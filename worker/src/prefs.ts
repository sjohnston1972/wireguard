// prefs.ts
//
// Plain English: each person's widget preferences in D1 (table ui_prefs),
// one row per person per page. Reading answers every page, repaired against
// today's widget list (shared/widgets.ts), so an older or newer dashboard's
// leftovers never reach a widget. Saving checks the preferences strictly
// against the same list the app draws from, keeps only what differs from
// the defaults, and lands only on the version the change was made from
// (one atomic statement), so two devices can never overwrite each other
// unseen. The owner is always the signed-in identity the caller passes in.

import type { Env } from "./env";
import { MAX_PAGE_PREFS_BYTES, PAGE_IDS, PREFS_SCHEMA, REGISTRY, normalisePagePrefs, validatePagePrefs, type PageId, type Registry } from "../../shared/widgets";
import type { PrefsPage, PrefsResponse } from "../../shared/api";
import { MAX_TOPOLOGY_LAYOUT_BYTES, normaliseTopologyLayout, topologyPage, validateTopologyLayout, type TopologyLayoutPage } from "../../shared/topology/layout";

/** What a save came to: the page as now stored, or the refusal (status, code, message, field). */
export type PutResult = { ok: true; page: PrefsPage } | { ok: false; status: 400 | 409; code: "bad_input" | "stale" | "outdated"; message: string; field?: string };

export const STALE_MESSAGE = "Changed on another device. Showing the latest.";
/** What an older dashboard is told (the same words as an entry saved by one: shared/widgets.ts). */
export const OUTDATED_MESSAGE = "This tab is running an older dashboard. Reload to change widget settings.";

/**
 * Why a save's `schema` is refused, or null for PREFS_SCHEMA (2). Missing or
 * an older number: 409 outdated (the tab runs a bundle that would drop
 * layout.shown, so it should reload). Anything else: 400.
 */
export function schemaRefusal(schema: unknown): { status: 400 | 409; code: "bad_input" | "outdated"; message: string } | null {
  if (schema === PREFS_SCHEMA) return null;
  if (schema === undefined || (typeof schema === "number" && Number.isInteger(schema) && schema >= 0 && schema < PREFS_SCHEMA)) return { status: 409, code: "outdated", message: OUTDATED_MESSAGE };
  return { status: 400, code: "bad_input", message: `schema must be ${PREFS_SCHEMA}.` };
}

/** Every widget page for `user`, normalised; a page never saved is version 0 with {}. */
export async function getPrefs(env: Env, user: string, reg: Registry = REGISTRY): Promise<PrefsResponse> {
  // Only the widget pages: a person's topology rows (one per lab, up to 16 KiB each) are never read here.
  const inList = PAGE_IDS.map((_, i) => `?${i + 2}`).join(", ");
  const rows = (
    await env.DB.prepare(`SELECT page, json, version, updated_at FROM ui_prefs WHERE user = ?1 AND page IN (${inList})`)
      .bind(user, ...PAGE_IDS)
      .all<{ page: string; json: string; version: number; updated_at: string }>()
  ).results;
  const pages = {} as Record<PageId, PrefsPage>;
  for (const page of PAGE_IDS) {
    const r = rows.find((x) => x.page === page);
    if (!r) {
      pages[page] = { version: 0, updatedAt: null, prefs: {} };
      continue;
    }
    let raw: unknown = {};
    try {
      raw = JSON.parse(r.json);
    } catch {
      raw = {}; // an unreadable row reads as defaults; the next save replaces it
    }
    pages[page] = { version: Number(r.version), updatedAt: r.updated_at, prefs: normalisePagePrefs(page, raw, reg) };
  }
  return { pages };
}

/**
 * Save one page for `user`, made on `baseVersion` (0 = never saved). Refused
 * (nothing written): 400 for anything the strict check or the 8 KiB cap
 * refuses, 409 outdated for an entry from an older dashboard, 409 stale when
 * the stored version is not `baseVersion`.
 */
