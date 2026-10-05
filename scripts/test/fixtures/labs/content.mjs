// scripts/test/fixtures/labs/content.mjs
//
// Plain English: the content checks every batch 2 lab shares, in one place
// (batch 1 wrote them out twice, in labs-storage.test.mjs and
// labs-content-identity.test.mjs, which stay as they are). A content area's
// test file calls labContentSuite(id, { marker }) once per lab, then adds
// that lab's own tests with the helpers below. Everything reads the lab's
// text: no Azure, no terraform init (npm run labs-tf does that).
//
//   lab(id)               { dir, tfDir, files, yaml, readme, blocks }
//                           files   { "main.tf": text, ... } (.tf only)
//                           yaml    lab.yaml as read (YAML 1.1)
//                           readme  readme.md, LF line ends
//                           blocks  top-level HCL blocks { kind, labels, body }
//   resources(l, type?)   resource blocks, optionally of one type
//   attr(body, name)      the right-hand side of `name = ...` (first match, any depth)
//   outputs(l)            output names
//   uncomment(src)        # and // comment lines blanked
//   TERRAFORM             terraform is on PATH
//   CHILD_TYPES           types that need neither a resource group nor tags of their own
//   estimateGbpH(items)   Σ gbp_h × qty, as shared/labs.ts estimateGbpH (authored figures)
//   costMarker(gbpH, deployMin)   as shared/labs.ts costMarker

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, parseLabYaml, variablesProblems } from "../../../lib/labs.mjs";
import { lintDir } from "../../../../infra/ci/lab-lint.mjs";

