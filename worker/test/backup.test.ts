import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { buildExport, checkRestoreFile, nightlyConfigBackup, backupStatus, EXPORT_KIND, EXPORT_VERSION, KEEP_CONFIG_BACKUPS } from "../src/backup";

// Backups (issue #46): the dashboard's data exported, the nightly copy in
// R2, and a restore that puts it all back exactly, in one go.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const BASE = "http://localhost:8787";
const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";

function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(BASE + path, { ...init, headers: { "Sec-Fetch-Site": "same-origin", ...(init.headers ?? {}) } }), env, ctx) as Promise<Response>;
}

function upload(env: Env, text: string, name = "wg-admin-config-2026-09-26.json"): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([text], name, { type: "application/json" }));
  return call(env, "/settings/backup/restore", { method: "POST", body: form });
}

function confirm(env: Env, token: string, word: string): Promise<Response> {
  return call(env, "/settings/backup/restore/confirm", { method: "POST", body: new URLSearchParams({ token, confirm: word }), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
}

/** Some of everything an export carries, plus things it must not. */
async function seed(env: Env) {
  const p = await db.addPeer(env, { name: "laptop", public_key: KEY_A, ip: "10.13.13.2", full_tunnel: true, tunnel_dns: true });
  await db.addPeer(env, { name: "phone", public_key: KEY_B, ip: "10.13.13.3", full_tunnel: false });
  await db.addFwRule(env, { enabled: 1, name: "Laptop to web", src_kind: "client", src_value: String(p.id), dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "443", action: "allow", log: 1 });
  await db.addForward(env, { name: "web", proto: "tcp", public_port: 8443, target_ip: "10.50.2.4", target_port: 443, allow_from: "" });
  await db.addProfile(env, { name: "Japan", region: "japaneast", vm_size: "Standard_B1s" });
  await db.addSchedule(env, { days: "12345", start_time: "08:00", end_time: "18:00", profile_id: 1 });
  await db.savePushSub(env, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "B".repeat(87), auth: "a".repeat(22), label: "Pixel" });
  await db.setSetting(env, "idle_destroy_minutes", "30");
  await db.setSetting(env, "firewall_default", "allow");
  await db.setSetting(env, "internal_marker", "keep-me");
  await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at, ssh_password, callback_token_hash) VALUES ('r1', 'apply', 'success', '2026-09-26T00:00:00Z', 'hunter2-secret', 'deadbeef')").run();
}

