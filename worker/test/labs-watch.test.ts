// labs-watch.test.ts
//
// Plain English: plan L2.3. The labs' watchman (every 5 minutes): it heals a
// missed callback from GitHub, warns 15 minutes before a session ends, tears
// down at the timer and at max_until, tears down again when that did not
// work (with one note), cleans up after a failed deploy, and never makes more
// than 20 outside calls in one run. Extend never passes max_until.

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { actionButton } from "../src/actions";
import { runLabWatch, WATCH_CALLS } from "../src/labs/watch";
import { api, advance, deployLab, freeze, ghIdFor, labDispatches, labEnv, labRun, report, rows, runningLab, secrets, session, HOUR, MIN } from "./labs-helpers";

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const pushes = (world: { notes: Record<string, any>[] }) => world.notes.filter((n) => /lab/i.test(String(n.title)));
const watch = (env: Parameters<typeof runLabWatch>[0]) => runLabWatch(env, new Date());

describe("warnings (L2.3)", () => {
  it("a missed callback heals from GitHub", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    // GitHub has started it, but the run never collected its secrets: the watch finds it by title.
    advance(2 * MIN);
    world.jobs.set(ghIdFor(world, r.json.runId), [{ id: 1, name: "lab", status: "in_progress", conclusion: null, steps: [{ name: "Check out, Parse payload", status: "completed", conclusion: "success" }, { name: "Collect run secrets", status: "in_progress", conclusion: null }] }]);
    await watch(env);
    expect(await labRun(env, r.json.runId)).toMatchObject({ github_run_id: ghIdFor(world, r.json.runId), status: "running" });
    expect(JSON.parse((await labRun(env, r.json.runId))!.steps_json)).toHaveLength(2);
    // GitHub finishes it; the result never arrives. Two minutes' grace, then GitHub's word stands.
    const gh = world.ghRuns.get(ghIdFor(world, r.json.runId))!;
    gh.status = "completed";
    gh.conclusion = "success";
    gh.updated_at = new Date().toISOString();
    advance(MIN);
    await watch(env);
    expect((await session(env, r.json.sessionId))!.state).toBe("deploying");
    advance(2 * MIN);
    await watch(env);
    expect((await session(env, r.json.sessionId))!.state).toBe("running");
    expect(await labRun(env, r.json.runId)).toMatchObject({ status: "succeeded" });
    // A run GitHub never started fails after 3 minutes, and its session is failed.
    const r7 = await deployLab(env, "az104-07-files");
    for (const [k, v] of world.ghRuns) if (v.display_title.endsWith(r7.json.runId)) world.ghRuns.delete(k);
    advance(4 * MIN);
    await watch(env);
    expect(await labRun(env, r7.json.runId)).toMatchObject({ status: "failed" });
    expect((await session(env, r7.json.sessionId))!.state).toBe("failed");
  });

  it("15 minutes before the timer one push with Extend 1h and Tear down", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage", { hours: 2, peer: false });
    advance(HOUR + 40 * MIN);
    await watch(env);
    expect(pushes(world).filter((n) => /ends in/.test(n.title))).toHaveLength(0);
    advance(6 * MIN); // 14 minutes left
    await watch(env);
    await watch(env);
    const sent = pushes(world).filter((n) => /ends in/.test(n.title));
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain("Storage accounts");
    expect(sent[0].actions.map((a: { label: string }) => a.label)).toEqual(["Extend 1h", "Tear down", "Open the lab"]);
    expect((await session(env, up.sid))!.warned_at).not.toBeNull();
  });

  it("Extend is left out under an hour from max_until", async () => {
    freeze();
    const { env, world } = await labEnv();
    // Lab 5: max_h 6. Deploy for 5 h: the timer ends 55 minutes before max_until... then extend to max.
    const up = await runningLab(env, world, "az104-05-storage", { hours: 5, peer: false });
    expect((await api(env, "POST", "/labs/az104-05-storage/extend", { toMax: true })).status).toBe(200);
    expect((await session(env, up.sid))!.auto_destroy_at).toBe((await session(env, up.sid))!.max_until);
    advance(6 * HOUR - 14 * MIN);
    await watch(env);
    const sent = pushes(world).filter((n) => /ends in/.test(n.title));
    expect(sent).toHaveLength(1);
    expect(sent[0].actions.map((a: { label: string }) => a.label)).toEqual(["Tear down", "Open the lab"]);
    expect(sent[0].message).toMatch(/maximum/);
  });
});

