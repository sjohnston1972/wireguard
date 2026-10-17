// labs-aws-reads.test.ts
//
// Plain English: what the Worker reads from AWS for AWS labs (AWS labs spec
// §6): the hourly orphan sweep with its 90-minute grace and its own share of
// the leftovers list, the daily cost by lab tag, the lab price feed, AWS
// list prices in the estimate, the capacity warning, the permission ticks
// and the running lab's resources. Pretend AWS answers from world.labAws.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { arnParts, taggedName } from "../src/labs/awsReads";
import { sweepAwsOrphans, sweepOrphans, readOrphans, AWS_CONFIRM_CALLS, AWS_SWEEP_CALLS } from "../src/labs/orphans";
import { leftoversMessage } from "../src/labs/availability";
import { fetchAwsLabCostDays } from "../src/labs/cost";
import { budgetedNet, directNet, BudgetExceeded } from "../src/labs/net";
import { checkLabPermissions } from "../src/labs/permissions";
import { awsListPrice, pricedItems, readLabPrices } from "../src/labs/prices";
import { runLabWatch } from "../src/labs/watch";
import { capacityProblems } from "../src/labs/warnings";
import labPrices, { labPriceAsks, labPriceBody } from "../src/insights/aws/feeds/labPrices";
import { makeAwsCtx } from "../src/insights/aws/ctx";
import { makeBudget } from "../src/insights/types";
import { config } from "../src/env";
import { getSnapshot } from "../src/state";
import { awsPriceKey } from "../../shared/labs";
import { advance, api, freeze, labEnv, rows, runningLab, session, withAwsLabs, AWS_TEST_LABS, HOUR, MIN, NOW } from "./labs-helpers";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ARN = (r: string, region = "eu-west-2") => `arn:aws:ec2:${region}:123456789012:${r}`;
const tagged = (lab: string, r: string, name?: string) => ({ arn: ARN(r), tags: { "cloudlabs-lab": lab, ...(name ? { Name: name } : {}) } });

