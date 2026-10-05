// scripts/lab-release-test.mjs
//
// Plain English: the real-Azure release test for a lab version (labs spec
// §11.2, plan L1.5), run from this PC with the gh CLI you are signed in to.
// For each lab, one after another, it dispatches lab.yml with action "test"
// (deploy, ready check, destroy, safety net, verify clean, all in one run),
// waits for it, reads the LAB_RESULT line from the run's log and appends a
// row to docs/labs/release-tests.md. No callback and no peering: the
// dashboard is not involved, so the run makes its own masked password.
//
// IT COSTS MONEY (pennies per lab for labs 1-7), so it refuses to start
// without --confirm-cost, and prints the estimate either way. It ALWAYS gets
// the lab torn down: a failed or dirty test, an unreadable result, or Ctrl-C
// mid-test cancels the test run and dispatches a destroy run for that lab.
//
//   node scripts/lab-release-test.mjs <lab id...> --confirm-cost [--ref feat/labs] [--slot 31] [--region uksouth]
//   node scripts/lab-release-test.mjs --check     permissions only, nothing is built (needs az signed in
//                                                 as the pipeline service principal)
//
// lab.yml must already be on main (GitHub dispatches only workflows that
// exist on the default branch); --ref picks the branch whose lab.yml and lab
// code run. Slot 31 (10.71.192.0/18) is the default: the dashboard hands out
// low slots first, so a release test rarely meets a running lab there.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, LAB_SLOTS, slotCidr } from "./lib/labs.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const RESULTS_FILE = join(ROOT, "docs", "labs", "release-tests.md");
const HEADER = [
  "# Lab release tests",
  "",
  "One row per real-Azure release test (labs spec §11.2), appended by `node scripts/lab-release-test.mjs`.",
  "A lab version is released when its test passes with clean = yes. Times are the run's own; £ is the",
  "lab's hourly estimate times those minutes.",
  "",
  "| Date (UTC) | Lab | Version | Result | Clean | Leftovers | Deploy | Destroy | Est. £ | Run |",
  "|---|---|---|---|---|---|---|---|---|---|",
  "",
].join("\n");

/** Every lab in the catalogue, by id. */
export function labDefs(labsDir = join(ROOT, "labs")) {
  return new Map(buildCatalogue(labsDir).catalogue.labs.map((d) => [d.id, d]));
}

/** The contract's sessionTimeoutMin: min(150, 2 x (deploy + destroy) + 20). */
export const timeoutMin = (t) => Math.min(150, 2 * (t.deploy_min + t.destroy_min) + 20);

const gbpH = (def) => (def.cost?.items ?? []).reduce((s, i) => s + i.gbp_h * (i.qty ?? 1), 0);

/** Estimated £ for the minutes a test really took (null when unknown). */
export function estimateGbp(def, deploySeconds, destroySeconds) {
  if (deploySeconds == null && destroySeconds == null) return null;
  return Math.round(gbpH(def) * (((deploySeconds ?? 0) + (destroySeconds ?? 0)) / 3600) * 1e6) / 1e6;
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const rand = (n, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");

/** lab.yml's payload for a release test of `def` (spec §5): no callback, no peering. */
export function buildPayload(def, { slot, region, runId, namePrefix }) {
  return {
    lab_id: def.id,
    version: def.version,
    run_id: runId,
    session_id: `ls-release-${runId}`,
    region,
    secondary_region: def.regions?.secondary ?? null,
    slot_cidr: slotCidr(slot),
    name_prefix: namePrefix ?? `l${def.id.split("-")[1]}${rand(5)}`,
    peering: false,
    timeout_min: timeoutMin(def.timing),
    callback_url: "",
    secrets_url: "",
  };
}

/** The last LAB_RESULT {...} line in a run's log, parsed; null if none. */
export function parseLabResult(log) {
  let found = null;
  for (const line of String(log).split(/\r?\n/)) {
    const m = /LAB_RESULT (\{.*\})\s*$/.exec(line);
    if (!m) continue;
    try {
      found = JSON.parse(m[1]);
    } catch {
      /* not a result line */
    }
  }
  return found;
}

const dur = (s) => (s == null ? "—" : `${Math.floor(s / 60)}m ${s % 60}s`);

/** One markdown row for docs/labs/release-tests.md. */
export function releaseRow({ at, lab, version, result, clean, leftovers, deploySeconds, destroySeconds, gbp, runId }) {
  const date = at.toISOString().slice(0, 16).replace("T", " ");
  const c = clean === true ? "yes" : clean === false ? "no" : "unknown";
  const left = Array.isArray(leftovers) ? (leftovers.length ? leftovers.join(", ") : "none") : "unknown";
  const money = gbp == null ? "—" : `£${gbp.toFixed(4)}`;
  return `| ${date} | ${lab} | ${version} | ${result} | ${c} | ${left} | ${dur(deploySeconds)} | ${dur(destroySeconds)} | ${money} | ${runId ?? "—"} |`;
}

function appendRow(file, row) {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, HEADER);
  }
  appendFileSync(file, `${row}\n`);
}

