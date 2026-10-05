// lab-release.test.mjs
//
// Plain English: scripts/lab-release-test.mjs, the real-Azure release test
// for a lab version (labs spec §11.2) run from Steven's PC. It dispatches
// lab.yml with action "test" (deploy then destroy in one run), waits, reads
// LAB_RESULT from the run's log and adds a row to docs/labs/release-tests.md.
// It costs money, so it refuses to start without --confirm-cost, and it
// always makes sure the lab is torn down: a failed, dirty or interrupted test
// dispatches a destroy run. Here gh and az are fakes.

import { test } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotCidr } from "../lib/labs.mjs";
import { buildPayload, checkPermissions, estimateGbp, labDefs, parseArgs, parseLabResult, releaseRow, runRelease, timeoutMin } from "../lab-release-test.mjs";

const DEFS = labDefs();
const lab7 = DEFS.get("az104-07-files");

/** A fake gh: records calls; dispatches get a run id; `results` maps "<action> <lab>" to the LAB_RESULT the run prints. */
function fakeGh({ results = {}, watch = () => 0, failDispatch = false } = {}) {
  const calls = [];
  const runs = [];
  const gh = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "workflow" && args[1] === "run") {
      if (failDispatch) return { status: 1, stdout: "", stderr: "HTTP 404" };
      const payload = JSON.parse(args[args.indexOf("-f", args.indexOf("-f") + 1) + 1].replace(/^payload=/, ""));
      const action = args.find((a) => a.startsWith("action=")).slice(7);
      runs.push({ id: 9000 + runs.length, title: `lab ${action} ${payload.lab_id} ${payload.run_id}`, action, lab: payload.lab_id });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "run" && args[1] === "list") return { status: 0, stdout: JSON.stringify(runs.map((r) => ({ databaseId: r.id, displayTitle: r.title, status: "in_progress" }))), stderr: "" };
    if (args[0] === "run" && args[1] === "watch") return watch(args[2], runs);
    if (args[0] === "run" && args[1] === "view") {
      const r = runs.find((x) => String(x.id) === args[2]);
      const res = results[`${r.action} ${r.lab}`];
      const lines = ['lab\tFinish live log, Report result\t2026-10-04T12:00:00Z echo "LAB_RESULT $result"'];
      if (res) lines.push(`lab\tFinish live log, Report result\t2026-10-04T12:00:01Z LAB_RESULT ${JSON.stringify(res)}`);
      return { status: 0, stdout: lines.join("\n"), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { gh, calls, runs };
}
const pass = (id, extra = {}) => ({ lab_id: id, version: 1, action: "test", run_id: "x", status: "success", clean: true, leftovers: [], deploy_seconds: 300, destroy_seconds: 180, ...extra });
const deps = (gh, file) => ({ gh, log: () => {}, sleep: async () => {}, now: () => new Date("2026-10-04T12:00:00Z"), file });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "lab-release-")), "release-tests.md");

test("builds the payload with the slot CIDR and timeout", () => {
  const p = buildPayload(lab7, { slot: 31, region: "uksouth", runId: "lab-test-20261004T120000Z-ab12", namePrefix: "l07abcde" });
  assert.deepEqual(p, {
    lab_id: "az104-07-files",
    version: lab7.version,
    run_id: "lab-test-20261004T120000Z-ab12",
    session_id: "ls-release-lab-test-20261004T120000Z-ab12",
    region: "uksouth",
    secondary_region: null,
    slot_cidr: "10.71.192.0/18",
    name_prefix: "l07abcde",
    peering: false,
    timeout_min: timeoutMin(lab7.timing),
    callback_url: "",
    secrets_url: "",
  });
  assert.equal(p.slot_cidr, slotCidr(31));
  // The contract's sessionTimeoutMin: min(150, 2 x (deploy + destroy) + 20).
  assert.equal(timeoutMin({ deploy_min: 5, destroy_min: 3 }), 36);
  assert.equal(timeoutMin({ deploy_min: 35, destroy_min: 20 }), 130);
  assert.equal(timeoutMin({ deploy_min: 60, destroy_min: 30 }), 150);
  // A fresh, valid name prefix each time when none is given.
  assert.match(buildPayload(lab7, { slot: 31, region: "uksouth", runId: "r" }).name_prefix, /^l07[a-z0-9]{5}$/);
});

test("parses LAB_RESULT", () => {
  const log = [
    "lab\tFinish live log, Report result\t2026-10-04T12:00:00.1Z echo \"LAB_RESULT $result\"",
    `lab\tFinish live log, Report result\t2026-10-04T12:00:00.2Z LAB_RESULT ${JSON.stringify(pass("az104-07-files"))}`,
  ].join("\r\n");
  assert.deepEqual(parseLabResult(log), pass("az104-07-files"));
  assert.equal(parseLabResult("no result here"), null);
  assert.equal(parseLabResult("x LAB_RESULT {not json"), null);
});

