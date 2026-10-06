// scripts/test/fixtures/labs/content.mjs
//
// Plain English: the content checks every batch 2 lab shares, in one place
// (batch 1 wrote them out twice, in labs-storage.test.mjs and
// labs-content-identity.test.mjs, which stay as they are). A content area's
// test file calls labContentSuite(id, { marker }) once per lab, then adds
// that lab's own tests with the helpers below. Everything reads the lab's
// text: no Azure, no terraform init (npm run labs-tf does that).
//
// Batch 3 (labs batch 3 plan, C0 names): labContentSuite(id, { marker,
// secondary = false, identity = "none" }). `secondary: true` for a lab with
// rg-lab-<id>-secondary in the secondary region; `identity: "match"` for a
// lab whose lab.yaml identity lists its role assignments. Test 3 reads
// plans/schema-facts.json (which types take a resource group and tags), and
// test 5 counts S4 disks per region (`region: secondary` = one per replicated
// VM). contentChecks(id, opts) gives the same checks as { name, skip?, fn }
// without registering them (the suite's own tests run them on fixture labs;
// opts.labsDir and opts.load point them elsewhere).
//
//   lab(id, labsDir?)     { dir, tfDir, files, yaml, readme, blocks }
//                           files   { "main.tf": text, ... } (.tf only)
//                           yaml    lab.yaml as read (YAML 1.1)
//                           readme  readme.md, LF line ends
//                           blocks  top-level HCL blocks { kind, labels, body }
//   resources(l, type?)   resource blocks, optionally of one type
//   attr(body, name)      the right-hand side of `name = ...` (first match, any depth)
//   outputs(l)            output names
//   roleAssignments(l)    [{ address, role, scope, principalType }] per azurerm_role_assignment:
//                           role   a literal role_definition_name, or the lab's custom role's
//                                  name (azurerm_role_definition.<x>.<id or name>), else null
//                           scope  resource_group (azurerm_resource_group.*.id), management_group
//                                  (azurerm_management_group.*.id) or resource (anything else)
//   uncomment(src)        # and // comment lines blanked
//   TERRAFORM             terraform is on PATH
//   CHILD_TYPES           types that need neither a resource group nor tags of their own
//                         (batch 1-2 tests; the suite now reads schema-facts.json)
//   estimateGbpH(items)   Σ gbp_h × qty, as shared/labs.ts estimateGbpH (authored figures)
//   costMarker(gbpH, deployMin)   as shared/labs.ts costMarker

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, cidrOverlaps, GOVERNANCE_LABS, parseLabYaml, variablesProblems } from "../../../lib/labs.mjs";
import { lintDir } from "../../../../infra/ci/lab-lint.mjs";
import { costMarker, estimateGbpH } from "./estimate.mjs";
import { LAB_PLANS } from "./plans/labs.mjs";

const LABS = fileURLToPath(new URL("../../../../labs/", import.meta.url));
/** { "<type>": { rg, tags } } from the provider schemas (plans/extract-computed.mjs writes it). */
const SCHEMA_FACTS = JSON.parse(readFileSync(new URL("./plans/schema-facts.json", import.meta.url), "utf8"));
/** The secondary region every batch 3 lab with regions.secondary names (uksouth's pair). */
const SECONDARY_REGION = "ukwest";
// No update check: it calls out to the internet and can stall a test run.
const TF_ENV = { ...process.env, CHECKPOINT_DISABLE: "1" };
export const TERRAFORM = spawnSync("terraform", ["version"], { encoding: "utf8", env: TF_ENV }).status === 0;

