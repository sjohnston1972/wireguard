// views/dashboard.ts
//
// Plain English: the one-glance screen. A faceplate with the state word and
// the tunnel diagram, a ruled list of facts, then the two controls: Deploy
// (with "for how long?" and, when travelling, "where?"), Hibernate, Resume
// and Tear down (with a typed confirmation). While a run is in progress it
// shows the GitHub step timeline and the live log.
// The whole thing re-polls itself: every 5 seconds while busy, every 20
// seconds otherwise.

import { html, raw } from "hono/html";
import type { Html } from "./layout";
import { fmtTime, ago, gbp, bytes } from "./layout";
import { serverTunnelIp } from "../peers";
import type { Snapshot } from "../state";
import { STATE_LABEL, isBusy, isPowerOp, peerOnline, trafficFlowing, selfTestFailures } from "../state";
import { regionName } from "../region";
import type { Config } from "../env";
import type { Peer } from "../db";

export interface LiveOpts {
  snap: Snapshot;
  cfg: Config;
  peerCount: number;
  peers?: Peer[];
  canDispatch: boolean;
  notice?: { kind: "good" | "warn" | "bad" | "info"; text: string } | null;
  lockHolder?: string | null;
  /** The successful apply that built what is running now, for the inventory panel. */
  deployment?: { id: string; requested_by: string | null; finished_at: string | null; github_run_url: string | null; agent_token_hash: string | null; callback_token_hash: string | null; payload_json: string | null; ssh_password: string | null } | null;
  callerIp?: string | null;
  serverPub?: string | null;
  /** Where Cloudflare thinks the browser is, and the nearest Azure region. */
  near?: { country: string | null; region: string | null } | null;
}

/**
 * Running, but the VM's boot self-test has not reported yet: show "Verifying"
 * rather than a green "Running". Builds from before the self-test never
 * report one, so after 5 minutes it stops waiting.
 */
function verifying(s: Snapshot): boolean {
  if (s.state !== "running" || s.selftest) return false;
  const since = Date.parse(s.running_since ?? s.since ?? "");
  return Number.isFinite(since) && Date.now() - since < 5 * 60_000;
}

/**
 * The VM's public IPv6 address, from Azure's inventory. The address the VM
 * itself reports (agent.wan6) is its private fd50:50:0:1::/64 one: Azure
 * translates IPv6 at the edge just as it does IPv4. Shown only when the VM
 * also reports IPv6 working inside, so a half-built stack is not advertised.
 */
function publicIp6(s: Snapshot): string | null {
  if (!s.agent?.wan6) return null;
  const a = s.azure?.resources.find((r) => r.kind === "Public IPv6")?.detail.split(",")[0]?.trim();
  return a && a.includes(":") ? a : null;
}

