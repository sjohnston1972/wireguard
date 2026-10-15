// insights-aws-server.test.ts
//
// Plain English: the three AWS server feeds (AWS insights spec sections 4.1,
// 4.2, 4.7 and 2.8), answered from saved AWS replies in
// fixtures/aws-insights/:
//   - health: DescribeInstanceStatus (both checks ok, the hardware check
//     impaired, a stopped server, AWS scheduled events) becomes the same
//     health shape as Azure's, and each new scheduled event writes one
//     watchman note and one push, never twice;
//   - metrics: one CloudWatch GetMetricData call; every value lands in its
//     5-minute slot whatever order CloudWatch sends them in, a missing point
//     stays null (and never wipes a stored one), byte and op sums become per
//     second;
//   - boot log: GetConsoleOutput's base64 becomes text, capped at 64 KB and
//     redacted; read again after each start, and on demand once a minute.
// Fake ids only: i-0abc, account 123456789012.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import health, { fetchAwsHealth, normaliseAwsHealth, storeAwsHealth, AWS_EVENTS_SEEN_KEY } from "../src/insights/aws/feeds/health";
import metrics, { awsMetricsParams, normaliseAwsMetrics, storeAwsMetrics } from "../src/insights/aws/feeds/metrics";
import bootLog, { AWS_NO_OUTPUT, fetchAwsBootLogNow, normaliseAwsBootLog } from "../src/insights/aws/feeds/bootLog";
import { runAwsInsights } from "../src/insights/aws/runner";
import { makeAwsCtx } from "../src/insights/aws/ctx";
import { getAwsLatest } from "../src/insights/aws/common";
import type { AwsBootLogDoc, AwsFeed, AwsHealthDoc } from "../src/insights/aws/types";
import { makeBudget } from "../src/insights/types";
import { BOOTLOG_MAX_BYTES } from "../src/insights/feeds/bootLog";
import { REDACTED } from "../src/insights/redact";
import { AWS_METRICS, AWS_VM_COLUMNS } from "../../shared/azureMetrics";
import { effectiveConfig } from "../src/settings";
import { getSnapshot, saveSnapshot } from "../src/state";
import { sha256Hex } from "../src/auth";
import type { Env } from "../src/env";
import { azureEnv, running, MIN, iso } from "./insights-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const NOW = new Date("2026-10-15T10:07:00Z");
const LAUNCH = "2026-10-15T09:52:00.000Z";
const AWS_ON: Partial<Env> = { AWS_ENABLED: "1" };

const fx = (name: string) => readFileSync(new URL(`./fixtures/aws-insights/${name}`, import.meta.url), "utf8");
const xmlReply = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/xml" } });
const awsErr = (code: string, status = 400) => xmlReply(`<Response><Errors><Error><Code>${code}</Code><Message>User: arn:aws:iam::123456789012:user/wg-admin-worker is not authorized</Message></Error></Errors><RequestID>x</RequestID></Response>`, status);

interface AwsCall {
  host: string;
  action: string | null;
  params: URLSearchParams;
}

interface FakeAws {
  calls: AwsCall[];
  /** ntfy pushes (watchman notes also go to the webhook). */
  pushes: string[];
  /** The headend, as DescribeInstances finds it; null = none. */
  headend: { id: string; state: string; launchTime: string } | null;
  status: string;
  metrics: string;
  console: string;
  /** Tried first; the first to answer wins. */
  answer?: (c: AwsCall) => Response | undefined;
}

const describeInstances = (h: FakeAws["headend"]) =>
  xmlReply(
    `<DescribeInstancesResponse><reservationSet>${
      h
        ? `<item><reservationId>r-1</reservationId><instancesSet><item><instanceId>${h.id}</instanceId><instanceState><code>16</code><name>${h.state}</name></instanceState><instanceType>t4g.micro</instanceType><launchTime>${h.launchTime}</launchTime><tagSet><item><key>wg-admin</key><value>vpn</value></item><item><key>wg-admin-role</key><value>headend</value></item></tagSet></item></instancesSet></item>`
        : ""
    }</reservationSet></DescribeInstancesResponse>`,
  );

