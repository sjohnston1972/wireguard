# Redesign plan 1: history recorder

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start recording VM health, per-client latency/traffic/handshakes and firewall drops into D1 (60 s detail for 48 h, 5-minute summaries for 30 days), and keep each run's GitHub step list, on today's live dashboard, with no visible change.

**Architecture:** A new module `worker/src/history.ts` holds pure sample-building functions and three D1 writers: `recordHeartbeat` (called from the VM heartbeat handler, guarded so it can never fail a heartbeat), `recordMissedHeartbeats` and `rollUp` (both called from the 5-minute watchman). Migration `0012_history.sql` adds three tables and a `runs.steps_json` column. `refreshActiveRun` saves the step list on every GitHub poll.

**Tech Stack:** Cloudflare Worker (TypeScript, Hono), D1 (SQLite), Vitest on Node 24 with the existing harness (`worker/test/harness.ts`: D1 on `node:sqlite` with the real migrations).

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md` (section 5 is this plan; section 14 step 1).

## The plan series

The spec's delivery order becomes five plans, each written when the previous one has landed, so it is based on the code as it then is:

1. **History recorder** (this plan): on `main`, deployed to today's dashboard.
2. JSON API `/api/v1` with tests, on `redesign`.
3. App foundation: Vite + React project, build and dev scripts, tokens and themes, shell, command palette, shared components, query layer, scenario seeder.
4. The six views with their phone layouts (one plan per view if large): Overview, Clients, Firewall (with the draft backend), Activity, Cost, Settings.
5. Switch-over: remove old pages and routes, deploy, live checklist.

## Global Constraints

- All new and changed files start with the house-style header comment: the file name, then a "Plain English:" paragraph saying what it does.
- Times are stored as ISO strings without milliseconds, `YYYY-MM-DDTHH:MM:SSZ` (UTC), produced only by `bucket()`.
- Raw resolution is 60 s (`res = 60`), summaries 300 s (`res = 300`); raw kept 48 h, summaries and drops kept 30 days.
- A history failure must never change the heartbeat's response or the snapshot (catch, log `history:` and carry on).
- Nothing is recorded while the state is `destroyed` or `standby` (the existing late-heartbeat guard in `handleAgent` returns before recording).
- Client rows are keyed by `peers.id`, never by public key (keys change on re-key).
- Byte counters are deltas from the previous heartbeat; a counter that went down (VM rebooted or rebuilt) counts from 0, i.e. the new value.
- Write volume stays inside D1's free allowance: one VM row and one row per client per minute, drops aggregated per minute per flow.
- Tests: `npm test` (node --test for scripts, then Vitest). Typecheck: `npm run typecheck`. Both must pass at the end of every task.
- Branch: `feat/history-recorder`, created from `redesign` (which holds the spec and this plan). PR into `main`. Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`.
- Deploying to production happens only in Task 7, and only after Steven says go.

## Review Focus

1. A VM rebuilt or rebooted mid-session: its WireGuard byte counters restart from zero, so the delta would be negative. Expected: the minute counts the new counter value, never a negative or a huge number. (Task 2)
2. A heartbeat arriving after a tear-down or during Standby (late mail). Expected: nothing is recorded and no availability gap is created. (Task 4 and Task 5)
3. The history tables missing or the D1 write failing. Expected: the heartbeat still returns 200 with the peer list and the snapshot is still updated. (Task 4)
4. Boot time: the VM is "running" from the GitHub callback, but its first heartbeat comes a minute or two later after the self-test. Expected: no "missed" minutes are recorded in the first 3 minutes after `running_since`. (Task 5)
5. Two heartbeats in the same minute. Expected: one row, `received` stays 1, bytes add up, the maximum rate and latency are kept. (Task 3)

---

### Task 1: Migration and the run step column

**Files:**
- Create: `worker/migrations/0012_history.sql`
- Modify: `worker/src/db.ts:12-31` (the `Run` interface)
- Test: `worker/test/history.test.ts` (new)

**Interfaces:**
- Produces: tables `hist_vm`, `hist_client`, `hist_drops`; column `runs.steps_json TEXT`; `db.Run.steps_json: string | null`.

- [ ] **Step 1: Write the failing test**

Create `worker/test/history.test.ts`:

```ts
// history.test.ts
//
// Plain English: the dashboard's own history (history.ts). Samples from
// heartbeats, the watchman filling in missed minutes, folding old samples
// into 5-minute summaries, and the run step list kept with each run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

describe("schema", () => {
  it("has the history tables and the run step column", async () => {
    expect(await columns("hist_vm")).toEqual(["res", "t", "expected", "received", "load1", "rx_rate", "tx_rate", "rx_rate_max", "tx_rate_max", "peers_online", "dns_up"]);
    expect(await columns("hist_client")).toEqual(["res", "t", "peer_id", "online", "handshake_age", "latency_avg", "latency_max", "rx", "tx"]);
    expect(await columns("hist_drops")).toEqual(["t", "src", "dst", "proto", "dport", "in_if", "out_if", "n"]);
    expect(await columns("runs")).toContain("steps_json");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL, `expected [] to deeply equal [ 'res', ... ]` (the tables do not exist).

- [ ] **Step 3: Write the migration**

Create `worker/migrations/0012_history.sql`:

```sql
-- 0012_history.sql
--
-- Plain English: the dashboard's own history, like an SNMP poller's
-- database. Every heartbeat (about every 30 seconds while the VM runs) adds
-- to a one-minute sample for the VM and one per client. The watchman fills
-- in the minutes when no heartbeat came, folds samples older than 48 hours
-- into 5-minute summaries, and deletes anything older than 30 days.
-- Firewall drops are kept as one row per minute per distinct flow, with a
-- count. Runs keep their GitHub step list (steps_json).

CREATE TABLE IF NOT EXISTS hist_vm (
  res          INTEGER NOT NULL,  -- seconds per row: 60 (raw) or 300 (5-minute summary)
  t            TEXT    NOT NULL,  -- start of the slot, "YYYY-MM-DDTHH:MM:SSZ" (UTC)
  expected     INTEGER NOT NULL,  -- minutes the VM was meant to be up in this slot
  received     INTEGER NOT NULL,  -- of those, minutes with at least one heartbeat
  load1        REAL,              -- 1-minute load average
  rx_rate      REAL,              -- bytes per second into the VM from clients
  tx_rate      REAL,              -- bytes per second from the VM to clients
  rx_rate_max  REAL,
  tx_rate_max  REAL,
  peers_online INTEGER,
  dns_up       INTEGER,           -- 1 up, 0 down, NULL not reported
  PRIMARY KEY (res, t)
);