/** A tiny line chart of recent round-trip times. */
function sparkline(samples: number[] | undefined): Html {
  const v = (samples ?? []).slice(-24);
  if (v.length < 2) return html``;
  const w = 64, h = 16, max = Math.max(...v, 1), min = Math.min(...v);
  const span = Math.max(1, max - min);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

/** Latest round-trip time and its recent shape, for a client. */
export function latencyCell(samples: number[] | undefined): Html {
  const last = samples?.[samples.length - 1];
  if (last === undefined) return html`<span class="faint">—</span>`;
  return html`<span class="lat">${sparkline(samples)} <span class="mono">${last < 10 ? last.toFixed(1) : Math.round(last)} ms</span></span>`;
}

function selfTestCell(s: Snapshot): Html {
  if (s.state !== "running") return html`<span class="faint">—</span>`;
  const t = s.selftest;
  if (!t) return verifying(s) ? html`<span class="pill busy">running</span> <span class="faint small">a test client is dialling in</span>` : html`<span class="pill idle">not on this build</span>`;
  const failed = selfTestFailures(t);
  if (failed.length) return html`<span class="pill down">failed</span> <span class="small">${failed.join(", ")}</span>`;
  const parts = ["handshake", "tunnel", t.loopback ? "loopback" : "", t.dns ? "DNS" : "", t.internet ? "internet" : "", t.internet6 ? "IPv6" : ""].filter(Boolean);
  return html`<span class="pill up">passed</span> <span class="faint small">${parts.join(" · ")} in ${(t.ms / 1000).toFixed(1)} s</span>`;
}

/** SSH access to the VM: user, host, per-deploy password behind a click, and the allow-list. */
function secrets(o: LiveOpts): Html {
  const s = o.snap;
  if (s.state !== "running" || !o.deployment) return html``;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(o.deployment.payload_json ?? "{}"); } catch { /* ignore */ }
  const allowed = s.azure?.resources.find((r) => r.kind === "Network security group")?.detail.match(/allow tcp 22 from ([^;]+)/)?.[1] ?? (payload.ssh_allowed_cidr ? String(payload.ssh_allowed_cidr) : null);
  const host = s.public_ip ?? o.cfg.dnsName;
  const tunnelIp = serverTunnelIp(o.cfg.subnet);
  const loopbackUp = !!s.agent && s.agent.loopback === o.cfg.loopbackIp;
  return html`<dialog id="dlg-ssh" class="modal" aria-labelledby="dlg-ssh-title">
  <div class="modal-box">
  <div class="modal-head"><div><h2 id="dlg-ssh-title">SSH to the VM</h2><p class="muted small">username, password and allow-list for this deployment</p></div><button type="button" data-close aria-label="Close">Close</button></div>
  <table class="rows inv"><tbody>
    <tr><th>Public host</th><td><b class="mono">${host}</b></td><td class="muted">${o.cfg.dnsName}, port 22; only from the allowed address below</td></tr>
    <tr><th>Over the tunnel</th><td><b class="mono">${o.cfg.loopbackIp}</b>${loopbackUp ? html` <span class="pill up">up</span>` : html` <span class="pill idle">not on this build</span>`}<div class="mono small muted">${tunnelIp}</div></td><td class="muted">from any connected client, from anywhere. No firewall rule needed: SSH rides inside the WireGuard packets, which the NSG already admits, so port 22 is never exposed. ${loopbackUp ? "Use the loopback." : `Use ${tunnelIp} until the next deploy adds the loopback.`}</td></tr>
    <tr><th>Username</th><td><b class="mono">azureuser</b></td><td class="muted">sudo without a password</td></tr>
    <tr><th>Password</th><td>${o.deployment.ssh_password
      ? html`<span class="mono secret-value" data-secret="${o.deployment.ssh_password}" hidden>${o.deployment.ssh_password}</span><span class="mono secret-mask">••••••••••••••••</span></td><td class="muted"><button type="button" data-reveal style="padding:3px 8px;font-size:.8rem">Show</button> <button type="button" data-copy-secret style="padding:3px 8px;font-size:.8rem">Copy</button> <span class="small">made for this deploy only; dies with the VM</span>`
      : html`<span class="faint">none on this build</span></td><td class="muted">this VM was built before passwords were added; use the key, or redeploy`}</td></tr>
    <tr><th>Key</th><td><b class="mono">wg-admin-azure_ed25519</b></td><td class="muted">on the laptop in <span class="mono">~/.ssh</span>; always works regardless of the password</td></tr>
    <tr><th>Allowed from</th><td><b class="mono">${allowed ?? "nobody"}</b></td><td class="muted">${allowed ? "the only address the firewall lets reach port 22" : "no SSH rule on this deploy"}
      <form method="post" action="/actions/allow-ssh" hx-post="/actions/allow-ssh" hx-target="#live" hx-swap="outerHTML" style="display:inline;margin-left:8px"><button type="submit" style="padding:3px 8px;font-size:.8rem">Allow SSH from this address</button></form></td></tr>
    <tr><th>Commands</th><td colspan="2"><div><code>ssh azureuser@${loopbackUp ? o.cfg.loopbackIp : tunnelIp}</code> <span class="muted small">over the tunnel, password or key</span></div><div style="margin-top:4px"><code>ssh azureuser@${host}</code> <span class="muted small">over the internet, from the allowed address</span></div><div style="margin-top:4px"><code>ssh -i ~/.ssh/wg-admin-azure_ed25519 azureuser@${o.cfg.dnsName}</code> <span class="muted small">with the key</span></div></td></tr>
  </tbody></table>
  </div>
</dialog>`;
}

