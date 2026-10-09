// scripts/lib/shots.mjs
//
// Plain English: the planning half of the screenshot tool, with no browser in
// it: which pages, at which sizes, in which theme, what each file is called,
// and which shots must fit on one screen. Kept apart so it can be tested
// without starting Edge.

export const ROUTES = [
  { route: "/", name: "overview" },
  { route: "/clients", name: "clients" },
  { route: "/clients/:id", name: "client", needs: "client" },
  { route: "/firewall", name: "firewall" },
  { route: "/firewall/rules/:id", name: "rule", needs: "rule" },
  { route: "/activity", name: "activity" },
  { route: "/activity/runs/:id", name: "run", needs: "run" },
  { route: "/cost", name: "cost" },
  { route: "/settings", name: "settings" },
  // The dev-only component gallery: it shows every component, so it scrolls by design.
  { route: "/__gallery", name: "gallery", exemptFromOneScreen: true },
];

export const SIZES = [
  { width: 1600, height: 900, mobile: false },
  { width: 1100, height: 700, mobile: false },
  // The boundary of the one-screen rule.
  { width: 1100, height: 600, mobile: false },
  { width: 390, height: 844, mobile: true },
];

export const THEMES = ["dark", "light"];

/**
 * Pages that may scroll down (labs redesign spec ruling 8: the Labs catalogue, with any query) but
 * never sideways, at any size including the phone. Matched against the shot's path.
 */
export const SCROLLING_ROUTES = [/^\/labs(?:\?.*)?$/];

/** The one-screen rule: desktop windows of 1100 x 600 and larger must not scroll the page. */
export function isOneScreenSize(s) {
  return !s.mobile && s.width >= 1100 && s.height >= 600;
}

/**
 * How far the page scrolls. The shell is the window's height and its page
 * area (#main) scrolls inside itself, so the document alone never scrolls:
 * the page area is measured too. Runs inside the browser (see OVERFLOW_PROBE),
 * so it uses nothing but its two arguments.
 *
 * `innerScroller` catches a view that keeps #main still but wraps the page in
 * one scrolling box of its own: an element that scrolls (overflow-y auto or
 * scroll, and more content than room), spans the page area's width (90 % or
 * more) and holds two or more panels. A list scrolling inside its one panel
 * holds one panel; a column of panels too tall for the window (allowed by the
 * spec, section 7) is narrower than the page. Neither is reported.
 */
export function measureOverflow(document, window) {
  const d = document.documentElement;
  const main = document.getElementById("main");
  let innerScroller = null;
  if (main && typeof main.querySelectorAll === "function" && typeof window.getComputedStyle === "function") {
    for (const e of main.querySelectorAll("*")) {
      const by = e.scrollHeight - e.clientHeight;
      if (by <= 1 || e.clientWidth < main.clientWidth * 0.9) continue;
      const oy = window.getComputedStyle(e).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      if (e.querySelectorAll(".panel").length < 2) continue;
      const cls = typeof e.className === "string" ? e.className.trim().split(/\s+/).filter(Boolean)[0] : "";
      innerScroller = { what: `${String(e.tagName).toLowerCase()}${cls ? `.${cls}` : ""}`, by };
      break;
    }
  }
  return {
    y: d.scrollHeight - window.innerHeight,
    x: d.scrollWidth - window.innerWidth,
    mainY: main ? main.scrollHeight - main.clientHeight : null,
    mainX: main ? main.scrollWidth - main.clientWidth : null,
    innerScroller,
  };
}

/** The expression the browser evaluates: a JSON string of measureOverflow's answer. */
export const OVERFLOW_PROBE = `JSON.stringify((${measureOverflow.toString()})(document, window))`;

/**
 * Whether a shot passes its overflow check, and why not. `shot.checkOverflow`: "all" (the
 * one-screen rule; true from older callers means the same), "x" (a scrolling page: sideways only)
 * or false (not checked).
 */
export function judgeOverflow(m, shot) {
  if (!shot.checkOverflow) return { ok: true, reason: null };
  const sidewaysOnly = shot.checkOverflow === "x";
  const problems = [];
  if (!sidewaysOnly && m.y > 0) problems.push(`the page scrolls ${m.y}px`);
  if (!sidewaysOnly && m.mainY !== null && m.mainY > 0) problems.push(`#main scrolls ${m.mainY}px`);
  if (m.x > 0) problems.push(`the page scrolls sideways ${m.x}px`);
  if (m.mainX !== null && m.mainX > 0) problems.push(`#main scrolls sideways ${m.mainX}px`);
  if (!sidewaysOnly && m.innerScroller) problems.push(`${m.innerScroller.what} scrolls ${m.innerScroller.by}px (a page-wide scroller holding several panels)`);
  return problems.length ? { ok: false, reason: problems.join(", ") } : { ok: true, reason: null };
}

