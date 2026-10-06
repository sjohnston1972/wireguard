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
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";

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
