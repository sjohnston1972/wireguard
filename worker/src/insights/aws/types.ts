// insights/aws/types.ts
//
// Plain English: the contract of the AWS half of the insights collector
// (spec 2026-10-15-aws-insights-design.md, sections 3, 4 and 9). An AWS feed
// is a module in insights/aws/feeds/<name>.ts that asks AWS, normalises the
// answer and stores it in the aws_* tables (migration 0024); the runner
// (insights/aws/runner.ts) runs the due ones beside Azure's, under the same
// budget of outside calls, each in its own try/catch. The read layer maps
// each AWS feed back onto the Azure FeedId it stands in for, so the pages
// read the same shapes whichever cloud the server is in. This file is frozen
// for the parallel tasks: a change goes through the integrator.

import type { Env, Config } from "../../env";
import { canAws, config } from "../../env";
import type { Snapshot } from "../../state";
import type { AzureHealth, BootLogResponse, FeedId, ScheduledEvent } from "../../../../shared/api";
import type { Budget, FeedResult } from "../types";
import type { FeedRow } from "../common";

export type AwsFeedId = "aws.health" | "aws.metrics" | "aws.activity" | "aws.serviceHealth" | "aws.capacity" | "aws.prices" | "aws.bootLog" | "aws.housekeeping";

/** Every AWS feed id, in the runner's priority order (spec section 4), the daily prune last. */
export const AWS_FEED_IDS: readonly AwsFeedId[] = ["aws.health", "aws.metrics", "aws.activity", "aws.serviceHealth", "aws.capacity", "aws.prices", "aws.bootLog", "aws.housekeeping"];

/** Which Azure FeedIds each AWS feed stands in for on screen (metrics → vmMetrics and pipMetrics). */
export const AWS_STANDS_IN: Record<Exclude<AwsFeedId, "aws.housekeeping">, FeedId[]> = {
  "aws.health": ["health"],
  "aws.metrics": ["vmMetrics", "pipMetrics"],
  "aws.activity": ["activity"],
  "aws.serviceHealth": ["serviceHealth"],
  "aws.capacity": ["capacity"],
  "aws.prices": ["prices"],
  "aws.bootLog": ["bootLog"],
};

/** The footer's source label per AWS feed (FeedStatus.source). */
export const AWS_SOURCES: Record<Exclude<AwsFeedId, "aws.housekeeping">, string> = {
  "aws.health": "AWS EC2",
  "aws.metrics": "AWS CloudWatch",
  "aws.activity": "AWS CloudTrail",
  "aws.serviceHealth": "AWS public status feed",
  "aws.capacity": "AWS Service Quotas",
  "aws.prices": "AWS Price List",
  "aws.bootLog": "AWS console output",
};

/**
 * When an AWS feed applies: always (while AWS is configured); server = the
 * server is in AWS and not destroyed (the headend may exist); running = the
 * server is in AWS and running, or stopped at most 15 minutes ago.
 */
export type AwsFeedWhen = "always" | "server" | "running";

/** The headend as EC2 describes it (DescribeInstances, tag wg-admin-role=headend). */
export interface AwsHeadend {
  id: string;
  /** EC2's state name: pending, running, stopping, stopped, shutting-down. */
  state: string;
  /** When it last started (ISO), or null. */
  launchTime: string | null;
  instanceType: string | null;
}

/**
 * What an AWS feed's run gets. Every outside call goes through one of the
 * helpers, which take from `budget` (1 call each), give up after 8 s, stop
 * once the run is out of time, never quote a URL, key or signature in an
 * error, and turn AWS throttling into AwsThrottled.
 */