/** "/firewall/rules/3" -> "firewall-rules-3"; "/" -> "overview". */
function slug(path) {
  if (path === "/") return "overview";
  return path.replace(/^\/+/, "").replace(/^__/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "");
}

export function shotName(path, size, theme) {
  return `${slug(path)}__${size.width}x${size.height}__${theme}.png`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const split = (v) =>
  String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function parseArgs(argv) {
  const o = {
    dryRun: false,
    json: false,
    scenario: null,
    base: "http://localhost:5173",
    api: "http://localhost:8787",
    out: `.superpowers/shots/${today()}`,
    routes: null,
    sizes: null,
    themes: null,
    browser: null,
    settle: 1500,
    port: 0,
    freezeTime: false,
    now: null,
    widgetChrome: "on",
    prefs: [],
    scrollTo: null,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--scenario":
        o.scenario = need(i++, a);
        break;
      case "--base":
        o.base = need(i++, a).replace(/\/+$/, "");
        break;
      case "--api":
        o.api = need(i++, a).replace(/\/+$/, "");
        break;
      case "--out":
        o.out = need(i++, a);
        break;
      case "--browser":
        o.browser = need(i++, a);
        break;
      case "--settle":
        o.settle = Number(need(i++, a));
        break;
      case "--port":
        o.port = Number(need(i++, a));
        break;
      case "--routes":
        o.routes = split(need(i++, a));
        break;
      case "--themes":
        o.themes = split(need(i++, a));
        for (const t of o.themes) if (!THEMES.includes(t)) throw new Error(`Unknown theme "${t}" (dark or light)`);
        break;
      case "--sizes":
        o.sizes = split(need(i++, a)).map((s) => {
          const m = s.match(/^(\d+)x(\d+)$/);
          if (!m) throw new Error(`Bad size "${s}": use WIDTHxHEIGHT, for example 1100x700`);
          const width = Number(m[1]);
          return { width, height: Number(m[2]), mobile: width < 640 };
        });
        break;
      case "--freeze-time":
        o.freezeTime = true;
        break;
      case "--now": {
        const ms = Date.parse(need(i++, a));
        if (!Number.isFinite(ms)) throw new Error("--now is an ISO time, for example 2026-10-02T14:00:00Z");
        o.now = new Date(ms).toISOString();
        break;
      }
      case "--widget-chrome":
        o.widgetChrome = need(i++, a);
        if (o.widgetChrome !== "on" && o.widgetChrome !== "off") throw new Error("--widget-chrome is on or off");
        break;
      case "--prefs":
        o.prefs = split(need(i++, a));
        break;
      case "--scroll-to":
        o.scrollTo = need(i++, a);
        break;
      default:
        throw new Error(`Unknown option ${a}`);
    }
  }
  if (!Number.isFinite(o.settle) || o.settle < 0) throw new Error("--settle is a number of milliseconds");
  // The frozen time is the seeded story's "now", so there has to be a story.
  if (o.freezeTime && !o.scenario) throw new Error("--freeze-time needs --scenario (the browser's clock is pinned to the seeded time)");
  // A frozen run seeds the same moment every time, so runs taken days apart still compare pixel for pixel.
  if (o.freezeTime && !o.now) o.now = FROZEN_NOW;
  return o;
}

/**
 * The moment a --freeze-time run seeds its story at (unless --now says
 * otherwise). The seeder also stops the dev Worker's clock there, and the
 * browser's clock is pinned to it, so every age and clock on screen is the
 * same on every run.
 */
export const FROZEN_NOW = "2026-10-02T14:00:00.000Z";

/**
 * Why a frozen run's pictures cannot be trusted, or null: the dev Worker's
 * clock (GET /api/v1/session's `now`) must still read the seeded moment at
 * the end of the run. wrangler reloads the Worker when its code changes,
 * which starts the clock again.
 */
export function frozenClockProblem(serverNow, expected) {
  if (serverNow === expected) return null;
  return `The dev Worker's clock reads ${serverNow ?? "nothing"}, not the frozen ${expected}: it restarted during the run (wrangler reloads it when worker/ or shared/ files change). Shoot again without editing those files.`;
}

// ── Widgets: a frozen clock, hidden widget chrome, saved preferences ──────

/**
 * A script for every new page (before the app's own) that pins the clock:
 * `Date.now()` and `new Date()` both answer `iso`, so "3 min ago", today's
 * date and every clock on screen come out the same on every run. Dates made
 * from a value (new Date(0), Date.UTC, Date.parse) work as normal.
 */
export function freezeTimeScript(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`--freeze-time: "${iso}" is not a time`);
  return `(() => {
  const Real = Date;
  const FIXED = ${ms};
  function Frozen(...args) {
    if (!new.target) return new Real(FIXED).toString();
    return args.length ? new Real(...args) : new Real(FIXED);
  }
  Frozen.prototype = Real.prototype;
  Frozen.now = () => FIXED;
  Frozen.parse = Real.parse;
  Frozen.UTC = Real.UTC;
  Object.defineProperty(Real.prototype, "constructor", { value: Frozen, configurable: true, writable: true });
  globalThis.Date = Frozen;
})()`;
}