CREATE TABLE IF NOT EXISTS hist_client (
  res           INTEGER NOT NULL,
  t             TEXT    NOT NULL,
  peer_id       INTEGER NOT NULL,  -- peers.id: stays the same when a client is re-keyed
  online        INTEGER NOT NULL,  -- 1 if its last handshake was under 3 minutes old
  handshake_age INTEGER,           -- seconds since its last handshake; NULL = never
  latency_avg   REAL,              -- ms; NULL = no ping answered
  latency_max   REAL,
  rx            INTEGER NOT NULL,  -- bytes the VM received from it in this slot
  tx            INTEGER NOT NULL,  -- bytes the VM sent to it in this slot
  PRIMARY KEY (res, peer_id, t)
);

CREATE TABLE IF NOT EXISTS hist_drops (
  t      TEXT    NOT NULL,           -- the minute, as above
  src    TEXT    NOT NULL,
  dst    TEXT    NOT NULL,
  proto  TEXT    NOT NULL,
  dport  INTEGER NOT NULL DEFAULT 0, -- 0 = no port (ICMP and the like)
  in_if  TEXT    NOT NULL DEFAULT '',
  out_if TEXT    NOT NULL DEFAULT '',
  n      INTEGER NOT NULL,           -- drops of this flow in this minute
  PRIMARY KEY (t, src, dst, proto, dport, in_if, out_if)
);

ALTER TABLE runs ADD COLUMN steps_json TEXT;
```

In `worker/src/db.ts`, add one line to the `Run` interface after `ssh_password: string | null;`:

```ts
  steps_json: string | null; // the GitHub step list as last seen while the run was active
```

- [ ] **Step 4: Run the test to see it pass, then the whole suite**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0012_history.sql worker/src/db.ts worker/test/history.test.ts
git commit -m "History store: tables and run step column

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 2: Pure sample builders

**Files:**
- Create: `worker/src/history.ts`
- Test: `worker/test/history.test.ts`

**Interfaces:**
- Consumes: `AgentReport`, `Traffic`, `peerOnline` from `worker/src/state.ts` (`peerOnline(p: AgentPeer, now = Date.now()): boolean`, true when the handshake is under 180 s old).
- Produces (used by Tasks 3-5):
  - constants `RAW_RES = 60`, `SUMMARY_RES = 300`, `RAW_KEEP_MS`, `SUMMARY_KEEP_MS`, `BOOT_GRACE_MS`, `LATE_GRACE_MS`, `LOOKBACK_MS`
  - `bucket(ms: number, res: number): string`
  - `interface VmSample { load1: number | null; rx_rate: number; tx_rate: number; peers_online: number; dns_up: 0 | 1 | null }`
  - `vmSample(report: AgentReport, traffic: Traffic): VmSample`
  - `interface ClientSample { peer_id: number; online: 0 | 1; handshake_age: number | null; latency: number | null; rx: number; tx: number }`
  - `clientSamples(o: { report: AgentReport; prev: AgentReport | null; rtt: Record<string, number> | null | undefined; peers: { id: number; public_key: string }[]; nowMs: number }): ClientSample[]`

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/history.test.ts` (add `import { bucket, vmSample, clientSamples } from "../src/history";` and `import type { AgentReport, Traffic } from "../src/state";` to the imports at the top):

```ts
const PHONE = "P".repeat(43) + "=";
const LAPTOP = "L".repeat(43) + "=";
const T0 = Date.parse("2026-10-02T10:00:00Z");

function report(at: number, peers: { key: string; hs: number; rx: number; tx: number }[], extra: Partial<AgentReport> = {}): AgentReport {
  return {
    at: new Date(at).toISOString(),
    hostname: "vm-wg",
    uptime_seconds: 100,
    load: "0.12 0.10 0.05",
    listen_port: 51820,
    server_public_key: "S=",
    loopback: null,
    wan6: null,
    dns: { up: true, blocked: 10 },
    peers: peers.map((p) => ({ public_key: p.key, endpoint: null, allowed_ips: "10.13.13.2/32", latest_handshake: p.hs, rx: p.rx, tx: p.tx })),
    ...extra,
  } as AgentReport;
}
const traffic = (rx_rate: number, tx_rate: number, peers_online: number): Traffic => ({ at: new Date(T0).toISOString(), rx: 0, tx: 0, rx_rate, tx_rate, peers_online });

describe("bucket", () => {
  it("floors to the slot start, with no milliseconds", () => {
    expect(bucket(Date.parse("2026-10-02T10:03:47.123Z"), 60)).toBe("2026-10-02T10:03:00Z");
    expect(bucket(Date.parse("2026-10-02T10:03:47.123Z"), 300)).toBe("2026-10-02T10:00:00Z");
    expect(bucket(Date.parse("2026-10-02T10:05:00.000Z"), 300)).toBe("2026-10-02T10:05:00Z");
  });
});

describe("vmSample", () => {
  it("takes the 1-minute load, the rates and DNS", () => {
    expect(vmSample(report(T0, []), traffic(100, 200, 2))).toEqual({ load1: 0.12, rx_rate: 100, tx_rate: 200, peers_online: 2, dns_up: 1 });
  });
  it("leaves load and DNS empty when the VM did not report them", () => {
    expect(vmSample(report(T0, [], { load: "", dns: null }), traffic(0, 0, 0))).toEqual({ load1: null, rx_rate: 0, tx_rate: 0, peers_online: 0, dns_up: null });
  });
});

describe("clientSamples", () => {
  const peers = [{ id: 7, public_key: PHONE }, { id: 9, public_key: LAPTOP }];
  const now = T0 + 60_000;
  const s = now / 1000;

  it("counts bytes since the previous heartbeat", () => {
    const prev = report(T0, [{ key: PHONE, hs: s - 30, rx: 1000, tx: 5000 }]);
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 1500, tx: 9000 }]);
    expect(clientSamples({ report: cur, prev, rtt: { [PHONE]: 23.456 }, peers, nowMs: now })).toEqual([{ peer_id: 7, online: 1, handshake_age: 10, latency: 23.5, rx: 500, tx: 4000 }]);
  });

  it("counts from zero when the counters went down (VM rebooted or rebuilt)", () => {
    const prev = report(T0, [{ key: PHONE, hs: s - 30, rx: 9_000_000, tx: 9_000_000 }]);
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 300, tx: 400 }]);
    expect(clientSamples({ report: cur, prev, rtt: null, peers, nowMs: now })[0]).toMatchObject({ rx: 300, tx: 400 });
  });

  it("counts the whole counter on the first heartbeat of a session", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 300, tx: 400 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })[0]).toMatchObject({ rx: 300, tx: 400 });
  });

  it("is online under 3 minutes since the handshake, offline from 3 minutes", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 179, rx: 0, tx: 0 }, { key: LAPTOP, hs: s - 181, rx: 0, tx: 0 }]);
    const out = clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now });
    expect(out.map((c) => [c.peer_id, c.online, c.handshake_age])).toEqual([[7, 1, 179], [9, 0, 181]]);
  });

  it("has no handshake age, and is offline, when the client never connected", () => {
    const cur = report(now, [{ key: PHONE, hs: 0, rx: 0, tx: 0 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })[0]).toMatchObject({ online: 0, handshake_age: null, latency: null });
  });

  it("skips keys that are not a known client", () => {
    const cur = report(now, [{ key: "U".repeat(43) + "=", hs: s - 10, rx: 1, tx: 1 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: null, peers, nowMs: now })).toEqual([]);
  });

  it("ignores a latency that is not a finite number", () => {
    const cur = report(now, [{ key: PHONE, hs: s - 10, rx: 0, tx: 0 }]);
    expect(clientSamples({ report: cur, prev: null, rtt: { [PHONE]: Number.NaN }, peers, nowMs: now })[0].latency).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL, `Failed to resolve import "../src/history"`.

- [ ] **Step 3: Write the module**

Create `worker/src/history.ts`:

```ts
// history.ts
//
// Plain English: the dashboard's own history, like an SNMP poller keeping
// readings instead of only showing the current one. Every VM heartbeat
// adds to a one-minute sample for the VM and one per client (history in
// D1, tables in migrations/0012_history.sql). The watchman fills in the
// minutes when no heartbeat came, so availability is honest, and folds
// samples older than 48 hours into 5-minute summaries kept for 30 days.
// Nothing is recorded while the VM is destroyed or in Standby.

