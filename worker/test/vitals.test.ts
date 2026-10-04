// vitals.test.ts
//
// Plain English: the VM's own figures arriving on the heartbeat (agent
// version 7). parseVitals checks every number and string and never throws;
// an older agent's heartbeat (no vitals) keeps working and stores null; a
// new Azure scheduled event writes one note and one push, once per id.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import * as db from "../src/db";
import type { Env } from "../src/env";
import { parseVitals, parseAgentVersion, vitalsSample, freshScheduledEvents } from "../src/vitals";
import { startDeploy, issueRunSecrets, handleCallback, handleAgent } from "../src/runs";
import { getSnapshot } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = "2026-10-04T10:00:00Z";

/** A version-7 agent's vitals, as wg-vitals.sh collect prints them. */
function rawVitals(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mem: { total: 1_000_000_000, available: 600_000_000 },
    disk: { total: 30_000_000_000, used: 6_000_000_000, avail: 24_000_000_000 },
    cpu: { steal_pct: 1.5, iowait_pct: 0.25, ncpu: 2 },
    conntrack: { count: 64, max: 32768 },
    updates: { pending: 3, security: 1, at: AT },
    events: {
      incarnation: 2,
      at: AT,
      items: [{ id: "6e1c3b9a-0000-4000-8000-000000000001", type: "Reboot", status: "Scheduled", not_before: "Sun, 04 Oct 2026 13:00:00 GMT", source: "Platform", duration_s: 300, description: "Host server maintenance.", self: true }],
    },
    net: { at: AT, method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: 9.4, loss_pct: 0 }, { ip: "8.8.8.8", rtt_ms: 10.2, loss_pct: 0 }] },
    ...over,
  };
}

describe("parseVitals", () => {
  it("keeps a well-formed report, with the event's time as ISO", () => {
    const v = parseVitals(rawVitals())!;
    expect(v.mem).toEqual({ total: 1_000_000_000, available: 600_000_000 });
    expect(v.disk).toEqual({ total: 30_000_000_000, used: 6_000_000_000, avail: 24_000_000_000 });
    expect(v.cpu).toEqual({ steal_pct: 1.5, iowait_pct: 0.25, ncpu: 2 });
    expect(v.conntrack).toEqual({ count: 64, max: 32768 });
    expect(v.updates).toEqual({ pending: 3, security: 1, at: "2026-10-04T10:00:00.000Z" });
    expect(v.events?.incarnation).toBe(2);
    expect(v.events?.items[0]).toEqual({ id: "6e1c3b9a-0000-4000-8000-000000000001", type: "Reboot", status: "Scheduled", not_before: "2026-10-04T13:00:00.000Z", source: "Platform", duration_s: 300, description: "Host server maintenance.", self: true });
    expect(v.net).toEqual({ at: "2026-10-04T10:00:00.000Z", method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: 9.4, loss_pct: 0 }, { ip: "8.8.8.8", rtt_ms: 10.2, loss_pct: 0 }] });
  });

  it("answers null for anything that is not an object", () => {
    for (const raw of [undefined, null, 0, 7, "vitals", true, [], [1, 2]]) expect(parseVitals(raw)).toBeNull();
  });

  it("clamps percentages, caps strings, drops wrong types", () => {
    const v = parseVitals(
      rawVitals({
        mem: { total: 1000, available: 5000 }, // more free than there is: capped at the total
        disk: { total: "30", used: 1, avail: 2 }, // a string total: the part is unreadable
        cpu: { steal_pct: 250, iowait_pct: -4, ncpu: 2.7 },
        conntrack: { count: 900, max: 100 },
        updates: { pending: -2, security: 1, at: AT },
        events: {
          incarnation: "2",
          at: AT,
          items: [
            { id: "a".repeat(500), type: "Reboot", status: "S".repeat(100), not_before: "not a date", source: null, duration_s: -1, description: "d".repeat(1000), self: "yes" },
            { id: "x", type: "Explode", status: "Scheduled" }, // not a type Azure sends: left out
            "junk",
          ],
        },
        net: { at: AT, method: "carrier pigeon", targets: [] },
      }),
    )!;
    expect(v.mem).toEqual({ total: 1000, available: 1000 });
    expect(v.disk).toBeNull();
    expect(v.cpu).toEqual({ steal_pct: 100, iowait_pct: 0, ncpu: null });
    expect(v.conntrack).toEqual({ count: 100, max: 100 });
    expect(v.updates).toBeNull();
    expect(v.events?.incarnation).toBeNull();
    expect(v.events?.items).toHaveLength(1);
    const e = v.events!.items[0];
    expect(e.id.length).toBeLessThanOrEqual(64);
    expect(e.status.length).toBeLessThanOrEqual(32);
    expect(e.description?.length).toBe(200);
    expect(e.not_before).toBeNull();
    expect(e.duration_s).toBeNull();
    expect(e.self).toBe(false);
    expect(v.net).toBeNull();
  });

  it("keeps at most 10 events and 4 internet targets, and strips control characters", () => {
    const item = (i: number) => ({ id: `id-${i}`, type: "Freeze", status: "Scheduled", not_before: null, source: "Platform", duration_s: 9, description: "line\nbreak\u0007", self: true });
    const v = parseVitals(
      rawVitals({
        events: { incarnation: 1, at: AT, items: Array.from({ length: 15 }, (_, i) => item(i)) },
        net: { at: AT, method: "tcp", targets: Array.from({ length: 8 }, () => ({ ip: "1.1.1.1", rtt_ms: 70000, loss_pct: 101 })) },
      }),
    )!;
    expect(v.events?.items).toHaveLength(10);
    expect(v.events?.items[0].description).toBe("line break");
    expect(v.net?.targets).toHaveLength(4);
    expect(v.net?.targets[0]).toEqual({ ip: "1.1.1.1", rtt_ms: 60000, loss_pct: 100 });
  });

  it("refuses an internet target that is not an address", () => {
    const v = parseVitals(rawVitals({ net: { at: AT, method: "icmp", targets: [{ ip: "<script>", rtt_ms: 1, loss_pct: 0 }, { ip: "2606:4700::1111", rtt_ms: 2, loss_pct: 0 }] } }))!;
    expect(v.net?.targets).toEqual([{ ip: "2606:4700::1111", rtt_ms: 2, loss_pct: 0 }]);
  });

  it("reads missing parts as null, never 0", () => {
    const v = parseVitals({ mem: { total: 1000, available: 400 } })!;
    expect(v).toEqual({ mem: { total: 1000, available: 400 }, disk: null, cpu: null, conntrack: null, updates: null, events: null, net: null });
    expect(parseVitals({ cpu: { steal_pct: null, iowait_pct: null, ncpu: null } })!.cpu).toEqual({ steal_pct: null, iowait_pct: null, ncpu: null });
  });

  it("never throws on fuzzed input", () => {
    // A seeded generator, so a failure can be replayed.
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const leaves = [null, undefined, 0, -1, 1e308, -1e308, Number.NaN, Infinity, "", "x".repeat(5000), "2026-10-04T10:00:00Z", true, false, {}, [], "\u0000"];
    const any = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.4) return leaves[Math.floor(rnd() * leaves.length)];
      if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 12) }, () => any(depth + 1));
      const keys = ["mem", "disk", "cpu", "conntrack", "updates", "events", "net", "items", "targets", "total", "available", "used", "avail", "steal_pct", "ncpu", "count", "max", "pending", "security", "at", "id", "type", "status", "ip", "rtt_ms", "loss_pct", "method", "self", "__proto__"];
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 6; i++) o[keys[Math.floor(rnd() * keys.length)]] = any(depth + 1);
      return o;
    };
    for (let i = 0; i < 2000; i++) {
      const raw = rnd() < 0.5 ? any(0) : { ...rawVitals(), [["mem", "disk", "cpu", "conntrack", "updates", "events", "net"][i % 7]]: any(1) };
      expect(() => parseVitals(raw)).not.toThrow();
    }
  });

  it("never throws even when reading the input throws", () => {
    const hostile = Object.defineProperty({}, "mem", { enumerable: true, get: () => { throw new Error("boom"); } });
    expect(parseVitals(hostile)).toBeNull();
  });
});

