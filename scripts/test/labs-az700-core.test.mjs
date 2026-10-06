// labs-az700-core.test.mjs
//
// Plain English: the AZ-700 core networking and routing labs (AZ-700 plan,
// area Z1: labs 31-35) checked without touching Azure. Each runs the shared
// content suite (fixtures/labs/content.mjs: catalogue rules, lint, one
// resource group, VMs with no public IP, the address test at slot 31, the
// marker), then its own tests: what it builds, as the plan's per-lab design
// says. init, validate and the mock plan are npm run labs-tf's job; the plan
// fixtures (fixtures/labs/plans/labs/az700-3*.mjs) are checked against
// main.tf and the scope check by lab-plans.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { cidrOverlaps } from "../lib/labs.mjs";

const NAT = "az700-31-ip-nat-outbound";

/** The body of the first nested block `name { ... }` in `body` (any depth), or undefined. */
function nested(body, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*\\{`).exec(body ?? "");
  if (!m) return undefined;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) break;
  }
  return body.slice(m.index + m[0].length, i);
}

/** Every nested block `name { ... }` in `body`. */
function allNested(body, name) {
  const out = [];
  let rest = body ?? "";
  for (let b = nested(rest, name); b !== undefined; b = nested(rest, name)) {
    out.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  return out;
}

/** `body` with every nested block's contents taken out (`name {}` stays), so attr() reads only top-level arguments. */
function topLevel(body) {
  let out = "";
  let depth = 0;
  for (const ch of body ?? "") {
    if (ch === "{" && depth++ > 0) continue;
    if (ch === "}" && --depth > 0) continue;
    if (depth === 0 || ch === "{") out += ch;
  }
  return out;
}
const top = (body, name) => attr(topLevel(body), name);

/** A list literal's quoted strings: ["a", "b"] -> ["a", "b"]. */
const strings = (v) => [...(v ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);

const one = (l, type) => {
  const rs = resources(l, type);
  assert.equal(rs.length, 1, `exactly one ${type}`);
  return rs[0];
};
const byName = (l, type, name) => {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r;
};
/** A planned resource from the lab's plan fixture, by address. */
const planned = (id, address) => {
  const r = LAB_PLANS[id].plan.planned_values.root_module.resources.find((x) => x.address === address);
  assert.ok(r, `the plan fixture has ${address}`);
  return r.values;
};
/** A readme section's text: from "## name" to the next "## " heading or the footer. */
const section = (l, name) => l.readme.split(`## ${name}\n`)[1]?.split(/\n## |\nAnything you build/)[0] ?? "";

// ── Lab 31: public IP prefixes, NAT Gateway and outbound rules ───────────

labContentSuite(NAT, { marker: "££" });

test(`${NAT}: two /31 Standard prefixes, one on the NAT gateway and one as the load balancer's frontend`, () => {
  const l = lab(NAT);
  const prefixes = resources(l, "azurerm_public_ip_prefix");
  assert.deepEqual(prefixes.map((p) => p.labels[1]).sort(), ["lb", "nat"]);
  for (const p of prefixes) {
    assert.equal(attr(p.body, "prefix_length"), "31", `${p.labels[1]}: a /31 (two addresses)`);
    assert.equal(attr(p.body, "sku"), '"Standard"');
    assert.deepEqual(strings(attr(p.body, "zones")), ["1", "2", "3"], `${p.labels[1]}: zone-redundant`);
  }
  assert.deepEqual(strings(attr(byName(l, "azurerm_public_ip_prefix", "nat").body, "name")), ["pfx-nat"]);
  assert.deepEqual(strings(attr(byName(l, "azurerm_public_ip_prefix", "lb").body, "name")), ["pfx-lb"]);
  // The NAT gateway: Standard, idle 4 minutes, pfx-nat associated, on snet-nat only.
  const ng = one(l, "azurerm_nat_gateway");
  assert.equal(attr(ng.body, "name"), '"ng-hub"');
  assert.equal(attr(ng.body, "sku_name"), '"Standard"');
  assert.equal(attr(ng.body, "idle_timeout_in_minutes"), "4");
  const assoc = one(l, "azurerm_nat_gateway_public_ip_prefix_association");
  assert.equal(attr(assoc.body, "nat_gateway_id"), "azurerm_nat_gateway.hub.id");
  assert.equal(attr(assoc.body, "public_ip_prefix_id"), "azurerm_public_ip_prefix.nat.id");
  const sub = one(l, "azurerm_subnet_nat_gateway_association");
  assert.equal(attr(sub.body, "subnet_id"), "azurerm_subnet.nat.id");
  assert.equal(attr(sub.body, "nat_gateway_id"), "azurerm_nat_gateway.hub.id");
  // The load balancer's only frontend comes from pfx-lb (no public IP resource at all).
  const lb = one(l, "azurerm_lb");
  assert.equal(attr(lb.body, "sku"), '"Standard"');
  const fes = allNested(lb.body, "frontend_ip_configuration");
  assert.equal(fes.length, 1, "one frontend");
  assert.equal(attr(fes[0], "public_ip_prefix_id"), "azurerm_public_ip_prefix.lb.id");
  assert.equal(resources(l, "azurerm_public_ip").length, 0, "no public IP: both prefixes' addresses are used whole");
  // The plan knows both prefixes are /31s.
  for (const k of ["nat", "lb"]) assert.equal(planned(NAT, `azurerm_public_ip_prefix.${k}`).prefix_length, 31);
});

test(`${NAT}: the load balancer has an outbound rule and no load-balancing or inbound rule`, () => {
  const l = lab(NAT);
  for (const t of ["azurerm_lb_rule", "azurerm_lb_nat_rule", "azurerm_lb_nat_pool", "azurerm_lb_probe"]) assert.equal(resources(l, t).length, 0, `no ${t}`);
  const rule = one(l, "azurerm_lb_outbound_rule");
  assert.equal(attr(rule.body, "loadbalancer_id"), "azurerm_lb.out.id");
  assert.equal(attr(rule.body, "protocol"), '"All"');
  assert.equal(attr(rule.body, "backend_address_pool_id"), "azurerm_lb_backend_address_pool.out.id");
  assert.equal(attr(rule.body, "allocated_outbound_ports"), "32000", "32,000 ports per VM: the two addresses' 128,000 ports serve up to four VMs");
  assert.equal(attr(rule.body, "idle_timeout_in_minutes"), "4");
  assert.equal(attr(rule.body, "tcp_reset_enabled"), "true");
  assert.equal(attr(nested(rule.body, "frontend_ip_configuration"), "name"), '"fe-out"');
  // vm-lb is in the pool; vm-nat is not.
  const members = resources(l, "azurerm_network_interface_backend_address_pool_association");
  assert.deepEqual(members.map((m) => attr(m.body, "network_interface_id")), ["azurerm_network_interface.lb.id"]);
  assert.equal(attr(members[0].body, "backend_address_pool_id"), "azurerm_lb_backend_address_pool.out.id");
  // No NSG rule lets anything in from the internet.
  const rules = [...resources(l, "azurerm_network_security_rule").map((r) => r.body), ...resources(l, "azurerm_network_security_group").flatMap((g) => allNested(g.body, "security_rule"))];
  for (const r of rules) if (/"Inbound"/.test(attr(r, "direction") ?? "") && /"Allow"/.test(attr(r, "access") ?? "")) assert.doesNotMatch(attr(r, "source_address_prefix") ?? "", /"(\*|Internet|0\.0\.0\.0\/0)"/, "no inbound allow from the internet");
});

test(`${NAT}: both subnets set default outbound access off`, () => {
  const l = lab(NAT);
  const subnets = resources(l, "azurerm_subnet");
  assert.deepEqual(subnets.map((s) => attr(s.body, "name")).sort(), ['"snet-lb"', '"snet-nat"']);
  for (const s of subnets) assert.equal(attr(s.body, "default_outbound_access_enabled"), "false", `${s.labels[1]}: outbound only through the NAT gateway or the outbound rule`);
  // vm-nat in snet-nat, vm-lb in snet-lb.
  assert.equal(attr(nested(byName(l, "azurerm_network_interface", "nat").body, "ip_configuration"), "subnet_id"), "azurerm_subnet.nat.id");
  assert.equal(attr(nested(byName(l, "azurerm_network_interface", "lb").body, "ip_configuration"), "subnet_id"), "azurerm_subnet.lb.id");
  for (const k of ["nat", "lb"]) assert.equal(planned(NAT, `azurerm_subnet.${k}`).default_outbound_access_enabled, false);
});

test(`${NAT}: the readme explains BYOIP under Not built here`, () => {
  const l = lab(NAT);
  const h2 = [...l.readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.ok(h2.indexOf("Not built here") > h2.indexOf("Things to try") && h2.indexOf("Not built here") < h2.indexOf("Learn more"), "Not built here comes after Things to try and before Learn more");
  const nb = section(l, "Not built here");
  assert.match(nb, /custom IP prefix/i);
  assert.match(nb, /BYOIP|bring your own IP/i);
  assert.match(nb, /\]\(https:\/\/learn\.microsoft\.com\//, "with a Learn link");
  assert.ok(outputs(l).includes("peer_vnet_id"));
  assert.doesNotMatch(uncomment(Object.values(l.files).join("\n")), /azurerm_custom_ip_prefix/);
});

// ── Lab 32: hybrid DNS with DNS Private Resolver ─────────────────────────

const DNS = "az700-32-dns-resolver";

labContentSuite(DNS, { marker: "££" });

test(`${DNS}: inbound and outbound endpoints in their own delegated /28 subnets`, () => {
  const l = lab(DNS);
  const resolver = one(l, "azurerm_private_dns_resolver");
  assert.equal(attr(resolver.body, "virtual_network_id"), "azurerm_virtual_network.hub.id");
  const inbound = one(l, "azurerm_private_dns_resolver_inbound_endpoint");
  const outbound = one(l, "azurerm_private_dns_resolver_outbound_endpoint");
  assert.equal(attr(inbound.body, "private_dns_resolver_id"), "azurerm_private_dns_resolver.hub.id");
  assert.equal(attr(outbound.body, "private_dns_resolver_id"), "azurerm_private_dns_resolver.hub.id");
  const ipc = nested(inbound.body, "ip_configurations");
  assert.equal(attr(ipc, "subnet_id"), "azurerm_subnet.in.id");
  assert.equal(attr(ipc, "private_ip_allocation_method"), '"Dynamic"');
  assert.equal(attr(outbound.body, "subnet_id"), "azurerm_subnet.out.id");
  for (const k of ["in", "out"]) {
    const s = byName(l, "azurerm_subnet", k);
    assert.equal(attr(s.body, "virtual_network_name"), "azurerm_virtual_network.hub.name", `snet-${k} is in the hub`);
    assert.equal(attr(nested(s.body, "service_delegation"), "name"), '"Microsoft.Network/dnsResolvers"', `snet-${k} is delegated to DNS resolvers`);
    const prefix = planned(DNS, `azurerm_subnet.${k}`).address_prefixes;
    assert.equal(prefix.length, 1);
    assert.match(prefix[0], /\/28$/, `snet-${k} is a /28`);
  }
  // The two /28s are their own: neither is snet-app.
  assert.notEqual(planned(DNS, "azurerm_subnet.in").address_prefixes[0], planned(DNS, "azurerm_subnet.out").address_prefixes[0]);
  assert.match(planned(DNS, "azurerm_subnet.app").address_prefixes[0], /\/24$/);
  for (const s of resources(l, "azurerm_subnet")) assert.ok(attr(s.body, "default_outbound_access_enabled") !== undefined, `${s.labels[1]}: default outbound access set explicitly (ruling 37)`);
});

test(`${DNS}: the ruleset forwards onprem.lab32.internal to the dnsmasq VM and is linked to the hub`, () => {
  const l = lab(DNS);
  const rs = one(l, "azurerm_private_dns_resolver_dns_forwarding_ruleset");
  assert.equal(attr(rs.body, "private_dns_resolver_outbound_endpoint_ids"), "[azurerm_private_dns_resolver_outbound_endpoint.out.id]");
  const rule = one(l, "azurerm_private_dns_resolver_forwarding_rule");
  assert.equal(attr(rule.body, "dns_forwarding_ruleset_id"), `azurerm_private_dns_resolver_dns_forwarding_ruleset.${rs.labels[1]}.id`);
  assert.equal(attr(rule.body, "domain_name"), '"onprem.lab32.internal."', "the trailing dot: a fully qualified name");
  const target = nested(rule.body, "target_dns_servers");
  assert.equal(attr(target, "ip_address"), "local.dns_ip", "the dnsmasq VM's fixed address");
  assert.equal(attr(target, "port"), "53");
  const dnsNic = nested(byName(l, "azurerm_network_interface", "dns").body, "ip_configuration");
  assert.equal(attr(dnsNic, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(dnsNic, "private_ip_address"), "local.dns_ip");
  const link = one(l, "azurerm_private_dns_resolver_virtual_network_link");
  assert.equal(attr(link.body, "dns_forwarding_ruleset_id"), `azurerm_private_dns_resolver_dns_forwarding_ruleset.${rs.labels[1]}.id`);
  assert.equal(attr(link.body, "virtual_network_id"), "azurerm_virtual_network.hub.id");
  // The plan knows the rule's target: the fourth host of snet-onprem, in vnet-onprem.
  const r = planned(DNS, "azurerm_private_dns_resolver_forwarding_rule.onprem");
  assert.deepEqual(r.target_dns_servers, [{ ip_address: "10.71.208.4", port: 53 }]);
  // dnsmasq answers onprem.lab32.internal itself and sends azure.lab32.internal to the inbound endpoint.
  const tpl = readFileSync(join(l.tfDir, "dnsmasq-init.yaml.tftpl"), "utf8");
  assert.match(tpl, /local=\/onprem\.lab32\.internal\//);
  assert.match(tpl, /host-record=fileserver\.onprem\.lab32\.internal,/);
  assert.match(tpl, /server=\/azure\.lab32\.internal\/\$\{inbound_ip\}/);
  assert.match(uncomment(l.files["main.tf"]), /inbound_ip\s*=\s*azurerm_private_dns_resolver_inbound_endpoint\.in\.ip_configurations\[0\]\.private_ip_address/);
});

test(`${DNS}: the on-prem VNet uses the dnsmasq VM for DNS and that VM's NIC uses Azure DNS`, () => {
  const l = lab(DNS);
  const onprem = byName(l, "azurerm_virtual_network", "onprem");
  assert.equal(attr(onprem.body, "dns_servers"), "[local.dns_ip]");
  assert.equal(attr(byName(l, "azurerm_virtual_network", "hub").body, "dns_servers"), undefined, "the hub keeps Azure DNS (the ruleset is linked there)");
  assert.equal(attr(byName(l, "azurerm_network_interface", "dns").body, "dns_servers"), '["168.63.129.16"]', "vm-dns resolves through Azure DNS, so its apt install works before dnsmasq runs");
  // The two VNets are peered both ways (standing in for a VPN or ExpressRoute).
  const peerings = resources(l, "azurerm_virtual_network_peering").map((p) => `${attr(p.body, "virtual_network_name")} -> ${attr(p.body, "remote_virtual_network_id")}`).sort();
  assert.deepEqual(peerings, ["azurerm_virtual_network.hub.name -> azurerm_virtual_network.onprem.id", "azurerm_virtual_network.onprem.name -> azurerm_virtual_network.hub.id"]);
  assert.match(l.readme, /VPN or ExpressRoute/);
  // vm-dns installs dnsmasq, so its subnet has default outbound access on.
  assert.equal(attr(byName(l, "azurerm_subnet", "onprem").body, "default_outbound_access_enabled"), "true");
  assert.deepEqual(planned(DNS, "azurerm_virtual_network.onprem").dns_servers, ["10.71.208.4"]);
});

test(`${DNS}: dns_link is true and Terraform never links a zone to the gateway`, () => {
  const l = lab(DNS);
  assert.equal(l.yaml.connectivity.dns_link, true);
  const zone = one(l, "azurerm_private_dns_zone");
  assert.equal(attr(zone.body, "name"), '"azure.lab32.internal"', "a .internal name: the gateway's dnsmasq forwards internal to Azure DNS (ruling 10)");
  const links = resources(l, "azurerm_private_dns_zone_virtual_network_link");
  assert.deepEqual(links.map((x) => attr(x.body, "virtual_network_id")), ["azurerm_virtual_network.hub.id"], "the zone is linked to the hub only; the Worker links it to the gateway while peered");
  assert.equal(attr(links[0].body, "registration_enabled"), "true");
  assert.doesNotMatch(uncomment(Object.values(l.files).join("\n")), /gateway_vnet_id/, "Terraform never names the gateway's VNet");
});

// Review fix 16: the plan's table of the fourteen labs says how many /20s each uses; it must agree with each lab.yaml.
test("the AZ-700 plan's table gives each lab's subnets_used as its lab.yaml does", () => {
  const plan = readFileSync(join(lab(NAT).dir, "..", "..", "docs", "superpowers", "plans", "2026-10-06-labs-az700-plan.md"), "utf8").replace(/\r\n/g, "\n");
  const table = plan.split("\n## The fourteen labs\n")[1].split("\n### ")[0];
  const rows = [...table.matchAll(/^\| (\d{2}) \| (az700-\d{2}-[a-z0-9-]+) \|(.*)\|$/gm)].map((m) => ({ id: m[2], cells: m[3].split("|").map((c) => c.trim()) }));
  assert.equal(rows.length, 14);
  // Columns after the id: Builds, £/h, Peer, Regions, /20s, ...
  for (const r of rows) assert.equal(Number(r.cells[4]), lab(r.id).yaml.connectivity.subnets_used, `${r.id}: /20s`);
});

// ── Lab 33: Virtual Network Manager (scope exception S1) ─────────────────

const AVNM = "az700-33-vnet-manager";

labContentSuite(AVNM, { marker: "££" });

test(`${AVNM}: the network manager's scope is exactly the current subscription and it has no cross-tenant scope`, () => {
  const l = lab(AVNM);
  const m = one(l, "azurerm_network_manager");
  assert.equal(m.labels[1], "avnm");
  assert.equal(attr(m.body, "name"), '"avnm-${var.name_prefix}"');
  assert.equal(attr(m.body, "resource_group_name"), "azurerm_resource_group.lab.name", "the manager lives in rg-lab-<id>; only its reach is the subscription (S1)");
  const scope = allNested(m.body, "scope");
  assert.equal(scope.length, 1, "one scope block");
  assert.equal(attr(scope[0], "subscription_ids"), "[data.azurerm_subscription.current.id]");
  assert.equal(attr(scope[0], "management_group_ids"), undefined, "no management group scope");
  assert.doesNotMatch(m.body, /cross_tenant_scopes/, "no cross-tenant scope");
  assert.deepEqual(strings(attr(m.body, "scope_accesses")), ["Connectivity", "SecurityAdmin"]);
  // The current subscription: a data source that names no subscription of its own.
  const subs = l.blocks.filter((b) => b.kind === "data" && b.labels[0] === "azurerm_subscription");
  assert.deepEqual(subs.map((b) => b.labels[1]), ["current"]);
  assert.doesNotMatch(subs[0].body, /subscription_id/);
  // Only the eight AVNM types S1 allows, and no policy of any kind (dynamic membership needs one).
  const S1_TYPES = ["azurerm_network_manager", "azurerm_network_manager_network_group", "azurerm_network_manager_static_member", "azurerm_network_manager_connectivity_configuration", "azurerm_network_manager_security_admin_configuration", "azurerm_network_manager_admin_rule_collection", "azurerm_network_manager_admin_rule", "azurerm_network_manager_deployment"];
  for (const r of resources(l).filter((x) => x.labels[0].startsWith("azurerm_network_manager"))) assert.ok(S1_TYPES.includes(r.labels[0]), `${r.labels[0]} is not one of the AVNM types S1 allows`);
  assert.equal(resources(l).filter((x) => /policy/.test(x.labels[0])).length, 0, "no policy definition or assignment");
  const plannedScope = planned(AVNM, "azurerm_network_manager.avnm").scope;
  assert.equal(plannedScope.length, 1);
  assert.equal(plannedScope[0].subscription_ids.length, 1);
});

test(`${AVNM}: the network group's members are the two spokes, statically`, () => {
  const l = lab(AVNM);
  const g = one(l, "azurerm_network_manager_network_group");
  assert.equal(attr(g.body, "name"), '"ng-spokes"');
  assert.equal(attr(g.body, "network_manager_id"), "azurerm_network_manager.avnm.id");
  assert.ok([undefined, '"VirtualNetwork"'].includes(attr(g.body, "member_type")), "a group of VNets");
  const members = resources(l, "azurerm_network_manager_static_member");
  assert.deepEqual(members.map((x) => attr(x.body, "target_virtual_network_id")).sort(), ["azurerm_virtual_network.spoke1.id", "azurerm_virtual_network.spoke2.id"], "each member is the lab's own spoke, by reference");
  for (const x of members) assert.equal(attr(x.body, "network_group_id"), "azurerm_network_manager_network_group.spokes.id");
  // Three VNets, from the first three /20s; the hub is not a member.
  assert.deepEqual(resources(l, "azurerm_virtual_network").map((v) => attr(v.body, "name")).sort(), ['"vnet-hub"', '"vnet-spoke1"', '"vnet-spoke2"']);
  assert.deepEqual(["hub", "spoke1", "spoke2"].map((k) => planned(AVNM, `azurerm_virtual_network.${k}`).address_space[0]), ["10.71.192.0/20", "10.71.208.0/20", "10.71.224.0/20"]);
});

test(`${AVNM}: hub-and-spoke connectivity and a security admin rule collection are deployed in the lab's region`, () => {
  const l = lab(AVNM);
  const cc = one(l, "azurerm_network_manager_connectivity_configuration");
  assert.equal(attr(cc.body, "network_manager_id"), "azurerm_network_manager.avnm.id");
  assert.equal(attr(cc.body, "connectivity_topology"), '"HubAndSpoke"');
  assert.equal(attr(cc.body, "global_mesh_enabled"), "false");
  // Review fix 10: never delete the hub's existing peerings (its peering with the gateway's vnet-wg among them).
  assert.equal(attr(cc.body, "delete_existing_peering_enabled"), "false");
  assert.equal(planned(AVNM, `azurerm_network_manager_connectivity_configuration.${cc.labels[1]}`).delete_existing_peering_enabled, false);
  const group = nested(cc.body, "applies_to_group");
  assert.equal(attr(group, "group_connectivity"), '"DirectlyConnected"');
  assert.equal(attr(group, "network_group_id"), "azurerm_network_manager_network_group.spokes.id");
  assert.equal(attr(group, "use_hub_gateway"), "false", "no hub gateway");
  const hub = nested(cc.body, "hub");
  assert.equal(attr(hub, "resource_id"), "azurerm_virtual_network.hub.id");
  assert.equal(attr(hub, "resource_type"), '"Microsoft.Network/virtualNetworks"');
  const sac = one(l, "azurerm_network_manager_security_admin_configuration");
  assert.equal(attr(sac.body, "network_manager_id"), "azurerm_network_manager.avnm.id");
  const rc = one(l, "azurerm_network_manager_admin_rule_collection");
  assert.equal(attr(rc.body, "security_admin_configuration_id"), `azurerm_network_manager_security_admin_configuration.${sac.labels[1]}.id`);
  assert.equal(attr(rc.body, "network_group_ids"), "[azurerm_network_manager_network_group.spokes.id]");
  // Two rules: deny SSH from the internet, and always allow it from the hub (lower number, evaluated first).
  const rules = Object.fromEntries(resources(l, "azurerm_network_manager_admin_rule").map((r) => [unquoteName(r), r.body]));
  assert.deepEqual(Object.keys(rules).sort(), ["always-allow-hub-ssh", "deny-ssh-internet"]);
  for (const body of Object.values(rules)) {
    assert.equal(attr(body, "admin_rule_collection_id"), `azurerm_network_manager_admin_rule_collection.${rc.labels[1]}.id`);
    assert.equal(attr(body, "direction"), '"Inbound"');
    assert.equal(attr(body, "protocol"), '"Tcp"');
    assert.deepEqual(strings(attr(body, "destination_port_ranges")), ["22"]);
  }
  const deny = rules["deny-ssh-internet"];
  assert.equal(attr(deny, "action"), '"Deny"');
  assert.equal(attr(deny, "priority"), "100");
  assert.equal(attr(nested(deny, "source"), "address_prefix_type"), '"ServiceTag"');
  assert.equal(attr(nested(deny, "source"), "address_prefix"), '"Internet"');
  const allow = rules["always-allow-hub-ssh"];
  assert.equal(attr(allow, "action"), '"AlwaysAllow"');
  assert.equal(attr(allow, "priority"), "90");
  assert.equal(attr(nested(allow, "source"), "address_prefix_type"), '"IPPrefix"');
  assert.equal(attr(nested(allow, "source"), "address_prefix"), "local.hub_cidr");
  // Both configurations deployed, each in the lab's region.
  const deps = resources(l, "azurerm_network_manager_deployment");
  const byAccess = Object.fromEntries(deps.map((d) => [strings(attr(d.body, "scope_access"))[0], d.body]));
  assert.deepEqual(Object.keys(byAccess).sort(), ["Connectivity", "SecurityAdmin"]);
  assert.equal(attr(byAccess.Connectivity, "configuration_ids"), `[azurerm_network_manager_connectivity_configuration.${cc.labels[1]}.id]`);
  assert.equal(attr(byAccess.SecurityAdmin, "configuration_ids"), `[azurerm_network_manager_security_admin_configuration.${sac.labels[1]}.id]`);
  for (const d of deps) {
    assert.equal(attr(d.body, "network_manager_id"), "azurerm_network_manager.avnm.id");
    assert.equal(attr(d.body, "location"), "azurerm_resource_group.lab.location");
  }
  // The security rules must be in place only once the rules are: the deployment waits for them.
  assert.match(byAccess.SecurityAdmin, /depends_on\s*=\s*\[[^\]]*azurerm_network_manager_admin_rule\.deny_ssh[^\]]*\]/);
  assert.match(byAccess.SecurityAdmin, /depends_on\s*=\s*\[[^\]]*azurerm_network_manager_admin_rule\.allow_hub_ssh[^\]]*\]/);
  assert.match(byAccess.Connectivity, /depends_on\s*=\s*\[[^\]]*azurerm_network_manager_static_member\.spoke1[^\]]*\]/);
});

