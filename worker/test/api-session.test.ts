// api-session.test.ts
//
// Plain English: who is signed in, which build is running, what setup is
// missing and the watchman notes nobody has read; and marking them read.
import { describe, it, expect, afterEach, vi } from "vitest";
import { api, apiEnv } from "./api-helpers";
import * as db from "../src/db";
import { BUILD } from "../src/build";

afterEach(() => vi.unstubAllGlobals());

describe("GET /session", () => {
  it("says who is signed in, the build, the setup gaps and the unread notes", async () => {
    const { env } = apiEnv();
    await db.addAlert(env, "drift", "Azure still has resource group rg-wg-ondemand.");
    const r = await api(env, "GET", "/session");
    expect(r.status).toBe(200);
    expect(r.json.user).toBe("dev@localhost");
    expect(r.json.build).toBe(BUILD);
    expect(typeof r.json.now).toBe("string");
    expect(r.json.setupMissing).toEqual(expect.any(Object));
    expect(r.json.notes.map((n: { message: string }) => n.message)).toEqual(["Azure still has resource group rg-wg-ondemand."]);
  });
});

describe("POST /notes/ack", () => {
  it("marks every note read", async () => {
    const { env } = apiEnv();
    await db.addAlert(env, "info", "Old note");
    const r = await api(env, "POST", "/notes/ack");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, message: "Notes marked as read." });
    expect(await db.unacknowledgedAlerts(env)).toHaveLength(0);
  });
});
