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
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";
import { labFolders } from "../lib/labs.mjs";
import { LAB_PLANS, loadLabPlans } from "./fixtures/labs/plans/labs.mjs";
import { COMPUTED, realisticPlan } from "./fixtures/labs/plans/realistic.mjs";

const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
const PLAN_FILES = fileURLToPath(new URL("./fixtures/labs/plans/labs/", import.meta.url));
const BATCH1 = ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az104-04-cost", "az104-05-storage", "az104-06-blob-security", "az104-07-files"];
/** Every resource type batch 2's labs (8-19) use, from the batch 2 plan's B0.1 list: computed.json must know each one. */
const BATCH2_TYPES = [
  // compute (8-12)
  "azurerm_linux_virtual_machine", "azurerm_linux_virtual_machine_scale_set", "azurerm_monitor_autoscale_setting", "azurerm_service_plan",
  "azurerm_linux_web_app", "azurerm_linux_web_app_slot", "azurerm_container_group", "azurerm_container_app", "azurerm_container_app_environment",
  "azurerm_container_registry", "azurerm_virtual_machine_extension", "azurerm_managed_disk", "azurerm_virtual_machine_data_disk_attachment",
  "azurerm_resource_group_template_deployment",
  // networking (13-17)
  "azurerm_application_security_group", "azurerm_network_interface_application_security_group_association", "azurerm_network_security_rule",
  "azurerm_network_interface_security_group_association", "azurerm_subnet_network_security_group_association", "azurerm_route_table", "azurerm_route",
  "azurerm_subnet_route_table_association", "azurerm_virtual_network_peering", "azurerm_dns_zone", "azurerm_dns_a_record", "azurerm_dns_cname_record",
  "azurerm_private_dns_zone", "azurerm_private_dns_a_record", "azurerm_private_dns_zone_virtual_network_link", "azurerm_public_ip", "azurerm_lb",
  "azurerm_lb_backend_address_pool", "azurerm_lb_probe", "azurerm_lb_rule", "azurerm_network_interface_backend_address_pool_association",
  "azurerm_application_gateway",
  // monitor and backup (18-19)
  "azurerm_log_analytics_workspace", "azurerm_monitor_data_collection_rule", "azurerm_monitor_data_collection_rule_association",
  "azurerm_monitor_metric_alert", "azurerm_monitor_activity_log_alert", "azurerm_monitor_action_group", "azurerm_recovery_services_vault",
  "azurerm_backup_policy_vm", "azurerm_backup_protected_vm",
  // data sources
  "data.azurerm_client_config",
];
/** An address without its instance key: azurerm_subnet.s["web"] -> azurerm_subnet.s. */
const block = (address) => address.replace(/\[[^\]]*\]/g, "");
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

const ITERATOR_RE = /\b(count\.index|each\.key|each\.value)\b/g;

/**
 * count and for_each in a lab's .tf files: { address: { repeat: "count" | "for_each" | null, attrs: { attr: Set(count.index, each.key, each.value) } } }.
 * Terraform lists these among an attribute's references (azurerm_network_interface.web[count.index].id
 * as ["azurerm_network_interface.web", "count.index"]), so a fixture must too: lab 16's real plan was
 * refused over exactly that while its fixture, with [0] and [1] spelled out, passed.
 */
