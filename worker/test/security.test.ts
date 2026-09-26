import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { cameFromOurPages, isLocalhost } from "../src/auth";
import { startDeploy, issueRunSecrets, handleCallback } from "../src/runs";
import { startCapture, receiveCapture, validFilter, readCapped } from "../src/capture";
import { getSnapshot } from "../src/state";

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

describe("wrong-token brake (issue #7)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts failures per address, so junk cannot lock out the real VM", async () => {
    const { env } = makeEnv();
    const bad = { method: "POST", body: "{}", headers: { Authorization: "Bearer nope", "CF-Connecting-IP": "198.51.100.7", "Content-Type": "application/json" } };
    for (let i = 0; i < 10; i++) expect((await call(env, "https://wg-admin.example/api/agent", bad)).status).toBe(401);
    expect((await call(env, "https://wg-admin.example/api/agent", bad)).status).toBe(429);
    // Another address (the real VM) is still heard.
    const other = { ...bad, headers: { ...bad.headers, "CF-Connecting-IP": "20.0.0.10" } };
    expect((await call(env, "https://wg-admin.example/api/agent", other)).status).toBe(401);
  });
});

describe("capture upload (issues #8 and #17)", () => {
  let env: Env;
  let world: World;
  beforeEach(() => {
    const m = makeEnv();
    env = m.env;
    world = m.world;
  });
  afterEach(() => vi.unstubAllGlobals());

  async function running(): Promise<{ runId: string; token: string }> {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
    const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
    world.azure.rg = true;
    await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
    return { runId: run.id, token: sec.body.agent_token as string };
  }

  function stream(chunks: number, size: number): ReadableStream<Uint8Array> {
    let n = 0;
    return new ReadableStream({
      pull(ctl) {
        if (n++ < chunks) ctl.enqueue(new Uint8Array(size));
        else ctl.close();
      },
    });
  }

  it("filters may not start with a dash (tcpdump would take it as an option)", () => {
    expect(validFilter("-w/etc/x")).toBe(false);
    expect(validFilter("  -r /etc/shadow")).toBe(false);
    expect(validFilter("portrange 1000-2000")).toBe(true);
  });

  it("checks the token before reading the file", async () => {
    await running();
    await startCapture(env, { iface: "wg0", filter: "", seconds: 30, by: "s" });
    const id = (await getSnapshot(env)).capture_req!.id;
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull() { pulled = true; } }, { highWaterMark: 0 });
    expect((await receiveCapture(env, "wrong", id, body, null)).status).toBe(401);
    expect(pulled).toBe(false);
  });

  it("stops reading past 30 MB even without a size label", async () => {
    const { token } = await running();
    await startCapture(env, { iface: "wg0", filter: "", seconds: 30, by: "s" });
    const id = (await getSnapshot(env)).capture_req!.id;
    const r = await receiveCapture(env, token, id, stream(40, 1024 * 1024), null);
    expect(r.status).toBe(413);
    expect(await db.getCapture(env, id)).toMatchObject({ status: "failed" });
    expect(await readCapped(stream(3, 10), 100)).toHaveProperty("byteLength", 30);
  });

  it("only the current deployment's token counts", async () => {
    const { runId, token } = await running();
    await startCapture(env, { iface: "wg0", filter: "", seconds: 30, by: "s" });
    const id = (await getSnapshot(env)).capture_req!.id;
    // A newer apply exists: the old VM's token no longer uploads.
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at) VALUES ('newer', 'apply', 'queued', ?1)").bind(new Date(Date.now() + 60_000).toISOString()).run();
    expect(runId).not.toBe("newer");
    expect((await receiveCapture(env, token, id, new Uint8Array([1, 2]).buffer, null)).status).toBe(410);
  });
});
