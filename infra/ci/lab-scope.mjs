// infra/ci/lab-scope.mjs
//
// Plain English: the lab pipeline's border guard (labs spec §8.4). Before
// anything is built, lab.yml shows it the lab's Terraform plan and it refuses
// the plan if any resource would land, or reach, outside the lab:
//
//   node infra/ci/lab-scope.mjs --plan plan.json --lab <id>   (terraform show -json)
//   node infra/ci/lab-scope.mjs --hcl  lab.json  --lab <id>   (hcl2json of the .tf files; CI's early warning)
//
// Exit 0: every resource stays inside the lab. Exit 1: one "rule: address
// (why)" line per refused resource. Exit 2: bad arguments or unreadable input.
//
// The rules, in the order they are reported (one per resource, the first that
// applies):
//   provider          a provider whose FULL source address is not hashicorp's
//                     azurerm, azuread, random or time on registry.terraform.io
//                     (lab-lint.mjs's list: null, external, http, local, azapi,
//                     terraform_data and look-alikes from elsewhere), or an
//                     azurerm/azuread provider pointed at other credentials
//   provisioner       any provisioner (it would run commands with the pipeline's keys)
//   import            adopting an object that already exists (an import block, or
//                     a plan change that is importing): a lab only ever creates,
//                     and tear-down deletes what it adopted, a real user renamed
//                     lab-<id>-x included
//   gateway           vnet-wg or rg-wg-* named, or var.gateway_vnet_id used,
//                     anywhere but a private DNS zone link's virtual_network_id
//   association       moving a subscription into a management group
//   governance        role/policy definitions and management groups outside the
//                     five governance labs, or without the lab-<id>- prefix
//   entra-type        an Entra object other than a user, a group or a membership
//   entra-prefix      an Entra name, UPN or mail nickname without lab-<id>-, or a
//                     membership of a group the lab did not make
//   role              a role assignment off labs/setup/allowed-roles.json, a custom
//                     role without its fixed GUID, one that can grant access, holds
//                     a wildcard action (only wildcard reads such as */read), or
//                     is assignable anywhere but the lab's own group(s); a policy
//                     definition whose rule lists a roleDefinitionIds entry that is
//                     not a built-in on the allow-list (a remediating policy's
//                     identity gets those roles), or whose rule a plan cannot read;
//                     in a template: Microsoft.Authorization, .Management or .Graph
//                     resources, and any extension (Bicep `extension`/`import`)
//   immutability      a Locked immutability policy (nothing can delete it), or a
//                     Key Vault with purge protection (nothing can delete it for
//                     its retention period)
//   azure-made-group  AKS node groups, backup restore groups and Container Apps
//                     infrastructure groups (an environment in a subnet) not
//                     named rg-lab-<id>-*
//   resource-group    a resource group other than rg-lab-<id> or rg-lab-<id>-*
//   outside-scope     a resource group, scope or parent outside the lab (an id at
//                     any path too, a whole top-level attribute included, and any
//                     id inside a JSON string such as a policy assignment's
//                     parameters, known or unknown: a failover group's
//                     partner server and databases, a replicated VM's disk target
//                     group; an unknown one inside an attribute written as blocks
//                     is held to all of that attribute's references, which is
//                     how terraform show -json lists them), anything at subscription
//                     scope (a policy rule's deploymentScope too), or a resource tied to nothing in the
//                     lab (an instance key, count.index or each.key, places
//                     nothing on its own; each.value places only when for_each
//                     ranges over the lab's own resources); template deployments at other scopes, deployment
//                     scripts, a template spec; in a template (templateProblems,
//                     keys read case-insensitively, as ARM does): a schema other
//                     than a resource group's, any resource type not on its
//                     allow-list (TEMPLATE_TYPES), nested deployments other than
//                     Bicep's own modules, linked templates and template specs,
//                     /subscriptions/ or /resourceGroups/ paths, subscription(),
//                     tenant(), managementGroup(), resourceId() with a group or
//                     subscription; in a plan, a template_content it cannot read
//
// It is plain Node with no packages (the runner has Node; npm ci is not run),
// and it never prints a value Terraform marks sensitive.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALLOWED_PROVIDER_SOURCES, normalizeSource, providerOfType } from "./lab-lint.mjs";

export const LAB_ID_RE = /^az(104|305)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
/** The governance labs, named in code (spec §8.3). A test keeps this equal to shared/labs.ts. */
export const GOVERNANCE_LABS = ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone", "az305-21-monitoring-scale"];
export const RULES = ["provider", "provisioner", "import", "gateway", "association", "governance", "entra-type", "entra-prefix", "role", "immutability", "azure-made-group", "resource-group", "outside-scope"];

const ALLOWED_ROLES = JSON.parse(readFileSync(new URL("../../labs/setup/allowed-roles.json", import.meta.url), "utf8"));
/** Allowed providers by FULL source address (a look-alike ending /azurerm from elsewhere is not azurerm). */
const PROVIDERS = new Set(ALLOWED_PROVIDER_SOURCES);
/** Their local names, for the provider-credentials check. */
const PROVIDER_NAMES = new Set(ALLOWED_PROVIDER_SOURCES.map((s) => s.split("/").pop()));
/** Provider settings that would point a provider at other credentials, another subscription or tenant. */
const PROVIDER_CREDENTIALS = ["subscription_id", "tenant_id", "client_id", "client_secret", "client_certificate", "client_certificate_path", "client_certificate_password", "auxiliary_tenant_ids", "oidc_token", "oidc_token_file_path", "msi_endpoint", "use_cli", "use_msi"];
const GOVERNANCE_TYPES = new Set([
  "azurerm_role_definition",
  "azurerm_policy_definition",
  "azurerm_policy_set_definition",
  // A management-group initiative is a governance definition (spec §17, ruling 29).
  "azurerm_management_group_policy_set_definition",
  "azurerm_management_group",
  "azurerm_management_group_policy_assignment",
  "azurerm_management_group_policy_exemption",
  "azurerm_management_group_policy_remediation",
]);
const ASSOCIATION_TYPES = new Set(["azurerm_management_group_subscription_association", "azurerm_subscription"]);
const ENTRA_TYPES = new Set(["azuread_user", "azuread_group", "azuread_group_member"]);
const GATEWAY_RE = /\b(?:rg-wg|vnet-wg)\b/i;
const DNS_LINK = "azurerm_private_dns_zone_virtual_network_link";
/** Attributes ending _id that hold an Entra object or tenant id, not an Azure resource id. */
const NOT_ARM = new Set(["principal_id", "tenant_id", "object_id", "client_id", "application_id", "member_object_id", "group_object_id", "principal_object_id", "role_id", "application_object_id", "sku_id"]);
/** A name an Azure resource id goes by: id, x_id, x_ids (Entra and other non-ARM ids excepted). */
const ID_NAME = (name) => (name === "id" || /_ids?$/.test(name)) && !NOT_ARM.has(name);
/** A reference to an id: azurerm_x.y.id, data.a.b.c_id, var.x_ids, azurerm_x.y[0].id. */
const ID_REF = (ref) => ref.includes(".") && ID_NAME(ref.replace(/\[[^\]]*\]/g, "").split(".").at(-1));
/**
 * A whole data source used as a value (data.a.b with no attribute of it among `refs`): what a splat
 * (data.a.b[*].id) or a for expression over it lists, since Terraform stops a reference at the splat.
 */
