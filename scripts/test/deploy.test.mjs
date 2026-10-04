// Deploy and rollback tools. Nothing here talks to Cloudflare: the step lists
// are pure, the runner is a recording fake, and the scripts are only started
// with --dry-run, from an empty folder (no .env) with the token blanked, so a
// broken dry run would fail at loading .env rather than reach wrangler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploySteps, rollbackArgs, rollbackSteps, runSteps, toSpawn, devBuildSteps, REPLACED_NOTE, cronTriggers, cronRollbackWarning } from "../lib/deploy.mjs";
import { readFileSync } from "node:fs";

const scripts = fileURLToPath(new URL("../", import.meta.url));
const ID = "0b9ee8a5-3c3b-4c1f-9a43-1f2e3d4c5b6a";

test("deploy builds and checks the bundle before migrations and deploy", () => {
  assert.deepEqual(deploySteps(), [
    ["npm", "run", "build:web"],
    ["npm", "run", "bundle-size"],
    ["wrangler", "deployments", "status"],
    ["wrangler", "d1", "migrations", "apply", "wg-admin", "--remote"],
    ["wrangler", "deploy"],
  ]);
});

test("the steps run in order, with the replaced version's note after the status step", () => {
  const seen = [];
  const status = runSteps(deploySteps(), (step) => (seen.push(step.join(" ")), 0), (line) => seen.push("log: " + line));
  assert.equal(status, 0);
  assert.deepEqual(seen.filter((s) => !s.startsWith("log: $")), [
    "npm run build:web",
    "npm run bundle-size",
    "wrangler deployments status",
    "log: " + REPLACED_NOTE,
    "wrangler d1 migrations apply wg-admin --remote",
    "wrangler deploy",
  ]);
  assert.equal(REPLACED_NOTE, "The version above is the one this deploy replaces: keep its id for a rollback.");
});

test("a failing step stops the deploy before anything after it", () => {
  const seen = [];
  const status = runSteps(deploySteps(), (step) => (seen.push(step.join(" ")), step[2] === "bundle-size" ? 1 : 0), () => {});
  assert.equal(status, 1);
  assert.deepEqual(seen, ["npm run build:web", "npm run bundle-size"]);
});

test("rollback args carry the id, a message and --yes", () => {
  // As `npx wrangler rollback --help` prints: rollback [version-id] -m/--message -y/--yes.
  assert.deepEqual(rollbackArgs(ID, "switch-over rollback"), ["wrangler", "rollback", ID, "--message", "switch-over rollback", "--yes"]);
  assert.deepEqual(rollbackSteps(ID), [["wrangler", "rollback", ID, "--message", "switch-over rollback", "--yes"]]);
});

test("a rollback id must be a version id, never a flag or junk", () => {
  for (const bad of ["--yes", "-m", "latest", "1234", `${ID} --force`, ""]) {
    assert.throws(() => rollbackArgs(bad, "m"), /version id/, bad);
  }
  assert.doesNotThrow(() => rollbackArgs(ID.toUpperCase(), "m"));
});

test("no id lists deployments and changes nothing", () => {
  assert.deepEqual(rollbackSteps(undefined), [["wrangler", "deployments", "list"]]);
  assert.deepEqual(rollbackSteps(""), [["wrangler", "deployments", "list"]]);
});