describe("the AWS orphan sweep", () => {
  it("makes 12 calls, waits 90 minutes, skips live labs and names what it found", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    world.labAws.tagged["eu-west-2"] = [tagged("soa-03-auto-scaling", "vpc/vpc-0live"), tagged("soa-05-rds", "instance/i-0left", "vm-client")];
    world.labAws.ec2 = { "eu-west-2": { instances: [{ id: "i-0left", state: "running" }] } };
    world.labAws.iam.roles = ["lab-soa-05-rds-x", "wg-admin-labs"];
    world.labAws.dashboards["eu-west-2"] = ["lab-soa-05-rds-overview"];
    const t0 = new Date(NOW);
    const before = world.calls.length;
    expect(await sweepAwsOrphans(env, budgetedNet(20), t0)).toMatch(/aws orphans: 0 lab/);
    expect(world.calls.length - before).toBe(AWS_SWEEP_CALLS);
    const later = new Date(t0.getTime() + 91 * 60_000);
    expect(await sweepAwsOrphans(env, budgetedNet(20), later)).toMatch(/aws orphans: 1 lab/);
    const o = await readOrphans(env);
    expect(o).toEqual([{ labId: "soa-05-rds", names: ["dashboard lab-soa-05-rds-overview", "ec2:instance i-0left", "iam role lab-soa-05-rds-x"].sort(), since: t0.toISOString() }]);
  });

  it("with fewer than 12 calls left it waits, records nothing, and stays due", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    await expect(sweepAwsOrphans(env, budgetedNet(11), new Date(NOW))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await env.STATUS.get("labs:sweep-aws")).toBeNull();
  });

  it("in the watch, a run whose Azure sweep took the calls leaves the AWS sweep due; the next run makes it", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    const first = await runLabWatch(env, new Date());
    expect(first.some((l) => /^orphans: /.test(l))).toBe(true);
    expect(first).toContain("aws orphans: out of calls for this run");
    expect(await env.STATUS.get("labs:sweep-aws")).toBeNull();
    const t = advance(5 * MIN);
    const second = await runLabWatch(env, t);
    expect(second.some((l) => /^aws orphans: 0 lab/.test(l))).toBe(true);
    expect(JSON.parse((await env.STATUS.get("labs:sweep-aws"))!).at).toBe(t.toISOString());
  });

  it("a tagged listing with more than one page is partial: no dirty slot released, earlier entries kept", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { sid } = await runningLab(env, world, "soa-05-rds");
    await env.DB.prepare("UPDATE lab_sessions SET state = 'ended_dirty', ended_at = ?1 WHERE id = ?2").bind(NOW, sid).run();
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "saa-16-dr-pilot-light", names: ["ec2:vpc vpc-0y"], since: NOW }]));
    // 101 items of lab 3 in London: the one page holds 100 and AWS says there is more.
    world.labAws.tagged["eu-west-2"] = Array.from({ length: 101 }, (_, i) => tagged("soa-03-auto-scaling", `subnet/subnet-${i}`));
    const line = await sweepAwsOrphans(env, budgetedNet(20), new Date(NOW));
    expect(line).toMatch(/could not list: tagged resources in eu-west-2 \(more than 100\)/);
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["saa-16-dr-pilot-light"]);
    expect((await session(env, sid))!.slot).not.toBeNull();
    // With one page that holds everything the same sweep is complete: the slot goes back and the old entry is gone.
    world.labAws.tagged["eu-west-2"] = world.labAws.tagged["eu-west-2"].slice(0, 100);
    const later = new Date(Date.parse(NOW) + 61 * MIN);
    expect(await sweepAwsOrphans(env, budgetedNet(20), later)).toMatch(/1 slot\(s\) released/);
    expect((await session(env, sid))!.slot).toBeNull();
    expect(await readOrphans(env)).toEqual([]);
  });

  it("a failed AWS listing keeps that lab's earlier entry", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "soa-05-rds", names: ["ec2:vpc vpc-0x"], since: NOW }]));
    world.labAws.dashboards = new Proxy({}, { get: () => { throw new Error("boom"); } }) as Record<string, string[]>;
    const line = await sweepAwsOrphans(env, budgetedNet(20), new Date(NOW));
    expect(line).toMatch(/could not list: dashboards in eu-west-2/);
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["soa-05-rds"]);
  });

  it("Review Focus 5: a KMS key waiting to delete is never an orphan; other leftovers still are (P11)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.tagged["eu-west-2"] = [
      { arn: "arn:aws:kms:eu-west-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab", tags: { "cloudlabs-lab": "soa-07-iam-kms" } },
      { arn: "arn:aws:secretsmanager:eu-west-2:123456789012:secret:lab-soa-07-iam-kms-app-AbCdEf", tags: { "cloudlabs-lab": "soa-07-iam-kms" } },
    ];
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * 60_000));
    const o = await readOrphans(env);
    expect(o).toHaveLength(1);
    expect(o[0].names.some((n) => n.startsWith("kms:key"))).toBe(false);
    expect(o[0].names.some((n) => n.startsWith("secretsmanager:secret"))).toBe(true);
  });

  // Live 2026-10-16: the tagging API listed deleted VPC endpoints, terminated instances and an INACTIVE ECS cluster
  // and service 4-5 hours after they were gone, and the leftovers they made blocked deploying seven AWS labs.
  const ec2Reads = (world: { calls: { host: string; body?: unknown }[] }, from: number) => world.calls.slice(from).filter((c) => /^ec2\./.test(c.host));

  it("an EC2 instance or VPC endpoint counts only once EC2 confirms it still exists: one read per region and type", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.tagged["eu-west-2"] = [
      tagged("soa-05-rds", "instance/i-0real"),
      tagged("soa-05-rds", "instance/i-0term"),
      tagged("soa-05-rds", "instance/i-0gone"),
      tagged("soa-05-rds", "vpc-endpoint/vpce-0real"),
      tagged("soa-05-rds", "vpc-endpoint/vpce-0deleted"),
      tagged("soa-05-rds", "vpc-endpoint/vpce-0gone"),
      tagged("saa-16-dr-pilot-light", "instance/i-0shut"),
      tagged("saa-16-dr-pilot-light", "vpc-endpoint/vpce-0dead"),
    ];
    world.labAws.ec2 = {
      "eu-west-2": {
        instances: [{ id: "i-0real", state: "stopped" }, { id: "i-0term", state: "terminated" }, { id: "i-0shut", state: "shutting-down" }],
        endpoints: [{ id: "vpce-0real", state: "available" }, { id: "vpce-0deleted", state: "deleted" }, { id: "vpce-0dead", state: "Deleted" }],
      },
    };
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    const before = world.calls.length;
    expect(await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * MIN))).toMatch(/aws orphans: 1 lab/);
    expect(await readOrphans(env)).toEqual([{ labId: "soa-05-rds", names: ["ec2:instance i-0real", "ec2:vpc-endpoint vpce-0real"], since: t0.toISOString() }]);
    // Both labs' instances in one DescribeInstances, both labs' endpoints in one DescribeVpcEndpoints.
    const reads = ec2Reads(world, before);
    expect(reads).toHaveLength(2);
    expect(world.calls.length - before).toBe(AWS_SWEEP_CALLS + 2);
  });

  it("a ghost-only lab's dirty slot goes back once EC2 says its instance is terminated", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { sid } = await runningLab(env, world, "soa-05-rds");
    await env.DB.prepare("UPDATE lab_sessions SET state = 'ended_dirty', ended_at = ?1 WHERE id = ?2").bind(NOW, sid).run();
    world.labAws.tagged["eu-west-2"] = [tagged("soa-05-rds", "instance/i-0term")];
    world.labAws.ec2 = { "eu-west-2": { instances: [{ id: "i-0term", state: "terminated" }] } };
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    expect((await session(env, sid))!.slot).not.toBeNull(); // inside the 90 minutes: still present, as before
    expect(await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * MIN))).toMatch(/1 slot\(s\) released/);
    expect((await session(env, sid))!.slot).toBeNull();
    expect(await readOrphans(env)).toEqual([]);
  });

  it("a confirm read AWS refuses keeps the item counted: a failed read never hides a real leftover", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.tagged["eu-west-2"] = [tagged("soa-05-rds", "instance/i-0x"), tagged("soa-05-rds", "vpc-endpoint/vpce-0x")];
    world.labAws.ec2 = { "eu-west-2": { fail: "UnauthorizedOperation" } };
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * MIN));
    expect((await readOrphans(env))[0]?.names).toEqual(["ec2:instance i-0x", "ec2:vpc-endpoint vpce-0x"]);
    world.labAws.ec2 = { "eu-west-2": { fail: "RequestLimitExceeded" } };
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 152 * MIN));
    expect((await readOrphans(env))[0]?.names).toEqual(["ec2:instance i-0x", "ec2:vpc-endpoint vpce-0x"]);
  });

  it("outside the two lab regions (the Worker may not describe there) an instance is counted unconfirmed, with no read", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.tagged["us-east-1"] = [{ arn: ARN("instance/i-0east", "us-east-1"), tags: { "cloudlabs-lab": "soa-05-rds" } }];
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    const before = world.calls.length;
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * MIN));
    expect(ec2Reads(world, before)).toHaveLength(0);
    expect((await readOrphans(env))[0]?.names).toEqual(["ec2:instance i-0east"]);
  });

  it("with no calls left for the confirm reads the sweep waits, records nothing, and stays due", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    await expect(sweepAwsOrphans(env, budgetedNet(AWS_SWEEP_CALLS + AWS_CONFIRM_CALLS - 1), new Date(NOW))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await env.STATUS.get("labs:sweep-aws")).toBeNull();
  });

  it("ECS clusters, services and task definitions are never orphans (the Worker cannot describe ECS); other leftovers still are", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const ecs = (r: string) => ({ arn: `arn:aws:ecs:eu-west-2:123456789012:${r}`, tags: { "cloudlabs-lab": "saa-16-dr-pilot-light" } });
    world.labAws.tagged["eu-west-2"] = [ecs("cluster/lab-saa-16-dr-pilot-light"), ecs("service/lab-saa-16-dr-pilot-light/web"), ecs("task-definition/lab-saa-16-dr-pilot-light-web:3"), tagged("saa-16-dr-pilot-light", "vpc/vpc-0y")];
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * MIN));
    expect(await readOrphans(env)).toEqual([{ labId: "saa-16-dr-pilot-light", names: ["ec2:vpc vpc-0y"], since: t0.toISOString() }]);
  });

  it("an AWS lab's leftovers sentence says AWS; an Azure lab's still says Azure", () => {
    expect(leftoversMessage({ id: "soa-05-rds", title: "RDS" })).toBe("RDS still has leftovers in AWS from an earlier session. Clean them up from the Labs tab first.");
    expect(leftoversMessage({ id: "az104-07-files", title: "Azure Files" })).toBe("Azure Files still has leftovers in Azure from an earlier session. Clean them up from the Labs tab first.");
  });

  it("the AWS sweep keeps Azure entries and the Azure sweep keeps AWS entries", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "az104-07-files", names: ["rg-lab-az104-07-files"], since: NOW }, { labId: "soa-05-rds", names: ["ec2:vpc vpc-0x"], since: NOW }]));
    await sweepAwsOrphans(env, budgetedNet(20), new Date(NOW));
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["az104-07-files"]);
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "soa-05-rds", names: ["ec2:vpc vpc-0x"], since: NOW }]));
    await sweepOrphans(env, budgetedNet(20), new Date(NOW));
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["soa-05-rds"]);
  });
});

