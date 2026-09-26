// firewall.ts
//
// Plain English: the rule table on the Firewall page, compiled into an
// nftables rule set for the WireGuard VM. The VM routes between four places
// (the tunnel clients, the home LAN behind the home site, the Azure VNet and
// the internet) and this decides what may pass between them. Think of an ACL
// on a firewall's inside interfaces with zones, written top to bottom, first
// match wins, then the default.
//
// Only traffic routed THROUGH the VM is filtered (the "forward" hook). The
// VM's own traffic (the tunnel, the heartbeat, DNS, SSH to the VM) is never
// touched, so no rule can lock you out of the headend. The one exception is
// a published port: the VM drops it for itself, since it is meant for the
// server behind (and the WireGuard and SSH ports can never be published).
//
// Every rule gets a named counter, so the dashboard can show its hits. The
// default rule logs what it drops ("wgfw-drop ...", rate-limited), which is
// how the dashboard shows recent drops.
//
// The same rule set also carries:
//   - TCP MSS clamping, so full-size packets never need fragmenting inside
//     the tunnel (the classic "pages hang on 4G" fault);
//   - published ports: destination NAT from the VM's public address to a
//     server in the workloads subnet or on the home LAN, like a static NAT
//     on an edge firewall;
//   - traffic accounting for top talkers: per tunnel client and remote
//     address, bytes each way, in self-filling sets (think NetFlow cache).

import type { Config } from "./env";
import type { Peer } from "./db";
import { peerIp6 } from "./peers";

export type EndKind = "any" | "zone" | "client" | "cidr";
export type Zone = "clients" | "home" | "azure" | "workloads" | "internet";
export type Proto = "any" | "tcp" | "udp" | "icmp";

export interface FwRule {
  id: number;
  position: number;
  enabled: number;
  name: string;
  src_kind: EndKind;
  src_value: string;
  dst_kind: EndKind;
  dst_value: string;
  proto: Proto;
  ports: string;
  action: "allow" | "deny";
  log: number;
}

/** A published port: public TCP/UDP port on the VM -> a server behind it. */
export interface Forward {
  id: number;
  enabled: number;
  name: string;
  proto: "tcp" | "udp";
  public_port: number;
  target_ip: string;
  target_port: number;
  allow_from: string; // "" = anywhere, else a CIDR
}

/** Where a packet capture can listen on the VM. */
export const CAPTURE_IFACES: Record<string, string> = {
  wg0: "Inside the tunnel (decrypted client traffic)",
  eth0: "Azure side (the VNet and the internet)",
  any: "Both",
};

/**
 * Ports the VM itself needs on its public address; never publishable, in
 * either protocol. Checked by port number alone, so "UDP 22" can never turn
 * into a back door to SSH on TCP 22. The WireGuard port is whatever this
 * install uses (WG_PORT), not always 51820.
 * Returns why the port is taken, or null if it is free.
 */
export function reservedPort(port: number, cfg: Pick<Config, "port">): string | null {
  if (port === cfg.port) return "the port WireGuard itself listens on";
  if (port === 22) return "SSH to the VM";
  return null;
}

/** One Azure edge (NSG) rule for a published port: exactly its protocol, port and allowed source. */
export interface PublishedNsgRule {
  name: string;
  protocol: "Tcp" | "Udp";
  port: string;
  source: string; // "*" = anywhere
}

/**
 * The published ports that are actually in force: enabled, a valid IPv4
 * "allowed from", a target the VM can route to, and not a reserved port
 * (a row saved before a check existed is simply left out).
 */
export function liveForwards(forwards: Forward[], cfg: Config): Forward[] {
  return forwards.filter((f) => {
    if (!f.enabled || reservedPort(f.public_port, cfg)) return false;
    const src = f.allow_from ? parseCidr(f.allow_from) : null;
    if (f.allow_from && (!src || src.family !== 4)) return false;
    return forwardTargetOk(f.target_ip, cfg);
  });
}

/**
 * The NSG rules that let published ports through Azure's edge: one per
 * published port, with the same protocol and the same "allowed from" as the
 * Firewall tab, so the edge opens no more than the VM will forward.
 */
export function publishedNsgRules(forwards: Forward[], cfg: Config): PublishedNsgRule[] {
  return liveForwards(forwards, cfg)
    .sort((a, b) => a.proto.localeCompare(b.proto) || a.public_port - b.public_port)
    .map((f) => ({
      name: `published-${f.proto}-${f.public_port}`,
      protocol: f.proto === "udp" ? "Udp" : "Tcp",
      port: String(f.public_port),
      source: f.allow_from ? (parseCidr(f.allow_from)?.text ?? "*") : "*",
    }));
}