export function tfIterators(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tf"))) {
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    let depth = 0;
    let current = null;
    let attr = null;
    let heredoc = null;
    for (const raw of lines) {
      if (heredoc) {
        if (raw.trim() === heredoc) heredoc = null;
        continue;
      }
      const line = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\s(#|\/\/).*$/, "").replace(/^\s*(#|\/\/).*$/, "");
      const code = /^\s*(#|\/\/)/.test(raw) ? "" : raw;
      const hd = /<<-?([A-Z_]+)\s*$/.exec(line);
      if (depth === 0) {
        const m = /^(resource|data)\s+"([^"]+)"\s+"([^"]+)"/.exec(raw);
        if (m) {
          current = `${m[1] === "data" ? "data." : ""}${m[2]}.${m[3]}`;
          out[current] = { repeat: null, attrs: {} };
        }
      } else if (depth === 1 && current) {
        const a = /^\s*([a-z0-9_]+)\s*=/.exec(line);
        const b = /^\s*([a-z0-9_]+)\s*\{/.exec(line);
        const d = /^\s*dynamic\s+"([a-z0-9_]+)"/.exec(raw);
        attr = d?.[1] ?? a?.[1] ?? b?.[1] ?? attr;
        if (a && (a[1] === "count" || a[1] === "for_each")) out[current].repeat = a[1];
      }
      if (current && depth >= 1 && attr && !META.has(attr)) {
        for (const m of code.matchAll(ITERATOR_RE)) (out[current].attrs[attr] ??= new Set()).add(m[1]);
      }
      for (const ch of line) {
        if (ch === "{" || ch === "(" || ch === "[") depth++;
        else if (ch === "}" || ch === ")" || ch === "]") depth--;
      }
      if (depth === 0) {
        current = null;
        attr = null;
      }
      if (hd) heredoc = hd[1];
    }
  }
  return out;
}

/** The attribute names a fixture description configures (a data source: only its arguments). */
const configured = (def, data = false) =>
  data ? new Set(Object.keys(def.refs ?? {})) : new Set([...Object.keys(def.values ?? {}), ...(def.unknown ?? []).map((p) => p.split(".")[0]), ...Object.keys(def.refs ?? {}).map((p) => p.split(".")[0])]);

const labs = labFolders(LABS);

/** A fixture description's attribute names per resource block (count and for_each instances merged). */
function fixtureAttributes(d) {
  const out = {};
  const add = (address, names) => {
    out[block(address)] ??= new Set();
    for (const n of names) out[block(address)].add(n);
  };
  for (const r of d.resources) add(r.address, configured(r));
  for (const r of d.data ?? []) add(r.address, configured(r, true));
  return out;
}

test("computed.json has every type batch 2 labs use", () => {
  assert.deepEqual(BATCH2_TYPES.filter((t) => !COMPUTED.types[t]), []);
});

test("a realistic plan with for_each instances has one configuration entry per resource block", () => {
  const id = "az104-13-vnets";
  const rg = `rg-lab-${id}`;
  const subnet = (key, n) => ({
    address: `azurerm_subnet.s["${key}"]`,
    values: { name: `snet-${key}`, resource_group_name: rg, virtual_network_name: "vnet-lab", address_prefixes: [`10.64.64.${n}/24`] },
    refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], virtual_network_name: ["azurerm_virtual_network.lab.name", "azurerm_virtual_network.lab"], address_prefixes: ["each.value"] },
  });
  const d = {
    lab: id,
    resources: [
      { address: "azurerm_resource_group.lab", values: { name: rg, location: "uksouth" }, refs: { name: ["var.resource_group_name"], location: ["var.region"] } },
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: rg, location: "uksouth", address_space: ["10.64.64.0/20"] }, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] } },
      subnet("web", 0),
      subnet("app", 1),
    ],
  };
  const plan = realisticPlan(d);
  assert.deepEqual(plan.configuration.root_module.resources.map((r) => r.address), ["azurerm_resource_group.lab", "azurerm_virtual_network.lab", "azurerm_subnet.s"]);
  const planned = plan.planned_values.root_module.resources.filter((r) => r.type === "azurerm_subnet");
  assert.deepEqual(planned.map((r) => [r.address, r.name, r.index]), [['azurerm_subnet.s["web"]', "s", "web"], ['azurerm_subnet.s["app"]', "s", "app"]]);
  assert.deepEqual(plan.resource_changes.filter((c) => c.type === "azurerm_subnet").map((c) => c.index), ["web", "app"]);
  assert.deepEqual(checkPlan(plan, id), []);
  assert.deepEqual(Object.keys(fixtureAttributes(d)), ["azurerm_resource_group.lab", "azurerm_virtual_network.lab", "azurerm_subnet.s"]);
});

