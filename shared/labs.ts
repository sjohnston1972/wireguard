// shared/labs.ts
//
// Plain English: the lab contract (spec docs/superpowers/specs/2026-10-04-labs-design.md).
// What a lab definition looks like (lab.yaml, §3.2), what its readme becomes
// (§3.3, plan ruling 2), the address pool and its 32 slots (§4), the names a
// lab owns (§3.1), the governance labs (§8.3), the roles a lab may assign
// (§8.1, labs/setup/allowed-roles.json) and the few sums both the Worker and
// the app need (cost per hour, workflow timeout). The scripts keep a copy of
// the constants in scripts/lib/labs.mjs; a test keeps the two equal.
//
// Nothing here talks to anything: plain values and pure functions.

import allowedRoles from "../labs/setup/allowed-roles.json";

// ── Lab definitions (lab.yaml, spec §3.2) ────────────────────────────────

export type LabExam = "AZ-104" | "AZ-305" | "AZ-700";
/** The exams, in the order the catalogue, coverage and a lab's `exams` list them (ruling 38). */
export const LAB_EXAMS: readonly LabExam[] = ["AZ-104", "AZ-305", "AZ-700"];
export type LabLevel = "foundation" | "associate" | "expert";
export type LabType = "explore" | "break-fix";
/** lab.yaml connectivity.peering: off (never), optional (a tick on Deploy), required (always on). */
export type PeeringMode = "off" | "optional" | "required";
/** Where a lab assigns a role. Never the subscription (§8.3). */
export type LabRoleScope = "resource_group" | "resource" | "management_group";

/** One line of a lab's cost (£ per hour each). A monthly fee is authored as fee / 730 (HOURS_PER_MONTH). */
export interface LabCostItem {
  name: string;
  gbp_h: number;
  /** How many; default 1. */
  qty?: number;
  /** "secondary": priced in the session's secondary region (lab.yaml regions.secondary); otherwise the session's region. */
  region?: "secondary";
  /** Azure's list price for it, when Azure has one: a meter name (with its unit) or a VM size. The price feed refreshes gbp_h from it (§9.1). */
  retail?: { meter?: string; unit?: string; sku?: string };
}

/** A lab, exactly as its lab.yaml says (snake_case kept), plus `number` (the NN in the id) and `exams`. */
export interface LabDef {
  id: string;
  number: number;
  version: number;
  title: string;
  summary: string;
  /** The primary exam: the one the id's prefix names (az700- is AZ-700). */
  exam: LabExam;
  /**
   * Computed by labs-build (ruling 39): the primary exam first, then every other exam one of
   * skill_areas belongs to, in LAB_EXAMS order. A lab counts in each one's coverage and filter.
   */
  exams: LabExam[];
  /** Keys from labs/skill-areas.yaml: any exam's, at least one of the primary exam's. */
  skill_areas: string[];
  level: LabLevel;
  type: LabType;
  /** Lab ids shown as a "run before" badge; never blocks Deploy. */
  prerequisites: string[];
  cost: { items: LabCostItem[]; pricey: string | null };
  timing: { deploy_min: number; destroy_min: number; session_h: number; max_h: number };
  capacity: { vm_sizes: string[] };
  regions: { secondary: string | null };
  connectivity: { peering: PeeringMode; dns_link: boolean; subnets_used: number };
  identity: { creates: ("user" | "group")[]; roles: { role: string; scope: LabRoleScope }[]; governance: boolean };
}

/** An official exam skill area (labs/skill-areas.yaml, §12.1). */
export interface SkillArea {
  key: string;
  exam: LabExam;
  name: string;
}

// ── Readmes, parsed at build time (plan ruling 2) ────────────────────────
// The app draws these as React elements: no HTML is ever injected. Only
// headings, paragraphs, bullets, fenced code, links (https only), bold, inline
// code and <details> exist; anything else is refused by labs-build.

export type ReadmeInline = { t: "text"; text: string } | { t: "b"; text: string } | { t: "code"; text: string } | { t: "a"; text: string; href: string };

export type ReadmeBlock =
  | { t: "h"; level: 1 | 2 | 3; text: string }
  | { t: "p"; inlines: ReadmeInline[] }
  | { t: "ul"; items: ReadmeInline[][] }
  | { t: "code"; lang: string | null; text: string }
  /** Collapsed unless the reader opens it (break-fix "What was broken" is always authored closed). */
  | { t: "details"; summary: string; blocks: ReadmeBlock[] };

