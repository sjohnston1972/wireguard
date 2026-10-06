// scripts/test/fixtures/labs/plans/realistic.mjs
//
// Plain English: builds `terraform show -json` plans the way Terraform really
// prints them for a first deploy, from a short hand-written description of a
// lab's resources. The part that matters most is after_unknown: Terraform
// marks as "known after apply" every attribute the provider computes and the
// configuration leaves unset (computed.json, from the real provider schemas),
// and every attribute built from another resource's unknown value (an id, an
// object id). Two real labs were refused at plan because the old hand-made
// fixtures left these out (lab 6's group mail_nickname, lab 3's management
// group subscription_ids).
//
// Batch 3's release tests recorded real plan shapes (shapes/*.json) and
// taught it three more things a plan does: it marks every attribute the
// provider schema calls sensitive, set or not (computed.json's "sensitive");
// it marks an Optional and Computed block the configuration leaves unset as
// wholly unknown (UNSET_BLOCKS_UNKNOWN: a schema cannot say which blocks
// those are); and it knows some computed attributes at plan, the defaults a
// provider fills in (PLAN_DEFAULTS). It also leaves a dynamic block out of
// the configuration's expressions while its values are planned.
//
//   realisticPlan({ resources, data, providers, variables })
//     resources: [{ address, values, refs?, unknown?, sensitive?, dynamic?, importing?, actions?, count?, forEach? }]
//       address    may carry an instance key, azurerm_subnet.s[0] or azurerm_subnet.s["web"]
//                  (count or for_each): each instance is its own planned resource
//                  and change (with "index"), and the configuration has one
//                  entry per resource block, as Terraform prints it
//       values     what the plan knows (nested blocks as arrays of objects)
//       refs       { "attr" or "block.0.attr": [references] } as in the configuration
//       unknown    ["attr" or "block.0.attr"]: known only after apply (built from unknowns)
//       sensitive  ["attr"], beyond what the schema marks sensitive (it marks those itself)
//       dynamic    ["block"]: blocks main.tf writes as dynamic "block" {}: their values are
//                  planned, but the configuration has no expressions for them (no references)
//       count      the block's count (a number), printed as count_expression
//       forEach    the block's for_each as Terraform prints it: { references: [...] }
//                  or { constant_value: {...} } (for_each_expression)
//                  Terraform 1.14 prints a reference through an instance key it
//                  works out from count or for_each, such as
//                  azurerm_network_interface.web[count.index].id, as the
//                  resource and the key: ["azurerm_network_interface.web", "count.index"]
//     data: [{ address, values, refs?, args? }] data sources read at plan (prior_state); values are
//                  what was read, and only refs and the constant arguments named in args are in the
//                  configuration's expressions (data "azurerm_subscription" "current" {} has none)
//
//   withAfterUnknown(plan)   adds resource_changes with real after_unknown to an
//                            older fixture plan that only has planned_values

import { readFileSync } from "node:fs";

export const COMPUTED = JSON.parse(readFileSync(new URL("./computed.json", import.meta.url), "utf8"));
/** { "<type>": { rg, tags } }: whether a resource type takes resource_group_name and tags (extract-computed.mjs writes it). */
export const SCHEMA_FACTS = JSON.parse(readFileSync(new URL("./schema-facts.json", import.meta.url), "utf8"));

/**
 * Blocks a provider plans as wholly unknown when the configuration leaves them unset (SDKv2 blocks that are
 * Optional and Computed). The provider schema has no "computed" on a block, so these are as the release tests'
 * real plans recorded them (shapes/*.json; azurerm 4.81.0, 2026-10-06). A type not listed here may have some
 * too: its first recorded shape will say, and the shape test fails until they are added.
 */
export const UNSET_BLOCKS_UNKNOWN = {
  azurerm_cosmosdb_account: ["analytical_storage", "backup", "capacity"],
  azurerm_cosmosdb_sql_container: ["conflict_resolution_policy", "indexing_policy"],
  azurerm_dns_zone: ["soa_record"],
  azurerm_key_vault: ["contact", "network_acls"],
  azurerm_linux_virtual_machine: ["termination_notification"],
  azurerm_monitor_diagnostic_setting: ["enabled_metric", "metric"],
  azurerm_mssql_database: ["long_term_retention_policy", "short_term_retention_policy", "threat_detection_policy"],
  azurerm_private_dns_zone: ["soa_record"],
  azurerm_virtual_hub_connection: ["routing"],
  azurerm_virtual_network_gateway: ["bgp_settings"],
  azurerm_storage_account: ["blob_properties", "network_rules", "queue_properties", "routing", "share_properties", "static_website"],
};

/**
 * Computed attributes a provider already knows at plan when the configuration leaves them unset: the defaults it
 * fills in. Known (in the planned values, not in after_unknown) and not configured (no expression). As the real
 * plans recorded them: lab 21's workspace, lab 22's random passwords, lab 42's WAF policy (hashicorp/random 3.9.1's defaults).
 */
