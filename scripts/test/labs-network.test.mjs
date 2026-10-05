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

// ── Lab 14: VNet peering and user-defined routes ─────────────────────────

const L14 = "az104-14-peering-udr";
labContentSuite(L14, { marker: "£" });
servesWithPython(L14, { spoke1: 80, spoke2: 80 });

test(`${L14}: hub and two spokes from /20s 0, 1 and 2, each spoke peered with the hub both ways, forwarded traffic allowed`, () => {
  const l = lab(L14);
  const loc = locals(l);
  assert.equal(loc.hub_cidr, "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(loc.spoke1_cidr, "cidrsubnet(var.address_space, 2, 1)");
  assert.equal(loc.spoke2_cidr, "cidrsubnet(var.address_space, 2, 2)");
  assert.equal(l.yaml.connectivity.subnets_used, 3);
  assert.deepEqual(resources(l, "azurerm_virtual_network").map((v) => [v.labels[1], unq(attr(v.body, "name")), attr(v.body, "address_space")]), [
    ["hub", "vnet-hub", "[local.hub_cidr]"],
    ["spoke1", "vnet-spoke1", "[local.spoke1_cidr]"],
    ["spoke2", "vnet-spoke2", "[local.spoke2_cidr]"],
  ]);
  // Each subnet inside its own VNet's /20.
  for (const [key, vnet, local] of [["router", "hub", "hub_cidr"], ["spoke1", "spoke1", "spoke1_cidr"], ["spoke2", "spoke2", "spoke2_cidr"]]) {
    const s = res(l, "azurerm_subnet", key);
    assert.equal(attr(s.body, "virtual_network_name"), `azurerm_virtual_network.${vnet}.name`);
    assert.equal(attr(s.body, "address_prefixes"), `[local.${key}_subnet]`);
    assert.equal(loc[`${key}_subnet`], `cidrsubnet(local.${local}, 4, 0)`);
  }
  const peerings = resources(l, "azurerm_virtual_network_peering").map((p) => ({
    from: attr(p.body, "virtual_network_name").replace(/^azurerm_virtual_network\.(\w+)\.name$/, "$1"),
    to: attr(p.body, "remote_virtual_network_id").replace(/^azurerm_virtual_network\.(\w+)\.id$/, "$1"),
    access: attr(p.body, "allow_virtual_network_access"),
    forwarded: attr(p.body, "allow_forwarded_traffic"),
    transit: attr(p.body, "allow_gateway_transit") ?? "false",
    remote: attr(p.body, "use_remote_gateways") ?? "false",
  }));
  const pairs = peerings.map((p) => `${p.from}->${p.to}`).sort();
  assert.deepEqual(pairs, ["hub->spoke1", "hub->spoke2", "spoke1->hub", "spoke2->hub"], "each spoke peered with the hub both ways, and the spokes never with each other");
  for (const p of peerings) {
    assert.equal(p.access, "true", `${p.from}->${p.to}: virtual network access`);
    assert.equal(p.forwarded, "true", `${p.from}->${p.to}: forwarded traffic allowed (the router forwards)`);
    assert.equal(p.transit, "false");
    assert.equal(p.remote, "false");
  }
});

test(`${L14}: a router VM in the hub with IP forwarding on its NIC and in the kernel`, () => {
  const l = lab(L14);
  const nic = res(l, "azurerm_network_interface", "router");
  assert.equal(attr(nic.body, "ip_forwarding_enabled"), "true", "Azure forwards packets not addressed to the NIC");
  assert.match(nic.body, /subnet_id\s*=\s*azurerm_subnet\.router\.id/);
  assert.equal(attr(nic.body, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(nic.body, "private_ip_address"), "local.router_ip");
  assert.equal(locals(l).router_ip, "cidrhost(local.router_subnet, 4)");
  // Only the router forwards.
  for (const other of resources(l, "azurerm_network_interface").filter((n) => n.labels[1] !== "router")) assert.notEqual(attr(other.body, "ip_forwarding_enabled"), "true", other.labels[1]);
  const vm = res(l, "azurerm_linux_virtual_machine", "router");
  assert.equal(attr(vm.body, "size"), '"Standard_B1s"');
  assert.equal(attr(vm.body, "custom_data"), 'base64encode(templatefile("${path.module}/router-init.yaml.tftpl", {}))');
  const tpl = readFileSync(join(l.tfDir, "router-init.yaml.tftpl"), "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(tpl, /\$\{/, "the router's cloud-init takes no variables");
  const doc = parseYaml(tpl);
  assert.equal(doc.packages, undefined, "no packages");
  const conf = doc.write_files.find((f) => f.path.startsWith("/etc/sysctl.d/"));
  assert.match(conf.content, /^net\.ipv4\.ip_forward = 1$/m, "the kernel forwards");
  assert.match(conf.content, /^net\.ipv4\.conf\.all\.send_redirects = 0$/m, "no ICMP redirects back to the spokes");
  assert.ok(doc.runcmd.includes("sysctl --system"), "applied at first boot, and kept for every boot");
});

test(`${L14}: each spoke routes the other spoke's prefix to the router, and nothing routes 0.0.0.0/0`, () => {
  const l = lab(L14);
  assert.deepEqual(resources(l, "azurerm_route_table").map((r) => [r.labels[1], unq(attr(r.body, "name"))]), [
    ["spoke1", "rt-spoke1"],
    ["spoke2", "rt-spoke2"],
  ]);
  const routes = resources(l, "azurerm_route").map((r) => ({
    table: attr(r.body, "route_table_name").replace(/^azurerm_route_table\.(\w+)\.name$/, "$1"),
    prefix: attr(r.body, "address_prefix"),
    type: unq(attr(r.body, "next_hop_type")),
    hop: attr(r.body, "next_hop_in_ip_address"),
  }));
  assert.deepEqual(routes, [
    { table: "spoke1", prefix: "local.spoke2_cidr", type: "VirtualAppliance", hop: "local.router_ip" },
    { table: "spoke2", prefix: "local.spoke1_cidr", type: "VirtualAppliance", hop: "local.router_ip" },
  ]);
  assert.deepEqual(associations(l, "azurerm_subnet_route_table_association", "route_table_id"), { spoke1: "spoke1", spoke2: "spoke2" });
  assert.doesNotMatch(code(l), /0\.0\.0\.0\/0/, "no default route: the spokes keep Azure's own way out");
  // Each spoke VM sits behind its route table.
  assert.match(res(l, "azurerm_network_interface", "spoke1").body, /subnet_id\s*=\s*azurerm_subnet\.spoke1\.id/);
  assert.match(res(l, "azurerm_network_interface", "spoke2").body, /subnet_id\s*=\s*azurerm_subnet\.spoke2\.id/);
});

test(`${L14}: peer_vnet_id is the hub, and the readme says the spokes are not reachable over the tunnel`, () => {
  const l = lab(L14);
  assert.equal(l.yaml.connectivity.peering, "optional");
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.hub.id");
  assert.match(l.readme, /spokes are not reachable over the tunnel/i);
  assert.match(l.readme, /not transitive/i);
  for (const vm of ["vm-router", "vm-spoke1", "vm-spoke2"]) assert.match(output(l, "private_ips").body, new RegExp(`"${vm}"\\s*=`));
  assert.match(output(l, "connect").body, /ssh azureuser@\$\{azurerm_network_interface\.router\.private_ip_address\}/);
  assert.doesNotMatch(code(l), /var\.gateway_vnet_id/);
});

// ── Lab 15: Azure DNS, public and private zones ──────────────────────────

const L15 = "az104-15-dns";
labContentSuite(L15, { marker: "£" });
servesWithPython(L15, { web: 80 });

/** RFC 5737's documentation ranges: an address there can never point at anything real. */
const DOC_NETS = [/^192\.0\.2\.\d+$/, /^198\.51\.100\.\d+$/, /^203\.0\.113\.\d+$/];

test(`${L15}: a public zone named from name_prefix under example.com, with an A and a CNAME record`, () => {
  const l = lab(L15);
  const [zone, ...more] = resources(l, "azurerm_dns_zone");
  assert.equal(more.length, 0, "one public zone");
  assert.equal(zone.labels[1], "public");
  // example.com is reserved (RFC 2606), so the zone can never shadow a real domain; the prefix keeps sessions apart.
  assert.equal(attr(zone.body, "name"), '"${var.name_prefix}.example.com"');
  const [a, ...moreA] = resources(l, "azurerm_dns_a_record");
  assert.equal(moreA.length, 0);
  assert.equal(attr(a.body, "zone_name"), "azurerm_dns_zone.public.name");
  assert.equal(attr(a.body, "name"), '"www"');
  const records = JSON.parse(attr(a.body, "records"));
  assert.ok(records.length >= 1);
  for (const ip of records) assert.ok(DOC_NETS.some((re) => re.test(ip)), `${ip} is a documentation address (RFC 5737)`);
  assert.ok(Number(attr(a.body, "ttl")) <= 300, "a short TTL, so changes show quickly");
  const [cname, ...moreC] = resources(l, "azurerm_dns_cname_record");
  assert.equal(moreC.length, 0);
  assert.equal(attr(cname.body, "zone_name"), "azurerm_dns_zone.public.name");
  assert.equal(attr(cname.body, "name"), '"app"');
  assert.equal(attr(cname.body, "record"), '"www.${azurerm_dns_zone.public.name}"');
  // The zone is never delegated: its name servers answer for it directly.
  assert.match(output(l, "connect").body, /nslookup www\.\$\{azurerm_dns_zone\.public\.name\} \$\{tolist\(azurerm_dns_zone\.public\.name_servers\)\[0\]\}/);
  assert.match(l.readme, /not delegated/i);
});

test(`${L15}: private zone lab15.internal linked to the lab VNet with auto-registration`, () => {
  const l = lab(L15);
  const [zone, ...more] = resources(l, "azurerm_private_dns_zone");
  assert.equal(more.length, 0, "one private zone");
  assert.equal(attr(zone.body, "name"), '"lab15.internal"', "the gateway's dnsmasq forwards internal to Azure DNS (ruling 10)");
  const [link, ...moreLinks] = resources(l, "azurerm_private_dns_zone_virtual_network_link");
  assert.equal(moreLinks.length, 0, "one link, to the lab VNet");
  assert.equal(attr(link.body, "private_dns_zone_name"), `azurerm_private_dns_zone.${zone.labels[1]}.name`);
  assert.equal(attr(link.body, "virtual_network_id"), "azurerm_virtual_network.lab.id");
  assert.equal(attr(link.body, "registration_enabled"), "true", "auto-registration: vm-web gets its own A record");
  // A record made by hand beside the one Azure registers; the VM waits for the link so it registers at first boot.
  const [www, ...moreA] = resources(l, "azurerm_private_dns_a_record");
  assert.equal(moreA.length, 0);
  assert.equal(attr(www.body, "zone_name"), `azurerm_private_dns_zone.${zone.labels[1]}.name`);
  assert.equal(attr(www.body, "name"), '"www"');
  assert.equal(attr(www.body, "records"), "[azurerm_network_interface.web.private_ip_address]", "www.lab15.internal is vm-web's address");
  assert.match(res(l, "azurerm_linux_virtual_machine", "web").body, /depends_on\s*=\s*\[azurerm_private_dns_zone_virtual_network_link\.\w+\]/);
  assert.match(output(l, "connect").body, /nslookup vm-web\.lab15\.internal/);
});

test(`${L15}: dns_link is true and Terraform never links the zone to the gateway`, () => {
  const l = lab(L15);
  assert.equal(l.yaml.connectivity.dns_link, true, "the pipeline links lab15.internal to the gateway VNet while peered");
  assert.equal(l.yaml.connectivity.peering, "optional");
  assert.ok(!l.blocks.some((b) => b.kind === "variable" && ["gateway_vnet_id", "peered"].includes(b.labels[0])), "no gateway_vnet_id or peered variable");
  assert.doesNotMatch(code(l), /gateway_vnet_id|vnet-wg|rg-wg/);
  for (const link of resources(l, "azurerm_private_dns_zone_virtual_network_link")) assert.equal(attr(link.body, "virtual_network_id"), "azurerm_virtual_network.lab.id");
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.lab.id");
  // Over the tunnel, while peered: the readme says so, and that it needs the gateway's tunnel DNS.
  assert.match(l.readme, /vm-web\.lab15\.internal/);
  assert.match(l.readme, /tunnel/i);
});

// ── Lab 16: Load Balancer and Application Gateway ────────────────────────

const L16 = "az104-16-lb-appgw";
labContentSuite(L16, { marker: "££" });
servesWithPython(L16, { web: 80 });

/** The bodies of the nested blocks called `name` directly inside `body` (one level down). */
function nested(body, name) {
  const out = [];
  const re = new RegExp(`^[ ]{2}${name}[ ]*\\{`, "gm");
  for (const m of body.matchAll(re)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}" && --depth === 0) break;
    }
    out.push(body.slice(m.index + m[0].length, i));
  }
  return out;
}

test(`${L16}: an internal Standard load balancer with a TCP 80 probe and rule over both VMs`, () => {
  const l = lab(L16);
  const [lb, ...more] = resources(l, "azurerm_lb");
  assert.equal(more.length, 0);
  assert.equal(attr(lb.body, "sku"), '"Standard"', "Standard: Basic load balancers are retired");
  const [fe, ...moreFe] = nested(lb.body, "frontend_ip_configuration");
  assert.equal(moreFe.length, 0, "one frontend");
  assert.equal(attr(fe, "subnet_id"), "azurerm_subnet.web.id", "internal: a private frontend in the web subnet");
  assert.equal(attr(fe, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(fe, "private_ip_address"), "local.lb_ip");
  assert.equal(locals(l).lb_ip, "cidrhost(local.web_cidr, 10)");
  assert.doesNotMatch(lb.body, /public_ip_address_id/, "no public frontend");
  const [pool] = resources(l, "azurerm_lb_backend_address_pool");
  assert.equal(attr(pool.body, "loadbalancer_id"), "azurerm_lb.web.id");
  const [probe] = resources(l, "azurerm_lb_probe");
  assert.equal(attr(probe.body, "loadbalancer_id"), "azurerm_lb.web.id");
  assert.equal(attr(probe.body, "protocol"), '"Tcp"');
  assert.equal(attr(probe.body, "port"), "80");
  const [rule] = resources(l, "azurerm_lb_rule");
  assert.equal(attr(rule.body, "protocol"), '"Tcp"');
  assert.equal(attr(rule.body, "frontend_port"), "80");
  assert.equal(attr(rule.body, "backend_port"), "80");
  assert.equal(attr(rule.body, "backend_address_pool_ids"), "[azurerm_lb_backend_address_pool.web.id]");
  assert.equal(attr(rule.body, "probe_id"), "azurerm_lb_probe.http.id");
  assert.equal(unq(attr(rule.body, "frontend_ip_configuration_name")), unq(attr(fe, "name")));
  // Both VMs (count = 2) are in the pool.
  const vm = res(l, "azurerm_linux_virtual_machine", "web");
  assert.equal(attr(vm.body, "count"), "2");
  const [member] = resources(l, "azurerm_network_interface_backend_address_pool_association");
  assert.equal(attr(member.body, "count"), "2");
  assert.equal(attr(member.body, "network_interface_id"), "azurerm_network_interface.web[count.index].id");
  assert.equal(attr(member.body, "backend_address_pool_id"), "azurerm_lb_backend_address_pool.web.id");
  assert.equal(attr(member.body, "ip_configuration_name"), attr(nested(res(l, "azurerm_network_interface", "web").body, "ip_configuration")[0], "name"));
});

test(`${L16}: the gateway is Standard_v2 autoscaling from 0 to 2, priced by hand (its meters are shared, ruling 2)`, () => {
  const l = lab(L16);
  assert.equal(l.yaml.version, 2, "Basic to Standard_v2 is a new version");
  const [gw] = resources(l, "azurerm_application_gateway");
  const [sku] = nested(gw.body, "sku");
  assert.equal(attr(sku, "name"), '"Standard_v2"');
  assert.equal(attr(sku, "tier"), '"Standard_v2"');
  assert.equal(attr(sku, "capacity"), undefined, "no fixed capacity: autoscale_configuration sets it");
  const [auto, ...moreAuto] = nested(gw.body, "autoscale_configuration");
  assert.equal(moreAuto.length, 0);
  assert.equal(attr(auto, "min_capacity"), "0", "scales to zero instances when idle");
  assert.equal(attr(auto, "max_capacity"), "2", "the smallest maximum azurerm accepts");
  // Standard Fixed Cost and Standard Capacity Units are shared with WAF v2 and Application Gateway for Containers:
  // authored (uksouth GBP, Retail Prices API), never a retail entry the feed would mismatch.
  const items = l.yaml.cost.items;
  const fixed = items.find((i) => /Standard_v2, fixed/.test(i.name));
  const cu = items.find((i) => /Standard_v2, capacity unit/.test(i.name));
  assert.ok(fixed && cu, JSON.stringify(items));
  assert.equal(fixed.gbp_h, 0.1887);
  assert.equal(cu.gbp_h, 0.006);
  for (const i of [fixed, cu]) assert.equal(i.retail, undefined, `${i.name} has no retail entry`);
  assert.ok(!items.some((i) => /Basic/.test(i.name) || /^Basic /.test(i.retail?.meter ?? "")), "no Basic gateway left");
  assert.equal(l.yaml.cost.pricey, fixed.name);
});

test(`${L16}: an Application Gateway in its own /24 with the public IP it must have and its only listener on the private frontend`, () => {
  const l = lab(L16);
  const loc = locals(l);
  assert.equal(loc.vnet_cidr, "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(loc.web_cidr, "cidrsubnet(local.vnet_cidr, 4, 0)");
  assert.equal(loc.appgw_cidr, "cidrsubnet(local.vnet_cidr, 4, 1)", "a /24 of its own");
  assert.equal(attr(res(l, "azurerm_subnet", "appgw").body, "address_prefixes"), "[local.appgw_cidr]");
  const [gw, ...more] = resources(l, "azurerm_application_gateway");
  assert.equal(more.length, 0);
  assert.equal(attr(nested(gw.body, "gateway_ip_configuration")[0], "subnet_id"), "azurerm_subnet.appgw.id");
  // Two frontends: the public IP Azure insists on, and a private one.
  const fes = nested(gw.body, "frontend_ip_configuration").map((f) => ({ name: unq(attr(f, "name")), pip: attr(f, "public_ip_address_id"), subnet: attr(f, "subnet_id"), ip: attr(f, "private_ip_address"), alloc: unq(attr(f, "private_ip_address_allocation")) }));
  assert.equal(fes.length, 2);
  const pub = fes.find((f) => f.pip);
  const priv = fes.find((f) => f.subnet);
  assert.equal(pub.pip, "azurerm_public_ip.appgw.id");
  assert.equal(priv.subnet, "azurerm_subnet.appgw.id");
  assert.equal(priv.alloc, "Static");
  assert.equal(priv.ip, "local.appgw_ip");
  assert.equal(loc.appgw_ip, "cidrhost(local.appgw_cidr, 10)");
  const [ip] = resources(l, "azurerm_public_ip");
  assert.equal(attr(ip.body, "sku"), '"Standard"');
  assert.equal(attr(ip.body, "allocation_method"), '"Static"');
  // Its only listener is on the private frontend: nothing listens on the public IP.
  const listeners = nested(gw.body, "http_listener");
  assert.equal(listeners.length, 1, "one listener");
  assert.equal(unq(attr(listeners[0], "frontend_ip_configuration_name")), priv.name);
  assert.equal(attr(listeners[0], "protocol"), '"Http"');
  // Backends: both VMs on port 80, a rule with a priority (v2-family SKUs need one), a TLS policy that is not deprecated.
  assert.equal(attr(nested(gw.body, "backend_address_pool")[0], "ip_addresses"), "azurerm_network_interface.web[*].private_ip_address");
  assert.equal(attr(nested(gw.body, "backend_http_settings")[0], "port"), "80");
  const [rule] = nested(gw.body, "request_routing_rule");
  assert.ok(Number(attr(rule, "priority")) >= 1);
  assert.match(attr(nested(gw.body, "ssl_policy")[0], "policy_name"), /AppGwSslPolicy2022/);
  assert.match(output(l, "connect").body, /curl http:\/\/\$\{local\.appgw_ip\}/);
  assert.match(output(l, "connect").body, /curl http:\/\/\$\{local\.lb_ip\}/);
});

test(`${L16}: the gateway subnet allows GatewayManager on 65200-65535`, () => {
  const l = lab(L16);
  assert.deepEqual(associations(l, "azurerm_subnet_network_security_group_association", "network_security_group_id"), { appgw: "appgw" });
  const inbound = rulesOf(l, "appgw").filter((r) => r.direction === "Inbound" && r.access === "Allow");
  const gm = inbound.find((r) => r.src === "GatewayManager");
  assert.ok(gm, "a rule from the GatewayManager service tag");
  assert.equal(gm.port, "65200-65535");
  assert.equal(gm.protocol, "Tcp");
  // The listener's port from the VNet (the tunnel too, when peered); never from the internet.
  const http = inbound.find((r) => r.port === "80");
  assert.equal(http?.src, "VirtualNetwork");
  for (const r of inbound) assert.notEqual(r.src, "Internet", `${r.name}: nothing from the internet`);
  assert.notEqual(l.yaml.cost.pricey, null, "the card names what makes it ££");
  assert.match(l.readme, /5 to 15 minutes|15 minutes/i, "the readme warns the gateway is slow to deploy");
});

// ── Lab 17: break-fix, connectivity troubleshooting with Network Watcher ─

const L17 = "az104-17-netwatcher-fix";
labContentSuite(L17, { marker: "£" });
servesWithPython(L17, { app: 80, db: 8080 });

/** The readme's text under one ## heading, up to the next. */
const section = (readme, heading) => readme.split(`\n## ${heading}\n`)[1]?.split(/\n## /)[0] ?? "";

test(`${L17}: type break-fix, with Symptom and a closed What was broken`, () => {
  const l = lab(L17);
  assert.equal(l.yaml.type, "break-fix");
  assert.deepEqual(l.yaml.skill_areas, ["az104.networking", "az104.monitor"]);
  assert.ok(section(l.readme, "Symptom").trim(), "a Symptom section");
  assert.match(l.readme, /\n<details>\n<summary>What was broken<\/summary>\n[\s\S]+?\n<\/details>\n/, "a closed details block");
  assert.doesNotMatch(l.readme, /<details open/);
  // The answer names both faults and how to find them.
  const answer = l.readme.split("<summary>What was broken</summary>")[1].split("</details>")[0];
  assert.match(answer, /allow-monitoring/);
  assert.match(answer, /rt-app/);
  assert.match(answer, /IP flow verify/i);
  assert.match(answer, /Next hop/i);
});

test(`${L17}: an NSG deny on 8080 outranks the allow`, () => {
  const l = lab(L17);
  assert.deepEqual(associations(l, "azurerm_subnet_network_security_group_association", "network_security_group_id"), { db: "db" });
  const inbound = rulesOf(l, "db").filter((r) => r.direction === "Inbound");
  const deny = inbound.find((r) => r.access === "Deny" && r.port === "8080");
  const allow = inbound.find((r) => r.access === "Allow" && r.port === "8080");
  assert.ok(deny && allow, "a deny and an allow on 8080");
  assert.equal(deny.name, "allow-monitoring", "the deny hides behind a misleading name");
  assert.ok(deny.priority < allow.priority, "the deny is evaluated first");
  assert.equal(deny.src, "VirtualNetwork", "it catches vm-app's traffic");
  assert.equal(attr(allow.body, "source_address_prefix"), "local.app_cidr", "the allow names the app subnet");
  // ssh from the VNet (the tunnel too, while peered) still works, so the VM can be reached to look around.
  assert.equal(inbound.find((r) => r.access === "Allow" && r.port === "22")?.src, "VirtualNetwork");
});

test(`${L17}: the app subnet routes the db subnet to an address nothing holds`, () => {
  const l = lab(L17);
  const loc = locals(l);
  assert.equal(loc.vnet_cidr, "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(loc.app_cidr, "cidrsubnet(local.vnet_cidr, 4, 0)");
  assert.equal(loc.db_cidr, "cidrsubnet(local.vnet_cidr, 4, 1)");
  // Inside the VNet, in a /24 no subnet uses, and no NIC holds it.
  assert.equal(loc.fw_ip, "cidrhost(cidrsubnet(local.vnet_cidr, 4, 15), 4)");
  for (const s of resources(l, "azurerm_subnet")) assert.match(attr(s.body, "address_prefixes"), /^\[local\.(app|db)_cidr\]$/, `${s.labels[1]} is not the firewall's /24`);
  for (const nic of resources(l, "azurerm_network_interface")) assert.doesNotMatch(nic.body, /local\.fw_ip/);
  const [table, ...more] = resources(l, "azurerm_route_table");
  assert.equal(more.length, 0);
  assert.equal(unq(attr(table.body, "name")), "rt-app");
  const [route, ...moreRoutes] = resources(l, "azurerm_route");
  assert.equal(moreRoutes.length, 0);
  assert.equal(attr(route.body, "route_table_name"), `azurerm_route_table.${table.labels[1]}.name`);
  assert.equal(attr(route.body, "address_prefix"), "local.db_cidr");
  assert.equal(unq(attr(route.body, "next_hop_type")), "VirtualAppliance");
  assert.equal(attr(route.body, "next_hop_in_ip_address"), "local.fw_ip");
  assert.deepEqual(associations(l, "azurerm_subnet_route_table_association", "route_table_id"), { [table.labels[1]]: "app" });
  assert.doesNotMatch(code(l), /0\.0\.0\.0\/0/);
});

test(`${L17}: both VMs carry the Network Watcher agent and Terraform makes no Network Watcher of its own`, () => {
  const l = lab(L17);
  const exts = resources(l, "azurerm_virtual_machine_extension");
  assert.deepEqual(exts.map((e) => attr(e.body, "virtual_machine_id")).sort(), ["azurerm_linux_virtual_machine.app.id", "azurerm_linux_virtual_machine.db.id"]);
  for (const e of exts) {
    assert.equal(attr(e.body, "publisher"), '"Microsoft.Azure.NetworkWatcher"');
    assert.equal(attr(e.body, "type"), '"NetworkWatcherAgentLinux"');
    assert.equal(attr(e.body, "type_handler_version"), '"1.4"');
    assert.equal(attr(e.body, "auto_upgrade_minor_version"), "true");
  }
  // Azure's own NetworkWatcher_<region> in NetworkWatcherRG does the work (batch 2 ruling 8).
  assert.doesNotMatch(code(l), /azurerm_network_watcher|NetworkWatcherRG|azurerm_network_connection_monitor|flow_log/);
  assert.match(l.readme, /NetworkWatcherRG/);
});

test(`${L17}: the Symptom names neither fault`, () => {
  const l = lab(L17);
  // The Symptom's own text: up to the collapsed answer, if that follows it.
  const symptom = section(l.readme, "Symptom").split("<details>")[0];
  assert.ok(symptom.trim());
  assert.match(symptom, /`curl http:\/\/vm-db:8080` from `vm-app` times out/);
  assert.doesNotMatch(symptom, /allow-monitoring|nsg|security|rule|deny|route|udr|rt-app|next hop|appliance|firewall|10\.\d/i);
  // Nor does the rest of the readme outside the answer, or the lab's summary and title.
  const outside = l.readme.split("<details>")[0] + (l.readme.split("</details>")[1] ?? "");
  assert.doesNotMatch(outside, /allow-monitoring|rt-app|nothing holds/i);
  assert.doesNotMatch(`${l.yaml.title} ${l.yaml.summary}`, /deny|route|udr/i);
});
