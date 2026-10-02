// api-backup.test.ts
//
// Plain English: backups and restore through the JSON API: the export
// download, a nightly copy, and the two-step restore (preview, then type
// "restore"). The first block pins the old restore page so moving the
// "is a run in progress" check out of index.ts cannot change it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { apiEnv, base } from "./api-helpers";
import worker from "../src/index";
import * as db from "../src/db";
import type { Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

function upload(env: Env, text: string): Promise<Response> {
  const f = new FormData();
  f.append("file", new File([text], "wg-admin-config-2026-10-02.json", { type: "application/json" }));
  return worker.fetch(new Request(base + "/settings/backup/restore", { method: "POST", body: f, headers: { "Sec-Fetch-Site": "same-origin" } }), env, ctx) as Promise<Response>;
}

describe("old restore page (pinned)", () => {
  it("still renders its page, and still refuses while a run is active", async () => {
    const { env } = apiEnv();
    const r = await upload(env, "not json");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("That file is not JSON.");
    await env.DB.prepare("INSERT OR REPLACE INTO runs (id, action, status, requested_at) VALUES ('busy', 'apply', 'running', ?1)").bind(new Date().toISOString()).run();
    expect(await (await upload(env, "{}")).text()).toContain("A run is in progress. Wait for it to finish, then restore.");
  });
});