// Review fix 5: azurerm's default timeout for a deployment is 24 hours, longer than any job: 30 minutes each way.
test(`${AVNM}: each deployment times out after 30 minutes to create or delete, not azurerm's 24 hours`, () => {
  const l = lab(AVNM);
  const deps = resources(l, "azurerm_network_manager_deployment");
  assert.equal(deps.length, 2);
  for (const d of deps) {
    const t = nested(d.body, "timeouts");
    assert.ok(t !== undefined, `${d.labels[1]} has a timeouts block`);
    assert.equal(attr(t, "create"), '"30m"', d.labels[1]);
    assert.equal(attr(t, "delete"), '"30m"', d.labels[1]);
  }
});

test(`${AVNM}: no NSG allows SSH from the internet; a spoke NSG's deny from the hub is what the always-allow rule overrides`, () => {
  const l = lab(AVNM);
  const rules = resources(l, "azurerm_network_security_rule");
  for (const r of rules) {
    if (attr(r.body, "access") === '"Allow"' && attr(r.body, "direction") === '"Inbound"') assert.doesNotMatch(attr(r.body, "source_address_prefix") ?? "", /"(\*|Internet|0\.0\.0\.0\/0)"/, `${r.labels[1]}: never an inbound rule from the internet (spec §3.9)`);
  }
  const deny = rules.filter((r) => attr(r.body, "access") === '"Deny"' && attr(r.body, "destination_port_range") === '"22"');
  assert.deepEqual(deny.map((r) => attr(r.body, "source_address_prefix")), ["local.hub_cidr", "local.hub_cidr"], "each spoke's NSG denies SSH from the hub");
  for (const k of ["spoke1", "spoke2"]) {
    const a = resources(l, "azurerm_subnet_network_security_group_association").find((x) => attr(x.body, "subnet_id") === `azurerm_subnet.${k}.id`);
    assert.ok(a, `snet-app in vnet-${k} has its NSG`);
  }
});