/** The style --widget-chrome off adds: every cog, move handle and widget menu is gone, as if never built. */
export const WIDGET_CHROME_OFF_CSS = "[data-widget-chrome] { display: none !important; }";

/**
 * An expression (for Runtime.evaluate, awaited) that scrolls the first element matching `selector` to the top of
 * its scrolling box and waits for the pictures on the page to load (lazy ones load once scrolled to). True when
 * the element was found.
 */
export function scrollToScript(selector) {
  return `(async () => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  await new Promise((r) => setTimeout(r, 300));
  await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); setTimeout(r, 3000); })));
  return true;
})()`;
}

/** A script for every new page that adds WIDGET_CHROME_OFF_CSS as early as the page allows. */
export function widgetChromeOffScript() {
  return `(() => {
  const add = () => {
    if (document.getElementById("wg-shots-chrome-off")) return true;
    const root = document.head || document.documentElement;
    if (!root) return false;
    const s = document.createElement("style");
    s.id = "wg-shots-chrome-off";
    s.textContent = ${JSON.stringify(WIDGET_CHROME_OFF_CSS)};
    root.appendChild(s);
    return true;
  };
  if (!add()) document.addEventListener("DOMContentLoaded", add, { once: true });
})()`;
}

/** The widget pages, as shared/widgets.ts names them. */
export const PREFS_PAGES = ["overview", "clients", "firewall", "activity", "cost"];

/**
 * The --prefs files read and checked before anything starts: each is a JSON
 * object of page -> that page's preferences (the body the dashboard saves).
 * A page may come from one file only. The Worker checks the preferences
 * themselves when they are saved, and a refusal stops the run.
 */
export function loadPrefsFiles(paths, read) {
  const out = {};
  const from = {};
  for (const p of paths) {
    let text;
    try {
      text = read(p);
    } catch (e) {
      throw new Error(`--prefs: ${p} cannot be read (${e.code ?? e.message})`);
    }
    let v;
    try {
      v = JSON.parse(String(text));
    } catch {
      throw new Error(`--prefs: ${p} is not valid JSON`);
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`--prefs: ${p} must be an object of pages, for example {"overview": {...}}`);
    for (const [page, prefs] of Object.entries(v)) {
      if (!PREFS_PAGES.includes(page)) throw new Error(`--prefs: in ${p}, "${page}" is not a widget page (${PREFS_PAGES.join(", ")})`);
      if (prefs === null || typeof prefs !== "object" || Array.isArray(prefs)) throw new Error(`--prefs: in ${p}, "${page}" must be an object`);
      if (page in out) throw new Error(`--prefs: ${page} is in both ${from[page]} and ${p}; give each page once`);
      out[page] = prefs;
      from[page] = p;
    }
  }
  return out;
}

/** The saves to make: each page's preferences with the version the server holds now (GET /api/v1/prefs), as a schema 2 dashboard (PrefsPutBody). */
export function prefsPuts(current, pages) {
  return Object.entries(pages).map(([page, prefs]) => ({ page, body: { schema: 2, baseVersion: current.pages[page]?.version ?? 0, prefs } }));
}

/** A shot's overflow check: "x" on a scrolling page at every size, "all" for the one-screen rule, else false. */
function overflowCheck(path, size, r) {
  if (SCROLLING_ROUTES.some((re) => re.test(path))) return "x";
  return isOneScreenSize(size) && !r.exemptFromOneScreen ? "all" : false;
}

/**
 * Every shot to take. `ids` are the client, rule and run found from the API
 * (any may be missing); a detail page with no id yet has `path: null`.
 */
export function buildPlan(opts, ids) {
  const sizes = opts.sizes ?? SIZES;
  const themes = opts.themes ?? THEMES;
  // A route given that is not in the list (a Settings section, a given client) is shot as written.
  const routes = opts.routes ? opts.routes.map((r) => ROUTES.find((x) => x.route === r) ?? { route: r, name: r }) : ROUTES;
  const out = [];
  for (const r of routes) {
    const id = r.needs ? ids[r.needs] : undefined;
    const path = r.needs ? (id === undefined || id === null ? null : r.route.replace(":id", encodeURIComponent(String(id)))) : r.route;
    for (const size of sizes) {
      for (const theme of themes) {
        out.push({
          route: r.route,
          path,
          theme,
          width: size.width,
          height: size.height,
          mobile: !!size.mobile,
          file: shotName(path ?? r.route.replace(":id", "x"), size, theme),
          checkOverflow: overflowCheck(path ?? r.route, size, r),
        });
      }
    }
  }
  return out;
}
