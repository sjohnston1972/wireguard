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
//   realisticPlan({ resources, data, providers, variables })
//     resources: [{ address, values, refs?, unknown?, sensitive?, importing?, actions?, count?, forEach? }]
//       address    may carry an instance key, azurerm_subnet.s[0] or azurerm_subnet.s["web"]
//                  (count or for_each): each instance is its own planned resource
//                  and change (with "index"), and the configuration has one
//                  entry per resource block, as Terraform prints it
//       values     what the plan knows (nested blocks as arrays of objects)
//       refs       { "attr" or "block.0.attr": [references] } as in the configuration
//       unknown    ["attr" or "block.0.attr"]: known only after apply (built from unknowns)
//       sensitive  ["attr"]
//       count      the block's count (a number), printed as count_expression
//       forEach    the block's for_each as Terraform prints it: { references: [...] }
//                  or { constant_value: {...} } (for_each_expression)
//                  Terraform 1.14 prints a reference through an instance key it
//                  works out from count or for_each, such as
//                  azurerm_network_interface.web[count.index].id, as the
//                  resource and the key: ["azurerm_network_interface.web", "count.index"]
//     data: [{ address, values, refs? }] data sources read at plan (prior_state)
//
//   withAfterUnknown(plan)   adds resource_changes with real after_unknown to an
//                            older fixture plan that only has planned_values

import { readFileSync } from "node:fs";

export const COMPUTED = JSON.parse(readFileSync(new URL("./computed.json", import.meta.url), "utf8"));

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
  // An unknown value is not in the planned values; its place is held so the schema does not count it as unset.
  const held = structuredClone(values);
  for (const p of unknown) setPath(held, p, "(unknown)");
  for (const p of Object.keys(def.refs ?? {}).map(split)) if (p.length === 1 && !(p[0] in held)) held[p[0]] = "(from config)";
  for (const p of unknown) deletePath(values, p);
  const au = unknownFor(held, tree);
  for (const p of unknown) setPath(au, p, true);
  const expressions = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expressionFor(v)]));
  for (const p of unknown) if (!(p[0] in expressions)) expressions[p[0]] = typeof p[1] === "number" ? [] : {};
  for (const [path, refs] of Object.entries(def.refs ?? {})) setPath(expressions, split(path), { references: refs });
  const sensitive = Object.fromEntries((def.sensitive ?? []).map((k) => [k, true]));
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
