// actions.ts
//
// Plain English: the buttons on a phone notification. Each button is a
// one-time link: a long random code, good for one press, for one job
// (extend by an hour, hibernate, or tear down; for a lab session, extend that
// session by an hour or tear it down), and only until shortly after
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

/** A lab session's links (labs spec §7.4): one more hour, or tear it down. The session id rides in the action. */
export type LabQuickAction = `lab-extend-1h:${string}` | `lab-destroy:${string}`;
export type QuickAction = "extend" | "hibernate" | "destroy" | LabQuickAction;

const LABEL: Record<"extend" | "hibernate" | "destroy", string> = { extend: "Extend 1h", hibernate: "Hibernate", destroy: "Tear down" };
/** "lab-extend-1h:<session id>" or "lab-destroy:<session id>", session ids as lab_sessions makes them. */
const LAB_ACTION_RE = /^lab-(extend-1h|destroy):ls-[a-z0-9-]{1,60}$/;

/** Is this one of a lab session's links (handled by labs/act.ts)? */
export function isLabAction(action: string): action is LabQuickAction {
  return LAB_ACTION_RE.test(action);
}

const labelOf = (action: QuickAction): string => (isLabAction(action) ? (action.startsWith("lab-destroy:") ? LABEL.destroy : LABEL.extend) : LABEL[action]);

function store(env: Env) {
  return env.RUN_LOCK.get(env.RUN_LOCK.idFromName("singleton"));
}

/** Mint a one-time link for an action, valid for `ttlSeconds`. */
export async function actionButton(env: Env, action: QuickAction, ttlSeconds: number): Promise<NotifyButton> {
  const token = randomToken();
  await store(env).fetch("https://lock/act/put", { method: "POST", body: JSON.stringify({ key: await sha256Hex(token), action, expiresAt: Date.now() + ttlSeconds * 1000 }) });
  return { label: labelOf(action), url: `${config(env).publicUrl}/api/act/${token}`, kind: "http" };
}

/** Use up a link. Returns its action, or null if it is unknown, used or expired. */
export async function consumeAction(env: Env, token: string): Promise<QuickAction | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await store(env).fetch("https://lock/act/take", { method: "POST", body: JSON.stringify({ key: await sha256Hex(token) }) });
  const { action } = (await r.json()) as { action: string | null };
  if (action === null) return null;
  return action === "extend" || action === "hibernate" || action === "destroy" || isLabAction(action) ? action : null;
}

/** A "view" button: the dashboard, or a page of it (a path like "/cost"). */
export function dashboardButton(env: Env, label = "Open dashboard", path = "/"): NotifyButton {
  return { label, url: config(env).publicUrl + path, kind: "view" };
}
