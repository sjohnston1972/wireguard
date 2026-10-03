// api-backup.test.ts
//
// Plain English: backups and restore through the JSON API: the export
// download, a nightly copy, and the two-step restore (preview, then type
// "restore").
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import { buildExport, nightlyConfigBackup, MAX_RESTORE_BYTES } from "../src/backup";
import { saveSnapshot } from "../src/state";
import worker from "../src/index";
import * as db from "../src/db";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";
const P256 = "P256SECRETKEY".padEnd(87, "x");

/** Some of everything an export carries, plus things it must not. */
async function seed(env: Env) {
  await db.addPeer(env, { name: "laptop", public_key: KEY_A, ip: "10.13.13.2", full_tunnel: true, tunnel_dns: true });
  await db.addPeer(env, { name: "phone", public_key: KEY_B, ip: "10.13.13.3", full_tunnel: false });
  await db.addForward(env, { name: "web", proto: "tcp", public_port: 8443, target_ip: "10.50.2.4", target_port: 443, allow_from: "" });
  await db.savePushSub(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: P256, auth: "a".repeat(22), label: "Pixel" });
  await db.setSetting(env, "idle_destroy_minutes", "30");
  await db.setSetting(env, "internal_marker", "keep-me");
  await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at, ssh_password) VALUES ('r1', 'apply', 'success', '2026-09-26T00:00:00Z', 'hunter2-secret')").run();
}

/** A raw request with a JSON label, for bodies the helper would not build. */
function raw(env: Env, path: string, text: string, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(base + "/api/v1" + path, { method: "POST", body: text, headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers } }), env, ctx) as Promise<Response>;
}

async function exportFile(env: Env): Promise<Record<string, unknown>> {
  return JSON.parse((await api(env, "GET", "/backup/export")).text);
}