// Review fix 12: DirectlyConnected makes a connected group (no spoke-to-spoke peering), and nothing in the hub can
// send SSH to a spoke, so the readme must not promise ANM_ peerings between spokes or a test the lab cannot run.
test(`${AVNM}: the readme describes a connected group, not spoke peerings, and only things the lab can show`, () => {
  const l = lab(AVNM);
  const r = l.readme;
  assert.doesNotMatch(r, /spoke\s*<->\s*spoke/i, "no spoke <-> spoke peering");
  assert.doesNotMatch(r, /ANM_ peerings? (between|spoke)/i);
  assert.match(r, /connected group/i);
  assert.match(r, /no peering between the spokes|not a peering|no spoke-to-spoke peering/i);
  const tries = section(l, "Things to try");
  // The hub holds no VM, so "allowed from the hub" cannot be tried; the effective rules show the order instead.
  assert.doesNotMatch(tries, /allowed by `always-allow-hub-ssh`/);
  assert.match(tries, /[Ee]ffective security rules/);
  assert.match(tries, /no VM in the hub|hub has no VM/i);
  assert.equal(resources(l, "azurerm_linux_virtual_machine").filter((v) => /hub/.test(attr(v.body, "name") ?? "")).length, 0, "no hub VM (cost)");
  assert.doesNotMatch(r.split("## What it deploys")[0], /see an AlwaysAllow rule override an NSG/);
});

