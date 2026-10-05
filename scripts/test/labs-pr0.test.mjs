// labs-pr0.test.mjs
//
// Plain English: PR 0's lab.yml and infra/ci/ must be exactly this branch's
// (scripts/labs-pr0-check.mjs). The comparison itself is tested on a small
// throw-away git repository; the real check against origin/feat/labs-pr0 runs
// when that ref has been fetched (CI's shallow checkout skips it, with a note).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pr0Differences } from "../labs-pr0-check.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("labs-pr0-check finds a changed, a missing and an extra file, and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr0-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "core.autocrlf", "false");
  const put = (p, s) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  put(".github/workflows/lab.yml", "name: lab\n");
  put("infra/ci/lab-peer.sh", "echo peer\n");
  put("infra/ci/live-log.mjs", "// log\n");
  put("other/file.txt", "not PR 0's\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "pr0");
  git(dir, "branch", "pr0");
  assert.deepEqual(pr0Differences("pr0", "HEAD", dir), []);
  put("infra/ci/lab-peer.sh", "echo peer --resolution-policy\n");
  put("infra/ci/lab-lint.mjs", "// new\n");
  put("other/file.txt", "changed, but not PR 0's\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "labs");
  assert.deepEqual(pr0Differences("pr0", "HEAD", dir), [
    { path: "infra/ci/lab-lint.mjs", why: "missing from pr0" },
    { path: "infra/ci/lab-peer.sh", why: "differs" },
  ]);
  assert.throws(() => pr0Differences("no-such-ref", "HEAD", dir), /git ls-tree no-such-ref/);
});

// Batch 1 only. PR 0 put lab.yml on main; from batch 2 on, a branch's own
// lab.yml and infra/ci/ run with `--ref <branch>` and reach main in the batch
// PR itself (labs batch 2 plan, ruling 11), so they are meant to differ from
// PR 0's. `npm run labs-pr0-check` stays for a future PR 0 of its own.
const fetched = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/feat/labs-pr0"], { cwd: REPO, encoding: "utf8" }).status === 0;
test("PR 0 (origin/feat/labs-pr0) carries exactly this branch's lab.yml and infra/ci/", { skip: "batch 1 only: from batch 2, lab.yml and infra/ci/ change in the batch PR (batch 2 ruling 11)" }, () => {
  assert.ok(fetched, "origin/feat/labs-pr0 is fetched");
  assert.deepEqual(pr0Differences("origin/feat/labs-pr0", "HEAD", REPO), []);
});
