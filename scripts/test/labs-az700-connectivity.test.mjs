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

// ── Lab 37: point-to-site VPN with Entra ID ──────────────────────────────

const P2S = "az700-37-p2s-vpn";
/** The Azure VPN Client's Microsoft-registered app (Learn, 2025-02-13): no app registration, no consent. */
const AZURE_VPN_AUDIENCE = "c632b3df-fb67-4d84-bdcf-b95ad541b5c8";

labContentSuite(P2S, { marker: "£££", identity: "match" });
sharedChecks(P2S);

test(`${P2S}: OpenVPN with Entra ID and the Microsoft-registered audience`, () => {
  const l = lab(P2S);
  const gws = resources(l, "azurerm_virtual_network_gateway");
  assert.equal(gws.length, 1, "one VPN gateway");
  const g = gws[0].body;
  assert.deepEqual([top(g, "type"), top(g, "vpn_type"), top(g, "sku"), top(g, "generation"), top(g, "active_active")], ['"Vpn"', '"RouteBased"', '"VpnGw1AZ"', '"Generation1"', "false"], "a route-based VpnGw1AZ (Basic has no OpenVPN or Entra ID), Generation1, active-standby");
  const pip = byName(l, "azurerm_public_ip", refTo(attr(nested(g, "ip_configuration"), "public_ip_address_id"), "azurerm_public_ip"));
  assert.deepEqual([attr(pip.body, "sku"), attr(pip.body, "allocation_method"), strings(attr(pip.body, "zones")).join(",")], ['"Standard"', '"Static"', "1,2,3"], "a Standard, static, zone-redundant public IP");
  const subnet = byName(l, "azurerm_subnet", refTo(attr(nested(g, "ip_configuration"), "subnet_id"), "azurerm_subnet"));
  assert.equal(attr(subnet.body, "name"), '"GatewaySubnet"');
  assert.equal(prefixLength(only(l, subnet.body, "address_prefixes")), 27, "GatewaySubnet is a /27 (ruling 46)");
  const p2s = nested(g, "vpn_client_configuration");
  assert.ok(p2s, "a point-to-site configuration");
  assert.deepEqual(strings(attr(p2s, "vpn_client_protocols")), ["OpenVPN"], "OpenVPN only (Entra ID needs it)");
  assert.deepEqual(strings(attr(p2s, "vpn_auth_types")), ["AAD"], "Entra ID authentication only");
  assert.equal(attr(p2s, "aad_audience"), `"${AZURE_VPN_AUDIENCE}"`, "the Microsoft-registered Azure VPN Client audience");
  for (const b of ["root_certificate", "revoked_certificate", "radius_server", "ipsec_policy"]) assert.equal(nested(p2s, b), undefined, `no ${b}`);
  assert.equal(attr(p2s, "radius_server_address"), undefined, "no RADIUS");
  // No app registration, service principal or consent: not an identity change (ruling 44).
  assert.deepEqual(l.blocks.filter((b) => b.kind === "resource" && b.labels[0].startsWith("azuread_")).map((b) => b.labels[0]), ["azuread_user"], "the only Entra object is the lab user (no application, service principal or grant)");
  assert.equal(top(g, "bgp_enabled") ?? "false", "false", "no BGP: nothing to peer with");
});

test(`${P2S}: the tenant and issuer come from the client config, the issuer with a trailing slash`, () => {
  const l = lab(P2S);
  const cfg = l.blocks.find((b) => b.kind === "data" && b.labels[0] === "azurerm_client_config");
  assert.ok(cfg, 'data "azurerm_client_config" exists');
  assert.equal(cfg.body.trim(), "", "it takes no arguments: the tenant the pipeline signs in to");
  const tenant = `data.azurerm_client_config.${cfg.labels[1]}.tenant_id`;
  const p2s = nested(resources(l, "azurerm_virtual_network_gateway")[0].body, "vpn_client_configuration");
  assert.equal(attr(p2s, "aad_tenant"), `"https://login.microsoftonline.com/\${${tenant}}/"`);
  assert.equal(attr(p2s, "aad_issuer"), `"https://sts.windows.net/\${${tenant}}/"`, "the issuer ends with a slash, or sign-in fails");
  // The plan knows both (a data source is read at plan).
  const after = planned(P2S, "azurerm_virtual_network_gateway.hub").after.vpn_client_configuration[0];
  assert.match(after.aad_tenant, /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/$/);
  assert.match(after.aad_issuer, /^https:\/\/sts\.windows\.net\/[0-9a-f-]{36}\/$/);
});

