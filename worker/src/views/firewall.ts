// views/firewall.ts
//
// Plain English: the Firewall page. The rule table the WireGuard VM enforces
// on traffic it routes between tunnel clients, the home LAN, the Azure VNet
// (including the workloads subnet with the test VM) and the internet. Top to
// bottom, first match wins, then the default. Each rule shows its hits (the
// VM's counter for it), when it last matched, and anything wrong with it.
// Below: what the default rule dropped recently, with "Allow this", and what
// each zone contains.

import { html } from "hono/html";
import type { Html } from "./layout";
import { ago, bytes, sheetHead } from "./layout";
import type { Config } from "../env";
import type { Peer } from "../db";
import type { Snapshot } from "../state";
import { ZONE_LABEL, endLabel, serviceLabel, zoneAddrs, type FwRule, type Zone } from "../firewall";

export interface FirewallOpts {
  rules: FwRule[];
  peers: Peer[];
  cfg: Config;
  snap: Snapshot;
  hash: string;
  problems: Record<number, string>;
  notice?: { kind: "good" | "bad"; text: string } | null;
}

const ZONES = Object.keys(ZONE_LABEL) as Zone[];

function count(n: number): string {
  return n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k` : `${(n / 1e6).toFixed(1)}M`;
}

/** Where the rule set stands on the VM. */
function appliedState(o: FirewallOpts): { kind: "up" | "busy" | "down" | "idle"; text: string } {
  const fw = o.snap.firewall;
  if (o.snap.state !== "running") return { kind: "idle", text: "Not running: this rule set is loaded at the next deploy or resume." };
  if (!fw) return { kind: "idle", text: "This VM was built before the firewall existed: redeploy to use it." };
  if (fw.error) return { kind: "down", text: `The VM refused the last rule set and kept the previous one: ${fw.error}` };
  if (fw.applied_hash === o.hash) return { kind: "up", text: `Applied on the VM (rule set ${o.hash.slice(0, 8)}).` };
  return { kind: "busy", text: "Changed: the VM picks it up within 30 seconds." };
}

function endSelect(name: string, o: FirewallOpts, selected = "any"): Html {
  return html`<select name="${name}" data-end-select>
    <option value="any" ${selected === "any" ? "selected" : ""}>Anywhere</option>
    <optgroup label="Zones">${ZONES.map((z) => html`<option value="zone:${z}" ${selected === `zone:${z}` ? "selected" : ""}>${ZONE_LABEL[z]}</option>`)}</optgroup>
    <optgroup label="One client">${o.peers.map((p) => html`<option value="client:${p.id}" ${selected === `client:${p.id}` ? "selected" : ""}>${p.name} (${p.ip})</option>`)}</optgroup>
    <option value="cidr" ${selected === "cidr" ? "selected" : ""}>An address or network…</option>
  </select>`;
}

function hits(o: FirewallOpts, key: string): Html {
  const c = o.snap.firewall?.counters[key];
  const last = o.snap.firewall?.last_hit[key];
  if (!c) return html`<span class="faint">—</span>`;
  return html`<b class="mono">${count(c[0])}</b> <span class="faint small">${bytes(c[1])}</span>${last ? html`<div class="faint small">last ${ago(last)}</div>` : ""}`;
}

function actionPill(r: FwRule): Html {
  return r.action === "allow" ? html`<span class="pill up">allow</span>` : html`<span class="pill down">deny</span>`;
}

function ruleButtons(r: FwRule, first: boolean, last: boolean): Html {
  const post = (path: string, label: string, cls = "", title = "") =>
    html`<form method="post" action="/firewall/rules/${r.id}/${path}" hx-post="/firewall/rules/${r.id}/${path}" hx-target="#fw" hx-swap="outerHTML" hx-select="#fw" style="display:inline"><button type="submit" class="${cls}" title="${title}">${label}</button></form>`;
  return html`${first ? "" : post("up", "↑", "", "Move up")}${last ? "" : post("down", "↓", "", "Move down")}${post("toggle", r.enabled ? "Disable" : "Enable")}${post("delete", "Delete", "danger")}`;
}

/** The add-rule form, also used prefilled by "Allow this" on a drop. */
function addForm(o: FirewallOpts): Html {
  return html`<form method="post" action="/firewall/rules" hx-post="/firewall/rules" hx-target="#fw" hx-swap="outerHTML" hx-select="#fw" class="fw-add">
    <label class="field"><span>Name</span><input type="text" name="name" maxlength="60" required placeholder="Phone to the test VM web page"></label>
    <div class="fw-ends">
      <label class="field"><span>From</span>${endSelect("from", o)}<input type="text" name="from_cidr" placeholder="10.13.13.3 or 192.168.1.0/24" data-cidr-for="from" hidden></label>
      <label class="field"><span>To</span>${endSelect("to", o, "zone:workloads")}<input type="text" name="to_cidr" placeholder="10.50.2.4 or 10.50.2.0/24" data-cidr-for="to" hidden></label>
    </div>
    <div class="fw-ends">
      <label class="field"><span>Protocol</span><select name="proto"><option value="tcp">TCP</option><option value="udp">UDP</option><option value="icmp">Ping (ICMP)</option><option value="any">Any</option></select></label>
      <label class="field"><span>Ports (TCP/UDP)</span><input type="text" name="ports" placeholder="8080 or 80,443 or 8000-8100; blank = all"></label>
    </div>
    <div class="chips"><label><input type="radio" name="action" value="allow" checked><span>Allow</span></label><label><input type="radio" name="action" value="deny"><span>Deny</span></label></div>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="log" value="1" style="width:auto"><span style="margin:0">Log matches (the VM's kernel log)</span></label>
    <p class="hint">New rules go to the bottom, just above the default. Move them up where order matters: the first match wins.</p>
    <div class="btn-row"><button type="submit" class="primary">Add rule</button></div>
  </form>`;
}

function dropsTable(o: FirewallOpts): Html {
  const drops = o.snap.firewall?.drops ?? [];
  const who = (ip: string) => o.peers.find((p) => p.ip === ip)?.name ?? ip;
  if (!drops.length) return html`<p class="faint">Nothing dropped recently.</p>`;
  return html`<table class="rows stack"><thead><tr><th>When</th><th>From → to</th><th>What</th><th></th></tr></thead><tbody>
    ${drops.slice(0, 20).map(
      (d) => html`<tr><td class="small muted" data-label="When">${ago(d.at)}</td><td class="lead mono">${who(d.src)} → ${who(d.dst)}</td><td data-label="What">${d.proto}${d.dport ? ` ${d.dport}` : ""}</td>
        <td class="actions"><form method="post" action="/firewall/allow-drop" hx-post="/firewall/allow-drop" hx-target="#fw" hx-swap="outerHTML" hx-select="#fw" style="display:inline">
          <input type="hidden" name="src" value="${d.src}"><input type="hidden" name="dst" value="${d.dst}"><input type="hidden" name="proto" value="${d.proto}"><input type="hidden" name="dport" value="${d.dport ?? ""}">
          <button type="submit" title="Add an allow rule for exactly this: this source, this destination, this protocol and port">Allow this</button></form></td></tr>`
    )}</tbody></table>`;
}

function zonesPanel(o: FirewallOpts): Html {
  const ip = o.snap.test_vm_ip;
  return html`<table class="rows inv"><tbody>
    ${ZONES.map((z) => {
      const a = zoneAddrs(z, o.cfg);
      return html`<tr><th>${ZONE_LABEL[z]}</th><td class="mono small" colspan="2">${a.negate ? "everything except " : ""}${a.v4.concat(a.v6).join(", ") || "not set"}</td></tr>`;
    })}
    <tr><th>Test VM</th><td colspan="2">${ip
      ? html`<b class="mono">${ip}</b> <span class="muted small">in the workloads subnet. From a connected client: <code>ping ${ip}</code>, <code>curl http://${ip}:8080</code></span>`
      : html`<span class="muted small">${o.cfg.testVm ? "built with the next deploy" : "off (Settings > Next deploy)"}</span>`}</td></tr>
  </tbody></table>`;
}

/** The phone's Firewall: lights, one line per rule (tap for detail), and sheets. */
function firewallPhone(o: FirewallOpts, st: { kind: string; text: string }): Html {
  const drops = o.snap.firewall?.drops ?? [];
  const recent = drops.filter((d) => Date.now() - Date.parse(d.at) < 10 * 60_000).length;
  return html`<div class="m-only m-dock">
    <div class="m-inds">
      <span class="ind ${st.kind}"><i></i>${st.kind === "up" ? "Applied" : st.kind === "busy" ? "Updating" : st.kind === "down" ? "Refused" : "Not running"}</span>
      <span class="ind idle"><i></i>${o.rules.filter((r) => r.enabled).length} rules</span>
      <span class="ind ${recent ? "busy" : "idle"}"><i></i>${recent} drops (10 min)</span>
      <span class="ind ${o.cfg.firewallDefault === "deny" ? "up" : "busy"}"><i></i>Default ${o.cfg.firewallDefault}</span>
    </div>
    <ul class="m-list" style="margin-top:12px">
      ${o.rules.map((r) => {
        const c = o.snap.firewall?.counters[`r${r.id}`];
        return html`<li><button type="button" data-sheet="sh-rule-${r.id}"><span class="ind ${!r.enabled || o.problems[r.id] ? "idle" : r.action === "allow" ? "up" : "down"}"><i></i>${r.name}</span><span class="m-right">${c ? count(c[0]) : "—"}</span></button></li>`;
      })}
    </ul>
    <div class="m-btns two"><button type="button" class="primary" data-sheet="sh-fw-add">Add rule</button><button type="button" data-sheet="sh-fw-drops">Drops${recent ? html` <span class="count">${recent}</span>` : ""}</button></div>
    <div class="m-more"><button type="button" class="ghost" data-sheet="sh-fw-zones">Zones and test VM</button><button type="button" class="ghost" data-sheet="sh-fw-default">Default</button></div>
  </div>
  ${o.rules.map(
    (r, i) => html`<div class="panel sheet m-only" id="sh-rule-${r.id}">
      ${sheetHead(r.name)}
      <p>${actionPill(r)} ${r.enabled ? "" : html`<span class="pill idle">disabled</span>`} ${o.problems[r.id] ? html`<span class="pill down">not applied</span> <span class="small">${o.problems[r.id]}</span>` : ""}</p>
      <dl class="m-kv">
        <div><dt>From</dt><dd>${endLabel(r.src_kind, r.src_value, o.peers)}</dd></div>
        <div><dt>To</dt><dd>${endLabel(r.dst_kind, r.dst_value, o.peers)}</dd></div>
        <div><dt>Service</dt><dd>${serviceLabel(r)}</dd></div>
        <div><dt>Hits</dt><dd>${hits(o, `r${r.id}`)}</dd></div>
      </dl>
      <div class="m-actions">${ruleButtons(r, i === 0, i === o.rules.length - 1)}</div>
    </div>`
  )}`;
}

export function firewallBody(o: FirewallOpts): Html {
  const st = appliedState(o);
  const def = o.snap.firewall?.counters.default;
  return html`<section id="fw" hx-get="/firewall" hx-trigger="every 20s" hx-select="#fw" hx-swap="outerHTML">
  <div class="section-head"><h1>Firewall</h1><span class="muted small d-only">What the WireGuard VM lets through between tunnel clients, the home LAN, the Azure VNet and the internet. First match wins.</span></div>
  ${o.notice ? html`<div class="notice ${o.notice.kind}"><p>${o.notice.text}</p></div>` : ""}
  <div class="notice d-only ${st.kind === "down" ? "bad" : st.kind === "busy" ? "warn" : st.kind === "up" ? "good" : ""}"><p>${st.text}</p></div>
  ${firewallPhone(o, st)}

  <div class="table-wrap d-only">
    <table class="rows fw">
      <thead><tr><th>#</th><th>Rule</th><th>From</th><th>To</th><th>Service</th><th>Action</th><th>Hits</th><th></th></tr></thead>
      <tbody>
      ${o.rules.map(
        (r, i) => html`<tr class="${r.enabled ? "" : "off"}">
          <td class="faint">${i + 1}</td>
          <td><b>${r.name}</b>${r.log ? html` <span class="pill idle">log</span>` : ""}${!r.enabled ? html` <span class="pill idle">disabled</span>` : ""}${o.problems[r.id] ? html`<div class="small" style="color:var(--down)">Not applied: ${o.problems[r.id]}</div>` : ""}</td>
          <td>${endLabel(r.src_kind, r.src_value, o.peers)}</td>
          <td>${endLabel(r.dst_kind, r.dst_value, o.peers)}</td>
          <td>${serviceLabel(r)}</td>
          <td>${actionPill(r)}</td>
          <td>${hits(o, `r${r.id}`)}</td>
          <td class="actions">${ruleButtons(r, i === 0, i === o.rules.length - 1)}</td>
        </tr>`
      )}
        <tr class="fw-default">
          <td class="faint">∗</td>
          <td><b>Default</b> <span class="muted small">anything no rule matched${o.cfg.firewallDefault === "deny" ? ", logged" : ""}</span></td>
          <td>Anywhere</td><td>Anywhere</td><td>Any</td>
          <td>${o.cfg.firewallDefault === "deny" ? html`<span class="pill down">deny</span>` : html`<span class="pill up">allow</span>`}</td>
          <td>${hits(o, "default")}</td>
          <td class="actions"><form method="post" action="/firewall/default" hx-post="/firewall/default" hx-target="#fw" hx-swap="outerHTML" hx-select="#fw" style="display:inline"><input type="hidden" name="value" value="${o.cfg.firewallDefault === "deny" ? "allow" : "deny"}"><button type="submit">${o.cfg.firewallDefault === "deny" ? "Make default allow" : "Make default deny"}</button></form></td>
        </tr>
      </tbody>
    </table>
  </div>
  <p class="faint small d-only" style="margin-top:6px">Hits count packets that started or matched a connection since the rule set was last loaded (a change, or a VM rebuild, starts them again). Replies to allowed traffic pass automatically and are not counted per rule.${def ? "" : ""}</p>

  <div class="two-col" style="margin-top:16px">
    <div class="panel sheet" id="sh-fw-add">${sheetHead("Add a rule")}<h2>Add a rule</h2>${addForm(o)}</div>
    <div>
      <div class="panel sheet" id="sh-fw-drops">${sheetHead("Recent drops")}<h2>Recent drops</h2><p class="muted small">What the default rule refused, newest first (the VM logs up to 10 a second).</p>${dropsTable(o)}</div>
      <div class="panel sheet" id="sh-fw-zones" style="margin-top:16px">${sheetHead("Zones and test VM")}<h2>Zones and test VM</h2>${zonesPanel(o)}</div>
      <div class="panel sheet m-only" id="sh-fw-default">${sheetHead("Default")}
        <p>Anything no rule matches is <b>${o.cfg.firewallDefault === "deny" ? "denied and logged" : "allowed"}</b>. ${hits(o, "default")}</p>
        <form method="post" action="/firewall/default" hx-post="/firewall/default" hx-target="#fw" hx-swap="outerHTML" hx-select="#fw"><input type="hidden" name="value" value="${o.cfg.firewallDefault === "deny" ? "allow" : "deny"}"><div class="btn-row"><button type="submit">${o.cfg.firewallDefault === "deny" ? "Make default allow" : "Make default deny"}</button></div></form>
      </div>
    </div>
  </div>
</section>`;
}
