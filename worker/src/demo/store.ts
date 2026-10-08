// demo/store.ts
//
// Plain English: demo mode's store, a Durable Object with its own SQLite
// database (binding DEMO_STORE, one instance "demo", shared by everyone in
// demo mode: it is all made up). Demo mode spec §6.
//
//   refresh    wipe the store, build the app's tables (schema.gen.ts), and
//              run the dev seeder's everything story into it, as
//              demo@example.com. Inside blockConcurrencyWhile (no new read
//              starts meanwhile), and only once every read already in
//              flight has finished, so no read ever sees a half-built
//              store; within a budget (10 minutes apart, and a daily
//              allowance of rows written).
//   ensureReady  refresh when the store is empty, built from an older
//              schema or an older version of the story, or more than 12
//              hours old, budget permitting.
//   status     what the store holds and when it may be refreshed (no seeding).
//   serve      answer one demo read: the app's own /api/v1 code (and /health)
//              run against the demo environment (env.ts), never the real one,
//              on the demo's own clock (clock.ts): the app sees the time the
//              demo was seeded and the answer's times are moved to now, so
//              the demo looks live however long ago it was seeded.
//
// Everything here runs inside demoScope with the outbound guard installed
// (guard.ts): a fetch from demo code fails instead of leaving the Worker.
// Nothing in the background (cron, watchman, lab watch, insights) reaches
// this object, and it has no alarm.
//
// The RPC methods answer refusals as values ({ ok: false, code: "demo_busy" }),
// never as thrown errors: an error's class does not survive the trip back to
// the Worker, a value does.

import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import type { Env } from "../env";
import { config } from "../env";
import type { AuthedVars } from "../auth";
import { buildApi } from "../api";
import { getSnapshot } from "../state";
import { seedScenario } from "../devseed";
import { DEMO_DATA_HEADER, DEMO_STORY } from "../../../shared/demo";
import { DEMO_SCHEMA, DEMO_SCHEMA_HASH } from "./schema.gen";
import { ensureFacadeTables, splitSql, WriteMeter, type SqlLike } from "./sql";
import { makeDemoEnv } from "./env";
import { demoScope, installDemoFetchGuard } from "./guard";
import { demoClock, demoClockFor, installDemoClock, shiftTimes } from "./clock";

installDemoFetchGuard();
installDemoClock();

/** Rows a day the demo store may write by refreshing (spec ruling 8). */
export const DEMO_DAILY_ROWS = 30_000;
/** Refreshes at least this far apart (10 minutes). */
export const DEMO_MIN_INTERVAL_MS = 600_000;
/** Data older than this (12 hours) is re-seeded when someone switches demo mode on or reads it, budget permitting. */
export const DEMO_STALE_MS = 43_200_000;
/** How long a refresh waits for reads already in flight before giving up (they never take this long). */
export const DEMO_DRAIN_MS = 10_000;
/** The refusal when reads in flight never finished. */
export const DEMO_READING_MESSAGE = "Demo data is being read. Try again in a moment.";
/**
 * The version of the story the store was seeded with. Raise it when the seeder's everything story changes, so the
 * deployed store re-seeds itself on the next read (budget permitting; until then it keeps showing the older story).
 * 2: the busy story (2026-10-08): eleven clients, six connected, a 20-hour session, a month of history and costs.
 */
export const DEMO_STORY_VERSION = "2";
/** Who the demo's runs and change log name. */
export const DEMO_ACTOR = "demo@example.com";
/** The one instance's name: env.DEMO_STORE.idFromName(DEMO_INSTANCE). */
export const DEMO_INSTANCE = "demo";

/** What status() answers (spec §6.2). */
export interface DemoStoreStatus {
  refreshedAt: string | null;
  story: "everything";
  rowsToday: number;
  lastRows: number;
  dailyRows: number;
  /** null = a refresh is allowed now. */
  nextRefreshAt: string | null;
  /** Built from the deployed migrations (DEMO_SCHEMA_HASH). */
  schemaOk: boolean;
}

