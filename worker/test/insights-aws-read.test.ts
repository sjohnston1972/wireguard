// insights-aws-read.test.ts
//
// Plain English: the /api/v1/azure routes when the server is in AWS (AWS
// insights spec section 6). The same addresses and the same response shapes,
// read from the aws_* tables and tagged cloud "aws"; each feed's footer says
// where its figures come from. Nothing here reaches AWS except where a test
// says so: fetch is a counter, and the three helpers the region and server
// feeds own (fetchAwsBootLogNow, awsCapacityCheck, awsPriceInfo) are
// stand-ins, so this file stays true while those feeds are filled in.
// Also: a destroyed server whose last cloud was AWS still reads AWS's
// tables (Review Focus 1), Azure's answers only gain cloud and source, and
// the dev seeder's insights-aws story.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import { saveSnapshot, getSnapshot } from "../src/state";
import { seedScenario, SCENARIOS } from "../src/devseed";
import { AWS_TABLES } from "../src/insights/aws/types";
import { AZ_TABLES } from "../src/insights/types";
import { FEEDS, PIP_COLUMNS, VITALS_COLUMNS, VM_COLUMNS } from "../../shared/azureMetrics";
import { fetchAwsBootLogNow } from "../src/insights/aws/feeds/bootLog";
import capacityFeed, { awsCapacityCheck } from "../src/insights/aws/feeds/capacity";
import { awsPriceInfo } from "../src/insights/aws/feeds/prices";
import { NOW, NO_AZURE, agentReport, ago, iso, MIN } from "./insights-helpers";
import type { Env } from "../src/env";
import type { CapacityDoc } from "../src/insights/types";
import type { AwsBootLogDoc, AwsHealthDoc } from "../src/insights/aws/types";
import type { CapacityCheck, PriceInfo } from "../../shared/api";

