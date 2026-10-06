// api/prefs.ts
//
// Plain English: widget preferences for the signed-in person.
//   GET /api/v1/prefs          every widget page, repaired against today's widgets
//   PUT /api/v1/prefs/:page    { schema: 2, baseVersion, prefs } -> the page as stored now
// The owner is always the identity the login check found (c.get("user")):
// no route takes a user, so nobody can read or change another person's.
// A body over 16 KiB is refused before it is parsed; everything else is
// checked against shared/widgets.ts (worker/src/prefs.ts) and a refusal
// names the field. 409 stale: another device saved first. 409 outdated:
// the tab runs an older dashboard and should reload (also any save without
// schema 2: that bundle would drop layout.shown).

import type { Hono } from "hono";
import { body, fail, type ApiEnv } from "./app";
import { getPrefs, getTopologyLayout, putPrefs, putTopologyLayout, schemaRefusal } from "../prefs";
import { labDef } from "../labs/catalogue";
import { MAX_TOPOLOGY_BODY_BYTES, type TopologyLayoutPutBody } from "../../../shared/topology/layout";
import { MAX_PREFS_BODY_BYTES, PAGE_IDS, type PageId } from "../../../shared/widgets";
import type { PrefsPutBody } from "../../../shared/api";

const TOO_BIG = `Widget settings are too large to save (over ${MAX_PREFS_BODY_BYTES / 1024} KiB).`;

const TOO_BIG_LAYOUT = `This diagram layout is too large to save (over ${MAX_TOPOLOGY_BODY_BYTES / 1024} KiB).`;

export function registerPrefs(api: Hono<ApiEnv>): void {
  api.get("/prefs", async (c) => c.json(await getPrefs(c.env, c.get("user"))));

  // A lab diagram's saved arrangement (lab topology spec §8.3): registered before /prefs/:page.
  api.get("/prefs/topology/:labId", async (c) => {
    const labId = c.req.param("labId");
    if (!labDef(labId)) return fail(c, 404, "not_found", "No such lab.");
    return c.json(await getTopologyLayout(c.env, c.get("user"), labId));
  });

  api.put("/prefs/topology/:labId", async (c) => {
    const labId = c.req.param("labId");
    if (!labDef(labId)) return fail(c, 404, "not_found", "No such lab.");

    // The size first, on the raw text, before anything parses it.
    const declared = Number(c.req.header("Content-Length"));
    if (Number.isFinite(declared) && declared > MAX_TOPOLOGY_BODY_BYTES) return fail(c, 400, "bad_input", TOO_BIG_LAYOUT, "layout");
    const text = await c.req.text();
    if (new TextEncoder().encode(text).length > MAX_TOPOLOGY_BODY_BYTES) return fail(c, 400, "bad_input", TOO_BIG_LAYOUT, "layout");

    const b = await body<Record<string, unknown>>(c);
    if (!b) return fail(c, 400, "bad_input", "Send { baseVersion, layout }.", "layout");
    const unknown = Object.keys(b).find((k) => k !== "baseVersion" && k !== "layout");
    if (unknown !== undefined) return fail(c, 400, "bad_input", `Unknown field "${unknown}".`, unknown);
    if (!Object.prototype.hasOwnProperty.call(b, "layout")) return fail(c, 400, "bad_input", "layout is required.", "layout");
    const { baseVersion, layout } = b as unknown as TopologyLayoutPutBody;
    const r = await putTopologyLayout(c.env, c.get("user"), labId, baseVersion, layout);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    return c.json(r.page);
  });

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
    const unknown = Object.keys(b).find((k) => k !== "baseVersion" && k !== "prefs" && k !== "schema");
    if (unknown !== undefined) return fail(c, 400, "bad_input", `Unknown field "${unknown}".`, unknown);
    if (!Object.prototype.hasOwnProperty.call(b, "prefs")) return fail(c, 400, "bad_input", "prefs is required.", "prefs");
    const { baseVersion, prefs } = b as unknown as PrefsPutBody;

    // A good baseVersion first (putPrefs says why it is not), then the schema: a tab without
    // schema 2 runs an older bundle that would drop layout.shown, so it is told to reload.
    if (Number.isInteger(baseVersion) && baseVersion >= 0) {
      const s = schemaRefusal(b.schema);
      if (s) return fail(c, s.status, s.code, s.message, "schema");
    }
    const r = await putPrefs(c.env, c.get("user"), page as PageId, baseVersion, prefs);
    if (!r.ok) return fail(c, r.status, r.code, r.message, r.field);
    return c.json(r.page);
  });
}