export const PLAN_DEFAULTS = {
  azurerm_cdn_frontdoor_firewall_policy: { captcha_cookie_expiration_in_minutes: 30, js_challenge_cookie_expiration_in_minutes: 30 },
  azurerm_log_analytics_workspace: { local_authentication_enabled: true },
  random_password: { lower: true, min_lower: 0, min_numeric: 0, min_special: 0, min_upper: 0, number: true, numeric: true, special: true, upper: true },
};

/** after_sensitive for one object (a resource or one nested block): every attribute the schema marks sensitive, set or not. */
function sensitiveFor(values, tree) {
  const out = {};
  for (const a of tree?.sensitive ?? []) out[a] = true;
  for (const [b, sub] of Object.entries(tree?.blocks ?? {})) {
    if (!Array.isArray(values[b])) continue;
    const inner = values[b].map((el) => sensitiveFor(el ?? {}, sub));
    if (inner.some((x) => Object.keys(x).length)) out[b] = inner;
  }
  return out;
}

/** An address's parts: data.TYPE.NAME or TYPE.NAME, with an optional [0] or ["key"] instance key. */
function parseAddress(address) {
  const m = /^(?:data\.)?([a-z0-9_]+)\.([A-Za-z0-9_-]+)(?:\[(\d+|"[^"]*")\])?$/.exec(address);
  if (!m) throw new Error(`not a resource address: ${address}`);
  const index = m[3] === undefined ? undefined : m[3].startsWith('"') ? JSON.parse(m[3]) : Number(m[3]);
  return { type: m[1], name: m[2], index, block: address.replace(/\[[^\]]*\]$/, "") };
}
const typeOf = (address) => parseAddress(address).type;
const nameOf = (address) => parseAddress(address).name;
/** { index } for an instance address, {} otherwise. */
const indexOf = (address) => {
  const { index } = parseAddress(address);
  return index === undefined ? {} : { index };
};
const providerOf = (type) => `registry.terraform.io/hashicorp/${type.split("_")[0]}`;
const split = (path) => path.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));

function setPath(obj, path, value) {
  let o = obj;
  path.forEach((k, i) => {
    if (i === path.length - 1) o[k] = value;
    else {
      if (o[k] == null || typeof o[k] !== "object") o[k] = typeof path[i + 1] === "number" ? [] : {};
      o = o[k];
    }
  });
}

function deletePath(obj, path) {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (o == null || typeof o !== "object") return;
    o = o[k];
  }
  if (o && typeof o === "object") delete o[path.at(-1)];
}

/** after_unknown for one object (a resource or one nested block) against its schema tree. */
function unknownFor(values, tree) {
  const au = {};
  for (const a of tree?.attrs ?? []) if (!(a in values)) au[a] = true;
  for (const [b, sub] of Object.entries(tree?.blocks ?? {})) {
    if (Array.isArray(values[b])) au[b] = values[b].map((el) => unknownFor(el ?? {}, sub));
  }
  return au;
}

/** The configuration's expression for a known value: constant_value leaves, nested blocks as arrays. */
function expressionFor(v) {
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) return v.map((x) => Object.fromEntries(Object.entries(x).map(([k, y]) => [k, expressionFor(y)])));
  return { constant_value: v };
}

function resourceParts(def, mode) {
  const type = typeOf(def.address);
  const tree = COMPUTED.types[mode === "data" ? `data.${type}` : type];
  if (!tree && (type.startsWith("azurerm_") || type.startsWith("azuread_"))) throw new Error(`computed.json has no ${type}: add it to extract-computed.mjs`);
  const values = structuredClone(def.values ?? {});
  const unknown = (def.unknown ?? []).map(split);
  const dynamic = new Set(def.dynamic ?? []);
  for (const path of Object.keys(def.refs ?? {})) if (dynamic.has(split(path)[0])) throw new Error(`${def.address}: ${path} is in a dynamic block, which a plan's configuration leaves out: give it no refs`);
  // An unknown value is not in the planned values; its place is held so the schema does not count it as unset.
  const held = structuredClone(values);
  for (const p of unknown) setPath(held, p, "(unknown)");
  for (const p of Object.keys(def.refs ?? {}).map(split)) if (p.length === 1 && !(p[0] in held)) held[p[0]] = "(from config)";
  for (const p of unknown) deletePath(values, p);
  // Defaults the provider fills in at plan: known, planned, never configured.
  const defaults = mode === "data" ? {} : Object.fromEntries(Object.entries(PLAN_DEFAULTS[type] ?? {}).filter(([k]) => !(k in held)));
  const au = unknownFor({ ...held, ...defaults }, tree);
  for (const p of unknown) setPath(au, p, true);
  // An Optional and Computed block left unset: the provider plans the whole block as unknown.
  if (mode !== "data") for (const b of UNSET_BLOCKS_UNKNOWN[type] ?? []) if (!(b in held)) au[b] = true;
  // A data source's values are what it read, not what the configuration set: `data "azurerm_subscription" "current" {}`
  // has no expressions at all. Only its refs, and any constant arguments it lists in `args`, are configured.
  const configuredValues = mode === "data" ? Object.entries(values).filter(([k]) => (def.args ?? []).includes(k)) : Object.entries(values);
  const expressions = Object.fromEntries(configuredValues.filter(([k]) => !dynamic.has(k)).map(([k, v]) => [k, expressionFor(v)]));
  for (const p of unknown) if (!(p[0] in expressions) && !dynamic.has(p[0])) expressions[p[0]] = typeof p[1] === "number" ? [] : {};
  for (const [path, refs] of Object.entries(def.refs ?? {})) setPath(expressions, split(path), { references: refs });
  Object.assign(values, defaults);
  // Every attribute the schema marks sensitive, set or not, and any the description adds.
  const sensitive = mode === "data" ? {} : sensitiveFor(values, tree);
  for (const p of (def.sensitive ?? []).map(split)) setPath(sensitive, p, true);
  return { type, values, au, expressions, sensitive };
}