test("wrangler steps run through npx with the token; npm steps never see it", () => {
  const env = { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" };
  const w = toSpawn(["wrangler", "deploy"], env, { PATH: "p" });
  assert.equal(w.cmd, "npx");
  assert.deepEqual(w.args, ["wrangler", "deploy"]);
  assert.equal(w.env.CLOUDFLARE_API_TOKEN, "t");
  assert.equal(w.env.CLOUDFLARE_ACCOUNT_ID, "a");
  assert.equal(w.env.PATH, "p");
  const n = toSpawn(["npm", "run", "build:web"], env, { PATH: "p", CLOUDFLARE_API_TOKEN: "leak" });
  assert.equal(n.cmd, "npm");
  assert.deepEqual(n.args, ["run", "build:web"]);
  assert.equal(n.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("on Windows (cmd.exe) an argument with a space is quoted, so the rollback message stays one argument", () => {
  assert.deepEqual(toSpawn(rollbackArgs(ID, "switch-over rollback"), {}, {}, true).args, ["wrangler", "rollback", ID, "--message", '"switch-over rollback"', "--yes"]);
  assert.deepEqual(toSpawn(rollbackArgs(ID, "switch-over rollback"), {}, {}, false).args, ["wrangler", "rollback", ID, "--message", "switch-over rollback", "--yes"]);
  assert.deepEqual(toSpawn(["wrangler", "deploy"], {}, {}, true).args, ["wrangler", "deploy"]);
});

test("npm run dev builds the app first only when web/dist has no index.html", () => {
  const asked = [];
  assert.deepEqual(devBuildSteps((p) => (asked.push(p), false)), [["npm", "run", "build:web"]]);
  assert.deepEqual(asked, ["web/dist/index.html"]);
  assert.deepEqual(devBuildSteps(() => true), []);
});

function dryRun(script, args) {
  const cwd = mkdtempSync(join(tmpdir(), "deploy-dry-"));
  try {
    const r = spawnSync(process.execPath, [join(scripts, script), "--dry-run", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    });
    return { ...r, wroteBuild: existsSync(join(cwd, "worker")) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("rollback-worker --dry-run with no id would only list deployments", () => {
  const r = dryRun("rollback-worker.mjs", []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\$ wrangler deployments list$/m);
  assert.doesNotMatch(r.stdout, /wrangler rollback/);
});

test("rollback-worker --dry-run with an id would roll back to it", () => {
  const r = dryRun("rollback-worker.mjs", [ID]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^\\$ wrangler rollback ${ID} --message switch-over rollback --yes$`, "m"));
});

test("the cron triggers are read from wrangler.toml", () => {
  assert.deepEqual(cronTriggers('[triggers]\ncrons = ["*/5 * * * *", "2-59/5 * * * *"]\n'), ["*/5 * * * *", "2-59/5 * * * *"]);
  assert.deepEqual(cronTriggers('[triggers]\ncrons = [\n  "*/5 * * * *",\n]\n'), ["*/5 * * * *"]);
  assert.deepEqual(cronTriggers("name = 'x'\n"), []);
  // The real file: the watchman and the Azure insights collector.
  const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
  assert.deepEqual(cronTriggers(toml), ["*/5 * * * *", "2-59/5 * * * *"]);
});

test("the rollback warning says a rollback keeps today's cron triggers and how to go back properly", () => {
  const w = cronRollbackWarning(["*/5 * * * *", "2-59/5 * * * *"]);
  assert.match(w, /^WARNING: /);
  assert.match(w, /cron triggers/i);
  assert.match(w, /"\*\/5 \* \* \* \*", "2-59\/5 \* \* \* \*"/);
  // What goes wrong: the old code gets the new cron too, and runs the watchman on every cron event.
  assert.match(w, /watchman/);
  assert.match(w, /twice every 5 minutes/);
  // The right way back.
  assert.match(w, /revert the merge on main, then npm run deploy-worker/);
  assert.match(w, /deploy the previous commit/);
});

test("rollback-worker prints the cron warning when it lists and when it rolls back", () => {
  for (const args of [[], [ID]]) {
    const r = dryRun("rollback-worker.mjs", args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /WARNING: .*cron triggers/i, args.join(" ") || "(list)");
    assert.match(r.stdout + r.stderr, /revert the merge on main, then npm run deploy-worker/);
  }
});

test("rollback-worker refuses an id that is not a version id", () => {
  const r = dryRun("rollback-worker.mjs", ["--yes"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version id/);
});

test("deploy-worker --dry-run prints the five steps and writes nothing", () => {
  const r = dryRun("deploy-worker.mjs", []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const steps = r.stdout.split(/\r?\n/).filter((l) => l.startsWith("$ "));
  assert.deepEqual(steps, deploySteps().map((s) => "$ " + s.join(" ")));
  assert.equal(r.wroteBuild, false, "no build stamp in a dry run");
});
