// lab-workflow.test.mjs
//
// Plain English: checks on .github/workflows/lab.yml (labs spec §5) that can be
// made without running it, in the style of wg-workflow.test.mjs: its shape
// (every §5 step, named exactly as shared/labs.ts LAB_STEPS, on the right
// actions), where each secret goes, the order of the steps that must always
// run, and the step scripts themselves run in bash against fakes: Parse
// payload, Collect run secrets without a Worker, and the result report.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { SECRET_ENV } from "../../infra/ci/live-log.mjs";
import { BASH, fwd, JQ, REPO } from "./fixtures/labs/harness.mjs";

const WF = fileURLToPath(new URL("../../.github/workflows/lab.yml", import.meta.url));
const text = readFileSync(WF, "utf8").replace(/\r\n/g, "\n");
const wf = parse(text);
const job = Object.values(wf.jobs)[0];
const steps = job.steps;
const step = (name) => {
  const s = steps.find((x) => x.name === name);
  assert.ok(s, `no step named ${name}`);
  return s;
};

/** LAB_STEPS from shared/labs.ts (TypeScript, so read as text): [{ n, name, on }]. */
const LAB_STEPS = (() => {
  const src = readFileSync(new URL("../../shared/labs.ts", import.meta.url), "utf8");
  const all = ["deploy", "destroy", "peer", "unpeer", "test"];
  return [...src.matchAll(/\{ n: (\d+), name: "([^"]+)", on: (ALL|\[[^\]]*\]) \}/g)].map((m) => ({ n: Number(m[1]), name: m[2], on: m[3] === "ALL" ? all : JSON.parse(m[3]) }));
})();
const lab = (n) => LAB_STEPS.find((s) => s.n === n).name;
const index = (name) => steps.findIndex((s) => s.name === name);

/** Python with PyYAML, which lab-parse.sh uses to read lab.yaml as YAML 1.1 (the runner has it). */
const PY = (() => {
  if (!BASH) return null;
  const r = spawnSync(BASH, ["-c", "for p in python3 python; do if $p -c 'import yaml' >/dev/null 2>&1; then echo $p; exit 0; fi; done; exit 1"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
})();

// ── Structure ────────────────────────────────────────────────────────────

test("lab.yml has no tabs and every §5 step is named", () => {
  assert.ok(!text.includes("\t"));
  assert.equal(LAB_STEPS.length, 16);
  let last = -1;
  for (const s of LAB_STEPS) {
    const found = steps.filter((x) => x.name === s.name);
    assert.equal(found.length, 1, `step ${s.n} "${s.name}" must appear exactly once`);
    const i = index(s.name);
    assert.ok(i > last, `step ${s.n} "${s.name}" is out of order`);
    last = i;
  }
});

test("lab.yml parses as YAML", () => {
  assert.ok(Array.isArray(steps) && steps.length >= 16);
  assert.equal(wf.name, "lab");
  assert.deepEqual(Object.keys(wf.on), ["workflow_dispatch"]);
  assert.deepEqual(wf.on.workflow_dispatch.inputs.action.options, ["deploy", "destroy", "peer", "unpeer", "test"]);
});

test("each §5 step runs only on its actions", () => {
  const all = ["deploy", "destroy", "peer", "unpeer", "test"];
  for (const s of LAB_STEPS) {
    const cond = String(step(s.name).if ?? "");
    if (s.on.length === all.length) {
      for (const a of all) assert.ok(!cond.includes(`'${a}'`), `${s.name} runs on every action, so names none`);
      continue;
    }
    for (const a of all) assert.equal(cond.includes(`'${a}'`), s.on.includes(a), `${s.name}: ${a}`);
  }
});

test("run-name carries action, lab id and run id", () => {
  assert.match(wf["run-name"], /^lab \$\{\{ inputs\.action \}\} \$\{\{ fromJSON\(inputs\.payload\)\.lab_id[^}]*\}\} \$\{\{ fromJSON\(inputs\.payload\)\.run_id[^}]*\}\}$/);
});

test("concurrency group is per lab and action, never cancels", () => {
  assert.match(wf.concurrency.group, /fromJSON\(inputs\.payload\)\.lab_id/);
  assert.match(wf.concurrency.group, /inputs\.action/);
  assert.match(wf.concurrency.group, /^lab-/);
  assert.equal(wf.concurrency["cancel-in-progress"], false);
});

test("timeout-minutes reads timeout_min from the payload", () => {
  assert.equal(job["timeout-minutes"], "${{ fromJSON(inputs.payload).timeout_min || 60 }}");
});

// ── Secrets ──────────────────────────────────────────────────────────────

test("no step sees the Cloudflare DNS token or the WireGuard key", () => {
  for (const banned of ["CLOUDFLARE_DNS_TOKEN", "CLOUDFLARE_API_TOKEN", "WG_SERVER_PRIVATE_KEY", "CLOUDFLARE_ZONE_ID"]) assert.ok(!text.includes(banned), banned);
  // Secrets are handed to steps, never to the whole job or workflow.
  assert.ok(!JSON.stringify(wf.env ?? {}).includes("secrets."));
  assert.ok(!JSON.stringify(job.env ?? {}).includes("secrets."));
  // Ready-made actions never get a secret.
  for (const s of steps.filter((x) => x.uses)) assert.ok(!JSON.stringify(s).includes("secrets."), s.name);
});

test("ARM secrets only in steps 5–14", () => {
  const allowed = LAB_STEPS.filter((s) => s.n >= 5 && s.n <= 14).map((s) => s.name);
  const withArm = steps.filter((s) => JSON.stringify(s.env ?? {}).includes("secrets.ARM_"));
  assert.ok(withArm.length >= 8);
  for (const s of withArm) assert.ok(allowed.includes(s.name), `${s.name} has ARM secrets`);
  for (const s of steps) if (!s.env) assert.ok(!JSON.stringify(s).includes("secrets.ARM_"), s.name);
});

test("the OIDC audience is wg-admin and secrets go to secrets_url", () => {
  const s = step(lab(2));
  assert.match(s.run, /audience=wg-admin/);
  assert.match(s.run, /"\$SECRETS_URL"/);
  assert.match(s.run, /::add-mask::\$v/);
  for (const k of ["callback_token", "admin_password"]) assert.ok(s.run.includes(k), k);
  assert.match(s.run, /put_env CALLBACK_TOKEN/);
  assert.match(s.run, /put_env TF_VAR_admin_password/);
});

test("without secrets_url the run makes its own masked admin password and skips peering", { skip: BASH ? false : "no bash found" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-secrets-"));
  const envFile = join(dir, "env");
  writeFileSync(envFile, "");
  const r = spawnSync(BASH, ["-eo", "pipefail", "-c", step(lab(2)).run], { encoding: "utf8", env: { ...process.env, SECRETS_URL: "", GITHUB_ENV: fwd(envFile), LAB_PEERING: "true" } });
  assert.equal(r.status, 0, r.stderr);
  const env = readFileSync(envFile, "utf8");
  const pw = /^TF_VAR_admin_password<<(EOV_\w+)\n(.*)\n\1$/m.exec(env)?.[2];
  assert.ok(pw && pw.length >= 20, env);
  // Azure's VM password rules: upper, lower, digit and symbol.
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /\d/);
  assert.match(pw, /[^A-Za-z0-9]/);
  assert.match(env, /^LAB_PEERING<<(EOV_\w+)\nfalse\n\1$/m);
  // Masked before anything else could print it, and never printed otherwise.
  const lines = r.stdout.split("\n");
  assert.ok(lines.includes(`::add-mask::${pw}`));
  assert.equal(lines.filter((l) => l.includes(pw)).length, 1);
});