/** A pretend AWS in front of the pretend Azure: every *.amazonaws.com call is recorded and answered from the fixtures. */
function withAws(over: Partial<FakeAws> = {}): FakeAws {
  const inner = globalThis.fetch;
  const fake: FakeAws = { calls: [], pushes: [], headend: { id: "i-0abc", state: "running", launchTime: LAUNCH }, status: fx("status-ok.xml"), metrics: fx("metrics.xml"), console: fx("console.xml"), ...over };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : typeof input === "string" ? input : (input as URL).href;
    const u = new URL(url);
    const body = req ? await req.clone().text() : String(init?.body ?? "");
    if (u.hostname === "ntfy.sh") {
      fake.pushes.push(body);
      return new Response("{}", { status: 200 });
    }
    if (!u.hostname.endsWith("amazonaws.com")) return inner(input, init);
    const params = new URLSearchParams(body);
    const call: AwsCall = { host: u.hostname, action: params.get("Action"), params };
    fake.calls.push(call);
    const r = fake.answer?.(call);
    if (r) return r;
    switch (call.action) {
      case "DescribeInstances":
        return describeInstances(fake.headend);
      case "DescribeInstanceStatus":
        return xmlReply(fake.status);
      case "GetMetricData":
        return xmlReply(fake.metrics);
      case "GetConsoleOutput":
        return xmlReply(fake.console);
    }
    throw new Error(`unexpected AWS call ${call.host} ${call.action}`);
  });
  return fake;
}

async function awsEnv(over: Partial<FakeAws> = {}, snap: Parameters<typeof running>[1] = {}) {
  const { env } = azureEnv(AWS_ON);
  const aws = withAws(over);
  await running(env, { cloud: "aws", region: "eu-west-2", vm_size: "t4g.micro", running_since: LAUNCH, since: LAUNCH, ...snap }, NOW);
  return { env, aws };
}

async function ctxFor(env: Env, now = NOW, budget = makeBudget(25)) {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return makeAwsCtx(env, now, snap, cfg, budget, { row: null });
}

async function runFeeds(env: Env, feeds: AwsFeed[], now = NOW) {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return runAwsInsights(env, now, feeds, { budget: makeBudget(25), late: () => false, snap, cfg });
}

async function awsFeedRow(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM aws_feed WHERE feed = ?1").bind(id).first<{ status: string; error: string | null; last_try_at: string | null; next_due_at: string | null }>();
}

const actions = (aws: FakeAws) => aws.calls.map((c) => c.action);

// ── Health ────────────────────────────────────────────────────────────────

