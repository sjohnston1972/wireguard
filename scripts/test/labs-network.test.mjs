// labs-network.test.mjs
//
// Plain English: the networking labs (batch 2 plan area B2: labs 13-17)
// checked without touching Azure. Each lab runs the shared content suite
// (fixtures/labs/content.mjs: catalogue rules, lint, one resource group,
// peering and subnets, no public IP on a VM, prices, terraform fmt), then
// the tests the plan names for it: what it builds, read from its Terraform
// text. Plans and the scope check are lab-plans.test.mjs's job; init and
// validate are npm run labs-tf's (they download providers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";

// ── Helpers ──────────────────────────────────────────────────────────────

const unq = (v) => (v ?? "").replace(/^"|"$/g, "");
/** One resource block by type and name. */
const res = (l, type, name) => {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r;
};
const output = (l, name) => l.blocks.find((b) => b.kind === "output" && b.labels[0] === name);
/** Every Terraform file but variables.tf, comments dropped. */
const code = (l) => uncomment(Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => t).join("\n"));
/** The locals block's `name = expression` lines: { name: expression }. */
const locals = (l) => Object.fromEntries(l.blocks.filter((b) => b.kind === "locals").flatMap((b) => [...b.body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*(.+)$/gm)].map((m) => [m[1], m[2].trim()])));

/** The NSG rules (azurerm_network_security_rule) of one NSG, read into plain objects. */
const rulesOf = (l, nsg) =>
  resources(l, "azurerm_network_security_rule")
    .filter((r) => attr(r.body, "network_security_group_name") === `azurerm_network_security_group.${nsg}.name`)
    .map((r) => ({
      key: r.labels[1],
      name: unq(attr(r.body, "name")),
      priority: Number(attr(r.body, "priority")),
      direction: unq(attr(r.body, "direction")),
      access: unq(attr(r.body, "access")),
      protocol: unq(attr(r.body, "protocol")),
      port: unq(attr(r.body, "destination_port_range")),
      src: unq(attr(r.body, "source_address_prefix")),
      srcAsg: attr(r.body, "source_application_security_group_ids"),
      dstAsg: attr(r.body, "destination_application_security_group_ids"),
      body: r.body,
    }));

/** The subnet an NSG (or route table) is associated with, by association resources: { nsgOrRtName: subnetName }. */
const associations = (l, type, field) =>
  Object.fromEntries(
    resources(l, type).map((a) => [attr(a.body, field).replace(/^azurerm_[a-z_]+\.([a-z0-9_]+)\.id$/, "$1"), attr(a.body, "subnet_id").replace(/^azurerm_subnet\.([a-z0-9_]+)\.id$/, "$1")]),
  );

/** A VM's cloud-init: the template it renders and the port it is given (custom_data = base64encode(templatefile(...))). */
function webInit(l, vm) {
  const cd = attr(vm.body, "custom_data") ?? "";
  const m = /^base64encode\(templatefile\("\$\{path\.module\}\/(cloud-init\.yaml\.tftpl)", \{ port = (\d+) \}\)\)$/.exec(cd);
  assert.ok(m, `${vm.labels[1]}: custom_data renders cloud-init.yaml.tftpl with a port (${cd})`);
  return Number(m[2]);
}

/** cloud-init.yaml.tftpl rendered for a port and parsed. */
function renderedInit(l, port) {
  const path = join(l.tfDir, "cloud-init.yaml.tftpl");
  assert.ok(existsSync(path), "terraform/cloud-init.yaml.tftpl exists");
  const tpl = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const rendered = tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    assert.equal(k, "port", `the template takes only port (found ${k})`);
    return String(port);
  });
  return { tpl, doc: parseYaml(rendered) };
}

/**
 * Batch 2 ruling 5: a VM serves with python3 -m http.server from a
 * cloud-init systemd unit, and installs nothing (no dependency on outbound
 * access). Checks every VM that renders cloud-init.yaml.tftpl.
 */
