// api/prefs.ts
//
// Plain English: widget preferences for the signed-in person.
//   GET /api/v1/prefs          every widget page, repaired against today's widgets
//   PUT /api/v1/prefs/:page    { baseVersion, prefs } -> the page as stored now
// The owner is always the identity the login check found (c.get("user")):
// no route takes a user, so nobody can read or change another person's.
// A body over 16 KiB is refused before it is parsed; everything else is
// checked against shared/widgets.ts (worker/src/prefs.ts) and a refusal
// names the field. 409 stale: another device saved first. 409 outdated:
// the tab runs an older dashboard and should reload.

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { getPrefs, putPrefs } from "../prefs";
import { MAX_PREFS_BODY_BYTES, PAGE_IDS, type PageId } from "../../../shared/widgets";
import type { PrefsPutBody } from "../../../shared/api";

const TOO_BIG = `Widget settings are too large to save (over ${MAX_PREFS_BODY_BYTES / 1024} KiB).`;

export function registerPrefs(api: Hono<ApiEnv>): void {
  api.get("/prefs", async (c) => c.json(await getPrefs(c.env, c.get("user"))));

  api.put("/prefs/:page", async (c) => {
    const page = c.req.param("page");
    if (!(PAGE_IDS as readonly string[]).includes(page)) return fail(c, 404, "not_found", "No such page.");

    // The size first, on the raw text, before anything parses it.
    const declared = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_PREFS_BODY_BYTES) return fail(c, 400, "bad_input", TOO_BIG, "prefs");
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_PREFS_BODY_BYTES) return fail(c, 400, "bad_input", TOO_BIG, "prefs");

    // body() reads the same (cached) text and refuses what is not a JSON object.
    const b = await body<Record<string, unknown>>(c);
    if (!b) return fail(c, 400, "bad_input", "Send { baseVersion, prefs }.", "prefs");
    const unknown = Object.keys(b).find((k) => k !== "baseVersion" && k !== "prefs");
    if (unknown !== undefined) return fail(c, 400, "bad_input", `Unknown field "${unknown}".`, unknown);
    if (!Object.prototype.hasOwnProperty.call(b, "prefs")) return fail(c, 400, "bad_input", "prefs is required.", "prefs");
    const { baseVersion, prefs } = b as unknown as PrefsPutBody;

    const r = await putPrefs(c.env, c.get("user"), page as PageId, baseVersion, prefs);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    return c.json(r.page);
  });
}
