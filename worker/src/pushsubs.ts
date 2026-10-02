// pushsubs.ts
//
// Plain English: the phone-alerts commands: turn alerts on for a phone, turn
// them off, ask whether a phone is still on the list, send a test alert, and
// remove a phone from Settings. Both the old routes (which the app and its
// service worker call) and the data API call these, so a phone is treated the
// same whichever way it asks. A phone's push address and keys are never
// handed back to anyone: they are only ever used to send it alerts.

import type { Env } from "./env";
import * as db from "./db";
import { isPushEndpoint } from "./webpush";
import { notify, lastNotifyError } from "./notify";
import { dashboardButton } from "./actions";
import { no, type Done } from "./result";

const NOT_A_SUBSCRIPTION = "That does not look like a push subscription.";

/**
 * Turn alerts on for a phone. The input is what the browser's push
 * subscription gave the app; anything that is not a real push service's
 * address and well-formed keys is refused and nothing is stored.
 */
export async function subscribePhone(env: Env, user: string, input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null; label?: unknown } | null): Promise<Done<null>> {
  const endpoint = String(input?.endpoint ?? "");
  const p256dh = String(input?.keys?.p256dh ?? "");
  const auth = String(input?.keys?.auth ?? "");
  if (!/^https:\/\/[^\s]{10,}$/.test(endpoint) || !isPushEndpoint(endpoint)) return no(400, "bad_input", NOT_A_SUBSCRIPTION, "endpoint");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return no(400, "bad_input", NOT_A_SUBSCRIPTION, "keys");
  const label = input?.label as string | undefined;
  await db.savePushSub(env, { endpoint, p256dh, auth, label: String(label ?? "").slice(0, 40) || null });
  await db.addAlert(env, "info", `Phone alerts turned on for ${label || "a device"} by ${user}.`);
  await db.audit(env, user, "push.add", label || "a device", null, { label: label || null });
  return { ok: true, value: null };
}

/** Turn alerts off for the phone with this push address. No address is a no-op, as before. */
export async function unsubscribePhone(env: Env, user: string, endpoint: unknown): Promise<Done<null>> {
  if (endpoint) {
    await db.deletePushSub(env, { endpoint: String(endpoint) });
    await db.audit(env, user, "push.remove", "this device", null, null);
  }
  return { ok: true, value: null };
}

/** Is this phone still on our list? Also hands over the public key, for signing up again. */
export async function phoneStatus(env: Env, endpoint: string): Promise<{ registered: boolean; id: number | null; last_error: string | null; vapid: string | null }> {
  const sub = endpoint ? (await db.listPushSubs(env)).find((s) => s.endpoint === endpoint) : undefined;
  return { registered: !!sub, id: sub?.id ?? null, last_error: sub?.last_error ?? null, vapid: env.VAPID_PUBLIC_KEY ?? null };
}

/** Send a test alert to every phone and the webhook; a failure comes back as 502 with the reason. */
export async function sendTestAlert(env: Env): Promise<Done<{ phones: number }>> {
  await env.STATUS.delete("notify:last_error");
  await notify(env, "wg-admin: test alert", "Phone alerts work. Tap to open the dashboard.", { tags: ["test"], buttons: [dashboardButton(env)] });
  const err = await lastNotifyError(env);
  if (err) return no(502, "upstream", err.why);
  return { ok: true, value: { phones: (await db.listPushSubs(env)).length } };
}

/** Remove a phone from the list (Settings). 404 if it is not there. */
export async function removePhone(env: Env, user: string, id: number): Promise<Done<{ label: string }>> {
  const gone = (await db.listPushSubs(env)).find((s) => s.id === id);
  if (!gone) return no(404, "not_found", "No such phone.");
  await db.deletePushSub(env, { id });
  const label = gone.label ?? `device ${gone.id}`;
  await db.audit(env, user, "push.remove", label, gone, null);
  return { ok: true, value: { label } };
}
