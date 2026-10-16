// insights-aws-region.test.ts
//
// Plain English: the two AWS region feeds (AWS insights spec sections 4.5
// and 4.6). Capacity: is the instance type (and the test VM's t4g.nano)
// offered in the region, how many vCPUs each needs, and how much of the
// On-Demand Standard vCPU quota is in use; turned into the deploy form's
// warning by awsCapacityCheck. Prices: AWS's list prices for the instance,
// the 8 GB gp3 disk and the public IPv4 address (the Price List API, whose
// PriceList entries are JSON strings, so parsed twice), converted to GBP with
// the configured rate; turned into Settings' AWS price line by awsPriceInfo.
// Every AWS answer comes from saved replies in fixtures/aws-insights; no
// call leaves the test.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import capacity, { AWS_TEST_VM_SIZE, awsCapacityCheck, awsCapacitySizes, awsLabCapacitySizes, normaliseAwsCapacity, readAwsCapacity, runningStandardVcpus } from "../src/insights/aws/feeds/capacity";
import prices, { AWS_DISK_GB, awsPriceBodies, awsPriceInfo, normaliseAwsPrices, readAwsPrices } from "../src/insights/aws/feeds/prices";
import { runAwsInsights } from "../src/insights/aws/runner";
import { makeBudget, type CapacityDoc } from "../src/insights/types";
import type { PriceRow } from "../src/insights/price";
import { effectiveConfig } from "../src/settings";
import { config, type Env } from "../src/env";
import { getSnapshot } from "../src/state";
import { azureEnv, running, NOW, iso } from "./insights-helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const AWS_ON: Partial<Env> = { AWS_ENABLED: "1" };
const DAY = 86_400_000;

const text = (name: string) => readFileSync(new URL(`./fixtures/aws-insights/${name}`, import.meta.url), "utf8");
const jsonFixture = (name: string) => JSON.parse(text(name));

interface AwsCall {
  host: string;
  action: string | null;
  params: URLSearchParams;
  target: string | null;
  body: any;
  auth: string;
}

/** A pretend AWS: records every *.amazonaws.com call and answers it with `answer`, or from the fixtures. */
function withAws(answer: (c: AwsCall) => Response | undefined = () => undefined) {
  const inner = globalThis.fetch;
  const calls: AwsCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : typeof input === "string" ? input : (input as URL).href;
    const u = new URL(url);
    if (!u.hostname.endsWith("amazonaws.com")) return inner(input, init);
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    const headers = new Headers(req ? req.headers : init?.headers);
    const target = headers.get("x-amz-target");
    const params = new URLSearchParams(target ? "" : raw);
    const call: AwsCall = { host: u.hostname, action: params.get("Action"), params, target, body: target ? JSON.parse(raw) : null, auth: headers.get("authorization") ?? "" };
    calls.push(call);
    const r = answer(call);
    if (r) return r;
    if (call.action === "DescribeInstanceTypeOfferings") return new Response(text("offerings.xml"), { status: 200 });
    if (call.action === "DescribeInstanceTypes") return new Response(text("instance-types.xml"), { status: 200 });
    if (call.action === "DescribeInstances") return new Response(text("instances-running.xml"), { status: 200 });
    if (call.target === "ServiceQuotasV20190624.GetServiceQuota") return new Response(text("quota.json"), { status: 200 });
    if (call.target === "AWSPriceListService.GetProducts") {
      const fields = Object.fromEntries((call.body.Filters as { Field: string; Value: string }[]).map((f) => [f.Field, f.Value]));
      if (fields.instanceType) return new Response(text("price-instance.json"), { status: 200 });
      if (fields.volumeApiName) return new Response(text("price-gp3.json"), { status: 200 });
      if (fields.group) return new Response(text("price-ip.json"), { status: 200 });
    }
    throw new Error(`unexpected AWS call ${call.host} ${call.action ?? call.target}`);
  });
  return calls;
}

async function opts(env: Env, budget = makeBudget(25)) {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return { budget, late: () => false, snap, cfg };
}

async function feedRow(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM aws_feed WHERE feed = ?1").bind(id).first<{ status: string; error: string | null; next_due_at: string | null }>();
}

const replies = (over: Partial<{ offerings: string; types: string | null; quota: unknown; instances: string }> = {}) => ({
  offerings: text("offerings.xml"),
  types: text("instance-types.xml"),
  quota: jsonFixture("quota.json"),
  instances: text("instances-running.xml"),
  ...over,
});