describe("AWS lab costs by tag (A17)", () => {
  it("keeps charged rows as aws:<id> in pounds, skips untagged spend, and asks once a day", async () => {
    freeze();
    const { env, world } = await labEnv();
    world.labAws.costByTag = [{ day: "2026-10-14", lab: "soa-03-auto-scaling", usd: 2 }, { day: "2026-10-14", lab: "", usd: 3 }];
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBe("aws lab costs: 1 row(s)");
    const rows = (await env.DB.prepare("SELECT day, rg, lab_id, gbp FROM lab_cost_days").all()).results;
    expect(rows).toEqual([{ day: "2026-10-14", rg: "aws:soa-03-auto-scaling", lab_id: "soa-03-auto-scaling", gbp: 1.5 }]);
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBeNull();
  });

  it("one try a day, win or lose: after a failed pull a second same-day run asks Cost Explorer nothing", async () => {
    freeze();
    const { env, world } = await labEnv();
    world.labAws.costByTagFail = true;
    const ce = () => world.calls.filter((c) => c.host === "ce.us-east-1.amazonaws.com").length;
    await expect(fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).rejects.toThrow();
    expect(ce()).toBe(1);
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBeNull();
    expect(ce()).toBe(1);
    // The next day it tries again.
    world.labAws.costByTagFail = false;
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(Date.parse(NOW) + 86_400_000))).toMatch(/^aws lab costs: /);
    expect(ce()).toBe(2);
  });

  it("out of calls is not a try: nothing asked, nothing marked, the day stays due", async () => {
    freeze();
    const { env, world } = await labEnv();
    await expect(fetchAwsLabCostDays(env, budgetedNet(0), new Date(NOW))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await env.STATUS.get("labs:cost_tried_day_aws")).toBeNull();
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBe("aws lab costs: 0 row(s)");
    expect(world.calls.filter((c) => c.host === "ce.us-east-1.amazonaws.com")).toHaveLength(1);
  });
});