/** "What exists in Azure" plus the per-deploy secrets, shown while anything exists. */
function inventory(o: LiveOpts): Html {
  const s = o.snap;
  const az = s.azure;
  if (s.state === "destroyed" && (!az || !az.exists)) return html``;
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(o.deployment?.payload_json ?? "{}"); } catch { /* ignore */ }
  const rows = az?.resources ?? [];
  return html`<dialog id="dlg-azure" class="modal" aria-labelledby="dlg-azure-title">
  <div class="modal-box">
  <div class="modal-head"><div><h2 id="dlg-azure-title">In Azure right now</h2><p class="muted small">${az ? html`${rows.length} resource${rows.length === 1 ? "" : "s"} in ${az.resource_group}, checked ${ago(az.checked_at)}` : "not checked yet"}${az?.error ? html` · <span style="color:var(--down)">${az.error}</span>` : ""}</p></div><button type="button" data-close aria-label="Close">Close</button></div>
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
  </div>
</dialog>`;
}

/** The buttons that open the two modals. */
function modalButtons(o: LiveOpts): Html {
  const s = o.snap;
  const az = s.azure;
  const showAzure = !(s.state === "destroyed" && (!az || !az.exists));
  const showSsh = s.state === "running" && !!o.deployment;
  if (!showAzure && !showSsh) return html``;
  return html`<div class="btn-row modal-row" style="margin-top:16px">
    ${showSsh ? html`<button type="button" data-open="dlg-ssh">SSH to the VM</button>` : ""}
    ${showAzure ? html`<button type="button" data-open="dlg-azure">In Azure right now${az ? html` <span class="count">${az.resources.length}</span>` : ""}</button>` : ""}
  </div>`;
}