/** Drop # and // comment lines, so commented-out code never counts. */
export const uncomment = (src) => src.split("\n").map((l) => (/^\s*(#|\/\/)/.test(l) ? "" : l)).join("\n");

/** Top-level blocks: { kind, labels, body }. Braces are counted outside strings ("${...}" is balanced anyway). */
function hclBlocks(src) {
  const code = uncomment(src);
  const out = [];
  const re = /^(resource|data|output|variable|locals|provider|terraform)((?:\s+"[^"]*")*)\s*\{/gm;
  for (const m of code.matchAll(re)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    let inStr = false;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (inStr) {
        if (ch === "\\") i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    out.push({ kind: m[1], labels: [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]), body: code.slice(m.index + m[0].length, i) });
  }
  return out;
}

/** A lab's folder read once: lab.yaml, readme and the .tf files split into blocks. */
export function lab(id, labsDir = LABS) {
  const dir = join(labsDir, id);
  const tfDir = join(dir, "terraform");
  const files = existsSync(tfDir) ? Object.fromEntries(readdirSync(tfDir).filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(join(tfDir, f), "utf8").replace(/\r\n/g, "\n")])) : {};
  const all = Object.values(files).join("\n");
  return {
    dir,
    tfDir,
    files,
    yaml: parseLabYaml(readFileSync(join(dir, "lab.yaml"), "utf8")).raw,
    // Windows checkouts may turn LF into CRLF; checks are about content, not line endings.
    readme: readFileSync(join(dir, "readme.md"), "utf8").replace(/\r\n/g, "\n"),
    blocks: hclBlocks(all),
  };
}

export const resources = (l, type) => l.blocks.filter((b) => b.kind === "resource" && (!type || b.labels[0] === type));
export const outputs = (l) => l.blocks.filter((b) => b.kind === "output").map((b) => b.labels[0]);
export const attr = (body, name) => body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m"))?.[1].trim();

/**
 * Resource types that are part of another resource: they need not name the
 * lab's resource group or carry var.tags themselves (most cannot). Any that
 * do name a resource group must name the lab's.
 */
export const CHILD_TYPES = new Set([
  // batch 1
  "azurerm_storage_container",
  "azurerm_storage_blob",
  "azurerm_storage_share",
  "azurerm_storage_management_policy",
  "azurerm_subnet",
  "azurerm_private_dns_zone_virtual_network_link",
  "azurerm_role_assignment",
  // batch 2
  "azurerm_network_security_rule",
  "azurerm_route",
  "azurerm_subnet_network_security_group_association",
  "azurerm_subnet_route_table_association",
  "azurerm_network_interface_security_group_association",
  "azurerm_network_interface_application_security_group_association",
  "azurerm_lb_backend_address_pool",
  "azurerm_lb_probe",
  "azurerm_lb_rule",
  "azurerm_network_interface_backend_address_pool_association",
  "azurerm_virtual_machine_extension",
  "azurerm_virtual_machine_data_disk_attachment",
  "azurerm_virtual_network_peering",
  "azurerm_dns_a_record",
  "azurerm_dns_cname_record",
  "azurerm_private_dns_a_record",
  "azurerm_private_dns_cname_record",
  "azurerm_monitor_data_collection_rule_association",
  "azurerm_backup_policy_vm",
  "azurerm_backup_protected_vm",
  "azurerm_linux_web_app_slot",
]);

// shared/labs.ts estimateGbpH and costMarker, in JavaScript (a Worker test keeps them equal).
export { costMarker, estimateGbpH };

const VM_TYPES = ["azurerm_linux_virtual_machine", "azurerm_windows_virtual_machine"];
const VMSS_TYPES = ["azurerm_linux_virtual_machine_scale_set", "azurerm_windows_virtual_machine_scale_set", "azurerm_orchestrated_virtual_machine_scale_set"];
const unquote = (v) => (v ?? "").replace(/^"|"$/g, "");

/** How many of a resource block there are by default: a literal count, else 1. */
function countOf(r) {
  const c = attr(r.body, "count");
  if (c === undefined) return 1;
  assert.match(c, /^\d+$/, `${r.labels.join(".")}: count is a number, so the checks can count VMs`);
  return Number(c);
}

/** Every VM a lab makes: [{ address, size, count (default), max (autoscale maximum) }]. */
function vms(l) {
  const out = [];
  for (const r of resources(l).filter((x) => VM_TYPES.includes(x.labels[0]))) out.push({ address: r.labels.join("."), r, size: unquote(attr(r.body, "size")), count: countOf(r), max: countOf(r) });
  for (const r of resources(l).filter((x) => VMSS_TYPES.includes(x.labels[0]))) {
    const instances = Number(attr(r.body, "instances") ?? 0);
    const address = r.labels.join(".");
    const scaler = resources(l, "azurerm_monitor_autoscale_setting").find((a) => attr(a.body, "target_resource_id") === `${address}.id`);
    const max = scaler ? Number(attr(scaler.body, "maximum")) : instances;
    out.push({ address, r, size: unquote(attr(r.body, "sku")), count: instances, max });
  }
  return out;
}

/**
 * Site Recovery's replicated VMs: [{ address, size }]. Each has a replica disk
 * in the secondary region, and a failover (or test failover) makes a VM there
 * of its source VM's size, so capacity.vm_sizes lists it too (ruling 3).
 */
function replicatedVms(l) {
  return resources(l, "azurerm_site_recovery_replicated_vm").map((r) => {
    const address = r.labels.join(".");
    const source = /^([a-z0-9_]+\.[A-Za-z0-9_-]+)\.id$/.exec(attr(r.body, "source_vm_id") ?? "")?.[1];
    const vm = vms(l).find((v) => v.address === source);
    assert.ok(vm, `${address}: source_vm_id is a VM this lab makes (azurerm_linux_virtual_machine.<name>.id), so its failover VM can be counted`);
    return { address, size: vm.size };
  });
}

/** Σ qty of the cost items matching `pick`. */
const pricedQty = (l, pick) => l.yaml.cost.items.filter(pick).reduce((n, i) => n + (i.qty ?? 1), 0);

/** Every role assignment a lab makes: [{ address, role, scope, principalType }] (count copies included). */
export function roleAssignments(l) {
  const id = l.yaml?.id ?? "";
  return resources(l, "azurerm_role_assignment").flatMap((r) => {
    const address = r.labels.join(".");
    const named = attr(r.body, "role_definition_name");
    let role = null;
    if (named !== undefined && /^"[^"$]*"$/.test(named)) role = unquote(named);
    else {
      // The lab's own custom role: azurerm_role_definition.<x>.role_definition_resource_id (or .name, .id).
      const ref = /^azurerm_role_definition\.([A-Za-z0-9_-]+)\.(role_definition_resource_id|role_definition_id|name|id)$/.exec(named ?? attr(r.body, "role_definition_id") ?? "");
      const def = ref && resources(l, "azurerm_role_definition").find((d) => d.labels[1] === ref[1]);
      if (def) role = unquote(attr(def.body, "name")).replace(/\$\{var\.lab_id\}/g, id);
    }
    const at = attr(r.body, "scope") ?? "";
    const scope = /^azurerm_resource_group\.[A-Za-z0-9_-]+\.id$/.test(at) ? "resource_group" : /^azurerm_management_group\.[A-Za-z0-9_-]+\.id$/.test(at) ? "management_group" : "resource";
    const pt = attr(r.body, "principal_type");
    return Array(countOf(r)).fill({ address, role, scope, principalType: pt === undefined ? null : unquote(pt) });
  });
}

const ipToInt = (ip) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
/** A CIDR's first and last address as numbers, or null when it is not an IPv4 CIDR. */
function cidrSpan(cidr) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(cidr));
  if (!m || Number(m[2]) > 32) return null;
  const size = 2 ** (32 - Number(m[2]));
  const start = Math.floor(ipToInt(m[1]) / size) * size;
  return [start, start + size - 1];
}