/** Is a publish target somewhere the VM can route to and back? Workloads subnet, rest of the VNet, or the home LAN. */
export function forwardTargetOk(ip: string, cfg: Config): boolean {
  const inCidr = (addr: string, cidr: string) => {
    const [base, bits] = cidr.split("/");
    const toInt = (a: string) => a.split(".").reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
    const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(addr) & mask) === (toInt(base) & mask);
  };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return inCidr(ip, cfg.vnetCidr) || (!!cfg.homeLanCidr && inCidr(ip, cfg.homeLanCidr));
}

export const ZONE_LABEL: Record<Zone, string> = {
  clients: "Tunnel clients",
  home: "Home LAN",
  azure: "Azure VNet",
  workloads: "Workloads subnet",
  internet: "Internet",
};

interface Addrs {
  v4: string[];
  v6: string[];
  /** true for "the internet": everything except the private places below. */
  negate?: boolean;
}

/** The address sets behind each zone, from the current settings. */
export function zoneAddrs(zone: Zone, cfg: Config): Addrs {
  const privateV4 = [cfg.subnet, `${cfg.loopbackIp}/32`, cfg.vnetCidr].concat(cfg.homeLanCidr ? [cfg.homeLanCidr] : []);
  const privateV6 = (cfg.subnet6 ? [cfg.subnet6] : []).concat(["fd50:50::/48"]);
  switch (zone) {
    case "clients":
      return { v4: [cfg.subnet], v6: cfg.subnet6 ? [cfg.subnet6] : [] };
    case "home":
      return { v4: cfg.homeLanCidr ? [cfg.homeLanCidr] : [], v6: [] };
    case "azure":
      return { v4: [cfg.vnetCidr], v6: ["fd50:50::/48"] };
    case "workloads":
      return { v4: [cfg.workloadCidr], v6: [] };
    case "internet":
      return { v4: privateV4, v6: privateV6, negate: true };
  }
}

/** A dotted IPv4 address with every part 0-255. */
function isIpv4(a: string): boolean {
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1, 5).every((x) => Number(x) <= 255);
}

/**
 * A real IPv6 address, checked the way nft will check it: eight groups of 1
 * to 4 hex digits, or fewer with exactly one "::" standing in for the missing
 * zeros. The last two groups may be written as IPv4 (::ffff:192.0.2.1).
 * "1::2::3" and "1:2:3" are not addresses, and one of them in the rule table
 * would make the VM refuse the whole rule set.
 */
export function isIpv6(a: string): boolean {
  let s = a;
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!isIpv4(v4[2])) return false;
    s = `${v4[1]}0:0`;
  }
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const all = halves.length === 2 ? [...groups(halves[0]), ...groups(halves[1])] : s.split(":");
  if (halves.length === 2 ? all.length > 7 : all.length !== 8) return false;
  return all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
}

/** A tidy CIDR (or bare address) of either family, or null. */
export function parseCidr(s: string): { family: 4 | 6; text: string } | null {
  const t = s.trim();
  const m4 = t.match(/^([\d.]+)(?:\/(\d{1,2}))?$/);
  if (m4 && isIpv4(m4[1]) && (m4[2] === undefined || Number(m4[2]) <= 32)) return { family: 4, text: m4[2] === undefined ? `${t}/32` : t };
  const m6 = t.match(/^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/);
  if (m6 && m6[1].includes(":") && isIpv6(m6[1]) && (m6[2] === undefined || Number(m6[2]) <= 128)) return { family: 6, text: m6[2] === undefined ? `${t.toLowerCase()}/128` : t.toLowerCase() };
  return null;
}

/** "22", "80,443", "8000-8100" -> nft port expression, or null if it is not valid. */
export function parsePorts(s: string): string | null {
  const t = s.replace(/\s+/g, "");
  if (!t) return "";
  const parts = t.split(",");
  for (const p of parts) {
    const m = p.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535 || (m[2] && (Number(m[2]) > 65535 || Number(m[2]) < Number(m[1])))) return null;
  }
  return parts.length === 1 ? parts[0] : `{ ${parts.join(", ")} }`;
}

/** Resolve one end of a rule to address sets. null = unresolvable (a deleted client). */
export function endAddrs(kind: EndKind, value: string, cfg: Config, peers: Peer[]): Addrs | "any" | null {
  if (kind === "any") return "any";
  if (kind === "zone") return value in ZONE_LABEL ? zoneAddrs(value as Zone, cfg) : null;
  if (kind === "client") {
    const p = peers.find((x) => String(x.id) === value);
    if (!p) return null;
    const v6 = peerIp6(cfg.subnet6, p.ip);
    return { v4: [`${p.ip}/32`], v6: v6 ? [`${v6}/128`] : [] };
  }
  const c = parseCidr(value);
  if (!c) return null;
  return c.family === 4 ? { v4: [c.text], v6: [] } : { v4: [], v6: [c.text] };
}