export function liveSection(o: LiveOpts): Html {
  const s = o.snap;
  const busy = isBusy(s.state);
  const every = busy ? "5s" : "20s";
  const online = s.agent ? s.agent.peers.filter((p) => peerOnline(p)).length : 0;
  const heartbeatStale = s.state === "running" && (!s.last_agent_at || Date.now() - Date.parse(s.last_agent_at) > 120_000);
  const checking = verifying(s);
  const word = checking ? "Verifying" : STATE_LABEL[s.state];
  const wordState = checking ? "verifying" : s.state;
  const dns = s.agent?.dns;

  return html`<section id="live" hx-get="/partials/live" hx-trigger="every ${every}" hx-swap="outerHTML" hx-select="#live">
  ${o.notice ? html`<div class="notice ${o.notice.kind === "info" ? "" : o.notice.kind}"><p>${o.notice.text}</p></div>` : ""}

  <div class="faceplate">
    <div>
      <h1 class="state-word" data-state="${wordState}">${word}</h1>
      <div class="state-sub">${subline(s, o.cfg)}</div>
    </div>
    <div class="tipwrap">${tunnel(s, o.cfg)}${homeTip(o)}${azureTip(o)}</div>
  </div>

  <dl class="facts">
    <div class="fact"><dt>Public address</dt><dd>${s.public_ip ? html`<span class="mono">${s.public_ip}</span>${s.state === "running" && publicIp6(s) ? html`<div class="mono small">${publicIp6(s)}</div>` : ""}` : html`<span class="faint">none</span>`}</dd></div>
    <div class="fact"><dt>${o.cfg.dnsName}</dt><dd>${dnsCell(s)}</dd></div>
    ${s.state === "standby" && s.standby_since
      ? html`<div class="fact"><dt>Standby cost so far</dt><dd><span data-cost-since="${s.standby_since}" data-rate="${o.cfg.standbyRateGbp}">${gbp(0)}</span> <span class="faint small">at ${gbp(o.cfg.standbyRateGbp)}/h, disk and address only</span></dd></div>
        <div class="fact"><dt>In standby for</dt><dd><span data-since="${s.standby_since}"></span> <span class="faint small">torn down after ${o.cfg.standbyMaxDays} days</span></dd></div>`
      : html`<div class="fact"><dt>Cost this session</dt><dd>${s.running_since ? html`<span data-cost-since="${s.running_since}" data-rate="${o.cfg.hourlyRateGbp}">${gbp(0)}</span> <span class="faint small">at ${gbp(o.cfg.hourlyRateGbp)}/h</span>` : html`<span class="faint">£0.00</span>`}</dd></div>
        <div class="fact"><dt>Up for</dt><dd>${s.running_since ? html`<span data-since="${s.running_since}"></span>` : html`<span class="faint">—</span>`}</dd></div>`}
    <div class="fact"><dt>Clients</dt><dd>${o.peerCount} configured${s.state === "running" ? html`, <b>${online} online</b>` : ""}</dd></div>
    <div class="fact"><dt>Loopback (ping test)</dt><dd>${s.state === "running" ? html`<span class="mono">${o.cfg.loopbackIp}</span> ${s.agent ? (s.agent.loopback === o.cfg.loopbackIp ? html`<span class="pill up">up</span>` : s.agent.loopback ? html`<span class="pill busy">${s.agent.loopback}</span>` : html`<span class="pill idle">not on this build</span>`) : ""}` : html`<span class="faint">—</span>`}</dd></div>
    <div class="fact"><dt>Self-test</dt><dd>${selfTestCell(s)}</dd></div>
    <div class="fact"><dt>Tunnel DNS</dt><dd>${s.state !== "running" || !s.agent ? html`<span class="faint">—</span>` : dns ? html`${dns.up ? html`<span class="pill up">up</span>` : html`<span class="pill down">down</span>`} <span class="mono small">${o.cfg.loopbackIp}</span> <span class="faint small">${dns.blocked ? `blocks ${dns.blocked.toLocaleString("en-GB")} ad names; ` : ""}names like vm.wg</span>` : html`<span class="pill idle">not on this build</span>`}</dd></div>
    <div class="fact"><dt>Heartbeat from VM</dt><dd>${s.state !== "running" ? html`<span class="faint">—</span>` : heartbeatStale ? html`<span class="pill down">missing</span> <span class="faint small">${ago(s.last_agent_at)}</span>` : html`<span class="pill up">live</span> <span class="faint small">${ago(s.last_agent_at)}${s.agent ? html`, load ${s.agent.load.split(" ")[0]}` : ""}</span>`}</dd></div>
  </dl>

  ${isPowerOp(s.state) ? powerProgress(s) : busy ? runProgress(s) : controls(o)}
  ${modalButtons(o)}
  ${secrets(o)}
  ${inventory(o)}
</section>`;
}

function subline(s: Snapshot, cfg: Config): Html {
  switch (s.state) {
    case "running":
      return html`Since ${fmtTime(s.running_since)}.${s.auto_destroy_at ? html` Tears itself down in <b class="clock" data-until="${s.auto_destroy_at}"></b> (${fmtTime(s.auto_destroy_at)}).` : html` No auto-destroy set.`}`;
    case "deploying":
      return html`Building in Azure ${regionName(s.region ?? cfg.region)}. Usually about 4 minutes.${s.github_run_url ? html` <a href="${s.github_run_url}" target="_blank" rel="noopener">GitHub run</a>` : ""}`;
    case "destroying":
      return html`Removing everything from Azure. The bill returns to £0 when this finishes.${s.github_run_url ? html` <a href="${s.github_run_url}" target="_blank" rel="noopener">GitHub run</a>` : ""}`;
    case "failed":
      return html`<b>${s.error ?? "The last run failed."}</b> Use Clean up to make sure nothing was left in Azure.`;
    case "hibernating":
      return html`Powering the VM down. Its disk, address and DNS stay, so it can resume in about a minute.`;
    case "standby":
      return html`Warm standby: the VM is powered off (deallocated) with its disk and address kept, costing about ${gbp(cfg.standbyRateGbp)} an hour. Resume takes about a minute; clients reconnect on their own.${s.error ? html` <b>${s.error}</b>` : ""}`;
    case "resuming":
      return html`Powering the VM back on in Azure ${regionName(s.region ?? cfg.region)}. It re-runs its self-test and reports in, usually within a minute.`;
    default:
      return html`Nothing exists in Azure. Cost is £0.00. Deploy takes about 4 minutes.`;
  }
}

