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

test(`${LB}: lb-uks's second frontend, on its own public IP, is chained to a Gateway load balancer whose pool has VXLAN tunnel interfaces`, () => {
  const l = lab(LB);
  const { gw, uks } = lbs(l);
  // Learn: "Gateway Load Balancer doesn't work with the Global Load Balancer tier." lb-uks has two
  // frontends: fe-uks (first, unchained) is lb-global's member; the second is chained to lb-gw.
  const fes = allNested(uks.body, "frontend_ip_configuration");
  assert.equal(fes.length, 2, "lb-uks has two frontends: one for lb-global, one chained to lb-gw");
  const [plain, chained] = fes;
  assert.equal(attr(plain, "name"), '"fe-uks"');
  assert.equal(attr(plain, "gateway_load_balancer_frontend_ip_configuration_id"), undefined, "fe-uks (lb-global's member) is never chained");
  assert.equal(attr(chained, "name"), '"fe-uks-chained"');
  assert.equal(attr(chained, "gateway_load_balancer_frontend_ip_configuration_id"), `azurerm_lb.${gw.labels[1]}.frontend_ip_configuration[0].id`);
  // Each frontend on its own Standard static public IP in rg-lab-<id>.
  const pipOf = (fe) => /^azurerm_public_ip\.([a-z0-9_]+)\.id$/.exec(attr(fe, "public_ip_address_id") ?? "")?.[1];
  assert.ok(pipOf(plain) && pipOf(chained), "both frontends have a public IP");
  assert.notEqual(pipOf(plain), pipOf(chained), "two different public IPs");
  const cpip = byName(l, "azurerm_public_ip", pipOf(chained)).body;
  assert.equal(attr(cpip, "name"), '"pip-lb-uks-chained"');
  assert.deepEqual([attr(cpip, "sku"), attr(cpip, "allocation_method"), attr(cpip, "sku_tier"), attr(cpip, "resource_group_name")], ['"Standard"', '"Static"', undefined, IN_LAB]);
  // No chained frontend anywhere is a member of lb-global's pool.
  const chainedRefs = resources(l, "azurerm_lb")
    .flatMap((x) => allNested(x.body, "frontend_ip_configuration").map((f, i) => ({ ref: `azurerm_lb.${x.labels[1]}.frontend_ip_configuration[${i}].id`, f })))
    .filter((x) => attr(x.f, "gateway_load_balancer_frontend_ip_configuration_id"))
    .map((x) => x.ref);
  assert.deepEqual(chainedRefs, [`azurerm_lb.${uks.labels[1]}.frontend_ip_configuration[1].id`]);
  for (const m of resources(l, "azurerm_lb_backend_address_pool_address")) assert.ok(!chainedRefs.includes(attr(m.body, "backend_address_ip_configuration_id")), `${m.labels[1]}: lb-global's member is not chained`);
  // Only the inbound NAT rule uses the chained frontend; the load-balancing and outbound rules use fe-uks.
  for (const r of onLb(l, "azurerm_lb_rule", uks.labels[1])) assert.equal(attr(r.body, "frontend_ip_configuration_name"), '"fe-uks"', r.labels[1]);
  for (const r of onLb(l, "azurerm_lb_outbound_rule", uks.labels[1])) assert.equal(attr(nested(r.body, "frontend_ip_configuration"), "name"), '"fe-uks"', r.labels[1]);
  // The plan fixture has both frontends.
  assert.deepEqual(planned(LB, `azurerm_lb.${uks.labels[1]}`).frontend_ip_configuration.map((f) => f.name), ["fe-uks", "fe-uks-chained"]);
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
  // On the chained frontend: curl its address on 8081 and the packets pass through vm-nva.
  assert.equal(attr(n, "frontend_ip_configuration_name"), '"fe-uks-chained"');
  assert.ok(allNested(uks.body, "frontend_ip_configuration").some((f) => attr(f, "name") === '"fe-uks-chained"'));
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
  // Four public IPs: lb-global's, lb-uks's two (fe-uks and the chained frontend) and lb-ukw's.
  assert.equal(resources(l, "azurerm_public_ip").length, 4);
  const std = y.cost.items.filter((i) => i.retail?.meter === "Standard IPv4 Static Public IP");
  assert.deepEqual(std.map((i) => [i.region ?? "primary", i.qty ?? 1]).sort(), [["primary", 2], ["secondary", 1]], "lb-uks's two IPs in uksouth, lb-ukw's in ukwest");
  assert.ok(std.some((i) => /chained/.test(i.name)), "the chained frontend's IP is named in the price list");
  const r = l.readme;
  assert.match(r, /fe-uks-chained/);
  assert.match(r, /doesn't work with the Global/, "the readme says why lb-global's member is not chained");
  assert.match(r, /`rg-lab-az700-40-lb-advanced-secondary`/);
  assert.match(r, /home region/i);
  assert.match(r, /VXLAN/);
  assert.match(r, /tcpdump/);
  assert.match(r, /8081/);
  assert.match(r, /after (the load balancer )?translat/i, "why the NSG allows 80 and not 8081-8090");
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.uks.id");
  for (const o of ["private_ips", "connect"]) assert.ok(outputs(l).includes(o));
});

// ── Lab 41: Application Gateway WAF_v2, TLS, rewrites, WAF policy ────────

const AGW = "az700-41-appgw-waf";

labContentSuite(AGW, { marker: "££" });

test(`${AGW}: WAF_v2 with autoscale 0 to 2 and only private listeners`, () => {
  const l = lab(AGW);
  const g = one(l, "azurerm_application_gateway").body;
  assert.equal(top(g, "name"), '"agw-hub"');
  assert.deepEqual([attr(nested(g, "sku"), "name"), attr(nested(g, "sku"), "tier"), attr(nested(g, "sku"), "capacity")], ['"WAF_v2"', '"WAF_v2"', undefined], "WAF_v2, no fixed capacity");
  const auto = nested(g, "autoscale_configuration");
  assert.deepEqual([attr(auto, "min_capacity"), attr(auto, "max_capacity")], ["0", "2"]);
  // In snet-agw, a /24 of its own.
  const agw = subnetIn(l, "hub", "snet-agw");
  assert.equal(attr(nested(g, "gateway_ip_configuration"), "subnet_id"), `azurerm_subnet.${agw.labels[1]}.id`);
  assert.equal(cidrOf(l, agw.body, "address_prefixes"), "cidrsubnet(cidrsubnet(var.address_space, 2, 0), 4, 0)");
  // Two frontends: the public IP Azure insists on, and a fixed private address; every listener is on the private one.
  const fes = allNested(g, "frontend_ip_configuration");
  assert.equal(fes.length, 2);
  const pub = fes.find((f) => attr(f, "public_ip_address_id"));
  const priv = fes.find((f) => attr(f, "subnet_id"));
  assert.equal(attr(pub, "public_ip_address_id"), `azurerm_public_ip.${one(l, "azurerm_public_ip").labels[1]}.id`);
  assert.equal(attr(priv, "private_ip_address_allocation"), '"Static"');
  assert.equal(attr(priv, "private_ip_address"), "local.agw_ip");
  const listeners = allNested(g, "http_listener");
  assert.equal(listeners.length, 2, "HTTP and HTTPS");
  for (const x of listeners) assert.equal(attr(x, "frontend_ip_configuration_name"), attr(priv, "name"), "every listener on the private frontend");
  assert.deepEqual(listeners.map((x) => attr(x, "protocol")).sort(), ['"Http"', '"Https"']);
  assert.equal(attr(one(l, "azurerm_public_ip").body, "sku"), '"Standard"');
  // Both web VMs in the pool, probed on / with Host 127.0.0.1.
  const pool = nested(g, "backend_address_pool");
  assert.equal(attr(pool, "ip_addresses"), "[azurerm_network_interface.web1.private_ip_address, azurerm_network_interface.web2.private_ip_address]");
  const probe = nested(g, "probe");
  assert.deepEqual([attr(probe, "protocol"), attr(probe, "path")], ['"Http"', '"/"']);
  assert.equal(attr(nested(g, "backend_http_settings"), "probe_name"), attr(probe, "name"));
  assert.equal(attr(nested(g, "ssl_policy"), "policy_name"), '"AppGwSslPolicy20220101"');
  // The subnet's NSG lets GatewayManager in on 65200-65535; the gateway will not start without it.
  const gm = nsgRules(l).find((r) => ruleString(r.body, "source_address_prefix") === "GatewayManager");
  assert.ok(gm, "a GatewayManager rule");
  assert.equal(ruleString(gm.body, "destination_port_range"), "65200-65535");
  noInternetSsh(l);
});

test(`${AGW}: the HTTPS listener's certificate is the vault's self-signed certificate read by the gateway's identity through an access policy`, () => {
  const l = lab(AGW);
  const g = one(l, "azurerm_application_gateway").body;
  const uai = one(l, "azurerm_user_assigned_identity");
  assert.equal(attr(uai.body, "name"), '"id-${var.name_prefix}-agw"');
  const id = nested(g, "identity");
  assert.equal(attr(id, "type"), '"UserAssigned"');
  assert.equal(attr(id, "identity_ids"), `[azurerm_user_assigned_identity.${uai.labels[1]}.id]`);
  const cert = one(l, "azurerm_key_vault_certificate");
  const ssl = nested(g, "ssl_certificate");
  assert.equal(attr(ssl, "key_vault_secret_id"), `azurerm_key_vault_certificate.${cert.labels[1]}.versionless_secret_id`, "versionless: a renewed certificate is picked up");
  assert.equal(attr(ssl, "data"), undefined, "no certificate in the state or the plan");
  const https = allNested(g, "http_listener").find((x) => attr(x, "protocol") === '"Https"');
  assert.equal(attr(https, "ssl_certificate_name"), attr(ssl, "name"));
  // Self-signed, CN=app.lab41.internal, 12 months, in the lab's vault.
  const c = cert.body;
  const vault = one(l, "azurerm_key_vault");
  assert.equal(attr(c, "key_vault_id"), `azurerm_key_vault.${vault.labels[1]}.id`);
  assert.equal(attr(nested(c, "issuer_parameters"), "name"), '"Self"');
  const x509 = nested(c, "x509_certificate_properties");
  assert.equal(attr(x509, "subject"), '"CN=app.lab41.internal"');
  assert.equal(attr(x509, "validity_in_months"), "12");
  assert.deepEqual(strings(attr(nested(x509, "subject_alternative_names"), "dns_names")), ["app.lab41.internal"]);
  assert.equal(attr(nested(c, "secret_properties"), "content_type"), '"application/x-pkcs12"');
  // Access policies, not RBAC (no role assignment: the allow-list has no Certificates Officer).
  assert.equal(attr(vault.body, "rbac_authorization_enabled"), "false");
  assert.equal(attr(vault.body, "tenant_id"), "data.azurerm_client_config.current.tenant_id");
  assert.equal(resources(l, "azurerm_role_assignment").length, 0);
  const policies = resources(l, "azurerm_key_vault_access_policy");
  assert.equal(policies.length, 2, "the pipeline's and the gateway's");
  for (const p of policies) {
    assert.equal(attr(p.body, "key_vault_id"), `azurerm_key_vault.${vault.labels[1]}.id`);
    assert.equal(attr(p.body, "tenant_id"), "data.azurerm_client_config.current.tenant_id");
  }
  const pipeline = policies.find((p) => attr(p.body, "object_id") === "data.azurerm_client_config.current.object_id");
  assert.ok(pipeline, "one for the pipeline (client config)");
  assert.deepEqual(strings(attr(pipeline.body, "certificate_permissions")).sort(), ["Create", "Delete", "Get", "List", "Purge"]);
  assert.deepEqual(strings(attr(pipeline.body, "secret_permissions")), ["Get"]);
  assert.equal(attr(pipeline.body, "key_permissions"), undefined);
  const gateway = policies.find((p) => attr(p.body, "object_id") === `azurerm_user_assigned_identity.${uai.labels[1]}.principal_id`);
  assert.ok(gateway, "one for the gateway's identity");
  assert.deepEqual(strings(attr(gateway.body, "secret_permissions")), ["Get"], "the gateway reads the certificate as a secret, nothing more");
  assert.equal(attr(gateway.body, "certificate_permissions"), undefined);
  // The certificate waits for the pipeline's policy, the gateway for its own.
  assert.match(c.replace(/\s+/g, " "), new RegExp(`depends_on = \\[ ?azurerm_key_vault_access_policy\\.${pipeline.labels[1]},? ?\\]`));
  assert.match(g.replace(/\s+/g, " "), new RegExp(`depends_on = \\[[^\\]]*azurerm_key_vault_access_policy\\.${gateway.labels[1]}`));
});

test(`${AGW}: HTTP redirects to HTTPS and a rewrite set adds and removes headers`, () => {
  const l = lab(AGW);
  const g = one(l, "azurerm_application_gateway").body;
  const listeners = allNested(g, "http_listener");
  const http = listeners.find((x) => attr(x, "protocol") === '"Http"');
  const https = listeners.find((x) => attr(x, "protocol") === '"Https"');
  const ports = Object.fromEntries(allNested(g, "frontend_port").map((p) => [attr(p, "name"), attr(p, "port")]));
  assert.equal(ports[attr(http, "frontend_port_name")], "80");
  assert.equal(ports[attr(https, "frontend_port_name")], "443");
  const redirect = nested(g, "redirect_configuration");
  assert.equal(attr(redirect, "redirect_type"), '"Permanent"');
  assert.equal(attr(redirect, "target_listener_name"), attr(https, "name"));
  assert.equal(attr(redirect, "include_path"), "true");
  assert.equal(attr(redirect, "include_query_string"), "true");
  const rules = allNested(g, "request_routing_rule");
  assert.equal(rules.length, 2);
  const toRedirect = rules.find((r) => attr(r, "http_listener_name") === attr(http, "name"));
  assert.equal(attr(toRedirect, "redirect_configuration_name"), attr(redirect, "name"));
  assert.equal(attr(toRedirect, "backend_address_pool_name"), undefined);
  const toPool = rules.find((r) => attr(r, "http_listener_name") === attr(https, "name"));
  assert.equal(attr(toPool, "backend_address_pool_name"), attr(nested(g, "backend_address_pool"), "name"));
  const rw = nested(g, "rewrite_rule_set");
  assert.equal(attr(toPool, "rewrite_rule_set_name"), attr(rw, "name"));
  const headers = allNested(rw, "response_header_configuration").map((h) => [attr(h, "header_name"), attr(h, "header_value")]);
  assert.deepEqual(headers, [['"X-Lab"', '"41"'], ['"Server"', '""']], "adds X-Lab: 41, removes Server (an empty value deletes it)");
});

test(`${AGW}: a Prevention WAF policy with DRS 2.1 and one custom rule`, () => {
  const l = lab(AGW);
  const g = one(l, "azurerm_application_gateway").body;
  const waf = one(l, "azurerm_web_application_firewall_policy");
  assert.equal(top(g, "firewall_policy_id"), `azurerm_web_application_firewall_policy.${waf.labels[1]}.id`);
  assert.equal(nested(g, "waf_configuration"), undefined, "the policy, not the old inline configuration");
  const w = waf.body;
  assert.equal(top(w, "resource_group_name"), IN_LAB);
  const ps = nested(w, "policy_settings");
  assert.deepEqual([attr(ps, "enabled"), attr(ps, "mode")], ["true", '"Prevention"']);
  const sets = allNested(nested(w, "managed_rules"), "managed_rule_set").map((s) => [attr(s, "type"), attr(s, "version")]);
  assert.deepEqual(sets, [['"Microsoft_DefaultRuleSet"', '"2.1"']]);
  const custom = allNested(w, "custom_rules");
  assert.equal(custom.length, 1, "one custom rule");
  const c = custom[0];
  assert.deepEqual([attr(c, "rule_type"), attr(c, "action")], ['"MatchRule"', '"Block"']);
  assert.match(attr(c, "name"), /^"[A-Za-z][A-Za-z0-9]*"$/, "letters and digits only");
  const m = nested(c, "match_conditions");
  assert.equal(attr(nested(m, "match_variables"), "variable_name"), '"QueryString"');
  assert.equal(attr(m, "operator"), '"Contains"');
  assert.deepEqual(strings(attr(m, "match_values")), ["attack=1"]);
});

test(`${AGW}: the vault has no purge protection and versions.tf purges it on destroy`, () => {
  const l = lab(AGW);
  const v = one(l, "azurerm_key_vault").body;
  assert.equal(attr(v, "name"), '"${var.name_prefix}kv"');
  assert.equal(attr(v, "sku_name"), '"standard"');
  assert.equal(attr(v, "purge_protection_enabled"), "false");
  assert.equal(attr(v, "soft_delete_retention_days"), "7");
  assert.equal(attr(v, "access_policy"), undefined, "policies as their own resources, never inline as well");
  const kv = nested(features(l), "key_vault");
  assert.equal(attr(kv, "purge_soft_delete_on_destroy"), "true");
  assert.equal(attr(kv, "recover_soft_deleted_key_vaults"), "false");
  assert.equal(attr(kv, "recover_soft_deleted_certificates"), "false");
  assert.equal(attr(nested(features(l), "resource_group"), "prevent_deletion_if_contains_resources"), "false");
});

test(`${AGW}: app.lab41.internal is the private frontend, in a zone linked to vnet-hub, with dns_link on`, () => {
  const l = lab(AGW);
  const zone = one(l, "azurerm_private_dns_zone");
  assert.equal(attr(zone.body, "name"), '"lab41.internal"');
  const a = one(l, "azurerm_private_dns_a_record").body;
  assert.equal(attr(a, "name"), '"app"');
  assert.equal(attr(a, "records"), "[local.agw_ip]");
  const link = one(l, "azurerm_private_dns_zone_virtual_network_link").body;
  assert.equal(attr(link, "virtual_network_id"), "azurerm_virtual_network.hub.id");
  assert.equal(attr(link, "registration_enabled"), "false");
  assert.equal(l.yaml.connectivity.dns_link, true, "the pipeline links lab41.internal to the gateway VNet while peered");
  assert.doesNotMatch(code(l), /gateway_vnet_id|vnet-wg|rg-wg/);
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.hub.id");
});

test(`${AGW}: the gateway's access and firewall logs go to a capped workspace in resource-specific tables`, () => {
  const l = lab(AGW);
  const ws = one(l, "azurerm_log_analytics_workspace").body;
  assert.equal(attr(ws, "sku"), '"PerGB2018"');
  assert.equal(attr(ws, "daily_quota_gb"), "0.05");
  const d = one(l, "azurerm_monitor_diagnostic_setting").body;
  assert.equal(attr(d, "target_resource_id"), `azurerm_application_gateway.${one(l, "azurerm_application_gateway").labels[1]}.id`);
  assert.equal(attr(d, "log_analytics_workspace_id"), `azurerm_log_analytics_workspace.${one(l, "azurerm_log_analytics_workspace").labels[1]}.id`);
  assert.equal(attr(d, "log_analytics_destination_type"), '"Dedicated"', "AGWAccessLogs and AGWFirewallLogs");
  assert.deepEqual(allNested(d, "enabled_log").map((e) => attr(e, "category")).sort(), ['"ApplicationGatewayAccessLog"', '"ApplicationGatewayFirewallLog"']);
  assert.match(l.readme, /AGWFirewallLogs/);
});

test(`${AGW}: two web VMs, lab.yaml as planned and a readme that blocks an attack`, () => {
  const l = lab(AGW);
  const y = l.yaml;
  assert.deepEqual(resources(l, "azurerm_linux_virtual_machine").map((v) => attr(v.body, "name")).sort(), ['"vm-web1"', '"vm-web2"']);
  assert.equal(attr(subnetIn(l, "hub", "snet-web").body, "default_outbound_access_enabled"), "false", "nothing to install");
  assert.equal(attr(subnetIn(l, "hub", "snet-agw").body, "default_outbound_access_enabled"), "true", "the gateway reaches the vault");
  assert.deepEqual([y.exam, y.level, y.type], ["AZ-700", "associate", "explore"]);
  assert.deepEqual(y.skill_areas, ["az700.delivery", "az700.security"]);
  assert.deepEqual(y.prerequisites, ["az104-16-lb-appgw"]);
  assert.deepEqual(y.connectivity, { peering: "optional", dns_link: true, subnets_used: 1 });
  assert.deepEqual(y.timing, { deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 3 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 64);
  // WAF v2's meters share their names with Standard v2 and Application Gateway for Containers: authored (ruling 54).
  for (const n of [/WAF_v2, fixed/, /WAF_v2, capacity unit/]) {
    const i = y.cost.items.find((x) => n.test(x.name));
    assert.ok(i, String(n));
    assert.equal(i.retail, undefined);
  }
  assert.equal(y.cost.pricey, "Application Gateway WAF_v2, fixed");
  const r = l.readme;
  assert.match(r, /403/);
  assert.match(r, /Detection/);
  assert.match(r, /app\.lab41\.internal/);
  assert.match(r, /access polic/i);
});

// ── Lab 42: Front Door Premium, rules, caching, WAF, Private Link origin ─

const AFD = "az700-42-frontdoor-private";

labContentSuite(AFD, { marker: "££" });

test(`${AFD}: a Premium profile whose origin uses Private Link to the lab's Private Link service`, () => {
  const l = lab(AFD);
  const p = one(l, "azurerm_cdn_frontdoor_profile");
  assert.equal(attr(p.body, "sku_name"), '"Premium_AzureFrontDoor"', "Private Link origins need Premium");
  assert.equal(attr(p.body, "resource_group_name"), IN_LAB);
  const pls = one(l, "azurerm_private_link_service");
  const o = one(l, "azurerm_cdn_frontdoor_origin").body;
  const pl = nested(o, "private_link");
  assert.ok(pl, "the origin has a private_link block");
  assert.equal(attr(pl, "private_link_target_id"), `azurerm_private_link_service.${pls.labels[1]}.id`);
  assert.equal(attr(pl, "location"), "var.region");
  assert.ok(attr(pl, "request_message"), "a request message the approver reads");
  assert.equal(attr(pl, "target_type"), undefined, "no target_type for a Private Link service (a load balancer origin)");
  // The origin is the internal load balancer's private address, over HTTP.
  assert.equal(attr(o, "host_name"), "local.lb_ip");
  assert.equal(attr(o, "origin_host_header"), "local.lb_ip");
  assert.equal(attr(o, "http_port"), "80");
  // The Private Link service fronts lb-int, NATs into snet-pls, and is never auto-approved (ruling 51).
  const s = pls.body;
  assert.equal(attr(s, "load_balancer_frontend_ip_configuration_ids"), `[azurerm_lb.${one(l, "azurerm_lb").labels[1]}.frontend_ip_configuration[0].id]`);
  assert.equal(attr(nested(s, "nat_ip_configuration"), "subnet_id"), `azurerm_subnet.${subnetIn(l, "app", "snet-pls").labels[1]}.id`);
  assert.equal(attr(s, "auto_approval_subscription_ids"), undefined, "Front Door's connection waits for a person to approve it");
  assert.equal(attr(s, "visibility_subscription_ids"), undefined);
  assert.equal(attr(subnetIn(l, "app", "snet-pls").body, "private_link_service_network_policies_enabled"), "false");
  // lb-int: internal, Standard, a rule and probe on 80 over vm-web.
  const lb = one(l, "azurerm_lb").body;
  assert.equal(attr(lb, "sku"), '"Standard"');
  assert.equal(attr(nested(lb, "frontend_ip_configuration"), "subnet_id"), `azurerm_subnet.${subnetIn(l, "app", "snet-web").labels[1]}.id`);
  assert.equal(attr(nested(lb, "frontend_ip_configuration"), "private_ip_address"), "local.lb_ip");
  assert.equal(attr(nested(lb, "frontend_ip_configuration"), "public_ip_address_id"), undefined);
  assert.equal(resources(l, "azurerm_public_ip").length, 0, "no public IP anywhere: Front Door is the only way in");
  assert.deepEqual([attr(one(l, "azurerm_lb_rule").body, "frontend_port"), attr(one(l, "azurerm_lb_rule").body, "backend_port")], ["80", "80"]);
  // The origin group probes over HTTP every 100 seconds; the route forwards HTTP only, HTTPS redirect on, cached and compressed.
  const og = one(l, "azurerm_cdn_frontdoor_origin_group").body;
  assert.deepEqual([attr(nested(og, "health_probe"), "protocol"), attr(nested(og, "health_probe"), "path"), attr(nested(og, "health_probe"), "interval_in_seconds")], ['"Http"', '"/"', "100"]);
  const route = one(l, "azurerm_cdn_frontdoor_route").body;
  assert.deepEqual(strings(attr(route, "patterns_to_match")), ["/*"]);
  assert.equal(attr(route, "https_redirect_enabled"), "true");
  assert.equal(attr(route, "forwarding_protocol"), '"HttpOnly"');
  const cache = nested(route, "cache");
  assert.ok(cache, "caching on");
  assert.equal(attr(cache, "compression_enabled"), "true");
  noInternetSsh(l);
});

test(`${AFD}: a rule set with a redirect, a header and a cache override`, () => {
  const l = lab(AFD);
  const rs = one(l, "azurerm_cdn_frontdoor_rule_set");
  assert.match(attr(rs.body, "name"), /^"[A-Za-z][A-Za-z0-9]*"$/, "letters and digits only");
  const route = one(l, "azurerm_cdn_frontdoor_route").body;
  assert.equal(attr(route, "cdn_frontdoor_rule_set_ids"), `[azurerm_cdn_frontdoor_rule_set.${rs.labels[1]}.id]`);
  const rules = resources(l, "azurerm_cdn_frontdoor_rule");
  assert.equal(rules.length, 3);
  for (const r of rules) {
    assert.equal(attr(r.body, "cdn_frontdoor_rule_set_id"), `azurerm_cdn_frontdoor_rule_set.${rs.labels[1]}.id`);
    assert.match(attr(r.body, "name"), /^"[A-Za-z][A-Za-z0-9]*"$/);
  }
  const redirect = rules.find((r) => nested(r.body, "url_redirect_action"));
  assert.ok(redirect, "a redirect rule");
  assert.deepEqual(strings(attr(nested(redirect.body, "url_path_condition"), "match_values")), ["old"]);
  assert.equal(attr(nested(redirect.body, "url_redirect_action"), "destination_path"), '"/"');
  const header = rules.find((r) => nested(r.body, "response_header_action"));
  assert.ok(header, "a response header rule");
  const h = nested(header.body, "response_header_action");
  assert.deepEqual([attr(h, "header_name"), attr(h, "value")], ['"X-Lab"', '"42"']);
  const cache = rules.find((r) => nested(r.body, "route_configuration_override_action"));
  assert.ok(cache, "a cache override rule");
  assert.deepEqual(strings(attr(nested(cache.body, "url_path_condition"), "match_values")), ["static/"]);
  assert.equal(attr(nested(cache.body, "route_configuration_override_action"), "cache_behavior"), '"OverrideAlways"');
  assert.deepEqual(rules.map((r) => Number(attr(r.body, "order"))).sort(), [1, 2, 3]);
});

test(`${AFD}: a Premium WAF policy in Prevention with managed rule sets, attached by a security policy`, () => {
  const l = lab(AFD);
  const w = one(l, "azurerm_cdn_frontdoor_firewall_policy");
  const b = w.body;
  assert.equal(attr(b, "sku_name"), '"Premium_AzureFrontDoor"');
  assert.equal(attr(b, "mode"), '"Prevention"');
  assert.equal(attr(b, "enabled"), "true");
  assert.match(attr(b, "name"), /^"[A-Za-z][A-Za-z0-9]*"$/);
  const managed = Object.fromEntries(allNested(b, "managed_rule").map((m) => [attr(m, "type"), attr(m, "version")]));
  assert.deepEqual(managed, { '"Microsoft_DefaultRuleSet"': '"2.1"', '"Microsoft_BotManagerRuleSet"': '"1.1"' });
  const custom = allNested(b, "custom_rule");
  assert.equal(custom.length, 1);
  assert.equal(attr(custom[0], "type"), '"RateLimitRule"');
  assert.equal(attr(custom[0], "action"), '"Block"');
  assert.ok(Number(attr(custom[0], "rate_limit_threshold")) > 0);
  const sp = one(l, "azurerm_cdn_frontdoor_security_policy").body;
  assert.equal(attr(sp, "cdn_frontdoor_profile_id"), `azurerm_cdn_frontdoor_profile.${one(l, "azurerm_cdn_frontdoor_profile").labels[1]}.id`);
  assert.equal(attr(nested(sp, "firewall"), "cdn_frontdoor_firewall_policy_id"), `azurerm_cdn_frontdoor_firewall_policy.${w.labels[1]}.id`);
  assert.equal(attr(nested(sp, "domain"), "cdn_frontdoor_domain_id"), `azurerm_cdn_frontdoor_endpoint.${one(l, "azurerm_cdn_frontdoor_endpoint").labels[1]}.id`);
  assert.deepEqual(strings(attr(nested(sp, "association"), "patterns_to_match")), ["/*"]);
});

test(`${AFD}: the readme's first Things to try approves the connection`, () => {
  const l = lab(AFD);
  const tries = l.readme.split("## Things to try")[1].split(/\n## /)[0];
  const first = tries.split("\n").find((x) => x.startsWith("- "));
  assert.match(first, /approve/i);
  assert.match(first, /pls-web/);
  assert.match(first, /502/);
  assert.match(l.readme, /x-cache/i);
  assert.match(l.readme, /each hour, or part(ial)? hour/i, "the base fee is billed per hour (Learn, Front Door billing)");
  assert.match(l.readme, /about 15 minutes/, "the deploy time");
  // Ruling 51: the pipeline never approves; nothing in the Terraform does either.
  for (const r of resources(l)) assert.doesNotMatch(r.body, /is_manual_connection|approv/i, r.labels.join("."));
});

test(`${AFD}: lab.yaml as planned, peering off, the base fee authored per hour`, () => {
  const l = lab(AFD);
  const y = l.yaml;
  assert.deepEqual(y.skill_areas, ["az700.delivery", "az700.security", "az700.private"]);
  assert.equal(y.level, "expert");
  assert.deepEqual(y.prerequisites, ["az305-27-multi-region"]);
  assert.deepEqual(y.connectivity, { peering: "off", dns_link: false, subnets_used: 1 });
  assert.deepEqual(y.timing, { deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 74);
  const base = y.cost.items.find((i) => /Front Door Premium, base fee/.test(i.name));
  assert.ok(base);
  assert.equal(base.gbp_h, 0.3412, "£249.066 a month / 730");
  assert.equal(base.retail, undefined, "priced under Zone 1, no uksouth row");
  assert.equal(y.cost.pricey, base.name);
  assert.ok(!outputs(l).includes("peer_vnet_id"));
  assert.equal(attr(subnetIn(l, "app", "snet-web").body, "default_outbound_access_enabled"), "false");
  assert.equal(attr(subnetIn(l, "app", "snet-pls").body, "default_outbound_access_enabled"), "false");
});

// ── Lab 43: Private Link service, private endpoints, service endpoint policies ──

const PL = "az700-43-private-link";

labContentSuite(PL, { marker: "££" });

/** Lab 43's private endpoints by what they reach: { svc, blob }. */
function endpoints(l) {
  const pes = resources(l, "azurerm_private_endpoint");
  assert.equal(pes.length, 2, "two private endpoints");
  const svc = pes.find((p) => /azurerm_private_link_service\./.test(attr(nested(p.body, "private_service_connection"), "private_connection_resource_id") ?? ""));
  const blob = pes.find((p) => /azurerm_storage_account\./.test(attr(nested(p.body, "private_service_connection"), "private_connection_resource_id") ?? ""));
  assert.ok(svc && blob, "one to the Private Link service and one to a storage account");
  return { svc, blob };
}

test(`${PL}: a Private Link service auto-approving only the current subscription`, () => {
  const l = lab(PL);
  const pls = one(l, "azurerm_private_link_service");
  const s = pls.body;
  assert.equal(attr(s, "name"), '"pls-svc"');
  // Ruling 51: the subscription id (a GUID, never a path) from the subscription the pipeline signs in to.
  const sub = l.blocks.find((b) => b.kind === "data" && b.labels[0] === "azurerm_subscription");
  assert.ok(sub, 'data "azurerm_subscription"');
  assert.equal(sub.body.trim(), "", "no subscription_id: always the current subscription");
  const current = `[data.azurerm_subscription.${sub.labels[1]}.subscription_id]`;
  assert.equal(attr(s, "auto_approval_subscription_ids"), current);
  assert.equal(attr(s, "visibility_subscription_ids"), current);
  assert.equal(attr(s, "load_balancer_frontend_ip_configuration_ids"), `[azurerm_lb.${one(l, "azurerm_lb").labels[1]}.frontend_ip_configuration[0].id]`);
  const pls_subnet = subnetIn(l, "provider", "snet-pls");
  assert.equal(attr(nested(s, "nat_ip_configuration"), "subnet_id"), `azurerm_subnet.${pls_subnet.labels[1]}.id`);
  assert.equal(attr(pls_subnet.body, "private_link_service_network_policies_enabled"), "false");
  // The provider's load balancer is internal, in snet-svc, over vm-svc.
  const lb = one(l, "azurerm_lb").body;
  assert.equal(attr(nested(lb, "frontend_ip_configuration"), "subnet_id"), `azurerm_subnet.${subnetIn(l, "provider", "snet-svc").labels[1]}.id`);
  assert.equal(attr(nested(lb, "frontend_ip_configuration"), "public_ip_address_id"), undefined);
  assert.equal(resources(l, "azurerm_public_ip").length, 0);
  // The consumer's endpoint to it, automatic (no manual approval), in snet-pe.
  const { svc } = endpoints(l);
  const psc = nested(svc.body, "private_service_connection");
  assert.equal(attr(psc, "private_connection_resource_id"), `azurerm_private_link_service.${pls.labels[1]}.id`);
  assert.equal(attr(psc, "is_manual_connection"), "false");
  assert.equal(attr(psc, "subresource_names"), undefined, "a Private Link service has no sub-resources");
  assert.equal(attr(svc.body, "subnet_id"), `azurerm_subnet.${subnetIn(l, "consumer", "snet-pe").labels[1]}.id`);
  noInternetSsh(l);
});

test(`${PL}: a blob private endpoint with its privatelink zone group on the consumer VNet`, () => {
  const l = lab(PL);
  const { blob } = endpoints(l);
  const st = byName(l, "azurerm_storage_account", "st");
  assert.equal(attr(st.body, "name"), '"${var.name_prefix}st"');
  const psc = nested(blob.body, "private_service_connection");
  assert.equal(attr(psc, "private_connection_resource_id"), "azurerm_storage_account.st.id");
  assert.deepEqual(strings(attr(psc, "subresource_names")), ["blob"]);
  assert.equal(attr(psc, "is_manual_connection"), "false");
  assert.equal(attr(blob.body, "subnet_id"), `azurerm_subnet.${subnetIn(l, "consumer", "snet-pe").labels[1]}.id`);
  const zone = one(l, "azurerm_private_dns_zone");
  assert.equal(attr(zone.body, "name"), '"privatelink.blob.core.windows.net"');
  assert.equal(attr(nested(blob.body, "private_dns_zone_group"), "private_dns_zone_ids"), `[azurerm_private_dns_zone.${zone.labels[1]}.id]`);
  const link = one(l, "azurerm_private_dns_zone_virtual_network_link").body;
  assert.equal(attr(link, "virtual_network_id"), "azurerm_virtual_network.consumer.id");
  assert.equal(attr(link, "registration_enabled"), "false");
  assert.equal(l.yaml.connectivity.dns_link, true, "the pipeline links the zone to the gateway VNet while peered");
  assert.doesNotMatch(code(l), /gateway_vnet_id|vnet-wg|rg-wg/);
  // Both accounts: StorageV2 LRS, nothing public, containers through the management plane only.
  for (const sa of resources(l, "azurerm_storage_account")) {
    assert.deepEqual([attr(sa.body, "account_kind"), attr(sa.body, "account_tier"), attr(sa.body, "account_replication_type")], ['"StorageV2"', '"Standard"', '"LRS"']);
    assert.equal(attr(sa.body, "allow_nested_items_to_be_public"), "false");
  }
  for (const c of resources(l, "azurerm_storage_container")) {
    assert.match(attr(c.body, "storage_account_id") ?? "", /^azurerm_storage_account\.[a-z]+\.id$/, "storage_account_id: the management plane, no data-plane call from the pipeline");
    assert.equal(attr(c.body, "container_access_type"), '"private"');
  }
});

test(`${PL}: a service endpoint policy that allows only the lab's first account, on the client subnet with the storage service endpoint`, () => {
  const l = lab(PL);
  const policy = one(l, "azurerm_subnet_service_endpoint_storage_policy");
  const defs = allNested(policy.body, "definition");
  assert.equal(defs.length, 1);
  assert.equal(attr(defs[0], "service"), '"Microsoft.Storage"');
  assert.equal(attr(defs[0], "service_resources"), "[azurerm_storage_account.st.id]", "only ${prefix}st, never ${prefix}other");
  assert.equal(attr(byName(l, "azurerm_storage_account", "other").body, "name"), '"${var.name_prefix}other"');
  const client = subnetIn(l, "consumer", "snet-client");
  assert.deepEqual(strings(attr(client.body, "service_endpoints")), ["Microsoft.Storage"]);
  assert.equal(attr(client.body, "service_endpoint_policy_ids"), `[azurerm_subnet_service_endpoint_storage_policy.${policy.labels[1]}.id]`);
  assert.equal(attr(client.body, "default_outbound_access_enabled"), "true", "vm-client reaches the storage service endpoints");
  const vmc = resources(l, "azurerm_network_interface").find((n) => attr(n.body, "name") === '"nic-vm-client"');
  assert.equal(attr(nested(vmc.body, "ip_configuration"), "subnet_id"), `azurerm_subnet.${client.labels[1]}.id`);
  // Both accounts in the session's region: a policy applies to accounts in its own region.
  for (const sa of resources(l, "azurerm_storage_account")) assert.equal(attr(sa.body, "location"), "azurerm_resource_group.lab.location");
});

test(`${PL}: the two VNets are not peered`, () => {
  const l = lab(PL);
  const vnets = Object.fromEntries(resources(l, "azurerm_virtual_network").map((v) => [v.labels[1], v.body]));
  assert.deepEqual(Object.keys(vnets).sort(), ["consumer", "provider"]);
  assert.equal(cidrOf(l, vnets.provider, "address_space"), "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(cidrOf(l, vnets.consumer, "address_space"), "cidrsubnet(var.address_space, 2, 1)");
  assert.equal(resources(l, "azurerm_virtual_network_peering").length, 0, "no peering: the consumer reaches the provider only through Private Link");
  for (const [vnet, name, n] of [["provider", "snet-svc", 0], ["provider", "snet-pls", 1], ["consumer", "snet-pe", 0], ["consumer", "snet-client", 1]]) {
    assert.equal(cidrOf(l, subnetIn(l, vnet, name).body, "address_prefixes"), `cidrsubnet(cidrsubnet(var.address_space, 2, ${vnet === "provider" ? 0 : 1}), 4, ${n})`, `${vnet} ${name}`);
  }
  // The pipeline peers the consumer to the gateway: from the tunnel, the endpoints are what you reach.
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.consumer.id");
});

test(`${PL}: lab.yaml as planned and a readme that compares the two kinds of endpoint`, () => {
  const l = lab(PL);
  const y = l.yaml;
  assert.deepEqual(y.skill_areas, ["az700.private", "az305.infra", "az305.data"]);
  assert.deepEqual([y.level, y.type], ["associate", "explore"]);
  assert.deepEqual(y.prerequisites, ["az104-06-blob-security"]);
  assert.deepEqual(y.connectivity, { peering: "optional", dns_link: true, subnets_used: 2 });
  assert.deepEqual(y.timing, { deploy_min: 8, destroy_min: 6, session_h: 2, max_h: 4 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 48);
  assert.equal(y.cost.items.filter((i) => /Private endpoint/.test(i.name)).reduce((n, i) => n + (i.qty ?? 1), 0), 2);
  const r = l.readme;
  assert.match(r, /service endpoint polic/i);
  assert.match(r, /[Rr]eject/);
  assert.match(r, /NAT/);
  assert.match(r, /lab 6/i, "the zone name lab 6 links too");
});

// ── Lab 44: VNet flow logs, IP flow verify and Bastion ───────────────────

const FL = "az700-44-flow-logs-bastion";

labContentSuite(FL, { marker: "££" });

/** An NSG's rules by name: { "<rule name>": body }. */
const rulesOf = (l, nsgKey) => Object.fromEntries(nsgRules(l).filter((r) => r.nsg === nsgKey).map((r) => [ruleString(r.body, "name"), r.body]));
/** A rule's essentials: [direction, access, protocol, source, destination, ports], ports as a sorted list. */
const essentials = (b) => [
  ruleString(b, "direction"),
  ruleString(b, "access"),
  ruleString(b, "protocol"),
  ruleString(b, "source_address_prefix"),
  ruleString(b, "destination_address_prefix"),
  (attr(b, "destination_port_ranges") ? strings(attr(b, "destination_port_ranges")) : [ruleString(b, "destination_port_range")]).sort().join(","),
];

test(`${FL}: a Basic Bastion with the documented AzureBastionSubnet NSG rules`, () => {
  const l = lab(FL);
  const b = one(l, "azurerm_bastion_host").body;
  assert.equal(attr(b, "sku"), '"Basic"', "Basic: the exam's subnet and NSG; Developer needs neither");
  const sn = subnetIn(l, "hub", "AzureBastionSubnet");
  assert.equal(cidrOf(l, sn.body, "address_prefixes"), "cidrsubnet(cidrsubnet(var.address_space, 2, 0), 6, 0)", "a /26, the smallest Bastion takes");
  const ipc = nested(b, "ip_configuration");
  assert.equal(attr(ipc, "subnet_id"), `azurerm_subnet.${sn.labels[1]}.id`);
  const pip = /^azurerm_public_ip\.([a-z0-9_]+)\.id$/.exec(attr(ipc, "public_ip_address_id"))[1];
  assert.deepEqual([attr(byName(l, "azurerm_public_ip", pip).body, "sku"), attr(byName(l, "azurerm_public_ip", pip).body, "allocation_method")], ['"Standard"', '"Static"']);
  // Learn, "Working with NSG access and Azure Bastion": the inbound and outbound rules the subnet needs.
  const assoc = resources(l, "azurerm_subnet_network_security_group_association").find((a) => attr(a.body, "subnet_id") === `azurerm_subnet.${sn.labels[1]}.id`);
  assert.ok(assoc, "AzureBastionSubnet has an NSG");
  const nsgKey = /^azurerm_network_security_group\.([a-z0-9_]+)\.id$/.exec(attr(assoc.body, "network_security_group_id"))[1];
  const got = Object.values(rulesOf(l, nsgKey)).map(essentials).map((x) => x.join(" ")).sort();
  const want = [
    ["Inbound", "Allow", "Tcp", "Internet", "*", "443"],
    ["Inbound", "Allow", "Tcp", "GatewayManager", "*", "443"],
    ["Inbound", "Allow", "Tcp", "AzureLoadBalancer", "*", "443"],
    ["Inbound", "Allow", "*", "VirtualNetwork", "VirtualNetwork", "5701,8080"],
    ["Outbound", "Allow", "*", "*", "VirtualNetwork", "22,3389"],
    ["Outbound", "Allow", "Tcp", "*", "AzureCloud", "443"],
    ["Outbound", "Allow", "*", "VirtualNetwork", "VirtualNetwork", "5701,8080"],
    ["Outbound", "Allow", "*", "*", "Internet", "80"],
  ]
    .map((x) => x.join(" "))
    .sort();
  assert.deepEqual(got, want);
  // The rules exist before Bastion is made, or Azure refuses it.
  assert.match(b.replace(/\s+/g, " "), new RegExp(`depends_on = \\[[^\\]]*azurerm_subnet_network_security_group_association\\.${assoc.labels[1]}`));
  noInternetSsh(l);
});

test(`${FL}: SSH reaches the VMs only from the Bastion subnet, web may reach app on 80 and app may not reach web`, () => {
  const l = lab(FL);
  const bastion = "local.bastion_cidr";
  for (const [key, vm] of [["web", "vm-web"], ["app", "vm-app"]]) {
    const r = rulesOf(l, key);
    const ssh = Object.values(r).filter((b) => ruleString(b, "access") === "Allow" && portsInclude(attr(b, "destination_port_range") ?? '"*"', 22));
    assert.equal(ssh.length, 1, `${vm}: one rule allows 22`);
    assert.equal(attr(ssh[0], "source_address_prefix"), bastion, `${vm}: 22 from the Bastion subnet only`);
    const denySsh = Object.values(r).find((b) => ruleString(b, "access") === "Deny" && ruleString(b, "source_address_prefix") === "VirtualNetwork");
    assert.ok(denySsh, `${vm}: a deny from the rest of the VNet`);
    assert.ok(Number(attr(denySsh, "priority")) > Number(attr(ssh[0], "priority")));
  }
  const app = rulesOf(l, "app");
  const http = Object.values(app).find((b) => ruleString(b, "access") === "Allow" && ruleString(b, "destination_port_range") === "80");
  assert.equal(attr(http, "source_address_prefix"), "local.web_cidr", "web -> app 80 allowed");
  const web = rulesOf(l, "web");
  const fromApp = Object.values(web).find((b) => ruleString(b, "access") === "Deny" && attr(b, "source_address_prefix") === "local.app_cidr");
  assert.ok(fromApp, "app -> web denied");
  // The Network Watcher agent on both VMs, for IP flow verify's cousins (packet capture, connection troubleshoot).
  const ext = resources(l, "azurerm_virtual_machine_extension").filter((e) => attr(e.body, "type") === '"NetworkWatcherAgentLinux"');
  assert.deepEqual(ext.map((e) => attr(e.body, "virtual_machine_id")).sort(), ["azurerm_linux_virtual_machine.app.id", "azurerm_linux_virtual_machine.web.id"]);
  assert.equal(resources(l, "azurerm_network_watcher").length, 0, "never a Network Watcher of its own: one per region already exists");
});

test(`${FL}: the flow log is in NetworkWatcherRG on NetworkWatcher_<region>, named lab-<id>-, targeting the lab VNet and storing in the lab's account`, () => {
  const l = lab(FL);
  const f = one(l, "azurerm_network_watcher_flow_log").body;
  // Scope exception S2 (ruling 48, approved by Steven 2026-10-05), exactly as the scope check holds it.
  assert.equal(top(f, "resource_group_name"), '"NetworkWatcherRG"');
  assert.equal(attr(f, "network_watcher_name"), '"NetworkWatcher_${var.region}"');
  assert.equal(attr(f, "name"), '"lab-${var.lab_id}-vnet"', "attr(): topLevel() would drop the interpolation's braces");
  assert.equal(top(f, "target_resource_id"), "azurerm_virtual_network.hub.id");
  assert.equal(top(f, "storage_account_id"), `azurerm_storage_account.${one(l, "azurerm_storage_account").labels[1]}.id`);
  assert.equal(top(f, "network_security_group_id"), undefined, "a VNet flow log, never an NSG's");
  assert.equal(top(f, "location"), "var.region", "the watcher's region");
  assert.equal(top(f, "enabled"), "true");
  assert.equal(top(f, "version"), "2");
  const ret = nested(f, "retention_policy");
  assert.deepEqual([attr(ret, "enabled"), attr(ret, "days")], ["true", "1"]);
  // Nothing else names NetworkWatcherRG, and the storage account is in the region (flow logs need that).
  const others = resources(l).filter((r) => r.labels[0] !== "azurerm_network_watcher_flow_log" && /NetworkWatcherRG/i.test(r.body));
  assert.deepEqual(others.map((r) => r.labels.join(".")), []);
  const sa = one(l, "azurerm_storage_account").body;
  assert.equal(attr(sa, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(sa, "account_replication_type"), '"LRS"');
  // The plan's watcher is the session's region's own.
  const p = planned(FL, "azurerm_network_watcher_flow_log.vnet");
  assert.equal(p.network_watcher_name, "NetworkWatcher_uksouth");
  assert.equal(p.name, `lab-${FL}-vnet`);
});

test(`${FL}: traffic analytics every 10 minutes into the lab's capped workspace`, () => {
  const l = lab(FL);
  const f = one(l, "azurerm_network_watcher_flow_log").body;
  const ws = one(l, "azurerm_log_analytics_workspace");
  const ta = nested(f, "traffic_analytics");
  assert.equal(attr(ta, "enabled"), "true");
  assert.equal(attr(ta, "interval_in_minutes"), "10");
  assert.equal(attr(ta, "workspace_resource_id"), `azurerm_log_analytics_workspace.${ws.labels[1]}.id`);
  assert.equal(attr(ta, "workspace_id"), `azurerm_log_analytics_workspace.${ws.labels[1]}.workspace_id`);
  assert.equal(attr(ta, "workspace_region"), `azurerm_log_analytics_workspace.${ws.labels[1]}.location`);
  assert.equal(attr(ws.body, "daily_quota_gb"), "0.05");
  assert.equal(attr(ws.body, "resource_group_name"), IN_LAB, "traffic analytics' NWTA* rule and endpoint land in the workspace's group: the lab's");
});

test(`${FL}: the readme explains DDoS, Defender for Cloud and Bastion Developer`, () => {
  const l = lab(FL);
  const r = l.readme;
  const nbh = r.split("## Not built here")[1]?.split("## Learn more")[0] ?? "";
  assert.match(nbh, /DDoS Network Protection/);
  assert.match(nbh, /DDoS IP Protection/);
  assert.match(nbh, /Defender for Cloud/);
  assert.match(nbh, /attack path/i);
  assert.match(nbh, /Cloud Security Explorer/);
  assert.match(nbh, /network insights/i);
  assert.match(r, /Bastion Developer/);
  assert.match(r, /NetworkWatcherRG/);
  assert.match(r, /NTANetAnalytics/);
  assert.match(r, /IP flow verify/);
  const tries = r.split("## Things to try")[1].split("\n## ")[0];
  assert.match(tries, /[Rr]emove[^\n]*Bastion[^\n]*rule|rule[^\n]*Bastion[^\n]*break/i);
});

test(`${FL}: lab.yaml as planned`, () => {
  const l = lab(FL);
  const y = l.yaml;
  assert.deepEqual(y.skill_areas, ["az700.security", "az700.core"]);
  assert.deepEqual([y.level, y.type], ["associate", "explore"]);
  assert.deepEqual(y.prerequisites, ["az104-17-netwatcher-fix"]);
  assert.deepEqual(y.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(y.timing, { deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 4 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 64);
  const bastion = y.cost.items.find((i) => /Bastion Basic/.test(i.name));
  assert.equal(bastion.gbp_h, 0.1434);
  assert.equal(bastion.retail, undefined, '"Basic Gateway" is shared with other gateways (ruling 54)');
  for (const s of ["snet-web", "snet-app", "AzureBastionSubnet"]) assert.equal(attr(subnetIn(l, "hub", s).body, "default_outbound_access_enabled"), "true", s);
});
