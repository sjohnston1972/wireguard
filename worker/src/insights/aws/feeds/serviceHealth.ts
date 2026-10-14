// insights/aws/feeds/serviceHealth.ts
//
// Plain English: AWS's own outages for the region, from AWS's public status
// feeds (RSS, no sign-in) for EC2 and VPC, every 15 minutes while AWS is
// configured, stored in aws_service_events like Azure's service events.
// Spec 2026-10-15-aws-insights-design.md, section 4.4. (AWS's Health API
// needs a paid support plan; the RSS is free.)
//
//   - Each <item> is one event: its guid is the tracking id, the
//     description (tags stripped, at most 2 KB) the summary, the region its
//     plain name ("London", from awsRegionName).
//   - "PlannedMaintenance" when the title starts "Informational message"
//     and mentions maintenance; otherwise "ServiceIssue".
//   - "Active" only for the newest item of its feed, under 24 hours old,
//     whose title neither starts "[RESOLVED]" nor says "operating normally";
//     everything else is "Resolved", as is a stored issue the feed no
//     longer lists.
//   - A feed that answers non-200, or with something that is not RSS (an
//     HTML error page), makes the run an error and leaves its stored events
//     alone; the other feed is still read. An empty channel is fine.

import { awsRegionName } from "../../../../../shared/azureMetrics";
import type { ServiceEventRow } from "../../feeds/serviceHealth";
import { DAY } from "../../common";
import { BudgetExceeded } from "../../types";
import { awsPlainError } from "../common";
import { AwsOutOfTime } from "../ctx";
import { AwsThrottled, type AwsFeed, type AwsFeedCtx } from "../types";

type AwsStatusService = "EC2" | "VPC";

/** At most this many items per feed (each one's guid is a bind in the resolve statement; D1 allows 100). */
const MAX_ITEMS = 50;
/** At most this much of an answer is read. */
const MAX_BYTES = 512 * 1024;
const SUMMARY_MAX = 2048;

/** One <item> of a status feed, as read. */
export interface RssItem {
  guid: string | null;
  title: string | null;
  link: string | null;
  /** pubDate as ISO, or null when missing or unreadable. */
  pubDate: string | null;
  description: string | null;
}

/** The region's two status feeds. */
export function awsStatusFeeds(region: string): { service: AwsStatusService; url: string }[] {
  return [
    { service: "EC2", url: `https://status.aws.amazon.com/rss/ec2-${region}.rss` },
    { service: "VPC", url: `https://status.aws.amazon.com/rss/vpc-${region}.rss` },
  ];
}

/** XML's (and HTML's) common entities. */
function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

/** An element's text: CDATA sections as they are, the rest entity-decoded. */
function xmlText(raw: string): string {
  let out = "";
  let last = 0;
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)) {
    out += decode(raw.slice(last, m.index));
    out += m[1];
    last = m.index! + m[0].length;
  }
  return (out + decode(raw.slice(last))).trim();
}

/** The text of the first <tag> in an item (no nested elements of the same name). */
function field(item: string, tag: string, max: number): string | null {
  const m = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  const t = m ? xmlText(m[1]!).replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, max) : null;
}

/** HTML as plain text: tags out, entities decoded, spaces squeezed, capped. */
function plainText(html: string | null, max = SUMMARY_MAX): string | null {
  if (!html) return null;
  const t = decode(html.slice(0, 50_000).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/** A feed's items, newest-first as published; null when the text is not RSS (an HTML error page, nothing at all). */
export function parseAwsRss(xml: string): RssItem[] | null {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>][\s\S]*<\/channel>/i.test(xml)) return null;
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    if (items.length >= MAX_ITEMS) break;
    const body = m[1]!;
    const pub = Date.parse(field(body, "pubDate", 80) ?? "");
    const desc = body.match(/<description(?:\s[^>]*)?>([\s\S]*?)<\/description>/);
    items.push({
      guid: field(body, "guid", 300),
      title: field(body, "title", 300),
      link: field(body, "link", 300),
      pubDate: Number.isFinite(pub) ? new Date(pub).toISOString() : null,
      description: desc ? xmlText(desc[1]!) : null,
    });
  }
  return items;
}

