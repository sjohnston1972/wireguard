import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, buildPlan, SIZES, ROUTES, shotName, isOneScreenSize } from "../lib/shots.mjs";

const script = fileURLToPath(new URL("../shots.mjs", import.meta.url));

test("the plan covers every route at three sizes in two themes", () => {
  const plan = buildPlan(parseArgs([]), {});
  assert.equal(SIZES.length, 3);
  assert.deepEqual(
    SIZES.map((s) => `${s.width}x${s.height}`),
    ["1600x900", "1100x700", "390x844"],
  );
  assert.equal(plan.length, ROUTES.length * 3 * 2);
  assert.ok(plan.some((s) => s.path === "/__gallery"));
  assert.ok(plan.every((s) => s.file.endsWith(".png")));
  assert.equal(new Set(plan.map((s) => s.file)).size, plan.length, "file names are unique");
});

test("the phone size is emulated as mobile; desktop sizes are not", () => {
  const plan = buildPlan(parseArgs([]), {});
  assert.ok(plan.filter((s) => s.width === 390).every((s) => s.mobile === true));
  assert.ok(plan.filter((s) => s.width >= 1100).every((s) => s.mobile === false));
});

test("the one-screen rule applies to desktop sizes of 1100x600 and up, not the phone or the gallery", () => {
  assert.equal(isOneScreenSize({ width: 1100, height: 700, mobile: false }), true);
  assert.equal(isOneScreenSize({ width: 1600, height: 900, mobile: false }), true);
  assert.equal(isOneScreenSize({ width: 1100, height: 599, mobile: false }), false);
  assert.equal(isOneScreenSize({ width: 390, height: 844, mobile: true }), false);
  const plan = buildPlan(parseArgs([]), {});
  assert.ok(plan.filter((s) => s.path === "/__gallery").every((s) => !s.checkOverflow));
  assert.ok(plan.filter((s) => s.path === "/" && s.width === 1100).every((s) => s.checkOverflow));
});

test("detail routes use ids found from the API; without them they are listed as pending", () => {
  const pending = buildPlan(parseArgs([]), {});
  assert.ok(pending.some((s) => s.route === "/clients/:id" && s.path === null));
  const ids = buildPlan(parseArgs([]), { client: 7, rule: 3, run: "apply-20261002-abc" });
  assert.ok(ids.some((s) => s.path === "/clients/7"));
  assert.ok(ids.some((s) => s.path === "/firewall/rules/3"));
  assert.ok(ids.some((s) => s.path === "/activity/runs/apply-20261002-abc"));
  assert.ok(ids.every((s) => s.path !== null));
});

test("flags narrow the plan", () => {
  const opts = parseArgs(["--routes", "/,/cost", "--sizes", "1100x700", "--themes", "dark"]);
  const plan = buildPlan(opts, {});
  assert.deepEqual(
    plan.map((s) => s.route),
    ["/", "/cost"],
  );
});

test("parseArgs knows its flags and refuses the rest", () => {
  const o = parseArgs(["--dry-run", "--scenario", "running", "--base", "http://localhost:5199", "--out", "x"]);
  assert.equal(o.dryRun, true);
  assert.equal(o.scenario, "running");
  assert.equal(o.base, "http://localhost:5199");
  assert.equal(o.out, "x");
  assert.throws(() => parseArgs(["--nope"]), /Unknown option/);
  assert.throws(() => parseArgs(["--sizes", "big"]), /size/);
});

test("shotName is stable and file-safe", () => {
  assert.equal(shotName("/", { width: 1600, height: 900 }, "dark"), "overview__1600x900__dark.png");
  assert.equal(shotName("/__gallery", { width: 390, height: 844 }, "light"), "gallery__390x844__light.png");
  assert.equal(shotName("/firewall/rules/3", { width: 1100, height: 700 }, "dark"), "firewall-rules-3__1100x700__dark.png");
});

test("--dry-run lists the shots and exits 0 without starting a browser or touching the network", () => {
  const r = spawnSync(process.execPath, [script, "--dry-run", "--base", "http://127.0.0.1:9"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/i);
  assert.match(r.stdout, /overview__1600x900__dark\.png/);
  assert.match(r.stdout, /gallery__390x844__light\.png/);
  assert.match(r.stdout, /60 shots/);
});

test("--dry-run --json prints the plan as JSON", () => {
  const r = spawnSync(process.execPath, [script, "--dry-run", "--json", "--routes", "/cost"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.length, 6);
  assert.ok(plan.every((s) => s.route === "/cost"));
});

test("a bad flag exits non-zero", () => {
  const r = spawnSync(process.execPath, [script, "--dry-run", "--bogus"], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown option/);
});
