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
//   provider          a provider other than azurerm, azuread, random, time or
//                     tls (null, external, http, local, azapi, terraform_data),
//                     or an azurerm/azuread provider pointed at other credentials
//   provisioner       any provisioner (it would run commands with the pipeline's keys)
//   gateway           vnet-wg or rg-wg-* named, or var.gateway_vnet_id used,
//                     anywhere but a private DNS zone link's virtual_network_id
//   association       moving a subscription into a management group
//   governance        role/policy definitions and management groups outside the
//                     five governance labs, or without the lab-<id>- prefix
//   entra-type        an Entra object other than a user, a group or a membership
//   entra-prefix      an Entra name, UPN or mail nickname without lab-<id>-, or a
//                     membership of a group the lab did not make
//   role              a role assignment off labs/setup/allowed-roles.json, a custom
//                     role without its fixed GUID, or one that can grant access
//   immutability      a Locked immutability policy (nothing can delete it)
//   azure-made-group  AKS node groups or backup restore groups not named rg-lab-<id>-*
//   resource-group    a resource group other than rg-lab-<id> or rg-lab-<id>-*
//   outside-scope     a resource group, scope or parent outside the lab, anything
//                     at subscription scope, or a resource tied to nothing in the lab
//
// It is plain Node with no packages (the runner has Node; npm ci is not run),
// and it never prints a value Terraform marks sensitive.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LAB_ID_RE = /^az(104|305)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
/** The governance labs, named in code (spec §8.3). A test keeps this equal to shared/labs.ts. */
export const GOVERNANCE_LABS = ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone", "az305-21-monitoring-scale"];
export const RULES = ["provider", "provisioner", "gateway", "association", "governance", "entra-type", "entra-prefix", "role", "immutability", "azure-made-group", "resource-group", "outside-scope"];

