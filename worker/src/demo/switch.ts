// demo/switch.ts
//
// Plain English: the demo switch itself, one row per person in the real D1
// table demo_mode (migration 0022; spec ruling 5). A row means "this person
// sees the demo store"; no row means real data. Keyed by the Access email in
// lower case, as ui_prefs is. This row is the only real-store write demo mode
// ever makes: no audit entry, no Activity line (ruling 21), never in the
// backup, never wiped by the dev seeder.
//
// demoOn throws when D1 cannot be read. The gate turns that into 503
// demo_unknown: guessing "off" could show real data during a recording,
// guessing "on" could hide a real problem (ruling 6).

import type { Env } from "../env";

const key = (user: string) => user.trim().toLowerCase();

/** Is this person in demo mode? Throws when D1 cannot answer. */
export async function demoOn(env: Env, user: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS on_ FROM demo_mode WHERE user = ?1").bind(key(user)).first();
  return row !== null;
}

/** Turn this person's demo mode on (insert or replace the row) or off (delete it). Nobody else's row is touched. */
export async function setDemo(env: Env, user: string, on: boolean, now: Date = new Date()): Promise<void> {
  if (on) await env.DB.prepare("INSERT OR REPLACE INTO demo_mode (user, since) VALUES (?1, ?2)").bind(key(user), now.toISOString()).run();
  else await env.DB.prepare("DELETE FROM demo_mode WHERE user = ?1").bind(key(user)).run();
}