test(`${AVNM}: the readme warns never to add vnet-wg to a group`, () => {
  const l = lab(AVNM);
  assert.match(l.readme, /never add `vnet-wg`[^.]*network group/i);
  assert.match(l.readme, /deploy(ing)? \*\*None\*\*|"None"/i, "the readme says how configurations are removed (deploy None)");
  assert.match(l.readme, /Azure Policy/, "why dynamic membership is not built");
});

// ── Lab 34: Route Server with a BGP router VM ────────────────────────────

const RS = "az700-34-route-server";

labContentSuite(RS, { marker: "££" });

test(`${RS}: a Route Server in a /26 RouteServerSubnet with a Standard public IP`, () => {
  const l = lab(RS);
  const rs = one(l, "azurerm_route_server");
  assert.equal(attr(rs.body, "sku"), '"Standard"');
  assert.equal(attr(rs.body, "subnet_id"), "azurerm_subnet.rs.id");
  assert.equal(attr(rs.body, "public_ip_address_id"), "azurerm_public_ip.rs.id");
  assert.equal(attr(rs.body, "branch_to_branch_traffic_enabled"), "false");
  const subnet = byName(l, "azurerm_subnet", "rs");
  assert.equal(attr(subnet.body, "name"), '"RouteServerSubnet"');
  assert.equal(attr(subnet.body, "virtual_network_name"), "azurerm_virtual_network.hub.name");
  assert.deepEqual(planned(RS, "azurerm_subnet.rs").address_prefixes, ["10.71.192.0/26"]);
  const pip = one(l, "azurerm_public_ip");
  assert.equal(attr(pip.body, "sku"), '"Standard"');
  assert.equal(attr(pip.body, "allocation_method"), '"Static"');
  assert.deepEqual(strings(attr(pip.body, "zones")), ["1", "2", "3"]);
  // Nothing on RouteServerSubnet: no NSG, no route table.
  for (const t of ["azurerm_subnet_network_security_group_association", "azurerm_subnet_route_table_association"]) assert.ok(!resources(l, t).some((a) => attr(a.body, "subnet_id") === "azurerm_subnet.rs.id"), `no ${t} on RouteServerSubnet`);
});