const LABS = fileURLToPath(new URL("../../../../labs/", import.meta.url));
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
export function lab(id) {
  const dir = join(LABS, id);
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

/** £ per hour from the authored figures: Σ gbp_h × qty (shared/labs.ts estimateGbpH; a Worker test keeps them equal). */
export function estimateGbpH(items) {
  const sum = items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  return Math.round(sum * 1e6) / 1e6;
}

/** The card's marker (shared/labs.ts costMarker): £ under £0.05/h, ££ under £0.50/h, £££ from £0.50/h or a 30-minute deploy. */
export function costMarker(gbpH, deployMin) {
  if (gbpH >= 0.5 || deployMin >= 30) return "£££";
  return gbpH >= 0.05 ? "££" : "£";
}

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

/** Σ qty of the cost items matching `pick`. */
const pricedQty = (l, pick) => l.yaml.cost.items.filter(pick).reduce((n, i) => n + (i.qty ?? 1), 0);

/**
 * The checks every batch 2 lab shares (seven tests, named as in the batch 2
 * plan's "B0 names as built"). `marker`: the lab's cost marker, "£" or "££".
 */
export function labContentSuite(id, { marker }) {
  assert.ok(marker === "£" || marker === "££", `labContentSuite(${id}): marker is "£" or "££"`);

  test(`${id}: lab.yaml and readme pass the catalogue rules, and the readme is no longer a stub`, () => {
    const { problems } = buildCatalogue(LABS);
    assert.deepEqual(problems.filter((p) => p.lab === id), []);
    const l = lab(id);
    assert.doesNotMatch(l.readme, /stub/i);
    assert.match(l.readme, /## What it deploys[\s\S]*```text\n[\s\S]+?\n```[\s\S]*## Things to try/, "What it deploys has a text diagram");
    const learn = l.readme.split("## Learn more")[1]?.split(/\n## |\nAnything you build/)[0] ?? "";
    const links = [...learn.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length >= 1, "Learn more has links");
    for (const u of links) assert.match(u, /^https:\/\/learn\.microsoft\.com\//, u);
  });

  test(`${id}: Terraform passes the text lint and declares only contract variables`, () => {
    const l = lab(id);
    for (const f of ["versions.tf", "variables.tf", "main.tf", "outputs.tf"]) assert.ok(l.files[f], `terraform/${f} exists`);
    // The whole folder, as lab.yml lints it before init: .tf text, .bicep text and the file rules.
    assert.deepEqual(lintDir(l.tfDir), []);
    assert.deepEqual(variablesProblems(l.files["variables.tf"]), []);
    const elsewhere = uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
    for (const b of l.blocks.filter((x) => x.kind === "variable")) assert.match(elsewhere, new RegExp(`\\bvar\\.${b.labels[0]}\\b`), `variable ${b.labels[0]} is declared but never used`);
  });

  test(`${id}: one resource group, named by the pipeline, and everything else inside it with the tags`, () => {
    const l = lab(id);
    const rgs = resources(l, "azurerm_resource_group");
    assert.equal(rgs.length, 1);
    assert.equal(rgs[0].labels[1], "lab");
    assert.equal(attr(rgs[0].body, "name"), "var.resource_group_name");
    assert.equal(attr(rgs[0].body, "tags"), "var.tags");
    for (const r of resources(l).filter((x) => x.labels[0].startsWith("azurerm_") && x.labels[0] !== "azurerm_resource_group")) {
      const at = r.labels.join(".");
      const rgName = attr(r.body, "resource_group_name");
      if (rgName !== undefined) assert.equal(rgName, "azurerm_resource_group.lab.name", `${at} is inside rg-lab-<id>`);
      const rgId = attr(r.body, "resource_group_id");
      if (rgId !== undefined) assert.equal(rgId, "azurerm_resource_group.lab.id", `${at} is inside rg-lab-<id>`);
      if (!CHILD_TYPES.has(r.labels[0])) {
        assert.equal(rgName, "azurerm_resource_group.lab.name", `${at} names its resource group`);
        assert.equal(attr(r.body, "tags"), "var.tags", `${at} carries var.tags`);
      }
    }
  });

  test(`${id}: lab.yaml agrees with the Terraform on peering, VM sizes, subnets and identity`, () => {
    const l = lab(id);
    const k = l.yaml.connectivity;
    assert.equal(outputs(l).includes("peer_vnet_id"), k.peering !== "off", "peer_vnet_id only when the lab can peer");
    for (const o of ["private_ips", "connect"]) assert.ok(outputs(l).includes(o), `output ${o}`);
    // One vm_sizes entry per VM, a scale set counted at its autoscale maximum.
    const sizes = vms(l).flatMap((v) => Array(v.max).fill(v.size));
    assert.deepEqual([...l.yaml.capacity.vm_sizes].sort(), sizes.sort(), "capacity.vm_sizes: one entry per VM at its maximum");
    // Each /20 of the slot from cidrsubnet(var.address_space, 2, n); subnets_used counts them.
    const all = uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
    const twenties = new Set([...all.matchAll(/cidrsubnet\(var\.address_space,\s*2,\s*(\d+)\)/g)].map((m) => m[1]));
    assert.equal(twenties.size, k.subnets_used, "subnets_used is the number of distinct /20s");
    assert.doesNotMatch(all, /cidrsubnet\(var\.address_space,(?!\s*2,)/, "the slot is only ever cut into /20s first");
    assert.equal(/\bvar\.address_space\b/.test(all), k.subnets_used > 0, "var.address_space is used exactly when subnets_used > 0");
    // Batch 2 makes no Entra objects and assigns no roles.
    assert.equal(l.blocks.filter((b) => (b.kind === "resource" || b.kind === "data") && b.labels[0].startsWith("azuread_")).length, 0, "no Entra objects");
    assert.equal(resources(l, "azurerm_role_assignment").length, 0, "no role assignments");
    assert.deepEqual(l.yaml.identity, { creates: [], roles: [], governance: false });
  });

  test(`${id}: VMs have no public IP and use the sizes and disks lab.yaml prices`, () => {
    const l = lab(id);
    for (const nic of resources(l, "azurerm_network_interface")) assert.doesNotMatch(nic.body, /public_ip_address_id/, `${nic.labels[1]}: no public IP on a VM's NIC`);
    for (const v of vms(l)) assert.doesNotMatch(v.r.body, /public_ip_address\s*\{/, `${v.address}: no public IP on scale set instances`);
    // A public IP only where Azure insists on one: an Application Gateway's frontend.
    const gateways = resources(l, "azurerm_application_gateway").map((g) => g.body).join("\n");
    for (const ip of resources(l, "azurerm_public_ip")) assert.ok(gateways.includes(`azurerm_public_ip.${ip.labels[1]}.id`), `azurerm_public_ip.${ip.labels[1]} belongs to an Application Gateway`);
    // Sizes: each priced by a retail.sku item, qty = the default count.
    const bySize = {};
    for (const v of vms(l)) bySize[v.size] = (bySize[v.size] ?? 0) + v.count;
    for (const [size, n] of Object.entries(bySize)) assert.equal(pricedQty(l, (i) => i.retail?.sku === size), n, `${size}: ${n} priced (cost qty is the default count)`);
    // OS disks: Standard HDD (S4), priced per VM.
    const vmCount = vms(l).reduce((n, v) => n + v.count, 0);
    for (const v of vms(l)) assert.equal(attr(v.r.body, "storage_account_type"), '"Standard_LRS"', `${v.address}: a Standard_LRS OS disk`);
    assert.equal(pricedQty(l, (i) => i.retail?.meter === "S4 LRS Disk"), vmCount, "one S4 LRS Disk per VM");
    // Data disks: StandardSSD E1 (4 GiB at most), priced each.
    const disks = resources(l, "azurerm_managed_disk");
    for (const d of disks) {
      assert.equal(attr(d.body, "storage_account_type"), '"StandardSSD_LRS"', `${d.labels[1]}: StandardSSD_LRS`);
      assert.ok(Number(attr(d.body, "disk_size_gb")) <= 4, `${d.labels[1]}: 4 GiB at most (E1)`);
    }
    assert.equal(pricedQty(l, (i) => i.retail?.meter === "E1 LRS Disk"), disks.reduce((n, d) => n + countOf(d), 0), "one E1 LRS Disk per data disk");
  });

  test(`${id}: costs what its marker says`, () => {
    const y = lab(id).yaml;
    const total = estimateGbpH(y.cost.items);
    assert.equal(costMarker(total, y.timing.deploy_min), marker, `£${total.toFixed(4)}/h, deploy ${y.timing.deploy_min} min`);
  });

  test(`${id}: terraform fmt -check`, { skip: TERRAFORM ? false : "terraform is not installed" }, () => {
    const r = spawnSync("terraform", ["fmt", "-check", "-diff", "-recursive", "-no-color"], { cwd: lab(id).tfDir, encoding: "utf8", env: TF_ENV });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
