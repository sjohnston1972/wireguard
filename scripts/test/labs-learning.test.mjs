// labs-learning.test.mjs
//
// Plain English: the catalogue's learning content and resource counts (labs
// redesign spec §5, §6.2). Each §5.2 rule is tried by breaking one field of a
// good labs/_learning/<id>.yaml and checking the refusal names that field; a
// good file is merged into the catalogue; a missing file is tolerated by the
// build and refused by labs-check (requireLearning); planned diagrams are
// counted by kind; and the _learning folder is invisible to the version check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yaml12 } from "yaml";
import { buildCatalogue, countPlanned, labFolders, LEARNING_DIR, readLearning, validateLearning, versionProblems } from "../lib/labs.mjs";

const stringify = (v) => yaml12(v, { version: "1.1" });

const SKILLS = [{ key: "az104.storage", exam: "AZ-104", name: "Implement and manage storage" }];

const lab = (id, over = {}) => ({
  id,
  version: 1,
  title: `Lab ${id}`,
  summary: "A storage account.",
  exam: "AZ-104",
  skill_areas: ["az104.storage"],
  level: "foundation",
  type: "explore",
  prerequisites: [],
  cost: { items: [{ name: "Storage account", gbp_h: 0.0001 }], pricey: null },
  timing: { deploy_min: 4, destroy_min: 3, session_h: 1, max_h: 2 },
  capacity: { vm_sizes: [] },
  regions: { secondary: null },
  connectivity: { peering: "off", dns_link: false, subnets_used: 0 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});

const readme = (id) =>
  [
    "## What it deploys",
    "",
    "- A storage account",
    "",
    "## Things to try",
    "",
    "- One",
    "- Two",
    "- Three",
    "",
    "## Learn more",
    "",
    "- [Storage](https://learn.microsoft.com/azure/storage/)",
    "",
    `Anything you build by hand inside \`rg-lab-${id}\` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts \`lab-${id}-\`.`,
    "",
  ].join("\n");

/** A learning file that passes every rule. */
const good = (over = {}) => ({
  objective: "Compare redundancy options and move blobs between tiers with a lifecycle rule.",
  learn: ["Choose between LRS and GRS for a storage account", "Move blobs to the cool tier with a lifecycle rule", "Read the replication status of a secondary region"],
  learning_min: 45,
  ...over,
});

const HEADER = "# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.\n";

/** A temporary labs/ root with these labs and learning files (lab id -> object, or raw text). */
function makeRoot(labs, learning = {}) {
  const root = mkdtempSync(join(tmpdir(), "labs-learning-"));
  writeFileSync(join(root, "skill-areas.yaml"), stringify(SKILLS));
  for (const l of labs) {
    mkdirSync(join(root, l.id), { recursive: true });
    writeFileSync(join(root, l.id, "lab.yaml"), stringify(l));
    writeFileSync(join(root, l.id, "readme.md"), readme(l.id));
  }
  if (Object.keys(learning).length) mkdirSync(join(root, LEARNING_DIR), { recursive: true });
  for (const [id, v] of Object.entries(learning)) writeFileSync(join(root, LEARNING_DIR, `${id}.yaml`), typeof v === "string" ? v : HEADER + stringify(v));
  return root;
}

const DEF = { id: "az104-05-storage", timing: { deploy_min: 4, destroy_min: 3, session_h: 1, max_h: 2 } };

/** The fields validateLearning refuses for `raw` (as a sorted list), against lab 5 (max_h 2). */
const refused = (raw, def = DEF) => validateLearning(raw, def).map((p) => p.field);

test("LEARNING_DIR is _learning, and labFolders never lists it", () => {
  assert.equal(LEARNING_DIR, "_learning");
  const root = makeRoot([lab("az104-05-storage")], { "az104-05-storage": good() });
  try {
    assert.deepEqual(labFolders(root), ["az104-05-storage"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a good file has no problems", () => {
  assert.deepEqual(validateLearning(good(), DEF), []);
});

test("an unknown key names itself, and a missing one is refused", () => {
  const p = validateLearning(good({ notes: "x" }), DEF);
  assert.deepEqual(p.map((x) => x.field), ["notes"]);
  assert.match(p[0].message, /notes/);
  const { learn, ...rest } = good();
  assert.deepEqual(refused(rest), ["learn"]);
  assert.deepEqual(refused(["a"]), [null]);
});

test("objective: one sentence of 30 to 140 characters, no markdown", () => {
  assert.deepEqual(refused(good({ objective: "Deploy a vault. Then read its secrets back." })), ["objective"], "two sentences");
  assert.deepEqual(refused(good({ objective: "Deploy a vault and read its secrets back!" })), ["objective"], "an exclamation");
  assert.deepEqual(refused(good({ objective: "Is a vault worth deploying for this lab?" })), ["objective"], "a question");
  assert.deepEqual(refused(good({ objective: `${"A".repeat(140)}.` })), ["objective"], "141 characters");
  assert.deepEqual(refused(good({ objective: `${"A".repeat(139)}.` })), [], "140 characters");
  assert.deepEqual(refused(good({ objective: "Too short a line." })), ["objective"], "under 30");
  assert.deepEqual(refused(good({ objective: "Deploy a **vault** and read its secrets back." })), ["objective"], "markdown *");
  assert.deepEqual(refused(good({ objective: "Deploy a `vault` and read its secrets back now." })), ["objective"], "markdown `");
  assert.deepEqual(refused(good({ objective: "Deploy a [vault] and read its secrets back now." })), ["objective"], "markdown [");
  assert.deepEqual(refused(good({ objective: "Deploy a vault #1 and read its secrets back now." })), ["objective"], "markdown #");
  assert.deepEqual(refused(good({ objective: "deploy a vault and read its secrets back now." })), ["objective"], "a small first letter");
  assert.deepEqual(refused(good({ objective: "Deploy a vault and read its secrets back now" })), ["objective"], "no full stop");
  assert.deepEqual(refused(good({ objective: "Deploy a vault and read\nits secrets back now." })), ["objective"], "two lines");
  assert.deepEqual(refused(good({ objective: 42 })), ["objective"], "not text");
});

test("learn: exactly three distinct lines of 15 to 90 characters, capitalised, no full stop, no markdown", () => {
  const [a, b, c] = good().learn;
  assert.deepEqual(refused(good({ learn: [a, b] })), ["learn"], "2 bullets");
  assert.deepEqual(refused(good({ learn: [a, b, c, "Read the activity log for each change"] })), ["learn"], "4 bullets");
  assert.deepEqual(refused(good({ learn: [a, b, `R${"e".repeat(90)}`] })), ["learn"], "a 91-character bullet");
  assert.deepEqual(refused(good({ learn: [a, b, `R${"e".repeat(89)}`] })), [], "a 90-character bullet");
  assert.deepEqual(refused(good({ learn: [a, b, "Too short"] })), ["learn"], "under 15");
  assert.deepEqual(refused(good({ learn: [a, b, `${c}.`] })), ["learn"], "a trailing full stop");
  assert.deepEqual(refused(good({ learn: [a, b, a.toUpperCase()] })), ["learn"], "duplicate bullets (any case)");
  assert.deepEqual(refused(good({ learn: [a, b, "read the replication status of a region"] })), ["learn"], "a small first letter");
  assert.deepEqual(refused(good({ learn: [a, b, "Read the `replication` status of a region"] })), ["learn"], "markdown");
  assert.deepEqual(refused(good({ learn: [a, b, "Read the replication\nstatus of a region"] })), ["learn"], "two lines");
  assert.deepEqual(refused(good({ learn: [a, b, 7] })), ["learn"], "not text");
  assert.deepEqual(refused(good({ learn: "Choose a redundancy option for storage" })), ["learn"], "not a list");
});

test("learning_min: a whole multiple of 5 from 15 to min(240, max_h × 60)", () => {
  assert.deepEqual(refused(good({ learning_min: 12 })), ["learning_min"], "12");
  assert.deepEqual(refused(good({ learning_min: 17 })), ["learning_min"], "17");
  assert.deepEqual(refused(good({ learning_min: 10 })), ["learning_min"], "10");
  assert.deepEqual(refused(good({ learning_min: 15 })), [], "15");
  assert.deepEqual(refused(good({ learning_min: 120 })), [], "120 = max_h 2 × 60");
  assert.deepEqual(refused(good({ learning_min: 125 })), ["learning_min"], "over max_h × 60");
  assert.deepEqual(refused(good({ learning_min: 245 }), { ...DEF, timing: { ...DEF.timing, max_h: 6 } }), ["learning_min"], "over 240");
  assert.deepEqual(refused(good({ learning_min: 240 }), { ...DEF, timing: { ...DEF.timing, max_h: 6 } }), [], "240");
  assert.deepEqual(refused(good({ learning_min: "45" })), ["learning_min"], "text");
  assert.deepEqual(refused(good({ learning_min: 45.5 })), ["learning_min"], "a fraction");
});

test("a good file is merged as learning[id]; the header comment is fine", () => {
  const root = makeRoot([lab("az104-05-storage"), lab("az104-06-blobs")], { "az104-05-storage": good() });
  try {
    const { catalogue, problems } = buildCatalogue(root);
    assert.deepEqual(problems, []);
    assert.equal(catalogue.schema, 2);
    assert.deepEqual(catalogue.learning, { "az104-05-storage": good() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing file is tolerated by buildCatalogue and refused with requireLearning", () => {
  const root = makeRoot([lab("az104-05-storage"), lab("az104-06-blobs")], { "az104-05-storage": good() });
  try {
    const built = buildCatalogue(root);
    assert.deepEqual(built.problems, []);
    assert.equal(built.catalogue.learning["az104-06-blobs"], undefined);
    assert.equal(built.catalogue.labs.length, 2);
    const checked = buildCatalogue(root, { requireLearning: true });
    assert.equal(checked.problems.length, 1, JSON.stringify(checked.problems));
    assert.deepEqual({ ...checked.problems[0], message: undefined }, { lab: "az104-06-blobs", file: "_learning/az104-06-blobs.yaml", field: null, message: undefined });
    assert.match(checked.problems[0].message, /labs\/_learning\/az104-06-blobs\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed file is refused by both, in the existing problem shape", () => {
  const root = makeRoot([lab("az104-05-storage")], { "az104-05-storage": good({ learning_min: 17 }) });
  try {
    for (const opts of [undefined, { requireLearning: true }]) {
      const { problems } = buildCatalogue(root, opts);
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.deepEqual({ ...problems[0], message: undefined }, { lab: "az104-05-storage", file: "_learning/az104-05-storage.yaml", field: "learning_min", message: undefined });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const bad = makeRoot([lab("az104-05-storage")], { "az104-05-storage": "objective: [unclosed\n" });
  try {
    const { problems } = buildCatalogue(bad);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].field, null);
    assert.match(problems[0].message, /not valid YAML/);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("a file for an unknown id is a problem", () => {
  const root = makeRoot([lab("az104-05-storage")], { "az104-05-storage": good(), "az104-99-nothing": good() });
  try {
    const { problems } = buildCatalogue(root);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.deepEqual(problems[0], { lab: "az104-99-nothing", file: "_learning/az104-99-nothing.yaml", field: null, message: "no lab az104-99-nothing" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readLearning returns learning and problems for the ids it is given", () => {
  const root = makeRoot([lab("az104-05-storage")], { "az104-05-storage": good() });
  try {
    const defs = [{ ...lab("az104-05-storage"), number: 5 }];
    assert.deepEqual(readLearning(root, ["az104-05-storage"], defs, { requireLearning: true }), { learning: { "az104-05-storage": good() }, problems: [] });
    const none = readLearning(root, ["az104-05-storage", "az104-06-blobs"], defs, { requireLearning: false });
    assert.deepEqual(none.problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Resources from the planned diagram (spec §6.2) ───────────────────────

const node = (id, kind, extra = {}) => ({ id, key: id, kind, label: id, props: {}, ...extra });

test("countPlanned skips lanes, the gateway and folded entries and counts outside nodes", () => {
  const graph = {
    schema: 1,
    labId: "az700-44-flow-logs-bastion",
    version: 1,
    source: "planned",
    at: null,
    nodes: [
      node("lane/tenant", "lane"),
      node("gw", "gateway"),
      node("rg", "resourceGroup"),
      node("vnet", "vnet", { parent: "rg" }),
      node("vm1", "vm", { folded: [{ id: "nic1", label: "nic", armType: "Microsoft.Network/networkInterfaces" }, { id: "disk1", label: "disk", armType: "Microsoft.Compute/disks" }] }),
      node("vm2", "vm"),
      node("fl", "flowLog", { scope: "outside" }),
    ],
    edges: [],
  };
  const counts = countPlanned(graph);
  assert.deepEqual(counts, { flowLog: 1, resourceGroup: 1, vm: 2, vnet: 1 });
  assert.deepEqual(Object.keys(counts), ["flowLog", "resourceGroup", "vm", "vnet"], "keys sorted");
});

test("resources come from the planned folder; a lab with no planned file has no resources entry", () => {
  const root = makeRoot([lab("az104-05-storage"), lab("az104-06-blobs")]);
  const planned = mkdtempSync(join(tmpdir(), "labs-planned-"));
  try {
    writeFileSync(join(planned, "az104-05-storage.json"), JSON.stringify({ schema: 1, labId: "az104-05-storage", version: 1, source: "planned", at: null, nodes: [node("rg", "resourceGroup"), node("s1", "storage"), node("s2", "storage")], edges: [] }));
    const { catalogue, problems } = buildCatalogue(root, { plannedDir: planned });
    assert.deepEqual(problems, []);
    assert.deepEqual(catalogue.resources, { "az104-05-storage": { resourceGroup: 1, storage: 2 } });
    // The default folder is <root>/../shared/topology/planned: absent beside a temp root.
    assert.deepEqual(buildCatalogue(root).catalogue.resources, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(planned, { recursive: true, force: true });
  }
});

// ── Versions (spec §5.3) ─────────────────────────────────────────────────

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("editing labs/_learning/<id>.yaml makes versionProblems return []", () => {
  const dir = mkdtempSync(join(tmpdir(), "labs-learning-git-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.net");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "core.autocrlf", "false");
    const labs = join(dir, "labs");
    mkdirSync(join(labs, "az104-05-storage"), { recursive: true });
    mkdirSync(join(labs, LEARNING_DIR), { recursive: true });
    writeFileSync(join(labs, "az104-05-storage", "lab.yaml"), stringify(lab("az104-05-storage")));
    writeFileSync(join(labs, "az104-05-storage", "readme.md"), readme("az104-05-storage"));
    writeFileSync(join(labs, LEARNING_DIR, "az104-05-storage.yaml"), HEADER + stringify(good()));
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    // Edited, and a new file for another lab: neither is a lab folder's change.
    writeFileSync(join(labs, LEARNING_DIR, "az104-05-storage.yaml"), HEADER + stringify(good({ learning_min: 60 })));
    writeFileSync(join(labs, LEARNING_DIR, "az104-06-blobs.yaml"), HEADER + stringify(good()));
    assert.deepEqual(versionProblems(labs, "base"), []);
    assert.deepEqual(labFolders(labs), ["az104-05-storage"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
