// devseed.ts
//
// Plain English: a stage-set builder for the developer's own PC. It wipes the
// local database and the stored snapshot, then fills them with a believable
// story (a running VM with clients on it, a deploy half-way through, a failed
// one, a month of busy history...) so the new dashboard can be looked at and
// screenshotted without a cloud. Like loading a canned capture into a packet
// viewer instead of waiting for real traffic.
//
// THE LOCK: the route answers 404, exactly as if it did not exist, unless
// AUTH_DEV_BYPASS is exactly "1" AND the request is for localhost, 127.0.0.1
// or [::1]. That is the same test the login bypass in auth.ts uses (it even
// shares its host check). On the live Worker AUTH_DEV_BYPASS is never set, so
// the route is closed twice over. It is mounted before the login check on
// purpose, so it has to carry its own guard, and does.
//
// History is written through the real write functions (recordHeartbeat,
// rollUp, nextTraffic and friends), one simulated heartbeat at a time, so the
// seeded rows have exactly the shape the VM's heartbeats produce in
// production. Everything is generated from a fixed seed: the same scenario at
// the same time gives the same rows.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import type { Env } from "./env";
import { config } from "./env";
import { isLocalhost } from "./auth";
import * as db from "./db";
import { EMPTY, getSnapshot, saveSnapshot, nextTraffic, nextLatency, nextSession, nextTalkers, detectRoams, type AgentReport, type AgentPeer, type Snapshot, type Step, type Session, type Talker, type FirewallStatus } from "./state";
import { recordHeartbeat, rollUp, bucket, fwDeltas, SUMMARY_RES } from "./history";
import { freshDrops, nextFirewall } from "./runs";
import { effectiveConfig } from "./settings";
import { compileFirewall } from "./firewall";
import { budgetStatus } from "./budget";
import { freezeDevClock } from "./devclock";
import { AZ_TABLES } from "./insights/types";
import { seedInsights } from "./devseed-insights";
import { buildExport } from "./backup";
import { isWgKey } from "./peers";
import { DEVSEED_BACKUP_ROOT, DEVSEED_KV } from "./devmarks";
import { seedLabs, seedLabsMore, wipeLabs, seedActor, withSeedActor, DEFAULT_SEED_ACTOR } from "./devseed-labs";

/**
 * The VM a story runs, and what an hour of it costs (VM, disk and address, Azure's list prices). Every story runs
 * the small B1s, except everything: demo mode's story, which Steven wanted busy, with costs clearly visible but the
 * month under £50 (2026-10-08). It runs a D2s v5, and its prices are seeded to match (seedEverything).
 */
interface SeedVm {
  size: string;
  /** £ an hour: the VM, its disk and its address (as priceInfo adds them up). */
  rate: number;
}
const SMALL_VM: SeedVm = { size: "Standard_B1s", rate: 0.0157 };
const BUSY_VM: SeedVm = { size: "Standard_D2s_v5", rate: 0.0896 };
const vmStore = new AsyncLocalStorage<SeedVm>();
/** The VM of the seed running now (per call, like seedActor, so two seeds at once never mix). */
const vm = (): SeedVm => vmStore.getStore() ?? SMALL_VM;

export const SCENARIOS = ["empty", "destroyed", "deploying", "running", "failed", "standby", "busy-month", "insights", "labs", "labs-setup", "everything"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/**
 * The stories told on top of the running one: the running story first, then
 * their own layers. everything (issue #96) is all of them at once, plus the
 * busy-month kinds of history and the few things no other story shows, so
 * every widget on every page has data (seedEverything, below).
 */
const ON_RUNNING: readonly Scenario[] = ["insights", "labs", "labs-setup", "everything"];

/** True only on a developer's PC: the login bypass is on and the request is for localhost. */
export function devSeedAllowed(env: Env, url: string): boolean {
  return env.AUTH_DEV_BYPASS === "1" && isLocalhost(url);
}

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SEED = 20261002;

// ── Deterministic randomness ──────────────────────────────────────────────

type Rng = { next: () => number; int: (a: number, b: number) => number; pick: <T>(xs: readonly T[]) => T; chance: (p: number) => boolean };

function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => iso(ms).slice(0, 10);
const midnight = (ms: number) => Math.floor(ms / DAY) * DAY;
const hex = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join("");
const round1 = (n: number) => Math.round(n * 10) / 10;

function wgKey(rng: Rng): string {
  const bytes = Array.from({ length: 32 }, () => rng.int(0, 255));
  const k = btoa(String.fromCharCode(...bytes));
  return k.slice(0, 43) + "=";
}

// ── The cast ──────────────────────────────────────────────────────────────

interface Cast {
  name: string;
  ip: string;
  full: boolean;
  vnet: boolean;
  dns: boolean;
  routes: string;
  note: string | null;
  /** How often it is on during a session: 1 = always. */
  presence: number;
  /** Round trip in ms: base and jitter. */
  lat: [number, number];
  /** Typical download rate, bytes per second, while active. */
  rate: number;
  /** In the running scenario: on now, with what dial-in address. */
  online: boolean;
  /** Days since it last shook hands, for the ones that are off. */
  lastSeenDays: number;
  expiresInDays?: number;
  remotes: { r: string; name: string; w: number }[];
}

const REMOTES = {
  web: [
    { r: "142.250.180.14", name: "www.google.com", w: 5 },
    { r: "151.101.65.69", name: "www.reddit.com", w: 3 },
    { r: "104.18.32.47", name: "cdn.cloudflare.com", w: 2 },
  ],
  dev: [
    { r: "140.82.121.4", name: "github.com", w: 5 },
    { r: "52.84.150.39", name: "registry.npmjs.org", w: 3 },
    { r: "13.107.42.14", name: "login.microsoftonline.com", w: 1 },
  ],
  game: [
    { r: "162.159.130.234", name: "discord.com", w: 3 },
    { r: "23.62.226.40", name: "cdn.steamstatic.com", w: 6 },
  ],
  site: [
    { r: "192.168.1.10", name: "nas.home.lan", w: 6 },
    { r: "192.168.1.1", name: "router.home.lan", w: 1 },
  ],
  k8s: [
    { r: "34.107.204.206", name: "registry.k8s.io", w: 4 },
    { r: "52.216.30.14", name: "ghcr.io", w: 2 },
  ],
} as const;

const CAST: Cast[] = [
  { name: "home-site", ip: "10.13.13.10", full: false, vnet: true, dns: false, routes: "192.168.1.0/24", note: "Home network container", presence: 1, lat: [18, 4], rate: 52_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.site] },
  { name: "phone", ip: "10.13.13.3", full: true, vnet: true, dns: true, routes: "", note: "Android", presence: 0.8, lat: [32, 6], rate: 41_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.web] },
  { name: "gaming-pc", ip: "10.13.13.2", full: true, vnet: false, dns: true, routes: "", note: "Gaming PC", presence: 0.3, lat: [24, 5], rate: 210_000, online: false, lastSeenDays: 3, remotes: [...REMOTES.game] },
  { name: "laptop", ip: "10.13.13.4", full: false, vnet: true, dns: true, routes: "", note: null, presence: 0.5, lat: [26, 5], rate: 38_000, online: false, lastSeenDays: 8, remotes: [...REMOTES.dev] },
  { name: "work-mac", ip: "10.13.13.5", full: false, vnet: true, dns: true, routes: "", note: "Work", presence: 0.7, lat: [28, 4], rate: 96_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.dev] },
  { name: "k8s-node", ip: "10.13.13.11", full: false, vnet: true, dns: false, routes: "", note: "Lab cluster", presence: 0.9, lat: [26, 3], rate: 70_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.k8s] },
  { name: "tablet", ip: "10.13.13.7", full: true, vnet: false, dns: true, routes: "", note: null, presence: 0.2, lat: [31, 6], rate: 22_000, online: false, lastSeenDays: 21, remotes: [...REMOTES.web] },
  { name: "guest-ipad", ip: "10.13.13.14", full: true, vnet: false, dns: true, routes: "", note: "Guest, expires soon", presence: 0.1, lat: [34, 7], rate: 18_000, online: false, lastSeenDays: 12, expiresInDays: 4, remotes: [...REMOTES.web] },
];

/**
 * everything's extra clients (demo mode, Steven 2026-10-08: "connected clients ... 6 or so"): two more always on,
 * so six are connected of twelve, and two that come and go.
 */
const EXTRA_CAST: Cast[] = [
  { name: "media-server", ip: "10.13.13.8", full: false, vnet: true, dns: true, routes: "", note: "Media server", presence: 0.95, lat: [21, 4], rate: 150_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.web] },
  { name: "dev-vm", ip: "10.13.13.12", full: false, vnet: true, dns: false, routes: "", note: "Build agent", presence: 0.9, lat: [27, 3], rate: 85_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.dev] },
  { name: "kids-chromebook", ip: "10.13.13.15", full: true, vnet: false, dns: true, routes: "", note: null, presence: 0.3, lat: [35, 7], rate: 26_000, online: false, lastSeenDays: 2, remotes: [...REMOTES.web] },
  { name: "travel-router", ip: "10.13.13.16", full: true, vnet: false, dns: true, routes: "", note: "Holiday router", presence: 0.15, lat: [44, 9], rate: 30_000, online: false, lastSeenDays: 6, remotes: [...REMOTES.web] },
];

const FOUR = ["home-site", "phone", "gaming-pc", "laptop"];

interface SeedPeer {
  id: number;
  public_key: string;
  ip: string;
  cast: Cast;
  endpoint: string;
}

