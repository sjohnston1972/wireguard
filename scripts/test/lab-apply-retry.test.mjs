// lab-apply-retry.test.mjs
//
// Plain English: Azure sometimes drops a connection mid-apply ("HTTP response
// was nil; connection may have been reset") with nothing wrong in the lab.
// lab.yml's Apply and Destroy steps (infra/ci/lab-tf-run.sh) then try again,
// but only for those transport errors (infra/ci/lab-transient.mjs), never for
// a 4xx such as a quota, validation or authorization refusal, and a retried
// apply always goes through a fresh plan and the scope check first: a saved
// plan cannot be applied twice, and nothing is ever applied unchecked.
// The scripts run in bash against a fake terraform (fixtures/labs/harness.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { BASH, fwd, REPO, world } from "./fixtures/labs/harness.mjs";
import { withAfterUnknown } from "./fixtures/labs/plans/realistic.mjs";
import { transientFailure } from "../../infra/ci/lab-transient.mjs";

const skip = BASH ? false : "no bash found";

// ── What counts as transient ─────────────────────────────────────────────

/** A Terraform -no-color diagnostic as apply prints it: summary, then where it came from. */
const diag = (msg, address = "azurerm_network_security_rule.allow_out", name = "AllowSshRdpOutbound") =>
  `Error: ${msg}\n\n  with ${address},\n  on main.tf line 40, in resource "${address.split(".")[0]}" "${address.split(".")[1]}":\n  40: resource "${address.split(".")[0]}" "${address.split(".")[1]}" {\n  41:   name = "${name}"\n`;

const NSG_RESET = diag(
  'creating Security Rule (Subscription: "00000000-0000-0000-0000-000000000000"\nResource Group Name: "rg-lab-az104-06-blob-security"\nNetwork Security Group Name: "nsg-lab"\nSecurity Rule Name: "AllowSshRdpOutbound"): performing CreateOrUpdate: Put "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lab-az104-06-blob-security/providers/Microsoft.Network/networkSecurityGroups/nsg-lab/securityRules/AllowSshRdpOutbound?api-version=2025-01-01": HTTP response was nil; connection may have been reset',
);
const NIC_RESET = diag(
  'creating Network Interface (Subscription: "00000000-0000-0000-0000-000000000000"\nResource Group Name: "rg-lab-az104-06-blob-security"\nNetwork Interface Name: "nic-vm1"): performing CreateOrUpdate: Put "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-lab-az104-06-blob-security/providers/Microsoft.Network/networkInterfaces/nic-vm1?api-version=2025-01-01": read tcp 10.1.0.4:51234->4.150.240.10:443: read: connection reset by peer',
  "azurerm_network_interface.vm1",
  "nic-vm1",
);
const QUOTA = diag(
  'creating Linux Virtual Machine (Subscription: "00000000-0000-0000-0000-000000000000"\nResource Group Name: "rg-lab-az104-06-blob-security"\nVirtual Machine Name: "vm1"): performing CreateOrUpdate: unexpected status 409 (409 Conflict) with error: OperationNotAllowed: Operation could not be completed as it results in exceeding approved standardBSFamily Cores quota.',
  "azurerm_linux_virtual_machine.vm1",
  "vm1",
);
const VALIDATION = diag(
  'creating Storage Account (Subscription: "00000000-0000-0000-0000-000000000000"\nResource Group Name: "rg-lab-az104-06-blob-security"\nStorage Account Name: "stlab"): performing Create: unexpected status 400 (400 Bad Request) with error: InvalidParameter: The parameter is invalid.',
  "azurerm_storage_account.lab",
  "stlab",
);

test("Azure transport errors are transient: the two seen in release tests and the rest of the list", () => {
  for (const text of [
    NSG_RESET,
    NIC_RESET,
    diag('performing CreateOrUpdate: Put "https://management.azure.com/x": net/http: TLS handshake timeout'),
    diag('performing CreateOrUpdate: Put "https://management.azure.com/x": dial tcp 4.150.240.10:443: i/o timeout'),
    diag('performing CreateOrUpdate: Put "https://management.azure.com/x": unexpected EOF'),
    diag("performing CreateOrUpdate: unexpected status 429 (429 Too Many Requests) with error: TooManyRequests: Too many requests, retry later."),
    diag("waiting for the creation: RetryableError: the operation can be retried"),
    diag('performing CreateOrUpdate: Put "https://management.azure.com/x": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'),
    // Both resources failing on the connection is still only the connection.
    `${NSG_RESET}\n${NIC_RESET}`,
    // As the live log may see it: with Terraform's box drawing and Windows line ends.
    NSG_RESET.split("\n").map((l) => `│ ${l}`).join("\r\n"),
  ]) {
    const r = transientFailure(text);
    assert.equal(r.transient, true, text);
    assert.ok(r.reasons.length > 0, text);
  }
});