test("LAB_PLANS merges labs 1-7 with every file in plans/labs/", async () => {
  const files = existsSync(PLAN_FILES) ? readdirSync(PLAN_FILES).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)) : [];
  assert.deepEqual(Object.keys(LAB_PLANS).sort(), [...BATCH1, ...files].sort());
  // A file is named by its lab id and gives { lab, variables, resources, data? }; the merge builds its plan.
  const dir = mkdtempSync(join(tmpdir(), "lab-plans-"));
  const rg = { address: "azurerm_resource_group.lab", values: { name: "rg-lab-az104-99-demo", location: "uksouth" }, refs: { name: ["var.resource_group_name"] } };
  writeFileSync(join(dir, "az104-99-demo.mjs"), `export default () => (${JSON.stringify({ lab: "az104-99-demo", variables: {}, resources: [rg] })});\n`);
  const loaded = await loadLabPlans(dir);
  assert.deepEqual(Object.keys(loaded), ["az104-99-demo"]);
  assert.equal(loaded["az104-99-demo"].plan.resource_changes[0].address, "azurerm_resource_group.lab");
  assert.deepEqual(checkPlan(loaded["az104-99-demo"].plan, "az104-99-demo"), []);
  // A file not named by its lab id is refused, naming the file.
  const wrong = mkdtempSync(join(tmpdir(), "lab-plans-"));
  writeFileSync(join(wrong, "az104-98-one.mjs"), `export default () => (${JSON.stringify({ lab: "az104-98-other", variables: {}, resources: [] })});\n`);
  await assert.rejects(loadLabPlans(wrong), /az104-98-one/);
});

test("there is a realistic plan for every lab in the catalogue", () => {
  assert.deepEqual(Object.keys(LAB_PLANS).sort(), [...labs].sort());
});

for (const id of labs) {
  test(`${id}: the plan fixture has main.tf's resources and attributes`, () => {
    const tf = tfResources(join(LABS, id, "terraform"));
    const d = LAB_PLANS[id];
    assert.ok(d, `no fixture for ${id}`);
    const fixture = fixtureAttributes(d);
    assert.deepEqual(Object.keys(fixture).sort(), Object.keys(tf).sort(), "resources");
    for (const [address, attrs] of Object.entries(tf)) assert.deepEqual([...fixture[address]].sort(), [...attrs].sort(), address);
  });

  test(`${id}: the plan fixture lists count.index and each.* where main.tf uses them, as Terraform does`, () => {
    const tf = tfIterators(join(LABS, id, "terraform"));
    const d = LAB_PLANS[id];
    const defs = [...d.resources, ...(d.data ?? [])];
    for (const [address, { repeat, attrs }] of Object.entries(tf)) {
      const mine = defs.filter((r) => block(r.address) === address);
      // count and for_each reach the configuration (count_expression, for_each_expression).
      for (const r of mine) {
        assert.equal(r.count !== undefined ? "count" : r.forEach ? "for_each" : null, repeat, `${r.address}: main.tf has ${repeat ?? "neither count nor for_each"}`);
      }
      for (const [attr, tokens] of Object.entries(attrs)) {
        for (const r of mine) {
          const refs = Object.entries(r.refs ?? {}).filter(([k]) => k.split(".")[0] === attr).flatMap(([, v]) => v);
          for (const t of tokens) assert.ok(refs.some((x) => x === t || x.startsWith(`${t}.`)), `${r.address}: ${attr} uses ${t} in main.tf, so its references must list it (${JSON.stringify(refs)})`);
        }
      }
    }
    // Terraform never prints an instance key it works out ([count.index], [each.key]) as a literal [0] or ["a"].
    const text = readdirSync(join(LABS, id, "terraform")).filter((f) => f.endsWith(".tf")).map((f) => readFileSync(join(LABS, id, "terraform", f), "utf8")).join("\n");
    for (const r of defs) {
      for (const [attr, refs] of Object.entries(r.refs ?? {})) {
        for (const x of refs) {
          const keyed = /^.*?\[(?:\d+|"[^"]*")\]/.exec(x);
          if (keyed) assert.ok(text.includes(keyed[0]), `${r.address}: ${attr} references ${x}, but main.tf never spells ${keyed[0]}`);
        }
      }
    }
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
