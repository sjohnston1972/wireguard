// api-push.test.ts
//
// Plain English: phone alerts. The old routes the app and its service worker
// call (/api/push/..., /settings/push/:id/delete) must answer exactly as they
// always have; the new /api/v1/push routes do the same jobs with proper JSON
// errors and never show a phone's keys.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import * as db from "../src/db";
import worker from "../src/index";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const P256 = "BpEcTzQ" + "x".repeat(80); // 87 characters of the right alphabet
const AUTH = "aUthSecret0123456789"; // 20 characters
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abcdefghijkl";
const sub = (over: Record<string, unknown> = {}) => ({ endpoint: ENDPOINT, keys: { p256dh: P256, auth: AUTH }, label: "Pixel", ...over });

/** An old-style call: returns the status, the parsed body and the raw response. */
async function old(env: Env, method: string, path: string, json?: unknown, type = "application/json") {
  const headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" };
  const init: RequestInit = { method, headers, redirect: "manual" };
  if (json !== undefined) {
    init.body = typeof json === "string" ? json : JSON.stringify(json);
    headers["Content-Type"] = type;
  }
  const r = await worker.fetch(new Request(`${base}${path}`, init), env, ctx);
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: r.status, json: parsed, text, res: r };
}

describe("the old push routes keep their answers", () => {
  it("subscribe: a good subscription is stored and answers { ok: true }", async () => {
    const { env } = apiEnv();
    const r = await old(env, "POST", "/api/push/subscribe", sub());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const subs = await db.listPushSubs(env);
    expect(subs.map((s) => [s.endpoint, s.label])).toEqual([[ENDPOINT, "Pixel"]]);
    expect((await db.listAlerts(env)).map((a) => a.message)).toContain("Phone alerts turned on for Pixel by dev@localhost.");
    expect((await db.listAudit(env)).find((a) => a.action === "push.add")?.target).toBe("Pixel");
  });

  it("subscribe: anything else answers 400 with the old one-string error and stores nothing", async () => {
    const { env } = apiEnv();
    for (const bad of [sub({ endpoint: "https://evil.example/collect/abcdef" }), sub({ keys: { p256dh: "short", auth: AUTH } }), sub({ keys: { p256dh: P256, auth: "!" } }), {}]) {
      const r = await old(env, "POST", "/api/push/subscribe", bad);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: "That does not look like a push subscription." });
    }
    expect((await old(env, "POST", "/api/push/subscribe", JSON.stringify(sub()), "text/plain")).status).toBe(400);
    expect(await db.listPushSubs(env)).toEqual([]);
  });

  it("subscribe: a long label is cut to 40 characters; no label is a device", async () => {
    const { env } = apiEnv();
    await old(env, "POST", "/api/push/subscribe", sub({ label: "L".repeat(60) }));
    expect((await db.listPushSubs(env))[0].label).toBe("L".repeat(40));
    await old(env, "POST", "/api/push/subscribe", sub({ endpoint: ENDPOINT + "2", label: undefined }));
    expect((await db.listPushSubs(env))[1].label).toBeNull();
    expect((await db.listAlerts(env)).map((a) => a.message)).toContain("Phone alerts turned on for a device by dev@localhost.");
  });

  it("status: registered or not, never cached", async () => {
    const { env } = apiEnv({ VAPID_PUBLIC_KEY: "PUBKEY" });
    await old(env, "POST", "/api/push/subscribe", sub());
    const id = (await db.listPushSubs(env))[0].id;
    const yes = await old(env, "GET", `/api/push/status?endpoint=${encodeURIComponent(ENDPOINT)}`);
    expect(yes.json).toEqual({ registered: true, id, last_error: null, vapid: "PUBKEY" });
    expect(yes.res.headers.get("Cache-Control")).toBe("no-store");
    expect((await old(env, "GET", "/api/push/status?endpoint=https%3A%2F%2Fnope")).json).toEqual({ registered: false, id: null, last_error: null, vapid: "PUBKEY" });
    expect((await old(env, "GET", "/api/push/status")).json).toEqual({ registered: false, id: null, last_error: null, vapid: "PUBKEY" });
  });

  it("unsubscribe: removes the phone and says ok; with no endpoint it still says ok and records nothing", async () => {
    const { env } = apiEnv();
    await old(env, "POST", "/api/push/subscribe", sub());
    expect((await old(env, "POST", "/api/push/unsubscribe", {})).json).toEqual({ ok: true });
    expect(await db.listPushSubs(env)).toHaveLength(1);
    expect((await db.listAudit(env)).filter((a) => a.action === "push.remove")).toHaveLength(0);
    const r = await old(env, "POST", "/api/push/unsubscribe", { endpoint: ENDPOINT });
    expect(r.json).toEqual({ ok: true });
    expect(await db.listPushSubs(env)).toEqual([]);
    expect((await db.listAudit(env)).find((a) => a.action === "push.remove")?.target).toBe("this device");
  });

  it("test: { ok: true, phones } when it goes out, { ok: false, error } (still 200) when the pager fails", async () => {
    const { env, world } = apiEnv();
    await old(env, "POST", "/api/push/subscribe", sub());
    const good = await old(env, "POST", "/api/push/test");
    expect(good.status).toBe(200);
    expect(good.json).toEqual({ ok: true, phones: 1 });
    expect(world.notes.length).toBe(1);
    const { env: env2 } = apiEnv({ NOTIFY_WEBHOOK_URL: "https://hooks.example.com/x" });
    const bad = await old(env2, "POST", "/api/push/test");
    expect(bad.status).toBe(200);
    expect(bad.json.ok).toBe(false);
    expect(typeof bad.json.error).toBe("string");
  });

  it("settings delete: removes the phone and redirects to /settings?saved=1, even for a missing id", async () => {
    const { env } = apiEnv();
    await old(env, "POST", "/api/push/subscribe", sub());
    const id = (await db.listPushSubs(env))[0].id;
    const r = await old(env, "POST", `/settings/push/${id}/delete`);
    expect(r.status).toBe(302);
    expect(r.res.headers.get("Location")).toBe("/settings?saved=1");
    expect(await db.listPushSubs(env)).toEqual([]);
    expect((await db.listAudit(env)).find((a) => a.action === "push.remove")?.target).toBe("Pixel");
    const again = await old(env, "POST", `/settings/push/${id}/delete`);
    expect(again.status).toBe(302);
    expect(again.res.headers.get("Location")).toBe("/settings?saved=1");
    expect((await db.listAudit(env)).filter((a) => a.action === "push.remove")).toHaveLength(1);
  });
});
