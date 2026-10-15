// insights-aws-runner.test.ts
//
// Plain English: the AWS half of the insights collector (AWS insights spec
// sections 2.4, 3 and 9). The AWS feeds run beside Azure's under the same
// budget of outside calls: without the Worker's AWS keys nothing is fetched
// and every AWS feed reads not_configured; the server feeds (health,
// metrics, boot log) only run while the server is in AWS; when it is, Azure's
// server feeds are skipped but Azure's cloud-wide feeds still run. A feed
// AWS throttles is skipped (still due), a refused call names the permission.
//
// The AWS feeds are stand-ins built from the real registry's metadata, so
// this file stays true while the real feeds are filled in.
import { describe, it, expect, afterEach, vi } from "vitest";
import { runInsights, type FeedModule } from "../src/insights/runner";
import { runAwsInsights, AWS_OUT_OF_CALLS } from "../src/insights/aws/runner";
import { AWS_FEED_MODULES } from "../src/insights/aws/feeds/index";
import { AWS_FEED_IDS, AWS_SOURCES, AWS_STANDS_IN, AWS_TABLES, AwsThrottled, awsConfigured, type AwsFeed, type AwsFeedCtx, type AwsFeedId } from "../src/insights/aws/types";
import { makeBudget } from "../src/insights/types";
import { effectiveConfig } from "../src/settings";
import { getSnapshot, saveSnapshot } from "../src/state";
import type { Env } from "../src/env";
import { azureEnv, running, feedRows, NOW, ago, iso, MIN } from "./insights-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** AWS switched on, with the harness's (fake) Worker keys. */
const AWS_ON: Partial<Env> = { AWS_ENABLED: "1" };
const NO_AWS_KEYS: Partial<Env> = { AWS_ENABLED: "1", AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined };

interface AwsCall {
  host: string;
  action: string | null;
  target: string | null;
}

/**
 * A pretend AWS in front of the pretend Azure: every *.amazonaws.com call is
 * recorded and answered by `answer` (DescribeInstances finds the headend by
 * default); anything else goes on to the Azure fake.
 */
function withAws(answer: (c: AwsCall) => Response | undefined = () => undefined) {
  const inner = globalThis.fetch;
  const calls: AwsCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : typeof input === "string" ? input : (input as URL).href;
    const u = new URL(url);
    if (!u.hostname.endsWith("amazonaws.com")) return inner(input, init);
    const body = req ? await req.clone().text() : String(init?.body ?? "");
    const headers = new Headers(req ? req.headers : init?.headers);
    const call: AwsCall = { host: u.hostname, action: new URLSearchParams(body).get("Action"), target: headers.get("x-amz-target") };
    calls.push(call);
    const r = answer(call);
    if (r) return r;
    if (call.action === "DescribeInstances") {
      return new Response(
        "<DescribeInstancesResponse><reservationSet><item><reservationId>r-1</reservationId><instancesSet><item><instanceId>i-0abc</instanceId><instanceState><code>16</code><name>running</name></instanceState><instanceType>t4g.micro</instanceType><launchTime>2026-10-04T08:00:00.000Z</launchTime><tagSet><item><key>wg-admin</key><value>vpn</value></item><item><key>wg-admin-role</key><value>headend</value></item></tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>",
        { status: 200 },
      );
    }
    if (call.target?.endsWith("GetResources")) return new Response(JSON.stringify({ ResourceTagMappingList: [{ ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0abc" }, { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:security-group/sg-wg" }], PaginationToken: "" }), { status: 200 });
    throw new Error(`unexpected AWS call ${call.host} ${call.action ?? call.target}`);
  });
  return calls;
}

/** An Azure stand-in feed. */
function fakeAz(id: FeedModule["id"], when: FeedModule["when"], log: string[]): FeedModule {
  return {
    id,
    title: id,
    cadenceMin: 5,
    when,
    calls: 1,
    arm: false,
    async run() {
      log.push(id);
      return { status: "ok", error: null };
    },
  };
}

/** An AWS stand-in: the real feed's id, cadence, when and calls, with `body` as its run. */
function fakeAws(id: AwsFeedId, log: string[], over: Partial<AwsFeed> = {}, body?: (ctx: AwsFeedCtx) => Promise<void>): AwsFeed {
  const real = AWS_FEED_MODULES.find((f) => f.id === id)!;
  return {
    id,
    title: real.title,
    cadenceMin: real.cadenceMin,
    when: real.when,
    calls: real.calls,
    ...over,
    async run(ctx) {
      log.push(id);
      if (body) await body(ctx);
      return { status: "ok", error: null };
    },
  };
}

