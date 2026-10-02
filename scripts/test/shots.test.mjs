import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, buildPlan, SIZES, ROUTES, shotName, isOneScreenSize, measureOverflow, OVERFLOW_PROBE, judgeOverflow } from "../lib/shots.mjs";

const script = fileURLToPath(new URL("../shots.mjs", import.meta.url));

test("the plan covers every route at four sizes (including the 1100x600 boundary) in two themes", () => {
  const plan = buildPlan(parseArgs([]), {});
  assert.equal(SIZES.length, 4);
  assert.deepEqual(
    SIZES.map((s) => `${s.width}x${s.height}`),
    ["1600x900", "1100x700", "1100x600", "390x844"],
  );
  assert.equal(plan.length, ROUTES.length * 4 * 2);
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

test("a route given that is not in the list (a Settings section, a client) is shot as written, one-screen checked", () => {
  const plan = buildPlan(parseArgs(["--routes", "/settings/automation,/clients/3,/cost", "--sizes", "1100x600", "--themes", "dark"]), {});
  assert.deepEqual(
    plan.map((s) => s.path),
    ["/settings/automation", "/clients/3", "/cost"],
  );
  assert.ok(plan.every((s) => s.checkOverflow));
  assert.equal(plan[0].file, "settings-automation__1100x600__dark.png");
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
  assert.match(r.stdout, /80 shots/);
});

test("--dry-run --json prints the plan as JSON", () => {
  const r = spawnSync(process.execPath, [script, "--dry-run", "--json", "--routes", "/cost"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.length, 8);
  assert.ok(plan.every((s) => s.route === "/cost"));
});

test("a bad flag exits non-zero", () => {
  const r = spawnSync(process.execPath, [script, "--dry-run", "--bogus"], { encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown option/);
});

// The shell is 100dvh and its page area (#main) scrolls inside itself, so the
// document never scrolls: the one-screen check has to look inside #main too.
function fakePage({ docScroll = 900, innerHeight = 900, docWidth = 1600, innerWidth = 1600, main }) {
  const document = {
    documentElement: { scrollHeight: docScroll, scrollWidth: docWidth },
    getElementById: (id) => (id === "main" && main ? main : null),
  };
  return { document, window: { innerHeight, innerWidth } };
}

test("measureOverflow reports the page area's own scroll as well as the document's", () => {
  const { document, window } = fakePage({ main: { scrollHeight: 1140, clientHeight: 900, scrollWidth: 1600, clientWidth: 1600 } });
  const m = measureOverflow(document, window);
  assert.equal(m.y, 0, "the document itself does not scroll");
  assert.equal(m.mainY, 240, "but #main does");
  assert.equal(m.mainX, 0);
});

test("measureOverflow copes with a page that has no #main", () => {
  const { document, window } = fakePage({ docScroll: 950 });
  const m = measureOverflow(document, window);
  assert.equal(m.y, 50);
  assert.equal(m.mainY, null);
});

test("the probe sent to the browser runs measureOverflow on the live document", () => {
  const { document, window } = fakePage({ main: { scrollHeight: 700, clientHeight: 600, scrollWidth: 10, clientWidth: 10 } });
  const run = new Function("document", "window", `return ${OVERFLOW_PROBE};`);
  const m = JSON.parse(run(document, window));
  assert.equal(m.mainY, 100);
});

test("a desktop shot fails the one-screen rule when #main scrolls, even though the document does not", () => {
  const shot = { checkOverflow: true };
  assert.equal(judgeOverflow({ y: 0, x: 0, mainY: 0, mainX: 0 }, shot).ok, true);
  const bad = judgeOverflow({ y: 0, x: 0, mainY: 240, mainX: 0 }, shot);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /#main/);
  assert.equal(judgeOverflow({ y: 12, x: 0, mainY: 0, mainX: 0 }, shot).ok, false, "document scroll still fails");
  assert.equal(judgeOverflow({ y: 0, x: 0, mainY: null, mainX: null }, shot).ok, true);
  assert.equal(judgeOverflow({ y: 300, x: 0, mainY: 300, mainX: 0 }, { checkOverflow: false }).ok, true, "phone and gallery are not checked");
});