/**
 * The address ranges a lab's plan fixture gives itself (AZ-700 plan Z0.4, ruling 46): every VNet's
 * address_space, every virtual hub's address_prefix and every VPN gateway's point-to-site client pool
 * (vpn_client_configuration.address_space). Each must be inside the session's slot
 * (variables.address_space) and none may overlap another. A range the plan does not know is a problem
 * too: cidrsubnet() of the slot is known at plan, so the fixture gives it. Returns problem sentences.
 * `d`: a plan description ({ variables, resources }, plans/labs.mjs).
 */
export function addressProblems(d) {
  if (!d) return ["no plan fixture for this lab (scripts/test/fixtures/labs/plans/labs/<id>.mjs)"];
  const slot = d.variables?.address_space;
  const slotSpan = cidrSpan(slot);
  if (!slotSpan) return [`the plan fixture's address_space variable (the session's slot) is not a CIDR: ${JSON.stringify(slot)}`];
  const out = [];
  const ranges = [];
  const add = (what, cidr) => {
    const span = cidrSpan(cidr);
    if (!span) out.push(`${what} ${JSON.stringify(cidr)} is not an IPv4 CIDR the plan knows`);
    else if (span[0] < slotSpan[0] || span[1] > slotSpan[1]) out.push(`${what} ${cidr} is outside the slot ${slot}`);
    else ranges.push({ what, cidr });
  };
  const unknown = (r, attr) => (r.unknown ?? []).some((p) => p === attr || p.startsWith(`${attr}.`));
  for (const r of d.resources ?? []) {
    const type = r.address.split(".")[0];
    const v = r.values ?? {};
    if (type === "azurerm_virtual_network") {
      if (!Array.isArray(v.address_space) || !v.address_space.length || unknown(r, "address_space")) out.push(`${r.address}: address_space must be known at plan (cidrsubnet of var.address_space)`);
      else for (const c of v.address_space) add(`${r.address} address space`, c);
    }
    if (type === "azurerm_virtual_hub") {
      if (typeof v.address_prefix !== "string" || unknown(r, "address_prefix")) out.push(`${r.address}: address_prefix must be known at plan (cidrsubnet of var.address_space)`);
      else add(`${r.address} hub prefix`, v.address_prefix);
    }
    if (type === "azurerm_virtual_network_gateway") {
      (v.vpn_client_configuration ?? []).forEach((p, i) => {
        if (!Array.isArray(p?.address_space) || unknown(r, `vpn_client_configuration.${i}.address_space`)) out.push(`${r.address}: vpn_client_configuration's address_space must be known at plan`);
        else for (const c of p.address_space) add(`${r.address} client pool`, c);
      });
    }
  }
  for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) if (cidrOverlaps(ranges[i].cidr, ranges[j].cidr)) out.push(`${ranges[i].what} ${ranges[i].cidr} overlaps ${ranges[j].what} ${ranges[j].cidr}`);
  return out;
}