/** Read the command line. Throws with a usage message on anything wrong. */
export function parseArgs(argv, defs = labDefs()) {
  const out = { ids: [], ref: "feat/labs", slot: LAB_SLOTS - 1, region: "uksouth", check: false, confirm: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--confirm-cost") out.confirm = true;
    else if (a === "--ref") out.ref = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--slot") out.slot = Number(argv[++i]);
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else out.ids.push(a);
  }
  if (out.check && out.ids.length === 0) return out;
  if (out.ids.length === 0) throw new Error("give at least one lab id (or --check)");
  for (const id of out.ids) if (!defs.has(id)) throw new Error(`unknown lab id ${id}; the catalogue has ${[...defs.keys()].join(", ")}`);
  if (!Number.isInteger(out.slot) || out.slot < 0 || out.slot >= LAB_SLOTS) throw new Error(`--slot must be 0 to ${LAB_SLOTS - 1}`);
  if (!out.ref || !/^[A-Za-z0-9._/-]+$/.test(out.ref)) throw new Error("--ref must be a branch name");
  if (!/^[a-z][a-z0-9]{1,30}$/.test(out.region ?? "")) throw new Error("--region must be an Azure region name such as uksouth");
  if (!out.confirm) throw new Error("a release test builds real Azure resources and costs money: add --confirm-cost to go ahead");
  return out;
}

const json = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** Dispatch lab.yml and find the run by its title; returns the GitHub run id or null. */
async function dispatch(gh, ref, action, payload, sleep) {
  const r = await gh(["workflow", "run", "lab.yml", "--ref", ref, "-f", `action=${action}`, "-f", `payload=${JSON.stringify(payload)}`]);
  if (r.status !== 0) throw new Error(`gh workflow run failed: ${(r.stderr || "").trim()}`);
  const title = `lab ${action} ${payload.lab_id} ${payload.run_id}`;
  for (let i = 0; i < 36; i++) {
    const list = await gh(["run", "list", "--workflow", "lab.yml", "--event", "workflow_dispatch", "--json", "databaseId,displayTitle,status", "--limit", "50"]);
    const run = (json(list.stdout) ?? []).find((x) => x.displayTitle === title);
    if (run) return run.databaseId;
    await sleep(5000);
  }
  throw new Error(`dispatched, but no run titled "${title}" appeared`);
}

/** Wait for a run and read its LAB_RESULT (null if none). */
async function finish(gh, id) {
  await gh(["run", "watch", String(id), "--exit-status", "--interval", "30"]);
  return parseLabResult((await gh(["run", "view", String(id), "--log"])).stdout);
}

/**
 * Release-test each lab in turn. deps: { gh(args) -> Promise<{status, stdout, stderr}>,
 * log, sleep(ms), now(), file, exit(code), defs, signals (default: process) }. Returns one result per lab.
 */
