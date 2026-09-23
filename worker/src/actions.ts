// actions.ts
//
// Plain English: the buttons on a phone notification. Each button is a
// one-time link: a long random code, good for one press, for one job
// (extend by an hour, hibernate, or tear down), and only until shortly after
// the deadline it was sent about. Only the code's SHA-256 is stored, in the
// Durable Object (so two quick taps cannot both use it), and reading the
// store does not reveal a working link. Like a one-time PIN
// on a change ticket rather than a standing password.
//
// These links skip the Cloudflare Access login (the phone's ntfy app cannot
// log in), which is why they can do so little: nothing here can deploy,
// read anything, or change settings. The worst a leaked link can do is one
// extra hour of running, or an early shutdown.

import type { Env } from "./env";
import { config } from "./env";
import { randomToken, sha256Hex } from "./auth";
import type { NotifyButton } from "./notify";

export type QuickAction = "extend" | "hibernate" | "destroy";

const LABEL: Record<QuickAction, string> = { extend: "Extend 1h", hibernate: "Hibernate", destroy: "Tear down" };

function store(env: Env) {
  return env.RUN_LOCK.get(env.RUN_LOCK.idFromName("singleton"));
}

/** Mint a one-time link for an action, valid for `ttlSeconds`. */
export async function actionButton(env: Env, action: QuickAction, ttlSeconds: number): Promise<NotifyButton> {
  const token = randomToken();
  await store(env).fetch("https://lock/act/put", { method: "POST", body: JSON.stringify({ key: await sha256Hex(token), action, expiresAt: Date.now() + ttlSeconds * 1000 }) });
  return { label: LABEL[action], url: `${config(env).publicUrl}/api/act/${token}`, kind: "http" };
}

/** Use up a link. Returns its action, or null if it is unknown, used or expired. */
export async function consumeAction(env: Env, token: string): Promise<QuickAction | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await store(env).fetch("https://lock/act/take", { method: "POST", body: JSON.stringify({ key: await sha256Hex(token) }) });
  const { action } = (await r.json()) as { action: string | null };
  return action === "extend" || action === "hibernate" || action === "destroy" ? action : null;
}

export function dashboardButton(env: Env, label = "Open dashboard"): NotifyButton {
  return { label, url: config(env).publicUrl, kind: "view" };
}
