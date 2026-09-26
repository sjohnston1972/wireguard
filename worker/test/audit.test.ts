// The change log (issue #45): every configuration change from the dashboard
// is written down with who made it and the before/after, secrets never are,
// the Activity page shows it filtered and paged, and the watchman trims it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { runScheduled } from "../src/monitor";
import { acquireLock } from "../src/lock";
import { describeChange } from "../src/views/activity";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
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

function post(path: string, form: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(
    new Request(BASE + path, { method: "POST", body: new URLSearchParams(form).toString(), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" } }),
    env,
    ctx
  ) as Promise<Response>;
}

function postJson(path: string, body: unknown): Promise<Response> {
  return worker.fetch(new Request(BASE + path, { method: "POST", body: JSON.stringify(body), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" } }), env, ctx) as Promise<Response>;
}

async function get(path: string): Promise<string> {
  const r = (await worker.fetch(new Request(BASE + path), env, ctx)) as Response;
  expect(r.status).toBe(200);
  return r.text();
}

/** The change log, oldest first, with the JSON read back. */
async function log() {
  return (await db.listAudit(env, { limit: 200 })).reverse().map((r) => ({ ...r, before: r.before_json && JSON.parse(r.before_json), after: r.after_json && JSON.parse(r.after_json) }));
}

describe("clients", () => {
  it("add, edit, disable, re-key and delete are each logged with who and what", async () => {
    const add = await postJson("/api/peers", { name: "Phone", public_key: KEY_A });
    expect(add.status).toBe(200);
    const id = ((await add.json()) as { peer: { id: number } }).peer.id;
    await post(`/peers/${id}/dns`);
    await post(`/peers/${id}/toggle`);
    await postJson(`/api/peers/${id}/rekey`, { public_key: KEY_B });
    await post(`/peers/${id}/delete`);

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
    await postJson("/api/peers", { name: "Phone", public_key: "nope" });
    expect(await log()).toEqual([]);
  });
});

describe("firewall", () => {
  it("rule add, move, toggle, delete and the default are logged", async () => {
    await post("/firewall/rules", { name: "First", from: "any", to: "any", proto: "any" });
    await post("/firewall/rules", { name: "Second", from: "any", to: "any", proto: "tcp", ports: "443" });
    const all = await db.listFwRules(env);
    const second = all.find((r) => r.name === "Second")!;
    const place = all.indexOf(second) + 1; // 1 = checked first; the seeded rules come before
    await post(`/firewall/rules/${second.id}/up`);
    await post(`/firewall/rules/${second.id}/toggle`);
    await post(`/firewall/rules/${second.id}/delete`);
    await post("/firewall/default", { value: "allow" });

    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["firewall.rule.add", "firewall.rule.add", "firewall.rule.move", "firewall.rule.disable", "firewall.rule.delete", "firewall.default"]);
    expect(rows[1].after).toMatchObject({ name: "Second", proto: "tcp", ports: "443" });
    expect(rows[2].before).toMatchObject({ place });
    expect(rows[2].after).toMatchObject({ place: place - 1 });
    expect(rows[3].after).toEqual({ enabled: 0 });
    expect(rows[4].target).toBe("Second");
    expect(rows[5]).toMatchObject({ before: { firewall_default: "deny" }, after: { firewall_default: "allow" } });
  });

  it("moving the top rule up changes nothing, so nothing is logged", async () => {
    await post("/firewall/rules", { name: "Only", from: "any", to: "any", proto: "any" });
    const only = (await db.listFwRules(env))[0];
    await post(`/firewall/rules/${only.id}/up`);
    expect((await log()).map((r) => r.action)).toEqual(["firewall.rule.add"]);
  });

  it("published ports: add, disable, delete", async () => {
    await post("/firewall/forwards", { name: "Web", proto: "tcp", public_port: "8443", target_ip: "10.50.2.4", target_port: "443" });
    const f = (await db.listForwards(env))[0];
    await post(`/firewall/forwards/${f.id}/toggle`);
    await post(`/firewall/forwards/${f.id}/delete`);
    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["firewall.forward.add", "firewall.forward.disable", "firewall.forward.delete"]);
    expect(rows[0].target).toBe("Web (TCP 8443)");
  });
});

describe("settings, profiles, schedules, lock", () => {
  it("a settings save logs just the fields that changed; a save that changes nothing is skipped", async () => {
    await post("/settings", { monthly_budget_gbp: "25", region: "uksouth" });
    await post("/settings", { monthly_budget_gbp: "25", region: "uksouth" });
    await post("/settings", { monthly_budget_gbp: "30", region: "uksouth" });
    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["settings.save", "settings.save"]);
    expect(rows[0].after).toEqual({ monthly_budget_gbp: "25", region: "uksouth" });
    expect(rows[1].before).toEqual({ monthly_budget_gbp: "25" });
    expect(rows[1].after).toEqual({ monthly_budget_gbp: "30" });
  });

  it("profiles and schedules: create, toggle, delete; lock release", async () => {
    await post("/settings/profiles", { name: "Asia", region: "eastasia", vm_size: "Standard_B1s" });
    const p = (await db.listProfiles(env)).find((x) => x.name === "Asia")!;
    await post(`/settings/profiles/${p.id}/delete`);
    await post("/settings/schedules", { day: "1", start: "09:00", end: "17:00" });
    const s = (await db.listSchedules(env))[0];
    await post(`/settings/schedules/${s.id}/toggle`);
    await post(`/settings/schedules/${s.id}/delete`);
    await post("/settings/release-lock"); // nothing held: nothing changed, nothing logged
    await acquireLock(env, "run-stuck");
    await post("/settings/release-lock");
    const rows = await log();
    expect(rows.map((r) => r.action)).toEqual(["profile.add", "profile.delete", "schedule.add", "schedule.disable", "schedule.delete", "lock.release"]);
    expect(rows[1]).toMatchObject({ target: "Asia", before: { name: "Asia", region: "eastasia" }, after: null });
    expect(rows[2].target).toBe("days 1, 09:00–17:00");
    expect(rows[5]).toMatchObject({ target: "run-stuck", after: { held: false, lock: null } });
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
    await postJson("/api/push/subscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/abcdefghijkl", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) }, label: "Pixel" });
    const sub = (await db.listPushSubs(env))[0];
    expect(sub).toBeTruthy();
    await post(`/settings/push/${sub.id}/delete`);
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
    const r = await postJson("/api/peers", { name: "Laptop", public_key: KEY_A });
    expect(r.status).toBe(200);
    expect((await db.listPeers(env)).map((p) => p.name)).toEqual(["Laptop"]);
  });
});

