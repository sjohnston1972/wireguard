// demo-store.test.ts
//
// Plain English: demo mode's store (worker/src/demo/store.ts), a Durable
// Object with its own SQLite. It seeds the everything story into itself and
// serves demo reads by running the app's own /api/v1 code against its demo
// environment. Proved here:
//   - it never touches a real binding or secret (a "tripwire" env whose real
//     bindings throw on any touch), and makes no outside call;
//   - refreshes keep to a budget (10 minutes apart; a daily row allowance)
//     and the store gets itself ready when it is empty, stale or out of date;
//   - a refresh happens inside blockConcurrencyWhile, so no read sees a
//     half-built store;
//   - the outbound guard refuses any fetch inside demoScope and survives cron's meter.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, fakeDemoState, tripwire, tripped, demoInstance } from "./harness";
import { DemoStore, DEMO_DAILY_ROWS, DEMO_MIN_INTERVAL_MS, DEMO_STALE_MS, DEMO_ACTOR, DEMO_DRAIN_MS, DEMO_READING_MESSAGE, type DemoResult } from "../src/demo/store";
import { demoScope, installDemoFetchGuard, DemoOutboundError, demoFetchGuarded, demoOutboundLog } from "../src/demo/guard";
import { DEMO_SCHEMA_HASH } from "../src/demo/schema.gen";
import { DEMO_VARS } from "../src/demo/env";
import { runCron } from "../src/cron";
import type { Env } from "../src/env";

const NOW = "2026-10-08T10:00:00.000Z";
const at = (iso: string, plusMs: number) => new Date(Date.parse(iso) + plusMs).toISOString();
const base = "https://wg-admin.example";

type Json = any;

/** Every GET route of buildApi() as a concrete path (31), with seeded ids filled in from the demo itself. */
async function everyGet(get: (path: string) => Promise<{ status: number; json: Json; text: string }>): Promise<string[]> {
  const clients = (await get("/clients")).json;
  const overview = (await get("/overview")).json;
  const labs = (await get("/labs")).json;
  const settings = (await get("/settings")).json;
  const peer = clients.clients[0].id;
  const run = encodeURIComponent(overview.snapshot.run_id);
  const lab = labs.running[0]?.labId ?? labs.running[0]?.lab_id ?? labs.labs[0].id;
  const day = settings.backups.config.days[0];
  return [
    "/session",
    "/overview",
    "/ssh-password",
    "/history?scope=vm&range=24h",
    "/clients",
    `/clients/${peer}`,
    "/firewall",
    "/activity?range=7d",
    `/runs/${run}`,
    `/runs/${run}/log`,
    "/cost?range=month",
    "/settings",
    "/backup/export",
    `/backup/config/${day}`,
    "/push/status",
    "/prefs",
    `/prefs/topology/${lab}`,
    "/azure/summary",
    "/azure/metrics?resource=vm&range=24h",
    "/azure/changes?range=7d",
    "/azure/service-health?range=30d",
    "/azure/capacity",
    "/azure/price",
    "/azure/diagnostics",
    "/azure/bootlog",
    "/labs",
    "/labs/sessions",
    "/labs/coverage",
    `/labs/${lab}`,
    `/labs/${lab}/topology`,
    `/labs/${lab}/secret`,
  ];
}

function storeWith(env: Env) {
  const state = fakeDemoState();
  return { store: new DemoStore(state.ctx, env), state };
}