describe("parseAgentVersion", () => {
  it("keeps a whole version number and reads anything else as null", () => {
    expect(parseAgentVersion(7)).toBe(7);
    expect(parseAgentVersion(6)).toBe(6);
    for (const raw of [undefined, null, "7", 7.5, -1, 0, 1e9, Number.NaN]) expect(parseAgentVersion(raw)).toBeNull();
  });
});

describe("vitalsSample", () => {
  const atMs = Date.parse(AT) + 30_000;

  it("turns the vitals into hist_vm's percentages (disk as df's Use%)", () => {
    const s = vitalsSample(parseVitals(rawVitals()), atMs);
    expect(s).toEqual({ mem_used_pct: 40, disk_used_pct: 20, steal_pct: 1.5, conntrack_pct: 0.2, net_rtt_ms: 9.8, net_loss_pct: 0 });
  });

  it("is all null without vitals", () => {
    expect(vitalsSample(null, atMs)).toEqual({ mem_used_pct: null, disk_used_pct: null, steal_pct: null, conntrack_pct: null, net_rtt_ms: null, net_loss_pct: null });
  });

  it("leaves out an internet check older than 15 minutes, and averages loss across targets", () => {
    const v = parseVitals(rawVitals({ net: { at: AT, method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: null, loss_pct: 100 }, { ip: "8.8.8.8", rtt_ms: 12, loss_pct: 0 }] } }));
    expect(vitalsSample(v, atMs)).toMatchObject({ net_rtt_ms: 12, net_loss_pct: 50 });
    expect(vitalsSample(v, Date.parse(AT) + 16 * 60_000)).toMatchObject({ net_rtt_ms: null, net_loss_pct: null });
  });
});