/** refresh/ensureReady's answer: done (with the seed's counts when it seeded), or refused with when to try again. */
export type DemoResult = { ok: true; status: DemoStoreStatus; counts: Record<string, number> } | { ok: false; code: "demo_busy"; message: string; nextAt: string; status: DemoStoreStatus };

/** A refresh the budget does not allow now (inside this object; RPC callers get the DemoResult). */
export class DemoBudget extends Error {
  constructor(
    readonly nextAt: string,
    message: string,
  ) {
    super(message);
    this.name = "DemoBudget";
  }
}

/** The answer when the store cannot be made current (spec ruling 10). */
export const DEMO_OUTDATED_MESSAGE = "Demo data needs a refresh after an update. Press Refresh demo data in Settings.";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const utcDay = (ms: number) => iso(ms).slice(0, 10);
const london = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });

/** Where serve() leaves the caller's email on its demo env, for the demo app's user middleware (module-private). */
const USER = Symbol("demo user");

type Meta = { refreshedAt: string | null; attemptAt: string | null; schemaHash: string | null; storyVersion: string | null; day: string | null; rowsToday: number; lastRows: number };

export class DemoStore extends DurableObject<Env> {
  private readonly sql: SqlLike;
  private app: Hono<{ Bindings: Env; Variables: AuthedVars }> | null = null;
  /** Reads running the demo app now, and who waits for them all to finish (a refresh). */
  private reading = 0;
  private drained: (() => void)[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Only the store's own storage is kept; this.env (the real one) is read for the plain [vars] alone (makeDemoEnv).
    this.sql = {
      exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...(bindings as SqlStorageValue[])),
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
    };
  }

  // ── Bookkeeping ─────────────────────────────────────────────────────────

  private meta(): Meta {
    ensureFacadeTables(this.sql);
    const rows = this.sql.exec("SELECT k, v FROM _demo_meta").toArray();
    const m = new Map(rows.map((r) => [String(r.k), String(r.v)]));
    return {
      refreshedAt: m.get("refreshedAt") ?? null,
      attemptAt: m.get("attemptAt") ?? null,
      schemaHash: m.get("schemaHash") ?? null,
      storyVersion: m.get("storyVersion") ?? null,
      day: m.get("day") ?? null,
      rowsToday: Number(m.get("rowsToday") ?? 0) || 0,
      lastRows: Number(m.get("lastRows") ?? 0) || 0,
    };
  }

  private writeMeta(patch: Partial<Record<keyof Meta | "story", string | number>>): void {
    ensureFacadeTables(this.sql);
    for (const [k, v] of Object.entries(patch)) this.sql.exec("INSERT OR REPLACE INTO _demo_meta (k, v) VALUES (?1, ?2)", k, String(v)).toArray();
  }

  /** When the next refresh is allowed (null = now), and why not now. */
  private budget(m: Meta, now: number): { nextAt: number; message: string } | null {
    const rowsToday = m.day === utcDay(now) ? m.rowsToday : 0;
    let nextAt = 0;
    let message = "";
    const last = m.attemptAt ? Date.parse(m.attemptAt) : NaN;
    if (Number.isFinite(last) && now - last < DEMO_MIN_INTERVAL_MS) {
      nextAt = last + DEMO_MIN_INTERVAL_MS;
      message = `Demo data was refreshed less than 10 minutes ago. Try again at ${london(nextAt)}.`;
    }
    // The first refresh of a UTC day is always allowed, so a large story can never lock the demo out for good.
    if (rowsToday > 0 && rowsToday + 2 * m.lastRows > DEMO_DAILY_ROWS) {
      const tomorrow = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
      nextAt = Math.max(nextAt, tomorrow);
      message = `Demo data has used today's refresh allowance. Try again at ${london(tomorrow)} tomorrow.`;
    }
    return nextAt ? { nextAt, message } : null;
  }

  private statusAt(now: number): DemoStoreStatus {
    const m = this.meta();
    const b = this.budget(m, now);
    return {
      refreshedAt: m.refreshedAt,
      story: DEMO_STORY,
      rowsToday: m.day === utcDay(now) ? m.rowsToday : 0,
      lastRows: m.lastRows,
      dailyRows: DEMO_DAILY_ROWS,
      nextRefreshAt: b ? iso(b.nextAt) : null,
      schemaOk: m.refreshedAt !== null && m.schemaHash === DEMO_SCHEMA_HASH,
    };
  }

  // ── RPC ─────────────────────────────────────────────────────────────────

  /** What the store holds and when it may next be refreshed. Never seeds. */
  async status(nowIso: string = new Date().toISOString()): Promise<DemoStoreStatus> {
    return this.statusAt(Date.parse(nowIso));
  }

  /** Wipe and re-seed, budget permitting. */
  async refresh(nowIso: string = new Date().toISOString()): Promise<DemoResult> {
    installDemoFetchGuard();
    const now = Date.parse(nowIso);
    return this.ctx.blockConcurrencyWhile(async () => {
      // No new read starts while the block holds; one already running must finish before the wipe.
      if (!(await this.drain())) {
        return { ok: false as const, code: "demo_busy" as const, message: DEMO_READING_MESSAGE, nextAt: iso(now + 60_000), status: this.statusAt(now) };
      }
      try {
        const counts = await this.seed(now);
        return { ok: true as const, status: this.statusAt(now), counts };
      } catch (e) {
        if (e instanceof DemoBudget) return { ok: false as const, code: "demo_busy" as const, message: e.message, nextAt: e.nextAt, status: this.statusAt(now) };
        throw e;
      }
    });
  }

  /** Seed when empty, built from an older schema or story, or older than 12 hours; budget permitting. */
  async ensureReady(nowIso: string = new Date().toISOString()): Promise<DemoResult> {
    const now = Date.parse(nowIso);
    const st = this.statusAt(now);
    const stale = st.refreshedAt !== null && now - Date.parse(st.refreshedAt) > DEMO_STALE_MS;
    const oldStory = this.meta().storyVersion !== DEMO_STORY_VERSION;
    if (st.refreshedAt && st.schemaOk && !stale && !oldStory) return { ok: true, status: st, counts: {} };
    const r = await this.refresh(nowIso);
    // Only old (not empty, not out of date): the data is still good to show while the budget says wait.
    if (!r.ok && st.refreshedAt && st.schemaOk) return { ok: true, status: this.statusAt(now), counts: {} };
    return r;
  }

  /** Answer one demo read (GET/HEAD /api/v1/*, POST /api/v1/firewall/simulate, GET /health) for `user`. */
  async serve(request: Request, user: string): Promise<Response> {
    installDemoFetchGuard();
    installDemoClock();
    const now = Date.now();
    // Empty, out of date, or over 12 hours old: seed first, budget permitting. Old but intact data is still served
    // when the budget says wait (ensureReady answers ok); only an empty or out-of-date store answers 503.
    const r = await this.ensureReady(iso(now));
    if (!r.ok) {
      return Response.json({ error: { code: "demo_outdated", message: DEMO_OUTDATED_MESSAGE } }, { status: 503, headers: { [DEMO_DATA_HEADER]: "demo", "Cache-Control": "no-store" } });
    }
    // The demo's clock (clock.ts): the app sees the seed time (to the minute); the answer is moved on to now.
    const { offset, shift } = demoClockFor(Date.parse(r.status.refreshedAt ?? ""), now);
    const env = makeDemoEnv(this.env, this.sql, new WriteMeter());
    Object.defineProperty(env, USER, { value: user });
    const ctx = this.ctx;
    const exec = { waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    // Counted from here (after any seeding above), so a refresh waits for this read before it wipes.
    this.reading++;
    let res: Response;
    try {
      res = await demoClock.run(offset, () => demoScope.run(true, () => this.demoApp().fetch(request, env, exec)));
      // The whole answer is read here, inside the count: nothing reads the store after it drops.
      if (res.body) {
        const type = res.headers.get("Content-Type") ?? "";
        res = shift && /json|^text\//i.test(type) ?new Response(shiftTimes(await res.text(), shift), res) : new Response(await res.arrayBuffer(), res);
      }
    } finally {
      if (--this.reading === 0) for (const done of this.drained.splice(0)) done();
    }
    const out = new Response(res.body, res);
    out.headers.set(DEMO_DATA_HEADER, "demo");
    out.headers.set("Cache-Control", "no-store");
    return out;
  }

  // ── Inside ──────────────────────────────────────────────────────────────

  /** The app as the Worker mounts it, minus the login (the gate has done that): /api/v1 and /health. */
  private demoApp() {
    if (this.app) return this.app;
    const app = new Hono<{ Bindings: Env; Variables: AuthedVars }>();
    app.use("*", async (c, next) => {
      c.set("user", (c.env as unknown as { [USER]?: string })[USER] ?? "");
      await next();
    });
    app.route("/api/v1", buildApi());
    // The same answer as the Worker's GET /health (index.ts), from the demo snapshot.
    app.get("/health", async (c) => {
      const snap = await getSnapshot(c.env);
      return c.json({ state: snap.state, public_ip: snap.public_ip, updated_at: snap.updated_at, config: config(c.env).dnsName });
    });
    app.notFound((c) => c.text("Not found", 404));
    app.onError((err, c) => {
      const ref = crypto.randomUUID().slice(0, 8);
      console.error(`demo error ${ref} on ${c.req.method} ${new URL(c.req.url).pathname}:`, err);
      return c.text(`Something broke (reference ${ref}). The details are in the Worker's log.`, 500);
    });
    this.app = app;
    return app;
  }

  /** Wait until no read is running (true), or DEMO_DRAIN_MS passes (false). */
  private async drain(): Promise<boolean> {
    if (this.reading === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<boolean>((r) => this.drained.push(() => r(true)));
    const late = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), DEMO_DRAIN_MS)));
    try {
      return await Promise.race([done, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Wipe, schema, everything story, meta. Throws DemoBudget when the budget says no. */
  private async seed(now: number): Promise<Record<string, number>> {
    const before = this.meta();
    const b = this.budget(before, now);
    if (b) throw new DemoBudget(iso(b.nextAt), b.message);
    const today = utcDay(now);
    const carried = before.day === today ? before.rowsToday : 0;
    const meter = new WriteMeter();
    await this.wipe();
    // The attempt counts from here, even if the seed fails half-way (rows written are rows written).
    this.writeMeta({ attemptAt: iso(now), day: today, rowsToday: carried, lastRows: before.lastRows });
    try {
      for (const m of DEMO_SCHEMA) for (const s of splitSql(m.sql)) this.metered(meter, s);
      ensureFacadeTables(this.sql);
      const env = makeDemoEnv(this.env, this.sql, meter);
      const result = await demoScope.run(true, () => seedScenario(env, DEMO_STORY, new Date(now), { actor: DEMO_ACTOR }));
      this.writeMeta({ refreshedAt: iso(now), schemaHash: DEMO_SCHEMA_HASH, storyVersion: DEMO_STORY_VERSION, story: DEMO_STORY, rowsToday: carried + meter.rows, lastRows: meter.rows });
      return result.counts;
    } catch (e) {
      this.writeMeta({ rowsToday: carried + meter.rows, lastRows: meter.rows });
      throw e;
    }
  }

  private metered(meter: WriteMeter, query: string): void {
    const c = this.sql.exec(query);
    c.toArray();
    meter.add(c.rowsWritten);
  }

  /** Empty the store: deleteAll (a SQLite-backed object's whole database), then drop any table still there. */
  private async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
    let left: Record<string, unknown>[] = [];
    try {
      left = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
    } catch {
      left = [];
    }
    for (const t of left) this.sql.exec(`DROP TABLE IF EXISTS "${String(t.name).replace(/"/g, '""')}"`).toArray();
  }
}
