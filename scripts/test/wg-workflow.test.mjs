// wg-workflow.test.mjs
//
// Plain English: checks on .github/workflows/wg.yml that can be made without
// running it. The file must still be valid YAML (parsed with Python's yaml,
// as ci.yml does for cloud-init, when Python is there), and the live log must
// be wired in the right places: started once the callback token is known,
// copied from the steps that matter, flushed before the result is reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WF = fileURLToPath(new URL("../../.github/workflows/wg.yml", import.meta.url));
const text = readFileSync(WF, "utf8");

/** The steps, parsed by a real YAML parser when one is available. */
function parsedSteps() {
  for (const py of ["python3", "python"]) {
    const r = spawnSync(py, ["-c", "import sys, json, yaml; d = yaml.safe_load(open(sys.argv[1], encoding='utf-8')); print(json.dumps(d['jobs']['terraform']['steps']))", WF], { encoding: "utf8" });
    if (r.status === 0) return JSON.parse(r.stdout);
    if (r.stderr && /yaml|Error/.test(r.stderr) && !/No module named|not found|not recognized/.test(r.stderr)) throw new Error(`wg.yml does not parse: ${r.stderr}`);
  }
  return null;
}
const steps = parsedSteps();
const noYaml = steps ? false : "no Python with PyYAML here";

/** Steps whose output goes to the live log. */
const STREAMED = ["Wait for any earlier wg run to finish", "terraform init (state in R2)", "terraform apply", "terraform destroy", "Verify Azure is clean (fallback delete)", "Park DNS record", "Back up state"];

test("wg.yml has no tabs and every step still has a name", () => {
  assert.ok(!text.includes("\t"));
  const names = [...text.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  for (const n of [...STREAMED, "Start live log", "Finish live log", "Report result to the Worker"]) assert.ok(names.includes(n), `missing step ${n}`);
});

test("wg.yml parses as YAML", { skip: noYaml }, () => {
  assert.ok(Array.isArray(steps) && steps.length > 10);
});

test("the live log starts once the run's callback token is known, and never fails the job", { skip: noYaml }, () => {
  const names = steps.map((s) => s.name);
  const start = steps.find((s) => s.name === "Start live log");
  assert.ok(names.indexOf("Start live log") > names.indexOf("Collect run secrets from the Worker"));
  assert.ok(names.indexOf("Start live log") < names.indexOf("Wait for any earlier wg run to finish"));
  assert.equal(start["continue-on-error"], true);
  assert.match(start.if, /CALLBACK_TOKEN/);
  assert.match(start.run, /live-log\.mjs" ship/);
  assert.match(start.run, /nohup/);
  assert.match(start.run, /LIVE_LOG_FILE=.*GITHUB_ENV/);
  assert.match(start.run, /LIVE_LOG_PID=.*GITHUB_ENV/);
  // It gets no repository secrets of its own.
  assert.equal(start.env, undefined);
});

test("each step that matters copies its output into the live log under its own name, first thing", { skip: noYaml }, () => {
  for (const name of STREAMED) {
    const s = steps.find((x) => x.name === name);
    const first = s.run.split("\n")[0];
    assert.equal(first, `source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "${name}"`, name);
  }
});

test("the last lines are sent before the result is reported, even after a failure, and the shipper is stopped", { skip: noYaml }, () => {
  const names = steps.map((s) => s.name);
  const fin = steps.find((s) => s.name === "Finish live log");
  assert.ok(names.indexOf("Finish live log") > names.indexOf("Back up state"));
  assert.ok(names.indexOf("Finish live log") < names.indexOf("Report result to the Worker"));
  assert.match(fin.if, /always\(\)/);
  assert.equal(fin["continue-on-error"], true);
  assert.match(fin.run, /\.stop/);
  assert.match(fin.run, /kill/);
});
