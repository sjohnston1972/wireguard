// api-foundation.test.ts
//
// Plain English: the data API's front door: JSON for every answer,
// including refusals, never cached, and the dashboard's own errors turned
// into the right status.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { api, apiEnv } from "./api-helpers";
import { makeEnv } from "./harness";
import { createApi, statusFor } from "../src/api/app";
import { RunError } from "../src/runs";

afterEach(() => vi.unstubAllGlobals());

describe("API front door", () => {
  it("answers an unknown API path with JSON 404", async () => {
    const { env } = apiEnv();
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: { code: "not_found", message: "No such API route." } });
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses a cross-site change with JSON 403", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/nope", {}, { "Sec-Fetch-Site": "cross-site" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
  });

  it("answers JSON 503 when login is not configured", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("not_configured");
  });

  it("answers JSON 401 when there is no login token", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787", CF_ACCESS_TEAM_DOMAIN: "t.cloudflareaccess.com", CF_ACCESS_AUD: "aud", CF_ACCESS_ALLOWED_EMAIL: "a@b.c" });
    const r = await api(env, "GET", "/nope");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("unauthenticated");
  });

  it("still answers today's pages with text, not JSON", async () => {
    const { env } = makeEnv({ PUBLIC_URL: "http://localhost:8787" });
    const r = await (await import("../src/index")).default.fetch(new Request("http://localhost:8787/"), env, { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext);
    expect(r.status).toBe(503);
    expect(r.headers.get("Content-Type") ?? "").toMatch(/^text\/plain/);
  });
});

describe("dashboard errors", () => {
  it("maps RunError codes to statuses", () => {
    expect(statusFor("bad_input")).toBe(400);
    expect(statusFor("not_found")).toBe(404);
    expect(statusFor("over_budget")).toBe(422);
    expect(statusFor("confirm_required")).toBe(422);
    expect(statusFor("refused")).toBe(409);
    expect(statusFor("anything else")).toBe(409);
  });

  it("turns a thrown RunError into its status and code, and a crash into 500 with only a reference", async () => {
    const sub = createApi();
    sub.get("/conflict", () => {
      throw new RunError("A run is already in progress.");
    });
    sub.get("/budget", () => {
      throw new RunError("Over budget.", "over_budget");
    });
    sub.get("/crash", () => {
      throw new Error("secret detail");
    });
    const parent = new Hono();
    parent.route("/api/v1", sub);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const conflict = await parent.request("/api/v1/conflict");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "refused", message: "A run is already in progress." } });
    const budget = await parent.request("/api/v1/budget");
    expect(budget.status).toBe(422);
    const crash = await parent.request("/api/v1/crash");
    expect(crash.status).toBe(500);
    const text = JSON.stringify(await crash.json());
    expect(text).not.toContain("secret detail");
    expect(text).toMatch(/reference [0-9a-f]{8}/);
    spy.mockRestore();
  });
});