/** One feed's items as service events (service "EC2" or "VPC", the region's plain name). */
export function normaliseAwsRss(items: RssItem[], service: AwsStatusService, regionName: string, now: Date): ServiceEventRow[] {
  // The newest item by pubDate (the first published, on a tie).
  let newest = -1;
  items.forEach((it, i) => {
    if (it.pubDate && (newest < 0 || it.pubDate > (items[newest]!.pubDate ?? ""))) newest = i;
  });
  const rows: ServiceEventRow[] = [];
  items.forEach((it, i) => {
    const title = it.title?.slice(0, 200) ?? null;
    const trackingId = (it.guid ?? (it.link && it.pubDate ? `${it.link}#${it.pubDate}` : null) ?? (title && it.pubDate ? `${service}:${title}:${it.pubDate}` : null))?.slice(0, 300);
    if (!title || !trackingId) return;
    const fresh = !!it.pubDate && now.getTime() - Date.parse(it.pubDate) < DAY;
    const over = /^\s*\[RESOLVED\]/i.test(title) || /operating normally/i.test(title);
    rows.push({
      tracking_id: trackingId,
      type: /^\s*Informational message/i.test(title) && /maintenance/i.test(title) ? "PlannedMaintenance" : "ServiceIssue",
      status: i === newest && fresh && !over ? "Active" : "Resolved",
      level: null,
      title,
      summary: plainText(it.description),
      services: [service],
      regions: [regionName],
      starts_at: it.pubDate,
      ends_at: null,
      updated_at: it.pubDate ?? now.toISOString(),
    });
  });
  return rows;
}

/** One status feed's items (1 call). A non-200 answer or one that is not RSS throws, in plain words without the address. */
export async function fetchAwsRss(ctx: AwsFeedCtx, feed: { service: AwsStatusService; url: string }): Promise<RssItem[]> {
  const r = await ctx.fetch(feed.url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
  if (!r.ok) throw new Error(`AWS's ${feed.service} status feed answered ${r.status}.`);
  const items = parseAwsRss((await r.text()).slice(0, MAX_BYTES));
  if (!items) throw new Error(`AWS's ${feed.service} status feed did not answer with RSS.`);
  return items;
}

/**
 * Store one feed's events, and mark Resolved any of this feed's (service and
 * region) stored issues it no longer lists. Nothing is deleted:
 * housekeeping prunes old events.
 */
export async function storeAwsServiceEvents(db: D1Database, rows: ServiceEventRow[], service: AwsStatusService, regionName: string): Promise<void> {
  const ids = rows.map((r) => r.tracking_id).slice(0, MAX_ITEMS);
  const services = JSON.stringify([service]);
  const regions = JSON.stringify([regionName]);
  const notListed = ids.length ? ` AND tracking_id NOT IN (${ids.map((_, i) => `?${i + 3}`).join(", ")})` : "";
  await db.batch([
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO aws_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
           ON CONFLICT (tracking_id) DO UPDATE SET type = excluded.type, status = excluded.status, level = excluded.level, title = excluded.title, summary = excluded.summary,
             services = excluded.services, regions = excluded.regions, starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = excluded.updated_at`,
        )
        .bind(r.tracking_id, r.type, r.status, r.level, r.title, r.summary, JSON.stringify(r.services), JSON.stringify(r.regions), r.starts_at, r.ends_at, r.updated_at),
    ),
    db.prepare(`UPDATE aws_service_events SET status = 'Resolved' WHERE status = 'Active' AND services = ?1 AND regions = ?2${notListed}`).bind(services, regions, ...ids),
  ]);
}

const serviceHealth: AwsFeed = {
  id: "aws.serviceHealth",
  title: "Service health",
  cadenceMin: 15,
  when: "always",
  calls: 2,
  async run(ctx) {
    const regionName = awsRegionName(ctx.region);
    const errors: string[] = [];
    for (const feed of awsStatusFeeds(ctx.region)) {
      let items: RssItem[];
      try {
        items = await fetchAwsRss(ctx, feed);
      } catch (e) {
        // A budget, time or throttle stop ends the run as the runner decides (skipped); any other failure is this feed's own.
        if (e instanceof BudgetExceeded || e instanceof AwsOutOfTime || e instanceof AwsThrottled) throw e;
        errors.push(awsPlainError(e));
        continue;
      }
      await storeAwsServiceEvents(ctx.db, normaliseAwsRss(items, feed.service, regionName, ctx.now), feed.service, regionName);
    }
    return errors.length ? { status: "error", error: errors.join(" ") } : { status: "ok", error: null };
  },
};

export default serviceHealth;