/**
 * shared/labs.generated.json, written by `npm run labs-build` (gitignored).
 * Only the Worker imports it (worker/src/labs/catalogue.ts); the app reads GET /labs.
 * Labs are sorted by exam (AZ-104, AZ-305, AZ-700), then by number.
 */
export interface LabCatalogue {
  /** Bumped when this shape changes (2: learning and resources, labs redesign spec §6.2). */
  schema: 2;
  skillAreas: SkillArea[];
  labs: LabDef[];
  /** Lab id -> its readme. */
  readmes: Record<string, ReadmeBlock[]>;
  /** Lab id -> its learning content (labs/_learning/<id>.yaml); a lab with no file yet has no entry. */
  learning: Record<string, LabLearningDef>;
  /** Lab id -> planned TopoKind -> count (shared/topology/planned/<id>.json, keys sorted); a lab with no planned graph has no entry. */
  resources: Record<string, Record<string, number>>;
}

/**
 * A lab's learning content (labs redesign spec §5), from labs/_learning/<id>.yaml, outside the lab
 * folder so editing it never needs a version bump. snake_case as authored.
 */
export interface LabLearningDef {
  /** One sentence, 30-140 characters. */
  objective: string;
  /** "What you will learn": exactly three, each 15-90 characters, starting with a verb. */
  learn: [string, string, string];
  /** Learning time in minutes: a multiple of 5 from 15 to min(240, max_h × 60). */
  learning_min: number;
}

// ── Ids, names and the address pool (spec §3.1, §4) ──────────────────────

/** A lab id: az104-NN-slug, az305-NN-slug or az700-NN-slug, at most LAB_ID_MAX characters. */
export const LAB_ID_RE = /^az(104|305|700)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const LAB_ID_MAX = 40;
/** A lab's primary exam, from its id's prefix (az700-31-x is AZ-700). */
export const examOfId = (id: string): LabExam => (id.startsWith("az104-") ? "AZ-104" : id.startsWith("az305-") ? "AZ-305" : "AZ-700");
/** 10.64.0.0 - 10.71.255.255: 32 slots of /18 (§4). IPv4 only. */
export const LAB_POOL = "10.64.0.0/13";
export const LAB_SLOTS = 32;
export const LAB_SLOT_BITS = 18;
/**
 * Ranges the pool must never overlap: the tunnel, the loopback, vnet-wg, the
 * home LAN (wrangler.toml defaults), Docker's bridge and Azure's DNS/metadata address.
 */
export const GATEWAY_RANGES: readonly string[] = ["10.13.13.0/24", "10.13.255.1/32", "10.50.0.0/16", "192.168.1.0/24", "172.17.0.0/16", "168.63.129.16/32"];

/** Labs 1, 2, 3, 20 and 21: the only ones that may create subscription-level definitions and management groups (§8.3). */
export const GOVERNANCE_LABS: readonly string[] = ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone", "az305-21-monitoring-scale"];

/** The Terraform variables the pipeline fills (§3.4). A lab's variables.tf declares only ones from this list. */
export const LAB_TF_VARS: readonly string[] = ["lab_id", "name_prefix", "resource_group_name", "region", "secondary_region", "address_space", "peered", "gateway_vnet_id", "admin_password", "ssh_public_key", "upn_domain", "tags"];

const ipToInt = (ip: string): number => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

/** A CIDR's first and last address as numbers. */
function cidrRange(cidr: string): [number, number] {
  const [ip, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits ?? 32));
  const start = Math.floor(ipToInt(ip) / size) * size;
  return [start, start + size - 1];
}

/** Do two IPv4 CIDRs share any address? */
export function cidrOverlaps(a: string, b: string): boolean {
  const [a0, a1] = cidrRange(a);
  const [b0, b1] = cidrRange(b);
  return a0 <= b1 && b0 <= a1;
}

/** Slot n's /18: 10.64.0.0 + n x 16384. Throws outside 0..31. */
export function slotCidr(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= LAB_SLOTS) throw new RangeError(`slot ${n} is outside 0-${LAB_SLOTS - 1}`);
  return `${intToIp(ipToInt(LAB_POOL.split("/")[0]) + n * 2 ** (32 - LAB_SLOT_BITS))}/${LAB_SLOT_BITS}`;
}

