// labs-az700-connectivity.test.mjs
//
// Plain English: the AZ-700 hybrid connectivity and hub labs (AZ-700 plan,
// area Z2: labs 36-39) checked without touching Azure. Each runs the shared
// content suite (fixtures/labs/content.mjs, test 6 from its plan fixture at
// slot 31), then its own tests: what it builds, from which addresses, in
// which order it can be torn down, and what its readme promises. init,
// validate and the mock plan are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attr, estimateGbpH, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { timeoutMin } from "../lab-release-test.mjs";

const S2S = "az700-36-s2s-vpn";

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

const byName = (l, type, name) => {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r;
};
/** The resource a `<type>.<name>.<attr>` reference names: [type, name], or null. */
const refTo = (v, type, a = "id") => {
  const m = new RegExp(`^${type}\\.([A-Za-z0-9_-]+)\\.${a}$`).exec(v ?? "");
  return m ? m[1] : null;
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
  return e.replace(/\s+/g, " ");
}
/** A one-element list attribute's only element, locals expanded: address_space = [local.x] -> "cidrsubnet(...)". */
function only(l, body, name) {
  const v = attr(body, name);
  const m = /^\[(.+)\]$/.exec(v ?? "");
  assert.ok(m, `${name} is a one-element list (${v})`);
  return expand(l, m[1]);
}

/** A subnet's prefix length from its expression: cidrsubnet(cidrsubnet(var.address_space, 2, n), bits, k) -> 20 + bits. */
function prefixLength(expr) {
  const m = /^cidrsubnet\(cidrsubnet\(var\.address_space, 2, \d\), (\d+), \d+\)$/.exec(expr);
  assert.ok(m, `${expr} is cidrsubnet(cidrsubnet(var.address_space, 2, n), bits, k)`);
  return 20 + Number(m[1]);
}

/** The plan fixture's change for `address` (what lab.yml's scope check reads). */
const planned = (id, address) => {
  const c = LAB_PLANS[id]?.plan.resource_changes.find((x) => x.address === address);
  assert.ok(c, `the plan fixture has ${address}`);
  return c.change;
};

/** Checks every AZ-700 Z2 lab shares: explicit default outbound access, and a £££ readme's deploy time and session cost. */
function sharedChecks(id) {
  test(`${id}: every subnet sets default outbound access explicitly`, () => {
    const l = lab(id);
    const subnets = resources(l, "azurerm_subnet");
    assert.ok(subnets.length > 0, "the lab has subnets");
    for (const s of subnets) assert.match(attr(s.body, "default_outbound_access_enabled") ?? "", /^(true|false)$/, `azurerm_subnet.${s.labels[1]} sets default_outbound_access_enabled (ruling 37)`);
  });
  test(`${id}: the readme gives the deploy time and, for a £££ lab, what a 2-hour session costs`, () => {
    const l = lab(id);
    const { deploy_min: d, destroy_min: t } = l.yaml.timing;
    assert.match(l.readme, new RegExp(`about ${d} minutes`), `the readme says deploying takes about ${d} minutes`);
    const gbpH = estimateGbpH(l.yaml.cost.items);
    if (gbpH < 0.5 && d < 30) return;
    // From deploy to the end of tear-down: 2 hours plus the deploy and the destroy.
    const session = gbpH * (2 + (d + t) / 60);
    const quoted = [...l.readme.matchAll(/2-hour session costs about £(\d+\.\d{2})/g)].map((m) => Number(m[1]));
    assert.equal(quoted.length, 1, "the readme says once what a 2-hour session costs (\"a 2-hour session costs about £X.XX\")");
    assert.ok(Math.abs(quoted[0] - session) <= 0.05, `£${quoted[0]} is within 5p of £${session.toFixed(2)} (£${gbpH.toFixed(4)}/h × (2 h + ${d + t} minutes))`);
  });
}

/** The readme's `## Not built here` section (text up to the next heading), or "". */
const notBuiltHere = (l) => /\n## Not built here\n([\s\S]*?)(?=\n## )/.exec(l.readme)?.[1] ?? "";

// ── Lab 36: site-to-site VPN ─────────────────────────────────────────────

labContentSuite(S2S, { marker: "£££" });
sharedChecks(S2S);

