// views/dashboard.ts
//
// Plain English: the one-glance screen. A faceplate with the state word and
// the tunnel diagram, a ruled list of facts, then the two controls: Deploy
// (with "for how long?") and Tear down (with a typed confirmation). While a
// run is in progress it shows the GitHub step timeline and the live log.
// The whole thing re-polls itself: every 5 seconds while busy, every 20
// seconds otherwise.

import { html, raw } from "hono/html";
import type { Html } from "./layout";
import { fmtTime, ago, gbp } from "./layout";
import type { Snapshot } from "../state";
import { STATE_LABEL, isBusy, peerOnline } from "../state";
import type { Config } from "../env";

export interface LiveOpts {
  snap: Snapshot;
  cfg: Config;
  peerCount: number;
  canDispatch: boolean;
  notice?: { kind: "good" | "warn" | "bad" | "info"; text: string } | null;
  lockHolder?: string | null;
  /** The successful apply that built what is running now, for the inventory panel. */
  deployment?: { id: string; requested_by: string | null; finished_at: string | null; github_run_url: string | null; agent_token_hash: string | null; callback_token_hash: string | null; payload_json: string | null } | null;
  serverPub?: string | null;
}

/** "What exists in Azure" plus the per-deploy secrets, shown while anything exists. */
function inventory(o: LiveOpts): Html {
  const s = o.snap;
  const az = s.azure;
  if (s.state === "destroyed" && (!az || !az.exists)) return html``;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(o.deployment?.payload_json ?? "{}"); } catch { /* ignore */ }
  const rows = az?.resources ?? [];
  return html`<details class="panel inventory" data-panel="inventory" style="margin-top:16px" ${s.state === "running" ? raw("open") : ""}>
  <summary><h2 style="display:inline">In Azure right now</h2> <span class="muted small">${az ? html`${rows.length} resource${rows.length === 1 ? "" : "s"} in ${az.resource_group}, checked ${ago(az.checked_at)}` : "not checked yet"}${az?.error ? html` · <span style="color:var(--down)">${az.error}</span>` : ""}</span></summary>
  ${rows.length
    ? html`<table class="rows inv"><tbody>${rows.map((r) => html`<tr><th>${r.kind}</th><td><b>${r.name}</b></td><td class="muted">${r.detail}</td></tr>`)}</tbody></table>`
    : az && !az.exists
      ? html`<p class="muted">Azure reports nothing in ${az.resource_group}.</p>`
      : html`<p class="muted">Waiting for the first Azure check (every 5 minutes, or press Check Azure now).</p>`}
  ${o.deployment
    ? html`<h3 style="margin-top:14px">This deployment</h3>
      <table class="rows inv"><tbody>
        <tr><th>Run</th><td><b>${o.deployment.id}</b></td><td class="muted">by ${o.deployment.requested_by ?? "?"}, finished ${fmtTime(o.deployment.finished_at)}${o.deployment.github_run_url ? html`, <a href="${o.deployment.github_run_url}" target="_blank" rel="noopener">GitHub log</a>` : ""}</td></tr>
        <tr><th>Loopback</th><td><b>lo1</b></td><td class="muted"><span class="mono">${o.cfg.loopbackIp}/32</span>, a dummy interface outside the tunnel subnet. From a connected client: <span class="mono">ping ${o.cfg.loopbackIp}</span></td></tr>
        <tr><th>DNS record</th><td><b>${o.cfg.dnsName}</b></td><td class="muted">A ${s.public_ip ?? "?"}, TTL 60, DNS only, owned by Terraform</td></tr>
        <tr><th>Server key</th><td><b>WireGuard</b></td><td class="muted mono">${o.serverPub ?? "not set"}</td></tr>
        <tr><th>Agent token</th><td><b>per deploy</b></td><td class="muted">baked into the VM by cloud-init; only its hash is stored: <span class="mono">${(o.deployment.agent_token_hash ?? "").slice(0, 16)}…</span></td></tr>
        <tr><th>Callback token</th><td><b>per run</b></td><td class="muted">used once by GitHub Actions; hash <span class="mono">${(o.deployment.callback_token_hash ?? "").slice(0, 16)}…</span></td></tr>
        <tr><th>SSH</th><td><b>azureuser</b></td><td class="muted">${payload.ssh_allowed_cidr ? html`key only, allowed from <span class="mono">${String(payload.ssh_allowed_cidr)}</span>` : "no SSH rule (nobody can SSH in)"}</td></tr>
        <tr><th>Clients loaded</th><td><b>${(() => { try { return JSON.parse(String(payload.peers_json ?? "[]")).length; } catch { return "?"; } })()}</b></td><td class="muted">at boot; later changes reach the VM via the heartbeat</td></tr>
        <tr><th>State file</th><td><b>R2</b></td><td class="muted">wg-admin-tfstate / wg-admin/terraform.tfstate, backups kept for the last 20 runs</td></tr>
      </tbody></table>`
    : ""}
</details>`;
}