test("anything else is not transient: 4xx refusals, a resource's own timeout, a mix, or no error at all", () => {
  for (const text of [
    QUOTA,
    VALIDATION,
    diag("unexpected status 403 (403 Forbidden) with error: AuthorizationFailed: The client does not have authorization"),
    diag("QuotaExceeded: Operation results in exceeding quota limits of Core."),
    // The resource's own create timeout (an hour for a VPN gateway): retrying would only spend another hour.
    diag("waiting for creation of Virtual Network Gateway: context deadline exceeded"),
    // Any one diagnostic that is not transient blocks the retry.
    `${NSG_RESET}\n${QUOTA}`,
    // A refusal that mentions a reset too is still a refusal.
    diag("unexpected status 400 (400 Bad Request) with error: InvalidRequestFormat: connection reset by peer"),
    // No Error: diagnostic (a crash, a state write failure) is never guessed at.
    "panic: runtime error: invalid memory address\nconnection reset by peer\n",
    "",
  ]) {
    assert.equal(transientFailure(text).transient, false, text);
  }
  // Only the message counts, never the configuration Terraform quotes under it.
  const quoted = diag("waiting for creation of Virtual Network Gateway: context deadline exceeded", "azurerm_virtual_network_gateway.gw", "gw-unexpected EOF");
  assert.equal(transientFailure(quoted).transient, false);
});

// ── lab-tf-run.sh apply ──────────────────────────────────────────────────

const ID = "az104-06-blob-security";
const scope = (f) => JSON.parse(readFileSync(join(REPO, "scripts", "test", "fixtures", "labs", "scope", `${f}.json`), "utf8"));
const CLEAN = scope("clean-template");
const EVIL = scope("evil-role");
const CLEAN_PLAN = JSON.stringify(withAfterUnknown(CLEAN.plan));
const EVIL_PLAN = JSON.stringify(withAfterUnknown(EVIL.plan));
const APPLIED = "Apply complete! Resources: 3 added, 0 changed, 0 destroyed.\n\nOutputs:\n\nadmin_user = \"lab-secret-user\"";

/** Run lab-tf-run.sh <action> with a fake terraform answering `rules`; a workspace holding labs/<lab>/terraform. */
function run(action, rules, { lab = ID, env = {} } = {}) {
  const w = world(rules);
  const ws = mkdtempSync(join(tmpdir(), "lab-retry-ws-"));
  mkdirSync(join(ws, "labs", lab, "terraform"), { recursive: true });
  const temp = join(w.dir, "runner-temp");
  mkdirSync(temp);
  const r = w.run("infra/ci/lab-tf-run.sh", [action], { GITHUB_WORKSPACE: fwd(ws), RUNNER_TEMP: fwd(temp), LAB_ID: lab, LAB_PEERING: "false", LAB_APPLY_BACKOFF_SECONDS: "30", ...env });
  const calls = w.calls();
  w.cleanup();
  rmSync(ws, { recursive: true, force: true });
  const tf = calls.filter((c) => c.startsWith("terraform "));
  return { ...r, calls, tf, applies: tf.filter((c) => c.startsWith("terraform apply")), plans: tf.filter((c) => c.startsWith("terraform plan")), sleeps: calls.filter((c) => c.startsWith("sleep ")) };
}
const apply = (codes, errs, extra = [], opts) =>
  run("apply", [{ cmd: "terraform", match: "^apply", code: codes, err: errs, out: codes.map((c) => (c === 0 ? APPLIED : "")) }, { cmd: "terraform", match: "^show", out: CLEAN_PLAN }, ...extra], opts);