// The live log (infra/ci/live-log.mjs, which this area does not own) hides only
// the env names on its SECRET_ENV. lab.yml's new ones must join that list; until
// the integrator adds them this test is a TODO, so the gap stays visible.
const secretNames = (() => {
  const named = new Set(["CALLBACK_TOKEN", "TF_VAR_admin_password"]); // run secrets, put in $GITHUB_ENV
  for (const s of steps) for (const [k, v] of Object.entries(s.env ?? {})) if (/secrets\./.test(String(v)) && k !== "AWS_ENDPOINT_URL_S3") named.add(k);
  return [...named].sort();
})();
const notHidden = secretNames.filter((k) => !SECRET_ENV.includes(k));
test("every secret lab.yml hands a step is hidden by the live log", () => {
  assert.deepEqual(notHidden, []);
  for (const k of ["TF_VAR_admin_password", "TF_VAR_upn_domain"]) assert.ok(SECRET_ENV.includes(k), k);
});

// ── Payload and step order ───────────────────────────────────────────────

/** A workspace with labs/<id>/lab.yaml (from the repo) and, optionally, a terraform folder. */
function workspace(id = "az104-06-blob-security", { tf = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "lab-ws-"));
  mkdirSync(join(ws, "labs"), { recursive: true });
  cpSync(join(REPO, "labs", id), join(ws, "labs", id), { recursive: true });
  // The real labs carry Terraform; a workspace has either a stub or none at all.
  rmSync(join(ws, "labs", id, "terraform"), { recursive: true, force: true });
  if (tf) {
    mkdirSync(join(ws, "labs", id, "terraform"), { recursive: true });
    writeFileSync(join(ws, "labs", id, "terraform", "main.tf"), "# test\n");
  }
  return ws;
}
const PAYLOAD = {
  lab_id: "az104-06-blob-security",
  version: 1,
  run_id: "lab-deploy-20261004T120000Z-ab12",
  session_id: "ls-20261004T120000Z-cd34",
  region: "uksouth",
  secondary_region: null,
  slot_cidr: "10.64.64.0/18",
  name_prefix: "l06k3x9q",
  peering: true,
  timeout_min: 34,
  callback_url: "https://wg.example.net/api/callback",
  secrets_url: "https://wg.example.net/api/callback/lab-secrets",
};
/** Run lab-parse.sh for `action` and `payload`; returns { status, out, env: { KEY: value } }. */
function runParse(action, payload, ws = workspace()) {
  const dir = mkdtempSync(join(tmpdir(), "lab-parse-"));
  const event = join(dir, "event.json");
  const envFile = join(dir, "env");
  writeFileSync(event, JSON.stringify({ inputs: { action, payload: typeof payload === "string" ? payload : JSON.stringify(payload) } }));
  writeFileSync(envFile, "");
  const r = spawnSync(BASH, ["-eo", "pipefail", fwd(join(REPO, "infra", "ci", "lab-parse.sh"))], {
    encoding: "utf8",
    env: { ...process.env, LAB_PYTHON: PY ?? "", LAB_ACTION_INPUT: action, GITHUB_EVENT_PATH: fwd(event), GITHUB_ENV: fwd(envFile), GITHUB_WORKSPACE: fwd(ws) },
  });
  const env = {};
  for (const m of readFileSync(envFile, "utf8").matchAll(/^(\w+)<<(EOV_\w+)\n([^\n]*)\n\2$/gm)) env[m[1]] = m[3];
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", env };
}
const skipParse = !BASH ? "no bash found" : !PY ? "no Python with PyYAML here (the runner has it)" : false;

