// lab-aws-workflow.test.mjs
//
// Plain English: lab-aws.yml keeps lab.yml's contract (AWS labs spec §5) and
// hands each step only the credentials it needs: R2 by file, wg-admin-labs
// for steps 6-8 and 11-14, wg-admin-deploy for Peer and Unpeer only, never
// Azure's or Cloudflare's keys. lab.yml refuses an AWS lab. The five steps
// copied from lab.yml (which may not change) stay equal to lab.yml's, apart
// from the named substitutions (pre-flight ruling C20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SECRET_ENV } from "../../infra/ci/live-log.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASH, fwd, JQ } from "./fixtures/labs/harness.mjs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const text = read(".github/workflows/lab-aws.yml");
const wf = parse(text);
const steps = Object.values(wf.jobs)[0].steps;
const HELPERS = ["Check out repository", "Mask the AWS account id", "Set up Terraform", "Cache Terraform providers"];
const STEP_NAMES = [...read("shared/labs.ts").matchAll(/\{ n: (\d+), name: "([^"]+)"/g)].map((m) => m[2]);
const step = (name) => steps.find((s) => s.name === name);
const envOf = (s) => Object.keys(s.env ?? {});
const LABS_ROLE_STEPS = ["Plan and scope check", "Apply", "Ready check", "Unblock", "Destroy", "Safety net", "Verify clean"];
const DEPLOY_ROLE_STEPS = ["Peer", "Unpeer"];

test("no tabs; the 16 steps in order, named as LAB_STEPS", () => {
  assert.doesNotMatch(text, /\t/);
  assert.equal(STEP_NAMES.length, 16);
  assert.deepEqual(steps.map((s) => s.name).filter((n) => !HELPERS.includes(n)), STEP_NAMES);
});

test("run name, concurrency and timeout as lab.yml", () => {
  const lab = parse(read(".github/workflows/lab.yml"));
  assert.equal(wf["run-name"], lab["run-name"]);
  assert.deepEqual(wf.concurrency, lab.concurrency);
  assert.equal(Object.values(wf.jobs)[0]["timeout-minutes"], Object.values(lab.jobs)[0]["timeout-minutes"]);
  assert.deepEqual(wf.on.workflow_dispatch.inputs.action.options, ["deploy", "destroy", "peer", "unpeer", "test"]);
  assert.equal(wf.permissions["id-token"], "write");
});

test("Parse payload says aws here and azure in lab.yml", () => {
  assert.equal(step("Check out, Parse payload").env.LAB_WORKFLOW_CLOUD, "aws");
  const lab = parse(read(".github/workflows/lab.yml"));
  assert.equal(Object.values(lab.jobs)[0].steps.find((s) => s.name === "Check out, Parse payload").env.LAB_WORKFLOW_CLOUD, "azure");
});

test("never Azure's keys, the UPN domain, the Cloudflare DNS token or the WireGuard key", () => {
  assert.doesNotMatch(text, /ARM_|LAB_UPN_DOMAIN|CLOUDFLARE_DNS_TOKEN|WG_SERVER_PRIVATE_KEY|AZURE_RESOURCE_GROUP/);
  assert.equal(wf.env.AWS_ACCESS_KEY_ID, undefined);
});

test("wg-admin-labs only in steps 6-8 and 11-14, wg-admin-deploy only in Peer and Unpeer, each through aws-lab-creds.sh", () => {
  for (const s of steps) {
    const labs = envOf(s).includes("AWS_LABS_ROLE_ARN");
    const deploy = envOf(s).includes("AWS_DEPLOY_ROLE_ARN");
    if (s.name === "Mask the AWS account id") continue;
    assert.equal(labs, LABS_ROLE_STEPS.includes(s.name), `${s.name}: wg-admin-labs`);
    assert.equal(deploy, DEPLOY_ROLE_STEPS.includes(s.name), `${s.name}: wg-admin-deploy`);
    if (labs) assert.match(s.run, /^source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-lab-creds\.sh" "\$AWS_LABS_ROLE_ARN"/m);
    if (deploy) assert.match(s.run, /source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-lab-creds\.sh" "\$AWS_DEPLOY_ROLE_ARN" 3600/);
    if (labs || deploy) assert.ok(s.run.indexOf("aws-lab-creds.sh") < s.run.indexOf("live-log.sh"), `${s.name}: credentials before the live log, so its filter hides them`);
  }
});

test("R2 keys never sit in AWS_* beside AWS credentials: init writes them to a file, umask 077", () => {
  const init = step("Terraform init");
  assert.deepEqual(envOf(init).sort(), ["R2_ACCESS_KEY_ID", "R2_BUCKET", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY"]);
  assert.match(init.run, /umask 077; printf 'bucket = "%s"\\naccess_key/);
  assert.match(init.run, /-backend-config="\$RUNNER_TEMP\/r2\.hcl" -backend-config="key=labs\/\$LAB_ID\/terraform\.tfstate"/);
  assert.match(init.run, /lab-lint\.mjs" --cloud aws/);
  for (const s of steps) if (envOf(s).some((k) => k.includes("ROLE_ARN")) && s.name !== "Mask the AWS account id") assert.ok(!envOf(s).includes("AWS_ACCESS_KEY_ID"), s.name);
  assert.deepEqual(envOf(step("Back up state")).filter((k) => k.startsWith("AWS_")).sort(), ["AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL_S3", "AWS_SECRET_ACCESS_KEY"]);
});

test("teardown steps and the report always run; Destroy may fail; the result carries peer_vpc_id and never files", () => {
  for (const n of ["Unpeer", "Unblock", "Destroy", "Safety net", "Verify clean"]) assert.match(step(n).if, /^always\(\)/, n);
  for (const n of ["Unpeer", "Unblock", "Destroy", "Safety net"]) assert.equal(step(n)["continue-on-error"], true, n);
  const report = step("Finish live log, Report result");
  assert.equal(report.if, "always()");
  assert.match(report.run, /peer_vpc_id:\(\$o\.peer_vpc_id \/\/ null\)/);
  assert.doesNotMatch(report.run, /peer_vnet_id/);
  assert.match(report.run, /del\(\.files\)/);
  assert.match(step("Wait for earlier run of this lab").run, /actions\/workflows\/lab-aws\.yml\/runs/);
  assert.match(step("Apply").run, /PEER_ROUTE_TABLE_IDS=/);
});

test("the live log hides the AWS session and both role ARNs", () => {
  for (const k of ["AWS_SESSION_TOKEN", "AWS_LABS_ROLE_ARN", "AWS_DEPLOY_ROLE_ARN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "TF_VAR_admin_password", "CALLBACK_TOKEN"]) assert.ok(SECRET_ENV.includes(k), k);
});

test("every env a step is handed from a secret or GitHub's token is one the live log hides", () => {
  // AWS_ENDPOINT_URL_S3 carries the Cloudflare account id inside the address; secretsFromEnv derives and hides it.
  const derived = ["AWS_ENDPOINT_URL_S3"];
  let n = 0;
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.env ?? {})) {
      if (!/\$\{\{\s*(secrets\.|github\.token)/.test(String(v))) continue;
      n++;
      assert.ok(SECRET_ENV.includes(k) || derived.includes(k), `${s.name}: ${k}`);
    }
  }
  assert.ok(n >= 15, "the secret env entries were found");
});

test("ruling P2: step 16 sends files only beside the result, for a succeeded deploy or test, never in LAB_RESULT or outputs", () => {
  const report = step("Finish live log, Report result");
  assert.match(report.run, /files="\$\(jq -c '\.files\.value \/\/ \{\}' "\$RUNNER_TEMP\/outputs\.json"\)"/);
  assert.match(report.run, /\[ "\$status" = success \] && \{ \[ "\$action" = deploy \] \|\| \[ "\$action" = test \]; \}/);
  assert.match(report.run, /--argjson files "\$files"/);
  assert.match(report.run, /outputs:\{private_ips[^}]*\},\s*files:\$files|files:\$files/);
  assert.match(report.run, /echo "LAB_RESULT \$result"/);
  assert.doesNotMatch(report.run.split('echo "LAB_RESULT')[0].split("result=")[1] ?? "", /files/, "LAB_RESULT never carries files");
});

// Pre-flight ruling C20: lab.yml is frozen, so lab-aws.yml keeps verbatim copies of five of its steps.
test("final fix F4: Apply masks every output but the files, and of the files only their PEM lines (an OpenVPN profile's directives stay readable)", { skip: BASH && JQ ? false : "needs bash and jq (CI has both)" }, () => {
  const run = step("Apply").run;
  const from = run.indexOf("jq -r ");
  const to = run.indexOf("peer_vpc=");
  assert.ok(from > 0 && to > from, "Apply's mask lines");
  const dir = mkdtempSync(join(tmpdir(), "lab-aws-mask-"));
  try {
    const pem = (kind, body) => `-----BEGIN ${kind}-----\n${body.join("\n")}\n-----END ${kind}-----`;
    const ca = pem("CERTIFICATE", ["MIIBszCCAVmgAwIBAgIRAKxyz0123456789abcdefghijk", "AwIBAgIRAKxyz0123456789abcdefghijkMIIBszCCAVmg"]);
    const key = pem("PRIVATE KEY", ["MC4CAQAwBQYDK2VwBCIEIJ+abcdefghijklmnopqrstuvwxyz0123"]);
    const ovpn = ["client", "dev tun", "proto udp", "remote abc.cvpn-endpoint-0a.prod.clientvpn.eu-west-2.amazonaws.com 443", "nobind", "verb 3", "reneg-sec 0", "<ca>", ca, "</ca>", "<key>", key, "</key>", ""].join("\n");
    writeFileSync(join(dir, "outputs.json"), JSON.stringify({
      private_ips: { sensitive: false, type: ["map", "string"], value: { "vm-target": "10.64.0.10" } },
      files: { sensitive: true, type: ["object", {}], value: { "ans-31.ovpn": ovpn, "client.key": key } },
    }));
    const r = spawnSync(BASH, ["-c", run.slice(from, to)], { env: { ...process.env, RUNNER_TEMP: fwd(dir) }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const masked = new Set([...r.stdout.matchAll(/^::add-mask::(.*)$/gm)].map((m) => m[1]));
    assert.ok(masked.has("10.64.0.10"), "a plain output is masked");
    for (const line of ["client", "dev tun", "nobind", "verb 3", "reneg-sec 0", "<ca>", "</ca>", "<key>", "proto udp"]) assert.ok(!masked.has(line), `not masked: ${line}`);
    for (const line of [...ca.split("\n"), ...key.split("\n")]) assert.ok(masked.has(line), `masked: ${line}`);
    assert.ok(![...masked].some((m) => m.includes("\n")), "one line per mask");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the five steps copied from lab.yml equal lab.yml's after the named substitutions", () => {
  const lab = Object.values(parse(read(".github/workflows/lab.yml")).jobs)[0].steps;
  const labStep = (name) => lab.find((s) => s.name === name);
  const swap = (from, to) => (r) => {
    assert.ok(r.includes(from), `lab.yml no longer has ${from}: update lab-aws.yml and this test`);
    return r.split(from).join(to);
  };
  const SUBS = {
    "Collect run secrets": [],
    "Start live log": [],
    "Wait for earlier run of this lab": [swap("actions/workflows/lab.yml/runs", "actions/workflows/lab-aws.yml/runs")],
    "Back up state": [],
    "Finish live log, Report result": [
      swap("jq 'with_entries(.value = .value.value)'", "jq 'del(.files) | with_entries(.value = .value.value)'"),
      swap("peer_vnet_id:($o.peer_vnet_id // null)", "peer_vpc_id:($o.peer_vpc_id // null)"),
      // Ruling P2: a lab's files go beside the result, in the body's own files key.
      swap(
        `if [ -n "\${CALLBACK_URL:-}" ] && [ -n "\${CALLBACK_TOKEN:-}" ]; then\n`,
        `if [ -n "\${CALLBACK_URL:-}" ] && [ -n "\${CALLBACK_TOKEN:-}" ]; then\n` +
          `  files="{}"\n` +
          `  if [ "$status" = success ] && { [ "$action" = deploy ] || [ "$action" = test ]; } && [ -f "$RUNNER_TEMP/outputs.json" ]; then\n` +
          `    files="$(jq -c '.files.value // {}' "$RUNNER_TEMP/outputs.json")"\n` +
          `  fi\n`,
      ),
      swap(`--argjson o "$outputs" --arg gh_run_id`, `--argjson o "$outputs" --argjson files "$files" --arg gh_run_id`),
      swap(`destroy_seconds:$r.destroy_seconds}}')"`, `destroy_seconds:$r.destroy_seconds},\n      files:$files}')"`),
    ],
  };
  for (const [name, subs] of Object.entries(SUBS)) {
    const want = labStep(name);
    const got = step(name);
    assert.equal(got.run, subs.reduce((r, f) => f(r), want.run), `${name}: run`);
    for (const k of ["if", "id", "env", "continue-on-error", "timeout-minutes"]) assert.deepEqual(got[k], want[k], `${name}: ${k}`);
  }
});
