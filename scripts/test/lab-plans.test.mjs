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
import { COMPUTED, PLAN_DEFAULTS, realisticPlan, SCHEMA_FACTS, UNSET_BLOCKS_UNKNOWN } from "./fixtures/labs/plans/realistic.mjs";
import { ctx, linuxVm, rgResource, rgSecondaryResource, SECONDARY } from "./fixtures/labs/plans/common.mjs";
import { compareShapes, planShape, recordedShape, SHAPES } from "./fixtures/labs/plans/shape.mjs";

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
/** Every resource type batch 3's labs (20-27) use, from the batch 3 plan's C0.1 list: computed.json must know each one. */
const BATCH3_TYPES = [
  "azurerm_key_vault", "azurerm_key_vault_secret", "azurerm_user_assigned_identity", "azurerm_log_analytics_workspace", "azurerm_policy_set_definition",
  "azurerm_management_group_policy_set_definition", "azurerm_resource_group_policy_assignment", "azurerm_mssql_server", "azurerm_mssql_database",
  "azurerm_mssql_failover_group", "azurerm_private_endpoint", "azurerm_private_dns_zone", "azurerm_private_dns_zone_virtual_network_link",
  "azurerm_cosmosdb_account", "azurerm_cosmosdb_sql_database", "azurerm_cosmosdb_sql_container", "azurerm_storage_container_immutability_policy",
  "azurerm_storage_management_policy", "azurerm_recovery_services_vault", "azurerm_site_recovery_fabric", "azurerm_site_recovery_protection_container",
  "azurerm_site_recovery_replication_policy", "azurerm_site_recovery_protection_container_mapping", "azurerm_site_recovery_network_mapping",
  "azurerm_site_recovery_replicated_vm", "azurerm_container_group", "azurerm_traffic_manager_profile", "azurerm_traffic_manager_external_endpoint",
  "azurerm_cdn_frontdoor_profile", "azurerm_cdn_frontdoor_endpoint", "azurerm_cdn_frontdoor_origin_group", "azurerm_cdn_frontdoor_origin",
  "azurerm_cdn_frontdoor_route", "time_sleep", "random_password",
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

test("computed.json has every type batch 3 labs use", () => {
  assert.deepEqual(BATCH3_TYPES.filter((t) => !COMPUTED.types[t]), []);
  // The providers they come from, at the versions labs/_template's constraints resolve to.
  for (const p of ["azurerm", "azuread", "random", "time"]) assert.ok(COMPUTED.providers[`registry.terraform.io/hashicorp/${p}`], p);
});

test("schema-facts.json says which types take a resource group and tags", () => {
  // One entry for every resource type computed.json knows (data sources take neither).
  assert.deepEqual(Object.keys(SCHEMA_FACTS).sort(), Object.keys(COMPUTED.types).filter((t) => !t.startsWith("data.")).sort());
  for (const [t, f] of Object.entries(SCHEMA_FACTS)) assert.deepEqual(Object.keys(f).sort(), ["rg", "tags"], t);
  // As azurerm 4.81.0 declares them (resource_group_name and tags as arguments).
  assert.deepEqual(SCHEMA_FACTS.azurerm_subnet, { rg: true, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_storage_container, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_key_vault_secret, { rg: false, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_mssql_database, { rg: false, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_site_recovery_replicated_vm, { rg: true, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_user_assigned_identity, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_resource_group, { rg: false, tags: true });
  assert.deepEqual(SCHEMA_FACTS.time_sleep, { rg: false, tags: false });
  // AZ-700 plan Z0.4: the suite's types, as azurerm 4.81.0 declares them.
  assert.deepEqual(SCHEMA_FACTS.azurerm_network_watcher_flow_log, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_network_manager, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_network_manager_static_member, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_network_manager_deployment, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_key_vault_certificate, { rg: false, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_private_dns_resolver_forwarding_rule, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_virtual_hub, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_lb_outbound_rule, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_subnet_service_endpoint_storage_policy, { rg: true, tags: true });
});

/** Every resource type the AZ-700 labs (31-44) use, from the AZ-700 plan's Z0.4 list, and the ones the scope tests plan. */
const AZ700_TYPES = [
  "azurerm_public_ip_prefix", "azurerm_nat_gateway", "azurerm_nat_gateway_public_ip_prefix_association", "azurerm_subnet_nat_gateway_association",
  "azurerm_lb_outbound_rule", "azurerm_lb_nat_rule", "azurerm_lb_backend_address_pool_address", "azurerm_private_dns_resolver",
  "azurerm_private_dns_resolver_inbound_endpoint", "azurerm_private_dns_resolver_outbound_endpoint", "azurerm_private_dns_resolver_dns_forwarding_ruleset",
  "azurerm_private_dns_resolver_forwarding_rule", "azurerm_private_dns_resolver_virtual_network_link", "azurerm_network_manager",
  "azurerm_network_manager_network_group", "azurerm_network_manager_static_member", "azurerm_network_manager_connectivity_configuration",
  "azurerm_network_manager_security_admin_configuration", "azurerm_network_manager_admin_rule_collection", "azurerm_network_manager_admin_rule",
  "azurerm_network_manager_deployment", "azurerm_route_server", "azurerm_route_server_bgp_connection", "azurerm_firewall", "azurerm_firewall_policy",
  "azurerm_firewall_policy_rule_collection_group", "azurerm_virtual_network_gateway", "azurerm_local_network_gateway",
  "azurerm_virtual_network_gateway_connection", "azurerm_virtual_wan", "azurerm_virtual_hub", "azurerm_virtual_hub_connection",
  "azurerm_virtual_hub_routing_intent", "azurerm_web_application_firewall_policy", "azurerm_key_vault_certificate", "azurerm_key_vault_access_policy",
  "azurerm_cdn_frontdoor_firewall_policy", "azurerm_cdn_frontdoor_security_policy", "azurerm_cdn_frontdoor_rule_set", "azurerm_cdn_frontdoor_rule",
  "azurerm_private_link_service", "azurerm_subnet_service_endpoint_storage_policy", "azurerm_network_watcher_flow_log", "azurerm_bastion_host",
  "azurerm_route_table", "azurerm_subnet_route_table_association", "azurerm_monitor_diagnostic_setting", "azuread_user",
  // What the scope tests plan and refuse: AVNM's other types (S1) and the never rule's.
  "azurerm_network_manager_scope_connection", "azurerm_network_manager_subscription_connection", "azurerm_network_manager_management_group_connection",
  "azurerm_network_manager_routing_configuration", "azurerm_network_manager_routing_rule_collection", "azurerm_network_ddos_protection_plan",
  "azurerm_express_route_circuit", "azurerm_express_route_port", "azurerm_express_route_gateway", "azurerm_custom_ip_prefix", "azurerm_network_watcher",
  "azurerm_resource_group_policy_assignment",
];

test("ctx takes a slot: AZ-700 fixtures are at slot 31, 10.71.192.0/18", () => {
  assert.equal(ctx("az104-07-files", "07").variables.address_space, "10.64.64.0/18", "slot 1 by default, as batches 1-3");
  const c = ctx("az700-31-ip-nat-outbound", "31", { slot: 31 });
  assert.equal(c.variables.address_space, "10.71.192.0/18");
  assert.equal(c.slot, "10.71.192.0/18");
});

test("a data source's configuration holds only its arguments, never what it read", () => {
  // data "azurerm_subscription" "current" {} prints no expressions; what it read is in prior_state only. The AVNM scope
  // check (S1) tells the current subscription by a subscription data source that sets no subscription_id.
  const cfg = LAB_PLANS["az104-01-identity"].plan.configuration.root_module.resources.find((r) => r.address === "data.azurerm_subscription.current");
  assert.deepEqual(cfg.expressions, {});
  const read = LAB_PLANS["az104-01-identity"].plan.prior_state.values.root_module.resources.find((r) => r.address === "data.azurerm_subscription.current");
  assert.match(read.values.id, /^\/subscriptions\//);
  const named = realisticPlan({ data: [{ address: "data.azurerm_resource_group.x", values: { name: "rg-lab-az104-07-files", location: "uksouth" }, args: ["name"] }] });
  assert.deepEqual(Object.keys(named.configuration.root_module.resources[0].expressions), ["name"]);
});

test("computed.json has every type AZ-700 labs use", () => {
  assert.deepEqual(AZ700_TYPES.filter((t) => !COMPUTED.types[t]), []);
  // The block a flow log's traffic analytics and a gateway's P2S settings go in, and what a plan cannot know.
  assert.ok(COMPUTED.types.azurerm_network_manager.attrs.includes("cross_tenant_scopes"), "cross_tenant_scopes is computed: unknown at plan, never set");
  assert.ok(COMPUTED.types.azurerm_network_watcher_flow_log.attrs.includes("target_resource_id"));
  assert.ok(COMPUTED.types.azurerm_virtual_network_gateway_connection.sensitive.includes("shared_key"), "a connection's shared key is sensitive in every plan");
});

test("ctx gives a secondary group and region", () => {
  const c = ctx("az305-23-sql-failover", "23");
  assert.equal(SECONDARY, "ukwest");
  assert.equal(c.rgSecondary, "rg-lab-az305-23-sql-failover-secondary");
  assert.equal(c.variables.secondary_region, "ukwest");
  assert.notEqual(c.variables.secondary_region, c.variables.region);
  const rg2 = rgSecondaryResource(c);
  assert.equal(rg2.address, "azurerm_resource_group.secondary");
  assert.deepEqual(rg2.values, { name: c.rgSecondary, location: SECONDARY, tags: c.tags });
  assert.deepEqual(rg2.refs, { name: ["var.resource_group_name"], location: ["var.secondary_region"], tags: ["var.tags"] });
  // Both groups are the lab's own; a VM in the secondary group passes the scope check too.
  const IN_RG2 = { resource_group_name: ["azurerm_resource_group.secondary.name", "azurerm_resource_group.secondary"], location: ["azurerm_resource_group.secondary.location", "azurerm_resource_group.secondary"], tags: ["var.tags"] };
  const vnet = { address: "azurerm_virtual_network.target", values: { name: "vnet-target", resource_group_name: c.rgSecondary, location: SECONDARY, address_space: ["10.64.80.0/20"], tags: c.tags }, refs: IN_RG2 };
  const subnet = { address: "azurerm_subnet.target", values: { name: "snet-vms", resource_group_name: c.rgSecondary, virtual_network_name: "vnet-target", address_prefixes: ["10.64.80.0/24"] }, refs: { resource_group_name: IN_RG2.resource_group_name } };
  // An image from another publisher, pinned to one version (lab 26's AlmaLinux 9.7).
  const [nic, vm] = linuxVm(c, { name: "vm-app", subnet: "azurerm_subnet.target", image: { publisher: "almalinux", offer: "almalinux-x86_64", sku: "9-gen2", version: "9.7.2026051801" } });
  assert.deepEqual(vm.values.source_image_reference, [{ publisher: "almalinux", offer: "almalinux-x86_64", sku: "9-gen2", version: "9.7.2026051801" }]);
  // A Canonical image at "latest" unless a publisher or version is given.
  assert.deepEqual(linuxVm(c, { name: "vm-y", subnet: "azurerm_subnet.target", image: { offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2" } })[1].values.source_image_reference, [{ publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2", version: "latest" }]);
  assert.deepEqual(linuxVm(c, { name: "vm-x", subnet: "azurerm_subnet.target" })[1].values.source_image_reference, [{ publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" }]);
  const plan = realisticPlan({ resources: [rgResource(c), rg2, vnet, subnet, nic, vm], variables: c.variables });
  assert.deepEqual(checkPlan(plan, c.id), []);
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

  // Ruling 35: each release test records its real plan's shape (scripts/lab-release-test.mjs, from
  // lab.yml step 6's LAB_PLAN_SHAPE line) into plans/shapes/<id>.json; the fixture must have it.
  const recorded = recordedShape(id);
  test(`${id}: the plan fixture has the recorded real plan's shape`, { skip: recorded ? false : `no real plan shape recorded for ${id} yet (its next release test records plans/shapes/${id}.json)` }, () => {
    assert.deepEqual(compareShapes(recorded, planShape(LAB_PLANS[id].plan)), []);
  });
}

// ── Real-plan shapes (labs batch 3 plan, C0.2) ───────────────────────────

/** A small plan with a VM: a password (sensitive), a name prefix, references, nested blocks and unknown ids. */
function shapedPlan() {
  const c = ctx("az104-07-files", "07");
  const vnet = { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: "uksouth", address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], location: ["azurerm_resource_group.lab.location", "azurerm_resource_group.lab"], tags: ["var.tags"] } };
  const subnet = { address: "azurerm_subnet.vms", values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"] }, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], virtual_network_name: ["azurerm_virtual_network.lab.name", "azurerm_virtual_network.lab"] } };
  const [nic, vm] = linuxVm(c, { name: "vm-files", subnet: "azurerm_subnet.vms" });
  vm.values.admin_password = "Sup3r-Secret-Value!";
  return { c, plan: realisticPlan({ resources: [rgResource(c), vnet, subnet, nic, vm], variables: { ...c.variables, admin_password: "Sup3r-Secret-Value!" } }) };
}

test("planShape keeps addresses, references, unknown and sensitive paths and no values", () => {
  const { c, plan } = shapedPlan();
  const shape = planShape(plan);
  assert.deepEqual(Object.keys(shape.resources).sort(), ["azurerm_linux_virtual_machine.files", "azurerm_network_interface.files", "azurerm_resource_group.lab", "azurerm_subnet.vms", "azurerm_virtual_network.lab"]);
  const vm = shape.resources["azurerm_linux_virtual_machine.files"];
  assert.equal(vm.type, "azurerm_linux_virtual_machine");
  assert.deepEqual(vm.refs.network_interface_ids, ["azurerm_network_interface.files.id", "azurerm_network_interface.files"]);
  assert.deepEqual(vm.refs.admin_password, ["var.admin_password"]);
  // A nested block's references keep their path, as the configuration nests them.
  assert.deepEqual(shape.resources["azurerm_network_interface.files"].refs["ip_configuration.0.subnet_id"], ["azurerm_subnet.vms.id", "azurerm_subnet.vms"]);
  assert.ok(vm.unknown.includes("network_interface_ids"));
  assert.ok(vm.unknown.includes("id"));
  assert.ok(vm.unknown.includes("os_disk.0.name"), vm.unknown.join(", "));
  // Both attributes the schema calls sensitive, custom_data too though this VM sets none (as lab 22's real plan).
  assert.deepEqual(vm.sensitive, ["admin_password", "custom_data"]);
  // Never a value: not the password, not a name, not an address, not a tag.
  const text = JSON.stringify(shape);
  for (const v of ["Sup3r-Secret-Value!", c.rg, "vnet-lab", "10.64.64.0/24", "ls-20261005T0900-ab12", "Standard_B1s", "ssh-ed25519"]) assert.ok(!text.includes(v), v);
  // Data sources read at plan are in the shape too (by address and references).
  const withData = realisticPlan({ resources: [rgResource(c)], data: [{ address: "data.azurerm_client_config.current", values: { tenant_id: "x", object_id: "y" } }] });
  assert.deepEqual(Object.keys(planShape(withData).resources).sort(), ["azurerm_resource_group.lab", "data.azurerm_client_config.current"]);
});

test("the shape test skips a lab with no recorded shape and fails a fixture whose references differ", () => {
  assert.equal(recordedShape("az104-99-none"), null);
  assert.match(SHAPES.replace(/\\/g, "/"), /scripts\/test\/fixtures\/labs\/plans\/shapes\/$/);
  const { plan } = shapedPlan();
  const real = planShape(plan);
  assert.deepEqual(compareShapes(real, planShape(plan)), []);
  // Reference order is not compared; their content is.
  const reordered = structuredClone(real);
  reordered.resources["azurerm_subnet.vms"].refs.resource_group_name.reverse();
  assert.deepEqual(compareShapes(reordered, real), []);
  // The fixture spells a reference with a literal key where the real plan lists the iterator (lab 16's lesson).
  const fixture = structuredClone(real);
  fixture.resources["azurerm_linux_virtual_machine.files"].refs.network_interface_ids = ["azurerm_network_interface.files[0].id", "azurerm_network_interface.files[0]"];
  const diff = compareShapes(real, fixture);
  assert.equal(diff.length, 1);
  assert.match(diff[0], /azurerm_linux_virtual_machine\.files: network_interface_ids/);
  // A resource only one side has, an unknown path the fixture misses and a sensitive path are each named.
  const fewer = structuredClone(real);
  delete fewer.resources["azurerm_subnet.vms"];
  fewer.resources["azurerm_virtual_network.lab"].unknown = fewer.resources["azurerm_virtual_network.lab"].unknown.filter((p) => p !== "guid");
  fewer.resources["azurerm_linux_virtual_machine.files"].sensitive = [];
  const many = compareShapes(real, fewer).join("\n");
  assert.match(many, /azurerm_subnet\.vms: in the real plan, not in the fixture/);
  assert.match(many, /azurerm_virtual_network\.lab: unknown/);
  assert.match(many, /azurerm_linux_virtual_machine\.files: sensitive/);
});

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

// Batch 3's release tests (2026-10-06) recorded real plan shapes that every fixture differed from in the same few
// ways; realistic.mjs now prints them as Terraform does, for every lab, recorded or not.
test("the realistic plans print sensitive attributes, unset optional-computed blocks, plan-time defaults and dynamic blocks as the real plans did", () => {
  const change = (lab, address) => LAB_PLANS[lab].plan.resource_changes.find((c) => c.address === address).change;
  const config = (lab, address) => LAB_PLANS[lab].plan.configuration.root_module.resources.find((r) => r.address === address);
  // Every attribute the schema calls sensitive, set or not: lab 23 never sets administrator_login_password_wo, lab 27
  // no secure_environment_variables (inside each container block), lab 22's VM no custom_data.
  assert.ok(COMPUTED.types.azurerm_mssql_server.sensitive.includes("administrator_login_password_wo"));
  assert.equal(change("az305-23-sql-failover", "azurerm_mssql_server.primary").after_sensitive.administrator_login_password_wo, true);
  assert.equal(change("az305-27-multi-region", "azurerm_container_group.uks").after_sensitive.container[0].secure_environment_variables, true);
  assert.equal(change("az305-22-keyvault-mi", "azurerm_linux_virtual_machine.vm").after_sensitive.custom_data, true);
  assert.equal(change("az305-26-site-recovery", "azurerm_storage_account.cache").after_sensitive.primary_access_key, true);
  // An Optional and Computed block left unset is wholly unknown; one the lab sets is not.
  assert.equal(change("az305-25-storage-design", "azurerm_storage_account.lake").after_unknown.blob_properties, true);
  assert.equal(change("az305-26-site-recovery", "azurerm_linux_virtual_machine.vm").after_unknown.termination_notification, true);
  assert.ok(UNSET_BLOCKS_UNKNOWN.azurerm_storage_account.includes("network_rules"));
  assert.notEqual(change("az104-07-files", "azurerm_storage_account.files").after_unknown.network_rules, true, "lab 7 sets network_rules");
  assert.equal(change("az104-07-files", "azurerm_storage_account.files").after_unknown.network_rules[0].virtual_network_subnet_ids, true);
  // A default the provider fills in at plan: known, planned, and not in the configuration.
  const law = change("az305-21-monitoring-scale", "azurerm_log_analytics_workspace.lab");
  assert.equal(law.after_unknown.local_authentication_enabled, undefined);
  assert.equal(law.after.local_authentication_enabled, PLAN_DEFAULTS.azurerm_log_analytics_workspace.local_authentication_enabled);
  assert.equal(config("az305-21-monitoring-scale", "azurerm_log_analytics_workspace.lab").expressions.local_authentication_enabled, undefined);
  const pw = change("az305-22-keyvault-mi", "random_password.app_db");
  assert.equal(pw.after_unknown.lower, undefined);
  assert.equal(pw.after.lower, true);
  assert.equal(pw.after.special, false, "a value the lab sets is kept, never replaced by the default");
  // A dynamic block: planned values, no expressions (so no references) in the configuration.
  assert.equal(change("az305-26-site-recovery", "azurerm_linux_virtual_machine.vm").after.admin_ssh_key.length, 1);
  assert.equal(config("az305-26-site-recovery", "azurerm_linux_virtual_machine.vm").expressions.admin_ssh_key, undefined);
  assert.throws(() => realisticPlan({ resources: [{ address: "azurerm_linux_virtual_machine.x", values: { admin_ssh_key: [{ username: "u" }] }, dynamic: ["admin_ssh_key"], refs: { "admin_ssh_key.0.public_key": ["var.ssh_public_key"] } }] }), /dynamic block/);
});

// Lab 26's recorded shape is from its first release test, on Ubuntu 22.04 (v2). Version 3 runs AlmaLinux 9.7: the
// image's publisher, offer, sku and version and the cloud-init text are values, which a shape never holds, and no
// address, reference, unknown or sensitive path changed. So the Ubuntu shape is still the shape to match, compared
// in full rather than skipped; the retest of v3 records its own (lab-release-test.mjs saves shapes/<id>.json).
test("az305-26-site-recovery: the switch to AlmaLinux changes no part of the plan's shape, so the recorded one still applies", () => {
  const d = LAB_PLANS["az305-26-site-recovery"];
  const vm = d.resources.find((r) => r.address === "azurerm_linux_virtual_machine.vm");
  assert.deepEqual(vm.values.source_image_reference, [{ publisher: "almalinux", offer: "almalinux-x86_64", sku: "9-gen2", version: "9.7.2026051801" }]);
  const ubuntu = structuredClone(d);
  ubuntu.resources.find((r) => r.address === vm.address).values.source_image_reference = [{ publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2", version: "latest" }];
  assert.deepEqual(planShape(realisticPlan(ubuntu)), planShape(d.plan));
  // The main.tf change is in values only: the image block and custom_data keep the same references.
  const tf = tfResources(join(LABS, "az305-26-site-recovery", "terraform"))["azurerm_linux_virtual_machine.vm"];
  assert.ok(tf.has("source_image_reference") && tf.has("custom_data") && !tf.has("plan"), "no plan block (a free image)");
  assert.ok(recordedShape("az305-26-site-recovery"), "the v2 shape is recorded");
});
