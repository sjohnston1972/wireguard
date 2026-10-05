// labs-compute.test.mjs
//
// Plain English: the compute labs (batch 2 plan area B1: labs 8 to 12)
// checked without touching Azure. Each lab runs the shared content suite
// (fixtures/labs/content.mjs: catalogue rules, lint, one resource group,
// lab.yaml agreeing with the Terraform, no public IPs, prices, marker, fmt),
// then its own tests below, named as the plan names them. lab-plans.test.mjs
// runs each lab's realistic plan (fixtures/labs/plans/labs/<id>.mjs) through
// the scope check; npm run labs-tf does init and validate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templateProblems } from "../../infra/ci/lab-scope.mjs";
import { BICEP_VERSION, pinnedBicep } from "../lib/bicep.mjs";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import lab12Plan from "./fixtures/labs/plans/labs/az104-12-bicep.mjs";

/** The body of resource `type.name` (asserts it exists). */
function body(l, type, name) {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r.body;
}
/** All of a lab's .tf text, comments blanked. */
const tfText = (l) => uncomment(Object.values(l.files).join("\n"));
/** All of a lab's locals blocks, together. */
const localsText = (l) => l.blocks.filter((b) => b.kind === "locals").map((b) => b.body).join("\n");

// ── Lab 8: VMs, availability zones, disks and extensions ────────────────

const L8 = "az104-08-vms";
labContentSuite(L8, { marker: "£" });

test(`${L8}: two Standard_B1s Ubuntu VMs in zones 1 and 2 with no public IP`, () => {
  const l = lab(L8);
  const vms = resources(l, "azurerm_linux_virtual_machine");
  assert.equal(vms.length, 2);
  assert.deepEqual(vms.map((v) => attr(v.body, "zone")).sort(), ['"1"', '"2"']);
  for (const v of vms) {
    assert.equal(attr(v.body, "size"), '"Standard_B1s"');
    assert.equal(attr(v.body, "offer"), '"ubuntu-24_04-lts"');
    assert.equal(attr(v.body, "sku"), '"server"');
    assert.equal(attr(v.body, "admin_password"), "var.admin_password");
    assert.match(v.body, /boot_diagnostics\s*\{\s*\}/, "boot diagnostics on, so the serial console works");
  }
  assert.equal(resources(l, "azurerm_public_ip").length, 0);
  assert.equal(resources(l, "azurerm_network_interface").length, 2);
});

test(`${L8}: a 4 GiB Standard SSD data disk in the first VM's zone, attached at LUN 0`, () => {
  const l = lab(L8);
  const disks = resources(l, "azurerm_managed_disk");
  assert.equal(disks.length, 1);
  const d = disks[0].body;
  assert.equal(attr(d, "disk_size_gb"), "4");
  assert.equal(attr(d, "storage_account_type"), '"StandardSSD_LRS"');
  assert.equal(attr(d, "create_option"), '"Empty"');
  assert.equal(attr(d, "zone"), attr(body(l, "azurerm_linux_virtual_machine", "zone1"), "zone"), "a zonal disk must be in its VM's zone");
  const att = resources(l, "azurerm_virtual_machine_data_disk_attachment");
  assert.equal(att.length, 1);
  assert.equal(attr(att[0].body, "lun"), "0");
  assert.equal(attr(att[0].body, "managed_disk_id"), `azurerm_managed_disk.${disks[0].labels[1]}.id`);
  assert.equal(attr(att[0].body, "virtual_machine_id"), "azurerm_linux_virtual_machine.zone1.id");
});

test(`${L8}: a Custom Script extension serves the VM's name on port 80 with python3 and installs nothing`, () => {
  const l = lab(L8);
  const exts = resources(l, "azurerm_virtual_machine_extension");
  assert.deepEqual(exts.map((e) => attr(e.body, "virtual_machine_id")).sort(), ["azurerm_linux_virtual_machine.zone1.id", "azurerm_linux_virtual_machine.zone2.id"], "one on each VM");
  for (const e of exts) {
    assert.equal(attr(e.body, "publisher"), '"Microsoft.Azure.Extensions"');
    assert.equal(attr(e.body, "type"), '"CustomScript"');
    assert.match(attr(e.body, "settings"), /commandToExecute\s*=\s*local\.serve_web/);
    assert.doesNotMatch(e.body, /protected_settings/, "nothing secret, so nothing hidden");
  }
  const cmd = localsText(l);
  assert.match(cmd, /serve_web\s*=/);
  assert.match(cmd, /hostname\s*>\s*\/srv\/www\/index\.html/, "serves the VM's name");
  assert.match(cmd, /python3 -m http\.server 80/);
  assert.match(cmd, /systemctl enable --now/, "a systemd unit, so it survives a reboot");
  assert.doesNotMatch(cmd, /\b(apt|apt-get|pip|snap|curl|wget)\b|fileUris/, "installs and downloads nothing");
  assert.ok(outputs(l).includes("peer_vnet_id"));
});

