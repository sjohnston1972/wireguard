// keyrotation.ts
//
// Plain English: notices when the server's WireGuard key has been rotated.
// The rotation itself happens on the laptop (npm run keys -- --rotate, then
// npm run secrets and npm run deploy-worker), because the Worker never holds
// the private key. All the Worker sees is the public key in wrangler.toml
// changing. When it does, every existing client config still trusts the old
// key, so each client is flagged "needs new config". The flag clears on that
// client's first handshake after the change with a VM that is running the
// new key, which is proof the device has the new config.

import type { Env } from "./env";
import * as db from "./db";
import { isWgKey } from "./peers";
import type { AgentReport } from "./state";
import { getSnapshot } from "./state";

/** What the dashboard remembers about the server key (settings key "server_key"). */
export interface KeyRecord {
  pub: string; // the public key last seen in wrangler.toml
  changed_at: string | null; // when it last changed; null if it never has
  previous: string | null; // the key before that
}

const SETTING = "server_key";

function parse(raw: string | null): KeyRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as KeyRecord;
    return r && typeof r.pub === "string" ? r : null;
  } catch {
    return null;
  }
}

/** The first few characters of a key: enough to tell two apart, easy to read. */
export function shortKey(k: string | null): string {
  return k ? `${k.slice(0, 8)}…` : "?";
}

/**
 * Compare wrangler.toml's server public key with the one last seen. The first
 * time, just remember it. If it has changed, record when, flag every client,
 * and write it in Activity. Safe to call from anywhere, as often as you like:
 * only one caller can record a given change.
 */
export async function syncServerKey(env: Env, now = new Date()): Promise<KeyRecord | null> {
  const pub = env.WG_SERVER_PUBLIC_KEY ?? "";
  if (!isWgKey(pub)) return null;
  const raw = await db.getSetting(env, SETTING);
  const rec = parse(raw);
  if (rec && rec.pub === pub) return rec;
  if (!rec) {
    const first: KeyRecord = { pub, changed_at: null, previous: null };
    if (await db.swapSetting(env, SETTING, raw, JSON.stringify(first))) return first;
    return parse(await db.getSetting(env, SETTING));
  }
  const at = now.toISOString();
  const next: KeyRecord = { pub, changed_at: at, previous: rec.pub };
  if (!(await db.swapSetting(env, SETTING, raw, JSON.stringify(next)))) return parse(await db.getSetting(env, SETTING));
  const n = await db.flagPeersForNewConfig(env, at);
  await db.addAlert(
    env,
    "key_rotation",
    `Server key changed: configs now trust ${shortKey(pub)} (was ${shortKey(rec.pub)}). ${n} client${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a new config: press Get config on each on the Clients page. Settings shows who has reconnected.`
  );
  return next;
}

/**
 * From a heartbeat: clear the flag on every flagged client that has shaken
 * hands since the change. Only counts when the VM itself runs the new key
 * (a VM built before the rotation still accepts the old configs).
 */
export async function noteHandshakes(env: Env, report: AgentReport): Promise<void> {
  const rec = await syncServerKey(env);
  if (!rec?.changed_at || report.server_public_key !== rec.pub) return;
  const flagged = await db.peersNeedingConfig(env);
  if (!flagged.length) return;
  const since = Date.parse(rec.changed_at) / 1000;
  const seen = new Map(report.peers.map((p) => [p.public_key, p.latest_handshake]));
  const done = flagged.filter((p) => (seen.get(p.public_key) ?? 0) > since);
  for (const p of done) await db.clearNeedsConfig(env, p.id);
  if (done.length && done.length === flagged.length) {
    await db.addAlert(env, "key_rotation", "Every client has reconnected with the new server key.");
  }
}

/** What the Settings page shows: the change, who has reconnected, and whether the VM is on the new key. */
export interface RotationStatus {
  changedAt: string | null;
  previous: string | null;
  /** The key the VM reports, when one is running; null otherwise. */
  vmKey: string | null;
  clients: { name: string; done: boolean; site: boolean }[];
}

export async function rotationStatus(env: Env): Promise<RotationStatus> {
  const [rec, snap] = await Promise.all([syncServerKey(env), getSnapshot(env)]);
  const vmKey = snap.state === "running" ? snap.agent?.server_public_key ?? null : null;
  if (!rec?.changed_at) return { changedAt: null, previous: null, vmKey, clients: [] };
  const peers = (await db.listPeers(env)).filter((p) => p.created_at < rec.changed_at!);
  return {
    changedAt: rec.changed_at,
    previous: rec.previous,
    vmKey,
    clients: peers.map((p) => ({ name: p.name, done: !p.needs_config, site: !!p.routes })),
  };
}
