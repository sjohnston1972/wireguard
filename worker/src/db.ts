// db.ts
//
// Plain English: the only file that speaks SQL. Everything else asks for
// "the latest run" or "all enabled peers" and gets typed objects back.

import type { Env } from "./env";

export type RunAction = "apply" | "destroy";
export type RunStatus = "queued" | "running" | "success" | "failure" | "cancelled";

export interface Run {
  id: string;
  action: RunAction;
  status: RunStatus;
  requested_at: string;
  requested_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  github_run_id: number | null;
  github_run_url: string | null;
  callback_token_hash: string | null;
  agent_token_hash: string | null;
  payload_json: string | null;
  outputs_json: string | null;
  public_ip: string | null;
  auto_destroy_at: string | null;
  reason: string | null;
  error: string | null;
  ssh_password: string | null;
}

export interface Peer {
  id: number;
  name: string;
  public_key: string;
  ip: string;
  enabled: number;
  full_tunnel: number;
  azure_vnet: number;
  tunnel_dns: number;
  routes: string; // comma-separated CIDRs reached through this peer (a site), "" for a plain client
  home_lan: number; // client config also routes the home LAN into the tunnel
  created_at: string;
  note: string | null;
}

export interface Alert {
  id: number;
  at: string;
  kind: string;
  message: string;
  run_id: string | null;
  acknowledged: number;
}

export interface CostDay {
  day: string;
  gbp: number;
  fetched_at: string;
}

// ── Runs ──────────────────────────────────────────────────────────────────

export async function createRun(env: Env, r: Omit<Run, "started_at" | "finished_at" | "github_run_id" | "github_run_url" | "outputs_json" | "public_ip" | "error">): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, action, status, requested_at, requested_by, callback_token_hash, agent_token_hash, payload_json, auto_destroy_at, reason, ssh_password)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  )
    .bind(r.id, r.action, r.status, r.requested_at, r.requested_by, r.callback_token_hash, r.agent_token_hash, r.payload_json, r.auto_destroy_at, r.reason, r.ssh_password ?? null)
    .run();
}

export async function getRun(env: Env, id: string): Promise<Run | null> {
  return (await env.DB.prepare("SELECT * FROM runs WHERE id = ?1").bind(id).first<Run>()) ?? null;
}

export async function latestRun(env: Env): Promise<Run | null> {
  return (await env.DB.prepare("SELECT * FROM runs ORDER BY requested_at DESC LIMIT 1").first<Run>()) ?? null;
}

/** The most recent run that is still queued or running, if any. */
export async function activeRun(env: Env): Promise<Run | null> {
  return (
    (await env.DB.prepare("SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY requested_at DESC LIMIT 1").first<Run>()) ?? null
  );
}

/** The most recent successful apply, if it has not been followed by a successful destroy. */
export async function currentDeployment(env: Env): Promise<Run | null> {
  const last = await env.DB.prepare("SELECT * FROM runs WHERE status = 'success' ORDER BY finished_at DESC LIMIT 1").first<Run>();
  return last && last.action === "apply" ? last : null;
}

export async function listRuns(env: Env, limit = 50): Promise<Run[]> {
  const r = await env.DB.prepare("SELECT * FROM runs ORDER BY requested_at DESC LIMIT ?1").bind(limit).all<Run>();
  return r.results;
}

export async function updateRun(env: Env, id: string, patch: Partial<Run>): Promise<void> {
  const keys = Object.keys(patch).filter((k) => k !== "id");
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
  await env.DB.prepare(`UPDATE runs SET ${sets} WHERE id = ?1`).bind(id, ...vals).run();
}

// ── Peers ─────────────────────────────────────────────────────────────────

export async function listPeers(env: Env): Promise<Peer[]> {
  return (await env.DB.prepare("SELECT * FROM peers ORDER BY id").all<Peer>()).results;
}

export async function enabledPeers(env: Env): Promise<Peer[]> {
  return (await env.DB.prepare("SELECT * FROM peers WHERE enabled = 1 ORDER BY id").all<Peer>()).results;
}

export async function getPeer(env: Env, id: number): Promise<Peer | null> {
  return (await env.DB.prepare("SELECT * FROM peers WHERE id = ?1").bind(id).first<Peer>()) ?? null;
}