export async function putPrefs(env: Env, user: string, page: PageId, baseVersion: number, prefs: unknown, reg: Registry = REGISTRY): Promise<PutResult> {
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return { ok: false, status: 400, code: "bad_input", message: "baseVersion must be the page's version as last read (0 if never saved).", field: "baseVersion" };
  }
  const problem = validatePagePrefs(page, prefs, reg);
  if (problem) return problem.outdated ? { ok: false, status: 409, code: "outdated", message: problem.message, field: problem.field } : { ok: false, status: 400, code: "bad_input", message: problem.message, field: problem.field };
  const stored = normalisePagePrefs(page, prefs, reg);
  const json = JSON.stringify(stored);
  if (new TextEncoder().encode(json).length > MAX_PAGE_PREFS_BYTES) {
    return { ok: false, status: 400, code: "bad_input", message: `These widget settings are too large to save (over ${MAX_PAGE_PREFS_BYTES / 1024} KiB for the page).`, field: "prefs" };
  }
  const now = new Date().toISOString();
  // D1 binds every JS number as REAL: the version is cast so it compares and stores as an INTEGER.
  const r =
    baseVersion === 0
      ? await env.DB.prepare("INSERT OR IGNORE INTO ui_prefs (user, page, json, version, updated_at) VALUES (?1, ?2, ?3, 1, ?4)").bind(user, page, json, now).run()
      : await env.DB.prepare("UPDATE ui_prefs SET json = ?3, version = version + 1, updated_at = ?4 WHERE user = ?1 AND page = ?2 AND version = CAST(?5 AS INTEGER)").bind(user, page, json, now, baseVersion).run();
  if (!r.meta.changes) return { ok: false, status: 409, code: "stale", message: STALE_MESSAGE };
  return { ok: true, page: { version: baseVersion + 1, updatedAt: now, prefs: stored } };
}

// ── A lab diagram's saved arrangement (lab topology spec §8.3) ──────────
// Same table, page "topology:<lab id>" (migration 0021). getPrefs above
// reads the widget pages only (page IN (...)), so these rows never reach it.

/** What a topology save came to: the layout as now stored, or the refusal. */
export type TopologyPutResult = { ok: true; page: TopologyLayoutPage } | { ok: false; status: 400 | 409; code: "bad_input" | "stale"; message: string; field?: string };

/** `user`'s saved layout of lab `labId`; never saved is version 0 with the empty layout. The caller checks the lab id. */
export async function getTopologyLayout(env: Env, user: string, labId: string): Promise<TopologyLayoutPage> {
  const r = await env.DB.prepare("SELECT json, version, updated_at FROM ui_prefs WHERE user = ?1 AND page = ?2").bind(user, topologyPage(labId)).first<{ json: string; version: number; updated_at: string }>();
  if (!r) return { version: 0, updatedAt: null, layout: { v: 1, nodes: {} } };
  let raw: unknown = null;
  try {
    raw = JSON.parse(r.json);
  } catch {
    raw = null; // an unreadable row reads as the empty layout; the next save replaces it
  }
  return { version: Number(r.version), updatedAt: r.updated_at, layout: normaliseTopologyLayout(raw) };
}

/**
 * Save `user`'s layout of lab `labId`, made on `baseVersion` (0 = never
 * saved). Refused, nothing written: 400 for a layout the strict check or the
 * 16 KiB cap refuses, 409 stale when the stored version is not `baseVersion`.
 * The caller checks the lab id is in the catalogue.
 */
export async function putTopologyLayout(env: Env, user: string, labId: string, baseVersion: number, layout: unknown): Promise<TopologyPutResult> {
  if (typeof baseVersion !== "number" || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return { ok: false, status: 400, code: "bad_input", message: "baseVersion must be the layout's version as last read (0 if never saved).", field: "baseVersion" };
  }
  const problem = validateTopologyLayout(layout);
  if (problem) return { ok: false, status: 400, code: "bad_input", message: problem.message, field: problem.field };
  const stored = normaliseTopologyLayout(layout);
  const json = JSON.stringify(stored);
  if (new TextEncoder().encode(json).length > MAX_TOPOLOGY_LAYOUT_BYTES) {
    return { ok: false, status: 400, code: "bad_input", message: `This diagram layout is too large to save (over ${MAX_TOPOLOGY_LAYOUT_BYTES / 1024} KiB).`, field: "layout" };
  }
  const page = topologyPage(labId);
  const now = new Date().toISOString();
  // D1 binds every JS number as REAL: the version is cast so it compares and stores as an INTEGER.
  const r =
    baseVersion === 0
      ? await env.DB.prepare("INSERT OR IGNORE INTO ui_prefs (user, page, json, version, updated_at) VALUES (?1, ?2, ?3, 1, ?4)").bind(user, page, json, now).run()
      : await env.DB.prepare("UPDATE ui_prefs SET json = ?3, version = version + 1, updated_at = ?4 WHERE user = ?1 AND page = ?2 AND version = CAST(?5 AS INTEGER)").bind(user, page, json, now, baseVersion).run();
  if (!r.meta.changes) return { ok: false, status: 409, code: "stale", message: STALE_MESSAGE };
  return { ok: true, page: { version: baseVersion + 1, updatedAt: now, layout: stored } };
}