vi.mock("../src/insights/aws/feeds/bootLog", async (orig) => {
  const m = await orig<typeof import("../src/insights/aws/feeds/bootLog")>();
  return { ...m, fetchAwsBootLogNow: vi.fn() };
});
vi.mock("../src/insights/aws/feeds/capacity", async (orig) => {
  const m = await orig<typeof import("../src/insights/aws/feeds/capacity")>();
  const check = (doc: CapacityDoc | null, region: string, size: string, needTestVm: boolean, fetchedAt: string | null): CapacityCheck => ({
    region,
    size,
    available: doc ? doc.sizes.some((s) => s.name === size && s.available) : null,
    reason: null,
    vcpusNeeded: doc ? 2 : null,
    family: null,
    total: doc ? doc.cores : null,
    ok: doc ? true : null,
    message: doc ? `stand-in check (test VM ${needTestVm ? "on" : "off"})` : null,
    fetchedAt,
  });
  return { ...m, awsCapacityCheck: vi.fn(check), default: { ...m.default, run: vi.fn(async () => ({ status: "error" as const, error: "Not built yet." })) } };
});
vi.mock("../src/insights/aws/feeds/prices", async (orig) => {
  const m = await orig<typeof import("../src/insights/aws/feeds/prices")>();
  const info = (rows: { item: string; gbp: number; fetched_at: string }[], _cfg: unknown, region: string, size: string): PriceInfo => ({
    region,
    size,
    vmGbpPerHour: rows.find((r) => r.item === size)?.gbp ?? null,
    diskGbpPerHour: null,
    ipGbpPerHour: rows.find((r) => r.item === "ip:v4")?.gbp ?? null,
    totalGbpPerHour: 0.0123,
    standbyGbpPerHour: 0.0045,
    fetchedAt: rows[0]?.fetched_at ?? null,
    stale: false,
    source: "aws",
    reason: null,
  });
  return { ...m, awsPriceInfo: vi.fn(info) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const AWS_ON: Partial<Env> = { ...NO_AZURE, AWS_ENABLED: "1" };
const NO_AWS_KEYS: Partial<Env> = { ...NO_AZURE, AWS_ENABLED: "1", AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined };
const LAUNCH = "2026-10-04T08:00:00.000Z";

/** An env at NOW whose every outside call is counted (and refused). */
function routeEnv(over: Partial<Env> = AWS_ON) {
  const { env } = apiEnv(over);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const spy = vi.fn(async (..._a: unknown[]) => new Response("no network in tests", { status: 503 }));
  vi.stubGlobal("fetch", spy);
  return { env, spy };
}

/** The server running in AWS (London, t4g.micro), with a version-7 agent. */
const awsRunning = (env: Env) =>
  saveSnapshot(env, { state: "running", cloud: "aws", region: "eu-west-2", vm_size: "t4g.micro", since: ago(120), running_since: ago(120), last_agent_at: ago(0.5), agent: agentReport(), public_ip: "198.51.100.7", azure: null });

const HEALTH: AwsHealthDoc = {
  instanceId: "i-0abc",
  health: { state: "Available", title: "Both AWS status checks passed.", summary: "Both AWS status checks passed.", reason: null, since: null, power: "Server running", provisioning: null, vmAgent: null, bootDiagnostics: true, checkedAt: ago(2) },
  maintenance: [{ id: "instance-event-0a1", type: "system-reboot", status: "Scheduled", notBefore: iso(NOW.getTime() + 180 * MIN), source: "AWS", description: "scheduled reboot", durationS: 7200 }],
};
const BOOT: AwsBootLogDoc = { fetchedAt: ago(30), bytes: 41, truncated: false, redactions: 1, text: "Linux version 6.8.0-aws\npassword ‹redacted›\n", reason: null, launchTime: LAUNCH };
const CAPACITY: CapacityDoc = {
  sizes: [
    { name: "t4g.micro", available: true, reason: null, vcpus: 2, family: "standard" },
    { name: "t4g.nano", available: true, reason: null, vcpus: 2, family: "standard" },
  ],
  usages: [{ family: "standard", used: 2, limit: 32 }],
  cores: { used: 2, limit: 32 },
};

/** What the AWS feeds would have stored by NOW. */
async function seedAws(env: Env): Promise<void> {
  const db = env.DB;
  const feed = (id: string, status: string, ok: string | null, error: string | null = null) =>
    db.prepare("INSERT INTO aws_feed (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, ago(2), ok, status, error, ago(-3));
  const vm = (t: string, cols: Record<string, number | null>) => {
    const keys = Object.keys(cols);
    return db.prepare(`INSERT INTO hist_aws_vm (res, t${keys.map((k) => `, ${k}`).join("")}) VALUES (CAST(?1 AS INTEGER), ?2${keys.map((_, i) => `, ?${i + 3}`).join("")})`).bind(300, t, ...keys.map((k) => cols[k]));
  };
  const act = (id: string, at: string, op: string, caller: string, kind: string, type: string, name: string) =>
    db.prepare("INSERT INTO aws_activity (id, at, operation, status, caller, caller_kind, resource_type, resource_name) VALUES (?1, ?2, ?3, 'Succeeded', ?4, ?5, ?6, ?7)").bind(id, at, op, caller, kind, type, name);
  const ev = (id: string, status: string, region: string, updated: string) =>
    db.prepare("INSERT INTO aws_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES (?1, 'ServiceIssue', ?2, NULL, ?3, 'Some summary.', '[\"EC2\"]', ?4, ?5, NULL, ?5)").bind(id, status, `Issue ${id}`, JSON.stringify([region]), updated);
  const price = (item: string, gbp: number, unit: string) => db.prepare("INSERT INTO aws_prices (region, item, gbp, unit, meter, fetched_at) VALUES ('eu-west-2', ?1, ?2, ?3, 'usage', ?4)").bind(item, gbp, unit, ago(120));
  await db.batch([
    feed("aws.health", "ok", ago(2)),
    feed("aws.metrics", "ok", ago(5)),
    feed("aws.activity", "ok", ago(2)),
    feed("aws.serviceHealth", "error", ago(60), "AWS's status feed for EC2 answered 503."),
    feed("aws.capacity", "ok", ago(60)),
    feed("aws.prices", "ok", ago(120)),
    feed("aws.bootLog", "ok", ago(30)),
    feed("aws.housekeeping", "ok", ago(300)),
    vm("2026-10-04T09:50:00Z", { cpu_avg: 4, cpu_max: 9, net_in: 1000, net_out: 500, credits_min: 140, credits_used: 0.3, pkts_in: 120, pkts_out: 80, status_failed: 0 }),
    vm("2026-10-04T09:55:00Z", { cpu_avg: 6, cpu_max: 12, net_in: 2000, net_out: null, credits_min: 139, credits_used: 0.4, pkts_in: 100, pkts_out: null, status_failed: 0 }),
    vm("2026-10-04T10:00:00Z", { cpu_avg: 8, cpu_max: 20, net_in: 400, net_out: 600, credits_min: 138.5, credits_used: 0.5, pkts_in: 50, pkts_out: 30, status_failed: 0 }),
    db.prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES ('health', ?1, ?2)").bind(JSON.stringify(HEALTH), ago(2)),
    db.prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES ('bootlog', ?1, ?2)").bind(JSON.stringify(BOOT), ago(30)),
    act("e1", ago(60), "RunInstances", "wg-admin-worker", "wgadmin", "EC2 instance", "i-0abc"),
    act("e2", ago(30), "AuthorizeSecurityGroupIngress", "someone", "person", "Security group", "sg-wg"),
    act("e3", ago(10), "ModifyInstanceAttribute", "ec2.amazonaws.com", "aws", "EC2 instance", "i-0abc"),
    act("e4", ago(3 * 24 * 60), "CreateTags", "wg-admin-worker", "wgadmin", "EC2 instance", "i-0abc"),
    ev("aws-ec2-london-now", "Active", "London", ago(12)),
    ev("aws-vpc-london-old", "Resolved", "London", ago(5 * 24 * 60)),
    ev("aws-ec2-ireland", "Active", "Ireland", ago(12)),
    db.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES ('eu-west-2', ?1, ?2)").bind(JSON.stringify(CAPACITY), ago(60)),
    price("t4g.micro", 0.0067, "1 Hour"),
    price("disk:gp3", 0.0705, "GB-Mo"),
    price("ip:v4", 0.0039, "1 Hour"),
  ]);
}

const byId = (feeds: any[], id: string) => feeds.find((f) => f.id === id);

describe("/api/v1/azure on AWS", () => {
  it("summary reads AWS's tables: region, health, maintenance, London's issue, the newest slot, and each feed with its AWS source", async () => {
    const { env, spy } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.cloud).toBe("aws");
    expect(s.configured).toBe(true);
    expect(s.region).toEqual({ id: "eu-west-2", name: "London" });
    expect(s.health).toEqual({ ...HEALTH.health, annotations: [] });
    expect(s.maintenance).toEqual(HEALTH.maintenance);
    expect(s.serviceIssues.map((e: any) => e.trackingId)).toEqual(["aws-ec2-london-now"]);
    expect(s.latest).toEqual({ cpuPct: 8, creditsLeft: 138.5, creditsTrend: "falling", memFreeBytes: null, vipAvailPct: null, underDdos: null, at: "2026-10-04T10:00:00Z" });
    expect(s.agent).toBe("current");
    // Every Azure FeedId, in FEEDS order, answered by the AWS feed standing in for it.
    expect(s.feeds.map((f: any) => f.id)).toEqual(FEEDS.map((f) => f.id));
    expect(byId(s.feeds, "health")).toEqual({ id: "health", title: "Instance health", status: "ok", lastOkAt: ago(2), error: null, cadenceMin: 5, source: "AWS EC2" });
    for (const id of ["vmMetrics", "pipMetrics"]) expect(byId(s.feeds, id)).toEqual({ id, title: "CloudWatch metrics", status: "ok", lastOkAt: ago(5), error: null, cadenceMin: 15, source: "AWS CloudWatch" });
    expect(byId(s.feeds, "metricDefs")).toEqual({ id: "metricDefs", title: "Metric names", status: "ok", lastOkAt: null, error: null, cadenceMin: null, source: "AWS CloudWatch" });
    expect(byId(s.feeds, "serviceHealth")).toEqual({ id: "serviceHealth", title: "Service health", status: "error", lastOkAt: ago(60), error: "AWS's status feed for EC2 answered 503.", cadenceMin: 15, source: "AWS public status feed" });
    expect(byId(s.feeds, "activity").source).toBe("AWS CloudTrail");
    expect(byId(s.feeds, "capacity").source).toBe("AWS Service Quotas");
    expect(byId(s.feeds, "prices").source).toBe("AWS Price List");
    expect(byId(s.feeds, "bootLog")).toMatchObject({ source: "AWS console output", cadenceMin: null });
    expect(spy).not.toHaveBeenCalled();
  });

  it("metrics: vm serves VM_COLUMNS from hist_aws_vm (Azure-only columns null); pip is packets and bytes from the same rows, nulls kept", async () => {
    const { env, spy } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    let r = await api(env, "GET", "/azure/metrics?resource=vm&range=1h");
    expect(r.json).toMatchObject({ cloud: "aws", resource: "vm", range: "1h", step: 300, columns: ["t", ...VM_COLUMNS] });
    expect(r.json.points).toHaveLength(3);
    expect(r.json.points[2]).toEqual({ t: "2026-10-04T10:00:00Z", cpu_avg: 8, cpu_max: 20, mem_free_min: null, net_in: 400, net_out: 600, disk_read: null, disk_write: null, disk_rops: null, disk_wops: null, credits_min: 138.5, credits_used: 0.5, avail_avg: null, os_iops_max: null, os_bw_max: null });
    // 7d groups slots in half hours: peaks take the max, minimums the min, the rest average.
    r = await api(env, "GET", "/azure/metrics?resource=vm&range=7d");
    expect(r.json.step).toBe(1800);
    expect(r.json.points).toEqual([
      expect.objectContaining({ t: "2026-10-04T09:30:00Z", cpu_avg: 5, cpu_max: 12, credits_min: 139, net_out: 500, mem_free_min: null }),
      expect.objectContaining({ t: "2026-10-04T10:00:00Z", cpu_avg: 8, cpu_max: 20, credits_min: 138.5 }),
    ]);
    r = await api(env, "GET", "/azure/metrics?resource=pip&range=1h");
    expect(r.json).toMatchObject({ cloud: "aws", resource: "pip", step: 300, columns: ["t", ...PIP_COLUMNS] });
    const nulls = { ddos_max: null, pkts_in_ddos: null, pkts_drop_ddos: null, bytes_in_ddos: null, bytes_drop_ddos: null, syn: null, vip_avail: null };
    expect(r.json.points).toEqual([
      { t: "2026-10-04T09:50:00Z", ...nulls, packets: 200, bytes: 450_000 },
      { t: "2026-10-04T09:55:00Z", ...nulls, packets: null, bytes: null },
      { t: "2026-10-04T10:00:00Z", ...nulls, packets: 80, bytes: 300_000 },
    ]);
    // The vitals come from the heartbeat whatever the cloud.
    r = await api(env, "GET", "/azure/metrics?resource=vitals&range=1h");
    expect(r.json).toMatchObject({ cloud: "aws", resource: "vitals", columns: ["t", ...VITALS_COLUMNS], points: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("changes read aws_activity: newest first, the who filter, the range, and AWS's own calls as the platform", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    let r = await api(env, "GET", "/azure/changes?range=24h&who=all");
    expect(r.json.cloud).toBe("aws");
    expect(r.json.feed).toMatchObject({ id: "activity", status: "ok", source: "AWS CloudTrail", cadenceMin: 5 });
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["e3", "e2", "e1"]);
    expect(r.json.rows[1]).toEqual({ id: "e2", at: ago(30), operation: "AuthorizeSecurityGroupIngress", status: "Succeeded", caller: "someone", callerKind: "person", resourceType: "Security group", resourceName: "sg-wg" });
    expect(r.json.rows[0].callerKind).toBe("azure");
    expect(r.json.rows[2].callerKind).toBe("wgadmin");
    r = await api(env, "GET", "/azure/changes?range=24h&who=others");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["e3", "e2"]);
    r = await api(env, "GET", "/azure/changes?range=7d&who=wgadmin");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["e1", "e4"]);
  });

  it("service-health is the region's AWS events, active first; another region's are left out", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    let r = await api(env, "GET", "/azure/service-health?range=7d");
    expect(r.json.cloud).toBe("aws");
    expect(r.json.events.map((e: any) => e.trackingId)).toEqual(["aws-ec2-london-now", "aws-vpc-london-old"]);
    expect(r.json.events[0]).toMatchObject({ type: "ServiceIssue", status: "Active", services: ["EC2"] });
    expect(r.json.feed).toMatchObject({ id: "serviceHealth", status: "error", source: "AWS public status feed" });
    r = await api(env, "GET", "/azure/service-health?range=30d");
    expect(r.json.events.map((e: any) => e.trackingId)).toEqual(["aws-ec2-london-now", "aws-vpc-london-old"]);
  });

  it("capacity and price take an AWS region and instance type and answer from the AWS tables", async () => {
    const { env, spy } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    let r = await api(env, "GET", "/azure/capacity?region=eu-west-2&size=t4g.micro");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ region: "eu-west-2", size: "t4g.micro", available: true, ok: true, fetchedAt: ago(60) });
    expect(vi.mocked(awsCapacityCheck)).toHaveBeenCalledWith(CAPACITY, "eu-west-2", "t4g.micro", expect.any(Boolean), ago(60));
    expect(vi.mocked(capacityFeed.run)).not.toHaveBeenCalled();
    r = await api(env, "GET", "/azure/price?region=eu-west-2&size=t4g.micro");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ region: "eu-west-2", size: "t4g.micro", source: "aws", vmGbpPerHour: 0.0067, ipGbpPerHour: 0.0039 });
    const rows = vi.mocked(awsPriceInfo).mock.calls[0]![0];
    expect(rows.map((x) => x.item).sort()).toEqual(["disk:gp3", "ip:v4", "t4g.micro"]);
    expect(rows[0]).toMatchObject({ region: "eu-west-2", fetched_at: ago(120) });
    // An AWS region wants an EC2 instance type, and an Azure region an Azure size.
    for (const path of ["/azure/capacity?region=eu-west-2&size=Standard_B1s", "/azure/capacity?region=uksouth&size=t4g.micro", "/azure/price?region=eu-west-2&size=Standard_B1s"]) {
      r = await api(env, "GET", path);
      expect(r.status, path).toBe(400);
      expect(r.json.error, path).toMatchObject({ code: "bad_input", field: "size" });
    }
    expect((await api(env, "GET", "/azure/capacity?region=eu-west-9x&size=t4g.micro")).json.error).toMatchObject({ field: "region" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a capacity cache miss for AWS's region runs the AWS capacity feed once per 10 minutes; another AWS region is never fetched", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    vi.mocked(capacityFeed.run).mockImplementationOnce(async (ctx) => {
      expect(ctx.region).toBe("eu-west-2");
      await ctx.db.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES ('eu-west-2', ?1, ?2)").bind(JSON.stringify(CAPACITY), ctx.now.toISOString()).run();
      return { status: "ok", error: null };
    });
    let r = await api(env, "GET", "/azure/capacity?region=eu-west-2&size=t4g.micro");
    expect(r.json).toMatchObject({ region: "eu-west-2", size: "t4g.micro", available: true, fetchedAt: NOW.toISOString() });
    expect(vi.mocked(capacityFeed.run)).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare("SELECT status FROM aws_feed WHERE feed = 'aws.capacity'").first<{ status: string }>())?.status).toBe("ok");
    // Another size the doc lacks: the 10-minute rule holds, no second run.
    r = await api(env, "GET", "/azure/capacity?region=eu-west-2&size=t4g.large");
    expect(r.json).toMatchObject({ region: "eu-west-2", size: "t4g.large", available: false });
    expect(vi.mocked(capacityFeed.run)).toHaveBeenCalledTimes(1);
    r = await api(env, "GET", "/azure/capacity?region=eu-west-1&size=t4g.micro");
    expect(r.json).toMatchObject({ region: "eu-west-1", available: null, fetchedAt: null });
    expect(vi.mocked(capacityFeed.run)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(awsCapacityCheck)).toHaveBeenLastCalledWith(null, "eu-west-1", "t4g.micro", expect.any(Boolean), null);
  });

  it("diagnostics list the AWS feeds with their timing and AWS's metric names", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    await seedAws(env);
    const r = (await api(env, "GET", "/azure/diagnostics")).json;
    expect(r.cloud).toBe("aws");
    expect(r.configured).toBe(true);
    expect(r.feeds.map((f: any) => f.id)).toEqual(FEEDS.map((f) => f.id));
    expect(byId(r.feeds, "health")).toEqual({ id: "health", title: "Instance health", status: "ok", lastOkAt: ago(2), error: null, cadenceMin: 5, source: "AWS EC2", lastTryAt: ago(2), nextDueAt: ago(-3) });
    expect(byId(r.feeds, "metricDefs")).toMatchObject({ status: "ok", source: "AWS CloudWatch", lastTryAt: null, nextDueAt: null });
    expect(r.metricNames.vm).toEqual(expect.arrayContaining(["CPUUtilization", "CPUCreditBalance", "EBSReadBytes", "StatusCheckFailed"]));
    expect(new Set(r.metricNames.vm).size).toBe(r.metricNames.vm.length);
    expect(r.metricNames.pip).toEqual(["NetworkPacketsIn", "NetworkPacketsOut", "NetworkIn", "NetworkOut"]);
  });

  it("bootlog GET serves the stored console output without its launch time, or why there is none", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    let r = await api(env, "GET", "/azure/bootlog");
    expect(r.json).toEqual({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: "AWS has no console output for this server yet." });
    await seedAws(env);
    r = await api(env, "GET", "/azure/bootlog");
    const { launchTime: _l, ...want } = BOOT;
    expect(r.json).toEqual(want);
    const { env: off } = routeEnv(NO_AWS_KEYS);
    await awsRunning(off);
    r = await api(off, "GET", "/azure/bootlog");
    expect(r.json.reason).toBe("AWS isn't connected. Add the Worker's AWS keys.");
  });

  it("bootlog POST fetches through the AWS boot log helper: the doc, 429 slow_down, 502 upstream; nothing without AWS keys", async () => {
    const { env } = routeEnv();
    await awsRunning(env);
    vi.mocked(fetchAwsBootLogNow).mockResolvedValueOnce({ ok: true, doc: BOOT });
    let r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    const { launchTime: _l, ...want } = BOOT;
    expect(r.json).toEqual(want);
    vi.mocked(fetchAwsBootLogNow).mockResolvedValueOnce({ ok: false, why: "slow_down", message: "One a minute." });
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("slow_down");
    vi.mocked(fetchAwsBootLogNow).mockResolvedValueOnce({ ok: false, why: "error", message: "AWS refused GetConsoleOutput: the Worker's AWS user needs ec2:GetConsoleOutput." });
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(502);
    expect(r.json.error).toMatchObject({ code: "upstream", message: "Could not fetch the boot log: AWS refused GetConsoleOutput: the Worker's AWS user needs ec2:GetConsoleOutput." });
    vi.mocked(fetchAwsBootLogNow).mockRejectedValueOnce(new Error("Not built yet."));
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(502);
    expect(vi.mocked(fetchAwsBootLogNow)).toHaveBeenCalledTimes(4);
    const { env: off } = routeEnv(NO_AWS_KEYS);
    await awsRunning(off);
    r = await api(off, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    expect(r.json.reason).toBe("AWS isn't connected. Add the Worker's AWS keys.");
    expect(vi.mocked(fetchAwsBootLogNow)).toHaveBeenCalledTimes(4);
  });

  it("Review Focus 1: a destroyed server whose last cloud was AWS reads AWS's tables with no headend and no crash", async () => {
    const { env, spy } = routeEnv();
    await saveSnapshot(env, { state: "destroyed", cloud: "aws", region: "eu-west-2", vm_size: "t4g.micro", agent: null, since: ago(20) });
    await seedAws(env);
    let r = await api(env, "GET", "/azure/summary");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ cloud: "aws", configured: true, region: { id: "eu-west-2", name: "London" }, health: null, maintenance: [], vitals: null, agent: "none" });
    expect(r.json.serviceIssues.map((e: any) => e.trackingId)).toEqual(["aws-ec2-london-now"]);
    expect(r.json.latest.cpuPct).toBe(8);
    r = await api(env, "GET", "/azure/changes?range=24h");
    expect(r.status).toBe(200);
    expect(r.json.cloud).toBe("aws");
    expect(r.json.rows.map((x: any) => x.id)).toEqual(["e3", "e2", "e1"]);
    for (const path of ["/azure/metrics?resource=vm&range=1h", "/azure/service-health", "/azure/diagnostics", "/azure/bootlog"]) {
      r = await api(env, "GET", path);
      expect(r.status, path).toBe(200);
    }
    // With nothing stored at all, still no crash.
    const { env: bare } = routeEnv();
    await saveSnapshot(bare, { state: "destroyed", cloud: "aws" });
    r = await api(bare, "GET", "/azure/summary");
    expect(r.json).toMatchObject({ cloud: "aws", health: null, maintenance: [], serviceIssues: [], latest: { cpuPct: null, at: null } });
    expect((await api(bare, "GET", "/azure/bootlog")).json.reason).toBe("No VM");
    expect(spy).not.toHaveBeenCalled();
  });

  it("without the Worker's AWS keys every AWS feed reads not_configured and nothing is fetched", async () => {
    const { env, spy } = routeEnv(NO_AWS_KEYS);
    await awsRunning(env);
    await seedAws(env);
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.cloud).toBe("aws");
    expect(s.configured).toBe(false);
    expect(s.feeds.every((f: any) => f.status === "not_configured" && f.error === null)).toBe(true);
    expect((await api(env, "GET", "/azure/diagnostics")).json.configured).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("with the server in Azure the routes read Azure's tables, tagged cloud azure and source Azure", async () => {
    const { env } = routeEnv(NO_AZURE);
    await saveSnapshot(env, { state: "running", region: "uksouth", vm_size: "Standard_B1s", since: ago(120), agent: agentReport() });
    await seedAws(env);
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s.cloud).toBe("azure");
    expect(s.region).toEqual({ id: "uksouth", name: "UK South" });
    expect(s.feeds.every((f: any) => f.source === "Azure")).toBe(true);
    expect(s.health).toBeNull();
    expect(s.latest.cpuPct).toBeNull();
    const c = (await api(env, "GET", "/azure/changes?range=24h")).json;
    expect(c).toMatchObject({ cloud: "azure", rows: [], feed: { source: "Azure" } });
    expect((await api(env, "GET", "/azure/metrics?resource=vm&range=1h")).json).toMatchObject({ cloud: "azure", points: [] });
    expect((await api(env, "GET", "/azure/service-health")).json).toMatchObject({ cloud: "azure", events: [] });
    expect((await api(env, "GET", "/azure/diagnostics")).json.cloud).toBe("azure");
  });
});

