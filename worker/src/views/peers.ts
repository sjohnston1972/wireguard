// views/peers.ts
//
// Plain English: the clients screen. A ruled table of every phone and
// laptop with its tunnel address, last handshake and traffic, plus the
// add-a-client form. Keys are made in the browser (see app.js); this screen
// only ever sees public keys.

import { html } from "hono/html";
import type { Html } from "./layout";
import { ago, bytes, fmtTime } from "./layout";
import type { Peer } from "../db";
import type { AgentReport } from "../state";
import { peerOnline } from "../state";
import type { Config } from "../env";

export function peersTable(peers: Peer[], report: AgentReport | null, running: boolean): Html {
  const byKey = new Map((report?.peers ?? []).map((p) => [p.public_key, p]));
  return html`<div id="peers-table" class="table-wrap">
  ${peers.length
    ? html`<table class="rows">
      <thead><tr><th>Client</th><th>Tunnel address</th><th>Status</th><th>Last handshake</th><th class="num">Received</th><th class="num">Sent</th><th></th></tr></thead>
      <tbody>
      ${peers.map((p) => {
        const live = byKey.get(p.public_key);
        const online = !!live && peerOnline(live);
        return html`<tr>
          <td><b>${p.name}</b>${p.full_tunnel ? html` <span class="pill idle">full tunnel</span>` : ""}<div class="key" title="${p.public_key}">${p.public_key}</div></td>
          <td class="mono">${p.ip}</td>
          <td>${!p.enabled ? html`<span class="pill idle">disabled</span>` : !running ? html`<span class="faint">headend down</span>` : online ? html`<span class="pill up">online</span>` : html`<span class="pill idle">offline</span>`}</td>
          <td>${live && live.latest_handshake ? html`<span title="${new Date(live.latest_handshake * 1000).toISOString()}">${ago(new Date(live.latest_handshake * 1000).toISOString())}</span>` : html`<span class="faint">never</span>`}</td>
          <td class="num">${live ? bytes(live.tx) : html`<span class="faint">—</span>`}</td>
          <td class="num">${live ? bytes(live.rx) : html`<span class="faint">—</span>`}</td>
          <td class="actions">
            <form method="post" action="/peers/${p.id}/toggle" hx-post="/peers/${p.id}/toggle" hx-target="#peers-table" hx-swap="outerHTML" style="display:inline"><button type="submit">${p.enabled ? "Disable" : "Enable"}</button></form>
            <form method="post" action="/peers/${p.id}/delete" hx-post="/peers/${p.id}/delete" hx-target="#peers-table" hx-swap="outerHTML" hx-confirm="Delete ${p.name}? Its config stops working at the next heartbeat." style="display:inline"><button type="submit" class="danger">Delete</button></form>
          </td>
        </tr>`;
      })}
      </tbody></table>`
    : html`<div class="empty"><b>No clients yet.</b> Add one below: a phone takes under a minute.</div>`}
</div>`;
}

export function peersBody(o: { peers: Peer[]; report: AgentReport | null; running: boolean; cfg: Config; serverPub: string | null; nextIp: string | null }): Html {
  return html`<section>
  <div class="section-head"><h1>Clients</h1><span class="muted small">${o.running ? "Changes reach the VM within 30 seconds." : "Changes are loaded at the next deploy."}</span></div>
  ${peersTable(o.peers, o.report, o.running)}
</section>

<section id="peer-reveal" hidden>
  <div class="panel">
    <div class="section-head"><h2>Config for <span data-peer-name></span></h2><span class="muted small">tunnel address <span class="mono" data-peer-ip></span></span></div>
    <p class="muted">This is the only time the private key is shown. Scan it with the WireGuard app, or download the file. It is not stored anywhere.</p>
    <div class="reveal">
      <div class="qr" aria-label="QR code of the config"></div>
      <div>
        <pre class="conf" id="peer-conf"></pre>
        <div class="btn-row"><a class="btn" data-download href="#">Download .conf</a><button type="button" data-copy="#peer-conf">Copy</button></div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="panel">
    <h2>Add a client</h2>
    ${o.serverPub
      ? html`<form id="add-peer">
        <label class="field"><span>Name</span><input type="text" name="name" required maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9 _-]{0,31}" placeholder="Phone"></label>
        <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="full_tunnel" value="1" style="width:auto"><span style="margin:0">Full tunnel (send all traffic through Azure, an exit node)</span></label>
        <p class="hint">Split tunnel by default: only ${o.cfg.subnet} goes through. Next free address: <span class="mono">${o.nextIp ?? "none left"}</span>.</p>
        <div class="btn-row"><button type="submit" class="primary" ${o.nextIp ? "" : "disabled"}>Make keys and add</button><span id="add-peer-status" class="small muted"></span></div>
      </form>`
      : html`<p class="muted">The server key is not configured (WG_SERVER_PRIVATE_KEY), so client configs cannot be built yet. <a href="/settings">Finish setup</a>.</p>`}
  </div>
</section>

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
    <p class="muted small" style="margin-top:8px">Endpoint <code>${o.cfg.dnsName}:${o.cfg.port}</code>${o.report ? html` · VM reports ${o.report.peers.length} peer${o.report.peers.length === 1 ? "" : "s"} loaded, checked ${fmtTime(o.report.at)}` : ""}</p>
  </div>
</section>`;
}
