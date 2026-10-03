// The change log (issue #45): every configuration change from the dashboard
// is written down with who made it and the before/after, secrets never are,
// and the watchman trims it. (The Activity screen's filtering and paging are
// pinned in api-activity.test.ts; the other changes' entries in the area
// tests: api-clients, api-firewall, api-fwdraft, api-settings, api-push.)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import { api } from "./api-helpers";
import * as db from "../src/db";
import { runScheduled } from "../src/monitor";
import { describeChange } from "../src/activity";

const BASE = "http://localhost:8787";
const USER = "dev@localhost"; // who the dev login switch-off says you are
const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";

let env: Env;
beforeEach(() => {
  env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: BASE }).env;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The change log, oldest first, with the JSON read back. */
async function log() {
  return (await db.listAudit(env, { limit: 200 })).reverse().map((r) => ({ ...r, before: r.before_json && JSON.parse(r.before_json), after: r.after_json && JSON.parse(r.after_json) }));
}

describe("clients", () => {
  it("add, edit, disable, re-key and delete are each logged with who and what", async () => {
    const add = await api(env, "POST", "/clients", { name: "Phone", public_key: KEY_A });
    expect(add.status).toBe(200);
    const id = add.json.peer.id;
    await api(env, "PUT", `/clients/${id}`, { tunnel_dns: true });
    await api(env, "PUT", `/clients/${id}`, { enabled: false });
    await api(env, "POST", `/clients/${id}/rekey`, { public_key: KEY_B });
    await api(env, "DELETE", `/clients/${id}`);

    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["client.add", "client.edit", "client.disable", "client.rekey", "client.delete"]);
    expect(rows.every((r) => r.user === USER && r.target === "Phone")).toBe(true);
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toMatchObject({ name: "Phone", public_key: KEY_A, enabled: 1 });
    // An edit keeps only what changed.
    expect(rows[1].before).toEqual({ tunnel_dns: 0 });
    expect(rows[1].after).toEqual({ tunnel_dns: 1 });
    expect(rows[2].after).toEqual({ enabled: 0 });
    expect(rows[3].before).toEqual({ public_key: KEY_A });
    expect(rows[3].after).toEqual({ public_key: KEY_B });
    expect(rows[4].before).toMatchObject({ name: "Phone", public_key: KEY_B });
    expect(rows[4].after).toBeNull();
  });

  it("a failed add is not logged", async () => {
    await api(env, "POST", "/clients", { name: "Phone", public_key: "nope" });
    expect(await log()).toEqual([]);
  });
});

describe("settings", () => {
  it("a settings save logs just the fields that changed; a save that changes nothing is skipped", async () => {
    await api(env, "PUT", "/settings", { monthly_budget_gbp: 25, region: "uksouth" });
    await api(env, "PUT", "/settings", { monthly_budget_gbp: 25, region: "uksouth" });
    await api(env, "PUT", "/settings", { monthly_budget_gbp: 30, region: "uksouth" });
    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["settings.save", "settings.save"]);
    expect(rows[0].after).toEqual({ monthly_budget_gbp: "25", region: "uksouth" });
    expect(rows[1].before).toEqual({ monthly_budget_gbp: "25" });
    expect(rows[1].after).toEqual({ monthly_budget_gbp: "30" });
  });
});

describe("secrets never reach the change log", () => {
  it("scrubs keys, passwords and tokens at any depth", async () => {
    await db.audit(env, "me", "config.restore", "backup", { private_key: "PRIV", nested: { ssh_password: "pw", callback_token_hash: "h" } }, { name: "x", list: [{ api_token: "t" }], preshared_key: "psk" });
    const raw = (await db.listAudit(env))[0];
    const text = `${raw.before_json} ${raw.after_json}`;
    for (const secret of ["PRIV", '"pw"', '"h"', '"t"', "psk\""]) expect(text).not.toContain(secret);
    expect(JSON.parse(raw.after_json!)).toMatchObject({ name: "x", list: [{ api_token: "(hidden)" }], preshared_key: "(hidden)" });
  });

  it("removing a phone keeps its label but not its push keys or address", async () => {
    await api(env, "POST", "/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijkl", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }, label: "Pixel" });
    const sub = (await db.listPushSubs(env))[0];
    expect(sub).toBeTruthy();
    await api(env, "DELETE", `/push/${sub.id}`);
    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["push.add", "push.remove"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("B".repeat(87));
    expect(text).not.toContain("a".repeat(22));
    expect(text).not.toContain("fcm.googleapis.com");
    expect(rows[1].target).toBe("Pixel");
  });

  it("a logging failure never breaks the change itself", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => (sql.startsWith("INSERT INTO audit") ? { bind: () => ({ run: async () => { throw new Error("disk full"); } }) } : real(sql))) as typeof env.DB.prepare;
    const r = await api(env, "POST", "/clients", { name: "Laptop", public_key: KEY_A });
    expect(r.status).toBe(200);
    expect((await db.listPeers(env)).map((p) => p.name)).toEqual(["Laptop"]);
  });
});

describe("describing a change", () => {
  it("describes adds, edits and deletes in plain lines", () => {
    expect(describeChange(null, '{"name":"Phone"}')).toEqual(["name = Phone"]);
    expect(describeChange('{"enabled":1}', '{"enabled":0}')).toEqual(["enabled: 1 → 0"]);
    expect(describeChange('{"name":"Phone"}', null)).toEqual(["removed; it was:", "name = Phone"]);
    expect(describeChange(null, null)).toEqual([]);
  });
});

describe("retention", () => {
  it("keeps the newest 1000 rows and nothing older than 180 days, trimmed by the watchman", async () => {
    const ins = (at: string, i: number) => env.DB.prepare("INSERT INTO audit (at, user, action, target) VALUES (?1, 'me', 'client.edit', ?2)").bind(at, `r${i}`).run();
    await ins(new Date(Date.now() - 200 * 86_400_000).toISOString(), -1);
    const base = Date.now() - 86_400_000;
    for (let i = 0; i < 1005; i++) await ins(new Date(base + i * 1000).toISOString(), i);
    await runScheduled(env);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first<{ n: number }>();
    expect(count!.n).toBe(db.AUDIT_KEEP_ROWS);
    const oldest = await env.DB.prepare("SELECT target FROM audit ORDER BY at LIMIT 1").first<{ target: string }>();
    expect(oldest!.target).toBe("r5"); // r-1 was too old; r0-r4 were the extra rows
  });
});
