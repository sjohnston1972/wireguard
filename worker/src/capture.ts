// capture.ts
//
// Plain English: packet captures on the WireGuard VM, for Wireshark. The
// dashboard asks (the request rides back on the next heartbeat reply), the
// VM runs tcpdump for the chosen time, compresses the file and sends it here,
// and it is kept in R2 under captures/ for download. Only the ten most recent
// are kept. Like "monitor capture ... export" on a router, but the file lands
// in the browser.

import type { Env } from "./env";
import * as db from "./db";
import { getSnapshot, saveSnapshot } from "./state";
import { RunError } from "./runs";
import { randomToken, sha256Hex } from "./auth";
import { CAPTURE_IFACES } from "./firewall";

export { CAPTURE_IFACES };
const KEEP = 10;

/** A BPF filter from the page: only the characters filters are made of, and short. */
export function validFilter(f: string): boolean {
  return f.length <= 200 && /^[A-Za-z0-9 .:/()!&|=<>\-\[\]]*$/.test(f);
}

export async function startCapture(env: Env, o: { iface: string; filter: string; seconds: number; by: string }): Promise<string> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running") throw new RunError("Nothing is running.");
  if (snap.capture_req) throw new RunError("A capture is already running.");
  if (!(o.iface in CAPTURE_IFACES)) throw new RunError("Unknown interface.");
  if (!validFilter(o.filter)) throw new RunError("That filter has characters a capture filter never needs.");
  const seconds = Math.min(300, Math.max(5, Math.round(o.seconds)));
  const id = randomToken().slice(0, 16);
  await db.addCapture(env, { id, requested_by: o.by, iface: o.iface, filter: o.filter, seconds });
  await saveSnapshot(env, { capture_req: { id, iface: o.iface, filter: o.filter, seconds, at: new Date().toISOString() } });
  return `Capture started: ${seconds} s ${o.iface === "any" ? "on both sides" : o.iface === "wg0" ? "inside the tunnel" : "on the Azure side"}${o.filter ? ` (${o.filter})` : ""}. It appears below when done.`;
}

/** The VM's upload. Authenticated with the deployment's agent token, like the heartbeat. */
export async function receiveCapture(env: Env, token: string, id: string, body: ArrayBuffer, error: string | null): Promise<{ status: number; text: string }> {
  if (!token) return { status: 401, text: "no token" };
  const run = await env.DB.prepare("SELECT id FROM runs WHERE action = 'apply' AND agent_token_hash = ?1 ORDER BY requested_at DESC LIMIT 1").bind(await sha256Hex(token)).first<{ id: string }>();
  if (!run) return { status: 401, text: "unknown token" };
  const cap = await db.getCapture(env, id);
  if (!cap || cap.status === "done" || cap.status === "failed") return { status: 404, text: "no such capture waiting" };
  const snap = await getSnapshot(env);
  if (snap.capture_req?.id === id) await saveSnapshot(env, { capture_req: null });
  const now = new Date().toISOString();
  if (error || !body.byteLength) {
    await db.updateCapture(env, id, { status: "failed", finished_at: now, error: (error || "the VM sent an empty file").slice(0, 300) });
    return { status: 200, text: "noted" };
  }
  await env.STATE.put(`captures/${id}.pcap.gz`, body, { httpMetadata: { contentType: "application/gzip" } });
  await db.updateCapture(env, id, { status: "done", finished_at: now, bytes: body.byteLength });
  // Keep the ten newest; the rest go.
  const old = (await db.listCaptures(env, 100)).slice(KEEP);
  for (const c of old) {
    await env.STATE.delete(`captures/${c.id}.pcap.gz`);
    await env.DB.prepare("DELETE FROM captures WHERE id = ?1").bind(c.id).run();
  }
  return { status: 200, text: "stored" };
}
