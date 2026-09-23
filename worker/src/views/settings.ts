// views/settings.ts
//
// Plain English: the back office. A setup checklist (which secrets are in
// place), the run lock (with a release button for a stuck run), the values
// the next deploy will use (editable), the server public key, and how to
// rotate it (a deliberate, off-dashboard action).

import { html } from "hono/html";
import type { Html } from "./layout";
import { fmtTime, sheetHead } from "./layout";
import type { Config } from "../env";
import { SECRET_GROUPS } from "../env";
import { REGIONS, regionName } from "../region";
import type { Profile, Schedule } from "../db";
import { daysText } from "../schedule-time";

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
  profiles?: Profile[];
  schedules?: Schedule[];
  err?: string | null;
  publicUrl?: string;
}

const SIZES = ["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"];
const DAYS: [string, string][] = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["7", "Sun"]];

/**
 * Install wg-admin as an app. What shows depends on the device, and app.js
 * fills it in: an Install button where the browser offers one (Chrome on
 * Android), the Share-sheet steps on an iPhone, "installed" when it already
 * runs as an app, and on a computer a QR code to open it on the phone.
 */
function installPanel(o: SettingsOpts): Html {
  return html`<div class="panel sheet" id="sh-install" data-install-panel>
    ${sheetHead("Install on your phone")}
    <h2>Install on your phone</h2>
    <p class="muted small">wg-admin installs as an app: its own icon, full screen, no browser bars, and the login lasts 24 hours.</p>
    <p data-install-state class="small"></p>
    <div class="btn-row" data-install-android hidden><button type="button" class="primary big" data-install>Install app</button></div>
    <ol class="steps small" data-install-ios hidden>
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap <b>Share</b> (the square with an arrow, bottom centre).</li>
      <li>Scroll down, tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
    </ol>
    <ol class="steps small" data-install-other hidden>
      <li>In Chrome, open the <b>⋮</b> menu.</li>
      <li>Tap <b>Install app</b> (or <b>Add to Home screen</b>).</li>
    </ol>
    <div data-install-desktop hidden>
      <p class="small muted">Scan with the phone's camera to open wg-admin there, then come back to this panel on the phone.</p>
      <div class="qr install-qr" data-qr-text="${o.publicUrl ?? ""}" aria-label="QR code of the dashboard address"></div>
    </div>
  </div>`;
}

/** Deploy profiles: list, delete, add. */
function profilesPanel(o: SettingsOpts): Html {
  const ps = o.profiles ?? [];
  return html`<div class="panel sheet" id="sh-profiles" style="margin-top:16px">
    ${sheetHead("Profiles")}
    <h2>Profiles</h2>
    <p class="muted small">Named places to deploy. Deploy offers each as one tap; while running, Move rebuilds in another.</p>
    ${ps.length
      ? html`<ul class="checklist">${ps.map((p) => html`<li><div style="flex:1"><b>${p.name}</b> <span class="muted small">${regionName(p.region)}, ${p.vm_size}</span></div><form method="post" action="/settings/profiles/${p.id}/delete" hx-boost="false"><button type="submit" class="danger" style="padding:3px 10px;font-size:.8rem">Delete</button></form></li>`)}</ul>`
      : html`<p class="faint">None yet.</p>`}
    <form method="post" action="/settings/profiles" style="margin-top:10px">
      <label class="field"><span>Name</span><input type="text" name="name" maxlength="24" required placeholder="Japan exit"></label>
      <label class="field"><span>Region</span><select name="region">${Object.entries(REGIONS).map(([r, n]) => html`<option value="${r}">${n}</option>`)}</select></label>
      <label class="field"><span>VM size</span><select name="vm_size">${SIZES.map((v) => html`<option value="${v}">${v}</option>`)}</select></label>
      <div class="btn-row"><button type="submit">Add profile</button></div>
    </form>
  </div>`;
}