test(`${RS}: the NVA has IP forwarding on and its BGP connection uses ASN 65010`, () => {
  const l = lab(RS);
  const nic = byName(l, "azurerm_network_interface", "nva");
  assert.equal(attr(nic.body, "ip_forwarding_enabled"), "true");
  const ipc = nested(nic.body, "ip_configuration");
  assert.equal(attr(ipc, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(ipc, "private_ip_address"), "local.nva_ip");
  const bgp = one(l, "azurerm_route_server_bgp_connection");
  assert.equal(attr(bgp.body, "route_server_id"), "azurerm_route_server.rs.id");
  assert.equal(attr(bgp.body, "peer_asn"), "65010");
  assert.equal(attr(bgp.body, "peer_ip"), "local.nva_ip");
  // FRR from cloud-init: both Route Server instances as eBGP multihop neighbours, retried and pinned.
  const vm = byName(l, "azurerm_linux_virtual_machine", "nva");
  assert.match(vm.body, /templatefile\("\$\{path\.module\}\/frr-init\.yaml\.tftpl"/);
  assert.match(vm.body, /rs_ips\s*=\s*azurerm_route_server\.rs\.virtual_router_ips/, "the neighbours are the Route Server's own addresses, so the VM is made after it");
  assert.match(vm.body, /asn\s*=\s*65010/);
  const tpl = readFileSync(join(l.tfDir, "frr-init.yaml.tftpl"), "utf8");
  assert.match(tpl, /%\{ for ip in rs_ips ~\}/);
  assert.match(tpl, /neighbor \$\{ip\} remote-as 65515/);
  assert.match(tpl, /neighbor \$\{ip\} ebgp-multihop/);
  assert.match(tpl, /router bgp \$\{asn\}/);
  assert.match(tpl, /network \$\{advertised_prefix\}/);
  assert.match(tpl, /Pin: version 8\.4\.4-\*/, "FRR pinned to Ubuntu 24.04's 8.4.4 series");
  assert.match(tpl, /for i in \$\(seq 1 30\)/, "the install is retried");
  assert.match(tpl, /bgpd=yes/);
  assert.match(tpl, /net\.ipv4\.ip_forward = 1/);
  // FRR comes from Ubuntu's archive, so snet-nva has default outbound access on.
  assert.equal(attr(byName(l, "azurerm_subnet", "nva").body, "default_outbound_access_enabled"), "true");
  assert.deepEqual(planned(RS, "azurerm_route_server_bgp_connection.nva").peer_asn, 65010);
});

test(`${RS}: the spoke uses the hub's remote gateway after the Route Server exists`, () => {
  const l = lab(RS);
  const hubToSpoke = byName(l, "azurerm_virtual_network_peering", "hub_to_spoke");
  assert.equal(attr(hubToSpoke.body, "allow_gateway_transit"), "true");
  const spokeToHub = byName(l, "azurerm_virtual_network_peering", "spoke_to_hub");
  assert.equal(attr(spokeToHub.body, "use_remote_gateways"), "true");
  assert.equal(attr(spokeToHub.body, "remote_virtual_network_id"), "azurerm_virtual_network.hub.id");
  assert.match(spokeToHub.body, /depends_on\s*=\s*\[[^\]]*azurerm_route_server\.rs\b/, "a peering may use remote gateways only once the hub has one");
  assert.match(spokeToHub.body, /depends_on\s*=\s*\[[^\]]*azurerm_virtual_network_peering\.hub_to_spoke\b/);
  assert.equal(planned(RS, "azurerm_virtual_network_peering.spoke_to_hub").use_remote_gateways, true);
});

test(`${RS}: the advertised prefix is in the slot and in no VNet`, () => {
  const l = lab(RS);
  const main = uncomment(l.files["main.tf"]);
  assert.match(main, /advertised_prefix\s*=\s*cidrsubnet\(cidrsubnet\(var\.address_space,\s*2,\s*3\),\s*4,\s*0\)/, "the first /24 of the slot's last /20");
  assert.equal(l.yaml.connectivity.subnets_used, 3, "the advertised prefix takes /20 #3 of the slot, so it counts");
  // At slot 31 it is 10.71.240.0/24: inside the slot, outside both VNets.
  const vm = LAB_PLANS[RS].plan.configuration.root_module.resources.find((r) => r.address === "azurerm_linux_virtual_machine.nva");
  assert.ok(vm, "the plan has vm-nva");
  const vnets = ["hub", "spoke"].map((k) => planned(RS, `azurerm_virtual_network.${k}`).address_space[0]);
  assert.deepEqual(vnets, ["10.71.192.0/20", "10.71.208.0/20"]);
  for (const v of vnets) assert.equal(cidrOverlaps(v, "10.71.240.0/24"), false, `${v} does not hold the advertised prefix`);
  assert.equal(cidrOverlaps("10.71.192.0/18", "10.71.240.0/24"), true);
  // A dummy interface on the NVA holds an address in it, so the route has somewhere to go.
  const tpl = readFileSync(join(l.tfDir, "frr-init.yaml.tftpl"), "utf8");
  assert.match(tpl, /Kind=dummy/);
  assert.match(tpl, /Address=\$\{advertised_ip\}\/24/);
});

// ── Lab 35: break-fix, forced tunnelling to an NVA that does not forward ─

const FT = "az700-35-forced-tunnel-fix";

labContentSuite(FT, { marker: "£" });

test(`${FT}: the spoke's route table sends 0.0.0.0/0 to the NVA`, () => {
  const l = lab(FT);
  const rt = one(l, "azurerm_route_table");
  assert.equal(attr(rt.body, "name"), '"rt-spoke"');
  assert.equal(allNested(rt.body, "route").length, 0, "routes are azurerm_route resources");
  const route = one(l, "azurerm_route");
  assert.equal(attr(route.body, "route_table_name"), `azurerm_route_table.${rt.labels[1]}.name`);
  assert.equal(attr(route.body, "address_prefix"), '"0.0.0.0/0"');
  assert.equal(attr(route.body, "next_hop_type"), '"VirtualAppliance"');
  assert.equal(attr(route.body, "next_hop_in_ip_address"), "local.nva_ip");
  const assoc = one(l, "azurerm_subnet_route_table_association");
  assert.equal(attr(assoc.body, "subnet_id"), "azurerm_subnet.app.id");
  assert.equal(attr(assoc.body, "route_table_id"), `azurerm_route_table.${rt.labels[1]}.id`);
  // The spoke has no way out of its own: default outbound off, so the route is its only path.
  assert.equal(attr(byName(l, "azurerm_subnet", "app").body, "default_outbound_access_enabled"), "false");
  assert.equal(attr(byName(l, "azurerm_subnet", "nva").body, "default_outbound_access_enabled"), "true", "the NVA itself can reach the internet");
  // Peered both ways with forwarded traffic allowed: the peering is not one of the faults.
  const peerings = resources(l, "azurerm_virtual_network_peering");
  assert.equal(peerings.length, 2);
  for (const p of peerings) assert.equal(attr(p.body, "allow_forwarded_traffic"), "true");
  assert.deepEqual(planned(FT, "azurerm_route.default"), { ...planned(FT, "azurerm_route.default"), address_prefix: "0.0.0.0/0", next_hop_in_ip_address: "10.71.192.4" });
});

test(`${FT}: the NVA's NIC has IP forwarding off`, () => {
  const l = lab(FT);
  const nic = byName(l, "azurerm_network_interface", "nva");
  assert.equal(attr(nic.body, "ip_forwarding_enabled"), "false", "fault 1, set explicitly");
  assert.equal(attr(nested(nic.body, "ip_configuration"), "private_ip_address"), "local.nva_ip");
  // Fault 2 in the OS: kernel forwarding off. Fault 3: no masquerade anywhere.
  const tpl = readFileSync(join(l.tfDir, "nva-init.yaml.tftpl"), "utf8");
  assert.match(tpl, /net\.ipv4\.ip_forward = 0/);
  assert.doesNotMatch(tpl.replace(/^\s*#.*$/gm, ""), /MASQUERADE|masquerade|nat/i, "no SNAT set up");
  assert.equal(planned(FT, "azurerm_network_interface.nva").ip_forwarding_enabled, false);
});

test(`${FT}: the readme has a Symptom and a closed What was broken naming the three faults`, () => {
  const l = lab(FT);
  assert.equal(l.yaml.type, "break-fix");
  const symptom = section(l, "Symptom");
  assert.match(symptom, /curl -I https:\/\/www\.microsoft\.com/);
  assert.match(symptom, /time[sd]? out/);
  assert.match(l.readme, /<details>\n<summary>What was broken<\/summary>/);
  const broken = l.readme.split("<summary>What was broken</summary>")[1].split("</details>")[0];
  assert.match(broken, /IP forwarding/);
  assert.match(broken, /ip_forward/);
  assert.match(broken, /MASQUERADE|SNAT/);
  assert.match(broken, /[Nn]ext hop/);
  assert.match(broken, /[Ee]ffective routes/);
  assert.ok(l.readme.indexOf("## Symptom") < l.readme.indexOf("<details>") && l.readme.indexOf("<details>") < l.readme.indexOf("## Things to try"), "Symptom, then the details, then Things to try");
});

/** An admin rule's name attribute, unquoted. */
function unquoteName(r) {
  return (attr(r.body, "name") ?? "").replace(/^"|"$/g, "");
}
