// labs-storage.test.mjs
//
// Plain English: the storage labs (plan area L6: labs 5, 6 and 7) checked
// without touching Azure. Each lab must pass the catalogue rules
// (scripts/lib/labs.mjs), keep everything inside rg-lab-<id> with addresses
// only from its slot, name its storage accounts from name_prefix (globally
// unique, at most 24 lowercase letters and digits) and build what the plan's
// L6 section says it builds. terraform fmt runs when terraform is installed;
// init and validate are npm run labs-tf's job (they download providers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { buildCatalogue, lintTfText, parseLabYaml, variablesProblems } from "../lib/labs.mjs";

const labsDir = fileURLToPath(new URL("../../labs/", import.meta.url));
const TERRAFORM = spawnSync("terraform", ["version"], { encoding: "utf8" }).status === 0;

// ── Helpers: read a lab and split its Terraform into top-level blocks ────

const lab = (id) => {
  const dir = join(labsDir, id);
  const tfDir = join(dir, "terraform");
  const files = existsSync(tfDir) ? Object.fromEntries(readdirSync(tfDir).filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(join(tfDir, f), "utf8")])) : {};
  const all = Object.values(files).join("\n");
  return { dir, tfDir, files, yaml: parseLabYaml(readFileSync(join(dir, "lab.yaml"), "utf8")).raw, readme: readFileSync(join(dir, "readme.md"), "utf8"), blocks: hclBlocks(all) };
};