test("lab-parse.sh passes bash -n", { skip: BASH ? false : "no bash found" }, () => {
  const r = spawnSync(BASH, ["-n", fwd(join(REPO, "infra", "ci", "lab-parse.sh"))], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(step(lab(1)).run, /infra\/ci\/lab-parse\.sh/);
});

test("Parse payload sets the run's values and the §3.4 Terraform variables", { skip: skipParse }, () => {
  const r = runParse("deploy", PAYLOAD);
  assert.equal(r.status, 0, r.out);
  const e = r.env;
  assert.equal(e.LAB_ID, "az104-06-blob-security");
  assert.equal(e.LAB_VERSION, "1");
  assert.equal(e.WORKER_RUN_ID, PAYLOAD.run_id);
  assert.equal(e.LAB_HAS_TF, "true");
  assert.equal(e.LAB_PEERING, "true");
  assert.equal(e.LAB_DNS_LINK, "true");
  assert.equal(e.LAB_DEPLOY_MIN, "4");
  assert.equal(e.LAB_ENTRA, "true");
  assert.equal(e.CALLBACK_URL, "https://wg.example.net/api/callback/lab");
  assert.equal(e.LAB_PEER_URL, "https://wg.example.net/api/callback/lab-peer");
  assert.equal(e.LIVE_LOG_URL, "https://wg.example.net/api/callback/log");
  assert.equal(e.SECRETS_URL, PAYLOAD.secrets_url);
  assert.equal(e.TF_VAR_lab_id, "az104-06-blob-security");
  assert.equal(e.TF_VAR_resource_group_name, "rg-lab-az104-06-blob-security");
  assert.equal(e.TF_VAR_address_space, "10.64.64.0/18");
  assert.equal(e.TF_VAR_name_prefix, "l06k3x9q");
  assert.equal(e.TF_VAR_region, "uksouth");
  assert.equal(e.TF_VAR_secondary_region, "");
  assert.equal(e.TF_VAR_peered, "true");
  assert.deepEqual(JSON.parse(e.TF_VAR_tags), { project: "wg-admin-labs", lab: "az104-06-blob-security", session: PAYLOAD.session_id });
  // A callback_url that already ends /lab is taken as the result address.
  assert.equal(runParse("deploy", { ...PAYLOAD, callback_url: "https://wg.example.net/api/callback/lab" }).env.LAB_PEER_URL, "https://wg.example.net/api/callback/lab-peer");
});

test("Parse payload refuses a bad lab id, a missing folder and a version that differs from lab.yaml", { skip: skipParse }, () => {
  for (const id of ["../../etc", "az104-06-Blob", "az104-06-x--y", "az104-06-blob-security-", "rm -rf", ""]) {
    const r = runParse("deploy", { ...PAYLOAD, lab_id: id });
    assert.notEqual(r.status, 0, id);
    assert.equal(r.env.LAB_ID, undefined, id);
  }
  const missing = runParse("deploy", { ...PAYLOAD, lab_id: "az104-99-nowhere" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.out, /no labs\/az104-99-nowhere/);
  const stale = runParse("deploy", { ...PAYLOAD, version: 2 });
  assert.notEqual(stale.status, 0);
  assert.match(stale.out, /version 2.*lab\.yaml.*1|stale/i);
  assert.notEqual(runParse("test", { ...PAYLOAD, version: 2 }).status, 0);
  assert.notEqual(runParse("deploy", "not json").status, 0);
  const noTf = runParse("deploy", PAYLOAD, workspace("az104-06-blob-security", { tf: false }));
  assert.notEqual(noTf.status, 0);
  assert.match(noTf.out, /terraform/);
});

test("Parse payload refuses values that could smuggle a line, a slot outside the pool or a foreign URL", { skip: skipParse }, () => {
  for (const bad of [
    { slot_cidr: "10.50.0.0/18" },
    { slot_cidr: "10.64.1.0/18" },
    { slot_cidr: "10.72.0.0/18" },
    { name_prefix: "l07k3x9q" },
    { name_prefix: "L06K3X9Q" },
    { region: "uk south" },
    { run_id: "x\ny" },
    { run_id: "a\"b" },
    { timeout_min: 151 },
    { timeout_min: "60" },
    { peering: "yes" },
    { callback_url: "http://wg.example.net/api/callback" },
    { secrets_url: "https://wg.example.net/x y" },
  ]) {
    const r = runParse("deploy", { ...PAYLOAD, ...bad });
    assert.notEqual(r.status, 0, JSON.stringify(bad));
  }
});

test("a destroy always goes ahead: a stale version is a warning, and a lab gone from the catalogue is cleaned up by name", { skip: skipParse }, () => {
  const stale = runParse("destroy", { ...PAYLOAD, version: 2 });
  assert.equal(stale.status, 0, stale.out);
  assert.match(stale.out, /::warning::/);
  const gone = runParse("destroy", { lab_id: "az104-99-nowhere", run_id: "lab-destroy-1-x", callback_url: "", secrets_url: "" }, workspace());
  assert.equal(gone.status, 0, gone.out);
  assert.equal(gone.env.LAB_ID, "az104-99-nowhere");
  assert.equal(gone.env.LAB_HAS_TF, "false");
  assert.equal(gone.env.LAB_ENTRA, "true", "unknown lab: check Entra strictly");
  // Peering off when the lab says off, whatever the payload asks.
  const off = runParse("deploy", { ...PAYLOAD, lab_id: "az104-05-storage", name_prefix: "l05abcde" }, workspace("az104-05-storage"));
  assert.equal(off.status, 0, off.out);
  assert.equal(off.env.LAB_PEERING, "false");
  assert.equal(off.env.LAB_ENTRA, "false");
});

test("safety net, verify clean, backup and report run with always()", () => {
  for (const n of [10, 11, 12, 13, 14, 15, 16]) assert.match(String(step(lab(n)).if), /always\(\)/, lab(n));
  // But never without a lab id, and never racing an earlier run of the same lab.
  for (const n of [10, 11, 12, 13, 14]) {
    assert.match(String(step(lab(n)).if), /steps\.wait\.outcome == 'success'/, lab(n));
    assert.match(String(step(lab(n)).if), /env\.LAB_ID != ''/, lab(n));
  }
  for (const n of [10, 11, 12, 13]) assert.equal(step(lab(n))["continue-on-error"], true, lab(n));
  assert.match(step(lab(13)).run, /lab-safety-net\.sh" "\$LAB_ID"/);
  assert.match(step(lab(14)).run, /lab-safety-net\.sh" --verify "\$LAB_ID"/);
  assert.match(step(lab(11)).run, /lab-unblock\.sh" "\$LAB_ID"/);
  assert.equal(step(lab(14)).id, "verify");
  assert.equal(step(lab(4)).id, "wait");
});

test("the live log starts after secrets and finishes before the result", () => {
  assert.ok(index(lab(3)) > index(lab(2)));
  const start = step(lab(3));
  assert.match(start.if, /CALLBACK_TOKEN/);
  assert.equal(start["continue-on-error"], true);
  assert.match(start.run, /live-log\.mjs" ship/);
  assert.equal(start.env, undefined);
  const fin = step(lab(16)).run;
  assert.ok(fin.indexOf(".stop") >= 0 && fin.indexOf(".stop") < fin.indexOf("LAB_RESULT") && fin.indexOf(".stop") < fin.indexOf('"$CALLBACK_URL"'));
  // Each step that does work copies its output into the live log, first thing.
  for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    assert.equal(step(lab(n)).run.split("\n")[0], `source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "${lab(n)}"`, lab(n));
  }
});

test("the plan is scope-checked before apply, and apply uses that plan", () => {
  const plan = step(lab(6)).run;
  assert.match(plan, /terraform plan .*-out=/);
  assert.match(plan, /terraform show (-no-color )?-json/);
  assert.match(plan, /node "\$GITHUB_WORKSPACE\/infra\/ci\/lab-scope\.mjs" --plan "\$RUNNER_TEMP\/plan\.json" --lab "\$LAB_ID"/);
  assert.ok(plan.indexOf("terraform plan") < plan.indexOf("lab-scope.mjs"));
  const apply = step(lab(7)).run;
  assert.match(apply, /terraform apply .*"\$RUNNER_TEMP\/plan\.out"/);
  // The public log never shows the outputs block, and every output is masked.
  assert.match(apply, /sed '\/\^Outputs:\/,\$d'/);
  assert.match(apply, /::add-mask::/);
  assert.equal(step(lab(12))["continue-on-error"], true);
  assert.match(step(lab(12)).run, /terraform destroy .*-auto-approve/);
  assert.match(String(step(lab(9)).if), /env\.LAB_PEERING == 'true'/);
});

// ── Results and state ────────────────────────────────────────────────────

test("LAB_RESULT carries clean, leftovers and seconds and never an address", { skip: !BASH ? "no bash found" : !JQ ? "no jq on PATH (the runner has it)" : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-report-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${fwd(join(dir, "curl.args"))}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "outputs.json"), JSON.stringify({ private_ips: { value: { vm: "10.64.64.4" } }, connect: { value: ["ssh azureuser@10.64.64.4"] }, users: { value: { ann: "lab-x-ann@contoso.onmicrosoft.com" } } }));
  const script = step(lab(16)).run;
  assert.ok(!script.includes("${{"), "expressions go through the step's env, not into the script");
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; ${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      JOB_STATUS: "success",
      GITHUB_RUN_ID: "123",
      GH_RUN_URL: "https://github.com/o/r/actions/runs/123",
      FAKE_BIN: fwd(bin),
      RUNNER_TEMP: fwd(dir),
      LAB_ACTION: "test",
      LAB_ID: "az104-07-files",
      LAB_VERSION: "1",
      WORKER_RUN_ID: "lab-test-1-x",
      CALLBACK_URL: "https://wg.example.net/api/callback/lab",
      CALLBACK_TOKEN: "tok-abcdef",
      LAB_DEPLOY_SECONDS: "212",
      LAB_DESTROY_SECONDS: "140",
      VERIFY_CLEAN: "true",
      VERIFY_LEFTOVERS: "[]",
      DESTROY_OUTCOME: "success",
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = r.stdout.split("\n").find((l) => l.startsWith("LAB_RESULT "));
  assert.ok(line, r.stdout);
  const result = JSON.parse(line.slice("LAB_RESULT ".length));
  assert.deepEqual(result, { lab_id: "az104-07-files", version: 1, action: "test", run_id: "lab-test-1-x", status: "success", clean: true, leftovers: [], deploy_seconds: 212, destroy_seconds: 140 });
  assert.ok(!/\d+\.\d+\.\d+\.\d+|contoso/.test(line));
  // The Worker gets the outputs (over HTTPS, with the run's token), the public log does not.
  const args = readFileSync(join(dir, "curl.args"), "utf8");
  const body = JSON.parse(args.split("\n")[args.split("\n").indexOf("-d") + 1]);
  assert.equal(body.run_id, "lab-test-1-x");
  assert.equal(body.status, "success");
  assert.deepEqual(body.outputs.private_ips, { vm: "10.64.64.4" });
  assert.deepEqual(body.outputs.connect, ["ssh azureuser@10.64.64.4"]);
  assert.equal(body.outputs.clean, true);
  assert.deepEqual(body.outputs.leftovers, []);
  assert.equal(body.outputs.deploy_seconds, 212);
  assert.equal(body.outputs.destroy_seconds, 140);
  assert.match(args, /^https:\/\/wg\.example\.net\/api\/callback\/lab$/m);
});

test("the lab's Terraform text is linted before anything of Terraform runs (init downloads providers, plan runs data sources)", () => {
  const init = step(lab(5)).run;
  assert.match(init, /node "\$GITHUB_WORKSPACE\/infra\/ci\/lab-lint\.mjs" "\$GITHUB_WORKSPACE\/labs\/\$LAB_ID\/terraform"/);
  assert.match(init, /set -euo pipefail/);
  const lint = init.indexOf("lab-lint.mjs");
  assert.ok(lint < init.indexOf("az bicep build") && lint < init.indexOf("terraform init"));
  // No step before init touches Terraform; init runs for deploy, destroy and test alike.
  for (const s of steps.slice(0, index(lab(5)))) assert.ok(!/\bterraform (init|plan|apply|destroy)\b/.test(s.run ?? ""), s.name);
  for (const a of ["deploy", "destroy", "test"]) assert.ok(String(step(lab(5)).if).includes(`'${a}'`), a);
});

test("bicep files are built before init", () => {
  const init = step(lab(5)).run;
  assert.match(init, /az bicep build --file "\$f"/);
  assert.ok(init.indexOf("az bicep build") < init.indexOf("terraform init"));
});

test("state key is labs/<id>/terraform.tfstate and backups keep 5", () => {
  assert.match(step(lab(5)).run, /-backend-config="key=labs\/\$LAB_ID\/terraform\.tfstate"/);
  const backup = step(lab(15)).run;
  assert.match(backup, /s3:\/\/\$R2_BUCKET\/labs\/\$LAB_ID\/backups\//);
  assert.match(backup, /head -n -5/);
  assert.equal(step(lab(15))["continue-on-error"], true);
});

test("destroy waits a while for the state lock; once verified clean, the backed-up state and any stale lock are removed from R2", () => {
  assert.match(step(lab(12)).run, /terraform destroy .*-lock-timeout=\d+m/);
  const s = step(lab(15));
  assert.equal(s.env.VERIFY_CLEAN, "${{ steps.verify.outputs.clean }}");
  assert.match(s.run, /bash "\$GITHUB_WORKSPACE\/infra\/ci\/lab-state-reset\.sh" "\$LAB_ID"/);
  // After the backup, and even when this run opened no Terraform state (init never ran).
  assert.ok(s.run.indexOf("lab-state-reset.sh") > s.run.indexOf("terraform state pull"));
  assert.ok(!/^\s*exit 0\s*$/m.test(s.run.slice(0, s.run.indexOf("lab-state-reset.sh"))), "no early exit skips the reset");
  // Verify clean runs before it.
  assert.ok(index(lab(14)) < index(lab(15)));
});

test("the state reset runs only on a verified-clean lab, and removes the state and its .tflock", { skip: BASH ? false : "no bash found" }, async () => {
  const { world } = await import("./fixtures/labs/harness.mjs");
  const ID = "az104-06-blob-security";
  const w = world();
  const clean = w.run("infra/ci/lab-state-reset.sh", [ID], { VERIFY_CLEAN: "true", R2_BUCKET: "wg-admin-state" });
  assert.equal(clean.status, 0, clean.out);
  assert.deepEqual(w.calls().filter((c) => c.startsWith("aws ")), [
    `aws s3 rm s3://wg-admin-state/labs/${ID}/terraform.tfstate --only-show-errors`,
    `aws s3 rm s3://wg-admin-state/labs/${ID}/terraform.tfstate.tflock --only-show-errors`,
  ]);
  w.cleanup();
  for (const v of ["false", "", undefined]) {
    const n = world();
    const r = n.run("infra/ci/lab-state-reset.sh", [ID], { VERIFY_CLEAN: v ?? "", R2_BUCKET: "wg-admin-state" });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(n.calls(), [], `VERIFY_CLEAN=${v}`);
    n.cleanup();
  }
  const bad = world();
  assert.equal(bad.run("infra/ci/lab-state-reset.sh", ["../wg-admin"], { VERIFY_CLEAN: "true", R2_BUCKET: "b" }).status, 2);
  assert.deepEqual(bad.calls(), []);
  bad.cleanup();
  // A failed delete is a warning, never a failed run.
  const flaky = world([{ cmd: "aws", match: "tflock", code: 1, err: "AccessDenied" }]);
  const f = flaky.run("infra/ci/lab-state-reset.sh", [ID], { VERIFY_CLEAN: "true", R2_BUCKET: "b" });
  assert.equal(f.status, 0);
  assert.match(f.out, /::warning::could not remove labs\/az104-06-blob-security\/terraform\.tfstate\.tflock/);
  flaky.cleanup();
});

test("the wait step looks only at earlier lab.yml runs of the same lab, for 10 minutes at most", () => {
  const s = step(lab(4));
  assert.equal(s["timeout-minutes"], 10);
  assert.match(s.run, /actions\/workflows\/lab\.yml\/runs/);
  assert.match(s.run, /\.id < \$GITHUB_RUN_ID/);
  assert.match(s.run, /display_title/);
  assert.match(s.run, /\$LAB_ID/);
});
