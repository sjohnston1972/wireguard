// api/push.ts
//
// Plain English: phone alerts over the data API: turn alerts on or off for a
// phone, ask whether a phone is still registered, send a test alert, remove a
// phone. Answers never include a phone's push address or keys.

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { idParam } from "./clients";
import { subscribePhone, unsubscribePhone, phoneStatus, sendTestAlert, removePhone } from "../pushsubs";
import type { ApiOk, PushStatusResponse } from "../../../shared/api";

export function registerPush(api: Hono<ApiEnv>): void {
  api.post("/push/subscribe", async (c) => {
    const b = (await body<{ endpoint?: unknown; keys?: unknown; label?: unknown }>(c)) ?? {};
    if (b.label !== undefined && b.label !== null && typeof b.label !== "string") return fail(c, 400, "bad_input", "label must be text.", "label");
    if (b.keys !== undefined && (b.keys === null || typeof b.keys !== "object" || Array.isArray(b.keys))) return fail(c, 400, "bad_input", "That does not look like a push subscription.", "keys");
    const r = await subscribePhone(c.env, c.get("user"), b as Parameters<typeof subscribePhone>[2]);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    const out: ApiOk = { ok: true, message: "Phone alerts are on for this device." };
    return c.json(out);
  });

  api.post("/push/unsubscribe", async (c) => {
    const b = (await body<{ endpoint?: unknown }>(c)) ?? {};
    if (typeof b.endpoint !== "string" || !b.endpoint) return fail(c, 400, "bad_input", "endpoint must be this device's push address.", "endpoint");
    const r = await unsubscribePhone(c.env, c.get("user"), b.endpoint);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    const out: ApiOk = { ok: true, message: "Phone alerts are off for this device." };
    return c.json(out);
  });

  api.get("/push/status", async (c) => {
    const out: PushStatusResponse = await phoneStatus(c.env, c.req.query("endpoint") ?? "");
    return c.json(out);
  });

  api.post("/push/test", async (c) => {
    const r = await sendTestAlert(c.env);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    const out: ApiOk = { ok: true, message: `Test alert sent to ${r.value.phones} phone(s).` };
    return c.json(out);
  });

  api.delete("/push/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a phone's number.", "id");
    const r = await removePhone(c.env, c.get("user"), id);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    const out: ApiOk = { ok: true, message: `Removed ${r.value.label}. It will not get alerts any more.` };
    return c.json(out);
  });
}