/** Stand-ins for every real AWS feed, in the registry's order. */
const standIns = (log: string[]) => AWS_FEED_MODULES.map((f) => fakeAws(f.id, log));

/** The Azure stand-ins: one feed of each `when`. */
const azFeeds = (log: string[]) => [fakeAz("health", "rg", log), fakeAz("vmMetrics", "running", log), fakeAz("pipMetrics", "vm", log), fakeAz("activity", "always", log), fakeAz("serviceHealth", "always", log)];

async function awsFeedRows(env: Env): Promise<Record<string, { status: string; last_ok_at: string | null; last_try_at: string | null; error: string | null; next_due_at: string | null }>> {
  const rows = (await env.DB.prepare("SELECT * FROM aws_feed").all<any>()).results;
  return Object.fromEntries(rows.map((r) => [r.feed, r]));
}

async function opts(env: Env, budget = makeBudget(25)) {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return { budget, late: () => false, snap, cfg };
}

const SERVER_FEEDS: AwsFeedId[] = ["aws.health", "aws.metrics", "aws.bootLog"];
const ALWAYS_FEEDS: AwsFeedId[] = ["aws.activity", "aws.serviceHealth", "aws.capacity", "aws.prices", "aws.labPrices", "aws.housekeeping"];

describe("the AWS feed contract", () => {
  it("lists the feeds in priority order with the spec's cadence, when and calls", () => {
    expect(AWS_FEED_MODULES.map((f) => f.id)).toEqual([...AWS_FEED_IDS]);
    expect(AWS_FEED_IDS).toEqual(["aws.health", "aws.metrics", "aws.activity", "aws.serviceHealth", "aws.capacity", "aws.prices", "aws.labPrices", "aws.bootLog", "aws.housekeeping"]);
    const meta = Object.fromEntries(AWS_FEED_MODULES.map((f) => [f.id, [f.when, f.cadenceMin, f.calls]]));
    expect(meta).toEqual({
      "aws.health": ["server", 5, 2],
      "aws.metrics": ["running", 15, 2],
      "aws.activity": ["always", 5, 4],
      "aws.serviceHealth": ["always", 15, 2],
      "aws.capacity": ["always", 1440, 8],
      "aws.prices": ["always", 1440, 3],
      "aws.labPrices": ["always", 60, 5],
      "aws.bootLog": ["server", null, 2],
      "aws.housekeeping": ["always", 1440, 0],
    });
    expect(AWS_STANDS_IN["aws.metrics"]).toEqual(["vmMetrics", "pipMetrics"]);
    expect(AWS_SOURCES["aws.metrics"]).toBe("AWS CloudWatch");
    expect([...AWS_TABLES].sort()).toEqual(["aws_activity", "aws_capacity", "aws_feed", "aws_latest", "aws_prices", "aws_service_events", "hist_aws_vm"]);
  });

  it("AWS is configured only with both Worker keys and AWS switched on", () => {
    expect(awsConfigured(azureEnv(AWS_ON).env)).toBe(true);
    expect(awsConfigured(azureEnv().env)).toBe(false); // AWS_ENABLED unset
    expect(awsConfigured(azureEnv(NO_AWS_KEYS).env)).toBe(false);
    expect(awsConfigured(azureEnv({ ...AWS_ON, AWS_WORKER_SECRET_ACCESS_KEY: "REPLACE_ME" }).env)).toBe(false);
  });
});

