/* sw.js: the dashboard's service worker.
 *
 * Plain English: what lets a phone install wg-admin as an app. It caches
 * nothing and changes nothing while the network works: every page still
 * comes live from the Worker, behind the login. Its one job is a clear
 * offline page instead of the browser's own error when the phone has no
 * signal, and being there is what Chrome looks for before offering Install.
 */
"use strict";

var OFFLINE = [
  "<!doctype html><html lang=en><head><meta charset=utf-8>",
  "<meta name=viewport content='width=device-width, initial-scale=1'>",
  "<title>wg-admin: offline</title>",
  "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1620;color:#e6edf5;",
  "font:16px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box}",
  "div{max-width:30ch}b{display:block;font-size:1.6rem;margin-bottom:6px}button{font:inherit;font-weight:600;",
  "margin-top:14px;padding:12px 18px;border:0;border-radius:8px;background:#6b8cff;color:#0b1220}</style></head>",
  "<body><div><b>No connection</b>The dashboard needs the internet to reach Cloudflare. ",
  "The VPN itself is unaffected.<br><button onclick='location.reload()'>Try again</button></div></body></html>",
].join("");

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (e) {
  // Only whole-page loads get the offline fallback; everything else goes
  // straight to the network untouched.
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request).catch(function () {
      return new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    })
  );
});
