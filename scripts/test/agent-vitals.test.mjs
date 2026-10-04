// agent-vitals.test.mjs
//
// Plain English: the VM agent's new vitals (insights spec section 5), run for
// real in bash against a fixture tree. WG_ROOT points the scripts at fake
// /proc and /run folders, and fake apt-check, apt-get, curl, ping, df,
// timeout and systemd-run on PATH stand in for the VM's tools, so nothing
// here touches the network or Azure. The heartbeat itself (wg-agent.sh)
// posts to a tiny local HTTP server that captures the body.
//
// Skipped where bash or jq is missing (CI's Ubuntu runner has both; on
// Windows, Git Bash plus a jq on PATH).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const VITALS_SH = join(REPO, "infra", "agent", "wg-vitals.sh");
const AGENT_SH = join(REPO, "infra", "agent", "wg-agent.sh");
const EVENTS_FIXTURE = join(HERE, "fixtures", "agent", "scheduledevents.json");

/** Git Bash on Windows (the bash.exe on PATH there is often WSL's), plain bash elsewhere. */
function findBash() {
  const cands = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash"] : ["bash"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
const BASH = findBash();
const JQ = BASH ? spawnSync(BASH, ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim() || null : null;
const skip = !BASH ? "no bash found" : !JQ ? "no jq on PATH" : false;

/** Forward slashes: Git Bash takes C:/... paths, and they read the same on Linux. */
const fwd = (p) => p.replace(/\\/g, "/");

/** A fresh fixture tree: a root with /proc and /run, a bin folder of fakes, and a log folder the fakes write to. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "wg-vitals-"));
  const root = join(dir, "root");
  const bin = join(dir, "bin");
  const log = join(dir, "log");
  for (const d of [join(root, "proc", "sys", "net", "netfilter"), join(root, "run", "wg-admin"), join(root, "usr", "local", "sbin"), bin, log]) mkdirSync(d, { recursive: true });
  copyFileSync(VITALS_SH, join(root, "usr", "local", "sbin", "wg-vitals.sh"));
  const w = {
    dir,
    root,
    bin,
    log,
    run: join(root, "run", "wg-admin"),
    file: (rel, text) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    },
    read: (rel) => readFileSync(join(root, rel), "utf8"),
    json: (rel) => JSON.parse(readFileSync(join(root, rel), "utf8")),
    calls: (name) => (existsSync(join(log, name)) ? readFileSync(join(log, name), "utf8").split("\n").filter(Boolean) : []),
    fake: (name, body) => {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    },
    env: (extra = {}) => ({ ...process.env, FAKE_BIN: fwd(bin), WG_ROOT: fwd(root), FAKE_LOG: fwd(log), ...extra }),
    // A job still sleeping in the background (the timing test) may hold a file open on Windows; it ends on its own.
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* left for the OS to clear */
      }
    },
  };
  // Native jq.exe on Windows writes CRLF unless told --binary.
  if (process.platform === "win32" && /\.exe$/i.test(JQ ?? "")) w.fake("jq", `exec "${JQ}" -b "$@"`);
  w.file("proc/meminfo", "MemTotal:         948000 kB\nMemFree:          100000 kB\nMemAvailable:     571000 kB\nBuffers:           10000 kB\n");
  w.file("proc/stat", STAT_A);
  w.file("proc/uptime", "3600.25 3500.00\n");
  w.file("proc/loadavg", "0.12 0.10 0.05 1/90 1234\n");
  w.file("proc/sys/net/netfilter/nf_conntrack_count", "61\n");
  w.file("proc/sys/net/netfilter/nf_conntrack_max", "32768\n");
  w.fake("df", `echo "$*" >> "$FAKE_LOG/df"\nprintf '      1B-blocks        Used       Avail\\n 31000000000  7000000000 24000000000\\n'`);
  w.fake("systemd-run", `echo "$*" >> "$FAKE_LOG/systemd-run"`);
  w.fake("apt-check", `echo called >> "$FAKE_LOG/apt-check"\n[[ -n "\${FAKE_SLEEP:-}" ]] && sleep "$FAKE_SLEEP"\nprintf '5;2' >&2`);
  return w;
}