export interface AwsFeedCtx {
  env: Env;
  db: D1Database;
  now: Date;
  snap: Snapshot;
  cfg: Config;
  budget: Budget;
  /** config(env).aws.region */
  region: string;
  /** One EC2 Query API call in the region (`params` in the Query API's flat names); the XML. 1 call. */
  ec2(action: string, params?: Record<string, string>): Promise<string>;
  /** One Query API call to another service in the region (CloudWatch: "monitoring", Version 2010-08-01); the XML. 1 call. */
  query(service: "monitoring", action: string, params: Record<string, string>, version: string): Promise<string>;
  /** One JSON 1.1 call (CloudTrail, Service Quotas, the Price List, tagging); the parsed answer. 1 call. */
  json<T>(o: { service: string; region: string; host: string; target: string; body: unknown }): Promise<T>;
  /** An unsigned call (the public status RSS). 1 call. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** The headend, or null when there is none. Looked up once per run and shared by the feeds; 1 call the first time. */
  headend(): Promise<AwsHeadend | null>;
  /** The ids (the last ARN segment: i-…, sg-…, eipalloc-…) of every resource tagged wg-admin=vpn. Once per run; 1 call the first time. */
  taggedIds(): Promise<Set<string>>;
  /** The runner only: this feed's aws_feed row as the run read it. */
  row?: { last_try_at: string | null; last_ok_at: string | null; next_due_at: string | null } | null;
}

/**
 * An AWS feed module's default export. Each module also exports its fetch,
 * normalise and store steps separately, so each can be tested without a
 * network.
 */
export interface AwsFeed {
  id: AwsFeedId;
  title: string;
  /** Minutes between runs while it applies; null = on demand (boot log). */
  cadenceMin: number | null;
  when: AwsFeedWhen;
  /** The most outside calls one run of it makes, the headend and tagged-resource lookups included (the runner skips it when fewer remain). */
  calls: number;
  run(ctx: AwsFeedCtx): Promise<FeedResult>;
  /**
   * Optional: overrides the plain "next_due_at has passed" rule (the boot
   * log: due when the headend's launch time differs from the stored one).
   * Runs inside the feed's try/catch, after its `when` holds.
   */
  due?(ctx: AwsFeedCtx, row: FeedRow | null): boolean | Promise<boolean>;
}

/** AWS insights run only with both Worker keys set (not the .env.example placeholders) and AWS switched on (AWS_ENABLED=1). */
export function awsConfigured(env: Env): boolean {
  return canAws(env) && config(env).aws.enabled;
}

/** Every table migration 0024 adds (the dev seeder wipes them; none is in the backup). */
export const AWS_TABLES = ["hist_aws_vm", "aws_feed", "aws_latest", "aws_activity", "aws_service_events", "aws_capacity", "aws_prices"] as const;
export type AwsTable = (typeof AWS_TABLES)[number];

// ── What the feeds store as JSON ──────────────────────────────────────────

/** aws_latest['health']: the headend's status checks as AzureHealth (less its annotations), and AWS's scheduled events for it. */
export interface AwsHealthDoc {
  instanceId: string;
  health: Omit<AzureHealth, "annotations">;
  /** AWS's scheduled events ("instance-reboot", ...), soonest first; completed and cancelled ones dropped. */
  maintenance: ScheduledEvent[];
}

/** aws_latest['bootlog']: a BootLogDoc (redacted, at most 64 KB) plus the launch time it was read for. */
export type AwsBootLogDoc = BootLogResponse & { launchTime: string | null };

// aws_capacity.json is the existing CapacityDoc (insights/types.ts): sizes [{ name, available, reason, vcpus, family: "standard" }],
// usages [{ family: "standard", used, limit }], cores { used, limit }.
// aws_prices rows: item = the instance type | "disk:gp3" | "ip:v4"; unit "1 Hour" | "GB-Mo"; gbp per unit; meter = AWS's usagetype.

/**
 * Thrown when AWS throttles a call (Throttling*, RequestLimitExceeded). The
 * runner records the feed as skipped: it stays due and the next run tries
 * again.
 */
export class AwsThrottled extends Error {
  constructor(message = "AWS asked cloudlabs to slow down; it runs next time.") {
    super(message);
    this.name = "AwsThrottled";
  }
}
