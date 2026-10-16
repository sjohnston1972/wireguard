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
//                   variables) and CLI configuration (terraform.rc); and an
//                   x.json beside x.bicep (the pipeline builds it, pinned)
//   literal-cidr    an address not from cidrsubnet(var.address_space, ...)
//   gateway         the gateway's names (rg-wg-*, vnet-wg)
//
// --cloud aws (AWS labs, spec §7.3) swaps in the AWS rules: providers aws,
// random, time, tls and archive; literal CIDRs may also be IPv6 and only
// 0.0.0.0/0 and ::/0 pass; the gateway rule names the VPN server's VPC parts
// (vpc-wg, snet-wg, rt-wg, sg-wg, igw-wg, rt-workloads, snet-workloads, and
// its instances, interface, address, disks and workloads group: AWS_GATEWAY_NAMES) and
// anything called wg-admin-* except the lab permission boundary; aws-provider
// (a provider "aws" block holds only region, alias and default_tags with
// var.tags: no credentials, profile, assume_role, endpoints or account
// settings); and data (no data "tls_certificate"; an archive_file reads only
// inside path.module). Bicep files are not read for AWS. `--cloud aws` also
// reads the CloudFormation templates in `terraform/cfn/` (lab 06; rule cfn,
// ruling P4): short-form tags (`!Ref`: Terraform's yamldecode reads none),
// `Transform`, nested stacks, custom resources, macros, StackSets, SAM, IAM
// types, `Fn::ImportValue`, and `DeletionPolicy`/`UpdateReplacePolicy` other
// than Delete; plus the literal-cidr and gateway rules. --cloud aws also
// refuses, in .tf and cfn/ text, a literal EC2 id (i-, vol-, snap-, eni-, sg-,
// subnet-, vpc-, rtb-, acl- and 8 to 17 hex digits) and an EC2 alarm action
// (automate:, AWS_EC2.InstanceId.: rule known-id), and in .tf timestamp(),
// plantimestamp(), uuid() and bcrypt() (rule apply-time): a plan cannot see a literal
// behind a conditional, nor what an apply-time value chooses (Task 3
// re-review N-4). Azure labs keep timestamp() (az104-04-cost's budget).
//
// A lab's .bicep files (built to ARM JSON after this check, lab.yml step 5)
// get literal-cidr and gateway too, plus module (a registry or template spec
// module, br: or ts:) and provider (extension, import or provider
// statements: Microsoft Graph and the like). lab-scope.mjs's templateProblems
// then reads the built template, at labs-tf and in the plan.
//
//   node infra/ci/lab-lint.mjs [--cloud aws] labs/<id>/terraform
//
// Exit 0: clean. Exit 1: one "rule: file:line (message)" line per problem.
// Exit 2: bad arguments. Plain Node with no packages (npm ci is not run on the
// runner); scripts/lib/labs.mjs re-exports lintTfText for npm run labs-check.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The providers a lab may use, as full source addresses. lab-scope.mjs checks the plan against the same list. */
export const ALLOWED_PROVIDER_SOURCES = ["registry.terraform.io/hashicorp/azurerm", "registry.terraform.io/hashicorp/azuread", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time"];
/** The providers an AWS lab may use, as full source addresses (lab-scope-aws.mjs checks the plan against the same list). */
export const ALLOWED_PROVIDER_SOURCES_AWS = ["registry.terraform.io/hashicorp/aws", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time", "registry.terraform.io/hashicorp/tls", "registry.terraform.io/hashicorp/archive"];
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

// AWS: the same rules, with IPv6 literals, the VPN server's VPC names and the aws-provider / data checks below.
const AWS_BOUNDARY_NAME = "wg-admin-lab-boundary";
/** Every Name tag in infra/aws/main.tf (lab-scope-aws.mjs GATEWAY_NAME_LIST is the same list; a test keeps them equal). */
export const AWS_GATEWAY_NAMES = ["vpc-wg", "snet-wg", "rt-wg", "sg-wg", "igw-wg", "nic-wg", "pip-wg", "vm-wg", "osdisk-wg", "rt-workloads", "snet-workloads", "sg-workloads", "vm-test", "osdisk-test"];
const AWS_TEXT_RULES = [
  { rule: "literal-cidr", re: /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/g, ok: (m) => m === "0.0.0.0/0", message: (m) => `literal CIDR ${m}: every address comes from cidrsubnet(var.address_space, ...)` },
  { rule: "literal-cidr", re: /(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\/\d{1,3}\b/g, ok: (m) => m === "::/0", message: (m) => `literal CIDR ${m}: every address comes from cidrsubnet(var.address_space, ...)` },
  ...TEXT_RULES.filter((r) => ["provisioner", "module", "import", "backend"].includes(r.rule)),
  { rule: "gateway", re: new RegExp(String.raw`\b(${AWS_GATEWAY_NAMES.join("|")})\b`, "g"), message: (m) => `${m}: lab Terraform never names the VPN server's parts (only var.gateway_cidr)` },
  { rule: "gateway", re: /\bwg-admin[\w-]*/g, ok: (m) => m === AWS_BOUNDARY_NAME, message: (m) => `${m}: lab Terraform never names wg-admin resources (only the ${AWS_BOUNDARY_NAME} permission boundary)` },
  // Task 3 re-review N-4: a backstop for what a plan cannot see inside an expression (a literal behind a conditional).
  { rule: "known-id", re: /\b(?:i|vol|snap|eni|sg|subnet|vpc|rtb|acl)-[0-9a-f]{8,17}\b/g, message: (m) => `${m}: an existing AWS resource's id; a lab names its own items by reference` },
  { rule: "known-id", re: /automate:|AWS_EC2\.InstanceId\./gi, message: (m) => `${m}: an EC2 alarm action acts on an instance; a lab's alarm notifies its own topic` },
  { rule: "apply-time", re: /\b(?:plan)?timestamp\s*\(\s*\)|\buuid\s*\(\s*\)|\bbcrypt\s*\(/g, message: (m) => `${m}: a value not known until apply hides what an expression chooses from the plan check` },
];
/** Ruling P4: a lab's CloudFormation templates (terraform/cfn/*.yaml), read as text before init. */
const CFN_RULES = [
  ...AWS_TEXT_RULES.filter((r) => ["literal-cidr", "gateway", "known-id"].includes(r.rule)),
  { rule: "cfn", re: /^\s*Transform\s*:/gm, message: () => "Transform: macros and SAM run code this check never sees" },
  { rule: "cfn", re: /\b(AWS::CloudFormation::(?:Stack|StackSet|CustomResource|Macro|ModuleDefaultVersion|ResourceVersion)|AWS::Serverless::\w+|AWS::IAM::\w+|AWS::Include|Custom::[\w-]+|Fn::Transform|Fn::ImportValue)\b/g, message: (m) => `${m}: a lab's template makes only what lab-scope-aws.mjs CFN_TYPES lists, and reaches nothing outside itself` },
  { rule: "cfn", re: /(?:^|[:\-[,]\s*)!(?:Ref|Sub|GetAtt|Join|If|Equals|Select|Split|FindInMap|Base64|Cidr|GetAZs|ImportValue|Not|And|Or|Condition|Transform|Length|ToJsonString)\b/gm, message: (m) => `${m.trim().replace(/^[:\-[,]\s*/, "")}: write the long form (Ref:, Fn::Sub:): Terraform's yamldecode reads no YAML tags` },
  { rule: "cfn", re: /\b(?:DeletionPolicy|UpdateReplacePolicy)\s*:\s*(?:Retain|RetainExceptOnCreate|Snapshot)\b/g, message: (m) => `${m}: a lab keeps nothing after tear-down (Delete only)` },
  // Final review I-1: a log group with deletion protection on cannot be deleted at tear-down.
  { rule: "cfn", re: /\bDeletionProtectionEnabled"?\s*:\s*"?(?!false\b)[^\s"]+/g, message: (m) => `${m}: a lab keeps nothing after tear-down (false, or leave it out)` },
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

/** The top-level entries of a block body: [{ key, kind: "attr" | "block", index, value }] (value: the rest of the line, or the block's body). */
function topLevel(body) {
  const entries = [];
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    if (depth === 0 && !inStr && (i === 0 || body[i - 1] === "\n")) {
      const m = /^[ \t]*([A-Za-z_][\w-]*)[ \t]*(=|\{)/.exec(body.slice(i, body.indexOf("\n", i) < 0 ? undefined : body.indexOf("\n", i)));
      if (m) {
        if (m[2] === "{") {
          const open = i + m[0].length - 1;
          const close = closeOf(body, open);
          entries.push({ key: m[1], kind: "block", index: i, value: close < 0 ? body.slice(open + 1) : body.slice(open + 1, close) });
        } else {
          const end = body.indexOf("\n", i);
          entries.push({ key: m[1], kind: "attr", index: i, value: body.slice(i + m[0].length, end < 0 ? body.length : end).trim() });
        }
      }
    }
    const ch = body[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"' || ch === "\n") inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
  }
  return entries;
}

const AWS_REGIONS_OK = ["var.region", "var.secondary_region", '"us-east-1"', '"us-west-2"'];

/** AWS: a provider "aws" block is region, alias and default_tags { tags = var.tags }, nothing else. */
function awsProviderProblems(file, code) {
  const out = [];
  for (const m of code.matchAll(/\bprovider\s+"aws"\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    const body = close < 0 ? "" : code.slice(open + 1, close);
    const at = (e) => lineOf(code, open + 1 + e.index);
    const entries = topLevel(body);
    const bad = (line, message) => out.push({ file, line, rule: "aws-provider", message });
    for (const e of entries) {
      if (!["region", "alias", "default_tags"].includes(e.key)) bad(at(e), `provider "aws" may not set ${e.key}: only region, alias and default_tags (credentials come from the run's environment)`);
      else if (e.key === "region" && !AWS_REGIONS_OK.includes(e.value)) bad(at(e), `provider "aws" region must be var.region or var.secondary_region (or a global lab's us-east-1 / us-west-2), not ${e.value}`);
      else if (e.key === "default_tags" && (e.kind !== "block" || e.value.replace(/\s+/g, " ").trim() !== "tags = var.tags")) bad(at(e), 'provider "aws" default_tags must be exactly { tags = var.tags }');
    }
    const line = lineOf(code, m.index);
    if (!entries.some((e) => e.key === "region")) bad(line, 'provider "aws" needs region = var.region');
    if (!entries.some((e) => e.key === "default_tags")) bad(line, 'provider "aws" needs default_tags { tags = var.tags }');
  }
  return out;
}

/** AWS: data "tls_certificate" fetches a remote certificate; an archive_file reads only inside path.module. */
function awsDataProblems(file, code) {
  const out = [];
  for (const m of code.matchAll(new RegExp(String.raw`\bdata\s+${LABEL}\s+${LABEL}\s*\{`, "g"))) {
    const type = label(m, 1);
    const line = lineOf(code, m.index);
    if (type === "tls_certificate") out.push({ file, line, rule: "data", message: 'data "tls_certificate" is not allowed: it fetches a certificate from a URL at plan time' });
    if (type !== "archive_file") continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    for (const e of topLevel(close < 0 ? "" : code.slice(open + 1, close))) {
      if (["source_file", "source_dir", "source"].includes(e.key) && e.kind === "attr" && !(/^"\$\{path\.module\}/.test(e.value) && !e.value.includes(".."))) {
        out.push({ file, line: lineOf(code, open + 1 + e.index), rule: "data", message: `archive_file ${e.key} must start with "\${path.module}" (no other path is read at plan time)` });
      }
    }
  }
  return out;
}

/**
 * Lint a lab's Terraform files ({ "main.tf": text, ... }), all of them
 * together (providers are declared in one file and used in another).
 * `cloud` "aws" applies the AWS rules. Returns [{ file, line, rule, message }].
 */
export function lintTfText(files, { cloud = "azure" } = {}) {
  const aws = cloud === "aws";
  const allowedSources = aws ? ALLOWED_PROVIDER_SOURCES_AWS : ALLOWED_PROVIDER_SOURCES;
  const out = [];
  const codes = Object.entries(files).map(([file, src]) => [file, stripComments(src)]);
  for (const [file, code] of codes) {
    if (aws) out.push(...awsProviderProblems(file, code), ...awsDataProblems(file, code));
    for (const r of aws ? AWS_TEXT_RULES : TEXT_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: lineOf(code, m.index + (m[0].length - m[0].trimStart().length)), rule: r.rule, message: r.message(m[0].trim()) });
      }
    }
  }

  // provider: every declared provider, and every provider a block uses, by full source address.
  const declared = requiredProviders(codes);
  const allowed = (local) => allowedSources.includes(declared.get(local)?.source ?? normalizeSource(local)) && local !== "terraform";
  const refuse = (file, line, local, what) => {
    const src = local === "terraform" ? "terraform.io/builtin/terraform" : (declared.get(local)?.source ?? normalizeSource(local));
    out.push({ file, line, rule: "provider", message: `${what}: provider ${src} is not allowed in a lab (only ${allowedSources.join(", ")})` });
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

/** Blank out Bicep comments (// and block comments), keeping 'strings' (with \' escapes), '''multi-line''' strings, lines and columns. */
export function stripBicepComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("'''", i)) {
      const end = src.indexOf("'''", i + 3);
      const stop = end < 0 ? src.length : end + 3;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== "'" && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
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

const BICEP_RULES = [
  TEXT_RULES.find((r) => r.rule === "literal-cidr"),
  TEXT_RULES.find((r) => r.rule === "gateway"),
  { rule: "module", re: /^\s*module\s+[A-Za-z_]\w*\s+'(?:br|ts)[:/][^']*'/gm, message: () => "a registry or template spec module brings code from elsewhere: keep every module a local .bicep file" },
  { rule: "provider", re: /^\s*(?:extension|import|provider)\b/gm, message: (m) => `${m.trim()}: Bicep extensions (Microsoft Graph and the like) reach beyond the lab's resource group` },
];

/**
 * Lint a lab's Bicep files ({ "main.bicep": text, ... }), which the pipeline
 * builds to ARM JSON before init: literal CIDRs (every address comes from the
 * parameter Terraform passes, cut from the slot), the gateway's names,
 * registry or template spec modules, and extensions or imports.
 * Returns [{ file, line, rule, message }].
 */
export function lintBicepText(files) {
  const out = [];
  for (const [file, src] of Object.entries(files)) {
    const code = stripBicepComments(src.replace(/\r\n/g, "\n"));
    for (const r of BICEP_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: lineOf(code, m.index + (m[0].length - m[0].trimStart().length)), rule: r.rule, message: r.message(m[0].trim()) });
      }
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** Files in a lab's terraform/ folder that Terraform would read but this check cannot. Returns [{ file, line: 1, rule: "file", message }]. */
export function fileProblems(names) {
  const out = [];
  const bicep = new Set(names.filter((f) => /\.bicep$/i.test(f)).map((f) => f.toLowerCase().replace(/\.bicep$/, "")));
  for (const f of names) {
    const n = f.toLowerCase();
    if (n.endsWith(".tf.json")) out.push({ file: f, line: 1, rule: "file", message: "JSON Terraform files are not allowed: write .tf, which this check reads" });
    else if (/\.tfvars(\.json)?$/.test(n)) out.push({ file: f, line: 1, rule: "file", message: "tfvars files are not allowed: they would override the variables the pipeline sets" });
    else if (n === "terraform.rc" || n === ".terraformrc") out.push({ file: f, line: 1, rule: "file", message: "Terraform CLI configuration is not allowed in a lab" });
    else if (n.endsWith(".json") && bicep.has(n.replace(/\.json$/, ""))) out.push({ file: f, line: 1, rule: "file", message: `${f} is built from ${f.replace(/\.json$/i, ".bicep")} by the pipeline's pinned Bicep: never commit it` });
  }
  return out;
}

/** Lint a lab's CloudFormation templates ({ "cfn/stack.yaml": text }), comment lines left out. */
export function lintCfnText(files) {
  const out = [];
  for (const [file, src] of Object.entries(files)) {
    const code = src.replace(/\r\n/g, "\n").replace(/^\s*#.*$/gm, (m) => " ".repeat(m.length));
    for (const r of CFN_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: lineOf(code, m.index + (m[0].length - m[0].trimStart().length)), rule: r.rule, message: r.message(m[0].trim()) });
      }
    }
  }
  return out;
}

/** Everything about one lab's terraform/ folder: file names, the text of its .tf files and of its .bicep files (AWS: its cfn/ templates). */
export function lintDir(dir, { cloud = "azure" } = {}) {
  const names = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const read = (re) => Object.fromEntries(names.filter((f) => re.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const cfnDir = join(dir, "cfn");
  const cfn = cloud === "aws" && existsSync(cfnDir) ? Object.fromEntries(readdirSync(cfnDir).filter((f) => /\.(ya?ml|json)$/i.test(f)).map((f) => [`cfn/${f}`, readFileSync(join(cfnDir, f), "utf8")])) : {};
  return [...fileProblems(names), ...lintTfText(read(/\.tf$/), { cloud }), ...(cloud === "aws" ? lintCfnText(cfn) : lintBicepText(read(/\.bicep$/i)))];
}

function main(argv) {
  let cloud = "azure";
  const args = [...argv];
  if (args[0] === "--cloud") {
    cloud = args[1];
    args.splice(0, 2);
  }
  const dir = args[0];
  if (!dir || args.length !== 1 || !["azure", "aws"].includes(cloud)) {
    console.error("Usage: node infra/ci/lab-lint.mjs [--cloud aws] <a lab's terraform folder>");
    return 2;
  }
  let problems;
  try {
    problems = lintDir(dir, { cloud });
  } catch (e) {
    console.error(`lab-lint: cannot read ${dir}: ${e.message}`);
    return 2;
  }
  for (const p of problems) console.log(`${p.rule}: ${p.file}:${p.line} (${p.message})`);
  if (problems.length) {
    console.error(`lab-lint: ${problems.length} problem(s) in ${dir}; Terraform was not started`);
    return 1;
  }
  console.error(`lab-lint: ${dir} uses only ${(cloud === "aws" ? ALLOWED_PROVIDER_SOURCES_AWS : ALLOWED_PROVIDER_SOURCES).map((s) => s.split("/").pop()).join(", ")} and nothing that runs at init or plan`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
