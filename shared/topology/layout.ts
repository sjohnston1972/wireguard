// shared/topology/layout.ts
//
// Plain English: a lab diagram's saved arrangement (lab topology spec §8.2-
// §8.3, ruling 17). Only what the person moved is kept: per node key, its
// position relative to its parent and the parent key it was saved under (a
// position is applied only while the node still has that parent). One
// ui_prefs row per person per lab, page "topology:<lab id>", saved with the
// widgets' optimistic version. The Worker checks every save strictly with
// validateTopologyLayout (a refusal names the field) and stores
// normaliseTopologyLayout's form; the app reads with the same normaliser.

import type { PrefsProblem } from "../widgets";

export type { PrefsProblem };

export interface TopologyLayout {
  v: 1;
  nodes: Record<string, { x: number; y: number; p: string | null }>;
}

/** GET /api/v1/prefs/topology/:labId; version 0 = never saved. */
export interface TopologyLayoutPage {
  version: number;
  updatedAt: string | null;
  layout: TopologyLayout;
}

/** PUT /api/v1/prefs/topology/:labId. */
export interface TopologyLayoutPutBody {
  baseVersion: number;
  layout: TopologyLayout;
}

/** A save's request body may be at most this long (checked on the raw text, before parsing). */
export const MAX_TOPOLOGY_BODY_BYTES = 20 * 1024;
/** A stored layout (normalised JSON) may be at most this long. */
export const MAX_TOPOLOGY_LAYOUT_BYTES = 16 * 1024;
/** At most this many saved positions per lab. */
export const MAX_TOPOLOGY_ENTRIES = 300;
/** A node key (and a parent key) is at most this long. */
export const MAX_TOPOLOGY_KEY_CHARS = 200;
/** Coordinates are whole numbers within ± this. */
export const MAX_TOPOLOGY_COORD = 100_000;

export const EMPTY_LAYOUT: TopologyLayout = Object.freeze({ v: 1, nodes: Object.freeze({}) }) as TopologyLayout;

/** The ui_prefs page of a lab's layout. */
export const topologyPage = (labId: string): string => `topology:${labId}`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const BAD_KEY_CHARS = /[\u0000-\u001f\u007f"'`]/;

/** A node or parent key: 1-200 characters, no control characters, no quotes. */
export const validTopologyKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= MAX_TOPOLOGY_KEY_CHARS && !BAD_KEY_CHARS.test(k);
const validCoord = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= MAX_TOPOLOGY_COORD;

/** Why a layout is refused (the field at fault), or null when it is fine. */
export function validateTopologyLayout(raw: unknown): PrefsProblem | null {
  if (!isObj(raw)) return { field: "layout", message: "layout must be an object { v: 1, nodes }." };
  for (const k of Object.keys(raw)) if (k !== "v" && k !== "nodes") return { field: `layout.${k}`, message: `Unknown field "${k}".` };
  if (raw.v !== 1) return { field: "layout.v", message: "layout.v must be 1." };
  if (!isObj(raw.nodes)) return { field: "layout.nodes", message: "layout.nodes must be an object of positions by node key." };
  const keys = Object.keys(raw.nodes);
  if (keys.length > MAX_TOPOLOGY_ENTRIES) return { field: "layout.nodes", message: `At most ${MAX_TOPOLOGY_ENTRIES} saved positions per diagram.` };
  for (const k of keys) {
    if (!validTopologyKey(k)) return { field: "layout.nodes", message: `A node key must be 1 to ${MAX_TOPOLOGY_KEY_CHARS} characters with no quotes or control characters.` };
    const e = raw.nodes[k];
    const at = `layout.nodes.${k}`;
    if (!isObj(e)) return { field: at, message: "A position is { x, y, p }." };
    for (const f of Object.keys(e)) if (f !== "x" && f !== "y" && f !== "p") return { field: `${at}.${f}`, message: `Unknown field "${f}".` };
    if (!validCoord(e.x)) return { field: `${at}.x`, message: `x must be a whole number within ±${MAX_TOPOLOGY_COORD}.` };
    if (!validCoord(e.y)) return { field: `${at}.y`, message: `y must be a whole number within ±${MAX_TOPOLOGY_COORD}.` };
    if (!("p" in e) || !(e.p === null || validTopologyKey(e.p))) return { field: `${at}.p`, message: "p must be null or the parent's node key." };
  }
  return null;
}

/** A layout as stored and read: keys sorted, each entry { x, y, p }; anything that does not validate is left out. */
export function normaliseTopologyLayout(raw: unknown): TopologyLayout {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.nodes)) return { v: 1, nodes: {} };
  const nodes: TopologyLayout["nodes"] = {};
  for (const k of Object.keys(raw.nodes).sort()) {
    if (Object.keys(nodes).length >= MAX_TOPOLOGY_ENTRIES) break;
    const e = raw.nodes[k];
    if (!validTopologyKey(k) || !isObj(e) || !validCoord(e.x) || !validCoord(e.y) || !(e.p === null || validTopologyKey(e.p))) continue;
    nodes[k] = { x: e.x, y: e.y, p: e.p };
  }
  return { v: 1, nodes };
}
