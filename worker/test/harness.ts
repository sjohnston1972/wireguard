// harness.ts
//
// Plain English: a lab bench for the Worker. It stands up stand-ins for the
// Cloudflare pieces (D1 as a real in-memory SQLite database with the real
// migrations, KV as a map, the real RunLock Durable Object class with an
// in-memory store) and fakes the outside world (GitHub, Azure, DNS, ntfy)
// by answering fetch() calls. Tests then drive whole journeys: deploy,
// callback, heartbeat, timer, hibernate, resume, tear down, without a cloud.

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Env } from "../src/env";
import { RunLock } from "../src/lock";
import type { GhJob } from "../src/github";

// ── D1 on node:sqlite ─────────────────────────────────────────────────────

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  private params() {
    return this.args.map((a) => (a === undefined ? null : typeof a === "boolean" ? (a ? 1 : 0) : a)) as (string | number | null)[];
  }
  async first<T>(): Promise<T | null> {
    const r = this.db.prepare(this.sql).get(...this.params());
    return (r ? { ...r } : null) as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params()).map((r) => ({ ...r })) as T[] };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params());
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

/** D1's batch: every statement in one transaction, all or nothing. */
async function batch(db: DatabaseSync, stmts: Stmt[]) {
  db.exec("BEGIN");
  try {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return { prepare: (sql: string) => new Stmt(db, sql), batch: (stmts: Stmt[]) => batch(db, stmts) } as unknown as D1Database;
}

// ── KV ────────────────────────────────────────────────────────────────────

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    async get(k: string, type?: string) {
      const v = m.get(k);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k: string, v: string) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
  } as unknown as KVNamespace;
}

// ── Durable Object ────────────────────────────────────────────────────────

/** One RunLock instance with its own in-memory storage, handling one request at a time. */
function fakeInstance(env: Env): { fetch: (url: string, init?: RequestInit) => Promise<Response> } {
  const data = new Map<string, unknown>();
  const storage = {
    async get(k: string) {
      return structuredClone(data.get(k));
    },
    async put(k: string, v: unknown) {
      data.set(k, structuredClone(v));
    },
    async delete(k: string) {
      return data.delete(k);
    },
    async list({ prefix }: { prefix: string }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)));
    },
  };
  const obj = new RunLock({ storage } as unknown as DurableObjectState, env);
  // A real Durable Object's read-then-write is not interleaved with another
  // request (its "input gate"); handle one request at a time to match.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (url: string, init?: RequestInit) => {
    const next = queue.then(() => obj.fetch(new Request(url, init)));
    queue = next.catch(() => undefined);
    return next;
  };
  return { fetch: serial };
}

/** The RunLock namespace: one instance per name, as Cloudflare keeps them ("singleton" for the gateway, "lab:<id>" per lab). */
function fakeDO(env: Env): DurableObjectNamespace {
  const instances = new Map<string, ReturnType<typeof fakeInstance>>();
  return {
    idFromName: (name: string) => name,
    get: (id: string) => {
      if (!instances.has(id)) instances.set(id, fakeInstance(env));
      return instances.get(id)!;
    },
  } as unknown as DurableObjectNamespace;
}

// ── The outside world ─────────────────────────────────────────────────────

/**
 * Azure as the lab code sees it (labs spec §7.5, §8.2, §9.4): what the orphan
 * sweep lists, what the ready check and the modal's resources read, the
 * permission check's role assignments and the per-lab cost rows. Starts empty.
 */
