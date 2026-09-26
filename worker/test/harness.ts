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

function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
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

function fakeDO(env: Env): DurableObjectNamespace {
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
  return {
    idFromName: () => "singleton",
    get: () => ({ fetch: serial }),
  } as unknown as DurableObjectNamespace;
}

// ── The outside world ─────────────────────────────────────────────────────

export interface World {
  /** Every workflow dispatch: action and parsed payload. */
  dispatches: { action: string; payload: Record<string, unknown> }[];
  /** GitHub runs by numeric id, with the title the Worker searches for. */
  ghRuns: Map<number, { id: number; display_title: string; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at?: string }>;
  /** Azure: does the resource group exist, and the VM's power state. */
  azure: { rg: boolean; power: string; ip: string };
  /** VM power calls made: "deallocate" | "start". */
  powerCalls: string[];
  /** Every notification published to ntfy. */
  notes: Record<string, any>[];
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; world: World } {
  const world: World = { dispatches: [], ghRuns: new Map(), azure: { rg: false, power: "running", ip: "20.0.0.10" }, powerCalls: [], notes: [] };
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
  env.STATE = {
    async put(k: string, v: ArrayBuffer) { objects.set(k, v); },
    async get(k: string) { const v = objects.get(k); return v ? { body: v, arrayBuffer: async () => v } : null; },
    async delete(k: string) { objects.delete(k); },
  } as unknown as R2Bucket;
  (world as World & { objects: Map<string, ArrayBuffer> }).objects = objects;

  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const u = new URL(url);

    // GitHub
    if (u.hostname === "api.github.com") {
      if (u.pathname.endsWith("/dispatches")) {
        const body = JSON.parse(String(init?.body));
        const payload = JSON.parse(body.inputs.payload);
        world.dispatches.push({ action: body.inputs.action, payload });
        const id = nextGh++;
        world.ghRuns.set(id, { id, display_title: `wg ${body.inputs.action} ${payload.run_id}`, status: "in_progress", conclusion: null, html_url: `https://github.com/run/${id}`, created_at: new Date().toISOString() });
        return new Response(null, { status: 204 });
      }
      if (/\/actions\/workflows\/.+\/runs$/.test(u.pathname)) return json({ workflow_runs: [...world.ghRuns.values()].reverse() });
      const run = u.pathname.match(/\/actions\/runs\/(\d+)$/);
      if (run) return world.ghRuns.has(Number(run[1])) ? json(world.ghRuns.get(Number(run[1]))) : json({}, 404);
      if (/\/actions\/runs\/\d+\/jobs$/.test(u.pathname)) return json({ jobs: [] });
      return json({}, 404);
    }

    // Azure
    if (u.hostname === "login.microsoftonline.com") return json({ access_token: "arm", expires_in: 3600 });
    if (u.hostname === "management.azure.com") {
      const vmOp = u.pathname.match(/virtualMachines\/vm-wg\/(deallocate|start)$/);
      if (vmOp && method === "POST") {
        world.powerCalls.push(vmOp[1]);
        return new Response(null, { status: 202 });
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

/** The GitHub run id for the Worker's latest dispatch. */
export function lastGhRun(world: World): number {
  return Math.max(...world.ghRuns.keys());
}