describe("the lab price feed and AWS list prices", () => {
  const ALB = AWS_TEST_LABS[0].cost.items.find((i) => i.name === "ALB, hourly")!; // aws_price AWSELB, usagetype {usage}-LoadBalancerUsage
  it("fills {usage} per region and adds the region code", () => {
    const body = labPriceBody(ALB.aws_price!, "eu-west-1");
    expect(body.Filters).toContainEqual({ Type: "TERM_MATCH", Field: "usagetype", Value: "EU-LoadBalancerUsage" });
    expect(body.Filters).toContainEqual({ Type: "TERM_MATCH", Field: "regionCode", Value: "eu-west-1" });
    expect(labPriceBody(ALB.aws_price!, "eu-west-2").Filters).toContainEqual({ Type: "TERM_MATCH", Field: "usagetype", Value: "EUW2-LoadBalancerUsage" });
  });

  it("stores exactly-one matches in pounds, stores nothing for two products, and says which", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const product = (usd: string) => ({ product: { attributes: { usagetype: "EUW2-LoadBalancerUsage" } }, terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: usd } } } } } } });
    world.labAws.products = (body) => (body.ServiceCode === "AWSELB" ? [product("0.0265")] : [product("0.01"), product("0.02")]);
    const ctx = makeAwsCtx(env, new Date(NOW), await getSnapshot(env), config(env), makeBudget(20));
    const r = await labPrices.run(ctx);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/2 products/);
    const row = await env.DB.prepare("SELECT gbp, unit FROM aws_prices WHERE region = 'eu-west-2' AND item = ?1").bind(awsPriceKey(ALB.aws_price!)).first<{ gbp: number; unit: string }>();
    expect(row?.unit).toBe("Hrs");
    expect(row?.gbp).toBeCloseTo(0.0265 * 0.75, 9);
    expect(labPriceAsks(AWS_TEST_LABS, "eu-west-2").length).toBeGreaterThan(0);
  });

  it("prices are asked for London (where the estimate reads them) whatever AWS_REGION says", async () => {
    freeze();
    const { env, world } = await labEnv({ AWS_REGION: "us-east-1" });
    withAwsLabs();
    const asked: string[] = [];
    world.labAws.products = (body) => {
      asked.push(body.Filters.find((f) => f.Field === "regionCode")!.Value);
      return [];
    };
    await labPrices.run(makeAwsCtx(env, new Date(), await getSnapshot(env), config(env), makeBudget(20)));
    expect(asked.length).toBeGreaterThan(0);
    expect([...new Set(asked)]).toEqual(["eu-west-2"]);
  });

  it("a reference matching two products, or none, stores nothing: the authored figure stays", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const EC2 = AWS_TEST_LABS[0].cost.items.find((i) => i.name === "EC2 t4g.micro")!;
    const product = (usd: string) => ({ product: { attributes: { usagetype: "EUW2-BoxUsage:t4g.micro" } }, terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: usd } } } } } } });
    world.labAws.products = (body) => (body.ServiceCode === "AWSELB" ? [product("0.0265")] : [product("0.01"), product("0.02")]);
    const run = async () => labPrices.run(makeAwsCtx(env, new Date(), await getSnapshot(env), config(env), makeBudget(20)));
    await run();
    const stored = async (ref: typeof EC2) => (await rows(env, "SELECT item FROM aws_prices WHERE item = ?1", awsPriceKey(ref.aws_price!))).length;
    expect(await stored(EC2)).toBe(0);
    const lines = pricedItems(AWS_TEST_LABS[0], await readLabPrices(env, "uksouth"), "uksouth", new Date());
    expect(lines.map((l) => [l.name, l.source])).toEqual([["ALB, hourly", "aws"], ["EC2 t4g.micro", "authored"]]);
    expect(lines[1]!.gbpH).toBe(EC2.gbp_h);
    // A run an hour later asks only for what is still missing (the ALB row is fresh); none answered: "0 products".
    advance(HOUR);
    world.labAws.products = () => [];
    const pricing = () => world.calls.filter((c) => c.host === "api.pricing.us-east-1.amazonaws.com").length;
    const before = pricing();
    const r = await run();
    expect(pricing() - before).toBe(1);
    expect(r).toMatchObject({ status: "error" });
    expect(r.error).toMatch(/0 products/);
    expect(await stored(EC2)).toBe(0);
  });

  it("an AWS item uses its fresh list price (Hrs per hour, GB-Mo × gb ÷ 730), else the authored figure", () => {
    const now = new Date(NOW);
    const fresh = new Date(now.getTime() - 86_400_000).toISOString();
    const stale = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const gp3 = { name: "gp3", gbp_h: 0.0008, aws_price: { service: "AmazonEC2", unit: "GB-Mo" as const, gb: 8, filters: { productFamily: "Storage", volumeApiName: "gp3" } } };
    const rows = [{ region: "eu-west-2", item: awsPriceKey(gp3.aws_price), gbp: 0.0696, unit: "GB-Mo", fetched_at: fresh }];
    expect(awsListPrice(gp3, rows, "eu-west-2", now, null)?.gbpH).toBeCloseTo((0.0696 * 8) / 730, 9);
    expect(awsListPrice(gp3, [{ ...rows[0], fetched_at: stale }], "eu-west-2", now, null)).toBeNull();
    const lines = pricedItems({ ...AWS_TEST_LABS[0], cost: { items: [gp3], pricey: null } }, rows, "uksouth", now);
    expect(lines[0]).toMatchObject({ source: "aws" });
  });
});

