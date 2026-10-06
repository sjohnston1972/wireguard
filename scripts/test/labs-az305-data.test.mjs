// labs-az305-data.test.mjs
//
// Plain English: the AZ-305 data labs (labs batch 3 plan, area C2: labs 23,
// 24 and 25) checked without touching Azure. Each runs the shared content
// suite (fixtures/labs/content.mjs: catalogue rules, lint, its resource
// groups, peering and subnets, prices, marker, terraform fmt), then the tests
// the plan names for it: what it builds, read from its Terraform text, and
// above all that tear-down can get it back to £0 (no vCore database where
// the quota is 0, a failover group Terraform can take apart, no locked
// immutability). Plans and the scope check are lab-plans.test.mjs's job
// (lab 25 also proves its plan is refused once its policy is locked); init,
// validate and the mocked plan are npm run labs-tf's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";
import { attr, lab, labContentSuite, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";

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

// ── Lab 24: Cosmos DB, partitioning and consistency ──────────────────────

const L24 = "az305-24-cosmos";
labContentSuite(L24, { marker: "£" });

/** A container's partition key: { paths, kind, version } as main.tf writes them. */
const partitionKey = (c) => ({ paths: [...(attr(c.body, "partition_key_paths") ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]), kind: unq(attr(c.body, "partition_key_kind")) || "Hash", version: attr(c.body, "partition_key_version") });

test(`${L24}: a serverless SQL API account in one region with the free tier off`, () => {
  const l = lab(L24);
  const acct = one(l, "azurerm_cosmosdb_account");
  const a = acct.body;
  assert.equal(acct.labels[1], "lab");
  assert.equal(attr(a, "name"), '"${var.name_prefix}-cosmos"');
  assert.equal(attr(a, "resource_group_name"), "azurerm_resource_group.lab.name");
  assert.equal(attr(a, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(a, "kind"), '"GlobalDocumentDB"', "the NoSQL (SQL) API");
  assert.equal(attr(a, "offer_type"), '"Standard"');
  // Serverless: billed per request unit and GB, nothing provisioned (ruling 33).
  assert.deepEqual(allNested(a, "capabilities").map((b) => unq(attr(b, "name"))), ["EnableServerless"]);
  assert.equal(nested(a, "capacity"), undefined, "no account throughput limit: serverless has no provisioned throughput");
  // One region: serverless accounts run in one region only.
  const geo = allNested(a, "geo_location");
  assert.equal(geo.length, 1, "one geo_location");
  assert.equal(attr(geo[0], "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(geo[0], "failover_priority"), "0");
  assert.notEqual(attr(geo[0], "zone_redundant"), "true");
  assert.notEqual(attr(a, "multiple_write_locations_enabled"), "true");
  assert.notEqual(attr(a, "automatic_failover_enabled"), "true");
  // The free tier is one per subscription, and creation fails if it is already taken.
  assert.equal(attr(a, "free_tier_enabled"), "false");
  // Reached over the internet with keys, from the portal's Data Explorer: no network of its own.
  assert.equal(attr(a, "public_network_access_enabled"), "true");
  assert.equal(attr(a, "local_authentication_enabled"), "true", "key authentication on, for Data Explorer and the SDK samples");
  assert.equal(attr(a, "is_virtual_network_filter_enabled"), undefined);
  assert.equal(attr(a, "ip_range_filter"), undefined);
  assert.equal(resources(l, "azurerm_private_endpoint").length + resources(l, "azurerm_virtual_network").length, 0, "no VNet, no private endpoint");
  assert.equal(l.yaml.regions.secondary, null);
  assert.deepEqual(l.yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.match(output(l, "connect").body, /azurerm_cosmosdb_account\.lab\.endpoint/);
});

test(`${L24}: three containers with single, hierarchical and deliberately poor partition keys, and no throughput`, () => {
  const l = lab(L24);
  const db = one(l, "azurerm_cosmosdb_sql_database");
  assert.equal(attr(db.body, "name"), '"shop"');
  assert.equal(attr(db.body, "account_name"), "azurerm_cosmosdb_account.lab.name");
  assert.equal(attr(db.body, "resource_group_name"), "azurerm_resource_group.lab.name");
  const containers = resources(l, "azurerm_cosmosdb_sql_container");
  const byName = Object.fromEntries(containers.map((c) => [unq(attr(c.body, "name")), partitionKey(c)]));
  assert.deepEqual(Object.keys(byName).sort(), ["bykey-status", "events", "orders"]);
  // A single key with many values; a hierarchical key (tenant, then user) past the 20 GB logical partition limit;
  // and a key with a handful of values, the hot-partition example.
  assert.deepEqual(byName.orders, { paths: ["/customerId"], kind: "Hash", version: "2" });
  assert.deepEqual(byName.events, { paths: ["/tenantId", "/userId"], kind: "MultiHash", version: "2" }, "hierarchical keys are MultiHash, version 2");
  assert.deepEqual(byName["bykey-status"], { paths: ["/status"], kind: "Hash", version: "2" });
  for (const c of containers) {
    assert.equal(attr(c.body, "account_name"), "azurerm_cosmosdb_account.lab.name", c.labels[1]);
    assert.equal(attr(c.body, "database_name"), `azurerm_cosmosdb_sql_database.${db.labels[1]}.name`, c.labels[1]);
    assert.equal(attr(c.body, "resource_group_name"), "azurerm_resource_group.lab.name", c.labels[1]);
  }
  // Serverless takes no throughput at all: setting any is refused by Azure.
  for (const b of [db, ...containers]) {
    assert.equal(attr(b.body, "throughput"), undefined, `${b.labels[1]}: no throughput`);
    assert.equal(nested(b.body, "autoscale_settings"), undefined, `${b.labels[1]}: no autoscale`);
  }
  assert.match(l.readme, /hot partition/i);
  assert.match(l.readme, /synthetic/i);
});

test(`${L24}: Session consistency by default`, () => {
  const l = lab(L24);
  const cp = nested(one(l, "azurerm_cosmosdb_account").body, "consistency_policy");
  assert.ok(cp !== undefined, "a consistency_policy block");
  assert.equal(attr(cp, "consistency_level"), '"Session"');
  assert.equal(attr(cp, "max_interval_in_seconds"), undefined, "staleness bounds only go with BoundedStaleness");
  assert.equal(attr(cp, "max_staleness_prefix"), undefined);
  // The readme walks through all five levels.
  for (const level of ["Strong", "Bounded staleness", "Session", "Consistent prefix", "Eventual"]) assert.match(l.readme, new RegExp(level, "i"), level);
});

test(`${L24}: light serverless use is priced authored, and the readme says why serverless refuses a second region`, () => {
  const l = lab(L24);
  // "1M RUs" is priced per 1M, a unit the feed cannot read; "Data Stored" is shared by several Cosmos DB products.
  for (const i of l.yaml.cost.items) assert.equal(i.retail, undefined, `${i.name} is authored`);
  assert.ok(l.yaml.cost.items.some((i) => /RU/.test(i.name)), "a request unit item");
  assert.match(l.readme, /serverless[^\n]*(one|single) region|(one|single) region[^\n]*serverless/i);
  assert.match(l.readme, /free tier/i);
  assert.match(l.readme, /request charge/i);
});

// ── Lab 25: storage design, data lake, immutability, tiering ─────────────

const L25 = "az305-25-storage-design";
labContentSuite(L25, { marker: "£" });

/** Storage types that write through an account's data plane (blob, DFS, file, queue or table endpoints). */
const DATA_PLANE_TYPES = [
  "azurerm_storage_blob",
  "azurerm_storage_data_lake_gen2_filesystem",
  "azurerm_storage_data_lake_gen2_path",
  "azurerm_storage_share",
  "azurerm_storage_share_directory",
  "azurerm_storage_share_file",
  "azurerm_storage_queue",
  "azurerm_storage_table",
  "azurerm_storage_table_entity",
];

/** A management policy's rules: [{ name, prefixes, blobTypes, baseBlob: { setting: days } }]. */
const lifecycleRules = (policy) =>
  allNested(policy.body, "rule").map((r) => {
    const f = nested(r, "filters");
    const bb = nested(nested(r, "actions"), "base_blob") ?? "";
    return {
      name: unq(attr(r, "name")),
      enabled: attr(r, "enabled"),
      prefixes: [...(attr(f, "prefix_match") ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]),
      blobTypes: [...(attr(f, "blob_types") ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]),
      baseBlob: Object.fromEntries([...bb.matchAll(/^\s*([a-z_]+)\s*=\s*(\d+)\s*$/gm)].map((m) => [m[1], Number(m[2])])),
    };
  });

test(`${L25}: an HNS account with raw and curated file systems and a lifecycle to Cool, Cold and Archive`, () => {
  const l = lab(L25);
  const lake = res(l, "azurerm_storage_account", "lake").body;
  assert.equal(attr(lake, "name"), '"${var.name_prefix}lake"');
  assert.equal(attr(lake, "account_kind"), '"StorageV2"');
  assert.equal(attr(lake, "account_tier"), '"Standard"');
  assert.equal(attr(lake, "account_replication_type"), '"LRS"', "LRS: Archive needs LRS, GRS or RA-GRS, and LRS is the cheapest");
  assert.equal(attr(lake, "access_tier"), '"Hot"');
  assert.equal(attr(lake, "is_hns_enabled"), "true", "hierarchical namespace: Data Lake Storage");
  // The file systems are containers made through Resource Manager (management plane).
  const onLake = resources(l, "azurerm_storage_container").filter((c) => attr(c.body, "storage_account_id") === "azurerm_storage_account.lake.id");
  assert.deepEqual(onLake.map((c) => unq(attr(c.body, "name"))).sort(), ["curated", "raw"]);
  for (const c of onLake) assert.equal(attr(c.body, "container_access_type"), '"private"', c.labels[1]);
  // Lifecycle: raw ages Hot -> Cool -> Cold -> Archive; curated is kept a year.
  const policy = one(l, "azurerm_storage_management_policy");
  assert.equal(attr(policy.body, "storage_account_id"), "azurerm_storage_account.lake.id");
  const rules = lifecycleRules(policy);
  const raw = rules.find((r) => r.prefixes.includes("raw/"));
  assert.ok(raw, "a rule for raw/");
  assert.equal(raw.enabled, "true");
  assert.deepEqual(raw.prefixes, ["raw/"]);
  assert.deepEqual(raw.blobTypes, ["blockBlob"]);
  assert.deepEqual(raw.baseBlob, {
    tier_to_cool_after_days_since_modification_greater_than: 30,
    tier_to_cold_after_days_since_modification_greater_than: 90,
    tier_to_archive_after_days_since_modification_greater_than: 180,
  });
  const curated = rules.find((r) => r.prefixes.includes("curated/"));
  assert.ok(curated, "a rule for curated/");
  assert.equal(curated.enabled, "true");
  assert.deepEqual(curated.blobTypes, ["blockBlob"]);
  assert.deepEqual(curated.baseBlob, { delete_after_days_since_modification_greater_than: 365 });
  assert.equal(rules.length, 2, "two rules");
  assert.match(l.readme, /rehydrat/i);
});

test(`${L25}: an RA-GRS account whose evidence container has an unlocked 1-day policy`, () => {
  const l = lab(L25);
  const rec = res(l, "azurerm_storage_account", "records").body;
  assert.equal(attr(rec, "name"), '"${var.name_prefix}rec"');
  assert.equal(attr(rec, "account_kind"), '"StorageV2"');
  assert.equal(attr(rec, "account_replication_type"), '"RAGRS"', "read-access geo-redundant: a readable secondary endpoint");
  assert.notEqual(attr(rec, "is_hns_enabled"), "true");
  assert.deepEqual(resources(l, "azurerm_storage_account").map((a) => a.labels[1]).sort(), ["lake", "records"]);
  const evidence = resources(l, "azurerm_storage_container").filter((c) => attr(c.body, "storage_account_id") === "azurerm_storage_account.records.id");
  assert.deepEqual(evidence.map((c) => unq(attr(c.body, "name"))), ["evidence"]);
  const p = one(l, "azurerm_storage_container_immutability_policy").body;
  assert.equal(attr(p, "storage_container_resource_manager_id"), `azurerm_storage_container.${evidence[0].labels[1]}.id`);
  assert.equal(attr(p, "immutability_period_in_days"), "1", "1 day: the shortest time-based retention");
  // Unlocked (ruling 34): tear-down can delete it; a locked one is refused at plan (immutability rule).
  assert.equal(attr(p, "locked"), "false", "locked = false, said explicitly");
  assert.equal(attr(p, "protected_append_writes_enabled"), "true", "append blobs can still grow");
  assert.notEqual(attr(p, "protected_append_writes_all_enabled"), "true");
  assert.match(output(l, "connect").body, /azurerm_storage_account\.records\.secondary_blob_endpoint/, "connect shows the read-only secondary endpoint");
});

test(`${L25}: the same plan with the policy locked is refused before anything is built`, () => {
  const d = LAB_PLANS[L25];
  assert.deepEqual(checkPlan(d.plan, L25), [], "unlocked: passes");
  const locked = structuredClone(d);
  locked.resources.find((r) => r.address === "azurerm_storage_container_immutability_policy.evidence").values.locked = true;
  const problems = checkPlan(realisticPlan(locked), L25);
  assert.deepEqual(problems.map((p) => [p.rule, p.address]), [["immutability", "azurerm_storage_container_immutability_policy.evidence"]]);
});

test(`${L25}: no SFTP, no public blob access, nothing written through the data plane`, () => {
  const l = lab(L25);
  for (const a of resources(l, "azurerm_storage_account")) {
    const b = a.body;
    assert.equal(attr(b, "sftp_enabled"), "false", `${a.labels[1]}: SFTP off (it bills by the hour)`);
    assert.notEqual(attr(b, "nfsv3_enabled"), "true", `${a.labels[1]}: no NFS`);
    assert.equal(attr(b, "allow_nested_items_to_be_public"), "false", `${a.labels[1]}: no public containers`);
    assert.equal(attr(b, "shared_access_key_enabled"), "true", `${a.labels[1]}: shared key on, for Storage browser and SAS`);
    assert.equal(attr(b, "https_traffic_only_enabled"), "true", a.labels[1]);
    assert.equal(attr(b, "min_tls_version"), '"TLS1_2"', a.labels[1]);
    // No version-level or account-level immutability, and no versioning to lean on.
    assert.equal(nested(b, "immutability_policy"), undefined, `${a.labels[1]}: no account-level immutability`);
    assert.equal(nested(b, "blob_properties"), undefined, `${a.labels[1]}: no blob properties (no versioning), which also keeps Terraform off the blob endpoint`);
  }
  for (const t of DATA_PLANE_TYPES) assert.equal(resources(l, t).length, 0, `no ${t}`);
  for (const c of resources(l, "azurerm_storage_container")) {
    assert.ok(attr(c.body, "storage_account_id"), `${c.labels[1]}: made through Resource Manager (storage_account_id)`);
    assert.equal(attr(c.body, "storage_account_name"), undefined, `${c.labels[1]}: never through the blob endpoint (storage_account_name)`);
  }
  // The provider never calls the data plane, so tear-down works whatever is done to the accounts' networks.
  const storage = nested(features(l), "storage");
  assert.ok(storage !== undefined, "features has a storage block");
  assert.equal(attr(storage, "data_plane_available"), "false");
  assert.equal(l.yaml.connectivity.peering, "off");
  assert.equal(l.yaml.connectivity.subnets_used, 0);
  assert.equal(resources(l, "azurerm_private_endpoint").length, 0);
});

test(`${L25}: the readme says never to lock the policy`, () => {
  const r = lab(L25).readme;
  assert.match(r, /[Nn]ever lock/);
  assert.match(r, /\*\*Lock policy\*\*|lock the policy/i);
  // A legal hold you add is removed by tear-down, as the unlocked policy is.
  assert.match(r, /legal hold/i);
  assert.match(r, /[Tt]ear-down removes[^\n]*legal hold|legal hold[^\n]*[Tt]ear-down removes/);
  assert.match(r, /secondary endpoint/i);
  assert.match(r, /Archive/);
});

test(`${L25}: builds on lab 5: names az104-05-storage as its prerequisite, and is priced as two small accounts`, () => {
  const { yaml } = lab(L25);
  assert.deepEqual(yaml.prerequisites, ["az104-05-storage"]);
  for (const i of yaml.cost.items) assert.equal(i.retail, undefined, `${i.name} is authored`);
  assert.ok(yaml.cost.items.filter((i) => /account/i.test(i.name)).length >= 2, "an item per account");
});

// ── Measured timings (batch 3 plan, Integration step 8) ──────────────────

// The first release tests (docs/labs/release-tests.md, 2026-10-06), rounded up to the next whole
// minute; each change of timing bumps the lab's version. The job timeout is 2 x (deploy + destroy) + 20.
for (const [id, deploy, destroy, measured, timeout] of [
  [L23, 10, 7, "9m 27s and 6m 36s", 54],
  [L24, 4, 11, "3m 27s and 10m 45s", 50],
  [L25, 2, 3, "1m 38s and 2m 33s", 30],
]) {
  test(`${id}: deploy ${deploy} and destroy ${destroy} minutes, the release test's ${measured} rounded up, at version 2`, () => {
    const { timing, version } = lab(id).yaml;
    assert.equal(timing.deploy_min, deploy);
    assert.equal(timing.destroy_min, destroy);
    assert.equal(Math.min(150, 2 * (timing.deploy_min + timing.destroy_min) + 20), timeout, "job timeout");
    assert.ok(version >= 2, "the measured timings bump the version");
  });
}