async function serveGet(store: DemoStore, path: string, user = "dev@localhost") {
  const r = await store.serve(new Request(`${base}/api/v1${path}`), user);
  const text = await r.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text, headers: r.headers };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the tripwire (spec §9.1): a DemoStore whose real bindings throw on any touch", () => {
  it("refreshes, reports and serves every GET without touching a real binding, a secret or the network", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const outbound: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      outbound.push(String(input instanceof Request ? input.url : input));
      throw new Error("no outside calls in this test");
    });
    tripped.length = 0;
    demoOutboundLog.length = 0;
    const vars = Object.fromEntries(DEMO_VARS.map((k) => [k, k === "PUBLIC_URL" ? base : k === "WG_PORT" ? "51820" : `v-${k.toLowerCase()}`]));
    const secrets = ["AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID", "CLOUDFLARE_DNS_TOKEN", "CLOUDFLARE_ZONE_ID", "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "CF_ACCESS_ALLOWED_EMAIL", "GITHUB_REPO", "GITHUB_TOKEN", "NOTIFY_WEBHOOK_URL", "NOTIFY_TOKEN", "VAPID_PRIVATE_KEY"];
    const env = {
      ...vars,
      ...Object.fromEntries(secrets.map((k) => [k, `TRIPWIRE-${k}`])),
      AUTH_DEV_BYPASS: "1",
      DB: tripwire("DB"),
      STATUS: tripwire("STATUS"),
      STATE: tripwire("STATE"),
      RUN_LOCK: tripwire("RUN_LOCK"),
      ASSETS: tripwire("ASSETS"),
      DEMO_STORE: tripwire("DEMO_STORE"),
    } as unknown as Env;
    const { store } = storeWith(env);

    const r = await store.refresh(NOW);
    expect(r.ok).toBe(true);
    expect((await store.status(NOW)).refreshedAt).toBe(NOW);

    const paths = await everyGet((p) => serveGet(store, p));
    expect(paths).toHaveLength(31);
    const answers: string[] = [];
    for (const p of paths) {
      const a = await serveGet(store, p);
      answers.push(`${p} ${a.status} ${a.text}`);
      expect(a.status, `${p}: ${a.text.slice(0, 200)}`).toBeLessThan(500);
    }
    const sim = await store.serve(new Request(`${base}/api/v1/firewall/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: { kind: "any", value: null }, to: { kind: "any", value: null }, proto: "tcp", port: 443 }) }), "dev@localhost");
    expect(sim.status).toBe(200);
    const health = await store.serve(new Request(`${base}/health`), "dev@localhost");
    expect(health.status).toBe(200);
    expect(((await health.json()) as Json).state).toBe("running");

    expect(tripped).toEqual([]);
    expect(answers.join("\n")).not.toContain("TRIPWIRE");
    expect(outbound).toEqual([]);
    // Not even an attempt the guard had to refuse.
    expect(demoOutboundLog).toEqual([]);
  }, 120_000);
});

describe("real names never shown (recordings)", () => {
  it("no demo answer names the real host, DNS name, home LAN or SSH range", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv({ PUBLIC_URL: "https://wg-admin.real-host.test", WG_DNS_NAME: "wg.real-host.test", HOME_LAN_CIDR: "10.77.3.0/24", SSH_ALLOWED_CIDR: "81.2.69.160/32" });
    const { store } = storeWith(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    const paths = await everyGet((p) => serveGet(store, p));
    const answers: string[] = [];
    for (const p of paths) answers.push(`${p} ${(await serveGet(store, p)).text}`);
    answers.push(await (await store.serve(new Request(`${base}/health`), "dev@localhost")).text());
    const all = answers.join("\n");
    expect(all).not.toContain("real-host");
    expect(all).not.toContain("10.77.3.");
    expect(all).not.toContain("81.2.69.160");
    expect(all).not.toContain("clydeford");
    expect(all).toContain("vpn.example.com");
  }, 120_000);
});

describe("serve", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  it("answers GET /api/v1/overview with the running story, marked demo and never cached", async () => {
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    expect((await store.refresh(NOW)).ok).toBe(true);
    const a = await serveGet(store, "/overview");
    expect(a.status).toBe(200);
    expect(a.json.snapshot.state).toBe("running");
    expect(a.headers.get("X-WG-Data")).toBe("demo");
    expect(a.headers.get("Cache-Control")).toBe("no-store");
  }, 60_000);

  it("with an empty store, seeds first", async () => {
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    expect((await store.status(NOW)).refreshedAt).toBeNull();
    const a = await serveGet(store, "/clients");
    expect(a.status).toBe(200);
    expect(a.json.clients.length).toBeGreaterThanOrEqual(6);
    expect((await store.status(NOW)).refreshedAt).toBe(NOW);
  }, 60_000);

  it("runs the app as the caller, writes as demo@example.com, and answers HEAD and the simulator", async () => {
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    await store.refresh(NOW);
    expect((await serveGet(store, "/session", "someone@example.com")).json.user).toBe("someone@example.com");
    const activity = (await serveGet(store, "/activity?range=30d")).json;
    expect(JSON.stringify(activity)).toContain(DEMO_ACTOR);
    expect(JSON.stringify(activity)).not.toContain("dev@localhost");
    const head = await store.serve(new Request(`${base}/api/v1/clients`, { method: "HEAD" }), "dev@localhost");
    expect(head.status).toBe(200);
    const sim = await store.serve(new Request(`${base}/api/v1/firewall/simulate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: { kind: "any", value: null }, to: { kind: "any", value: null }, proto: "udp", port: 53 }) }), "dev@localhost");
    expect(sim.status).toBe(200);
  }, 60_000);

  it("never reads or writes the real stores", async () => {
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    await store.refresh(NOW);
    await serveGet(store, "/overview");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM peers").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first<{ n: number }>())!.n).toBe(0);
    expect((await env.STATE.list()).objects).toEqual([]);
  }, 60_000);

  it("a stale DEMO_SCHEMA_HASH re-seeds on read, or answers 503 demo_outdated when over budget", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    await store.refresh(NOW);
    state.sql.exec("UPDATE _demo_meta SET v = 'old-schema' WHERE k = 'schemaHash'");
    expect((await store.status(NOW)).schemaOk).toBe(false);
    const later = at(NOW, DEMO_MIN_INTERVAL_MS + 1000);
    vi.setSystemTime(new Date(later));
    const a = await serveGet(store, "/overview");
    expect(a.status).toBe(200);
    const st = await store.status(later);
    expect(st.schemaOk).toBe(true);
    expect(st.refreshedAt).toBe(later);
    // Out of date again, within 10 minutes of the last refresh: no re-seed allowed.
    state.sql.exec("UPDATE _demo_meta SET v = 'old-schema' WHERE k = 'schemaHash'");
    const b = await serveGet(store, "/overview");
    expect(b.status).toBe(503);
    expect(b.json.error.code).toBe("demo_outdated");
    expect(b.json.error.message).toBe("Demo data needs a refresh after an update. Press Refresh demo data in Settings.");
    expect(b.headers.get("X-WG-Data")).toBe("demo");
  }, 120_000);
});

