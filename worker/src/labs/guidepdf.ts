// labs/guidepdf.ts
//
// Plain English: a lab's guide as a PDF (GET /api/v1/labs/:id/guide.pdf).
// The guide's HTML (labs/guide.ts) is drawn by Cloudflare Browser Rendering
// (binding BROWSER, @cloudflare/puppeteer) as A4 with page numbers, then kept
// in R2 so it is made once per lab version and content:
//
//   lab-guides/<lab id>/v<version>-<content hash>.pdf    the PDF (customMetadata.generatedAt)
//   lab-guides/_locks/<lab id>.json                      "being made", while one render runs
//
// The content hash covers everything the guide shows (the lab, its readme,
// learning content, diagrams and cost words, and GUIDE_FORMAT), never the
// date: a new lab version, a readme edit, a new diagram or a changed price
// makes a new PDF; nothing else does. After a new one is stored, the lab's
// older PDFs are deleted.
//
// One render at a time per lab: callers in the same isolate share one
// promise; another isolate sees the lock (fresh for GUIDE_LOCK_MS) and waits
// for the PDF to appear (up to GUIDE_WAIT_MS), then answers "busy, try
// again". The lock is best effort (R2 has no compare-and-set here), so the
// worst case is two renders of the same PDF, never a wrong one.
//
// When Browser Rendering is missing (no binding) or refuses (not enabled,
// over its limits), the answer is a 503 that says so; the route never falls
// back to another service.

import type { Env } from "../env";
import type { LabDef } from "../../../shared/labs";
import { catalogue, labReadme } from "./catalogue";
import { guideDiagrams } from "./guidediagrams";
import { labGbpH } from "./prices";
import { fixedConfig } from "../settings";
import { buildGuideHtml, costWords, GUIDE_FORMAT, guideFooterTemplate, type GuideInput } from "./guide";

export const GUIDE_PREFIX = "lab-guides/";
export const GUIDE_LOCK_PREFIX = "lab-guides/_locks/";
/** How long one render may take, start to finish. */
export const GUIDE_RENDER_TIMEOUT_MS = 45_000;
/** A lock older than this is a dead render's: ignored. */
export const GUIDE_LOCK_MS = 90_000;
/** How long a caller waits for another isolate's render before answering busy. */
export const GUIDE_WAIT_MS = 20_000;
export const GUIDE_POLL_MS = 1_000;

/** A refusal the route turns into an error answer. */
export class GuideError extends Error {
  constructor(
    readonly status: 503 | 504,
    readonly code: "guide_unavailable" | "guide_busy" | "guide_timeout",
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "GuideError";
  }
}

/** Draws `html` as a PDF with `footer` on every page. */
export type GuideRenderer = (browser: Fetcher, html: string, footer: string, timeoutMs: number) => Promise<Uint8Array>;

/** The real one: Browser Rendering through @cloudflare/puppeteer (browser.mjs, loaded only when a PDF is made). */
export const browserRenderingPdf: GuideRenderer = async (binding, html, footer, timeoutMs) => {
  const { renderPdf } = await import("./browser.mjs");
  return renderPdf(binding, html, footer, timeoutMs);
};

let renderer: GuideRenderer = browserRenderingPdf;
/** Tests only: draw with `r` (null puts the real one back). */
export function setGuideRendererForTest(r: GuideRenderer | null): void {
  renderer = r ?? browserRenderingPdf;
}

const inflight = new Map<string, Promise<GuidePdf>>();
/** Tests only: forget renders in flight. */
export function resetGuideInflight(): void {
  inflight.clear();
}

export interface GuidePdf {
  bytes: ArrayBuffer;
  generatedAt: string;
  key: string;
  cached: boolean;
}

export interface GuideOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitUntil?: (p: Promise<unknown>) => void;
}

/** Everything the guide shows, read from the bundled catalogue (and the price table for the cost). */
export async function guideInput(env: Env, def: LabDef, now: number): Promise<GuideInput> {
  const cat = catalogue();
  let gbpH: number | null = null;
  try {
    const cfg = await fixedConfig(env);
    gbpH = await labGbpH(env, def, cfg.region, new Date(now));
  } catch {
    gbpH = null;
  }
  return {
    def,
    readme: labReadme(def.id),
    learning: cat.learning?.[def.id] ?? null,
    diagrams: guideDiagrams(def.id),
    skillAreaNames: Object.fromEntries(cat.skillAreas.map((a) => [a.key, a.name])),
    gbpH,
  };
}