/** Scheduled windows: list, pause, delete, add. */
function schedulesPanel(o: SettingsOpts): Html {
  const rs = o.schedules ?? [];
  const ps = o.profiles ?? [];
  const pname = (id: number | null) => (id ? ps.find((p) => p.id === id)?.name ?? "deleted profile" : "usual settings");
  return html`<div class="panel sheet" id="sh-schedules" style="margin-top:16px">
    ${sheetHead("Schedules")}
    <h2>Schedules</h2>
    <p class="muted small">When a window opens (UK time) the watchman deploys, or resumes from Standby, and sets the timer to the window's end. Each window starts once a day; tear down by hand and it stays down until tomorrow's.</p>
    ${rs.length
      ? html`<ul class="checklist">${rs.map((r) => html`<li><span class="${r.enabled ? "ok" : "no"}">${r.enabled ? "●" : "○"}</span><div style="flex:1"><b>${daysText(r.days)} ${r.start_time}–${r.end_time}</b> <span class="muted small">${pname(r.profile_id)}</span></div>
          <form method="post" action="/settings/schedules/${r.id}/toggle" hx-boost="false"><button type="submit" style="padding:3px 10px;font-size:.8rem">${r.enabled ? "Pause" : "Resume"}</button></form>
          <form method="post" action="/settings/schedules/${r.id}/delete" hx-boost="false"><button type="submit" class="danger" style="padding:3px 10px;font-size:.8rem">Delete</button></form></li>`)}</ul>`
      : html`<p class="faint">No schedules. Everything starts by hand.</p>`}
    <form method="post" action="/settings/schedules" style="margin-top:10px">
      <span class="small muted">Days</span>
      <div class="chips">${DAYS.map(([v, n]) => html`<label><input type="checkbox" name="day" value="${v}" ${Number(v) <= 5 ? "checked" : ""}><span>${n}</span></label>`)}</div>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <label class="field"><span>From</span><input type="time" name="start" value="08:00" required></label>
        <label class="field"><span>Until</span><input type="time" name="end" value="18:00" required></label>
      </div>
      <label class="field"><span>Profile</span><select name="profile"><option value="">Usual settings</option>${ps.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
      <div class="btn-row"><button type="submit">Add schedule</button></div>
    </form>
  </div>`;
}

/** The phone's Settings: three lights (setup, alerts, lock) and a button per section. */
function settingsPhone(o: SettingsOpts): Html {
  const missing = Object.keys(o.missing).length;
  const alerts = !o.webhook ? ["idle", "Alerts off"] : o.notifyError ? ["down", "Alerts failing"] : o.ntfy && !o.ntfyToken ? ["busy", "Alerts: no token"] : ["up", "Alerts on"];
  return html`<div class="m-only m-dock">
    <div class="m-inds">
      <span class="ind ${missing ? "down" : "up"}"><i></i>${missing ? `${missing} setup gap${missing === 1 ? "" : "s"}` : "Setup complete"}</span>
      <span class="ind ${alerts[0]}"><i></i>${alerts[1]}</span>
      <span class="ind ${o.lock.held ? "busy" : "up"}"><i></i>${o.lock.held ? "Run lock held" : "Lock free"}</span>
    </div>
    <div class="m-btns"><button type="button" class="primary" data-sheet="sh-install" data-install-link>Install the app</button></div>
    <div class="m-btns two">
      <button type="button" data-sheet="sh-next">Next deploy</button>
      <button type="button" data-sheet="sh-profiles">Profiles</button>
      <button type="button" data-sheet="sh-schedules">Schedules${(o.schedules ?? []).some((r) => r.enabled) ? html` <span class="count">${(o.schedules ?? []).filter((r) => r.enabled).length}</span>` : ""}</button>
      ${o.ntfy ? html`<button type="button" data-sheet="sh-alerts-setup">Phone alerts</button>` : html`<button type="button" data-sheet="sh-setup">Setup</button>`}
      ${o.ntfy ? html`<button type="button" data-sheet="sh-setup">Setup</button>` : ""}
      <button type="button" data-sheet="sh-lock">Run lock</button>
      <button type="button" data-sheet="sh-key">Server key</button>
    </div>
  </div>`;
}

