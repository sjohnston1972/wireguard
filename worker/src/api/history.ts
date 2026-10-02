// api/history.ts
//
// Plain English: the recorded history for a chart: the VM's (health,
// traffic, availability) or one client's (online, latency, bytes), for the
// last hour, day, week or 30 days.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { readVmHistory, readClientHistory, RANGE_MS, type HistoryRange } from "../history";

export function registerHistory(api: Hono<ApiEnv>): void {
  api.get("/history", async (c) => {
    const range = c.req.query("range") ?? "";
    if (!Object.hasOwn(RANGE_MS, range)) return fail(c, 400, "bad_input", "Range is one of 1h, 24h, 7d or 30d.", "range");
    const scope = c.req.query("scope");
    const now = new Date();
    if (scope === "vm") return c.json(await readVmHistory(c.env, range as HistoryRange, now));
    if (scope !== "client") return fail(c, 400, "bad_input", "Scope is vm or client.", "scope");
    const id = Number(c.req.query("id"));
    if (!Number.isInteger(id) || id < 1) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    if (!(await db.getPeer(c.env, id))) return fail(c, 404, "not_found", "No such client.");
    return c.json(await readClientHistory(c.env, id, range as HistoryRange, now));
  });
}