function servesWithPython(id, expected) {
  test(`${id}: VMs serve their name with python3 -m http.server from a cloud-init systemd unit and install nothing`, () => {
    const l = lab(id);
    const ports = {};
    for (const vm of resources(l, "azurerm_linux_virtual_machine").filter((v) => attr(v.body, "custom_data")?.includes("cloud-init.yaml.tftpl"))) ports[vm.labels[1]] = webInit(l, vm);
    assert.deepEqual(ports, expected, "which VMs serve, on which port");
    for (const port of new Set(Object.values(ports))) {
      const { tpl, doc } = renderedInit(l, port);
      assert.match(tpl, /^#cloud-config\n/);
      assert.equal(doc.packages, undefined, "no packages");
      assert.notEqual(doc.package_update, true, "no apt update");
      assert.notEqual(doc.package_upgrade, true, "no apt upgrade");
      const unit = doc.write_files.find((f) => f.path === "/etc/systemd/system/lab-http.service");
      assert.ok(unit, "a systemd unit lab-http.service");
      assert.match(unit.content, new RegExp(`^ExecStart=/usr/bin/python3 -m http\\.server ${port} --directory /srv/lab$`, "m"));
      assert.match(unit.content, /hostname > \/srv\/lab\/index\.html/, "it serves the VM's name");
      assert.match(unit.content, /^Restart=always$/m);
      assert.match(unit.content, /^WantedBy=multi-user\.target$/m);
      assert.ok(doc.runcmd.includes("systemctl enable --now lab-http.service"));
      assert.doesNotMatch(tpl, /\b\d{1,3}(\.\d{1,3}){3}\b/, "no literal addresses");
    }
  });
}

// ── Lab 13: VNets, subnets, NSGs, ASGs ───────────────────────────────────

const L13 = "az104-13-vnets";
labContentSuite(L13, { marker: "£" });
servesWithPython(L13, { web: 80, app: 8080 });

test(`${L13}: one /20 VNet with web and app subnets and an NSG on each`, () => {
  const l = lab(L13);
  const loc = locals(l);
  assert.equal(loc.vnet_cidr, "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(loc.web_cidr, "cidrsubnet(local.vnet_cidr, 4, 0)");
  assert.equal(loc.app_cidr, "cidrsubnet(local.vnet_cidr, 4, 1)");
  const [vnet, ...more] = resources(l, "azurerm_virtual_network");
  assert.equal(more.length, 0, "one VNet");
  assert.equal(attr(vnet.body, "address_space"), "[local.vnet_cidr]");
  assert.deepEqual(resources(l, "azurerm_subnet").map((s) => [s.labels[1], unq(attr(s.body, "name")), attr(s.body, "address_prefixes")]), [
    ["web", "snet-web", "[local.web_cidr]"],
    ["app", "snet-app", "[local.app_cidr]"],
  ]);
  assert.deepEqual(resources(l, "azurerm_network_security_group").map((n) => [n.labels[1], unq(attr(n.body, "name"))]), [
    ["web", "nsg-web"],
    ["app", "nsg-app"],
  ]);
  assert.deepEqual(associations(l, "azurerm_subnet_network_security_group_association", "network_security_group_id"), { web: "web", app: "app" });
  // Each VM in its own subnet.
  assert.match(res(l, "azurerm_network_interface", "web").body, /subnet_id\s*=\s*azurerm_subnet\.web\.id/);
  assert.match(res(l, "azurerm_network_interface", "app").body, /subnet_id\s*=\s*azurerm_subnet\.app\.id/);
});

test(`${L13}: asg-web may reach asg-app on 8080 and nothing else from the VNet reaches app`, () => {
  const l = lab(L13);
  assert.deepEqual(resources(l, "azurerm_application_security_group").map((a) => [a.labels[1], unq(attr(a.body, "name"))]), [
    ["web", "asg-web"],
    ["app", "asg-app"],
  ]);
  const members = resources(l, "azurerm_network_interface_application_security_group_association").map((a) => [attr(a.body, "network_interface_id"), attr(a.body, "application_security_group_id")]);
  assert.deepEqual(members, [
    ["azurerm_network_interface.web.id", "azurerm_application_security_group.web.id"],
    ["azurerm_network_interface.app.id", "azurerm_application_security_group.app.id"],
  ]);
  const inbound = rulesOf(l, "app").filter((r) => r.direction === "Inbound");
  const allows = inbound.filter((r) => r.access === "Allow");
  assert.equal(allows.length, 1, "nsg-app allows exactly one thing in");
  const [allow] = allows;
  assert.equal(allow.protocol, "Tcp");
  assert.equal(allow.port, "8080");
  assert.equal(allow.srcAsg, "[azurerm_application_security_group.web.id]");
  assert.equal(allow.dstAsg, "[azurerm_application_security_group.app.id]");
  // Then the default AllowVnetInBound (65000) is overridden: everything else from the VNet is denied.
  const deny = inbound.find((r) => r.access === "Deny" && r.src === "VirtualNetwork");
  assert.ok(deny, "a Deny from VirtualNetwork");
  assert.equal(deny.port, "*");
  assert.equal(deny.protocol, "*");
  assert.ok(deny.priority > allow.priority && deny.priority < 65000, "the deny comes after the allow and before Azure's AllowVnetInBound");
});

test(`${L13}: ssh to web only from VirtualNetwork, which includes the gateway when peered`, () => {
  const l = lab(L13);
  const inbound = rulesOf(l, "web").filter((r) => r.direction === "Inbound");
  const ssh = inbound.filter((r) => r.access === "Allow" && r.port === "22");
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].src, "VirtualNetwork");
  const http = inbound.find((r) => r.access === "Allow" && r.port === "80");
  assert.equal(http?.src, "VirtualNetwork", "web serves port 80 to the VNet");
  // Nothing else from the VNet: a deny after the allows, before AllowVnetInBound.
  const deny = inbound.find((r) => r.access === "Deny" && r.src === "VirtualNetwork" && r.port === "*");
  assert.ok(deny && deny.priority > Math.max(...inbound.filter((r) => r.access === "Allow").map((r) => r.priority)) && deny.priority < 65000);
  for (const r of inbound.filter((x) => x.access === "Allow")) assert.equal(r.src, "VirtualNetwork", `${r.name}: only from VirtualNetwork`);
  // Peered address space is part of the VirtualNetwork tag: the readme says the tunnel gets in that way.
  assert.match(l.readme, /VirtualNetwork[^\n]*peer/i);
  assert.equal(l.yaml.connectivity.peering, "optional");
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.lab.id");
});

test(`${L13}: private_ips and connect name both VMs`, () => {
  const l = lab(L13);
  assert.match(output(l, "private_ips").body, /"vm-web"\s*=\s*azurerm_network_interface\.web\.private_ip_address/);
  assert.match(output(l, "private_ips").body, /"vm-app"\s*=\s*azurerm_network_interface\.app\.private_ip_address/);
  assert.match(output(l, "connect").body, /ssh azureuser@\$\{azurerm_network_interface\.web\.private_ip_address\}/);
  assert.ok(outputs(l).includes("peer_vnet_id"));
  assert.doesNotMatch(code(l), /var\.gateway_vnet_id/);
});
