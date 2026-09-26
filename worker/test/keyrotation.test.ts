// Server key rotation, on the harness: the Worker notices wrangler.toml's
// public key change, flags every client, and ticks each one off at its first
// handshake with a VM that runs the new key.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { syncServerKey, rotationStatus } from "../src/keyrotation";
import { runScheduled } from "../src/monitor";
import { peersTable } from "../src/views/peers";
import { settingsBody } from "../src/views/settings";
import { effectiveConfig } from "../src/settings";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const OLD = "wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc="; // the harness's key
const NEW = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const PHONE = "P".repeat(43) + "=";
const LAPTOP = "L".repeat(43) + "=";
const DUMP = (server: string, lines: string[]) => ["(hidden)\t" + server + "\t51820\toff", ...lines].join("\n");
const peerLine = (key: string, ip: string, handshake: number) => `${key}\t(none)\t1.2.3.4:5\t${ip}/32\t${handshake}\t10\t20\t25`;

async function toRunning() {
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

async function twoClients() {
  const phone = await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const laptop = await db.addPeer(env, { name: "Laptop", public_key: LAPTOP, ip: "10.13.13.3", full_tunnel: false });
  return { phone, laptop };
}

const rotationAlerts = async () => (await db.listAlerts(env, 50)).filter((a) => a.kind === "key_rotation");

describe("server key rotation", () => {
  it("the first sighting of a key is just remembered: no flags, no alert", async () => {
    await twoClients();
    const rec = await syncServerKey(env);
    expect(rec).toMatchObject({ pub: OLD, changed_at: null });
    expect(await db.peersNeedingConfig(env)).toEqual([]);
    expect(await rotationAlerts()).toEqual([]);
  });

  it("a new key flags every client once, and says so in Activity once", async () => {
    await twoClients();
    await syncServerKey(env);
    await new Promise((r) => setTimeout(r, 5)); // clients made strictly before the change
    env.WG_SERVER_PUBLIC_KEY = NEW;
    // Two requests noticing at the same moment still record it once.
    await Promise.all([syncServerKey(env), syncServerKey(env), runScheduled(env)]);
    expect((await db.peersNeedingConfig(env)).map((p) => p.name)).toEqual(["Phone", "Laptop"]);
    const alerts = await rotationAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/Server key changed.*2 clients need a new config/);
    const st = await rotationStatus(env);
    expect(st.previous).toBe(OLD);
    expect(st.clients).toEqual([
      { name: "Phone", done: false, site: false },
      { name: "Laptop", done: false, site: false },
    ]);
  });

  it("the cron notices the change on its own", async () => {
    await twoClients();
    await runScheduled(env);
    await new Promise((r) => setTimeout(r, 5));
    env.WG_SERVER_PUBLIC_KEY = NEW;
    await runScheduled(env);
    expect(await db.peersNeedingConfig(env)).toHaveLength(2);
  });

  it("clears each client at its first handshake with a VM on the new key, and only then", async () => {
    const { phone } = await twoClients();
    const token = await toRunning(); // the heartbeat-to-be remembers OLD
    await syncServerKey(env);
    await new Promise((r) => setTimeout(r, 5));
    env.WG_SERVER_PUBLIC_KEY = NEW;
    const rec = (await syncServerKey(env))!;
    const since = Math.floor(Date.parse(rec.changed_at!) / 1000);

    // The VM was built before the rotation: old configs still connect to it, which proves nothing.
    await handleAgent(env, token, { dump: DUMP(OLD, [peerLine(PHONE, "10.13.13.2", since + 30)]) });
    expect(await db.peersNeedingConfig(env)).toHaveLength(2);
    const st = await rotationStatus(env);
    expect(st.vmKey).toBe(OLD);

    // On the new key: the phone has shaken hands since the change, the laptop's handshake is older.
    await handleAgent(env, token, { dump: DUMP(NEW, [peerLine(PHONE, "10.13.13.2", since + 30), peerLine(LAPTOP, "10.13.13.3", since - 60)]) });
    expect((await db.peersNeedingConfig(env)).map((p) => p.name)).toEqual(["Laptop"]);
    expect((await db.getPeer(env, phone.id))!.needs_config).toBe(0);
    expect((await rotationStatus(env)).clients).toEqual([
      { name: "Phone", done: true, site: false },
      { name: "Laptop", done: false, site: false },
    ]);

    // A re-keyed laptop (Get config) connects: the last one, so Activity says everyone is done.
    const LAPTOP2 = "M".repeat(43) + "=";
    const laptop = (await db.listPeers(env)).find((p) => p.name === "Laptop")!;
    await db.setPeerKey(env, laptop.id, LAPTOP2);
    await handleAgent(env, token, { dump: DUMP(NEW, [peerLine(LAPTOP2, "10.13.13.3", since + 90)]) });
    expect(await db.peersNeedingConfig(env)).toEqual([]);
    expect((await rotationAlerts()).map((a) => a.message)).toContain("Every client has reconnected with the new server key.");
  });

  it("clients added after the change are not flagged and not on the checklist", async () => {
    await twoClients();
    await syncServerKey(env);
    await new Promise((r) => setTimeout(r, 5));
    env.WG_SERVER_PUBLIC_KEY = NEW;
    await syncServerKey(env);
    await new Promise((r) => setTimeout(r, 5));
    await db.addPeer(env, { name: "Tablet", public_key: "T".repeat(43) + "=", ip: "10.13.13.4", full_tunnel: false });
    expect((await db.peersNeedingConfig(env)).map((p) => p.name)).toEqual(["Phone", "Laptop"]);
    expect((await rotationStatus(env)).clients.map((c) => c.name)).toEqual(["Phone", "Laptop"]);
  });

  it("the Clients table marks flagged clients", async () => {
    await twoClients();
    await syncServerKey(env);
    await new Promise((r) => setTimeout(r, 5));
    env.WG_SERVER_PUBLIC_KEY = NEW;
    await syncServerKey(env);
    const phone = (await db.listPeers(env)).find((p) => p.name === "Phone")!;
    await db.clearNeedsConfig(env, phone.id);
    const out = String(await peersTable(await db.listPeers(env), null, false));
    expect(out.match(/needs new config<\/span>/g)?.length).toBe(2); // the laptop: desktop row and phone sheet
  });

  it("Settings shows the guide, the checklist, and a warning while the VM runs the old key", async () => {
    const cfg = await effectiveConfig(env);
    const base = { cfg, overrides: {}, missing: {}, lock: { held: false, lock: null }, serverPub: NEW, repo: null, webhook: false };
    const before = String(await settingsBody({ ...base, rotation: { changedAt: null, previous: null, vmKey: null, clients: [] } }));
    expect(before).toContain("Rotate the server key");
    expect(before).toContain("npm run keys -- --rotate");
    expect(before).not.toContain("Since the key changed");
    const after = String(await settingsBody({ ...base, rotation: { changedAt: new Date().toISOString(), previous: OLD, vmKey: OLD, clients: [{ name: "Phone", done: true, site: false }, { name: "home-site", done: false, site: true }] } }));
    expect(after).toContain("1 of 2 clients reconnected");
    expect(after).toContain("The running VM still uses the old key");
    expect(after).toContain("npm run home -- --down");
  });

  it("ignores a missing or malformed key rather than recording it", async () => {
    env.WG_SERVER_PUBLIC_KEY = "";
    expect(await syncServerKey(env)).toBeNull();
    expect(await db.getSetting(env, "server_key")).toBeNull();
  });
});