describe("budget and readiness (spec §9.8)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  it("status never seeds", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    const st = await store.status(NOW);
    expect(st).toMatchObject({ refreshedAt: null, story: "everything", rowsToday: 0, lastRows: 0, dailyRows: DEMO_DAILY_ROWS, nextRefreshAt: null, schemaOk: false });
    expect(state.sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'peers'").toArray()[0].n).toBe(0);
  });

  it("a refresh records its rows; a second within 10 minutes is refused naming the time", async () => {
    const { env } = makeEnv();
    const { store } = demoInstance(env);
    const first = await store.refresh(NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.counts.peers).toBe(12);
    expect(first.status.lastRows).toBeGreaterThan(1000);
    expect(first.status.rowsToday).toBe(first.status.lastRows);
    expect(first.status.nextRefreshAt).toBe(at(NOW, DEMO_MIN_INTERVAL_MS));
    const again = (await store.refresh(at(NOW, 60_000))) as Extract<DemoResult, { ok: false }>;
    expect(again.ok).toBe(false);
    expect(again.code).toBe("demo_busy");
    expect(again.nextAt).toBe(at(NOW, DEMO_MIN_INTERVAL_MS));
    // 10:10 UTC is 11:10 in London (BST).
    expect(again.message).toBe("Demo data was refreshed less than 10 minutes ago. Try again at 11:10.");
  }, 60_000);

  it("rowsToday survives the wipe and adds up; the daily budget uses rowsToday + 2 × lastRows", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    const a = await store.refresh(NOW);
    const t2 = at(NOW, DEMO_MIN_INTERVAL_MS);
    const b = await store.refresh(t2);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.status.rowsToday).toBe(a.status.lastRows + b.status.lastRows);
    // Pretend today has used nearly all of it: rowsToday + 2 × lastRows over the allowance.
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'rowsToday'", String(DEMO_DAILY_ROWS - b.status.lastRows));
    const t3 = at(NOW, 2 * DEMO_MIN_INTERVAL_MS);
    const st = await store.status(t3);
    expect(st.nextRefreshAt).toBe("2026-10-09T00:00:00.000Z");
    const c = (await store.refresh(t3)) as Extract<DemoResult, { ok: false }>;
    expect(c.ok).toBe(false);
    expect(c.code).toBe("demo_busy");
    expect(c.nextAt).toBe("2026-10-09T00:00:00.000Z");
    expect(c.message).toBe("Demo data has used today's refresh allowance. Try again at 01:00 tomorrow.");
  }, 120_000);

  it("a new UTC day resets rowsToday, and always allows one refresh", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    await store.refresh(NOW);
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'rowsToday'", String(DEMO_DAILY_ROWS));
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'lastRows'", String(DEMO_DAILY_ROWS));
    const tomorrow = "2026-10-09T00:00:05.000Z";
    vi.setSystemTime(new Date(tomorrow));
    expect((await store.status(tomorrow)).rowsToday).toBe(0);
    expect((await store.status(tomorrow)).nextRefreshAt).toBeNull();
    const r = await store.refresh(tomorrow);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status.rowsToday).toBe(r.status.lastRows);
  }, 120_000);

  it("ensureReady: seeds an empty store; leaves a fresh one; re-seeds a 13-hour-old one; keeps old data when over budget", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    const r1 = await store.ensureReady(NOW);
    expect(r1.ok && r1.status.refreshedAt).toBe(NOW);
    const r2 = await store.ensureReady(at(NOW, 3_600_000));
    expect(r2.ok && r2.status.refreshedAt).toBe(NOW);
    const old = at(NOW, DEMO_STALE_MS + 3_600_000);
    vi.setSystemTime(new Date(old));
    const r3 = await store.ensureReady(old);
    expect(r3.ok && r3.status.refreshedAt).toBe(old);
    // 13 hours on again, but today's allowance is spent: the data is old but there, so it is ready as it is.
    const older = at(old, DEMO_STALE_MS + 3_600_000);
    vi.setSystemTime(new Date(older));
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'day'", older.slice(0, 10));
    state.sql.exec("UPDATE _demo_meta SET v = ?1 WHERE k = 'rowsToday'", String(DEMO_DAILY_ROWS));
    const r4 = await store.ensureReady(older);
    expect(r4.ok && r4.status.refreshedAt).toBe(old);
  }, 120_000);

  it("ensureReady on an empty store over budget is refused (the switch must stay off)", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    await store.status(NOW);
    state.sql.exec("INSERT OR REPLACE INTO _demo_meta (k, v) VALUES ('day', ?1), ('rowsToday', ?2), ('lastRows', ?3), ('attemptAt', ?4)", NOW.slice(0, 10), String(DEMO_DAILY_ROWS), "5000", at(NOW, -3_600_000));
    const r = (await store.ensureReady(NOW)) as Extract<DemoResult, { ok: false }>;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("demo_busy");
    expect(r.status.refreshedAt).toBeNull();
  });

  it("a stale schema hash makes status say so", async () => {
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    await store.refresh(NOW);
    expect((await store.status(NOW)).schemaOk).toBe(true);
    expect(String(state.sql.exec("SELECT v FROM _demo_meta WHERE k = 'schemaHash'").toArray()[0].v)).toBe(DEMO_SCHEMA_HASH);
  }, 60_000);
});