describe("aws.health: DescribeInstanceStatus as the health shape", () => {
  it("both checks ok: Available, the server running, no Azure-only fields", () => {
    const doc = normaliseAwsHealth(fx("status-ok.xml"), "i-0abc", NOW);
    expect(doc.instanceId).toBe("i-0abc");
    expect(doc.health).toEqual({
      state: "Available",
      title: "Both AWS status checks passed.",
      summary: "AWS's hardware check (system status) and the server's own check (instance status) both passed.",
      reason: null,
      since: null,
      power: "Server running",
      provisioning: null,
      vmAgent: null,
      bootDiagnostics: true,
      checkedAt: NOW.toISOString(),
    });
    expect("annotations" in doc.health).toBe(false);
    expect(doc.maintenance).toEqual([]);
  });

  it("the hardware check impaired: Unavailable, in plain words (the EBS check's own status is not mistaken for it)", () => {
    const doc = normaliseAwsHealth(fx("status-impaired.xml"), "i-0abc", NOW);
    expect(doc.health.state).toBe("Unavailable");
    expect(doc.health.title).toBe("An AWS status check failed.");
    expect(doc.health.summary).toBe("AWS's hardware check failed (system status impaired).");
    // The instance check impaired instead.
    const inst = fx("status-ok.xml").replace(/(<instanceStatus>[\s\S]*?<\/details>\s*<status>)ok/, "$1impaired");
    expect(normaliseAwsHealth(inst, "i-0abc", NOW).health).toMatchObject({ state: "Unavailable", summary: "The server's own check failed (instance status impaired)." });
  });

  it("a check still starting (after every start): Unknown, not amber; a check without data: Degraded", () => {
    const init = fx("status-ok.xml").replace(/(<instanceStatus>[\s\S]*?<\/details>\s*<status>)ok/, "$1initializing");
    expect(normaliseAwsHealth(init, "i-0abc", NOW).health).toMatchObject({ state: "Unknown", title: "AWS status checks are starting.", summary: "The server's own check has no result yet (instance status initializing)." });
    const none = fx("status-ok.xml").replace(/(<systemStatus>[\s\S]*?<\/details>\s*<status>)ok/, "$1insufficient-data");
    expect(normaliseAwsHealth(none, "i-0abc", NOW).health).toMatchObject({ state: "Degraded", title: "AWS status checks are still running." });
    // One check without data and the other starting: Degraded.
    const both = none.replace(/(<instanceStatus>[\s\S]*?<\/details>\s*<status>)ok/, "$1initializing");
    expect(normaliseAwsHealth(both, "i-0abc", NOW).health.state).toBe("Degraded");
  });

  it("a stopped server: Unknown (AWS checks only a running server), power Server stopped", () => {
    const doc = normaliseAwsHealth(fx("status-stopped.xml"), "i-0abc", NOW);
    expect(doc.health).toMatchObject({ state: "Unknown", power: "Server stopped", title: "The server is stopped; AWS checks only a running server." });
    // Starting and stopping, in the power words.
    expect(normaliseAwsHealth(fx("status-stopped.xml").replace("<name>stopped</name>", "<name>pending</name>"), "i-0abc", NOW).health.power).toBe("Server starting");
    expect(normaliseAwsHealth(fx("status-stopped.xml").replace("<name>stopped</name>", "<name>stopping</name>"), "i-0abc", NOW).health.power).toBe("Server stopping");
  });

  it("no status for the instance: Unknown, power from the headend's own state", () => {
    const doc = normaliseAwsHealth("<DescribeInstanceStatusResponse><instanceStatusSet/></DescribeInstanceStatusResponse>", "i-0abc", NOW, "running");
    expect(doc.health).toMatchObject({ state: "Unknown", power: "Server running", title: "AWS gave no status check result." });
  });

  it("scheduled events: soonest first, completed and canceled ones dropped, with AWS's code and the length", () => {
    const doc = normaliseAwsHealth(fx("status-events.xml"), "i-0abc", NOW);
    expect(doc.health.state).toBe("Available");
    expect(doc.maintenance).toEqual([
      { id: "instance-event-0a1b2c3d4e5f60718", type: "instance-retirement", status: "Scheduled", notBefore: "2026-10-18T09:00:00.000Z", source: "AWS", description: "The instance is running on degraded hardware", durationS: null },
      { id: "instance-event-0d59937288b749b32", type: "system-reboot", status: "Scheduled", notBefore: "2026-10-20T03:00:00.000Z", source: "AWS", description: "scheduled reboot", durationS: 7200 },
    ]);
  });

  it("asks for the headend only, stopped or not, and stores aws_latest['health']", async () => {
    const { env, aws } = await awsEnv();
    const ctx = await ctxFor(env);
    const xml = await fetchAwsHealth(ctx, "i-0abc");
    expect(xml).toContain("instanceStatusSet");
    const c = aws.calls.find((x) => x.action === "DescribeInstanceStatus")!;
    expect(c.host).toBe("ec2.eu-west-2.amazonaws.com");
    expect(c.params.get("InstanceId.1")).toBe("i-0abc");
    expect(c.params.get("IncludeAllInstances")).toBe("true");
    await storeAwsHealth(env.DB, normaliseAwsHealth(xml, "i-0abc", NOW), NOW);
    const stored = await getAwsLatest<AwsHealthDoc>(env.DB, "health");
    expect(stored?.updatedAt).toBe(NOW.toISOString());
    expect(stored?.doc.health.state).toBe("Available");
  });

  it("runs on the cron: one shared headend lookup and one status call", async () => {
    const { env, aws } = await awsEnv();
    expect(await runFeeds(env, [health])).toEqual([]);
    expect(actions(aws)).toEqual(["DescribeInstances", "DescribeInstanceStatus"]);
    expect(await awsFeedRow(env, "aws.health")).toMatchObject({ status: "ok", error: null });
    expect((await getAwsLatest<AwsHealthDoc>(env.DB, "health"))?.doc.instanceId).toBe("i-0abc");
  });

  it("no headend (a deploy still building it): nothing stored, not an error", async () => {
    const { env, aws } = await awsEnv({ headend: null });
    await runFeeds(env, [health]);
    expect(actions(aws)).toEqual(["DescribeInstances"]);
    expect(await awsFeedRow(env, "aws.health")).toMatchObject({ status: "ok" });
    expect(await getAwsLatest(env.DB, "health")).toBeNull();
  });

  it("no headend: an old instance's stored health and scheduled events are removed", async () => {
    const { env, aws } = await awsEnv({ status: fx("status-events.xml") });
    await runFeeds(env, [health]);
    expect((await getAwsLatest<AwsHealthDoc>(env.DB, "health"))?.doc.maintenance).toHaveLength(2);
    // The old server is gone and a new deploy has not built its headend yet.
    aws.headend = null;
    await runFeeds(env, [health], new Date(NOW.getTime() + 6 * MIN));
    expect(await awsFeedRow(env, "aws.health")).toMatchObject({ status: "ok" });
    expect(await getAwsLatest(env.DB, "health")).toBeNull();
  });

  it("a new headend's health replaces the old instance's, scheduled events and all", async () => {
    const { env, aws } = await awsEnv({ status: fx("status-events.xml") });
    await runFeeds(env, [health]);
    expect((await getAwsLatest<AwsHealthDoc>(env.DB, "health"))?.doc.instanceId).toBe("i-0abc");
    aws.headend = { id: "i-0new", state: "running", launchTime: LAUNCH };
    aws.status = fx("status-ok.xml").split("i-0abc").join("i-0new");
    await runFeeds(env, [health], new Date(NOW.getTime() + 6 * MIN));
    const doc = (await getAwsLatest<AwsHealthDoc>(env.DB, "health"))?.doc;
    expect(doc?.instanceId).toBe("i-0new");
    expect(doc?.maintenance).toEqual([]);
    expect(doc?.health.state).toBe("Available");
  });

  it("a refusal names the permission and quotes nothing of AWS's", async () => {
    const { env } = await awsEnv({ answer: (c) => (c.action === "DescribeInstanceStatus" ? awsErr("UnauthorizedOperation", 403) : undefined) });
    await runFeeds(env, [health]);
    const row = await awsFeedRow(env, "aws.health");
    expect(row).toMatchObject({ status: "error", error: "AWS refused DescribeInstanceStatus: the Worker's AWS user needs ec2:DescribeInstanceStatus." });
    expect(row?.error).not.toMatch(/arn:|amazonaws/);
  });

  it("each new scheduled event writes one watchman note and one push, once per event id", async () => {
    const { env, aws } = await awsEnv({ status: fx("status-events.xml") });
    await runFeeds(env, [health]);
    const notes = async () => (await env.DB.prepare("SELECT message FROM alerts WHERE message LIKE 'AWS scheduled%' ORDER BY message").all<{ message: string }>()).results.map((r) => r.message);
    expect(await notes()).toHaveLength(2);
    expect((await notes()).join("\n")).toContain("AWS scheduled a system-reboot for this VM: not before");
    expect((await notes()).join("\n")).toContain("about 120 min. scheduled reboot");
    expect((await notes()).join("\n")).toContain("AWS scheduled an instance-retirement for this VM");
    expect(aws.pushes.filter((p) => p.includes("AWS maintenance scheduled"))).toHaveLength(2);
    // Five minutes later, the same events: no new note, no new push.
    await runFeeds(env, [health], new Date(NOW.getTime() + 6 * MIN));
    expect(await notes()).toHaveLength(2);
    expect(aws.pushes.filter((p) => p.includes("AWS maintenance scheduled"))).toHaveLength(2);
    // The ids it has noted are remembered in aws_latest.
    expect((await getAwsLatest<string[]>(env.DB, AWS_EVENTS_SEEN_KEY))?.doc).toEqual(["instance-event-0a1b2c3d4e5f60718", "instance-event-0d59937288b749b32"]);
    // A third event later: one more note.
    aws.status = fx("status-events.xml").replace("<eventsSet>", "<eventsSet><item><code>instance-stop</code><description>The instance is scheduled to stop</description><instanceEventId>instance-event-0aaaaaaaaaaaaaaaa</instanceEventId><notBefore>2026-10-25T03:00:00.000Z</notBefore></item>");
    await runFeeds(env, [health], new Date(NOW.getTime() + 12 * MIN));
    expect(await notes()).toHaveLength(3);
  });
});