const ALLOWED_ROLES = JSON.parse(readFileSync(new URL("../../labs/setup/allowed-roles.json", import.meta.url), "utf8"));
const PROVIDERS = new Set(["azurerm", "azuread", "random", "time", "tls"]);
/** Provider settings that would point a provider at other credentials, another subscription or tenant. */
const PROVIDER_CREDENTIALS = ["subscription_id", "tenant_id", "client_id", "client_secret", "client_certificate", "client_certificate_path", "client_certificate_password", "auxiliary_tenant_ids", "oidc_token", "oidc_token_file_path", "msi_endpoint", "use_cli", "use_msi"];
const GOVERNANCE_TYPES = new Set([
  "azurerm_role_definition",
  "azurerm_policy_definition",
  "azurerm_policy_set_definition",
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
/** Meta-arguments hcl2json shows as attributes. */
const META = new Set(["count", "for_each", "depends_on", "lifecycle", "provider", "provisioner", "connection"]);

/** A value Terraform does not know until apply (plan), or an expression this check cannot evaluate (HCL). `prefix` is the literal start, when known. */
export class Unknown {
  constructor(prefix = "") {
    this.prefix = prefix;
  }
}

// ── Reading a plan (terraform show -json) ────────────────────────────────

const providerOf = (full) => String(full ?? "").split("/").pop();
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
    seen.set(r.address, {
      address: r.address,
      mode: r.mode ?? (r.address.startsWith("data.") ? "data" : "managed"),
      type: r.type,
      provider: providerOf(r.provider_name),
      values,
      refs,
      configured: new Set(Object.keys(exprs)),
      provisioners: (c.provisioners ?? []).length,
      sensitive: new Set(Object.entries(r.sensitive_values ?? {}).filter(([, v]) => v === true).map(([k]) => k)),
    });
  };
  for (const r of moduleResources(plan?.planned_values?.root_module)) add(r);
  for (const r of moduleResources(plan?.prior_state?.values?.root_module)) if (r.mode === "data") add(r);
  // A data source configured but not read yet (or a resource only in the configuration).
  for (const [address, c] of cfg) {
    if ([...seen.keys()].some((a) => stripIndex(a) === address)) continue;
    add({ address, mode: c.mode, type: c.type, provider_name: (plan?.configuration?.provider_config ?? {})[c.provider_config_key]?.full_name ?? c.type.split("_")[0], values: {} });
  }
  const providers = Object.entries(plan?.configuration?.provider_config ?? {}).map(([key, p]) => ({ key, name: p.name ?? key.split(".")[0], keys: Object.keys(p.expressions ?? {}) }));
  return { resources: [...seen.values()], providers };
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
          const prov = typeof block?.provider === "string" ? block.provider.replace(/^\$\{|\}$/g, "").split(".")[0] : type.split("_")[0];
          resources.push({
            address: `${prefix}${type}.${name}`,
            mode: mode === "resource" ? "managed" : "data",
            type,
            provider: prov,
            values,
            refs,
            configured: new Set(Object.keys(refs)),
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
  return { resources, providers };
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

/**
 * Check a lab's resources (from planResources or hclResources). Returns
 * [{ rule, address, message }], at most one per resource.
 */
export function scopeProblems({ resources, providers }, labId) {
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
    if (!PROVIDERS.has(r.provider)) refuse("provider", `the ${r.provider} provider is not allowed in a lab`);
    // provisioner
    if (r.provisioners > 0) refuse("provisioner", "provisioners are not allowed in a lab");

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
      if (r.type === "azurerm_role_definition") {
        const guid = typeof v.role_definition_id === "string" ? v.role_definition_id.toLowerCase() : null;
        const entry = custom.find((c) => c.id.toLowerCase() === guid);
        if (!entry || typeof v.name !== "string" || v.name.toLowerCase() !== entry.name.toLowerCase()) refuse("role", `a custom role needs its fixed name and role_definition_id from labs/setup/allowed-roles.json`);
        const actions = leaves(v.permissions ?? []).filter((l) => l.path.includes("actions") || l.path.includes("data_actions")).map((l) => String(l.value));
        if (actions.some((a) => a === "*" || /^Microsoft\.Authorization\/(\*|.*\/(write|delete|\*)$)/i.test(a))) refuse("role", "a lab custom role may not grant access or hold every action");
      }
      if (r.type === "azurerm_resource_group_template_deployment" || r.type === "azurerm_subscription_template_deployment") {
        let tpl = null;
        try {
          tpl = typeof v.template_content === "string" ? JSON.parse(v.template_content) : null;
        } catch {
          tpl = null;
        }
        const walk = (list) => {
          for (const res of Array.isArray(list) ? list : Object.values(list ?? {})) {
            if (!res || typeof res !== "object") continue;
            if (/^Microsoft\.(Authorization|Management)\//i.test(String(res.type ?? ""))) refuse("role", `the template deploys ${res.type}, which a lab may only make in Terraform`);
            if (["resourceGroup", "subscriptionId", "scope", "managementGroup"].some((k) => k in res)) refuse("outside-scope", `the template sends ${res.type ?? "a resource"} to another scope`);
            walk(res.resources);
            walk(res.properties?.template?.resources);
          }
        };
        if (tpl) walk(tpl.resources);
      }

      // immutability
      for (const l of all) {
        const inImmutable = l.path.some((p) => /immutab/i.test(String(p))) || /immutability_policy/.test(r.type);
        if (inImmutable && (l.value === "Locked" || (l.attr === "locked" && l.value === true) || (String(l.path.at(-1)) === "locked" && l.value === true))) {
          refuse("immutability", `${l.path.join(".")} locks an immutability policy, which nothing can delete until it expires`);
          break;
        }
      }

      // azure-made-group
      if (r.type === "azurerm_kubernetes_cluster" && !startsWithRg(v.node_resource_group)) refuse("azure-made-group", `node_resource_group must be named ${rg}-<suffix>`);
      if (r.type === "azurerm_backup_policy_vm") {
        const irg = Array.isArray(v.instant_restore_resource_group) ? v.instant_restore_resource_group[0] : null;
        if (!irg || !startsWithRg(irg.prefix)) refuse("azure-made-group", `instant_restore_resource_group.prefix must start ${rg}-`);
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
        for (const l of all) {
          if (linkException(l.attr)) continue; // the gateway VNet, through var.gateway_vnet_id only
          const c = classifyId(l.value);
          if (!c) continue;
          if (c.kind === "rg") {
            anchored = true;
            if (!ownRg(c.name)) refuse("outside-scope", `${l.path.join(".")} is in resource group ${c.name}, outside the lab`);
          } else if (c.kind === "mg") {
            anchored = true;
            if (!ownMg(c.name)) refuse("outside-scope", `${l.path.join(".")} is in management group ${c.name}, not one this lab owns`);
          } else if (c.kind === "sub") {
            const definitionRef = DEFINITION_REF.test(c.rest);
            const governanceScope = governance && GOVERNANCE_TYPES.has(r.type) && (l.attr === "scope" || l.attr === "assignable_scopes") && c.rest === "";
            if (!definitionRef && !governanceScope) refuse("outside-scope", `${l.path.join(".")} is at subscription scope; a lab works inside its own group`);
          }
        }
        for (const [attr, refs] of Object.entries(r.refs)) {
          if (!r.configured.has(attr)) continue;
          if (refs.some((x) => target(x)?.mode === "managed")) anchored = true;
          const scopeLike = attr === "scope" || attr === "resource_group_name" || attr === "assignable_scopes" || attr === "scopes" || (/_ids?$/.test(attr) && !NOT_ARM.has(attr));
          if (!scopeLike) continue;
          const unknownHere = all.some((l) => l.attr === attr && l.value instanceof Unknown);
          if (!unknownHere) continue;
          const bad = refs.filter((x) => !(target(x)?.mode === "managed") && x !== "var.resource_group_name" && x !== "var.gateway_vnet_id");
          if (bad.length || refs.length === 0) refuse("outside-scope", `${attr} comes from ${bad[0] ?? "nothing this check can place"}, which the check cannot place inside the lab`);
        }
        if (!anchored) refuse("outside-scope", "it is tied to nothing inside the lab's resource group");
      }
    }

    // One line per resource: the first rule, in RULES order.
    if (found.length) out.push(found.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule))[0]);
  }

  for (const p of providers ?? []) {
    if (!PROVIDERS.has(p.name)) continue; // its resources are refused one by one
    const bad = p.keys.filter((k) => PROVIDER_CREDENTIALS.includes(k));
    if (bad.length) out.push({ rule: "provider", address: `provider.${p.key}`, message: `a lab provider may not set ${bad.join(", ")}: it uses the pipeline's own subscription and login` });
  }
  return out;
}

export const checkPlan = (plan, labId) => scopeProblems(planResources(plan), labId);
export const checkHcl = (hcl, labId) => scopeProblems(hclResources(hcl, labId), labId);

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
