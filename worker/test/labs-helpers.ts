// labs-helpers.ts
//
// Plain English: the lab engine's test bench (plan L2). A small catalogue of
// its own (so a lab.yaml change in labs/ never moves these tests), a signed-in
// API with the permission check passed, and the steps a lab run goes through
// from the outside: collect its secrets, report its result, ask to peer.

import { vi } from "vitest";
import { apiEnv, api } from "./api-helpers";
import type { World } from "./harness";
import type { Env } from "../src/env";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { issueLabSecrets, handleLabCallback, handleLabPeer } from "../src/labs/callbacks";
import type { LabCatalogue, LabDef } from "../../shared/labs";

const base = (id: string, number: number, over: Partial<LabDef> = {}): LabDef => ({
  id,
  number,
  version: 1,
  title: `Lab ${number}`,
  summary: `Lab ${number} summary.`,
  exam: id.startsWith("az305") ? "AZ-305" : "AZ-104",
  skill_areas: [id.startsWith("az305") ? "az305.infra" : "az104.storage"],
  level: "associate",
  type: "explore",
  prerequisites: [],
  cost: { items: [{ name: "Storage account", gbp_h: 0.01 }], pricey: null },
  timing: { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 },
  capacity: { vm_sizes: [] },
  regions: { secondary: null },
  connectivity: { peering: "off", dns_link: false, subnets_used: 0 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});

/** Labs 1, 5, 6, 7 and 28, shaped like the real ones but with round numbers. */
export const TEST_LABS: LabDef[] = [
  base("az104-01-identity", 1, { title: "Identity", identity: { creates: ["user", "group"], roles: [{ role: "Reader", scope: "resource_group" }], governance: true }, timing: { deploy_min: 2, destroy_min: 2, session_h: 1, max_h: 4 } }),
  base("az104-05-storage", 5, { title: "Storage accounts" }),
  base("az104-06-blob-security", 6, {
    title: "Blob security",
    cost: { items: [{ name: "Storage account", gbp_h: 0.0001 }, { name: "Private endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" } }], pricey: null },
    connectivity: { peering: "optional", dns_link: true, subnets_used: 1 },
    identity: { creates: ["group"], roles: [{ role: "Storage Blob Data Reader", scope: "resource_group" }], governance: false },
    timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 },
  }),
  base("az104-07-files", 7, {
    title: "Azure Files",
    cost: { items: [{ name: "Linux VM, Standard_B1s", gbp_h: 0.0083, retail: { sku: "Standard_B1s" } }, { name: "OS disk", gbp_h: 0.0034 }], pricey: null },
    capacity: { vm_sizes: ["Standard_B1s"] },
    connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  }),
  base("az305-28-hub-spoke-fw", 28, {
    title: "Hub-spoke with Azure Firewall",
    cost: { items: [{ name: "Azure Firewall Basic", gbp_h: 0.4 }, { name: "Public IPs", gbp_h: 0.01, qty: 2 }], pricey: "Azure Firewall Basic" },
    timing: { deploy_min: 15, destroy_min: 10, session_h: 2, max_h: 3 },
    connectivity: { peering: "required", dns_link: false, subnets_used: 2 },
  }),
];

export const TEST_CATALOGUE: LabCatalogue = {
  schema: 1,
  skillAreas: [
    { key: "az104.storage", exam: "AZ-104", name: "Implement and manage storage" },
    { key: "az305.infra", exam: "AZ-305", name: "Design infrastructure solutions" },
  ],
  labs: TEST_LABS,
  readmes: { "az104-05-storage": [{ t: "h", level: 2, text: "What it deploys" }] },
};

export const NOW = "2026-10-04T12:00:00.000Z";

/** Freeze the clock (Date only) at `at`. */
export function freeze(at = NOW): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

/** Move the frozen clock on by `ms`. */
export function advance(ms: number): Date {
  const t = new Date(Date.now() + ms);
  vi.setSystemTime(t);
  return t;
}

export const MIN = 60_000;
export const HOUR = 3_600_000;

/** A signed-in API on the test catalogue, with the permission check passed. */
export async function labEnv(overrides: Partial<Env> = {}): Promise<{ env: Env; world: World }> {
  setCatalogueForTest(TEST_CATALOGUE);
  const r = apiEnv(overrides);
  await r.env.STATUS.put("labs:permissions", JSON.stringify({ checkedAt: NOW, role: true, users: true, groups: true, message: null }));
  return r;
}

/** The GitHub run id the harness gave the dispatch of our run `runId`. */
export function ghIdFor(world: World, runId: string): number {
  const r = [...world.ghRuns.values()].find((x) => x.display_title.endsWith(` ${runId}`));
  if (!r) throw new Error(`no GitHub run for ${runId}`);
  return r.id;
}

/** The lab.yml dispatches, newest last. */
export const labDispatches = (world: World) => world.dispatches.filter((d) => d.workflow === "lab.yml");

/** Collect a lab run's secrets as its workflow would (after the OIDC check). */
export async function secrets(env: Env, world: World, runId: string): Promise<{ callback_token: string; admin_password: string }> {
  const r = await issueLabSecrets(env, runId, ghIdFor(world, runId));
  if (r.status !== 200) throw new Error(`secrets: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { callback_token: string; admin_password: string };
}

/** Report a lab run's result as step 16 does. */
export async function report(env: Env, runId: string, token: string, status: string, outputs: Record<string, unknown> = {}, action?: string) {
  const row = await env.DB.prepare("SELECT action FROM lab_runs WHERE id = ?1").bind(runId).first<{ action: string }>();
  return handleLabCallback(env, token, { run_id: runId, action: action ?? row?.action ?? "deploy", status, outputs });
}

export const peer = (env: Env, token: string, body: unknown) => handleLabPeer(env, token, body);

/** Deploy a lab through the API; returns the session and run ids. */
export async function deployLab(env: Env, id: string, body: Record<string, unknown> = { hours: 2, peer: false }) {
  const r = await api(env, "POST", `/labs/${id}/deploy`, body);
  return r;
}

/** Deploy and finish the deploy with a successful result. */
export async function runningLab(env: Env, world: World, id: string, body: Record<string, unknown> = { hours: 2, peer: false }, outputs: Record<string, unknown> = { private_ips: { vm: "10.64.0.4" }, connect: ["ssh azureuser@10.64.0.4"], clean: true, leftovers: [], deploy_seconds: 120, destroy_seconds: 0 }) {
  const r = await deployLab(env, id, body);
  if (r.status !== 200) throw new Error(`deploy ${id}: ${r.status} ${r.text}`);
  const runId = r.json.runId as string;
  const sid = r.json.sessionId as string;
  const s = await secrets(env, world, runId);
  const done = await report(env, runId, s.callback_token, "success", outputs);
  if (done.status !== 200) throw new Error(`callback: ${done.status} ${JSON.stringify(done.body)}`);
  return { sid, runId, token: s.callback_token, password: s.admin_password };
}

export const session = (env: Env, sid: string) => env.DB.prepare("SELECT * FROM lab_sessions WHERE id = ?1").bind(sid).first<Record<string, any>>();
export const labRun = (env: Env, id: string) => env.DB.prepare("SELECT * FROM lab_runs WHERE id = ?1").bind(id).first<Record<string, any>>();
export const rows = async <T = Record<string, any>>(env: Env, sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
export { api };
