import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, buildPlan, SIZES, ROUTES, SCROLLING_ROUTES, shotName, isOneScreenSize, measureOverflow, OVERFLOW_PROBE, judgeOverflow, loadPrefsFiles, freezeTimeScript, WIDGET_CHROME_OFF_CSS, widgetChromeOffScript, prefsPuts, FROZEN_NOW, frozenClockProblem } from "../lib/shots.mjs";

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

// Labs redesign spec ruling 8: the catalogue page scrolls down, never sideways.
test("/labs and /labs?… are judged for sideways scroll only, at every size including the phone", () => {
  assert.ok(SCROLLING_ROUTES.some((re) => re.test("/labs")));
  const routes = ["/labs", "/labs?lab=az104-02-policy", "/labs?exam=AZ-305&ready=1"];
  const plan = buildPlan(parseArgs(["--routes", routes.join(","), "--sizes", "1600x900,1100x600,1024x768,390x844", "--themes", "dark"]), {});
  assert.equal(plan.length, 12);
  for (const s of plan) assert.equal(s.checkOverflow, "x", `${s.path} at ${s.width}x${s.height}`);
  assert.equal(plan.find((s) => s.width === 390).mobile, true);
  // Tall is fine, sideways is not, inside #main too.
  assert.deepEqual(judgeOverflow({ y: 0, x: 0, mainY: 2400, mainX: 0, innerScroller: null }, { checkOverflow: "x" }), { ok: true, reason: null });
  assert.equal(judgeOverflow({ y: 0, x: 18, mainY: 2400, mainX: 0, innerScroller: null }, { checkOverflow: "x" }).ok, false);
  const side = judgeOverflow({ y: 0, x: 0, mainY: 0, mainX: 6, innerScroller: null }, { checkOverflow: "x" });
  assert.equal(side.ok, false);
  assert.match(side.reason, /sideways 6px/);
  assert.equal(judgeOverflow({ y: 0, x: 0, mainY: 0, mainX: 0, innerScroller: { what: "div.x", by: 9 } }, { checkOverflow: "x" }).ok, true, "a page-wide scroller is allowed on a scrolling page");
  // The full rule ("all", or true from older callers) still fails a tall page.
  assert.equal(judgeOverflow({ y: 0, x: 0, mainY: 10, mainX: 0 }, { checkOverflow: "all" }).ok, false);
  assert.equal(judgeOverflow({ y: 0, x: 0, mainY: 10, mainX: 0 }, { checkOverflow: true }).ok, false);
});

