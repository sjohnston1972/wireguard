// labs-az700-delivery.test.mjs
//
// Plain English: the AZ-700 delivery, private access and monitoring labs
// (AZ-700 labs plan, area Z3: labs 40 to 44) checked without touching Azure.
// Each runs the shared content suite (fixtures/labs/content.mjs, test 6 from
// its plan fixture at slot 31), then its own tests: what it builds, what it
// never builds (a VM public IP, SSH from the internet), where it builds it,
// and that it is priced honestly. init, validate and the mock plan are npm
// run labs-tf's job; the plan fixtures' match with main.tf is
// lab-plans.test.mjs's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";

const LB = "az700-40-lb-advanced";

// ── Helpers ──────────────────────────────────────────────────────────────

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
const output = (l, name) => l.blocks.find((b) => b.kind === "output" && b.labels[0] === name);
/** Every .tf file's code, comments dropped. */
const code = (l) => uncomment(Object.values(l.files).join("\n"));

/** The azurerm provider's features block from versions.tf. */
const features = (l) => {
  const p = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm");
  assert.ok(p, 'versions.tf has provider "azurerm"');
  const f = nested(p.body, "features");
  assert.ok(f !== undefined, "the azurerm provider has a features block");
  return f;
};

/** The lab's locals, name -> expression (one per line, as terraform fmt lays them out). */
function locals(l) {
  const out = {};
  for (const b of l.blocks.filter((x) => x.kind === "locals")) for (const m of b.body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*(.+)$/gm)) out[m[1]] = m[2].trim();
  return out;
}
/** An expression with local.x replaced by its value, until none is left. */
function expand(l, expr) {
  const ls = locals(l);
  let e = expr ?? "";
  for (let i = 0; i < 8 && /\blocal\.[a-z0-9_]+/.test(e); i++) e = e.replace(/\blocal\.([a-z0-9_]+)/g, (m, n) => ls[n] ?? m);
  return e;
}
/** A VNet's or subnet's only address, from `address_space` / `address_prefixes` = [x], locals expanded. */
function cidrOf(l, body, name) {
  const v = attr(body, name);
  const m = /^\[(.+)\]$/.exec(v ?? "");
  assert.ok(m, `${name} is a one-element list (${v})`);
  return expand(l, m[1]).replace(/\s+/g, " ");
}

/** A subnet by its Azure name inside the VNet resource `vnet` (azurerm_virtual_network.<vnet>). */
function subnetIn(l, vnet, name) {
  const s = resources(l, "azurerm_subnet").find((x) => attr(x.body, "virtual_network_name") === `azurerm_virtual_network.${vnet}.name` && attr(x.body, "name") === `"${name}"`);
  assert.ok(s, `${name} in azurerm_virtual_network.${vnet}`);
  return s;
}

/** A plan fixture resource's planned values, by address. */
const planned = (id, address) => {
  const r = LAB_PLANS[id].plan.planned_values.root_module.resources.find((x) => x.address === address);
  assert.ok(r, `${id}'s plan fixture has ${address}`);
  return r.values;
};

/** Every NSG rule a lab writes: [{ name, nsg, body }] (azurerm_network_security_rule resources). */
const nsgRules = (l) => resources(l, "azurerm_network_security_rule").map((r) => ({ key: r.labels[1], nsg: /^azurerm_network_security_group\.([a-z0-9_]+)\.name$/.exec(attr(r.body, "network_security_group_name") ?? "")?.[1], body: r.body }));

/** Does a port spec ("22", "20-25", "*", ["22", "80"]) take in `port`? */
function portsInclude(spec, port) {
  const parts = spec.startsWith("[") ? strings(spec) : [spec.replace(/^"|"$/g, "")];
  return parts.some((p) => {
    if (p === "*") return true;
    const [a, b = a] = p.split("-").map(Number);
    return port >= a && port <= b;
  });
}
const ruleString = (body, name) => (attr(body, name) ?? "").replace(/^"|"$/g, "");

