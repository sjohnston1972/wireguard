// labs-az305-data.test.mjs
//
// Plain English: the AZ-305 data labs (labs batch 3 plan, area C2: labs 23,
// 24 and 25) checked without touching Azure. Each runs the shared content
// suite (fixtures/labs/content.mjs: catalogue rules, lint, its resource
// groups, peering and subnets, prices, marker, terraform fmt), then the tests
// the plan names for it: what it builds, read from its Terraform text, and
// above all that tear-down can get it back to £0 (no vCore database where
// the quota is 0, a failover group Terraform can take apart, no locked
// immutability). Plans and the scope check are lab-plans.test.mjs's job;
// init, validate and the mocked plan are npm run labs-tf's.

import { test } from "node:test";
import assert from "node:assert/strict";
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

/** Every nested block `name { ... }` in `body`, in order. */
function allNested(body, name) {
  const out = [];
  let rest = body ?? "";
  for (let b = nested(rest, name); b !== undefined; b = nested(rest, name)) {
    out.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  return out;
}

/** The azurerm provider's features block from versions.tf. */
const features = (l) => {
  const p = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm");
  assert.ok(p, 'versions.tf has provider "azurerm"');
  const f = nested(p.body, "features");
  assert.ok(f !== undefined, "the azurerm provider has a features block");
  return f;
};

const one = (l, type) => {
  const rs = resources(l, type);
  assert.equal(rs.length, 1, `exactly one ${type}`);
  return rs[0];
};

/** The variable block `name`'s body, comments dropped and whitespace squeezed. */
const variable = (l, name) => {
  const v = l.blocks.find((b) => b.kind === "variable" && b.labels[0] === name);
  assert.ok(v, `variable "${name}" is declared`);
  return v.body.replace(/\s+/g, " ");
};

// ── Lab 23: Azure SQL Database, geo-replication, failover group, serverless ─

const L23 = "az305-23-sql-failover";
labContentSuite(L23, { marker: "££", secondary: true });

/** SKUs priced per DTU: Basic, Standard (S0-S12) and Premium (P1-P15). Anything else is vCore. */
const DTU_SKU = /^(Basic|S\d+|P\d+)$/;

test(`${L23}: a Basic primary in rg-lab-<id> and a Basic geo-secondary on the ukwest server in rg-lab-<id>-secondary`, () => {
  const l = lab(L23);
  assert.deepEqual(resources(l, "azurerm_mssql_server").map((s) => s.labels[1]).sort(), ["primary", "secondary"], "two servers");
  const primary = res(l, "azurerm_mssql_server", "primary").body;
  const secondary = res(l, "azurerm_mssql_server", "secondary").body;
  assert.equal(attr(primary, "resource_group_name"), "azurerm_resource_group.lab.name");
  assert.equal(attr(primary, "location"), "azurerm_resource_group.lab.location", "the primary server is in the session's region");
  assert.equal(attr(primary, "name"), '"${var.name_prefix}-sqlp"');
  assert.equal(attr(secondary, "resource_group_name"), "azurerm_resource_group.secondary.name");
  assert.equal(attr(secondary, "location"), "azurerm_resource_group.secondary.location", "the secondary server is in the secondary region");
  assert.equal(attr(secondary, "name"), '"${var.name_prefix}-sqls"');
  for (const [name, s] of [["primary", primary], ["secondary", secondary]]) {
    assert.equal(attr(s, "version"), '"12.0"', name);
    assert.equal(attr(s, "minimum_tls_version"), '"1.2"', name);
    assert.equal(attr(s, "administrator_login"), '"labadmin"', name);
    assert.equal(attr(s, "administrator_login_password"), "var.admin_password", `${name}: the session's password (behind Show)`);
    assert.equal(attr(s, "public_network_access_enabled"), "true", `${name}: public access on, with no firewall rule, so the portal shows what a rule would allow`);
    assert.equal(nested(s, "azuread_administrator"), undefined, `${name}: SQL authentication only, no Entra admin`);
  }
  assert.equal(resources(l, "azurerm_mssql_firewall_rule").length, 0, "no firewall rules: only the private endpoints reach the servers");
  assert.equal(resources(l, "azurerm_mssql_virtual_network_rule").length, 0);

  const dbs = resources(l, "azurerm_mssql_database");
  const appdb = res(l, "azurerm_mssql_database", "primary").body;
  assert.equal(attr(appdb, "name"), '"appdb"');
  assert.equal(attr(appdb, "server_id"), "azurerm_mssql_server.primary.id");
  assert.equal(attr(appdb, "sku_name"), '"Basic"');
  assert.equal(attr(appdb, "create_mode"), undefined, "the primary is a new, empty database");
  const geo = res(l, "azurerm_mssql_database", "secondary").body;
  assert.equal(attr(geo, "name"), '"appdb"', "a geo-secondary has its primary's name");
  assert.equal(attr(geo, "server_id"), "azurerm_mssql_server.secondary.id");
  assert.equal(attr(geo, "sku_name"), '"Basic"', "the same tier as its primary");
  assert.equal(attr(geo, "create_mode"), '"Secondary"');
  assert.equal(attr(geo, "creation_source_database_id"), "azurerm_mssql_database.primary.id");
  assert.equal(dbs.filter((d) => attr(d.body, "create_mode") === '"Secondary"').length, 1, "one geo-secondary");
  assert.equal(resources(l, "azurerm_mssql_elasticpool").length, 0, "no elastic pool");
});

test(`${L23}: the failover group is Manual, holds the primary and depends on the explicit geo-secondary`, () => {
  const l = lab(L23);
  const fog = one(l, "azurerm_mssql_failover_group").body;
  assert.equal(attr(fog, "name"), '"${var.name_prefix}-fog"', "the listener is <name_prefix>-fog.database.windows.net");
  assert.equal(attr(fog, "server_id"), "azurerm_mssql_server.primary.id");
  assert.equal(attr(fog, "databases"), "[azurerm_mssql_database.primary.id]", "only appdb is in the group");
  assert.equal(attr(nested(fog, "partner_server"), "id"), "azurerm_mssql_server.secondary.id");
  // Customer-managed failover (ruling 24): Microsoft-managed needs a grace period of at least an hour.
  const rw = nested(fog, "read_write_endpoint_failover_policy");
  assert.ok(rw !== undefined, "a read_write_endpoint_failover_policy block");
  assert.equal(attr(rw, "mode"), '"Manual"');
  assert.equal(attr(rw, "grace_minutes"), undefined, "Manual takes no grace period");
  // The group adopts the link the explicit secondary already made; made after it, destroyed before it.
  assert.match(fog, /depends_on\s*=\s*\[azurerm_mssql_database\.secondary\]/);
  assert.equal(attr(fog, "tags"), "var.tags");
  // Connect and the readme name the listener.
  assert.match(output(l, "connect").body, /\$\{azurerm_mssql_failover_group\.\w+\.name\}\.database\.windows\.net/);
  assert.match(l.readme, /listener/i);
});

test(`${L23}: the serverless database is GP_S_Gen5_1 with auto-pause, on the ukwest server, outside the group`, () => {
  const l = lab(L23);
  const scratch = res(l, "azurerm_mssql_database", "scratch").body;
  assert.equal(attr(scratch, "name"), '"scratch"');
  assert.equal(attr(scratch, "server_id"), "azurerm_mssql_server.secondary.id", "vCore quota: 0 in uksouth, 320 in ukwest");
  assert.equal(attr(scratch, "sku_name"), '"GP_S_Gen5_1"', "General Purpose serverless, Gen5, at most 1 vCore");
  assert.equal(attr(scratch, "min_capacity"), "0.5", "the smallest minimum");
  const pause = Number(attr(scratch, "auto_pause_delay_in_minutes"));
  // Learn: General Purpose's minimum is 15 minutes (V: the mock plan accepts it). Never -1 (always on).
  assert.ok(pause >= 15 && pause <= 60, `auto_pause_delay_in_minutes ${pause} is 15 to 60, so it pauses within a session`);
  assert.equal(attr(scratch, "max_size_gb"), "1", "1 GB: storage is billed by the configured size");
  assert.equal(attr(scratch, "create_mode"), undefined);
  // Auto-pause is not available to a geo-replicated serverless database: never in the group, never a secondary.
  assert.doesNotMatch(attr(one(l, "azurerm_mssql_failover_group").body, "databases"), /scratch/);
  assert.equal(resources(l, "azurerm_mssql_database").filter((d) => attr(d.body, "creation_source_database_id")?.includes("scratch")).length, 0);
  // Not the free offer (azurerm 4.81 has no attribute for it): priced, and authored (the vCore meter is shared).
  const item = l.yaml.cost.items.find((i) => /serverless/i.test(i.name));
  assert.ok(item, "a serverless cost item");
  assert.equal(item.retail, undefined, "authored: the serverless vCore meter name is shared (ruling 2)");
  assert.ok(item.gbp_h > 0);
  assert.match(l.readme, /auto-pause/i);
});

test(`${L23}: no vCore database in the primary region`, () => {
  const l = lab(L23);
  for (const d of resources(l, "azurerm_mssql_database")) {
    const sku = unq(attr(d.body, "sku_name"));
    assert.ok(sku, `${d.labels[1]}: sku_name is set`);
    if (attr(d.body, "server_id") === "azurerm_mssql_server.primary.id") assert.match(sku, DTU_SKU, `${d.labels[1]} on the primary server is DTU (${sku}): uksouth's vCore quota is 0`);
    else assert.equal(attr(d.body, "server_id"), "azurerm_mssql_server.secondary.id", `${d.labels[1]}: on one of the lab's servers`);
  }
  // The primary server is the one in the session's region; nothing vCore reaches it any other way.
  assert.equal(attr(res(l, "azurerm_mssql_server", "primary").body, "location"), "azurerm_resource_group.lab.location");
  assert.doesNotMatch(code(l), /azurerm_mssql_elasticpool|azurerm_mssql_managed_instance/);
});

test(`${L23}: both servers have a private endpoint in the uksouth VNet and dns_link is true, and Terraform never links the zone to the gateway`, () => {
  const l = lab(L23);
  const loc = locals(l);
  assert.equal(loc.vnet_cidr, "cidrsubnet(var.address_space, 2, 0)");
  assert.equal(loc.endpoints_cidr, "cidrsubnet(local.vnet_cidr, 4, 0)");
  const vnet = one(l, "azurerm_virtual_network").body;
  assert.equal(attr(vnet, "resource_group_name"), "azurerm_resource_group.lab.name", "the VNet is in rg-lab-<id>, in the session's region");
  assert.equal(attr(vnet, "address_space"), "[local.vnet_cidr]");
  const subnet = one(l, "azurerm_subnet");
  assert.equal(attr(subnet.body, "address_prefixes"), "[local.endpoints_cidr]");
  assert.equal(attr(subnet.body, "name"), '"snet-pe"');
  const zone = one(l, "azurerm_private_dns_zone");
  assert.equal(attr(zone.body, "name"), '"privatelink.database.windows.net"');
  assert.equal(attr(zone.body, "resource_group_name"), "azurerm_resource_group.lab.name");
  const pes = resources(l, "azurerm_private_endpoint");
  assert.deepEqual(pes.map((p) => p.labels[1]).sort(), ["primary", "secondary"], "one endpoint per server");
  for (const pe of pes) {
    const server = `azurerm_mssql_server.${pe.labels[1]}`;
    assert.equal(attr(pe.body, "resource_group_name"), "azurerm_resource_group.lab.name", `${pe.labels[1]}: in rg-lab-<id>`);
    assert.equal(attr(pe.body, "location"), "azurerm_resource_group.lab.location", `${pe.labels[1]}: in uksouth, beside the VNet, whichever region its server is in`);
    assert.equal(attr(pe.body, "subnet_id"), `azurerm_subnet.${subnet.labels[1]}.id`);
    const psc = nested(pe.body, "private_service_connection");
    assert.equal(attr(psc, "private_connection_resource_id"), `${server}.id`);
    assert.equal(attr(psc, "subresource_names"), '["sqlServer"]');
    assert.equal(attr(psc, "is_manual_connection"), "false");
    assert.equal(attr(nested(pe.body, "private_dns_zone_group"), "private_dns_zone_ids"), `[azurerm_private_dns_zone.${zone.labels[1]}.id]`, `${pe.labels[1]}: its A record goes in the lab's zone`);
  }
  const [link, ...more] = resources(l, "azurerm_private_dns_zone_virtual_network_link");
  assert.equal(more.length, 0, "one link, to the lab VNet");
  assert.equal(attr(link.body, "private_dns_zone_name"), `azurerm_private_dns_zone.${zone.labels[1]}.name`);
  assert.equal(attr(link.body, "virtual_network_id"), "azurerm_virtual_network.lab.id");
  assert.equal(attr(link.body, "registration_enabled"), "false");
  // The pipeline links the zone to vnet-wg while peered; the gateway's dnsmasq already forwards database.windows.net.
  assert.equal(l.yaml.connectivity.dns_link, true);
  assert.equal(l.yaml.connectivity.peering, "optional");
  assert.equal(l.yaml.connectivity.subnets_used, 1);
  assert.ok(!l.blocks.some((b) => b.kind === "variable" && ["gateway_vnet_id", "peered"].includes(b.labels[0])), "no gateway_vnet_id or peered variable");
  assert.doesNotMatch(code(l), /gateway_vnet_id|vnet-wg|rg-wg/);
  assert.equal(attr(output(l, "peer_vnet_id").body, "value"), "azurerm_virtual_network.lab.id");
  const ips = output(l, "private_ips").body;
  for (const pe of pes) assert.match(ips, new RegExp(`azurerm_private_endpoint\\.${pe.labels[1]}\\.private_service_connection\\[0\\]\\.private_ip_address`));
  assert.match(l.readme, /privatelink\.database\.windows\.net/);
  assert.match(l.readme, /tunnel/i);
});

test(`${L23}: variables.tf refuses a secondary region equal to the region`, () => {
  const l = lab(L23);
  const v = variable(l, "secondary_region");
  assert.match(v, /validation \{ condition = var\.secondary_region != "" && var\.secondary_region != var\.region error_message = "[^"]+" \}/);
  // The secondary group and server are in it; nothing else names a region.
  assert.equal(attr(res(l, "azurerm_resource_group", "secondary").body, "location"), "var.secondary_region");
  assert.equal((code(l).match(/var\.secondary_region/g) ?? []).length, 1, "only rg-lab-<id>-secondary reads var.secondary_region; its resources take its location");
  assert.doesNotMatch(code(l), /"(uksouth|ukwest)"/, "no literal regions");
});

test(`${L23}: the two Basic databases are priced from the feed, the geo-secondary in the secondary region`, () => {
  const { cost } = lab(L23).yaml;
  const primary = cost.items.filter((i) => i.retail?.meter === "B DTU");
  assert.equal(primary.length, 1);
  assert.equal(primary[0].retail.unit, "1/Day");
  assert.equal(primary[0].region, undefined, "the primary is in the session's region");
  const geo = cost.items.filter((i) => i.retail?.meter === "B Secondary Active DTU");
  assert.equal(geo.length, 1);
  assert.equal(geo[0].retail.unit, "1/Day");
  assert.equal(geo[0].region, "secondary", "priced at the ukwest rate");
  // Two endpoints and the zone, authored (Private Link is priced in region Global; zones are tiered).
  assert.equal(cost.items.filter((i) => /private endpoint/i.test(i.name)).reduce((n, i) => n + (i.qty ?? 1), 0), 2);
  for (const i of cost.items.filter((x) => /private endpoint|DNS zone/i.test(x.name))) assert.equal(i.retail, undefined, `${i.name} is authored`);
});

test(`${L23}: the readme says to deploy in uksouth with ukwest as its pair, what rg-lab-<id>-secondary holds, and how failover leaves Terraform`, () => {
  const r = lab(L23).readme;
  assert.match(r, /UK South[^\n]*UK West|uksouth[^\n]*ukwest/);
  assert.match(r, /`rg-lab-az305-23-sql-failover-secondary`/);
  assert.match(r, /secondary server/i);
  assert.match(r, /`scratch`/);
  // After a failover the roles are swapped; tear-down deletes the group, then the links (ruling 31).
  assert.match(r, /[Ff]ail back|tear-down[^\n]*failed over|failed over[^\n]*tear-down/);
  assert.match(r, /vCore/);
});
