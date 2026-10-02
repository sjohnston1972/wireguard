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

/** The one-screen rule: desktop windows of 1100 x 600 and larger must not scroll the page. */
export function isOneScreenSize(s) {
  return !s.mobile && s.width >= 1100 && s.height >= 600;
}

/**
 * How far the page scrolls. The shell is the window's height and its page
 * area (#main) scrolls inside itself, so the document alone never scrolls:
 * the page area is measured too. Runs inside the browser (see OVERFLOW_PROBE),
 * so it uses nothing but its two arguments.
 */
export function measureOverflow(document, window) {
  const d = document.documentElement;
  const main = document.getElementById("main");
  return {
    y: d.scrollHeight - window.innerHeight,
    x: d.scrollWidth - window.innerWidth,
    mainY: main ? main.scrollHeight - main.clientHeight : null,
    mainX: main ? main.scrollWidth - main.clientWidth : null,
  };
}

/** The expression the browser evaluates: a JSON string of measureOverflow's answer. */
export const OVERFLOW_PROBE = `JSON.stringify((${measureOverflow.toString()})(document, window))`;

/** Whether a shot passes the one-screen rule, and why not. */
export function judgeOverflow(m, shot) {
  if (!shot.checkOverflow) return { ok: true, reason: null };
  const problems = [];
  if (m.y > 0) problems.push(`the page scrolls ${m.y}px`);
  if (m.mainY !== null && m.mainY > 0) problems.push(`#main scrolls ${m.mainY}px`);
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
      default:
        throw new Error(`Unknown option ${a}`);
    }
  }
  if (!Number.isFinite(o.settle) || o.settle < 0) throw new Error("--settle is a number of milliseconds");
  return o;
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
          checkOverflow: isOneScreenSize(size) && !r.exemptFromOneScreen,
        });
      }
    }
  }
  return out;
}
