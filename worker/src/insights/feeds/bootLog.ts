// insights/feeds/bootLog.ts
//
// Plain English: the VM's serial console log ("boot log"), for when the VM
// stops answering. Fetched automatically once per stale-heartbeat episode
// (the watchman's "unreachable" flag, or no heartbeat since the VM
// started), and on demand by POST /api/v1/azure/bootlog.
//
// Security (spec 11):
//   - Azure hands out a signed URL valid for 5 minutes. It is used at once
//     and never stored, logged or returned; errors never quote it.
//   - HEAD for the length, then a ranged GET of the last 64 KB only (a reply
//     that ignores Range is cut to its last 64 KB as it streams in).
//   - The text is redacted (insights/redact.ts, including this run's SSH
//     password) before it is stored as az_latest['bootlog'].
//   - Without boot diagnostics (a VM built before they were turned on) the
//     answer says they turn on with the next deploy; without a VM, "No VM".

import type { FeedModule } from "../runner";
import type { BootLogDoc, FeedCtx, HealthDoc } from "../types";
import { currentDeployment } from "../../db";
import { heartbeatProblem } from "../../overview";
import { armRefusal, getLatest, paths, putLatest, vmExists } from "../common";
import { redact } from "../redact";

const COMPUTE_API = "2024-07-01";
export const BOOTLOG_MAX_BYTES = 64 * 1024;
/** A reply that ignores Range is read at most this far before it is given up (keeping its last 64 KB). */
const READ_CAP_BYTES = 2 * 1024 * 1024;
export const NEXT_DEPLOY = "Boot diagnostics turn on with the next deploy";
export const NO_VM = "No VM";

const reasonDoc = (reason: string): BootLogDoc => ({ fetchedAt: null, bytes: 0, truncated: false, redactions: 0, text: null, reason });

/** The last `max` bytes of a body, reading at most `cap` bytes; and how many bytes it had (at least). */
async function tailOf(r: Response, max: number, cap: number): Promise<{ bytes: Uint8Array; total: number }> {
  if (!r.body) {
    const all = new Uint8Array(await r.arrayBuffer());
    return { bytes: all.slice(-max), total: all.length };
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    kept += value.length;
    while (chunks.length > 1 && kept - chunks[0]!.length >= max) kept -= chunks.shift()!.length;
    if (total >= cap) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const joined = new Uint8Array(kept);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return { bytes: joined.slice(-max), total };
}

/** Read the serial log through its signed URL: at most the last 64 KB. The URL stays in this function. */
async function readSerialLog(ctx: FeedCtx, signedUrl: string): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const head = await ctx.fetch(signedUrl, { method: "HEAD" });
  const length = head.ok ? Number(head.headers.get("Content-Length")) : NaN;
  const range = Number.isFinite(length) && length > 0 ? `bytes=${Math.max(0, length - BOOTLOG_MAX_BYTES)}-${length - 1}` : `bytes=-${BOOTLOG_MAX_BYTES}`;
  const r = await ctx.fetch(signedUrl, { headers: { Range: range } });
  if (r.status === 206) {
    const all = new Uint8Array(await r.arrayBuffer());
    const total = Number(r.headers.get("Content-Range")?.split("/")[1]);
    return { bytes: all.slice(-BOOTLOG_MAX_BYTES), truncated: (Number.isFinite(total) ? total : Number.isFinite(length) ? length : all.length) > BOOTLOG_MAX_BYTES || all.length > BOOTLOG_MAX_BYTES };
  }
  if (!r.ok) throw new Error(`Azure storage refused the boot log (${r.status}).`);
  const t = await tailOf(r, BOOTLOG_MAX_BYTES, READ_CAP_BYTES);
  return { bytes: t.bytes, truncated: t.total > BOOTLOG_MAX_BYTES };
}

/** Fetch, cap and redact the boot log; a reason instead when there is none to fetch. */
export async function fetchBootLog(ctx: FeedCtx, extraSecrets: (string | null)[] = []): Promise<BootLogDoc> {
  if (!vmExists(ctx.snap)) return reasonDoc(NO_VM);
  const health = await getLatest<HealthDoc>(ctx.db, "health");
  if (health?.doc?.bootDiagnostics === false) return reasonDoc(NEXT_DEPLOY);

  const r = await ctx.arm(`${paths(ctx.env, ctx.cfg).vm}/retrieveBootDiagnosticsData?api-version=${COMPUTE_API}&sasUriExpirationTimeInMinutes=5`, { method: "POST" });
  if (r.status === 404) return reasonDoc(NO_VM);
  if (r.status === 409 || r.status === 400) {
    // "Boot diagnostics is not enabled" is the one refusal that means "turn it on"; others (a deallocated VM) are errors.
    const body = await r.text().catch(() => "");
    if (/boot\s*diagnostics/i.test(body.slice(0, 2000))) return reasonDoc(NEXT_DEPLOY);
    const code = body.match(/"code"\s*:\s*"([A-Za-z]{1,60})"/)?.[1];
    throw new Error(`Azure refused the boot log link (${r.status}${code ? ` ${code}` : ""}).`);
  }
  if (!r.ok) throw await armRefusal("the boot log link", r);
  const link = ((await r.json()) as { serialConsoleLogBlobUri?: unknown }).serialConsoleLogBlobUri;
  if (typeof link !== "string" || !/^https:\/\//i.test(link)) return reasonDoc(NEXT_DEPLOY);

  const { bytes, truncated } = await readSerialLog(ctx, link);
  let text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
  if (truncated) {
    // The tail starts mid-line: drop the partial first line.
    const nl = text.indexOf("\n");
    if (nl >= 0 && nl < 4096) text = text.slice(nl + 1);
  }
  const clean = redact(text, extraSecrets);
  return { fetchedAt: ctx.now.toISOString(), bytes: bytes.length, truncated, redactions: clean.count, text: clean.text.slice(-BOOTLOG_MAX_BYTES), reason: null };
}

/** Fetch and store (a "No VM" answer never replaces the last VM's log). */
export async function fetchAndStoreBootLog(ctx: FeedCtx): Promise<BootLogDoc> {
  const dep = await currentDeployment(ctx.env).catch(() => null);
  const doc = await fetchBootLog(ctx, [dep?.ssh_password ?? null]);
  if (doc.reason !== NO_VM) await putLatest(ctx.db, "bootlog", doc, ctx.now.toISOString());
  return doc;
}

const bootLog: FeedModule = {
  id: "bootLog",
  title: "Boot log",
  cadenceMin: null,
  when: "vm",
  calls: 3,
  arm: true,
  async due(ctx, row) {
    const now = ctx.now.getTime();
    const silent = heartbeatProblem(ctx.snap, now) !== null || (ctx.snap.state === "running" && (await ctx.env.STATUS.get("flag:unreachable")) === "1");
    if (!silent) return false;
    // Once per episode: the episode began at the last heartbeat (or the VM's start).
    const start = Math.max(Date.parse(ctx.snap.last_agent_at ?? "") || 0, Date.parse(ctx.snap.running_since ?? ctx.snap.since ?? "") || 0);
    const tried = Date.parse(row?.last_try_at ?? "");
    return !Number.isFinite(tried) || tried < start;
  },
  async run(ctx) {
    await fetchAndStoreBootLog(ctx);
    return { status: "ok", error: null };
  },
};

export default bootLog;
