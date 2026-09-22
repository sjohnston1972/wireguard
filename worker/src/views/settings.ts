// views/settings.ts
//
// Plain English: the back office. A setup checklist (which secrets are in
// place), the run lock (with a release button for a stuck run), the values
// the next deploy will use (editable), the server public key, and how to
// rotate it (a deliberate, off-dashboard action).

import { html } from "hono/html";
import type { Html } from "./layout";
import { fmtTime } from "./layout";
import type { Config } from "../env";
import { SECRET_GROUPS } from "../env";

export interface SettingsOpts {
  cfg: Config;
  overrides: Record<string, string>;
  missing: Record<string, string[]>;
  lock: { held: boolean; lock: { runId: string; since: string } | null };
  serverPub: string | null;
  saved?: boolean;
  repo: string | null;
  webhook: boolean;
}

export function settingsBody(o: SettingsOpts): Html {
  const ov = (k: string, d: string | number) => (o.overrides[k] ?? String(d));
  return html`<section>
  <div class="section-head"><h1>Settings</h1></div>
  ${o.saved ? html`<div class="notice good"><p>Saved. The next deploy uses these values.</p></div>` : ""}
  <div class="two-col">
    <div class="panel">
      <h2>Next deploy</h2>
      <form method="post" action="/settings">
        <label class="field"><span>Azure region</span>
          <select name="region">${["uksouth", "ukwest", "westeurope", "northeurope", "eastus", "westus2", "centralus"].map((r) => html`<option value="${r}" ${ov("region", o.cfg.region) === r ? "selected" : ""}>${r}</option>`)}</select>
          <div class="hint">Changing region is a full tear-down and deploy. Clients do not change.</div></label>
        <label class="field"><span>VM size</span>
          <select name="vm_size">${["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"].map((v) => html`<option value="${v}" ${ov("vm_size", o.cfg.vmSize) === v ? "selected" : ""}>${v}</option>`)}</select></label>
        <label class="field"><span>Default auto-destroy (hours, 0 = none)</span><input type="number" name="auto_destroy_default_hours" min="0" max="72" step="0.25" value="${ov("auto_destroy_default_hours", o.cfg.autoDestroyDefaultHours)}"></label>
        <label class="field"><span>Idle tear-down (minutes without a handshake, 0 = off)</span><input type="number" name="idle_destroy_minutes" min="0" max="1440" value="${ov("idle_destroy_minutes", o.cfg.idleDestroyMinutes)}"></label>
        <label class="field"><span>Monthly budget warning (£)</span><input type="number" name="monthly_budget_gbp" min="0" step="0.5" value="${ov("monthly_budget_gbp", o.cfg.monthlyBudgetGbp)}"></label>
        <label class="field"><span>Estimated cost per hour (£)</span><input type="number" name="hourly_rate_gbp" min="0" step="0.0001" value="${ov("hourly_rate_gbp", o.cfg.hourlyRateGbp)}"><div class="hint">B1s + 30 GB SSD + static IP in UK South is about £0.0149. Actual figures come from Azure once a day.</div></label>
        <label class="field"><span>SSH allowed from (CIDR, blank = the address that clicks Deploy)</span><input type="text" name="ssh_allowed_cidr" placeholder="81.97.53.125/32" value="${ov("ssh_allowed_cidr", o.cfg.sshAllowedCidr)}"></label>
        <div class="btn-row"><button type="submit" class="primary">Save</button></div>
      </form>
    </div>

    <div>
      <div class="panel">
        <h2>Setup</h2>
        <p class="muted small">Secrets live in the Worker, set with <kbd>npm run secrets -- --worker</kbd>. This list only shows presence, never values.</p>
        <ul class="checklist">
          ${Object.entries(SECRET_GROUPS).map(([group, keys]) => {
            const miss = o.missing[group] ?? [];
            return html`<li><span class="${miss.length ? "no" : "ok"}">${miss.length ? "✕" : "✓"}</span><div>${group}${miss.length ? html`<div class="small muted">missing: ${miss.join(", ")}</div>` : ""}</div></li>`;
          })}
          <li><span class="${o.webhook ? "ok" : "no"}">${o.webhook ? "✓" : "–"}</span><div>Notifications webhook${o.webhook ? "" : html` <span class="small muted">(optional; set NOTIFY_WEBHOOK_URL for Discord, Slack, ntfy or JSON)</span>`}</div></li>
        </ul>
        ${o.repo ? html`<p class="small muted" style="margin-top:10px">Runner: <a href="https://github.com/${o.repo}/actions" target="_blank" rel="noopener">github.com/${o.repo}</a></p>` : ""}
      </div>

      <div class="panel" style="margin-top:16px">
        <h2>Run lock</h2>
        ${o.lock.held
          ? html`<p class="muted">Held by <code>${o.lock.lock!.runId}</code> since ${fmtTime(o.lock.lock!.since)}. It expires on its own after 45 minutes.</p>
            <form method="post" action="/settings/release-lock"><div class="btn-row"><button type="submit" class="danger">Release lock</button><span class="small muted">Only if the run is truly dead. Check GitHub first.</span></div></form>`
          : html`<p class="muted">Free. One run at a time; a second click gets a clear message instead of a second VM.</p>`}
      </div>

      <div class="panel" style="margin-top:16px">
        <h2>Server key</h2>
        ${o.serverPub ? html`<p class="small">Public key <code>${o.serverPub}</code></p>` : html`<p class="muted">Not configured.</p>`}
        <p class="muted small">Rotating it invalidates every client. It is deliberately not a button here. On the laptop:</p>
        <pre class="conf">npm run keys -- --rotate
npm run secrets
npm run secrets -- --worker</pre>
        <p class="muted small">Then re-add each client so it gets a config that trusts the new key.</p>
      </div>
    </div>
  </div>
</section>`;
}