describe("freshScheduledEvents", () => {
  const v = (ids: string[]) => parseVitals(rawVitals({ events: { incarnation: 1, at: AT, items: ids.map((id) => ({ id, type: "Reboot", status: "Scheduled", not_before: null, source: "Platform", duration_s: null, description: null, self: true })) } }));

  it("returns the ids not seen before and remembers the last 20", () => {
    const seen = Array.from({ length: 20 }, (_, i) => `old-${i}`);
    const r = freshScheduledEvents(v(["old-19", "new-1"]), seen);
    expect(r.fresh.map((e) => e.id)).toEqual(["new-1"]);
    expect(r.seen).toHaveLength(20);
    expect(r.seen.at(-1)).toBe("new-1");
    expect(r.seen).not.toContain("old-0");
  });

  it("finds nothing without events, and keeps the list as it was", () => {
    expect(freshScheduledEvents(null, undefined)).toEqual({ fresh: [], seen: [] });
    expect(freshScheduledEvents(v([]), ["a"])).toEqual({ fresh: [], seen: ["a"] });
  });
});

// ── The heartbeat itself ────────────────────────────────────────────────

const PHONE = "P".repeat(43) + "=";
const DUMP = "PRIV\tS=\t51820\toff\n" + `${PHONE}\t(none)\t203.0.113.25:4000\t10.13.13.2/32\t${Math.floor(Date.now() / 1000)}\t1\t1\t0`;

async function toRunning() {
  await db.addPeer(env, { name: "Phone", public_key: PHONE, ip: "10.13.13.2", full_tunnel: false });
  const run = await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
  const sec = await issueRunSecrets(env, run.id, lastGhRun(world));
  world.azure.rg = true;
  await handleCallback(env, sec.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.azure.ip } });
  return sec.body.agent_token as string;
}

describe("handleAgent and vitals", () => {
  it("handleAgent stores agent_version and vitals on the snapshot", async () => {
    const token = await toRunning();
    const r = await handleAgent(env, token, { agent_version: 7, dump: DUMP, vitals: rawVitals() });
    expect(r.status).toBe(200);
    const agent = (await getSnapshot(env)).agent!;
    expect(agent.agent_version).toBe(7);
    expect(agent.vitals?.mem).toEqual({ total: 1_000_000_000, available: 600_000_000 });
    expect(agent.vitals?.net?.targets).toHaveLength(2);
  });

  it("an agent_version 6 body stores vitals null", async () => {
    const token = await toRunning();
    const r = await handleAgent(env, token, { agent_version: 6, dump: DUMP });
    expect(r.status).toBe(200);
    expect((r.body as { peers: unknown[] }).peers).toHaveLength(1);
    const agent = (await getSnapshot(env)).agent!;
    expect(agent.agent_version).toBe(6);
    expect(agent.vitals).toBeNull();
  });

  it("an agent with no version at all stores both as null", async () => {
    const token = await toRunning();
    await handleAgent(env, token, { dump: DUMP });
    const agent = (await getSnapshot(env)).agent!;
    expect(agent.agent_version).toBeNull();
    expect(agent.vitals).toBeNull();
  });

  it("a vitals parse failure still answers the heartbeat with peers", async () => {
    const token = await toRunning();
    const hostile = Object.defineProperty({}, "events", { enumerable: true, get: () => { throw new Error("boom"); } });
    const r = await handleAgent(env, token, { agent_version: 7, dump: DUMP, vitals: hostile });
    expect(r.status).toBe(200);
    expect((r.body as { peers: unknown[] }).peers).toHaveLength(1);
    const snap = await getSnapshot(env);
    expect(snap.agent?.vitals).toBeNull();
    expect(snap.last_agent_at).not.toBeNull();
  });

  it("a new scheduled event writes one note and one push, and the same id again writes nothing", async () => {
    const token = await toRunning();
    const before = world.notes.length;
    await handleAgent(env, token, { agent_version: 7, dump: DUMP, vitals: rawVitals() });
    const notes = (await db.listAlerts(env)).filter((a) => /scheduled/i.test(a.message));
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toMatch(/Reboot/);
    expect(notes[0].message).toMatch(/Host server maintenance/);
    const pushes = world.notes.slice(before).filter((n) => /maintenance/i.test(n.title ?? ""));
    expect(pushes).toHaveLength(1);
    expect((await getSnapshot(env)).sched_events_seen).toEqual(["6e1c3b9a-0000-4000-8000-000000000001"]);

    // The same event again (now Started): nothing new.
    const again = rawVitals();
    (again.events as { items: { status: string }[] }).items[0].status = "Started";
    await handleAgent(env, token, { agent_version: 7, dump: DUMP, vitals: again });
    expect((await db.listAlerts(env)).filter((a) => /scheduled/i.test(a.message))).toHaveLength(1);
    expect(world.notes.slice(before).filter((n) => /maintenance/i.test(n.title ?? ""))).toHaveLength(1);
  });

  it("a note that cannot be written never costs the heartbeat", async () => {
    const token = await toRunning();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await env.DB.prepare("DROP TABLE alerts").run();
    const r = await handleAgent(env, token, { agent_version: 7, dump: DUMP, vitals: rawVitals() });
    expect(r.status).toBe(200);
    expect((r.body as { peers: unknown[] }).peers).toHaveLength(1);
    expect(spy).toHaveBeenCalled();
  });
});