describe("capacity, permissions and resources", () => {
  it("the AWS capacity sentence sums vCPUs against the On-Demand Standard quota", () => {
    const doc = { sizes: [{ name: "t4g.micro", available: true, reason: null, vcpus: 2, family: "standard" }], usages: [{ family: "standard", used: 30, limit: 32 }], cores: { used: 30, limit: 32 } };
    const words = { place: "London", family: () => "On-Demand Standard" };
    expect(capacityProblems(doc, ["t4g.micro", "t4g.micro", "t4g.micro", "t4g.micro"], [], "eu-west-2", words)).toEqual(["Needs 8 On-Demand Standard vCPUs (8 for this lab's t4g.micro); 30 of 32 used in London."]);
  });

  it("ruling P7: a global lab's resources include what is tagged in us-east-1", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-09-route53-cloudfront");
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:s3:::cloudlabs-a09k3x9q-site", tags: { "cloudlabs-lab": "soa-09-route53-cloudfront", Name: "site" } }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:cloudfront::123456789012:distribution/E1ABC", tags: { "cloudlabs-lab": "soa-09-route53-cloudfront", Name: "cdn-site" } }];
    const r = await api(env, "GET", "/labs/soa-09-route53-cloudfront");
    expect(r.json.resources).toEqual([
      { name: "site", type: "s3:bucket", group: "lab-soa-09-route53-cloudfront (London)", state: null },
      { name: "cdn-site", type: "cloudfront:distribution", group: "lab-soa-09-route53-cloudfront (global: CloudFront, Route 53)", state: null },
    ]);
  });

  it("Review Focus 5: an AWS session's users values are withheld outside /labs/:id/secret (P5)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const users = { "lab-soa-07-iam-kms-ann": "password Xy7-not-a-real-one at https://123456789012.signin.aws.amazon.com/console" };
    await runningLab(env, world, "soa-07-iam-kms", { hours: 2, peer: false }, { private_ips: {}, connect: [], users, peer_vpc_id: null });
    const d = await api(env, "GET", "/labs/soa-07-iam-kms");
    expect(JSON.stringify(d.json)).not.toContain("Xy7-not-a-real-one");
    expect(JSON.stringify(d.json)).toContain("lab-soa-07-iam-kms-ann");
    const s = await api(env, "GET", "/labs/soa-07-iam-kms/secret");
    expect(s.json.users).toEqual(users);
  });

  it("the AWS ticks gate AWS labs with aws_setup; an inactive cost tag only warns", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.role = true;
    world.labAws.boundary = false;
    world.labAws.costTags = [{ key: "cloudlabs-lab", status: "Inactive" }];
    const p = await checkLabPermissions(env, directNet());
    expect(p).toMatchObject({ awsRole: true, awsBoundary: false, awsCostTag: false });
    expect(p.message).toMatch(/wg-admin-lab-boundary policy does not exist yet/);
    expect(p.message).toMatch(/cost tag is not active yet/);
    const card = (await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "soa-03-auto-scaling");
    expect(card.blockers[0]).toEqual({ kind: "aws_setup", message: "AWS labs are not set up yet: run the AWS bootstrap, then Check permissions." });
    world.labAws.boundary = true;
    await checkLabPermissions(env, directNet());
    const again = (await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "soa-03-auto-scaling");
    expect(again.blockers.map((b: { kind: string }) => b.kind)).not.toContain("aws_setup");
  });

  it("without AWS keys the AWS ticks are off and say so; with no AWS lab in the catalogue nothing about AWS is asked", async () => {
    freeze();
    const noKeys = await labEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined });
    withAwsLabs();
    const p = await checkLabPermissions(noKeys.env, directNet());
    expect(p).toMatchObject({ role: false, awsRole: false, awsBoundary: false, awsCostTag: null });
    expect(p.message).toMatch(/AWS is not connected: the Worker has no AWS keys\./);
    expect(noKeys.world.calls.some((c) => c.host.endsWith("amazonaws.com"))).toBe(false);
    const { env, world } = await labEnv(); // the Azure-only test catalogue
    world.labAws.role = true;
    const q = await checkLabPermissions(env, directNet());
    expect(q).toMatchObject({ awsRole: null, awsBoundary: null, awsCostTag: null });
    expect(world.calls.some((c) => c.host.endsWith("amazonaws.com"))).toBe(false);
  });

  it("with AWS set up the check makes its 4 AWS reads and asks for the boundary in the Worker's own account", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    Object.assign(world.labAws, { role: true, boundary: true, costTags: [{ key: "cloudlabs-lab", status: "Active" }] });
    const before = world.calls.length;
    const p = await checkLabPermissions(env, directNet());
    expect(p).toMatchObject({ awsRole: true, awsBoundary: true, awsCostTag: true });
    const aws = world.calls.slice(before).filter((c) => c.host.endsWith("amazonaws.com"));
    expect(aws.map((c) => c.action ?? c.target)).toEqual(["GetCallerIdentity", "GetRole", "GetPolicy", "AWSInsightsIndexService.ListCostAllocationTags"]);
  });

  it("an AWS lab's capacity warning counts later AWS sessions and the server's type when no AWS headend exists (P14)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    // A reading from an hour ago: 26 of 32 used. Since then soa-05-rds (2 × t4g.micro) was deployed.
    const doc = { sizes: [{ name: "t4g.micro", available: true, reason: null, vcpus: 2, family: "standard" }], usages: [{ family: "standard", used: 26, limit: 32 }], cores: { used: 26, limit: 32 } };
    await env.DB.prepare("INSERT INTO aws_capacity (region, json, fetched_at) VALUES ('eu-west-2', ?1, ?2)").bind(JSON.stringify(doc), new Date(Date.now() - HOUR).toISOString()).run();
    const lab5 = AWS_TEST_LABS.find((l) => l.id === "soa-05-rds")!;
    lab5.capacity = { vm_sizes: [], instance_types: ["t4g.micro"] };
    try {
      await runningLab(env, world, "soa-05-rds");
      const d = (await api(env, "GET", "/labs/soa-03-auto-scaling")).json;
      const cap = d.warnings.find((w: { kind: string }) => w.kind === "capacity");
      // 2 × t4g.micro (lab 3) + 1 (lab 5, after the reading) = 6, plus the server's t4g.micro (no AWS headend) = 8: 26 + 8 > 32.
      expect(cap?.message).toBe("May not be available: Needs 8 On-Demand Standard vCPUs (6 for this lab's t4g.micro and 2 for the gateway's next deploy); 26 of 32 used in London.");
    } finally {
      lab5.capacity = { vm_sizes: [], instance_types: [] };
    }
  });

  it("a running AWS lab's resources come from its tags, named by their Name tag", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    world.labAws.tagged["eu-west-2"] = [tagged("soa-03-auto-scaling", "vpc/vpc-0a", "vpc-lab"), tagged("soa-03-auto-scaling", "instance/i-0b")];
    const r = await api(env, "GET", "/labs/soa-03-auto-scaling");
    expect(r.json.resources).toEqual([
      { name: "vpc-lab", type: "ec2:vpc", group: "lab-soa-03-auto-scaling (London)", state: null },
      { name: "i-0b", type: "ec2:instance", group: "lab-soa-03-auto-scaling (London)", state: null },
    ]);
  });
});
describe("batch 3 reads", () => {
  it("ruling P2: an API Gateway ARN names its collection as the type", () => {
    expect(arnParts("arn:aws:apigateway:eu-west-2::/apis/a1b2c3")).toEqual({ service: "apigateway", type: "apis", id: "a1b2c3" });
    expect(arnParts("arn:aws:apigateway:eu-west-2::/apis/a1b2c3/stages/$default")).toEqual({ service: "apigateway", type: "stages", id: "a1b2c3/$default" });
    expect(taggedName("arn:aws:apigateway:eu-west-2::/apis/a1b2c3")).toBe("apigateway:apis a1b2c3");
    expect(arnParts("arn:aws:dynamodb:eu-west-1:123456789012:table/lab-saa-16-dr-pilot-light-orders")).toEqual({ service: "dynamodb", type: "table", id: "lab-saa-16-dr-pilot-light-orders" });
  });

  it("ruling P5: a DNS lab's resources come from London, Ireland and us-east-1", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "saa-16-dr-pilot-light");
    const tag = (Name: string) => ({ "cloudlabs-lab": "saa-16-dr-pilot-light", Name });
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0app", tags: tag("vm-app") }];
    world.labAws.tagged["eu-west-1"] = [{ arn: "arn:aws:dynamodb:eu-west-1:123456789012:table/lab-saa-16-dr-pilot-light-orders", tags: tag("table-orders") }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:route53:::hostedzone/Z0LAB", tags: tag("zone-dr") }];
    const r = await api(env, "GET", "/labs/saa-16-dr-pilot-light");
    expect(r.json.resources).toEqual([
      { name: "vm-app", type: "ec2:instance", group: "lab-saa-16-dr-pilot-light (London)", state: null },
      { name: "table-orders", type: "dynamodb:table", group: "lab-saa-16-dr-pilot-light (Ireland)", state: null },
      { name: "zone-dr", type: "route53:hostedzone", group: "lab-saa-16-dr-pilot-light (global: Route 53)", state: null },
    ]);
  });

  it("ruling P22: a WAF ACL and a Lattice listener name their own types", () => {
    expect(arnParts("arn:aws:wafv2:us-east-1:123456789012:global/webacl/lab-ans-26-edge-waf/0a1b")).toEqual({ service: "wafv2", type: "global/webacl", id: "lab-ans-26-edge-waf/0a1b" });
    expect(arnParts("arn:aws:vpc-lattice:eu-west-2:123456789012:service/svc-0a/listener/listener-0b")).toEqual({ service: "vpc-lattice", type: "listener", id: "svc-0a/listener/listener-0b" });
    expect(arnParts("arn:aws:vpc-lattice:eu-west-2:123456789012:service/svc-0a")).toEqual({ service: "vpc-lattice", type: "service", id: "svc-0a" });
    expect(arnParts("arn:aws:globalaccelerator::123456789012:accelerator/0abc")).toEqual({ service: "globalaccelerator", type: "accelerator", id: "0abc" });
  });

  it("ruling P24: lab 26's resources come from London, Ireland, us-east-1 and us-west-2, each labelled", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "ans-26-edge");
    const tag = (Name: string) => ({ "cloudlabs-lab": "ans-26-edge", Name });
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0ldn", tags: tag("vm-london") }];
    world.labAws.tagged["eu-west-1"] = [{ arn: "arn:aws:ec2:eu-west-1:123456789012:instance/i-0dub", tags: tag("vm-ireland") }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/lab-ans-26-edge-waf/0a1b", tags: tag("waf-lab") }];
    world.labAws.tagged["us-west-2"] = [{ arn: "arn:aws:globalaccelerator::123456789012:accelerator/0abc", tags: tag("ga-lab") }];
    const r = await api(env, "GET", "/labs/ans-26-edge");
    expect(r.json.resources).toEqual([
      { name: "vm-london", type: "ec2:instance", group: "lab-ans-26-edge (London)", state: null },
      { name: "vm-ireland", type: "ec2:instance", group: "lab-ans-26-edge (Ireland)", state: null },
      { name: "waf-lab", type: "wafv2:global/webacl", group: "lab-ans-26-edge (global: CloudFront, WAF)", state: null },
      { name: "ga-lab", type: "globalaccelerator:accelerator", group: "lab-ans-26-edge (global: Global Accelerator)", state: null },
    ]);
  });
});
