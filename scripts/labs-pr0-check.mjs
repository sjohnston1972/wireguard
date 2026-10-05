// scripts/labs-pr0-check.mjs   (npm run labs-pr0-check [-- --ref origin/feat/labs-pr0] [--base HEAD])
//
// Plain English: PR 0 (plan ruling 8) puts lab.yml and its infra/ci steps on
// main ahead of the rest of Labs, because GitHub only dispatches workflows
// that exist on the default branch. Its copies must be exactly the ones the
// Labs branch tests, or main would run older steps than the ones reviewed.
// This compares the committed files (git blobs, so line endings never
// matter) of .github/workflows/lab.yml and everything under infra/ci/ at two
// refs, and lists every path that differs or exists on one side only.
//
// Exit 0: identical. Exit 1: the differences, one per line. Exit 2: a ref git
// cannot read (fetch it first: git fetch origin feat/labs-pr0).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The paths PR 0 carries. */
export const PR0_PATHS = [".github/workflows/lab.yml", "infra/ci"];

/** Map(path -> blob id) of PR0_PATHS at `ref`. Throws when git cannot read the ref. */
export function pr0Files(ref, cwd = process.cwd()) {
  const r = spawnSync("git", ["ls-tree", "-r", ref, "--", ...PR0_PATHS], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-tree ${ref}: ${(r.stderr || "").trim()}`);
  const out = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

/** Paths that differ between two refs: [{ path, why }]. */
export function pr0Differences(ref, base = "HEAD", cwd = process.cwd()) {
  const a = pr0Files(ref, cwd);
  const b = pr0Files(base, cwd);
  const out = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(path)) out.push({ path, why: `missing from ${ref}` });
    else if (!b.has(path)) out.push({ path, why: `only in ${ref}` });
    else if (a.get(path) !== b.get(path)) out.push({ path, why: "differs" });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const ref = arg("--ref", "origin/feat/labs-pr0");
  const base = arg("--base", "HEAD");
  let diffs;
  try {
    diffs = pr0Differences(ref, base);
  } catch (e) {
    console.error(`labs-pr0-check: ${e.message}`);
    process.exit(2);
  }
  for (const d of diffs) console.log(`${d.path}: ${d.why}`);
  if (diffs.length) {
    console.error(`labs-pr0-check: ${ref} differs from ${base} in ${diffs.length} file(s); refresh PR 0 from this branch`);
    process.exit(1);
  }
  console.log(`labs-pr0-check: ${ref} carries exactly ${base}'s lab.yml and infra/ci/ (${pr0Files(base).size} files)`);
}
