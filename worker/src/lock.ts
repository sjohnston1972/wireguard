// lock.ts
//
// Plain English: a single key on a hook. Only one run (deploy or destroy) may
// hold it at a time. A Durable Object is Cloudflare's way of guaranteeing
// there is exactly one copy of this hook in the world, so two clicks a
// millisecond apart cannot both start a run. The lock expires on its own
// after a while in case a run dies without releasing it.

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