const WHOLE_DATA_REF = (ref, refs) => /^data\.[a-z0-9_]+\.[A-Za-z0-9_-]+$/.test(ref.replace(/\[[^\]]*\]/g, "")) && !refs.some((x) => x !== ref && x.replace(/\[[^\]]*\]/g, "").startsWith(`${ref.replace(/\[[^\]]*\]/g, "")}.`));
/**
 * Every string inside a JSON string (`{...}` or `[...]`), keys too, as { path, value }; strings inside it that are
 * JSON themselves are read as well (a few levels). Not JSON (or not a string): nothing.
 */
function jsonStrings(s, depth = 0) {
  if (typeof s !== "string" || depth > 3) return [];
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return [];
  let parsed;
  try {
    parsed = JSON.parse(t);
  } catch {
    return [];
  }
  const out = [];
  const walk = (v, path) => {
    if (typeof v === "string") {
      out.push({ path, value: v });
      for (const j of jsonStrings(v, depth + 1)) out.push({ path: `${path} > ${j.path}`, value: j.value });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        out.push({ path: `${p} (key)`, value: k });
        walk(x, p);
      }
    }
  };
  walk(parsed, "");
  return out;
}
/**
 * count.index and each.key: an instance's own key, as in azurerm_network_interface.web[count.index].id,
 * which Terraform 1.14 lists as ["azurerm_network_interface.web", "count.index"]. They never reach
 * outside the lab, but they place nothing either. each.value is the for_each element: see forEachPlaces.
 */
const INDEX_REF = /^(count\.index|each\.key)(\.|\[|$)/;
const EACH_VALUE_REF = /^each\.value(\.|\[|$)/;
/** Meta-arguments hcl2json shows as attributes. */
const META = new Set(["count", "for_each", "depends_on", "lifecycle", "provider", "provisioner", "connection"]);

/** A value Terraform does not know until apply (plan), or an expression this check cannot evaluate (HCL). `prefix` is the literal start, when known. */
export class Unknown {
  constructor(prefix = "") {
    this.prefix = prefix;
  }
}

// ── Reading a plan (terraform show -json) ────────────────────────────────

/** A plan's provider_name as a full source address ("terraform.io/builtin/terraform" stays as it is). */
const providerOf = (full) => normalizeSource(full);
const stripIndex = (address) => address.replace(/\[[^\]]*\]/g, "");

function moduleResources(mod, out = []) {
  for (const r of mod?.resources ?? []) out.push(r);
  for (const c of mod?.child_modules ?? []) moduleResources(c, out);
  return out;
}

function configResources(mod, prefix = "", out = new Map()) {
  for (const r of mod?.resources ?? []) out.set(prefix + r.address, r);
  for (const [name, call] of Object.entries(mod?.module_calls ?? {})) configResources(call.module, `${prefix}module.${name}.`, out);
  return out;
}

/** Every "references" list anywhere under a configuration expression. */
function exprRefs(expr, out = []) {
  if (Array.isArray(expr)) for (const e of expr) exprRefs(e, out);
  else if (expr && typeof expr === "object") {
    if (Array.isArray(expr.references)) out.push(...expr.references);
    for (const [k, v] of Object.entries(expr)) if (k !== "references" && k !== "constant_value") exprRefs(v, out);
  }
  return out;
}

/** Each "references" list under a configuration expression by its path: { "a": [...], "b.0.c": [...] }. */
function refPaths(expr, path, out) {
  if (Array.isArray(expr)) {
    expr.forEach((e, i) => refPaths(e, [...path, i], out));
    return out;
  }
  if (!expr || typeof expr !== "object") return out;
  if (Array.isArray(expr.references) && path.length) out[path.join(".")] = expr.references;
  for (const [k, v] of Object.entries(expr)) if (k !== "references" && k !== "constant_value") refPaths(v, [...path, k], out);
  return out;
}

/** Put an Unknown wherever after_unknown says the value is not known yet. */
function mergeUnknown(values, unknown) {
  if (unknown === true) return new Unknown();
  if (Array.isArray(unknown)) {
    const arr = Array.isArray(values) ? [...values] : [];
    unknown.forEach((u, i) => {
      if (u !== false && u != null) arr[i] = mergeUnknown(arr[i], u);
    });
    return arr;
  }
  if (unknown && typeof unknown === "object") {
    const obj = values && typeof values === "object" && !Array.isArray(values) ? { ...values } : {};
    for (const [k, u] of Object.entries(unknown)) if (u !== false && u != null) obj[k] = mergeUnknown(obj[k], u);
    return obj;
  }
  return values;
}

/** Resources from `terraform show -json <plan>`, in this check's own shape. */
export function planResources(plan) {
  const cfg = configResources(plan?.configuration?.root_module);
  const changes = new Map((plan?.resource_changes ?? []).map((c) => [c.address, c]));
  const seen = new Map();
  const add = (r) => {
    if (!r?.address || seen.has(r.address)) return;
    const c = cfg.get(stripIndex(r.address)) ?? {};
    const after = changes.get(r.address)?.change?.after_unknown;
    const values = mergeUnknown(r.values ?? {}, after ?? {});
    const exprs = c.expressions ?? {};
    const refs = {};
    for (const [k, e] of Object.entries(exprs)) refs[k] = exprRefs(e);
    // A value not known until apply carries the references its own expression makes, as an HCL Unknown does.
    // Terraform splits only schema blocks by path ("partner_server.0.id"); an attribute that holds objects or
    // lists (azurerm's managed_disk, a failover group's databases) is one expression whose references cover
    // every value inside it, while after_unknown still marks those values by their own nested paths. So an
    // unknown value takes the references of the nearest enclosing path that has any. A whole block left unknown
    // (every value in it unknown, its expressions split by path below it) takes every reference under it.
    const byPath = refPaths(exprs, [], {});
    for (const l of leaves(values)) {
      if (!(l.value instanceof Unknown)) continue;
      for (let n = l.path.length; n > 0; n--) {
        const refs = byPath[l.path.slice(0, n).join(".")];
        if (refs) {
          l.value.refs = refs;
          break;
        }
      }
      if (!l.value.refs) {
        const under = `${l.path.join(".")}.`;
        const below = Object.entries(byPath).filter(([p]) => p.startsWith(under)).flatMap(([, refs]) => refs);
        if (below.length) l.value.refs = below;
      }
    }
    seen.set(r.address, {
      address: r.address,
      mode: r.mode ?? (r.address.startsWith("data.") ? "data" : "managed"),
      type: r.type,
      provider: providerOf(r.provider_name),
      values,
      refs,
      configured: new Set(Object.keys(exprs)),
      // for_each, as the configuration prints it ({ references } or { constant_value }), or null.
      forEach: c.for_each_expression ? { refs: exprRefs(c.for_each_expression), constant: c.for_each_expression.constant_value } : null,
      provisioners: (c.provisioners ?? []).length,
      sensitive: new Set(Object.entries(r.sensitive_values ?? {}).filter(([, v]) => v === true).map(([k]) => k)),
    });
  };
  for (const r of moduleResources(plan?.planned_values?.root_module)) add(r);
  for (const r of moduleResources(plan?.prior_state?.values?.root_module)) if (r.mode === "data") add(r);
  // A data source configured but not read yet (or a resource only in the configuration).
  for (const [address, c] of cfg) {
    if ([...seen.keys()].some((a) => stripIndex(a) === address)) continue;
    add({ address, mode: c.mode, type: c.type, provider_name: (plan?.configuration?.provider_config ?? {})[c.provider_config_key]?.full_name ?? providerOfType(c.type), values: {} });
  }
  const providers = Object.entries(plan?.configuration?.provider_config ?? {}).map(([key, p]) => ({ key, name: p.name ?? key.split(".")[0], keys: Object.keys(p.expressions ?? {}) }));
  // Terraform 1.5+: a change that adopts an existing object says so in change.importing.
  const imports = (plan?.resource_changes ?? []).filter((c) => c?.change?.importing).map((c) => c.address);
  return { resources: [...seen.values()], providers, imports };
}

// ── Reading HCL (hcl2json) ───────────────────────────────────────────────

/** Split a template string into literal text and ${...} expressions. */
function templateParts(s) {
  const parts = [];
  let i = 0;
  let lit = "";
  while (i < s.length) {
    if (s[i] === "$" && s[i + 1] === "{" && s[i - 1] !== "$") {
      let depth = 1;
      let j = i + 2;
      let inStr = false;
      while (j < s.length && depth > 0) {
        const ch = s[j];
        if (inStr) {
          if (ch === "\\") j++;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      if (lit) parts.push({ lit });
      lit = "";
      parts.push({ expr: s.slice(i + 2, j - 1).trim() });
      i = j;
      continue;
    }
    lit += s[i++];
  }
  if (lit) parts.push({ lit });
  return parts;
}

const REF_RE = /\b(?:(?:var|local)\.[A-Za-z0-9_-]+|data\.[a-z0-9_]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+)*|module\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+)*|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+)*)/g;

