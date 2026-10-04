// lock.ts
//
// Plain English: the one place that is never out of date. A Durable Object
// is Cloudflare's guarantee that exactly one copy of something exists in the
// world and that its reads and writes happen in order. Two things live here:
//
//   1. The run lock: a single key on a hook. Only one run (deploy or destroy)
//      may hold it, so two clicks a millisecond apart cannot both start a run.
//      It expires on its own in case a run dies without releasing it.
//   3. The one-time links on phone notifications (actions.ts): "use once"
//      has to mean once, even if two taps land a millisecond apart.
//   2. The status snapshot ("is it up?"). It used to live in KV, but KV is
//      eventually consistent between edges: the GitHub callback wrote the
//      public IP at one edge, the VM's heartbeat read a stale copy at another
//      and wrote it back without the IP. Every patch is now merged here,
//      atomically, so the last writer can never lose someone else's field.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

interface LockRecord {
  runId: string;
  since: string;
  expiresAt: number;
}

export class RunLock extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();

    // ── Status snapshot ────────────────────────────────────────────────
    if (url.pathname === "/snapshot") {
      if (request.method === "GET") {
        const snap = (await this.ctx.storage.get<Record<string, unknown>>("snapshot")) ?? null;
        return Response.json({ snapshot: snap });
      }
      if (request.method === "POST") {
        // Atomic read-merge-write. Body: { patch: {...}, seed?: {...} }.
        // "seed" is used once to migrate the old KV copy and never overwrites.
        // "ifState": only save if the state is still this (compare-and-set),
        // so of two callers racing on the same change only one goes ahead.
        const body = (await request.json()) as { patch?: Record<string, unknown>; seed?: Record<string, unknown>; ifState?: string };
        let cur = (await this.ctx.storage.get<Record<string, unknown>>("snapshot")) ?? null;
        if (!cur && body.seed) cur = body.seed;
        if (body.ifState !== undefined && (cur?.state ?? null) !== body.ifState) return Response.json({ snapshot: cur, ok: false });
        const next = { ...(cur ?? {}), ...(body.patch ?? {}), updated_at: new Date(now).toISOString() };
        await this.ctx.storage.put("snapshot", next);
        return Response.json({ snapshot: next });
      }
      return new Response("method", { status: 405 });
    }

    // ── One-time action links ─────────────────────────────────────────
    if (url.pathname === "/act/put" || url.pathname === "/act/take") {
      const body = (await request.json()) as { key: string; action?: string; expiresAt?: number };
      const key = `act:${body.key}`;
      if (url.pathname === "/act/put") {
        await this.ctx.storage.put(key, { action: body.action, expiresAt: body.expiresAt });
        // Sweep expired links so the store does not grow.
        const all = await this.ctx.storage.list<{ expiresAt: number }>({ prefix: "act:" });
        for (const [k, v] of all) if (v.expiresAt < now) await this.ctx.storage.delete(k);
        return Response.json({ ok: true });
      }
      const rec = await this.ctx.storage.get<{ action: string; expiresAt: number }>(key);
      if (rec) await this.ctx.storage.delete(key);
      return Response.json({ action: rec && rec.expiresAt > now ? rec.action : null });
    }

    // ── Run lock ───────────────────────────────────────────────────────
    const current = (await this.ctx.storage.get<LockRecord>("lock")) ?? null;
    const live = current && current.expiresAt > now ? current : null;

    switch (url.pathname) {
      case "/status":
        return Response.json({ held: !!live, lock: live });

      case "/acquire": {
        const body = (await request.json()) as { runId: string; ttlMs?: number };
        if (live && live.runId !== body.runId) {
          return Response.json({ ok: false, holder: live }, { status: 409 });
        }
        const rec: LockRecord = { runId: body.runId, since: new Date(now).toISOString(), expiresAt: now + (body.ttlMs ?? 45 * 60_000) };
        await this.ctx.storage.put("lock", rec);
        return Response.json({ ok: true, lock: rec });
      }

      case "/release": {
        const body = (await request.json()) as { runId?: string; force?: boolean };
        if (live && !body.force && body.runId && live.runId !== body.runId) {
          return Response.json({ ok: false, holder: live }, { status: 409 });
        }
        await this.ctx.storage.delete("lock");
        return Response.json({ ok: true });
      }

      default:
        return new Response("not found", { status: 404 });
    }
  }
}

// ── Which lock ─────────────────────────────────────────────────────────
// RunLock works for any instance name (labs spec §7.3). "singleton" is the
// gateway's: its run lock, its snapshot and the one-time links. Each lab has
// its own instance, "lab:<id>" (labLock), holding only that lab's run lock,
// so a lab never waits for the gateway or another lab. The one time a lab
// takes "singleton" is the 10-minute peering lock (§7.6).

export const GATEWAY_LOCK = "singleton";
/** A lab's RunLock instance name (the same as labLockName in shared/labs.ts). */
export const labLock = (labId: string): string => `lab:${labId}`;

export type { LockRecord };

function stub(env: Env, name = GATEWAY_LOCK) {
  return env.RUN_LOCK.get(env.RUN_LOCK.idFromName(name));
}

/** Take a run lock: the gateway's unless `name` says which. Expires on its own after `ttlMs` (default 45 minutes). */
export async function acquireLock(env: Env, runId: string, opts: { name?: string; ttlMs?: number } = {}): Promise<{ ok: boolean; holder?: LockRecord }> {
  const r = await stub(env, opts.name).fetch("https://lock/acquire", { method: "POST", body: JSON.stringify({ runId, ttlMs: opts.ttlMs }) });
  return (await r.json()) as { ok: boolean; holder?: LockRecord };
}

export async function releaseLock(env: Env, runId?: string, force = false, name = GATEWAY_LOCK): Promise<void> {
  await stub(env, name).fetch("https://lock/release", { method: "POST", body: JSON.stringify({ runId, force }) });
}

export async function lockStatus(env: Env, name = GATEWAY_LOCK): Promise<{ held: boolean; lock: LockRecord | null }> {
  const r = await stub(env, name).fetch("https://lock/status");
  return (await r.json()) as { held: boolean; lock: LockRecord | null };
}