/** The lab's resource group. */
export const labRg = (id: string): string => `rg-lab-${id}`;
/** The lab's RunLock instance name (§7.3); the gateway's is "singleton". */
export const labLockName = (id: string): string => `lab:${id}`;

/** Does the name follow one of the lab's naming rules: rg-lab-<id>, rg-lab-<id>-<suffix>, lab-<id>-<name>? Case-insensitive (Azure is). */
function nameFits(id: string, name: string): boolean {
  const n = name.toLowerCase();
  const i = id.toLowerCase();
  return n === `rg-lab-${i}` || n.startsWith(`rg-lab-${i}-`) || (n.startsWith(`lab-${i}-`) && n.length > `lab-${i}-`.length);
}

/**
 * The catalogue id a name belongs to: the LONGEST id whose naming rules it
 * fits, so rg-lab-az104-08-vms-zones-x is az104-08-vms-zones, never
 * az104-08-vms. Null when it fits none (NetworkWatcherRG, rg-wg-ondemand).
 */
export function labIdFromName(name: string, ids: readonly string[]): string | null {
  let best: string | null = null;
  for (const id of ids) if (nameFits(id, name) && (!best || id.length > best.length)) best = id;
  return best;
}

/**
 * Is this Azure or Entra name the lab's own? It must fit the lab's naming
 * rules, and no longer catalogue id may fit it better. Pass the catalogue's
 * ids; without them only the naming rules apply.
 */
export function ownsName(id: string, name: string, ids: readonly string[] = [id]): boolean {
  if (!nameFits(id, name)) return false;
  return labIdFromName(name, ids.includes(id) ? ids : [...ids, id]) === id;
}

export const isGovernanceLab = (id: string): boolean => GOVERNANCE_LABS.includes(id);

/**
 * Scope exception S1 (AZ-700 spec §6, ruling 47; approved by Steven 2026-10-05): the only lab whose Virtual
 * Network Manager may be scoped to the subscription, with static members that are its own VNets only.
 */
export const AVNM_LABS: readonly string[] = ["az700-33-vnet-manager"];
/**
 * Scope exception S2 (AZ-700 spec §6, ruling 48; approved by Steven 2026-10-05): the only lab that may make a flow
 * log, named lab-<id>-*, under the region's NetworkWatcher_<region> in Azure's NetworkWatcherRG.
 */
export const FLOW_LOG_LABS: readonly string[] = ["az700-44-flow-logs-bastion"];

/** What a lab needs beyond Contributor (§8.1): the governance role (any role assignment, or a governance lab) and Graph (Entra users or groups). */
export function labNeeds(def: Pick<LabDef, "id" | "identity">): { role: boolean; graph: boolean } {
  return { role: def.identity.governance || isGovernanceLab(def.id) || def.identity.roles.length > 0, graph: def.identity.creates.length > 0 };
}

// ── The roles a lab may assign (plan ruling 3) ───────────────────────────

export interface AllowedRoles {
  builtIn: { name: string; id: string }[];
  /** Lab custom roles with their fixed role_definition_id. Each name starts lab-<lab>-. */
  custom: { lab: string; name: string; id: string }[];
  principalTypes: ("User" | "Group" | "ServicePrincipal")[];
}
export const ALLOWED_ROLES: AllowedRoles = {
  builtIn: allowedRoles.builtIn,
  custom: allowedRoles.custom,
  principalTypes: allowedRoles.principalTypes as AllowedRoles["principalTypes"],
};

// ── Cost and time ────────────────────────────────────────────────────────

/** Spec §9.1: a monthly fee is spread over 730 hours. */
export const HOURS_PER_MONTH = 730;

/**
 * £ per hour: Σ gbp_h × qty. `priceOf` may give a fresh retail price per unit
 * per hour for an item (null: keep the authored gbp_h). Rounded to 6 places.
 */
export function estimateGbpH(items: readonly LabCostItem[], priceOf?: (item: LabCostItem) => number | null): number {
  const sum = items.reduce((n, i) => n + (priceOf?.(i) ?? i.gbp_h) * (i.qty ?? 1), 0);
  return Math.round(sum * 1e6) / 1e6;
}