/**
 * Who may own a public IP (labs spec §17 rulings 5 and 50): the services that must have one. A public
 * IP belongs to one of these, never to a VM (whose NIC may not name one at all).
 */
const PUBLIC_IP_OWNERS = [
  "azurerm_application_gateway",
  "azurerm_virtual_network_gateway",
  "azurerm_route_server",
  "azurerm_firewall",
  "azurerm_bastion_host",
  // A public load balancer's frontend (lab 40's static page, lab 31's outbound-only frontend).
  "azurerm_lb",
  // A NAT gateway's outbound address.
  "azurerm_nat_gateway_public_ip_association",
];

/**
 * The checks every batch 2 and 3 lab shares, as [{ name, skip?, fn }] (names
 * as in the batch 2 plan's "B0 names as built" and the batch 3 plan's C0
 * names). `marker`: "£", "££" or "£££" (£££ from £0.50/h or a deploy of 30
 * minutes or more). `secondary`: the lab has rg-lab-<id>-secondary
 * in the secondary region. `identity`: "none" (no role assignments) or "match"
 * (lab.yaml identity lists them). `addresses` (default true, AZ-700 plan
 * Z0.4): test 6, the plan fixture's VNets, hub prefixes and client pools are
 * inside the slot and do not overlap. `labsDir`, `load` and `plan` (the plan
 * description, plans/labs.mjs) are for the suite's own tests (fixture labs,
 * or a lab changed in memory).
 */