// ── Metrics ───────────────────────────────────────────────────────────────

describe("aws.metrics: CloudWatch GetMetricData into hist_aws_vm", () => {
  it("asks for every catalogue metric of the headend, 5-minute periods over the last 45 minutes", () => {
    const p = awsMetricsParams("i-0abc", NOW);
    expect(p.StartTime).toBe("2026-10-15T09:20:00Z");
    expect(p.EndTime).toBe(NOW.toISOString());
    expect(p.ScanBy).toBe("TimestampAscending");
    AWS_METRICS.forEach((m, i) => {
      const k = `MetricDataQueries.member.${i + 1}`;
      expect(p[`${k}.Id`]).toBe(m.column);
      expect(p[`${k}.MetricStat.Metric.Namespace`]).toBe("AWS/EC2");
      expect(p[`${k}.MetricStat.Metric.MetricName`]).toBe(m.name);
      expect(p[`${k}.MetricStat.Metric.Dimensions.member.1.Name`]).toBe("InstanceId");
      expect(p[`${k}.MetricStat.Metric.Dimensions.member.1.Value`]).toBe("i-0abc");
      expect(p[`${k}.MetricStat.Period`]).toBe("300");
      expect(p[`${k}.MetricStat.Stat`]).toBe(m.stat);
    });
    expect(p[`MetricDataQueries.member.${AWS_METRICS.length + 1}.Id`]).toBeUndefined();
  });

  it("every value lands in its slot whatever the order; missing points stay null; sums of bytes and ops per second", () => {
    const rows = normaliseAwsMetrics(fx("metrics.xml"), NOW);
    // 09:20 to 10:00: nine complete slots, oldest first; 10:05 is not over at 10:07 and is dropped.
    expect(rows.map((r) => r.t)).toEqual(["09:20", "09:25", "09:30", "09:35", "09:40", "09:45", "09:50", "09:55", "10:00"].map((h) => `2026-10-15T${h}:00Z`));
    const at = (h: string) => rows.find((r) => r.t === `2026-10-15T${h}:00Z`)!;
    expect(at("09:20")).toEqual({
      t: "2026-10-15T09:20:00Z",
      cpu_avg: 1.5,
      cpu_max: 10, // CloudWatch sent this series newest first
      net_in: 100, // 30000 bytes in the slot / 300 s
      net_out: null, // only two points came back
      disk_read: 500,
      disk_write: 10000,
      disk_rops: 0.2,
      disk_wops: null, // no points at all
      credits_min: 144,
      credits_used: 0.05, // a credit sum is not per second
      status_failed: 0,
      pkts_in: 1200, // packets in the slot, not per second
      pkts_out: 900,
    });
    expect(at("10:00")).toMatchObject({ cpu_avg: 2.3, cpu_max: 18, net_in: 1000, net_out: 2000, pkts_out: 908 });
    expect(at("09:50")).toMatchObject({ net_out: 2000 });
    expect(at("09:55")).toMatchObject({ net_out: null, pkts_out: 907 });
    expect(at("09:40")).toMatchObject({ cpu_max: 14, pkts_out: 904 });
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["t", ...AWS_VM_COLUMNS].sort());
  });

  it("an empty or unreadable answer is no rows", () => {
    expect(normaliseAwsMetrics("<GetMetricDataResponse><GetMetricDataResult><MetricDataResults/></GetMetricDataResult></GetMetricDataResponse>", NOW)).toEqual([]);
    expect(normaliseAwsMetrics("not xml", NOW)).toEqual([]);
    // An Id that is not ours, and a value that is not a number, are ignored.
    const odd = "<MetricDataResults><member><Id>evil_col</Id><Timestamps><member>2026-10-15T09:50:00Z</member></Timestamps><Values><member>5</member></Values></member><member><Id>cpu_avg</Id><Timestamps><member>2026-10-15T09:50:00Z</member></Timestamps><Values><member>NaN-ish</member></Values></member></MetricDataResults>";
    expect(normaliseAwsMetrics(odd, NOW)).toEqual([{ t: "2026-10-15T09:50:00Z", ...Object.fromEntries(AWS_VM_COLUMNS.map((c) => [c, null])) }]);
  });

  it("an upsert fills in late points and a null never wipes a stored value", async () => {
    const { env } = await awsEnv();
    const empty = Object.fromEntries(AWS_VM_COLUMNS.map((c) => [c, null])) as Record<(typeof AWS_VM_COLUMNS)[number], number | null>;
    await storeAwsMetrics(env.DB, [{ t: "2026-10-15T09:50:00Z", ...empty, cpu_avg: 4, net_in: 10 }]);
    await storeAwsMetrics(env.DB, [{ t: "2026-10-15T09:50:00Z", ...empty, cpu_avg: null, net_in: 20, pkts_in: 7 }]);
    const row = await env.DB.prepare("SELECT * FROM hist_aws_vm WHERE t = '2026-10-15T09:50:00Z'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ res: 300, cpu_avg: 4, net_in: 20, pkts_in: 7, net_out: null });
    expect(typeof row?.res).toBe("number");
  });

  it("runs on the cron: one GetMetricData call to CloudWatch in the region, nine rows stored", async () => {
    const { env, aws } = await awsEnv();
    expect(await runFeeds(env, [metrics])).toEqual([]);
    expect(actions(aws)).toEqual(["DescribeInstances", "GetMetricData"]);
    const c = aws.calls[1]!;
    expect(c.host).toBe("monitoring.eu-west-2.amazonaws.com");
    expect(c.params.get("Version")).toBe("2010-08-01");
    expect(c.params.get("MetricDataQueries.member.1.MetricStat.Metric.Dimensions.member.1.Value")).toBe("i-0abc");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM hist_aws_vm WHERE res = 300").first<{ n: number }>();
    expect(n?.n).toBe(9);
    expect(await awsFeedRow(env, "aws.metrics")).toMatchObject({ status: "ok" });
  });

  it("a refusal names cloudwatch:GetMetricData", async () => {
    const { env } = await awsEnv({ answer: (c) => (c.action === "GetMetricData" ? awsErr("AccessDenied", 403) : undefined) });
    await runFeeds(env, [metrics]);
    expect(await awsFeedRow(env, "aws.metrics")).toMatchObject({ status: "error", error: "AWS refused GetMetricData: the Worker's AWS user needs cloudwatch:GetMetricData." });
  });

  it("no headend: no metrics call", async () => {
    const { env, aws } = await awsEnv({ headend: null });
    await runFeeds(env, [metrics]);
    expect(actions(aws)).toEqual(["DescribeInstances"]);
    expect(await awsFeedRow(env, "aws.metrics")).toMatchObject({ status: "ok" });
  });
});

