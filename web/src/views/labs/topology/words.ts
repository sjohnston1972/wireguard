// views/labs/topology/words.ts
//
// Plain English: how the diagram says things in words (lab topology spec
// §9.2-§9.3): a prop's name and value as text, a node's accessible name ("VM
// vm-app in snet-app, Running, private IP 10.64.0.4") and an edge's ("lb-svc to
// vm-svc: TCP 80→80"). The canvas, the details panel and the List view share
// these, so every view uses the same words.

import type { TopologyGraph, TopoEdge, TopoNode, TopoPropValue } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";

const LABELS: Record<string, string> = {
  region: "region",
  zones: "zones",
  sku: "SKU",
  tier: "tier",
  size: "size",
  os: "OS",
  instances: "instances",
  autoscale: "autoscale",
  privateIp: "private IP",
  publicIp: "public IP",
  addressSpace: "address space",
  prefix: "prefix",
  dnsServers: "DNS servers",
  allocation: "allocation",
  ports: "ports",
  asn: "ASN",
  bgp: "BGP",
  vpnType: "VPN type",
  clientPool: "client pool",
  groupId: "group id",
  target: "target",
  accountKind: "account kind",
  accessTier: "access tier",
  replication: "replication",
  publicAccess: "public access",
  apiKind: "API",
  consistency: "consistency",
  capacity: "capacity",
  retentionDays: "retention (days)",
  dailyCapGb: "daily cap (GB)",
  cpu: "CPU",
  memoryGb: "memory (GB)",
  ingress: "ingress",
  targetPort: "target port",
  routing: "routing",
  hostName: "host name",
  effect: "effect",
  enforcement: "enforcement",
  scopeAccess: "scope access",
  mode: "mode",
  status: "status",
  counts: "contents",
  chips: "settings",
  tags: "tags",
  peerTarget: "peered to the gateway",
  group: "group",
  resourceId: "resource id",
};

/** A prop's name in words, lower case ("private IP"). */
export const propLabel = (name: string): string => LABELS[name] ?? name;
/** A prop's name with a capital first letter, for a heading or a details row. */
export const propTitle = (name: string): string => {
  const l = propLabel(name);
  return l.charAt(0).toUpperCase() + l.slice(1);
};

/** A prop's value as text: lists joined by commas, true/false as on/off. */
export function propText(name: string, v: TopoPropValue): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return name === "peerTarget" ? (v ? "yes" : "no") : v ? "on" : "off";
  return String(v);
}

const textList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

/** What a container's header says after its name: a mono sub-line (an address) and chips. The layout sizes headers from it. */
export function groupHeaderBits(node: TopoNode): { sub: string | null; chips: string[] } {
  const p = node.props;
  switch (node.kind) {
    case "resourceGroup":
      return { sub: null, chips: [...textList(p.region), ...textList(p.chips), ...textList(p.tags)] };
    case "vnet":
      return {
        sub: p.addressSpace !== undefined ? propText("addressSpace", p.addressSpace) : null,
        chips: [...(p.peerTarget === true ? ["Peered to the gateway"] : []), ...(p.dnsServers !== undefined ? [`DNS ${propText("dnsServers", p.dnsServers)}`] : []), ...textList(p.chips)],
      };
    case "subnet":
      return { sub: p.prefix !== undefined ? propText("prefix", p.prefix) : null, chips: textList(p.chips) };
    case "virtualHub":
      return {
        sub: p.prefix !== undefined ? propText("prefix", p.prefix) : null,
        chips: ["hub", ...(p.sku !== undefined ? [String(p.sku)] : []), ...(p.routing !== undefined ? [`routing ${propText("routing", p.routing)}`] : []), ...textList(p.chips)],
      };
    default:
      return { sub: null, chips: textList(p.chips) };
  }
}