const doc = (over: Partial<CapacityDoc> = {}): CapacityDoc => ({
  sizes: [
    { name: "t4g.micro", available: true, reason: null, vcpus: 2, family: "standard" },
    { name: "t4g.nano", available: true, reason: null, vcpus: 2, family: "standard" },
  ],
  usages: [{ family: "standard", used: 6, limit: 32 }],
  cores: { used: 6, limit: 32 },
  ...over,
});

describe("AWS capacity: reading the replies", () => {
  it("asks about the configured instance type and the test VM's t4g.nano", async () => {
    const { env } = azureEnv(AWS_ON);
    expect(AWS_TEST_VM_SIZE).toBe("t4g.nano");
    expect(awsCapacitySizes(config(env))).toEqual(["t4g.micro", "t4g.nano"]);
    const { env: big } = azureEnv({ ...AWS_ON, AWS_INSTANCE_TYPE: "t4g.small" });
    expect(awsCapacitySizes(config(big))).toEqual(["t4g.small", "t4g.nano"]);
    const { env: nano } = azureEnv({ ...AWS_ON, AWS_INSTANCE_TYPE: "t4g.nano" });
    expect(awsCapacitySizes(config(nano))).toEqual(["t4g.nano"]);
  });

  it("offered sizes carry their vCPUs; the quota and the running Standard vCPUs fill usages and cores", () => {
    expect(normaliseAwsCapacity(replies(), ["t4g.micro", "t4g.nano"])).toEqual(doc());
  });

  it("counts only pending/running On-Demand Standard instances: no spot, no GPU (g) family; vCPUs = cores × threads", () => {
    // t4g.micro 2×1 + m5.large 1×2 + t3.small (pending) 1×2; the spot c5.large and the g4dn.xlarge are left out.
    expect(runningStandardVcpus(text("instances-running.xml"))).toBe(6);
    expect(runningStandardVcpus("<DescribeInstancesResponse><reservationSet/></DescribeInstancesResponse>")).toBe(0);
  });

  it("a size the region doesn't offer reads NotOffered, with no vCPUs", () => {
    const offerings = "<DescribeInstanceTypeOfferingsResponse><instanceTypeOfferingSet><item><instanceType>t4g.nano</instanceType><locationType>region</locationType><location>eu-west-2</location></item></instanceTypeOfferingSet></DescribeInstanceTypeOfferingsResponse>";
    const d = normaliseAwsCapacity(replies({ offerings }), ["t4g.micro", "t4g.nano"]);
    expect(d.sizes[0]).toEqual({ name: "t4g.micro", available: false, reason: "NotOffered", vcpus: null, family: "standard" });
    expect(d.sizes[1]).toMatchObject({ name: "t4g.nano", available: true, vcpus: 2 });
  });

  it("an unreadable quota leaves the quota unjudged rather than inventing one", () => {
    const d = normaliseAwsCapacity(replies({ quota: { Quota: {} } }), ["t4g.micro"]);
    expect(d.usages).toEqual([]);
    expect(d.cores).toBeNull();
  });
});

