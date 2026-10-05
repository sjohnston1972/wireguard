// scripts/lib/labs.mjs
//
// Plain English: the script-side twin of shared/labs.ts. It reads the lab
// folders (labs/<id>/{lab.yaml,readme.md,terraform/}), checks every rule the
// spec sets for them (§3.2 to §3.4, §4, §11.1) and builds the catalogue the
// Worker bundles (shared/labs.generated.json). npm run labs-build and npm run
// labs-check are thin wrappers around it; L1's lab-scope and labs-tf reuse it.
// No cloud calls: files, git and arithmetic only.
//
// The constants are copies of shared/labs.ts (a test keeps them equal), so
// scripts never have to load TypeScript.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ── Constants (copies of shared/labs.ts) ─────────────────────────────────

export const LAB_ID_RE = /^az(104|305)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const LAB_ID_MAX = 40;
export const LAB_POOL = "10.64.0.0/13";
export const LAB_SLOTS = 32;
export const GATEWAY_RANGES = ["10.13.13.0/24", "10.13.255.1/32", "10.50.0.0/16", "192.168.1.0/24", "172.17.0.0/16", "168.63.129.16/32"];
export const GOVERNANCE_LABS = ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone", "az305-21-monitoring-scale"];
export const LAB_TF_VARS = ["lab_id", "name_prefix", "resource_group_name", "region", "secondary_region", "address_space", "peered", "gateway_vnet_id", "admin_password", "ssh_public_key", "upn_domain", "tags"];

/** The roles a lab may assign (plan ruling 3). */
export const ALLOWED_ROLES = JSON.parse(readFileSync(new URL("../../labs/setup/allowed-roles.json", import.meta.url), "utf8"));

/** The standard readme footer (§3.3), with the lab's id filled in. */
export function readmeFooter(id) {
  return `Anything you build by hand inside \`rg-lab-${id}\` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts \`lab-${id}-\`.`;
}

// ── Addresses ────────────────────────────────────────────────────────────

const ipToInt = (ip) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
function cidrRange(cidr) {
  const [ip, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits ?? 32));
  const start = Math.floor(ipToInt(ip) / size) * size;
  return [start, start + size - 1];
}
export function cidrOverlaps(a, b) {
  const [a0, a1] = cidrRange(a);
  const [b0, b1] = cidrRange(b);
  return a0 <= b1 && b0 <= a1;
}
export function slotCidr(n) {
  if (!Number.isInteger(n) || n < 0 || n >= LAB_SLOTS) throw new RangeError(`slot ${n} is outside 0-${LAB_SLOTS - 1}`);
  return `${intToIp(ipToInt(LAB_POOL.split("/")[0]) + n * 16384)}/18`;
}

/** The pool's problems (§11.1): 32 slots inside it, none overlapping each other or any of `ranges`. [] when all is well. */
export function checkPool(ranges = GATEWAY_RANGES) {
  const out = [];
  const slots = Array.from({ length: LAB_SLOTS }, (_, n) => slotCidr(n));
  for (const s of slots) if (!cidrOverlaps(s, LAB_POOL) || cidrRange(s)[1] > cidrRange(LAB_POOL)[1]) out.push(`slot ${s} is outside the pool ${LAB_POOL}`);
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) if (cidrOverlaps(slots[i], slots[j])) out.push(`slots ${slots[i]} and ${slots[j]} overlap`);
  for (const r of ranges) if (cidrOverlaps(LAB_POOL, r)) out.push(`the lab pool ${LAB_POOL} overlaps ${r}`);
  return out;
}

// ── lab.yaml (spec §3.2) ─────────────────────────────────────────────────