describe("the Activity page", () => {
  it("shows the change log newest first, filtered by kind and search", async () => {
    await postJson("/api/peers", { name: "Phone", public_key: KEY_A });
    await post("/firewall/default", { value: "allow" });
    let page = await get("/activity");
    expect(page).toContain("Change log");
    expect(page.indexOf("firewall.default")).toBeLessThan(page.indexOf("client.add"));
    expect(page).toContain("firewall_default: deny → allow");

    page = await get("/activity?kind=client");
    expect(page).toContain("client.add");
    expect(page).not.toContain("firewall.default");

    page = await get("/activity?q=Phone");
    expect(page).toContain("client.add");
    expect(page).not.toContain("firewall.default");

    page = await get("/activity?kind=nonsense&q=zzz");
    expect(page).toContain("No changes match.");
  });

  it("pages through older changes", async () => {
    for (let i = 0; i < 55; i++) await db.audit(env, "me", "client.edit", `c${i}`, null, { n: i });
    const first = await get("/activity");
    expect(first).toContain("Older →");
    expect(first).not.toContain("← Newer");
    expect(first).toContain(">c54<");
    expect(first).not.toContain(">c4<");
    const second = await get("/activity?page=2");
    expect(second).toContain("← Newer");
    expect(second).not.toContain("Older →");
    expect(second).toContain(">c4<");
  });

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