describe("the runner with AWS feeds", () => {
  it("(a) AWS not configured, server in Azure: no AWS call, every AWS feed not_configured, Azure untouched", async () => {
    const { env } = azureEnv(NO_AWS_KEYS);
    const aws = withAws();
    await running(env);
    const log: string[] = [];
    await runInsights(env, NOW, azFeeds(log), { awsFeeds: standIns(log) });
    expect(aws).toEqual([]);
    expect(log).toEqual(["health", "vmMetrics", "pipMetrics", "activity", "serviceHealth"]);
    const rows = await awsFeedRows(env);
    for (const id of AWS_FEED_IDS) expect(rows[id]?.status, id).toBe("not_configured");
    for (const id of ["health", "vmMetrics", "pipMetrics", "activity", "serviceHealth"]) expect((await feedRows(env))[id]?.status, id).toBe("ok");
    // A second run writes nothing new.
    const before = JSON.stringify(rows);
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN), azFeeds([]), { awsFeeds: standIns([]) });
    expect(JSON.stringify(await awsFeedRows(env))).toBe(before);
  });

  it("(b) server in AWS: Azure server feeds (and its change log) skipped, Azure service health and every AWS feed run", async () => {
    const { env, az } = azureEnv(AWS_ON);
    withAws();
    await running(env, { cloud: "aws" });
    const log: string[] = [];
    await runInsights(env, NOW, azFeeds(log), { awsFeeds: standIns(log) });
    // The AWS server feeds go first; Azure's service health still runs. Its change log has no resource group to read.
    expect(log.filter((x) => x.startsWith("aws."))).toEqual([...AWS_FEED_IDS]);
    expect(log.filter((x) => !x.startsWith("aws."))).toEqual(["serviceHealth"]);
    expect(log.indexOf("aws.health")).toBeLessThan(log.indexOf("serviceHealth"));
    const az_ = await feedRows(env);
    for (const id of ["health", "vmMetrics", "pipMetrics", "activity"]) {
      expect(az_[id]?.status, id).toBe("skipped");
      expect(az_[id]?.error, id).toBe("The server runs in AWS.");
    }
    expect(az_.serviceHealth.status).toBe("ok");
    const rows = await awsFeedRows(env);
    for (const id of AWS_FEED_IDS) expect(rows[id]?.status, id).toBe("ok");
    expect(rows["aws.health"].next_due_at).toBe(iso(NOW.getTime() + 5 * MIN));
    expect(rows["aws.bootLog"].next_due_at).toBeNull(); // on demand
    expect(az.calls.filter((c) => c.u.hostname === "management.azure.com")).toHaveLength(0);
  });

  it("(b) the stub feeds say they are not built yet, and no AWS call is made for them", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws();
    await running(env, { cloud: "aws" });
    // Only the feeds still stubbed: a built feed is tested in its own file.
    const stubs: AwsFeed[] = [];
    for (const f of AWS_FEED_MODULES.filter((m) => m.id !== "aws.housekeeping")) {
      try {
        const r = await f.run({} as AwsFeedCtx);
        if (r.status === "error" && r.error === "Not built yet.") stubs.push(f);
      } catch {
        /* a built feed given an empty ctx: not a stub */
      }
    }
    await runAwsInsights(env, NOW, stubs, await opts(env));
    const rows = await awsFeedRows(env);
    for (const f of stubs) expect(rows[f.id], f.id).toMatchObject({ status: "error", error: "Not built yet." });
    expect(aws).toEqual([]);
  });

  it("(c) AWS configured, server in Azure: only the AWS cloud-wide feeds run; the server feeds read idle", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws();
    await running(env);
    // Left over from a time AWS was not configured.
    await env.DB.prepare("INSERT INTO aws_feed (feed, status) VALUES ('aws.health', 'not_configured')").run();
    const log: string[] = [];
    await runInsights(env, NOW, azFeeds(log), { awsFeeds: standIns(log) });
    expect(log).toEqual(["health", "vmMetrics", "pipMetrics", "activity", "serviceHealth", ...ALWAYS_FEEDS]);
    const rows = await awsFeedRows(env);
    for (const id of ALWAYS_FEEDS) expect(rows[id]?.status, id).toBe("ok");
    for (const id of SERVER_FEEDS) {
      expect(rows[id]?.status, id).toBe("idle");
      expect(rows[id]?.last_try_at, id).toBeNull();
    }
    expect(aws).toEqual([]);
    // A destroyed AWS server: still no server feeds.
    await saveSnapshot(env, { state: "destroyed", since: ago(5), cloud: "aws" });
    log.length = 0;
    await runAwsInsights(env, new Date(NOW.getTime() + 60 * MIN), standIns(log), await opts(env));
    expect(log).toEqual(ALWAYS_FEEDS.filter((id) => id !== "aws.capacity" && id !== "aws.prices" && id !== "aws.housekeeping"));
  });

  it("(d) a feed needing more calls than are left is skipped with the out-of-calls words and stays due", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws();
    await running(env, { cloud: "aws" });
    const log: string[] = [];
    const feeds = [fakeAws("aws.prices", log, { calls: 3 }), fakeAws("aws.housekeeping", log)];
    await runAwsInsights(env, NOW, feeds, await opts(env, makeBudget(1)));
    expect(log).toEqual(["aws.housekeeping"]);
    const rows = await awsFeedRows(env);
    expect(rows["aws.prices"]).toMatchObject({ status: "skipped", error: AWS_OUT_OF_CALLS, next_due_at: null });
    expect(AWS_OUT_OF_CALLS).toMatch(/used up/);
    // A feed that takes more than it said is stopped at the budget, and skipped.
    const greedy = fakeAws("aws.activity", [], { calls: 1 }, async (ctx) => {
      await ctx.ec2("DescribeInstances");
      await ctx.ec2("DescribeInstances");
    });
    await runAwsInsights(env, NOW, [greedy], await opts(env, makeBudget(1)));
    expect((await awsFeedRows(env))["aws.activity"]).toMatchObject({ status: "skipped", error: AWS_OUT_OF_CALLS });
  });

  it("(e) a feed AWS throttles is skipped and stays due", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws((c) => (c.action === "DescribeInstanceStatus" ? new Response("<Response><Errors><Error><Code>RequestLimitExceeded</Code><Message>Request limit exceeded.</Message></Error></Errors></Response>", { status: 503 }) : undefined));
    await running(env, { cloud: "aws" });
    await env.DB.prepare("INSERT INTO aws_feed (feed, status, next_due_at) VALUES ('aws.health', 'ok', ?1), ('aws.activity', 'ok', ?1)").bind(ago(2)).run();
    const feeds = [
      fakeAws("aws.health", [], {}, async (ctx) => void (await ctx.ec2("DescribeInstanceStatus"))),
      fakeAws("aws.activity", [], {}, async () => {
        throw new AwsThrottled("AWS asked us to slow down.");
      }),
    ];
    await runAwsInsights(env, NOW, feeds, await opts(env));
    const rows = await awsFeedRows(env);
    for (const id of ["aws.health", "aws.activity"]) {
      expect(rows[id]?.status, id).toBe("skipped");
      expect(rows[id]?.next_due_at, id).toBe(ago(2));
    }
  });

  it("a refused call names the permission the Worker's AWS user needs, and never a signature", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws((c) => {
      if (c.action === "DescribeInstanceStatus") return new Response("<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized. Encoded authorization failure message: abc</Message></Error></Errors></Response>", { status: 403 });
      if (c.target?.endsWith("LookupEvents")) return new Response(JSON.stringify({ __type: "AccessDeniedException", message: "User: arn:aws:iam::123456789012:user/wg-admin-worker is not authorized" }), { status: 400 });
      if (c.host.startsWith("monitoring.")) return new Response("<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>", { status: 403 });
      return undefined;
    });
    await running(env, { cloud: "aws" });
    const feeds = [
      fakeAws("aws.health", [], {}, async (ctx) => void (await ctx.ec2("DescribeInstanceStatus"))),
      fakeAws("aws.metrics", [], {}, async (ctx) => void (await ctx.query("monitoring", "GetMetricData", {}, "2010-08-01"))),
      fakeAws("aws.activity", [], {}, async (ctx) => void (await ctx.json({ service: "cloudtrail", region: "eu-west-2", host: "cloudtrail.eu-west-2.amazonaws.com", target: "com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents", body: {} }))),
    ];
    await runAwsInsights(env, NOW, feeds, await opts(env));
    const rows = await awsFeedRows(env);
    expect(rows["aws.health"].error).toBe("AWS refused DescribeInstanceStatus: the Worker's AWS user needs ec2:DescribeInstanceStatus.");
    expect(rows["aws.metrics"].error).toBe("AWS refused GetMetricData: the Worker's AWS user needs cloudwatch:GetMetricData.");
    expect(rows["aws.activity"].error).toBe("AWS refused LookupEvents: the Worker's AWS user needs cloudtrail:LookupEvents.");
    for (const r of Object.values(rows)) expect(r.status).toBe("error");
    expect(JSON.stringify(rows)).not.toMatch(/https?:|Signature|Credential/);
  });

  it("the headend and the tagged ids are looked up once per run and shared by the feeds", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws();
    await running(env, { cloud: "aws" });
    const seen: unknown[] = [];
    const look = async (ctx: AwsFeedCtx) => {
      seen.push(await ctx.headend());
      seen.push([...(await ctx.taggedIds())]);
    };
    const budget = makeBudget(25);
    await runAwsInsights(env, NOW, [fakeAws("aws.health", [], {}, look), fakeAws("aws.metrics", [], {}, look)], await opts(env, budget));
    expect(seen[0]).toEqual({ id: "i-0abc", state: "running", launchTime: "2026-10-04T08:00:00.000Z", instanceType: "t4g.micro" });
    expect(seen[1]).toEqual(["i-0abc", "sg-wg"]);
    expect(seen[2]).toEqual(seen[0]);
    expect(aws.filter((c) => c.action === "DescribeInstances")).toHaveLength(1);
    expect(aws.filter((c) => c.target?.endsWith("GetResources"))).toHaveLength(1);
    expect(budget.used()).toBe(2);
  });

  it("the AWS feeds share the Azure run's budget of 25", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws(() => new Response("<DescribeVpcsResponse><vpcSet/></DescribeVpcsResponse>", { status: 200 }));
    await running(env);
    const az: FeedModule = { ...fakeAz("activity", "always", []), calls: 20, run: async (ctx) => (ctx.budget.take(20), { status: "ok", error: null }) };
    const greedy = fakeAws("aws.activity", [], { calls: 4 }, async (ctx) => {
      for (let i = 0; i < 10; i++) await ctx.ec2("DescribeVpcs");
    });
    await runInsights(env, NOW, [az], { awsFeeds: [greedy] });
    expect(aws).toHaveLength(5);
    expect((await awsFeedRows(env))["aws.activity"].status).toBe("skipped");
  });

  it("custom Azure feeds alone run no AWS feed; the default run includes them", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws(() => new Response("nope", { status: 500 }));
    await running(env);
    await runInsights(env, NOW, azFeeds([]));
    expect(await awsFeedRows(env)).toEqual({});
    await runInsights(env, NOW);
    const rows = await awsFeedRows(env);
    for (const id of ALWAYS_FEEDS) expect(rows[id]?.last_try_at, id).toBe(NOW.toISOString());
  });

  it("housekeeping prunes the AWS tables like Azure's", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws();
    const DAY = 1440 * MIN;
    const now = NOW.getTime();
    await saveSnapshot(env, { state: "destroyed", since: iso(now - 8 * DAY), cloud: "aws" });
    const slot = (ms: number) => new Date(Math.floor(ms / 300_000) * 300_000).toISOString().replace(".000Z", "Z");
    await env.DB.prepare("INSERT INTO hist_aws_vm (res, t, cpu_avg) VALUES (300, ?1, 1), (300, ?2, 2)").bind(slot(now - 31 * DAY), slot(now - 29 * DAY)).run();
    await env.DB.prepare("INSERT INTO aws_activity (id, at, operation, status, caller, caller_kind, resource_type, resource_name) VALUES ('old', ?1, 'RunInstances', 'Succeeded', NULL, 'wgadmin', 'EC2 instance', NULL), ('kept', ?2, 'RunInstances', 'Succeeded', NULL, 'wgadmin', 'EC2 instance', NULL)")
      .bind(iso(now - 91 * DAY), iso(now - 89 * DAY))
      .run();
    await env.DB.prepare("INSERT INTO aws_service_events (tracking_id, type, status, title, services, regions, updated_at) VALUES ('ev-old', 'ServiceIssue', 'Resolved', 't', '[]', '[]', ?1), ('ev-kept', 'ServiceIssue', 'Resolved', 't', '[]', '[]', ?2)")
      .bind(iso(now - 91 * DAY), iso(now - 80 * DAY))
      .run();
    await env.DB.prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES ('bootlog', '{}', ?1), ('bootlog-try', '{}', ?2), ('health', '{}', ?1)").bind(iso(now - 8 * DAY), iso(now - 2 * DAY)).run();
    await env.DB.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES ('eu-west-1', '{}', ?1), ('eu-west-2', '{}', ?2)").bind(iso(now - 31 * DAY), iso(now - DAY)).run();
    await env.DB.prepare("INSERT INTO aws_prices (region, item, gbp, unit, meter, fetched_at) VALUES ('eu-west-1', 'ip:v4', 1, '1 Hour', 'm', ?1), ('eu-west-2', 'ip:v4', 1, '1 Hour', 'm', ?2)").bind(iso(now - 31 * DAY), iso(now - 8 * DAY)).run();
    const hk = AWS_FEED_MODULES.find((f) => f.id === "aws.housekeeping")!;
    await runAwsInsights(env, NOW, [hk], await opts(env));
    const col = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results.map((r) => Object.values(r)[0]);
    expect(await col("SELECT cpu_avg FROM hist_aws_vm")).toEqual([2]);
    expect(await col("SELECT id FROM aws_activity")).toEqual(["kept"]);
    expect(await col("SELECT tracking_id FROM aws_service_events")).toEqual(["ev-kept"]);
    expect(await col("SELECT key FROM aws_latest ORDER BY key")).toEqual(["health"]);
    expect(await col("SELECT region FROM aws_capacity")).toEqual(["eu-west-2"]);
    expect(await col("SELECT region FROM aws_prices")).toEqual(["eu-west-2"]);
    expect((await awsFeedRows(env))["aws.housekeeping"]).toMatchObject({ status: "ok", next_due_at: iso(now + DAY) });
  });
});