export function liveSection(o: LiveOpts): Html {
  const s = o.snap;
  const busy = isBusy(s.state);
  const every = busy ? "5s" : "20s";
  const online = s.agent ? s.agent.peers.filter((p) => peerOnline(p)).length : 0;
  const heartbeatStale = s.state === "running" && (!s.last_agent_at || Date.now() - Date.parse(s.last_agent_at) > 120_000);

  return html`<section id="live" hx-get="/partials/live" hx-trigger="every ${every}" hx-swap="outerHTML" hx-select="#live">
  ${o.notice ? html`<div class="notice ${o.notice.kind === "info" ? "" : o.notice.kind}"><p>${o.notice.text}</p></div>` : ""}

  <div class="faceplate">
    <div>
      <h1 class="state-word" data-state="${s.state}">${STATE_LABEL[s.state]}</h1>
      <div class="state-sub">${subline(s, o.cfg)}</div>
    </div>
    ${tunnel(s, o.cfg)}
  </div>

  <dl class="facts">
    <div class="fact"><dt>Public address</dt><dd>${s.public_ip ? html`<span class="mono">${s.public_ip}</span>` : html`<span class="faint">none</span>`}</dd></div>
    <div class="fact"><dt>${o.cfg.dnsName}</dt><dd>${dnsCell(s)}</dd></div>
    <div class="fact"><dt>Cost this session</dt><dd>${s.running_since ? html`<span data-cost-since="${s.running_since}" data-rate="${o.cfg.hourlyRateGbp}">${gbp(0)}</span> <span class="faint small">at ${gbp(o.cfg.hourlyRateGbp)}/h</span>` : html`<span class="faint">£0.00</span>`}</dd></div>
    <div class="fact"><dt>Up for</dt><dd>${s.running_since ? html`<span data-since="${s.running_since}"></span>` : html`<span class="faint">—</span>`}</dd></div>
    <div class="fact"><dt>Clients</dt><dd>${o.peerCount} configured${s.state === "running" ? html`, <b>${online} online</b>` : ""}</dd></div>
    <div class="fact"><dt>Loopback (ping test)</dt><dd>${s.state === "running" ? html`<span class="mono">${o.cfg.loopbackIp}</span> ${s.agent ? (s.agent.loopback === o.cfg.loopbackIp ? html`<span class="pill up">up</span>` : s.agent.loopback ? html`<span class="pill busy">${s.agent.loopback}</span>` : html`<span class="pill idle">not on this build</span>`) : ""}` : html`<span class="faint">—</span>`}</dd></div>
    <div class="fact"><dt>Heartbeat from VM</dt><dd>${s.state !== "running" ? html`<span class="faint">—</span>` : heartbeatStale ? html`<span class="pill down">missing</span> <span class="faint small">${ago(s.last_agent_at)}</span>` : html`<span class="pill up">live</span> <span class="faint small">${ago(s.last_agent_at)}${s.agent ? html`, load ${s.agent.load.split(" ")[0]}` : ""}</span>`}</dd></div>
  </dl>

  ${busy ? runProgress(s) : controls(o)}
  ${inventory(o)}
</section>`;
}