/** Review Focus 2: no NSG rule lets the internet reach SSH or RDP, and no VM's NIC has a public IP. */
function noInternetSsh(l) {
  for (const r of nsgRules(l)) {
    if (ruleString(r.body, "direction") !== "Inbound" || ruleString(r.body, "access") !== "Allow") continue;
    const src = [attr(r.body, "source_address_prefix"), attr(r.body, "source_address_prefixes")].filter(Boolean).join(" ");
    if (!/Internet|\*|0\.0\.0\.0\/0/.test(src)) continue;
    const dst = attr(r.body, "destination_port_range") ?? attr(r.body, "destination_port_ranges") ?? '"*"';
    for (const port of [22, 3389]) assert.ok(!portsInclude(dst, port), `${r.key} lets the internet reach port ${port}`);
  }
  for (const nic of resources(l, "azurerm_network_interface")) assert.doesNotMatch(nic.body, /public_ip_address_id/, `${nic.labels[1]}: no public IP on a VM`);
}

/** cloud-init template `file` rendered with `vars` (templatefile's ${name}; shell variables are $name, never ${name}). */
function renderCloudInit(l, file, vars) {
  const tpl = readFileSync(join(l.tfDir, file), "utf8").replace(/\r\n/g, "\n");
  const rendered = tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    assert.ok(k in vars, `${file} takes only ${Object.keys(vars).join(", ")} (found \${${k}})`);
    return vars[k];
  });
  assert.doesNotMatch(rendered, /%\{/, "no template directives");
  assert.match(tpl, /^#cloud-config\n/);
  return { text: rendered, doc: parseYaml(rendered) };
}

const IN_LAB = "azurerm_resource_group.lab.name";
const IN_SECONDARY = "azurerm_resource_group.secondary.name";

// ── Lab 40: Load Balancer, cross-region, Gateway LB, inbound NAT, outbound rules ──

labContentSuite(LB, { marker: "££", secondary: true });

/** Lab 40's load balancers by role: { global, uks, ukw, gw }. */
function lbs(l) {
  const all = resources(l, "azurerm_lb");
  assert.equal(all.length, 4, "four load balancers: global, uksouth, ukwest and the Gateway load balancer");
  const find = (pick, what) => {
    const r = all.filter(pick);
    assert.equal(r.length, 1, what);
    return r[0];
  };
  return {
    global: find((x) => attr(x.body, "sku_tier") === '"Global"', "one global-tier load balancer"),
    gw: find((x) => attr(x.body, "sku") === '"Gateway"', "one Gateway load balancer"),
    uks: find((x) => attr(x.body, "sku") === '"Standard"' && attr(x.body, "sku_tier") === undefined && top(x.body, "resource_group_name") === IN_LAB, "one regional Standard load balancer in rg-lab-<id>"),
    ukw: find((x) => attr(x.body, "sku") === '"Standard"' && top(x.body, "resource_group_name") === IN_SECONDARY, "one regional Standard load balancer in rg-lab-<id>-secondary"),
  };
}
/** The resources of `type` whose loadbalancer_id is azurerm_lb.<key>.id. */
const onLb = (l, type, key) => resources(l, type).filter((r) => attr(r.body, "loadbalancer_id") === `azurerm_lb.${key}.id`);

test(`${LB}: a global-tier load balancer in uksouth over the two regional frontends`, () => {
  const l = lab(LB);
  const { global, uks, ukw } = lbs(l);
  const g = global.body;
  assert.equal(attr(g, "name"), '"lb-global"');
  assert.equal(attr(g, "sku"), '"Standard"');
  assert.equal(top(g, "resource_group_name"), IN_LAB);
  // Its home region is the session's, uksouth (a home region, Learn 2026-07-07).
  assert.equal(top(g, "location"), "azurerm_resource_group.lab.location");
  // A Global-tier Standard public IP, in the home region.
  const fe = nested(g, "frontend_ip_configuration");
  const pipKey = /^azurerm_public_ip\.([a-z0-9_]+)\.id$/.exec(attr(fe, "public_ip_address_id") ?? "")?.[1];
  const pip = byName(l, "azurerm_public_ip", pipKey).body;
  assert.equal(attr(pip, "sku"), '"Standard"');
  assert.equal(attr(pip, "sku_tier"), '"Global"');
  assert.equal(attr(pip, "allocation_method"), '"Static"');
  assert.equal(attr(pip, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(pip, "resource_group_name"), IN_LAB);
  // One pool whose two members are the regional load balancers' frontends.
  const pools = onLb(l, "azurerm_lb_backend_address_pool", global.labels[1]);
  assert.equal(pools.length, 1, "one backend pool on the global load balancer");
  const members = resources(l, "azurerm_lb_backend_address_pool_address");
  assert.equal(members.length, 2);
  for (const m of members) {
    assert.equal(attr(m.body, "backend_address_pool_id"), `azurerm_lb_backend_address_pool.${pools[0].labels[1]}.id`);
    assert.equal(attr(m.body, "ip_address"), undefined, "a frontend, not an address");
    assert.equal(attr(m.body, "virtual_network_id"), undefined);
  }
  assert.deepEqual(members.map((m) => attr(m.body, "backend_address_ip_configuration_id")).sort(), [`azurerm_lb.${uks.labels[1]}.frontend_ip_configuration[0].id`, `azurerm_lb.${ukw.labels[1]}.frontend_ip_configuration[0].id`].sort());
  // One rule, TCP 80 to 80 (the regional rules' frontend port); the global tier has no probe and no outbound rule.
  const rules = onLb(l, "azurerm_lb_rule", global.labels[1]);
  assert.equal(rules.length, 1);
  const r = rules[0].body;
  assert.deepEqual([attr(r, "protocol"), attr(r, "frontend_port"), attr(r, "backend_port")], ['"Tcp"', "80", "80"]);
  assert.equal(attr(r, "probe_id"), undefined, "the global tier takes no probe: it reads the regional load balancers' health");
  assert.equal(attr(r, "backend_address_pool_ids"), `[azurerm_lb_backend_address_pool.${pools[0].labels[1]}.id]`);
  assert.equal(onLb(l, "azurerm_lb_probe", global.labels[1]).length, 0);
  assert.equal(onLb(l, "azurerm_lb_outbound_rule", global.labels[1]).length, 0, "no outbound rules on the global tier");
});

test(`${LB}: the uksouth frontend is chained to a Gateway load balancer whose pool has VXLAN tunnel interfaces`, () => {
  const l = lab(LB);
  const { gw, uks } = lbs(l);
  const fe = nested(uks.body, "frontend_ip_configuration");
  assert.equal(attr(fe, "gateway_load_balancer_frontend_ip_configuration_id"), `azurerm_lb.${gw.labels[1]}.frontend_ip_configuration[0].id`);
  // The Gateway load balancer: an internal frontend in snet-nva at a fixed address.
  const g = gw.body;
  assert.equal(attr(g, "name"), '"lb-gw"');
  assert.equal(top(g, "resource_group_name"), IN_LAB);
  const gfe = nested(g, "frontend_ip_configuration");
  assert.equal(attr(gfe, "subnet_id"), `azurerm_subnet.${subnetIn(l, "uks", "snet-nva").labels[1]}.id`);
  assert.equal(attr(gfe, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(gfe, "public_ip_address_id"), undefined);
  // Its pool: two VXLAN tunnel interfaces, internal 10800 / VNI 800 and external 10801 / VNI 801.
  const pools = onLb(l, "azurerm_lb_backend_address_pool", gw.labels[1]);
  assert.equal(pools.length, 1);
  const tunnels = allNested(pools[0].body, "tunnel_interface").map((t) => [attr(t, "identifier"), attr(t, "type"), attr(t, "protocol"), attr(t, "port")]);
  assert.deepEqual(tunnels.sort(), [["800", '"Internal"', '"VXLAN"', "10800"], ["801", '"External"', '"VXLAN"', "10801"]]);
  // HA ports (every protocol, port 0) with a TCP 22 probe the NVA's sshd answers.
  const rules = onLb(l, "azurerm_lb_rule", gw.labels[1]);
  assert.equal(rules.length, 1);
  assert.deepEqual([attr(rules[0].body, "protocol"), attr(rules[0].body, "frontend_port"), attr(rules[0].body, "backend_port")], ['"All"', "0", "0"]);
  const probes = onLb(l, "azurerm_lb_probe", gw.labels[1]);
  assert.equal(probes.length, 1);
  assert.deepEqual([attr(probes[0].body, "protocol"), attr(probes[0].body, "port")], ['"Tcp"', "22"]);
  assert.equal(attr(rules[0].body, "probe_id"), `azurerm_lb_probe.${probes[0].labels[1]}.id`);
  // vm-nva is the pool's one member, its NIC forwarding IP.
  const assoc = resources(l, "azurerm_network_interface_backend_address_pool_association").filter((a) => attr(a.body, "backend_address_pool_id") === `azurerm_lb_backend_address_pool.${pools[0].labels[1]}.id`);
  assert.equal(assoc.length, 1);
  const nicKey = /^azurerm_network_interface\.([a-z0-9_]+)\.id$/.exec(attr(assoc[0].body, "network_interface_id"))?.[1];
  const nic = byName(l, "azurerm_network_interface", nicKey).body;
  assert.equal(attr(nic, "name"), '"nic-vm-nva"');
  assert.equal(attr(nic, "ip_forwarding_enabled"), "true");
});

test(`${LB}: the NVA's cloud-init bridges the two VXLAN tunnels to the Gateway load balancer's frontend`, () => {
  const l = lab(LB);
  const vm = resources(l, "azurerm_linux_virtual_machine").find((v) => attr(v.body, "name") === '"vm-nva"');
  assert.ok(vm, "vm-nva");
  assert.equal(attr(vm.body, "custom_data"), 'base64encode(templatefile("${path.module}/nva-cloud-init.yaml.tftpl", { gateway_lb_ip = local.gw_ip }))');
  // The template names the frontend the Gateway load balancer has: local.gw_ip.
  const { gw } = lbs(l);
  assert.equal(attr(nested(gw.body, "frontend_ip_configuration"), "private_ip_address"), "local.gw_ip");
  const { doc, text } = renderCloudInit(l, "nva-cloud-init.yaml.tftpl", { gateway_lb_ip: "10.71.193.10" });
  const all = text.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(all, /\b(apt|apt-get|pip|snap|wget|curl)\b/, "nothing installed: iproute2 ships with Ubuntu");
  const script = doc.write_files.find((f) => f.path === "/usr/local/bin/lab-vxlan");
  assert.ok(script, "/usr/local/bin/lab-vxlan");
  assert.match(script.content, /type vxlan id 800 [^\n]*remote 10\.71\.193\.10 [^\n]*dstport 10800/);
  assert.match(script.content, /type vxlan id 801 [^\n]*remote 10\.71\.193\.10 [^\n]*dstport 10801/);
  assert.match(script.content, /type bridge/);
  // Both tunnels join the bridge: a packet in on one leaves on the other.
  assert.match(script.content, /for link in vxlan800 vxlan801; do\n[^]*?ip link set "\$link" master br-gwlb\n[^]*?done/);
  const unit = doc.write_files.find((f) => f.path === "/etc/systemd/system/lab-vxlan.service");
  assert.ok(unit, "a systemd unit, so the tunnels come back after a reboot");
  assert.match(unit.content, /^ExecStart=\/usr\/local\/bin\/lab-vxlan$/m);
  assert.ok(doc.runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c)).includes("systemctl enable --now lab-vxlan.service"));
});

test(`${LB}: an inbound NAT rule maps a port range to port 80 and never to 22`, () => {
  const l = lab(LB);
  const { uks } = lbs(l);
  const nats = resources(l, "azurerm_lb_nat_rule");
  assert.equal(nats.length, 1, "one inbound NAT rule");
  const n = nats[0].body;
  assert.equal(attr(n, "loadbalancer_id"), `azurerm_lb.${uks.labels[1]}.id`);
  assert.equal(attr(n, "resource_group_name"), IN_LAB);
  // Version 2: a frontend port range over a backend pool, not one rule per NIC.
  assert.deepEqual([attr(n, "protocol"), attr(n, "frontend_port_start"), attr(n, "frontend_port_end"), attr(n, "backend_port")], ['"Tcp"', "8081", "8090", "80"]);
  assert.equal(attr(n, "frontend_port"), undefined);
  const pool = onLb(l, "azurerm_lb_backend_address_pool", uks.labels[1])[0];
  assert.equal(attr(n, "backend_address_pool_id"), `azurerm_lb_backend_address_pool.${pool.labels[1]}.id`);
  assert.equal(attr(n, "frontend_ip_configuration_name"), attr(nested(uks.body, "frontend_ip_configuration"), "name"));
  for (const x of resources(l, "azurerm_lb_nat_rule")) for (const a of ["backend_port", "frontend_port", "frontend_port_start", "frontend_port_end"]) assert.notEqual(attr(x.body, a), "22", `${a} is never 22`);
  noInternetSsh(l);
});

test(`${LB}: both regional load balancers have outbound rules and their rules disable outbound SNAT`, () => {
  const l = lab(LB);
  const { uks, ukw } = lbs(l);
  for (const lb of [uks, ukw]) {
    const key = lb.labels[1];
    const fe = attr(nested(lb.body, "frontend_ip_configuration"), "name");
    // A public frontend from a Standard static public IP the load balancer owns.
    const pipKey = /^azurerm_public_ip\.([a-z0-9_]+)\.id$/.exec(attr(nested(lb.body, "frontend_ip_configuration"), "public_ip_address_id") ?? "")?.[1];
    const pip = byName(l, "azurerm_public_ip", pipKey).body;
    assert.equal(attr(pip, "sku"), '"Standard"');
    assert.equal(attr(pip, "sku_tier"), undefined, "Regional");
    const rules = onLb(l, "azurerm_lb_rule", key);
    assert.equal(rules.length, 1, `${key}: one load-balancing rule`);
    const r = rules[0].body;
    assert.deepEqual([attr(r, "protocol"), attr(r, "frontend_port"), attr(r, "backend_port"), attr(r, "frontend_ip_configuration_name")], ['"Tcp"', "80", "80", fe]);
    assert.equal(attr(r, "disable_outbound_snat"), "true", `${key}: the rule leaves outbound to the outbound rule`);
    const probes = onLb(l, "azurerm_lb_probe", key);
    assert.equal(probes.length, 1);
    assert.deepEqual([attr(probes[0].body, "protocol"), attr(probes[0].body, "port"), attr(probes[0].body, "request_path")], ['"Http"', "80", '"/"']);
    assert.equal(attr(r, "probe_id"), `azurerm_lb_probe.${probes[0].labels[1]}.id`);
    const outs = onLb(l, "azurerm_lb_outbound_rule", key);
    assert.equal(outs.length, 1, `${key}: one outbound rule`);
    const o = outs[0].body;
    assert.equal(attr(o, "protocol"), '"All"');
    assert.equal(attr(nested(o, "frontend_ip_configuration"), "name"), fe);
    const pool = onLb(l, "azurerm_lb_backend_address_pool", key);
    assert.equal(pool.length, 1);
    assert.equal(attr(o, "backend_address_pool_id"), `azurerm_lb_backend_address_pool.${pool[0].labels[1]}.id`);
    assert.equal(attr(r, "backend_address_pool_ids"), `[azurerm_lb_backend_address_pool.${pool[0].labels[1]}.id]`);
    assert.equal(Number(attr(o, "allocated_outbound_ports")) % 8, 0, "ports in multiples of 8");
    assert.equal(attr(o, "tcp_reset_enabled"), "true");
  }
  // The web subnets reach out only through the outbound rules: default outbound access off (ruling 37).
  for (const [vnet, name] of [["uks", "snet-web"], ["ukw", "snet-web"], ["uks", "snet-nva"]]) assert.equal(attr(subnetIn(l, vnet, name).body, "default_outbound_access_enabled"), "false", `${vnet} ${name}`);
});

test(`${LB}: ukwest resources are in rg-lab-<id>-secondary`, () => {
  const l = lab(LB);
  const { ukw } = lbs(l);
  const vnets = Object.fromEntries(resources(l, "azurerm_virtual_network").map((v) => [v.labels[1], v.body]));
  assert.deepEqual(Object.keys(vnets).sort(), ["uks", "ukw"]);
  assert.equal(attr(vnets.uks, "name"), '"vnet-uks"');
  assert.equal(attr(vnets.ukw, "name"), '"vnet-ukw"');
  assert.equal(attr(vnets.uks, "resource_group_name"), IN_LAB);
  assert.equal(attr(vnets.ukw, "resource_group_name"), IN_SECONDARY);
  assert.equal(cidrOf(l, vnets.uks, "address_space"), "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(cidrOf(l, vnets.ukw, "address_space"), "cidrsubnet(var.address_space, 2, 1)");
  assert.equal(cidrOf(l, subnetIn(l, "uks", "snet-web").body, "address_prefixes"), "cidrsubnet(cidrsubnet(var.address_space, 2, 0), 4, 0)");
  assert.equal(cidrOf(l, subnetIn(l, "uks", "snet-nva").body, "address_prefixes"), "cidrsubnet(cidrsubnet(var.address_space, 2, 0), 4, 1)");
  assert.equal(cidrOf(l, subnetIn(l, "ukw", "snet-web").body, "address_prefixes"), "cidrsubnet(cidrsubnet(var.address_space, 2, 1), 4, 0)");
  // Everything in vnet-ukw, and lb-ukw with its IP, pool members and rules, lives in the secondary group, in ukwest.
  const secondary = ["azurerm_virtual_network.ukw", `azurerm_lb.${ukw.labels[1]}`];
  for (const a of secondary) {
    const [type, name] = a.split(".");
    const b = byName(l, type, name).body;
    assert.equal(top(b, "resource_group_name"), IN_SECONDARY, a);
    assert.equal(top(b, "location"), "azurerm_resource_group.secondary.location", a);
  }
  const vm2 = resources(l, "azurerm_linux_virtual_machine").find((v) => attr(v.body, "name") === '"vm-web2"');
  assert.equal(attr(vm2.body, "resource_group_name"), IN_SECONDARY);
  assert.equal(attr(vm2.body, "location"), "azurerm_resource_group.secondary.location");
  const nic2 = resources(l, "azurerm_network_interface").find((v) => attr(v.body, "name") === '"nic-vm-web2"');
  assert.equal(attr(nic2.body, "resource_group_name"), IN_SECONDARY);
  assert.equal(attr(nested(nic2.body, "ip_configuration"), "subnet_id"), `azurerm_subnet.${subnetIn(l, "ukw", "snet-web").labels[1]}.id`);
  const pip = /^azurerm_public_ip\.([a-z0-9_]+)\.id$/.exec(attr(nested(ukw.body, "frontend_ip_configuration"), "public_ip_address_id"))[1];
  assert.equal(attr(byName(l, "azurerm_public_ip", pip).body, "resource_group_name"), IN_SECONDARY);
  assert.equal(attr(byName(l, "azurerm_public_ip", pip).body, "location"), "azurerm_resource_group.secondary.location");
  for (const s of resources(l, "azurerm_subnet").filter((x) => attr(x.body, "virtual_network_name") === "azurerm_virtual_network.ukw.name")) assert.equal(attr(s.body, "resource_group_name"), IN_SECONDARY);
  for (const n of resources(l, "azurerm_network_security_group").filter((x) => /ukw/.test(attr(x.body, "name")))) assert.equal(attr(n.body, "resource_group_name"), IN_SECONDARY);
  // The plan puts the ukwest VNet in ukwest and the global load balancer's home in uksouth.
  assert.equal(planned(LB, "azurerm_virtual_network.ukw").location, "ukwest");
  assert.equal(planned(LB, `azurerm_lb.${lbs(l).global.labels[1]}`).location, "uksouth");
});

test(`${LB}: the web subnets let port 80 in from the internet, the NAT rule's range included after translation, and nothing else`, () => {
  const l = lab(LB);
  const rules = nsgRules(l);
  const internet = rules.filter((r) => ruleString(r.body, "source_address_prefix") === "Internet");
  assert.ok(internet.length >= 2, "a rule in each web subnet's NSG");
  for (const r of internet) {
    assert.equal(ruleString(r.body, "access"), "Allow");
    assert.equal(ruleString(r.body, "direction"), "Inbound");
    assert.equal(ruleString(r.body, "protocol"), "Tcp");
    // An NSG sees the packet after the load balancer translates it: 8081-8090 arrive as 80.
    assert.equal(ruleString(r.body, "destination_port_range"), "80", `${r.key}: port 80 only`);
    const nsg = byName(l, "azurerm_network_security_group", r.nsg).body;
    assert.match(attr(nsg, "name"), /^"nsg-web-/);
  }
  noInternetSsh(l);
  // Each NSG is on its subnet.
  for (const [vnet, sub] of [["uks", "snet-web"], ["ukw", "snet-web"], ["uks", "snet-nva"]]) {
    const s = subnetIn(l, vnet, sub);
    assert.ok(resources(l, "azurerm_subnet_network_security_group_association").some((a) => attr(a.body, "subnet_id") === `azurerm_subnet.${s.labels[1]}.id`), `${vnet} ${sub} has an NSG`);
  }
});

test(`${LB}: three Standard_B1s VMs, one in ukwest, each web VM serving its name and region`, () => {
  const l = lab(LB);
  const vms = resources(l, "azurerm_linux_virtual_machine");
  assert.deepEqual(vms.map((v) => attr(v.body, "name")).sort(), ['"vm-nva"', '"vm-web1"', '"vm-web2"']);
  for (const v of vms) assert.equal(attr(v.body, "size"), '"Standard_B1s"');
  assert.deepEqual(l.yaml.capacity.vm_sizes, ["Standard_B1s", "Standard_B1s", "Standard_B1s"]);
  for (const [name, region] of [["vm-web1", "var.region"], ["vm-web2", "var.secondary_region"]]) {
    const v = vms.find((x) => attr(x.body, "name") === `"${name}"`);
    assert.equal(attr(v.body, "custom_data"), `base64encode(templatefile("\${path.module}/cloud-init.yaml.tftpl", { name = "${name}", region = ${region} }))`);
  }
  const { doc } = renderCloudInit(l, "cloud-init.yaml.tftpl", { name: "vm-web1", region: "uksouth" });
  const unit = doc.write_files.find((f) => f.path === "/etc/systemd/system/lab-http.service");
  assert.match(unit.content, /^ExecStart=\/usr\/bin\/python3 -m http\.server 80 --directory \/srv\/lab$/m);
  assert.match(unit.content, /vm-web1 in uksouth/);
  assert.equal(doc.packages, undefined, "nothing to install: the web subnets have no default outbound access");
});

test(`${LB}: lab.yaml prices both regions and the readme says what the chain and the global tier do`, () => {
  const l = lab(LB);
  const y = l.yaml;
  assert.equal(y.exam, "AZ-700");
  assert.equal(y.level, "expert");
  assert.deepEqual(y.skill_areas, ["az700.delivery"]);
  assert.deepEqual(y.prerequisites, ["az104-16-lb-appgw"]);
  assert.deepEqual(y.regions, { secondary: "ukwest" });
  assert.deepEqual(y.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(y.timing, { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 4 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 56);
  // ukwest's public IP is priced there; the global IP, both IPs' meters and the VMs from the price feed.
  const secondary = y.cost.items.filter((i) => i.region === "secondary");
  assert.ok(secondary.some((i) => i.retail?.meter === "Standard IPv4 Static Public IP"), "lb-ukw's public IP, in ukwest");
  assert.ok(y.cost.items.some((i) => i.retail?.meter === "Global IPv4 Static Public IP"), "the global public IP");
  assert.ok(y.cost.items.some((i) => /Gateway Load Balancer/.test(i.name) && !i.retail), "the Gateway load balancer, authored");
  assert.ok(y.cost.items.some((i) => /chain/i.test(i.name) && !i.retail), "the chain, authored");
  const r = l.readme;
  assert.match(r, /`rg-lab-az700-40-lb-advanced-secondary`/);
  assert.match(r, /home region/i);
  assert.match(r, /VXLAN/);
  assert.match(r, /tcpdump/);
  assert.match(r, /8081/);
  assert.match(r, /after (the load balancer )?translat/i, "why the NSG allows 80 and not 8081-8090");
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.uks.id");
  for (const o of ["private_ips", "connect"]) assert.ok(outputs(l).includes(o));
});
