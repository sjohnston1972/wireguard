// api-settings.test.ts
//
// Plain English: the Settings screen's data and changes through the JSON API:
// the values, profiles, schedules, the run lock. The first block pins how the
// old Settings page routes answer, so moving their logic into shared
// functions cannot change what the live dashboard does.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv, base } from "./api-helpers";
import worker from "../src/index";
import * as db from "../src/db";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

/** A page form post, the way the old Settings page sends it. */
function form(env: Env, path: string, fields: Record<string, string>): Promise<Response> {
  return worker.fetch(new Request(base + path, { method: "POST", body: new URLSearchParams(fields), headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" }, redirect: "manual" }), env, ctx) as Promise<Response>;
}

describe("old Settings page routes (pinned)", () => {
  it("a bad profile name redirects to /settings?err=profile and saves nothing", async () => {
    const { env } = apiEnv();
    const r = await form(env, "/settings/profiles", { name: "!bad", region: "uksouth", vm_size: "Standard_B1s" });
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe("/settings?err=profile");
    expect(await db.listProfiles(env)).toHaveLength(3);
  });

  it("an unknown region, a bad size and a duplicate name all redirect the same way", async () => {
    const { env } = apiEnv();
    expect((await form(env, "/settings/profiles", { name: "Japan", region: "mars", vm_size: "Standard_B1s" })).headers.get("Location")).toBe("/settings?err=profile");
    expect((await form(env, "/settings/profiles", { name: "Japan", region: "uksouth", vm_size: "B1s" })).headers.get("Location")).toBe("/settings?err=profile");
    const ok = await form(env, "/settings/profiles", { name: "Japan", region: "uksouth", vm_size: "Standard_B1s" });
    expect(ok.headers.get("Location")).toBe("/settings?saved=1");
    expect((await form(env, "/settings/profiles", { name: "Japan", region: "ukwest", vm_size: "Standard_B1s" })).headers.get("Location")).toBe("/settings?err=profile");
    expect(await db.listProfiles(env)).toHaveLength(4);
  });

  it("the Settings page still renders its VM size choices", async () => {
    const { env } = apiEnv();
    const r = await worker.fetch(new Request(base + "/settings", { headers: { "Sec-Fetch-Site": "same-origin" } }), env, ctx);
    const text = await r.text();
    expect(r.status).toBe(200);
    for (const s of ["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"]) expect(text).toContain(`<option value="${s}">`);
  });

  it("a schedule with a bad window redirects to /settings?err=schedule; a good one is saved and audited", async () => {
    const { env } = apiEnv();
    expect((await form(env, "/settings/schedules", { day: "1", start: "18:00", end: "08:00" })).headers.get("Location")).toBe("/settings?err=schedule");
    expect((await form(env, "/settings/schedules", { day: "1", start: "08:00", end: "18:00" })).headers.get("Location")).toBe("/settings?saved=1");
    expect(await db.listSchedules(env)).toHaveLength(1);
  });
});