async function insertPeers(env: Env, rng: Rng, now: number, names: string[], cast: Cast[] = CAST): Promise<SeedPeer[]> {
  const out: SeedPeer[] = [];
  for (const c of cast.filter((x) => names.includes(x.name))) {
    const p = await db.addPeer(env, {
      name: c.name,
      public_key: wgKey(rng),
      ip: c.ip,
      full_tunnel: c.full,
      azure_vnet: c.vnet,
      tunnel_dns: c.dns,
      note: c.note ?? undefined,
      expires_at: c.expiresInDays ? iso(now + c.expiresInDays * DAY) : null,
    });
    const created = iso(now - rng.int(20, 90) * DAY);
    const seen = c.lastSeenDays === 0 ? iso(now - rng.int(1, 9) * MIN) : iso(now - c.lastSeenDays * DAY);
    await env.DB.prepare("UPDATE peers SET created_at = ?2, last_handshake_at = ?3, routes = ?4 WHERE id = ?1").bind(p.id, created, seen, c.routes).run();
    // Where it dials in from: TEST-NET-2 (RFC 5737), never a real address. The three unused draws keep every later random number as it was.
    const [, , , host] = [rng.int(31, 92), rng.int(1, 250), rng.int(1, 250), rng.int(2, 250)];
    out.push({ id: p.id, public_key: p.public_key, ip: p.ip, cast: c, endpoint: `198.51.100.${host}:${rng.int(20000, 60000)}` });
  }
  return out;
}

// ── Firewall rules ────────────────────────────────────────────────────────

async function insertRules(env: Env, custom: boolean): Promise<void> {
  const base = (position: number, name: string, src: string, dst: string): Parameters<typeof db.addFwRule>[1] => ({ position, enabled: 1, name, src_kind: "zone", src_value: src, dst_kind: "zone", dst_value: dst, proto: "any", ports: "", action: "allow", log: 0 });
  const rules: Parameters<typeof db.addFwRule>[1][] = [
    base(10, "Clients to the internet (full tunnel)", "clients", "internet"),
    base(20, "Clients to the Azure VNet", "clients", "azure"),
    base(30, "Clients to the home LAN", "clients", "home"),
    base(40, "Clients to each other", "clients", "clients"),
    base(50, "Workloads to the internet (updates)", "workloads", "internet"),
  ];
  if (custom) {
    rules.push({ position: 25, enabled: 1, name: "k8s-node to the cluster API", src_kind: "cidr", src_value: "10.13.13.11/32", dst_kind: "cidr", dst_value: "10.244.0.0/16", proto: "tcp", ports: "6443", action: "allow", log: 0 });
    rules.push({ position: 35, enabled: 1, name: "Block SSH to the home LAN", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "home", proto: "tcp", ports: "22", action: "deny", log: 1 });
  }
  await env.DB.prepare("DELETE FROM fw_rules").run();
  for (const r of rules) await db.addFwRule(env, r);
}

// ── Run steps ─────────────────────────────────────────────────────────────

const DEPLOY_STEPS: [string, number][] = [
  ["Check out code from GitHub", 12],
  ["Parse deployment configuration", 3],
  ["Collect secrets from GitHub Actions", 4],
  ["Create Azure resources (VM, network, disk)", 38],
  ["Wait for VM to be ready", 42],
  ["Set up WireGuard and system config", 19],
  ["Apply Terraform configuration", 48],
  ["Configure firewall rules", 9],
  ["Verify Azure is clean (fallback delete)", 14],
  ["Set DNS record", 6],
  ["Run connectivity tests", 21],
  ["Report result to GitHub", 3],
];
const DESTROY_STEPS: [string, number][] = [
  ["Check out code from GitHub", 11],
  ["Collect secrets from GitHub Actions", 4],
  ["Destroy Azure resources", 71],
  ["Remove DNS record", 5],
  ["Verify Azure is clean (fallback delete)", 12],
  ["Report result to GitHub", 3],
];

/** The GitHub step list for a run that began at `startMs`: all done, or stopped partway. */
function stepList(template: [string, number][], startMs: number, o: { done?: number; failAt?: number } = {}): Step[] {
  let t = startMs;
  return template.map(([name, secs], i) => {
    const s = t;
    t += secs * 1000;
    if (o.failAt !== undefined && i > o.failAt) return { name, status: "completed", conclusion: "skipped", started_at: null, completed_at: null };
    if (o.failAt === i) return { name, status: "completed", conclusion: "failure", started_at: iso(s), completed_at: iso(t) };
    if (o.done !== undefined && i > o.done) return { name, status: "queued", conclusion: null, started_at: null, completed_at: null };
    if (o.done === i) return { name, status: "in_progress", conclusion: null, started_at: iso(s), completed_at: null };
    return { name, status: "completed", conclusion: "success", started_at: iso(s), completed_at: iso(t) };
  });
}

const stepSeconds = (t: [string, number][]) => t.reduce((n, [, s]) => n + s, 0);

// ── Runs, notes and changes ───────────────────────────────────────────────

interface Session0 {
  start: number;
  end: number | null;
  region: string;
  by: string;
  reason: string | null;
}

function runId(action: string, atMs: number, rng: Rng): string {
  const stamp = iso(atMs).replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  return `${action}-${stamp}-${hex(rng, 6)}`;
}

async function note(env: Env, at: number, kind: string, message: string, runIdv: string | null, acknowledged: boolean): Promise<void> {
  await env.DB.prepare("INSERT INTO alerts (at, kind, message, run_id, acknowledged) VALUES (?1, ?2, ?3, ?4, ?5)").bind(iso(at), kind, message, runIdv, acknowledged ? 1 : 0).run();
}

async function auditAt(env: Env, at: number, action: string, target: string, before: unknown, after: unknown): Promise<void> {
  await env.DB.prepare("INSERT INTO audit (at, user, action, target, before_json, after_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(iso(at), seedActor(), action, target, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after))
    .run();
}

/** One session's two runs (deploy, then tear-down if it ended) with their steps, and the notes the watchman sent. */
async function addSession(env: Env, rng: Rng, s: Session0, now: number, o: { peersLoaded: number; ack: boolean; password?: string }): Promise<{ applyId: string; destroyId: string | null; publicIp: string }> {
  const buildSecs = stepSeconds(DEPLOY_STEPS) + rng.int(-20, 40);
  const requested = s.start - buildSecs * 1000 - rng.int(5, 20) * 1000;
  const started = requested + rng.int(4, 15) * 1000;
  const applyId = runId("apply", requested, rng);
  // TEST-NET-3 (RFC 5737): a made-up address, never a real one.
  const publicIp = `203.0.113.${rng.int(2, 250)}`;
  await db.createRun(env, {
    id: applyId,
    action: "apply",
    status: "queued",
    requested_at: iso(requested),
    requested_by: s.by,
    callback_token_hash: null,
    agent_token_hash: null,
    payload_json: JSON.stringify({ region: s.region, vm_size: vm().size, run_id: applyId, peers_json: JSON.stringify(Array.from({ length: o.peersLoaded }, (_, i) => ({ n: i }))), ssh_allowed_cidr: "203.0.113.9/32" }),
    auto_destroy_at: s.end ? iso(s.end) : iso(now + 3 * HOUR + 12 * MIN),
    reason: s.reason,
    ssh_password: o.password ?? null,
  });
  await db.updateRun(env, applyId, {
    status: "success",
    started_at: iso(started),
    finished_at: iso(s.start),
    github_run_id: 7_000_000_000 + rng.int(1, 999_999),
    github_run_url: `https://ci.example.invalid/actions/runs/${7_000_000_000 + rng.int(1, 999_999)}`,
    public_ip: publicIp,
    steps_json: JSON.stringify(stepList(DEPLOY_STEPS, started)),
  });
  await note(env, s.start, "deploy", `Deployed in ${s.region}: the VM is up at ${publicIp}.`, applyId, o.ack);
  let destroyId: string | null = null;
  if (s.end) {
    const reqD = s.end;
    const startD = reqD + rng.int(3, 9) * 1000;
    const finD = startD + stepSeconds(DESTROY_STEPS) * 1000 + rng.int(-8, 25) * 1000;
    destroyId = runId("destroy", reqD, rng);
    await db.createRun(env, { id: destroyId, action: "destroy", status: "queued", requested_at: iso(reqD), requested_by: s.reason === "schedule" ? "watchman" : s.by, callback_token_hash: null, agent_token_hash: null, payload_json: null, auto_destroy_at: null, reason: s.reason, ssh_password: null });
    await db.updateRun(env, destroyId, { status: "success", started_at: iso(startD), finished_at: iso(finD), github_run_id: 7_000_000_000 + rng.int(1, 999_999), github_run_url: `https://ci.example.invalid/actions/runs/${7_000_000_000 + rng.int(1, 999_999)}`, steps_json: JSON.stringify(stepList(DESTROY_STEPS, startD)) });
    const hours = (s.end - s.start) / HOUR;
    await note(env, finD, "destroy", "Torn down: everything in Azure is gone.", destroyId, o.ack);
    await note(env, finD + 1000, "session", `Session ${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m, about £${(hours * vm().rate).toFixed(2)}.`, destroyId, o.ack);
  }
  return { applyId, destroyId, publicIp };
}

/** A run that failed partway: a deploy at "Apply Terraform configuration", or a tear-down at "Destroy Azure resources". */
async function addFailedRun(env: Env, rng: Rng, atMs: number, error: string, action: "apply" | "destroy" = "apply"): Promise<string> {
  const id = runId(action, atMs, rng);
  const started = atMs + 8000;
  const failAt = action === "apply" ? 6 : 2;
  const steps = stepList(action === "apply" ? DEPLOY_STEPS : DESTROY_STEPS, started, { failAt });
  const finished = Date.parse(steps[failAt].completed_at!);
  const payload = action === "apply" ? JSON.stringify({ region: "uksouth", vm_size: vm().size, run_id: id }) : null;
  await db.createRun(env, { id, action, status: "queued", requested_at: iso(atMs), requested_by: seedActor(), callback_token_hash: null, agent_token_hash: null, payload_json: payload, auto_destroy_at: null, reason: null, ssh_password: null });
  await db.updateRun(env, id, { status: "failure", started_at: iso(started), finished_at: iso(finished), github_run_id: 7_000_000_000 + rng.int(1, 999_999), github_run_url: `https://ci.example.invalid/actions/runs/7000${rng.int(10000, 99999)}`, error, steps_json: JSON.stringify(steps) });
  await note(env, finished, "failure", `${action === "apply" ? "Deploy" : "Tear-down"} failed: ${error}`, id, false);
  return id;
}

/** A deploy cancelled by hand while the Azure resources were being made. */
async function addCancelledRun(env: Env, rng: Rng, atMs: number): Promise<string> {
  const id = runId("apply", atMs, rng);
  await db.createRun(env, { id, action: "apply", status: "queued", requested_at: iso(atMs), requested_by: seedActor(), callback_token_hash: null, agent_token_hash: null, payload_json: JSON.stringify({ region: "uksouth", vm_size: vm().size }), auto_destroy_at: null, reason: null, ssh_password: null });
  await db.updateRun(env, id, { status: "cancelled", started_at: iso(atMs + 9000), finished_at: iso(atMs + 80_000), steps_json: JSON.stringify(stepList(DEPLOY_STEPS, atMs + 9000, { failAt: 3 }).map((s) => (s.conclusion === "failure" ? { ...s, conclusion: "cancelled" } : s))) });
  return id;
}

/** What the watchman writes about problems, one of each kind it uses. */
const WATCHMAN_NOTES: [string, string][] = [
  ["idle", "No client activity for 30 minutes; tearing down in 10 minutes unless someone connects."],
  ["cost_guard", "Auto-destroy extended once; the cost guard stopped it at the 4 hour limit."],
  ["drift", "DNS mismatch: {dns} resolves to 192.0.2.1 but the VM is at 203.0.113.12."],
  ["unreachable", "No heartbeat from the VM for 2 minutes. It may be down, or the agent token may be wrong."],
  ["info", "Heartbeat from the VM is back."],
  ["info", 'Client "guest-ipad" expired and was switched off.'],
];

/** `count` watchman notes at random times in the last `hours` hours, taking the kinds in turn; the first four unread. */
async function addWatchmanNotes(env: Env, rng: Rng, now: number, count: number, hours: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const [kind, msg] = WATCHMAN_NOTES[i % WATCHMAN_NOTES.length];
    // {dns}: this environment's DNS name (the demo's example one, never the real one there).
    await note(env, now - rng.int(2, hours) * HOUR, kind, msg.replace("{dns}", config(env).dnsName), null, i > 3);
  }
}