test(`${S2S}: two VpnGw1AZ route-based gateways with zone-redundant Standard public IPs and BGP`, () => {
  const l = lab(S2S);
  const gws = resources(l, "azurerm_virtual_network_gateway");
  assert.equal(gws.length, 2, "two VPN gateways");
  const vnets = new Set();
  const asns = [];
  for (const g of gws) {
    const at = `azurerm_virtual_network_gateway.${g.labels[1]}`;
    assert.equal(top(g.body, "type"), '"Vpn"', `${at}: type Vpn`);
    assert.equal(top(g.body, "vpn_type"), '"RouteBased"', `${at}: route-based`);
    assert.equal(top(g.body, "sku"), '"VpnGw1AZ"', `${at}: VpnGw1AZ (ruling 44: never Basic or non-AZ)`);
    assert.equal(top(g.body, "generation"), '"Generation1"', `${at}: Generation1`);
    assert.equal(top(g.body, "active_active"), "false", `${at}: active-standby`);
    assert.equal(top(g.body, "bgp_enabled"), "true", `${at}: BGP on`);
    assert.equal(nested(g.body, "vpn_client_configuration"), undefined, `${at}: no point-to-site`);
    asns.push(attr(nested(g.body, "bgp_settings"), "asn"));
    const ipc = allNested(g.body, "ip_configuration");
    assert.equal(ipc.length, 1, `${at}: one IP configuration (active-standby)`);
    const pip = byName(l, "azurerm_public_ip", refTo(attr(ipc[0], "public_ip_address_id"), "azurerm_public_ip"));
    assert.equal(attr(pip.body, "sku"), '"Standard"', `${at}'s public IP is Standard (Basic public IPs are retired)`);
    assert.equal(attr(pip.body, "allocation_method"), '"Static"');
    assert.deepEqual(strings(attr(pip.body, "zones")), ["1", "2", "3"], `${at}'s public IP is zone-redundant`);
    const subnet = byName(l, "azurerm_subnet", refTo(attr(ipc[0], "subnet_id"), "azurerm_subnet"));
    assert.equal(attr(subnet.body, "name"), '"GatewaySubnet"', `${at} is in a GatewaySubnet`);
    assert.equal(prefixLength(only(l, subnet.body, "address_prefixes")), 27, "GatewaySubnet is a /27 (ruling 46)");
    vnets.add(refTo(attr(subnet.body, "virtual_network_name"), "azurerm_virtual_network", "name"));
  }
  assert.deepEqual([...asns].sort(), ["65010", "65020"], "ASNs 65010 and 65020");
  assert.deepEqual([...vnets].sort(), ["azure", "onprem"], "one gateway in vnet-azure, one in vnet-onprem");
  assert.equal(attr(byName(l, "azurerm_virtual_network", "azure").body, "name"), '"vnet-azure"');
  assert.equal(attr(byName(l, "azurerm_virtual_network", "onprem").body, "name"), '"vnet-onprem"');
  assert.equal(resources(l, "azurerm_virtual_network_peering").length, 0, "the two VNets are not peered: the VPN joins them");
});

test(`${S2S}: each local network gateway describes the other VNet`, () => {
  const l = lab(S2S);
  const lgws = resources(l, "azurerm_local_network_gateway");
  assert.equal(lgws.length, 2, "two local network gateways");
  const gwOf = (side) => byName(l, "azurerm_virtual_network_gateway", side);
  const ipOf = (side) => refTo(attr(nested(gwOf(side).body, "ip_configuration"), "public_ip_address_id"), "azurerm_public_ip");
  const other = { azure: "onprem", onprem: "azure" };
  for (const side of ["azure", "onprem"]) {
    // The local network gateway the side's connection uses describes the other side.
    const cn = resources(l, "azurerm_virtual_network_gateway_connection").find((c) => refTo(attr(c.body, "virtual_network_gateway_id"), "azurerm_virtual_network_gateway") === side);
    assert.ok(cn, `a connection from the ${side} gateway`);
    const lgw = byName(l, "azurerm_local_network_gateway", refTo(attr(cn.body, "local_network_gateway_id"), "azurerm_local_network_gateway"));
    const at = `azurerm_local_network_gateway.${lgw.labels[1]}`;
    const far = other[side];
    assert.equal(attr(lgw.body, "gateway_address"), `azurerm_public_ip.${ipOf(far)}.ip_address`, `${at}: the ${far} gateway's public IP`);
    assert.equal(only(l, lgw.body, "address_space"), only(l, byName(l, "azurerm_virtual_network", far).body, "address_space"), `${at}: the ${far} VNet's /20`);
    const bgp = nested(lgw.body, "bgp_settings");
    assert.equal(attr(bgp, "asn"), attr(nested(gwOf(far).body, "bgp_settings"), "asn"), `${at}: the ${far} gateway's ASN`);
    // try(): a mocked plan (labs-tf) has no peering addresses; a real one has them unknown until the gateway exists.
    assert.equal(attr(bgp, "bgp_peering_address"), `try(azurerm_virtual_network_gateway.${far}.bgp_settings[0].peering_addresses[0].default_addresses[0], "")`, `${at}: the ${far} gateway's BGP peering address`);
  }
});

