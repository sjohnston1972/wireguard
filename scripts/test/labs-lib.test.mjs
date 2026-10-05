// labs-lib.test.mjs
//
// Plain English: the catalogue checks (scripts/lib/labs.mjs) that labs-build
// and labs-check run. Each §3.2 rule is tried by breaking one field of a good
// lab and checking the refusal names that field; readmes, Terraform text, the
// address pool and the version bump have their own tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yaml12 } from "yaml";

// YAML 1.1, as lab.yaml is read (so "off" is quoted, never a boolean).
const stringify = (v) => yaml12(v, { version: "1.1" });
import {
  buildCatalogue,
  checkPool,
  lintTfText,
  parseLabYaml,
  parseReadme,
  readmeFooter,
  validateLab,
  variablesProblems,
  versionProblems,
} from "../lib/labs.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));

const SKILLS = [
  { key: "az104.identity", exam: "AZ-104", name: "Manage Azure identities and governance" },
  { key: "az104.storage", exam: "AZ-104", name: "Implement and manage storage" },
  { key: "az104.networking", exam: "AZ-104", name: "Implement and manage virtual networking" },
  { key: "az305.data", exam: "AZ-305", name: "Design data storage solutions" },
];

/** A lab.yaml that passes every rule (lab 6 of the spec). */
const good = (over = {}) => ({
  id: "az104-06-blob-security",
  version: 1,
  title: "Blob security: SAS, access policies, private endpoint",
  summary: "A storage account with a private container.",
  exam: "AZ-104",
  skill_areas: ["az104.storage", "az104.networking"],
  level: "associate",
  type: "explore",
  prerequisites: ["az104-05-storage"],
  cost: {
    items: [
      { name: "Storage account, LRS hot, a few MB", gbp_h: 0.0001 },
      { name: "Private endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" } },
    ],
    pricey: null,
  },
  timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 },
  capacity: { vm_sizes: [] },
  regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: true, subnets_used: 1 },
  identity: { creates: ["group"], roles: [{ role: "Storage Blob Data Reader", scope: "resource_group" }], governance: false },
  ...over,
});

const lab5 = () =>
  good({ id: "az104-05-storage", title: "Storage accounts", skill_areas: ["az104.storage"], level: "foundation", prerequisites: [], connectivity: { peering: "off", dns_link: false, subnets_used: 0 }, identity: { creates: [], roles: [], governance: false } });

const readme = (id, type = "explore", extra = "") =>
  [
    "## What it deploys",
    "",
    "- A storage account",
    "",
    "```",
    "rg-lab -> storage",
    "```",
    "",
    ...(type === "break-fix" ? ["## Symptom", "", "Something is broken.", "", "<details>", "<summary>What was broken</summary>", "", "An NSG rule.", "", "</details>", ""] : []),
    "## Things to try",
    "",
    "- One",
    "- Two **bold**",
    "- Three `code`",
    "",
    "## Learn more",
    "",
    "- [Storage](https://learn.microsoft.com/azure/storage/)",
    "",
    extra,
    readmeFooter(id),
    "",
  ].join("\n");

/** A temporary labs/ root with the skill areas and these labs (folder name = lab id unless given). */
function makeRoot(labs, { readmes = {}, folders = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "labs-"));
  writeFileSync(join(root, "skill-areas.yaml"), stringify(SKILLS));
  for (const l of labs) {
    const folder = folders[l.id] ?? l.id;
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "lab.yaml"), stringify(l));
    writeFileSync(join(root, folder, "readme.md"), readmes[l.id] ?? readme(l.id, l.type));
  }
  return root;
}