describe("dashboard data backup and restore (issue #46)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: BASE }).env;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await seed(env);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Download export is an attachment with every table and nothing secret", async () => {
    const r = await call(env, "/settings/backup/export");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toMatch(/^attachment; filename="wg-admin-config-\d{4}-\d{2}-\d{2}\.json"$/);
    const text = await r.text();
    const exp = JSON.parse(text);
    expect(exp.kind).toBe(EXPORT_KIND);
    expect(exp.version).toBe(EXPORT_VERSION);
    expect(exp.tables.peers).toHaveLength(2);
    expect(exp.tables.fw_rules.length).toBeGreaterThan(5);
    expect(exp.tables.forwards).toHaveLength(1);
    expect(exp.tables.push_subs).toHaveLength(1);
    expect(exp.tables.settings.map((s: { key: string }) => s.key).sort()).toEqual(["firewall_default", "idle_destroy_minutes"]);
    expect(text).not.toMatch(/hunter2|deadbeef|ssh_password|internal_marker/);
  });

  it("round trip: export, change things, restore, and it is all back exactly", async () => {
    const before = await buildExport(env);
    const file = await (await call(env, "/settings/backup/export")).text();

    // Things change after the export...
    await db.deletePeer(env, 1);
    await db.addPeer(env, { name: "stranger", public_key: "C".repeat(43) + "=", ip: "10.13.13.9", full_tunnel: false });
    await db.addFwRule(env, { enabled: 1, name: "Extra", src_kind: "any", src_value: "", dst_kind: "any", dst_value: "", proto: "any", ports: "", action: "deny", log: 0 });
    await db.deleteProfile(env, 4);
    await db.setSetting(env, "idle_destroy_minutes", "90");
    await db.setSetting(env, "region", "eastus");

    // ...step one shows the preview and changes nothing.
    const r = await upload(env, file);
    expect(r.status).toBe(200);
    const page = await r.text();
    expect(page).toContain("Type <kbd>restore</kbd> to confirm");
    expect(page).toContain("Clients");
    const token = page.match(/name="token" value="([0-9a-f]{64})"/)![1];
    expect((await db.listPeers(env)).map((p) => p.name)).toContain("stranger");

    // The wrong word does nothing.
    const wrong = await (await confirm(env, token, "yes")).text();
    expect(wrong).toContain("Not restored: type &quot;restore&quot; to confirm");
    expect(wrong).toContain(`value="${token}"`); // the preview stays, no need to upload again
    expect((await db.listPeers(env)).map((p) => p.name)).toContain("stranger");

    const done = await confirm(env, token, "restore");
    expect(done.status).toBe(302);
    expect(done.headers.get("Location")).toBe("/settings?restored=1");

    const after = await buildExport(env);
    expect(after.tables).toEqual(before.tables);
    expect(await db.getSetting(env, "region")).toBeNull(); // not in the file: back to the default
    expect(await db.getSetting(env, "internal_marker")).toBe("keep-me"); // internal: untouched
    expect((await db.getRun(env, "r1"))?.ssh_password).toBe("hunter2-secret"); // runs are not touched

    // The upload is used up.
    expect(await (await confirm(env, token, "restore")).text()).toContain("expired");
  });

  it("refuses to restore while a run is in progress", async () => {
    const file = await (await call(env, "/settings/backup/export")).text();
    const page = await (await upload(env, file)).text();
    const token = page.match(/name="token" value="([0-9a-f]{64})"/)![1];
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at) VALUES ('r2', 'apply', 'running', '2026-09-26T01:00:00Z')").run();
    await db.deletePeer(env, 2);
    expect(await (await confirm(env, token, "restore")).text()).toContain("A run is in progress");
    expect(await db.getPeer(env, 2)).toBeNull();
    expect(await (await upload(env, file)).text()).toContain("A run is in progress");
  });

  it("a file the database refuses changes nothing at all", async () => {
    const exp = await buildExport(env);
    // Two clients with the same address: passes the checks, fails the database's UNIQUE rule part-way.
    exp.tables.peers[1].ip = exp.tables.peers[0].ip;
    await db.deletePeer(env, 2);
    const page = await (await upload(env, JSON.stringify(exp))).text();
    const token = page.match(/name="token" value="([0-9a-f]{64})"/)![1];
    expect(await (await confirm(env, token, "restore")).text()).toContain("Nothing was changed");
    expect((await db.listPeers(env)).map((p) => p.name)).toEqual(["laptop"]);
    expect((await db.listFwRules(env)).length).toBe(exp.tables.fw_rules.length);
  });

  it("checks the file before anything is touched", async () => {
    const good = await buildExport(env);
    const bad = (f: (e: any) => void) => {
      const e = structuredClone(good) as any;
      f(e);
      return JSON.stringify(e);
    };
    expect(await checkRestoreFile(env, "not json")).toMatch(/not JSON/);
    expect(await checkRestoreFile(env, bad((e) => (e.kind = "other")))).toMatch(/not a wg-admin config export/);
    expect(await checkRestoreFile(env, bad((e) => (e.version = 99)))).toMatch(/newer wg-admin/);
    expect(await checkRestoreFile(env, bad((e) => delete e.tables.schedules))).toMatch(/missing the Schedules/);
    expect(await checkRestoreFile(env, bad((e) => (e.tables.peers[0].evil = "x")))).toMatch(/does not know/);
    expect(await checkRestoreFile(env, bad((e) => (e.tables.peers[0].public_key = "nope")))).toMatch(/WireGuard public key/);
    expect(await checkRestoreFile(env, bad((e) => delete e.tables.peers[0].name))).toMatch(/missing "name"/);
    expect(await checkRestoreFile(env, bad((e) => e.tables.settings.push({ key: "internal_marker", value: "x" })))).toMatch(/not a setting/);
    expect(await checkRestoreFile(env, bad((e) => (e.tables.settings[0].value = "sometimes")))).toMatch(/does not look right/);
    expect(await checkRestoreFile(env, bad((e) => (e.tables.fw_rules[0].name = { a: 1 })))).toMatch(/not plain text/);
    expect(typeof (await checkRestoreFile(env, JSON.stringify(good)))).toBe("object");
    expect(await (await upload(env, "{}")).text()).toContain("not a wg-admin config export");
  });

  it("a restore from another site is refused", async () => {
    const r = await worker.fetch(new Request(BASE + "/settings/backup/restore/confirm", { method: "POST", body: new URLSearchParams({ token: "0".repeat(64), confirm: "restore" }), headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/x-www-form-urlencoded" } }), env, ctx);
    expect(r.status).toBe(403);
  });
});

describe("backups in R2 (issue #46)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: BASE }).env;
    await seed(env);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes one export a day and keeps the newest 30", async () => {
    const day0 = Date.parse("2026-08-01T03:00:00Z");
    for (let i = 0; i < 33; i++) expect(await nightlyConfigBackup(env, new Date(day0 + i * 86_400_000))).toMatch(/written/);
    expect(await nightlyConfigBackup(env, new Date(day0 + 32 * 86_400_000 + 3_600_000))).toBeNull(); // same day again: nothing
    const s = await backupStatus(env, true);
    expect(s.config.count).toBe(KEEP_CONFIG_BACKUPS);
    expect(s.config.days[0]).toBe("2026-09-02");
    expect(s.config.days.at(-1)).toBe("2026-08-04");
    // The nightly copy can be downloaded, and restored.
    const r = await call(env, "/settings/backup/config/2026-09-02");
    expect(r.headers.get("Content-Disposition")).toContain("wg-admin-config-2026-09-02.json");
    expect(typeof (await checkRestoreFile(env, await r.text()))).toBe("object");
    expect((await call(env, "/settings/backup/config/2026-01-01")).status).toBe(404);
    expect((await call(env, "/settings/backup/config/..%2Fbackups")).status).toBe(404);
  });

  it("counts the Terraform state backups and shows them on Settings", async () => {
    expect((await backupStatus(env, true)).state).toEqual({ count: 0, newest: null });
    await env.STATE.put("backups/20260925T100000Z-apply.tfstate", "{}");
    await env.STATE.put("backups/20260926T100000Z-destroy.tfstate", "{}");
    await env.STATE.put("wg-admin/terraform.tfstate", "{}");
    const s = await backupStatus(env, true);
    expect(s.state.count).toBe(2);
    expect(s.state.newest).not.toBeNull();
    const page = await (await call(env, "/settings")).text();
    expect(page).toContain("Backups");
    expect(page).toMatch(/Terraform state <span class="muted small">2 kept, newest/);
    expect(page).toContain('href="/settings/backup/export"');
  });
});
