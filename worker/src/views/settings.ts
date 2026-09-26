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
import type { Profile, Schedule, PushSub } from "../db";
import { daysText } from "../schedule-time";
import type { BackupStatus, ExportTable, RestorePlan } from "../backup";
import { TABLE_LABEL } from "../backup";

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
  pushSubs?: PushSub[];
  vapidPublic?: string | null;
  /** What R2 holds (backup.ts). */
  backups?: BackupStatus;
  /** Just back from a restore. */
  restored?: boolean;
}

/**
 * Phone alerts: pushed to the wg-admin app itself (Web Push). app.js fills in
 * the state for this device and wires the buttons; the list below is every
 * phone signed up, from the database.
 */
function alertsPanel(o: SettingsOpts): Html {
  const subs = o.pushSubs ?? [];
  return html`<div class="panel sheet" id="sh-alerts-setup" style="margin-top:16px" data-push-panel data-vapid="${o.vapidPublic ?? ""}">
    ${sheetHead("Phone alerts")}
    <h2>Phone alerts</h2>
    <p class="muted small">Alerts come from the wg-admin app like any app's: ready (with the self-test result), a heads-up 15 minutes before the timer ends with Extend 1h and Hibernate buttons, a summary when a session ends, and drift, failures, scheduled starts and the cost guard.</p>
    ${o.notifyError ? html`<div class="notice bad" style="margin:8px 0"><p><b>The last alert did not send</b> (${fmtTime(o.notifyError.at)}): <span class="mono small">${o.notifyError.why}</span></p></div>` : ""}
    <p class="small" data-push-state>${o.vapidPublic ? "" : html`<span class="pill idle">not set up</span> VAPID keys are missing.`}</p>
    <div class="btn-row">
      <button type="button" class="primary big" data-push-on hidden>Turn on alerts on this phone</button>
      <button type="button" data-push-test hidden>Send a test alert</button>
      <button type="button" data-push-off hidden>Turn off on this device</button>
    </div>
    ${subs.length
      ? html`<ul class="checklist" style="margin-top:12px">${subs.map((s) => html`<li data-push-id="${s.id}"><span class="${s.last_error ? "no" : "ok"}">${s.last_error ? "✕" : "✓"}</span><div style="flex:1">${s.label ?? "A device"} <span class="pill idle" data-this-device hidden>this device</span> <span class="muted small">${s.last_error ? html`last alert failed: ${s.last_error}` : s.last_ok ? `last alert ${fmtTime(s.last_ok)}` : `since ${fmtTime(s.created_at)}`}</span></div><form method="post" action="/settings/push/${s.id}/delete" hx-boost="false" data-confirm="Stop sending alerts to ${s.label ?? "this device"}? To get them there again, turn alerts on from that device."><button type="submit" class="danger" style="padding:3px 10px;font-size:.8rem">Remove</button></form></li>`)}</ul>`
      : html`<p class="faint small" style="margin-top:10px">No phone signed up yet.</p>`}
  </div>`;
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

/** A schedule in words, for lists and questions: "Mon–Fri 08:00–18:00". */
function scheduleText(r: Schedule): string {
  return `${daysText(r.days)} ${r.start_time}–${r.end_time}`;
}

/**
 * The question asked before deleting a profile. A schedule that uses it
 * would quietly fall back to the usual settings, so those are named.
 */
function profileDeleteQuestion(p: Profile, schedules: Schedule[]): string {
  const using = schedules.filter((r) => r.profile_id === p.id);
  const q = `Delete the profile "${p.name}"?`;
  if (!using.length) return q;
  return `${q} ${using.length === 1 ? "This schedule uses it" : `These ${using.length} schedules use it`}: ${using.map(scheduleText).join("; ")}. ${using.length === 1 ? "It" : "They"} will then build with the usual settings instead.`;
}

/** Deploy profiles: list, delete, add. */
function profilesPanel(o: SettingsOpts): Html {
  const ps = o.profiles ?? [];
  const rs = o.schedules ?? [];
  return html`<div class="panel sheet" id="sh-profiles" style="margin-top:16px">
    ${sheetHead("Profiles")}
    <h2>Profiles</h2>
    <p class="muted small">Named places to deploy. Deploy offers each as one tap; while running, Move rebuilds in another.</p>
    ${ps.length
      ? html`<ul class="checklist">${ps.map((p) => {
          const used = rs.filter((r) => r.profile_id === p.id).length;
          return html`<li><div style="flex:1"><b>${p.name}</b> <span class="muted small">${regionName(p.region)}, ${p.vm_size}${used ? `; used by ${used} schedule${used === 1 ? "" : "s"}` : ""}</span></div><form method="post" action="/settings/profiles/${p.id}/delete" hx-boost="false" data-confirm="${profileDeleteQuestion(p, rs)}"><button type="submit" class="danger" style="padding:3px 10px;font-size:.8rem">Delete</button></form></li>`;
        })}</ul>`
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
      ? html`<ul class="checklist">${rs.map((r) => html`<li><span class="${r.enabled ? "ok" : "no"}">${r.enabled ? "●" : "○"}</span><div style="flex:1"><b>${scheduleText(r)}</b> <span class="muted small">${pname(r.profile_id)}</span></div>
          <form method="post" action="/settings/schedules/${r.id}/toggle" hx-boost="false"><button type="submit" style="padding:3px 10px;font-size:.8rem">${r.enabled ? "Pause" : "Resume"}</button></form>
          <form method="post" action="/settings/schedules/${r.id}/delete" hx-boost="false" data-confirm="Delete the schedule ${scheduleText(r)}? (Pause keeps it for later.)"><button type="submit" class="danger" style="padding:3px 10px;font-size:.8rem">Delete</button></form></li>`)}</ul>`
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

/** A backup set in words: "12 kept, newest 26 Sep 03:05". */
function setText(b: { count: number; newest: string | null }): string {
  return b.count ? `${b.count} kept, newest ${fmtTime(b.newest)}` : "none yet";
}

/**
 * Backups: the Terraform state copies GitHub Actions makes after each run,
 * the nightly export of the dashboard's own data, and download and restore.
 */
function backupsPanel(o: SettingsOpts): Html {
  const b = o.backups;
  return html`<div class="panel sheet" id="sh-backups" style="margin-top:16px">
    ${sheetHead("Backups")}
    <h2>Backups</h2>
    ${b?.error ? html`<div class="notice bad" style="margin:8px 0"><p>Could not read R2: <span class="mono small">${b.error}</span></p></div>` : ""}
    <ul class="checklist">
      <li><span class="${b?.state.count ? "ok" : "no"}">${b?.state.count ? "✓" : "–"}</span><div>Terraform state <span class="muted small">${b ? setText(b.state) : "not checked"}. Copied after every deploy or tear-down; the last 20 are kept.</span></div></li>
      <li><span class="${b?.config.count ? "ok" : "no"}">${b?.config.count ? "✓" : "–"}</span><div>Dashboard data <span class="muted small">${b ? setText(b.config) : "not checked"}. Clients, firewall rules, published ports, profiles, schedules, alert phones and settings, saved once a day; the last 30 are kept.</span>${b?.config.days.length ? html`<div class="small">Newest: <a href="/settings/backup/config/${b.config.days[0]}" hx-boost="false" download>${b.config.days[0]}</a></div>` : ""}</div></li>
    </ul>
    <p class="muted small" style="margin-top:10px">An export holds no passwords or tokens, and no client private keys (the dashboard never has them), so restored clients keep working with the configs they already have.</p>
    <div class="btn-row"><a class="btn" href="/settings/backup/export" hx-boost="false" download>Download export</a></div>
    <form method="post" action="/settings/backup/restore" enctype="multipart/form-data" hx-boost="false" style="margin-top:12px">
      <label class="field"><span>Restore from file</span><input type="file" name="file" accept=".json,application/json" required>
        <div class="hint">You will see what the file holds before anything changes.</div></label>
      <div class="btn-row"><button type="submit">Check file</button></div>
    </form>
  </div>`;
}

export interface RestoreOpts {
  current: Record<ExportTable, number>;
  plan?: RestorePlan;
  token?: string;
  fileName?: string;
  error?: string;
}

/**
 * Restore, step two: what the file holds against what is here now, and the
 * typed confirmation. Or, if the file could not be used, why.
 */
export function restoreBody(o: RestoreOpts): Html {
  const names = Object.keys(TABLE_LABEL) as ExportTable[];
  return html`<section>
  <div class="section-head"><h1>Restore from file</h1></div>
  ${o.error ? html`<div class="notice bad"><p>${o.error}</p></div>` : ""}
  ${o.plan && o.token
    ? html`<div class="panel">
      <p>${o.fileName ? html`<b>${o.fileName}</b>, e` : "E"}xported ${fmtTime(o.plan.exported_at)}.</p>
      <table class="rows"><thead><tr><th></th><th>Now</th><th>After restore</th></tr></thead><tbody>
        ${names.map((n) => html`<tr><th>${TABLE_LABEL[n]}</th><td>${o.current[n]}</td><td><b>${o.plan!.counts[n]}</b></td></tr>`)}
      </tbody></table>
      <p class="muted small" style="margin-top:10px">Everything in these lists is replaced by the file's copy in one go. Clients, firewall rules and ports reach a running VM within 30 seconds. Nothing else (runs, activity, cost history) changes.</p>
      <form method="post" action="/settings/backup/restore/confirm" hx-boost="false">
        <input type="hidden" name="token" value="${o.token}">
        <label class="field"><span>Type <kbd>restore</kbd> to confirm</span><input type="text" name="confirm" autocomplete="off" data-confirm-word="restore" placeholder="restore"></label>
        <div class="btn-row"><button type="submit" class="danger">Replace with this file</button><a class="btn" href="/settings">Cancel</a></div>
      </form>
    </div>`
    : html`<p><a class="btn" href="/settings">Back to Settings</a></p>`}
</section>`;
}

/** The phone's Settings: three lights (setup, alerts, lock) and a button per section. */
function settingsPhone(o: SettingsOpts): Html {
  const missing = Object.keys(o.missing).length;
  const phones = (o.pushSubs ?? []).length;
  const alerts = o.notifyError ? ["down", "Alerts failing"] : phones ? ["up", `Alerts on (${phones})`] : ["busy", "Alerts off"];
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
      <button type="button" data-sheet="sh-alerts-setup">Phone alerts</button>
      <button type="button" data-sheet="sh-setup">Setup</button>
      <button type="button" data-sheet="sh-lock">Run lock</button>
      <button type="button" data-sheet="sh-key">Server key</button>
      <button type="button" data-sheet="sh-backups">Backups</button>
    </div>
  </div>`;
}

export function settingsBody(o: SettingsOpts): Html {
  const ov = (k: string, d: string | number) => (o.overrides[k] ?? String(d));
  return html`<section>
  <div class="section-head"><h1>Settings</h1></div>
  ${o.saved ? html`<div class="notice good"><p>Saved.</p></div>` : ""}
  ${o.restored ? html`<div class="notice good"><p>Restored. The dashboard's data now matches the file.</p></div>` : ""}
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
        <label class="field"><span>Test VM behind the firewall</span>
          <select name="test_vm"><option value="1" ${ov("test_vm", o.cfg.testVm ? "1" : "0") === "1" ? "selected" : ""}>Build it (B1ls in the workloads subnet, about £0.006 an hour)</option><option value="0" ${ov("test_vm", o.cfg.testVm ? "1" : "0") === "0" ? "selected" : ""}>Don't build it</option></select>
          <div class="hint">A small server with no public address, reachable only through the WireGuard firewall, to try rules against.</div></label>
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
          <li><span class="${(o.pushSubs ?? []).length ? "ok" : "no"}">${(o.pushSubs ?? []).length ? "✓" : "–"}</span><div>Phone alerts${(o.pushSubs ?? []).length ? ` (${(o.pushSubs ?? []).length} phone${(o.pushSubs ?? []).length === 1 ? "" : "s"})` : html` <span class="small muted">(turn on in Phone alerts)</span>`}${o.webhook ? " and a webhook" : ""}</div></li>
        </ul>
        ${o.repo ? html`<p class="small muted" style="margin-top:10px">Runner: <a href="https://github.com/${o.repo}/actions" target="_blank" rel="noopener">github.com/${o.repo}</a></p>` : ""}
      </div>

      ${alertsPanel(o)}

      ${installPanel(o)}
      ${profilesPanel(o)}
      ${schedulesPanel(o)}
      ${backupsPanel(o)}

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
