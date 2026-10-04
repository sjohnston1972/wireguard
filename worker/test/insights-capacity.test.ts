// insights-capacity.test.ts
//
// Plain English: region capacity and quota (plan X1.6): is the next
// deploy's VM size offered to this subscription in the region, and is there
// vCPU quota for it (plus the test VM)? Warnings only when the answer is no.
import { describe, it, expect, afterEach, vi } from "vitest";
import { skuRestrictions, normaliseUsages, capacityCheck } from "../src/insights/feeds/capacity";
import { runInsights } from "../src/insights/runner";
import type { CapacityDoc } from "../src/insights/types";
import { api, base } from "./api-helpers";
import { azureEnv, allNotDue, setFeed, feedRows, callsTo, fixture, fixtureText, json, NOW, ago, iso, MIN } from "./insights-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const SIZES = ["Standard_B1s", "Standard_B1ls", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"];
const doc = (): CapacityDoc => ({ sizes: skuRestrictions(fixtureText("skus-uksouth"), SIZES), ...normaliseUsages(fixture("usages-uksouth"), ["standardBSFamily", "standardBasv2Family"]) });

describe("capacity", () => {
  it("skuRestrictions slices only the wanted sizes from a large reply", () => {
    const text = fixtureText("skus-uksouth");
    const filler = Array.from({ length: 4000 }, (_, i) => `{"resourceType":"disks","name":"Filler_${i}","tier":"Standard","locations":["UKSouth"],"capabilities":[{"name":"MaxSizeGiB","value":"${i}"}],"restrictions":[]}`).join(",\n");
    const big = text.replace('{"value":[', `{"value":[\n${filler},`);
    expect(big.length).toBeGreaterThan(500_000);
    const parse = vi.spyOn(JSON, "parse");
    const sizes = skuRestrictions(big, ["Standard_B1s", "Standard_B2ats_v2"]);
    expect(Math.max(...parse.mock.calls.map((c) => String(c[0]).length))).toBeLessThan(2_000);
    expect(sizes).toEqual([
      { name: "Standard_B1s", available: true, reason: null, vcpus: 1, family: "standardBSFamily" }, // a Zone restriction is not a Location one
      { name: "Standard_B2ats_v2", available: true, reason: null, vcpus: 2, family: "standardBasv2Family" }, // braces and quotes inside a string do not confuse the slicing
    ]);
    // Standard_B1s is not confused with Standard_B1s_v2; a size missing from the list is not offered there.
    expect(skuRestrictions(text, ["Standard_B1s_v2", "Standard_Nope"])).toEqual([
      { name: "Standard_B1s_v2", available: false, reason: "NotAvailableForSubscription", vcpus: 2, family: "standardBsv2Family" },
      { name: "Standard_Nope", available: false, reason: "NotOffered", vcpus: null, family: null },
    ]);
  });

  it("NotAvailableForSubscription makes available false with the reason", () => {
    const d = doc();
    expect(d.sizes.find((s) => s.name === "Standard_B2s")).toEqual({ name: "Standard_B2s", available: false, reason: "NotAvailableForSubscription", vcpus: 2, family: "standardBSFamily" });
    const c = capacityCheck(d, "uksouth", "Standard_B2s", false, ago(120), NOW);
    expect(c).toMatchObject({ region: "uksouth", size: "Standard_B2s", available: false, reason: "NotAvailableForSubscription", ok: false, vcpusNeeded: 2, fetchedAt: ago(120) });
  });

  it("quota adds 1 vCPU for the test VM", () => {
    const d = doc(); // cores 9 of 10, B-series 8 of 10
    expect(normaliseUsages(fixture("usages-uksouth"), ["standardBSFamily"])).toEqual({ usages: [{ family: "standardBSFamily", used: 8, limit: 10 }], cores: { used: 9, limit: 10 } });
    const plain = capacityCheck(d, "uksouth", "Standard_B1s", false, ago(10), NOW);
    expect(plain).toMatchObject({ vcpusNeeded: 1, ok: true, family: { name: "standardBSFamily", used: 8, limit: 10 }, total: { used: 9, limit: 10 } });
    const withTest = capacityCheck(d, "uksouth", "Standard_B1s", true, ago(10), NOW);
    expect(withTest).toMatchObject({ vcpusNeeded: 2, ok: false });
    // A Basv2 size with the test VM: the B-series family needs its 1 vCPU free too.
    d.cores = { used: 0, limit: 10 };
    d.usages = [{ family: "standardBSFamily", used: 10, limit: 10 }, { family: "standardBasv2Family", used: 0, limit: 10 }];
    expect(capacityCheck(d, "uksouth", "Standard_B2ats_v2", false, ago(10), NOW).ok).toBe(true);
    expect(capacityCheck(d, "uksouth", "Standard_B2ats_v2", true, ago(10), NOW).ok).toBe(false);
    // An unknown size: nothing to say.
    expect(capacityCheck(d, "uksouth", "Standard_D2s_v5", false, ago(10), NOW)).toMatchObject({ available: null, ok: null, message: null, vcpusNeeded: null });
  });

  it("message wording matches spec 10.2", () => {
    const d = doc();
    expect(capacityCheck(d, "uksouth", "Standard_B2s", false, ago(10), NOW).message).toBe("Standard_B2s isn't offered to this subscription in UK South (NotAvailableForSubscription).");
    d.usages = [{ family: "standardBSFamily", used: 9, limit: 10 }];
    d.cores = { used: 9, limit: 20 };
    expect(capacityCheck(d, "uksouth", "Standard_B1s", true, ago(10), NOW).message).toBe("Needs 2 B-series vCPUs; 9 of 10 used in UK South.");
    d.usages = [{ family: "standardBSFamily", used: 1, limit: 10 }];
    d.cores = { used: 9, limit: 10 };
    expect(capacityCheck(d, "uksouth", "Standard_B1s", true, ago(10), NOW).message).toBe("Needs 2 vCPUs; 9 of 10 used in UK South.");
    d.cores = { used: 1, limit: 10 };
    expect(capacityCheck(d, "uksouth", "Standard_B1s", false, ago(120), NOW).message).toBe("Available · vCPU quota 1 of 10 used · checked 2 h ago");
    expect(capacityCheck(d, "uksouth", "Standard_B1s", false, ago(4), NOW).message).toBe("Available · vCPU quota 1 of 10 used · checked 4 min ago");
    const missing = { ...doc(), sizes: skuRestrictions("{\"value\":[]}", ["Standard_B1s"]) };
    expect(capacityCheck(missing, "uksouth", "Standard_B1s", false, ago(4), NOW).message).toBe("Standard_B1s isn't offered in UK South.");
  });

  it("the feed reads one region per run, the configured one first, and stores each daily", async () => {
    const { env, az } = azureEnv();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("INSERT INTO profiles (name, region, vm_size) VALUES ('NL', 'westeurope', 'Standard_B2s')").run();
    await allNotDue(env);
    await setFeed(env, "capacity", { status: "ok", next_due_at: ago(1) });
    await runInsights(env, NOW);
    expect(callsTo(az, "Microsoft.Compute/skus").map((c) => c.u.searchParams.get("$filter"))).toEqual(["location eq 'uksouth'"]);
    expect(callsTo(az, "/usages")[0]!.u.pathname).toMatch(/\/locations\/uksouth\/usages$/);
    expect(callsTo(az, "Microsoft.Compute/skus")[0]!.u.searchParams.get("api-version")).toBe("2021-07-01");
    expect(callsTo(az, "/usages")[0]!.u.searchParams.get("api-version")).toBe("2024-07-01");
    // westeurope is still to read: due next run.
    expect((await feedRows(env)).capacity.next_due_at).toBe(iso(NOW.getTime() + 5 * MIN));
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    expect(callsTo(az, "Microsoft.Compute/skus").map((c) => c.u.searchParams.get("$filter"))).toEqual(["location eq 'uksouth'", "location eq 'westeurope'"]);
    expect((await feedRows(env)).capacity.next_due_at).toBe(iso(NOW.getTime() + 5 * MIN + 1440 * MIN));
    const stored = (await env.DB.prepare("SELECT region, json FROM az_capacity ORDER BY region").all<{ region: string; json: string }>()).results;
    expect(stored.map((r) => r.region)).toEqual(["uksouth", "westeurope"]);
    const d = JSON.parse(stored[0]!.json) as CapacityDoc;
    expect(d.sizes.map((s) => s.name)).toEqual(expect.arrayContaining(["Standard_B1s", "Standard_B1ls", "Standard_B2s", "Standard_B2ats_v2"]));
  });

  it("a cache miss fetches once per region per 10 minutes", async () => {
    const { env, az } = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const skus = () => callsTo(az, "Microsoft.Compute/skus").length;
    let r = await api(env, "GET", "/azure/capacity?region=uksouth&size=Standard_B2s");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ available: false, reason: "NotAvailableForSubscription", ok: false, message: "Standard_B2s isn't offered to this subscription in UK South (NotAvailableForSubscription)." });
    expect(skus()).toBe(1);
    // Cached now: no second fetch.
    r = await api(env, "GET", "/azure/capacity?region=uksouth&size=Standard_B1s");
    expect(r.json.available).toBe(true);
    expect(skus()).toBe(1);
    // Azure failing for another region: one try, then nothing for 10 minutes.
    az.handlers.push((c) => (c.url.includes("westeurope") ? json({ error: { code: "InternalServerError" } }, 500) : undefined));
    r = await api(env, "GET", "/azure/capacity?region=westeurope&size=Standard_B1s");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ region: "westeurope", available: null, ok: null });
    expect(skus()).toBe(2);
    await api(env, "GET", "/azure/capacity?region=westeurope&size=Standard_B1s");
    expect(skus()).toBe(2);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * MIN));
    await api(env, "GET", "/azure/capacity?region=westeurope&size=Standard_B1s");
    expect(skus()).toBe(3);
    // Nothing secret in what was answered.
    expect(JSON.stringify(r.json)).not.toMatch(/sub|secret|token/i);
  });

  it("overview carries capacity for the deploy target", async () => {
    const { env } = azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    let o = await api(env, "GET", "/overview");
    expect(o.json.capacity).toBeNull();
    await env.DB.prepare("INSERT INTO az_capacity (region, json, fetched_at) VALUES ('uksouth', ?1, ?2)").bind(JSON.stringify(doc()), ago(60)).run();
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('vm_size', 'Standard_B2s')").run();
    o = await api(env, "GET", "/overview");
    expect(o.json.capacity).toMatchObject({ region: "uksouth", size: "Standard_B2s", ok: false, available: false, fetchedAt: ago(60) });
  });
});
