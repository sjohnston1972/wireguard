// labs-az305-three-tier.test.mjs
//
// Plain English: lab 28, the three-tier app (AZ-305 batch 4; spec §17,
// ruling 41), checked without touching Azure. It runs the shared content
// suite (fixtures/labs/content.mjs), then its own tests: Front Door Standard
// with a WAF policy of custom rules in front of a web tier Container App
// that answers only Front Door; an app tier Container App with internal
// ingress only; an Azure SQL Basic database with public access off, reached
// through one private endpoint; a workload-profiles Container Apps
// environment in a lab subnet whose infrastructure group is
// rg-lab-<id>-infra; no App Service, no vCore, nothing secret in outputs;
// and prices that say what Azure charges. init, validate and the mock plan
// are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";

const TT = "az305-28-three-tier";
const IN_LAB = "azurerm_resource_group.lab.name";

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

/** `body` with every nested block's contents taken out, so attr() reads only top-level arguments. */
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

/** The env blocks of a container: { NAME: { value?, secret_name? } }. */
const envOf = (container) => Object.fromEntries(allNested(container, "env").map((e) => [attr(e, "name")?.replace(/"/g, ""), { value: attr(e, "value"), secret_name: attr(e, "secret_name") }]));

/** Sum of a Container App's containers' cpu and memory (Gi). */
function sizing(app) {
  const cs = allNested(nested(app.body, "template"), "container");
  return { cpu: cs.reduce((n, c) => n + Number(attr(c, "cpu")), 0), mem: cs.reduce((n, c) => n + Number(attr(c, "memory").replace(/"|Gi/g, "")), 0), count: cs.length };
}

labContentSuite(TT, { marker: "££" });

// ── The Container Apps environment ──────────────────────────────────────────

test(`${TT}: one workload-profiles environment (Consumption profile only) in a delegated lab subnet, its infrastructure group rg-lab-<id>-infra`, () => {
  const l = lab(TT);
  const env = one(l, "azurerm_container_app_environment");
  const b = env.body;
  assert.equal(attr(b, "resource_group_name"), IN_LAB);
  assert.equal(attr(b, "infrastructure_subnet_id"), "azurerm_subnet.apps.id", "in the lab's own subnet: the app tier must reach the private endpoint");
  // Ruling 41 (and ruling 7's rule): Azure names the platform's group after the lab, so the sweep finds it.
  assert.equal(attr(b, "infrastructure_resource_group_name"), '"${var.resource_group_name}-infra"');
  assert.equal(attr(b, "internal_load_balancer_enabled"), "false", "external: Front Door Standard reaches the web tier over the internet");
  assert.equal(attr(b, "zone_redundancy_enabled"), "false");
  const profiles = allNested(b, "workload_profile");
  assert.equal(profiles.length, 1, "one workload profile");
  assert.equal(attr(profiles[0], "name"), '"Consumption"');
  assert.equal(attr(profiles[0], "workload_profile_type"), '"Consumption"', "no Dedicated profile: no plan management fee");
  assert.equal(attr(b, "log_analytics_workspace_id"), undefined, "no workspace to pay for");
  // The subnet: a /24 of the slot's first /20, delegated to Microsoft.App/environments, outbound on (image pulls).
  const s = byName(l, "azurerm_subnet", "apps").body;
  assert.equal(attr(s, "address_prefixes"), "[local.apps_cidr]");
  assert.equal(attr(s, "default_outbound_access_enabled"), "true", "a delegated service subnet keeps default outbound (ruling 57): images come from MCR");
  const d = nested(s, "service_delegation");
  assert.equal(attr(d, "name"), '"Microsoft.App/environments"');
  assert.deepEqual(strings(attr(d, "actions")), ["Microsoft.Network/virtualNetworks/subnets/join/action"]);
  // No consumption-only environment beside it, and no environment storage, certificate or Dapr component.
  assert.deepEqual(resources(l).map((r) => r.labels[0]).filter((t) => /^azurerm_container_app_environment_/.test(t)), []);
});

test(`${TT}: the scope check refuses the environment without its named infrastructure group`, () => {
  const { plan, ...description } = LAB_PLANS[TT];
  assert.deepEqual(checkPlan(plan, TT), [], "the realistic plan passes");
  const bad = structuredClone(description);
  const env = bad.resources.find((r) => r.address === "azurerm_container_app_environment.lab");
  delete env.values.infrastructure_resource_group_name;
  delete env.refs.infrastructure_resource_group_name;
  const problems = checkPlan(realisticPlan(bad), TT);
  assert.ok(problems.some((p) => p.rule === "azure-made-group"), JSON.stringify(problems));
});

// ── The web tier ────────────────────────────────────────────────────────────

test(`${TT}: the web tier has public HTTPS ingress, scales to zero and answers only requests carrying this Front Door profile's id`, () => {
  const l = lab(TT);
  const web = byName(l, "azurerm_container_app", "web");
  const b = web.body;
  assert.equal(top(b, "name"), '"ca-web"');
  assert.equal(top(b, "container_app_environment_id"), "azurerm_container_app_environment.lab.id");
  assert.equal(top(b, "workload_profile_name"), '"Consumption"');
  assert.equal(top(b, "revision_mode"), '"Single"');
  const ing = nested(b, "ingress");
  assert.equal(attr(ing, "external_enabled"), "true", "Front Door Standard has no Private Link origin: the web tier is public by nature (ruling 50)");
  assert.equal(attr(ing, "allow_insecure_connections"), "false", "HTTPS only; plain HTTP is redirected");
  assert.equal(attr(ing, "target_port"), "8080");
  const t = nested(b, "template");
  assert.equal(attr(t, "min_replicas"), "0", "no replicas, no charge, until Front Door sends a request");
  assert.equal(attr(t, "max_replicas"), "1");
  const c = nested(t, "container");
  const env = envOf(c);
  assert.equal(env.FRONT_DOOR_ID?.value, "azurerm_cdn_frontdoor_profile.lab.resource_guid", "the X-Azure-FDID it accepts is this profile's");
  assert.equal(env.APP_URL?.value, '"http://ca-app"', "it calls the app tier by name, inside the environment");
  assert.equal(attr(c, "command"), '["python3", "-c", file("${path.module}/web.py")]');
  const py = readFileSync(join(l.tfDir, "web.py"), "utf8");
  assert.match(py, /X-Azure-FDID/);
  assert.match(py, /403/);
  assert.match(py, /urlopen\(APP/);
  assert.match(py, /8080/);
  assert.deepEqual(sizing(web), { cpu: 0.25, mem: 0.5, count: 1 });
});

// ── The app tier ────────────────────────────────────────────────────────────

test(`${TT}: the app tier has internal ingress only, one replica always, an API container and a sqlcmd sidecar sharing an EmptyDir volume`, () => {
  const l = lab(TT);
  const app = byName(l, "azurerm_container_app", "app");
  const b = app.body;
  assert.equal(top(b, "name"), '"ca-app"');
  assert.equal(top(b, "container_app_environment_id"), "azurerm_container_app_environment.lab.id");
  assert.equal(top(b, "workload_profile_name"), '"Consumption"');
  const ing = nested(b, "ingress");
  assert.equal(attr(ing, "external_enabled"), "false", "internal: only apps in the environment (and its VNet) reach it");
  assert.equal(attr(ing, "allow_insecure_connections"), "true", "the web tier calls http://ca-app inside the environment");
  assert.equal(attr(ing, "target_port"), "8080");
  const t = nested(b, "template");
  assert.equal(attr(t, "min_replicas"), "1", "always one replica, so the sidecar keeps querying and az containerapp exec has somewhere to go");
  assert.equal(attr(t, "max_replicas"), "1");
  const vol = nested(t, "volume");
  assert.equal(attr(vol, "name"), '"shared"');
  assert.equal(attr(vol, "storage_type"), '"EmptyDir"');
  const cs = allNested(t, "container");
  const names = cs.map((c) => attr(c, "name"));
  assert.deepEqual(names, ['"api"', '"sqltools"']);
  for (const c of cs) {
    const m = nested(c, "volume_mounts");
    assert.equal(attr(m, "name"), '"shared"');
    assert.equal(attr(m, "path"), '"/shared"');
  }
  const [api, tools] = cs;
  assert.equal(attr(api, "command"), '["python3", "-c", file("${path.module}/app.py")]');
  assert.equal(envOf(api).SQL_SERVER?.value, "azurerm_mssql_server.lab.fully_qualified_domain_name");
  assert.equal(attr(tools, "image"), '"mcr.microsoft.com/mssql/server:2022-latest"', "the SQL Server image only for its sqlcmd: the server itself never starts");
  assert.equal(attr(tools, "command"), '["/bin/bash", "-c", file("${path.module}/sqltools.sh")]');
  const env = envOf(tools);
  assert.equal(env.SQLCMDSERVER?.value, "azurerm_mssql_server.lab.fully_qualified_domain_name");
  assert.equal(env.SQLCMDUSER?.value, '"labadmin"');
  assert.equal(env.SQLCMDDBNAME?.value, '"appdb"');
  assert.deepEqual(env.SQLCMDPASSWORD, { value: undefined, secret_name: '"sql-password"' }, "the password reaches the container only as a secret reference");
  const sh = readFileSync(join(l.tfDir, "sqltools.sh"), "utf8");
  assert.match(sh, /mssql-tools18/);
  assert.match(sh, /\/shared\/db\.txt/);
  assert.match(sh, /sleep 60/);
  assert.doesNotMatch(sh, /sqlservr/, "the database engine in the image is never started");
  const py = readFileSync(join(l.tfDir, "app.py"), "utf8");
  assert.match(py, /gethostbyname/);
  assert.match(py, /1433/);
  assert.match(py, /\/shared\/db\.txt/);
  // 0.25 vCPU and 0.5 Gi each: 0.5 vCPU and 1 Gi in all, a combination the Consumption profile allows.
  assert.deepEqual(sizing(app), { cpu: 0.5, mem: 1, count: 2 });
});

test(`${TT}: the SQL password is a Container Apps secret, and no output, env value or image argument carries it`, () => {
  const l = lab(TT);
  const app = byName(l, "azurerm_container_app", "app");
  const secrets = allNested(app.body, "secret");
  assert.equal(secrets.length, 1);
  assert.equal(attr(secrets[0], "name"), '"sql-password"');
  assert.equal(attr(secrets[0], "value"), "var.admin_password");
  // Only the server and the secret read the password.
  const all = uncomment(Object.values(l.files).join("\n"));
  const uses = [...all.matchAll(/^\s*([a-z_]+)\s*=\s*var\.admin_password\b/gm)].map((m) => m[1]).sort();
  assert.deepEqual(uses, ["administrator_login_password", "value"]);
  const web = byName(l, "azurerm_container_app", "web");
  assert.equal(allNested(web.body, "secret").length, 0, "the web tier holds no secret");
  const outs = uncomment(l.files["outputs.tf"]);
  assert.doesNotMatch(outs, /admin_password|\bsecret\b|administrator_login_password|connection_string/i);
  assert.doesNotMatch(outs, /sensitive\s*=/);
});

test(`${TT}: every container image comes from mcr.microsoft.com`, () => {
  const l = lab(TT);
  const images = resources(l, "azurerm_container_app").flatMap((a) => allNested(a.body, "container").map((c) => attr(c, "image")));
  assert.equal(images.length, 3);
  for (const i of images) assert.match(i, /^"mcr\.microsoft\.com\//, i);
  assert.equal(resources(l, "azurerm_container_registry").length, 0, "no registry: nothing to pull from but MCR");
});

// ── The data tier ───────────────────────────────────────────────────────────

test(`${TT}: one Basic (DTU) database on a server with public network access off, reached by one private endpoint and its private DNS zone`, () => {
  const l = lab(TT);
  const srv = one(l, "azurerm_mssql_server").body;
  assert.equal(attr(srv, "name"), '"${var.name_prefix}-sql"');
  assert.equal(attr(srv, "administrator_login"), '"labadmin"');
  assert.equal(attr(srv, "public_network_access_enabled"), "false", "only the private endpoint reaches it");
  assert.equal(attr(srv, "minimum_tls_version"), '"1.2"');
  assert.equal(resources(l, "azurerm_mssql_firewall_rule").length, 0);
  const db = one(l, "azurerm_mssql_database").body;
  assert.equal(attr(db, "name"), '"appdb"');
  assert.equal(attr(db, "server_id"), "azurerm_mssql_server.lab.id");
  // uksouth's vCore quota is 0 (ruling 24): DTU Basic, never GP_/BC_/HS_.
  assert.equal(attr(db, "sku_name"), '"Basic"');
  const pe = one(l, "azurerm_private_endpoint").body;
  assert.equal(attr(pe, "subnet_id"), "azurerm_subnet.endpoints.id");
  const psc = nested(pe, "private_service_connection");
  assert.equal(attr(psc, "private_connection_resource_id"), "azurerm_mssql_server.lab.id");
  assert.deepEqual(strings(attr(psc, "subresource_names")), ["sqlServer"]);
  assert.equal(attr(psc, "is_manual_connection"), "false");
  assert.equal(attr(nested(pe, "private_dns_zone_group"), "private_dns_zone_ids"), "[azurerm_private_dns_zone.sql.id]");
  const zone = one(l, "azurerm_private_dns_zone").body;
  assert.equal(attr(zone, "name"), '"privatelink.database.windows.net"');
  const link = one(l, "azurerm_private_dns_zone_virtual_network_link").body;
  assert.equal(attr(link, "virtual_network_id"), "azurerm_virtual_network.lab.id", "linked to the VNet the environment lives in");
  assert.equal(attr(link, "registration_enabled"), "false");
  const s = byName(l, "azurerm_subnet", "endpoints").body;
  assert.equal(attr(s, "address_prefixes"), "[local.endpoints_cidr]");
  assert.equal(attr(s, "default_outbound_access_enabled"), "false", "nothing in the endpoints' subnet needs the internet (ruling 57)");
});

test(`${TT}: the VNet is the slot's first /20, the environment's subnet its first /24 and the endpoints' its second`, () => {
  const l = lab(TT);
  const all = uncomment(l.files["main.tf"]).replace(/\s+/g, " ");
  assert.match(all, /vnet_cidr = cidrsubnet\(var\.address_space, 2, 0\)/);
  assert.match(all, /apps_cidr = cidrsubnet\(local\.vnet_cidr, 4, 0\)/);
  assert.match(all, /endpoints_cidr = cidrsubnet\(local\.vnet_cidr, 4, 1\)/);
  assert.equal(attr(one(l, "azurerm_virtual_network").body, "address_space"), "[local.vnet_cidr]");
});

// ── Front Door and the WAF ──────────────────────────────────────────────────

test(`${TT}: Front Door Standard with one origin, the web tier over HTTPS with its own host name, and no health probe`, () => {
  const l = lab(TT);
  const p = one(l, "azurerm_cdn_frontdoor_profile");
  const profileId = `azurerm_cdn_frontdoor_profile.${p.labels[1]}.id`;
  assert.equal(attr(p.body, "resource_group_name"), IN_LAB, "global, kept in rg-lab-<id>");
  assert.equal(attr(p.body, "sku_name"), '"Standard_AzureFrontDoor"', "Standard: Premium's base fee is about ten times higher");
  const ep = one(l, "azurerm_cdn_frontdoor_endpoint");
  assert.equal(attr(ep.body, "cdn_frontdoor_profile_id"), profileId);
  const og = one(l, "azurerm_cdn_frontdoor_origin_group");
  assert.equal(attr(og.body, "cdn_frontdoor_profile_id"), profileId);
  assert.equal(nested(og.body, "health_probe"), undefined, "one origin: no probes, so the web tier can scale to zero");
  assert.ok(nested(og.body, "load_balancing") !== undefined);
  const o = one(l, "azurerm_cdn_frontdoor_origin").body;
  assert.equal(attr(o, "host_name"), "azurerm_container_app.web.ingress[0].fqdn");
  assert.equal(attr(o, "origin_host_header"), "azurerm_container_app.web.ingress[0].fqdn", "Container Apps routes by host name");
  assert.equal(attr(o, "https_port"), "443");
  assert.equal(attr(o, "certificate_name_check_enabled"), "true");
  const r = one(l, "azurerm_cdn_frontdoor_route").body;
  assert.equal(attr(r, "cdn_frontdoor_endpoint_id"), `azurerm_cdn_frontdoor_endpoint.${ep.labels[1]}.id`);
  assert.equal(attr(r, "cdn_frontdoor_origin_group_id"), `azurerm_cdn_frontdoor_origin_group.${og.labels[1]}.id`);
  assert.deepEqual(strings(attr(r, "patterns_to_match")), ["/*"]);
  assert.deepEqual(strings(attr(r, "supported_protocols")).sort(), ["Http", "Https"]);
  assert.equal(attr(r, "forwarding_protocol"), '"HttpsOnly"');
  assert.equal(attr(r, "https_redirect_enabled"), "true");
  assert.equal(nested(r, "cache"), undefined, "no caching: every request reaches the app");
});

test(`${TT}: a Standard WAF policy in Prevention with custom rules only (managed rule sets need Premium), associated with the endpoint`, () => {
  const l = lab(TT);
  const w = one(l, "azurerm_cdn_frontdoor_firewall_policy").body;
  assert.equal(attr(w, "sku_name"), '"Standard_AzureFrontDoor"', "the policy's tier matches the profile's");
  assert.equal(attr(w, "mode"), '"Prevention"');
  assert.equal(attr(w, "enabled"), "true");
  assert.equal(attr(w, "custom_block_response_status_code"), "403");
  assert.equal(nested(w, "managed_rule"), undefined, "Front Door Standard takes no managed rule sets (Premium only)");
  const rules = allNested(w, "custom_rule");
  assert.deepEqual(rules.map((r) => attr(r, "name")), ['"BlockAdminPath"', '"RateLimitPerClient"']);
  const [admin, rate] = rules;
  assert.equal(attr(admin, "type"), '"MatchRule"');
  assert.equal(attr(admin, "action"), '"Block"');
  const am = nested(admin, "match_condition");
  assert.equal(attr(am, "match_variable"), '"RequestUri"');
  assert.equal(attr(am, "operator"), '"Contains"');
  assert.deepEqual(strings(attr(am, "match_values")), ["/admin"]);
  assert.deepEqual(strings(attr(am, "transforms")), ["Lowercase"]);
  assert.equal(attr(rate, "type"), '"RateLimitRule"');
  assert.equal(attr(rate, "rate_limit_duration_in_minutes"), "1");
  assert.equal(attr(rate, "rate_limit_threshold"), "100");
  // Azure refuses match values with the Any operator (lab 42's finding): Contains "/" matches every request.
  const rm = nested(rate, "match_condition");
  assert.equal(attr(rm, "operator"), '"Contains"');
  assert.deepEqual(strings(attr(rm, "match_values")), ["/"]);
  const sp = one(l, "azurerm_cdn_frontdoor_security_policy").body;
  assert.equal(attr(sp, "cdn_frontdoor_firewall_policy_id"), "azurerm_cdn_frontdoor_firewall_policy.lab.id");
  assert.equal(attr(sp, "cdn_frontdoor_domain_id"), "azurerm_cdn_frontdoor_endpoint.lab.id");
  assert.deepEqual(strings(attr(sp, "patterns_to_match")), ["/*"]);
});

// ── What it never builds ────────────────────────────────────────────────────

test(`${TT}: no App Service, no vCore database, no public IP of its own and no peering`, () => {
  const l = lab(TT);
  const types = resources(l).map((r) => r.labels[0]);
  // Ruling 41: App Service quota is 0 in this subscription.
  assert.deepEqual(types.filter((t) => /service_plan|web_app|app_service|function_app/.test(t)), []);
  assert.doesNotMatch(uncomment(l.files["main.tf"]), /"(GP|BC|HS)_/, "no vCore SKU (uksouth vCore quota is 0)");
  assert.equal(resources(l, "azurerm_public_ip").length, 0, "the environment's public IPs are Azure's, in rg-lab-<id>-infra");
  assert.deepEqual(l.yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 1 });
  assert.ok(!outputs(l).includes("peer_vnet_id"));
});

test(`${TT}: connect names Front Door, the refused direct URL, the WAF's blocked path and the exec into the sidecar; private_ips the endpoint`, () => {
  const l = lab(TT);
  const connect = l.blocks.find((b) => b.kind === "output" && b.labels[0] === "connect")?.body ?? "";
  assert.ok(connect.includes("https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}"));
  assert.ok(connect.includes("https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}/admin"));
  assert.ok(connect.includes("https://${azurerm_container_app.web.ingress[0].fqdn}"));
  assert.ok(connect.includes("az containerapp exec"));
  assert.ok(connect.includes("--container sqltools"));
  const ips = l.blocks.find((b) => b.kind === "output" && b.labels[0] === "private_ips")?.body ?? "";
  assert.match(ips, /"pe-sql"\s*=\s*azurerm_private_endpoint\.sql\.private_service_connection\[0\]\.private_ip_address/);
});

// ── Cost, timing and the readme ─────────────────────────────────────────────

test(`${TT}: priced honestly: Front Door's base fee, the WAF policy and each custom rule, SQL Basic, the endpoint, the environment's IPs and load balancer, the app tier`, () => {
  const l = lab(TT);
  const y = l.yaml;
  const item = (re) => {
    const i = y.cost.items.find((x) => re.test(x.name));
    assert.ok(i, `a cost item matching ${re}`);
    return i;
  };
  const fd = item(/Front Door Standard, base fee/);
  assert.equal(fd.retail, undefined, "authored: priced under region Zone N, no uksouth row (ruling 2)");
  assert.ok(fd.gbp_h >= 26.4161 / 730 - 0.00005, "£26.4161 a month");
  assert.equal(y.cost.pricey, fd.name);
  const policy = item(/WAF policy/);
  assert.ok(policy.gbp_h >= 3.7737 / 730 - 0.00005, "Standard Policy £3.7737 a month");
  const rule = item(/WAF custom rule/);
  assert.ok(rule.gbp_h >= 0.7547 / 730 - 0.00005, "Standard Rule £0.7547 a month each");
  const nRules = allNested(one(l, "azurerm_cdn_frontdoor_firewall_policy").body, "custom_rule").length;
  assert.equal(rule.qty, nRules, "one per custom rule");
  const sql = item(/SQL Database Basic/);
  assert.deepEqual(sql.retail, { meter: "B DTU", unit: "1/Day" }, "the feed refreshes it (lab 23's meter)");
  assert.equal(item(/Private endpoint/).gbp_h, 0.0076);
  item(/Private DNS zone/);
  const ips = item(/public IP/);
  assert.equal(ips.qty, 2, "Learn: one for egress and one for ingress in an external environment");
  item(/load balancer/);
  item(/app tier/);
  assert.deepEqual(y.capacity.vm_sizes, []);
  assert.deepEqual(y.timing, { deploy_min: 15, destroy_min: 20, session_h: 2, max_h: 3 });
  assert.equal(y.regions.secondary, null);
});

test(`${TT}: the readme explains the tiers, the Front Door lock, the WAF tier limits, the infra group and why there is no App Service`, () => {
  const r = lab(TT).readme;
  assert.match(r, /X-Azure-FDID/);
  assert.match(r, /Premium/);
  assert.match(r, /managed rule/i);
  assert.match(r, /`rg-lab-az305-28-three-tier-infra`/);
  assert.match(r, /App Service/);
  assert.match(r, /vCore/);
  assert.match(r, /az containerapp exec/);
  assert.match(r, /base fee[^\n]*hour/i);
  assert.match(r, /## Not built here/);
});
