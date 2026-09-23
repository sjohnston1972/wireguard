// views/peers.ts
//
// Plain English: the clients screen. A ruled table of every phone and
// laptop with its tunnel address, last handshake and traffic, plus the
// add-a-client form. Keys are made in the browser (see app.js); this screen
// only ever sees public keys.

import { html } from "hono/html";
import type { Html } from "./layout";
import { ago, bytes, fmtTime, sheetHead } from "./layout";
import type { Peer } from "../db";
import type { AgentReport, AgentPeer } from "../state";
import { peerOnline } from "../state";
import type { Config } from "../env";
import { serverTunnelIp as serverTunnelIpOf, peerIp6 } from "../peers";
import { latencyCell } from "./dashboard";

/**
 * What the VM says about this client, not just what the database says.
 * "disabled" only becomes "off the VM" once a heartbeat no longer lists the
 * key; "enabled" shows "loading onto VM" until a heartbeat does list it.
 */
function statusCell(p: Peer, live: AgentPeer | undefined, running: boolean, online: boolean): Html {
  if (!p.enabled) {
    if (running && live) return html`<span class="pill busy">removing from VM…</span>`;
    return html`<span class="pill idle">disabled</span>${running ? html` <span class="faint small">off the VM</span>` : ""}`;
  }
  if (!running) return html`<span class="faint">headend down</span>`;
  if (!live) return html`<span class="pill busy">loading onto VM…</span>`;
  return online ? html`<span class="pill up">online</span>` : html`<span class="pill idle">offline</span> <span class="faint small">on the VM, no recent handshake</span>`;
}