describe("refresh and blockConcurrencyWhile", () => {
  it("every write of a refresh happens inside blockConcurrencyWhile, and a read waits for it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { state } = demoInstance(env);
    const stub = env.DEMO_STORE.get(env.DEMO_STORE.idFromName("demo")) as unknown as DemoStore;
    const refreshing = stub.refresh(NOW);
    // Started while the refresh holds the store: answered only after it, from the finished data.
    const reading = stub.serve(new Request(`${base}/api/v1/clients`), "dev@localhost");
    expect((await refreshing).ok).toBe(true);
    const r = await reading;
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).clients.length).toBeGreaterThanOrEqual(6);
    expect(state.writes.length).toBeGreaterThan(100);
    expect(state.writes.filter((w) => !w.inside).filter((w) => !/^CREATE TABLE IF NOT EXISTS _demo_/.test(w.query))).toEqual([]);
  }, 60_000);

  it("a read already in flight when a refresh starts finishes before the wipe (never a half-wiped store)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    const stub = env.DEMO_STORE.get(env.DEMO_STORE.idFromName("demo")) as unknown as DemoStore;
    expect((await stub.refresh(NOW)).ok).toBe(true);
    const order: string[] = [];
    const wipe = state.ctx.storage.deleteAll.bind(state.ctx.storage);
    vi.spyOn(state.ctx.storage, "deleteAll").mockImplementation(async () => {
      order.push("wipe");
      return wipe();
    });
    // The demo app answers only when released, then reads the store (a read that awaits real I/O part-way).
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    vi.spyOn(store as unknown as { demoApp: () => unknown }, "demoApp").mockReturnValue({
      fetch: async () => {
        await paused;
        const n = state.sql.exec("SELECT COUNT(*) AS n FROM peers").toArray()[0]!.n;
        order.push("read done");
        return Response.json({ n });
      },
    });
    const reading = stub.serve(new Request(`${base}/api/v1/clients`), "dev@localhost");
    await new Promise((r) => setTimeout(r, 20));
    const refreshing = stub.refresh(at(NOW, DEMO_MIN_INTERVAL_MS));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const r = await reading;
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).n).toBeGreaterThan(0);
    expect((await refreshing).ok).toBe(true);
    expect(order).toEqual(["read done", "wipe"]);
  }, 60_000);

  it("a read that never finishes: the refresh gives up after DEMO_DRAIN_MS with demo_busy and wipes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(NOW));
    const { env } = makeEnv();
    const { store, state } = demoInstance(env);
    const stub = env.DEMO_STORE.get(env.DEMO_STORE.idFromName("demo")) as unknown as DemoStore;
    expect((await stub.refresh(NOW)).ok).toBe(true);
    const wipe = vi.spyOn(state.ctx.storage, "deleteAll");
    vi.spyOn(store as unknown as { demoApp: () => unknown }, "demoApp").mockReturnValue({ fetch: () => new Promise<Response>(() => {}) });
    void stub.serve(new Request(`${base}/api/v1/clients`), "dev@localhost");
    await vi.advanceTimersByTimeAsync(0);
    const refreshing = stub.refresh(at(NOW, DEMO_MIN_INTERVAL_MS));
    await vi.advanceTimersByTimeAsync(DEMO_DRAIN_MS);
    const r = await refreshing;
    expect(r).toMatchObject({ ok: false, code: "demo_busy", message: DEMO_READING_MESSAGE });
    expect(wipe).not.toHaveBeenCalled();
    expect((await stub.status(NOW)).refreshedAt).toBe(NOW);
  }, 60_000);
});