function dnsCell(s: Snapshot): Html {
  if (s.dns_ip === "192.0.2.1") return html`<span class="pill idle">parked</span> <span class="faint small">until the next deploy</span>`;
  if (s.state === "destroyed" || s.state === "deploying") return s.dns_ip ? html`<span class="mono">${s.dns_ip}</span> <span class="pill busy">stale</span>` : html`<span class="faint">no record</span>`;
  if (!s.dns_ip) return html`<span class="faint">no record</span>`;
  return html`<span class="mono">${s.dns_ip}</span> ${s.dns_live ? html`<span class="pill up">live</span>` : html`<span class="pill busy">mismatch</span>`}`;
}

/** The tunnel diagram: Home ── wg.clydeford.net ── Azure. Lit only when Running. */
function tunnel(s: Snapshot, cfg: Config): Html {
  const running = s.state === "running";
  const heartbeatFresh = running && !!s.last_agent_at && Date.now() - Date.parse(s.last_agent_at) < 120_000;
  const t = s.traffic;
  const flowing = running && trafficFlowing(t);
  const online = t?.peers_online ?? 0;
  // Home tile: lit when a client has a live handshake, "flow" when bytes moved in the last interval.
  const homeClass = flowing ? "flow" : running && online > 0 ? "lit" : "";
  // Azure tile: lit when the VM is heartbeating, "flow" when bytes moved.
  const azureClass = flowing ? "flow" : heartbeatFresh ? "lit" : "";
  const rate = (t?.rx_rate ?? 0) + (t?.tx_rate ?? 0);
  return html`<svg class="tunnel" data-state="${s.state}" data-flow="${flowing ? "1" : "0"}" viewBox="0 0 520 150" role="img" aria-label="Tunnel: home to ${cfg.dnsName} to Azure ${cfg.region}, ${STATE_LABEL[s.state]}${flowing ? ", traffic passing" : ""}">
  <path class="carrier" d="M 92 70 C 170 70, 190 70, 260 70 S 350 70, 428 70" />
  <g class="hot" data-tip="tip-home" tabindex="0" role="button" aria-label="Client details">
  <rect class="node home ${homeClass}" x="12" y="42" width="80" height="56" rx="8"/>
  <text class="name" x="52" y="66" text-anchor="middle">Home</text>
  <text x="52" y="84" text-anchor="middle">${running ? `${online} client${online === 1 ? "" : "s"} up` : cfg.homeLanCidr || "clients"}</text>
  </g>
  <g>
    <circle class="port" cx="260" cy="70" r="7"/>
    <text class="name" x="260" y="38" text-anchor="middle">${cfg.dnsName}</text>
    <text x="260" y="102" text-anchor="middle">UDP ${cfg.port}${s.public_ip ? ` · ${s.public_ip}` : ""}</text>
    ${running && t
      ? html`<text class="traffic ${flowing ? "flow" : ""}" x="260" y="120" text-anchor="middle">in ${bytes(t.rx)}, out ${bytes(t.tx)}${flowing ? ` at ${bytes(Math.round(rate))}/s` : ""}</text>`
      : ""}
  </g>
  <g class="hot" data-tip="tip-azure" tabindex="0" role="button" aria-label="VM details">
  <rect class="node azure ${azureClass}" x="428" y="42" width="80" height="56" rx="8"/>
  <text class="name" x="468" y="66" text-anchor="middle">Azure</text>
  <text x="468" y="84" text-anchor="middle">${s.state === "standby" ? "standby" : s.region ?? cfg.region}</text>
  </g>
  <text x="52" y="128" text-anchor="middle">tunnel ${cfg.subnet}</text>
  <text x="468" y="128" text-anchor="middle">${cfg.vmSize}</text>
</svg>`;
}