export function settingsBody(o: SettingsOpts): Html {
  const ov = (k: string, d: string | number) => (o.overrides[k] ?? String(d));
  return html`<section>
  <div class="section-head"><h1>Settings</h1></div>
  ${o.saved ? html`<div class="notice good"><p>Saved.</p></div>` : ""}
  ${o.err === "profile" ? html`<div class="notice bad"><p>Not saved: a profile needs a short name (letters, digits, spaces, dashes) that is not already used.</p></div>` : ""}
  ${o.err === "schedule" ? html`<div class="notice bad"><p>Not saved: pick at least one day, and an end time later than the start (a window cannot cross midnight).</p></div>` : ""}
  ${settingsPhone(o)}
  <div class="two-col">
    <div class="panel sheet" id="sh-next">
      ${sheetHead("Next deploy")}
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
      <div class="panel sheet" id="sh-setup">
        ${sheetHead("Setup")}
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
        ? html`<div class="panel sheet" id="sh-alerts-setup" style="margin-top:16px">
        ${sheetHead("Phone alerts")}
        <h2>Phone alerts</h2>
        <p class="muted small">Install the free ntfy app (<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iPhone</a>, <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android</a>), tap +, and subscribe to this topic on ${o.ntfy.base.replace(/^https?:\/\//, "")}:</p>
        ${o.notifyError ? html`<div class="notice bad" style="margin:8px 0"><p><b>The last alert did not send</b> (${fmtTime(o.notifyError.at)}): <span class="mono small">${o.notifyError.why}</span>${o.ntfyToken ? "" : html` Anonymous posts from Cloudflare hit ntfy.sh's shared quota: make a free account at ntfy.sh, create an access token (Account, Access tokens) and set it as NOTIFY_TOKEN.`}</p></div>` : ""}
        <p class="small">${o.ntfyToken ? html`<span class="pill up">signed in</span> posting with your ntfy access token` : html`<span class="pill busy">anonymous</span> <span class="muted">no NOTIFY_TOKEN, so ntfy.sh may refuse posts from Cloudflare</span>`}</p>
        <code id="ntfy-topic">${o.ntfy.topic}</code> <button type="button" data-copy="#ntfy-topic" style="padding:3px 8px;font-size:.8rem">Copy</button>
        <p class="muted small" style="margin-top:8px">You get: ready (with the self-test result), a heads-up 15 minutes before the timer ends with Extend 1h / Hibernate / Tear down buttons, a summary when a session ends, and any drift, failure or cost guard. The topic name is the only key to the channel, so keep it to yourself; the buttons are single-use and can only extend, hibernate or tear down.</p>
      </div>`
        : ""}

      ${installPanel(o)}
      ${profilesPanel(o)}
      ${schedulesPanel(o)}

      <div class="panel sheet" id="sh-lock" style="margin-top:16px">
        ${sheetHead("Run lock")}
        <h2>Run lock</h2>
        ${o.lock.held
          ? html`<p class="muted">Held by <code>${o.lock.lock!.runId}</code> since ${fmtTime(o.lock.lock!.since)}. It expires on its own after 45 minutes.</p>
            <form method="post" action="/settings/release-lock"><div class="btn-row"><button type="submit" class="danger">Release lock</button><span class="small muted">Only if the run is truly dead. Check GitHub first.</span></div></form>`
          : html`<p class="muted">Free. One run at a time; a second click gets a clear message instead of a second VM.</p>`}
      </div>

      <div class="panel sheet" id="sh-key" style="margin-top:16px">
        ${sheetHead("Server key")}
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
