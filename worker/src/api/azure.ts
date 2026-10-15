// api/azure.ts
//
// Plain English: what the app reads about the cloud and the VM (spec
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
//
// With the server in AWS (AWS insights spec section 6; the snapshot's cloud,
// kept after a destroy) the same routes answer from AWS's tables in the same
// shapes, tagged cloud "aws"; capacity and price take an AWS region and
// instance type (eu-west-2, t4g.micro) and answer from AWS's tables.

import type { Context, Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import { effectiveConfig, fixedConfig } from "../settings";
import { allSettings } from "../db";
import { cloudOf, getSnapshot } from "../state";
import { REGIONS } from "../region";
import type { HistoryRange } from "../history";
import { insightsConfigured } from "../insights/types";
import { fixedPrice as fixedPriceInfo, priceInfo, rateSource, readPrices } from "../insights/price";
import { awsBootLogNow, awsCapacityFor, capacityFor, fetchBootLogNow, storedBootLog } from "../insights/ondemand";
import { feedStatus, readChanges, readDiagnostics, readMetrics, readSummary, serviceEvents } from "../insights/read";
import { awsConfigured } from "../insights/aws/types";
import { AWS_NOT_CONNECTED, readAwsPrices, storedAwsBootLog } from "../insights/aws/read";
import { awsPriceInfo } from "../insights/aws/feeds/prices";
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
/** An AWS region id (eu-west-2) and an EC2 instance type (t4g.micro). */
const AWS_REGION_RE = /^[a-z]{2}(-gov)?-[a-z]{4,10}-\d{1,2}$/;
const AWS_SIZE_RE = /^[a-z][a-z0-9-]{0,15}\.[a-z0-9]{1,20}$/;

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
const REGION: Rule = { test: (v) => Object.hasOwn(REGIONS, v) || AWS_REGION_RE.test(v), required: true, what: "an Azure region cloudlabs offers (for example uksouth) or an AWS region (for example eu-west-2)" };
const SIZE: Rule = { test: (v) => SIZE_RE.test(v) || AWS_SIZE_RE.test(v), required: true, what: "a VM size such as Standard_B1s, or an EC2 instance type such as t4g.micro" };

/** Region and size, checked as a pair: an AWS region takes an EC2 instance type, an Azure region an Azure size. Null when they match. */
function pairRefusal(c: Context<ApiEnv>, region: string, size: string): Response | null {
  const aws = AWS_REGION_RE.test(region);
  if (aws && !AWS_SIZE_RE.test(size)) return fail(c, 400, "bad_input", "size must be an EC2 instance type such as t4g.micro for an AWS region.", "size");
  if (!aws && !SIZE_RE.test(size)) return fail(c, 400, "bad_input", "size must be a VM size such as Standard_B1s for an Azure region.", "size");
  return null;
}

/** The fixed rates as a price, and why they apply (insights/price.ts). `cfg` must carry the fixed rates (fixedConfig). */
export function fixedPrice(cfg: Config, region: string, size: string, reason: string = NO_PRICE): PriceInfo {
  return fixedPriceInfo(cfg, region, size, reason);
}

function emptyBootLog(env: Env): BootLogResponse {
  return { fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: insightsConfigured(env) ? NOT_FETCHED : NOT_CONNECTED };
}
const awsNotConnected = (): BootLogResponse => ({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason: AWS_NOT_CONNECTED });

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
    // 5-minute slots (Azure's, or CloudWatch's) from the server's cloud; the vitals follow hist_vm's steps.
    const cloud = cloudOf(await getSnapshot(c.env));
    const m = await readMetrics(c.env.DB, resource, range, new Date(), cloud);
    const out: AzureMetricsResponse = { cloud, resource, range, step: m.step, columns: m.columns, points: m.points };
    return c.json(out);
  });

  api.get("/azure/changes", async (c) => {
    const q = readQuery(c, { range: oneOf(CHANGE_RANGES, "7d"), who: oneOf(WHO, "all") });
    if (q instanceof Response) return q;
    const now = new Date();
    const range = q.range as AzureChangesResponse["range"];
    const snap = await getSnapshot(c.env);
    const cloud = cloudOf(snap);
    const out: AzureChangesResponse = { cloud, range, feed: await feedStatus(c.env, snap, "activity", now), rows: await readChanges(c.env.DB, range, q.who as "all" | "others" | "wgadmin", now, cloud) };
    return c.json(out);
  });

  api.get("/azure/service-health", async (c) => {
    const q = readQuery(c, { range: oneOf(HEALTH_RANGES, "30d") });
    if (q instanceof Response) return q;
    const now = new Date();
    const [cfg, snap] = await Promise.all([effectiveConfig(c.env), getSnapshot(c.env)]);
    const cloud = cloudOf(snap);
    const from = new Date(now.getTime() - HEALTH_RANGE_DAYS[q.range as (typeof HEALTH_RANGES)[number]] * 86_400_000).toISOString();
    const out: AzureServiceHealthResponse = { cloud, events: await serviceEvents(c.env.DB, cfg, cloud, from), feed: await feedStatus(c.env, snap, "serviceHealth", now) };
    return c.json(out);
  });

  // Capacity and price: the cloud is the region's (an AWS region answers from AWS's tables), whatever the server is doing.
  api.get("/azure/capacity", async (c) => {
    const q = readQuery(c, { region: REGION, size: SIZE });
    if (q instanceof Response) return q;
    const bad = pairRefusal(c, q.region!, q.size!);
    if (bad) return bad;
    const cfg = await effectiveConfig(c.env);
    const out: CapacityCheck = AWS_REGION_RE.test(q.region!) ? await awsCapacityFor(c.env, cfg, q.region!, q.size!, new Date()) : await capacityFor(c.env, cfg, q.region!, q.size!, new Date());
    return c.json(out);
  });

  api.get("/azure/price", async (c) => {
    const q = readQuery(c, { region: REGION, size: SIZE });
    if (q instanceof Response) return q;
    const bad = pairRefusal(c, q.region!, q.size!);
    if (bad) return bad;
    if (AWS_REGION_RE.test(q.region!)) {
      const [cfg, rows] = await Promise.all([fixedConfig(c.env), readAwsPrices(c.env.DB, q.region!)]);
      const out: PriceInfo = awsPriceInfo(rows, cfg, q.region!, q.size!, new Date());
      return c.json(out);
    }
    const [cfg, stored, rows] = await Promise.all([fixedConfig(c.env), allSettings(c.env), readPrices(c.env.DB, q.region!)]);
    const out: PriceInfo = priceInfo(rows, cfg, q.region!, q.size!, rateSource(stored), new Date());
    return c.json(out);
  });

  api.get("/azure/diagnostics", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    // configured as the screens show it (insightsShown), so the diagnostics agree with the widgets.
    const out: AzureDiagnosticsResponse = await readDiagnostics(c.env, await getSnapshot(c.env), new Date());
    return c.json(out);
  });

  api.get("/azure/bootlog", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    const snap = await getSnapshot(c.env);
    const out: BootLogResponse = cloudOf(snap) === "aws" ? await storedAwsBootLog(c.env, snap) : await storedBootLog(c.env, NOT_CONNECTED, NOT_FETCHED);
    return c.json(out);
  });

  // Fetch now: one Worker-side fetch (Azure: through a 5-minute signed link that never leaves the Worker; AWS: GetConsoleOutput); once a minute at most.
  api.post("/azure/bootlog", async (c) => {
    const q = readQuery(c, {});
    if (q instanceof Response) return q;
    const aws = cloudOf(await getSnapshot(c.env)) === "aws";
    if (aws ? !awsConfigured(c.env) : !insightsConfigured(c.env)) return c.json(aws ? awsNotConnected() : emptyBootLog(c.env));
    const r = aws ? await awsBootLogNow(c.env, new Date()) : await fetchBootLogNow(c.env, new Date());
    if (r.ok) return c.json(r.doc satisfies BootLogResponse);
    if (r.why === "slow_down") return c.json({ error: { code: "slow_down", message: "The boot log was fetched less than a minute ago. Try again in a minute." } }, 429);
    return fail(c, 502, "upstream", `Could not fetch the boot log: ${r.message}`);
  });
}
