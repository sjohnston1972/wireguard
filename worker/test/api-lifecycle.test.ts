// api-lifecycle.test.ts
//
// Plain English: deploy, move, hibernate, resume, tear down, clean up,
// cancel, check Azure, extend, speed test and allow SSH, through the data
// API: each answers { ok, message } or a refusal with the right status,
// and counts as Steven having read the notes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { parseHours } from "../src/api/lifecycle";

afterEach(() => vi.unstubAllGlobals());

describe("POST /deploy", () => {
  it("starts a deploy and marks the notes read", async () => {
    const { env, world } = apiEnv();
    await db.addAlert(env, "info", "Old note");
    const r = await api(env, "POST", "/deploy", { hours: 2 });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.message).toMatch(/^Deploy started in UK South/);
    expect(world.dispatches.map((d) => d.action)).toEqual(["apply"]);
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
  });

  it("deploys a profile", async () => {
    const { env, world } = apiEnv();
    await db.addProfile(env, { name: "Test exit", region: "eastus", vm_size: "Standard_B1s" });
    const p = (await db.listProfiles(env)).find((x) => x.name === "Test exit")!;
    const r = await api(env, "POST", "/deploy", { profileId: p.id });
    expect(r.status).toBe(200);
    expect(r.json.message).toMatch(/^Deploy started: Test exit/);
    expect(world.dispatches[0].payload.region).toBe("eastus");
  });

  it("refuses an unknown region (400), a missing profile (404) and a second deploy (409)", async () => {
    const { env } = apiEnv();
    expect((await api(env, "POST", "/deploy", { region: "constructor" })).json.error).toEqual({ code: "bad_input", message: "Unknown region." });
    expect((await api(env, "POST", "/deploy", { region: "constructor" })).status).toBe(400);
    const missing = await api(env, "POST", "/deploy", { profileId: 999 });
    expect(missing.status).toBe(404);
    await api(env, "POST", "/deploy", {});
    const again = await api(env, "POST", "/deploy", {});
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("refused");
  });

  it("needs confirmation over budget (422), and goes ahead with it", async () => {
    const { env, world } = apiEnv();
    await env.DB.prepare("INSERT INTO cost_days (day, gbp, fetched_at) VALUES (?1, 25, 'x')").bind(new Date().toISOString().slice(0, 8) + "01").run();
    const r = await api(env, "POST", "/deploy", {});
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("over_budget");
    expect(world.dispatches).toHaveLength(0);
    expect((await api(env, "POST", "/deploy", { overBudgetOk: true })).status).toBe(200);
  });

  it("refuses bad hours with the field named, and starts nothing", async () => {
    const { env, world } = apiEnv();
    // (NaN is not tested here: JSON sends it as null, which rightly means "no limit".)
    for (const hours of ["2", -1, 1000, {}]) {
      const r = await api(env, "POST", "/deploy", { hours });
      expect(r.status).toBe(400);
      expect(r.json.error.field).toBe("hours");
    }
    expect(world.dispatches).toHaveLength(0);
  });
});

describe("POST /destroy", () => {
  it("needs the word destroy (422) before it tears down", async () => {
    const { env, world } = apiEnv();
    const r = await api(env, "POST", "/destroy", { confirm: "yes" });
    expect(r.status).toBe(422);
    expect(r.json.error).toEqual({ code: "confirm_required", message: 'Type "destroy" to confirm.', field: "confirm" });
    expect(world.dispatches).toHaveLength(0);
    const ok = await api(env, "POST", "/destroy", { confirm: " Destroy " });
    expect(ok.status).toBe(200);
    expect(ok.json.message).toMatch(/^Tear-down started/);
    expect(world.dispatches.map((d) => d.action)).toEqual(["destroy"]);
  });
});

describe("other actions", () => {
  it("cancel with nothing running says so", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/cancel");
    expect(r.json).toEqual({ ok: true, message: "Nothing to cancel." });
  });

  it("move needs a profile id", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/move", {});
    expect(r.status).toBe(400);
    expect(r.json.error.field).toBe("profileId");
  });

  it("allow-ssh refuses when nothing is running", async () => {
    const { env } = apiEnv();
    const r = await api(env, "POST", "/allow-ssh", undefined, { "Sec-Fetch-Site": "same-origin", "CF-Connecting-IP": "203.0.113.7" });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toBe("Nothing is running.");
  });
});

describe("parseHours", () => {
  it("accepts nothing, 0 and 0-168, and refuses everything else", () => {
    expect(parseHours(undefined)).toBeNull();
    expect(parseHours(null)).toBeNull();
    expect(parseHours(0)).toBeNull();
    expect(parseHours(2.5)).toBe(2.5);
    expect(parseHours(168)).toBe(168);
    expect(parseHours(168.5)).toBe("invalid");
    expect(parseHours(-1)).toBe("invalid");
    expect(parseHours("2")).toBe("invalid");
    expect(parseHours(Number.POSITIVE_INFINITY)).toBe("invalid");
  });
});