export interface LabAzure {
  /** Resource groups in the subscription (any name: rg-lab-*, NetworkWatcherRG, rg-wg-ondemand). */
  groups: { name: string; location?: string; createdTime?: string; tags?: Record<string, string> }[];
  managementGroups: { name: string; displayName?: string }[];
  /** Live 2026-10-05: a tenant that never used management groups refuses the list (403 AuthorizationFailed). */
  managementGroupsForbidden?: boolean;
  /**
   * Custom role definitions (the list is filtered to CustomRole by the caller's $filter).
   * `rgOnly`: assignable only inside a resource group, so the subscription's list leaves it
   * out, as ARM does; GET .../roleDefinitions/<id> still finds it (404 when there is none).
   */
  roleDefinitions: { id: string; roleName: string; type?: "CustomRole" | "BuiltInRole"; rgOnly?: boolean }[];
  policyDefinitions: { name: string; displayName?: string; policyType?: string }[];
  policyAssignments: { name: string; displayName?: string; scope: string }[];
  /** Resources, by group: GET .../resourceGroups/<rg>/resources lists those whose resourceGroup is <rg>. */
  resources: { name: string; type: string; resourceGroup: string; provisioningState?: string }[];
  /** Role assignments (the permission check filters by principalId). */
  roleAssignments: { principalId: string; roleDefinitionId: string; scope: string }[];
  /** Cost Management rows for the query grouped by ResourceGroupName: one per day and group, in £. */
  costRows: { day: string; rg: string; gbp: number }[];
}

/** Microsoft Graph as the lab code sees it: Entra users and groups. `fail` answers every Graph call with that status. */
export interface FakeGraph {
  users: { id: string; displayName: string; userPrincipalName: string }[];
  groups: { id: string; displayName: string; mailNickname?: string }[];
  fail?: number;
}