describe("overview and settings carry AWS's capacity and list price", () => {
  it("awsCapacity and awsPrice come from the stored AWS readings, null before any", async () => {
    const { env } = routeEnv();
    let o = (await api(env, "GET", "/overview")).json;
    expect(o.awsCapacity).toBeNull();
    let s = (await api(env, "GET", "/settings")).json;
    expect(s.awsPrice).toBeNull();
    await seedAws(env);
    o = (await api(env, "GET", "/overview")).json;
    expect(o.awsCapacity).toMatchObject({ region: "eu-west-2", size: "t4g.micro", ok: true, fetchedAt: ago(60) });
    expect(vi.mocked(awsCapacityCheck)).toHaveBeenCalledWith(CAPACITY, "eu-west-2", "t4g.micro", expect.any(Boolean), ago(60));
    s = (await api(env, "GET", "/settings")).json;
    expect(s.awsPrice).toMatchObject({ region: "eu-west-2", size: "t4g.micro", source: "aws", totalGbpPerHour: 0.0123 });
    // Azure's own fields are untouched.
    expect(s.price).toMatchObject({ region: "uksouth", source: "fixed" });
    expect(o.capacity).toBeNull();
  });

  it("a helper that throws leaves awsCapacity and awsPrice null rather than failing the page", async () => {
    const { env } = routeEnv();
    await seedAws(env);
    vi.mocked(awsCapacityCheck).mockImplementationOnce(() => {
      throw new Error("Not built yet.");
    });
    vi.mocked(awsPriceInfo).mockImplementationOnce(() => {
      throw new Error("Not built yet.");
    });
    const o = await api(env, "GET", "/overview");
    expect(o.status).toBe(200);
    expect(o.json.awsCapacity).toBeNull();
    const s = await api(env, "GET", "/settings");
    expect(s.status).toBe(200);
    expect(s.json.awsPrice).toBeNull();
  });
});

