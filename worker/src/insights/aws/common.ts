// insights/aws/common.ts
//
// Plain English: small helpers the AWS feeds share: the latest-document
// store (aws_latest), the run's view of aws_feed, and turning any AWS error
// into plain words. A refused call says which permission the Worker's AWS
// user is missing; nothing ever quotes a URL, a key or a signature.

import { AwsError } from "../../cloud/awsApi";
import { plainError, type FeedRow } from "../common";

// ── aws_latest ───────────────────────────────────────────────────────────

export async function getAwsLatest<T>(db: D1Database, key: string): Promise<{ doc: T; updatedAt: string } | null> {
  const r = await db.prepare("SELECT json, updated_at FROM aws_latest WHERE key = ?1").bind(key).first<{ json: string; updated_at: string }>();
  if (!r) return null;
  try {
    return { doc: JSON.parse(r.json) as T, updatedAt: r.updated_at };
  } catch {
    return null;
  }
}

export function putAwsLatestStmt(db: D1Database, key: string, doc: unknown, at: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO aws_latest (key, json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(doc), at);
}

/** Store a document under `key`; `at` defaults to now (feeds pass ctx.now.toISOString()). */
export async function putAwsLatest(db: D1Database, key: string, doc: unknown, at: string = new Date().toISOString()): Promise<void> {
  await putAwsLatestStmt(db, key, doc, at).run();
}

// ── aws_feed ─────────────────────────────────────────────────────────────

export async function readAwsFeedRows(db: D1Database): Promise<Map<string, FeedRow>> {
  const rows = (await db.prepare("SELECT feed, last_try_at, last_ok_at, status, error, next_due_at FROM aws_feed").all<FeedRow>()).results;
  return new Map(rows.map((r) => [r.feed, r]));
}

// ── Errors ───────────────────────────────────────────────────────────────

/** AWS's ways of saying "slow down". */
export function isAwsThrottle(e: unknown): boolean {
  return e instanceof AwsError && (/^Throttl/i.test(e.code) || e.code === "RequestLimitExceeded" || e.code === "TooManyRequestsException" || e.code === "SlowDown");
}

/** AWS's ways of saying "this user may not do that". */
export function isAwsRefusal(e: unknown): boolean {
  return e instanceof AwsError && (/^AccessDenied/i.test(e.code) || /^Unauthorized/i.test(e.code));
}

/** The IAM action a call needs: the service's IAM prefix (monitoring → cloudwatch, tagging → tag) and the action. */
export function iamPermission(service: string, action: string): string {
  const prefix: Record<string, string> = { monitoring: "cloudwatch", tagging: "tag" };
  return `${prefix[service] ?? service}:${action}`;
}

/**
 * Plain words for any error from an AWS call. With the call's action (and
 * the IAM permission it needs), a refusal reads "AWS refused <action>: the
 * Worker's AWS user needs <permission>." Other AWS errors give AWS's code
 * and the HTTP status, never AWS's message (it can quote ARNs and encoded
 * authorisation details). Anything else: plainError.
 */
export function awsPlainError(e: unknown, action?: string, permission?: string): string {
  if (e instanceof AwsError) {
    const code = e.code.replace(/[^\w.-]/g, "").slice(0, 80);
    if (isAwsRefusal(e)) return action ? `AWS refused ${action}: the Worker's AWS user needs ${permission ?? action}.` : `AWS refused a call (${code}): the Worker's AWS user is missing a permission.`;
    if (isAwsThrottle(e)) return `AWS asked cloudlabs to slow down (${code}); it runs next time.`;
    return `AWS refused ${action ?? "a call"} (${e.status}${code ? ` ${code}` : ""}).`;
  }
  return plainError(e);
}