export interface World {
  /** Every workflow dispatch: the workflow file ("wg.yml", "lab.yml"), action and parsed payload. */
  dispatches: { workflow: string; action: string; payload: Record<string, unknown> }[];
  /** GitHub runs by numeric id, with the title the Worker searches for. `workflow` is the file (absent = the gateway's). */
  ghRuns: Map<number, { id: number; display_title: string; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at?: string; workflow?: string }>;
  /** Labs: Azure resource groups, management groups, definitions, assignments, resources and cost rows. */
  labAzure: LabAzure;
  /** Labs: Entra users and groups. */
  graph: FakeGraph;
  /** Every outbound call the Worker made, in order (for subrequest budgets: a lab watch makes at most 20). */
  calls: { method: string; host: string; path: string }[];
  /** Azure: does the resource group exist, and the VM's power state. */
  azure: { rg: boolean; power: string; ip: string };
  /** VM power calls made: "deallocate" | "start". */
  powerCalls: string[];
  /** Every notification published to ntfy. */
  notes: Record<string, any>[];
  /** GitHub jobs per GitHub run id, for the step list. */
  jobs: Map<number, GhJob[]>;
  /** GitHub job logs per job id, as plain text; a job with none answers 404. */
  logs: Map<number, string>;
  /** Test-only: when set, GitHub answers the jobs call with this status instead of the jobs. */
  ghFail?: number;
  /**
   * Test-only: Azure's actual cost, one row per day, service and location.
   * When set, Cost Management answers the plain daily query with each day's
   * total and the grouped query with these rows. Unset: both answer empty.
   */
  costRows?: { day: string; service: string; location: string; gbp: number }[];
  /** Test-only: when set, the grouped cost query (by service and location) answers with this status. */
  costGroupedFail?: number;
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; world: World } {
  const world: World = {
    dispatches: [],
    ghRuns: new Map(),
    labAzure: { groups: [], managementGroups: [], roleDefinitions: [], policyDefinitions: [], policyAssignments: [], resources: [], roleAssignments: [], costRows: [] },
    graph: { users: [], groups: [] },
    calls: [],
    azure: { rg: false, power: "running", ip: "20.0.0.10" },
    powerCalls: [],
    notes: [],
    jobs: new Map(),
    logs: new Map(),
  };
  let nextGh = 1000;
  const env = {
    PUBLIC_URL: "https://wg-admin.example",
    WG_DNS_NAME: "wg.clydeford.net",
    WG_PORT: "51820",
    WG_SUBNET: "10.13.13.0/24",
    WG_SUBNET6: "fd13:13::/64",
    WG_SERVER_PUBLIC_KEY: "wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc=",
    AZURE_REGION: "uksouth",
    AZURE_VM_SIZE: "Standard_B1s",
    AZURE_RESOURCE_GROUP: "rg-wg-ondemand",
    AUTO_DESTROY_DEFAULT_HOURS: "4",
    IDLE_DESTROY_MINUTES: "0",
    MONTHLY_BUDGET_GBP: "10",
    HOURLY_RATE_GBP: "0.0157",
    GITHUB_REPO: "sjohnston1972/wireguard",
    GITHUB_TOKEN: "gh-test",
    AZURE_TENANT_ID: "t",
    AZURE_CLIENT_ID: "c",
    AZURE_CLIENT_SECRET: "s",
    AZURE_SUBSCRIPTION_ID: "sub",
    NOTIFY_WEBHOOK_URL: "https://ntfy.sh/wg-admin-test",
    ...overrides,
  } as unknown as Env;
  env.DB = fakeD1();
  env.STATUS = fakeKV();
  env.RUN_LOCK = fakeDO(env);
  const objects = new Map<string, ArrayBuffer>();
  const uploaded = new Map<string, Date>();
  env.STATE = {
    async put(k: string, v: ArrayBuffer) { objects.set(k, v); uploaded.set(k, new Date()); },
    async get(k: string) { const v = objects.get(k); return v ? { body: v, arrayBuffer: async () => v, text: async () => (typeof v === "string" ? v : new TextDecoder().decode(v)) } : null; },
    async delete(k: string | string[]) { for (const x of ([] as string[]).concat(k)) { objects.delete(x); uploaded.delete(x); } },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, uploaded: uploaded.get(key)! })), truncated: false };
    },
  } as unknown as R2Bucket;
  (world as World & { objects: Map<string, ArrayBuffer> }).objects = objects;

  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url);
    world.calls.push({ method, host: u.hostname, path: u.pathname + u.search });

    // GitHub
    if (u.hostname === "api.github.com") {
      if (u.pathname.endsWith("/dispatches")) {
        const body = JSON.parse(String(init?.body));
        const payload = JSON.parse(body.inputs.payload);
        const workflow = decodeURIComponent(u.pathname.match(/\/actions\/workflows\/([^/]+)\/dispatches$/)?.[1] ?? "");
        world.dispatches.push({ workflow, action: body.inputs.action, payload });
        const id = nextGh++;
        // Each workflow's run-name: wg.yml "wg <action> <run id>", lab.yml "lab <action> <lab id> <run id>".
        const title = workflow === "lab.yml" ? `lab ${body.inputs.action} ${payload.lab_id} ${payload.run_id}` : `wg ${body.inputs.action} ${payload.run_id}`;
        world.ghRuns.set(id, { id, display_title: title, status: "in_progress", conclusion: null, html_url: `https://github.com/run/${id}`, created_at: new Date().toISOString(), workflow });
        return new Response(null, { status: 204 });
      }
      const listed = u.pathname.match(/\/actions\/workflows\/([^/]+)\/runs$/);
      if (listed) {
        // A workflow lists only its own runs; a run without `workflow` is the gateway's.
        const lab = decodeURIComponent(listed[1]) === "lab.yml";
        return json({ workflow_runs: [...world.ghRuns.values()].filter((r) => (r.workflow === "lab.yml") === lab).reverse() });
      }
      const run = u.pathname.match(/\/actions\/runs\/(\d+)$/);
      if (run) return world.ghRuns.has(Number(run[1])) ? json(world.ghRuns.get(Number(run[1]))) : json({}, 404);
      const jobs = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
      if (jobs && world.ghFail) return json({}, world.ghFail);
      if (jobs) return json({ jobs: world.jobs.get(Number(jobs[1])) ?? [] });
      const log = u.pathname.match(/\/actions\/jobs\/(\d+)\/logs$/);
      if (log) return world.logs.has(Number(log[1])) ? new Response(world.logs.get(Number(log[1])), { status: 200 }) : json({}, 404);
      return json({}, 404);
    }

    // Azure
    if (u.hostname === "login.microsoftonline.com") return json({ access_token: String(init?.body ?? "").includes("graph.microsoft.com") ? "graph" : "arm", expires_in: 3600 });

    // Microsoft Graph (labs): users and groups, with startswith(displayName,'x') honoured.
    if (u.hostname === "graph.microsoft.com") {
      if (world.graph.fail) return json({ error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } }, world.graph.fail);
      const kind = u.pathname.match(/^\/v1\.0\/(users|groups)$/)?.[1] as "users" | "groups" | undefined;
      if (kind && method === "GET") {
        // startswith(field,'x') clauses joined by "or" (displayName, userPrincipalName, mailNickname).
        const clauses = [...(u.searchParams.get("$filter") ?? "").matchAll(/startswith\((\w+),\s*'([^']*)'\)/gi)].map((m) => ({ field: m[1], prefix: m[2].toLowerCase() }));
        const top = Number(u.searchParams.get("$top") ?? 0);
        let value: { displayName: string }[] = world.graph[kind];
        if (clauses.length) value = value.filter((x) => clauses.some((c) => String((x as Record<string, unknown>)[c.field] ?? "").toLowerCase().startsWith(c.prefix)));
        if (top > 0) value = value.slice(0, top);
        return json({ value });
      }
      return json({ error: { code: "Request_ResourceNotFound" } }, 404);
    }

    if (u.hostname === "management.azure.com") {
      const lab = labArm(world.labAzure, method, u, init);
      if (lab) return lab;
      const vmOp = u.pathname.match(/virtualMachines\/vm-wg\/(deallocate|start)$/);
      if (vmOp && method === "POST") {
        world.powerCalls.push(vmOp[1]);
        return new Response(null, { status: 202 });
      }
      if (world.costRows && u.pathname.includes("CostManagement")) {
        const grouped = JSON.parse(String(init?.body ?? "{}"))?.dataset?.grouping?.length > 0;
        const d = (day: string) => Number(day.replace(/-/g, ""));
        if (!grouped) {
          const totals = new Map<string, number>();
          for (const r of world.costRows) totals.set(r.day, (totals.get(r.day) ?? 0) + r.gbp);
          return json({ properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }, { name: "Currency" }], rows: [...totals].map(([day, gbp]) => [gbp, d(day), "GBP"]) } });
        }
        if (world.costGroupedFail) return json({}, world.costGroupedFail);
        return json({ properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }, { name: "ServiceName" }, { name: "ResourceLocation" }, { name: "Currency" }], rows: world.costRows.map((r) => [r.gbp, d(r.day), r.service, r.location, "GBP"]) } });
      }
      if (!world.azure.rg) return json({}, 404);
      if (/resourceGroups\/[^/]+$/.test(u.pathname)) return json({ location: "uksouth", tags: {} });
      if (u.pathname.endsWith("/instanceView")) return json({ statuses: [{ code: `PowerState/${world.azure.power}` }] });
      if (u.pathname.endsWith("/publicIPAddresses/pip-wg")) return json({ name: "pip-wg", properties: { ipAddress: world.azure.ip } });
      if (u.pathname.includes("CostManagement")) return json({ properties: { columns: [], rows: [] } });
      return json({}, 404);
    }

    // DNS over HTTPS and the Cloudflare API
    if (u.hostname === "cloudflare-dns.com") return json({ Answer: world.azure.rg ? [{ type: 1, data: world.azure.ip }] : [{ type: 1, data: "192.0.2.1" }] });
    if (u.hostname === "api.cloudflare.com") return json({ result: [] });

    // ntfy
    if (u.hostname === "ntfy.sh") {
      world.notes.push(JSON.parse(String(init?.body)));
      return json({});
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });

  return { env, world };
}