/** About how wide a container's header is drawn (name, address, chips): from character counts at its type sizes. */
export function headerTextWidth(node: TopoNode, bits: { sub: string | null; chips: string[] } = groupHeaderBits(node)): number {
  const subnet = node.kind === "subnet";
  let w = (subnet ? 20 : 24) + (node.kind === "lane" ? 0 : 22) + node.label.length * (subnet ? 6.6 : 7);
  if (bits.sub) w += 6 + bits.sub.length * 6.7;
  for (const c of bits.chips) w += 6 + 16 + c.length * 5.9;
  return Math.ceil(w);
}

/** Props that hold IP addresses (copy buttons, mono type). */
export const IP_PROPS: ReadonlySet<string> = new Set(["privateIp", "publicIp", "addressSpace", "prefix", "dnsServers", "clientPool"]);

/** Kinds whose status is the card's large chip (spec §9.2: databases prominent). */
export const DATABASE_KINDS: ReadonlySet<string> = new Set(["sqlDatabase", "cosmos"]);

/** The 1-2 props a card shows: its kind's card props that are set (never chips, tags or a database's status). */
export function cardProps(node: TopoNode): [string, TopoPropValue][] {
  const out: [string, TopoPropValue][] = [];
  for (const p of KINDS[node.kind].cardProps) {
    if (p === "chips" || p === "tags") continue;
    if (p === "status" && DATABASE_KINDS.has(node.kind)) continue;
    const v = node.props[p];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out.push([p, v]);
    if (out.length === 2) break;
  }
  return out;
}

/** A database's status word (its status prop, else its health word), or null. */
export function databaseStatus(node: TopoNode): { tone: "ok" | "warn" | "bad" | "unknown"; word: string } | null {
  if (!DATABASE_KINDS.has(node.kind)) return null;
  const s = node.props.status;
  if (node.health) return node.health;
  if (typeof s === "string" && s) return { tone: /online|succeeded|ready/i.test(s) ? "ok" : "unknown", word: s };
  return null;
}

/** The first key prop of a node in words ("private IP 10.71.192.4"), or null. */
export function keyPropWords(node: TopoNode): string | null {
  const kind = KINDS[node.kind];
  const names = kind.cardProps.length ? kind.cardProps : ["prefix", "addressSpace"];
  for (const p of ["privateIp", ...names]) {
    if (p === "chips" || p === "tags") continue;
    if (p === "privateIp" && !names.includes("privateIp")) continue;
    const v = node.props[p];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    return `${propLabel(p)} ${propText(p, v)}`;
  }
  return null;
}

/** A node's accessible name: kind word, name, parent, health, badge and key prop. */
export function nodeName(node: TopoNode, parent: TopoNode | undefined, badge: string | null): string {
  const head = node.id.startsWith("stack:") ? node.label : `${KINDS[node.kind].word} ${node.label}`;
  const first = parent ? `${head} in ${parent.label}` : head;
  return [first, node.health?.word, badge, keyPropWords(node)].filter(Boolean).join(", ");
}

/** An edge's accessible name: "lb-svc to vm-svc: TCP 80→80" (and its state). */
export function edgeName(edge: TopoEdge, byId: ReadonlyMap<string, TopoNode>): string {
  const from = byId.get(edge.from)?.label ?? edge.from;
  const to = byId.get(edge.to)?.label ?? edge.to;
  const label = edge.label ?? (edge.kind === "dependency" ? "depends on" : "traffic");
  return `${from} to ${to}: ${label}${edge.state ? `, ${edge.state.word}` : ""}`;
}

/** Whether a node matches a search: its name, kind word or any prop value (case-insensitive). */
export function matchesSearch(node: TopoNode, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (node.label.toLowerCase().includes(s)) return true;
  if (KINDS[node.kind].word.toLowerCase().includes(s) || KINDS[node.kind].plural.toLowerCase().includes(s)) return true;
  for (const [k, v] of Object.entries(node.props)) if (k !== "resourceId" && propText(k, v).toLowerCase().includes(s)) return true;
  return false;
}

/** id → node, for lookups. */
export const nodeIndex = (g: TopologyGraph): Map<string, TopoNode> => new Map(g.nodes.map((n) => [n.id, n]));