/** How one end reads on screen. */
export function endLabel(kind: EndKind, value: string, peers: Peer[]): string {
  if (kind === "any") return "Anywhere";
  if (kind === "zone") return ZONE_LABEL[value as Zone] ?? value;
  if (kind === "client") return peers.find((x) => String(x.id) === value)?.name ?? "(deleted client)";
  return value;
}

export function serviceLabel(r: { proto: Proto; ports: string }): string {
  if (r.proto === "any") return "Any";
  if (r.proto === "icmp") return "Ping (ICMP)";
  return `${r.proto.toUpperCase()}${r.ports ? ` ${r.ports}` : " any port"}`;
}

const set = (xs: string[]) => (xs.length === 1 ? xs[0] : `{ ${xs.join(", ")} }`);

function match(dir: "saddr" | "daddr", fam: "ip" | "ip6", a: Addrs | "any"): string | null {
  if (a === "any") return "";
  const xs = fam === "ip" ? a.v4 : a.v6;
  if (!xs.length) return a.negate ? "" : null; // nothing of this family: the rule does not apply to it
  return `${fam} ${dir} ${a.negate ? "!= " : ""}${set(xs)}`;
}

/** The nft statements for one rule (none if it cannot apply), each ending in its counter and verdict. */
export function ruleLines(r: FwRule, cfg: Config, peers: Peer[]): { lines: string[]; problem: string | null } {
  const src = endAddrs(r.src_kind, r.src_value, cfg, peers);
  const dst = endAddrs(r.dst_kind, r.dst_value, cfg, peers);
  if (src === null) return { lines: [], problem: `the source (${r.src_value}) no longer exists` };
  if (dst === null) return { lines: [], problem: `the destination (${r.dst_value}) no longer exists` };
  const ports = r.proto === "tcp" || r.proto === "udp" ? parsePorts(r.ports) : "";
  if (ports === null) return { lines: [], problem: `"${r.ports}" is not a port list` };

  const verdict = `${r.log ? `log prefix "wgfw-r${r.id} " level info ` : ""}counter name "r${r.id}" ${r.action === "allow" ? "accept" : "drop"}`;
  const l4 = (fam: "ip" | "ip6") =>
    r.proto === "any" ? "" : r.proto === "icmp" ? (fam === "ip" ? "meta l4proto icmp" : "meta l4proto ipv6-icmp") : `${r.proto}${ports ? ` dport ${ports}` : ""}`;

  // No addresses at all: one family-neutral line.
  if (src === "any" && dst === "any") {
    if (r.proto === "icmp") return { lines: [`meta l4proto { icmp, ipv6-icmp } ${verdict}`], problem: null };
    return { lines: [[l4("ip"), verdict].filter(Boolean).join(" ")], problem: null };
  }
  const lines: string[] = [];
  for (const fam of ["ip", "ip6"] as const) {
    const s = match("saddr", fam, src);
    const d = match("daddr", fam, dst);
    if (s === null || d === null) continue;
    // A negated-only match of a family neither end names ("internet" to
    // "anywhere" in IPv6, say) still applies to that family.
    const famOnly = !s && !d ? `meta nfproto ${fam === "ip" ? "ipv4" : "ipv6"}` : "";
    lines.push([famOnly, s, d, l4(fam), verdict].filter(Boolean).join(" "));
  }
  if (!lines.length) return { lines: [], problem: "the two ends have no address family in common (IPv4 to IPv6)" };
  return { lines, problem: null };
}

/**
 * The whole rule set. Loading it replaces the previous one in a single
 * transaction ("table; delete table; table { ... }"), so there is never a
 * moment with half a rule set.
 */
