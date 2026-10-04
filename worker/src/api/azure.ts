// api/azure.ts
//
// Plain English: what the app reads about Azure and the VM (spec
// 2026-10-04-azure-insights-design.md, section 8). Every route reads D1 and
// the snapshot only, never Azure, except POST bootlog and a capacity cache
// miss (insights/ondemand.ts), each in its own small budget. All sit behind
// the login and the same-origin check, like the rest of /api/v1. Without
// Azure credentials everything answers `configured: false`, every feed
// reads not_configured, and nothing is fetched.
//
//   GET  /api/v1/azure/summary
//   GET  /api/v1/azure/metrics?resource=vm|pip|vitals&range=1h|24h|7d|30d
//   GET  /api/v1/azure/changes?range=24h|7d|30d|90d&who=all|others|wgadmin
//   GET  /api/v1/azure/service-health?range=7d|30d|90d
//   GET  /api/v1/azure/capacity?region=&size=
//   GET  /api/v1/azure/price?region=&size=
//   GET  /api/v1/azure/diagnostics
//   GET  /api/v1/azure/bootlog     POST /api/v1/azure/bootlog
//
// A query key a route does not take, or a value outside its list, is
// refused with 400 bad_input naming the key.

import type { Context, Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import { effectiveConfig, fixedConfig } from "../settings";
import { allSettings } from "../db";
import { getSnapshot } from "../state";
import { REGIONS, azureRegionName } from "../region";
import type { HistoryRange } from "../history";
import { insightsConfigured } from "../insights/types";
import { fixedPrice as fixedPriceInfo, priceInfo, rateSource, readPrices } from "../insights/price";
import { capacityFor, fetchBootLogNow, storedBootLog } from "../insights/ondemand";
import { feedStatus, feedStatuses, metricNames, readChanges, readMetrics, readSummary } from "../insights/read";
import { regionalEvents } from "../insights/feeds/serviceHealth";
import type {
  AzureChangesResponse,
  AzureDiagnosticsResponse,
  AzureMetricsResponse,
  AzureServiceHealthResponse,
  AzureSummaryResponse,
  BootLogResponse,
  CapacityCheck,
  PriceInfo,
} from "../../../shared/api";
import type { Env } from "../env";
import type { Config } from "../env";

/** What a bootlog answers when there is none: why, in plain words. */
export const NOT_CONNECTED = "Azure isn't connected. Add the service principal secrets to the Worker.";
const NOT_FETCHED = "No boot log has been fetched yet.";
const NO_PRICE = "Azure prices aren't collected yet, so the fixed rates apply.";

const METRIC_RANGES = ["1h", "24h", "7d", "30d"] as const;
const CHANGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
const WHO = ["all", "others", "wgadmin"] as const;
const HEALTH_RANGES = ["7d", "30d", "90d"] as const;
const HEALTH_RANGE_DAYS: Record<(typeof HEALTH_RANGES)[number], number> = { "7d": 7, "30d": 30, "90d": 90 };
const SIZE_RE = /^Standard_[A-Za-z0-9_]{1,40}$/;

type Rule = { values?: readonly string[]; test?: (v: string) => boolean; required?: boolean; default?: string; what: string };

/** The query, checked against `rules`: the values (defaults filled in), or the refusal to send. */
function readQuery(c: Context<ApiEnv>, rules: Record<string, Rule>): Record<string, string> | Response {
  const q = new URL(c.req.url).searchParams;
  for (const k of q.keys()) if (!Object.hasOwn(rules, k)) return fail(c, 400, "bad_input", `Unknown query key "${k}".`, k);
  const out: Record<string, string> = {};
  for (const [k, r] of Object.entries(rules)) {
    const v = q.get(k);
    if (v === null || v === "") {
      if (r.required) return fail(c, 400, "bad_input", `${k} is required: ${r.what}.`, k);
      if (r.default !== undefined) out[k] = r.default;
      continue;
    }
    const ok = r.values ? r.values.includes(v) : r.test ? r.test(v) : true;
    if (!ok) return fail(c, 400, "bad_input", `${k} must be ${r.what}.`, k);
    out[k] = v;
  }
  return out;
}

const oneOf = (values: readonly string[], d?: string, required = false): Rule => ({ values, default: d, required, what: `one of ${values.join(", ")}` });
const REGION: Rule = { test: (v) => Object.hasOwn(REGIONS, v), required: true, what: "an Azure region wg-admin offers (for example uksouth)" };
const SIZE: Rule = { test: (v) => SIZE_RE.test(v), required: true, what: "a VM size such as Standard_B1s" };

/** The fixed rates as a price, and why they apply (insights/price.ts). `cfg` must carry the fixed rates (fixedConfig). */
export function fixedPrice(cfg: Config, region: string, size: string, reason: string = NO_PRICE): PriceInfo {
  return fixedPriceInfo(cfg, region, size, reason);
}

function emptyBootLog(env: Env): BootLogResponse {
  return { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: insightsConfigured(env) ? NOT_FETCHED : NOT_CONNECTED };
}

export function registerAzure(api: Hono<ApiEnv>): void {
  api.get("/azure/summary", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    const [cfg, snap] = await Promise.all([effectiveConfig(c.env), getSnapshot(c.env)]);
    const out: AzureSummaryResponse = await readSummary(c.env, cfg, snap, new Date());
    return c.json(out);
  });

  api.get("/azure/metrics", async (c) => {
    const q = readQuery(c, { resource: oneOf(["vm", "pip", "vitals"], undefined, true), range: oneOf(METRIC_RANGES, undefined, true) });
    if (q instanceof Response) return q;
    const resource = q.resource as AzureMetricsResponse["resource"];
    const range = q.range as HistoryRange;
    // Azure's metrics are 5-minute slots; the vitals follow hist_vm's steps.
    const m = await readMetrics(c.env.DB, resource, range, new Date());
    const out: AzureMetricsResponse = { resource, range, step: m.step, columns: m.columns, points: m.points };
    return c.json(out);
  });

  api.get("/azure/changes", async (c) => {
    const q = readQuery(c, { range: oneOf(CHANGE_RANGES, "7d"), who: oneOf(WHO, "all") });
    if (q instanceof Response) return q;
    const now = new Date();
    const range = q.range as AzureChangesResponse["range"];
    const out: AzureChangesResponse = { range, feed: await feedStatus(c.env, await getSnapshot(c.env), "activity", now), rows: await readChanges(c.env.DB, range, q.who as "all" | "others" | "wgadmin", now) };
    return c.json(out);
  });

  api.get("/azure/service-health", async (c) => {
    const q = readQuery(c, { range: oneOf(HEALTH_RANGES, "30d") });
    if (q instanceof Response) return q;
    const now = new Date();
    const cfg = await effectiveConfig(c.env);
    const from = new Date(now.getTime() - HEALTH_RANGE_DAYS[q.range as (typeof HEALTH_RANGES)[number]] * 86_400_000).toISOString();
    const out: AzureServiceHealthResponse = { events: await regionalEvents(c.env.DB, azureRegionName(cfg.region), from), feed: await feedStatus(c.env, await getSnapshot(c.env), "serviceHealth", now) };
    return c.json(out);
  });

  api.get("/azure/capacity", async (c) => {
    const q = readQuery(c, { region: REGION, size: SIZE });
    if (q instanceof Response) return q;
    const out: CapacityCheck = await capacityFor(c.env, await effectiveConfig(c.env), q.region!, q.size!, new Date());
    return c.json(out);
  });

  api.get("/azure/price", async (c) => {
    const q = readQuery(c, { region: REGION, size: SIZE });
    if (q instanceof Response) return q;
    const [cfg, stored, rows] = await Promise.all([fixedConfig(c.env), allSettings(c.env), readPrices(c.env.DB, q.region!)]);
    const out: PriceInfo = priceInfo(rows, cfg, q.region!, q.size!, rateSource(stored), new Date());
    return c.json(out);
  });

  api.get("/azure/diagnostics", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    const out: AzureDiagnosticsResponse = { configured: insightsConfigured(c.env), feeds: await feedStatuses(c.env, await getSnapshot(c.env), new Date()), metricNames: await metricNames(c.env.DB) };
    return c.json(out);
  });

  api.get("/azure/bootlog", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    const out: BootLogResponse = await storedBootLog(c.env, NOT_CONNECTED, NOT_FETCHED);
    return c.json(out);
  });

  // Fetch now: one Worker-side fetch through a 5-minute signed link that never leaves the Worker; once a minute at most.
  api.post("/azure/bootlog", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    if (!insightsConfigured(c.env)) return c.json(emptyBootLog(c.env));
    const r = await fetchBootLogNow(c.env, new Date());
    if (r.ok) return c.json(r.doc satisfies BootLogResponse);
    if (r.why === "slow_down") return c.json({ error: { code: "slow_down", message: "The boot log was fetched less than a minute ago. Try again in a minute." } }, 429);
    return fail(c, 502, "upstream", `Could not fetch the boot log: ${r.message}`);
  });
}
