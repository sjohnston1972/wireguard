// shared/topology/diff.ts
//
// Plain English: a running lab's planned and live diagrams side by side (lab
// topology spec §7). Nodes are matched on their key (ruling 6):
//
//   both      in both: the live card, live props, live health
//   added     live only, not made by Azure: "Added by hand"
//   azure     live only, made by Azure: "Made by Azure" (muted)
//   missing   planned only, a kind the live query lists, in the lab's groups:
//             a ghost card "Not deployed or removed" ("Not deployed yet"
//             while the session deploys)
//   unlisted  planned only, a kind the query cannot list or a resource
//             outside the lab's groups: a ghost "Not listed by the live view"
//
// mergeForView gives the live graph plus the ghosts, each ghost under its
// planned parent's live twin (by key), with its planned edges. rebaseSlot
// moves a planned graph's example addresses (slot 31's /18, the mock plan's)
// into a session's own /18 (ruling 23).

import { sortGraph, type TopoEdge, type TopologyGraph, type TopoNode } from "./model";
import { KINDS } from "./kinds";

export type NodeDiffStatus = "both" | "added" | "missing" | "azure" | "unlisted";

/** Slot 31's /18: the addresses in every planned graph (labs-tf's mock plan). */
export const MOCK_SLOT = "10.71.192.0/18";

const SYNTHETIC = new Set(["wg/gateway", "lane/global"]);

/** The status of every key in either graph. */
export function diffGraphs(planned: TopologyGraph, live: TopologyGraph, _opts: { deploying?: boolean } = {}): { status: Record<string, NodeDiffStatus> } {
  const status: Record<string, NodeDiffStatus> = {};
  const liveKeys = new Map(live.nodes.map((n) => [n.key, n]));
  const plannedKeys = new Map(planned.nodes.map((n) => [n.key, n]));
  for (const [k, n] of liveKeys) status[k] = plannedKeys.has(k) || SYNTHETIC.has(k) ? "both" : n.madeBy === "azure" ? "azure" : "added";
  for (const [k, n] of plannedKeys) {
    if (liveKeys.has(k)) continue;
    const listed = n.kind === "lane" ? k === "lane/global" : KINDS[n.kind].liveVisible;
    status[k] = listed && n.scope !== "outside" ? "missing" : "unlisted";
  }
  return { status };
}

/** The badge words of a status (null: no badge). */
export function badgeOf(status: NodeDiffStatus, opts: { deploying?: boolean } = {}): string | null {
  switch (status) {
    case "added":
      return "Added by hand";
    case "azure":
      return "Made by Azure";
    case "missing":
      return opts.deploying ? "Not deployed yet" : "Not deployed or removed";
    case "unlisted":
      return "Not listed by the live view";
    default:
      return null;
  }
}

/** The live graph plus ghosts (planned-only nodes and their edges), with every key's status. */
export function mergeForView(planned: TopologyGraph, live: TopologyGraph, opts: { deploying?: boolean } = {}): { graph: TopologyGraph; status: Record<string, NodeDiffStatus> } {
  const { status } = diffGraphs(planned, live, opts);
  const liveByKey = new Map(live.nodes.map((n) => [n.key, n.id]));
  const plannedById = new Map(planned.nodes.map((n) => [n.id, n]));
  const liveIds = new Set(live.nodes.map((n) => n.id));
  /** A planned node's id in the merged graph: its live twin's, else its own (a ghost). */
  const mapped = (plannedId: string): string | null => {
    const n = plannedById.get(plannedId);
    if (!n) return null;
    return liveByKey.get(n.key) ?? n.id;
  };
  const ghosts: TopoNode[] = [];
  for (const n of planned.nodes) {
    if (liveByKey.has(n.key)) continue;
    const g: TopoNode = { ...n, props: { ...n.props } };
    delete g.health;
    if (n.parent) {
      const p = mapped(n.parent);
      if (p) g.parent = p;
      else delete g.parent;
    }
    if (liveIds.has(g.id)) continue; // never clash with a live id
    ghosts.push(g);
  }
  const ghostIds = new Set(ghosts.map((n) => n.id));
  const edges = new Map<string, TopoEdge>(live.edges.map((e) => [e.id, e]));
  const pair = (kind: string, a: string, b: string) => `${kind}|${a < b ? `${a}|${b}` : `${b}|${a}`}`;
  const livePairs = new Set(live.edges.map((e) => pair(e.kind, e.from, e.to)));
  for (const e of planned.edges) {
    const from = mapped(e.from);
    const to = mapped(e.to);
    if (!from || !to || from === to) continue;
    const id = `ghost:${e.id}`;
    if (ghostIds.has(from) || ghostIds.has(to)) edges.set(id, { ...e, id, from, to });
    // Both ends live but the live view draws nothing between them: a child or link Resource Graph does not return
    // (Front Door origins, hub and BGP connections, forwarding rules, failover groups, DNS zone groups, AVNM members,
    // backup items, DCR associations, diagnostic settings). Shown from the plan, never as "not deployed".
    else if (!livePairs.has(pair(e.kind, from, to))) edges.set(id, { ...e, id, from, to, state: { tone: "unknown", word: badgeOf("unlisted")! } });
  }
  return { graph: sortGraph({ ...live, nodes: [...live.nodes, ...ghosts], edges: [...edges.values()] }), status };
}

// ── Addresses ────────────────────────────────────────────────────────────

const ipToInt = (ip: string): number => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
const IPV4 = /\b(\d{1,3}(?:\.\d{1,3}){3})(\/\d{1,2})?\b/g;

function rebaseText(s: string, from: [number, number], to: number): string {
  return s.replace(IPV4, (m, ip: string, len: string | undefined) => {
    if (ip.split(".").some((x) => Number(x) > 255)) return m;
    const n = ipToInt(ip);
    if (n < from[0] || n > from[1]) return m;
    return `${intToIp(to + (n - from[0]))}${len ?? ""}`;
  });
}

/** A copy with every IPv4 address and CIDR inside MOCK_SLOT moved into `cidr` (a /18). */
export function rebaseSlot(graph: TopologyGraph, cidr: string): TopologyGraph {
  const [base, bits] = MOCK_SLOT.split("/");
  const start = ipToInt(base!);
  const range: [number, number] = [start, start + 2 ** (32 - Number(bits)) - 1];
  const to = ipToInt(cidr.split("/")[0]!);
  const t = (s: string) => rebaseText(s, range, to);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => ({
      ...n,
      props: Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, typeof v === "string" ? t(v) : Array.isArray(v) ? v.map(t) : v])),
    })),
    edges: graph.edges.map((e) => (e.label ? { ...e, label: t(e.label) } : { ...e })),
  };
}