test("refuses an unknown lab id, and refuses to spend without --confirm-cost", async () => {
  assert.throws(() => parseArgs(["az104-99-nothing", "--confirm-cost"], DEFS), /unknown lab id az104-99-nothing/);
  assert.throws(() => parseArgs(["../x", "--confirm-cost"], DEFS), /unknown lab id/);
  assert.throws(() => parseArgs(["az104-07-files"], DEFS), /--confirm-cost/);
  assert.throws(() => parseArgs(["az104-07-files", "--slot", "32", "--confirm-cost"], DEFS), /slot/);
  assert.throws(() => parseArgs([], DEFS), /lab id/);
  const a = parseArgs(["az104-07-files", "az104-05-storage", "--ref", "feat/labs", "--slot", "30", "--confirm-cost"], DEFS);
  assert.deepEqual(a.ids, ["az104-07-files", "az104-05-storage"]);
  assert.equal(a.ref, "feat/labs");
  assert.equal(a.slot, 30);
  assert.equal(parseArgs(["az104-07-files", "--confirm-cost"], DEFS).slot, 31);
  // --check alone spends nothing, so needs no confirmation.
  assert.equal(parseArgs(["--check"], DEFS).check, true);
});

test("writes one row per lab", async () => {
  const file = tmpFile();
  const { gh, calls } = fakeGh({ results: { "test az104-07-files": pass("az104-07-files"), "test az104-05-storage": pass("az104-05-storage", { deploy_seconds: 200, destroy_seconds: 100 }) } });
  const out = await runRelease({ ids: ["az104-07-files", "az104-05-storage"], ref: "feat/labs", slot: 31, region: "uksouth" }, deps(gh, file));
  assert.deepEqual(out.map((r) => [r.lab, r.result, r.clean]), [["az104-07-files", "pass", true], ["az104-05-storage", "pass", true]]);
  const text = readFileSync(file, "utf8");
  const rows = text.split("\n").filter((l) => /^\| 20\d\d-/.test(l));
  assert.equal(rows.length, 2);
  assert.match(rows[0], /\| az104-07-files \| 1 \| pass \| yes \| none \| 5m 0s \| 3m 0s \| £\d+\.\d{4} \|/);
  assert.match(text, /^\| Date \(UTC\) \| Lab \| Version \| Result \| Clean \| Leftovers \| Deploy \| Destroy \| Est\. £ \| Run \|$/m);
  // Each test is dispatched on the given ref with action test, one after the other, and nothing else is dispatched.
  const dispatches = calls.filter((c) => c.startsWith("workflow run lab.yml"));
  assert.equal(dispatches.length, 2);
  for (const d of dispatches) assert.match(d, /^workflow run lab\.yml --ref feat\/labs -f action=test -f payload=\{/);
  // A second run appends below, keeping the header once.
  await runRelease({ ids: ["az104-07-files"], ref: "feat/labs", slot: 31, region: "uksouth" }, deps(gh, file));
  const again = readFileSync(file, "utf8");
  assert.equal(again.match(/^\| Date \(UTC\)/gm).length, 1);
  assert.equal(again.split("\n").filter((l) => /^\| 20\d\d-/.test(l)).length, 3);
});

test("a failed or dirty test is always followed by a destroy run, and recorded as fail", async () => {
  const file = tmpFile();
  const { gh, calls } = fakeGh({
    results: { "test az104-07-files": pass("az104-07-files", { status: "failure", clean: false, leftovers: ["rg-lab-az104-07-files"] }), "destroy az104-07-files": { ...pass("az104-07-files"), action: "destroy" } },
  });
  const out = await runRelease({ ids: ["az104-07-files"], ref: "feat/labs", slot: 31, region: "uksouth" }, deps(gh, file));
  assert.equal(out[0].result, "fail");
  assert.equal(out[0].teardown, "clean");
  const destroy = calls.filter((c) => c.startsWith("workflow run lab.yml") && c.includes("action=destroy"));
  assert.equal(destroy.length, 1);
  assert.match(readFileSync(file, "utf8"), /\| fail \| no \| rg-lab-az104-07-files \|/);
});

test("a test whose result cannot be read (watch fails, no LAB_RESULT) still tears down", async () => {
  const file = tmpFile();
  const { gh, calls } = fakeGh({ results: {}, watch: () => ({ status: 1, stdout: "", stderr: "run failed" }) });
  const out = await runRelease({ ids: ["az104-07-files"], ref: "feat/labs", slot: 31, region: "uksouth" }, deps(gh, file));
  assert.equal(out[0].result, "fail");
  assert.ok(calls.some((c) => c.startsWith("workflow run lab.yml") && c.includes("action=destroy")));
  // The test run is cancelled first, so the destroy does not wait behind it.
  assert.ok(calls.findIndex((c) => c.startsWith("run cancel")) < calls.findIndex((c) => c.includes("action=destroy")));
});

test("an interrupt (Ctrl-C) mid-test cancels the run and dispatches the destroy before exiting", async () => {
  const file = tmpFile();
  let release;
  const { gh, calls } = fakeGh({ watch: (id) => (id === "9000" ? new Promise((r) => (release = r)) : { status: 0, stdout: "", stderr: "" }) });
  const exits = [];
  const signals = new EventEmitter();
  const d = { ...deps(gh, file), exit: (code) => exits.push(code), signals };
  const running = runRelease({ ids: ["az104-07-files"], ref: "feat/labs", slot: 31, region: "uksouth" }, d);
  while (!calls.some((c) => c.startsWith("run watch"))) await new Promise((r) => setTimeout(r, 5));
  signals.emit("SIGINT");
  while (!exits.length) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(exits, [130]);
  assert.ok(calls.some((c) => c.startsWith("run cancel 9000")));
  assert.ok(calls.some((c) => c.includes("action=destroy")));
  release({ status: 1, stdout: "", stderr: "" });
  await running.catch(() => {});
});

test("an estimate in pounds from the lab's hourly price and the real durations", () => {
  const items = [{ name: "a", gbp_h: 0.5 }, { name: "b", gbp_h: 0.25, qty: 2 }];
  assert.equal(estimateGbp({ cost: { items } }, 1800, 1800), 1);
  assert.equal(estimateGbp({ cost: { items } }, null, null), null);
  const row = releaseRow({ at: new Date("2026-10-04T12:34:00Z"), lab: "az104-07-files", version: 2, result: "pass", clean: true, leftovers: [], deploySeconds: 61, destroySeconds: null, gbp: 0.00123, runId: 42 });
  assert.equal(row, "| 2026-10-04 12:34 | az104-07-files | 2 | pass | yes | none | 1m 1s | — | £0.0012 | 42 |");
});

test("--check reports each permission from fake az output", async () => {
  const answers = {
    "account show": { status: 0, stdout: JSON.stringify({ type: "servicePrincipal", name: "11111111-2222-3333-4444-555555555555", sub: "00000000-0000-0000-0000-000000000000" }) },
    "role assignment": { status: 0, stdout: JSON.stringify(["((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR (...))"]) },
    "rest --method get --url https://graph.microsoft.com/v1.0/users?$top=1": { status: 0, stdout: "" },
    "rest --method get --url https://graph.microsoft.com/v1.0/groups?$top=1": { status: 1, stdout: "", stderr: "Forbidden" },
    "account management-group create": { status: 0, stdout: "" },
    "account management-group delete": { status: 0, stdout: "" },
  };
  const calls = [];
  const az = async (args) => {
    const j = args.join(" ");
    calls.push(j);
    const k = Object.keys(answers).find((x) => j.startsWith(x));
    return k ? { stderr: "", ...answers[k] } : { status: 0, stdout: "", stderr: "" };
  };
  const lines = [];
  const res = await checkPermissions({ az, log: (l) => lines.push(l) });
  assert.deepEqual(res.map((r) => [r.name, r.ok]), [
    ["signed in as the pipeline service principal", true],
    ["wg-admin labs governance role, with its condition", true],
    ["Graph: read users", true],
    ["Graph: read groups", false],
    ["management groups: create and delete lab-perm-check", true],
  ]);
  assert.ok(calls.some((c) => c.startsWith("role assignment list --assignee 11111111-2222-3333-4444-555555555555 --role wg-admin labs governance --scope /subscriptions/00000000-0000-0000-0000-000000000000")));
  assert.ok(calls.indexOf("account management-group delete --name lab-perm-check") > calls.findIndex((c) => c.startsWith("account management-group create --name lab-perm-check")));
  // Never prints the subscription id or the app id.
  assert.ok(!lines.join("\n").includes("00000000-0000-0000-0000-000000000000"));
  assert.ok(!lines.join("\n").includes("11111111-2222"));

  const user = await checkPermissions({ az: async (args) => (args[0] === "account" && args[1] === "show" ? { status: 0, stdout: JSON.stringify({ type: "user", name: "steven@contoso.onmicrosoft.com", sub: "s" }) } : { status: 0, stdout: "[]" }), log: () => {} });
  assert.equal(user[0].ok, false);
});