/** Parse lab.yaml text. `problems` is non-empty when it is not YAML or not a mapping. */
export function parseLabYaml(text) {
  let raw;
  try {
    // YAML 1.1, as PyYAML and most tools read it: an unquoted off or no is a boolean and is refused.
    raw = parseYaml(text, { version: "1.1" });
  } catch (e) {
    return { raw: null, problems: [{ field: null, message: `lab.yaml is not valid YAML: ${e.message.split("\n")[0]}` }] };
  }
  if (!isObj(raw)) return { raw: null, problems: [{ field: null, message: "lab.yaml must be a mapping of keys to values" }] };
  return { raw, problems: [] };
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => typeof v === "string";
const text = (v) => typeof v === "string" && v.trim().length > 0;
const int = (min, max = Infinity) => (v) => Number.isInteger(v) && v >= min && v <= max;
const num = (min) => (v) => typeof v === "number" && Number.isFinite(v) && v >= min;
const bool = (v) => typeof v === "boolean";
const oneOf = (...xs) => (v) => xs.includes(v);
const nullOr = (f) => (v) => v === null || f(v);
const VM_SIZE = /^Standard_[A-Za-z0-9_]{1,40}$/;
const REGION = /^[a-z][a-z0-9]{1,30}$/;

// Each key: [check, what it must be, optional?]. Objects nest; arrays check each element.
const ITEM = { name: [text, "a name"], gbp_h: [num(0), "a price of 0 or more (£ per hour)"], qty: [int(1), "a whole number of 1 or more", true], retail: [{ meter: [text, "a meter name", true], unit: [text, "a unit", true], sku: [(v) => str(v) && VM_SIZE.test(v), "a VM size (Standard_...)", true] }, "", true] };
const SCHEMA = {
  id: [str, "text"],
  version: [int(1), "a whole number of 1 or more"],
  title: [text, "a title"],
  summary: [text, "a summary"],
  exam: [oneOf("AZ-104", "AZ-305"), "AZ-104 or AZ-305"],
  skill_areas: [[str], "a list of skill area keys"],
  level: [oneOf("foundation", "associate", "expert"), "foundation, associate or expert"],
  type: [oneOf("explore", "break-fix"), "explore or break-fix"],
  prerequisites: [[str], "a list of lab ids"],
  cost: [{ items: [[ITEM], "a list of cost items"], pricey: [nullOr(str), "null or the name of a cost item"] }, ""],
  timing: [{ deploy_min: [int(1), "whole minutes, 1 or more"], destroy_min: [int(1), "whole minutes, 1 or more"], session_h: [int(1), "whole hours, 1 or more"], max_h: [int(1, 12), "whole hours, 1 to 12"] }, ""],
  capacity: [{ vm_sizes: [[(v) => str(v) && VM_SIZE.test(v)], "a list of VM sizes (Standard_...)"] }, ""],
  regions: [{ secondary: [nullOr((v) => str(v) && REGION.test(v)), "null or an Azure region name (ukwest)"] }, ""],
  connectivity: [{ peering: [oneOf("off", "optional", "required"), "off, optional or required"], dns_link: [bool, "true or false"], subnets_used: [int(0, 4), "a whole number from 0 to 4"] }, ""],
  identity: [{ creates: [[oneOf("user", "group")], "a list of user and group"], roles: [[{ role: [text, "a role name"], scope: [oneOf("resource_group", "resource", "management_group"), "resource_group, resource or management_group"] }], "a list of role assignments"], governance: [bool, "true or false"] }, ""],
};

/** Check `v` against a schema entry; push problems with dotted field paths. Array elements report against the array's path. */
function checkShape(v, spec, path, out) {
  const [check, what] = spec;
  if (Array.isArray(check)) {
    if (!Array.isArray(v)) return out.push({ field: path, message: `${path} must be ${what}` });
    for (const el of v) checkShape(el, [check[0], what], path, out);
    return;
  }
  if (typeof check === "function") {
    if (!check(v)) out.push({ field: path, message: `${path} must be ${what}` });
    return;
  }
  // A nested object.
  if (!isObj(v)) return out.push({ field: path, message: `${path} must be a mapping` });
  for (const k of Object.keys(v)) if (!Object.hasOwn(check, k)) out.push({ field: `${path}.${k}`.replace(/^\./, ""), message: `${`${path}.${k}`.replace(/^\./, "")} is not a lab.yaml field` });
  for (const [k, sub] of Object.entries(check)) {
    const p = `${path}.${k}`.replace(/^\./, "");
    if (v[k] === undefined) {
      if (!sub[2]) out.push({ field: p, message: `${p} is missing` });
      continue;
    }
    checkShape(v[k], sub, p, out);
  }
}

/**
 * Validate one lab on its own (every rule except those that need the other
 * labs: prerequisites and id prefixes; see buildCatalogue). `ctx`: { folder,
 * skillAreas: SkillArea[] }. Returns { def, problems }; def (with `number`)
 * only when there are no problems.
 */
export function validateLab(raw, ctx) {
  const problems = [];
  checkShape(raw, [SCHEMA, ""], "", problems);
  const bad = (field, message) => problems.push({ field, message });
  const id = raw?.id;
  if (str(id)) {
    if (!LAB_ID_RE.test(id)) bad("id", `id "${id}" must look like az104-NN-slug or az305-NN-slug (lowercase letters, digits and single hyphens)`);
    if (id.length > LAB_ID_MAX) bad("id", `id "${id}" is longer than ${LAB_ID_MAX} characters`);
    if (ctx.folder !== undefined && id !== ctx.folder) bad("id", `id "${id}" must equal its folder name "${ctx.folder}"`);
    if (raw.exam && LAB_ID_RE.test(id) && raw.exam !== (id.startsWith("az104-") ? "AZ-104" : "AZ-305")) bad("exam", `exam ${raw.exam} does not match the id ${id}`);
    if (typeof raw.identity?.governance === "boolean" && raw.identity.governance !== GOVERNANCE_LABS.includes(id)) {
      bad("identity.governance", GOVERNANCE_LABS.includes(id) ? `${id} is a governance lab: set identity.governance: true` : `only labs 1, 2, 3, 20 and 21 may set identity.governance: true`);
    }
    for (const r of Array.isArray(raw.identity?.roles) ? raw.identity.roles : []) {
      if (!isObj(r)) continue;
      const allowed = ALLOWED_ROLES.builtIn.some((b) => b.name === r.role) || ALLOWED_ROLES.custom.some((c) => c.lab === id && c.name === r.role);
      if (str(r.role) && !allowed) bad("identity.roles", `role "${r.role}" is not on the allow-list (labs/setup/allowed-roles.json)`);
      if (r.scope === "subscription") bad("identity.roles", "a lab never assigns a role at subscription scope (§8.3)");
    }
  }
  if (Array.isArray(raw?.skill_areas)) {
    if (!raw.skill_areas.length) bad("skill_areas", "skill_areas needs at least one key from labs/skill-areas.yaml");
    for (const k of raw.skill_areas) {
      const area = ctx.skillAreas.find((a) => a.key === k);
      if (!area) bad("skill_areas", `skill area "${k}" is not in labs/skill-areas.yaml`);
      else if (raw.exam && area.exam !== raw.exam) bad("skill_areas", `skill area "${k}" belongs to ${area.exam}, not ${raw.exam}`);
    }
  }
  const t = raw?.timing;
  if (isObj(t) && Number.isInteger(t.session_h) && Number.isInteger(t.max_h) && t.session_h > t.max_h) bad("timing.session_h", `session_h (${t.session_h}) is more than max_h (${t.max_h})`);
  const c = raw?.cost;
  if (isObj(c) && Array.isArray(c.items)) {
    if (!c.items.length) bad("cost.items", "cost.items needs at least one item (a free lab lists one at gbp_h: 0)");
    if (str(c.pricey) && !c.items.some((i) => i?.name === c.pricey)) bad("cost.pricey", `pricey "${c.pricey}" names no cost item`);
    const sizes = Array.isArray(raw?.capacity?.vm_sizes) ? raw.capacity.vm_sizes : [];
    for (const i of c.items) {
      if (!isObj(i?.retail)) continue;
      if (!i.retail.meter && !i.retail.sku) bad("cost.items", `cost item "${i.name}": retail needs a meter or a sku`);
      if (i.retail.unit && !i.retail.meter) bad("cost.items", `cost item "${i.name}": retail.unit goes with a meter`);
      if (i.retail.sku && !sizes.includes(i.retail.sku)) bad("capacity.vm_sizes", `cost item "${i.name}" is a ${i.retail.sku}: list it in capacity.vm_sizes too`);
    }
  }
  const k = raw?.connectivity;
  if (isObj(k) && k.subnets_used === 0 && k.peering && k.peering !== "off") bad("connectivity.subnets_used", "a lab with no subnets (subnets_used: 0) cannot peer: set peering: off");
  if (problems.length) return { def: null, problems };
  return { def: { ...raw, number: Number(id.split("-")[1]) }, problems };
}

// ── readme.md (spec §3.3, plan ruling 2) ─────────────────────────────────

const REQUIRED = ["What it deploys", "Things to try", "Learn more"];

/** Inline markdown: **bold**, `code`, [text](https://...). Anything else that looks like markup is a problem. */
function parseInline(s, problems) {
  const out = [];
  const push = (t, x) => {
    const last = out[out.length - 1];
    if (t === "text" && last?.t === "text") last.text += x.text;
    else out.push({ t, ...x });
  };
  const plain = (x) => {
    if (!x) return;
    if (/!\[/.test(x)) problems.push(`images are not allowed: ${x.trim()}`);
    else if (/<[A-Za-z/!]/.test(x)) problems.push(`raw HTML is not allowed (put names like <id> in backticks): ${x.trim()}`);
    else if (/\*/.test(x)) problems.push(`only **bold** is allowed, not italics or a stray *: ${x.trim()}`);
    else if (/(^|[^A-Za-z0-9])_[^_\s][^_]*_($|[^A-Za-z0-9])/.test(x)) problems.push(`italics are not allowed: ${x.trim()}`);
    push("text", { text: x });
  };
  if (/!\[[^\]]*\]\(/.test(s)) problems.push(`images are not allowed: ${s.trim()}`);
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of s.matchAll(re)) {
    plain(s.slice(at, m.index));
    if (m[1] !== undefined) push("b", { text: m[1] });
    else if (m[2] !== undefined) push("code", { text: m[2] });
    else {
      if (!/^https:\/\/[^\s]+$/.test(m[4])) problems.push(`links must be https:// addresses: ${m[4]}`);
      push("a", { text: m[3], href: m[4] });
    }
    at = m.index + m[0].length;
  }
  plain(s.slice(at));
  return out;
}

/** Parse readme lines into blocks; stops at `</details>` when inside one. Returns [blocks, next line index]. */
function parseBlocks(lines, i, problems, inDetails) {
  const blocks = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) blocks.push({ t: "p", inlines: parseInline(para.join(" "), problems) });
    if (list) blocks.push({ t: "ul", items: list.map((item) => parseInline(item, problems)) });
    para = null;
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      const lang = line.slice(3).trim() || null;
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) problems.push("a code block is never closed with ```");
      blocks.push({ t: "code", lang, text: body.join("\n") });
      i++;
      continue;
    }
    if (trimmed === "</details>") {
      flush();
      if (inDetails) return [blocks, i + 1];
      problems.push("</details> without <details>");
      i++;
      continue;
    }
    if (/^<details\b/.test(trimmed)) {
      flush();
      if (inDetails) problems.push("details inside details is not allowed");
      if (trimmed !== "<details>") problems.push("details must be closed when the page opens: write <details> without open");
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const sm = (lines[j] ?? "").trim().match(/^<summary>(.+)<\/summary>$/);
      if (!sm) problems.push("<details> must be followed by <summary>...</summary>");
      const [inner, next] = parseBlocks(lines, sm ? j + 1 : i + 1, problems, true);
      if (next > lines.length) problems.push("<details> is never closed with </details>");
      blocks.push({ t: "details", summary: sm ? sm[1].trim() : "", blocks: inner });
      i = next;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      if (h[1].length > 3) problems.push(`headings go down to ### only: ${trimmed}`);
      else blocks.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    const b = line.match(/^[-*] (.*)$/);
    if (b) {
      if (para) flush();
      (list ??= []).push(b[1].trim());
      i++;
      continue;
    }
    if (list && /^ {2,}\S/.test(line) && !/^\s+([-*+]|\d+[.)])\s/.test(line)) {
      list[list.length - 1] += " " + trimmed;
      i++;
      continue;
    }
    if (/^\s+([-*+]|\d+[.)])\s/.test(line)) problems.push(`nested lists are not allowed: ${trimmed}`);
    else if (/^\d+[.)]\s/.test(trimmed)) problems.push(`numbered lists are not allowed: ${trimmed}`);
    else if (/^>/.test(trimmed)) problems.push(`quotes are not allowed: ${trimmed}`);
    else if (/^\|/.test(trimmed)) problems.push(`tables are not allowed: ${trimmed}`);
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) problems.push(`horizontal rules are not allowed: ${trimmed}`);
    else if (/^( {4}|\t)/.test(line)) problems.push(`indented code is not allowed, use a fenced block: ${trimmed}`);
    else if (/^</.test(trimmed)) problems.push(`raw HTML is not allowed: ${trimmed}`);
    else {
      if (list) flush();
      (para ??= []).push(trimmed);
    }
    i++;
  }
  flush();
  if (inDetails) return [blocks, lines.length + 1];
  return [blocks, i];
}