/**
 * ARM answers for the lab code, from world.labAzure; null when the call is
 * not one of them (the gateway's ARM answers then apply). Paths are matched
 * case-insensitively, as ARM does.
 */
function labArm(az: LabAzure, method: string, u: URL, init?: RequestInit): Response | null {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const p = u.pathname.toLowerCase();
  const sub = (rest: string) => new RegExp(`^/subscriptions/[^/]+${rest}$`);
  if (method === "GET" && sub("/resourcegroups").test(p)) {
    return json({ value: az.groups.map((g) => ({ id: `/subscriptions/sub/resourceGroups/${g.name}`, name: g.name, location: g.location ?? "uksouth", tags: g.tags ?? {}, createdTime: g.createdTime ?? null, properties: { provisioningState: "Succeeded" } })) });
  }
  const inGroup = p.match(sub("/resourcegroups/([^/]+)/resources"));
  if (method === "GET" && inGroup) {
    const rg = decodeURIComponent(inGroup[1]);
    return json({ value: az.resources.filter((r) => r.resourceGroup.toLowerCase() === rg).map((r) => ({ id: `/subscriptions/sub/resourceGroups/${r.resourceGroup}/providers/${r.type}/${r.name}`, name: r.name, type: r.type, properties: { provisioningState: r.provisioningState ?? "Succeeded" } })) });
  }
  if (method === "GET" && p === "/providers/microsoft.management/managementgroups") {
    if (az.managementGroupsForbidden) return new Response(JSON.stringify({ error: { code: "AuthorizationFailed", message: "The client does not have authorization to perform action 'Microsoft.Management/managementGroups/read'" } }), { status: 403, headers: { "Content-Type": "application/json" } });
    return json({ value: az.managementGroups.map((m) => ({ id: `/providers/Microsoft.Management/managementGroups/${m.name}`, name: m.name, properties: { displayName: m.displayName ?? m.name } })) });
  }
  if (method === "GET" && sub("/providers/microsoft.authorization/roledefinitions").test(p)) {
    const custom = /CustomRole/i.test(u.searchParams.get("$filter") ?? "");
    return json({ value: az.roleDefinitions.filter((r) => !r.rgOnly && (!custom || (r.type ?? "CustomRole") === "CustomRole")).map((r) => ({ id: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${r.id}`, name: r.id, properties: { roleName: r.roleName, type: r.type ?? "CustomRole" } })) });
  }
  const oneRole = p.match(sub("/providers/microsoft.authorization/roledefinitions/([^/]+)"));
  if (method === "GET" && oneRole) {
    const r = az.roleDefinitions.find((x) => x.id.toLowerCase() === decodeURIComponent(oneRole[1]));
    if (!r) return json({ error: { code: "RoleDefinitionDoesNotExist", message: "The specified role definition does not exist." } }, 404);
    return json({ id: `/subscriptions/sub/providers/Microsoft.Authorization/roleDefinitions/${r.id}`, name: r.id, properties: { roleName: r.roleName, type: r.type ?? "CustomRole" } });
  }
  if (method === "GET" && sub("/providers/microsoft.authorization/policydefinitions").test(p)) {
    return json({ value: az.policyDefinitions.map((d) => ({ id: `/subscriptions/sub/providers/Microsoft.Authorization/policyDefinitions/${d.name}`, name: d.name, properties: { displayName: d.displayName ?? d.name, policyType: d.policyType ?? "Custom" } })) });
  }
  if (method === "GET" && sub("/providers/microsoft.authorization/policyassignments").test(p)) {
    return json({ value: az.policyAssignments.map((a) => ({ id: `${a.scope}/providers/Microsoft.Authorization/policyAssignments/${a.name}`, name: a.name, properties: { displayName: a.displayName ?? a.name, scope: a.scope } })) });
  }
  if (method === "GET" && sub("/providers/microsoft.authorization/roleassignments").test(p)) {
    const who = (u.searchParams.get("$filter") ?? "").match(/principalId\s+eq\s+'([^']+)'/i)?.[1];
    return json({ value: az.roleAssignments.filter((a) => !who || a.principalId === who).map((a, i) => ({ id: `${a.scope}/providers/Microsoft.Authorization/roleAssignments/ra-${i}`, name: `ra-${i}`, properties: a })) });
  }
  if (method === "POST" && p.includes("/providers/microsoft.costmanagement/query")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { dataset?: { grouping?: { name: string }[] } };
    if (!body.dataset?.grouping?.some((g) => g.name === "ResourceGroupName")) return null;
    const d = (day: string) => Number(day.replace(/-/g, ""));
    return json({ properties: { columns: [{ name: "Cost" }, { name: "UsageDate" }, { name: "ResourceGroupName" }, { name: "Currency" }], rows: az.costRows.map((r) => [r.gbp, d(r.day), r.rg, "GBP"]) } });
  }
  return null;
}

/** The GitHub run id for the Worker's latest dispatch. */
export function lastGhRun(world: World): number {
  return Math.max(...world.ghRuns.keys());
}