/** Hover panel for the Home tile: every client, what the VM knows about it. */
function homeTip(o: LiveOpts): Html {
  const s = o.snap;
  const peers = o.peers ?? [];
  const live = new Map((s.agent?.peers ?? []).map((p) => [p.public_key, p]));
  const total = (s.traffic?.rx ?? 0) + (s.traffic?.tx ?? 0);
  const now = Date.now();
  return html`<div class="tip" id="tip-home" hidden>
  <div class="tip-head"><b>Clients</b><span class="muted small">${peers.length} configured${s.state === "running" ? html`, ${s.traffic?.peers_online ?? 0} online` : ", headend down"}</span></div>
  ${peers.length
    ? html`<table class="tiptable"><thead><tr><th>Client</th><th>Tunnel IP</th><th>Status</th><th>Handshake</th><th>Latency</th><th>From</th><th class="num">In</th><th class="num">Out</th><th class="num">Share</th></tr></thead><tbody>
      ${peers.map((p) => {
        const l = live.get(p.public_key);
        const on = !!l && peerOnline(l, now);
        const share = l && total > 0 ? Math.round(((l.rx + l.tx) / total) * 100) : 0;
        return html`<tr>
          <td><b>${p.name}</b>${p.full_tunnel ? html` <span class="pill idle">full</span>` : ""}${p.azure_vnet ? html` <span class="pill idle">+az</span>` : ""}</td>
          <td class="mono">${p.ip}</td>
          <td>${!p.enabled ? html`<span class="pill idle">disabled</span>` : s.state !== "running" ? html`<span class="faint">—</span>` : !l ? html`<span class="pill busy">loading</span>` : on ? html`<span class="pill up">online</span>` : html`<span class="pill idle">offline</span>`}</td>
          <td>${l && l.latest_handshake ? ago(new Date(l.latest_handshake * 1000).toISOString(), now) : html`<span class="faint">never</span>`}</td>
          <td>${latencyCell(s.latency?.[p.public_key])}</td>
          <td class="mono small">${l?.endpoint ?? html`<span class="faint">—</span>`}${s.roams?.[p.public_key] ? html`<div class="faint small">changed networks ${ago(s.roams[p.public_key].at, now)}</div>` : ""}</td>
          <td class="num">${l ? bytes(l.rx) : html`<span class="faint">—</span>`}</td>
          <td class="num">${l ? bytes(l.tx) : html`<span class="faint">—</span>`}</td>
          <td class="num">${l ? html`<span class="share"><i style="width:${share}%"></i></span> ${share}%` : html`<span class="faint">—</span>`}</td>
        </tr>`;
      })}
    </tbody></table>`
    : html`<p class="muted small">No clients yet. Add one on the Clients tab.</p>`}
  ${s.traffic ? html`<div class="muted small tip-foot">Totals in ${bytes(s.traffic.rx)}, out ${bytes(s.traffic.tx)}${trafficFlowing(s.traffic, now) ? html`, moving at ${bytes(Math.round(s.traffic.rx_rate + s.traffic.tx_rate))}/s` : ", idle"}. "From" is the address the client last dialled in from. Latency is the VM pinging the client through the tunnel every 30 seconds. In/out are as the VM sees them.</div>` : ""}
</div>`;
}