describe("the outbound guard", () => {
  it("fetch inside demoScope throws DemoOutboundError; outside it passes through", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("ok");
    });
    installDemoFetchGuard();
    await expect(demoScope.run(true, () => fetch("https://management.azure.com/x"))).rejects.toBeInstanceOf(DemoOutboundError);
    await expect(demoScope.run(true, async () => (await fetch("https://api.github.com/y")).text())).rejects.toThrow(/never calls outside services/);
    expect(seen).toEqual([]);
    expect(await (await fetch("https://example.com/ok")).text()).toBe("ok");
    expect(seen).toEqual(["https://example.com/ok"]);
  });

  it("installDemoFetchGuard is idempotent", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("ok");
    });
    installDemoFetchGuard();
    const once = globalThis.fetch;
    installDemoFetchGuard();
    installDemoFetchGuard();
    expect(globalThis.fetch).toBe(once);
    await fetch("https://example.com/a");
    expect(seen).toEqual(["https://example.com/a"]);
  });

  it("cron's counted() puts back the guard, not the raw fetch", async () => {
    vi.stubGlobal("fetch", async () => new Response("ok"));
    installDemoFetchGuard();
    const guarded = globalThis.fetch;
    expect(demoFetchGuarded()).toBe(true);
    const { env } = makeEnv();
    installDemoFetchGuard();
    const guard2 = globalThis.fetch;
    await runCron(env, new Date(NOW), {
      watchman: async () => {
        await fetch("https://example.com/watchman");
        return [];
      },
      labs: async () => [],
      insights: async () => [],
    });
    expect(globalThis.fetch).toBe(guard2);
    expect(demoFetchGuarded()).toBe(true);
    await expect(demoScope.run(true, () => fetch("https://example.com/x"))).rejects.toBeInstanceOf(DemoOutboundError);
    expect(guarded).toBeTypeOf("function");
  });
});