function problemsFor(labs, opts) {
  const root = makeRoot(labs, opts);
  try {
    return buildCatalogue(root).problems;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a good catalogue builds with no problems, sorted, with numbers and readme blocks", () => {
  const root = makeRoot([good(), lab5()]);
  try {
    const { catalogue, problems } = buildCatalogue(root);
    assert.deepEqual(problems, []);
    assert.equal(catalogue.schema, 1);
    assert.deepEqual(catalogue.labs.map((l) => [l.id, l.number]), [["az104-05-storage", 5], ["az104-06-blob-security", 6]]);
    assert.deepEqual(catalogue.skillAreas, SKILLS);
    assert.equal(catalogue.readmes["az104-06-blob-security"][0].t, "h");
    assert.equal(catalogue.labs[1].cost.items[1].retail.meter, "Standard Private Endpoint");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Each rule: [what, the lab(s), the field the refusal must name].
const RULES = [
  ["id differs from its folder", () => [[good(), lab5()], { folders: { "az104-06-blob-security": "az104-06-other" } }], "id"],
  ["id fails the pattern", () => [[good({ id: "az104-6-blob" }), lab5()], { folders: { "az104-6-blob": "az104-6-blob" } }], "id"],
  ["id longer than 40 characters", () => [[good({ id: "az104-06-blob-security-with-a-very-long-name" }), lab5()]], "id"],
  ["id a prefix of another lab's id", () => [[good(), lab5(), good({ id: "az104-05-storage-more", prerequisites: [] })]], "id"],
  ["exam does not match the id", () => [[good({ exam: "AZ-305" }), lab5()]], "exam"],
  ["unknown skill area", () => [[good({ skill_areas: ["az104.storage", "az104.cooking"] }), lab5()]], "skill_areas"],
  ["no skill area", () => [[good({ skill_areas: [] }), lab5()]], "skill_areas"],
  ["skill area of the other exam", () => [[good({ skill_areas: ["az305.data"] }), lab5()]], "skill_areas"],
  ["unknown prerequisite", () => [[good({ prerequisites: ["az104-99-nothing"] }), lab5()]], "prerequisites"],
  ["cyclic prerequisites", () => [[good(), good({ ...lab5(), prerequisites: ["az104-06-blob-security"] })]], "prerequisites"],
  ["a lab its own prerequisite", () => [[good({ prerequisites: ["az104-06-blob-security"] }), lab5()]], "prerequisites"],
  ["max_h over 12", () => [[good({ timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 13 } }), lab5()]], "timing.max_h"],
  ["session_h over max_h", () => [[good({ timing: { deploy_min: 4, destroy_min: 3, session_h: 7, max_h: 6 } }), lab5()]], "timing.session_h"],
  ["session_h not a whole hour", () => [[good({ timing: { deploy_min: 4, destroy_min: 3, session_h: 1.5, max_h: 6 } }), lab5()]], "timing.session_h"],
  ["deploy_min missing", () => [[good({ timing: { destroy_min: 3, session_h: 2, max_h: 6 } }), lab5()]], "timing.deploy_min"],
  ["empty cost", () => [[good({ cost: { items: [], pricey: null } }), lab5()]], "cost.items"],
  ["a negative price", () => [[good({ cost: { items: [{ name: "x", gbp_h: -1 }], pricey: null } }), lab5()]], "cost.items.gbp_h"],
  ["a pricey that names no item", () => [[good({ cost: { ...good().cost, pricey: "Azure Firewall" } }), lab5()]], "cost.pricey"],
  ["subnets_used above 4", () => [[good({ connectivity: { peering: "optional", dns_link: true, subnets_used: 5 } }), lab5()]], "connectivity.subnets_used"],
  ["subnets_used below 0", () => [[good({ connectivity: { peering: "off", dns_link: false, subnets_used: -1 } }), lab5()]], "connectivity.subnets_used"],
  ["subnets_used 0 with peering", () => [[good({ connectivity: { peering: "optional", dns_link: false, subnets_used: 0 } }), lab5()]], "connectivity.subnets_used"],
  ["an unknown peering mode", () => [[good({ connectivity: { peering: "sometimes", dns_link: true, subnets_used: 1 } }), lab5()]], "connectivity.peering"],
  ["governance on a lab not named in code", () => [[good({ identity: { creates: [], roles: [], governance: true } }), lab5()]], "identity.governance"],
  ["a role not on the allow-list", () => [[good({ identity: { creates: [], roles: [{ role: "Owner", scope: "resource_group" }], governance: false } }), lab5()]], "identity.roles"],
  ["a role at subscription scope", () => [[good({ identity: { creates: [], roles: [{ role: "Reader", scope: "subscription" }], governance: false } }), lab5()]], "identity.roles"],
  ["an unknown key", () => [[good({ colour: "blue" }), lab5()]], "colour"],
  ["an unknown nested key", () => [[good({ timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6, coffee_min: 5 } }), lab5()]], "timing.coffee_min"],
  ["version not a positive whole number", () => [[good({ version: 0 }), lab5()]], "version"],
  ["an unknown level", () => [[good({ level: "wizard" }), lab5()]], "level"],
  ["a VM size that is not one", () => [[good({ capacity: { vm_sizes: ["B1s"] } }), lab5()]], "capacity.vm_sizes"],
];

for (const [what, make, field] of RULES) {
  test(`each §3.2 rule refused with its field: ${what} -> ${field}`, () => {
    const [labs, opts] = make();
    const problems = problemsFor(labs, opts);
    assert.ok(problems.some((p) => p.field === field), `expected a problem on ${field}, got ${JSON.stringify(problems)}`);
  });
}

test("parseLabYaml refuses YAML that does not parse, and validateLab works on one lab alone", () => {
  assert.ok(parseLabYaml("id: [unclosed").problems.length > 0);
  const { raw, problems } = parseLabYaml(stringify(good()));
  assert.deepEqual(problems, []);
  const v = validateLab(raw, { folder: "az104-06-blob-security", skillAreas: SKILLS });
  assert.deepEqual(v.problems, []);
  assert.equal(v.def.number, 6);
  assert.equal(validateLab({ ...raw, title: "" }, { folder: "az104-06-blob-security", skillAreas: SKILLS }).problems[0].field, "title");
});

// ── Readmes ──────────────────────────────────────────────────────────────

test("readme without a required heading is refused", () => {
  for (const heading of ["What it deploys", "Things to try", "Learn more"]) {
    const md = readme("az104-06-blob-security").replace(`## ${heading}`, "## Something else");
    const { problems } = parseReadme(md, "explore", "az104-06-blob-security");
    assert.ok(problems.some((p) => p.includes(heading)), `${heading}: ${problems}`);
  }
});

test("Things to try needs 3 to 6 bullets, and the standard footer is required", () => {
  const two = readme("az104-06-blob-security").replace("- Three `code`\n", "");
  assert.ok(parseReadme(two, "explore", "az104-06-blob-security").problems.some((p) => /Things to try/.test(p)));
  const noFooter = readme("az104-06-blob-security").replace(readmeFooter("az104-06-blob-security"), "");
  assert.ok(parseReadme(noFooter, "explore", "az104-06-blob-security").problems.some((p) => /footer/.test(p)));
});

test("break-fix readme needs Symptom and a closed details", () => {
  const id = "az104-17-netwatcher-fix";
  assert.deepEqual(parseReadme(readme(id, "break-fix"), "break-fix", id).problems, []);
  assert.ok(parseReadme(readme(id, "explore"), "break-fix", id).problems.some((p) => /Symptom/.test(p)));
  const open = readme(id, "break-fix").replace("<details>", "<details open>");
  assert.ok(parseReadme(open, "break-fix", id).problems.some((p) => /closed|open/.test(p)));
  const noDetails = readme(id, "break-fix").replace(/<details>[\s\S]*<\/details>\n/, "");
  assert.ok(parseReadme(noDetails, "break-fix", id).problems.some((p) => /What was broken/.test(p)));
});

test("markdown outside the subset is refused", () => {
  const id = "az104-06-blob-security";
  for (const bad of ["| a | b |\n|---|---|", "![diagram](https://x.example/a.png)", "1. numbered", "> a quote", "#### deep heading", "Some *italic* text", "Some _italic_ text", "<b>html</b>", "[local](./file.md)", "[js](javascript:alert(1))", "    indented code", "- outer\n  - nested", "---"]) {
    const { problems } = parseReadme(readme(id, "explore", bad + "\n"), "explore", id);
    assert.ok(problems.length > 0, `should refuse: ${bad}`);
  }
});

test("parseReadme gives blocks for each supported element", () => {
  const md = [
    "# Title",
    "",
    "## Section",
    "",
    "### Sub",
    "",
    "A paragraph with **bold**, `code` and a [link](https://learn.microsoft.com/x)",
    "on two lines.",
    "",
    "- item one",
    "- item **two**",
    "",
    "```text",
    "a -> b",
    "  c",
    "```",
    "",
    "<details>",
    "<summary>What was broken</summary>",
    "",
    "Inside.",
    "",
    "</details>",
  ].join("\n");
  const { blocks, problems } = parseReadme(md, "explore", null);
  assert.deepEqual(problems, []);
  assert.deepEqual(blocks, [
    { t: "h", level: 1, text: "Title" },
    { t: "h", level: 2, text: "Section" },
    { t: "h", level: 3, text: "Sub" },
    {
      t: "p",
      inlines: [
        { t: "text", text: "A paragraph with " },
        { t: "b", text: "bold" },
        { t: "text", text: ", " },
        { t: "code", text: "code" },
        { t: "text", text: " and a " },
        { t: "a", text: "link", href: "https://learn.microsoft.com/x" },
        { t: "text", text: " on two lines." },
      ],
    },
    { t: "ul", items: [[{ t: "text", text: "item one" }], [{ t: "text", text: "item " }, { t: "b", text: "two" }]] },
    { t: "code", lang: "text", text: "a -> b\n  c" },
    { t: "details", summary: "What was broken", blocks: [{ t: "p", inlines: [{ t: "text", text: "Inside." }] }] },
  ]);
});

// ── Terraform text and the pool ──────────────────────────────────────────

test("a literal CIDR outside cidrsubnet is refused, 0.0.0.0/0 allowed", () => {
  const ok = { "main.tf": 'resource "azurerm_subnet" "y" {\n  address_prefixes = [cidrsubnet(var.address_space, 2, 0)]\n  source = "0.0.0.0/0"\n}\n' };
  assert.deepEqual(lintTfText(ok), []);
  const bad = { "main.tf": 'resource "azurerm_virtual_network" "y" {\n  address_space = ["10.64.0.0/16"]\n}\n' };
  const p = lintTfText(bad);
  assert.equal(p.length, 1);
  assert.equal(p[0].rule, "literal-cidr");
  assert.equal(p[0].line, 2);
  // A comment is not code.
  assert.deepEqual(lintTfText({ "main.tf": "# was 10.64.0.0/16 before\n// and vnet-wg\n/* rg-wg-ondemand */\n" }), []);
});

test("provisioners, forbidden providers and the gateway's names are refused", () => {
  const cases = [
    ['resource "azurerm_linux_virtual_machine" "vm" {\n  provisioner "remote-exec" {}\n}\n', "provisioner"],
    ['resource "null_resource" "x" {}\n', "provider"],
    ['data "external" "x" {}\n', "provider"],
    ['data "http" "x" {}\n', "provider"],
    ['resource "local_file" "x" {}\n', "provider"],
    ['terraform {\n  required_providers {\n    null = { source = "hashicorp/null" }\n  }\n}\n', "provider"],
    ['locals {\n  rg = "rg-wg-ondemand"\n}\n', "gateway"],
    ['data "azurerm_virtual_network" "wg" {\n  name = "vnet-wg"\n}\n', "gateway"],
    // Adopting an existing object (a real user, renamed lab-<id>-x): tear-down would delete it.
    ['import {\n  to = azuread_user.x\n  id = "/users/5b0c6a1e-2f3d-4c5b-8a9e-1d2c3b4a5f6e"\n}\n', "import"],
    ['  import   {\n  for_each = toset([])\n  to = azuread_user.x[each.key]\n  id = each.key\n}\n', "import"],
  ];
  for (const [text, rule] of cases) {
    const p = lintTfText({ "main.tf": text });
    assert.ok(p.some((x) => x.rule === rule), `${rule}: ${JSON.stringify(p)} for ${text}`);
  }
});

test("a variables.tf declaring a non-contract variable is refused", () => {
  assert.deepEqual(variablesProblems('variable "lab_id" {\n  type = string\n}\nvariable "tags" {\n  type = map(string)\n}\n'), []);
  const p = variablesProblems('variable "lab_id" {}\nvariable "my_secret" {}\n');
  assert.equal(p.length, 1);
  assert.match(p[0], /my_secret/);
});

test("the pool: 32 slots, no overlap with the gateway's ranges, Docker or Azure DNS", () => {
  assert.deepEqual(checkPool(), []);
  assert.ok(checkPool(["10.64.0.0/16"]).length > 0);
});

test("the template passes the Terraform checks", () => {
  const dir = join(repo, "labs", "_template");
  const files = Object.fromEntries(["main.tf", "variables.tf", "outputs.tf", "versions.tf"].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  assert.deepEqual(lintTfText(files), []);
  assert.deepEqual(variablesProblems(files["variables.tf"]), []);
});

// ── Versions against a base ──────────────────────────────────────────────

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("--base flags a changed lab folder whose version did not rise", () => {
  const dir = mkdtempSync(join(tmpdir(), "labs-git-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.net");
    git(dir, "config", "user.name", "t");
    const labs = join(dir, "labs");
    mkdirSync(join(labs, "az104-05-storage"), { recursive: true });
    mkdirSync(join(labs, "az104-06-blob-security"), { recursive: true });
    writeFileSync(join(labs, "az104-05-storage", "lab.yaml"), stringify(lab5()));
    writeFileSync(join(labs, "az104-05-storage", "readme.md"), "a\n");
    writeFileSync(join(labs, "az104-06-blob-security", "lab.yaml"), stringify(good()));
    writeFileSync(join(labs, "az104-06-blob-security", "readme.md"), "a\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    // Lab 5: readme changed, version not bumped. Lab 6: changed and bumped. Lab 7: new.
    writeFileSync(join(labs, "az104-05-storage", "readme.md"), "b\n");
    writeFileSync(join(labs, "az104-06-blob-security", "readme.md"), "b\n");
    writeFileSync(join(labs, "az104-06-blob-security", "lab.yaml"), stringify(good({ version: 2 })));
    mkdirSync(join(labs, "az104-07-files"), { recursive: true });
    writeFileSync(join(labs, "az104-07-files", "lab.yaml"), stringify(good({ id: "az104-07-files" })));
    const p = versionProblems(labs, "base");
    assert.equal(p.length, 1, JSON.stringify(p));
    assert.equal(p[0].lab, "az104-05-storage");
    assert.equal(p[0].field, "version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── The scripts ──────────────────────────────────────────────────────────

test("labs-build writes the catalogue from the repo's labs, and labs-check passes on them", () => {
  const build = spawnSync(process.execPath, [join(repo, "scripts", "labs-build.mjs")], { cwd: repo, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const out = join(repo, "shared", "labs.generated.json");
  assert.ok(existsSync(out));
  const cat = JSON.parse(readFileSync(out, "utf8"));
  // Exactly one catalogue entry per lab folder (a labs/<id>/ with a lab.yaml), so a
  // later batch adds labs without editing this test; batch 1's seven must still be there.
  const ids = cat.labs.map((l) => l.id);
  const folders = readdirSync(join(repo, "labs"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(repo, "labs", d.name, "lab.yaml")))
    .map((d) => d.name);
  assert.equal(new Set(ids).size, ids.length, "no lab id twice");
  assert.deepEqual([...ids].sort(), folders.sort());
  for (const id of ["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az104-04-cost", "az104-05-storage", "az104-06-blob-security", "az104-07-files"]) assert.ok(ids.includes(id), id);
  const check = spawnSync(process.execPath, [join(repo, "scripts", "labs-check.mjs")], { cwd: repo, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