describe("AWS capacity: the deploy form's check", () => {
  it("not read yet: every figure null", () => {
    expect(awsCapacityCheck(null, "eu-west-2", "t4g.micro", true, null)).toEqual({ region: "eu-west-2", size: "t4g.micro", available: null, reason: null, vcpusNeeded: null, family: null, total: null, ok: null, message: null, fetchedAt: null });
  });

  it("room in the quota: ok, with the quota in the quiet line and the Standard (T family) figures", () => {
    const c = awsCapacityCheck(doc(), "eu-west-2", "t4g.micro", true, iso(NOW.getTime()));
    expect(c).toMatchObject({ available: true, reason: null, vcpusNeeded: 4, ok: true, fetchedAt: iso(NOW.getTime()) });
    expect(c.family).toEqual({ name: "Standard (T family)", used: 6, limit: 32 });
    expect(c.total).toEqual({ used: 6, limit: 32 });
    expect(c.message).toBe("Available · vCPU quota 6 of 32 used");
    expect(awsCapacityCheck(doc(), "eu-west-2", "t4g.micro", false, null).vcpusNeeded).toBe(2);
  });

  it("quota near full: the test VM's vCPUs tip it over, ok false with the numbers", () => {
    const full = doc({ usages: [{ family: "standard", used: 30, limit: 32 }], cores: { used: 30, limit: 32 } });
    const c = awsCapacityCheck(full, "eu-west-2", "t4g.micro", true, null);
    expect(c.ok).toBe(false);
    expect(c.vcpusNeeded).toBe(4);
    expect(c.message).toBe("Needs 4 On-Demand Standard vCPUs; 30 of 32 used in London.");
    // Without the test VM it just fits.
    expect(awsCapacityCheck(full, "eu-west-2", "t4g.micro", false, null).ok).toBe(true);
  });

  it("not offered in the region: ok false, the region by name", () => {
    const d = doc({ sizes: [{ name: "t4g.micro", available: false, reason: "NotOffered", vcpus: null, family: "standard" }, ...doc().sizes.slice(1)] });
    const c = awsCapacityCheck(d, "eu-west-2", "t4g.micro", false, null);
    expect(c).toMatchObject({ available: false, reason: "NotOffered", ok: false, message: "t4g.micro isn't offered in London." });
    expect(awsCapacityCheck(d, "us-east-1", "t4g.micro", false, null).message).toBe("t4g.micro isn't offered in N. Virginia.");
  });

  it("the test VM's size not offered, when the test VM is on: ok false", () => {
    const d = doc({ sizes: [doc().sizes[0]!, { name: "t4g.nano", available: false, reason: "NotOffered", vcpus: null, family: "standard" }] });
    const c = awsCapacityCheck(d, "eu-west-2", "t4g.micro", true, null);
    expect(c).toMatchObject({ ok: false, message: "The test VM's t4g.nano isn't offered in London." });
    expect(awsCapacityCheck(d, "eu-west-2", "t4g.micro", false, null).ok).toBe(true);
  });

  it("a size the doc doesn't list (another size asked for): not known", () => {
    expect(awsCapacityCheck(doc(), "eu-west-2", "t4g.large", false, null)).toMatchObject({ available: null, ok: null, message: null });
  });

  it("offered but the quota unreadable: available, quota not judged", () => {
    const c = awsCapacityCheck(doc({ usages: [], cores: null }), "eu-west-2", "t4g.micro", true, null);
    expect(c).toMatchObject({ available: true, vcpusNeeded: 4, ok: null, family: null, total: null });
  });
});

