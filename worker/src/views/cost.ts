// views/cost.ts
//
// Plain English: the bill. Estimated cost of the current session ticking up,
// actual daily spend this month from Azure Cost Management as a bar chart,
// the month's total against the budget (budget.ts: alerts at 80% and 100%,
// and Deploy asks to confirm when over), and what each past session cost.

import { html } from "hono/html";
import type { Html } from "./layout";
import { gbp, fmtDate, fmtTime, duration, sheetHead } from "./layout";
import type { CostDay, Run } from "../db";
import type { Config } from "../env";
import type { Snapshot } from "../state";
import { sessionCost } from "./activity";
import type { BudgetStatus } from "../budget";

export function costBody(o: { snap: Snapshot; days: CostDay[]; runs: Run[]; cfg: Config; fetchedDay: string | null; budget: BudgetStatus }): Html {
  const total = o.days.reduce((a, d) => a + d.gbp, 0);
  const b = o.budget;
  const pct = Math.min(100, b.pct);
  const cls = b.level === "over" ? "over" : b.level === "warn" ? "warn" : "";
  const sessions = o.runs.filter((r) => r.action === "apply" && r.status === "success");
  const estMonth = sessions.reduce((a, r) => a + (sessionCost(r, o.runs, o.cfg) ?? 0), 0);
  return html`<section>
  <div class="section-head"><h1>Cost</h1><span class="muted small d-only">Estimates use ${gbp(o.cfg.hourlyRateGbp)} an hour; actuals come from Azure once a day.</span></div>
  <div class="two-col">
    <div class="panel">
      <h2>This session</h2>
      <div class="bignum">${o.snap.running_since ? html`<span data-cost-since="${o.snap.running_since}" data-rate="${o.cfg.hourlyRateGbp}">£0.00</span>` : "£0.00"}</div>
      <p class="muted small">${o.snap.running_since ? html`Running since ${fmtTime(o.snap.running_since)}.` : "Nothing is running."}</p>
    </div>
    <div class="panel">
      <h2>This month, actual</h2>
      <div class="bignum">${gbp(total)}</div>
      ${b.level === "none"
        ? html`<p class="muted small">No monthly budget set, so no budget alerts. <a href="/settings">Set one in Settings</a>.</p>`
        : html`<div class="budget"><i class="${cls}" style="width:${pct.toFixed(0)}%"></i></div>
      <p class="muted small">${b.pct.toFixed(0)}% of the ${gbp(b.budget)} budget${b.session > 0 ? html`, counting about ${gbp(b.session)} more for this session to its timer` : ""}.</p>`}
      <p class="muted small d-only">${o.fetchedDay ? html`From Azure on ${o.fetchedDay}.` : "No Azure figures yet."} Sessions this month estimate to ${gbp(estMonth)}.</p>
      ${budgetLine(b)}
    </div>
  </div>
  <div class="m-btns two m-only" style="margin-top:12px"><button type="button" data-sheet="sh-daily">Daily spend</button><button type="button" data-sheet="sh-sessions">Sessions (${sessions.length})</button></div>
</section>

<section>
  <div class="panel sheet" id="sh-daily">
    ${sheetHead("Daily spend")}
    <h2>Daily spend</h2>
    ${o.days.length ? chart(o.days) : html`<p class="muted">No daily figures yet. Azure publishes usage with a delay of up to 24 hours; the watchman pulls it once a day.</p>`}
  </div>
</section>

<section>
  <div class="section-head d-only"><h2>Sessions</h2></div>
  <div class="table-wrap sheet" id="sh-sessions">
  ${sheetHead("Sessions")}
  ${sessions.length
    ? html`<table class="rows stack"><thead><tr><th>Deployed</th><th>Region</th><th>Ran for</th><th class="num">Estimated</th></tr></thead><tbody>
      ${sessions.map((r) => {
        const end = o.runs.filter((x) => x.action === "destroy" && x.status === "success" && x.finished_at && r.finished_at && Date.parse(x.finished_at) > Date.parse(r.finished_at)).map((x) => x.finished_at!).sort()[0] ?? null;
        let region = o.cfg.region;
        try { region = (JSON.parse(r.payload_json ?? "{}") as { region?: string }).region ?? region; } catch { /* keep default */ }
        return html`<tr><td class="lead"><b>${fmtTime(r.finished_at)}</b></td><td data-label="Region">${region}</td><td data-label="Ran for">${end ? duration(r.finished_at, end) : html`<span class="pill up">still running</span>`}</td><td class="num" data-label="Estimated">~${gbp(sessionCost(r, o.runs, o.cfg) ?? 0)}</td></tr>`;
      })}</tbody></table>`
    : html`<div class="empty"><b>No sessions yet.</b></div>`}
  </div>
</section>`;
}

/** What the budget means right now: phone alerts sent, and the Deploy guard. */
function budgetLine(b: BudgetStatus): Html {
  if (b.level === "none") return html``;
  const sent = b.alerted === 100 ? "The 100% phone alert has gone out this month." : b.alerted === 80 ? "The 80% phone alert has gone out this month; the next comes at 100%." : "Your phone gets an alert at 80% and at 100%, once each a month.";
  if (b.level === "over") return html`<div class="notice bad" style="margin-top:10px"><p><b>Over budget.</b> Deploy asks you to tick "Deploy anyway" until the month ends or the budget is raised in Settings. ${sent}</p></div>`;
  if (b.level === "warn") return html`<div class="notice warn" style="margin-top:10px"><p><b>Past 80% of the budget.</b> ${sent}</p></div>`;
  return html`<p class="muted small">${sent}</p>`;
}

function chart(days: CostDay[]): Html {
  const w = 640, h = 180, padL = 40, padB = 26, padT = 10;
  const max = Math.max(0.01, ...days.map((d) => d.gbp));
  const n = days.length;
  const bw = Math.max(4, Math.min(28, ((w - padL - 10) / n) * 0.7));
  const step = (w - padL - 10) / n;
  const today = new Date().toISOString().slice(0, 10);
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / max);
  return html`<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily cost this month">
  <line class="axis" x1="${padL}" y1="${h - padB}" x2="${w - 5}" y2="${h - padB}"/>
  <text x="${padL + 4}" y="${padT + 12}" text-anchor="start">${gbp(max)}</text>
  <text class="minor" x="${padL - 6}" y="${h - padB}" text-anchor="end">£0</text>
  ${days.map((d, i) => {
    const x = padL + i * step + (step - bw) / 2;
    const yy = y(d.gbp);
    return html`<g><rect class="bar ${d.day === today ? "today" : ""}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - padB - yy).toFixed(1)}" rx="2"><title>${d.day}: ${gbp(d.gbp)}</title></rect>
      ${n <= 16 || i % Math.ceil(n / 12) === 0 || i === n - 1 ? html`<text class="${i === 0 || i === n - 1 || i === Math.floor(n / 2) ? "" : "minor"}" x="${(x + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${fmtDate(d.day)}</text>` : ""}</g>`;
  })}
</svg>`;
}