/** The card's marker (§12.2): £ pennies an hour, ££ up to about 50p, £££ about £1 or more (from 50p), or a deploy of 30 minutes or more. */
export function costMarker(gbpH: number, deployMin: number): "£" | "££" | "£££" {
  if (gbpH >= 0.5 || deployMin >= 30) return "£££";
  return gbpH >= 0.05 ? "££" : "£";
}

/** lab.yml's timeout-minutes (§5): 2 × (deploy + destroy) + 20, at most 150. */
export function sessionTimeoutMin(t: Pick<LabDef["timing"], "deploy_min" | "destroy_min">): number {
  return Math.min(150, 2 * (t.deploy_min + t.destroy_min) + 20);
}

/** A failed deploy is destroyed after this long; also the cost guard's grace past a deadline (§7.4). */
export const LAB_GRACE_MIN = 15;
/** Sessions this long or longer count as "run" for coverage (§7.2). */
export const LAB_COVERAGE_MIN = 15;
/** Session notes are at most this long (§7.2). */
export const LAB_NOTE_MAX = 2000;
/** Deploy and Extend take whole hours, 1 to 12 (no lab's max_h is over 12). */
export const LAB_HOURS_MAX = 12;

// ── Sessions, runs and the workflow (spec §5, §7.1) ──────────────────────

export const LAB_SESSION_STATES = ["deploying", "running", "failed", "tearing_down", "ended", "ended_dirty"] as const;
/** A session in one of these holds Azure resources (and its slot). */
export const LAB_LIVE_STATES = ["deploying", "running", "failed", "tearing_down"] as const;
export const LAB_PEERINGS = ["off", "waiting", "on", "disconnected"] as const;
export const LAB_END_REASONS = ["manual", "timer", "max", "budget", "failed", "orphan", "test"] as const;
export const LAB_ACTIONS = ["deploy", "destroy", "peer", "unpeer", "test"] as const;
export const LAB_WARNING_KINDS = ["budget", "capacity", "pricey", "slow", "unavailable"] as const;

type Action = (typeof LAB_ACTIONS)[number];
const ALL: Action[] = ["deploy", "destroy", "peer", "unpeer", "test"];
/** The 16 steps of lab.yml (§5), by number, with the actions each runs on. Step names are lab.yml's step names. */
export const LAB_STEPS: readonly { n: number; name: string; on: Action[] }[] = [
  { n: 1, name: "Check out, Parse payload", on: ALL },
  { n: 2, name: "Collect run secrets", on: ALL },
  { n: 3, name: "Start live log", on: ALL },
  { n: 4, name: "Wait for earlier run of this lab", on: ALL },
  { n: 5, name: "Terraform init", on: ["deploy", "destroy", "test"] },
  { n: 6, name: "Plan and scope check", on: ["deploy", "test"] },
  { n: 7, name: "Apply", on: ["deploy", "test"] },
  { n: 8, name: "Ready check", on: ["deploy", "test"] },
  { n: 9, name: "Peer", on: ["deploy", "peer", "test"] },
  { n: 10, name: "Unpeer", on: ["destroy", "unpeer", "test"] },
  { n: 11, name: "Unblock", on: ["destroy", "test"] },
  { n: 12, name: "Destroy", on: ["destroy", "test"] },
  { n: 13, name: "Safety net", on: ["destroy", "test"] },
  { n: 14, name: "Verify clean", on: ["destroy", "test"] },
  { n: 15, name: "Back up state", on: ALL },
  { n: 16, name: "Finish live log, Report result", on: ALL },
];

// ── Settings (Settings → Labs) ───────────────────────────────────────────

export const LABS_MAX_RUNNING_DEFAULT = 3;

/** The two lab settings from the stored overrides (D1 settings): labs_max_running 1-5 (default 3) and labs_default_peering "1"/"0" (default on). */
export function labsSettingsFrom(stored: Record<string, string>): { labsMaxRunning: number; labsDefaultPeering: boolean } {
  const n = Number(stored.labs_max_running);
  return {
    labsMaxRunning: Number.isInteger(n) && n >= 1 && n <= 5 ? n : LABS_MAX_RUNNING_DEFAULT,
    labsDefaultPeering: stored.labs_default_peering !== "0",
  };
}