test(`${S2S}: both connections use the same IPsec policy and a sensitive shared key`, () => {
  const l = lab(S2S);
  const cns = resources(l, "azurerm_virtual_network_gateway_connection");
  assert.equal(cns.length, 2, "two connections, one each way");
  const policies = [];
  for (const c of cns) {
    const at = `azurerm_virtual_network_gateway_connection.${c.labels[1]}`;
    assert.equal(top(c.body, "type"), '"IPsec"', `${at}: IPsec (site-to-site)`);
    assert.equal(top(c.body, "bgp_enabled"), "true", `${at}: BGP over the tunnel`);
    assert.equal(top(c.body, "shared_key"), "random_password.psk.result", `${at}: the shared key is random_password.psk (never a literal)`);
    const p = nested(c.body, "ipsec_policy");
    assert.ok(p, `${at}: a custom IPsec/IKE policy`);
    const policy = Object.fromEntries(["dh_group", "ike_encryption", "ike_integrity", "ipsec_encryption", "ipsec_integrity", "pfs_group", "sa_lifetime"].map((k) => [k, attr(p, k)]));
    assert.deepEqual(policy, { dh_group: '"DHGroup14"', ike_encryption: '"AES256"', ike_integrity: '"SHA256"', ipsec_encryption: '"GCMAES256"', ipsec_integrity: '"GCMAES256"', pfs_group: '"PFS14"', sa_lifetime: "27000" }, `${at}: IKEv2 AES256/SHA256 DH14, IPsec GCMAES256 PFS14, 27000 s`);
    policies.push(JSON.stringify(policy));
    // The plan marks the key sensitive, as Terraform does (schema-sensitive and from a sensitive result).
    assert.equal(planned(S2S, at).after_sensitive.shared_key, true, `${at}: shared_key is sensitive in the plan`);
  }
  assert.equal(new Set(policies).size, 1, "both ends use the same policy (or the tunnel never comes up)");
  const psk = byName(l, "random_password", "psk");
  assert.ok(Number(attr(psk.body, "length")) >= 32, "the shared key is 32 characters or more");
  assert.equal(attr(psk.body, "special"), "false", "letters and digits only (Azure accepts printable ASCII; this avoids quoting trouble on a device)");
  assert.match(uncomment(l.files["versions.tf"]).replace(/\s+/g, " "), /random = \{ source = "hashicorp\/random"/, "versions.tf declares the random provider");
  assert.ok(!outputs(l).some((o) => /key|psk|secret/i.test(o)), "no output shows the shared key");
});

test(`${S2S}: timing is 45/25 and the job timeout is 150`, () => {
  const { timing } = lab(S2S).yaml;
  assert.deepEqual(timing, { deploy_min: 45, destroy_min: 25, session_h: 2, max_h: 3 });
  assert.equal(timeoutMin(timing), 150, "min(150, 2 × (45 + 25) + 20)");
});

test(`${S2S}: the readme explains ExpressRoute and Extended Network under Not built here`, () => {
  const l = lab(S2S);
  const s = notBuiltHere(l);
  assert.ok(s, "the readme has a ## Not built here section (ruling 43)");
  assert.ok(l.readme.indexOf("## Things to try") < l.readme.indexOf("## Not built here") && l.readme.indexOf("## Not built here") < l.readme.indexOf("## Learn more"), "after Things to try, before Learn more");
  for (const w of ["ExpressRoute", "Global Reach", "FastPath", "ExpressRoute Direct", "BFD", "MACsec", "private peering", "Microsoft peering", "Extended Network"]) assert.match(s, new RegExp(w), `Not built here mentions ${w}`);
  assert.match(l.readme, /\]\(https:\/\/learn\.microsoft\.com\/azure\/expressroute\//, "Learn more links ExpressRoute");
});

test(`${S2S}: priced as two VpnGw1AZ gateways, two Standard public IPs and two small VMs`, () => {
  const { cost } = lab(S2S).yaml;
  const gw = cost.items.find((i) => i.retail?.meter === "VpnGw1AZ");
  assert.ok(gw, "a VpnGw1AZ retail item");
  assert.deepEqual([gw.qty, gw.gbp_h, gw.retail.unit], [2, 0.1585, "1 Hour"]);
  const ip = cost.items.find((i) => i.retail?.meter === "Standard IPv4 Static Public IP");
  assert.deepEqual([ip?.qty, ip?.gbp_h], [2, 0.0038], "two Standard public IPs");
  assert.equal(cost.pricey, gw.name, "the gateways are the pricey item");
  assert.equal(estimateGbpH(cost.items).toFixed(4), "0.3460");
});
