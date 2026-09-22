// lock.ts
//
// Plain English: the one place that is never out of date. A Durable Object
// is Cloudflare's guarantee that exactly one copy of something exists in the
// world and that its reads and writes happen in order. Two things live here:
//
//   1. The run lock: a single key on a hook. Only one run (deploy or destroy)
//      may hold it, so two clicks a millisecond apart cannot both start a run.
//      It expires on its own in case a run dies without releasing it.
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
        const body = (await request.json()) as { patch?: Record<string, unknown>; seed?: Record<string, unknown> };
        let cur = (await this.ctx.storage.get<Record<string, unknown>>("snapshot")) ?? null;
        if (!cur && body.seed) cur = body.seed;
        const next = { ...(cur ?? {}), ...(body.patch ?? {}), updated_at: new Date(now).toISOString() };
        await this.ctx.storage.put("snapshot", next);
        return Response.json({ snapshot: next });
      }
      return new Response("method", { status: 405 });
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

function stub(env: Env) {
  return env.RUN_LOCK.get(env.RUN_LOCK.idFromName("singleton"));
}

export async function acquireLock(env: Env, runId: string): Promise<{ ok: boolean; holder?: LockRecord }> {
  const r = await stub(env).fetch("https://lock/acquire", { method: "POST", body: JSON.stringify({ runId }) });
  return (await r.json()) as { ok: boolean; holder?: LockRecord };
}

export async function releaseLock(env: Env, runId?: string, force = false): Promise<void> {
  await stub(env).fetch("https://lock/release", { method: "POST", body: JSON.stringify({ runId, force }) });
}

export async function lockStatus(env: Env): Promise<{ held: boolean; lock: LockRecord | null }> {
  const r = await stub(env).fetch("https://lock/status");
  return (await r.json()) as { held: boolean; lock: LockRecord | null };
}