/** Changes made in the dashboard: clients, firewall rules and ports, settings, profiles and schedules. */
const CHANGE_LOG: [string, string, unknown, unknown][] = [
  ["client.add", "k8s-node", null, { name: "k8s-node", ip: "10.13.13.11", full_tunnel: 0 }],
  ["client.edit", "laptop", { enabled: 1 }, { enabled: 0 }],
  ["client.edit", "phone", { note: null }, { note: "Android" }],
  ["firewall.rule.add", "Block SSH to the home LAN", null, { action: "deny", proto: "tcp", ports: "22" }],
  ["firewall.rule.toggle", "Clients to each other", { enabled: 1 }, { enabled: 0 }],
  ["firewall.forward.add", "Test VM web page (TCP 8080)", null, { public_port: 8080, target_ip: "10.50.2.4" }],
  ["settings.save", "settings", { auto_destroy_default_hours: "4" }, { auto_destroy_default_hours: "6" }],
  ["settings.save", "settings", { monthly_budget_gbp: "5" }, { monthly_budget_gbp: "10" }],
  ["profile.add", "EU exit", null, { region: "westeurope", vm_size: "Standard_B1s" }],
  ["schedule.add", "Weekdays 08:00-18:00", null, { days: "12345", start_time: "08:00", end_time: "18:00" }],
];

/** `count` changes at random times in the last `hours` hours, taking CHANGE_LOG in turn. */
async function addChangeLog(env: Env, rng: Rng, now: number, count: number, hours: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const [a, tgt, b, af] = CHANGE_LOG[i % CHANGE_LOG.length];
    await auditAt(env, now - rng.int(1, hours) * HOUR, a, tgt, b, af);
  }
}

// ── Sessions on the calendar ──────────────────────────────────────────────

/** Past sessions on the given days ago (UTC), none ending later than `latestEnd`. `long`: working days of 7 to 12 hours (everything). */
function pastSessions(rng: Rng, now: number, daysAgo: number[], latestEnd: number, by = seedActor(), long = false): Session0[] {
  const out: Session0[] = [];
  for (const d of daysAgo) {
    const start = midnight(now - d * DAY) + (long ? rng.int(7, 11) : rng.int(8, 18)) * HOUR + rng.int(0, 11) * 5 * MIN;
    const end = Math.min(start + (long ? rng.int(84, 144) : rng.int(24, 60)) * 5 * MIN, latestEnd);
    if (end - start < HOUR) continue;
    out.push({ start, end, region: "uksouth", by: rng.chance(0.25) ? "watchman" : by, reason: rng.chance(0.25) ? "schedule" : null });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── Simulated heartbeats ──────────────────────────────────────────────────

interface Presence {
  from: number;
  to: number;
}

interface SimOut {
  report: AgentReport;
  traffic: Snapshot["traffic"];
  latency: Record<string, number[]>;
  session: Session | null;
  talkers: Record<string, Talker>;
  hist: { t: string; rx: number; tx: number }[];
  firewall: FirewallStatus | null;
  roams: Snapshot["roams"];
}

const DROP_FLOWS = [
  { src: "10.50.2.4", dst: "192.168.1.10", proto: "tcp", dport: 8080, in: "eth1", out: "wg0", w: 5 },
  { src: "10.13.13.5", dst: "203.0.113.44", proto: "tcp", dport: 22, in: "wg0", out: "eth0", w: 3 },
  { src: "10.13.13.5", dst: "192.168.1.15", proto: "tcp", dport: 3389, in: "wg0", out: "wg0", w: 2 },
  { src: "10.13.13.7", dst: "198.51.100.23", proto: "tcp", dport: 80, in: "wg0", out: "eth0", w: 2 },
  { src: "10.50.2.4", dst: "8.8.8.8", proto: "udp", dport: 53, in: "eth1", out: "eth0", w: 4 },
] as const;

/**
 * Play one VM session as a series of heartbeats, each saved through the real
 * history writer. Ticks are counted back from `endMs` so the newest sits just
 * before it. The last state is returned for the snapshot. `coarse`: before
 * `untilMs`, heartbeats `stepMs` apart instead (a long session in fewer rows).
 */
async function simulate(env: Env, rng: Rng, o: { startMs: number; endMs: number; stepMs: number; coarse?: { untilMs: number; stepMs: number }; peers: SeedPeer[]; presence: Map<number, Presence | null>; ruleIds: number[]; fwHash: string; port: number; serverKey: string }): Promise<SimOut> {
  const ticks: number[] = [];
  for (let t = o.endMs; t > o.startMs + o.stepMs; t -= o.coarse && t <= o.coarse.untilMs ? o.coarse.stepMs : o.stepMs) ticks.unshift(t);
  const cum = new Map<number, { rx: number; tx: number }>(o.peers.map((p) => [p.id, { rx: 0, tx: 0 }]));
  const pairs = new Map<string, { c: string; r: string; name: string; up: number; down: number }>();
  const counters: Record<string, [number, number]> = { default: [0, 0], ...Object.fromEntries(o.ruleIds.map((id) => [`r${id}`, [0, 0] as [number, number]])) };
  const weights: Record<string, number> = Object.fromEntries(o.ruleIds.map((id, i) => [`r${id}`, [30, 20, 6, 3, 1, 4, 8][i] ?? 1]));
  let prev: AgentReport | null = null;
  let traffic: Snapshot["traffic"] = null;
  let latency: Record<string, number[]> = {};
  let session: Session | null = null;
  let talkers: Record<string, Talker> = {};
  let hist: { t: string; rx: number; tx: number }[] = [];
  let firewall: FirewallStatus | null = null;
  let roams: Snapshot["roams"] = {};
  let report!: AgentReport;
  const dropWeight = DROP_FLOWS.reduce((n, d) => n + d.w, 0);

  for (const [i, t] of ticks.entries()) {
    const peers: AgentPeer[] = [];
    const rtt: Record<string, number> = {};
    const stepSecs = (i > 0 ? t - ticks[i - 1] : o.stepMs) / 1000;
    for (const p of o.peers) {
      const pres = o.presence.get(p.id) ?? null;
      const c = cum.get(p.id)!;
      let hs = 0;
      if (pres && t >= pres.from && t <= pres.to) {
        hs = Math.floor(t / 1000) - rng.int(4, 100);
        const busy = 0.35 + 0.9 * (0.5 + 0.5 * Math.sin(t / (11 * MIN) + p.id)) + 0.5 * rng.next();
        const down = Math.round(p.cast.rate * stepSecs * busy);
        const up = Math.round(down * (0.15 + 0.25 * rng.next()));
        c.tx += down;
        c.rx += up;
        rtt[p.public_key] = round1(Math.max(6, p.cast.lat[0] + (rng.next() - 0.5) * 2 * p.cast.lat[1] + (rng.chance(0.04) ? rng.int(8, 25) : 0)));
        const total = p.cast.remotes.reduce((n, x) => n + x.w, 0);
        for (const rem of p.cast.remotes) {
          const key = `${p.ip}|${rem.r}`;
          const e = pairs.get(key) ?? { c: p.ip, r: rem.r, name: rem.name, up: 0, down: 0 };
          e.up += Math.round((up * rem.w) / total);
          e.down += Math.round((down * rem.w) / total);
          pairs.set(key, e);
        }
        // Packets and bytes per rule, roughly in proportion to the weights.
        const pk = Math.round(down / 900);
        const ids = Object.keys(weights);
        const sum = ids.reduce((n, k) => n + weights[k], 0);
        for (const k of ids) {
          const share = weights[k] / sum;
          counters[k] = [counters[k][0] + Math.round(pk * share), counters[k][1] + Math.round(down * share)];
        }
      } else if (pres && t > pres.to) hs = Math.floor(pres.to / 1000);
      peers.push({ public_key: p.public_key, endpoint: hs ? p.endpoint : null, allowed_ips: `${p.ip}/32`, latest_handshake: hs, rx: c.rx, tx: c.tx });
    }
    report = {
      at: iso(t),
      hostname: "vm-wg",
      uptime_seconds: Math.round((t - o.startMs) / 1000) + 95,
      load: `${(0.05 + rng.next() * 0.2).toFixed(2)} ${(0.06 + rng.next() * 0.12).toFixed(2)} 0.05 1/112 4021`,
      listen_port: o.port,
      server_public_key: o.serverKey,
      loopback: "10.13.13.254",
      wan6: null,
      dns: { up: true, blocked: 1243 },
      peers,
    };
    // A burst of denied traffic now and then, most of it from the same few flows.
    const dropN = rng.chance(0.6) ? rng.int(1, 5) : 0;
    const drops = Array.from({ length: dropN }, () => {
      let x = rng.next() * dropWeight;
      const f = DROP_FLOWS.find((d) => (x -= d.w) < 0) ?? DROP_FLOWS[0];
      return { src: f.src, dst: f.dst, proto: f.proto, dport: f.dport, in: f.in, out: f.out };
    });
    counters.default = [counters.default[0] + dropN, counters.default[1] + dropN * 60];
    const fwReport = { hash: o.fwHash, error: null, counters: structuredClone(counters), drops };
    traffic = nextTraffic(traffic, report, t);
    await recordHeartbeat(env, { report, prev, rtt, traffic, drops: freshDrops(fwReport, report.at), fwHits: fwDeltas(firewall, fwReport) });
    latency = nextLatency(latency, rtt, report.peers.map((p) => p.public_key));
    roams = { ...roams, ...detectRoams(prev, report, report.at) };
    session = nextSession(session, prev, report, t);
    firewall = nextFirewall(firewall, fwReport, report.at);
    talkers = nextTalkers(talkers, [...pairs.values()], report.at);
    hist = hist.concat({ t: report.at, rx: Math.round(traffic.rx_rate), tx: Math.round(traffic.tx_rate) }).slice(-240);
    prev = report;
  }
  return { report, traffic, latency, session, talkers, hist, firewall, roams };
}

/** Wipe everything the seeder owns. */
async function wipe(env: Env, now: number): Promise<void> {
  // ui_prefs too: every story starts with the widgets as they ship (shots --prefs saves its own after seeding).
  // And the Azure insights tables: only the insights story fills them. The cost split and the runs' live logs: only everything.
  const tables = ["peers", "runs", "alerts", "audit", "cost_days", "cost_breakdown", "run_live_log", "run_live_log_pruned", "speedtests", "captures", "hist_vm", "hist_client", "hist_drops", "hist_fw", "fw_forwards", "fw_rules", "fw_draft_rules", "schedules", "ui_prefs", ...AZ_TABLES];
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    // No draft, and the live rule set back at version 1.
    env.DB.prepare("UPDATE fw_policy SET live_version = 1, draft_base = NULL, draft_default = NULL, apply_token = NULL WHERE id = 1"),
  ]);
  try {
    await env.DB.prepare("DELETE FROM sqlite_sequence").run();
  } catch {
    /* ids simply carry on counting where this database does not allow the reset */
  }
  await env.DB.prepare(`DELETE FROM settings WHERE key IN ('monthly_budget_gbp', ${EVERYTHING_SETTINGS.map(([k]) => `'${k}'`).join(", ")})`).run();
  // Only everything's own: its phone, the cached backup count and this month's budget alert mark.
  await env.DB.prepare("DELETE FROM push_subs WHERE endpoint LIKE ?1").bind(`${SEED_PUSH_HOST}%`).run();
  // The seeded key rotation, only (a real one is kept): the next read records the key afresh.
  await env.DB.prepare("DELETE FROM settings WHERE key = 'server_key' AND value LIKE ?1").bind(`%${SEED_OLD_SERVER_KEY}%`).run();
  await env.STATUS.delete(`budget:alerted:${iso(now).slice(0, 7)}`);
  // The seed's own markers (devmarks.ts): only a story that writes one again shows its stand-ins.
  for (const k of Object.values(DEVSEED_KV)) await env.STATUS.delete(k);
  // The seeded backups, only ever under DEVSEED_BACKUP_ROOT: STATE is production's bucket in wrangler.toml, so the real
  // backups/ and config-backups/ prefixes are never listed for deletion here. Then the cached count.
  const seeded = (await env.STATE.list({ prefix: DEVSEED_BACKUP_ROOT })).objects.map((o) => o.key).filter((k) => k.startsWith(DEVSEED_BACKUP_ROOT));
  if (seeded.length) await env.STATE.delete(seeded);
  await env.STATUS.delete("backup:status");
  // The lab tables and the lab engine's KV records: only the labs story fills them.
  await wipeLabs(env);
}