// ── Lab 9: VM Scale Sets and autoscale ──────────────────────────────────

const L9 = "az104-09-vmss";
labContentSuite(L9, { marker: "£" });

test(`${L9}: a Uniform scale set of Standard_B1s, 2 instances, no public IP, upgrade mode Manual`, () => {
  const l = lab(L9);
  assert.equal(resources(l, "azurerm_orchestrated_virtual_machine_scale_set").length, 0, "Uniform, not Flexible (ruling 6)");
  assert.equal(resources(l, "azurerm_linux_virtual_machine").length, 0);
  const sets = resources(l, "azurerm_linux_virtual_machine_scale_set");
  assert.equal(sets.length, 1);
  const s = sets[0].body;
  assert.equal(attr(s, "sku"), '"Standard_B1s"');
  assert.equal(attr(s, "instances"), "2");
  assert.equal(attr(s, "upgrade_mode"), '"Manual"');
  assert.equal(attr(s, "overprovision"), "false", "no extra instances while scaling, so quota and cost stay as priced");
  assert.equal(attr(s, "offer"), '"ubuntu-24_04-lts"');
  assert.equal(attr(s, "admin_password"), "var.admin_password");
  assert.doesNotMatch(s, /public_ip_address\s*\{/);
  assert.match(s, /lifecycle\s*\{\s*ignore_changes\s*=\s*\[instances\]/, "autoscale owns the instance count after deploy");
  // Each instance serves its name with python3 from a cloud-init systemd unit (ruling 5): nothing installed.
  assert.equal(attr(s, "custom_data"), 'filebase64("${path.module}/cloud-init.yaml")');
  const ci = readFileSync(join(l.tfDir, "cloud-init.yaml"), "utf8");
  assert.match(ci, /^#cloud-config/);
  assert.match(ci, /hostname > \/srv\/www\/index\.html/);
  assert.match(ci, /python3 -m http\.server 80/);
  assert.match(ci, /enable, --now, lab-web\.service/);
  assert.doesNotMatch(ci, /^\s*(packages|package_update|package_upgrade)\s*:/m, "no packages");
  assert.doesNotMatch(ci, /\b(apt|apt-get|pip|snap|curl|wget)\b/);
});

test(`${L9}: autoscale 1 to 3 on average CPU, out above 70% and in below 25%`, () => {
  const l = lab(L9);
  const scalers = resources(l, "azurerm_monitor_autoscale_setting");
  assert.equal(scalers.length, 1);
  const a = scalers[0].body;
  assert.equal(attr(a, "target_resource_id"), "azurerm_linux_virtual_machine_scale_set.web.id");
  assert.equal(attr(a, "minimum"), "1");
  assert.equal(attr(a, "maximum"), "3");
  assert.equal(attr(a, "default"), "2");
  const rules = [...a.matchAll(/rule\s*\{([\s\S]*?scale_action\s*\{[\s\S]*?\})/g)].map((m) => m[1]);
  assert.equal(rules.length, 2);
  const rule = (direction) => rules.find((r) => attr(r, "direction") === `"${direction}"`);
  for (const [direction, operator, threshold] of [["Increase", "GreaterThan", "70"], ["Decrease", "LessThan", "25"]]) {
    const r = rule(direction);
    assert.ok(r, `a ${direction} rule`);
    assert.equal(attr(r, "metric_name"), '"Percentage CPU"');
    assert.equal(attr(r, "metric_resource_id"), "azurerm_linux_virtual_machine_scale_set.web.id");
    assert.equal(attr(r, "time_aggregation"), '"Average"');
    assert.equal(attr(r, "operator"), `"${operator}"`);
    assert.equal(attr(r, "threshold"), threshold);
    assert.equal(attr(r, "value"), '"1"');
  }
});

test(`${L9}: vm_sizes lists three Standard_B1s, the autoscale maximum, and the cost two`, () => {
  const y = lab(L9).yaml;
  assert.deepEqual(y.capacity.vm_sizes, ["Standard_B1s", "Standard_B1s", "Standard_B1s"]);
  assert.equal(y.cost.items.find((i) => i.retail?.sku === "Standard_B1s").qty, 2);
  assert.equal(y.cost.items.find((i) => i.retail?.meter === "S4 LRS Disk").qty, 2);
  assert.deepEqual(y.prerequisites, ["az104-08-vms"]);
});

// ── Lab 11: Containers, ACI and Container Apps ──────────────────────────

const L11 = "az104-11-containers";
labContentSuite(L11, { marker: "£" });

test(`${L11}: an ACI group of 0.5 vCPU and 0.5 GB with a private IP in a delegated subnet`, () => {
  const l = lab(L11);
  const groups = resources(l, "azurerm_container_group");
  assert.equal(groups.length, 1);
  const g = groups[0].body;
  assert.equal(attr(g, "os_type"), '"Linux"');
  assert.equal(attr(g, "ip_address_type"), '"Private"', "no public IP (ruling 5)");
  assert.doesNotMatch(g, /dns_name_label/);
  assert.equal(attr(g, "subnet_ids"), "[azurerm_subnet.aci.id]");
  assert.equal(attr(g, "image"), '"mcr.microsoft.com/azuredocs/aci-helloworld:latest"', "from MCR: the registry stays empty");
  assert.equal(attr(g, "cpu"), "0.5");
  assert.equal(attr(g, "memory"), "0.5");
  assert.equal(attr(g, "port"), "80");
  const subnet = body(l, "azurerm_subnet", "aci");
  assert.match(subnet, /service_delegation\s*\{[^}]*name\s*=\s*"Microsoft\.ContainerInstance\/containerGroups"/);
  // The subnet's service association link can hold it for minutes after the group goes.
  assert.ok(l.yaml.timing.destroy_min >= 6, "destroy_min allows for the subnet's service association link");
});

test(`${L11}: a consumption-only Container Apps environment with no infrastructure subnet and an app that scales to zero`, () => {
  const l = lab(L11);
  const envs = resources(l, "azurerm_container_app_environment");
  assert.equal(envs.length, 1);
  const e = envs[0].body;
  // No subnet and no workload profile: consumption only, and Azure makes no
  // infrastructure group (ME_...) outside rg-lab-<id> (ruling 7).
  assert.doesNotMatch(e, /infrastructure_subnet_id|infrastructure_resource_group_name|workload_profile|internal_load_balancer_enabled/);
  assert.doesNotMatch(e, /log_analytics_workspace_id/, "no workspace: nothing billed per GB");
  const apps = resources(l, "azurerm_container_app");
  assert.equal(apps.length, 1);
  const a = apps[0].body;
  assert.equal(attr(a, "container_app_environment_id"), `azurerm_container_app_environment.${envs[0].labels[1]}.id`);
  assert.equal(attr(a, "min_replicas"), "0", "scales to zero: no charge while idle");
  assert.equal(attr(a, "max_replicas"), "1");
  assert.equal(attr(a, "image"), '"mcr.microsoft.com/k8se/quickstart:latest"');
  assert.equal(attr(a, "external_enabled"), "true", "public ingress, accepted (ruling 5)");
  assert.equal(attr(a, "target_port"), "80");
  assert.doesNotMatch(a, /workload_profile_name|registry\s*\{|identity\s*\{/);
});

test(`${L11}: an empty Basic registry with the admin user off, named from name_prefix`, () => {
  const l = lab(L11);
  const regs = resources(l, "azurerm_container_registry");
  assert.equal(regs.length, 1);
  const r = regs[0].body;
  assert.equal(attr(r, "name"), '"${var.name_prefix}acr"');
  assert.equal(attr(r, "sku"), '"Basic"');
  assert.equal(attr(r, "admin_enabled"), "false");
  assert.doesNotMatch(r, /georeplications|identity\s*\{/);
  // Nothing pulls from it: AcrPull is not on the allow-list (ruling 7).
  assert.doesNotMatch(tfText(l), /\.login_server\}?[^"]*\/|azurerm_container_registry_task|azurerm_role_assignment/);
  assert.ok(l.yaml.cost.items.some((i) => i.retail?.meter === "Basic Registry Unit" && i.retail.unit === "1/Day"));
});

// ── Lab 12: ARM and Bicep templates ─────────────────────────────────────

const L12 = "az104-12-bicep";
labContentSuite(L12, { marker: "£" });

/** The pinned Bicep from labs-tf's cache, never downloaded here (null: skip). */
const bicep = await pinnedBicep({ cacheDir: join(tmpdir(), "labs-bicep", BICEP_VERSION), fetch: async () => { throw new Error("no download in npm test"); }, log: () => {} });

test(`${L12}: Terraform deploys main.json, built from main.bicep, into the lab's group in Incremental mode`, () => {
  const l = lab(L12);
  for (const f of ["main.bicep", "vnet.bicep"]) assert.ok(existsSync(join(l.tfDir, f)), `terraform/${f}`);
  const deps = resources(l, "azurerm_resource_group_template_deployment");
  assert.equal(deps.length, 1);
  const d = deps[0].body;
  assert.equal(attr(d, "resource_group_name"), "azurerm_resource_group.lab.name");
  assert.equal(attr(d, "deployment_mode"), '"Incremental"');
  // Built at lab.yml step 5 by the pinned Bicep; never committed (the lint's file rule) and read at plan.
  assert.equal(attr(d, "template_content"), 'file("${path.module}/main.json")');
  assert.doesNotMatch(d, /template_spec_version_id/);
  assert.equal(resources(l).filter((r) => /template_deployment$/.test(r.labels[0]) && r.labels[0] !== "azurerm_resource_group_template_deployment").length, 0, "no deployment at another scope");
  const main = readFileSync(join(l.tfDir, "main.bicep"), "utf8");
  assert.match(main, /^module\s+vnet\s+'vnet\.bicep'/m, "one local module");
  assert.equal([...main.matchAll(/^module\s/gm)].length, 1);
  assert.match(main, /^param\s+\w+/m);
  assert.match(main, /^output\s+\w+/m);
  assert.doesNotMatch(main, /^targetScope/m, "a resource group deployment (the default scope)");
});

test(`${L12}: the template's addresses come from a parameter set from cidrsubnet(var.address_space, 2, 0)`, () => {
  const l = lab(L12);
  const d = resources(l, "azurerm_resource_group_template_deployment")[0].body;
  assert.match(d, /parameters_content\s*=\s*jsonencode\(\{[\s\S]*vnetCidr\s*=\s*\{\s*value\s*=\s*cidrsubnet\(var\.address_space,\s*2,\s*0\)\s*\}/);
  const main = readFileSync(join(l.tfDir, "main.bicep"), "utf8");
  const vnet = readFileSync(join(l.tfDir, "vnet.bicep"), "utf8");
  assert.match(main, /^param vnetCidr string$/m);
  assert.match(main, /cidr:\s*vnetCidr/, "passed to the module");
  assert.match(vnet, /addressPrefixes:\s*\[\s*cidr\s*\]/);
  assert.match(vnet, /cidrSubnet\(cidr,\s*24,/, "each subnet a /24 of the parameter");
});

test(`${L12}: template deletion removes what the template made`, () => {
  const l = lab(L12);
  const provider = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm").body;
  assert.match(provider, /template_deployment\s*\{\s*delete_nested_items_during_deletion\s*=\s*true\s*\}/);
  assert.match(provider, /prevent_deletion_if_contains_resources\s*=\s*false/, "and the group goes whatever is left");
});

test(`${L12}: the built template passes templateProblems`, { skip: bicep ? false : "the pinned Bicep is not in the cache (npm run labs-tf -- az104-12-bicep fetches it)" }, () => {
  const l = lab(L12);
  const dir = mkdtempSync(join(tmpdir(), "lab12-bicep-"));
  for (const f of ["main.bicep", "vnet.bicep"]) cpSync(join(l.tfDir, f), join(dir, f));
  const r = spawnSync(bicep, ["build", "main.bicep", "--outfile", "main.json"], { cwd: dir, encoding: "utf8", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const built = JSON.parse(readFileSync(join(dir, "main.json"), "utf8"));
  assert.deepEqual(templateProblems(built), []);
  assert.match(built.$schema, /\/deploymentTemplate\.json#$/);
  assert.ok(Object.values(built.resources).some((x) => x.type === "Microsoft.Resources/deployments"), "the module is a nested deployment");
  // The plan fixture deploys exactly this template, so lab-plans checks the real thing.
  assert.deepEqual(JSON.parse(lab12Plan().resources.find((x) => x.address === "azurerm_resource_group_template_deployment.bicep").values.template_content), built);
});
