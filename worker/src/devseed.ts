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

import type { Context } from "hono";
import type { Env } from "./env";
import { isLocalhost } from "./auth";
import * as db from "./db";
import { EMPTY, getSnapshot, saveSnapshot, nextTraffic, nextLatency, nextSession, nextTalkers, detectRoams, type AgentReport, type AgentPeer, type Snapshot, type Step, type Session, type Talker, type FirewallStatus } from "./state";
import { recordHeartbeat, rollUp, bucket, fwDeltas } from "./history";
import { freshDrops, nextFirewall } from "./runs";
import { effectiveConfig } from "./settings";
import { compileFirewall } from "./firewall";
import { budgetStatus } from "./budget";

export const SCENARIOS = ["empty", "destroyed", "deploying", "running", "failed", "standby", "busy-month"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** True only on a developer's PC: the login bypass is on and the request is for localhost. */
export function devSeedAllowed(env: Env, url: string): boolean {
  return env.AUTH_DEV_BYPASS === "1" && isLocalhost(url);
}

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const USER = "dev@localhost";
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
  { name: "sj-phone", ip: "10.13.13.3", full: true, vnet: true, dns: true, routes: "", note: "Android", presence: 0.8, lat: [32, 6], rate: 41_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.web] },
  { name: "sj-gaming", ip: "10.13.13.2", full: true, vnet: false, dns: true, routes: "", note: "Gaming PC", presence: 0.3, lat: [24, 5], rate: 210_000, online: false, lastSeenDays: 3, remotes: [...REMOTES.game] },
  { name: "laptop", ip: "10.13.13.4", full: false, vnet: true, dns: true, routes: "", note: null, presence: 0.5, lat: [26, 5], rate: 38_000, online: false, lastSeenDays: 8, remotes: [...REMOTES.dev] },
  { name: "work-mac", ip: "10.13.13.5", full: false, vnet: true, dns: true, routes: "", note: "Work", presence: 0.7, lat: [28, 4], rate: 96_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.dev] },
  { name: "k8s-node", ip: "10.13.13.11", full: false, vnet: true, dns: false, routes: "", note: "Lab cluster", presence: 0.9, lat: [26, 3], rate: 70_000, online: true, lastSeenDays: 0, remotes: [...REMOTES.k8s] },
  { name: "tablet", ip: "10.13.13.7", full: true, vnet: false, dns: true, routes: "", note: null, presence: 0.2, lat: [31, 6], rate: 22_000, online: false, lastSeenDays: 21, remotes: [...REMOTES.web] },
  { name: "guest-ipad", ip: "10.13.13.14", full: true, vnet: false, dns: true, routes: "", note: "Guest, expires soon", presence: 0.1, lat: [34, 7], rate: 18_000, online: false, lastSeenDays: 12, expiresInDays: 4, remotes: [...REMOTES.web] },
];

const FOUR = ["home-site", "sj-phone", "sj-gaming", "laptop"];

interface SeedPeer {
  id: number;
  public_key: string;
  ip: string;
  cast: Cast;
  endpoint: string;
}

async function insertPeers(env: Env, rng: Rng, now: number, names: string[]): Promise<SeedPeer[]> {
  const out: SeedPeer[] = [];
  for (const c of CAST.filter((x) => names.includes(x.name))) {
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
    out.push({ id: p.id, public_key: p.public_key, ip: p.ip, cast: c, endpoint: `${rng.int(31, 92)}.${rng.int(1, 250)}.${rng.int(1, 250)}.${rng.int(2, 250)}:${rng.int(20000, 60000)}` });
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
    .bind(iso(at), USER, action, target, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after))
    .run();
}