describe("teardown (L2.3)", () => {
  it("the timer destroys with reason timer", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage", { hours: 1, peer: false });
    advance(59 * MIN);
    await watch(env);
    expect(labDispatches(world).map((d) => d.action)).toEqual(["deploy"]);
    advance(MIN);
    await watch(env);
    expect(labDispatches(world).map((d) => d.action)).toEqual(["deploy", "destroy"]);
    expect((await session(env, up.sid))!).toMatchObject({ state: "tearing_down", end_reason: "timer" });
    // The gateway's workflow is never dispatched by the lab watch.
    expect(world.dispatches.filter((d) => d.workflow !== "lab.yml")).toHaveLength(0);
    // Next run: a destroy is already going; nothing more.
    advance(5 * MIN);
    await watch(env);
    expect(labDispatches(world)).toHaveLength(2);
  });

  it("max_until destroys with end_reason max even after extensions", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage", { hours: 2, peer: false });
    expect((await api(env, "POST", "/labs/az104-05-storage/extend", { hours: 3 })).status).toBe(200);
    expect((await session(env, up.sid))!.auto_destroy_at).toBe("2026-10-04T17:00:00.000Z");
    // Tamper with the timer as a bug might: max_until still wins.
    await env.DB.prepare("UPDATE lab_sessions SET auto_destroy_at = '2026-10-05T12:00:00.000Z' WHERE id = ?1").bind(up.sid).run();
    advance(6 * HOUR);
    await watch(env);
    expect((await session(env, up.sid))!).toMatchObject({ state: "tearing_down", end_reason: "max" });
    expect(labDispatches(world).at(-1)!.action).toBe("destroy");
  });

  it("still running 15 minutes past its deadline destroys again and writes one watchman note", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage", { hours: 1, peer: false });
    // GitHub refuses lab dispatches for a while: the timer's tear-down cannot start.
    const real = globalThis.fetch;
    let refuse = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (refuse && String(input).includes("/lab.yml/dispatches")) return new Response("busy", { status: 503 });
      return real(input, init);
    });
    advance(HOUR);
    await watch(env);
    expect((await session(env, up.sid))!.state).toBe("running");
    advance(16 * MIN);
    refuse = false;
    await watch(env);
    expect((await session(env, up.sid))!).toMatchObject({ state: "tearing_down", end_reason: "timer" });
    const notes = await rows(env, "SELECT kind, message FROM alerts WHERE kind = 'cost_guard'");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/Storage accounts.*15 minutes past/);
    // A destroy stuck long past its workflow's timeout is replaced, still with one note.
    advance(3 * HOUR);
    await watch(env);
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(2);
    expect(await rows(env, "SELECT * FROM alerts WHERE kind = 'cost_guard'")).toHaveLength(1);
  });

  it("a failed session older than 15 minutes is destroyed with end_reason failed", async () => {
    freeze();
    const { env, world } = await labEnv();
    const r = await deployLab(env, "az104-05-storage");
    const s = await secrets(env, world, r.json.runId);
    await report(env, r.json.runId, s.callback_token, "failure", {});
    advance(14 * MIN);
    await watch(env);
    expect((await session(env, r.json.sessionId))!.state).toBe("failed");
    advance(MIN);
    await watch(env);
    expect((await session(env, r.json.sessionId))!).toMatchObject({ state: "tearing_down", end_reason: "failed" });
    expect(labDispatches(world).map((d) => d.action)).toEqual(["deploy", "destroy"]);
  });
});