/** Hover panel for the Azure tile: the VM as it reports itself. */
function azureTip(o: LiveOpts): Html {
  const s = o.snap;
  const a = s.agent;
  const up = a ? a.uptime_seconds : 0;
  const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60);
  const load = a?.load ? a.load.split(" ") : [];
  const nic = s.azure?.resources.find((r) => r.kind === "Network interface")?.detail.match(/private ([\d.]+)/)?.[1];
  return html`<div class="tip" id="tip-azure" hidden>
  <div class="tip-head"><b>Headend VM</b><span class="muted small">${s.state === "running" ? html`${o.cfg.vmSize} in ${regionName(s.region ?? o.cfg.region)}` : STATE_LABEL[s.state]}</span></div>
  ${s.state === "running"
    ? html`<table class="tiptable kv"><tbody>
      <tr><th>Heartbeat</th><td>${s.last_agent_at ? html`${ago(s.last_agent_at)}${a ? html` from <span class="mono">${a.hostname}</span>` : ""}` : html`<span class="pill down">none yet</span>`}</td></tr>
      <tr><th>Uptime</th><td>${a ? `${h}h ${m}m` : html`<span class="faint">—</span>`}</td></tr>
      <tr><th>Load</th><td>${load.length ? html`<span class="mono">${load[0]}</span> <span class="faint small">1 min</span> · <span class="mono">${load[1]}</span> <span class="faint small">5 min</span> · <span class="mono">${load[2]}</span> <span class="faint small">15 min</span> <span class="faint small">(1 vCPU: 1.0 = busy)</span>` : html`<span class="faint">—</span>`}</td></tr>
      <tr><th>Public</th><td class="mono">${s.public_ip ?? "?"} <span class="faint small">${s.dns_live ? "DNS live" : "DNS not live"}</span></td></tr>
      <tr><th>VNet</th><td class="mono">${nic ?? "?"} <span class="faint small">in ${o.cfg.vnetCidr}</span></td></tr>
      <tr><th>Tunnel</th><td class="mono">${serverTunnelIp(o.cfg.subnet)} <span class="faint small">listening on UDP ${a?.listen_port ?? o.cfg.port}</span></td></tr>
      <tr><th>Loopback</th><td class="mono">${o.cfg.loopbackIp} ${a?.loopback === o.cfg.loopbackIp ? html`<span class="pill up">up</span>` : html`<span class="pill idle">not on this build</span>`}</td></tr>
      <tr><th>Peers loaded</th><td>${a ? a.peers.length : html`<span class="faint">—</span>`}</td></tr>
      ${s.auto_destroy_at ? html`<tr><th>Tears down</th><td>in <b data-until="${s.auto_destroy_at}"></b> <span class="faint small">${fmtTime(s.auto_destroy_at)}</span></td></tr>` : ""}
      </tbody></table>`
    : html`<p class="muted small">Nothing is running. Deploy to build the VM.</p>`}
</div>`;
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

/** Hibernate and resume have no GitHub run: Azure does it, and we poll the power state. */
function powerProgress(s: Snapshot): Html {
  const down = s.state === "hibernating";
  return html`<div class="panel" style="margin-top:16px">
  <div class="section-head"><h2>${down ? "Hibernating" : "Resuming"}</h2><span class="muted small">asked ${ago(s.power_op_at)}</span></div>
  <ol class="timeline">
    <li data-s="completed" data-c="success"><span class="dot"></span>Asked Azure to ${down ? "deallocate the VM" : "start the VM"}</li>
    <li data-s="in_progress" data-c=""><span class="dot"></span>${down ? "Waiting for the power state to read \"deallocated\" (usually 1 to 2 minutes)" : "Waiting for the VM's first heartbeat and self-test (usually about a minute)"}</li>
    <li data-s="queued" data-c=""><span class="dot"></span>${down ? "Standby: disk and address kept, VM not billed" : "Running"}</li>
  </ol>
</div>`;
}

/** "For how long?" chips, shared by Deploy, Resume and Extend. */
function hourChips(o: LiveOpts, prefix = "", checkedDefault = true): Html {
  const hours = [1, 2, 4, 8];
  const untilMidnight = hoursUntilMidnightLondon();
  return html`<div class="chips">
    ${hours.map((h) => html`<label><input type="radio" name="hours" value="${h}" ${checkedDefault && h === o.cfg.autoDestroyDefaultHours ? raw("checked") : ""}><span>${prefix}${h}h</span></label>`)}
    <label><input type="radio" name="hours" value="${untilMidnight}"><span>until midnight</span></label>
    <label><input type="radio" name="hours" value="0"><span>no limit</span></label>
  </div>`;
}

/** Where to build: the usual region, plus the nearest one when the browser is somewhere else. */
function regionChips(o: LiveOpts): Html {
  const home = o.cfg.region;
  const near = o.near?.region;
  if (!near || near === home) return html`<p class="small muted" style="margin:6px 0 0">Region ${regionName(home)}.</p>`;
  return html`<span class="small muted">Where?</span>
    <div class="chips">
      <label><input type="radio" name="region" value="${home}" checked><span>${regionName(home)}</span></label>
      <label><input type="radio" name="region" value="${near}"><span>${regionName(near)}, nearest to you${o.near?.country ? ` (${o.near.country})` : ""}</span></label>
    </div>`;
}

