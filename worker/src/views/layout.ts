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

export type Tab = "dashboard" | "peers" | "activity" | "cost" | "settings";
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const TABS: { id: Tab; href: string; label: string }[] = [
  { id: "dashboard", href: "/", label: "Overview" },
  { id: "peers", href: "/peers", label: "Clients" },
  { id: "activity", href: "/activity", label: "Activity" },
  { id: "cost", href: "/cost", label: "Cost" },
  { id: "settings", href: "/settings", label: "Settings" },
];

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
<link rel="icon" href="data:image/svg+xml,${raw(encodeURIComponent(favicon(s.state)))}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js" defer></script>
<script src="/qrcode.js" defer></script>
<script src="/app.js" defer></script>
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
<footer class="wrap">wg-admin · management plane for the on-demand WireGuard headend · state as of ${fmtTime(s.updated_at)}</footer>
</body>
</html>`;
}

export function notice(kind: "good" | "warn" | "bad" | "info", text: string): Html {
  return html`<div class="notice ${kind === "info" ? "" : kind}"><p>${text}</p></div>`;
}

function favicon(state: State): string {
  const color = state === "running" ? "#12945f" : state === "failed" ? "#d42b2b" : state === "destroyed" ? "#6b7a8a" : "#d97b06";
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

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function pill(kind: "up" | "busy" | "down" | "idle", text: string): Html {
  return html`<span class="pill ${kind}">${text}</span>`;
}

export function statePill(state: State): Html {
  const kind = state === "running" ? "up" : state === "failed" ? "down" : state === "destroyed" ? "idle" : "busy";
  return pill(kind, STATE_LABEL[state]);
}