const STAT_A = "cpu  1000 0 500 8000 100 0 0 400 0 0\ncpu0 500 0 250 4000 50 0 0 200 0 0\ncpu1 500 0 250 4000 50 0 0 200 0 0\nintr 12345\nctxt 999\n";
// 1000 jiffies later: 40 of them stolen by the hypervisor, 10 waiting on the disk.
const STAT_B = "cpu  1100 0 550 8800 110 0 0 440 0 0\ncpu0 550 0 275 4400 55 0 0 220 0 0\ncpu1 550 0 275 4400 55 0 0 220 0 0\nintr 12345\nctxt 999\n";

/**
 * bash's arguments to run a script with the fakes first on PATH. Set inside
 * bash, because Git Bash's launcher puts its own folders (with a real curl,
 * df and timeout) in front of whatever PATH it is given.
 */
const withFakes = (script, args = []) => ["--noprofile", "--norc", "-c", 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash --noprofile --norc "$0" "$@"', script, ...args];

/** Run a script in bash and wait for it. */
function bash(w, [script, ...args], extra = {}) {
  const t0 = Date.now();
  const r = spawnSync(BASH, withFakes(script, args), { encoding: "utf8", env: w.env(extra), timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
}
const vitals = (w, args, extra) => bash(w, [fwd(join(w.root, "usr", "local", "sbin", "wg-vitals.sh")), ...args], extra);

// ── Syntax ─────────────────────────────────────────────────────────────

test("wg-vitals.sh passes bash -n", { skip: BASH ? false : "no bash found" }, () => {
  const r = spawnSync(BASH, ["-n", fwd(VITALS_SH)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// ── Job: updates ───────────────────────────────────────────────────────

test("job updates writes pending and security", { skip }, () => {
  const w = world();
  try {
    const r = vitals(w, ["updates"]);
    assert.equal(r.status, 0, r.stderr);
    const u = w.json("run/wg-admin/updates.json");
    assert.equal(u.pending, 5);
    assert.equal(u.security, 2);
    assert.match(u.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  } finally {
    w.cleanup();
  }
});

test("job updates counts apt-get's simulated upgrade when apt-check is missing", { skip }, () => {
  const w = world();
  try {
    rmSync(join(w.bin, "apt-check"));
    w.fake(
      "apt-get",
      `echo "$*" >> "$FAKE_LOG/apt-get"\ncat <<'EOF'\nReading package lists...\nInst libssl3t64 [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])\nInst curl [8.5.0-2ubuntu10.1] (8.5.0-2ubuntu10.5 Ubuntu:24.04/noble-updates [amd64])\nConf libssl3t64 (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])\nEOF`,
    );
    const r = vitals(w, ["updates"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual({ ...w.json("run/wg-admin/updates.json"), at: "x" }, { pending: 2, security: 1, at: "x" });
    assert.match(w.calls("apt-get")[0], /-s/);
  } finally {
    w.cleanup();
  }
});

// ── Job: events ────────────────────────────────────────────────────────

function fakeImds(w, mode = "ok") {
  const events = readFileSync(EVENTS_FIXTURE, "utf8").replace("LONGDESC", "x".repeat(300));
  writeFileSync(join(w.dir, "events.json"), events);
  w.fake(
    "curl",
    `echo "$*" >> "$FAKE_LOG/curl"\ncase "$*" in\n  *compute/name*) printf 'vm-wg' ;;\n  *scheduledevents*) [[ "${mode}" == down ]] && exit 28; cat "${fwd(join(w.dir, "events.json"))}" ;;\n  *) exit 7 ;;\nesac`,
  );
}

test("job events keeps at most 10, caps descriptions at 200 and marks self", { skip }, () => {
  const w = world();
  try {
    fakeImds(w);
    const r = vitals(w, ["events"]);
    assert.equal(r.status, 0, r.stderr);
    const e = w.json("run/wg-admin/events.json");
    assert.equal(e.incarnation, 4);
    assert.match(e.at, /Z$/);
    assert.equal(e.items.length, 10);
    assert.deepEqual(e.items[0], { id: "6e1c3b9a-0000-4000-8000-000000000001", type: "Reboot", status: "Scheduled", not_before: "Sun, 04 Oct 2026 13:00:00 GMT", source: "Platform", duration_s: 300, description: "Host server maintenance.", self: true });
    assert.equal(e.items[1].description.length, 200);
    assert.equal(e.items[1].self, false);
    assert.equal(e.items[1].not_before, null);
    assert.equal(e.items[2].description, null);
  } finally {
    w.cleanup();
  }
});

test("job events never POSTs", { skip }, () => {
  const w = world();
  try {
    fakeImds(w);
    vitals(w, ["events"]);
    vitals(w, ["events"]);
    const calls = w.calls("curl");
    assert.ok(calls.some((c) => /scheduledevents\?api-version=2020-07-01/.test(c)), calls.join("\n"));
    for (const c of calls) {
      assert.doesNotMatch(c, /(^| )(-d|--data\S*|-X|--request|-F|--form|-T|--upload-file)( |$)/, c);
      assert.match(c, /Metadata:true/);
      assert.match(c, /--max-time 2/);
    }
    // The VM's name is asked once, then remembered.
    assert.equal(calls.filter((c) => /compute\/name/.test(c)).length, 1);
  } finally {
    w.cleanup();
  }
});

test("job events keeps the last result when the metadata service does not answer", { skip }, () => {
  const w = world();
  try {
    w.file("run/wg-admin/events.json", '{"incarnation":1,"at":"2026-10-04T09:00:00Z","items":[]}');
    fakeImds(w, "down");
    const r = vitals(w, ["events"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.json("run/wg-admin/events.json").at, "2026-10-04T09:00:00Z");
  } finally {
    w.cleanup();
  }
});

// ── Job: net ───────────────────────────────────────────────────────────

/** iputils ping's quiet summary, as a printf format (so the % is doubled). */
const pingOut = (ip, sent, got, loss, avg) =>
  `PING ${ip} (${ip}) 56(84) bytes of data.\\n\\n--- ${ip} ping statistics ---\\n${sent} packets transmitted, ${got} received, ${loss}%% packet loss, time 402ms\\n${avg === null ? "" : `rtt min/avg/max/mdev = 8.000/${avg}/12.000/0.300 ms\\n`}`;

function fakePing(w, mode) {
  w.fake(
    "ping",
    `echo "$*" >> "$FAKE_LOG/ping"\nip="\${@: -1}"\ncase "${mode}:$ip" in\n` +
      `  ok:1.1.1.1) printf '${pingOut("1.1.1.1", 3, 3, 0, "9.412")}' ;;\n` +
      `  ok:8.8.8.8) printf '${pingOut("8.8.8.8", 3, 2, "33.3333", "10.250")}' ;;\n` +
      `  unreachable:*) echo 'ping: connect: Network is unreachable' >&2; exit 2 ;;\n` +
      `  *) printf '${pingOut("$ip", 3, 0, 100, null)}'; exit 1 ;;\nesac`,
  );
  // TCP connects go through timeout(1); this one lets the addresses in FAKE_TCP_OK connect.
  w.fake("timeout", `shift\ncase "$*" in\n  */dev/tcp/*) echo "$*" >> "$FAKE_LOG/tcp"; for ok in \${FAKE_TCP_OK:-}; do [[ "$*" == *"/dev/tcp/$ok/53"* ]] && exit 0; done; exit 124 ;;\nesac\nexec "$@"`);
}

test("job net reports rtt and loss per target", { skip }, () => {
  const w = world();
  try {
    fakePing(w, "ok");
    const r = vitals(w, ["net"]);
    assert.equal(r.status, 0, r.stderr);
    const n = w.json("run/wg-admin/net.json");
    assert.equal(n.method, "icmp");
    assert.match(n.at, /Z$/);
    assert.deepEqual(n.targets, [
      { ip: "1.1.1.1", rtt_ms: 9.412, loss_pct: 0 },
      { ip: "8.8.8.8", rtt_ms: 10.25, loss_pct: 33.3333 },
    ]);
    for (const c of w.calls("ping")) assert.match(c, /^-n -q -c 3 -i 0\.2 -W 1 /);
    assert.deepEqual(w.calls("tcp"), []);
  } finally {
    w.cleanup();
  }
});

test("job net falls back to tcp when ping loses everything", { skip }, () => {
  const w = world();
  try {
    fakePing(w, "lossall");
    const r = vitals(w, ["net"], { FAKE_TCP_OK: "1.1.1.1" });
    assert.equal(r.status, 0, r.stderr);
    const n = w.json("run/wg-admin/net.json");
    assert.equal(n.method, "tcp");
    assert.equal(n.targets[0].ip, "1.1.1.1");
    assert.equal(n.targets[0].loss_pct, 0);
    assert.equal(typeof n.targets[0].rtt_ms, "number");
    assert.deepEqual(n.targets[1], { ip: "8.8.8.8", rtt_ms: null, loss_pct: 100 });
  } finally {
    w.cleanup();
  }
});

test("job net says no internet when tcp fails too", { skip }, () => {
  const w = world();
  try {
    fakePing(w, "lossall");
    const r = vitals(w, ["net"]);
    assert.equal(r.status, 0, r.stderr);
    const n = w.json("run/wg-admin/net.json");
    assert.equal(n.method, "icmp");
    assert.deepEqual(n.targets, [
      { ip: "1.1.1.1", rtt_ms: null, loss_pct: 100 },
      { ip: "8.8.8.8", rtt_ms: null, loss_pct: 100 },
    ]);
  } finally {
    w.cleanup();
  }
});

test("job net counts a ping that printed no summary as everything lost", { skip }, () => {
  const w = world();
  try {
    fakePing(w, "unreachable");
    const r = vitals(w, ["net"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(w.json("run/wg-admin/net.json").targets, [
      { ip: "1.1.1.1", rtt_ms: null, loss_pct: 100 },
      { ip: "8.8.8.8", rtt_ms: null, loss_pct: 100 },
    ]);
    assert.equal(w.calls("tcp").length, 2, "and the TCP check ran");
  } finally {
    w.cleanup();
  }
});

// ── One job at a time ──────────────────────────────────────────────────

test("a second start while a job runs exits at once", { skip }, async () => {
  const w = world();
  try {
    const first = spawn(BASH, withFakes(fwd(join(w.root, "usr", "local", "sbin", "wg-vitals.sh")), ["updates"]), { env: w.env({ FAKE_SLEEP: "8" }), stdio: "ignore" });
    const done = new Promise((r) => first.on("close", r));
    const end = Date.now() + 10_000;
    while (!w.calls("apt-check").length) {
      if (Date.now() > end) throw new Error("the first job never started");
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = vitals(w, ["updates"]);
    assert.equal(second.status, 0, second.stderr);
    // It did not wait for the lock: the first is still in its 8-second apt-check.
    assert.ok(!existsSync(join(w.run, "updates.json")), `the second start returned (after ${second.ms} ms) before the first finished`);
    assert.equal(w.calls("apt-check").length, 1, "apt-check ran once");
    await done;
    assert.equal(w.json("run/wg-admin/updates.json").pending, 5);
    // And once the first has finished, the lock is free again.
    vitals(w, ["updates"]);
    assert.equal(w.calls("apt-check").length, 2);
  } finally {
    w.cleanup();
  }
});

test("a lock left by a job that died is taken over", { skip }, () => {
  const w = world();
  try {
    mkdirSync(join(w.run, "vitals-updates.lock"));
    writeFileSync(join(w.run, "vitals-updates.lock", "pid"), "999999\n");
    const r = vitals(w, ["updates"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(w.calls("apt-check").length, 1);
    assert.ok(!existsSync(join(w.run, "vitals-updates.lock")), "lock released");
  } finally {
    w.cleanup();
  }
});

// ── collect: what the heartbeat sends ──────────────────────────────────

test("collect reads memory, disk and conntrack from fixture /proc", { skip }, () => {
  const w = world();
  try {
    const r = vitals(w, ["collect"]);
    assert.equal(r.status, 0, r.stderr);
    const v = JSON.parse(r.stdout);
    assert.deepEqual(v.mem, { total: 948000 * 1024, available: 571000 * 1024 });
    assert.deepEqual(v.disk, { total: 31000000000, used: 7000000000, avail: 24000000000 });
    assert.deepEqual(v.conntrack, { count: 61, max: 32768 });
    assert.deepEqual(v.cpu, { steal_pct: null, iowait_pct: null, ncpu: 2 }, "no previous reading yet");
    assert.equal(v.updates, null);
    assert.equal(v.events, null);
    assert.equal(v.net, null);
    assert.match(w.calls("df")[0], /-B1 --output=size,used,avail \/$/);
  } finally {
    w.cleanup();
  }
});

test("steal percent comes from two /proc/stat readings", { skip }, () => {
  const w = world();
  try {
    vitals(w, ["collect"]);
    w.file("proc/stat", STAT_B);
    const v = JSON.parse(vitals(w, ["collect"]).stdout);
    assert.deepEqual(v.cpu, { steal_pct: 4, iowait_pct: 1, ncpu: 2 });
  } finally {
    w.cleanup();
  }
});

test("conntrack is null when the files are absent", { skip }, () => {
  const w = world();
  try {
    rmSync(join(w.root, "proc", "sys"), { recursive: true });
    const v = JSON.parse(vitals(w, ["collect"]).stdout);
    assert.equal(v.conntrack, null);
    assert.ok(v.mem, "the rest still reported");
  } finally {
    w.cleanup();
  }
});

test("collect passes the jobs' caches through", { skip }, () => {
  const w = world();
  try {
    w.file("run/wg-admin/updates.json", '{"pending":3,"security":0,"at":"2026-10-04T08:00:00Z"}');
    w.file("run/wg-admin/net.json", '{"at":"2026-10-04T09:58:00Z","method":"icmp","targets":[{"ip":"1.1.1.1","rtt_ms":9.4,"loss_pct":0}]}');
    const v = JSON.parse(vitals(w, ["collect"]).stdout);
    assert.deepEqual(v.updates, { pending: 3, security: 0, at: "2026-10-04T08:00:00Z" });
    assert.equal(v.net.targets[0].rtt_ms, 9.4);
  } finally {
    w.cleanup();
  }
});

test("stale caches start their jobs through systemd-run --no-block", { skip }, () => {
  const w = world();
  try {
    vitals(w, ["collect"]);
    const calls = w.calls("systemd-run");
    assert.equal(calls.length, 3, calls.join("\n"));
    for (const job of ["updates", "events", "net"]) {
      const c = calls.find((l) => l.endsWith(` ${job}`));
      assert.ok(c, `started ${job}`);
      assert.match(c, /--no-block/);
      assert.match(c, new RegExp(`--unit wg-vitals-${job} `));
      assert.match(c, /RuntimeMaxSec=/);
      assert.match(c, /wg-vitals\.sh /);
    }
    // Straight after: every job is fresh, nothing more is started.
    vitals(w, ["collect"]);
    assert.equal(w.calls("systemd-run").length, 3);
    // Once a job's interval has passed (here, events: 60 s), only that one starts again.
    writeFileSync(join(w.run, "vitals-events.started"), String(Math.floor(Date.now() / 1000) - 61));
    vitals(w, ["collect"]);
    const after = w.calls("systemd-run");
    assert.equal(after.length, 4);
    assert.match(after[3], / events$/);
  } finally {
    w.cleanup();
  }
});

// ── The heartbeat ──────────────────────────────────────────────────────

/** Run wg-agent.sh once against a local server; resolves with the posted body and how long the run took. */
async function heartbeat(w, extra = {}) {
  let body = null;
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      body = { auth: req.headers.authorization, json: JSON.parse(data) };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const t0 = Date.now();
    const child = spawn(BASH, withFakes(fwd(AGENT_SH)), {
      env: w.env({ AGENT_URL: `http://127.0.0.1:${port}/api/agent`, AGENT_TOKEN: "tok", ...extra }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    const status = await new Promise((r) => child.on("close", r));
    return { status, stderr, ms: Date.now() - t0, body };
  } finally {
    server.close();
  }
}

/**
 * Lift the heartbeat's 3-second cap on collect, for the tests about what is
 * sent: on a busy Windows machine Git Bash's slow forks can take collect past
 * it (on the VM it takes milliseconds). The cap has its own test below.
 */
const uncapped = (w) => w.fake("timeout", 'shift\nexec "$@"');

test("wg-agent.sh passes bash -n", { skip: BASH ? false : "no bash found" }, () => {
  const r = spawnSync(BASH, ["-n", fwd(AGENT_SH)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("wg-agent.sh sends agent_version 7 and vitals from fixture /proc", { skip }, async () => {
  const w = world();
  try {
    w.file("run/wg-admin/updates.json", '{"pending":3,"security":0,"at":"2026-10-04T08:00:00Z"}');
    uncapped(w);
    const r = await heartbeat(w);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.body, "the heartbeat posted");
    assert.equal(r.body.auth, "Bearer tok");
    const b = r.body.json;
    assert.equal(b.agent_version, 7);
    assert.equal(b.uptime_seconds, 3600.25);
    assert.equal(b.load, "0.12 0.10 0.05");
    assert.deepEqual(b.vitals.mem, { total: 948000 * 1024, available: 571000 * 1024 });
    assert.deepEqual(b.vitals.disk, { total: 31000000000, used: 7000000000, avail: 24000000000 });
    assert.deepEqual(b.vitals.conntrack, { count: 61, max: 32768 });
    assert.equal(b.vitals.updates.pending, 3);
    assert.equal(b.vitals.events, null);
  } finally {
    w.cleanup();
  }
});

test("a broken cache file sends null for that field and the heartbeat still posts", { skip }, async () => {
  const w = world();
  try {
    w.file("run/wg-admin/updates.json", '{"pending":3,"secur');
    w.file("run/wg-admin/net.json", "[1,2,3]");
    uncapped(w);
    const r = await heartbeat(w);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.body.json.vitals.updates, null);
    assert.equal(r.body.json.vitals.net, null);
    assert.ok(r.body.json.vitals.mem, "the other fields still sent");
  } finally {
    w.cleanup();
  }
});

test("a missing or failing wg-vitals.sh sends vitals null and the heartbeat still posts", { skip }, async () => {
  const w = world();
  try {
    rmSync(join(w.root, "usr", "local", "sbin", "wg-vitals.sh"));
    const r = await heartbeat(w);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.body.json.agent_version, 7);
    assert.equal(r.body.json.vitals, null);
    assert.ok(r.body.json.dns, "the rest of the heartbeat is unchanged");
  } finally {
    w.cleanup();
  }
});

test("a collect that hangs is cut off after 3 s and the heartbeat still posts, with vitals null", { skip }, async () => {
  const w = world();
  try {
    // systemd-run stuck (say, on D-Bus) while starting a due job.
    w.fake("systemd-run", `echo "$*" >> "$FAKE_LOG/systemd-run"\nsleep 60`);
    const r = await heartbeat(w);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.body, "the heartbeat posted");
    assert.equal(r.body.json.vitals, null);
    assert.equal(w.calls("systemd-run").length, 1, "collect reached the stuck call");
    // Loose, for busy test machines: the point is that it never waits out the 60 s.
    assert.ok(r.ms < 40_000, `heartbeat took ${r.ms} ms`);
  } finally {
    w.cleanup();
  }
});

test("a job that sleeps 30 s leaves the heartbeat under 2 s", { skip }, async (t) => {
  const w = world();
  try {
    // This systemd-run really starts the job, detached, as systemd would.
    w.fake("systemd-run", `echo "$*" >> "$FAKE_LOG/systemd-run"\nnohup bash "\${@: -2}" >/dev/null 2>&1 </dev/null &`);
    // How long this machine takes for a heartbeat with every cache fresh (no job started).
    const now = String(Math.floor(Date.now() / 1000));
    for (const job of ["updates", "events", "net"]) writeFileSync(join(w.run, `vitals-${job}.started`), now);
    const base = await heartbeat(w);
    assert.equal(base.status, 0, base.stderr);
    assert.equal(w.calls("systemd-run").length, 0);
    // Now the updates job is due, and apt-check hangs for 30 s.
    rmSync(join(w.run, "vitals-updates.started"));
    const r = await heartbeat(w, { FAKE_SLEEP: "30" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.body, "the heartbeat posted");
    assert.equal(w.calls("systemd-run").length, 1, "the job was started");
    // Under 2 s, or on a slow or busy machine (Git Bash's forks on Windows, a
    // loaded container) within 1.5 s of that machine's own plain heartbeat:
    // either way nowhere near the job's 30 s.
    const limit = Math.max(2000, base.ms + 1500);
    t.diagnostic(`heartbeat with a hanging job: ${r.ms} ms; with every cache fresh: ${base.ms} ms; limit ${limit} ms`);
    assert.ok(r.ms < limit, `heartbeat took ${r.ms} ms (limit ${limit}, plain heartbeat ${base.ms} ms)`);
    assert.ok(!existsSync(join(w.run, "updates.json")), "the job was still running when the heartbeat finished");
  } finally {
    w.cleanup();
  }
});