describe("AWS capacity: the feed", () => {
  it("makes its four calls in each lab region (London, then Ireland), stores a CapacityDoc and reads ok", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws();
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [capacity], await opts(env));
    expect(await feedRow(env, "aws.capacity")).toMatchObject({ status: "ok", error: null, next_due_at: iso(NOW.getTime() + DAY) });
    const four = ["DescribeInstanceTypeOfferings", "DescribeInstanceTypes", "ServiceQuotasV20190624.GetServiceQuota", "DescribeInstances"];
    expect(aws.map((c) => c.action ?? c.target)).toEqual([...four, ...four]);
    expect(aws.slice(4).map((c) => c.host)).toEqual(["ec2.eu-west-1.amazonaws.com", "ec2.eu-west-1.amazonaws.com", "servicequotas.eu-west-1.amazonaws.com", "ec2.eu-west-1.amazonaws.com"]);
    expect((await readAwsCapacity(env.DB, "eu-west-1"))?.fetchedAt).toBe(NOW.toISOString());
    const [off, types, quota, inst] = aws;
    expect(off!.host).toBe("ec2.eu-west-2.amazonaws.com");
    expect(off!.params.get("LocationType")).toBe("region");
    expect(off!.params.get("Filter.1.Name")).toBe("instance-type");
    expect([off!.params.get("Filter.1.Value.1"), off!.params.get("Filter.1.Value.2")]).toEqual(["t4g.micro", "t4g.nano"]);
    expect([types!.params.get("InstanceType.1"), types!.params.get("InstanceType.2")]).toEqual(["t4g.micro", "t4g.nano"]);
    expect(quota!.host).toBe("servicequotas.eu-west-2.amazonaws.com");
    expect(quota!.body).toEqual({ ServiceCode: "ec2", QuotaCode: "L-1216C47A" });
    expect(quota!.auth).toContain("/eu-west-2/servicequotas/");
    expect(inst!.params.get("Filter.1.Name")).toBe("instance-state-name");
    expect([inst!.params.get("Filter.1.Value.1"), inst!.params.get("Filter.1.Value.2")]).toEqual(["pending", "running"]);
    const stored = await readAwsCapacity(env.DB, "eu-west-2");
    // The labs' own sizes follow the server's two; the canned offerings list only those two, so the rest read NotOffered.
    const labOnly = awsLabCapacitySizes(config(env)).slice(2).map((name) => ({ name, available: false, reason: "NotOffered", vcpus: null, family: "standard" }));
    expect(stored).toEqual({ doc: doc({ sizes: [...doc().sizes, ...labOnly] }), fetchedAt: NOW.toISOString() });
    expect(awsCapacityCheck(stored!.doc, "eu-west-2", "t4g.micro", true, stored!.fetchedAt).ok).toBe(true);
  });

  it("with AWS_REGION set elsewhere it reads that region and Ireland only: never more than its 8 calls", async () => {
    const { env } = azureEnv({ ...AWS_ON, AWS_REGION: "us-east-1" });
    const aws = withAws();
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [capacity], await opts(env));
    expect(await feedRow(env, "aws.capacity")).toMatchObject({ status: "ok" });
    expect(aws.length).toBeLessThanOrEqual(capacity.calls);
    expect(capacity.calls).toBe(8);
    expect([...new Set(aws.map((c) => c.host.split(".")[1]))]).toEqual(["us-east-1", "eu-west-1"]);
    expect(await readAwsCapacity(env.DB, "eu-west-2")).toBeNull();
  });

  it("nothing offered: DescribeInstanceTypes is not asked (it refuses unknown types)", async () => {
    const { env } = azureEnv(AWS_ON);
    const aws = withAws((c) => (c.action === "DescribeInstanceTypeOfferings" ? new Response("<DescribeInstanceTypeOfferingsResponse><instanceTypeOfferingSet/></DescribeInstanceTypeOfferingsResponse>", { status: 200 }) : undefined));
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [capacity], await opts(env));
    expect(aws.map((c) => c.action ?? c.target)).not.toContain("DescribeInstanceTypes");
    const stored = await readAwsCapacity(env.DB, "eu-west-2");
    expect(stored!.doc.sizes.every((s) => !s.available && s.reason === "NotOffered")).toBe(true);
    expect(awsCapacityCheck(stored!.doc, "eu-west-2", "t4g.micro", false, null)).toMatchObject({ ok: false, message: "t4g.micro isn't offered in London." });
  });

  it("a refused quota call names the permission and keeps the last reading", async () => {
    const { env } = azureEnv(AWS_ON);
    await env.DB.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES ('eu-west-2', ?1, ?2)").bind(JSON.stringify(doc()), iso(NOW.getTime() - 2 * DAY)).run();
    withAws((c) => (c.target?.endsWith("GetServiceQuota") ? new Response(JSON.stringify({ __type: "AccessDeniedException", message: "User: arn:aws:iam::123456789012:user/x is not authorized" }), { status: 400 }) : undefined));
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [capacity], await opts(env));
    const row = await feedRow(env, "aws.capacity");
    expect(row).toMatchObject({ status: "error", error: "AWS refused GetServiceQuota: the Worker's AWS user needs servicequotas:GetServiceQuota." });
    expect(row!.error).not.toMatch(/arn:|amazonaws|Signature/);
    expect((await readAwsCapacity(env.DB, "eu-west-2"))!.fetchedAt).toBe(iso(NOW.getTime() - 2 * DAY));
  });
});