/** The buttons for one client, shared by the desktop row and the phone sheet. */
function peerActions(p: Peer): Html {
  if (p.routes) {
    // The home site's keys live on the PC and are managed by "npm run home";
    // a new config from here would only break it.
    return html`<form method="post" action="/peers/${p.id}/toggle" hx-post="/peers/${p.id}/toggle" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit">${p.enabled ? "Disable" : "Enable"}</button></form>`;
  }
  return html`<button type="button" data-rekey="${p.id}" data-name="${p.name}" title="Make new keys for this client and download its config">Get config</button>
            ${p.full_tunnel ? "" : html`<form method="post" action="/peers/${p.id}/homelan" hx-post="/peers/${p.id}/homelan" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit" title="Whether configs for this client send the home network through the tunnel (via the home site). Only for devices away from home. Changes the next config you download.">${p.home_lan ? "Home network: on" : "Home network: off"}</button></form>`}
            ${p.full_tunnel ? "" : html`<form method="post" action="/peers/${p.id}/azure" hx-post="/peers/${p.id}/azure" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit" title="Whether configs for this client route the Azure network through the tunnel. Changes the next config you download; edit AllowedIPs in the app to change an existing one.">${p.azure_vnet ? "Azure route: on" : "Azure route: off"}</button></form>`}
            ${p.full_tunnel ? "" : html`<form method="post" action="/peers/${p.id}/dns" hx-post="/peers/${p.id}/dns" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit" title="Whether configs for this client use the tunnel DNS on the VM (ad-blocking, .wg names). Changes the next config you download.">${p.tunnel_dns ? "Tunnel DNS: on" : "Tunnel DNS: off"}</button></form>`}
            <form method="post" action="/peers/${p.id}/toggle" hx-post="/peers/${p.id}/toggle" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit">${p.enabled ? "Disable" : "Enable"}</button></form>
            <form method="post" action="/peers/${p.id}/delete" hx-post="/peers/${p.id}/delete" hx-target="#peers-table" hx-swap="outerHTML" hx-confirm="Delete ${p.name}? Its config stops working at the next heartbeat." style="display:inline"><button type="submit" class="danger">Delete</button></form>`;
}

/**
 * The phone's Clients: one line per device (a light, the name, and latency or
 * state), each opening a sheet with the details and the buttons.
 */
function peersPhone(peers: Peer[], byKey: Map<string, AgentPeer>, running: boolean, latency: Record<string, number[]>): Html {
  if (!peers.length) return html`<div class="m-only m-empty">No clients yet.</div>`;
  return html`<ul class="m-list m-only">
    ${peers.map((p) => {
      const live = byKey.get(p.public_key);
      const online = !!live && peerOnline(live);
      const lat = latency[p.public_key]?.slice(-1)[0];
      const kind = !p.enabled ? "idle" : !running ? "idle" : online ? "up" : live ? "idle" : "busy";
      const right = !p.enabled ? "disabled" : p.routes && !running ? "home site" : !running ? "" : online ? (lat !== undefined ? `${lat < 10 ? lat.toFixed(1) : Math.round(lat)} ms` : "online") : live ? "offline" : "loading";
      return html`<li><button type="button" data-sheet="sh-peer-${p.id}"><span class="ind ${kind}"><i></i>${p.name}</span><span class="m-right">${right}</span></button></li>`;
    })}
  </ul>
  ${peers.map((p) => {
    const live = byKey.get(p.public_key);
    const online = !!live && peerOnline(live);
    return html`<div class="panel sheet m-only" id="sh-peer-${p.id}">
      ${sheetHead(p.name)}
      <p>${statusCell(p, live, running, online)}${p.routes ? html` <span class="pill up">site: ${p.routes}</span>` : ""}${p.home_lan && !p.full_tunnel ? html` <span class="pill idle">+ home</span>` : ""}${p.full_tunnel ? html` <span class="pill idle">full tunnel</span>` : ""}${p.azure_vnet && !p.full_tunnel ? html` <span class="pill idle">+ azure</span>` : ""}${p.tunnel_dns || p.full_tunnel ? html` <span class="pill idle">tunnel DNS</span>` : ""}</p>
      <dl class="m-kv">
        <div><dt>Tunnel address</dt><dd class="mono">${p.ip}</dd></div>
        <div><dt>Last handshake</dt><dd>${live && live.latest_handshake ? ago(new Date(live.latest_handshake * 1000).toISOString()) : "never"}</dd></div>
        <div><dt>Latency</dt><dd>${running && online ? latencyCell(latency[p.public_key]) : "—"}</dd></div>
        <div><dt>Received / sent</dt><dd>${live ? `${bytes(live.tx)} / ${bytes(live.rx)}` : "—"}</dd></div>
      </dl>
      <div class="m-actions">${peerActions(p)}</div>
    </div>`;
  })}`;
}

export function peersTable(peers: Peer[], report: AgentReport | null, running: boolean, latency: Record<string, number[]> = {}): Html {
  const byKey = new Map((report?.peers ?? []).map((p) => [p.public_key, p]));
  return html`<div id="peers-table">
  ${peersPhone(peers, byKey, running, latency)}
  <div class="table-wrap d-only">
  ${peers.length
    ? html`<table class="rows stack">
      <thead><tr><th>Client</th><th>Tunnel address</th><th>Status</th><th>Last handshake</th><th>Latency</th><th class="num">Received</th><th class="num">Sent</th><th></th></tr></thead>
      <tbody>
      ${peers.map((p) => {
        const live = byKey.get(p.public_key);
        const online = !!live && peerOnline(live);
        return html`<tr>
          <td class="lead"><b>${p.name}</b>${p.routes ? html` <span class="pill up">site: ${p.routes}</span>` : ""}${p.full_tunnel ? html` <span class="pill idle">full tunnel</span>` : ""}${p.azure_vnet && !p.full_tunnel ? html` <span class="pill idle">+ azure</span>` : ""}${p.home_lan && !p.full_tunnel ? html` <span class="pill idle">+ home</span>` : ""}${p.tunnel_dns || p.full_tunnel ? html` <span class="pill idle">tunnel DNS</span>` : ""}<div class="key" title="${p.public_key}">${p.public_key}</div></td>
          <td class="mono" data-label="Tunnel address">${p.ip}</td>
          <td data-label="Status">${statusCell(p, live, running, online)}</td>
          <td data-label="Last handshake">${live && live.latest_handshake ? html`<span title="${new Date(live.latest_handshake * 1000).toISOString()}">${ago(new Date(live.latest_handshake * 1000).toISOString())}</span>` : html`<span class="faint">never</span>`}</td>
          <td data-label="Latency">${running && online ? latencyCell(latency[p.public_key]) : html`<span class="faint">—</span>`}</td>
          <td class="num" data-label="Received">${live ? bytes(live.tx) : html`<span class="faint">—</span>`}</td>
          <td class="num" data-label="Sent">${live ? bytes(live.rx) : html`<span class="faint">—</span>`}</td>
          <td class="actions">
            ${peerActions(p)}
          </td>
        </tr>`;
      })}
      </tbody></table>`
    : html`<div class="empty"><b>No clients yet.</b> Add one below: a phone takes under a minute.</div>`}
  </div>
</div>`;
}

export function peersBody(o: { peers: Peer[]; report: AgentReport | null; running: boolean; cfg: Config; serverPub: string | null; nextIp: string | null; latency?: Record<string, number[]> }): Html {
  return html`<section>
  <div class="section-head"><h1>Clients</h1><span class="muted small d-only">${o.running ? "Changes reach the VM within 30 seconds; the status column shows what the VM reports." : "Changes are loaded at the next deploy."}</span></div>
  ${peersTable(o.peers, o.report, o.running, o.latency)}
  <div class="m-btns m-only" style="margin-top:12px"><button type="button" class="primary big" data-sheet="sh-add">Add a client</button></div>
  <div class="m-more m-only"><button type="button" class="ghost" data-sheet="sh-help">Apps and server key</button></div>
</section>

<section id="peer-reveal" hidden>
  <div class="panel">
    <div class="sheet-head"><b>New config</b><button type="button" class="sheet-x" data-reveal-close>Done</button></div>
    <div class="section-head"><h2>Config for <span data-peer-name></span></h2><span class="muted small">tunnel address <span class="mono" data-peer-ip></span></span></div>
    <p class="muted">This is the only time the private key is shown. Scan it with the WireGuard app, or download the file and use "Import tunnel(s) from file" on Windows or macOS. It is not stored anywhere; to get a config again later, press Get config on the client, which makes new keys.</p>
    <div class="reveal">
      <div class="qr" aria-label="QR code of the config"></div>
      <div>
        <pre class="conf" id="peer-conf"></pre>
        <div class="btn-row"><a class="btn" data-download href="#">Download .conf</a><button type="button" data-copy="#peer-conf">Copy</button></div>
      </div>
    </div>
  </div>
</section>

<div class="side-by-side">
<section>
  <div class="panel sheet" id="sh-add">
    ${sheetHead("Add a client")}
    <h2>Add a client</h2>
    ${o.serverPub
      ? html`<form id="add-peer" hx-boost="false" action="/peers" method="get">
        <label class="field"><span>Name</span><input type="text" name="name" required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9 _-]{0,31}" placeholder="Phone"></label>
        <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="azure_vnet" value="1" style="width:auto"><span style="margin:0">Also route the Azure network <span class="mono">${o.cfg.vnetCidr}</span> through the tunnel</span></label>
        <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="tunnel_dns" value="1" style="width:auto"><span style="margin:0">Use the tunnel DNS: ad-blocking and names like <span class="mono">vm.wg</span>. Leave off if this device stays connected while the VM is destroyed</span></label>
        ${o.cfg.homeLanCidr ? html`<label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="home_lan" value="1" style="width:auto"><span style="margin:0">Also reach the home network <span class="mono">${o.cfg.homeLanCidr}</span> through the home site (for a device away from home)</span></label>` : ""}
        <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="full_tunnel" value="1" style="width:auto"><span style="margin:0">Full tunnel (send all traffic, IPv4 and IPv6, through Azure, an exit node; includes the Azure network and the tunnel DNS)</span></label>
        <p class="hint">Split tunnel by default: ${o.cfg.subnet}${o.cfg.subnet6 ? `, ${o.cfg.subnet6}` : ""} and the loopback ${o.cfg.loopbackIp} go through. Next free address: <span class="mono">${o.nextIp ?? "none left"}</span>${o.nextIp && o.cfg.subnet6 ? html` and <span class="mono">${peerIp6(o.cfg.subnet6, o.nextIp)}</span>` : ""}.</p>
        <div class="btn-row"><button type="submit" class="primary" ${o.nextIp ? "" : "disabled"}>Make keys and add</button><span id="add-peer-status" class="small muted"></span></div>
      </form>`
      : html`<p class="muted">The server public key is not configured (WG_SERVER_PUBLIC_KEY in wrangler.toml), so client configs cannot be built yet. <a href="/settings">Finish setup</a>.</p>`}
  </div>
</section>

<div class="stack sheet" id="sh-help">
${sheetHead("Apps and server key")}
<section>
  <div class="panel quiet">
    <h3>Get the WireGuard app</h3>
    <p class="muted small">Official clients. Install one, then add a client above and scan the QR (phones) or import the .conf (desktops).</p>
    <div class="downloads">
      <a href="https://apps.apple.com/app/wireguard/id1441195209" target="_blank" rel="noopener">iPhone and iPad</a>
      <a href="https://play.google.com/store/apps/details?id=com.wireguard.android" target="_blank" rel="noopener">Android</a>
      <a href="https://download.wireguard.com/windows-client/wireguard-installer.exe" target="_blank" rel="noopener">Windows</a>
      <a href="https://apps.apple.com/app/wireguard/id1451685025" target="_blank" rel="noopener">macOS</a>
      <a href="https://www.wireguard.com/install/" target="_blank" rel="noopener">Linux and everything else</a>
    </div>
  </div>
</section>

<section>
  <div class="panel quiet">
    <h3>Server public key</h3>
    <p class="muted small">Every client trusts this key. It never changes across rebuilds.</p>
    ${o.serverPub ? html`<code id="server-pub">${o.serverPub}</code> <button type="button" data-copy="#server-pub" style="padding:3px 8px;font-size:.8rem">Copy</button>` : html`<span class="faint">not set</span>`}
    <p class="muted small" style="margin-top:8px">Test from a connected client: <code>ping ${o.cfg.loopbackIp}</code> (the VM loopback, proves routing) and <code>ping ${serverTunnelIpOf(o.cfg.subnet)}</code> (the tunnel end).</p>
    <p class="muted small" style="margin-top:8px">Endpoint <code>${o.cfg.dnsName}:${o.cfg.port}</code>${o.report ? html` · VM reports ${o.report.peers.length} peer${o.report.peers.length === 1 ? "" : "s"} loaded, checked ${fmtTime(o.report.at)}` : ""}</p>
  </div>
</section>
</div>
</div>`;
}
