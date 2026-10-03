// livelog.test.ts
//
// Plain English: the run's live log. While a deploy or tear-down runs, the
// workflow posts its output to /api/callback/log with the run's callback
// token (infra/ci/live-log.mjs); the dashboard reads it from
// /api/v1/runs/:id/log until GitHub's full log exists. Checks the door
// (token, run still going, size), that a resent piece is stored once, that a
// run's log is capped and expires, that the Worker hides the run's secrets
// too, and which log the dashboard is given when.
import { describe, it, expect, afterEach, vi } from "vitest";
import { lastGhRun, type World } from "./harness";
import { api, apiEnv } from "./api-helpers";
import type { Env } from "../src/env";
import worker from "../src/index";
import * as db from "../src/db";
import { startDeploy, issueRunSecrets, handleCallback } from "../src/runs";
import { runScheduled } from "../src/monitor";
import { LIVE_LOG_KEEP_BYTES, LIVE_LOG_KEEP_DAYS, redact } from "../src/livelog";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
let ipCounter = 0;
/** Each test calls from its own address, so the wrong-token brake of one test never trips another. */
const freshIp = () => `198.51.100.${++ipCounter}`;

async function postLog(env: Env, token: string, body: unknown, ip = freshIp()): Promise<{ status: number; json: any }> {
  const r = await worker.fetch(
    new Request("https://wg-admin.example/api/callback/log", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "CF-Connecting-IP": ip },
    }),
    env,
    ctx,
  );
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

/** A deploy that has collected its secrets: running, with a callback token. */
async function activeDeploy(): Promise<{ env: Env; world: World; runId: string; token: string; ghId: number; password: string }> {
  const { env, world } = apiEnv();
  const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
  const ghId = lastGhRun(world);
  const sec = await issueRunSecrets(env, run.id, ghId);
  return { env, world, runId: run.id, token: sec.body.callback_token as string, ghId, password: sec.body.ssh_password as string };
}