/**
 * Parse a readme into ReadmeBlock[] (shared/labs.ts). With a lab id, the
 * lab rules apply too: the required headings (plus Symptom and a closed
 * "What was broken" details for break-fix), 3 to 6 Things to try and the
 * standard footer. With id null, only the markdown subset is checked.
 * Returns { blocks, problems } (problems are plain sentences).
 */
export function parseReadme(md, type, id) {
  const problems = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const [blocks] = parseBlocks(lines, 0, problems, false);
  if (id) {
    const h2 = blocks.filter((b) => b.t === "h" && b.level === 2).map((b) => b.text);
    for (const need of type === "break-fix" ? [...REQUIRED, "Symptom"] : REQUIRED) if (!h2.includes(need)) problems.push(`the readme needs a "## ${need}" heading`);
    const at = blocks.findIndex((b) => b.t === "h" && b.text === "Things to try");
    if (at >= 0) {
      const ul = blocks.slice(at + 1).find((b) => b.t === "ul" || b.t === "h");
      const n = ul?.t === "ul" ? ul.items.length : 0;
      if (n < 3 || n > 6) problems.push(`Things to try needs 3 to 6 bullets (has ${n})`);
    }
    if (type === "break-fix" && !blocks.some((b) => b.t === "details" && b.summary === "What was broken")) {
      problems.push('a break-fix readme needs a closed <details><summary>What was broken</summary> ... </details>');
    }
    const flat = (s) => s.replace(/\s+/g, " ").trim();
    if (!flat(md).includes(flat(readmeFooter(id)))) problems.push("the readme needs the standard footer (readmeFooter in scripts/lib/labs.mjs)");
  }
  return { blocks, problems };
}

