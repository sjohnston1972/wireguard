import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import { cameFromOurPages, isLocalhost } from "../src/auth";

// The front door's defences: forged requests from other sites, the dev
// login switch-off, and what an error tells a stranger.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

function call(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(url, init), env, ctx) as Promise<Response>;
}

describe("requests from other sites (issue #1)", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: "http://localhost:8787" }).env;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the decision: same-origin yes, sibling site or no label no", () => {
    const url = "https://wg-admin.example/x";
    expect(cameFromOurPages("same-origin", undefined, url, undefined)).toBe(true);
    expect(cameFromOurPages("same-site", "https://evil.example", url, undefined)).toBe(false);
    expect(cameFromOurPages("cross-site", "https://wg-admin.example", url, undefined)).toBe(false);
    expect(cameFromOurPages(undefined, "https://wg-admin.example", url, undefined)).toBe(true);
    expect(cameFromOurPages(undefined, "https://other.example", url, "https://other.example")).toBe(true);
    expect(cameFromOurPages(undefined, "https://evil.example", url, "https://wg-admin.example")).toBe(false);
    expect(cameFromOurPages(undefined, "null", url, undefined)).toBe(false);
    expect(cameFromOurPages(undefined, undefined, url, undefined)).toBe(false);
  });

  it("a POST from another site is refused; the same POST from our page works", async () => {
    let r = await call(env, "http://localhost:8787/alerts/ack", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    r = await call(env, "http://localhost:8787/alerts/ack", { method: "POST" });
    expect(r.status).toBe(403);
    r = await call(env, "http://localhost:8787/alerts/ack", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(r.status).toBe(302);
    r = await call(env, "http://localhost:8787/alerts/ack", { method: "POST", headers: { Origin: "http://localhost:8787" } });
    expect(r.status).toBe(302);
  });

  it("JSON routes want a JSON label", async () => {
    const body = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/abc" });
    let r = await call(env, "http://localhost:8787/api/push/subscribe", { method: "POST", body, headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" } });
    expect(r.status).toBe(400);
    r = await call(env, "http://localhost:8787/api/peers", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" } });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/Name|key/);
  });

  it("token routes called by the VM, GitHub and the phone are not affected", async () => {
    const r = await call(env, "http://localhost:8787/api/agent", { method: "POST", body: "{}", headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" } });
    expect(r.status).toBe(401);
    const a = await call(env, "http://localhost:8787/api/act/nope", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(a.status).toBe(410);
  });
});

describe("the dev login switch-off (issue #12)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only counts on this PC", () => {
    expect(isLocalhost("http://localhost:8787/")).toBe(true);
    expect(isLocalhost("http://127.0.0.1:8787/")).toBe(true);
    expect(isLocalhost("https://wg-admin.clydeford.net/")).toBe(false);
    expect(isLocalhost("https://localhost.evil.example/")).toBe(false);
  });

  it("is ignored on the live address", async () => {
    const { env } = makeEnv({ AUTH_DEV_BYPASS: "1", CF_ACCESS_TEAM_DOMAIN: "team.example", CF_ACCESS_AUD: "aud", CF_ACCESS_ALLOWED_EMAIL: "s@example.com" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(env, "https://wg-admin.example/settings");
    expect(r.status).toBe(401);
    expect(err).toHaveBeenCalled();
  });
});

describe("errors (issue #13)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a crash on an open route says nothing about the inside", async () => {
    const { env } = makeEnv();
    // A run_id that is not text makes the database lookup fail.
    env.DB = { prepare() { throw new Error("D1_TYPE_ERROR: secret internals"); } } as unknown as D1Database;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(env, "https://wg-admin.example/api/callback", { method: "POST", body: JSON.stringify({ run_id: { x: 1 } }), headers: { Authorization: "Bearer abc", "Content-Type": "application/json" } });
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).not.toMatch(/D1_TYPE_ERROR|internals/);
    expect(text).toMatch(/reference [0-9a-f]{8}/);
  });
});
