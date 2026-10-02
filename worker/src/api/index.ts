// api/index.ts
//
// Plain English: the data API's route list. Each area registers its own
// routes; the catch-all at the end answers anything else with a JSON 404.

import { createApi, fail, type ApiEnv } from "./app";
import type { Hono } from "hono";
import { registerSession } from "./session";
import { registerOverview } from "./overview";
import { registerLifecycle } from "./lifecycle";
import { registerHistory } from "./history";
import { registerClients } from "./clients";
import { registerFirewall } from "./firewall";
import { registerActivity } from "./activity";
import { registerCost } from "./cost";
import { registerSettings } from "./settings";
import { registerBackup } from "./backup";
import { registerPush } from "./push";
import { registerHealthCheck } from "./healthcheck";

export function buildApi(): Hono<ApiEnv> {
  const api = createApi();
  // Area routes, before the catch-all.
  registerSession(api);
  registerOverview(api);
  registerLifecycle(api);
  registerHistory(api);
  registerClients(api);
  registerFirewall(api);
  registerActivity(api);
  registerCost(api);
  registerSettings(api);
  registerBackup(api);
  registerPush(api);
  registerHealthCheck(api);
  api.all("*", (c) => fail(c, 404, "not_found", "No such API route."));
  return api;
}