describe("GET /backup/export and /backup/config/:day", () => {
  it("is an attachment with every table and nothing secret", async () => {
    const { env } = apiEnv();
    await seed(env);
    const r = await api(env, "GET", "/backup/export");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toMatch(/^attachment; filename="wg-admin-config-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.json.tables.peers).toHaveLength(2);
    expect(r.json.tables.settings.map((s: { key: string }) => s.key)).toEqual(["idle_destroy_minutes"]);
    expect(r.text).not.toMatch(/hunter2|ssh_password|internal_marker/);
  });

  it("hands out a nightly copy, and says so in JSON when it is gone or the day is not a day", async () => {
    const { env } = apiEnv();
    await seed(env);
    await nightlyConfigBackup(env, new Date("2026-10-01T03:00:00Z"));
    const r = await api(env, "GET", "/backup/config/2026-10-01");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toBe('attachment; filename="wg-admin-config-2026-10-01.json"');
    expect(r.json.kind).toBe("wg-admin-config");
    for (const day of ["2026-09-01", "../secret", "x"]) {
      const gone = await api(env, "GET", `/backup/config/${encodeURIComponent(day)}`);
      expect(gone.status).toBe(404);
      expect(gone.json.error.message).toBe("That nightly export is no longer kept.");
    }
  });
});

describe("restore: preview then confirm", () => {
  it("round trip: preview counts (never the rows), the word 'restore', and it is all back", async () => {
    const { env } = apiEnv();
    await seed(env);
    const file = await exportFile(env);
    const before = await buildExport(env);
    await db.deletePeer(env, 1);
    await db.addPeer(env, { name: "stranger", public_key: "C".repeat(43) + "=", ip: "10.13.13.9", full_tunnel: false });
    await db.setSetting(env, "region", "eastus");

    const p = await api(env, "POST", "/backup/restore/preview", file);
    expect(p.status).toBe(200);
    expect(p.json.token).toMatch(/^[0-9a-f]{64}$/);
    expect(p.json.exportedAt).toBe(file.exported_at);
    expect(p.json.file).toMatchObject({ peers: 2, forwards: 1, push_subs: 1 });
    expect(p.json.current.peers).toBe(2);
    expect(p.json.labels.peers).toBe("Clients");
    for (const leak of [P256, KEY_A, KEY_B, "fcm.googleapis", "laptop"]) expect(p.text).not.toContain(leak);
    expect((await db.listPeers(env)).map((x) => x.name)).toContain("stranger"); // nothing changed yet

    const c = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" });
    expect(c.status).toBe(200);
    expect(c.json.ok).toBe(true);
    expect(c.json.warning).toBeUndefined();
    expect((await buildExport(env)).tables).toEqual(before.tables);
    expect(await db.getSetting(env, "region")).toBeNull();
    expect(await db.getSetting(env, "internal_marker")).toBe("keep-me");
    expect((await db.getRun(env, "r1"))?.ssh_password).toBe("hunter2-secret");
    expect((await audit(env, "config.restore"))).toHaveLength(1);
    expect((await db.listAlerts(env, 5)).some((a) => /Dashboard data restored/.test(a.message))).toBe(true);
    // The upload is used up.
    expect((await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" })).status).toBe(404);
  });

  it("a wrong word is 422 naming confirm, and the preview stays usable", async () => {
    const { env } = apiEnv();
    await seed(env);
    const p = await api(env, "POST", "/backup/restore/preview", await exportFile(env));
    await db.deletePeer(env, 2);
    const w = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "yes" });
    expect(w.status).toBe(422);
    expect(w.json.error).toMatchObject({ code: "confirm_required", field: "confirm" });
    expect(await db.getPeer(env, 2)).toBeNull();
    expect((await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" })).status).toBe(200);
    expect(await db.getPeer(env, 2)).not.toBeNull();
  });

  it("an unknown, malformed or expired token is 404 'expired'; wrong types are 400", async () => {
    const { env } = apiEnv();
    for (const token of ["0".repeat(64), "short"]) {
      const r = await api(env, "POST", "/backup/restore/confirm", { token, confirm: "restore" });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("expired");
    }
    expect((await api(env, "POST", "/backup/restore/confirm", { token: 5, confirm: "restore" })).json.error.field).toBe("token");
    expect((await api(env, "POST", "/backup/restore/confirm", { token: "0".repeat(64), confirm: true })).json.error.field).toBe("confirm");
  });

  it("is blocked (409) while a run is in progress, at preview and at confirm", async () => {
    const { env } = apiEnv();
    await seed(env);
    const file = await exportFile(env);
    const p = await api(env, "POST", "/backup/restore/preview", file);
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at) VALUES ('r2', 'apply', 'running', '2026-09-26T01:00:00Z')").run();
    await db.deletePeer(env, 2);
    const c = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" });
    expect(c.status).toBe(409);
    expect(c.json.error.message).toMatch(/A run is in progress/);
    expect(await db.getPeer(env, 2)).toBeNull();
    expect((await api(env, "POST", "/backup/restore/preview", file)).status).toBe(409);
  });

  it("refuses an oversized body (by length and by Content-Length) and a file that is not an export, with 400", async () => {
    const { env } = apiEnv();
    const big = JSON.stringify({ pad: "x".repeat(MAX_RESTORE_BYTES) });
    expect((await raw(env, "/backup/restore/preview", big)).status).toBe(400);
    const lied = await raw(env, "/backup/restore/preview", "{}", { "Content-Length": String(MAX_RESTORE_BYTES + 20_000) }).catch(() => null);
    if (lied) expect(lied.status).toBe(400);
    const notExport = await api(env, "POST", "/backup/restore/preview", { kind: "other" });
    expect(notExport.status).toBe(400);
    expect(notExport.json.error.message).toBe("That is not a wg-admin config export.");
    expect((await raw(env, "/backup/restore/preview", "not json")).status).toBe(400);
    expect((await raw(env, "/backup/restore/preview", "{}", { "Content-Type": "text/plain" })).status).toBe(400);
    expect((await api(env, "POST", "/backup/restore/preview")).status).toBe(400);
  });

  it("a file the database refuses is 400 'Nothing was changed' and changes nothing", async () => {
    const { env } = apiEnv();
    await seed(env);
    const exp = await exportFile(env);
    const peers = (exp.tables as { peers: { ip: string }[] }).peers;
    peers[1].ip = peers[0].ip; // passes the checks, fails the database's UNIQUE rule part-way
    await db.deletePeer(env, 2);
    const p = await api(env, "POST", "/backup/restore/preview", exp);
    expect(p.status).toBe(200);
    const c = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" });
    expect(c.status).toBe(400);
    expect(c.json.error.message).toMatch(/^Nothing was changed: /);
    expect((await db.listPeers(env)).map((x) => x.name)).toEqual(["laptop"]);
    expect((await audit(env, "config.restore"))).toHaveLength(0);
  });

  it("with a VM up and Azure refusing the published ports: 200 with a warning, restore still done", async () => {
    const { env, world } = apiEnv();
    await seed(env);
    const p = await api(env, "POST", "/backup/restore/preview", await exportFile(env));
    await saveSnapshot(env, { state: "running" });
    world.azure.rg = false; // Azure answers 404 to the edge update
    const c = await api(env, "POST", "/backup/restore/confirm", { token: p.json.token, confirm: "restore" });
    expect(c.status).toBe(200);
    expect(c.json.ok).toBe(true);
    expect(c.json.warning).toMatch(/published ports/i);
    expect((await audit(env, "config.restore"))).toHaveLength(1);
  });
});

async function audit(env: Env, action: string) {
  return (await env.DB.prepare("SELECT * FROM audit WHERE action = ?1").bind(action).all()).results;
}