/** One session's two runs (deploy, then tear-down if it ended) with their steps, and the notes the watchman sent. */
async function addSession(env: Env, rng: Rng, s: Session0, now: number, o: { peersLoaded: number; ack: boolean; password?: string }): Promise<{ applyId: string; destroyId: string | null; publicIp: string }> {
  const buildSecs = stepSeconds(DEPLOY_STEPS) + rng.int(-20, 40);
  const requested = s.start - buildSecs * 1000 - rng.int(5, 20) * 1000;
  const started = requested + rng.int(4, 15) * 1000;
  const applyId = runId("apply", requested, rng);
  const publicIp = `20.${rng.int(100, 120)}.${rng.int(1, 250)}.${rng.int(2, 250)}`;
  await db.createRun(env, {
    id: applyId,
    action: "apply",
    status: "queued",
    requested_at: iso(requested),
    requested_by: s.by,
    callback_token_hash: null,
    agent_token_hash: null,
    payload_json: JSON.stringify({ region: s.region, vm_size: "Standard_B1s", run_id: applyId, peers_json: JSON.stringify(Array.from({ length: o.peersLoaded }, (_, i) => ({ n: i }))), ssh_allowed_cidr: "203.0.113.9/32" }),
    auto_destroy_at: s.end ? iso(s.end) : iso(now + 3 * HOUR + 12 * MIN),
    reason: s.reason,
    ssh_password: o.password ?? null,
  });
  await db.updateRun(env, applyId, {
    status: "success",
    started_at: iso(started),
    finished_at: iso(s.start),
    github_run_id: 7_000_000_000 + rng.int(1, 999_999),
    github_run_url: `https://github.com/sjohnston1972/wireguard/actions/runs/${7_000_000_000 + rng.int(1, 999_999)}`,
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
    await db.updateRun(env, destroyId, { status: "success", started_at: iso(startD), finished_at: iso(finD), github_run_id: 7_000_000_000 + rng.int(1, 999_999), github_run_url: `https://github.com/sjohnston1972/wireguard/actions/runs/${7_000_000_000 + rng.int(1, 999_999)}`, steps_json: JSON.stringify(stepList(DESTROY_STEPS, startD)) });
    const hours = (s.end - s.start) / HOUR;
    await note(env, finD, "destroy", "Torn down: everything in Azure is gone.", destroyId, o.ack);
    await note(env, finD + 1000, "session", `Session ${Math.floor(hours)}h ${Math.round((hours % 1) * 60)}m, about £${(hours * 0.0157).toFixed(2)}.`, destroyId, o.ack);
  }
  return { applyId, destroyId, publicIp };
}

async function addFailedRun(env: Env, rng: Rng, atMs: number, error: string): Promise<string> {
  const id = runId("apply", atMs, rng);
  const started = atMs + 8000;
  const failAt = 6;
  const steps = stepList(DEPLOY_STEPS, started, { failAt });
  const finished = Date.parse(steps[failAt].completed_at!);
  await db.createRun(env, { id, action: "apply", status: "queued", requested_at: iso(atMs), requested_by: USER, callback_token_hash: null, agent_token_hash: null, payload_json: JSON.stringify({ region: "uksouth", vm_size: "Standard_B1s", run_id: id }), auto_destroy_at: null, reason: null, ssh_password: null });
  await db.updateRun(env, id, { status: "failure", started_at: iso(started), finished_at: iso(finished), github_run_id: 7_000_000_000 + rng.int(1, 999_999), github_run_url: `https://github.com/sjohnston1972/wireguard/actions/runs/7000${rng.int(10000, 99999)}`, error, steps_json: JSON.stringify(steps) });
  await note(env, finished, "failure", `Deploy failed: ${error}`, id, false);
  return id;
}

// ── Sessions on the calendar ──────────────────────────────────────────────

/** Past sessions on the given days ago (UTC), none ending later than `latestEnd`. */
function pastSessions(rng: Rng, now: number, daysAgo: number[], latestEnd: number, by = USER): Session0[] {
  const out: Session0[] = [];
  for (const d of daysAgo) {
    const start = midnight(now - d * DAY) + rng.int(8, 18) * HOUR + rng.int(0, 11) * 5 * MIN;
    const end = Math.min(start + rng.int(24, 60) * 5 * MIN, latestEnd);
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
 * before it. The last state is returned for the snapshot.
 */
async function simulate(env: Env, rng: Rng, o: { startMs: number; endMs: number; stepMs: number; peers: SeedPeer[]; presence: Map<number, Presence | null>; ruleIds: number[]; fwHash: string; port: number; serverKey: string }): Promise<SimOut> {
  const ticks: number[] = [];
  for (let t = o.endMs; t > o.startMs + o.stepMs; t -= o.stepMs) ticks.unshift(t);
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

  for (const t of ticks) {
    const peers: AgentPeer[] = [];
    const rtt: Record<string, number> = {};
    const stepSecs = o.stepMs / 1000;
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
async function wipe(env: Env): Promise<void> {
  const tables = ["peers", "runs", "alerts", "audit", "cost_days", "speedtests", "captures", "hist_vm", "hist_client", "hist_drops", "hist_fw", "fw_forwards", "fw_rules", "fw_draft_rules", "schedules"];
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
  await env.DB.prepare("DELETE FROM settings WHERE key = 'monthly_budget_gbp'").run();
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
    { kind: "Virtual machine", name: "vm-wg", detail: "Standard_B1s, running" },
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

/** Wipe the local data and build one scenario. `now` is injectable so a run can be repeated exactly. */
export async function seedScenario(env: Env, scenario: Scenario, nowDate = new Date()): Promise<SeedResult> {
  const now = nowDate.getTime();
  const rng = makeRng(SEED);
  await wipe(env);
  await insertRules(env, scenario !== "empty");
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
      await simulate(env, rng, { startMs: s.start, endMs: s.end!, stepMs: 5 * MIN, peers, presence, ruleIds: ruleIdsIn, fwHash, port: cfg.port, serverKey });
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

  if (scenario === "empty") {
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (scenario === "busy-month") {
    const peers = await insertPeers(env, rng, now, CAST.map((c) => c.name));
    const spans: { start: number; end: number | null }[] = [];
    for (let d = 29; d >= 0; d--) {
      const dayStart = midnight(now - d * DAY);
      const n = rng.chance(0.65) ? (rng.chance(0.2) ? 2 : 1) : 0;
      for (let k = 0; k < n; k++) {
        const start = dayStart + (k === 0 ? rng.int(7, 12) : rng.int(15, 19)) * HOUR + rng.int(0, 11) * 5 * MIN;
        const end = Math.min(start + rng.int(18, 60) * 5 * MIN, now - 3 * HOUR);
        if (end - start < HOUR || start + 20 * MIN > now) continue;
        const s: Session0 = { start, end, region: rng.chance(0.15) ? "eastus" : "uksouth", by: rng.chance(0.3) ? "watchman" : USER, reason: rng.chance(0.3) ? "schedule" : null };
        await addSession(env, rng, s, now, { peersLoaded: peers.length, ack: now - end > 2 * DAY });
        spans.push({ start, end });
      }
      if (d !== 0 && rng.chance(0.12)) await addFailedRun(env, rng, dayStart + rng.int(9, 20) * HOUR, rng.pick(["Terraform apply failed: SkuNotAvailable for Standard_B1s in uksouth.", "Terraform apply failed: QuotaExceeded for the regional vCPU limit.", "Could not collect secrets from GitHub Actions (timeout)."]));
    }
    // One run cancelled by hand.
    const cancelAt = midnight(now - 11 * DAY) + 21 * HOUR;
    const cid = runId("apply", cancelAt, rng);
    await db.createRun(env, { id: cid, action: "apply", status: "queued", requested_at: iso(cancelAt), requested_by: USER, callback_token_hash: null, agent_token_hash: null, payload_json: JSON.stringify({ region: "uksouth", vm_size: "Standard_B1s" }), auto_destroy_at: null, reason: null, ssh_password: null });
    await db.updateRun(env, cid, { status: "cancelled", started_at: iso(cancelAt + 9000), finished_at: iso(cancelAt + 80_000), steps_json: JSON.stringify(stepList(DEPLOY_STEPS, cancelAt + 9000, { failAt: 3 }).map((s) => (s.conclusion === "failure" ? { ...s, conclusion: "cancelled" } : s))) });
    const problems: [string, string][] = [
      ["idle", "No client activity for 30 minutes; tearing down in 10 minutes unless someone connects."],
      ["cost_guard", "Auto-destroy extended once; the cost guard stopped it at the 4 hour limit."],
      ["drift", "DNS mismatch: wg.clydeford.net resolves to 192.0.2.1 but the VM is at 20.108.44.12."],
      ["unreachable", "No heartbeat from the VM for 2 minutes. It may be down, or the agent token may be wrong."],
      ["info", "Heartbeat from the VM is back."],
      ["info", 'Client "guest-ipad" expired and was switched off.'],
    ];
    for (let i = 0; i < 12; i++) {
      const [kind, msg] = problems[i % problems.length];
      await note(env, now - rng.int(2, 28 * 24) * HOUR, kind, msg, null, i > 3);
    }
    const changes: [string, string, unknown, unknown][] = [
      ["client.add", "k8s-node", null, { name: "k8s-node", ip: "10.13.13.11", full_tunnel: 0 }],
      ["client.edit", "laptop", { enabled: 1 }, { enabled: 0 }],
      ["client.edit", "sj-phone", { note: null }, { note: "Android" }],
      ["firewall.rule.add", "Block SSH to the home LAN", null, { action: "deny", proto: "tcp", ports: "22" }],
      ["firewall.rule.toggle", "Clients to each other", { enabled: 1 }, { enabled: 0 }],
      ["firewall.forward.add", "Test VM web page (TCP 8080)", null, { public_port: 8080, target_ip: "10.50.2.4" }],
      ["settings.save", "settings", { auto_destroy_default_hours: "4" }, { auto_destroy_default_hours: "6" }],
      ["settings.save", "settings", { monthly_budget_gbp: "5" }, { monthly_budget_gbp: "10" }],
      ["profile.add", "EU exit", null, { region: "westeurope", vm_size: "Standard_B1s" }],
      ["schedule.add", "Weekdays 08:00-18:00", null, { days: "12345", start_time: "08:00", end_time: "18:00" }],
    ];
    for (let i = 0; i < 24; i++) {
      const [a, tgt, b, af] = changes[i % changes.length];
      await auditAt(env, now - rng.int(1, 29 * 24) * HOUR, a, tgt, b, af);
    }
    await seedCost(env, rng, now, 40, spans);
    await insertSpeedTests(env, rng, now, false);
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  // The rest share a cast. "destroyed" and "failed" and "deploying" have a
  // week of earlier sessions behind them; "standby" and "running" too.
  const names = scenario === "running" || scenario === "standby" ? CAST.map((c) => c.name) : FOUR;
  const peers = await insertPeers(env, rng, now, names);
  const dayList = scenario === "running" ? [6, 5, 4, 2, 1] : [6, 5, 4, 3, 2, 1];
  // The last earlier session must end well before anything happening now.
  const lastEnd = scenario === "standby" ? now - 20 * HOUR : now - 5 * HOUR;
  const earlier = pastSessions(rng, now, dayList, lastEnd);
  const standbySince = now - 3 * HOUR - 8 * MIN;
  if (scenario === "standby") earlier.push({ start: standbySince - 2 * HOUR - 40 * MIN, end: standbySince, region: "uksouth", by: USER, reason: null });
  const spans: { start: number; end: number | null }[] = earlier.map((s) => ({ start: s.start, end: s.end }));
  let lastApply: { applyId: string; publicIp: string } | null = null;
  for (const s of earlier) {
    const r = await addSession(env, rng, s, now, { peersLoaded: peers.length, ack: now - s.end! > DAY });
    lastApply = { applyId: r.applyId, publicIp: r.publicIp };
    if (scenario === "standby" && s.end === standbySince) {
      // Standby: the deploy stands, only the VM is off. Drop the tear-down the helper wrote.
      await env.DB.prepare("DELETE FROM runs WHERE id = ?1").bind(r.destroyId).run();
      await env.DB.prepare("DELETE FROM alerts WHERE run_id = ?1").bind(r.destroyId).run();
    }
  }
  if (scenario === "running" || scenario === "standby") await addForward(env);
  const ids = (await db.listFwRules(env)).map((r) => r.id);
  const hash = await fwHashNow();
  await simSessions(peers, earlier.filter((s) => !(scenario === "standby" && s.end === standbySince)), ids, hash);
  if (scenario === "standby") {
    const s = earlier.at(-1)!;
    const presence = new Map<number, Presence | null>(peers.map((p) => [p.id, p.cast.presence >= 1 ? { from: s.start, to: s.end! } : p.cast.online ? { from: s.start + 10 * MIN, to: s.end! - 20 * MIN } : null]));
    await simulate(env, rng, { startMs: s.start, endMs: s.end!, stepMs: 5 * MIN, peers, presence, ruleIds: ids, fwHash: hash, port: cfg.port, serverKey });
  }
  await rollUp(env, nowDate);

  // Audit trail and a speed test or two.
  const changes: [number, string, string, unknown, unknown][] = [
    [now - 18 * DAY, "client.add", "home-site", null, { name: "home-site", ip: "10.13.13.10", full_tunnel: 0 }],
    [now - 14 * DAY, "client.add", "sj-phone", null, { name: "sj-phone", ip: "10.13.13.3", full_tunnel: 1 }],
    [now - 9 * DAY, "firewall.rule.add", "Block SSH to the home LAN", null, { action: "deny", proto: "tcp", ports: "22" }],
    [now - 5 * DAY, "settings.save", "settings", { auto_destroy_default_hours: "4" }, { auto_destroy_default_hours: "6" }],
    [now - 2 * DAY, "client.edit", "laptop", { enabled: 1 }, { enabled: 0 }],
  ];
  for (const [at, a, tgt, b, af] of changes) await auditAt(env, at, a, tgt, b, af);
  await insertSpeedTests(env, rng, now, scenario === "running");
  await seedCost(env, rng, now, 40, spans);
  await db.addSchedule(env, { days: "12345", start_time: "08:00", end_time: "18:00", profile_id: null });

  if (scenario === "destroyed") {
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (scenario === "standby") {
    const azure = AZURE(now, region, lastApply?.publicIp ?? "20.108.44.12");
    azure.resources[4] = { ...azure.resources[4], detail: "Standard_B1s, deallocated" };
    await saveSnapshot(env, { ...EMPTY, state: "standby", since: iso(standbySince), standby_since: iso(standbySince), public_ip: lastApply?.publicIp ?? null, dns_ip: lastApply?.publicIp ?? null, dns_live: true, region, vm_size: "Standard_B1s", profile: "UK", azure, run_id: lastApply?.applyId ?? null, updated_at: iso(now) });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (scenario === "failed") {
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
      github_run_url: `https://github.com/sjohnston1972/wireguard/actions/runs/7000012345`,
      region,
      vm_size: "Standard_B1s",
      profile: "UK",
      updated_at: iso(now),
    });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  if (scenario === "deploying") {
    const requested = now - 2 * MIN - 28 * SEC;
    const started = requested + 9 * SEC;
    const id = runId("apply", requested, rng);
    await db.createRun(env, { id, action: "apply", status: "queued", requested_at: iso(requested), requested_by: USER, callback_token_hash: null, agent_token_hash: null, payload_json: JSON.stringify({ region, vm_size: "Standard_B1s", run_id: id, peers_json: JSON.stringify(peers.map((p) => ({ n: p.cast.name }))) }), auto_destroy_at: iso(now + 4 * HOUR), reason: null, ssh_password: null });
    // No github_run_id on purpose: the Worker would otherwise look the run up on GitHub and replace these steps.
    await db.updateRun(env, id, { status: "running", started_at: iso(started), github_run_url: "https://github.com/sjohnston1972/wireguard/actions/runs/7000012346" });
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
    const tail = lines.map(([lvl, msg], i) => `${new Date(now - (lines.length - i) * 2500).toISOString().slice(11, 19)} ${lvl} ${msg}`).join("\n");
    await saveSnapshot(env, { ...EMPTY, state: "deploying", run_id: id, action: "apply", since: iso(started), steps, log_tail: tail, github_run_url: "https://github.com/sjohnston1972/wireguard/actions/runs/7000012346", region, vm_size: "Standard_B1s", profile: "UK", updated_at: iso(now) });
    return { ok: true, scenario, now: iso(now), counts: await counts(env) };
  }

  // running
  const startMs = now - 2 * HOUR - 12 * MIN;
  const cur = await addSession(env, rng, { start: startMs, end: null, region, by: USER, reason: null }, now, { peersLoaded: peers.length, ack: false, password: "dev-seed-not-a-real-password" });
  spans.push({ start: startMs, end: null });
  const presence = new Map<number, Presence | null>();
  for (const p of peers) {
    if (p.cast.presence >= 1) presence.set(p.id, { from: startMs, to: now + HOUR });
    else if (p.cast.online) presence.set(p.id, { from: startMs + rng.int(2, 40) * MIN, to: now + HOUR });
    else presence.set(p.id, null);
  }
  // One client was on earlier in this session and left a while ago.
  const left = peers.find((p) => p.cast.name === "laptop");
  if (left) presence.set(left.id, { from: startMs + 5 * MIN, to: now - 47 * MIN });
  const out = await simulate(env, rng, { startMs, endMs: now - 9 * SEC, stepMs: 2 * MIN, peers, presence, ruleIds: ids, fwHash: hash, port: cfg.port, serverKey });
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
    github_run_url: `https://github.com/sjohnston1972/wireguard/actions/runs/7000012347`,
    steps: stepList(DEPLOY_STEPS, startMs - stepSeconds(DEPLOY_STEPS) * 1000),
    azure: AZURE(now, region, cur.publicIp),
    traffic: out.traffic,
    selftest: { at: iso(startMs + 90 * SEC), ms: 8200, handshake: true, tunnel: true, loopback: true, dns: true, internet: true, internet6: null },
    latency: out.latency,
    roams: out.roams,
    session: out.session,
    region,
    vm_size: "Standard_B1s",
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
  return { ok: true, scenario, now: iso(now), counts: await counts(env) };
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
      .bind(`cap-${hex(rng, 8)}`, iso(at), USER, ifc, filter, error ? "failed" : "done", error ? null : bytes, iso(at + 35 * SEC), error)
      .run();
  }
}

// ── The route ─────────────────────────────────────────────────────────────

/**
 * POST /__dev/seed?scenario=<name>[&now=<ISO time>]. A 404 (the same as any
 * route that does not exist) unless the dev guard passes; only then are bad
 * input and results spoken about.
 */
export async function devSeed(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.method !== "POST" || !devSeedAllowed(c.env, c.req.url)) return c.text("404 Not Found", 404);
  const name = c.req.query("scenario") ?? "";
  if (!(SCENARIOS as readonly string[]).includes(name)) return c.json({ ok: false, error: `scenario must be one of: ${SCENARIOS.join(", ")}`, scenarios: [...SCENARIOS] }, 400);
  const nowParam = c.req.query("now");
  const when = nowParam ? new Date(nowParam) : new Date();
  if (Number.isNaN(when.getTime())) return c.json({ ok: false, error: "now must be an ISO time", scenarios: [...SCENARIOS] }, 400);
  return c.json(await seedScenario(c.env, name as Scenario, when));
}
