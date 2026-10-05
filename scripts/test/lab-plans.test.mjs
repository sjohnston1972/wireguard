// lab-plans.test.mjs
//
// Plain English: each real lab (1-7) as lab.yml's "Plan and scope check"
// sees it. Terraform cannot plan a lab offline, so fixtures/labs/plans/labs.mjs
// describes each lab's first-deploy plan by hand and realistic.mjs prints it
// as `terraform show -json` does, with after_unknown from the real provider
// schemas. These tests keep each description equal to its main.tf (the same
// resources, the same attribute names) and check lab-scope.mjs passes it.
// Two labs were refused for real because older fixtures were too tidy:
// lab 6's group had no mail_nickname (unknown at plan) and lab 3's
// management groups have subscription_ids unknown at plan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";
import { labFolders } from "../lib/labs.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { COMPUTED } from "./fixtures/labs/plans/realistic.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const META = new Set(["count", "for_each", "depends_on", "lifecycle", "provider", "provisioner", "connection"]);

/** Resources in a lab's .tf files: { address: Set(top-level attribute and block names) }. Line-based: terraform fmt lays the files out. */
export function tfResources(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tf"))) {
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    let depth = 0;
    let current = null;
    let heredoc = null;
    for (const raw of lines) {
      if (heredoc) {
        if (raw.trim() === heredoc) heredoc = null;
        continue;
      }
      const line = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\s(#|\/\/).*$/, "").replace(/^\s*(#|\/\/).*$/, "");
      const hd = /<<-?([A-Z_]+)\s*$/.exec(line);
      if (depth === 0) {
        const m = /^(resource|data)\s+""\s+""/.exec(line) && /^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/.exec(raw);
        if (m) {
          current = `${m[1] === "data" ? "data." : ""}${m[2]}.${m[3]}`;
          out[current] = new Set();
        }
      } else if (depth === 1 && current) {
        const a = /^\s*([a-z0-9_]+)\s*=/.exec(line);
        const b = /^\s*([a-z0-9_]+)\s*\{/.exec(line);
        const d = /^\s*dynamic\s+"([a-z0-9_]+)"/.exec(raw);
        const name = d?.[1] ?? a?.[1] ?? b?.[1];
        if (name && !META.has(name)) out[current].add(name);
      }
      for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      if (depth === 0) current = null;
      if (hd) heredoc = hd[1];
    }
  }
  return out;
}

/** The attribute names a fixture description configures (a data source: only its arguments). */
const configured = (def, data = false) =>
  data ? new Set(Object.keys(def.refs ?? {})) : new Set([...Object.keys(def.values ?? {}), ...(def.unknown ?? []).map((p) => p.split(".")[0]), ...Object.keys(def.refs ?? {}).map((p) => p.split(".")[0])]);

const labs = labFolders(LABS);

test("there is a realistic plan for every lab in the catalogue", () => {
  assert.deepEqual(Object.keys(LAB_PLANS).sort(), [...labs].sort());
});

for (const id of labs) {
  test(`${id}: the plan fixture has main.tf's resources and attributes`, () => {
    const tf = tfResources(join(LABS, id, "terraform"));
    const d = LAB_PLANS[id];
    assert.ok(d, `no fixture for ${id}`);
    const fixture = Object.fromEntries([...d.resources.map((r) => [r.address, configured(r)]), ...(d.data ?? []).map((r) => [r.address, configured(r, true)])]);
    assert.deepEqual(Object.keys(fixture).sort(), Object.keys(tf).sort(), "resources");
    for (const [address, attrs] of Object.entries(tf)) assert.deepEqual([...fixture[address]].sort(), [...attrs].sort(), address);
  });

  test(`${id}: lab-scope passes its realistic first-deploy plan`, () => {
    const problems = checkPlan(LAB_PLANS[id].plan, id);
    assert.deepEqual(problems.map((p) => `${p.rule}: ${p.address} (${p.message})`), []);
  });
}

test("the realistic plans mark computed, unset attributes unknown, as Terraform does", () => {
  const change = (lab, address) => LAB_PLANS[lab].plan.resource_changes.find((c) => c.address === address).change;
  // Ids are always known only after apply.
  assert.equal(change("az104-06-blob-security", "azurerm_resource_group.lab").after_unknown.id, true);
  // Optional and computed, and left unset: unknown at plan.
  assert.equal(change("az104-03-mgmt-groups", "azurerm_management_group.root").after_unknown.subscription_ids, true);
  assert.ok(COMPUTED.types.azuread_group.attrs.includes("mail_nickname"));
  // Set in main.tf: known, and not in after_unknown.
  assert.equal(change("az104-01-identity", "azuread_user.ann").after_unknown.mail_nickname, undefined);
  assert.equal(change("az104-01-identity", "azuread_user.ann").after.mail_nickname, "lab-az104-01-identity-ann");
  // Built from another resource's id: unknown, and missing from the planned values.
  const pe = change("az104-06-blob-security", "azurerm_private_endpoint.blob");
  assert.equal(pe.after_unknown.subnet_id, true);
  assert.equal(pe.after_unknown.private_service_connection[0].private_connection_resource_id, true);
  assert.equal("subnet_id" in pe.after, false);
});
