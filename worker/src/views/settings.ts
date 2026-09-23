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
import { REGIONS } from "../region";

export interface SettingsOpts {
  cfg: Config;
  overrides: Record<string, string>;
  missing: Record<string, string[]>;
  lock: { held: boolean; lock: { runId: string; since: string } | null };
  serverPub: string | null;
  saved?: boolean;
  repo: string | null;
  webhook: boolean;
  /** When notifications go to ntfy: where to subscribe on the phone. */
  ntfy?: { base: string; topic: string } | null;
  /** Whether an ntfy access token is set, and the last failed notification. */
  ntfyToken?: boolean;
  notifyError?: { at: string; why: string } | null;
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
          <select name="region">${Object.entries(REGIONS).map(([r, name]) => html`<option value="${r}" ${ov("region", o.cfg.region) === r ? "selected" : ""}>${name}</option>`)}</select>
          <div class="hint">The usual region. Away from home, Deploy also offers the one nearest to you. Changing region is a full tear-down and deploy; clients do not change.</div></label>
        <label class="field"><span>VM size</span>
          <select name="vm_size">${["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"].map((v) => html`<option value="${v}" ${ov("vm_size", o.cfg.vmSize) === v ? "selected" : ""}>${v}</option>`)}</select></label>
        <label class="field"><span>Default auto-destroy (hours, 0 = none)</span><input type="number" name="auto_destroy_default_hours" min="0" max="72" step="0.25" value="${ov("auto_destroy_default_hours", o.cfg.autoDestroyDefaultHours)}"></label>
        <label class="field"><span>When the timer or idle limit is reached</span>
          <select name="expiry_action">
            <option value="destroy" ${ov("expiry_action", o.cfg.expiryAction) === "destroy" ? "selected" : ""}>Tear down (back to £0, next start is a 4-minute deploy)</option>
            <option value="hibernate" ${ov("expiry_action", o.cfg.expiryAction) === "hibernate" ? "selected" : ""}>Hibernate (Standby, about £4.65 a month, resume in a minute)</option>
          </select>
          <div class="hint">The cost guard always tears down, whatever this says.</div></label>
        <label class="field"><span>Longest time in Standby before it is torn down (days)</span><input type="number" name="standby_max_days" min="1" max="60" value="${ov("standby_max_days", o.cfg.standbyMaxDays)}"></label>
        <label class="field"><span>Idle limit (minutes without a handshake, 0 = off)</span><input type="number" name="idle_destroy_minutes" min="0" max="1440" value="${ov("idle_destroy_minutes", o.cfg.idleDestroyMinutes)}"></label>
        <label class="field"><span>Monthly budget warning (£)</span><input type="number" name="monthly_budget_gbp" min="0" step="0.5" value="${ov("monthly_budget_gbp", o.cfg.monthlyBudgetGbp)}"></label>
        <label class="field"><span>Estimated cost per hour (£)</span><input type="number" name="hourly_rate_gbp" min="0" step="0.0001" value="${ov("hourly_rate_gbp", o.cfg.hourlyRateGbp)}"><div class="hint">B1s + 30 GB SSD + static IPv4 in UK South is about £0.0157 (IPv6 is free). Actual figures come from Azure once a day.</div></label>
        <label class="field"><span>Estimated Standby cost per hour (£)</span><input type="number" name="standby_rate_gbp" min="0" step="0.0001" value="${ov("standby_rate_gbp", o.cfg.standbyRateGbp)}"><div class="hint">Disk and static IP only, about £0.0064.</div></label>
        <label class="field"><span>SSH allowed from (CIDR, blank = the address that clicks Deploy)</span><input type="text" name="ssh_allowed_cidr" placeholder="203.0.113.10/32" value="${ov("ssh_allowed_cidr", o.cfg.sshAllowedCidr)}"></label>
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
          <li><span class="${o.webhook ? "ok" : "no"}">${o.webhook ? "✓" : "–"}</span><div>Notifications${o.ntfy ? " to the ntfy app" : o.webhook ? " webhook" : html` <span class="small muted">(optional; set NOTIFY_WEBHOOK_URL for ntfy, Discord, Slack or JSON)</span>`}</div></li>
        </ul>
        ${o.repo ? html`<p class="small muted" style="margin-top:10px">Runner: <a href="https://github.com/${o.repo}/actions" target="_blank" rel="noopener">github.com/${o.repo}</a></p>` : ""}
      </div>

      ${o.ntfy
        ? html`<div class="panel" style="margin-top:16px">
        <h2>Phone alerts</h2>
        <p class="muted small">Install the free ntfy app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a>, <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>), tap +, and subscribe to this topic on ${o.ntfy.base.replace(/^https?:\/\//, "")}:</p>
        ${o.notifyError ? html`<div class="notice bad" style="margin:8px 0"><p><b>The last alert did not send</b> (${fmtTime(o.notifyError.at)}): <span class="mono small">${o.notifyError.why}</span>${o.ntfyToken ? "" : html` Anonymous posts from Cloudflare hit ntfy.sh's shared quota: make a free account at ntfy.sh, create an access token (Account, Access tokens) and set it as NOTIFY_TOKEN.`}</p></div>` : ""}
        <p class="small">${o.ntfyToken ? html`<span class="pill up">signed in</span> posting with your ntfy access token` : html`<span class="pill busy">anonymous</span> <span class="muted">no NOTIFY_TOKEN, so ntfy.sh may refuse posts from Cloudflare</span>`}</p>
        <code id="ntfy-topic">${o.ntfy.topic}</code> <button type="button" data-copy="#ntfy-topic" style="padding:3px 8px;font-size:.8rem">Copy</button>
        <p class="muted small" style="margin-top:8px">You get: ready (with the self-test result), a heads-up 15 minutes before the timer ends with Extend 1h / Hibernate / Tear down buttons, a summary when a session ends, and any drift, failure or cost guard. The topic name is the only key to the channel, so keep it to yourself; the buttons are single-use and can only extend, hibernate or tear down.</p>
      </div>`
        : ""}

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
(put the new WG_SERVER_PUBLIC_KEY in wrangler.toml)
npm run deploy-worker</pre>
        <p class="muted small">Then re-add each client so it gets a config that trusts the new key.</p>
      </div>
    </div>
  </div>
</section>`;
}
