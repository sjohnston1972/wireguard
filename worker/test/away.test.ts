import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { saveSnapshot } from "../src/state";

// The "While you were away" banner (issue #56): gone once Steven presses a
// button, hidden while a run is in progress, and quiet about the routine
// notes his own button press produced. Warnings still show.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const base = "http://localhost:8787";
const ours = { "Sec-Fetch-Site": "same-origin" };

function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(base + path, init), env, ctx) as Promise<Response>;
}

async function banner(env: Env): Promise<string | null> {
  const page = await (await call(env, "/activity")).text();
  const m = page.match(/<div id="away">[\s\S]*?<\/ul>/);
  return m ? m[0] : null;
}

async function addAt(env: Env, kind: string, message: string, at: Date) {
  await env.DB.prepare("INSERT INTO alerts (at, kind, message) VALUES (?1, ?2, ?3)").bind(at.toISOString(), kind, message).run();
}

describe("While you were away banner (issue #56)", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base }).env;
  });

  it("shows notes nobody has read yet", async () => {
    await db.addAlert(env, "info", "Auto-destroy timer reached.");
    expect(await banner(env)).toContain("Auto-destroy timer reached.");
  });

  it("pressing a button reads the notes and removes the banner from the page", async () => {
    await db.addAlert(env, "info", "Old note");
    const r = await call(env, "/actions/cancel", { method: "POST", headers: { ...ours, "HX-Request": "true" } });
    const body = await r.text();
    expect(body).toContain('id="away" hx-swap-oob="delete"');
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
    expect(await banner(env)).toBeNull();
  });

  it("routine notes just after the button press are treated as seen; warnings are not", async () => {
    await call(env, "/actions/cancel", { method: "POST", headers: { ...ours, "HX-Request": "true" } });
    await db.addAlert(env, "deploy", "Deployed at 20.0.0.1 (callback)");
    await db.addAlert(env, "info", "Self-test passed in 2.5 s");
    await db.addAlert(env, "failure", "apply failed: something broke");
    const b = await banner(env);
    expect(b).toContain("apply failed: something broke");
    expect(b).not.toContain("Deployed at");
    expect(b).not.toContain("Self-test passed");
  });

  it("notes long after the last button press still count as while you were away", async () => {
    await call(env, "/actions/cancel", { method: "POST", headers: { ...ours, "HX-Request": "true" } });
    await addAt(env, "destroy", "Torn down overnight by the watchman", new Date(Date.now() + 3 * 3_600_000));
    expect(await banner(env)).toContain("Torn down overnight by the watchman");
  });

  it("no banner while a run is in progress", async () => {
    await db.addAlert(env, "info", "Something from earlier");
    await saveSnapshot(env, { state: "deploying", since: new Date().toISOString() });
    expect(await banner(env)).toBeNull();
    await saveSnapshot(env, { state: "running" });
    expect(await banner(env)).toContain("Something from earlier");
  });
});