import type { AgentReport, Traffic } from "./state";
import { peerOnline } from "./state";

/** Seconds per raw sample. A minute, not 30 s: heartbeats drift, and a 30 s
 *  slot could miss one and read as downtime while the VM was fine. */
export const RAW_RES = 60;
/** Seconds per summary row. */
export const SUMMARY_RES = 300;
/** Raw samples are folded into summaries after 48 hours. */
export const RAW_KEEP_MS = 48 * 3600_000;
/** Summaries and drops are deleted after 30 days. */
export const SUMMARY_KEEP_MS = 30 * 86_400_000;
/** No minute counts as missed until 3 minutes after the VM came up (boot and self-test). */
export const BOOT_GRACE_MS = 3 * 60_000;
/** The last 2 minutes are left alone: a heartbeat may be on its way. */
export const LATE_GRACE_MS = 2 * 60_000;
/** How far back the watchman looks for missed minutes (it runs every 5). */
export const LOOKBACK_MS = 15 * 60_000;

/** The start of the slot holding `ms`, as "YYYY-MM-DDTHH:MM:SSZ". */
export function bucket(ms: number, res: number): string {
  const start = Math.floor(ms / (res * 1000)) * res * 1000;
  return new Date(start).toISOString().replace(".000Z", "Z");
}

export interface VmSample {
  load1: number | null;
  rx_rate: number;
  tx_rate: number;
  peers_online: number;
  dns_up: 0 | 1 | null;
}

/** One heartbeat's VM reading: load, traffic rate, clients online, tunnel DNS. */
export function vmSample(report: AgentReport, traffic: Traffic): VmSample {
  const load = Number.parseFloat((report.load ?? "").split(" ")[0]);
  return {
    load1: Number.isFinite(load) ? load : null,
    rx_rate: traffic.rx_rate,
    tx_rate: traffic.tx_rate,
    peers_online: traffic.peers_online,
    dns_up: report.dns ? (report.dns.up ? 1 : 0) : null,
  };
}

export interface ClientSample {
  peer_id: number;
  online: 0 | 1;
  handshake_age: number | null;
  latency: number | null;
  rx: number;
  tx: number;
}

/**
 * One heartbeat's reading for each known client. Bytes are what moved since
 * the previous heartbeat; a counter that went down (the VM rebooted or was
 * rebuilt) counts from zero, and the first heartbeat of a session counts
 * the whole counter. Keys that are not a client in the table are skipped.
 */
