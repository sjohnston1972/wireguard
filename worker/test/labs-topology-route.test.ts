// labs-topology-route.test.ts: GET /api/v1/labs/:id/topology (lab topology spec §6, rulings 15-16, Review Focus 2).
// The harness stands in for D1 and KV; Resource Graph is a fake that records each query.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, labEnv as baseLabEnv, TEST_CATALOGUE, TEST_LABS } from "./labs-helpers";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { labTopology, resetTopologyCache, TOPOLOGY_CACHE_MS, TOPOLOGY_TIMEOUT_MS } from "../src/labs/topology";
import { LABS_KV, seedTopologyDev } from "../src/devseed-labs";
import { topologyQuery } from "../../shared/topology/query";
import { denyProblems } from "../../shared/topology/props";
import type { Env } from "../src/env";

const LAB = "az104-06-blob-security";
const SUB = "/subscriptions/sub";
const rg = (name: string) => `${SUB}/resourceGroups/${name}`;

/** Rows Resource Graph would give for the lab, plus rows that must never show. */
const ROWS = [
  {
    id: `${rg(`rg-lab-${LAB}`)}/providers/Microsoft.Network/virtualNetworks/vnet-lab`,
    name: "vnet-lab",
    type: "microsoft.network/virtualnetworks",
    location: "uksouth",
    resourceGroup: `rg-lab-${LAB}`,
    tags: { lab: LAB, project: "wg-admin-labs", session: "ls-secret-session", owner: "someone@contoso.onmicrosoft.com" },
    properties: { provisioningState: "Succeeded", addressSpace: { addressPrefixes: ["10.64.0.0/20"] }, subnets: [{ id: `${rg(`rg-lab-${LAB}`)}/providers/Microsoft.Network/virtualNetworks/vnet-lab/subnets/snet-endpoints`, name: "snet-endpoints", properties: { addressPrefix: "10.64.0.0/24" } }] },
  },
  {
    id: `${rg(`rg-lab-${LAB}`)}/providers/Microsoft.Storage/storageAccounts/l06abcdeblob`,
    name: "l06abcdeblob",
    type: "microsoft.storage/storageaccounts",
    kind: "StorageV2",
    location: "uksouth",
    resourceGroup: `rg-lab-${LAB}`,
    sku: { name: "Standard_LRS" },
    properties: { provisioningState: "Succeeded", primaryEndpoints: { blob: "https://l06abcdeblob.blob.core.windows.net/" }, connectionString: "DefaultEndpointsProtocol=https;AccountKey=abc", customData: "c2VjcmV0" },
  },
  // Another lab's group, and a longer lab id's group: dropped by the ownsName re-check.
  { id: `${rg("rg-lab-az104-05-storage")}/providers/Microsoft.Storage/storageAccounts/l05other`, name: "l05other", type: "microsoft.storage/storageaccounts", resourceGroup: "rg-lab-az104-05-storage", properties: {} },
  { id: `${rg(`rg-lab-${LAB}-extra`)}/providers/Microsoft.Storage/storageAccounts/l99longer`, name: "l99longer", type: "microsoft.storage/storageaccounts", resourceGroup: `rg-lab-${LAB}-extra`, properties: {} },
];

interface Arg {
  calls: { url: string; body: { subscriptions: string[]; query: string; options: { resultFormat: string; $top: number } }; signal?: AbortSignal | null }[];
  reply: (n: number) => Response | Promise<Response>;
}

/** Resource Graph, faked in front of the harness's own fetch. */
function fakeArg(): Arg {
  const arg: Arg = { calls: [], reply: () => Response.json({ totalRecords: ROWS.length, count: ROWS.length, data: ROWS }) };
  const prev = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.hostname === "management.azure.com" && u.pathname.toLowerCase() === "/providers/microsoft.resourcegraph/resources") {
      arg.calls.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
      return arg.reply(arg.calls.length);
    }
    return prev(url as string, init);
  });
  return arg;
}

/** A live session of `lab` straight into D1. */
async function liveSession(env: Env, sid: string, lab = LAB, state = "running") {
  await env.DB.prepare(
    `INSERT INTO lab_sessions (id, lab_id, lab_version, state, test, region, peering, name_prefix, requested_at, ready_at, max_until, est_gbp_h)
     VALUES (?1, ?2, CAST(4 AS INTEGER), ?3, CAST(0 AS INTEGER), 'uksouth', 'off', 'l06abcde', '2026-10-04T11:00:00.000Z', '2026-10-04T11:05:00.000Z', '2026-10-04T17:00:00.000Z', 0.01)`,
  )
    .bind(sid, lab, state)
    .run();
}

beforeEach(() => {
  resetTopologyCache();
});