test("a transient failure, then success: re-planned, scope-checked again, applied, and the lab succeeds", { skip }, () => {
  const r = apply([1, 0], [NSG_RESET, ""]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.applies.length, 2, r.calls.join("\n"));
  assert.equal(r.plans.length, 1, r.calls.join("\n"));
  // Apply, a fresh plan and its JSON for the scope check, then the new plan applied.
  const i = (re) => r.tf.findIndex((c) => re.test(c));
  assert.ok(i(/^terraform apply/) < i(/^terraform plan .*-out=/) && i(/^terraform plan/) < i(/^terraform show -no-color -json/), r.tf.join("\n"));
  assert.match(r.tf.at(-1), /^terraform apply -no-color -input=false .*plan\.out$/);
  assert.match(r.out, /Azure dropped the connection; retrying apply \(1 of 2\)/);
  assert.match(r.out, /HTTP response was nil/);
  assert.match(r.out, /scope check passed/);
  assert.deepEqual(r.sleeps, ["sleep 30"]);
  // The retry plan's shape is not recorded: the release test reads the last LAB_PLAN_SHAPE line as the lab's real plan.
  assert.doesNotMatch(r.out, /LAB_PLAN_SHAPE/);
  // The outputs block stays out of the log on the retried apply too.
  assert.match(r.out, /Apply complete!/);
  assert.doesNotMatch(r.out, /lab-secret-user|Outputs:/);
});

test("a non-transient failure (quota, validation) is never retried", { skip }, () => {
  for (const err of [QUOTA, VALIDATION]) {
    const r = apply([1, 0], [err, ""]);
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.applies.length, 1, r.calls.join("\n"));
    assert.equal(r.plans.length, 0);
    assert.deepEqual(r.sleeps, []);
    assert.doesNotMatch(r.out, /retrying (apply|destroy)/);
    assert.match(r.out, /not a dropped connection; not retrying/);
  }
});

test("two transient failures, then success: retried twice", { skip }, () => {
  const r = apply([1, 1, 0], [NSG_RESET, NIC_RESET, ""]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.applies.length, 3);
  assert.equal(r.plans.length, 2);
  assert.match(r.out, /retrying apply \(1 of 2\)/);
  assert.match(r.out, /retrying apply \(2 of 2\)/);
  // A longer wait before the second retry.
  assert.deepEqual(r.sleeps, ["sleep 30", "sleep 60"]);
});

test("three transient failures: the apply fails after 2 retries", { skip }, () => {
  const r = apply([1, 1, 1, 0], [NSG_RESET, NSG_RESET, NSG_RESET, ""]);
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.applies.length, 3);
  assert.equal(r.plans.length, 2);
  assert.match(r.out, /::error::.*after 2 retries/);
});

test("the scope check refusing the retry plan stops the run before any apply", { skip }, () => {
  const lab = EVIL.lab;
  const r = run("apply", [{ cmd: "terraform", match: "^apply", code: [1, 0], err: [NSG_RESET, ""] }, { cmd: "terraform", match: "^show", out: EVIL_PLAN }], { lab });
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.applies.length, 1, r.calls.join("\n"));
  assert.equal(r.plans.length, 1);
  assert.match(r.out, /role: azurerm_role_assignment\.owner/);
  // A fresh plan that fails outright is no better.
  const p = apply([1, 0], [NSG_RESET, ""], [{ cmd: "terraform", match: "^plan", code: 1, err: "Error: building account: connection refused" }]);
  assert.notEqual(p.status, 0, p.out);
  assert.equal(p.applies.length, 1);
});

test("a retry never starts too close to the job's deadline", { skip }, () => {
  const now = Math.floor(Date.now() / 1000);
  // 10 minutes left; the retry needs the backoff, the deploy (4 min), the teardown (3 min) and 420 s reserve.
  const late = apply([1, 0], [NSG_RESET, ""], [], { env: { LAB_JOB_DEADLINE: String(now + 600), LAB_DEPLOY_MIN: "4", LAB_DESTROY_MIN: "3" } });
  assert.notEqual(late.status, 0, late.out);
  assert.equal(late.applies.length, 1);
  assert.match(late.out, /deadline/);
  const early = apply([1, 0], [NSG_RESET, ""], [], { env: { LAB_JOB_DEADLINE: String(now + 3600), LAB_DEPLOY_MIN: "4", LAB_DESTROY_MIN: "3" } });
  assert.equal(early.status, 0, early.out);
  assert.equal(early.applies.length, 2);
});