export function clientSamples(o: {
  report: AgentReport;
  prev: AgentReport | null;
  rtt: Record<string, number> | null | undefined;
  peers: { id: number; public_key: string }[];
  nowMs: number;
}): ClientSample[] {
  const ids = new Map(o.peers.map((p) => [p.public_key, p.id]));
  const before = new Map((o.prev?.peers ?? []).map((p) => [p.public_key, p]));
  const delta = (now: number, prev: number | undefined) => (prev !== undefined && now >= prev ? now - prev : now);
  const out: ClientSample[] = [];
  for (const p of o.report.peers) {
    const id = ids.get(p.public_key);
    if (id === undefined) continue;
    const was = before.get(p.public_key);
    const ms = o.rtt?.[p.public_key];
    out.push({
      peer_id: id,
      online: peerOnline(p, o.nowMs) ? 1 : 0,
      handshake_age: p.latest_handshake > 0 ? Math.max(0, Math.round(o.nowMs / 1000 - p.latest_handshake)) : null,
      latency: typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null,
      rx: delta(p.rx, was?.rx),
      tx: delta(p.tx, was?.tx),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/history.ts worker/test/history.test.ts
git commit -m "History store: sample builders for the VM and each client

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 3: Writing a heartbeat's samples

**Files:**
- Modify: `worker/src/runs.ts:222-245` (extract `freshDrops` out of `nextFirewall`)
- Modify: `worker/src/history.ts` (add `recordHeartbeat`)
- Test: `worker/test/history.test.ts`

**Interfaces:**
- Consumes: Task 2's `bucket`, `RAW_RES`, `vmSample`, `clientSamples`; `listPeers(env): Promise<Peer[]>` from `worker/src/db.ts`; `FirewallStatus` from `worker/src/state.ts`.
- Produces:
  - `freshDrops(rep: { drops?: unknown[] } | null | undefined, at: string): FirewallStatus["drops"]` exported from `worker/src/runs.ts`
  - `recordHeartbeat(env: Env, o: { report: AgentReport; prev: AgentReport | null; rtt: Record<string, number> | null | undefined; traffic: Traffic; drops: FirewallStatus["drops"] }): Promise<void>` exported from `worker/src/history.ts`

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/history.test.ts` (add `recordHeartbeat` to the `../src/history` import and `import { freshDrops } from "../src/runs";`):

```ts
async function addPeer(id: number, key: string) {
  await env.DB.prepare("INSERT INTO peers (id, name, public_key, ip, enabled, full_tunnel, created_at) VALUES (?1, ?2, ?3, ?4, 1, 0, 'x')")
    .bind(id, `client${id}`, key, `10.13.13.${id}`)
    .run();
}
const rows = async (sql: string) => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;

describe("freshDrops", () => {
  it("stamps each reported drop with the heartbeat time, newest first", () => {
    const at = "2026-10-02T10:00:30.000Z";
    const out = freshDrops({ drops: [{ src: "10.13.13.2", dst: "10.50.2.4", proto: "TCP", dport: 22, in: "wg0", out: "eth0" }, { src: "10.13.13.3", dst: "10.50.2.4", proto: "ICMP" }] }, at);
    expect(out).toEqual([
      { at, src: "10.13.13.3", dst: "10.50.2.4", proto: "ICMP", dport: null, in: "", out: "" },
      { at, src: "10.13.13.2", dst: "10.50.2.4", proto: "TCP", dport: 22, in: "wg0", out: "eth0" },
    ]);
    expect(freshDrops(null, at)).toEqual([]);
    expect(freshDrops({ drops: [null, 5, "x"] as unknown[] }, at)).toEqual([]);
  });
});

describe("recordHeartbeat", () => {
  beforeEach(async () => {
    await addPeer(7, PHONE);
  });

  it("writes one VM row and one row per client for the minute", async () => {
    const s = (T0 + 30_000) / 1000;
    await recordHeartbeat(env, { report: report(T0 + 30_000, [{ key: PHONE, hs: s - 5, rx: 100, tx: 200 }]), prev: null, rtt: { [PHONE]: 20 }, traffic: traffic(10, 20, 1), drops: [] });
    expect(await rows("SELECT res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up FROM hist_vm")).toEqual([
      { res: 60, t: "2026-10-02T10:00:00Z", expected: 1, received: 1, load1: 0.12, rx_rate: 10, tx_rate: 20, rx_rate_max: 10, tx_rate_max: 20, peers_online: 1, dns_up: 1 },
    ]);
    expect(await rows("SELECT res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx FROM hist_client")).toEqual([
      { res: 60, t: "2026-10-02T10:00:00Z", peer_id: 7, online: 1, handshake_age: 5, latency_avg: 20, latency_max: 20, rx: 100, tx: 200 },
    ]);
  });

  it("merges two heartbeats in the same minute: received stays 1, bytes add, maxima kept", async () => {
    const s1 = (T0 + 5_000) / 1000;
    const s2 = (T0 + 35_000) / 1000;
    const first = report(T0 + 5_000, [{ key: PHONE, hs: s1 - 5, rx: 100, tx: 100 }]);
    await recordHeartbeat(env, { report: first, prev: null, rtt: { [PHONE]: 20 }, traffic: traffic(50, 10, 1), drops: [] });
    await recordHeartbeat(env, { report: report(T0 + 35_000, [{ key: PHONE, hs: s2 - 5, rx: 400, tx: 150 }]), prev: first, rtt: { [PHONE]: 40 }, traffic: traffic(20, 30, 1), drops: [] });
    const [vm] = await rows("SELECT received, rx_rate, rx_rate_max, tx_rate_max FROM hist_vm");
    expect(vm).toEqual({ received: 1, rx_rate: 20, rx_rate_max: 50, tx_rate_max: 30 });
    const [c] = await rows("SELECT rx, tx, latency_avg, latency_max FROM hist_client");
    expect(c).toEqual({ rx: 400, tx: 150, latency_avg: 30, latency_max: 40 });
  });

  it("counts drops per minute per flow, with no port stored as 0", async () => {
    const at = new Date(T0 + 10_000).toISOString();
    const drop = { at, src: "10.13.13.2", dst: "10.50.2.4", proto: "ICMP", dport: null, in: "wg0", out: "eth0" };
    await recordHeartbeat(env, { report: report(T0 + 10_000, []), prev: null, rtt: null, traffic: traffic(0, 0, 0), drops: [drop, drop] });
    await recordHeartbeat(env, { report: report(T0 + 40_000, []), prev: null, rtt: null, traffic: traffic(0, 0, 0), drops: [{ ...drop, at: new Date(T0 + 40_000).toISOString() }] });
    expect(await rows("SELECT t, src, dst, proto, dport, in_if, out_if, n FROM hist_drops")).toEqual([
      { t: "2026-10-02T10:00:00Z", src: "10.13.13.2", dst: "10.50.2.4", proto: "ICMP", dport: 0, in_if: "wg0", out_if: "eth0", n: 3 },
    ]);
  });

  it("fills in a minute the watchman had marked as missed", async () => {
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, '2026-10-02T10:00:00Z', 1, 0)").run();
    await recordHeartbeat(env, { report: report(T0 + 20_000, []), prev: null, rtt: null, traffic: traffic(5, 6, 0), drops: [] });
    expect(await rows("SELECT received, rx_rate, rx_rate_max FROM hist_vm")).toEqual([{ received: 1, rx_rate: 5, rx_rate_max: 5 }]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL, `freshDrops is not a function` / `recordHeartbeat is not exported`.

- [ ] **Step 3a: Extract `freshDrops` in `worker/src/runs.ts`**

Insert this function directly above `nextFirewall` (line 222):

```ts
/** The drops in one heartbeat's firewall report, newest first, stamped with the heartbeat's time. */
export function freshDrops(rep: { drops?: unknown[] } | null | undefined, at: string): FirewallStatus["drops"] {
  const drops = rep?.drops;
  return (Array.isArray(drops) ? drops : [])
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d) => ({ at, src: String(d.src ?? ""), dst: String(d.dst ?? ""), proto: String(d.proto ?? ""), dport: typeof d.dport === "number" ? d.dport : null, in: String(d.in ?? ""), out: String(d.out ?? "") }))
    .reverse();
}
```

In `nextFirewall`, replace the four lines that build `fresh` (from `const fresh = (Array.isArray(rep.drops) ? rep.drops : [])` through `.reverse();`) with:

```ts
  const fresh = freshDrops(rep, at);
```

- [ ] **Step 3b: Add `recordHeartbeat` to `worker/src/history.ts`**

Add to the imports at the top:

```ts
import type { Env } from "./env";
import type { FirewallStatus } from "./state";
import { listPeers } from "./db";
```

Append:

```ts
/**
 * Add one heartbeat to this minute's samples: the VM, each known client,
 * and the firewall drops it reported. One transaction. A second heartbeat
 * in the same minute keeps "received" at 1, adds the bytes, keeps the
 * latest rate and the highest rate and latency seen.
 */
export async function recordHeartbeat(
  env: Env,
  o: { report: AgentReport; prev: AgentReport | null; rtt: Record<string, number> | null | undefined; traffic: Traffic; drops: FirewallStatus["drops"] },
): Promise<void> {
  const nowMs = Date.parse(o.report.at);
  const t = bucket(nowMs, RAW_RES);
  const vm = vmSample(o.report, o.traffic);
  const clients = clientSamples({ report: o.report, prev: o.prev, rtt: o.rtt, peers: await listPeers(env), nowMs });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up)
       VALUES (?1, ?2, 1, 1, ?3, ?4, ?5, ?4, ?5, ?6, ?7)
       ON CONFLICT (res, t) DO UPDATE SET
         received = 1, load1 = excluded.load1, rx_rate = excluded.rx_rate, tx_rate = excluded.tx_rate,
         rx_rate_max = MAX(COALESCE(rx_rate_max, 0), excluded.rx_rate_max),
         tx_rate_max = MAX(COALESCE(tx_rate_max, 0), excluded.tx_rate_max),
         peers_online = excluded.peers_online, dns_up = excluded.dns_up`,
    ).bind(RAW_RES, t, vm.load1, vm.rx_rate, vm.tx_rate, vm.peers_online, vm.dns_up),
    ...clients.map((c) =>
      env.DB.prepare(
        `INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
         ON CONFLICT (res, peer_id, t) DO UPDATE SET
           online = MAX(online, excluded.online), handshake_age = excluded.handshake_age,
           latency_avg = COALESCE((latency_avg + excluded.latency_avg) / 2, excluded.latency_avg, latency_avg),
           latency_max = MAX(COALESCE(latency_max, excluded.latency_max), COALESCE(excluded.latency_max, latency_max)),
           rx = rx + excluded.rx, tx = tx + excluded.tx`,
      ).bind(RAW_RES, t, c.peer_id, c.online, c.handshake_age, c.latency, c.rx, c.tx),
    ),
    ...o.drops.map((d) =>
      env.DB.prepare(
        `INSERT INTO hist_drops (t, src, dst, proto, dport, in_if, out_if, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
         ON CONFLICT (t, src, dst, proto, dport, in_if, out_if) DO UPDATE SET n = n + 1`,
      ).bind(bucket(Date.parse(d.at), RAW_RES), d.src, d.dst, d.proto, d.dport ?? 0, d.in, d.out),
    ),
  ]);
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass (the existing firewall tests prove `nextFirewall` still behaves the same).

- [ ] **Step 5: Commit**

```bash
git add worker/src/runs.ts worker/src/history.ts worker/test/history.test.ts
git commit -m "History store: record each heartbeat's VM, client and drop samples

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 4: Record from the heartbeat, never failing it

**Files:**
- Modify: `worker/src/runs.ts` (`handleAgent`, around lines 706-725: after `patch.firewall = ...`, before `await saveSnapshot(env, patch)`)
- Test: `worker/test/history.test.ts`

**Interfaces:**
- Consumes: Task 3's `recordHeartbeat`, `freshDrops`.
- Produces: nothing new; heartbeats now write history.

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/history.test.ts` (add to the imports: `import { lastGhRun } from "./harness";`, `import * as db from "../src/db";`, `import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";`, `import { getSnapshot, saveSnapshot } from "../src/state";`):

```ts
const DUMP = (lines: string[]) => ["PRIV\tS=\t51820\toff", ...lines].join("\n");
const peerLine = (key: string, hsSecs: number, rx: number, tx: number) => `${key}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${hsSecs}\t${rx}\t${tx}\t0`;

/** Deploy on the harness and return the VM's agent token. */
async function toRunning() {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("heartbeats write history", () => {
  it("records the VM and the client, by client id", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const token = await toRunning();
    const phone = (await db.listPeers(env)).find((p) => p.public_key === PHONE)!;
    vi.setSystemTime(T0 + 15_000);
    const r = await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor((T0 + 10_000) / 1000), 1000, 2000)]), rtt: { [PHONE]: 18 } });
    expect(r.status).toBe(200);
    expect(await rows("SELECT res, t, received FROM hist_vm")).toEqual([{ res: 60, t: "2026-10-02T10:00:00Z", received: 1 }]);
    expect(await rows("SELECT peer_id, online, latency_avg, rx, tx FROM hist_client")).toEqual([{ peer_id: phone.id, online: 1, latency_avg: 18, rx: 1000, tx: 2000 }]);
  });

  it("records nothing for a heartbeat that arrives after a tear-down", async () => {
    const token = await toRunning();
    await saveSnapshot(env, { state: "destroyed" });
    await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor(Date.now() / 1000), 1, 1)]) });
    expect(await rows("SELECT * FROM hist_vm")).toEqual([]);
    expect(await rows("SELECT * FROM hist_client")).toEqual([]);
  });

  it("still answers the heartbeat and updates the snapshot when history cannot be written", async () => {
    const token = await toRunning();
    await env.DB.prepare("DROP TABLE hist_client").run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await handleAgent(env, token, { dump: DUMP([peerLine(PHONE, Math.floor(Date.now() / 1000), 1, 1)]) });
    expect(r.status).toBe(200);
    expect((r.body as { peers: unknown[] }).peers.length).toBe(1);
    expect((await getSnapshot(env)).last_agent_at).not.toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith("history:"))).toBe(true);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL in "records the VM and the client" (no rows) and "still answers" (no `history:` log).

- [ ] **Step 3: Call the recorder from `handleAgent`**

In `worker/src/runs.ts`, add to the imports: `import { recordHeartbeat } from "./history";`

In `handleAgent`, directly after the line `patch.firewall = nextFirewall(cur.firewall, body.firewall, report.at);`, insert:

```ts
  // History (history.ts): this heartbeat's VM, client and drop samples.
  // A history problem must never cost the VM its heartbeat.
  try {
    await recordHeartbeat(env, { report, prev: cur.agent, rtt: body.rtt, traffic, drops: freshDrops(body.firewall, report.at) });
  } catch (e) {
    console.error("history:", e);
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass.

- [ ] **Step 5: Commit**

```bash
git add worker/src/runs.ts worker/test/history.test.ts
git commit -m "History store: record every heartbeat, guarded so it can never fail one

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 5: Missed minutes, summaries and expiry in the watchman

**Files:**
- Modify: `worker/src/history.ts` (add `recordMissedHeartbeats`, `rollUp`)
- Modify: `worker/src/monitor.ts` (call both in `runScheduled`, after the change-log housekeeping block that ends near line 80)
- Test: `worker/test/history.test.ts`

**Interfaces:**
- Consumes: Task 2's constants and `bucket`; `Snapshot` and `getSnapshot` from `worker/src/state.ts`.
- Produces:
  - `recordMissedHeartbeats(env: Env, snap: Snapshot, now: Date): Promise<number>` (rows added)
  - `rollUp(env: Env, now: Date): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `worker/test/history.test.ts` (add `recordMissedHeartbeats, rollUp` to the `../src/history` import, `import { runScheduled } from "../src/monitor";`, and `import type { Snapshot } from "../src/state";`):

```ts
const running = (since: number) => ({ state: "running", running_since: new Date(since).toISOString() }) as Snapshot;

describe("recordMissedHeartbeats", () => {
  it("marks fully elapsed minutes with no heartbeat, after the boot grace and before the late grace", async () => {
    // Up at 10:00. Heartbeats arrived in 10:04 and 10:06. The watchman runs at 10:10:30.
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, '2026-10-02T10:04:00Z', 1, 1), (60, '2026-10-02T10:06:00Z', 1, 1)").run();
    const added = await recordMissedHeartbeats(env, running(T0), new Date(T0 + 10 * 60_000 + 30_000));
    // Counted from 10:03 (boot grace), up to the minute that ended by 10:08:30 (late grace): 10:03, 10:05, 10:07.
    expect(added).toBe(3);
    expect(await rows("SELECT t, received FROM hist_vm ORDER BY t")).toEqual([
      { t: "2026-10-02T10:03:00Z", received: 0 },
      { t: "2026-10-02T10:04:00Z", received: 1 },
      { t: "2026-10-02T10:05:00Z", received: 0 },
      { t: "2026-10-02T10:06:00Z", received: 1 },
      { t: "2026-10-02T10:07:00Z", received: 0 },
    ]);
  });

  it("only looks back 15 minutes", async () => {
    await recordMissedHeartbeats(env, running(T0), new Date(T0 + 60 * 60_000));
    const [{ first }] = await rows("SELECT MIN(t) AS first FROM hist_vm");
    expect(first).toBe("2026-10-02T10:45:00Z");
  });

  it("records nothing while the VM is not meant to be up", async () => {
    for (const state of ["destroyed", "standby", "deploying", "hibernating", "resuming", "failed"]) {
      expect(await recordMissedHeartbeats(env, { ...running(T0), state } as Snapshot, new Date(T0 + 30 * 60_000))).toBe(0);
    }
    expect(await recordMissedHeartbeats(env, { state: "running", running_since: null } as Snapshot, new Date(T0 + 30 * 60_000))).toBe(0);
    expect(await rows("SELECT * FROM hist_vm")).toEqual([]);
  });
});

describe("rollUp", () => {
  const NOW = new Date(Date.parse("2026-10-05T12:00:00Z"));
  const OLD = Date.parse("2026-10-03T11:50:00Z"); // 48 h 10 min before NOW

  it("folds raw samples older than 48 hours into 5-minute summaries and deletes them", async () => {
    for (let i = 0; i < 10; i++) {
      const t = bucket(OLD + i * 60_000, 60);
      await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up) VALUES (60, ?1, 1, ?2, 0.5, ?3, 10, ?3, 10, ?4, ?5)")
        .bind(t, i === 3 ? 0 : 1, i * 10, i < 5 ? 1 : 2, i === 7 ? 0 : 1)
        .run();
      await env.DB.prepare("INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx) VALUES (60, ?1, 7, ?2, ?3, ?4, ?5, 100, 50)")
        .bind(t, i === 9 ? 1 : 0, 600 - i, 20 + i, 30 + i)
        .run();
    }
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (60, '2026-10-05T11:00:00Z', 1, 1)").run(); // recent: kept raw
    await rollUp(env, NOW);
    expect(await rows("SELECT res, t, expected, received, rx_rate, rx_rate_max, peers_online, dns_up FROM hist_vm ORDER BY res, t")).toEqual([
      { res: 60, t: "2026-10-05T11:00:00Z", expected: 1, received: 1, rx_rate: null, rx_rate_max: null, peers_online: null, dns_up: null },
      { res: 300, t: "2026-10-03T11:50:00Z", expected: 5, received: 4, rx_rate: 20, rx_rate_max: 40, peers_online: 1, dns_up: 1 },
      { res: 300, t: "2026-10-03T11:55:00Z", expected: 5, received: 5, rx_rate: 70, rx_rate_max: 90, peers_online: 2, dns_up: 0 },
    ]);
    expect(await rows("SELECT res, t, online, handshake_age, latency_avg, latency_max, rx, tx FROM hist_client ORDER BY t")).toEqual([
      { res: 300, t: "2026-10-03T11:50:00Z", online: 0, handshake_age: 596, latency_avg: 22, latency_max: 34, rx: 500, tx: 250 },
      { res: 300, t: "2026-10-03T11:55:00Z", online: 1, handshake_age: 591, latency_avg: 27, latency_max: 39, rx: 500, tx: 250 },
    ]);
  });

  it("deletes summaries and drops older than 30 days", async () => {
    await env.DB.prepare("INSERT INTO hist_vm (res, t, expected, received) VALUES (300, '2026-09-04T11:55:00Z', 5, 5), (300, '2026-09-06T00:00:00Z', 5, 5)").run();
    await env.DB.prepare("INSERT INTO hist_drops (t, src, dst, proto, n) VALUES ('2026-09-04T11:55:00Z', 'a', 'b', 'TCP', 1), ('2026-09-06T00:00:00Z', 'a', 'b', 'TCP', 1)").run();
    await rollUp(env, NOW);
    expect(await rows("SELECT t FROM hist_vm")).toEqual([{ t: "2026-09-06T00:00:00Z" }]);
    expect(await rows("SELECT t FROM hist_drops")).toEqual([{ t: "2026-09-06T00:00:00Z" }]);
  });
});

describe("watchman", () => {
  it("fills in missed minutes while running", async () => {
    await toRunning();
    const snap = await getSnapshot(env);
    const since = Date.parse(snap.running_since!);
    await runScheduled(env, new Date(since + 10 * 60_000));
    const [{ n }] = await rows("SELECT COUNT(*) AS n FROM hist_vm WHERE received = 0");
    expect(Number(n)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL, `recordMissedHeartbeats is not exported` (and the watchman test finds no rows).

- [ ] **Step 3a: Add the two functions to `worker/src/history.ts`**

Add `Snapshot` to the type import from `./state`. Append:

```ts
/**
 * The watchman's half of availability: every fully elapsed minute in the
 * last 15 with no heartbeat, while the VM is meant to be up, gets a row
 * saying so. The first 3 minutes after it came up (boot, self-test) and the
 * last 2 (a heartbeat may be on its way) are left alone. A heartbeat that
 * arrives later still fills its minute in (recordHeartbeat).
 */
export async function recordMissedHeartbeats(env: Env, snap: Snapshot, now: Date): Promise<number> {
  if (snap.state !== "running" || !snap.running_since) return 0;
  const step = RAW_RES * 1000;
  const from = Math.ceil(Math.max(Date.parse(snap.running_since) + BOOT_GRACE_MS, now.getTime() - LOOKBACK_MS) / step) * step;
  const until = now.getTime() - LATE_GRACE_MS;
  const stmts: D1PreparedStatement[] = [];
  for (let ms = from; ms + step <= until; ms += step) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO hist_vm (res, t, expected, received) VALUES (?1, ?2, 1, 0)").bind(RAW_RES, bucket(ms, RAW_RES)));
  }
  if (!stmts.length) return 0;
  const results = await env.DB.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
}

/** The 5-minute slot of a stored time, in SQL. */
const SUMMARY_SLOT = `strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', t) AS INTEGER) / ${SUMMARY_RES}) * ${SUMMARY_RES}, 'unixepoch')`;

/**
 * Housekeeping, every 5 minutes: raw samples older than 48 hours become
 * 5-minute summaries (counts and bytes summed, rates and latency averaged,
 * the peaks kept, DNS down if it was down at any point, a client online if
 * it was online at any point), then are deleted. Summaries and drops older
 * than 30 days are deleted. One transaction.
 */
export async function rollUp(env: Env, now: Date): Promise<void> {
  const cutoff = bucket(now.getTime() - RAW_KEEP_MS, SUMMARY_RES);
  const expiry = bucket(now.getTime() - SUMMARY_KEEP_MS, SUMMARY_RES);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hist_vm (res, t, expected, received, load1, rx_rate, tx_rate, rx_rate_max, tx_rate_max, peers_online, dns_up)
       SELECT ${SUMMARY_RES}, ${SUMMARY_SLOT} AS slot, SUM(expected), SUM(received), AVG(load1), AVG(rx_rate), AVG(tx_rate),
              MAX(rx_rate_max), MAX(tx_rate_max), MAX(peers_online), MIN(dns_up)
       FROM hist_vm WHERE res = ${RAW_RES} AND t < ?1 GROUP BY slot
       ON CONFLICT (res, t) DO UPDATE SET expected = expected + excluded.expected, received = received + excluded.received`,
    ).bind(cutoff),
    env.DB.prepare(
      `INSERT INTO hist_client (res, t, peer_id, online, handshake_age, latency_avg, latency_max, rx, tx)
       SELECT ${SUMMARY_RES}, ${SUMMARY_SLOT} AS slot, peer_id, MAX(online), MIN(handshake_age), AVG(latency_avg), MAX(latency_max), SUM(rx), SUM(tx)
       FROM hist_client WHERE res = ${RAW_RES} AND t < ?1 GROUP BY peer_id, slot
       ON CONFLICT (res, peer_id, t) DO UPDATE SET rx = rx + excluded.rx, tx = tx + excluded.tx`,
    ).bind(cutoff),
    env.DB.prepare(`DELETE FROM hist_vm WHERE res = ${RAW_RES} AND t < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM hist_client WHERE res = ${RAW_RES} AND t < ?1`).bind(cutoff),
    env.DB.prepare("DELETE FROM hist_vm WHERE t < ?1").bind(expiry),
    env.DB.prepare("DELETE FROM hist_client WHERE t < ?1").bind(expiry),
    env.DB.prepare("DELETE FROM hist_drops WHERE t < ?1").bind(expiry),
  ]);
}
```

- [ ] **Step 3b: Call them from the watchman**

In `worker/src/monitor.ts`, add `import { recordMissedHeartbeats, rollUp } from "./history";` and insert directly after the change-log housekeeping `try { await db.pruneAudit(env, now); } catch ...` block:

```ts
  // History: mark the minutes with no heartbeat while running, then fold
  // samples older than 48 hours into summaries and drop the 30-day-old ones.
  try {
    await recordMissedHeartbeats(env, await getSnapshot(env), now);
    await rollUp(env, now);
  } catch (e) {
    notes.push(`history: ${(e as Error).message}`);
  }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass (`watchman.test.ts` proves the watchman still behaves).

- [ ] **Step 5: Commit**

```bash
git add worker/src/history.ts worker/src/monitor.ts worker/test/history.test.ts
git commit -m "History store: watchman marks missed minutes, summarises and expires

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 6: Keep each run's steps, with times

**Files:**
- Modify: `worker/src/github.ts:86-92` (`GhJob` step fields) and `:120-126` (`stepsFromJobs`)
- Modify: `worker/src/state.ts:177-181` (`Step`)
- Modify: `worker/src/runs.ts` (`refreshActiveRun`, after `const steps = stepsFromJobs(jobs);`)
- Modify: `worker/test/harness.ts` (GitHub jobs answer)
- Test: `worker/test/history.test.ts`

**Interfaces:**
- Consumes: `db.updateRun(env, id, patch: Partial<Run>)`, Task 1's `steps_json`.
- Produces: `Step` gains `started_at?: string | null; completed_at?: string | null`; `World.jobs: Map<number, GhJob[]>` in the harness; `runs.steps_json` is the JSON of `Step[]`.

- [ ] **Step 1: Write the failing test**

Append to `worker/test/history.test.ts` (add `refreshActiveRun` to the `../src/runs` import):

```ts
describe("run steps", () => {
  it("are saved with their times on every GitHub poll during the run", async () => {
    await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
    const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    world.jobs.set(lastGhRun(world), [
      {
        id: 1, name: "terraform", status: "in_progress", conclusion: null,
        steps: [
          { name: "Set up job", status: "completed", conclusion: "success", started_at: "2026-10-02T10:00:00Z", completed_at: "2026-10-02T10:00:02Z" },
          { name: "Check out", status: "completed", conclusion: "success", started_at: "2026-10-02T10:00:02Z", completed_at: "2026-10-02T10:00:04Z" },
          { name: "terraform apply", status: "in_progress", conclusion: null, started_at: "2026-10-02T10:00:30Z", completed_at: null },
        ],
      },
    ]);
    await refreshActiveRun(env);
    const saved = await db.getRun(env, run.id);
    expect(JSON.parse(saved!.steps_json!)).toEqual([
      { name: "Check out", status: "completed", conclusion: "success", started_at: "2026-10-02T10:00:02Z", completed_at: "2026-10-02T10:00:04Z" },
      { name: "terraform apply", status: "in_progress", conclusion: null, started_at: "2026-10-02T10:00:30Z", completed_at: null },
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run worker/test/history.test.ts`
Expected: FAIL, TypeScript/runtime error `world.jobs is undefined`.

- [ ] **Step 3a: Let the harness answer with jobs**

In `worker/test/harness.ts`:
- add `import type { GhJob } from "../src/github";` to the imports;
- add to `interface World`, after `notes`:

```ts
  /** GitHub jobs per GitHub run id, for the step list. */
  jobs: Map<number, GhJob[]>;
```

- in `makeEnv`, add `jobs: new Map()` to the `world` object literal;
- replace the line `if (/\/actions\/runs\/\d+\/jobs$/.test(u.pathname)) return json({ jobs: [] });` with:

```ts
      const jobs = u.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
      if (jobs) return json({ jobs: world.jobs.get(Number(jobs[1])) ?? [] });
```

- [ ] **Step 3b: Carry step times and save the steps**

In `worker/src/github.ts`, change the `steps` field of `GhJob` to:

```ts
  steps: { name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null }[];
```

and the `.map` in `stepsFromJobs` to:

```ts
    .map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion, started_at: s.started_at ?? null, completed_at: s.completed_at ?? null }));
```

In `worker/src/state.ts`, add two optional fields to `Step` (optional, so snapshots saved before this change still read):

```ts
  started_at?: string | null;
  completed_at?: string | null;
```

In `worker/src/runs.ts` `refreshActiveRun`, directly after `const steps = stepsFromJobs(jobs);` insert:

```ts
  // Keep the step list with the run (runs.steps_json), so a finished run
  // still shows its steps after the snapshot moves on to the next one.
  if (steps.length) await db.updateRun(env, run.id, { steps_json: JSON.stringify(steps) });
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run worker/test/history.test.ts` → PASS.
Run: `npm test && npm run typecheck` → all pass. If an existing test compares a step list with `toEqual` and now fails only because of the two new `null` fields, update that expectation to include `started_at: null, completed_at: null`; no other behaviour may change.

- [ ] **Step 5: Commit**

```bash
git add worker/src/github.ts worker/src/state.ts worker/src/runs.ts worker/test/harness.ts worker/test/history.test.ts
git commit -m "History store: keep each run's GitHub steps with their times

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
```

---

### Task 7: Ship and verify on the live dashboard

**Files:** none changed (PR, deploy, checks). Possibly `worker/src/build.ts` (rewritten by the deploy script).

- [ ] **Step 1: Full local verification**

Run: `npm test && npm run typecheck`
Expected: all test files pass, typecheck clean. Record the counts for the PR.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/history-recorder
gh pr create --base main --title "History store: record VM, client and drop history" --body-file - <<'EOF'
Plan 1 of the dashboard redesign (docs/superpowers/plans/2026-10-02-redesign-plan-1-history-recorder.md).
Starts recording, with no visible change: one-minute VM and per-client samples from every heartbeat,
missed minutes marked by the watchman, 5-minute summaries after 48 hours, 30-day expiry, firewall
drops per minute per flow, and each run's GitHub steps with times. Also brings the redesign spec and
this plan onto main.

Tests: <paste counts from step 1>.

https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV
EOF
```

Wait for the two CI checks (`typecheck + tests`, `terraform validate + render cloud-init`) to succeed: `gh pr checks --watch`.

- [ ] **Step 3: Ask Steven to approve the merge and the deploy**

Stop and ask. Do not merge or deploy without an explicit yes in chat.

- [ ] **Step 4: Merge, deploy, stamp**

```bash
gh pr merge --merge --delete-branch
git checkout main && git pull --ff-only
npm run deploy-worker
git add worker/src/build.ts
git commit -m "Build stamp for the deploy of the history recorder

Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV"
git push
```

Expected: the deploy output shows migration `0012_history.sql` applied and a new `Current Version ID`.

- [ ] **Step 5: Check the live database**

The broad token is in `.env` and never leaves this PC:

```bash
set -a; . ./.env; set +a
npx wrangler d1 execute wg-admin --remote --command "SELECT name FROM sqlite_master WHERE name LIKE 'hist_%'"
```

Expected: `hist_vm`, `hist_client`, `hist_drops`.

If the VM is running, wait two minutes (use a background wait, not a foreground sleep), then:

```bash
npx wrangler d1 execute wg-admin --remote --command "SELECT res, t, received, peers_online, dns_up FROM hist_vm ORDER BY t DESC LIMIT 5"
npx wrangler d1 execute wg-admin --remote --command "SELECT t, peer_id, online, latency_avg, rx, tx FROM hist_client ORDER BY t DESC LIMIT 8"
```

Expected: one `hist_vm` row per minute with `received = 1`, and a `hist_client` row per client per minute (the home site online with a latency). If the VM is not running, record in the summary that live rows will appear at the next deploy.

- [ ] **Step 6: Bring the redesign branch level with main**

```bash
git checkout redesign && git merge --ff-only main && git push
```

Expected: fast-forward (the redesign branch only held the docs, now on main).