function subline(s: Snapshot, cfg: Config): Html {
  switch (s.state) {
    case "running":
      return html`Since ${fmtTime(s.running_since)}.${s.auto_destroy_at ? html` Tears itself down in <b class="clock" data-until="${s.auto_destroy_at}"></b> (${fmtTime(s.auto_destroy_at)}).` : html` No auto-destroy set.`}`;
    case "deploying":
      return html`Building in Azure ${cfg.region}. Usually about 4 minutes.${s.github_run_url ? html` <a href="${s.github_run_url}" target="_blank" rel="noopener">GitHub run</a>` : ""}`;
    case "destroying":
      return html`Removing everything from Azure. The bill returns to £0 when this finishes.${s.github_run_url ? html` <a href="${s.github_run_url}" target="_blank" rel="noopener">GitHub run</a>` : ""}`;
    case "failed":
      return html`<b>${s.error ?? "The last run failed."}</b> Use Clean up to make sure nothing was left in Azure.`;
    default:
      return html`Nothing exists in Azure. Cost is £0.00. Deploy takes about 4 minutes.`;
  }
}

function dnsCell(s: Snapshot): Html {
  if (s.state === "destroyed" || s.state === "deploying") return s.dns_ip ? html`<span class="mono">${s.dns_ip}</span> <span class="pill busy">stale</span>` : html`<span class="faint">no record</span>`;
  if (!s.dns_ip) return html`<span class="faint">no record</span>`;
  return html`<span class="mono">${s.dns_ip}</span> ${s.dns_live ? html`<span class="pill up">live</span>` : html`<span class="pill busy">mismatch</span>`}`;
}

/** The tunnel diagram: Home ── wg.clydeford.net ── Azure. Lit only when Running. */
function tunnel(s: Snapshot, cfg: Config): Html {
  return html`<svg class="tunnel" data-state="${s.state}" viewBox="0 0 520 150" role="img" aria-label="Tunnel: home to ${cfg.dnsName} to Azure ${cfg.region}, ${STATE_LABEL[s.state]}">
  <path class="carrier" d="M 92 70 C 170 70, 190 70, 260 70 S 350 70, 428 70" />
  <rect class="node home" x="12" y="42" width="80" height="56" rx="8"/>
  <text class="name" x="52" y="66" text-anchor="middle">Home</text>
  <text x="52" y="84" text-anchor="middle">${cfg.homeLanCidr || "clients"}</text>
  <g>
    <circle class="port" cx="260" cy="70" r="7"/>
    <text class="name" x="260" y="38" text-anchor="middle">${cfg.dnsName}</text>
    <text x="260" y="105" text-anchor="middle">UDP ${cfg.port}${s.public_ip ? ` · ${s.public_ip}` : ""}</text>
  </g>
  <rect class="node azure" x="428" y="42" width="80" height="56" rx="8"/>
  <text class="name" x="468" y="66" text-anchor="middle">Azure</text>
  <text x="468" y="84" text-anchor="middle">${cfg.region}</text>
  <text x="52" y="128" text-anchor="middle">tunnel ${cfg.subnet}</text>
  <text x="468" y="128" text-anchor="middle">${cfg.vmSize}</text>
</svg>`;
}

function runProgress(s: Snapshot): Html {
  return html`<div class="panel" style="margin-top:16px">
  <div class="section-head"><h2>${s.action === "destroy" ? "Tearing down" : "Deploying"}</h2>
    <form method="post" action="/actions/cancel" hx-post="/actions/cancel" hx-target="#live" hx-swap="outerHTML" hx-confirm="Cancel the run? You will need to Clean up afterwards."><button type="submit" class="danger">Cancel</button></form>
  </div>
  ${s.steps.length
    ? html`<ol class="timeline">${s.steps.map((st) => html`<li data-s="${st.status}" data-c="${st.conclusion ?? ""}"><span class="dot"></span>${st.name}</li>`)}</ol>`
    : html`<p class="muted">Waiting for GitHub to pick up the job…</p>`}
  ${s.log_tail ? html`<pre class="log">${s.log_tail}</pre>` : ""}
</div>`;
}

