// seen.ts
//
// Plain English: "While you were away" should mean exactly that. Pressing
// any button on the dashboard counts as having read the notes so far, and
// the routine notes that follow in the next 15 minutes (Deployed at...,
// Self-test passed, Torn down, the session summary) are ones Steven watched
// happen. Shared by the pages (index.ts) and the data API (api/).

import type { Env } from "./env";
import * as db from "./db";

const LAST_ACTION_KEY = "ui:last_action_at";
const SEEN_WINDOW_MS = 15 * 60_000;

/** A button was pressed: the notes so far are read, and the clock starts for routine ones. */
export async function markActed(env: Env): Promise<void> {
  await db.acknowledgeAlerts(env);
  await env.STATUS.put(LAST_ACTION_KEY, new Date().toISOString(), { expirationTtl: 86_400 });
}

/** Mark the routine notes from just after the last button press as read. */
export async function ackWatchedNotes(env: Env): Promise<void> {
  const last = await env.STATUS.get(LAST_ACTION_KEY);
  if (!last || Number.isNaN(Date.parse(last))) return;
  await db.acknowledgeRoutineBetween(env, last, new Date(Date.parse(last) + SEEN_WINDOW_MS).toISOString());
}