function controls(o: LiveOpts): Html {
  const s = o.snap;
  const disabled = !o.canDispatch;
  const expiry = o.cfg.expiryAction === "hibernate" ? "hibernates" : "tears down";
  if (s.state === "standby") {
    return html`<div class="controls" style="margin-top:16px">
      <div class="panel">
        <h2>Resume</h2>
        <p class="muted">Powers the VM back on. Same address, same DNS, same clients; they reconnect by themselves. About a minute, at ${gbp(o.cfg.hourlyRateGbp)} an hour while up.</p>
        <form method="post" action="/actions/resume" hx-post="/actions/resume" hx-target="#live" hx-swap="outerHTML">
          <span class="small muted">For how long?</span>
          ${hourChips(o)}
          <div class="btn-row"><button type="submit" class="primary big">Resume</button></div>
        </form>
      </div>
      <div class="panel quiet">
        <h2>Tear down</h2>
        <p class="muted">Removes the VM, its disk and address, back to £0. The next start is a full deploy (about 4 minutes).</p>
        <form method="post" action="/actions/destroy" hx-post="/actions/destroy" hx-target="#live" hx-swap="outerHTML">
          <label class="field"><span>Type <kbd>destroy</kbd> to confirm</span><input type="text" name="confirm" autocomplete="off" data-confirm-word="destroy" placeholder="destroy"></label>
          <div class="btn-row"><button type="submit" class="danger" disabled ${disabled ? "disabled" : ""}>Tear down now</button></div>
        </form>
      </div>
    </div>`;
  }
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
        <h2>Hibernate</h2>
        <p class="muted">Warm standby: powers the VM off but keeps its disk and address, about ${gbp(o.cfg.standbyRateGbp * 24 * 30)} a month instead of ${gbp(o.cfg.hourlyRateGbp * 24 * 30)}. Resume takes about a minute instead of a 4-minute deploy.</p>
        <form method="post" action="/actions/hibernate" hx-post="/actions/hibernate" hx-target="#live" hx-swap="outerHTML">
          <div class="btn-row"><button type="submit">Hibernate</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>Auto-destroy</h2>
        <p class="muted">${s.auto_destroy_at ? html`Set for ${fmtTime(s.auto_destroy_at)}, in <b data-until="${s.auto_destroy_at}"></b>. The watchman ${expiry} within 5 minutes of that, and your phone gets a heads-up 15 minutes before.` : "Not set. The VM runs until you tear it down."}</p>
        <form method="post" action="/actions/extend" hx-post="/actions/extend" hx-target="#live" hx-swap="outerHTML">
          ${hourChips(o, "+", false)}
          <div class="btn-row"><button type="submit">Set from now</button></div>
        </form>
      </div>`
    : html`<div class="panel">
        <h2>Deploy</h2>
        <p class="muted">Builds a ${o.cfg.vmSize} in Azure, points ${o.cfg.dnsName} at it, loads ${o.peerCount} client${o.peerCount === 1 ? "" : "s"}. About ${gbp(o.cfg.hourlyRateGbp)} an hour while up.</p>
        <form method="post" action="/actions/deploy" hx-post="/actions/deploy" hx-target="#live" hx-swap="outerHTML">
          <span class="small muted">For how long?</span>
          ${hourChips(o)}
          ${regionChips(o)}
          <div class="btn-row">
            <button type="submit" class="primary big" ${disabled ? "disabled" : ""}>Deploy</button>
            ${disabled ? html`<span class="small muted">GitHub is not connected. <a href="/settings">Finish setup</a>.</span>` : ""}
            ${o.lockHolder ? html`<span class="small muted">Lock held by ${o.lockHolder}.</span>` : ""}
          </div>
        </form>
      </div>
      <div class="panel quiet">
        <h2>${s.state === "failed" ? "Clean up" : "Nothing running"}</h2>
        <p class="muted">${s.state === "failed" ? "Runs a tear-down to make sure nothing was left in Azure after the failure." : "Azure is empty and costs nothing. The name is parked, so clients that dial now simply get no answer."}</p>
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
