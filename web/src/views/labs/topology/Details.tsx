// views/labs/topology/Details.tsx
//
// Plain English: the details of the node picked on the diagram (lab topology
// spec §9.2): name, kind, ARM type, where it sits, health, its props (IPs
// with copy buttons), its connections in and out, the resources drawn inside
// its card, what its badge means, whether it is planned or live, and (live
// only) a link that opens it in the Azure portal. A stack card lists its
// members. Beside the diagram on a desktop (SidePanel), a bottom sheet on
// the phone. Closing it puts focus back on the node.

import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import { SidePanel } from "@/components/layout/SidePanel";
import { KeyValue, type KeyValueItem } from "@/components/data/KeyValue";
import type { DetailsProps } from "./contract";
import { stackGraph } from "./stacks";
import { IP_PROPS, nodeIndex, propText, propTitle } from "./words";
import { TopoIcon } from "./nodes/TopoIcon";
import "./Details.css";

const MEANING: Record<NodeDiffStatus, string | null> = {
  both: null,
  added: "It is in the lab's resource groups but not in the lab's Terraform: someone made it by hand.",
  azure: "Azure made it for something the lab deployed (a managed group, a disk, an endpoint's network interface), so it is expected.",
  missing: "The lab's Terraform plans it, but the live view cannot find it in Azure.",
  unlisted: "The live view's one Resource Graph query cannot list this kind of resource (or it sits outside the lab's groups), so its state is unknown here.",
};
const DEPLOYING_MEANING = "The lab's Terraform plans it and the deploy has not made it yet.";

const SKIP = new Set(["resourceId", "chips", "tags", "counts"]);

/** "snet-app in vnet-lab in rg-lab-x": the node's containers, innermost first. */
function placeOf(node: TopoNode, byId: ReadonlyMap<string, TopoNode>): string | null {
  const names: string[] = [];
  const seen = new Set<string>();
  let p = node.parent;
  while (p && byId.has(p) && !seen.has(p)) {
    seen.add(p);
    const n = byId.get(p)!;
    names.push(n.label);
    p = n.parent;
  }
  return names.length ? names.join(" in ") : null;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

export function focusNode(id: string): void {
  const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
  const el = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${sel}"], [data-node-id="${sel}"]`);
  el?.focus();
}

export function Details({ graph, status, nodeId, onClose, deploying = false }: DetailsProps & { deploying?: boolean }) {
  const { stacked, stacks } = useMemo(() => {
    const s = stackGraph(graph);
    return { stacked: s.graph, stacks: s.stacks };
  }, [graph]);
  const byId = useMemo(() => nodeIndex(stacked), [stacked]);
  const all = useMemo(() => nodeIndex(graph), [graph]);
  const node = nodeId ? (byId.get(nodeId) ?? all.get(nodeId)) : undefined;
  if (!node) return null;

  const close = () => {
    onClose();
    // After the panel has gone (and the SidePanel has put focus back), focus the node itself.
    setTimeout(() => focusNode(node.id), 0);
  };

  const kind = KINDS[node.kind];
  const st = status[node.key];
  const badge = st ? badgeOf(st, { deploying }) : null;
  const ghost = st === "missing" || st === "unlisted";
  const members = stacks[node.id];

  const items: KeyValueItem[] = [{ label: "Kind", value: members ? `${members.length} ${kind.plural}` : kind.word }];
  if (node.armType) items.push({ label: "ARM type", value: node.armType, mono: true });
  const place = placeOf(node, byId);
  if (place) items.push({ label: "In", value: place });
  if (node.health) items.push({ label: "Health", value: <span className={`topo-health topo-health--${node.health.tone}`}>{node.health.word}</span> });
  for (const [k, v] of Object.entries(node.props)) {
    if (SKIP.has(k)) continue;
    const text = propText(k, v);
    items.push({ label: propTitle(k), value: text, mono: IP_PROPS.has(k), copy: IP_PROPS.has(k) });
  }
  const chips = [...list(node.props.chips), ...list(node.props.counts), ...list(node.props.tags)];

  const conns = graph.edges.filter((e) => e.from === node.id || e.to === node.id || (members && members.some((m) => m.id === e.from || m.id === e.to)));
  const label = (id: string) => all.get(id)?.label ?? byId.get(id)?.label ?? id;
  const resourceId = typeof node.props.resourceId === "string" ? node.props.resourceId : null;
  const portal = graph.source === "live" && !ghost && resourceId && resourceId.startsWith("/subscriptions/") ? `https://portal.azure.com/#resource${resourceId}` : null;

  return (
    <SidePanel
      open
      onClose={close}
      title={node.label}
      subtitle={kind.word}
      leading={<TopoIcon kind={node.kind} size={28} />}
      className="topo-details"
      footer={
        portal ? (
          <a className="topo-details__portal" href={portal} target="_blank" rel="noreferrer noopener">
            Open in Azure portal <ExternalLink size={14} aria-hidden />
          </a>
        ) : undefined
      }
    >
      {badge && (
        <section className="topo-details__badge" aria-label="Badge">
          <span className={`topo-badge topo-badge--inline${ghost ? " topo-badge--ghost" : ""}`}>{badge}</span>
          <p>{st === "missing" && deploying ? DEPLOYING_MEANING : MEANING[st!]}</p>
        </section>
      )}
      <KeyValue items={items} />
      {chips.length > 0 && (
        <ul className="topo-details__chips" aria-label="Settings">
          {chips.map((c) => (
            <li key={c} className="topo-chip">
              {c}
            </li>
          ))}
        </ul>
      )}
      {members && (
        <>
          <h3 className="topo-details__h">Members</h3>
          <ul className="topo-details__list" aria-label="Members">
            {members.map((m) => (
              <li key={m.id}>
                <span className="topo-details__name">{m.label}</span>
                {m.health && <span className={`topo-health topo-health--${m.health.tone}`}>{m.health.word}</span>}
                {typeof m.props.privateIp === "string" && <span className="topo-mono">{m.props.privateIp}</span>}
                {status[m.key] && <span className="topo-details__muted">{badgeOf(status[m.key]!, { deploying })}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="topo-details__h">Connections</h3>
      {conns.length ? (
        <ul className="topo-details__list" aria-label="Connections">
          {conns.map((e) => {
            const out = e.from === node.id || (members?.some((m) => m.id === e.from) ?? false);
            const other = label(out ? e.to : e.from);
            const what = e.label ?? (e.kind === "dependency" ? "depends on" : "traffic");
            return (
              <li key={e.id}>
                {`${out ? "To" : "From"} ${other}: ${what}${e.kind === "dependency" ? " (dependency)" : ""}`}
                {e.state && <span className={`topo-health topo-health--${e.state.tone}`}>{e.state.word}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="topo-details__muted">None drawn.</p>
      )}
      {node.folded && node.folded.length > 0 && (
        <>
          <h3 className="topo-details__h">Drawn inside this card</h3>
          <ul className="topo-details__list" aria-label="Drawn inside this card">
            {node.folded.map((f) => (
              <li key={f.id}>
                <span className="topo-details__name">{f.label}</span>
                {f.armType && <span className="topo-details__muted">{f.armType.split("/").slice(1).join("/")}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="topo-details__muted topo-details__source">
        {graph.source === "live"
          ? `Live: read from Azure${graph.at ? ` at ${new Date(graph.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.`
          : "Planned: from the lab's Terraform, not read from Azure."}
      </p>
    </SidePanel>
  );
}