function controls(o: LiveOpts): Html {
  const s = o.snap;
  const disabled = !o.canDispatch;
  const hours = [1, 2, 4, 8];
  const untilMidnight = hoursUntilMidnightLondon();
  return html`<div class="controls" style="margin-top:16px">
  ${s.state === "running"
    ? html`<div class="panel">
        <h2>Tear down</h2>
        <p class="muted">Removes the VM, its address and the DNS record. Clients keep their configs and reconnect after the next deploy.</p>
        <form method="post" action="/actions/destroy" hx-post="/actions/destroy" hx-target="#live" hx-swap="outerHTML">
          <label class="field"><span>Type <kbd>destroy</kbd> to confirm</span><input type="text" name="confirm" autocomplete="off" data-confirm-word="destroy" placeholder="destroy"></label>
          <div class="btn-row"><button type="submit" class="danger primary big" disabled ${disabled ? "disabled" : ""}>Tear down now</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Auto-destroy</h2>
        <p class="muted">${s.auto_destroy_at ? html`Set for ${fmtTime(s.auto_destroy_at)}, in <b data-until="${s.auto_destroy_at}"></b>. The watchman tears down within 5 minutes of that.` : "Not set. The VM runs until you tear it down."}</p>
        <form method="post" action="/actions/extend" hx-post="/actions/extend" hx-target="#live" hx-swap="outerHTML">
          <div class="chips">
            ${hours.map((h) => html`<label><input type="radio" name="hours" value="${h}"><span>+${h}h</span></label>`)}
            <label><input type="radio" name="hours" value="${untilMidnight}"><span>until midnight</span></label>
            <label><input type="radio" name="hours" value="0"><span>no limit</span></label>
          </div>
          <div class="btn-row"><button type="submit">Set from now</button></div>
        </form>
      </div>`
    : html`<div class="panel">
        <h2>Deploy</h2>
        <p class="muted">Builds a ${o.cfg.vmSize} in Azure ${o.cfg.region}, points ${o.cfg.dnsName} at it, loads ${o.peerCount} client${o.peerCount === 1 ? "" : "s"}. About ${gbp(o.cfg.hourlyRateGbp)} an hour while up.</p>
        <form method="post" action="/actions/deploy" hx-post="/actions/deploy" hx-target="#live" hx-swap="outerHTML">
          <span class="small muted">For how long?</span>
          <div class="chips">
            ${hours.map((h) => html`<label><input type="radio" name="hours" value="${h}" ${h === o.cfg.autoDestroyDefaultHours ? raw("checked") : ""}><span>${h}h</span></label>`)}
            <label><input type="radio" name="hours" value="${untilMidnight}"><span>until midnight</span></label>
            <label><input type="radio" name="hours" value="0"><span>no limit</span></label>
          </div>
          <div class="btn-row">
            <button type="submit" class="primary big" ${disabled ? "disabled" : ""}>Deploy</button>
            ${disabled ? html`<span class="small muted">GitHub is not connected. <a href="/settings">Finish setup</a>.</span>` : ""}
            ${o.lockHolder ? html`<span class="small muted">Lock held by ${o.lockHolder}.</span>` : ""}
          </div>
        </form>
      </div>
      <div class="panel quiet">
        <h2>${s.state === "failed" ? "Clean up" : "Nothing running"}</h2>
        <p class="muted">${s.state === "failed" ? "Runs a tear-down to make sure nothing was left in Azure after the failure." : "Azure is empty and costs nothing. Clients that dial now get NXDOMAIN and fail fast."}</p>
        <div class="btn-row">
          ${s.state === "failed" ? html`<form method="post" action="/actions/cleanup" hx-post="/actions/cleanup" hx-target="#live" hx-swap="outerHTML"><button type="submit" ${disabled ? "disabled" : ""}>Clean up</button></form>` : ""}
          <form method="post" action="/actions/reconcile" hx-post="/actions/reconcile" hx-target="#live" hx-swap="outerHTML"><button type="submit">Check Azure now</button></form>
        </div>
      </div>`}
</div>`;
}

function hoursUntilMidnightLondon(now = new Date()): number {
  // Midnight London time, expressed as fractional hours from now (rounded up to the quarter hour).
  const london = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const next = new Date(london);
  next.setHours(24, 0, 0, 0);
  const h = (next.getTime() - london.getTime()) / 3_600_000;
  return Math.max(0.25, Math.ceil(h * 4) / 4);
}
