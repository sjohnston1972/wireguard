// api/index.ts
//
// Plain English: the data API's route list. Each area registers its own
// routes; the catch-all at the end answers anything else with a JSON 404.

import { createApi, fail, type ApiEnv } from "./app";
import type { Hono } from "hono";

export function buildApi(): Hono<ApiEnv> {
  const api = createApi();
  // Area routes are registered here (later tasks), before the catch-all.
  api.all("*", (c) => fail(c, 404, "not_found", "No such API route."));
  return api;
}
