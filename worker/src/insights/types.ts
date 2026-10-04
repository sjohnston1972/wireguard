// insights/types.ts
//
// Plain English: the contract of the Azure insights collector (spec
// 2026-10-04-azure-insights-design.md, sections 3, 4 and 7). A feed is a
// module in insights/feeds/<id>.ts that fetches from Azure, normalises the
// answer and stores it in D1; the runner (insights/runner.ts) runs the due
// feeds on the second cron, each in its own try/catch, under one budget of
// outside calls per run. This file is frozen for the areas (X0 owns it):
// a change goes through the integrator.

import type { Env } from "../env";
import type { Config } from "../env";
import type { Snapshot } from "../state";
import type { AzureHealth, BootLogResponse, FeedId, FeedState } from "../../../shared/api";
import { FEEDS } from "../../../shared/azureMetrics";

export type { FeedId, FeedState };

/** Every feed id, in the runner's priority order. */
export const FEED_IDS: readonly FeedId[] = FEEDS.map((f) => f.id);
/** Each feed's plain title. */
export const FEED_TITLES = Object.fromEntries(FEEDS.map((f) => [f.id, f.title])) as Record<FeedId, string>;
/** The feeds plus the daily prune, which runs like a feed (az_feed row 'housekeeping') but is never shown. */
export type InsightsFeedId = FeedId | "housekeeping";

/** The watchman's cron (wrangler.toml), unchanged. Any cron that is not INSIGHTS_CRON goes to the watchman. */
export const WATCHMAN_CRON = "*/5 * * * *";
/** The collector's own cron: two minutes after each watchman tick, in its own invocation and subrequest budget. */
export const INSIGHTS_CRON = "2-59/5 * * * *";

/** The most outside calls (fetches) one insights run may make. The Workers Free plan allows 50 per invocation. */
export const AZ_RUN_BUDGET = 25;

/** Every table migration 0019 adds (the seeder wipes them; none is in the backup). */
export const AZ_TABLES = ["hist_az_vm", "hist_az_pip", "az_feed", "az_latest", "az_activity", "az_service_events", "az_capacity", "az_prices"] as const;
export type AzTable = (typeof AZ_TABLES)[number];

/** Thrown by Budget.take before a fetch that would pass the run's budget. It ends that one feed (recorded as skipped), never the run. */
export class BudgetExceeded extends Error {
  constructor(
    readonly wanted: number,
    readonly remainingCalls: number,
    readonly limit: number,
  ) {
    super(`This run's budget of ${limit} Azure calls is used up (${wanted} wanted, ${remainingCalls} left).`);
    this.name = "BudgetExceeded";
  }
}

/** The run's allowance of outside calls. */
export interface Budget {
  /** Take `n` calls (default 1) or throw BudgetExceeded, taking none. */
  take(n?: number): void;
  remaining(): number;
  used(): number;
}

export function makeBudget(limit: number = AZ_RUN_BUDGET): Budget {
  let used = 0;
  return {
    take(n = 1) {
      if (used + n > limit) throw new BudgetExceeded(n, limit - used, limit);
      used += n;
    },
    remaining: () => limit - used,
    used: () => used,
  };
}

/** True when all four service principal values are set (and are not the .env.example placeholders). Without them every feed is not_configured and nothing is fetched. */
export function insightsConfigured(env: Env): boolean {
  return [env.AZURE_TENANT_ID, env.AZURE_CLIENT_ID, env.AZURE_CLIENT_SECRET, env.AZURE_SUBSCRIPTION_ID].every((v) => typeof v === "string" && v.trim() !== "" && !/^REPLACE_ME/.test(v));
}

// ── What the feeds store as JSON (az_latest.json, az_capacity.json) ────────

/** az_latest['health']: the summary's `health` less its annotations (those come from az_activity rows with category ResourceHealth). */
export type HealthDoc = Omit<AzureHealth, "annotations">;
/** az_latest['metricDefs']: the metric names Azure emits for each resource; null until read. Metric calls ask only for these. */
export interface MetricDefsDoc {
  vm: string[] | null;
  pip: string[] | null;
}
/** az_latest['bootlog']: the last boot log, already redacted and capped at 64 KB, exactly as GET /azure/bootlog serves it. Never a SAS URL. */
export type BootLogDoc = BootLogResponse;
/** az_capacity.json for one region: each size of interest, the vCPU quota per family (`family` = usages' name.value), and the regional total. */
export interface CapacityDoc {
  sizes: { name: string; available: boolean; reason: string | null; vcpus: number | null; family: string | null }[];
  usages: { family: string; used: number; limit: number }[];
  cores: { used: number; limit: number } | null;
}

/** When a feed applies: always; while the resource group exists; while the VM exists; while it runs (vmMetrics: and up to 15 min after it stops). */
export type FeedWhen = "always" | "rg" | "vm" | "running";

/** What a feed's run gets. Every outside call goes through `arm` or `fetch`, which take from `budget` and abort after 8 s. */
export interface FeedCtx {
  env: Env;
  /** An ARM call: `path` starts with "/subscriptions/..." (or is a full https://management.azure.com URL); the bearer token is added. */
  arm(path: string, init?: RequestInit): Promise<Response>;
  /** Any other outside call (the no-auth price API, a SAS blob URL). Errors never quote the URL. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  db: D1Database;
  now: Date;
  snap: Snapshot;
  cfg: Config;
  budget: Budget;
  /**
   * The runner only: this feed's az_feed row as the run read it (the run reads
   * az_feed once), and a way to make another feed due that this run sees at
   * once and saves with its results. Without them (a one-off job), markDue
   * in common.ts writes to D1 straight away.
   */
  row?: { last_try_at: string | null; last_ok_at: string | null; next_due_at: string | null } | null;
  markDue?(feed: string): void;
}

/** How one feed's run went; the runner writes it to az_feed. */
export interface FeedResult {
  status: Exclude<FeedState, "idle">;
  /** Plain words, no URL with a signature; null when status is ok. */
  error: string | null;
  /** When it is next due; null = its cadence from now. */
  nextDueAt?: string | null;
}

/**
 * A feed module's default export. Each feed module also exports its
 * `fetch`, `normalise` and `store` steps separately, so each can be tested
 * without a network.
 */
export interface Feed {
  id: InsightsFeedId;
  title: string;
  /** Minutes between runs while it applies; null = on demand. */
  cadenceMin: number | null;
  when: FeedWhen;
  /** The most outside calls one run of it makes (the runner skips it when fewer remain). */
  calls: number;
  run(ctx: FeedCtx): Promise<FeedResult>;
}