/** References in an HCL expression, with quoted strings and [index] taken out. */
function hclRefs(expr) {
  const code = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\[[^\]]*\]/g, "");
  return [...code.matchAll(REF_RE)].map((m) => m[0]);
}

function hclContext(hcl, labId) {
  const locals = Object.assign({}, ...(hcl.locals ?? []));
  const known = (expr, depth = 0) => {
    if (expr === "var.lab_id") return labId;
    if (expr === "var.resource_group_name") return `rg-lab-${labId}`;
    if (/^data\.azurerm_subscription\.[A-Za-z0-9_-]+\.id$/.test(expr)) return "/subscriptions/{subscription}";
    if (/^data\.azurerm_(subscription|client_config)\.[A-Za-z0-9_-]+\.subscription_id$/.test(expr)) return "{subscription}";
    const local = /^local\.([A-Za-z0-9_-]+)$/.exec(expr);
    if (local && depth < 8 && typeof locals[local[1]] === "string") {
      const r = resolve(locals[local[1]], depth + 1);
      return r instanceof Unknown ? null : r.value;
    }
    return null;
  };
  /** A string with its interpolations worked out where possible: { value } or Unknown (with .refs). */
  const resolve = (s, depth = 0) => {
    const refs = [];
    let out = "";
    let unknown = null;
    for (const p of templateParts(s)) {
      if (p.lit !== undefined) {
        if (!unknown) out += p.lit;
        continue;
      }
      const k = known(p.expr, depth);
      if (k !== null) {
        if (!unknown) out += k;
        continue;
      }
      for (const r of hclRefs(p.expr)) {
        const local = /^local\.([A-Za-z0-9_-]+)/.exec(r);
        if (local && typeof locals[local[1]] === "string" && depth < 8) {
          const lr = resolve(locals[local[1]], depth + 1);
          if (lr instanceof Unknown) refs.push(...lr.refs);
        } else refs.push(r);
      }
      if (!unknown) unknown = new Unknown(out);
    }
    if (unknown) {
      unknown.refs = refs;
      return unknown;
    }
    return { value: out };
  };
  return { resolve };
}

function hclValue(v, ctx, refs) {
  if (typeof v === "string") {
    const r = ctx.resolve(v);
    if (r instanceof Unknown) {
      refs.push(...r.refs);
      return r;
    }
    return r.value;
  }
  if (Array.isArray(v)) return v.map((x) => hclValue(x, ctx, refs));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hclValue(x, ctx, refs)]));
  return v;
}

/** How many blocks: an array of them, or labelled blocks as an object of arrays. */
function blockCount(b) {
  if (b == null) return 0;
  if (Array.isArray(b)) return b.length;
  if (typeof b === "object") return Object.values(b).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0) || 1;
  return 1;
}

/** Resources from hcl2json output (all of a lab's .tf files together), in this check's own shape. */
export function hclResources(hcl, labId) {
  const ctx = hclContext(hcl ?? {}, labId);
  // terraform { required_providers { azurerm = { source = "..." } } }: local name -> source.
  const sources = new Map();
  for (const t of [hcl?.terraform ?? []].flat()) {
    for (const rp of [t?.required_providers ?? []].flat()) {
      for (const [local, spec] of Object.entries(rp ?? {})) sources.set(local, typeof spec === "object" && spec?.source ? spec.source : local);
    }
  }
  const resources = [];
  for (const [mode, prefix] of [["resource", ""], ["data", "data."]]) {
    for (const [type, byName] of Object.entries(hcl?.[mode] ?? {})) {
      for (const [name, blocks] of Object.entries(byName ?? {})) {
        for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
          const values = {};
          const refs = {};
          for (const [k, v] of Object.entries(block ?? {})) {
            if (META.has(k)) continue;
            refs[k] = [];
            values[k] = hclValue(v, ctx, refs[k]);
          }
          // Left unset, azuread computes a mail nickname of its own: unknown in the
          // plan, and never lab-<id>-. Say so here too, as an early warning.
          if (mode === "resource" && (type === "azuread_user" || type === "azuread_group") && !("mail_nickname" in values)) values.mail_nickname = new Unknown();
          const local = typeof block?.provider === "string" ? block.provider.replace(/^\$\{|\}$/g, "").split(".")[0] : providerOfType(type);
          const prov = local === "terraform" ? "terraform.io/builtin/terraform" : normalizeSource(sources.get(local) ?? local);
          resources.push({
            address: `${prefix}${type}.${name}`,
            mode: mode === "resource" ? "managed" : "data",
            type,
            provider: prov,
            values,
            refs,
            configured: new Set(Object.keys(refs)),
            // hcl2json's count.index and each.* are not references here (REF_RE skips them).
            forEach: null,
            // hcl2json prints labelled blocks as { "local-exec": [...] }; count every kind.
            provisioners: blockCount(block?.provisioner),
            sensitive: new Set(),
          });
        }
      }
    }
  }
  const providers = [];
  for (const [name, blocks] of Object.entries(hcl?.provider ?? {})) {
    for (const b of Array.isArray(blocks) ? blocks : [blocks]) providers.push({ key: b?.alias ? `${name}.${b.alias}` : name, name, keys: Object.keys(b ?? {}) });
  }
  // import { to = azuread_user.x, id = "..." } blocks, as hcl2json prints them.
  const importBlocks = Array.isArray(hcl?.import) ? hcl.import : hcl?.import ? Object.values(hcl.import).flat() : [];
  const imports = importBlocks.map((b) => String(b?.to ?? "import").replace(/^\$\{|\}$/g, "").trim());
  return { resources, providers, imports };
}

// ── The rules ────────────────────────────────────────────────────────────

/** Every leaf under a value: { attr, path, value } (value a string, number, boolean, null or Unknown). */
function leaves(values) {
  const out = [];
  const walk = (v, path) => {
    if (v instanceof Unknown || v === null || typeof v !== "object") {
      out.push({ attr: path[0], path, value: v });
      return;
    }
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    for (const [k, x] of entries) walk(x, [...path, k]);
  };
  for (const [k, v] of Object.entries(values ?? {})) walk(v, [k]);
  return out;
}