/** The R2 key for this content: lab-guides/<id>/v<version>-<16 hex of SHA-256>.pdf. */
export async function guideKey(g: GuideInput): Promise<string> {
  const content = JSON.stringify({
    format: GUIDE_FORMAT,
    def: g.def,
    readme: g.readme,
    learning: g.learning,
    diagrams: g.diagrams,
    areas: g.skillAreaNames,
    cost: costWords(g.gbpH, g.def.timing.session_h),
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${GUIDE_PREFIX}${g.def.id}/v${g.def.version}-${hex}.pdf`;
}

async function cachedPdf(env: Env, key: string, fallbackAt: number): Promise<GuidePdf | null> {
  const obj = await env.STATE.get(key);
  if (!obj) return null;
  const meta = (obj as R2ObjectBody & { customMetadata?: Record<string, string> }).customMetadata;
  const uploaded = (obj as { uploaded?: Date }).uploaded;
  const generatedAt = meta?.generatedAt ?? (uploaded instanceof Date ? uploaded.toISOString() : new Date(fallbackAt).toISOString());
  return { bytes: await obj.arrayBuffer(), generatedAt, key, cached: true };
}

const lockKey = (id: string) => `${GUIDE_LOCK_PREFIX}${id}.json`;

async function readLock(env: Env, id: string): Promise<{ token: string; at: number } | null> {
  try {
    const obj = await env.STATE.get(lockKey(id));
    if (!obj) return null;
    const v = JSON.parse(await obj.text()) as { token?: unknown; at?: unknown };
    return typeof v.token === "string" && typeof v.at === "number" ? { token: v.token, at: v.at } : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GuideError(504, "guide_timeout", "Making the PDF took too long. Try again in a minute.")), ms);
  });
  return Promise.race([p, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** A Browser Rendering failure as the answer's words. */
function renderFailure(e: unknown): GuideError {
  if (e instanceof GuideError) return e;
  const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);
  if (/\b429\b|too many|rate limit/i.test(msg)) return new GuideError(503, "guide_busy", "Browser Rendering is at its limit just now. Try again in a minute.", 60);
  return new GuideError(503, "guide_unavailable", `Browser Rendering could not make the PDF (${msg}). Check that Browser Rendering is enabled for the Cloudflare account (Workers Paid), then try again.`);
}

/** Delete the lab's other PDFs (an older version or content). Best effort. */
async function dropOlder(env: Env, id: string, keep: string): Promise<void> {
  try {
    const listed = await env.STATE.list({ prefix: `${GUIDE_PREFIX}${id}/` });
    const old = listed.objects.map((o) => o.key).filter((k) => k !== keep);
    if (old.length) await env.STATE.delete(old);
  } catch (e) {
    console.error(`lab guide: could not tidy old PDFs of ${id}:`, (e as Error).message);
  }
}

async function render(env: Env, g: GuideInput, key: string, o: Required<GuideOptions>): Promise<GuidePdf> {
  const id = g.def.id;
  if (!env.BROWSER) {
    throw new GuideError(503, "guide_unavailable", "PDF guides need Cloudflare Browser Rendering, and this Worker has no BROWSER binding. Add [browser] binding = \"BROWSER\" to wrangler.toml and deploy.");
  }
  // Another isolate making the same lab's guide: wait for its PDF rather than start a second browser.
  const held = await readLock(env, id);
  if (held && o.now() - held.at < GUIDE_LOCK_MS) {
    const until = o.now() + GUIDE_WAIT_MS;
    while (o.now() < until) {
      await o.sleep(GUIDE_POLL_MS);
      const done = await cachedPdf(env, key, o.now());
      if (done) return done;
      const still = await readLock(env, id);
      if (!still || still.token !== held.token) break;
    }
    const done = await cachedPdf(env, key, o.now());
    if (done) return done;
    // Still (or newly) being made elsewhere: say so. A released lock without a PDF (that render failed): make it here.
    const now = await readLock(env, id);
    if (now && o.now() - now.at < GUIDE_LOCK_MS) {
      throw new GuideError(503, "guide_busy", "This lab's PDF is being made by another request. Try again in a few seconds.", 10);
    }
  }
  const token = crypto.randomUUID();
  await env.STATE.put(lockKey(id), JSON.stringify({ token, at: o.now() }), { httpMetadata: { contentType: "application/json" } });
  try {
    const generatedAt = new Date(o.now()).toISOString();
    const html = buildGuideHtml(g, generatedAt);
    let bytes: Uint8Array;
    try {
      bytes = await withTimeout(renderer(env.BROWSER, html, guideFooterTemplate(g.def, generatedAt), GUIDE_RENDER_TIMEOUT_MS - 5_000), GUIDE_RENDER_TIMEOUT_MS);
    } catch (e) {
      throw renderFailure(e);
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await env.STATE.put(key, buf, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { labId: id, version: String(g.def.version), generatedAt },
    });
    o.waitUntil(dropOlder(env, id, key));
    return { bytes: buf, generatedAt, key, cached: false };
  } finally {
    // Only our own lock: a slow render whose lock went stale must not drop a newer one.
    if ((await readLock(env, id))?.token === token) await env.STATE.delete(lockKey(id)).catch(() => undefined);
  }
}

/** The lab's guide PDF: from R2 when this content was made before, else made now (one render at a time per lab). */
export async function labGuidePdf(env: Env, def: LabDef, opts: GuideOptions = {}): Promise<GuidePdf> {
  const o: Required<GuideOptions> = {
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    waitUntil: opts.waitUntil ?? ((p) => void p.catch(() => undefined)),
  };
  const g = await guideInput(env, def, o.now());
  const key = await guideKey(g);
  const hit = await cachedPdf(env, key, o.now());
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const p = render(env, g, key, o).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** The download's file name: "<lab id> guide.pdf" (lab ids are [a-z0-9-] only). */
export const guideFileName = (id: string) => `${id} guide.pdf`;