test("/labs/history keeps the one-screen rule", () => {
  assert.ok(!SCROLLING_ROUTES.some((re) => re.test("/labs/history")));
  assert.ok(!SCROLLING_ROUTES.some((re) => re.test("/labs/az104-02-policy")));
  const plan = buildPlan(parseArgs(["--routes", "/labs/history,/cost", "--sizes", "1600x900,390x844", "--themes", "dark"]), {});
  assert.deepEqual(
    plan.map((s) => [s.path, s.width, s.checkOverflow]),
    [
      ["/labs/history", 1600, "all"],
      ["/labs/history", 390, false],
      ["/cost", 1600, "all"],
      ["/cost", 390, false],
    ],
  );
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

test("sideways overflow fails the one-screen rule, in the document or in #main", () => {
  const shot = { checkOverflow: true };
  const x = judgeOverflow({ y: 0, x: 30, mainY: 0, mainX: 0 }, shot);
  assert.equal(x.ok, false);
  assert.match(x.reason, /sideways/);
  const mainX = judgeOverflow({ y: 0, x: 0, mainY: 0, mainX: 28 }, shot);
  assert.equal(mainX.ok, false);
  assert.match(mainX.reason, /#main/);
});

// An element for the inner-scroller probe: its size, its overflow style and how many panels it holds.
function el({ w, h, scrollH = h, overflowY = "visible", panels = 0, cls = "box" }) {
  return { clientWidth: w, clientHeight: h, scrollHeight: scrollH, tagName: "DIV", className: cls, _overflowY: overflowY, querySelectorAll: (sel) => (sel === ".panel" ? Array.from({ length: panels }) : []) };
}
function pageWith(children) {
  const main = { scrollHeight: 852, clientHeight: 852, scrollWidth: 1536, clientWidth: 1536, querySelectorAll: () => children };
  const document = { documentElement: { scrollHeight: 900, scrollWidth: 1600 }, getElementById: (id) => (id === "main" ? main : null) };
  const window = { innerHeight: 900, innerWidth: 1600, getComputedStyle: (e) => ({ overflowY: e._overflowY }) };
  return { document, window };
}

test("a full-width scroller holding several panels is the page scrolling under another name, and fails", () => {
  const { document, window } = pageWith([el({ w: 1536, h: 600, scrollH: 900, overflowY: "auto", panels: 4, cls: "cost-body" })]);
  const m = measureOverflow(document, window);
  assert.equal(m.mainY, 0, "#main itself does not scroll");
  assert.deepEqual(m.innerScroller, { what: "div.cost-body", by: 300 });
  const v = judgeOverflow(m, { checkOverflow: true });
  assert.equal(v.ok, false);
  assert.match(v.reason, /div\.cost-body scrolls 300px/);
});

test("panels and columns that scroll on their own are allowed", () => {
  const { document, window } = pageWith([
    // a list scrolling inside its one panel (full width, but one panel)
    el({ w: 1536, h: 400, scrollH: 1200, overflowY: "auto", panels: 1, cls: "panel__body" }),
    // a column of panels, too tall, scrolling on its own (spec section 7)
    el({ w: 500, h: 700, scrollH: 1000, overflowY: "auto", panels: 3, cls: "col" }),
    // a full-width wrapper of panels that fits
    el({ w: 1536, h: 700, scrollH: 700, overflowY: "auto", panels: 5, cls: "fits" }),
    // clipped, not scrolling
    el({ w: 1536, h: 700, scrollH: 900, overflowY: "hidden", panels: 5, cls: "clip" }),
  ]);
  const m = measureOverflow(document, window);
  assert.equal(m.innerScroller, null);
  assert.equal(judgeOverflow(m, { checkOverflow: true }).ok, true);
});

// ── Options for the widgets work: frozen clock, hidden chrome, saved preferences ──

test("parseArgs: --freeze-time, --widget-chrome off, --prefs a.json,b.json", () => {
  const d = parseArgs([]);
  assert.equal(d.freezeTime, false);
  assert.equal(d.widgetChrome, "on");
  assert.deepEqual(d.prefs, []);
  const o = parseArgs(["--scenario", "running", "--freeze-time", "--widget-chrome", "off", "--prefs", "a.json, b.json"]);
  assert.equal(o.freezeTime, true);
  assert.equal(o.widgetChrome, "off");
  assert.deepEqual(o.prefs, ["a.json", "b.json"]);
  assert.equal(parseArgs(["--widget-chrome", "on"]).widgetChrome, "on");
  assert.throws(() => parseArgs(["--widget-chrome", "hidden"]), /--widget-chrome is on or off/);
  assert.throws(() => parseArgs(["--prefs"]), /needs a value/);
  assert.throws(() => parseArgs(["--freeze-time"]), /--freeze-time needs --scenario/);
  // Frozen runs seed the same story at the same moment every time, so two runs (days apart) compare equal.
  assert.equal(o.now, FROZEN_NOW);
  assert.equal(FROZEN_NOW, "2026-10-02T14:00:00.000Z");
  assert.equal(d.now, null, "an ordinary run seeds at the real time");
  assert.equal(parseArgs(["--scenario", "running", "--freeze-time", "--now", "2026-11-01T09:30:00Z"]).now, "2026-11-01T09:30:00.000Z");
  assert.throws(() => parseArgs(["--now", "soon"]), /--now is an ISO time/);
});

test("a frozen run fails if the dev Worker's clock moved (wrangler reloaded it mid-run)", () => {
  assert.equal(frozenClockProblem("2026-10-02T14:00:00.000Z", "2026-10-02T14:00:00.000Z"), null);
  assert.match(frozenClockProblem("2026-10-03T16:01:02.000Z", "2026-10-02T14:00:00.000Z"), /clock.*2026-10-03T16:01:02.000Z.*restarted/);
  assert.match(frozenClockProblem(undefined, "2026-10-02T14:00:00.000Z"), /clock/);
});

test("a frozen run asks the seeder to stop the dev Worker's clock at the seeded time", async () => {
  const { seed } = await import("../seed-scenarios.mjs");
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ ok: true, now: "2026-10-02T14:00:00.000Z" }), { status: 200 });
  };
  try {
    await seed("http://localhost:8787", "running", "2026-10-02T14:00:00.000Z", true);
    await seed("http://localhost:8787", "running");
  } finally {
    globalThis.fetch = real;
  }
  const q = (u) => Object.fromEntries(new URL(u).searchParams);
  assert.deepEqual(q(seen[0].url), { scenario: "running", now: "2026-10-02T14:00:00.000Z", freeze: "1" });
  assert.deepEqual(q(seen[1].url), { scenario: "running" });
  assert.ok(seen.every((s) => s.method === "POST"));
});