test(`${P2S}: the client pool is a /24 of the slot outside the VNet`, () => {
  const l = lab(P2S);
  const p2s = nested(resources(l, "azurerm_virtual_network_gateway")[0].body, "vpn_client_configuration");
  const pool = only(l, p2s, "address_space");
  assert.equal(pool, "cidrsubnet(cidrsubnet(var.address_space, 2, 3), 4, 15)", "the last /24 of the slot's fourth /20");
  const vnets = resources(l, "azurerm_virtual_network");
  assert.equal(vnets.length, 1, "one VNet, vnet-hub");
  assert.equal(only(l, vnets[0].body, "address_space"), "cidrsubnet(var.address_space, 2, 0)", "vnet-hub is the first /20, so the pool is outside it");
  // In the plan: a known /24 inside the slot, overlapping no VNet (test 6 checks the overlap).
  const after = planned(P2S, "azurerm_virtual_network_gateway.hub").after.vpn_client_configuration[0];
  assert.deepEqual(after.address_space, ["10.71.255.0/24"]);
});

test(`${P2S}: one Entra user named lab-<id>-vpnuser, listed in lab.yaml and the users output`, () => {
  const l = lab(P2S);
  const users = resources(l, "azuread_user");
  assert.equal(users.length, 1, "one Entra user");
  const u = users[0];
  assert.equal(attr(u.body, "display_name"), '"lab-${var.lab_id}-vpnuser"');
  assert.equal(attr(u.body, "user_principal_name"), '"lab-${var.lab_id}-vpnuser@${var.upn_domain}"');
  assert.equal(attr(u.body, "mail_nickname"), '"lab-${var.lab_id}-vpnuser"');
  assert.equal(attr(u.body, "password"), "var.admin_password", "the session's password, behind Show");
  assert.equal(attr(u.body, "force_password_change"), "false", "no forced change, so the first VPN sign-in works");
  assert.deepEqual(l.yaml.identity, { creates: ["user"], roles: [], governance: false });
  assert.ok(outputs(l).includes("users"), "output users");
  const out = l.blocks.find((b) => b.kind === "output" && b.labels[0] === "users");
  assert.match(out.body, new RegExp(`vpnuser\\s*=\\s*azuread_user\\.${u.labels[1]}\\.user_principal_name`), "users lists the lab user's sign-in name");
  assert.match(uncomment(l.files["versions.tf"]).replace(/\s+/g, " "), /azuread = \{ source = "hashicorp\/azuread"/, "versions.tf declares azuread");
});

test(`${P2S}: timing is 40/20 and the job timeout is 140`, () => {
  const { timing } = lab(P2S).yaml;
  assert.deepEqual(timing, { deploy_min: 40, destroy_min: 20, session_h: 2, max_h: 3 });
  assert.equal(timeoutMin(timing), 140, "2 × (40 + 20) + 20");
});

test(`${P2S}: the readme explains the Azure VPN Client beside WireGuard, and RADIUS, Always On and Azure Network Adapter under Not built here`, () => {
  const l = lab(P2S);
  assert.match(l.readme, /Azure VPN Client/);
  assert.match(l.readme, /WireGuard/);
  assert.match(l.readme, /10\.64\.0\.0\/13/, "the WireGuard route the P2S routes are more specific than");
  assert.match(l.readme, /more specific/);
  assert.match(l.readme, /MFA|multifactor/i, "MFA registration may be asked at first sign-in");
  const s = notBuiltHere(l);
  for (const w of ["RADIUS", "Always On", "Azure Network Adapter", "certificate"]) assert.match(s, new RegExp(w), `Not built here mentions ${w}`);
  assert.match(s, /app registration|register/i, "user and group restriction needs a custom app registration");
});

test(`${P2S}: priced as one VpnGw1AZ gateway, its public IP and one small VM`, () => {
  const { cost } = lab(P2S).yaml;
  const gw = cost.items.find((i) => i.retail?.meter === "VpnGw1AZ");
  assert.deepEqual([gw?.qty ?? 1, gw?.gbp_h], [1, 0.1585]);
  assert.equal(cost.pricey, gw.name);
  assert.equal(estimateGbpH(cost.items).toFixed(4), "0.1730");
});

// ── Lab 38: hub-spoke with Azure Firewall ────────────────────────────────

const FW = "az700-38-hub-firewall";

labContentSuite(FW, { marker: "££" });
sharedChecks(FW);

test(`${FW}: a Basic firewall with data and management IP configurations`, () => {
  const l = lab(FW);
  const fws = resources(l, "azurerm_firewall");
  assert.equal(fws.length, 1, "one firewall");
  const f = fws[0].body;
  assert.equal(top(f, "sku_name"), '"AZFW_VNet"', "a firewall in a VNet (a hub VNet, not a Virtual WAN hub)");
  assert.equal(top(f, "sku_tier"), '"Basic"');
  assert.equal(refTo(top(f, "firewall_policy_id"), "azurerm_firewall_policy"), "hub", "the firewall uses fwp-hub");
  const data = allNested(f, "ip_configuration");
  assert.equal(data.length, 1, "one data IP configuration");
  const mgmt = nested(f, "management_ip_configuration");
  assert.ok(mgmt, "a management IP configuration (Basic needs one)");
  const ips = {};
  for (const [what, block, name] of [["data", data[0], "AzureFirewallSubnet"], ["management", mgmt, "AzureFirewallManagementSubnet"]]) {
    const s = byName(l, "azurerm_subnet", refTo(attr(block, "subnet_id"), "azurerm_subnet"));
    assert.equal(attr(s.body, "name"), `"${name}"`, `the ${what} configuration is in ${name}`);
    assert.equal(prefixLength(only(l, s.body, "address_prefixes")), 26, `${name} is a /26 (ruling 46)`);
    assert.equal(refTo(attr(s.body, "virtual_network_name"), "azurerm_virtual_network", "name"), "hub", `${name} is in vnet-hub`);
    const pip = byName(l, "azurerm_public_ip", refTo(attr(block, "public_ip_address_id"), "azurerm_public_ip"));
    assert.deepEqual([attr(pip.body, "sku"), attr(pip.body, "allocation_method")], ['"Standard"', '"Static"'], `the ${what} public IP is Standard and static`);
    ips[what] = pip.labels[1];
  }
  assert.notEqual(ips.data, ips.management, "two different public IPs");
  assert.equal(resources(l, "azurerm_public_ip").length, 2, "only the firewall's two public IPs");
  assert.equal(top(f, "dns_proxy_enabled"), undefined, "no DNS proxy (Basic has none)");
});

test(`${FW}: the hub policy inherits the base policy`, () => {
  const l = lab(FW);
  const base = byName(l, "azurerm_firewall_policy", "base");
  const hub = byName(l, "azurerm_firewall_policy", "hub");
  assert.equal(attr(base.body, "name"), '"fwp-base"');
  assert.equal(attr(hub.body, "name"), '"fwp-hub"');
  assert.equal(attr(base.body, "base_policy_id"), undefined, "fwp-base is the parent");
  assert.equal(attr(hub.body, "base_policy_id"), "azurerm_firewall_policy.base.id", "fwp-hub inherits fwp-base");
  const groups = resources(l, "azurerm_firewall_policy_rule_collection_group");
  const of = (p) => groups.filter((g) => refTo(attr(g.body, "firewall_policy_id"), "azurerm_firewall_policy") === p);
  // The base: spoke-to-spoke SSH and ICMP, as network rules.
  const [bg] = of("base");
  assert.ok(bg, "fwp-base has a rule collection group");
  const net = nested(bg.body, "network_rule_collection");
  assert.equal(attr(net, "action"), '"Allow"');
  const rules = allNested(net, "rule");
  const ssh = rules.find((r) => strings(attr(r, "destination_ports")).includes("22"));
  assert.ok(ssh, "a rule for port 22");
  assert.deepEqual(strings(attr(ssh, "protocols")), ["TCP"]);
  assert.ok(rules.some((r) => strings(attr(r, "protocols")).includes("ICMP")), "a rule for ICMP");
  for (const r of rules) {
    assert.equal(attr(r, "source_addresses"), "[local.spoke1_cidr, local.spoke2_cidr]", "from the spokes");
    assert.equal(attr(r, "destination_addresses"), "[local.spoke1_cidr, local.spoke2_cidr]", "to the spokes");
  }
  assert.equal(nested(bg.body, "application_rule_collection"), undefined, "the base has network rules only");
  // The hub (child): web access to Ubuntu's mirrors and one Microsoft page, as application rules.
  const [hg] = of("hub");
  assert.ok(hg, "fwp-hub has a rule collection group");
  const app = nested(hg.body, "application_rule_collection");
  assert.equal(attr(app, "action"), '"Allow"');
  const fqdns = allNested(app, "rule").flatMap((r) => strings(attr(r, "destination_fqdns")));
  assert.deepEqual(fqdns.sort(), ["*.ubuntu.com", "www.microsoft.com"]);
  const ports = allNested(app, "protocols").map((p) => `${strings(attr(p, "type"))[0]}:${attr(p, "port")}`);
  assert.deepEqual([...new Set(ports)].sort(), ["Http:80", "Https:443"]);
  assert.equal(nested(hg.body, "network_rule_collection"), undefined, "the child adds application rules only");
});

test(`${FW}: each spoke sends 0.0.0.0/0 and the other spoke to the firewall`, () => {
  const l = lab(FW);
  const fwIp = "azurerm_firewall.hub.ip_configuration[0].private_ip_address";
  for (const [me, other] of [["spoke1", "spoke2"], ["spoke2", "spoke1"]]) {
    const rt = byName(l, "azurerm_route_table", me);
    assert.equal(attr(rt.body, "name"), `"rt-${me}"`);
    const routes = resources(l, "azurerm_route").filter((r) => refTo(attr(r.body, "route_table_name"), "azurerm_route_table", "name") === me);
    const prefixes = routes.map((r) => expand(l, attr(r.body, "address_prefix"))).sort();
    assert.deepEqual(prefixes, ['"0.0.0.0/0"', expand(l, `local.${other}_cidr`)].sort(), `rt-${me}: 0.0.0.0/0 and ${other}'s /20`);
    for (const r of routes) {
      assert.equal(attr(r.body, "next_hop_type"), '"VirtualAppliance"');
      assert.equal(attr(r.body, "next_hop_in_ip_address"), fwIp, "the next hop is the firewall's private IP");
    }
    const assoc = resources(l, "azurerm_subnet_route_table_association").find((a) => refTo(attr(a.body, "route_table_id"), "azurerm_route_table") === me);
    assert.ok(assoc, `rt-${me} is associated`);
    const subnet = byName(l, "azurerm_subnet", refTo(attr(assoc.body, "subnet_id"), "azurerm_subnet"));
    assert.equal(refTo(attr(subnet.body, "virtual_network_name"), "azurerm_virtual_network", "name"), me, `with ${me}'s subnet`);
    assert.equal(attr(subnet.body, "default_outbound_access_enabled"), "false", `${me}'s subnet is private: its way out is the firewall (ruling 37)`);
    // Peered with the hub both ways, forwarded traffic allowed (the firewall forwards the other spoke's packets).
    for (const [from, to] of [["hub", me], [me, "hub"]]) {
      const p = resources(l, "azurerm_virtual_network_peering").find((x) => refTo(attr(x.body, "virtual_network_name"), "azurerm_virtual_network", "name") === from && refTo(attr(x.body, "remote_virtual_network_id"), "azurerm_virtual_network") === to);
      assert.ok(p, `vnet-${from} peers with vnet-${to}`);
      assert.equal(attr(p.body, "allow_forwarded_traffic"), "true");
    }
  }
  assert.equal(resources(l, "azurerm_virtual_network_peering").length, 4, "no spoke-to-spoke peering: the firewall joins them");
});

test(`${FW}: no Standard or Premium firewall or policy`, () => {
  const l = lab(FW);
  for (const f of resources(l, "azurerm_firewall")) assert.equal(top(f.body, "sku_tier"), '"Basic"', `azurerm_firewall.${f.labels[1]} is Basic`);
  const policies = resources(l, "azurerm_firewall_policy");
  assert.equal(policies.length, 2);
  for (const p of policies) {
    assert.equal(attr(p.body, "sku"), '"Basic"', `azurerm_firewall_policy.${p.labels[1]} is Basic`);
    // Standard and Premium features a Basic policy cannot have.
    for (const b of ["intrusion_detection", "tls_certificate", "dns", "explicit_proxy"]) assert.equal(nested(p.body, b), undefined, `azurerm_firewall_policy.${p.labels[1]}: no ${b}`);
  }
});

test(`${FW}: the firewall logs to a capped workspace in resource-specific tables`, () => {
  const l = lab(FW);
  const ws = resources(l, "azurerm_log_analytics_workspace");
  assert.equal(ws.length, 1);
  assert.equal(attr(ws[0].body, "daily_quota_gb"), "0.05", "capped at 50 MB a day");
  assert.equal(attr(ws[0].body, "sku"), '"PerGB2018"');
  const ds = resources(l, "azurerm_monitor_diagnostic_setting");
  assert.equal(ds.length, 1);
  assert.equal(attr(ds[0].body, "target_resource_id"), "azurerm_firewall.hub.id");
  assert.equal(attr(ds[0].body, "log_analytics_workspace_id"), `azurerm_log_analytics_workspace.${ws[0].labels[1]}.id`);
  assert.equal(attr(ds[0].body, "log_analytics_destination_type"), '"Dedicated"', "resource-specific tables (AZFWApplicationRule and friends)");
  const cats = allNested(ds[0].body, "enabled_log").map((b) => strings(attr(b, "category"))[0]);
  assert.ok(cats.includes("AZFWApplicationRule") && cats.includes("AZFWNetworkRule"), `application and network rule logs (${cats.join(", ")})`);
});

test(`${FW}: timing is 15/12, the job timeout 74, and it is priced as a Basic firewall`, () => {
  const { timing, cost } = lab(FW).yaml;
  assert.deepEqual(timing, { deploy_min: 15, destroy_min: 12, session_h: 2, max_h: 3 });
  assert.equal(timeoutMin(timing), 74);
  const fw = cost.items.find((i) => i.retail?.meter === "Basic Deployment");
  assert.deepEqual([fw?.gbp_h, fw?.retail.unit], [0.2981, "1 Hour"], "Azure Firewall Basic, Basic Deployment");
  assert.equal(cost.pricey, fw.name);
  assert.equal(cost.items.find((i) => i.retail?.meter === "Standard IPv4 Static Public IP")?.qty, 2, "two Standard public IPs");
  assert.equal(estimateGbpH(cost.items).toFixed(4), "0.3325");
});
