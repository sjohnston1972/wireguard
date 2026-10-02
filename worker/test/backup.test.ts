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
    const r = await call(env, "/api/v1/backup/config/2026-09-02");
    expect(r.headers.get("Content-Disposition")).toContain("wg-admin-config-2026-09-02.json");
    expect(typeof (await checkRestoreFile(env, await r.text()))).toBe("object");
    expect((await call(env, "/api/v1/backup/config/2026-01-01")).status).toBe(404);
    expect((await call(env, "/api/v1/backup/config/..%2Fbackups")).status).toBe(404);
  });

  it("counts the Terraform state backups", async () => {
    expect((await backupStatus(env, true)).state).toEqual({ count: 0, newest: null });
    await env.STATE.put("backups/20260925T100000Z-apply.tfstate", "{}");
    await env.STATE.put("backups/20260926T100000Z-destroy.tfstate", "{}");
    await env.STATE.put("wg-admin/terraform.tfstate", "{}");
    const s = await backupStatus(env, true);
    expect(s.state.count).toBe(2);
    expect(s.state.newest).not.toBeNull();
  });
});