/** What an Azure resource id points at: a resource group, a management group, the subscription itself, or a tenant-wide definition. */
export function classifyId(id) {
  if (typeof id !== "string" || !id.startsWith("/")) return null;
  let m = /^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)/i.exec(id);
  if (m) return { kind: "rg", name: m[1] };
  m = /^\/providers\/Microsoft\.Management\/managementGroups\/([^/]+)/i.exec(id);
  if (m) return { kind: "mg", name: m[1] };
  m = /^\/subscriptions\/[^/]+(\/.*)?$/i.exec(id);
  if (m) return { kind: "sub", rest: m[1] ?? "" };
  if (/^\/providers\/Microsoft\.Authorization\//i.test(id)) return { kind: "builtin" };
  return null;
}

const DEFINITION_REF = /^\/providers\/Microsoft\.Authorization\/(roleDefinitions|policyDefinitions|policySetDefinitions)\/[^/]+$/i;

/** Every roleDefinitionIds entry and deploymentScope value in a parsed policy rule, keys read case-insensitively. */
function policyRuleKeys(rule) {
  const out = { roleDefinitionIds: [], deploymentScope: [] };
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const key = k.toLowerCase();
        if (key === "roledefinitionids") out.roleDefinitionIds.push(...(Array.isArray(x) ? x : [x]));
        else if (key === "deploymentscope") out.deploymentScope.push(x);
        walk(x);
      }
    }
  };
  walk(rule);
  return out;
}

// ── Templates ────────────────────────────────────────────────────────────

/** A resource group deployment template's schema; subscription, management group and tenant ones are refused. */
const RG_TEMPLATE_SCHEMA = /\/deploymentTemplate\.json#?$/i;
/** Template keys that send a resource somewhere other than the deployment's own group (lower case: templateProblems reads keys case-insensitively, as ARM does). */
const TEMPLATE_SCOPE_KEYS = ["resourcegroup", "subscriptionid", "scope", "managementgroup"];
/** Template resource types a lab may only make in Terraform (where the role rules see them), or never. */
const TEMPLATE_ROLE_TYPES = /^Microsoft\.(Authorization|Management|Graph)\//i;
const TEMPLATE_OUTSIDE_TYPES = /^Microsoft\.Resources\/(deploymentScripts|resourceGroups|templateSpecs)(\/|$)/i;
const NESTED_DEPLOYMENT = /^Microsoft\.Resources\/deployments$/i;
/**
 * The only resource types a template may deploy (lower case), each with why it can only land inside the lab's group.
 * Everything else is refused: AKS and Container Apps environments make groups of their own, managed applications and
 * deployment stacks deploy elsewhere, and so on. To let a lab deploy another type from a template, add it here with the
 * reason (labs spec §17, ruling 21); the scope keys, ids and expressions in it are still checked.
 */
const TEMPLATE_TYPES = new Map([
  ["microsoft.storage/storageaccounts", "lab 12: a storage account lives in the group it is deployed to"],
  ["microsoft.network/virtualnetworks", "lab 12: a VNet lives in its deployment's group; peerings to other groups need an id, which the string rules refuse"],
  ["microsoft.network/virtualnetworks/subnets", "lab 12: a subnet lives in its VNet"],
  ["microsoft.network/networksecuritygroups", "lab 12: an NSG lives in the group it is deployed to"],
  ["microsoft.network/networksecuritygroups/securityrules", "a rule lives in its NSG"],
  ["microsoft.resources/deployments", "lab 12's module: only as Bicep emits one (inline template, inner scope, Incremental, no resourceGroup/subscriptionId/scope), checked as a template of its own"],
]);
/** Template deployments at other scopes than a resource group. */
const OTHER_SCOPE_DEPLOYMENTS = new Set(["azurerm_subscription_template_deployment", "azurerm_management_group_template_deployment", "azurerm_tenant_template_deployment"]);