test("buildPlan: --prefs is read and validated before the browser starts", () => {
  const files = {
    "ov.json": JSON.stringify({ overview: { layout: { hidden: ["overview.topology"] } } }),
    "cost.json": JSON.stringify({ cost: { widgets: { "cost.perSession": { v: 1, s: { shown: "10" } } } } }),
    "again.json": JSON.stringify({ overview: {} }),
    "bad.json": "{ not json",
    "list.json": "[]",
    "page.json": JSON.stringify({ settings: {} }),
    "value.json": JSON.stringify({ clients: [] }),
  };
  const read = (p) => {
    if (!(p in files)) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" });
    return files[p];
  };
  assert.deepEqual(loadPrefsFiles(["ov.json", "cost.json"], read), {
    overview: { layout: { hidden: ["overview.topology"] } },
    cost: { widgets: { "cost.perSession": { v: 1, s: { shown: "10" } } } },
  });
  assert.throws(() => loadPrefsFiles(["nope.json"], read), /nope\.json.*cannot be read/);
  assert.throws(() => loadPrefsFiles(["bad.json"], read), /bad\.json is not valid JSON/);
  assert.throws(() => loadPrefsFiles(["list.json"], read), /list\.json.*object of pages/);
  assert.throws(() => loadPrefsFiles(["page.json"], read), /page\.json.*"settings" is not a widget page/);
  assert.throws(() => loadPrefsFiles(["value.json"], read), /value\.json.*"clients" must be an object/);
  assert.throws(() => loadPrefsFiles(["ov.json", "again.json"], read), /overview.*both ov\.json and again\.json/);
  // The whole command refuses a bad file before seeding or starting a browser.
  const r = spawnSync(process.execPath, [script, "--dry-run", "--prefs", "no-such-prefs-file.json"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no-such-prefs-file\.json/);
});

test("the frozen clock reads the seeded time everywhere a page asks, and dates still work", async () => {
  const { runInNewContext } = await import("node:vm");
  const at = "2026-10-02T14:00:00.000Z";
  const out = runInNewContext(
    `${freezeTimeScript(at)};
     const d = new Date();
     JSON.stringify({ now: Date.now(), iso: d.toISOString(), isDate: d instanceof Date, epoch: new Date(0).toISOString(), parts: new Date(2020, 0, 2).getFullYear(), utc: Date.UTC(2020, 0, 1), parse: Date.parse("2020-01-01T00:00:00Z"), str: typeof Date() })`,
    {},
  );
  const v = JSON.parse(out);
  assert.equal(v.now, Date.parse(at));
  assert.equal(v.iso, at);
  assert.equal(v.isDate, true);
  assert.equal(v.epoch, "1970-01-01T00:00:00.000Z");
  assert.equal(v.parts, 2020);
  assert.equal(v.utc, Date.UTC(2020, 0, 1));
  assert.equal(v.parse, Date.parse("2020-01-01T00:00:00Z"));
  assert.equal(v.str, "string");
  assert.throws(() => freezeTimeScript("yesterday"), /not a time/);
});

test("--widget-chrome off hides every [data-widget-chrome] element", () => {
  assert.match(WIDGET_CHROME_OFF_CSS, /\[data-widget-chrome\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(widgetChromeOffScript(), /data-widget-chrome/);
});

test("prefsPuts sends each page with the version the server holds now, as a schema 2 dashboard", () => {
  const current = { pages: { overview: { version: 3, updatedAt: "x", prefs: {} }, cost: { version: 0, updatedAt: null, prefs: {} } } };
  assert.deepEqual(prefsPuts(current, { overview: { layout: { hidden: ["overview.notes"] } }, cost: {} }), [
    { page: "overview", body: { schema: 2, baseVersion: 3, prefs: { layout: { hidden: ["overview.notes"] } } } },
    { page: "cost", body: { schema: 2, baseVersion: 0, prefs: {} } },
  ]);
});

test("the seed script offers the Worker's scenarios, insights and labs included", async () => {
  const { SCENARIOS } = await import("../seed-scenarios.mjs");
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../../worker/src/devseed.ts", import.meta.url), "utf8");
  const listed = JSON.parse(worker.match(/export const SCENARIOS = (\[[^\]]*\])/)[1]);
  assert.deepEqual([...SCENARIOS].sort(), [...listed].sort());
  assert.ok(SCENARIOS.includes("insights"));
  assert.ok(SCENARIOS.includes("labs"));
});

test("--scroll-to: the selector is kept, and the script scrolls to it and waits for its pictures", async () => {
  const { scrollToScript } = await import("../lib/shots.mjs");
  assert.equal(parseArgs([]).scrollTo, null);
  assert.equal(parseArgs(["--scroll-to", ".labs-diagram"]).scrollTo, ".labs-diagram");
  assert.throws(() => parseArgs(["--scroll-to"]), /--scroll-to needs a value/);
  const js = scrollToScript('a[title="x"]');
  assert.match(js, /document\.querySelector\("a\[title=\\"x\\"\]"\)/);
  assert.match(js, /scrollIntoView/);
  assert.match(js, /document\.images/);
});