export function realisticPlan({ resources = [], data = [], providers = ["azurerm"], variables = {} }) {
  const planned = [];
  const changes = [];
  const config = [];
  // One configuration entry per resource block, however many instances it has.
  const blocks = new Set();
  const configure = (def, entry) => {
    const block = parseAddress(def.address).block;
    if (blocks.has(block)) return;
    blocks.add(block);
    config.push({ address: block, ...entry });
  };
  for (const def of resources) {
    const { type, values, au, expressions, sensitive } = resourceParts(def, "managed");
    const common = { address: def.address, mode: "managed", type, name: nameOf(def.address), ...indexOf(def.address), provider_name: providerOf(type) };
    planned.push({ ...common, schema_version: 0, values, sensitive_values: sensitive });
    const change = { actions: def.actions ?? ["create"], before: def.importing ? {} : null, after: values, after_unknown: au, before_sensitive: false, after_sensitive: sensitive };
    if (def.importing) change.importing = def.importing;
    changes.push({ ...common, change });
    const repeat = { ...(def.count !== undefined ? { count_expression: { constant_value: def.count } } : {}), ...(def.forEach ? { for_each_expression: def.forEach } : {}) };
    configure(def, { mode: "managed", type, name: common.name, provider_config_key: type.split("_")[0], expressions, schema_version: 0, ...repeat });
  }
  const read = [];
  for (const def of data) {
    const { type, values, expressions } = resourceParts(def, "data");
    read.push({ address: def.address, mode: "data", type, name: nameOf(def.address), ...indexOf(def.address), provider_name: providerOf(type), schema_version: 0, values, sensitive_values: {} });
    configure(def, { mode: "data", type, name: nameOf(def.address), provider_config_key: type.split("_")[0], expressions, schema_version: 0 });
  }
  return {
    format_version: "1.2",
    terraform_version: "1.14.6",
    variables: Object.fromEntries(Object.entries(variables).map(([k, value]) => [k, { value }])),
    planned_values: { root_module: { resources: planned } },
    resource_changes: changes,
    prior_state: { format_version: "1.0", terraform_version: "1.14.6", values: { root_module: { resources: read } } },
    configuration: {
      provider_config: Object.fromEntries(providers.map((p) => [p, { name: p, full_name: `registry.terraform.io/hashicorp/${p}`, ...(p === "azurerm" ? { expressions: { features: [{}] } } : {}) }])),
      root_module: { resources: config },
    },
    timestamp: "2026-10-05T09:00:00Z",
    applyable: true,
    complete: true,
    errored: false,
  };
}

/** An older fixture plan (planned_values and configuration only), with resource_changes as Terraform prints them. */
export function withAfterUnknown(plan) {
  const out = structuredClone(plan);
  const have = new Set((out.resource_changes ?? []).map((c) => c.address));
  const cfg = new Map((out.configuration?.root_module?.resources ?? []).map((r) => [r.address, r]));
  out.resource_changes = [...(out.resource_changes ?? [])];
  for (const r of out.planned_values?.root_module?.resources ?? []) {
    if (have.has(r.address) || r.mode === "data") continue;
    const tree = COMPUTED.types[r.type];
    const held = { ...(r.values ?? {}) };
    for (const k of Object.keys(cfg.get(r.address.replace(/\[[^\]]*\]/g, ""))?.expressions ?? {})) if (!(k in held)) held[k] = "(from config)";
    const au = unknownFor(held, tree);
    // A configured attribute missing from the planned values is one Terraform cannot know yet.
    for (const k of Object.keys(held)) if (!(k in (r.values ?? {}))) au[k] = true;
    out.resource_changes.push({ address: r.address, mode: r.mode ?? "managed", type: r.type, name: r.name, provider_name: r.provider_name, change: { actions: ["create"], before: null, after: r.values ?? {}, after_unknown: au, before_sensitive: false, after_sensitive: r.sensitive_values ?? {} } });
  }
  return out;
}
