// scripts/lib/headless.mjs
//
// Plain English: a hidden Edge (or Chrome) of our own, steered through the
// Chrome DevTools Protocol with Node's built-in WebSocket, for the two jobs
// that need a real browser: drawing the lab readmes' Mermaid diagrams
// (labs-diagrams.mjs --render) and taking a picture of a page. The browser
// has a throw-away profile and is stopped by its own process id (and its
// helpers) when the job ends; no other program is touched.
//
//   const b = await openBrowser();          // null: no Edge or Chrome found
//   try { await b.evaluate("1 + 1") } finally { await b.close() }

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** The browser to use: `explicit`, $SHOTS_BROWSER, or the first installed one; null when there is none. */
export function findBrowser(explicit) {
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

async function getJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return await r.json();
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("DevTools connection failed")));
    });
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      this.ws.send(JSON.stringify({ id, method, params }));
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

/** Stop the browser we started, by its own process id (and its helper processes). */
function stopBrowser(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

/**
 * A hidden browser on about:blank. Returns null when no Edge or Chrome is installed.
 * `evaluate(expr)` runs an expression (promises awaited) and returns its value; `screenshot(html, w)` draws a page
 * of HTML `w` px wide and returns a PNG buffer of the whole page; `close()` stops the browser.
 */
export async function openBrowser({ browser } = {}) {
  const exe = findBrowser(browser);
  if (!exe) return null;
  const profile = mkdtempSync(join(tmpdir(), "wg-headless-"));
  const port = await freePort();
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--force-color-profile=srgb", "--window-size=1400,1000", "about:blank"];
  if (process.platform === "linux") args.unshift("--no-sandbox");
  const child = spawn(exe, args, { stdio: "ignore" });
  let cdp = null;
  const close = async () => {
    cdp?.close();
    stopBrowser(child);
    await sleep(200);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* the browser may still hold a file for a moment; it is a temp folder */
    }
  };
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
  } catch (e) {
    await close();
    throw e;
  }
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return r.result.value;
  };
  const screenshot = async (html, width = 1200) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const { frameTree } = await cdp.send("Page.getFrameTree");
    await cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    await evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
    await sleep(150);
    const h = await evaluate("Math.ceil(document.documentElement.scrollHeight)");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: Math.max(100, h), deviceScaleFactor: 1, mobile: false });
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    return Buffer.from(shot.data, "base64");
  };
  return { evaluate, screenshot, close, exe, pid: child.pid };
}
