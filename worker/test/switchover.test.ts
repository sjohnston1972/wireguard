import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";

// Switch-over: the old server-rendered dashboard is gone; the token routes,
// the manifest, health, captures and /api/v1 stay.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const base = "http://localhost:8787";

function call(env: Env, path: string, init: RequestInit = {}, origin = base): Promise<Response> {
  return worker.fetch(new Request(`${origin}${path}`, init), env, ctx) as Promise<Response>;
}
const SAME = { "Sec-Fetch-Site": "same-origin" };
const post = (env: Env, path: string, extra: Record<string, string> = {}) =>
  call(env, path, { method: "POST", headers: { ...SAME, "Content-Type": "application/json", ...extra }, body: "{}" });

let env: Env;
beforeEach(() => {
  env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base }).env;
});

const OLD_GETS = ["/", "/peers", "/partials/live", "/partials/peers-table", "/activity", "/cost", "/settings", "/firewall", "/api/ssh-password", "/api/push/status", "/icon.svg", "/settings/backup/export", "/settings/backup/config/2026-01-01"];
const OLD_POSTS = [
  ...["deploy", "move", "hibernate", "resume", "destroy", "cleanup", "cancel", "reconcile", "extend", "speedtest", "allow-ssh"].map((a) => `/actions/${a}`),
  "/alerts/ack",
  "/api/peers", "/api/peers/1/rekey", "/api/peers/1/expiry",
  ...["azure", "dns", "homelan", "toggle", "delete"].map((a) => `/peers/1/${a}`),
  "/api/push/subscribe", "/api/push/unsubscribe", "/api/push/test", "/settings/push/1/delete",
  "/settings", "/settings/profiles", "/settings/profiles/1/delete", "/settings/schedules", "/settings/schedules/1/toggle", "/settings/schedules/1/delete", "/settings/release-lock",
  "/settings/backup/restore", "/settings/backup/restore/confirm",
  "/firewall/forwards", "/firewall/forwards/1/toggle", "/firewall/forwards/1/delete", "/firewall/capture", "/firewall/clear",
  "/firewall/rules", "/firewall/rules/1/up", "/firewall/rules/1/toggle", "/firewall/rules/1/delete", "/firewall/default", "/firewall/allow-drop",
];

describe("the old dashboard is gone", () => {
  it("every removed page and form route answers 404", async () => {
    for (const p of OLD_GETS) expect((await call(env, p)).status, `GET ${p}`).toBe(404);
    for (const p of OLD_POSTS) expect((await post(env, p)).status, `POST ${p}`).toBe(404);
  });

  it("POST /settings with firewall_default changes nothing", async () => {
    const before = { d: await db.getSetting(env, "firewall_default"), v: (await db.getFwPolicy(env)).live_version };
    const r = await call(env, "/settings", { method: "POST", headers: { ...SAME, "Content-Type": "application/json" }, body: JSON.stringify({ firewall_default: "allow" }) });
    expect(r.status).toBe(404);
    expect(await db.getSetting(env, "firewall_default")).toBe(before.d);
    expect((await db.getFwPolicy(env)).live_version).toBe(before.v);
  });
});

describe("what stays", () => {
  it("kept token routes answer as before", async () => {
    const bad = { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" };
    let r = await call(env, "/api/agent", bad);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toMatch(/json/);
    r = await call(env, "/api/callback", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.headers.get("content-type")).toMatch(/json/);
    r = await call(env, "/api/callback/secrets", { method: "POST", headers: { Authorization: "Bearer not-a-jwt" }, body: "{}" });
    expect(r.status).toBe(401);
    r = await call(env, "/api/agent/capture/0123456789abcdef", { method: "POST", headers: { Authorization: "Bearer nope" }, body: "x" });
    expect(r.status).toBe(401);
    r = await call(env, "/api/act/nope", { method: "POST" });
    expect(r.status).toBe(410);
  });

  it("manifest, health and captures still answer", async () => {
    const m = await call(env, "/manifest.webmanifest");
    expect(m.status).toBe(200);
    const j = (await m.json()) as any;
    expect(j.id).toBe("/");
    expect(j.scope).toBe("/");
    expect(j.start_url).toBe("/");
    expect(j.icons).toHaveLength(3);
    expect(j.background_color).toBe("#08111c");
    expect(j.theme_color).toBe("#08111c");
    const h = await call(env, "/health");
    expect(h.status).toBe(200);
    expect(h.headers.get("content-type")).toMatch(/json/);
    expect((await call(env, "/captures/xyz")).status).toBe(404);
  });

  it("an unknown /api/v1 path is a JSON 404", async () => {
    const r = await call(env, "/api/v1/nope", { headers: SAME });
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as any).error.code).toBe("not_found");
  });

  it("an htmx request from an old page gets HX-Refresh", async () => {
    const g = await call(env, "/partials/live", { headers: { "HX-Request": "true" } });
    expect(g.status).toBe(200);
    expect(g.headers.get("HX-Refresh")).toBe("true");
    expect(await g.text()).toBe("");
    const p = await post(env, "/actions/deploy", { "HX-Request": "true" });
    expect(p.status).toBe(200);
    expect(p.headers.get("HX-Refresh")).toBe("true");
    expect(await p.text()).toBe("");
    expect(await db.listRuns(env, 10)).toHaveLength(0);
  });

  it("the dev seeder is 404 without the bypass and on a non-localhost host", async () => {
    const noBypass = makeEnv({ PUBLIC_URL: base }).env;
    expect((await call(noBypass, "/__dev/seed?scenario=running")).status).toBe(404);
    expect((await call(env, "/__dev/seed?scenario=running", {}, "https://wg-admin.example")).status).toBe(404);
  });
});
