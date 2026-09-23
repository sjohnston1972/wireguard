// views/layout.ts
//
// Plain English: the page frame every screen sits in: top bar with the link
// light and tabs, the setup and alert notices, the stylesheet and scripts.
// Also the small formatting helpers (times, money, pills) the screens share.

import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Snapshot, State } from "../state";
import { STATE_LABEL } from "../state";
import type { Alert } from "../db";
import { BUILD } from "../build";

export type Tab = "dashboard" | "peers" | "activity" | "cost" | "settings";
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const TABS: { id: Tab; href: string; label: string }[] = [
  { id: "dashboard", href: "/", label: "Overview" },
  { id: "peers", href: "/peers", label: "Clients" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "cost", href: "/cost", label: "Cost" },
  { id: "settings", href: "/settings", label: "Settings" },
];

// Line icons for the phone tab bar, drawn on a 24-unit grid in the text colour.
const ICON: Record<Tab, string> = {
  dashboard: `<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="12" r="2.5"/><path d="M7.5 12h9"/>`,
  peers: `<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>`,
  activity: `<path d="M4 6h16M4 12h16M4 18h10"/>`,
  cost: `<path d="M15 6.5a3.5 3.5 0 0 0-6 2.5v9M7 13h6M7 18h10"/>`,
  settings: `<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`,
};

export function page(o: {
  title: string;
  tab: Tab;
  user: string;
  snapshot: Snapshot;
  body: Html;
  missing?: Record<string, string[]>;
  alerts?: Alert[];
  notice?: { kind: "good" | "warn" | "bad" | "info"; text: string } | null;
}): Html {
  const s = o.snapshot;
  const missingGroups = Object.keys(o.missing ?? {});
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title} · wg-admin</title>
<meta name="theme-color" content="#eef2f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1620" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="wg-admin">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" href="data:image/svg+xml,${raw(encodeURIComponent(favicon(s.state)))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css?v=${BUILD}">
<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js" defer></script>
<script src="/qrcode.js?v=${BUILD}" defer></script>
<script src="/app.js?v=${BUILD}" defer></script>
</head>
<body hx-boost="true">
<header class="topbar">
  <div class="wrap">
    <a class="wordmark" href="/"><span class="light" data-state="${s.state}" title="${STATE_LABEL[s.state]}"></span>wg-admin</a>
    <nav class="tabs" aria-label="Sections">
      ${TABS.map((t) => html`<a href="${t.href}" ${t.id === o.tab ? raw('aria-current="page"') : ""}>${t.label}</a>`)}
    </nav>
    <span class="who">${o.user}</span>
  </div>
</header>
<main class="wrap">
  ${o.notice ? notice(o.notice.kind, o.notice.text) : ""}
  ${missingGroups.length
    ? html`<div class="notice warn"><p><b>Not fully set up.</b> Missing secrets for: ${missingGroups.join(", ")}.</p><span class="spacer"></span><a href="/settings">Finish setup</a></div>`
    : ""}
  ${s.drift ? html`<div class="notice bad"><p><b>Drift.</b> ${s.drift}</p><span class="spacer"></span><form method="post" action="/actions/reconcile" hx-post="/actions/reconcile" hx-target="body"><button type="submit">Reconcile</button></form></div>` : ""}
  ${(o.alerts ?? []).length
    ? html`<div class="notice"><div><b>While you were away</b><ul class="small" style="margin:4px 0 0;padding-left:18px">${o.alerts!.map((a) => html`<li>${fmtTime(a.at)}: ${a.message}</li>`)}</ul></div><span class="spacer"></span><form method="post" action="/alerts/ack" hx-post="/alerts/ack" hx-target="body"><button type="submit">Dismiss</button></form></div>`
    : ""}
  ${o.body}
</main>
<nav class="tabbar" aria-label="Sections">
  ${TABS.map((t) => html`<a href="${t.href}" ${t.id === o.tab ? raw('aria-current="page"') : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${raw(ICON[t.id])}</svg><span>${t.label}</span></a>`)}
</nav>
<footer class="wrap">wg-admin · management plane for the on-demand WireGuard headend · state as of ${fmtTime(s.updated_at)}</footer>
</body>
</html>`;
}

export function notice(kind: "good" | "warn" | "bad" | "info", text: string): Html {
  return html`<div class="notice ${kind === "info" ? "" : kind}"><p>${text}</p></div>`;
}

function favicon(state: State): string {
  const color = state === "running" ? "#12945f" : state === "failed" ? "#d42b2b" : state === "destroyed" || state === "standby" ? "#6b7a8a" : "#d97b06";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "2-digit", month: "short" });
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return "";
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function gbp(n: number): string {
  return `£${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;
}

export { bytesText as bytes } from "../format";

export function pill(kind: "up" | "busy" | "down" | "idle", text: string): Html {
  return html`<span class="pill ${kind}">${text}</span>`;
}

export function statePill(state: State): Html {
  const kind = state === "running" ? "up" : state === "failed" ? "down" : state === "destroyed" || state === "standby" ? "idle" : "busy";
  return pill(kind, STATE_LABEL[state]);
}
