// views/activity.ts
//
// Plain English: the logbook. Every deploy and destroy with who asked, how
// long it took, what it cost and how it ended, plus everything the watchman
// noticed overnight. Below them, the change log: every configuration change
// made from the dashboard, who made it, and what it was before and after.

import { html } from "hono/html";
import type { Html } from "./layout";
import { fmtTime, duration, gbp, ago, sheetHead } from "./layout";
import type { Run, Alert, AuditEntry } from "../db";
import type { Config } from "../env";

export function sessionCost(run: Run, runs: Run[], cfg: Config, now = Date.now()): number | null {
  if (run.action !== "apply" || run.status !== "success" || !run.finished_at) return null;
  // Session ends at the next successful destroy after this apply, or now.
  const end = runs
    .filter((r) => r.action === "destroy" && r.status === "success" && r.finished_at && Date.parse(r.finished_at) > Date.parse(run.finished_at!))
    .map((r) => Date.parse(r.finished_at!))
    .sort((a, b) => a - b)[0];
  const ms = (end ?? now) - Date.parse(run.finished_at);
  return (ms / 3_600_000) * cfg.hourlyRateGbp;
}

/** Change-log rows per page. */
export const AUDIT_PAGE = 50;

/** The change log's "Show" filter: the first word of each change's action. */
export const AUDIT_KINDS: { value: string; label: string }[] = [
  { value: "", label: "All changes" },
  { value: "client", label: "Clients" },
  { value: "firewall", label: "Firewall and published ports" },
  { value: "settings", label: "Settings" },
  { value: "profile", label: "Profiles" },
  { value: "schedule", label: "Schedules" },
  { value: "push", label: "Phone alerts" },
  { value: "capture", label: "Packet captures" },
  { value: "lock", label: "Run lock" },
  { value: "config", label: "Backup and restore" },
];

export interface ChangeLog {
  rows: AuditEntry[];
  more: boolean;
  kind: string;
  q: string;
  page: number;
}