export async function addPeer(env: Env, p: { name: string; public_key: string; ip: string; full_tunnel: boolean; azure_vnet?: boolean; tunnel_dns?: boolean; note?: string }): Promise<Peer> {
  const created_at = new Date().toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO peers (name, public_key, ip, enabled, full_tunnel, azure_vnet, tunnel_dns, created_at, note) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8) RETURNING *"
  )
    .bind(p.name, p.public_key, p.ip, p.full_tunnel ? 1 : 0, p.azure_vnet ? 1 : 0, p.tunnel_dns ? 1 : 0, created_at, p.note ?? null)
    .first<Peer>();
  if (!r) throw new Error("insert failed");
  return r;
}

/** Replace a client's public key (a "re-key"): the old config stops working at the next heartbeat. */
export async function setPeerKey(env: Env, id: number, public_key: string): Promise<void> {
  await env.DB.prepare("UPDATE peers SET public_key = ?2 WHERE id = ?1").bind(id, public_key).run();
}

/** Flip whether this client's config routes the Azure VNet. Takes effect in the next config it downloads. */
export async function setPeerAzureVnet(env: Env, id: number, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE peers SET azure_vnet = ?2 WHERE id = ?1").bind(id, on ? 1 : 0).run();
}

/** Flip whether this client's config uses the tunnel DNS. Takes effect in the next config it downloads. */
export async function setPeerTunnelDns(env: Env, id: number, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE peers SET tunnel_dns = ?2 WHERE id = ?1").bind(id, on ? 1 : 0).run();
}

export async function setPeerHomeLan(env: Env, id: number, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE peers SET home_lan = ?2 WHERE id = ?1").bind(id, on ? 1 : 0).run();
}

/** The site peer (a peer with routes), if one is registered and enabled. */
export async function sitePeer(env: Env): Promise<Peer | null> {
  return (await env.DB.prepare("SELECT * FROM peers WHERE routes != '' AND enabled = 1 ORDER BY id LIMIT 1").first<Peer>()) ?? null;
}

export async function setPeerEnabled(env: Env, id: number, enabled: boolean): Promise<void> {
  await env.DB.prepare("UPDATE peers SET enabled = ?2 WHERE id = ?1").bind(id, enabled ? 1 : 0).run();
}

export async function deletePeer(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM peers WHERE id = ?1").bind(id).run();
}

// ── Alerts ────────────────────────────────────────────────────────────────

export async function addAlert(env: Env, kind: string, message: string, run_id?: string | null): Promise<void> {
  await env.DB.prepare("INSERT INTO alerts (at, kind, message, run_id) VALUES (?1, ?2, ?3, ?4)")
    .bind(new Date().toISOString(), kind, message, run_id ?? null)
    .run();
}

export async function listAlerts(env: Env, limit = 50): Promise<Alert[]> {
  return (await env.DB.prepare("SELECT * FROM alerts ORDER BY at DESC LIMIT ?1").bind(limit).all<Alert>()).results;
}

export async function unacknowledgedAlerts(env: Env): Promise<Alert[]> {
  return (await env.DB.prepare("SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY at DESC LIMIT 10").all<Alert>()).results;
}

export async function acknowledgeAlerts(env: Env): Promise<void> {
  await env.DB.prepare("UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0").run();
}

// ── Settings ──────────────────────────────────────────────────────────────

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function allSettings(env: Env): Promise<Record<string, string>> {
  const r = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(r.results.map((x) => [x.key, x.value]));
}

// ── Cost ──────────────────────────────────────────────────────────────────

export async function upsertCostDay(env: Env, day: string, gbp: number): Promise<void> {
  await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(day) DO UPDATE SET gbp = excluded.gbp, fetched_at = excluded.fetched_at")
    .bind(day, gbp, new Date().toISOString())
    .run();
}

export async function costDays(env: Env, sinceDay: string): Promise<CostDay[]> {
  return (await env.DB.prepare("SELECT * FROM cost_days WHERE day >= ?1 ORDER BY day").bind(sinceDay).all<CostDay>()).results;
}

// ── Profiles ──────────────────────────────────────────────────────────────

export interface Profile {
  id: number;
  name: string;
  region: string;
  vm_size: string;
  sort: number;
}