describe("AWS prices: reading the price list", () => {
  it("asks for exactly the spec's three products, TERM_MATCH (instance and disk in AmazonEC2, the IPv4 address in AmazonVPC)", () => {
    const b = awsPriceBodies("eu-west-2", "t4g.micro");
    const fields = (x: { Filters: { Type: string; Field: string; Value: string }[] }) => {
      expect(x.Filters.every((f) => f.Type === "TERM_MATCH")).toBe(true);
      return Object.fromEntries(x.Filters.map((f) => [f.Field, f.Value]));
    };
    for (const x of [b.instance, b.gp3]) expect(x).toMatchObject({ ServiceCode: "AmazonEC2", FormatVersion: "aws_v1" });
    expect(b.ip).toMatchObject({ ServiceCode: "AmazonVPC", FormatVersion: "aws_v1" });
    expect(fields(b.instance)).toEqual({ instanceType: "t4g.micro", regionCode: "eu-west-2", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" });
    expect(fields(b.gp3)).toEqual({ productFamily: "Storage", volumeApiName: "gp3", regionCode: "eu-west-2" });
    expect(fields(b.ip)).toEqual({ regionCode: "eu-west-2", group: "VPCPublicIPv4Address" });
  });

  it("parses the PriceList strings twice, takes the OnDemand USD price and converts it to GBP", () => {
    const rows = normaliseAwsPrices({ instance: jsonFixture("price-instance.json"), gp3: jsonFixture("price-gp3.json"), ip: jsonFixture("price-ip.json") }, "t4g.micro", 0.75);
    expect(rows).toHaveLength(3);
    const by = Object.fromEntries(rows.map((r) => [r.item, r]));
    // OnDemand only: the fixture's Reserved 0.0059 is not taken.
    expect(by["t4g.micro"]).toEqual({ item: "t4g.micro", gbp: expect.closeTo(0.0094 * 0.75, 12), unit: "1 Hour", meter: "EUW2-BoxUsage:t4g.micro" });
    expect(by["disk:gp3"]).toEqual({ item: "disk:gp3", gbp: expect.closeTo(0.0928 * 0.75, 12), unit: "GB-Mo", meter: "EUW2-EBS:VolumeUsage.gp3" });
    // The in-use address, not the idle one listed first.
    expect(by["ip:v4"]).toEqual({ item: "ip:v4", gbp: expect.closeTo(0.005 * 0.75, 12), unit: "1 Hour", meter: "EUW2-PublicIPv4:InUseAddress" });
  });

  it("skips entries that aren't JSON, other instance types and empty answers", () => {
    const inst = jsonFixture("price-instance.json");
    const other = JSON.parse(inst.PriceList[0]);
    other.product.attributes.instanceType = "t4g.small";
    other.product.attributes.usagetype = "EUW2-BoxUsage:t4g.small";
    const rows = normaliseAwsPrices({ instance: { PriceList: ["{not json", JSON.stringify(other), 42] }, gp3: { PriceList: [] }, ip: {} }, "t4g.micro", 0.75);
    expect(rows).toEqual([]);
  });
});

describe("AWS prices: Settings' AWS price line", () => {
  const at = iso(NOW.getTime() - 3600_000);
  const rows: PriceRow[] = [
    { region: "eu-west-2", item: "t4g.micro", gbp: 0.00705, unit: "1 Hour", fetched_at: at },
    { region: "eu-west-2", item: "disk:gp3", gbp: 0.0696, unit: "GB-Mo", fetched_at: iso(NOW.getTime() - 7200_000) },
    { region: "eu-west-2", item: "ip:v4", gbp: 0.00375, unit: "1 Hour", fetched_at: at },
    { region: "eu-west-1", item: "t4g.micro", gbp: 1, unit: "1 Hour", fetched_at: at },
  ];

  it("running = instance + gp3 × 8 GB / 730 + IPv4; stopped = disk + IPv4; source aws", async () => {
    const { env } = azureEnv(AWS_ON);
    const cfg = config(env);
    const p = awsPriceInfo(rows, cfg, "eu-west-2", "t4g.micro", NOW);
    const disk = (0.0696 * AWS_DISK_GB) / 730;
    expect(AWS_DISK_GB).toBe(8);
    expect(p).toMatchObject({ region: "eu-west-2", size: "t4g.micro", stale: false, source: "aws", reason: null, fetchedAt: iso(NOW.getTime() - 7200_000) });
    expect(p.vmGbpPerHour).toBeCloseTo(0.00705, 12);
    expect(p.diskGbpPerHour).toBeCloseTo(disk, 12);
    expect(p.ipGbpPerHour).toBeCloseTo(0.00375, 12);
    expect(p.totalGbpPerHour).toBeCloseTo(0.00705 + disk + 0.00375, 12);
    expect(p.standbyGbpPerHour).toBeCloseTo(disk + 0.00375, 12);
  });

  it("more than 7 days old: still AWS's figures, marked stale", async () => {
    const { env } = azureEnv(AWS_ON);
    const later = new Date(NOW.getTime() + 8 * DAY);
    const p = awsPriceInfo(rows, config(env), "eu-west-2", "t4g.micro", later);
    expect(p).toMatchObject({ stale: true, source: "aws" });
    expect(p.totalGbpPerHour).not.toBeNull();
  });

  it("no price yet for the size or region: the fixed AWS rates, with why", async () => {
    const { env } = azureEnv({ ...AWS_ON, AWS_HOURLY_RATE_GBP: "0.02", AWS_STANDBY_RATE_GBP: "0.004" });
    const p = awsPriceInfo(rows, config(env), "eu-west-2", "t4g.small", NOW);
    expect(p).toEqual({ region: "eu-west-2", size: "t4g.small", vmGbpPerHour: null, diskGbpPerHour: null, ipGbpPerHour: null, totalGbpPerHour: 0.02, standbyGbpPerHour: 0.004, fetchedAt: null, stale: false, source: "fixed", reason: "No AWS price for t4g.small in London yet, so the fixed rates apply." });
    expect(awsPriceInfo([], config(env), "us-east-1", "t4g.micro", NOW).reason).toBe("No AWS price for t4g.micro in N. Virginia yet, so the fixed rates apply.");
  });
});

describe("AWS prices: the feed", () => {
  it("makes three GetProducts calls in us-east-1, converts with the configured rate and stores aws_prices", async () => {
    const { env } = azureEnv({ ...AWS_ON, AWS_USD_GBP: "0.8" });
    const aws = withAws();
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [prices], await opts(env));
    expect(await feedRow(env, "aws.prices")).toMatchObject({ status: "ok", error: null, next_due_at: iso(NOW.getTime() + DAY) });
    expect(aws).toHaveLength(3);
    for (const c of aws) {
      expect(c.host).toBe("api.pricing.us-east-1.amazonaws.com");
      expect(c.target).toBe("AWSPriceListService.GetProducts");
      expect(c.auth).toContain("/us-east-1/pricing/");
    }
    const stored = await readAwsPrices(env.DB, "eu-west-2");
    expect(stored.map((r) => [r.item, r.unit, r.fetched_at]).sort()).toEqual([
      ["disk:gp3", "GB-Mo", NOW.toISOString()],
      ["ip:v4", "1 Hour", NOW.toISOString()],
      ["t4g.micro", "1 Hour", NOW.toISOString()],
    ]);
    expect(stored.find((r) => r.item === "t4g.micro")!.gbp).toBeCloseTo(0.0094 * 0.8, 12);
    const meters = (await env.DB.prepare("SELECT item, meter FROM aws_prices ORDER BY item").all<{ item: string; meter: string }>()).results;
    expect(meters).toEqual([
      { item: "disk:gp3", meter: "EUW2-EBS:VolumeUsage.gp3" },
      { item: "ip:v4", meter: "EUW2-PublicIPv4:InUseAddress" },
      { item: "t4g.micro", meter: "EUW2-BoxUsage:t4g.micro" },
    ]);
    const p = awsPriceInfo(stored, config(env), "eu-west-2", "t4g.micro", NOW);
    expect(p.source).toBe("aws");
    expect(p.totalGbpPerHour).toBeCloseTo((0.0094 + (0.0928 * 8) / 730 + 0.005) * 0.8, 12);
  });

  it("a product missing from the answer: the others are stored, the feed reads error naming what is missing", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws((c) => (c.target && c.body?.Filters?.some((f: { Field: string }) => f.Field === "group") ? new Response(JSON.stringify({ FormatVersion: "aws_v1", PriceList: [] }), { status: 200 }) : undefined));
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [prices], await opts(env));
    expect(await feedRow(env, "aws.prices")).toMatchObject({ status: "error", error: "AWS's price list had no price for the public IPv4 address in eu-west-2." });
    expect((await readAwsPrices(env.DB, "eu-west-2")).map((r) => r.item).sort()).toEqual(["disk:gp3", "t4g.micro"]);
  });

  it("a refused GetProducts names the permission, never a URL or signature", async () => {
    const { env } = azureEnv(AWS_ON);
    withAws((c) => (c.target ? new Response(JSON.stringify({ __type: "AccessDeniedException", message: "no" }), { status: 400 }) : undefined));
    await running(env, { cloud: "aws" });
    await runAwsInsights(env, NOW, [prices], await opts(env));
    const row = await feedRow(env, "aws.prices");
    expect(row).toMatchObject({ status: "error", error: "AWS refused GetProducts: the Worker's AWS user needs pricing:GetProducts." });
    expect(await readAwsPrices(env.DB)).toEqual([]);
  });
});