// ── Terraform text (spec §3.4, §8.4 early warning) ───────────────────────

// Blank out comments (#, //, and block comments), keeping strings, lines and columns.
function stripComments(src) {
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

const TF_RULES = [
  { rule: "literal-cidr", re: /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/g, ok: (m) => m === "0.0.0.0/0", message: (m) => `literal CIDR ${m}: every address comes from cidrsubnet(var.address_space, ...)` },
  { rule: "provisioner", re: /\bprovisioner\s+"/g, message: () => "provisioners are not allowed" },
  { rule: "provider", re: /\b(?:resource|data)\s+"(?:null_\w*|local_\w*|external|http)"/g, message: (m) => `${m}: the null, external, http and local providers are not allowed` },
  { rule: "provider", re: /\bprovider\s+"(?:null|external|http|local)"/g, message: (m) => `${m}: the null, external, http and local providers are not allowed` },
  { rule: "provider", re: /^\s*(?:null|external|http|local)\s*=\s*\{/gm, message: (m) => `${m.trim()}: the null, external, http and local providers are not allowed` },
  { rule: "provider", re: /"hashicorp\/(?:null|external|http|local)"/g, message: (m) => `${m}: the null, external, http and local providers are not allowed` },
  { rule: "import", re: /^\s*import\s*\{/gm, message: () => "import blocks are not allowed: a lab only creates, and tear-down would delete what it adopted" },
  { rule: "gateway", re: /\brg-wg\b|\bvnet-wg\b/g, message: (m) => `${m}: lab Terraform never names the gateway's resources (only var.gateway_vnet_id)` },
];

/** Lint a lab's Terraform files ({ "main.tf": text, ... }). Returns [{ file, line, rule, message }]. */
export function lintTfText(files) {
  const out = [];
  for (const [file, src] of Object.entries(files)) {
    const code = stripComments(src);
    for (const r of TF_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: code.slice(0, m.index).split("\n").length, rule: r.rule, message: r.message(m[0]) });
      }
    }
  }
  return out;
}

/** A variables.tf may declare only §3.4 variables (LAB_TF_VARS). Returns problem sentences. */
export function variablesProblems(tf) {
  const out = [];
  for (const m of stripComments(tf).matchAll(/\bvariable\s+"([^"]+)"/g)) if (!LAB_TF_VARS.includes(m[1])) out.push(`variable "${m[1]}" is not one the pipeline fills (§3.4: ${LAB_TF_VARS.join(", ")})`);
  return out;
}

// ── The catalogue ────────────────────────────────────────────────────────

/** Lab folders under `root`: directories not starting with "_" and not "setup". */
export function labFolders(root) {
  return readdirSync(root)
    .filter((n) => !n.startsWith("_") && n !== "setup" && !n.startsWith("."))
    .filter((n) => statSync(join(root, n)).isDirectory())
    .sort();
}

/**
 * Read every lab under `root` (the repo's labs/ folder) and build the
 * catalogue (LabCatalogue in shared/labs.ts). Returns { catalogue, problems };
 * problems are { lab, file, field, message }. The catalogue holds only the
 * labs that passed, sorted AZ-104 then AZ-305 by number.
 */
export function buildCatalogue(root) {
  const problems = [];
  let skillAreas = [];
  try {
    skillAreas = parseYaml(readFileSync(join(root, "skill-areas.yaml"), "utf8"));
    if (!Array.isArray(skillAreas) || !skillAreas.every((a) => isObj(a) && text(a.key) && oneOf("AZ-104", "AZ-305")(a.exam) && text(a.name) && Object.keys(a).length === 3)) {
      problems.push({ lab: null, file: "skill-areas.yaml", field: null, message: "skill-areas.yaml must be a list of { key, exam, name }" });
      skillAreas = [];
    }
  } catch (e) {
    problems.push({ lab: null, file: "skill-areas.yaml", field: null, message: `skill-areas.yaml: ${e.message.split("\n")[0]}` });
  }
  const defs = [];
  const readmes = {};
  for (const folder of labFolders(root)) {
    const at = (file, field, message) => problems.push({ lab: folder, file, field, message });
    const yamlPath = join(root, folder, "lab.yaml");
    if (!existsSync(yamlPath)) {
      at("lab.yaml", null, "the folder has no lab.yaml");
      continue;
    }
    const parsed = parseLabYaml(readFileSync(yamlPath, "utf8"));
    for (const p of parsed.problems) at("lab.yaml", p.field, p.message);
    if (!parsed.raw) continue;
    const v = validateLab(parsed.raw, { folder, skillAreas });
    for (const p of v.problems) at("lab.yaml", p.field, p.message);
    const readmePath = join(root, folder, "readme.md");
    if (!existsSync(readmePath)) at("readme.md", "readme", "the folder has no readme.md");
    else {
      const r = parseReadme(readFileSync(readmePath, "utf8"), parsed.raw.type, folder);
      for (const m of r.problems) at("readme.md", "readme", m);
      if (v.def && !r.problems.length) readmes[v.def.id] = r.blocks;
    }
    if (v.def) defs.push(v.def);
  }
  // Rules across labs: id prefixes, numbers, prerequisites and their cycles.
  const ids = defs.map((d) => d.id);
  for (const d of defs) {
    const at = (field, message) => problems.push({ lab: d.id, file: "lab.yaml", field, message });
    for (const o of ids) if (o !== d.id && d.id.startsWith(o)) at("id", `id ${d.id} starts with another lab's id (${o}): a lab's names would be ambiguous`);
    for (const o of defs) if (o !== d && o.number === d.number && o.id < d.id) at("id", `lab number ${d.number} is also used by ${o.id}`);
    for (const p of d.prerequisites) {
      if (p === d.id) at("prerequisites", `${d.id} cannot be its own prerequisite`);
      else if (!ids.includes(p)) at("prerequisites", `prerequisite ${p} is not a lab in the catalogue`);
    }
  }
  const byId = new Map(defs.map((d) => [d.id, d]));
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "busy") {
      problems.push({ lab: id, file: "lab.yaml", field: "prerequisites", message: `prerequisites go round in a circle: ${[...path, id].join(" -> ")}` });
      return;
    }
    state.set(id, "busy");
    for (const p of byId.get(id)?.prerequisites ?? []) if (p !== id && byId.has(p)) visit(p, [...path, id]);
    state.set(id, "done");
  };
  for (const id of ids) visit(id, []);
  const bad = new Set(problems.map((p) => p.lab));
  const labs = defs.filter((d) => !bad.has(d.id)).sort((a, b) => a.exam.localeCompare(b.exam) || a.number - b.number);
  for (const id of Object.keys(readmes)) if (bad.has(id)) delete readmes[id];
  return { catalogue: { schema: 1, skillAreas, labs, readmes }, problems };
}

