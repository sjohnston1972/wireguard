// shared/topology/props.ts
//
// Plain English: the one allow-list of what a diagram node may say about a
// resource (lab topology spec §4.5). Both builders (planned, from the mock
// plan; live, from Resource Graph rows) map the attributes they read onto
// these names and pass the result through scrubProps as their last step, so
// nothing else (a password, a key, custom data, a connection string) can
// reach a planned file, a live response or the app. scrubProps also
// withholds any value that merely looks like a secret, and counts what it
// withheld so the diagram can say "1 value withheld".
//
// Adding a name: only with the deny-name test passing and the spec table
// (§4.5) and the plan's names section updated together.

import type { TopologyGraph, TopoPropValue } from "./model";

export const PROP_NAMES: ReadonlySet<string> = new Set([
  "region",
  "zones",
  "sku",
  "tier",
  "size",
  "os",
  "instances",
  "autoscale",
  "privateIp",
  "publicIp",
  "addressSpace",
  "prefix",
  "dnsServers",
  "allocation",
  "ports",
  "asn",
  "bgp",
  "vpnType",
  "clientPool",
  "groupId",
  "target",
  "accountKind",
  "accessTier",
  "replication",
  "publicAccess",
  "apiKind",
  "consistency",
  "capacity",
  "retentionDays",
  "dailyCapGb",
  "cpu",
  "memoryGb",
  "ingress",
  "targetPort",
  "routing",
  "hostName",
  "effect",
  "enforcement",
  "scopeAccess",
  "mode",
  "status",
  "counts",
  "chips",
  "tags",
  "peerTarget",
  "group",
  "resourceId",
]);

/**
 * labs-tf's mock plan secrets (scripts/labs-tf.mjs mockPlanFile), copied: a
 * test keeps them equal. Not real (nothing can sign in with either), but a
 * planned file must never carry them.
 */
export const MOCK_SECRETS = {
  adminPassword: "Mock-Passw0rd-labs-tf-not-real",
  sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH03BQA5/AQUCJHTD+mOsPkEaHYZJ/1Dhlg2VWSBcxxC labs-tf-mock",
} as const;

/** Longer than this and a value is withheld. */
export const MAX_PROP_CHARS = 256;

const SECRET_WORDS = /password|passwd|secret|sharedkey|shared_key|accountkey|account_key|sig=|-----BEGIN/i;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
const B64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const MOCK_KEY_BODY = MOCK_SECRETS.sshPublicKey.split(" ")[1]!;

/** A run of 40+ base64 characters that mixes digits, upper and lower case (a key or token, not a path). */
function base64Run(s: string): boolean {
  for (const m of s.matchAll(B64_RUN)) if (/\d/.test(m[0]) && /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0])) return true;
  return false;
}

/** Does this string look like a secret (a key, token, PEM, SAS, password, the mock secrets) or run over the length cap? */
export function secretLike(value: string): boolean {
  if (value.length > MAX_PROP_CHARS) return true;
  if (value.includes(MOCK_SECRETS.adminPassword) || value.includes(MOCK_KEY_BODY)) return true;
  return SECRET_WORDS.test(value) || JWT.test(value) || base64Run(value);
}

const isPropValue = (v: unknown): v is TopoPropValue =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === "string"));

/**
 * Only PROP_NAMES, only plain values (string, finite number, boolean, list
 * of strings), and nothing secret-like. `withheld` counts the names and
 * values dropped for those reasons (null, undefined and objects are simply
 * not props, so they are dropped uncounted).
 */
export function scrubProps(props: Record<string, unknown>): { props: Record<string, TopoPropValue>; withheld: number } {
  const out: Record<string, TopoPropValue> = {};
  let withheld = 0;
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (!PROP_NAMES.has(k)) {
      withheld++;
      continue;
    }
    if (!isPropValue(v)) continue;
    const strings = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
    if (strings.some(secretLike)) {
      withheld++;
      continue;
    }
    out[k] = Array.isArray(v) ? [...v] : v;
  }
  return { props: out, withheld };
}

/** An RG's (or any resource's) tags as shown: the lab and project values only, the rest counted (ruling 22). */
export function tagProps(tags: Record<string, unknown> | null | undefined): string[] {
  if (!tags || typeof tags !== "object") return [];
  const out: string[] = [];
  let other = 0;
  const entries = Object.entries(tags).sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  for (const [k, v] of entries) {
    const name = k.toLowerCase();
    if ((name === "lab" || name === "project") && typeof v === "string" && !secretLike(v)) out.push(`${name}: ${v}`);
    else other++;
  }
  if (other) out.push(`+${other} tag${other === 1 ? "" : "s"}`);
  return out;
}

/** A note for the diagram when the scrub withheld something. */
export const withheldNote = (n: number): string => `${n} value${n === 1 ? "" : "s"} withheld`;

/**
 * The deny check (spec §12), for tests and the generator: every problem in a
 * graph as a line. A prop name outside PROP_NAMES, or any string anywhere
 * (labels, props, folded labels, edge labels, notes) that is secret-like.
 */
export function denyProblems(g: TopologyGraph): string[] {
  const out: string[] = [];
  const check = (where: string, s: unknown) => {
    if (typeof s === "string" && secretLike(s)) out.push(`${where}: a secret-like value`);
  };
  for (const n of g.nodes) {
    check(`${n.id} label`, n.label);
    check(`${n.id} key`, n.key);
    for (const [k, v] of Object.entries(n.props ?? {})) {
      if (!PROP_NAMES.has(k)) out.push(`${n.id}: prop ${k} is not in PROP_NAMES`);
      for (const s of Array.isArray(v) ? v : [v]) check(`${n.id} ${k}`, s);
    }
    for (const f of n.folded ?? []) check(`${n.id} folded ${f.id}`, f.label);
  }
  for (const e of g.edges) {
    check(`${e.id} label`, e.label);
    check(`${e.id} via`, e.via);
  }
  for (const note of g.notes ?? []) check("note", note);
  const text = JSON.stringify(g);
  if (text.includes(MOCK_SECRETS.adminPassword)) out.push("the mock admin password appears in the graph");
  if (text.includes(MOCK_KEY_BODY)) out.push("the mock SSH key appears in the graph");
  return out;
}
