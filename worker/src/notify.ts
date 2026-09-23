// notify.ts
//
// Plain English: the pager. When something worth knowing happens (ready,
// torn down, failed, drift, cost guard, "tearing down in 15 minutes"), post it
// to a webhook if one is set. Discord, Slack, ntfy and plain JSON receivers
// are all handled. Off by default; never blocks the caller; never throws.
//
// ntfy.sh limits anonymous publishing per source IP, and Cloudflare Workers
// share their outgoing addresses with everyone else's, so anonymous posts
// from here hit "daily message quota reached" (found 2026-09-23). With
// NOTIFY_TOKEN (an access token from a free ntfy.sh account) the limit is
// the account's own. The last failure is kept in KV and shown in Settings,
// so a pager that has gone quiet is visible rather than silent.
//
// ntfy gets the full treatment: a priority, and buttons on the phone
// notification. A button is either a link that opens the dashboard, or a
// one-tap action ("Extend 1h", "Hibernate", "Tear down") that POSTs a
// single-use link (see actions.ts). The other services get the text only.

import type { Env } from "./env";

export interface NotifyButton {
  label: string;
  url: string;
  /** "view" opens the page; "http" POSTs to it from the phone without opening anything. */
  kind: "view" | "http";
}

export interface NotifyOptions {
  buttons?: NotifyButton[];
  priority?: 1 | 2 | 3 | 4 | 5; // ntfy: 3 default, 4 high, 5 urgent
  tags?: string[];
}

/** ntfy URLs look like https://ntfy.sh/<topic> (or a self-hosted server). */
export function ntfyParts(url: string): { base: string; topic: string } | null {
  try {
    const u = new URL(url);
    const topic = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!/ntfy/.test(u.hostname) && !/\/ntfy\//.test(url)) return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic)) return null;
    return { base: u.origin, topic };
  } catch {
    return null;
  }
}

/** The JSON ntfy's publish endpoint takes. Pure, for testing. */
export function ntfyMessage(topic: string, title: string, body: string, o: NotifyOptions = {}): Record<string, unknown> {
  const msg: Record<string, unknown> = { topic, title, message: body, tags: o.tags ?? ["shield"] };
  if (o.priority) msg.priority = o.priority;
  if (o.buttons?.length) {
    msg.actions = o.buttons.slice(0, 3).map((b) => (b.kind === "view" ? { action: "view", label: b.label, url: b.url } : { action: "http", label: b.label, url: b.url, method: "POST", clear: true }));
  }
  return msg;
}

export async function notify(env: Env, title: string, body: string, o: NotifyOptions = {}): Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    let target = url;
    let init: RequestInit;
    const ntfy = ntfyParts(url);
    if (/discord(app)?\.com\/api\/webhooks/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${body}` }) };
    } else if (/hooks\.slack\.com/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${body}` }) };
    } else if (ntfy) {
      target = ntfy.base;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (env.NOTIFY_TOKEN) headers.Authorization = `Bearer ${env.NOTIFY_TOKEN}`;
      init = { method: "POST", headers, body: JSON.stringify(ntfyMessage(ntfy.topic, title, body, o)) };
    } else {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "wg-admin", title, body, at: new Date().toISOString() }) };
    }
    const r = await fetch(target, init);
    if (r.ok) await env.STATUS.delete("notify:last_error");
    else await recordFailure(env, `${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    // Notifications are best effort, but a failure is remembered for Settings.
    await recordFailure(env, (e as Error).message).catch(() => {});
  }
}

async function recordFailure(env: Env, why: string): Promise<void> {
  console.log("notify failed:", why);
  await env.STATUS.put("notify:last_error", JSON.stringify({ at: new Date().toISOString(), why }), { expirationTtl: 7 * 86400 });
}

/** The last failed notification, if the most recent attempt failed. */
export async function lastNotifyError(env: Env): Promise<{ at: string; why: string } | null> {
  return env.STATUS.get<{ at: string; why: string }>("notify:last_error", "json");
}
