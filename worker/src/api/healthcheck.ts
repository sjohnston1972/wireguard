// api/healthcheck.ts
//
// Plain English: the "Run health check" button over the data API. It asks the
// VM to re-run its self-test; the pending request and the result show up in
// GET /overview, which already returns the snapshot. Like every button, a
// press counts as having read the notes (seen.ts).

import type { Hono } from "hono";
import type { ApiEnv } from "./app";
import { act } from "./lifecycle";
import { requestHealthCheck } from "../healthcheck";

export function registerHealthCheck(api: Hono<ApiEnv>): void {
  api.post("/health-check", (c) => act(c, () => requestHealthCheck(c.env)));
}