/** One value, short enough for a table cell. */
function shortValue(v: unknown): string {
  const s = v === null || v === undefined ? "none" : typeof v === "string" ? (v === "" ? "blank" : v) : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

/**
 * A change's before and after as plain lines: "enabled: 1 → 0" for an
 * edit, "name = Phone" for something added, "removed; it was:" and the old
 * values for a delete.
 */
export function describeChange(beforeJson: string | null, afterJson: string | null): string[] {
  const parse = (j: string | null): unknown => {
    try {
      return j === null ? null : JSON.parse(j);
    } catch {
      return j;
    }
  };
  const b = parse(beforeJson), a = parse(afterJson);
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (obj(b) && obj(a)) return [...new Set([...Object.keys(b), ...Object.keys(a)])].map((k) => `${k}: ${shortValue(b[k])} → ${shortValue(a[k])}`);
  if (obj(a)) return Object.entries(a).map(([k, v]) => `${k} = ${shortValue(v)}`);
  if (obj(b)) return ["removed; it was:", ...Object.entries(b).map(([k, v]) => `${k} = ${shortValue(v)}`)];
  if (b !== null || a !== null) return [`${shortValue(b)} → ${shortValue(a)}`];
  return [];
}

/** The address of one page of the change log, keeping the filter. */
function changesLink(o: ChangeLog, page: number): string {
  const p = new URLSearchParams();
  if (o.kind) p.set("kind", o.kind);
  if (o.q) p.set("q", o.q);
  if (page > 1) p.set("page", String(page));
  const qs = p.toString();
  return `/activity${qs ? `?${qs}` : ""}#changes`;
}

/** The change log: a filter, one page of changes newest first, and Newer / Older links. */
function changesSection(o: ChangeLog): Html {
  const filtered = !!(o.kind || o.q);
  return html`<section id="changes">
  <div class="section-head d-only"><h2>Change log</h2><span class="muted small">Who changed what from the dashboard. Keeps the newest 1000 changes, 180 days at most.</span></div>
  <div class="table-wrap sheet" id="sh-changes">
  ${sheetHead("Change log")}
  <form method="get" action="/activity#changes" class="btn-row" style="margin:0 0 12px">
    <select name="kind" aria-label="Show" style="width:auto">${AUDIT_KINDS.map((k) => html`<option value="${k.value}" ${k.value === o.kind ? "selected" : ""}>${k.label}</option>`)}</select>
    <input type="search" name="q" value="${o.q}" maxlength="60" placeholder="Search who, what or which" aria-label="Search" style="width:auto;flex:1 1 180px">
    <button type="submit">Filter</button>
    ${filtered ? html`<a class="small" href="/activity#changes">Clear</a>` : ""}
  </form>
  ${o.rows.length
    ? html`<table class="rows stack notes"><thead><tr><th>When</th><th>Change</th><th>On</th><th>What changed</th><th>By</th></tr></thead><tbody>
      ${o.rows.map((r) => html`<tr>
        <td class="small muted" data-label="When">${fmtTime(r.at)}</td>
        <td class="lead"><b>${r.action}</b></td>
        <td data-label="On">${r.target}</td>
        <td class="small wide">${describeChange(r.before_json, r.after_json).map((line) => html`<div>${line}</div>`)}</td>
        <td class="small phone-hide">${r.user}</td>
      </tr>`)}
      </tbody></table>`
    : html`<div class="empty"><b>${filtered ? "No changes match." : "No changes yet."}</b> ${filtered ? "Try another filter, or clear it." : "Adding a client, a firewall rule or saving Settings will be listed here."}</div>`}
  ${o.page > 1 || o.more
    ? html`<div class="btn-row small">
      ${o.page > 1 ? html`<a href="${changesLink(o, o.page - 1)}">← Newer</a>` : ""}
      <span class="muted">Page ${o.page}</span>
      ${o.more ? html`<a href="${changesLink(o, o.page + 1)}">Older →</a>` : ""}
    </div>`
    : ""}
  </div>
</section>`;
}

/** The phone's Activity: the last run and the last note as two lines, and buttons for the lists. */
function activityPhone(o: { runs: Run[]; alerts: Alert[] }): Html {
  const r = o.runs[0];
  const a = o.alerts[0];
  const kind = (st: string) => (st === "success" ? "up" : st === "failure" ? "down" : st === "cancelled" ? "idle" : "busy");
  const noteKind = (k: string) => (["failure", "drift", "cost_guard", "unreachable"].includes(k) ? "down" : "idle");
  return html`<div class="m-only m-dock">
    <div class="m-card">
      <div class="m-label">Last run</div>
      ${r ? html`<div class="m-line"><span class="ind ${kind(r.status)}"><i></i>${r.action === "apply" ? "Deploy" : "Tear down"} ${r.status}</span><span class="m-right">${ago(r.requested_at)}</span></div>` : html`<div class="m-line faint">None yet</div>`}
    </div>
    <div class="m-card">
      <div class="m-label">Last note</div>
      ${a ? html`<div class="m-line"><span class="ind ${noteKind(a.kind)}"><i></i>${a.kind.replace("_", " ")}</span><span class="m-right">${ago(a.at)}</span></div><div class="m-clamp">${a.message}</div>` : html`<div class="m-line faint">Nothing noticed yet</div>`}
    </div>
    <div class="m-btns three"><button type="button" data-sheet="sh-runs">Runs (${o.runs.length})</button><button type="button" data-sheet="sh-notes">Notes (${o.alerts.length})</button><button type="button" data-sheet="sh-changes">Changes</button></div>
  </div>`;
}

export function activityBody(o: { runs: Run[]; alerts: Alert[]; cfg: Config; changes?: ChangeLog }): Html {
  return html`<section>
  <div class="section-head"><h1>Activity</h1></div>
  ${activityPhone(o)}
  <div class="table-wrap sheet" id="sh-runs">
  ${sheetHead("Runs")}
  ${o.runs.length
    ? html`<table class="rows stack">
      <thead><tr><th>When</th><th>Action</th><th>Result</th><th>Took</th><th class="num">Session cost</th><th>By</th><th>Notes</th></tr></thead>
      <tbody>${o.runs.map((r) => {
        const cost = sessionCost(r, o.runs, o.cfg);
        const kind = r.status === "success" ? "up" : r.status === "failure" ? "down" : r.status === "cancelled" ? "idle" : "busy";
        return html`<tr>
          <td data-label="When">${fmtTime(r.requested_at)}</td>
          <td class="lead"><b>${r.action === "apply" ? "Deploy" : "Tear down"}</b>${r.public_ip ? html`<div class="key">${r.public_ip}</div>` : ""}</td>
          <td data-label="Result"><span class="pill ${kind}">${r.status}</span>${r.github_run_url ? html` <a class="small" href="${r.github_run_url}" target="_blank" rel="noopener">log</a>` : ""}</td>
          <td data-label="Took">${duration(r.started_at ?? r.requested_at, r.finished_at)}</td>
          <td class="num" data-label="Session cost">${cost === null ? html`<span class="faint">—</span>` : html`~${gbp(cost)}`}</td>
          <td class="small phone-hide">${r.requested_by ?? ""}</td>
          <td class="small muted wide">${r.reason ?? ""}${r.error ? html`<div style="color:var(--down)">${r.error}</div>` : ""}</td>
        </tr>`;
      })}</tbody></table>`
    : html`<div class="empty"><b>No runs yet.</b> The first deploy will appear here.</div>`}
  </div>
</section>

<section>
  <div class="section-head d-only"><h2>Watchman notes</h2><span class="muted small">Checks run every 5 minutes, whether or not anyone is looking.</span></div>
  <div class="table-wrap sheet" id="sh-notes">
  ${sheetHead("Watchman notes")}
  ${o.alerts.length
    ? html`<table class="rows stack notes"><thead><tr><th>When</th><th>Kind</th><th>What happened</th></tr></thead><tbody>
      ${o.alerts.map((a) => html`<tr><td class="small muted">${fmtTime(a.at)}</td><td><span class="pill ${a.kind === "failure" || a.kind === "drift" || a.kind === "cost_guard" || a.kind === "unreachable" ? "down" : a.kind === "deploy" || a.kind === "destroy" ? "up" : "idle"}">${a.kind.replace("_", " ")}</span></td><td class="wide">${a.message}</td></tr>`)}
      </tbody></table>`
    : html`<div class="empty"><b>Nothing noticed yet.</b> Drift, cost-guard fires, missing heartbeats and completed runs will be listed here.</div>`}
  </div>
</section>

${changesSection(o.changes ?? { rows: [], more: false, kind: "", q: "", page: 1 })}`;
}
