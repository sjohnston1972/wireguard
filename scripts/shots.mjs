// scripts/shots.mjs   (npm run shots -- --scenario running)
//
// Plain English: takes pictures of the new dashboard so they can be compared
// with the mockups. It starts a hidden Edge (or Chrome) of its own, steers it
// through the Chrome DevTools Protocol (the same remote control Chrome's
// developer tools use), visits every page at three window sizes in the dark and
// light themes, saves a PNG of each, and measures whether the page needs
// scrolling: the document and the shell's page area (#main), which scrolls
// inside the window-high shell. The one-screen rule says a desktop window of
// 1100 x 600 or larger must not: any page that does makes this script exit
// with an error.
//
// Needs the app running: npm run dev:web (port 5173) and npm run dev:api
// (port 8787). With --scenario NAME it first loads that canned story into the
// dev server (see seed-scenarios.mjs). It uses Node's built-in WebSocket, so
// there is nothing extra to install.
//
//   node scripts/shots.mjs --scenario running
//   node scripts/shots.mjs --scenario labs --routes /labs,/labs/az104-06-blob-security,/labs/history
//   node scripts/shots.mjs --dry-run                 (list the shots, take none)
//   options: --base URL --api URL --out DIR --routes /,/cost --sizes 1100x700 --themes dark
//            --browser PATH --settle MS --json (with --dry-run)
//   widgets: --freeze-time          seed at a fixed moment (2026-10-02T14:00Z, or --now ISO) and stop
//                                   both the dev Worker's clock and the browser's there (needs --scenario)
//            --widget-chrome off    hide every cog, move handle and widget menu ([data-widget-chrome])
//            --prefs a.json,b.json  save these widget preferences for dev@localhost before shooting
//                                   (each file: {"<page>": <PagePrefs>}; see scripts/shots-prefs/)
//   Compare two runs pixel by pixel: npm run shots:diff -- <dir A> <dir B>
//
// The browser is stopped by its own process id when the run ends; no other
// program is touched.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, buildPlan, OVERFLOW_PROBE, judgeOverflow, loadPrefsFiles, prefsPuts, freezeTimeScript, widgetChromeOffScript, frozenClockProblem } from "./lib/shots.mjs";
import { seed } from "./seed-scenarios.mjs";

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findBrowser(explicit) {
  for (const p of [explicit, process.env.SHOTS_BROWSER, ...BROWSERS]) if (p && existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** A minimal DevTools Protocol client over one WebSocket. */
class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("DevTools connection failed")));
    });
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
        else p.res(m.result);
      } else {
        for (const w of [...this.waiters]) {
          if (w.method === m.method) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.res(m.params);
          }
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Resolves on the next event of this name. Register before the action that causes it. */
  once(method, timeoutMs = 30_000) {
    return new Promise((res, rej) => {
      const w = { method, res: (p) => { clearTimeout(t); res(p); } };
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        rej(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return await r.json();
}

/** The first client, firewall rule and run the app can show, for the detail pages. */
async function findIds(base) {
  const ids = {};
  const tryGet = async (path, pick, key) => {
    try {
      const v = pick(await getJson(`${base}/api/v1${path}`));
      if (v !== undefined && v !== null) ids[key] = v;
    } catch {
      /* no data for this one: its detail shots are skipped */
    }
  };
  await tryGet("/clients", (j) => (j.clients.find((c) => !c.isSite) ?? j.clients[0])?.id, "client");
  await tryGet("/firewall", (j) => j.rules[0]?.id, "rule");
  await tryGet("/activity?range=30d", (j) => j.runs[0]?.id, "run");
  return ids;
}

/**
 * Save widget preferences for the signed-in dev user (dev@localhost): read
 * each page's current version, then PUT the page with it. The Worker checks
 * every value; a refusal stops the run with the Worker's own message.
 */
async function savePrefs(api, pages) {
  const current = await getJson(`${api}/api/v1/prefs`);
  for (const { page, body } of prefsPuts(current, pages)) {
    const r = await fetch(`${api}/api/v1/prefs/${page}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let why = `answered ${r.status}`;
      try {
        const e = (await r.json()).error;
        why = `${e.message}${e.field ? ` (field ${e.field})` : ""}`;
      } catch {
        /* not the API's error shape */
      }
      throw new Error(`--prefs: the dashboard refused the ${page} preferences: ${why}`);
    }
  }
  console.log(`Saved widget preferences for ${Object.keys(pages).join(", ")}`);
}

/** Stop the browser we started, by its own process id (and its helper processes). */
function stopBrowser(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function printPlan(plan, opts) {
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(`Dry run: ${plan.length} shots into ${opts.out}`);
  for (const s of plan) {
    const where = s.path ?? `${s.route} (needs data: id found from the API)`;
    console.log(`  ${s.file.padEnd(40)} ${where}  ${s.width}x${s.height}${s.mobile ? " phone" : ""} ${s.theme}${s.checkOverflow ? "  [one-screen check]" : ""}`);
  }
}

async function main() {
  let opts;
  let prefs;
  try {
    opts = parseArgs(process.argv.slice(2));
    // Read and checked before anything is seeded or started.
    prefs = loadPrefsFiles(opts.prefs, (p) => readFileSync(p, "utf8"));
  } catch (e) {
    console.error(e.message);
    return 2;
  }

  if (opts.dryRun) {
    printPlan(buildPlan(opts, {}), opts);
    return 0;
  }

  let seededNow = null;
  if (opts.scenario) {
    try {
      const r = await seed(opts.api, opts.scenario, opts.now ?? undefined, opts.freezeTime);
      seededNow = r.now;
      console.log(`Seeded "${opts.scenario}" at ${r.now}${opts.freezeTime ? " (the dev Worker's clock now stands still there until the next seed)" : ""}`);
    } catch (e) {
      console.error(e.message);
      return 3;
    }
    if (opts.scenario === "deploying") console.error("Note: with real GitHub credentials in .dev.vars the Worker gives up on a seeded deploy after about 3 minutes; shoot soon after seeding.");
  }

  // Saved widget preferences for dev@localhost, after seeding (the seeder wipes them).
  if (Object.keys(prefs).length) {
    try {
      await savePrefs(opts.api, prefs);
    } catch (e) {
      console.error(e.message);
      return 3;
    }
  }

  try {
    const r = await fetch(opts.base);
    if (!r.ok) throw new Error(`answered ${r.status}`);
  } catch (e) {
    console.error(`The app is not reachable at ${opts.base} (${e.cause?.code ?? e.message}). Start it: npm run dev:web (and npm run dev:api for data).`);
    return 3;
  }

  const ids = await findIds(opts.base);
  const all = buildPlan(opts, ids);
  const plan = all.filter((s) => s.path !== null);
  const skipped = all.filter((s) => s.path === null);
  if (skipped.length) console.log(`Skipping ${skipped.length} detail shots with no data (${[...new Set(skipped.map((s) => s.route))].join(", ")}).`);

  const exe = findBrowser(opts.browser);
  if (!exe) {
    console.error("No Edge or Chrome found. Pass --browser PATH or set SHOTS_BROWSER.");
    return 2;
  }

  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "wg-shots-"));
  const port = opts.port || (await freePort());
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--force-color-profile=srgb", "--window-size=1600,1000", "about:blank"], { stdio: "ignore" });
  let cdp = null;
  const results = [];
  let failed = false;
  try {
    let version = null;
    for (let i = 0; i < 100 && !version; i++) {
      try {
        version = await getJson(`http://127.0.0.1:${port}/json/version`);
      } catch {
        await sleep(150);
      }
    }
    if (!version) throw new Error("The browser did not start listening for DevTools.");
    const target = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    if (opts.freezeTime) {
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: freezeTimeScript(seededNow) });
      console.log(`Browser clock frozen at ${seededNow}`);
    }
    if (opts.widgetChrome === "off") await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: widgetChromeOffScript() });

    for (const s of plan) {
      const rec = { file: s.file, path: s.path, theme: s.theme, width: s.width, height: s.height, overflowY: null, overflowX: null, mainOverflowY: null, mainOverflowX: null, ok: true };
      try {
        // Phone width comes from device emulation: a headless window will not go below about 500 px.
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: s.mobile });
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: s.theme }] });
        const loaded = cdp.once("Page.loadEventFired");
        await cdp.send("Page.navigate", { url: `${opts.base}${s.path}` });
        await loaded;
        await cdp.send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => true) : true", awaitPromise: true });
        await sleep(opts.settle);
        const m = await cdp.send("Runtime.evaluate", { expression: OVERFLOW_PROBE, returnByValue: true });
        const measured = JSON.parse(m.result.value);
        rec.overflowY = measured.y;
        rec.overflowX = measured.x;
        rec.mainOverflowY = measured.mainY;
        rec.mainOverflowX = measured.mainX;
        rec.innerScroller = measured.innerScroller;
        const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(out, s.file), Buffer.from(shot.data, "base64"));
        const verdict = judgeOverflow(measured, s);
        if (!verdict.ok) {
          rec.ok = false;
          rec.reason = verdict.reason;
          failed = true;
        }
      } catch (e) {
        rec.ok = false;
        rec.error = e.message;
        failed = true;
      }
      results.push(rec);
      const scroll = `scroll ${rec.overflowY}px, #main ${rec.mainOverflowY ?? "-"}px`;
      const flag = rec.error ? `ERROR ${rec.error}` : s.checkOverflow ? `${scroll}${rec.ok ? "" : `  <-- FAILS the one-screen rule (${rec.reason})`}` : `${scroll} (not checked)`;
      console.log(`${rec.ok ? "ok  " : "FAIL"} ${s.file.padEnd(40)} ${flag}${rec.overflowX > 0 ? `  (sideways overflow ${rec.overflowX}px)` : ""}`);
    }
    // A frozen run is only good if the dev Worker's clock stood still throughout.
    if (opts.freezeTime) {
      let serverNow;
      try {
        serverNow = (await getJson(`${opts.api}/api/v1/session`)).now;
      } catch {
        /* reported below as "nothing" */
      }
      const problem = frozenClockProblem(serverNow, seededNow);
      if (problem) {
        console.error(problem);
        failed = true;
      }
    }
  } catch (e) {
    console.error(e.message);
    failed = true;
  } finally {
    cdp?.close();
    stopBrowser(child);
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the temp profile is left for the OS to clear */
    }
  }

  writeFileSync(join(out, "report.json"), JSON.stringify({ scenario: opts.scenario, base: opts.base, results }, null, 2));
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} shots ok, saved in ${out}`);
  if (bad.length) console.log(`${bad.length} problem(s): ${bad.map((r) => r.file).join(", ")}`);
  return failed ? 1 : 0;
}

process.exit(await main());