export async function compileFirewall(rules: FwRule[], cfg: Config, peers: Peer[], defaultAction: "deny" | "allow", forwards: Forward[] = []): Promise<{ text: string; hash: string; problems: Record<number, string> }> {
  const problems: Record<number, string> = {};
  const body: string[] = [];
  const counters: string[] = [`    counter default { }`];

  // Published ports: DNAT in prerouting (counted once per connection), an
  // accept for exactly that translated flow, and a masquerade so replies
  // come back the same way: into the tunnel for home-LAN targets, and from
  // the VM's own address for Azure targets (the workloads subnet only lets
  // in traffic that came through the VM, not straight from the internet).
  const dnat: string[] = [];
  const fwdAccept: string[] = [];
  const inputDrop: string[] = [];
  let homeTargets = false;
  let vnetTargets = false;
  for (const f of liveForwards(forwards, cfg)) {
    const src = f.allow_from ? parseCidr(f.allow_from) : null;
    counters.push(`    counter f${f.id} { }`);
    dnat.push(`    # published ${f.id}: ${f.name.replace(/[^\x20-\x7e]/g, "?")}`);
    dnat.push(`    iifname "eth0" ${src ? `ip saddr ${src.text} ` : ""}${f.proto} dport ${f.public_port} counter name "f${f.id}" dnat ip to ${f.target_ip}:${f.target_port}`);
    fwdAccept.push(`    ct status dnat ip daddr ${f.target_ip} ${f.proto} dport ${f.target_port} accept`);
    inputDrop.push(`    iifname "eth0" ${f.proto} dport ${f.public_port} drop`);
    if (forwardTargetOk(f.target_ip, { ...cfg, homeLanCidr: "" })) vnetTargets = true;
    else homeTargets = true;
  }
  for (const r of [...rules].sort((a, b) => a.position - b.position || a.id - b.id)) {
    if (!r.enabled) continue;
    const { lines, problem } = ruleLines(r, cfg, peers);
    if (problem) {
      problems[r.id] = problem;
      continue;
    }
    counters.push(`    counter r${r.id} { }`);
    // Names are the operator's; the file itself stays plain ASCII.
    body.push(`    # ${r.id}: ${r.name.replace(/[^\x20-\x7e]/g, "?")}`);
    for (const l of lines) body.push(`    ${l}`);
  }
  const deny = defaultAction === "deny";
  const core = [
    "table inet wgfw {",
    ...counters,
    "  # Top talkers: bytes per tunnel client and remote address, each way.",
    "  set up4 { type ipv4_addr . ipv4_addr; flags dynamic, timeout; timeout 2h; size 8192; counter; }",
    "  set down4 { type ipv4_addr . ipv4_addr; flags dynamic, timeout; timeout 2h; size 8192; counter; }",
    "  chain prerouting {",
    "    type nat hook prerouting priority dstnat; policy accept;",
    ...dnat,
    "  }",
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    ...(homeTargets ? [`    oifname "wg0" ct status dnat ip daddr ${cfg.homeLanCidr} masquerade`] : []),
    ...(vnetTargets ? [`    oifname "eth0" ct status dnat ip daddr ${cfg.vnetCidr} masquerade`] : []),
    "  }",
    ...(inputDrop.length
      ? [
          "  # A published port is for the server behind the VM, never the VM",
          "  # itself: anything on it that was not forwarded (the wrong source,",
          "  # or IPv6) stops here. Replies to the VM's own connections still pass.",
          "  chain input {",
          "    type filter hook input priority filter; policy accept;",
          "    ct state established,related accept",
          ...inputDrop,
          "  }",
        ]
      : []),
    "  chain accounting {",
    "    type filter hook forward priority filter - 20; policy accept;",
    `    ip saddr ${cfg.subnet} update @up4 { ip saddr . ip daddr }`,
    `    ip daddr ${cfg.subnet} update @down4 { ip daddr . ip saddr }`,
    "  }",
    "  chain forward {",
    `    type filter hook forward priority filter + 10; policy ${deny ? "drop" : "accept"};`,
    "    # Fit every new TCP connection's segments to the tunnel's path MTU.",
    "    tcp flags syn / syn,rst tcp option maxseg size set rt mtu",
    "    # Replies to allowed traffic, and nothing broken.",
    "    ct state established,related accept",
    "    ct state invalid drop",
    ...(fwdAccept.length ? ["    # Published ports: exactly the translated flows.", ...fwdAccept] : []),
    ...body,
    `    # Default: ${deny ? "deny and log (rate-limited)" : "allow"}.`,
    deny ? `    limit rate 10/second log prefix "wgfw-drop " level info` : "",
    `    counter name "default" ${deny ? "drop" : "accept"}`,
    "  }",
    "}",
  ].filter((l) => l !== "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(core.join("\n")));
  const hash = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const text = [`# ruleset ${hash} (wg-admin firewall, compiled by the dashboard)`, "table inet wgfw", "delete table inet wgfw", ...core, ""].join("\n");
  return { text, hash, problems };
}

/** The rule set a fresh install starts with: today's behaviour, written out as rules. */
export const STARTER_RULES: Omit<FwRule, "id">[] = [
  { position: 10, enabled: 1, name: "Clients to the internet (full tunnel)", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet", proto: "any", ports: "", action: "allow", log: 0 },
  { position: 20, enabled: 1, name: "Clients to the Azure VNet", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "azure", proto: "any", ports: "", action: "allow", log: 0 },
  { position: 30, enabled: 1, name: "Clients to the home LAN", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "home", proto: "any", ports: "", action: "allow", log: 0 },
  { position: 40, enabled: 1, name: "Clients to each other", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "clients", proto: "any", ports: "", action: "allow", log: 0 },
  { position: 50, enabled: 1, name: "Workloads to the internet (updates)", src_kind: "zone", src_value: "workloads", dst_kind: "zone", dst_value: "internet", proto: "any", ports: "", action: "allow", log: 0 },
];