export async function runRelease({ ids, ref, slot, region }, deps) {
  const { gh, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), file = RESULTS_FILE, exit = (c) => process.exit(c) } = deps;
  const defs = deps.defs ?? labDefs();
  const signals = deps.signals ?? process;
  let active = null; // the lab being tested: { def, payload, ghId, settled, tornDown }

  /** Make sure the lab in `a` is torn down: cancel its test run if it may still be going, then a destroy run. */
  const teardown = async (a, testFinished) => {
    if (!a || a.tornDown) return a?.tornDown ?? null;
    a.tornDown = "dispatched";
    if (a.ghId && !testFinished) {
      log(`cancelling test run ${a.ghId} so the destroy does not wait behind it`);
      await gh(["run", "cancel", String(a.ghId)]).catch(() => null);
    }
    const payload = { ...a.payload, run_id: `lab-destroy-${stamp(now())}-${rand(4)}` };
    try {
      log(`tearing down ${a.def.id}: dispatching a destroy run`);
      const id = await dispatch(gh, ref, "destroy", payload, sleep);
      const r = await finish(gh, id);
      a.tornDown = r?.clean === true ? "clean" : r?.clean === false ? `dirty: ${(r.leftovers ?? []).join(", ")}` : "unknown";
    } catch (e) {
      a.tornDown = `failed: ${e.message}`;
    }
    log(`teardown of ${a.def.id}: ${a.tornDown}${a.tornDown === "clean" ? "" : " — check Azure by hand (rg-lab-" + a.def.id + "*)"}`);
    return a.tornDown;
  };

  let interrupted = false;
  const onSignal = async () => {
    if (interrupted) return;
    interrupted = true;
    log("interrupted: making sure the lab is torn down first (press Ctrl-C again only if you will clean up by hand)");
    if (active && !active.settled) await teardown(active, false);
    exit(130);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  const results = [];
  try {
    for (const id of ids) {
      if (interrupted) break;
      const def = defs.get(id);
      const runId = `lab-test-${stamp(now())}-${rand(4)}`;
      const payload = buildPayload(def, { slot, region, runId });
      active = { def, payload, ghId: null, settled: false, tornDown: null };
      log(`release test: ${id} v${def.version} on ${ref}, slot ${slot} (${payload.slot_cidr}), timeout ${payload.timeout_min} min`);
      let result = null;
      try {
        active.ghId = await dispatch(gh, ref, "test", payload, sleep);
        log(`watching run ${active.ghId}`);
        result = await finish(gh, active.ghId);
      } catch (e) {
        log(`test of ${id} did not complete: ${e.message}`);
      }
      if (interrupted) break;
      const passed = (result?.status === "success" || result?.status === "success-with-fallback") && result?.clean === true;
      if (!passed) await teardown(active, result !== null);
      active.settled = true;
      const row = {
        at: now(),
        lab: id,
        version: def.version,
        result: passed ? "pass" : "fail",
        clean: result?.clean ?? null,
        leftovers: result?.leftovers ?? null,
        deploySeconds: result?.deploy_seconds ?? null,
        destroySeconds: result?.destroy_seconds ?? null,
        gbp: estimateGbp(def, result?.deploy_seconds ?? null, result?.destroy_seconds ?? null),
        runId: active.ghId,
      };
      appendRow(file, releaseRow(row));
      results.push({ ...row, teardown: active.tornDown });
      log(`${id}: ${row.result}${passed ? "" : ` (teardown: ${active.tornDown})`}`);
    }
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
  return results;
}

/**
 * --check: the permissions labs 1-3 and 6 need (spec §8.1-8.2), read with the
 * local az signed in as the pipeline service principal. Never prints ids.
 */
export async function checkPermissions({ az, log = console.log }) {
  const out = [];
  const note = (name, ok, detail = "") => {
    out.push({ name, ok, detail });
    log(`${ok ? "ok     " : "MISSING"}  ${name}${detail ? ` (${detail})` : ""}`);
  };
  const who = json((await az(["account", "show", "--query", "{type:user.type, name:user.name, sub:id}", "-o", "json"])).stdout) ?? {};
  note("signed in as the pipeline service principal", who.type === "servicePrincipal", who.type === "servicePrincipal" ? "" : "az login --service-principal first");
  const roles = await az(["role", "assignment", "list", "--assignee", String(who.name ?? ""), "--role", "wg-admin labs governance", "--scope", `/subscriptions/${who.sub ?? ""}`, "--query", "[].condition", "-o", "json"]);
  const conds = json(roles.stdout) ?? [];
  note("wg-admin labs governance role, with its condition", roles.status === 0 && conds.length > 0 && conds.some((c) => typeof c === "string" && c.includes("roleAssignments")), conds.length === 0 ? "not assigned" : "");
  for (const [what, path] of [["users", "users"], ["groups", "groups"]]) {
    const r = await az(["rest", "--method", "get", "--url", `https://graph.microsoft.com/v1.0/${path}?$top=1`, "-o", "none"]);
    note(`Graph: read ${what}`, r.status === 0, r.status === 0 ? "" : "grant the Graph application permissions and admin consent");
  }
  const mg = await az(["account", "management-group", "create", "--name", "lab-perm-check", "--display-name", "lab-perm-check", "-o", "none"]);
  if (mg.status === 0) {
    const del = await az(["account", "management-group", "delete", "--name", "lab-perm-check"]);
    note("management groups: create and delete lab-perm-check", del.status === 0, del.status === 0 ? "" : "created but not deleted: delete lab-perm-check by hand");
  } else note("management groups: create and delete lab-perm-check", false, "turn off 'Require write permissions for creating new management groups' (README)");
  return out;
}

// ── Command line ─────────────────────────────────────────────────────────

/** Run a command; capture its output, or show it live (gh run watch). */
function exec(cmd, args, { live = false, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: live ? "inherit" : ["ignore", "pipe", "pipe"], shell });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ status: null, stdout, stderr: e.message }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
// az is a .cmd on Windows, which needs a shell; quote what cmd.exe would split.
const azQuote = (a) => (process.platform === "win32" && /[\s&|<>^()"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const az = (args) => exec(process.platform === "win32" ? "az" : "az", args.map(azQuote), { shell: process.platform === "win32" });
const gh = (args) => exec("gh", args, { live: args[0] === "run" && args[1] === "watch" });

async function main() {
  const defs = labDefs();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), defs);
  } catch (e) {
    const ids = process.argv.slice(2).filter((a) => defs.has(a));
    for (const id of ids) {
      const d = defs.get(id);
      const est = gbpH(d) * ((d.timing.deploy_min + d.timing.destroy_min) / 60);
      console.error(`${id} v${d.version}: about £${est.toFixed(4)} (${d.timing.deploy_min} + ${d.timing.destroy_min} minutes at £${gbpH(d).toFixed(4)}/h; at most ${timeoutMin(d.timing)} minutes)`);
    }
    console.error(`lab-release-test: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (opts.check) {
    const res = await checkPermissions({ az });
    process.exitCode = res.every((r) => r.ok) ? 0 : 1;
    return;
  }
  const results = await runRelease(opts, { gh, defs });
  console.log(`Wrote ${results.length} row(s) to docs/labs/release-tests.md. Commit it.`);
  process.exitCode = results.every((r) => r.result === "pass") ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