async function finish(env: Env, world: World, runId: string, token: string) {
  world.azure.rg = true;
  await handleCallback(env, token, { run_id: runId, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
}

const LINE = (s: string) => `2026-10-03T08:00:00.000Z ${s}\n`;

describe("POST /api/callback/log", () => {
  it("stores a piece from the running workflow and the dashboard sees it", async () => {
    const { env, runId, token } = await activeDeploy();
    const r = await postLog(env, token, { run_id: runId, seq: 1, text: LINE("##[group]terraform init (state in R2)") + LINE("Initializing the backend...") });
    expect(r.status).toBe(200);
    const got = await api(env, "GET", `/runs/${runId}/log`);
    expect(got.status).toBe(200);
    expect(got.json.source).toBe("live");
    expect(got.json.active).toBe(true);
    expect(got.json.log).toContain("Initializing the backend...");
    expect(typeof got.json.updatedAt).toBe("string");
  });

  it("turns away a wrong token, an unknown run, a run with no token yet, and a malformed piece", async () => {
    const { env, runId, token } = await activeDeploy();
    expect((await postLog(env, "not-the-token", { run_id: runId, seq: 1, text: "x" })).status).toBe(401);
    expect((await postLog(env, "", { run_id: runId, seq: 1, text: "x" })).status).toBe(401);
    expect((await postLog(env, token, { run_id: "apply-nope", seq: 1, text: "x" })).status).toBe(404);
    // A run that never collected its secrets has no token to match.
    await db.createRun(env, { id: "apply-notoken", action: "apply", status: "queued", requested_at: new Date().toISOString(), requested_by: "s", callback_token_hash: null, agent_token_hash: null, payload_json: "{}", auto_destroy_at: null, reason: null, ssh_password: null });
    expect((await postLog(env, token, { run_id: "apply-notoken", seq: 1, text: "x" })).status).toBe(404);
    for (const bad of [{ run_id: runId, seq: "1", text: "x" }, { run_id: runId, seq: 1.5, text: "x" }, { run_id: runId, seq: -1, text: "x" }, { run_id: runId, seq: 1 }, { seq: 1, text: "x" }, "not json"]) {
      expect((await postLog(env, token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api(env, "GET", `/runs/${runId}/log`)).json.log).toBe("");
  });

  it("refuses more text once the run has finished (an old token is no use)", async () => {
    const { env, world, runId, token } = await activeDeploy();
    await finish(env, world, runId, token);
    const r = await postLog(env, token, { run_id: runId, seq: 1, text: LINE("late") });
    expect(r.status).toBe(409);
    expect(await db.liveLogRows(env, runId)).toEqual([]);
  });

  it("refuses a piece over 64 KB", async () => {
    const { env, runId, token } = await activeDeploy();
    expect((await postLog(env, token, { run_id: runId, seq: 1, text: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect((await postLog(env, token, { run_id: runId, seq: 2, text: "é".repeat(33 * 1024) })).status).toBe(413); // 66 KB as UTF-8
    expect((await postLog(env, token, { run_id: runId, seq: 3, text: "x".repeat(64 * 1024) })).status).toBe(200);
  });

  it("slows down an address after 10 wrong tokens, but a late piece (409) is not counted as one", async () => {
    const { env, world, runId, token } = await activeDeploy();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await postLog(env, "wrong", { run_id: runId, seq: 1, text: "x" }, ip)).status).toBe(401);
    expect((await postLog(env, token, { run_id: runId, seq: 1, text: "x" }, ip)).status).toBe(429);
    // Another address (the real runner) still gets through.
    expect((await postLog(env, token, { run_id: runId, seq: 1, text: "x" })).status).toBe(200);

    const ip2 = freshIp();
    await finish(env, world, runId, token);
    for (let i = 0; i < 12; i++) expect((await postLog(env, token, { run_id: runId, seq: 2 + i, text: "x" }, ip2)).status).toBe(409);
  });

  it("stores a resent piece only once (the first copy wins), and assembles pieces in order", async () => {
    const { env, runId, token } = await activeDeploy();
    expect((await postLog(env, token, { run_id: runId, seq: 2, text: LINE("second") })).status).toBe(200);
    expect((await postLog(env, token, { run_id: runId, seq: 1, text: LINE("first") })).status).toBe(200);
    const again = await postLog(env, token, { run_id: runId, seq: 1, text: LINE("first, resent") });
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(await db.liveLogRows(env, runId)).toHaveLength(2);
    const log = (await api(env, "GET", `/runs/${runId}/log`)).json.log as string;
    expect(log).toBe(LINE("first") + LINE("second"));
  });

  it("keeps only the newest ~400 KB of a run's log, and says that earlier lines were dropped", async () => {
    const { env, runId, token } = await activeDeploy();
    const piece = (n: number) => LINE(`piece ${n} `.padEnd(60 * 1024 - 30, "."));
    for (let n = 1; n <= 10; n++) expect((await postLog(env, token, { run_id: runId, seq: n, text: piece(n) })).status).toBe(200);
    const rows = await db.liveLogRows(env, runId);
    const total = rows.reduce((t, r) => t + r.text.length, 0);
    expect(total).toBeLessThanOrEqual(LIVE_LOG_KEEP_BYTES);
    expect(rows.at(-1)!.seq).toBe(10);
    expect(rows[0].seq).toBeGreaterThan(1);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: rows.length }, (_, i) => 11 - rows.length + i));
    expect(await db.liveLogPrunedUpto(env, runId)).toBe(rows[0].seq - 1);
    const log = (await api(env, "GET", `/runs/${runId}/log`)).json.log as string;
    expect(log).toMatch(/^##\[warning\]Earlier lines were dropped/);
    expect(log).toContain("piece 10 ");
    expect(log).not.toContain("piece 1 ");
  });

  it("says earlier lines were dropped only when the cap dropped some, not when piece 1 never arrived (a 413 skip, a lost first piece)", async () => {
    const { env, runId, token } = await activeDeploy();
    expect((await postLog(env, token, { run_id: runId, seq: 1, text: "x".repeat(64 * 1024 + 1) })).status).toBe(413);
    expect((await postLog(env, token, { run_id: runId, seq: 2, text: LINE("second") })).status).toBe(200);
    expect((await postLog(env, token, { run_id: runId, seq: 4, text: LINE("fourth") })).status).toBe(200);
    const log = (await api(env, "GET", `/runs/${runId}/log`)).json.log as string;
    expect(log).toBe(LINE("second") + LINE("fourth"));
    expect(log).not.toContain("Earlier lines were dropped");
  });

  it("hides the run's own secrets even if the runner missed them: the SSH password and the callback token, typed or base64", async () => {
    const { env, runId, token, password } = await activeDeploy();
    expect(password.length).toBeGreaterThan(5);
    const b64 = (s: string) => btoa(s);
    const text = LINE(`password ${password}`) + LINE(`token ${token}`) + LINE(`encoded ${b64(password)} and ${b64(token)}`) + LINE(`inside ${b64(`xPW=${password}\n`)}`);
    expect((await postLog(env, token, { run_id: runId, seq: 1, text })).status).toBe(200);
    const stored = (await db.liveLogRows(env, runId)).map((r) => r.text).join("");
    expect(stored).not.toContain(password);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(b64(password));
    expect(stored).not.toContain(b64(token));
    // Inside a longer blob the password starts 4 bytes in: its base64 from the next 3-byte boundary on.
    const core = password.slice(2, 2 + Math.floor((password.length - 2) / 3) * 3);
    expect(b64(`xPW=${password}\n`)).toContain(b64(core));
    expect(stored).not.toContain(b64(core));
    expect(stored).toContain("password ***");
  });
});

describe("Worker redaction: escaped forms", () => {
  it("hides a secret URL-encoded and JSON-escaped (including \\u escapes), as the runner does", () => {
    const secret = 'pa ss/w"o&r<d>\\é+=?#';
    const u = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
    const json = JSON.stringify(secret).slice(1, -1);
    const forms = [encodeURIComponent(secret), json, json.replace(/[^\x00-\x7e]/g, u), json.replace(/[<>&]/g, u)];
    for (const f of forms) {
      expect(f).not.toBe(secret);
      expect(redact(`before ${f} after`, [secret]), f).toBe("before *** after");
    }
  });
});

describe("live log retention", () => {
  it(`the watchman deletes a run's live log ${LIVE_LOG_KEEP_DAYS} days after the run ended, and orphans`, async () => {
    const { env, world, runId, token } = await activeDeploy();
    await postLog(env, token, { run_id: runId, seq: 1, text: LINE("kept while recent") });
    await finish(env, world, runId, token);
    // A run that ended long ago, and rows whose run no longer exists.
    await db.createRun(env, { id: "apply-old", action: "apply", status: "queued", requested_at: "2026-01-01T00:00:00.000Z", requested_by: "s", callback_token_hash: null, agent_token_hash: null, payload_json: "{}", auto_destroy_at: null, reason: null, ssh_password: null });
    await db.updateRun(env, "apply-old", { status: "success", finished_at: "2026-01-01T00:30:00.000Z" });
    await db.addLiveLogChunk(env, "apply-old", 1, "2026-01-01T00:10:00.000Z", "old text\n");
    await db.addLiveLogChunk(env, "apply-gone", 1, "2026-01-01T00:10:00.000Z", "orphan\n");
    await db.addLiveLogChunk(env, "apply-old", 2, "2026-01-01T00:11:00.000Z", "x".repeat(100));
    await db.trimLiveLog(env, "apply-old", 50); // the cap drops piece 1 and says so
    expect(await db.liveLogPrunedUpto(env, "apply-old")).toBe(1);

    const finished = (await db.getRun(env, runId))!.finished_at!;
    const day = 86_400_000;
    // Just inside the window: the recent run's log stays; the old one and the orphan go.
    await runScheduled(env, new Date(Date.parse(finished) + (LIVE_LOG_KEEP_DAYS - 1) * day));
    expect(await db.liveLogRows(env, runId)).toHaveLength(1);
    expect(await db.liveLogRows(env, "apply-old")).toEqual([]);
    expect(await db.liveLogPrunedUpto(env, "apply-old")).toBeNull();
    expect(await db.liveLogRows(env, "apply-gone")).toEqual([]);
    // Past it, the recent run's log goes too.
    await db.pruneLiveLogs(env, new Date(Date.parse(finished) + (LIVE_LOG_KEEP_DAYS + 1) * day));
    expect(await db.liveLogRows(env, runId)).toEqual([]);
  });

  it("never deletes the log of a run still going", async () => {
    const { env, runId, token } = await activeDeploy();
    await postLog(env, token, { run_id: runId, seq: 1, text: LINE("going") });
    await db.pruneLiveLogs(env, new Date(Date.now() + 365 * 86_400_000));
    expect(await db.liveLogRows(env, runId)).toHaveLength(1);
  });
});

describe("GET /api/v1/runs/:id/log: live while running, GitHub's once finished", () => {
  it("while the run is active: the live log, even when empty, without asking GitHub", async () => {
    const { env, world, runId, ghId } = await activeDeploy();
    // GitHub has no log for an unfinished job (it answers 404); that must not matter.
    world.jobs.set(ghId, [{ id: 77, name: "terraform apply", status: "in_progress", conclusion: null, steps: [] }]);
    const r = await api(env, "GET", `/runs/${runId}/log`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ log: "", source: "live", active: true, updatedAt: null });
  });

  it("while queued, before the workflow has even started: an empty live log, not a 404", async () => {
    const { env } = apiEnv();
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "s" });
    const r = await api(env, "GET", `/runs/${run.id}/log`);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("live");
    expect(r.json.log).toBe("");
  });

  it("once finished: GitHub's full log when GitHub has it", async () => {
    const { env, world, runId, token, ghId } = await activeDeploy();
    await postLog(env, token, { run_id: runId, seq: 1, text: LINE("live copy") });
    await finish(env, world, runId, token);
    world.jobs.set(ghId, [{ id: 77, name: "terraform apply", status: "completed", conclusion: "success", steps: [] }]);
    world.logs.set(77, "2026-10-03T08:00:00.000Z the full GitHub log");
    const r = await api(env, "GET", `/runs/${runId}/log`);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("github");
    expect(r.json.active).toBe(false);
    expect(r.json.log).toBe("the full GitHub log");
  });

  it("once finished but GitHub has no log (yet, or any more): the stored live log", async () => {
    const { env, world, runId, token, ghId } = await activeDeploy();
    await postLog(env, token, { run_id: runId, seq: 1, text: LINE("live copy") });
    await finish(env, world, runId, token);
    world.jobs.set(ghId, [{ id: 77, name: "terraform apply", status: "completed", conclusion: "success", steps: [] }]);
    const r = await api(env, "GET", `/runs/${runId}/log`);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("live");
    expect(r.json.active).toBe(false);
    expect(r.json.log).toBe(LINE("live copy"));
  });

  it("once finished and GitHub cannot be reached: the stored live log", async () => {
    const { env, world, runId, token } = await activeDeploy();
    await postLog(env, token, { run_id: runId, seq: 1, text: LINE("live copy") });
    await finish(env, world, runId, token);
    world.ghFail = 503;
    const r = await api(env, "GET", `/runs/${runId}/log`);
    expect(r.status).toBe(200);
    expect(r.json.source).toBe("live");
  });

  it("once finished with neither: 404 no_log that says so", async () => {
    const { env, world, runId, token, ghId } = await activeDeploy();
    await finish(env, world, runId, token);
    world.jobs.set(ghId, [{ id: 77, name: "terraform apply", status: "completed", conclusion: "success", steps: [] }]);
    const r = await api(env, "GET", `/runs/${runId}/log`);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("no_log");
    expect(r.json.error.message).toMatch(/GitHub/);
  });
});
