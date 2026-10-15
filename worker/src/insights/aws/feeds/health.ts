// insights/aws/feeds/health.ts
//
// Plain English: "what does AWS say about the server?". One call every 5
// minutes while the headend exists: EC2 DescribeInstanceStatus for the
// headend (IncludeAllInstances, so a stopped server answers too). AWS runs
// two status checks on a running server: the system check (AWS's own
// hardware and network) and the instance check (the server itself). They
// become the same health shape as Azure's:
//   - Available: both checks ok;
//   - Unavailable: either is impaired;
//   - Degraded: either has insufficient data;
//   - Unknown: either is still initializing (for a few minutes after every
//     start, which is normal, so not amber), or anything else, a stopped
//     server included (AWS checks only a running one).
// AWS's scheduled events for the server (a reboot, a retirement, ...) are
// kept in the same document, soonest first; completed and canceled ones are
// dropped. Each new event writes one watchman note and sends one push, as
// Azure's scheduled events do (runs.ts); the ids already noted are kept in
// aws_latest so an event is never noted twice. cloudlabs never acts on one.
// Stored as aws_latest['health'] (AwsHealthDoc); a new headend's document
// replaces the old one's. No headend (a deploy still building it) is not an
// error and removes the stored document, so an old instance's checks and
// scheduled events never show for a new or absent server.
// Spec 2026-10-15-aws-insights-design.md, sections 4.2 and 2.8.

import type { Env } from "../../../env";
import type { AzureHealth, ScheduledEvent } from "../../../../../shared/api";
import type { VmScheduledEvent } from "../../../state";
import { xmlFirst, xmlItems, xmlOwn, xmlOwnItems } from "../../../cloud/awsApi";
import * as db from "../../../db";
import { notify } from "../../../notify";
import { dashboardButton } from "../../../actions";
import { SEEN_EVENTS_KEEP, scheduledEventNote } from "../../../vitals";
import { str, time } from "../../common";
import { getAwsLatest, putAwsLatest } from "../common";
import type { AwsFeed, AwsFeedCtx, AwsHealthDoc } from "../types";

/** aws_latest key holding the scheduled-event ids already noted (the last 20). */
export const AWS_EVENTS_SEEN_KEY = "health-events-seen";

/** DescribeInstanceStatus for the headend, stopped or not. The XML. */
export async function fetchAwsHealth(ctx: AwsFeedCtx, instanceId: string): Promise<string> {
  return ctx.ec2("DescribeInstanceStatus", { "InstanceId.1": instanceId, IncludeAllInstances: "true" });
}

/** The own <status> of a check block (<systemStatus>, <instanceStatus>), never one of its details' statuses. */
function checkStatus(item: string, tag: "systemStatus" | "instanceStatus"): string | null {
  const block = item.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
  if (block === undefined) return null;
  // The block's details are <item>s, each with a <status> of its own: cut them out first.
  return xmlFirst(xmlOwn(`<item>${block}</item>`), "status");
}

const POWER: Record<string, string> = {
  running: "Server running",
  stopped: "Server stopped",
  pending: "Server starting",
  stopping: "Server stopping",
  "shutting-down": "Server shutting down",
  terminated: "Server terminated",
};

const CHECK_WORDS = {
  system: { name: "AWS's hardware check", field: "system status" },
  instance: { name: "The server's own check", field: "instance status" },
} as const;

/** The two checks' statuses as AzureHealth's state, title and summary. */
function verdict(system: string | null, instance: string | null, power: string | null): Pick<AzureHealth, "state" | "title" | "summary"> {
  const checks = [
    ["system", system],
    ["instance", instance],
  ] as const;
  const said = (want: string[], words: (n: string, f: string, s: string) => string) =>
    checks
      .filter(([, s]) => s !== null && want.includes(s))
      .map(([k, s]) => words(CHECK_WORDS[k].name, CHECK_WORDS[k].field, s!))
      .join(" ");
  if (system === "ok" && instance === "ok") {
    return { state: "Available", title: "Both AWS status checks passed.", summary: "AWS's hardware check (system status) and the server's own check (instance status) both passed." };
  }
  if (system === "impaired" || instance === "impaired") {
    return { state: "Unavailable", title: "An AWS status check failed.", summary: said(["impaired"], (n, f, s) => `${n} failed (${f} ${s}).`) };
  }
  const noResult = (n: string, f: string, s: string) => `${n} has no result yet (${f} ${s}).`;
  if (system === "insufficient-data" || instance === "insufficient-data") {
    return { state: "Degraded", title: "AWS status checks are still running.", summary: said(["initializing", "insufficient-data"], noResult) };
  }
  // AWS's checks start over after every start: a few minutes of this is normal, not a fault.
  if (system === "initializing" || instance === "initializing") {
    return { state: "Unknown", title: "AWS status checks are starting.", summary: said(["initializing"], noResult) };
  }
  if (power === "stopped") return { state: "Unknown", title: "The server is stopped; AWS checks only a running server.", summary: null };
  return { state: "Unknown", title: "AWS gave no status check result.", summary: null };
}