// ── lab-tf-run.sh destroy ────────────────────────────────────────────────

const destroy = (codes, errs, opts) => run("destroy", [{ cmd: "terraform", match: "^destroy", code: codes, err: errs, out: codes.map((c) => (c === 0 ? "Destroy complete! Resources: 3 destroyed." : "")) }], opts);

test("destroy: one retry on a transient failure, none on anything else", { skip }, () => {
  const ok = destroy([1, 0], [NIC_RESET, ""]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal(ok.tf.length, 2, ok.calls.join("\n"));
  for (const c of ok.tf) assert.match(c, /^terraform destroy -no-color -input=false -auto-approve -lock-timeout=5m$/);
  assert.match(ok.out, /Azure dropped the connection; retrying destroy \(1 of 1\)/);
  const twice = destroy([1, 1, 0], [NIC_RESET, NIC_RESET, ""]);
  assert.notEqual(twice.status, 0, twice.out);
  assert.equal(twice.tf.length, 2);
  const quota = destroy([1, 0], [VALIDATION, ""]);
  assert.notEqual(quota.status, 0, quota.out);
  assert.equal(quota.tf.length, 1);
  // Close to the deadline, the safety net's time comes first.
  const now = Math.floor(Date.now() / 1000);
  const late = destroy([1, 0], [NIC_RESET, ""], { env: { LAB_JOB_DEADLINE: String(now + 300), LAB_DESTROY_MIN: "3" } });
  assert.notEqual(late.status, 0, late.out);
  assert.equal(late.tf.length, 1);
});

// ── lab.yml wiring ───────────────────────────────────────────────────────

const wf = parse(readFileSync(fileURLToPath(new URL("../../.github/workflows/lab.yml", import.meta.url)), "utf8"));
const steps = Object.values(wf.jobs)[0].steps;
const step = (name) => steps.find((s) => s.name === name);

test("lab.yml's Plan, Apply and Destroy steps use the shared scripts", () => {
  assert.match(step("Plan and scope check").run, /bash "\$GITHUB_WORKSPACE\/infra\/ci\/lab-plan\.sh"\s*$/m);
  assert.match(step("Apply").run, /bash "\$GITHUB_WORKSPACE\/infra\/ci\/lab-tf-run\.sh" apply\s*$/m);
  assert.match(step("Destroy").run, /bash "\$GITHUB_WORKSPACE\/infra\/ci\/lab-tf-run\.sh" destroy\s*$/m);
  // A retry's fresh plan sees exactly the variables and keys the first plan saw.
  const planEnv = step("Plan and scope check").env;
  const applyEnv = step("Apply").env;
  for (const [k, v] of Object.entries(planEnv)) assert.equal(applyEnv[k], v, `Apply's env lacks ${k}`);
});

test("lab-plan.sh records the plan's shape on the first plan only", { skip }, () => {
  const rules = [{ cmd: "terraform", match: "^show", out: CLEAN_PLAN }];
  const w = world(rules);
  const ws = mkdtempSync(join(tmpdir(), "lab-plan-ws-"));
  mkdirSync(join(ws, "labs", ID, "terraform"), { recursive: true });
  const env = { GITHUB_WORKSPACE: fwd(ws), RUNNER_TEMP: fwd(w.dir), LAB_ID: ID, LAB_PEERING: "true", ARM_SUBSCRIPTION_ID: "sub-1", RG: "" };
  const first = w.run("infra/ci/lab-plan.sh", [], env);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /^LAB_PLAN_SHAPE /m);
  const again = w.run("infra/ci/lab-plan.sh", ["--retry"], env);
  assert.equal(again.status, 0, again.out);
  assert.doesNotMatch(again.out, /LAB_PLAN_SHAPE/);
  assert.deepEqual(w.calls().filter((c) => c.startsWith("terraform plan")), [`terraform plan -no-color -input=false -out=${fwd(w.dir)}/plan.out`, `terraform plan -no-color -input=false -out=${fwd(w.dir)}/plan.out`]);
  w.cleanup();
  rmSync(ws, { recursive: true, force: true });
});