/** The first argument of each resourceId(...) call in an ARM expression: a literal string, or null when it is not one. */
function resourceIdFirstArgs(expr) {
  const out = [];
  for (const m of expr.matchAll(/(?<![A-Za-z])resourceId\s*\(\s*/gi)) {
    let i = m.index + m[0].length;
    if (expr[i] !== "'") {
      out.push(null);
      continue;
    }
    let s = "";
    for (i++; i < expr.length; i++) {
      if (expr[i] === "'" && expr[i + 1] === "'") {
        s += "'";
        i++;
      } else if (expr[i] === "'") break;
      else s += expr[i];
    }
    out.push(s);
  }
  return out;
}

/**
 * Check an ARM template (an object, or its JSON text; Bicep builds one) that a
 * lab deploys into its own group with azurerm_resource_group_template_deployment.
 * Returns [{ rule, message }]: under "role" what writes access, locks,
 * governance or Entra (Microsoft.Graph and any other extension); under
 * "outside-scope" what deploys or reaches beyond the lab's group (other
 * schemas and scopes, resource groups, deployment scripts, linked templates
 * and template specs, ids of other groups, or a template it cannot read);
 * under "gateway" the gateway's names. Nested deployments are checked as
 * templates of their own.
 */
export function templateProblems(template) {
  const out = [];
  const add = (rule, message) => {
    if (!out.some((p) => p.rule === rule && p.message === message)) out.push({ rule, message });
  };
  // Nested deployments' inline templates: each is checked as a template of its own, so the string scan skips them.
  const nestedTemplates = new Set();
  const listOf = (resources) => (Array.isArray(resources) ? resources : resources && typeof resources === "object" ? Object.values(resources) : []);
  /** A copy of a template with every object key in lower case; two keys that differ only in case are refused. */
  const lowered = new WeakSet();
  const lower = (v, where, path = "") => {
    if (Array.isArray(v)) {
      const a = v.map((x, i) => lower(x, where, `${path}[${i}]`));
      lowered.add(a);
      return a;
    }
    if (!v || typeof v !== "object") return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const lk = k.toLowerCase();
      if (Object.hasOwn(o, lk)) add("outside-scope", `${where} has two keys ARM reads as one (${path ? `${path}.` : ""}${lk}), so this check cannot tell which it uses`);
      // defineProperty: a key called __proto__ stays a key.
      Object.defineProperty(o, lk, { value: lower(x, where, path ? `${path}.${lk}` : lk), enumerable: true, writable: true, configurable: true });
    }
    lowered.add(o);
    return o;
  };

  const visitResource = (res, where, parentType = "") => {
    if (!res || typeof res !== "object" || Array.isArray(res)) return;
    // A child declared inside its parent may give its type short ("subnets"); an extension resource carries "@version".
    const given = String(res.type ?? "").replace(/@.*$/, "");
    const type = parentType && given && !given.includes("/") ? `${parentType}/${given}` : given;
    if (/^Microsoft\.Graph\//i.test(type) || "extension" in res || "import" in res) add("role", `${where} deploys ${type || "a resource"} through an extension (Microsoft Graph and the like reach beyond Azure Resource Manager)`);
    else if (TEMPLATE_ROLE_TYPES.test(type) || /\/providers\//i.test(type)) add("role", `${where} deploys ${type}, which a lab may only make in Terraform`);
    else if (TEMPLATE_OUTSIDE_TYPES.test(type)) add("outside-scope", `${where} deploys ${type}, which reaches beyond the lab's group`);
    else if (!TEMPLATE_TYPES.has(type.toLowerCase())) {
      add("outside-scope", `${where} deploys ${type || "a resource with no type"}, which is not on the template allow-list (${[...TEMPLATE_TYPES.keys()].join(", ")}); if a lab needs it, add it to TEMPLATE_TYPES in infra/ci/lab-scope.mjs with the reason it can only ever land inside the lab's group (labs spec §17, ruling 21)`);
    }
    for (const k of TEMPLATE_SCOPE_KEYS) if (k in res) add("outside-scope", `${where} sends ${type || "a resource"} to another scope (${k})`);
    if (NESTED_DEPLOYMENT.test(type)) {
      // Only as Bicep emits a module: its template inline, its expressions its own (inner scope), Incremental.
      const props = res.properties ?? {};
      const name = res.name ?? "a nested deployment";
      if (props.templatelink) add("outside-scope", `${where} links a template (${props.templatelink.id ? "a template spec" : "a URL"}) this check cannot read`);
      if (props.parameterslink) add("outside-scope", `${where} links its parameters from a URL this check cannot read`);
      if (props.template !== undefined) {
        if (props.template && typeof props.template === "object") nestedTemplates.add(props.template);
        else add("outside-scope", `${where} gives ${name}'s template as something other than an inline template object, as Bicep never does`);
        visit(props.template, `${where} > ${name}`);
      }
      else if (!props.templatelink) add("outside-scope", `${where} has a nested deployment with no template`);
      if (String(props.expressionevaluationoptions?.scope ?? "").toLowerCase() !== "inner") add("outside-scope", `${where} has ${name} without expressionEvaluationOptions.scope "inner"; only Bicep-built modules (inner scope) are allowed`);
      if (String(props.mode ?? "").toLowerCase() !== "incremental") add("outside-scope", `${where} has ${name} in ${props.mode ?? "no"} mode; only Bicep-built modules (Incremental) are allowed`);
    }
    for (const child of listOf(res.resources)) visitResource(child, where, type);
  };

  const visit = (t, where) => {
    let tpl = t;
    if (typeof tpl === "string") {
      try {
        tpl = JSON.parse(tpl);
      } catch {
        add("outside-scope", `${where} is not JSON this check can read`);
        return;
      }
    }
    if (!tpl || typeof tpl !== "object" || Array.isArray(tpl)) {
      add("outside-scope", `${where} is not a template this check can read`);
      return;
    }
    // ARM reads property names case-insensitively ("Type", "ResourceGroup"), so every key is read in lower case;
    // values keep theirs. A nested template arrives already lowered (it is part of its parent).
    if (!lowered.has(tpl)) tpl = lower(tpl, where);
    if (typeof tpl.$schema !== "string" || !RG_TEMPLATE_SCHEMA.test(tpl.$schema)) add("outside-scope", `${where} has schema ${tpl.$schema ?? "(none)"}: only a resource group deployment template (deploymentTemplate.json) is allowed`);
    for (const k of ["extensions", "imports"]) {
      if (tpl[k] && typeof tpl[k] === "object" && Object.keys(tpl[k]).length) add("role", `${where} uses ${k} (${Object.keys(tpl[k]).join(", ")}): extensions such as Microsoft Graph reach beyond Azure Resource Manager`);
    }
    for (const res of listOf(tpl.resources)) visitResource(res, where);
    // The objects whose `metadata` is ARM's description slot: the template itself, each parameter, output and
    // definition (and the type schemas inside them), and each resource (children too). Anything else called
    // metadata (a variable, a parameter, a languageVersion 2.0 symbolic resource, a property) is read like any value.
    const described = new Set([tpl]);
    const schema = (s) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return;
      described.add(s);
      for (const x of listOf(s.properties)) schema(x);
      for (const x of listOf(s.discriminator?.mapping)) schema(x);
      for (const x of Array.isArray(s.prefixitems) ? s.prefixitems : []) schema(x);
      schema(s.items);
      schema(s.additionalproperties);
    };
    for (const k of ["parameters", "outputs", "definitions"]) for (const x of listOf(tpl[k])) schema(x);
    const resource = (r) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) return;
      described.add(r);
      for (const c of listOf(r.resources)) resource(c);
    };
    for (const r of listOf(tpl.resources)) resource(r);
    // Every string: other groups' ids, resourceId() in another group, ids above the group, the gateway. Descriptions
    // (the `metadata` of the objects above) and nested deployments' templates (checked on their own) are skipped.
    const strings = (v, path) => {
      if (nestedTemplates.has(v)) return;
      if (typeof v === "string") {
        if (GATEWAY_RE.test(v)) add("gateway", `${where} names the gateway's resources (${path})`);
        // An expression is "[...]"; "[[..." is a literal that starts with "[".
        const expression = v.startsWith("[") && !v.startsWith("[[") && v.endsWith("]");
        const literals = expression ? [...v.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")) : [v];
        for (const s of literals) {
          const c = classifyId(s);
          if (c && c.kind !== "builtin") add("outside-scope", `${where} names ${s} (${path}), which this check cannot place inside the lab's group`);
        }
        // A subscription or resource group path anywhere in a value, or spread across an expression's literals.
        if (literals.some((s) => /\/(subscriptions|resourcegroups)\//i.test(s)) || /\/(subscriptions|resourcegroups)\//i.test(literals.join(""))) {
          add("outside-scope", `${where} spells out a /subscriptions/ or /resourceGroups/ path (${path}); build ids with resourceId() and a resource type only`);
        }
        if (expression) {
          if (resourceIdFirstArgs(v).some((a) => a === null || !a.includes("/"))) add("outside-scope", `${where} uses resourceId() with a resource group or subscription (${path})`);
          if (/(?<![A-Za-z0-9_])(subscriptionResourceId|tenantResourceId|managementGroupResourceId|extensionResourceId)\s*\(/i.test(v)) add("outside-scope", `${where} builds an id above, or outside, the resource group (${path})`);
          // resourceGroup() is the deployment's own group; these name what is above it.
          if (/(?<![A-Za-z0-9_.])(subscription|tenant|managementGroup)\s*\(/i.test(v)) add("outside-scope", `${where} uses subscription(), tenant() or managementGroup() (${path}), which reach above the lab's group`);
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`));
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) if (!(k === "metadata" && described.has(v))) strings(x, path ? `${path}.${k}` : k);
      }
    };
    strings(tpl, "");
  };

  visit(template, "the template");
  return out;
}

/**
 * Check a lab's resources (from planResources or hclResources). Returns
 * [{ rule, address, message }], at most one per resource. `mode` is "plan"
 * (the default: a value this check cannot know is refused where it matters,
 * as a template's content) or "hcl" (CI's early warning, where file() and
 * other expressions are left to labs-tf and the plan).
 */
export function scopeProblems({ resources, providers, imports = [] }, labId, { mode = "plan" } = {}) {
  const importing = new Set(imports.map(stripIndex));
  const id = labId.toLowerCase();
  const rg = `rg-lab-${id}`;
  const prefix = `lab-${id}-`;
  const governance = GOVERNANCE_LABS.includes(labId);
  const builtInNames = new Set(ALLOWED_ROLES.builtIn.map((r) => r.name.toLowerCase()));
  const builtInIds = new Set(ALLOWED_ROLES.builtIn.map((r) => r.id.toLowerCase()));
  const custom = ALLOWED_ROLES.custom.filter((r) => r.lab === labId);
  const customIds = new Set(custom.map((r) => r.id.toLowerCase()));
  const customNames = new Set(custom.map((r) => r.name.toLowerCase()));

  const managed = new Map(resources.filter((r) => r.mode === "managed").map((r) => [stripIndex(r.address), r]));
  const data = new Map(resources.filter((r) => r.mode === "data").map((r) => [stripIndex(r.address), r]));
  /** The managed resource or data source a reference points at, if it is in this configuration. */
  const target = (ref) => {
    const parts = ref.replace(/\[[^\]]*\]/g, "").split(".");
    if (parts[0] === "data") return data.get(parts.slice(0, 3).join(".")) ?? null;
    return managed.get(parts.slice(0, 2).join(".")) ?? null;
  };
  /** A reference that places a value inside the lab: a resource it makes, or its group's name. */
  const placed = (x) => target(x)?.mode === "managed" || x === "var.resource_group_name" || x === "var.gateway_vnet_id";
  /** Any Azure id in a constant (keys too). */
  const holdsId = (v) => (typeof v === "string" ? classifyId(v) !== null || /\/(subscriptions|resourcegroups)\//i.test(v) : v && typeof v === "object" ? Object.entries(v).some(([k, x]) => holdsId(k) || holdsId(x)) : false);
  /**
   * What each.value is, from the resource's for_each: "places" when it ranges over resources the lab makes
   * (each.value is one of them), "harmless" over a constant with no Azure id in it, otherwise "unknown"
   * (a variable, a local, a data source, or nothing this check can see).
   */
  const forEachValue = (res) => {
    const fe = res.forEach;
    if (!fe) return "unknown";
    if (fe.refs.length) return fe.refs.every((x) => target(x)?.mode === "managed") ? "places" : "unknown";
    return fe.constant !== undefined && !holdsId(fe.constant) ? "harmless" : "unknown";
  };
  const gatewayData = new Set([...data.values()].filter((d) => leaves(d.values).some((l) => typeof l.value === "string" && GATEWAY_RE.test(l.value))).map((d) => stripIndex(d.address)));

  const ownRg = (name) => {
    const n = String(name).toLowerCase();
    return n === rg || n.startsWith(`${rg}-`);
  };
  /** A name that must start lab-<id>-: true, false, or false for an Unknown whose known start does not prove it. */
  const prefixed = (v) => (v instanceof Unknown ? v.prefix.toLowerCase().startsWith(prefix) : typeof v === "string" && v.toLowerCase().startsWith(prefix));
  const startsWithRg = (v) => {
    const p = `${rg}-`;
    return v instanceof Unknown ? v.prefix.toLowerCase().startsWith(p) : typeof v === "string" && v.toLowerCase().startsWith(p);
  };
  const ownMg = (name) => governance && String(name).toLowerCase().startsWith(prefix);

  const out = [];
  for (const r of resources) {
    const found = [];
    const refuse = (rule, message) => found.push({ rule, address: r.address, message });
    const refsOf = (attr) => r.refs[attr] ?? [];
    const v = r.values ?? {};
    const show = (attr) => (r.sensitive.has(attr) ? "(sensitive)" : v[attr] instanceof Unknown ? `${v[attr].prefix}…` : JSON.stringify(v[attr]));
    const all = leaves(v);

    // provider
    if (!PROVIDERS.has(r.provider)) refuse("provider", `the ${r.provider} provider is not allowed in a lab (only ${ALLOWED_PROVIDER_SOURCES.join(", ")})`);
    // provisioner
    if (r.provisioners > 0) refuse("provisioner", "provisioners are not allowed in a lab");
    // import
    if (importing.has(stripIndex(r.address))) refuse("import", "a lab only creates: importing would adopt an object that already exists, and tear-down would delete it");

    // gateway
    const linkException = (attr) => r.type === DNS_LINK && attr === "virtual_network_id" && refsOf(attr).length > 0 && refsOf(attr).every((x) => x === "var.gateway_vnet_id");
    for (const l of all) {
      if (linkException(l.attr)) continue;
      if (typeof l.value === "string" && GATEWAY_RE.test(l.value)) {
        refuse("gateway", `${l.path.join(".")} names the gateway's resources`);
        break;
      }
    }
    for (const [attr, refs] of Object.entries(r.refs)) {
      if (linkException(attr)) continue;
      if (refs.includes("var.gateway_vnet_id")) refuse("gateway", `${attr} uses var.gateway_vnet_id, which only a private DNS zone link may use`);
      const g = refs.map(target).find((t) => t && gatewayData.has(stripIndex(t.address)));
      if (g) refuse("gateway", `${attr} comes from ${g.address}, which reads the gateway's resources`);
    }

    if (r.mode === "managed") {
      // association
      if (ASSOCIATION_TYPES.has(r.type)) refuse("association", "a lab never moves or creates a subscription");
      // subscription_ids is optional and computed: left unset, every real plan has it unknown
      // (the provider reads it back after apply). Only a lab that sets it, or a known
      // non-empty list, is moving a subscription.
      if (r.type === "azurerm_management_group") {
        const ids = v.subscription_ids;
        const knownNonEmpty = Array.isArray(ids) && ids.length > 0;
        const setUnknown = r.configured.has("subscription_ids") && ids instanceof Unknown;
        if (knownNonEmpty || setUnknown) refuse("association", "a lab management group never holds the subscription");
      }

      // governance
      if (GOVERNANCE_TYPES.has(r.type)) {
        if (!governance) refuse("governance", `${r.type} is only for the governance labs (${GOVERNANCE_LABS.join(", ")})`);
        else {
          const names = r.type === "azurerm_management_group_policy_assignment" || r.type === "azurerm_management_group_policy_exemption" || r.type === "azurerm_management_group_policy_remediation" ? [] : ["name", ...(r.type === "azurerm_management_group" ? ["display_name"] : [])];
          for (const attr of names) if (attr in v && !prefixed(v[attr])) refuse("governance", `${attr} ${show(attr)} must start ${prefix}`);
        }
      }

      // entra-type, entra-prefix
      if (r.type.startsWith("azuread_")) {
        if (!ENTRA_TYPES.has(r.type)) refuse("entra-type", `a lab may make Entra users, groups and memberships only, not ${r.type}`);
        for (const attr of ["display_name", "user_principal_name", "mail_nickname"]) {
          if (r.type === "azuread_group_member" || !(attr in v) || v[attr] == null) continue;
          if (!prefixed(v[attr])) refuse("entra-prefix", `${attr} ${show(attr)} must start ${prefix}`);
        }
        if (r.type === "azuread_group_member" && !refsOf("group_object_id").some((x) => target(x)?.type === "azuread_group" && target(x)?.mode === "managed")) {
          refuse("entra-prefix", "group_object_id must be a group this lab makes");
        }
      }

      // role
      if (r.type === "azurerm_role_assignment" || r.type.startsWith("azurerm_pim_")) {
        let ok = false;
        if (r.type === "azurerm_role_assignment") {
          if (typeof v.role_definition_name === "string") ok = builtInNames.has(v.role_definition_name.toLowerCase()) || customNames.has(v.role_definition_name.toLowerCase());
          else if (typeof v.role_definition_id === "string") {
            const guid = v.role_definition_id.split("/").pop().toLowerCase();
            ok = builtInIds.has(guid) || customIds.has(guid);
          } else if (v.role_definition_id instanceof Unknown) {
            ok = refsOf("role_definition_id").some((x) => {
              const t = target(x);
              return t?.type === "azurerm_role_definition" && typeof t.values.role_definition_id === "string" && customIds.has(t.values.role_definition_id.toLowerCase());
            });
          }
        }
        if (!ok) refuse("role", `the role is not on labs/setup/allowed-roles.json for ${labId}`);
        if (typeof v.principal_type === "string" && !ALLOWED_ROLES.principalTypes.includes(v.principal_type)) refuse("role", `principal_type ${v.principal_type} is not allowed`);
      }
      // A remediating policy (deployIfNotExists, modify) stays inside the lab (spec §17, ruling 28): the roles its
      // assignment's identity is given (roleDefinitionIds) only built-ins on the allow-list, and never a deployment
      // at subscription scope. Read whatever the effect says (it may be a parameter).
      if (r.type === "azurerm_policy_definition") {
        const rule = v.policy_rule;
        if (rule instanceof Unknown) {
          if (mode === "plan") refuse("role", "policy_rule is not known at plan, so its roleDefinitionIds cannot be read; give apply-time values to the assignment as parameters");
        } else if (typeof rule === "string" && rule !== "") {
          let parsed = null;
          try {
            parsed = JSON.parse(rule);
          } catch {
            refuse("role", "policy_rule is not JSON this check can read");
          }
          const found = policyRuleKeys(parsed);
          const roles = found.roleDefinitionIds.map((x) => String(x).split("/").pop().toLowerCase());
          const off = roles.filter((g) => !builtInIds.has(g));
          if (off.length) refuse("role", `policy_rule's roleDefinitionIds may name only built-in roles on labs/setup/allowed-roles.json (not ${off.join(", ")})`);
          if (found.deploymentScope.some((s) => String(s).toLowerCase() === "subscription")) refuse("outside-scope", "policy_rule deploys at subscription scope (deploymentScope); a lab's remediation deploys into the resource's own group");
        }
      }
      if (r.type === "azurerm_role_definition") {
        const guid = typeof v.role_definition_id === "string" ? v.role_definition_id.toLowerCase() : null;
        const entry = custom.find((c) => c.id.toLowerCase() === guid);
        if (!entry || typeof v.name !== "string" || v.name.toLowerCase() !== entry.name.toLowerCase()) refuse("role", `a custom role needs its fixed name and role_definition_id from labs/setup/allowed-roles.json`);
        // Actions (and data actions; not_* only take away): no wildcard but a wildcard read
        // ("*/read"), and nothing that writes access (Microsoft.Authorization/.../write|delete).
        const actions = leaves(v.permissions ?? []).filter((l) => l.path.includes("actions") || l.path.includes("data_actions"));
        const risky = (a) => typeof a !== "string" || (a.includes("*") && !/\/read$/i.test(a)) || /^Microsoft\.Authorization\/.*\/(write|delete)$/i.test(a);
        if (actions.some((l) => l.value !== null && risky(l.value))) refuse("role", "a lab custom role may not hold wildcard actions (only wildcard reads) or grant access");
        // Assignable only inside the lab's own group(s). Left unset, Azure makes it the
        // definition's scope (the subscription), so unset is refused too.
        const scopes = v.assignable_scopes;
        const fromLabGroup = () => refsOf("assignable_scopes").length > 0 && refsOf("assignable_scopes").every((x) => target(x)?.mode === "managed" && target(x)?.type === "azurerm_resource_group");
        const inside = (s) => (s instanceof Unknown ? fromLabGroup() : typeof s === "string" && classifyId(s)?.kind === "rg" && ownRg(classifyId(s).name));
        const ok = scopes instanceof Unknown ? fromLabGroup() : Array.isArray(scopes) && scopes.length > 0 && scopes.every(inside);
        if (!ok) refuse("role", `a lab custom role is assignable only inside ${rg} (assignable_scopes from azurerm_resource_group.<name>.id)`);
      }
      // Templates (ARM JSON, or Bicep built to it): only into the lab's own group,
      // with a template this check can read in full (labs batch 2 plan, ruling 1).
      if (OTHER_SCOPE_DEPLOYMENTS.has(r.type)) refuse("outside-scope", `${r.type} deploys outside a resource group; a lab deploys templates only into its own (azurerm_resource_group_template_deployment)`);
      if (/^azurerm_resource_deployment_script_/.test(r.type)) refuse("outside-scope", "a deployment script runs code in Azure with an identity of its own, beyond what this check can see");
      if (r.type === "azurerm_resource_group_template_deployment") {
        const spec = v.template_spec_version_id;
        if (r.configured.has("template_spec_version_id") || (typeof spec === "string" && spec !== "")) {
          refuse("outside-scope", "template_spec_version_id deploys a template spec this check never reads; put the template in template_content");
        } else if (typeof v.template_content === "string") {
          for (const p of templateProblems(v.template_content)) refuse(p.rule, `template_content: ${p.message}`);
        } else if (mode === "plan") {
          refuse("outside-scope", "template_content is not known at plan, so this check cannot read the template; build it from a file (file(\"${path.module}/main.json\")) or known values");
        }
        // Parameters may carry resource ids the template then reaches.
        let params = null;
        try {
          params = typeof v.parameters_content === "string" ? JSON.parse(v.parameters_content) : null;
        } catch {
          params = null;
        }
        for (const l of leaves(params ?? {})) {
          const c = classifyId(l.value);
          if (c && !(c.kind === "rg" && ownRg(c.name)) && c.kind !== "builtin") refuse("outside-scope", `parameters_content ${l.path.join(".")} points outside the lab`);
        }
      }

      // immutability
      for (const l of all) {
        const inImmutable = l.path.some((p) => /immutab/i.test(String(p))) || /immutability_policy/.test(r.type);
        if (inImmutable && (l.value === "Locked" || (l.attr === "locked" && l.value === true) || (String(l.path.at(-1)) === "locked" && l.value === true))) {
          refuse("immutability", `${l.path.join(".")} locks an immutability policy, which nothing can delete until it expires`);
          break;
        }
      }
      // Purge protection keeps a deleted vault (and its name) for the whole retention period: nothing could
      // get the lab back to £0 and clean (spec §17, ruling 30). Unknown is refused when the lab sets it.
      if (r.type === "azurerm_key_vault") {
        const p = v.purge_protection_enabled;
        if (p === true || (p instanceof Unknown && r.configured.has("purge_protection_enabled"))) refuse("immutability", "purge_protection_enabled: a vault with purge protection cannot be deleted for its whole retention period; a lab never turns it on");
      }

      // azure-made-group
      if (r.type === "azurerm_kubernetes_cluster" && !startsWithRg(v.node_resource_group)) refuse("azure-made-group", `node_resource_group must be named ${rg}-<suffix>`);
      if (r.type === "azurerm_backup_policy_vm") {
        const irg = Array.isArray(v.instant_restore_resource_group) ? v.instant_restore_resource_group[0] : null;
        if (!irg || !startsWithRg(irg.prefix)) refuse("azure-made-group", `instant_restore_resource_group.prefix must start ${rg}-`);
      }
      // A Container Apps environment in a subnet gets an infrastructure group (ME_...) unless it is named.
      if (r.type === "azurerm_container_app_environment") {
        const inSubnet = r.configured.has("infrastructure_subnet_id") || (typeof v.infrastructure_subnet_id === "string" && v.infrastructure_subnet_id !== "");
        if (inSubnet && !startsWithRg(v.infrastructure_resource_group_name)) refuse("azure-made-group", `with an infrastructure subnet, infrastructure_resource_group_name must be named ${rg}-<suffix>`);
      }

      // resource-group
      if (r.type === "azurerm_resource_group") {
        const n = v.name;
        const ok = typeof n === "string" ? ownRg(n) : n instanceof Unknown ? n.prefix.toLowerCase().startsWith(`${rg}-`) : false;
        if (!ok) refuse("resource-group", `name ${show("name")} must be ${rg} or ${rg}-<suffix>`);
      }

      // outside-scope (Azure resources only)
      if (r.type.startsWith("azurerm_") && r.type !== "azurerm_resource_group") {
        let anchored = GOVERNANCE_TYPES.has(r.type);
        if (typeof v.resource_group_name === "string") {
          anchored = true;
          if (!ownRg(v.resource_group_name)) refuse("outside-scope", `resource_group_name ${show("resource_group_name")} is not the lab's group`);
        }
        // Every known string, and every string (keys too) inside a JSON string: a policy assignment's
        // parameters or a jsonencode() can carry an id as well as an attribute can.
        const judge = (where, attr, s, inJson) => {
          const c = classifyId(s);
          if (!c) return;
          if (c.kind === "rg") {
            anchored = true;
            if (!ownRg(c.name)) refuse("outside-scope", `${where} is in resource group ${c.name}, outside the lab`);
          } else if (c.kind === "mg") {
            anchored = true;
            if (!ownMg(c.name)) refuse("outside-scope", `${where} is in management group ${c.name}, not one this lab owns`);
          } else if (c.kind === "sub") {
            const definitionRef = DEFINITION_REF.test(c.rest);
            // Where a governance lab's definition lives; never where it can be assigned (role rule).
            const governanceScope = !inJson && governance && GOVERNANCE_TYPES.has(r.type) && attr === "scope" && c.rest === "";
            if (!definitionRef && !governanceScope) refuse("outside-scope", `${where} is at subscription scope; a lab works inside its own group`);
          }
        };
        for (const l of all) {
          if (linkException(l.attr)) continue; // the gateway VNet, through var.gateway_vnet_id only
          judge(l.path.join("."), l.attr, l.value, false);
          for (const j of jsonStrings(l.value)) judge(`${l.path.join(".")} (JSON ${j.path || "value"})`, l.attr, j.value, true);
        }
        for (const [attr, refs] of Object.entries(r.refs)) {
          if (!r.configured.has(attr)) continue;
          if (refs.some((x) => target(x)?.mode === "managed")) anchored = true;
          const scopeLike = attr === "scope" || attr === "resource_group_name" || attr === "assignable_scopes" || attr === "scopes" || (/_ids?$/.test(attr) && !NOT_ARM.has(attr));
          if (!scopeLike) continue;
          const unknownHere = all.some((l) => l.attr === attr && l.value instanceof Unknown);
          if (!unknownHere) continue;
          // count.index and each.key are the instance's key; each.value is judged by the for_each it comes from.
          const eachValue = refs.some((x) => EACH_VALUE_REF.test(x)) ? forEachValue(r) : null;
          const rest = refs.filter((x) => !INDEX_REF.test(x) && !EACH_VALUE_REF.test(x));
          const bad = [...rest.filter((x) => !placed(x)), ...(eachValue === "unknown" ? ["each.value"] : [])];
          const places = rest.some(placed) || eachValue === "places";
          if (bad.length || !places) refuse("outside-scope", `${attr} comes from ${bad[0] ?? refs[0] ?? "nothing this check can place"}, which the check cannot place inside the lab`);
        }
        // Ids at any path, a whole top-level attribute included (a failover group's partner_server.0.id and
        // databases, a replicated VM's managed_disk.0.target_resource_group_id, a jsonencode()d parameters):
        // an unknown one must come from the lab's own resources too. Its references are its own inside a schema
        // block, or the whole attribute's inside an attribute written as blocks (planResources), and every one
        // of them must place it inside the lab.
        for (const l of all) {
          if (!(l.value instanceof Unknown)) continue;
          const refs = l.value.refs ?? [];
          if (!refs.length) continue; // computed by the provider, not configured
          const named = String([...l.path].reverse().find((k) => typeof k === "string" && !/^\d+$/.test(k)));
          // An id by its name (…id, …_id, …_ids), or a value made from ids (databases.0, contact_groups), or from a
          // whole data source (data.x[*].id: Terraform lists only the data source, an object that holds ids).
          if (!ID_NAME(named) && !refs.some(ID_REF) && !refs.some((x) => WHOLE_DATA_REF(x, refs))) continue;
          const eachValue = refs.some((x) => EACH_VALUE_REF.test(x)) ? forEachValue(r) : null;
          const rest = refs.filter((x) => !INDEX_REF.test(x) && !EACH_VALUE_REF.test(x));
          const bad = [...rest.filter((x) => !placed(x)), ...(eachValue === "unknown" ? ["each.value"] : [])];
          if (bad.length || !(rest.some(placed) || eachValue === "places")) refuse("outside-scope", `${l.path.join(".")} comes from ${bad[0] ?? refs[0]}, which the check cannot place inside the lab`);
        }
        if (!anchored) refuse("outside-scope", "it is tied to nothing inside the lab's resource group");
      }
    }

    // One line per resource: the first rule, in RULES order.
    if (found.length) out.push(found.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule))[0]);
  }
  // An import whose target is not a resource of this configuration is still refused.
  const known = new Set(resources.map((r) => stripIndex(r.address)));
  for (const a of importing) if (!known.has(a)) out.push({ rule: "import", address: a, message: "a lab only creates: importing would adopt an object that already exists" });

  for (const p of providers ?? []) {
    if (!PROVIDER_NAMES.has(p.name)) continue; // its resources are refused one by one
    const bad = p.keys.filter((k) => PROVIDER_CREDENTIALS.includes(k));
    if (bad.length) out.push({ rule: "provider", address: `provider.${p.key}`, message: `a lab provider may not set ${bad.join(", ")}: it uses the pipeline's own subscription and login` });
  }
  return out;
}

export const checkPlan = (plan, labId) => scopeProblems(planResources(plan), labId, { mode: "plan" });
export const checkHcl = (hcl, labId) => scopeProblems(hclResources(hcl, labId), labId, { mode: "hcl" });

// ── Command line ─────────────────────────────────────────────────────────

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const planFile = arg("--plan");
  const hclFile = arg("--hcl");
  const lab = arg("--lab");
  if (!lab || !LAB_ID_RE.test(lab) || (!planFile) === (!hclFile)) {
    console.error("Usage: node infra/ci/lab-scope.mjs (--plan <terraform show -json file> | --hcl <hcl2json file>) --lab <lab id>");
    return 2;
  }
  let json;
  try {
    json = JSON.parse(readFileSync(planFile ?? hclFile, "utf8"));
  } catch (e) {
    console.error(`lab-scope: cannot read ${planFile ?? hclFile}: ${e.message}`);
    return 2;
  }
  const problems = planFile ? checkPlan(json, lab) : checkHcl(json, lab);
  const n = (planFile ? planResources(json) : hclResources(json, lab)).resources.length;
  for (const p of problems) console.log(`${p.rule}: ${p.address} (${p.message})`);
  if (problems.length) {
    console.error(`lab-scope: refused ${problems.length} of ${n} resource(s) for ${lab}; nothing was built`);
    return 1;
  }
  console.error(`lab-scope: ${n} resource(s), all inside ${lab}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
