// scripts/lib/topology-stream.mjs
//
// Plain English: reading a lab's mock plan for its planned diagram (lab
// topology spec §5, rulings 1-2). `terraform test -verbose -json` prints one
// JSON message per line; the run's plan arrives in one "test_plan" message
// with resource_changes (each resource's planned values) and output_changes,
// plus the provider schemas and, inside the values, the mock admin password
// and SSH key. This file takes only what the diagram builder reads: the
// managed resources' address, type, name, index, `after` and `after_unknown`
// with every value Terraform marks sensitive removed, every attribute whose
// name says secret removed, and every string that looks like the mock
// secrets removed; and the outputs the builder reads. The stream itself is
// never printed, written or returned. On a failed run the caller prints
// diagnostics(text) only: the stream's own error messages, redacted.

/** Outputs the planned builder reads (unknown ones arrive as null). */
export const PLAN_OUTPUTS = ["peer_vnet_id"];

const MOCK_PASSWORD = "Mock-Passw0rd-labs-tf-not-real";
const MOCK_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIH03BQA5/AQUCJHTD+mOsPkEaHYZJ/1Dhlg2VWSBcxxC";

/** Attribute names never read (spec §4.5): passwords, keys, custom data, connection strings, certificates. */
const DENY_NAME = /password|secret|^custom_data$|^user_data$|admin_ssh_key|ssh_key|shared_key|_key$|^key$|connection_string|certificate|^sas|_sas_|token|^value$|^content$|private_key/i;

const secretString = (s) => typeof s === "string" && (s.includes(MOCK_PASSWORD) || s.includes(MOCK_KEY) || /-----BEGIN/.test(s));

function* messages(text) {
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // not a JSON message line: skipped, never echoed
    }
  }
}

/**
 * The one `value` read: a container env value that is only a URL to a bare host name, as lab 28's web tier calls
 * its app tier ("http://ca-app"): no dots, credentials, path or query, so it can hold no secret. It draws the
 * planned app -> app edge (rules/planned.ts tierEdges).
 */
const BARE_APP_URL = /^https?:\/\/[a-z][a-z0-9-]{0,31}(:\d{1,5})?\/?$/i;

/** `after` with sensitive paths, denied names and secret-like strings taken out. `envMember`: an element of an `env` list. */
function clean(value, sensitive, envMember = false) {
  if (sensitive === true) return undefined;
  if (Array.isArray(value)) {
    const out = [];
    value.forEach((v, i) => {
      const c = clean(v, Array.isArray(sensitive) ? sensitive[i] : undefined, envMember);
      // Keep positions (an index means something); a dropped member becomes {} or null.
      out.push(c === undefined ? (v && typeof v === "object" ? {} : null) : c);
    });
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const appUrl = envMember && k === "value" && typeof v === "string" && BARE_APP_URL.test(v);
      if (DENY_NAME.test(k) && !appUrl) continue;
      const c = clean(v, sensitive && typeof sensitive === "object" ? sensitive[k] : undefined, k === "env" && Array.isArray(v));
      // null (unset) is left out too: the builder reads absent and null alike, and the input stays small.
      if (c !== undefined && c !== null) out[k] = c;
    }
    return out;
  }
  if (secretString(value)) return undefined;
  return value;
}

/** Managed resource changes reduced to what the builder reads, scrubbed. */
export function scrubChanges(changes) {
  return (changes ?? [])
    .filter((c) => (c.mode ?? "managed") === "managed")
    .map((c) => ({
      address: c.address,
      type: c.type,
      name: c.name,
      index: c.index ?? null,
      after: clean(c.change?.after ?? {}, c.change?.after_sensitive) ?? {},
      after_unknown: c.change?.after_unknown ?? {},
    }));
}

/**
 * { changes, outputs } from a `terraform test -verbose -json` stream's
 * test_plan message. Throws (naming no value) when there is none: a stream
 * without a plan is a failure, never an empty diagram.
 */
export function planFromTestStream(text) {
  for (const m of messages(text)) {
    if (m?.type !== "test_plan" || !m.test_plan) continue;
    const p = m.test_plan;
    const outputs = {};
    for (const name of PLAN_OUTPUTS) {
      const o = p.output_changes?.[name];
      const v = o && o.after_unknown !== true ? clean(o.after, o.after_sensitive) : undefined;
      outputs[name] = v === undefined ? null : v;
    }
    return { changes: scrubChanges(p.resource_changes), outputs };
  }
  throw new Error("the terraform test stream has no test_plan message");
}

/** A reference to a resource (not a variable, local, data source or a dynamic block's own iterator). */
const RESOURCE_REF = /^((?:azurerm|azuread|random|time)_[a-z0-9_]+\.[A-Za-z0-9_-]+)/;

/**
 * The references the builder joins on (ruling 1): for each managed resource
 * block (configuration address "type.name"), each top-level attribute's
 * resource references as "type.name" (sorted, unique), from
 * lab-scope's hclResources over hcl2json's output; and for each output
 * "output.<name>" → { value: [...] }. `hclResources` is passed in (it lives in
 * infra/ci/lab-scope.mjs).
 */
export function refsFromHcl(hcl, labId, hclResources) {
  const refs = {};
  const keep = (list) => [...new Set(list.map((r) => RESOURCE_REF.exec(r)?.[1]).filter(Boolean))].sort();
  for (const r of hclResources(hcl, labId).resources) {
    if (r.mode !== "managed") continue;
    const attrs = {};
    for (const [k, v] of Object.entries(r.refs)) {
      const list = keep(v);
      if (list.length) attrs[k] = list;
    }
    refs[r.address] = attrs;
  }
  for (const [name, blocks] of Object.entries(hcl?.output ?? {})) {
    const text = JSON.stringify((Array.isArray(blocks) ? blocks[0] : blocks)?.value ?? null);
    const list = keep([...text.matchAll(/\$\{([^}]*)\}/g)].flatMap((m) => m[1].match(/[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_]+)*/g) ?? []));
    if (list.length) refs[`output.${name}`] = { value: list };
  }
  return Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The stream's diagnostic messages as "severity: summary: detail" lines, the mock secrets redacted. */
export function diagnostics(text) {
  const out = [];
  for (const m of messages(text)) {
    if (m?.type !== "diagnostic" || !m.diagnostic) continue;
    const d = m.diagnostic;
    const line = `${d.severity ?? "error"}: ${d.summary ?? ""}${d.detail ? `: ${d.detail}` : ""}`;
    out.push(line.split(MOCK_PASSWORD).join("[redacted]").split(MOCK_KEY).join("[redacted]"));
  }
  return out;
}
