// infra/ci/lab-lint.mjs
//
// Plain English: the checks on a lab's Terraform SOURCE that must pass before
// lab.yml runs `terraform init` (labs spec §3.4, §8.4). The plan-time scope
// check (lab-scope.mjs) comes too late for some things: `terraform init`
// downloads whatever providers the files ask for, and `terraform plan` (and
// destroy, which plans first) already runs data sources, with the pipeline's
// Azure and R2 keys in the environment. So, on the text, before anything runs:
//
//   provider        only these providers, matched on the FULL source address
//                   (registry.terraform.io/hashicorp/azurerm, not "anything
//                   ending /azurerm"): azurerm, azuread, random and time. That
//                   refuses azapi, external, http, null, local, the builtin
//                   terraform provider (terraform_data, terraform_remote_state)
//                   and any look-alike from another namespace or registry.
//   provisioner     any provisioner (local-exec runs with the pipeline's keys)
//   module          any module block (it can bring its own providers and code)
//   import          import blocks (a lab only creates; tear-down would delete
//                   what it adopted)
//   backend         a backend other than s3 with the template's settings, or a
//                   cloud block (the state, with the lab's password, must go to R2)
//   file            files Terraform would read that this check cannot:
//                   *.tf.json, *.tfvars (they would override the pipeline's
//                   variables) and CLI configuration (terraform.rc)
//   literal-cidr    an address not from cidrsubnet(var.address_space, ...)
//   gateway         the gateway's names (rg-wg-*, vnet-wg)
//
//   node infra/ci/lab-lint.mjs labs/<id>/terraform
//
// Exit 0: clean. Exit 1: one "rule: file:line (message)" line per problem.
// Exit 2: bad arguments. Plain Node with no packages (npm ci is not run on the
// runner); scripts/lib/labs.mjs re-exports lintTfText for npm run labs-check.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The providers a lab may use, as full source addresses. lab-scope.mjs checks the plan against the same list. */
export const ALLOWED_PROVIDER_SOURCES = ["registry.terraform.io/hashicorp/azurerm", "registry.terraform.io/hashicorp/azuread", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time"];
/** The only settings a lab's backend "s3" block may carry (labs/_template/versions.tf); lab.yml supplies bucket and key. */
export const BACKEND_KEYS = ["region", "use_lockfile", "skip_credentials_validation", "skip_region_validation", "skip_requesting_account_id", "skip_metadata_api_check", "skip_s3_checksum", "use_path_style"];

/** A provider source as Terraform reads it: "azurerm" and "hashicorp/azurerm" both mean registry.terraform.io/hashicorp/azurerm. */
export function normalizeSource(source) {
  const parts = String(source ?? "").trim().toLowerCase().split("/").filter(Boolean);
  if (parts.length === 1) return `registry.terraform.io/hashicorp/${parts[0]}`;
  if (parts.length === 2) return `registry.terraform.io/${parts[0]}/${parts[1]}`;
  return parts.join("/");
}

/** The local provider name a resource or data type belongs to (Terraform: the part before the first "_"). */
export function providerOfType(type) {
  if (type === "terraform_data" || type === "terraform_remote_state") return "terraform";
  return String(type).split("_")[0];
}

/** Blank out comments (#, //, and block comments), keeping strings, lines and columns. */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "\n") inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "#" || (ch === "/" && src[i + 1] === "/")) {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** The index of the "}" closing the "{" at `open`, skipping strings; -1 if none. */
function closeOf(code, open) {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"' || ch === "\n") inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** HCL block labels may be quoted or bare identifiers: `resource "null_resource" "x"` or `resource null_resource x`. */
const LABEL = String.raw`(?:"([^"\n]*)"|([A-Za-z_][\w-]*))`;
const label = (m, i) => m[i] ?? m[i + 1];

const TEXT_RULES = [
  { rule: "literal-cidr", re: /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/g, ok: (m) => m === "0.0.0.0/0", message: (m) => `literal CIDR ${m}: every address comes from cidrsubnet(var.address_space, ...)` },
  { rule: "provisioner", re: new RegExp(String.raw`\bprovisioner\s+${LABEL}`, "g"), message: () => "provisioners are not allowed (they run commands with the pipeline's keys)" },
  { rule: "module", re: new RegExp(String.raw`(?:^|[\s{}])module\s+${LABEL}\s*\{`, "gm"), message: () => "module blocks are not allowed: a module can bring providers and code this check never sees" },
  { rule: "import", re: /^\s*import\s*\{/gm, message: () => "import blocks are not allowed: a lab only creates, and tear-down would delete what it adopted" },
  { rule: "backend", re: /^\s*cloud\s*\{/gm, message: () => "a cloud block is not allowed: the state lives in R2 (backend \"s3\")" },
  { rule: "gateway", re: /\brg-wg\b|\bvnet-wg\b/g, message: (m) => `${m}: lab Terraform never names the gateway's resources (only var.gateway_vnet_id)` },
];

const lineOf = (code, index) => code.slice(0, index).split("\n").length;

/** Declared providers across all files: Map(local name -> { source, file, line }). */
function requiredProviders(codes) {
  const out = new Map();
  for (const [file, code] of codes) {
    for (const m of code.matchAll(/\brequired_providers\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = closeOf(code, open);
      if (close < 0) continue;
      const body = code.slice(open + 1, close);
      // name = { source = "...", version = "..." }
      let flat = body;
      for (const e of body.matchAll(/([A-Za-z_][\w-]*)\s*=\s*\{/g)) {
        const o = e.index + e[0].length - 1;
        const c = closeOf(body, o);
        if (c < 0) continue;
        const inner = body.slice(o + 1, c);
        const src = /\bsource\s*=\s*"([^"]*)"/.exec(inner);
        out.set(e[1], { source: normalizeSource(src ? src[1] : e[1]), file, line: lineOf(code, open + 1 + e.index) });
        flat = flat.slice(0, o) + " ".repeat(c - o + 1) + flat.slice(c + 1);
      }
      // name = "version" (old style: hashicorp/<name>)
      for (const e of flat.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"[^"]*"/g)) if (!out.has(e[1])) out.set(e[1], { source: normalizeSource(e[1]), file, line: lineOf(code, open + 1 + e.index) });
    }
  }
  return out;
}

/**
 * Lint a lab's Terraform files ({ "main.tf": text, ... }), all of them
 * together (providers are declared in one file and used in another).
 * Returns [{ file, line, rule, message }].
 */
export function lintTfText(files) {
  const out = [];
  const codes = Object.entries(files).map(([file, src]) => [file, stripComments(src)]);
  for (const [file, code] of codes) {
    for (const r of TEXT_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: lineOf(code, m.index + (m[0].length - m[0].trimStart().length)), rule: r.rule, message: r.message(m[0].trim()) });
      }
    }
  }

  // provider: every declared provider, and every provider a block uses, by full source address.
  const declared = requiredProviders(codes);
  const allowed = (local) => ALLOWED_PROVIDER_SOURCES.includes(declared.get(local)?.source ?? normalizeSource(local)) && local !== "terraform";
  const refuse = (file, line, local, what) => {
    const src = local === "terraform" ? "terraform.io/builtin/terraform" : (declared.get(local)?.source ?? normalizeSource(local));
    out.push({ file, line, rule: "provider", message: `${what}: provider ${src} is not allowed in a lab (only ${ALLOWED_PROVIDER_SOURCES.join(", ")})` });
  };
  for (const [local, d] of declared) if (!allowed(local)) refuse(d.file, d.line, local, `required_providers ${local}`);
  for (const [file, code] of codes) {
    for (const m of code.matchAll(new RegExp(String.raw`\b(resource|data|ephemeral|action|list)\s+${LABEL}\s+${LABEL}\s*\{`, "g"))) {
      const type = label(m, 2);
      const local = providerOfType(type);
      if (!declared.has(local) && !allowed(local)) refuse(file, lineOf(code, m.index), local, `${m[1]} "${type}"`);
      else if (local === "terraform") refuse(file, lineOf(code, m.index), local, `${m[1]} "${type}"`);
    }
    for (const m of code.matchAll(new RegExp(String.raw`\bprovider\s+${LABEL}\s*\{`, "g"))) {
      const local = label(m, 1);
      if (!declared.has(local) && !allowed(local)) refuse(file, lineOf(code, m.index), local, `provider "${local}"`);
    }
    // provider = other.alias, as a resource's meta-argument
    for (const m of code.matchAll(/^\s*provider\s*=\s*([A-Za-z_][\w-]*)/gm)) {
      if (!declared.has(m[1]) && !allowed(m[1])) refuse(file, lineOf(code, m.index + m[0].indexOf("provider")), m[1], `provider = ${m[1]}`);
    }
    // backend: s3 only, with only the template's settings.
    for (const m of code.matchAll(new RegExp(String.raw`\bbackend\s+${LABEL}\s*\{`, "g"))) {
      const kind = label(m, 1);
      const line = lineOf(code, m.index);
      if (kind !== "s3") {
        out.push({ file, line, rule: "backend", message: `backend "${kind}" is not allowed: the state lives in R2 (backend "s3")` });
        continue;
      }
      const open = m.index + m[0].length - 1;
      const close = closeOf(code, open);
      const body = close < 0 ? "" : code.slice(open + 1, close);
      for (const k of body.matchAll(/^\s*([A-Za-z_][\w-]*)\s*(=|\{)/gm)) {
        if (!BACKEND_KEYS.includes(k[1])) out.push({ file, line: lineOf(code, open + 1 + k.index + k[0].indexOf(k[1])), rule: "backend", message: `backend "s3" may not set ${k[1]}: lab.yml supplies the bucket and key, and the state goes only to R2` });
      }
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Files in a lab's terraform/ folder that Terraform would read but this check cannot. Returns [{ file, line: 1, rule: "file", message }]. */
export function fileProblems(names) {
  const out = [];
  for (const f of names) {
    const n = f.toLowerCase();
    if (n.endsWith(".tf.json")) out.push({ file: f, line: 1, rule: "file", message: "JSON Terraform files are not allowed: write .tf, which this check reads" });
    else if (/\.tfvars(\.json)?$/.test(n)) out.push({ file: f, line: 1, rule: "file", message: "tfvars files are not allowed: they would override the variables the pipeline sets" });
    else if (n === "terraform.rc" || n === ".terraformrc") out.push({ file: f, line: 1, rule: "file", message: "Terraform CLI configuration is not allowed in a lab" });
  }
  return out;
}

/** Everything about one lab's terraform/ folder: file names and the text of its .tf files. */
export function lintDir(dir) {
  const names = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const files = Object.fromEntries(names.filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  return [...fileProblems(names), ...lintTfText(files)];
}

function main(argv) {
  const dir = argv[0];
  if (!dir || argv.length !== 1) {
    console.error("Usage: node infra/ci/lab-lint.mjs <a lab's terraform folder>");
    return 2;
  }
  let problems;
  try {
    problems = lintDir(dir);
  } catch (e) {
    console.error(`lab-lint: cannot read ${dir}: ${e.message}`);
    return 2;
  }
  for (const p of problems) console.log(`${p.rule}: ${p.file}:${p.line} (${p.message})`);
  if (problems.length) {
    console.error(`lab-lint: ${problems.length} problem(s) in ${dir}; Terraform was not started`);
    return 1;
  }
  console.error(`lab-lint: ${dir} uses only ${ALLOWED_PROVIDER_SOURCES.map((s) => s.split("/").pop()).join(", ")} and nothing that runs at init or plan`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