describe("the insights-aws dev story", () => {
  const rows = async (env: Env, table: string) => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n);

  it("is the running story in AWS with every AWS table filled, shown as connected on the dev server; other stories wipe it", async () => {
    expect(SCENARIOS).toContain("insights-aws");
    const { env } = apiEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await seedScenario(env, "insights-aws", NOW);
    for (const t of AWS_TABLES) expect(await rows(env, t), t).toBeGreaterThan(0);
    for (const t of AZ_TABLES) expect(await rows(env, t), t).toBe(0);
    const snap = await getSnapshot(env);
    expect(snap).toMatchObject({ state: "running", cloud: "aws", region: "eu-west-2" });
    const s = (await api(env, "GET", "/azure/summary")).json;
    expect(s).toMatchObject({ cloud: "aws", configured: true, region: { name: "London" }, agent: "current" });
    expect(s.feeds.every((f: any) => f.status === "ok")).toBe(true);
    expect(s.health).toMatchObject({ state: "Available", annotations: [] });
    expect(s.maintenance).toHaveLength(1);
    expect(s.serviceIssues).toHaveLength(1);
    expect(s.latest.cpuPct).not.toBeNull();
    expect(s.vitals).not.toBeNull();
    const c = (await api(env, "GET", "/azure/changes?range=7d&who=others")).json;
    expect(c.rows.some((x: any) => x.callerKind === "person")).toBe(true);
    const b = (await api(env, "GET", "/azure/bootlog")).json;
    expect(b.text).toMatch(/Linux version/);
    expect(b).not.toHaveProperty("launchTime");
    // Fake identities only.
    const all = JSON.stringify((await env.DB.prepare("SELECT * FROM aws_activity").all()).results) + JSON.stringify((await env.DB.prepare("SELECT * FROM aws_latest").all()).results);
    expect(all).not.toMatch(/clydeford|@gmail|arn:aws|"\d{12}"/);
    await seedScenario(env, "running", NOW);
    for (const t of AWS_TABLES) expect(await rows(env, t), `running ${t}`).toBe(0);
    expect(cloudOfSnap(await getSnapshot(env))).toBe("azure");
  }, 60_000);
});

const cloudOfSnap = (s: { cloud?: string | null }) => s.cloud ?? "azure";