describe("extend (L2.3)", () => {
  it("extend never moves auto_destroy_at past max_until and the refusal says until when", async () => {
    freeze();
    const { env, world } = await labEnv();
    const up = await runningLab(env, world, "az104-05-storage", { hours: 2, peer: false });
    const ext = await api(env, "POST", "/labs/az104-05-storage/extend", { hours: 3 });
    expect(ext.status).toBe(200);
    expect((await session(env, up.sid))!.auto_destroy_at).toBe("2026-10-04T17:00:00.000Z");
    const past = await api(env, "POST", "/labs/az104-05-storage/extend", { hours: 2 });
    expect(past.status).toBe(409);
    expect(past.json.error.message).toMatch(/until 19:00/); // 18:00 UTC is 19:00 in London (BST)
    expect((await session(env, up.sid))!.auto_destroy_at).toBe("2026-10-04T17:00:00.000Z");
    const max = await api(env, "POST", "/labs/az104-05-storage/extend", { toMax: true });
    expect(max.status).toBe(200);
    expect((await session(env, up.sid))!.auto_destroy_at).toBe("2026-10-04T18:00:00.000Z");
    // Not running: nothing to extend.
    expect((await api(env, "POST", "/labs/az104-07-files/extend", { hours: 1 })).status).toBe(409);
  });

  it("the lab-extend-1h and lab-destroy links act once", async () => {
    freeze();
    const { env, world } = await labEnv({ PUBLIC_URL: "http://localhost:8787" });
    const up = await runningLab(env, world, "az104-05-storage", { hours: 1, peer: false });
    const tap = async (action: string) => {
      const b = await actionButton(env, action as `lab-destroy:${string}`, 600);
      const url = b.url.replace("http://localhost:8787", "");
      const first = await worker.fetch(new Request(`http://localhost:8787${url}`, { method: "POST" }), env, ctx);
      const again = await worker.fetch(new Request(`http://localhost:8787${url}`, { method: "POST" }), env, ctx);
      return { first: [first.status, await first.text()] as const, again: again.status };
    };
    const e = await tap(`lab-extend-1h:${up.sid}`);
    expect(e.first[0]).toBe(200);
    expect(e.first[1]).toMatch(/Extended.*Storage accounts/);
    expect(e.again).toBe(410);
    expect((await session(env, up.sid))!.auto_destroy_at).toBe("2026-10-04T14:00:00.000Z");
    const d = await tap(`lab-destroy:${up.sid}`);
    expect(d.first[1]).toMatch(/Tearing down/);
    expect(d.again).toBe(410);
    expect((await session(env, up.sid))!).toMatchObject({ state: "tearing_down", end_reason: "manual" });
    expect(labDispatches(world).filter((x) => x.action === "destroy")).toHaveLength(1);
  });
});

describe("steps between watch runs (L2.3)", () => {
  it("every fourth live-log piece refreshes the lab run's steps from GitHub", async () => {
    freeze();
    const { env, world } = await labEnv();
    const { receiveLiveLog } = await import("../src/livelog");
    const r = await deployLab(env, "az104-05-storage");
    const s = await secrets(env, world, r.json.runId);
    world.jobs.set(ghIdFor(world, r.json.runId), [{ id: 1, name: "lab", status: "in_progress", conclusion: null, steps: [{ name: "Check out, Parse payload", status: "completed", conclusion: "success" }, { name: "Collect run secrets", status: "completed", conclusion: "success" }, { name: "Start live log", status: "in_progress", conclusion: null }] }]);
    const jobsCalls = () => world.calls.filter((c) => c.path.endsWith("/jobs")).length;
    for (let seq = 1; seq <= 3; seq++) await receiveLiveLog(env, s.callback_token, { run_id: r.json.runId, seq, text: `line ${seq}\n` });
    expect(jobsCalls()).toBe(0);
    await receiveLiveLog(env, s.callback_token, { run_id: r.json.runId, seq: 4, text: "line 4\n" });
    expect(jobsCalls()).toBe(1);
    const run = await api(env, "GET", "/labs/az104-05-storage");
    expect(run.json.session.activeRun.step).toEqual({ done: 2, of: 11, name: "Start live log" });
  });
});

describe("calls (L2.3)", () => {
  it("a watch run makes at most 20 subrequests", async () => {
    freeze();
    const { env, world } = await labEnv({ MONTHLY_BUDGET_GBP: "0" });
    await api(env, "PUT", "/settings", { labs_max_running: 5 });
    // Five labs at once: three running past their timers, two still deploying with GitHub never seen.
    const ids = ["az104-05-storage", "az104-06-blob-security", "az104-07-files"];
    for (const id of ids) await runningLab(env, world, id, { hours: 1, peer: false });
    await deployLab(env, "az104-01-identity");
    await deployLab(env, "az305-28-hub-spoke-fw", { hours: 1, peer: true });
    world.ghRuns.clear();
    advance(2 * HOUR);
    // The orphan sweep and the cost query are due too.
    const before = world.calls.length;
    const lines = await watch(env);
    const made = world.calls.length - before;
    expect(made).toBeLessThanOrEqual(WATCH_CALLS);
    expect(WATCH_CALLS).toBe(20);
    // The tear-downs came first: every expired lab got its destroy; the two GitHub never started are failed.
    expect(labDispatches(world).filter((d) => d.action === "destroy")).toHaveLength(3);
    expect((await rows(env, "SELECT state FROM lab_sessions WHERE lab_id IN ('az104-01-identity', 'az305-28-hub-spoke-fw')")).map((r) => r.state)).toEqual(["failed", "failed"]);
    expect(lines.join(" | ")).toMatch(/destroy|tear/i);
  });
});