/** The labs test env, with a longer catalogue id sharing lab 6's prefix (az104-06-blob-security-extra). */
async function labEnv(overrides: Partial<Env> = {}) {
  const r = await baseLabEnv(overrides);
  setCatalogueForTest({ ...TEST_CATALOGUE, labs: [...TEST_LABS, { ...TEST_LABS[2]!, id: `${LAB}-extra`, number: 6 }] });
  return r;
}
afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  resetTopologyCache();
});

describe("GET /labs/:id/topology", () => {
  it("the query names the subscription and only rg-lab-<id> and rg-lab-<id>-*, as topologyQuery writes it", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("ok");
    expect(arg.calls).toHaveLength(1);
    expect(arg.calls[0]!.url).toContain("api-version=2022-10-01");
    expect(arg.calls[0]!.body).toEqual({ subscriptions: ["sub"], query: topologyQuery(LAB), options: { resultFormat: "objectArray", $top: 1000 } });
  });

  it("an id outside the catalogue is 404 before any query", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    const r = await api(env, "GET", "/labs/az104-99-nope/topology");
    expect(r.status).toBe(404);
    expect(arg.calls).toHaveLength(0);
  });

  it("a row from another lab's group, or from a longer lab id's group, is dropped", async () => {
    const { env } = await labEnv();
    fakeArg();
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    const labels = (r.json.live.nodes as { label: string }[]).map((n) => n.label);
    expect(labels).toEqual(expect.arrayContaining(["vnet-lab", "snet-endpoints", "l06abcdeblob", `rg-lab-${LAB}`]));
    expect(labels).not.toContain("l05other");
    expect(labels).not.toContain("l99longer");
    expect(labels).not.toContain(`rg-lab-${LAB}-extra`);
  });

  it("the response holds no raw properties and no tag but lab and project", async () => {
    const { env } = await labEnv();
    fakeArg();
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.text).not.toMatch(/"properties"|connectionString|AccountKey|customData|c2VjcmV0|primaryEndpoints|ls-secret-session|someone@contoso/);
    expect(denyProblems(r.json.live)).toEqual([]);
    expect(r.json).toMatchObject({ status: "ok", message: null, truncated: false, fetchedAt: expect.any(String) });
  });

  it("no live session answers not_running without a query", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.json).toMatchObject({ status: "not_running", live: null });
    expect(arg.calls).toHaveLength(0);
  });

  it("Azure not configured answers no_azure", async () => {
    const { env } = await labEnv({ AZURE_CLIENT_ID: undefined, AZURE_CLIENT_SECRET: undefined });
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.json).toMatchObject({ status: "no_azure", live: null });
    expect(r.json.message).toMatch(/not connected/);
    expect(arg.calls).toHaveLength(0);
  });

  it("ARM 500 answers failed with a plain message, never Azure's body", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => Response.json({ error: { code: "InternalServerError", message: "secret internal detail" } }, { status: 500 });
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.json).toMatchObject({ status: "failed", live: null });
    expect(r.json.message).toMatch(/Azure answered 500/);
    expect(r.text).not.toMatch(/secret internal detail/);
  });

  it("403 says the identity cannot read Resource Graph", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => Response.json({ error: { code: "AuthorizationFailed" } }, { status: 403 });
    await liveSession(env, "ls-1");
    expect((await labTopology(env, LAB)).message).toMatch(/403.*Resource Graph/);
  });

  it("429 answers throttled with the cached graph", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    const first = await labTopology(env, LAB, 1_000_000);
    expect(first.status).toBe("ok");
    arg.reply = () => new Response("{}", { status: 429 });
    const later = await labTopology(env, LAB, 1_000_000 + TOPOLOGY_CACHE_MS + 1);
    expect(later).toMatchObject({ status: "throttled", live: first.live, fetchedAt: first.fetchedAt });
    expect(arg.calls).toHaveLength(2);
  });

  it("429 with nothing cached answers throttled with no graph", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => new Response("{}", { status: 429 });
    await liveSession(env, "ls-1");
    expect(await labTopology(env, LAB)).toMatchObject({ status: "throttled", live: null });
  });

  it("two requests within 30 s make one query; after 30 s a new one", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    await labTopology(env, LAB, 5_000_000);
    await labTopology(env, LAB, 5_000_000 + TOPOLOGY_CACHE_MS - 1);
    expect(arg.calls).toHaveLength(1);
    await labTopology(env, LAB, 5_000_000 + TOPOLOGY_CACHE_MS);
    expect(arg.calls).toHaveLength(2);
  });

  it("two at once share one query", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    arg.reply = async () => {
      await gate;
      return Response.json({ data: ROWS });
    };
    await liveSession(env, "ls-1");
    const both = Promise.all([labTopology(env, LAB, 7_000_000), labTopology(env, LAB, 7_000_000)]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;
    expect(arg.calls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it("a new session is a new cache entry", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    await labTopology(env, LAB, 9_000_000);
    await env.DB.prepare("UPDATE lab_sessions SET state = 'ended' WHERE id = 'ls-1'").run();
    await liveSession(env, "ls-2");
    await labTopology(env, LAB, 9_000_001);
    expect(arg.calls).toHaveLength(2);
  });

  it("more than 1000 rows answers truncated with a banner message", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => Response.json({ data: ROWS, $skipToken: "next-page" });
    await liveSession(env, "ls-1");
    expect(await labTopology(env, LAB)).toMatchObject({ status: "ok", truncated: true, message: expect.stringMatching(/first 1000/) });
  });

  it("rows the builder cannot read answer failed (not a 500), with the reason", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => Response.json({ data: [{ id: `${rg(`rg-lab-${LAB}`)}/providers/x/y/z`, name: "z", type: 5, resourceGroup: `rg-lab-${LAB}`, properties: {} }] });
    await liveSession(env, "ls-1");
    const r = await api(env, "GET", `/labs/${LAB}/topology`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "failed", live: null });
    expect(r.json.message).toMatch(/could not be drawn.*\(.+\).*planned diagram/);
  });

  it("the Resource Graph read carries a timeout; a timed-out read answers failed", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    await labTopology(env, LAB, 11_000_000);
    expect(arg.calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(TOPOLOGY_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    arg.reply = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const t = await labTopology(env, LAB, 11_000_000 + TOPOLOGY_CACHE_MS);
    expect(t).toMatchObject({ status: "failed", live: null });
    expect(t.message).toMatch(/did not answer the diagram.s read within 10 s/);
  });

  it("a failed answer is cached for 30 s too, then asked again", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    arg.reply = () => new Response("{}", { status: 500 });
    await liveSession(env, "ls-1");
    expect((await labTopology(env, LAB, 13_000_000)).status).toBe("failed");
    expect((await labTopology(env, LAB, 13_000_000 + TOPOLOGY_CACHE_MS - 1)).status).toBe("failed");
    expect(arg.calls).toHaveLength(1);
    arg.reply = () => Response.json({ data: ROWS });
    expect((await labTopology(env, LAB, 13_000_000 + TOPOLOGY_CACHE_MS)).status).toBe("ok");
    expect(arg.calls).toHaveLength(2);
  });

  it("a cached failure does not lose the last good graph for a later 429", async () => {
    const { env } = await labEnv();
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    const first = await labTopology(env, LAB, 15_000_000);
    arg.reply = () => new Response("{}", { status: 500 });
    await labTopology(env, LAB, 15_000_000 + TOPOLOGY_CACHE_MS);
    arg.reply = () => new Response("{}", { status: 429 });
    const later = await labTopology(env, LAB, 15_000_000 + 2 * TOPOLOGY_CACHE_MS);
    expect(later).toMatchObject({ status: "throttled", live: first.live });
  });

  it("the dev fixture is read only under AUTH_DEV_BYPASS when Azure is not configured", async () => {
    const { env } = await labEnv({ AZURE_CLIENT_ID: undefined, AZURE_CLIENT_SECRET: undefined });
    const arg = fakeArg();
    await liveSession(env, "ls-1");
    await seedTopologyDev(env);
    expect(await env.STATUS.get(LABS_KV.topologyDev)).toBeTruthy();
    const dev = await labTopology(env, LAB);
    expect(dev.status).toBe("ok");
    expect(dev.live?.nodes.some((n) => n.label === "nsg-handmade")).toBe(true);
    // The zone link folds into its zone and draws a link edge; the endpoint's NIC folds into the endpoint.
    const zone = dev.live!.nodes.find((n) => n.kind === "privateDnsZone")!;
    expect(zone.folded?.map((f) => f.label)).toEqual(["privatelink.blob.core.windows.net/link-vnet-lab"]);
    expect(dev.live!.edges.some((e) => e.from === zone.id && e.kind === "dependency" && e.label === "link")).toBe(true);
    const pe = dev.live!.nodes.find((n) => n.kind === "privateEndpoint")!;
    expect(pe).toMatchObject({ props: { groupId: "blob", privateIp: "10.64.0.4" } });
    expect(dev.live!.edges.some((e) => e.from === pe.id && e.label === "blob" && e.state?.word === "Approved")).toBe(true);
    expect(dev.live!.nodes.some((n) => n.id === "wg/gateway")).toBe(true);
    expect(arg.calls).toHaveLength(0);
    // Without the bypass the seeded rows are never read.
    expect(await labTopology({ ...env, AUTH_DEV_BYPASS: undefined } as Env, LAB)).toMatchObject({ status: "no_azure", live: null });
    // And with Azure configured the real query runs, not the fixture.
    const { env: real } = await labEnv();
    const realArg = fakeArg();
    await liveSession(real, "ls-9");
    await seedTopologyDev(real);
    await labTopology(real, LAB);
    expect(realArg.calls).toHaveLength(1);
  });
});
