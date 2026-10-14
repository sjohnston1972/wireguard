// wg-aws-workflow.test.mjs
//
// Plain English: wg-aws.yml: AWS in by role (no keys), R2 by file, the same shape as wg.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const aws = YAML.parse(readFileSync(".github/workflows/wg-aws.yml", "utf8"));
const az = YAML.parse(readFileSync(".github/workflows/wg.yml", "utf8"));
const steps = aws.jobs.terraform.steps;
const step = (n) => steps.find((s) => s.name === n) ?? assert.fail(`missing step ${n}`);

test("same inputs, run-name, concurrency and permissions as wg.yml", () => {
  assert.deepEqual(Object.keys(aws.on.workflow_dispatch.inputs), Object.keys(az.on.workflow_dispatch.inputs));
  assert.equal(aws["run-name"], az["run-name"]);
  assert.deepEqual(aws.concurrency, az.concurrency);
  assert.equal(aws.permissions["id-token"], "write");
  assert.equal(aws.jobs.terraform.defaults.run["working-directory"], "infra/aws");
});

test("no Azure, no AWS keys: the role and a web identity token", () => {
  for (const s of steps) {
    const env = s.env ?? {};
    assert.ok(!Object.keys(env).some((k) => k.startsWith("ARM_")), `${s.name} has ARM_*`);
  }
  for (const n of ["terraform apply", "terraform destroy", "Verify AWS is clean (fallback delete)"]) {
    const env = step(n).env ?? {};
    assert.ok(!("AWS_ACCESS_KEY_ID" in env), `${n} must not carry access keys`);
    assert.match(String(env.AWS_ROLE_ARN), /secrets\.AWS_DEPLOY_ROLE_ARN/);
    assert.match(step(n).run, /source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-token\.sh"/);
  }
});

test("R2 state credentials go in by file, never as AWS_* variables", () => {
  const init = step("terraform init (state in R2)");
  assert.ok(!("AWS_ACCESS_KEY_ID" in (init.env ?? {})));
  assert.match(init.run, /-backend-config="\$RUNNER_TEMP\/r2\.hcl"/);
});

test("streamed steps start the live log; destroy steps only on destroy", () => {
  for (const n of ["terraform init (state in R2)", "Build boot bundle", "terraform apply", "terraform destroy", "Verify AWS is clean (fallback delete)", "Park DNS record", "Back up state"]) {
    assert.equal(step(n).run.split("\n")[0], `source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "${n}"`);
  }
  for (const n of ["terraform destroy", "Verify AWS is clean (fallback delete)", "Park DNS record"]) assert.equal(step(n).if, "inputs.action == 'destroy'");
  assert.equal(step("Build boot bundle").if, "inputs.action == 'apply'");
  const names = steps.map((s) => s.name);
  assert.ok(names.indexOf("Build boot bundle") < names.indexOf("terraform apply"));
});

test("the safety net frees the ENI before the security groups and subnets", () => {
  const sh = readFileSync("infra/ci/aws-safety-net.sh", "utf8").replace(/\r\n/g, "\n");
  const at = (re) => sh.search(re);
  assert.ok(at(/disassociate-address/) > 0);
  assert.ok(at(/disassociate-address/) < at(/release-address/));
  assert.ok(at(/release-address/) < at(/delete-network-interface/));
  assert.ok(at(/delete-network-interface/) < at(/delete-security-group/));
  assert.ok(at(/delete-network-interface/) < at(/delete-subnet/));
  assert.match(sh, /describe-network-interfaces/);
});

test("the callback reports success-with-fallback only for a good job whose destroy step failed", () => {
  const run = step("Report result to the Worker").run;
  const line = run.split(String.fromCharCode(10)).find((l) => l.includes("success-with-fallback")) ?? assert.fail("no fallback status line");
  assert.match(line, /job.status/);
  assert.match(line, /steps.destroy.outcome/);
});

// Run the real safety net against a stub `aws` that finds nothing, optionally failing one final-check look.
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
function runNet(failVolumesFinal) {
  const dir = mkdtempSync(join(tmpdir(), "net-")).replaceAll("\\", "/");
  const stub = `#!/usr/bin/env bash
case "$*" in
  *describe-volumes*)
    n=$(cat "${dir}/vol" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/vol"
    if [ "${failVolumesFinal ? 1 : 0}" = 1 ] && [ "$n" -ge 1 ]; then echo "stub: describe-volumes failed" >&2; exit 255; fi ;;
esac
exit 0
`;
  writeFileSync(`${dir}/aws`, stub);
  chmodSync(`${dir}/aws`, 0o755);
  const script = join(process.cwd(), "infra/ci/aws-safety-net.sh").replaceAll("\\", "/");
  return spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
}

test("safety net: a failed look in the final check is a failure, never 'AWS clean'", { skip: !hasBash && "no bash here" }, () => {
  const bad = runNet(true);
  assert.notEqual(bad.status, 0);
  assert.ok(!bad.stdout.includes("AWS clean"));
  const good = runNet(false);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /AWS clean/);
});
