// insights-aws-activity.test.ts
//
// Plain English: the two AWS account feeds (AWS insights spec sections 4.3,
// 4.4 and 2.8). The change log reads CloudTrail's write events and keeps
// only cloudlabs' own: those made by cloudlabs (the Worker's user, the
// GitHub deploy role) and those touching a resource tagged wg-admin=vpn;
// another project's events in the same account never appear. A person
// changing one of our resources writes one watchman note. Service health
// reads AWS's public status RSS for EC2 and VPC in the region; an HTML
// error page or a non-200 answer records an error and leaves the stored
// events alone, an empty channel is fine.
//
// Saved answers in fixtures/aws-insights/ (fake account 123456789012).
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import activity, { LOOKUP_TARGET, awsCallerOf, keepAwsActivity, lookupStart, normaliseAwsActivity, storeAwsActivity } from "../src/insights/aws/feeds/activity";
import serviceHealth, { awsStatusFeeds, normaliseAwsRss, parseAwsRss } from "../src/insights/aws/feeds/serviceHealth";
import { runAwsInsights } from "../src/insights/aws/runner";
import { makeBudget } from "../src/insights/types";
import { effectiveConfig } from "../src/settings";
import { getSnapshot } from "../src/state";
import type { Env } from "../src/env";
import { azureEnv, running, NOW, ago, iso, MIN } from "./insights-helpers";

afterEach(() => vi.unstubAllGlobals());

const text = (name: string) => readFileSync(new URL(`./fixtures/aws-insights/${name}`, import.meta.url), "utf8");
const lookup = () => JSON.parse(text("lookup-events.json")) as { Events: any[]; NextToken?: string };
const AWS_ON: Partial<Env> = { AWS_ENABLED: "1" };
/** What GetResources answers: the headend, its security group, its network interface. */
const TAGGED = ["arn:aws:ec2:eu-west-2:123456789012:instance/i-0abc", "arn:aws:ec2:eu-west-2:123456789012:security-group/sg-wg", "arn:aws:ec2:eu-west-2:123456789012:network-interface/eni-0wg"];

interface Call {
  url: string;
  host: string;
  target: string | null;
  body: any;
}

/**
 * A pretend AWS: CloudTrail answers `trail` (one page per call, in order;
 * the last repeats), the tagging API answers TAGGED, and the status RSS
 * answers `rss[service]`. Every call is recorded.
 */