// ── Boot log ──────────────────────────────────────────────────────────────

describe("aws.bootLog: GetConsoleOutput, capped and redacted", () => {
  it("base64 to text, with the password and the private key redacted", async () => {
    const doc = await normaliseAwsBootLog(fx("console.xml"), NOW, LAUNCH);
    expect(doc.reason).toBeNull();
    expect(doc.fetchedAt).toBe(NOW.toISOString());
    expect(doc.launchTime).toBe(LAUNCH);
    expect(doc.truncated).toBe(false);
    expect(doc.text).toContain("Linux version 6.8.0-1016-aws");
    expect(doc.text).toContain("cloudlabs boot ok");
    expect(doc.text).not.toContain("Tr0ub4dor&3");
    expect(doc.text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ");
    expect(doc.text).toContain(REDACTED);
    expect(doc.redactions).toBeGreaterThanOrEqual(2);
    expect(doc.bytes).toBeGreaterThan(0);
  });

  it("the run's tokens and SSH password are redacted wherever they appear", async () => {
    const agentToken = "a1".repeat(32);
    const text = `cloud-init: AGENT/${agentToken}\nchpasswd S3cr3t-Pass\nok\n`;
    const xml = `<GetConsoleOutputResponse><instanceId>i-0abc</instanceId><output>${Buffer.from(text).toString("base64")}</output></GetConsoleOutputResponse>`;
    const doc = await normaliseAwsBootLog(xml, NOW, LAUNCH, ["S3cr3t-Pass"], [await sha256Hex(agentToken)]);
    expect(doc.text).toBe(`cloud-init: AGENT/${REDACTED}\nchpasswd ${REDACTED}\nok\n`);
  });

  it("only the last 64 KB, from a whole line", async () => {
    const line = "[    1.000000] systemd[1]: a perfectly ordinary boot line\n";
    const text = line.repeat(Math.ceil((BOOTLOG_MAX_BYTES * 1.5) / line.length)) + "the end\n";
    const xml = `<GetConsoleOutputResponse><output>${Buffer.from(text).toString("base64")}</output></GetConsoleOutputResponse>`;
    const doc = await normaliseAwsBootLog(xml, NOW, LAUNCH);
    expect(doc.truncated).toBe(true);
    expect(doc.bytes).toBe(BOOTLOG_MAX_BYTES);
    expect(doc.text!.length).toBeLessThanOrEqual(BOOTLOG_MAX_BYTES);
    expect(doc.text!.startsWith("[    1.000000]")).toBe(true);
    expect(doc.text!.endsWith("the end\n")).toBe(true);
  });

  it("no output yet: the reason says so", async () => {
    for (const xml of ["<GetConsoleOutputResponse><instanceId>i-0abc</instanceId><output/></GetConsoleOutputResponse>", "<GetConsoleOutputResponse><instanceId>i-0abc</instanceId></GetConsoleOutputResponse>"]) {
      const doc = await normaliseAwsBootLog(xml, NOW, LAUNCH);
      expect(doc).toEqual({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: AWS_NO_OUTPUT, launchTime: LAUNCH });
    }
    expect(AWS_NO_OUTPUT).toBe("AWS has no console output for this server yet.");
  });

  it("due when never read, and again after each start; not otherwise", async () => {
    const { env, aws } = await awsEnv();
    expect(await bootLog.due!(await ctxFor(env), null)).toBe(true);
    aws.calls.length = 0;
    // Read for this start: not due.
    await runFeeds(env, [bootLog]);
    expect(actions(aws)).toEqual(["DescribeInstances", "GetConsoleOutput"]);
    const c = aws.calls[1]!;
    expect(c.params.get("InstanceId")).toBe("i-0abc");
    expect(c.params.get("Latest")).toBe("true");
    const stored = await getAwsLatest<AwsBootLogDoc>(env.DB, "bootlog");
    expect(stored?.doc).toMatchObject({ launchTime: LAUNCH, reason: null });
    expect(stored?.doc.text).toContain("cloudlabs boot ok");
    expect(await awsFeedRow(env, "aws.bootLog")).toMatchObject({ status: "ok", next_due_at: null });
    aws.calls.length = 0;
    await runFeeds(env, [bootLog], new Date(NOW.getTime() + 5 * MIN));
    expect(actions(aws)).toEqual(["DescribeInstances"]);
    // Started again: due.
    aws.headend = { id: "i-0abc", state: "running", launchTime: "2026-10-15T11:00:00.000Z" };
    aws.calls.length = 0;
    await runFeeds(env, [bootLog], new Date("2026-10-15T11:05:00Z"));
    expect(actions(aws)).toEqual(["DescribeInstances", "GetConsoleOutput"]);
    expect((await getAwsLatest<AwsBootLogDoc>(env.DB, "bootlog"))?.doc.launchTime).toBe("2026-10-15T11:00:00.000Z");
  });

  it("no output yet after a start: tried again every 10 minutes for the first hour, then left to Fetch now", async () => {
    const { env, aws } = await awsEnv({ console: "<GetConsoleOutputResponse><instanceId>i-0abc</instanceId><output/></GetConsoleOutputResponse>" });
    const consoleCalls = () => aws.calls.filter((c) => c.action === "GetConsoleOutput").length;
    const at = (min: number) => new Date(Date.parse(LAUNCH) + min * MIN);
    await runFeeds(env, [bootLog], at(2));
    expect(consoleCalls()).toBe(1);
    expect((await getAwsLatest<AwsBootLogDoc>(env.DB, "bootlog"))?.doc.reason).toBe(AWS_NO_OUTPUT);
    await runFeeds(env, [bootLog], at(7));
    expect(consoleCalls()).toBe(1); // tried 5 minutes ago
    await runFeeds(env, [bootLog], at(12));
    expect(consoleCalls()).toBe(2);
    await runFeeds(env, [bootLog], at(70));
    await runFeeds(env, [bootLog], at(85));
    expect(consoleCalls()).toBe(2); // over an hour since the start
  });

  it("a refused read is tried again in 10 minutes, not on every run", async () => {
    const { env, aws } = await awsEnv({ answer: (c) => (c.action === "GetConsoleOutput" ? awsErr("UnauthorizedOperation", 403) : undefined) });
    const consoleCalls = () => aws.calls.filter((c) => c.action === "GetConsoleOutput").length;
    await runFeeds(env, [bootLog]);
    expect(await awsFeedRow(env, "aws.bootLog")).toMatchObject({ status: "error", error: "AWS refused GetConsoleOutput: the Worker's AWS user needs ec2:GetConsoleOutput." });
    await runFeeds(env, [bootLog], new Date(NOW.getTime() + 5 * MIN));
    expect(consoleCalls()).toBe(1);
  });

  it("no headend: not due, no console call", async () => {
    const { env, aws } = await awsEnv({ headend: null });
    await runFeeds(env, [bootLog]);
    expect(actions(aws)).toEqual(["DescribeInstances"]);
    expect(await getAwsLatest(env.DB, "bootlog")).toBeNull();
  });
});

describe("fetchAwsBootLogNow (POST /api/v1/azure/bootlog on AWS)", () => {
  it("fetches, redacts and stores; at most once a minute", async () => {
    const { env, aws } = await awsEnv();
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at, finished_at, ssh_password) VALUES ('run-1', 'apply', 'success', ?1, ?1, 'Tr0ub4dor&3')").bind(iso(NOW.getTime() - 20 * MIN)).run();
    const r = await fetchAwsBootLogNow(env, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.text).toContain("cloudlabs boot ok");
    expect(r.doc.text).not.toContain("Tr0ub4dor&3");
    expect(actions(aws)).toEqual(["DescribeInstances", "GetConsoleOutput"]);
    expect((await getAwsLatest<AwsBootLogDoc>(env.DB, "bootlog"))?.doc.launchTime).toBe(LAUNCH);
    expect(await awsFeedRow(env, "aws.bootLog")).toMatchObject({ status: "ok" });
    // Again 30 s later: slow down, no AWS call.
    const again = await fetchAwsBootLogNow(env, new Date(NOW.getTime() + 30_000));
    expect(again).toMatchObject({ ok: false, why: "slow_down" });
    expect(aws.calls).toHaveLength(2);
    // A minute later it may.
    expect((await fetchAwsBootLogNow(env, new Date(NOW.getTime() + 61_000))).ok).toBe(true);
  });

  it("no headend: No VM, nothing stored", async () => {
    const { env } = await awsEnv({ headend: null });
    const r = await fetchAwsBootLogNow(env, NOW);
    expect(r).toMatchObject({ ok: true, doc: { text: null, reason: "No VM" } });
    expect(await getAwsLatest(env.DB, "bootlog")).toBeNull();
  });

  it("a refusal is an error in plain words, recorded on the feed", async () => {
    const { env } = await awsEnv({ answer: (c) => (c.action === "GetConsoleOutput" ? awsErr("UnauthorizedOperation", 403) : undefined) });
    const r = await fetchAwsBootLogNow(env, NOW);
    expect(r).toEqual({ ok: false, why: "error", message: "AWS refused GetConsoleOutput: the Worker's AWS user needs ec2:GetConsoleOutput." });
    expect(await awsFeedRow(env, "aws.bootLog")).toMatchObject({ status: "error" });
  });

  it("AWS throttling reads as slow down", async () => {
    const { env } = await awsEnv({ answer: (c) => (c.action === "GetConsoleOutput" ? awsErr("RequestLimitExceeded", 503) : undefined) });
    expect(await fetchAwsBootLogNow(env, NOW)).toMatchObject({ ok: false, why: "slow_down" });
  });

  it("AWS not configured: no call at all", async () => {
    const { env } = azureEnv({ AWS_ENABLED: "0" });
    const aws = withAws();
    await saveSnapshot(env, { state: "running", cloud: "aws" });
    const r = await fetchAwsBootLogNow(env, NOW);
    expect(r).toMatchObject({ ok: false, why: "error" });
    expect(aws.calls).toEqual([]);
  });
});