const AZURE = (now: number, region: string, ip: string): NonNullable<Snapshot["azure"]> => ({
  checked_at: iso(now - 2 * MIN),
  resource_group: "rg-wg-ondemand",
  exists: true,
  resources: [
    { kind: "Resource group", name: "rg-wg-ondemand", detail: region },
    { kind: "Virtual network", name: "vnet-wg", detail: "10.50.0.0/16" },
    { kind: "Public IP", name: "pip-wg", detail: `${ip}, static` },
    { kind: "Network security group", name: "nsg-wg", detail: "allow udp 51820 from *; allow tcp 22 from 203.0.113.9/32" },
    { kind: "Virtual machine", name: "vm-wg", detail: `${vm().size}, running` },
  ],
});

// ── Cost ──────────────────────────────────────────────────────────────────

/** Azure's daily figures: a few pence of storage and address, plus the hours the VM ran. Yesterday is the newest (Azure lags a day). */
async function seedCost(env: Env, rng: Rng, now: number, days: number, spans: { start: number; end: number | null }[]): Promise<void> {
  for (let d = days; d >= 1; d--) {
    const from = midnight(now - d * DAY);
    const to = from + DAY;
    const hours = spans.reduce((n, s) => n + Math.max(0, Math.min(s.end ?? now, to) - Math.max(s.start, from)), 0) / HOUR;
    const gbp = Math.round((0.011 + rng.next() * 0.004 + hours * 0.0157) * 10000) / 10000;
    await db.upsertCostDay(env, day(from), gbp);
  }
  await env.STATUS.put("cost:fetched_day", day(now - DAY));
}

// ── The scenarios ─────────────────────────────────────────────────────────

export interface SeedResult {
  ok: true;
  scenario: Scenario;
  now: string;
  counts: Record<string, number>;
}

async function counts(env: Env): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["peers", "runs", "alerts", "audit", "cost_days", "hist_vm", "hist_client", "hist_drops"]) {
    out[t] = Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())?.n ?? 0);
  }
  return out;
}

/**
 * Wipe the local data and build one scenario. `now` is injectable so a run can be repeated exactly. It writes only
 * through env.DB, env.STATUS, env.STATE and env.RUN_LOCK, so the env decides the target: the dev server's local
 * stores, or demo mode's own store (demo/store.ts hands it the demo environment and actor demo@example.com).
 */
export async function seedScenario(env: Env, scenario: Scenario, nowDate = new Date(), opts: { actor?: string } = {}): Promise<SeedResult> {
  return withSeedActor(opts.actor ?? DEFAULT_SEED_ACTOR, () => vmStore.run(scenario === "everything" ? BUSY_VM : SMALL_VM, () => seedStory(env, scenario, nowDate)));
}