/** One AWS scheduled event as a ScheduledEvent; null for one already completed or canceled. */
function scheduledEvent(item: string): ScheduledEvent | null {
  const own = xmlOwn(item);
  const description = str(xmlFirst(own, "description"), 200);
  if (description && /^\[(Completed|Canceled|Cancelled)\]/i.test(description)) return null;
  const code = str(xmlFirst(own, "code"), 60);
  const notBefore = time(xmlFirst(own, "notBefore"));
  const notAfter = time(xmlFirst(own, "notAfter"));
  const id = str(xmlFirst(own, "instanceEventId"), 80) ?? (code ? `${code}@${notBefore ?? "?"}` : null);
  if (!id || !code) return null;
  const durationS = notBefore && notAfter ? Math.max(0, Math.round((Date.parse(notAfter) - Date.parse(notBefore)) / 1000)) : null;
  return { id, type: code, status: "Scheduled", notBefore, source: "AWS", description, durationS };
}

/**
 * DescribeInstanceStatus's answer as the stored health document. `state` is
 * the headend's own state (from DescribeInstances), used for the power words
 * when AWS has no status for it.
 */
export function normaliseAwsHealth(xml: string, instanceId: string, now: Date, state: string | null = null): AwsHealthDoc {
  const item = xmlItems(xml, "instanceStatusSet").find((i) => xmlFirst(xmlOwn(i), "instanceId") === instanceId) ?? null;
  const own = item ? xmlOwn(item) : "";
  const powerName = (item ? xmlFirst(own.match(/<instanceState>[\s\S]*?<\/instanceState>/)?.[0] ?? "", "name") : null) ?? state;
  const system = item ? checkStatus(item, "systemStatus") : null;
  const instance = item ? checkStatus(item, "instanceStatus") : null;
  const maintenance = (item ? xmlOwnItems(item, "eventsSet") : [])
    .slice(0, 20)
    .map(scheduledEvent)
    .filter((e): e is ScheduledEvent => e !== null)
    .sort((a, b) => (a.notBefore ?? "9999").localeCompare(b.notBefore ?? "9999"));
  return {
    instanceId,
    health: {
      ...verdict(system, instance, powerName),
      reason: null,
      since: null,
      power: powerName ? (POWER[powerName] ?? null) : null,
      provisioning: null,
      vmAgent: null,
      bootDiagnostics: true, // AWS keeps console output for every instance
      checkedAt: now.toISOString(),
    },
    maintenance,
  };
}

export async function storeAwsHealth(dbh: D1Database, doc: AwsHealthDoc, now: Date): Promise<void> {
  await putAwsLatest(dbh, "health", doc, now.toISOString());
}

/**
 * One watchman note and one push per scheduled event not noted before, in
 * the words Azure's use (vitals.ts scheduledEventNote). The noted ids are
 * remembered (the last 20). A note or push that fails does not fail the feed.
 */
export async function noteNewAwsEvents(env: Env, events: ScheduledEvent[], now: Date): Promise<ScheduledEvent[]> {
  if (!events.length) return [];
  try {
    const seen = (await getAwsLatest<string[]>(env.DB, AWS_EVENTS_SEEN_KEY))?.doc;
    const known = Array.isArray(seen) ? seen : [];
    const fresh = events.filter((e, i, all) => !known.includes(e.id) && all.findIndex((x) => x.id === e.id) === i);
    for (const e of fresh) {
      const vm: VmScheduledEvent = { id: e.id, type: e.type, status: e.status, not_before: e.notBefore, source: e.source, duration_s: e.durationS, description: e.description, self: true };
      const note = scheduledEventNote(vm, "AWS");
      await db.addAlert(env, "info", note);
      await notify(env, "cloudlabs: AWS maintenance scheduled", note, { tags: ["calendar"], buttons: [dashboardButton(env)] });
    }
    if (fresh.length) await putAwsLatest(env.DB, AWS_EVENTS_SEEN_KEY, [...known, ...fresh.map((e) => e.id)].slice(-SEEN_EVENTS_KEEP), now.toISOString());
    return fresh;
  } catch (e) {
    console.error("AWS scheduled events:", e instanceof Error ? e.name : "error");
    return [];
  }
}

const health: AwsFeed = {
  id: "aws.health",
  title: "Instance health",
  cadenceMin: 5,
  when: "server",
  calls: 2, // the headend lookup and DescribeInstanceStatus
  async run(ctx) {
    const h = await ctx.headend();
    if (!h) {
      // No headend (yet): nothing to say, and an old instance's checks and events must not show.
      await ctx.db.prepare("DELETE FROM aws_latest WHERE key = 'health'").run();
      return { status: "ok", error: null };
    }
    const doc = normaliseAwsHealth(await fetchAwsHealth(ctx, h.id), h.id, ctx.now, h.state);
    await storeAwsHealth(ctx.db, doc, ctx.now);
    await noteNewAwsEvents(ctx.env, doc.maintenance, ctx.now);
    return { status: "ok", error: null };
  },
};

export default health;