export async function listProfiles(env: Env): Promise<Profile[]> {
  return (await env.DB.prepare("SELECT * FROM profiles ORDER BY sort, id").all<Profile>()).results;
}

export async function getProfile(env: Env, id: number): Promise<Profile | null> {
  return (await env.DB.prepare("SELECT * FROM profiles WHERE id = ?1").bind(id).first<Profile>()) ?? null;
}

export async function addProfile(env: Env, p: { name: string; region: string; vm_size: string }): Promise<void> {
  await env.DB.prepare("INSERT INTO profiles (name, region, vm_size, sort) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort), 0) + 1 FROM profiles))").bind(p.name, p.region, p.vm_size).run();
}

export async function deleteProfile(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM profiles WHERE id = ?1").bind(id).run();
  await env.DB.prepare("UPDATE schedules SET profile_id = NULL WHERE profile_id = ?1").bind(id).run();
}

// ── Schedules ─────────────────────────────────────────────────────────────

export interface Schedule {
  id: number;
  days: string;
  start_time: string;
  end_time: string;
  profile_id: number | null;
  enabled: number;
  created_at: string;
}

export async function listSchedules(env: Env): Promise<Schedule[]> {
  return (await env.DB.prepare("SELECT * FROM schedules ORDER BY start_time, id").all<Schedule>()).results;
}

export async function addSchedule(env: Env, s: { days: string; start_time: string; end_time: string; profile_id: number | null }): Promise<void> {
  await env.DB.prepare("INSERT INTO schedules (days, start_time, end_time, profile_id, enabled, created_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)")
    .bind(s.days, s.start_time, s.end_time, s.profile_id, new Date().toISOString())
    .run();
}

export async function setScheduleEnabled(env: Env, id: number, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE schedules SET enabled = ?2 WHERE id = ?1").bind(id, on ? 1 : 0).run();
}

export async function deleteSchedule(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM schedules WHERE id = ?1").bind(id).run();
}

// ── Speed tests ───────────────────────────────────────────────────────────

export interface SpeedTest {
  id: string;
  at: string;
  target_name: string | null;
  down_mbps: number | null;
  up_mbps: number | null;
  rtt_ms: number | null;
  jitter_ms: number | null;
  error: string | null;
}

export async function saveSpeedTest(env: Env, t: SpeedTest): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO speedtests (id, at, target_name, down_mbps, up_mbps, rtt_ms, jitter_ms, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(t.id, t.at, t.target_name, t.down_mbps, t.up_mbps, t.rtt_ms, t.jitter_ms, t.error)
    .run();
}

export async function listSpeedTests(env: Env, limit = 10): Promise<SpeedTest[]> {
  return (await env.DB.prepare("SELECT * FROM speedtests ORDER BY at DESC LIMIT ?1").bind(limit).all<SpeedTest>()).results;
}

// ── Phones subscribed to alerts (Web Push) ────────────────────────────────

export interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  created_at: string;
  last_ok: string | null;
  last_error: string | null;
}

export async function listPushSubs(env: Env): Promise<PushSub[]> {
  return (await env.DB.prepare("SELECT * FROM push_subs ORDER BY id").all<PushSub>()).results;
}

export async function savePushSub(env: Env, s: { endpoint: string; p256dh: string; auth: string; label: string | null }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO push_subs (endpoint, p256dh, auth, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label"
  )
    .bind(s.endpoint, s.p256dh, s.auth, s.label, new Date().toISOString())
    .run();
}

export async function deletePushSub(env: Env, by: { id?: number; endpoint?: string }): Promise<void> {
  if (by.id) await env.DB.prepare("DELETE FROM push_subs WHERE id = ?1").bind(by.id).run();
  else if (by.endpoint) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(by.endpoint).run();
}

export async function markPushSub(env: Env, id: number, ok: boolean, error: string | null): Promise<void> {
  if (ok) await env.DB.prepare("UPDATE push_subs SET last_ok = ?2, last_error = NULL WHERE id = ?1").bind(id, new Date().toISOString()).run();
  else await env.DB.prepare("UPDATE push_subs SET last_error = ?2 WHERE id = ?1").bind(id, error).run();
}