export function contentChecks(id, { marker, secondary = false, identity = "none", addresses = true, labsDir = LABS, load = () => lab(id, labsDir), plan = () => LAB_PLANS[id] } = {}) {
  assert.ok(marker === "£" || marker === "££" || marker === "£££", `labContentSuite(${id}): marker is "£", "££" or "£££"`);
  assert.ok(identity === "none" || identity === "match", `labContentSuite(${id}): identity is "none" or "match"`);
  const groups = secondary ? ["lab", "secondary"] : ["lab"];
  const where = secondary ? "rg-lab-<id> or rg-lab-<id>-secondary" : "rg-lab-<id>";
  const checks = [];
  const check = (name, fn, skip) => checks.push({ name: `${id}: ${name}`, fn, ...(skip ? { skip } : {}) });

  check("lab.yaml and readme pass the catalogue rules, and the readme is no longer a stub", () => {
    const { problems } = buildCatalogue(labsDir);
    assert.deepEqual(problems.filter((p) => p.lab === id), []);
    const l = load();
    assert.doesNotMatch(l.readme, /stub/i);
    assert.match(l.readme, /## What it deploys[\s\S]*```text\n[\s\S]+?\n```[\s\S]*## Things to try/, "What it deploys has a text diagram");
    const learn = l.readme.split("## Learn more")[1]?.split(/\n## |\nAnything you build/)[0] ?? "";
    const links = [...learn.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length >= 1, "Learn more has links");
    for (const u of links) assert.match(u, /^https:\/\/learn\.microsoft\.com\//, u);
  });

  check("Terraform passes the text lint and declares only contract variables", () => {
    const l = load();
    for (const f of ["versions.tf", "variables.tf", "main.tf", "outputs.tf"]) assert.ok(l.files[f], `terraform/${f} exists`);
    // The whole folder, as lab.yml lints it before init: .tf text, .bicep text and the file rules.
    assert.deepEqual(lintDir(l.tfDir), []);
    assert.deepEqual(variablesProblems(l.files["variables.tf"]), []);
    const elsewhere = uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
    for (const b of l.blocks.filter((x) => x.kind === "variable")) assert.match(elsewhere, new RegExp(`\\bvar\\.${b.labels[0]}\\b`), `variable ${b.labels[0]} is declared but never used`);
  });

  const groupsName = secondary
    ? "two resource groups, rg-lab-<id> in the region and rg-lab-<id>-secondary in the secondary region, and everything else inside one of them with the tags"
    : "one resource group, named by the pipeline, and everything else inside it with the tags";
  check(groupsName, () => {
    const l = load();
    const rgs = resources(l, "azurerm_resource_group");
    assert.deepEqual(rgs.map((r) => r.labels[1]).sort(), [...groups].sort(), `the resource groups are azurerm_resource_group.${groups.join(" and .")}`);
    const main = rgs.find((r) => r.labels[1] === "lab");
    assert.equal(attr(main.body, "name"), "var.resource_group_name");
    assert.equal(attr(main.body, "tags"), "var.tags");
    if (secondary) {
      assert.equal(attr(main.body, "location"), "var.region", "rg-lab-<id> is in var.region");
      const sec = rgs.find((r) => r.labels[1] === "secondary");
      assert.equal(attr(sec.body, "name"), '"${var.resource_group_name}-secondary"', "azurerm_resource_group.secondary is rg-lab-<id>-secondary");
      assert.equal(attr(sec.body, "location"), "var.secondary_region", "rg-lab-<id>-secondary is in var.secondary_region");
      assert.equal(attr(sec.body, "tags"), "var.tags");
      assert.equal(l.yaml.regions?.secondary, SECONDARY_REGION, `lab.yaml regions.secondary is ${SECONDARY_REGION}`);
      const v = uncomment(l.files["variables.tf"] ?? "").replace(/\s+/g, " ");
      assert.match(v, /variable "secondary_region" \{.*?validation \{ condition = var\.secondary_region != "" && var\.secondary_region != var\.region /, 'variables.tf refuses an empty secondary_region or one equal to the region (condition = var.secondary_region != "" && var.secondary_region != var.region)');
    }
    const rgNames = groups.map((g) => `azurerm_resource_group.${g}.name`);
    const rgIds = groups.map((g) => `azurerm_resource_group.${g}.id`);
    for (const r of resources(l).filter((x) => x.labels[0].startsWith("azurerm_") && x.labels[0] !== "azurerm_resource_group")) {
      const at = r.labels.join(".");
      const facts = SCHEMA_FACTS[r.labels[0]];
      assert.ok(facts, `${r.labels[0]} is not in plans/schema-facts.json: the integrator adds it to extract-computed.mjs and regenerates`);
      const rgName = attr(r.body, "resource_group_name");
      if (facts.rg || rgName !== undefined) assert.ok(rgNames.includes(rgName), `${at} is inside ${where} (resource_group_name = ${rgName})`);
      const rgId = attr(r.body, "resource_group_id");
      if (rgId !== undefined) assert.ok(rgIds.includes(rgId), `${at} is inside ${where} (resource_group_id = ${rgId})`);
      if (facts.tags) assert.equal(attr(r.body, "tags"), "var.tags", `${at} carries var.tags`);
    }
  });

  check("lab.yaml agrees with the Terraform on peering, VM sizes, subnets and identity", () => {
    const l = load();
    const k = l.yaml.connectivity;
    assert.equal(outputs(l).includes("peer_vnet_id"), k.peering !== "off", "peer_vnet_id only when the lab can peer");
    for (const o of ["private_ips", "connect"]) assert.ok(outputs(l).includes(o), `output ${o}`);
    // One vm_sizes entry per VM at its maximum (a scale set at its autoscale maximum), and one per replicated VM's failover VM.
    const sizes = [...vms(l).flatMap((v) => Array(v.max).fill(v.size)), ...replicatedVms(l).map((v) => v.size)];
    assert.deepEqual([...l.yaml.capacity.vm_sizes].sort(), sizes.sort(), "capacity.vm_sizes: one entry per VM at its maximum, and one per replicated VM");
    // Each /20 of the slot from cidrsubnet(var.address_space, 2, n); subnets_used counts them.
    const all = uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
    const twenties = new Set([...all.matchAll(/cidrsubnet\(var\.address_space,\s*2,\s*(\d+)\)/g)].map((m) => m[1]));
    assert.equal(twenties.size, k.subnets_used, "subnets_used is the number of distinct /20s");
    assert.doesNotMatch(all, /cidrsubnet\(var\.address_space,(?!\s*2,)/, "the slot is only ever cut into /20s first");
    assert.equal(/\bvar\.address_space\b/.test(all), k.subnets_used > 0, "var.address_space is used exactly when subnets_used > 0");
    if (identity === "none") {
      // Batch 2 makes no Entra objects and assigns no roles.
      assert.equal(l.blocks.filter((b) => (b.kind === "resource" || b.kind === "data") && b.labels[0].startsWith("azuread_")).length, 0, "no Entra objects");
      assert.equal(resources(l, "azurerm_role_assignment").length, 0, "no role assignments");
      assert.deepEqual(l.yaml.identity, { creates: [], roles: [], governance: false });
      return;
    }
    // identity "match": lab.yaml lists exactly what the Terraform assigns and makes.
    const ras = roleAssignments(l);
    for (const r of ras) assert.ok(r.principalType, `${r.address} sets principal_type`);
    const key = (x) => `${x.role} at ${x.scope}`;
    assert.deepEqual((l.yaml.identity.roles ?? []).map(key).sort(), ras.map(key).sort(), "identity.roles lists the Terraform's role assignments ({ role, scope })");
    const made = [...new Set(resources(l).filter((b) => b.labels[0] === "azuread_user" || b.labels[0] === "azuread_group").map((b) => b.labels[0].slice("azuread_".length)))].sort();
    assert.deepEqual([...new Set(l.yaml.identity.creates ?? [])].sort(), made, "identity.creates lists the Entra object types the Terraform makes");
    assert.equal(l.yaml.identity.governance, GOVERNANCE_LABS.includes(id), "identity.governance is true exactly for the governance labs");
  });

  check("VMs have no public IP and use the sizes and disks lab.yaml prices", () => {
    const l = load();
    for (const nic of resources(l, "azurerm_network_interface")) assert.doesNotMatch(nic.body, /public_ip_address_id/, `${nic.labels[1]}: no public IP on a VM's NIC`);
    for (const v of vms(l)) assert.doesNotMatch(v.r.body, /public_ip_address\s*\{/, `${v.address}: no public IP on scale set instances`);
    // A public IP only where Azure insists on one (rulings 5 and 50): an Application Gateway, a VPN gateway,
    // a Route Server, a firewall, Bastion, a public load balancer's frontend or a NAT gateway.
    const owners = resources(l).filter((r) => PUBLIC_IP_OWNERS.includes(r.labels[0])).map((g) => g.body).join("\n");
    for (const ip of resources(l, "azurerm_public_ip")) assert.ok(new RegExp(`\\bazurerm_public_ip\\.${ip.labels[1]}\\.id\\b`).test(owners), `azurerm_public_ip.${ip.labels[1]} belongs to one of ${PUBLIC_IP_OWNERS.join(", ")} (rulings 5 and 50), never a VM`);
    // Sizes: each priced by a retail.sku item in the session's region, qty = the default count.
    const bySize = {};
    for (const v of vms(l)) bySize[v.size] = (bySize[v.size] ?? 0) + v.count;
    for (const [size, n] of Object.entries(bySize)) assert.equal(pricedQty(l, (i) => i.retail?.sku === size && !i.region), n, `${size}: ${n} priced (cost qty is the default count)`);
    // OS disks: Standard HDD (S4), priced per VM in the region; a replicated VM's replica disk in the secondary region.
    const vmCount = vms(l).reduce((n, v) => n + v.count, 0);
    for (const v of vms(l)) assert.equal(attr(v.r.body, "storage_account_type"), '"Standard_LRS"', `${v.address}: a Standard_LRS OS disk`);
    assert.equal(pricedQty(l, (i) => i.retail?.meter === "S4 LRS Disk" && !i.region), vmCount, "one S4 LRS Disk per VM");
    assert.equal(pricedQty(l, (i) => i.retail?.meter === "S4 LRS Disk" && i.region === "secondary"), replicatedVms(l).length, "one S4 LRS Disk with region: secondary per replicated VM (its replica disk)");
    // Data disks: StandardSSD E1 (4 GiB at most), priced each.
    const disks = resources(l, "azurerm_managed_disk");
    for (const d of disks) {
      assert.equal(attr(d.body, "storage_account_type"), '"StandardSSD_LRS"', `${d.labels[1]}: StandardSSD_LRS`);
      assert.ok(Number(attr(d.body, "disk_size_gb")) <= 4, `${d.labels[1]}: 4 GiB at most (E1)`);
    }
    assert.equal(pricedQty(l, (i) => i.retail?.meter === "E1 LRS Disk"), disks.reduce((n, d) => n + countOf(d), 0), "one E1 LRS Disk per data disk");
  });

  // Test 6 (AZ-700 plan Z0.4, ruling 46): from the plan fixture, at its slot (slot 31 for AZ-700 labs).
  if (addresses) {
    check("every VNet, hub prefix and client pool is inside the slot and none overlap", () => {
      assert.deepEqual(addressProblems(plan()), []);
    });
  }

  check("costs what its marker says", () => {
    const y = load().yaml;
    const total = estimateGbpH(y.cost.items);
    assert.equal(costMarker(total, y.timing.deploy_min), marker, `£${total.toFixed(4)}/h, deploy ${y.timing.deploy_min} min`);
  });

  check(
    "terraform fmt -check",
    () => {
      const r = spawnSync("terraform", ["fmt", "-check", "-diff", "-recursive", "-no-color"], { cwd: load().tfDir, encoding: "utf8", env: TF_ENV });
      assert.equal(r.status, 0, r.stdout + r.stderr);
    },
    TERRAFORM ? false : "terraform is not installed",
  );
  return checks;
}

/**
 * The shared checks as node:test tests (seven, named as in the batch 2 plan's
 * "B0 names as built"; batch 3's options as in its C0 names). `marker`: the
 * lab's cost marker, "£", "££" or "£££".
 */
export function labContentSuite(id, opts) {
  for (const c of contentChecks(id, opts)) test(c.name, c.skip ? { skip: c.skip } : {}, c.fn);
}
