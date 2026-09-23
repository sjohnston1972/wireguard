// views/activity.ts
//
// Plain English: the logbook. Every deploy and destroy with who asked, how
// long it took, what it cost and how it ended, plus everything the watchman
// noticed overnight.

import { html } from "hono/html";
import type { Html } from "./layout";
import { fmtTime, duration, gbp, ago, sheetHead } from "./layout";
import type { Run, Alert } from "../db";
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
    <div class="m-btns two"><button type="button" data-sheet="sh-runs">Runs (${o.runs.length})</button><button type="button" data-sheet="sh-notes">Notes (${o.alerts.length})</button></div>
  </div>`;
}

export function activityBody(o: { runs: Run[]; alerts: Alert[]; cfg: Config }): Html {
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
</section>`;
}