async function seedStory(env: Env, scenario: Scenario, nowDate: Date): Promise<SeedResult> {
  // insights tells the running story, then adds what the Azure collector and a version-7 agent would have stored;
  // labs tells it too, then adds the lab story (devseed-labs.ts); labs-setup is the lab story with the permission check failed;
  // everything is the running story with all of those layers and its own (ON_RUNNING).
  const story = (ON_RUNNING.includes(scenario) ? "running" : scenario) as Exclude<Scenario, "insights" | "labs" | "labs-setup" | "everything">;
  const now = nowDate.getTime();
  const rng = makeRng(SEED);
  // everything is demo mode's story: busier than the running one (Steven, 2026-10-08, "a vibrant busy dashboard").
  // Twelve clients (six connected), a session up since yesterday, longer working days before it, a month of history.
  const busy = scenario === "everything";
  const cast = busy ? [...CAST, ...EXTRA_CAST] : CAST;
  const sessionStart = now - (busy ? 20 : 2) * HOUR - 12 * MIN;
  await wipe(env, now);
  await insertRules(env, story !== "empty");
  await env.STATUS.delete("cost:fetched_day").catch(() => {});
  await saveSnapshot(env, { ...EMPTY, updated_at: iso(now) });
  const cfg = await effectiveConfig(env);
  const serverKey = env.WG_SERVER_PUBLIC_KEY || "wapbe4SDSmZoefARMVLSAR2KHjjCU3DJ3McGiXQ+3yc=";
  const region = cfg.region || "uksouth";
  /** The hash of the rule set as it stands now, so the seeded VM reports it as applied. */
  const fwHashNow = async () => (await compileFirewall(await db.listFwRules(env), cfg, await db.listPeers(env), cfg.firewallDefault, await db.listForwards(env))).hash;
  const simSessions = async (peers: SeedPeer[], sessions: Session0[], ruleIdsIn: number[], fwHash: string) => {
    for (const s of sessions) {
      const presence = new Map<number, Presence | null>();
      const len = (s.end ?? now) - s.start;
      for (const p of peers) {
        if (p.cast.presence >= 1) presence.set(p.id, { from: s.start, to: s.end! });
        else if (rng.chance(p.cast.presence)) {
          const from = s.start + Math.floor(rng.next() * 0.3 * len);
          presence.set(p.id, { from, to: from + Math.floor((0.35 + 0.65 * rng.next()) * (s.end! - from)) });
        } else presence.set(p.id, null);
      }
      // everything's longer days at a heartbeat every 15 minutes: the 7-day charts' half-hour points stay filled, in fewer rows.
      await simulate(env, rng, { startMs: s.start, endMs: s.end!, stepMs: (busy ? 15 : 5) * MIN, peers, presence, ruleIds: ruleIdsIn, fwHash, port: cfg.port, serverKey });
    }
    // The tests the watchman would have caught: a few minutes with no heartbeat in the middle of one session.
    const gapFrom = sessions.at(-2) ?? sessions[0];
    if (gapFrom) {
      const mid = bucket(gapFrom.start + (gapFrom.end! - gapFrom.start) / 2, 60);
      for (let i = 0; i < 4; i++) {
        const t = bucket(Date.parse(mid) + (i + 1) * 60_000, 60);
        await env.DB.prepare("INSERT OR IGNORE INTO hist_vm (res, t, expected, received) VALUES (60, ?1, 1, 0)").bind(t).run();
      }
    }
  };

  if (story === "empty") {
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (story === "busy-month") {
    const peers = await insertPeers(env, rng, now, CAST.map((c) => c.name));
    const spans: { start: number; end: number | null }[] = [];
    for (let d = 29; d >= 0; d--) {
      const dayStart = midnight(now - d * DAY);
      const n = rng.chance(0.65) ? (rng.chance(0.2) ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const start = dayStart + (k === 0 ? rng.int(7, 12) : rng.int(15, 19)) * HOUR + rng.int(0, 11) * 5 * MIN;
        const end = Math.min(start + rng.int(18, 60) * 5 * MIN, now - 3 * HOUR);
        if (end - start < HOUR || start + 20 * MIN > now) continue;
        const s: Session0 = { start, end, region: rng.chance(0.15) ? "eastus" : "uksouth", by: rng.chance(0.3) ? "watchman" : seedActor(), reason: rng.chance(0.3) ? "schedule" : null };
        await addSession(env, rng, s, now, { peersLoaded: peers.length, ack: now - end > 2 * DAY });
        spans.push({ start, end });
      }
      if (d !== 0 && rng.chance(0.12)) await addFailedRun(env, rng, dayStart + rng.int(9, 20) * HOUR, rng.pick(["Terraform apply failed: SkuNotAvailable for Standard_B1s in uksouth.", "Terraform apply failed: QuotaExceeded for the regional vCPU limit.", "Could not collect secrets from GitHub Actions (timeout)."]));
    }
    // One run cancelled by hand.
    await addCancelledRun(env, rng, midnight(now - 11 * DAY) + 21 * HOUR);
    await addWatchmanNotes(env, rng, now, 12, 28 * 24);
    await addChangeLog(env, rng, now, 24, 29 * 24);
    await seedCost(env, rng, now, 40, spans);
    await insertSpeedTests(env, rng, now, false);
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  // The rest share a cast. "destroyed" and "failed" and "deploying" have a
  // week of earlier sessions behind them; "standby" and "running" too.
  const names = story === "running" || story === "standby" ? cast.map((c) => c.name) : FOUR;
  const peers = await insertPeers(env, rng, now, names, cast);
  const dayList = story === "running" ? [6, 5, 4, 2, 1] : [6, 5, 4, 3, 2, 1];
  // The last earlier session must end well before anything happening now.
  const lastEnd = story === "standby" ? now - 20 * HOUR : busy ? sessionStart - 40 * MIN : now - 5 * HOUR;
  const earlier = pastSessions(rng, now, dayList, lastEnd, seedActor(), busy);
  const standbySince = now - 3 * HOUR - 8 * MIN;
  if (story === "standby") earlier.push({ start: standbySince - 2 * HOUR - 40 * MIN, end: standbySince, region: "uksouth", by: seedActor(), reason: null });
  const spans: { start: number; end: number | null }[] = earlier.map((s) => ({ start: s.start, end: s.end }));
  let lastApply: { applyId: string; publicIp: string } | null = null;
  for (const s of earlier) {
    const r = await addSession(env, rng, s, now, { peersLoaded: peers.length, ack: now - s.end! > DAY });
    lastApply = { applyId: r.applyId, publicIp: r.publicIp };
    if (story === "standby" && s.end === standbySince) {
      // Standby: the deploy stands, only the VM is off. Drop the tear-down the helper wrote.
      await env.DB.prepare("DELETE FROM runs WHERE id = ?1").bind(r.destroyId).run();
      await env.DB.prepare("DELETE FROM alerts WHERE run_id = ?1").bind(r.destroyId).run();
    }
  }
  if (story === "running" || story === "standby") await addForward(env);
  const ids = (await db.listFwRules(env)).map((r) => r.id);
  const hash = await fwHashNow();
  // everything: the sessions the roll-up would already have folded (over 47 hours old) are written as its summaries.
  const folded = (s: Session0) => busy && s.end !== null && s.end < now - 47 * HOUR;
  await simSessions(peers, earlier.filter((s) => !(story === "standby" && s.end === standbySince) && !folded(s)), ids, hash);
  if (busy) await summaryHistory(env, rng, { spans: earlier.filter(folded).map((s) => ({ start: s.start, end: s.end! })), stepMs: 30 * MIN, peers, ruleIds: ids });
  if (story === "standby") {
    const s = earlier.at(-1)!;
    const presence = new Map<number, Presence | null>(peers.map((p) => [p.id, p.cast.presence >= 1 ? { from: s.start, to: s.end! } : p.cast.online ? { from: s.start + 10 * MIN, to: s.end! - 20 * MIN } : null]));
    await simulate(env, rng, { startMs: s.start, endMs: s.end!, stepMs: 5 * MIN, peers, presence, ruleIds: ids, fwHash: hash, port: cfg.port, serverKey });
  }
  await rollUp(env, nowDate);

  // Audit trail and a speed test or two.
  const changes: [number, string, string, unknown, unknown][] = [
    [now - 18 * DAY, "client.add", "home-site", null, { name: "home-site", ip: "10.13.13.10", full_tunnel: 0 }],
    [now - 14 * DAY, "client.add", "phone", null, { name: "phone", ip: "10.13.13.3", full_tunnel: 1 }],
    [now - 9 * DAY, "firewall.rule.add", "Block SSH to the home LAN", null, { action: "deny", proto: "tcp", ports: "22" }],
    [now - 5 * DAY, "settings.save", "settings", { auto_destroy_default_hours: "4" }, { auto_destroy_default_hours: "6" }],
    [now - 2 * DAY, "client.edit", "laptop", { enabled: 1 }, { enabled: 0 }],
  ];
  for (const [at, a, tgt, b, af] of changes) await auditAt(env, at, a, tgt, b, af);
  await insertSpeedTests(env, rng, now, story === "running");
  await seedCost(env, rng, now, 40, spans);
  await db.addSchedule(env, { days: "12345", start_time: "08:00", end_time: "18:00", profile_id: null });

  if (story === "destroyed") {
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (story === "standby") {
    const azure = AZURE(now, region, lastApply?.publicIp ?? "203.0.113.12");
    azure.resources[4] = { ...azure.resources[4], detail: "Standard_B1s, deallocated" };
    await saveSnapshot(env, { ...EMPTY, state: "standby", since: iso(standbySince), standby_since: iso(standbySince), public_ip: lastApply?.publicIp ?? null, dns_ip: lastApply?.publicIp ?? null, dns_live: true, region, vm_size: "Standard_B1s", profile: "UK", azure, run_id: lastApply?.applyId ?? null, updated_at: iso(now) });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (story === "failed") {
    const at = now - 26 * MIN;
    const error = "Terraform apply failed: azurerm_linux_virtual_machine.wg: SkuNotAvailable: Standard_B1s is not available in uksouth right now.";
    const id = await addFailedRun(env, rng, at, error);
    const steps = stepList(DEPLOY_STEPS, at + 8000, { failAt: 6 });
    await saveSnapshot(env, {
      ...EMPTY,
      state: "failed",
      run_id: id,
      action: "apply",
      since: steps[6].completed_at,
      error,
      steps,
      log_tail: ["10:24:51 ERROR azurerm_linux_virtual_machine.wg: Creating...", "10:25:12 ERROR Error: creating Linux Virtual Machine: SkuNotAvailable", "10:25:12 ERROR Terraform apply failed (exit 1)"].join("\n"),
      github_run_url: `https://ci.example.invalid/actions/runs/7000012345`,
      region,
      vm_size: "Standard_B1s",
      profile: "UK",
      updated_at: iso(now),
    });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (story === "deploying") {
    const requested = now - 2 * MIN - 28 * SEC;
    const started = requested + 9 * SEC;
    const id = runId("apply", requested, rng);
    await db.createRun(env, { id, action: "apply", status: "queued", requested_at: iso(requested), requested_by: seedActor(), callback_token_hash: null, agent_token_hash: null, payload_json: JSON.stringify({ region, vm_size: "Standard_B1s", run_id: id, peers_json: JSON.stringify(peers.map((p) => ({ n: p.cast.name }))) }), auto_destroy_at: iso(now + 4 * HOUR), reason: null, ssh_password: null });
    // No github_run_id on purpose: the Worker would otherwise look the run up on GitHub and replace these steps.
    await db.updateRun(env, id, { status: "running", started_at: iso(started), github_run_url: "https://ci.example.invalid/actions/runs/7000012346" });
    // Six steps done, the seventh running, as in the mockup: shift the template so "now" falls inside step 7.
    const lead = DEPLOY_STEPS.slice(0, 6).reduce((n, [, s]) => n + s, 0);
    const steps = stepList(DEPLOY_STEPS, now - (lead + 12) * SEC, { done: 6 });
    await db.updateRun(env, id, { steps_json: JSON.stringify(steps) });
    const lines: [string, string][] = [
      ["INFO", "Applying Terraform configuration..."],
      ["INFO", "azurerm_network_interface.wg: Creating..."],
      ["INFO", "azurerm_network_security_group.wg: Creating..."],
      ["INFO", "azurerm_network_interface.wg: Creation complete (2.1s)"],
      ["INFO", "azurerm_public_ip.wg: Creating..."],
      ["INFO", "azurerm_public_ip.wg: Creation complete (1.8s)"],
      ["INFO", "azurerm_linux_virtual_machine.wg: Creating..."],
      ["INFO", "azurerm_linux_virtual_machine.wg: Still creating... (10s)"],
      ["INFO", "azurerm_linux_virtual_machine.wg: Creation complete (26.7s)"],
      ["INFO", "Provisioning VM with cloud-init..."],
      ["INFO", "Installing WireGuard..."],
      ["INFO", "Opening UDP 51820 in Azure NSG..."],
    ];
    const tail = lines.map(([lvl, msg], i) => `${new Date(now - (lines.length - i) * 2500).toISOString()} [${lvl}] ${msg}`).join("\n");
    await saveSnapshot(env, { ...EMPTY, state: "deploying", run_id: id, action: "apply", since: iso(started), steps, log_tail: tail, github_run_url: "https://ci.example.invalid/actions/runs/7000012346", region, vm_size: "Standard_B1s", profile: "UK", updated_at: iso(now) });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  // running
  const startMs = sessionStart;
  const cur = await addSession(env, rng, { start: startMs, end: null, region, by: seedActor(), reason: null }, now, { peersLoaded: peers.length, ack: false, password: "dev-seed-not-a-real-password" });
  spans.push({ start: startMs, end: null });
  const presence = new Map<number, Presence | null>();
  for (const p of peers) {
    if (p.cast.presence >= 1) presence.set(p.id, { from: startMs, to: now + HOUR });
    // everything's long session: the regulars arrive through the day, so the connected count climbs to six.
    else if (p.cast.online) presence.set(p.id, { from: startMs + rng.int(2, busy ? 700 : 40) * MIN, to: now + HOUR });
    else presence.set(p.id, null);
  }
  // One client was on earlier in this session and left a while ago.
  const left = peers.find((p) => p.cast.name === "laptop");
  if (left) presence.set(left.id, { from: startMs + 5 * MIN, to: now - 47 * MIN });
  // And in everything, a chromebook for a few hours this morning.
  const visit = busy ? peers.find((p) => p.cast.name === "kids-chromebook") : undefined;
  if (visit) presence.set(visit.id, { from: startMs + 3 * HOUR, to: startMs + 5 * HOUR + 40 * MIN });
  // everything: a heartbeat every 2 minutes for the last 80 minutes (the 1-hour charts), every 8 before that (fewer rows).
  const coarse = busy ? { untilMs: now - 80 * MIN, stepMs: 8 * MIN } : undefined;
  const out = await simulate(env, rng, { startMs, endMs: now - 9 * SEC, stepMs: 2 * MIN, coarse, peers, presence, ruleIds: ids, fwHash: hash, port: cfg.port, serverKey });
  const snapshot: Partial<Snapshot> = {
    ...EMPTY,
    state: "running",
    run_id: cur.applyId,
    action: "apply",
    since: iso(startMs),
    running_since: iso(startMs),
    public_ip: cur.publicIp,
    dns_ip: cur.publicIp,
    dns_live: true,
    auto_destroy_at: iso(now + 3 * HOUR + 12 * MIN),
    last_agent_at: out.report.at,
    agent: out.report,
    github_run_url: `https://ci.example.invalid/actions/runs/7000012347`,
    steps: stepList(DEPLOY_STEPS, startMs - stepSeconds(DEPLOY_STEPS) * 1000),
    azure: AZURE(now, region, cur.publicIp),
    traffic: out.traffic,
    selftest: { at: iso(startMs + 90 * SEC), ms: 8200, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null },
    latency: out.latency,
    roams: out.roams,
    session: out.session,
    region,
    vm_size: vm().size,
    profile: "UK",
    firewall: out.firewall,
    fw_base: Object.fromEntries(ids.map((id, i) => [`r${id}`, [[9200, 2800, 1500, 900, 300, 120, 60][i] ?? 50, [8_200_000, 2_600_000, 1_100_000, 800_000, 250_000, 90_000, 40_000][i] ?? 40_000]])) as Snapshot["fw_base"],
    talkers: out.talkers,
    traffic_hist: out.hist,
    test_vm_ip: "10.50.2.4",
    updated_at: iso(now),
  };
  await saveSnapshot(env, snapshot);
  await rollUp(env, nowDate);

  // Budget at 40 %: the month's spend so far is pennies, so the budget is set to match.
  const snap = await getSnapshot(env);
  const spent = (await budgetStatus(env, cfg, snap, nowDate)).total;
  await db.setSetting(env, "monthly_budget_gbp", String(Math.max(0.01, Math.round((spent / 0.4) * 100) / 100)));
  await insertDraft(env);
  // Last, so everything above is exactly the running story.
  if (scenario === "insights" || scenario === "everything") {
    await seedInsights(env, now, startMs, region);
    // The dev server shows these rows as connected without Azure credentials (insights/read.ts insightsShown).
    await env.STATUS.put(DEVSEED_KV.insights, "1");
  }
  if (scenario === "labs" || scenario === "labs-setup" || scenario === "everything") await seedLabs(env, now, { setup: scenario === "labs-setup" });
  if (scenario === "everything") await seedEverything(env, rng, { now, nowDate, earlier, applyId: cur.applyId, peers, ruleIds: ids, spans, region });
  return { ok: true, scenario, now: iso(now), counts: await counts(env) };
}

// ── everything (issue #96) ────────────────────────────────────────────────

/** Settings the everything story changes from their defaults, so each Settings section shows a value of its own. */
const EVERYTHING_SETTINGS: [string, string][] = [
  ["idle_destroy_minutes", "30"],
  ["ssh_allowed_cidr", "203.0.113.9/32"],
  ["labs_default_peering", "1"],
  ["vm_size", "Standard_D2s_v5"],
];
/** The seeded phone's push address: a made-up host, so nothing is ever delivered. */
const SEED_PUSH_HOST = "https://push.example.invalid/";
/** The server key "before" the seeded rotation: made up, never a key anything trusted. */
const SEED_OLD_SERVER_KEY = "SeedOnlyOldServerKeyNotRealAAAAAAAAAAAAAAAA=";

/**
 * The running story already told, with the insights and labs layers on top:
 * add what only busy-month or no story at all shows, so every widget on every
 * page has data. A week of history of every kind (a failed deploy, a
 * cancelled one, a failed tear-down, watchman notes of each kind, changes of
 * each kind, a re-key), a live log on every run, Azure's split of the
 * spend, a stale client and one whose config is out of date, the lab story's
 * failed lab and yesterday's lab spend, a phone, backups and settings of its
 * own. And since it became demo mode's story, busy (Steven, 2026-10-08, "a
 * vibrant busy dashboard"): a month of working days behind the week, a
 * D2s v5 whose costs are clearly visible, lab spend to match, and a budget of
 * £60 the month stays well under (never over £50).
 */
async function seedEverything(
  env: Env,
  rng: Rng,
  o: { now: number; nowDate: Date; earlier: Session0[]; applyId: string; peers: SeedPeer[]; ruleIds: number[]; spans: { start: number; end: number | null }[]; region: string },
): Promise<void> {
  const { now } = o;
  // Runs of every kind and outcome. Three days ago had no session, so its two runs stand alone.
  const quiet = midnight(now - 3 * DAY);
  await addFailedRun(env, rng, quiet + 10 * HOUR + 20 * MIN, "Terraform apply failed: azurerm_linux_virtual_machine.wg: SkuNotAvailable: Standard_B1s is not available in uksouth right now.");
  await addCancelledRun(env, rng, quiet + 15 * HOUR + 5 * MIN);
  // Yesterday's session ended at the second try: the first tear-down hit a lock on the disk.
  const last = o.earlier.at(-1);
  if (last?.end) await addFailedRun(env, rng, last.end - 9 * MIN, "Destroy failed: the OS disk is locked by a pending Azure operation; retry in a few minutes.", "destroy");
  await addWatchmanNotes(env, rng, now, 6, 6 * 24);
  await addChangeLog(env, rng, now, CHANGE_LOG.length, 6 * 24);

  // The kinds of change only everything has: a re-keyed client, a phone signed up, a capture, the lock released, a restore.
  const phone = await env.DB.prepare("SELECT * FROM peers WHERE name = 'phone'").first<Record<string, unknown>>();
  if (phone) await auditAt(env, now - 30 * HOUR, "client.rekey", "phone", phone, { ...phone, public_key: wgKey(rng) });
  await auditAt(env, now - 50 * HOUR, "push.add", "Pixel 8", null, { label: "Pixel 8" });
  await auditAt(env, now - 95 * MIN, "capture.start", "wg0", null, { iface: "wg0", filter: "host 10.13.13.3", seconds: 30 });
  await auditAt(env, now - 4 * DAY, "lock.release", "lock", { held: true }, { held: false });
  await auditAt(env, now - 5 * DAY - 3 * HOUR, "config.restore", "config", null, { exported_at: iso(now - 6 * DAY) });

  // Every client's Changes tab has its own entry: when it was added, for those the stories above did not log.
  const logged = new Set((await env.DB.prepare("SELECT target FROM audit WHERE action = 'client.add'").all<{ target: string }>()).results.map((r) => r.target));
  for (const p of await db.listPeers(env)) if (!logged.has(p.name)) await auditAt(env, Date.parse(p.created_at), "client.add", p.name, null, { name: p.name, ip: p.ip, full_tunnel: p.full_tunnel });

  // Clients: one not seen for 41 days (stale), one whose config predates the lab pool.
  await env.DB.batch([
    env.DB.prepare("UPDATE peers SET last_handshake_at = ?1 WHERE name = 'tablet'").bind(iso(now - 41 * DAY)),
    env.DB.prepare("UPDATE peers SET labs_config_due = 1 WHERE name = 'laptop'"),
  ]);
  // The server key was rotated 20 days ago: every client older than that has reconnected with it, except the stale tablet.
  const pub = env.WG_SERVER_PUBLIC_KEY ?? "";
  if (isWgKey(pub)) {
    const rotated = now - 20 * DAY;
    await db.setSetting(env, "server_key", JSON.stringify({ pub, changed_at: iso(rotated), previous: SEED_OLD_SERVER_KEY }));
    await env.DB.prepare("UPDATE peers SET needs_config = 1 WHERE name = 'tablet' AND created_at < ?1").bind(iso(rotated)).run();
    await note(env, rotated, "key_rotation", "Server key changed: configs now trust a new key. Clients need a new config: press Get config on each on the Clients page.", null, true);
  }

  // A month behind the week: its working days, with their runs, notes and history.
  const month = await backfillMonth(env, rng, { now, peers: o.peers, ruleIds: o.ruleIds, region: o.region });
  // What the D2s v5 costs: Azure's prices for it, and its daily figures (in place of the small VM's pennies).
  await busyPrices(env, now, o.region);
  await busyCostDays(env, rng, now, [...o.spans, ...month]);

  // Azure's split of each day's spend: mostly the VM, then disk, address and bandwidth (bandwidth has no region in Azure's export).
  const days = (await env.DB.prepare("SELECT day, gbp FROM cost_days ORDER BY day").all<{ day: string; gbp: number }>()).results;
  const parts: [string, string, number][] = [
    ["Virtual Machines", "uksouth", 0.8],
    ["Storage", "uksouth", 0.07],
    ["Virtual Network", "uksouth", 0.1],
    ["Bandwidth", "", 0.03],
  ];
  await db.upsertCostBreakdown(env, days.flatMap((d) => parts.map(([category, location, share]) => ({ day: d.day, category, location, gbp: Math.round(d.gbp * share * 10000) / 10000 }))));

  // The lab story's extra sessions (a failed lab, yesterday's spend), and settings of everything's own.
  await seedLabsMore(env, now);
  await busyLabCosts(env, now);
  // Every run's log (the gateway's and the labs'), as the workflow's live log would have kept it.
  await addRunLogs(env);
  for (const [k, v] of EVERYTHING_SETTINGS) await db.setSetting(env, k, v);
  await env.DB.prepare("INSERT INTO push_subs (endpoint, p256dh, auth, label, created_at, last_ok, last_error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)")
    .bind(`${SEED_PUSH_HOST}seed-0001`, "BSeedOnlyNotARealKeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "seed-only-auth", "Pixel 8", iso(now - 50 * HOUR), iso(now - 26 * MIN))
    .run();
  await addBackups(env, now);

  // A budget of £60: the month (at most about £45, see busyCostDays) never reaches it, nor its 80 % warning.
  await db.setSetting(env, "monthly_budget_gbp", String(BUSY_BUDGET_GBP));
}

/** everything's monthly budget. */
const BUSY_BUDGET_GBP = 60;

/**
 * everything's month behind the week: on most days 8 to 29 days ago, a working
 * day of 9 to 15 hours, with its deploy and tear-down (and their notes), and
 * its history one summary every 2 hours (the 30-day charts' step; see
 * summaryHistory). Returns the sessions, for the daily costs.
 */
async function backfillMonth(env: Env, rng: Rng, o: { now: number; peers: SeedPeer[]; ruleIds: number[]; region: string }): Promise<{ start: number; end: number }[]> {
  const spans: { start: number; end: number }[] = [];
  for (let d = 29; d >= 8; d--) {
    if (!rng.chance(0.85)) continue;
    const start = midnight(o.now - d * DAY) + rng.int(7, 10) * HOUR + rng.int(0, 11) * 5 * MIN;
    const end = start + rng.int(108, 180) * 5 * MIN;
    await addSession(env, rng, { start, end, region: o.region, by: rng.chance(0.3) ? "watchman" : seedActor(), reason: rng.chance(0.3) ? "schedule" : null }, o.now, { peersLoaded: o.peers.length, ack: true });
    spans.push({ start, end });
  }
  await summaryHistory(env, rng, { spans, stepMs: 2 * HOUR, peers: o.peers, ruleIds: o.ruleIds });
  return spans;
}

/**
 * History for sessions older than the 48 hours raw samples are kept, written
 * straight as the 5-minute summaries the roll-up would have left (history.ts
 * rollUp), one every `stepMs` (the step of the charts that show them): the
 * VM's readings, the regular clients', the firewall's hits and drops. The
 * same shape as the roll-up's rows, in a fraction of the writes a simulated
 * heartbeat every few minutes, then folded, would take (demo mode's refresh
 * has a daily allowance of rows).
 */
async function summaryHistory(env: Env, rng: Rng, o: { spans: { start: number; end: number }[]; stepMs: number; peers: SeedPeer[]; ruleIds: number[] }): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const regulars = o.peers.filter((p) => p.cast.presence >= 0.5);
  const rules = o.ruleIds.map((id, i) => ({ key: `r${id}`, w: [30, 20, 6, 3, 1, 4, 8][i] ?? 1 }));
  const wsum = rules.reduce((n, r) => n + r.w, 0);
  const dropWeight = DROP_FLOWS.reduce((n, d) => n + d.w, 0);
  const secs = o.stepMs / 1000;
  for (const { start, end } of o.spans) {
    for (let t = Math.ceil(start / o.stepMs) * o.stepMs; t < end; t += o.stepMs) {
      const slot = bucket(t, SUMMARY_RES);
      const on = regulars.filter((p) => p.cast.presence >= 1 || rng.chance(0.8));
      let down = 0;
      for (const p of on) {
        const busyF = 0.35 + 0.9 * (0.5 + 0.5 * Math.sin(t / (11 * MIN) + p.id)) + 0.5 * rng.next();
        const tx = Math.round(p.cast.rate * secs * busyF * 0.6);
        const rx = Math.round(tx * (0.15 + 0.25 * rng.next()));
        down += tx;
        const lat = round1(Math.max(6, p.cast.lat[0] + (rng.next() - 0.5) * 2 * p.cast.lat[1]));
        stmts.push(
          env.DB.prepare("INSERT OR IGNORE INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8)").bind(SUMMARY_RES, slot, p.id, rng.int(5, 110), lat, round1(lat + rng.int(2, 14)), rx, tx),
        );
      }
      const txRate = Math.round(down / secs);
      const rxRate = Math.round(txRate * (0.2 + 0.15 * rng.next()));
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up) VALUES (?1, ?2, 5, 5, ?3, ?4, ?5, ?6, ?7, ?8, 1)").bind(
          SUMMARY_RES,
          slot,
          round1(0.1 + rng.next() * 0.3),
          rxRate,
          txRate,
          Math.round(rxRate * (1.4 + rng.next())),
          Math.round(txRate * (1.4 + rng.next())),
          on.length,
        ),
      );
      const pk = Math.round(down / 900);
      for (const r of rules) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO hist_fw (res, t, rule, packets, bytes) VALUES (?1, ?2, ?3, ?4, ?5)").bind(SUMMARY_RES, slot, r.key, Math.max(1, Math.round((pk * r.w) / wsum)), Math.round((down * r.w) / wsum)));
      // Drops: the same few flows as the live sessions, about ten an hour.
      const n = Math.max(1, Math.round((rng.int(6, 26) * o.stepMs) / (2 * HOUR)));
      const flows = new Map<(typeof DROP_FLOWS)[number], number>();
      for (let k = 0; k < n; k++) {
        let x = rng.next() * dropWeight;
        const f = DROP_FLOWS.find((dd) => (x -= dd.w) < 0) ?? DROP_FLOWS[0];
        flows.set(f, (flows.get(f) ?? 0) + 1);
      }
      for (const [f, c] of flows) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO hist_drops (t, src, dst, proto, dport, in_if, out_if, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(slot, f.src, f.dst, f.proto, f.dport, f.in, f.out, c));
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO hist_fw (res, t, rule, packets, bytes) VALUES (?1, ?2, 'default', ?3, ?4)").bind(SUMMARY_RES, slot, n, n * 60));
    }
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

/** Azure's list price for everything's D2s v5 (beside the insights story's B1s), and the size offered in the region's capacity. */
async function busyPrices(env: Env, now: number, region: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, '1 Hour', 'D2s v5', ?4)").bind(region, BUSY_VM.size, 0.0832, iso(now - 5 * HOUR)).run();
  const row = await env.DB.prepare("SELECT json FROM az_capacity WHERE region = ?1").bind(region).first<{ json: string }>();
  if (!row) return;
  const cap = JSON.parse(row.json) as { sizes: unknown[]; usages: unknown[]; cores: { used: number; limit: number } };
  cap.sizes.push({ name: BUSY_VM.size, available: true, reason: null, vcpus: 2, family: "standardDSv5Family" });
  cap.usages.push({ family: "standardDSv5Family", used: 2, limit: 10 });
  cap.cores.used += 2;
  await env.DB.prepare("UPDATE az_capacity SET json = ?2 WHERE region = ?1").bind(region, JSON.stringify(cap)).run();
}

/** The most one of everything's days costs in Azure: × 31 days is still under £50. */
const BUSY_DAY_MAX_GBP = 1.5;

/**
 * everything's daily Azure figures, yesterday back 40 days: the D2s v5's hours
 * that day (the sessions' overlap; before the backfilled month, working days
 * of its own) at its list price and a little bandwidth, plus the disk and the
 * address, which cost the same every day. No day passes £1.50, so even the
 * forecast on the 2nd of a month (one day, carried to 31) stays under £50.
 */
async function busyCostDays(env: Env, rng: Rng, now: number, spans: { start: number; end: number | null }[]): Promise<void> {
  for (let d = 40; d >= 1; d--) {
    const from = midnight(now - d * DAY);
    const to = from + DAY;
    let hours = spans.reduce((n, s) => n + Math.max(0, Math.min(s.end ?? now, to) - Math.max(s.start, from)), 0) / HOUR;
    if (d >= 30 && hours === 0 && rng.chance(0.85)) hours = rng.int(9, 15);
    const gbp = Math.min(BUSY_DAY_MAX_GBP, 0.155 + rng.next() * 0.01 + hours * 0.087);
    await db.upsertCostDay(env, day(from), Math.round(gbp * 10000) / 10000);
  }
  await env.STATUS.put("cost:fetched_day", day(now - DAY));
}

/** £ an hour for each lab in everything: what its resources would cost (a storage account, a VM, a file share...). */
const BUSY_LAB_RATES: Record<string, number> = {
  "az104-01-identity": 0.02,
  "az104-02-policy": 0.03,
  "az104-03-mgmt-groups": 0.02,
  "az104-04-cost": 0.02,
  "az104-05-storage": 0.06,
  "az104-06-blob-security": 0.14,
  "az104-07-files": 0.11,
};

/** everything's lab spend: each lab at its rate above, and Azure's daily lab figures a little over the ended sessions' estimates. */
async function busyLabCosts(env: Env, now: number): Promise<void> {
  for (const [lab, rate] of Object.entries(BUSY_LAB_RATES)) {
    await env.DB.prepare("UPDATE lab_sessions SET est_gbp_h = ?2, est_gbp = CASE WHEN est_gbp IS NULL THEN NULL ELSE ROUND(?2 * (julianday(ended_at) - julianday(requested_at)) * 24, 4) END WHERE lab_id = ?1")
      .bind(lab, rate)
      .run();
  }
  await env.DB.prepare("DELETE FROM lab_cost_days").run();
  await env.DB.prepare(
    `INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at)
     SELECT substr(requested_at, 1, 10), 'rg-lab-' || lab_id, lab_id, ROUND(SUM(est_gbp) * 1.08 + 0.02, 4), ?1
       FROM lab_sessions WHERE est_gbp IS NOT NULL AND ended_at IS NOT NULL AND test = 0
      GROUP BY substr(requested_at, 1, 10), lab_id`,
  )
    .bind(iso(now - 6 * HOUR))
    .run();
}

/** A live log for every run, the gateway's and the labs', built from its steps: GitHub's line format, a group per step, the error where it stopped. */
async function addRunLogs(env: Env): Promise<void> {
  type Row = { id: string; error: string | null; steps_json: string | null; finished_at: string | null };
  const cols = "id, error, steps_json, finished_at";
  const runs = [...(await env.DB.prepare(`SELECT ${cols} FROM runs`).all<Row>()).results, ...(await env.DB.prepare(`SELECT ${cols} FROM lab_runs`).all<Row>()).results];
  const stmts: D1PreparedStatement[] = [];
  for (const r of runs) {
    const steps: Step[] = r.steps_json ? JSON.parse(r.steps_json) : [];
    const lines: string[] = [];
    for (const s of steps) {
      if (!s.started_at) continue;
      const t = (secs: number) => iso(Date.parse(s.started_at!) + secs * 1000);
      lines.push(`${t(0)} ##[group]${s.name}`, `${t(1)} [INFO] ${s.name}: started`);
      if (s.status === "in_progress") {
        lines.push(`${t(2)} [INFO] ${s.name}: still working...`);
        continue;
      }
      if (s.conclusion === "failure") lines.push(`${t(2)} ##[error]${r.error ?? "The step failed."}`);
      else if (s.conclusion === "cancelled") lines.push(`${t(2)} ##[error]The operation was canceled.`);
      else lines.push(`${s.completed_at ?? t(2)} [INFO] ${s.name}: done`);
      lines.push(`${s.completed_at ?? t(2)} ##[endgroup]`);
    }
    if (!lines.length) continue;
    stmts.push(env.DB.prepare("INSERT INTO run_live_log (run_id, seq, at, text) VALUES (?1, CAST(1 AS INTEGER), ?2, ?3)").bind(r.id, r.finished_at ?? lines.at(-1)!.slice(0, 24), lines.join("\n")));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/**
 * The backups a week of use leaves: Terraform's state after each finished
 * gateway run (as wg.yml names them), and a nightly config export for each of
 * the last 7 days (the real export of the seeded settings). All under
 * DEVSEED_BACKUP_ROOT, never the real prefixes; the marker points the dev
 * server's backup list and downloads there (backup.ts backupRoot).
 */
async function addBackups(env: Env, now: number): Promise<void> {
  const root = DEVSEED_BACKUP_ROOT;
  const runs = (await env.DB.prepare("SELECT action, finished_at FROM runs WHERE status = 'success' AND finished_at IS NOT NULL ORDER BY finished_at").all<{ action: string; finished_at: string }>()).results;
  for (const [i, r] of runs.entries()) {
    const ts = r.finished_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const state = { version: 4, terraform_version: "1.9.5", serial: i + 1, lineage: "00000000-0000-4000-8000-0000000005ed", outputs: {}, resources: [] };
    await env.STATE.put(`${root}backups/${ts}-${r.action}.tfstate`, JSON.stringify(state));
  }
  for (let d = 6; d >= 0; d--) {
    const at = new Date(midnight(now - d * DAY) + 2 * HOUR);
    if (at.getTime() > now) continue;
    await env.STATE.put(`${root}config-backups/${day(at.getTime())}.json`, JSON.stringify(await buildExport(env, at), null, 1), { httpMetadata: { contentType: "application/json" } });
  }
  await env.STATUS.put(DEVSEED_KV.backups, "1");
}

/** An unapplied firewall draft with two changes: one rule edited, one added. The live rules (and the VM) are untouched. */
async function insertDraft(env: Env): Promise<void> {
  await db.ensureFwDraft(env);
  const k8s = (await db.listFwDraftRules(env)).find((r) => r.name === "k8s-node to the cluster API");
  if (k8s) await db.updateFwDraftRule(env, k8s.id, { ...k8s, ports: "6443,10250", name: "k8s-node to the cluster API and kubelet" });
  await db.addFwDraftRule(env, { enabled: 1, name: "Clients to the test VM web page", src_kind: "zone", src_value: "clients", dst_kind: "cidr", dst_value: "10.50.2.4/32", proto: "tcp", ports: "8080", action: "allow", log: 0 });
}

async function addForward(env: Env): Promise<void> {
  await db.addForward(env, { name: "Test VM web page", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4", target_port: 8080, allow_from: "" });
}

async function insertSpeedTests(env: Env, rng: Rng, now: number, recent: boolean): Promise<void> {
  const when = [recent ? now - 41 * MIN : now - 2 * DAY, now - 3 * DAY, now - 6 * DAY];
  for (const at of when) {
    await db.saveSpeedTest(env, { id: `st-${hex(rng, 8)}`, at: iso(at), target_name: "home-site", down_mbps: round1(280 + rng.next() * 60), up_mbps: round1(70 + rng.next() * 30), rtt_ms: round1(17 + rng.next() * 6), jitter_ms: round1(1 + rng.next() * 2), error: null });
  }
  if (!recent) return;
  const caps: [number, string, string, number, string | null][] = [
    [now - 95 * MIN, "wg0", "host 10.13.13.3", 2_412_000, null],
    [now - 70 * MIN, "eth0", "tcp port 8080", 880_000, null],
    [now - 22 * MIN, "wg0", "udp port 53", 0, "tcpdump exited: permission denied on eth1"],
  ];
  for (const [at, ifc, filter, bytes, error] of caps) {
    await env.DB.prepare("INSERT INTO captures (id, requested_at, requested_by, iface, filter, seconds, status, bytes, finished_at, error) VALUES (?1, ?2, ?3, ?4, ?5, 30, ?6, ?7, ?8, ?9)")
      .bind(`cap-${hex(rng, 8)}`, iso(at), seedActor(), ifc, filter, error ? "failed" : "done", error ? null : bytes, iso(at + 35 * SEC), error)
      .run();
  }
}

// ── The route ─────────────────────────────────────────────────────────────

/**
 * POST /__dev/seed?scenario=<name>[&now=<ISO time>][&freeze=1]. A 404 (the same as any
 * route that does not exist) unless the dev guard passes; only then are bad
 * input and results spoken about.
 */
export async function devSeed(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method !== "POST" || !devSeedAllowed(c.env, c.req.url)) return c.text("404 Not Found", 404);
  // A third lock (demo mode spec ruling 20): a browser request sent by another site (any Sec-Fetch-Site but
  // same-origin) is refused, so a web page open on this PC cannot wipe the developer's database. The seed script
  // sends no such header and still works; the app's own Dev data section sends same-origin.
  const site = c.req.header("Sec-Fetch-Site");
  if (site !== undefined && site !== "same-origin") return c.text("Refused: the seeder only takes requests from wg-admin's own pages or the seed script.", 403);
  const name = c.req.query("scenario") ?? "";
  if (!(SCENARIOS as readonly string[]).includes(name)) return c.json({ ok: false, error: `scenario must be one of: ${SCENARIOS.join(", ")}`, scenarios: [...SCENARIOS] }, 400);
  const nowParam = c.req.query("now");
  // The real clock first: a previous freeze=1 must not decide what "now" means.
  freezeDevClock(null);
  const when = nowParam ? new Date(nowParam) : new Date();
  if (Number.isNaN(when.getTime())) return c.json({ ok: false, error: "now must be an ISO time", scenarios: [...SCENARIOS] }, 400);
  // freeze=1 (npm run shots -- --freeze-time): this dev Worker's clock stands still at `when` until the next seed.
  if (c.req.query("freeze") === "1") freezeDevClock(when.getTime());
  return c.json(await seedScenario(c.env, name as Scenario, when));
}
