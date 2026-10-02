// api/healthcheck.ts
//
// Plain English: the "Run health check" button over the data API. It asks the
// VM to re-run its self-test; the pending request and the result show up in
// GET /overview, which already returns the snapshot.

import type { Hono } from "hono";
import type { ApiEnv } from "./app";
import { requestHealthCheck } from "../healthcheck";
import type { ApiOk } from "../../../shared/api";

export function registerHealthCheck(api: Hono<ApiEnv>): void {
  api.post("/health-check", async (c) => {
    const out: ApiOk = { ok: true, message: await requestHealthCheck(c.env) };
    return c.json(out);
  });
}