// ── Versions against a base (spec §11.1) ─────────────────────────────────

/**
 * Lab folders under `labsDir` that changed against git ref `base` (committed,
 * staged, unstaged or new files) without their lab.yaml version rising.
 * A lab new since `base` is fine. Returns [{ lab, file, field: "version", message }].
 */
export function versionProblems(labsDir, base) {
  const g = (...args) => spawnSync("git", args, { cwd: labsDir, encoding: "utf8" });
  // The folder's path inside the repo as git spells it ("labs/"), whatever the OS calls it.
  const pre = g("rev-parse", "--show-prefix");
  if (pre.status !== 0) throw new Error(`not a git checkout: ${pre.stderr.trim()}`);
  const rel = pre.stdout.trim().replace(/\/$/, "");
  const out = [];
  for (const folder of labFolders(labsDir)) {
    const path = rel ? `${rel}/${folder}` : folder;
    const was = g("show", `${base}:${path}/lab.yaml`);
    if (was.status !== 0) continue; // new since base
    // Pathspecs are relative to labsDir (the command's cwd); `base:path` above is from the repo's top.
    const diff = g("diff", "--name-only", base, "--", folder);
    const untracked = g("ls-files", "--others", "--exclude-standard", "--", folder);
    if (!diff.stdout.trim() && !untracked.stdout.trim()) continue;
    const before = Number(parseLabYaml(was.stdout).raw?.version);
    const nowText = existsSync(join(labsDir, folder, "lab.yaml")) ? readFileSync(join(labsDir, folder, "lab.yaml"), "utf8") : "";
    const now = Number(parseLabYaml(nowText).raw?.version);
    if (!(now > before)) out.push({ lab: folder, file: "lab.yaml", field: "version", message: `${folder} changed since ${base} but its version did not rise (was ${before}, now ${now})` });
  }
  return out;
}