function world(o: { trail?: (Response | (() => Response))[]; rss?: Record<string, () => Response> } = {}) {
  const calls: Call[] = [];
  let page = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : typeof input === "string" ? input : (input as URL).href;
    const u = new URL(url);
    const raw = req ? await req.clone().text() : String(init?.body ?? "");
    const headers = new Headers(req ? req.headers : init?.headers);
    const call: Call = { url, host: u.hostname, target: headers.get("x-amz-target"), body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    if (u.hostname.startsWith("cloudtrail.")) {
      const list = o.trail ?? [new Response(JSON.stringify(lookup()), { status: 200 })];
      const r = list[Math.min(page++, list.length - 1)]!;
      return typeof r === "function" ? r() : r.clone();
    }
    if (u.hostname.startsWith("tagging.")) return new Response(JSON.stringify({ ResourceTagMappingList: TAGGED.map((ResourceARN) => ({ ResourceARN })), PaginationToken: "" }), { status: 200 });
    if (u.hostname === "status.aws.amazon.com") {
      const svc = u.pathname.match(/\/rss\/(\w+)-/)?.[1] ?? "";
      const r = o.rss?.[svc];
      return r ? r() : new Response(text("rss-empty.xml"), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return calls;
}

async function opts(env: Env, budget = makeBudget(25)) {
  const [snap, cfg] = await Promise.all([getSnapshot(env), effectiveConfig(env)]);
  return { budget, late: () => false, snap, cfg };
}

async function setup() {
  const { env } = azureEnv(AWS_ON);
  await running(env);
  return env;
}

const stored = async (env: Env) => (await env.DB.prepare("SELECT * FROM aws_activity ORDER BY at").all<any>()).results;
const notes = async (env: Env) => (await env.DB.prepare("SELECT kind, message FROM alerts WHERE message LIKE 'Changed in AWS outside cloudlabs%' ORDER BY id").all<{ kind: string; message: string }>()).results;
const feedRow = async (env: Env, id: string) => env.DB.prepare("SELECT * FROM aws_feed WHERE feed = ?1").bind(id).first<any>();
const events = async (env: Env) => (await env.DB.prepare("SELECT * FROM aws_service_events ORDER BY updated_at DESC").all<any>()).results;
const trailCalls = (calls: Call[]) => calls.filter((c) => c.host.startsWith("cloudtrail."));
const taggingCalls = (calls: Call[]) => calls.filter((c) => c.host.startsWith("tagging."));

describe("aws.activity: normalising CloudTrail events", () => {
  it("reads who, what, when and the resources of each event", () => {
    const evs = normaliseAwsActivity(lookup().Events);
    const by = (id: string) => evs.find((e) => e.id === id)!;
    expect(evs).toHaveLength(7);
    expect(by("ev-worker-0001")).toMatchObject({ at: "2026-10-04T09:40:00.000Z", operation: "AuthorizeSecurityGroupIngress", status: "Succeeded", caller: "wg-admin-worker", caller_kind: "wgadmin" });
    // The deploy role's session: wgadmin, named by its session.
    expect(by("ev-deploy-0001")).toMatchObject({ operation: "RunInstances", caller: "GitHubActions", caller_kind: "wgadmin" });
    expect(by("ev-person-0001")).toMatchObject({ caller: "someone", caller_kind: "person" });
    expect(by("ev-aws-0001")).toMatchObject({ caller: "ec2.amazonaws.com", caller_kind: "aws" });
    // errorCode in the event's JSON: Failed.
    expect(by("ev-failed-0001")).toMatchObject({ status: "Failed", caller_kind: "person" });
    expect(by("ev-deploy-0001").resources.map((r) => r.id)).toEqual(["subnet-0wg", "ami-0example", "i-0abc", "sg-wg"]);
    // Junk is dropped, not stored.
    expect(normaliseAwsActivity([null, 3, { EventId: "x" }, { EventId: "y", EventName: "RunInstances" }])).toEqual([]);
  });

  it("caller kinds: the Worker user and the deploy role are cloudlabs; AWS services; everyone else is a person", () => {
    expect(awsCallerOf("wg-admin-worker", { userIdentity: { type: "IAMUser", arn: "arn:aws:iam::123456789012:user/wg-admin-worker", userName: "wg-admin-worker" } })).toEqual({ caller: "wg-admin-worker", kind: "wgadmin" });
    expect(awsCallerOf(null, { userIdentity: { type: "AssumedRole", arn: "arn:aws:sts::123456789012:assumed-role/wg-admin-deploy/GitHubActions" } })).toEqual({ caller: "GitHubActions", kind: "wgadmin" });
    // Another role whose session happens to be called wg-admin-worker is not cloudlabs.
    expect(awsCallerOf("wg-admin-worker", { userIdentity: { type: "AssumedRole", arn: "arn:aws:sts::123456789012:assumed-role/other/wg-admin-worker" } }).kind).toBe("person");
    // A role named like ours but longer is not ours.
    expect(awsCallerOf("x", { userIdentity: { type: "AssumedRole", arn: "arn:aws:sts::123456789012:assumed-role/wg-admin-deploy-old/x" } }).kind).toBe("person");
    // A service-linked role acting for a service: aws.
    expect(awsCallerOf("AutoScaling", { userIdentity: { type: "AssumedRole", arn: "arn:aws:sts::123456789012:assumed-role/AWSServiceRoleForAutoScaling/AutoScaling", invokedBy: "autoscaling.amazonaws.com" } })).toEqual({ caller: "autoscaling.amazonaws.com", kind: "aws" });
    expect(awsCallerOf(null, { userIdentity: { type: "AWSService", invokedBy: "ec2.amazonaws.com" } })).toEqual({ caller: "ec2.amazonaws.com", kind: "aws" });
    expect(awsCallerOf(null, { userIdentity: { type: "Root", arn: "arn:aws:iam::123456789012:root" } })).toEqual({ caller: "root", kind: "person" });
    expect(awsCallerOf(null, null)).toEqual({ caller: null, kind: "person" });
  });

  it("keeps cloudlabs' events and those touching a tagged resource; another project's events never appear (Review Focus 3)", () => {
    const tagged = new Set(["i-0abc", "sg-wg", "eni-0wg"]);
    const rows = keepAwsActivity(normaliseAwsActivity(lookup().Events), tagged);
    expect(rows.map((r) => r.id).sort()).toEqual(["ev-aws-0001", "ev-deploy-0001", "ev-failed-0001", "ev-person-0001", "ev-worker-0001"]);
    expect(rows.some((r) => r.resource_name === "i-0other" || r.resource_name === "sg-other")).toBe(false);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    // Plain resource names from AWS_RESOURCE_KINDS; for several resources, a tagged one of the most telling kind.
    expect(by("ev-person-0001")).toMatchObject({ resource_type: "Security group", resource_name: "sg-wg", kind: "nsg" });
    expect(by("ev-deploy-0001")).toMatchObject({ resource_type: "EC2 instance", resource_name: "i-0abc", kind: "vm" });
    expect(by("ev-aws-0001")).toMatchObject({ resource_type: "Network interface", resource_name: "eni-0wg" });
    // Without the tagged list only cloudlabs' own events are kept.
    expect(keepAwsActivity(normaliseAwsActivity(lookup().Events), null).map((r) => r.id).sort()).toEqual(["ev-deploy-0001", "ev-worker-0001"]);
    // ARNs as resource names match by their id.
    const arnEv = normaliseAwsActivity([{ EventId: "e-arn", EventName: "ModifyInstanceAttribute", EventTime: 1791107000, Username: "someone", Resources: [{ ResourceType: "AWS::EC2::Instance", ResourceName: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0abc" }] }]);
    expect(keepAwsActivity(arnEv, tagged)).toEqual([expect.objectContaining({ id: "e-arn", resource_name: "i-0abc", resource_type: "EC2 instance" })]);
    // A cloudlabs event with no resources: Other, no name.
    const bare = normaliseAwsActivity([{ EventId: "e-bare", EventName: "CreateTags", EventTime: 1791107000, Username: "wg-admin-worker", CloudTrailEvent: JSON.stringify({ userIdentity: { type: "IAMUser", arn: "arn:aws:iam::123456789012:user/wg-admin-worker" } }) }]);
    expect(keepAwsActivity(bare, null)).toEqual([expect.objectContaining({ resource_type: "Other", resource_name: null })]);
  });

  it("reaches back 7 days on the first run, else from the newest stored event or last success, less 20 minutes", () => {
    const now = NOW.getTime();
    expect(lookupStart(now, null, null)).toBe(now - 7 * 24 * 60 * MIN);
    expect(lookupStart(now, ago(30), null)).toBe(now - 50 * MIN);
    expect(lookupStart(now, ago(300), ago(5))).toBe(now - 25 * MIN);
    // Never further back than 7 days, never later than 20 minutes ago.
    expect(lookupStart(now, ago(30 * 24 * 60), null)).toBe(now - 7 * 24 * 60 * MIN);
    expect(lookupStart(now, iso(now + 60 * MIN), null)).toBe(now - 20 * MIN);
  });
});

describe("aws.activity: a run", () => {
  it("asks CloudTrail for write events, stores only cloudlabs' and notes the person's change once", async () => {
    const env = await setup();
    const calls = world();
    const lines = await runAwsInsights(env, NOW, [activity], await opts(env));
    expect(lines).toEqual([]);
    const trail = trailCalls(calls);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ host: "cloudtrail.eu-west-2.amazonaws.com", target: LOOKUP_TARGET });
    expect(trail[0]!.body).toEqual({ LookupAttributes: [{ AttributeKey: "ReadOnly", AttributeValue: "false" }], StartTime: (NOW.getTime() - 7 * 24 * 60 * MIN) / 1000, EndTime: NOW.getTime() / 1000, MaxResults: 50 });
    expect(taggingCalls(calls)).toHaveLength(1);
    const rows = await stored(env);
    expect(rows.map((r) => r.id)).toEqual(["ev-deploy-0001", "ev-worker-0001", "ev-aws-0001", "ev-failed-0001", "ev-person-0001"]);
    expect(rows.find((r) => r.id === "ev-person-0001")).toEqual({ id: "ev-person-0001", at: "2026-10-04T09:55:00.000Z", operation: "AuthorizeSecurityGroupIngress", status: "Succeeded", caller: "someone", caller_kind: "person", resource_type: "Security group", resource_name: "sg-wg" });
    // Review Focus 3: someone else's instance is nowhere.
    expect(JSON.stringify(rows)).not.toMatch(/i-0other|sg-other|other-dev|another-person/);
    // One note: the person's successful change. Not the failed call, not AWS's own, not cloudlabs'.
    expect(await notes(env)).toEqual([{ kind: "drift", message: "Changed in AWS outside cloudlabs: AuthorizeSecurityGroupIngress on Security group sg-wg by someone" }]);
    expect(await feedRow(env, "aws.activity")).toMatchObject({ status: "ok", error: null, next_due_at: iso(NOW.getTime() + 5 * MIN) });

    // Five minutes on, CloudTrail answers the same events (the overlap): nothing new is stored and no second note.
    const later = new Date(NOW.getTime() + 5 * MIN);
    const calls2 = world();
    await runAwsInsights(env, later, [activity], await opts(env));
    expect(trailCalls(calls2)[0]!.body.StartTime).toBe((NOW.getTime() - 20 * MIN) / 1000); // last success less 20 minutes
    expect((await stored(env)).length).toBe(5);
    expect(await notes(env)).toHaveLength(1);
  });

  it("does not look up the tagged resources when every new event is cloudlabs' own", async () => {
    const env = await setup();
    const ours = lookup().Events.filter((e) => e.EventId === "ev-worker-0001" || e.EventId === "ev-deploy-0001");
    const calls = world({ trail: [new Response(JSON.stringify({ Events: ours }), { status: 200 })] });
    await runAwsInsights(env, NOW, [activity], await opts(env));
    expect(taggingCalls(calls)).toHaveLength(0);
    expect((await stored(env)).map((r) => r.id)).toEqual(["ev-deploy-0001", "ev-worker-0001"]);
    expect(await notes(env)).toEqual([]);
  });

  it("follows NextToken for at most 3 pages", async () => {
    const env = await setup();
    const page = (n: number) => () => new Response(JSON.stringify({ Events: [{ ...lookup().Events.find((e) => e.EventId === "ev-worker-0001"), EventId: `ev-page-${n}` }], NextToken: `token-${n}` }), { status: 200 });
    const calls = world({ trail: [page(1), page(2), page(3), page(4)] });
    await runAwsInsights(env, NOW, [activity], await opts(env));
    const trail = trailCalls(calls);
    expect(trail).toHaveLength(3);
    expect(trail.map((c) => c.body.NextToken ?? null)).toEqual([null, "token-1", "token-2"]);
    expect((await stored(env)).map((r) => r.id).sort()).toEqual(["ev-page-1", "ev-page-2", "ev-page-3"]);
  });

  it("a refused LookupEvents names the permission and stores nothing", async () => {
    const env = await setup();
    world({ trail: [new Response(JSON.stringify({ __type: "AccessDeniedException", Message: "User: arn:aws:iam::123456789012:user/wg-admin-worker is not authorized" }), { status: 400 })] });
    await runAwsInsights(env, NOW, [activity], await opts(env));
    const row = await feedRow(env, "aws.activity");
    expect(row).toMatchObject({ status: "error", error: "AWS refused LookupEvents: the Worker's AWS user needs cloudtrail:LookupEvents." });
    expect(row.error).not.toMatch(/arn:|amazonaws\.com/);
    expect(await stored(env)).toEqual([]);
  });

  it("storing twice notes once per event id", async () => {
    const env = await setup();
    const rows = keepAwsActivity(normaliseAwsActivity(lookup().Events), new Set(["i-0abc", "sg-wg", "eni-0wg"]));
    expect(await storeAwsActivity(env, rows)).toBe(1);
    expect(await storeAwsActivity(env, rows)).toBe(0);
    expect(await notes(env)).toHaveLength(1);
    expect(await stored(env)).toHaveLength(5);
  });
});

describe("aws.serviceHealth: parsing AWS's status RSS", () => {
  it("names the EC2 and VPC feeds for the region", () => {
    expect(awsStatusFeeds("eu-west-2")).toEqual([
      { service: "EC2", url: "https://status.aws.amazon.com/rss/ec2-eu-west-2.rss" },
      { service: "VPC", url: "https://status.aws.amazon.com/rss/vpc-eu-west-2.rss" },
    ]);
  });

  it("an empty channel has no items; an HTML page is not RSS", () => {
    expect(parseAwsRss(text("rss-empty.xml"))).toEqual([]);
    expect(parseAwsRss(text("rss-html-error.html"))).toBeNull();
    expect(parseAwsRss("")).toBeNull();
  });

  it("items become service events: newest and fresh is Active, the rest Resolved; maintenance is planned", () => {
    const items = parseAwsRss(text("rss-active.xml"))!;
    expect(items).toHaveLength(3);
    const rows = normaliseAwsRss(items, "EC2", "London", NOW);
    expect(rows[0]).toEqual({
      tracking_id: "https://status.aws.amazon.com/#ec2-eu-west-2_1791106200",
      type: "ServiceIssue",
      status: "Active",
      level: null,
      title: "Increased API Error Rates",
      summary: "We are investigating increased API error rates & latencies for the RunInstances API in the EU-WEST-2 Region. Existing instances are not affected.",
      services: ["EC2"],
      regions: ["London"],
      starts_at: "2026-10-04T09:30:00.000Z",
      ends_at: null,
      updated_at: "2026-10-04T09:30:00.000Z",
    });
    expect(rows[1]).toMatchObject({ type: "PlannedMaintenance", status: "Resolved", title: "Informational message: Scheduled network maintenance" });
    expect(rows[2]).toMatchObject({ type: "ServiceIssue", status: "Resolved", summary: expect.stringContaining("resolved & the service") });
    // The newest item, but over 24 hours old: Resolved.
    expect(normaliseAwsRss(items, "EC2", "London", new Date(NOW.getTime() + 25 * 60 * MIN))[0]!.status).toBe("Resolved");
    // The newest item says it is resolved.
    const resolved = normaliseAwsRss(parseAwsRss(text("rss-resolved.xml"))!, "EC2", "London", NOW);
    expect(resolved.map((r) => r.status)).toEqual(["Resolved", "Resolved"]);
  });

  it("summaries are capped at 2 KB", () => {
    const long = `<rss version="2.0"><channel><item><title>T</title><guid>g1</guid><pubDate>Sun, 04 Oct 2026 02:30:00 PDT</pubDate><description><![CDATA[${"x".repeat(5000)}]]></description></item></channel></rss>`;
    expect(normaliseAwsRss(parseAwsRss(long)!, "VPC", "London", NOW)[0]!.summary!.length).toBe(2048);
  });
});

describe("aws.serviceHealth: a run", () => {
  it("reads both feeds (2 calls) and stores the items with the region's plain name", async () => {
    const env = await setup();
    const calls = world({ rss: { ec2: () => new Response(text("rss-active.xml"), { status: 200 }) } });
    const lines = await runAwsInsights(env, NOW, [serviceHealth], await opts(env));
    expect(lines).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual(["https://status.aws.amazon.com/rss/ec2-eu-west-2.rss", "https://status.aws.amazon.com/rss/vpc-eu-west-2.rss"]);
    const rows = await events(env);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ status: "Active", services: '["EC2"]', regions: '["London"]', title: "Increased API Error Rates" });
    expect(await feedRow(env, "aws.serviceHealth")).toMatchObject({ status: "ok", next_due_at: iso(NOW.getTime() + 15 * MIN) });
  });

  it("a later resolved item resolves the issue", async () => {
    const env = await setup();
    world({ rss: { ec2: () => new Response(text("rss-active.xml"), { status: 200 }) } });
    await runAwsInsights(env, NOW, [serviceHealth], await opts(env));
    const later = new Date(NOW.getTime() + 15 * MIN);
    world({ rss: { ec2: () => new Response(text("rss-resolved.xml"), { status: 200 }) } });
    await runAwsInsights(env, later, [serviceHealth], await opts(env));
    const rows = await events(env);
    expect(rows.filter((r) => r.status === "Active")).toEqual([]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ tracking_id: "https://status.aws.amazon.com/#ec2-eu-west-2_1791108000", status: "Resolved" });
  });

  it("an HTML error page records an error and leaves the stored events alone (Review Focus 5)", async () => {
    const env = await setup();
    world({ rss: { ec2: () => new Response(text("rss-active.xml"), { status: 200 }) } });
    await runAwsInsights(env, NOW, [serviceHealth], await opts(env));
    const before = JSON.stringify(await events(env));
    const later = new Date(NOW.getTime() + 15 * MIN);
    world({ rss: { ec2: () => new Response(text("rss-html-error.html"), { status: 200, headers: { "Content-Type": "text/html" } }) } });
    await runAwsInsights(env, later, [serviceHealth], await opts(env));
    expect(JSON.stringify(await events(env))).toBe(before);
    const row = await feedRow(env, "aws.serviceHealth");
    expect(row).toMatchObject({ status: "error", error: "AWS's EC2 status feed did not answer with RSS." });
  });

  it("a non-200 answer records an error without the address; the other feed is still read", async () => {
    const env = await setup();
    const calls = world({ rss: { ec2: () => new Response("Service Unavailable", { status: 503 }), vpc: () => new Response(text("rss-active.xml").replace(/ec2-eu-west-2/g, "vpc-eu-west-2"), { status: 200 }) } });
    await runAwsInsights(env, NOW, [serviceHealth], await opts(env));
    expect(calls).toHaveLength(2);
    const row = await feedRow(env, "aws.serviceHealth");
    expect(row).toMatchObject({ status: "error", error: "AWS's EC2 status feed answered 503." });
    expect(row.error).not.toMatch(/https?:|\.rss/);
    expect((await events(env)).map((r) => r.services)).toEqual(['["VPC"]', '["VPC"]', '["VPC"]']);
  });

  it("an empty channel is ok and wipes nothing; an issue no longer listed reads Resolved (Review Focus 5)", async () => {
    const env = await setup();
    world({ rss: { ec2: () => new Response(text("rss-active.xml"), { status: 200 }) } });
    await runAwsInsights(env, NOW, [serviceHealth], await opts(env));
    const later = new Date(NOW.getTime() + 15 * MIN);
    world();
    await runAwsInsights(env, later, [serviceHealth], await opts(env));
    expect(await feedRow(env, "aws.serviceHealth")).toMatchObject({ status: "ok", error: null });
    const rows = await events(env);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "Resolved")).toBe(true);
  });
});