/** Drop # and // comment lines, so commented-out code never counts. */
const uncomment = (src) => src.split("\n").map((l) => (/^\s*(#|\/\/)/.test(l) ? "" : l)).join("\n");

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

const resources = (l, type) => l.blocks.filter((b) => b.kind === "resource" && (!type || b.labels[0] === type));
const outputs = (l) => l.blocks.filter((b) => b.kind === "output").map((b) => b.labels[0]);
const attr = (body, name) => body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, "m"))?.[1].trim();

// Resource types that are children of another resource (no resource group, no tags of their own).
const CHILD_TYPES = new Set([
  "azurerm_storage_container",
  "azurerm_storage_blob",
  "azurerm_storage_share",
  "azurerm_storage_management_policy",
  "azurerm_subnet",
  "azurerm_private_dns_zone_virtual_network_link",
  "azurerm_role_assignment",
]);

/** The checks every storage lab shares. */
function commonChecks(id) {
  test(`${id}: lab.yaml and readme pass the catalogue rules, and the readme is no longer a stub`, () => {
    const { problems } = buildCatalogue(labsDir);
    assert.deepEqual(problems.filter((p) => p.lab === id), []);
    assert.doesNotMatch(lab(id).readme, /stub/i);
  });

  test(`${id}: Terraform passes the text lint and declares only contract variables`, () => {
    const l = lab(id);
    assert.ok(Object.keys(l.files).length, "terraform/ has .tf files");
    for (const f of ["versions.tf", "variables.tf", "main.tf", "outputs.tf"]) assert.ok(l.files[f], `terraform/${f} exists`);
    assert.deepEqual(lintTfText(l.files), []);
    assert.deepEqual(variablesProblems(l.files["variables.tf"]), []);
  });

  test(`${id}: one resource group, named by the pipeline, and everything else inside it with the tags`, () => {
    const l = lab(id);
    const rgs = resources(l, "azurerm_resource_group");
    assert.equal(rgs.length, 1);
    assert.equal(attr(rgs[0].body, "name"), "var.resource_group_name");
    assert.equal(attr(rgs[0].body, "tags"), "var.tags");
    for (const r of resources(l).filter((r) => r.labels[0].startsWith("azurerm_") && r.labels[0] !== "azurerm_resource_group")) {
      const rgName = attr(r.body, "resource_group_name");
      if (rgName !== undefined) assert.equal(rgName, "azurerm_resource_group.lab.name", `${r.labels.join(".")} is inside rg-lab-<id>`);
      if (!CHILD_TYPES.has(r.labels[0])) {
        assert.equal(rgName, "azurerm_resource_group.lab.name", `${r.labels.join(".")} names its resource group`);
        assert.equal(attr(r.body, "tags"), "var.tags", `${r.labels.join(".")} carries var.tags`);
      }
    }
  });

  test(`${id}: storage account names come from name_prefix and stay within 24 lowercase letters and digits`, () => {
    const l = lab(id);
    const accounts = resources(l, "azurerm_storage_account");
    assert.ok(accounts.length >= 1);
    for (const a of accounts) {
      const m = attr(a.body, "name")?.match(/^"\$\{var\.name_prefix\}([a-z0-9]+)"$/);
      assert.ok(m, `${a.labels[1]}: name is "\${var.name_prefix}<suffix>"`);
      // name_prefix is l + two digits + 5 lowercase characters: 8.
      assert.ok(8 + m[1].length <= 24, `${a.labels[1]}: ${8 + m[1].length} characters`);
      assert.equal(attr(a.body, "min_tls_version"), '"TLS1_2"');
      assert.equal(attr(a.body, "allow_nested_items_to_be_public"), "false");
    }
    assert.match(l.files["variables.tf"], /variable "name_prefix"[\s\S]*?validation\s*\{[\s\S]*?\^\[a-z0-9\]/, "name_prefix is validated as lowercase letters and digits");
  });

  test(`${id}: lab.yaml agrees with the Terraform on peering, VM sizes and identity`, () => {
    const l = lab(id);
    const k = l.yaml.connectivity;
    assert.equal(outputs(l).includes("peer_vnet_id"), k.peering !== "off", "peer_vnet_id only when the lab can peer");
    for (const o of ["private_ips", "connect"]) assert.ok(outputs(l).includes(o), `output ${o}`);
    const sizes = resources(l).map((r) => attr(r.body, "size")).filter(Boolean).map((s) => s.replace(/"/g, ""));
    assert.deepEqual([...new Set(sizes)].sort(), [...l.yaml.capacity.vm_sizes].sort());
    assert.equal(resources(l, "azuread_group").length > 0, l.yaml.identity.creates.includes("group"));
    assert.equal(resources(l, "azuread_user").length > 0, l.yaml.identity.creates.includes("user"));
    const roles = resources(l, "azurerm_role_assignment").map((r) => attr(r.body, "role_definition_name")?.replace(/"/g, ""));
    assert.deepEqual(roles.sort(), l.yaml.identity.roles.map((r) => r.role).sort());
    // A VNet uses at most subnets_used /20s of the slot, each from cidrsubnet(var.address_space, 2, n).
    const twenties = new Set([...Object.values(l.files).join("\n").matchAll(/cidrsubnet\(var\.address_space,\s*2,\s*(\d+)\)/g)].map((m) => m[1]));
    assert.equal(twenties.size, k.subnets_used);
    // (variables.tf's description says "cidrsubnet(var.address_space, ...)" in prose.)
    const code = uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
    assert.doesNotMatch(code, /cidrsubnet\(var\.address_space,(?!\s*2,)/, "the slot is only ever cut into /20s first");
    assert.ok(Object.values(l.files).join("\n").includes("var.address_space") === k.subnets_used > 0);
  });

  test(`${id}: costs a few pence an hour at most (the £ marker)`, () => {
    const items = lab(id).yaml.cost.items;
    const total = items.reduce((s, i) => s + i.gbp_h * (i.qty ?? 1), 0);
    assert.ok(total > 0 && total < 0.05, `£${total.toFixed(4)}/h`);
  });

  test(`${id}: terraform fmt -check`, { skip: TERRAFORM ? false : "terraform is not installed" }, () => {
    const r = spawnSync("terraform", ["fmt", "-check", "-diff", "-recursive"], { cwd: lab(id).tfDir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}

// ── Lab 5: storage accounts ──────────────────────────────────────────────

commonChecks("az104-05-storage");

test("az104-05-storage: an LRS hot account and a GRS cool account", () => {
  const l = lab("az104-05-storage");
  const accounts = resources(l, "azurerm_storage_account").map((a) => ({ repl: attr(a.body, "account_replication_type"), tier: attr(a.body, "access_tier"), kind: attr(a.body, "account_kind"), perf: attr(a.body, "account_tier") }));
  assert.deepEqual(accounts, [
    { repl: '"LRS"', tier: '"Hot"', kind: '"StorageV2"', perf: '"Standard"' },
    { repl: '"GRS"', tier: '"Cool"', kind: '"StorageV2"', perf: '"Standard"' },
  ]);
});

test("az104-05-storage: a lifecycle policy moves block blobs to cool at 30 days and deletes them at 365", () => {
  const l = lab("az104-05-storage");
  const [p] = resources(l, "azurerm_storage_management_policy");
  assert.ok(p, "a management policy");
  assert.equal(attr(p.body, "storage_account_id"), "azurerm_storage_account.hot.id");
  assert.equal(attr(p.body, "tier_to_cool_after_days_since_modification_greater_than"), "30");
  assert.equal(attr(p.body, "delete_after_days_since_modification_greater_than"), "365");
  assert.match(p.body, /blob_types\s*=\s*\["blockBlob"\]/);
});

test("az104-05-storage: one blob in a private container, and no network at all", () => {
  const l = lab("az104-05-storage");
  assert.equal(resources(l, "azurerm_storage_blob").length, 1);
  const [c] = resources(l, "azurerm_storage_container");
  assert.equal(attr(c.body, "container_access_type"), '"private"');
  assert.equal(attr(c.body, "storage_account_id"), "azurerm_storage_account.hot.id");
  assert.equal(resources(l).filter((r) => /virtual_network|subnet|private_endpoint/.test(r.labels[0])).length, 0);
  assert.equal(l.yaml.connectivity.peering, "off");
});

// ── Lab 6: blob security ─────────────────────────────────────────────────

/** The provider's storage feature: false means Terraform never calls the storage data plane. */
const dataPlaneOff = (l) => /storage\s*\{\s*data_plane_available\s*=\s*false\s*\}/.test(uncomment(l.files["versions.tf"]));

commonChecks("az104-06-blob-security");

test("az104-06-blob-security: a private container made through ARM, and Terraform never calls the data plane", () => {
  const l = lab("az104-06-blob-security");
  const [c] = resources(l, "azurerm_storage_container");
  assert.equal(attr(c.body, "container_access_type"), '"private"');
  assert.match(attr(c.body, "storage_account_id"), /^azurerm_storage_account\.\w+\.id$/);
  // So tear-down still works after you turn public network access off by hand.
  assert.ok(dataPlaneOff(l), "versions.tf sets storage { data_plane_available = false }");
  assert.equal(resources(l, "azurerm_storage_blob").length, 0);
});

test("az104-06-blob-security: a /20 VNet from the slot, a blob private endpoint and the privatelink zone linked to the lab VNet", () => {
  const l = lab("az104-06-blob-security");
  const all = Object.values(l.files).join("\n");
  const [vnet] = resources(l, "azurerm_virtual_network");
  assert.equal(attr(vnet.body, "name"), '"vnet-lab"');
  assert.match(all, /vnet_cidr\s*=\s*cidrsubnet\(var\.address_space,\s*2,\s*0\)/);
  assert.equal(attr(vnet.body, "address_space"), "[local.vnet_cidr]");
  const [pe] = resources(l, "azurerm_private_endpoint");
  assert.match(pe.body, /subresource_names\s*=\s*\["blob"\]/);
  assert.match(pe.body, /private_dns_zone_ids\s*=\s*\[azurerm_private_dns_zone\.blob\.id\]/);
  const [zone] = resources(l, "azurerm_private_dns_zone");
  assert.equal(attr(zone.body, "name"), '"privatelink.blob.core.windows.net"');
  const links = resources(l, "azurerm_private_dns_zone_virtual_network_link");
  assert.equal(links.length, 1, "Terraform links the zone to the lab VNet only");
  assert.equal(attr(links[0].body, "virtual_network_id"), "azurerm_virtual_network.lab.id");
  assert.equal(attr(links[0].body, "registration_enabled"), "false");
});

test("az104-06-blob-security: the pipeline, not Terraform, links the zone to the gateway VNet while peered (dns_link)", () => {
  const l = lab("az104-06-blob-security");
  assert.equal(l.yaml.connectivity.dns_link, true);
  assert.equal(l.yaml.connectivity.peering, "optional");
  const all = uncomment(Object.values(l.files).join("\n"));
  assert.doesNotMatch(all, /var\.gateway_vnet_id|var\.peered/);
  const [out] = l.blocks.filter((b) => b.kind === "output" && b.labels[0] === "peer_vnet_id");
  assert.equal(attr(out.body, "value"), "azurerm_virtual_network.lab.id");
});

test("az104-06-blob-security: group lab-<id>-readers holds Storage Blob Data Reader on the resource group", () => {
  const l = lab("az104-06-blob-security");
  const [g] = resources(l, "azuread_group");
  assert.equal(attr(g.body, "display_name"), '"lab-${var.lab_id}-readers"');
  assert.equal(attr(g.body, "security_enabled"), "true");
  const [ra] = resources(l, "azurerm_role_assignment");
  assert.equal(attr(ra.body, "scope"), "azurerm_resource_group.lab.id");
  assert.equal(attr(ra.body, "role_definition_name"), '"Storage Blob Data Reader"');
  assert.equal(attr(ra.body, "principal_id"), "azuread_group.readers.object_id");
  assert.equal(attr(ra.body, "principal_type"), '"Group"');
  assert.deepEqual(l.yaml.identity.roles, [{ role: "Storage Blob Data Reader", scope: "resource_group" }]);
});

test("az104-06-blob-security: the stored access policy is a thing to try (azurerm cannot make one on a container)", () => {
  const l = lab("az104-06-blob-security");
  const things = l.readme.split("## Things to try")[1].split("## Learn more")[0];
  assert.match(things, /stored access policy/i);
  assert.doesNotMatch(l.readme.split("## Things to try")[0], /stored access policy/i, "What it deploys does not claim one");
});

test("az104-06-blob-security: the private endpoint is authored at Azure's Global price, with no retail meter the feed cannot find", () => {
  // The Retail Prices API has no uksouth row for "Standard Private Endpoint" (Virtual Network Private Link): Azure
  // prices it under region Global only (£0.0075/h, 2026-10-05). The price feed reads one region, so a retail meter
  // here would never refresh, and labs-verify --meters reports it. Authored, as batch 2 ruling 2 does for such items.
  const items = lab("az104-06-blob-security").yaml.cost.items;
  const pe = items.find((i) => /private endpoint/i.test(i.name));
  assert.ok(pe, "a private endpoint cost item");
  assert.equal(pe.retail, undefined);
  assert.ok(Math.abs(pe.gbp_h - 0.0075) / 0.0075 <= 0.25, `£${pe.gbp_h}/h is within 25% of Azure's £0.0075/h`);
  assert.ok(items.every((i) => i.retail?.meter !== "Standard Private Endpoint"));
});

// ── Lab 7: Azure Files from a VM ─────────────────────────────────────────

commonChecks("az104-07-files");

const files7 = () => {
  const l = lab("az104-07-files");
  const tplPath = join(l.tfDir, "cloud-init.yaml.tftpl");
  return { l, tpl: existsSync(tplPath) ? readFileSync(tplPath, "utf8").replace(/\r\n/g, "\n") : "" };
};
const output = (l, name) => l.blocks.find((b) => b.kind === "output" && b.labels[0] === name);

test("az104-07-files: an SMB share made through ARM, behind a firewall that admits only the VM subnet's service endpoint", () => {
  const { l } = files7();
  const [share] = resources(l, "azurerm_storage_share");
  assert.equal(attr(share.body, "enabled_protocol"), '"SMB"');
  assert.equal(attr(share.body, "storage_account_id"), "azurerm_storage_account.files.id");
  assert.ok(Number(attr(share.body, "quota")) <= 5, "a small quota");
  const [acct] = resources(l, "azurerm_storage_account");
  assert.equal(attr(acct.body, "account_replication_type"), '"LRS"');
  assert.equal(attr(acct.body, "account_tier"), '"Standard"', "standard (pay for what is stored), never premium (provisioned)");
  assert.equal(attr(acct.body, "default_action"), '"Deny"');
  assert.equal(attr(acct.body, "virtual_network_subnet_ids"), "[azurerm_subnet.vms.id]");
  const [subnet] = resources(l, "azurerm_subnet");
  assert.equal(attr(subnet.body, "service_endpoints"), '["Microsoft.Storage"]');
  // The GitHub runner is outside the firewall, so Terraform must never call the data plane.
  assert.ok(dataPlaneOff(l), "versions.tf sets storage { data_plane_available = false }");
});

test("az104-07-files: a Standard_B1s Linux VM with no public IP, a standard HDD OS disk and boot diagnostics for the serial console", () => {
  const { l } = files7();
  assert.equal(resources(l, "azurerm_public_ip").length, 0);
  const [nic] = resources(l, "azurerm_network_interface");
  assert.doesNotMatch(nic.body, /public_ip_address_id/);
  const [vm] = resources(l, "azurerm_linux_virtual_machine");
  assert.equal(attr(vm.body, "size"), '"Standard_B1s"');
  assert.equal(attr(vm.body, "storage_account_type"), '"Standard_LRS"');
  assert.match(vm.body, /boot_diagnostics\s*\{\s*\}/);
  assert.equal(attr(vm.body, "admin_password"), "var.admin_password");
  assert.match(vm.body, /dynamic\s+"admin_ssh_key"/, "the operator's SSH key when the pipeline has one");
  assert.match(output(l, "connect").body, /"ssh azureuser@\$\{azurerm_network_interface\.vm\.private_ip_address\}"/);
});

test("az104-07-files: cloud-init mounts the share with a root-only credentials file and never prints the key", () => {
  const { l, tpl } = files7();
  const [vm] = resources(l, "azurerm_linux_virtual_machine");
  assert.match(vm.body, /custom_data\s*=\s*base64encode\(templatefile\("\$\{path\.module\}\/cloud-init\.yaml\.tftpl"/);
  assert.match(vm.body, /key\s*=\s*azurerm_storage_account\.files\.primary_access_key/);
  assert.ok(tpl, "terraform/cloud-init.yaml.tftpl exists");
  assert.match(tpl, /^#cloud-config/);
  // The key is written once, into a 0600 root file, and used only by its path.
  assert.equal([...tpl.matchAll(/\$\{key\}/g)].length, 1, "the key appears once");
  assert.match(tpl, /- path: \/etc\/smbcredentials\/\S+\n(?:[ ]+\S.*\n)*?[ ]+permissions: "0600"/, "the credentials file is written 0600");
  assert.match(tpl, /password=\$\{key\}/);
  const runcmd = tpl.split(/^runcmd:/m)[1] ?? "";
  assert.ok(runcmd, "a runcmd section");
  assert.doesNotMatch(runcmd, /\$\{key\}|password=|set -x/, "commands never carry the key");
  assert.match(runcmd, /credentials=\/etc\/smbcredentials\//);
  assert.match(runcmd, /nofail/, "a failed mount never stops the VM booting");
  assert.match(tpl, /cifs-utils/);
  assert.doesNotMatch(tpl, /\b\d{1,3}(\.\d{1,3}){3}\b/, "no literal addresses");
});

test("az104-07-files: rendered cloud-init is valid YAML and the key lives only in the credentials file", () => {
  const { tpl } = files7();
  const KEY = "FAKEKEY+abc/def==";
  const vars = { account: "l07abcdefiles", host: "l07abcdefiles.file.core.windows.net", share: "labshare", key: KEY };
  const rendered = tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    assert.ok(k in vars, `template variable ${k} is passed by main.tf`);
    return vars[k];
  });
  const doc = parseYaml(rendered);
  assert.deepEqual(doc.packages, ["cifs-utils"]);
  const [cred] = doc.write_files;
  assert.equal(cred.path, "/etc/smbcredentials/l07abcdefiles.cred");
  assert.equal(cred.permissions, "0600");
  assert.equal(cred.content, `username=l07abcdefiles\npassword=${KEY}\n`);
  for (const cmd of doc.runcmd) assert.equal(typeof cmd, "string");
  assert.ok(!JSON.stringify(doc.runcmd).includes(KEY));
  assert.match(doc.runcmd.join("\n"), /\/\/l07abcdefiles\.file\.core\.windows\.net\/labshare \/mnt\/labshare cifs /);
});

test("az104-07-files: the VM subnet keeps default outbound access, so cloud-init can install cifs-utils without a NAT gateway", () => {
  const { l } = files7();
  const [subnet] = resources(l, "azurerm_subnet");
  assert.equal(attr(subnet.body, "default_outbound_access_enabled"), "true");
  assert.equal(resources(l, "azurerm_nat_gateway").length, 0);
});

test("az104-07-files: private_ips names the VM and peer_vnet_id is the lab VNet", () => {
  const { l } = files7();
  assert.match(output(l, "private_ips").body, /"vm-files"\s*=\s*azurerm_network_interface\.vm\.private_ip_address/);
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.lab.id");
});
