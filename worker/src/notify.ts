// notify.ts
//
// Plain English: the pager. When something worth knowing happens (deployed,
// torn down, failed, drift, cost guard), post it to a webhook if one is set.
// Discord, Slack, ntfy and plain JSON receivers are all handled. Off by
// default; never blocks the caller; never throws.

import type { Env } from "./env";

export async function notify(env: Env, title: string, body: string): Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    let init: RequestInit;
    if (/discord(app)?\.com\/api\/webhooks/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${body}` }) };
    } else if (/hooks\.slack\.com/.test(url)) {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${title}*\n${body}` }) };
    } else if (/ntfy\.sh|\/ntfy\//.test(url)) {
      init = { method: "POST", headers: { Title: title, Tags: "shield" }, body };
    } else {
      init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "wg-admin", title, body, at: new Date().toISOString() }) };
    }
    await fetch(url, init);
  } catch {
    // Notifications are best effort.
  }
}
