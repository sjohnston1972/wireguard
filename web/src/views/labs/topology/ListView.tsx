// views/labs/topology/ListView.tsx
//
// Plain English: the diagram as a nested list (lab topology spec §9.3): groups
// (resource group → VNet → subnet) holding their resources, each with its kind
// word, name, health word and badge. At T0 it is also what the stub Canvas
// draws; T1 finishes it (keyboard, connections) and adds the real canvas.

import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import "./ListView.css";

export interface ListViewProps {
  graph: TopologyGraph;
  status: Record<string, NodeDiffStatus>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** While the session deploys, missing reads "Not deployed yet". */
  deploying?: boolean;
}

const order = (a: TopoNode, b: TopoNode) => KINDS[a.kind].order - KINDS[b.kind].order || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function ListView({ graph, status, selected = null, onSelect, deploying = false }: ListViewProps) {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const children = new Map<string | null, TopoNode[]>();
  for (const n of graph.nodes) {
    const p = n.parent && ids.has(n.parent) ? n.parent : null;
    children.set(p, [...(children.get(p) ?? []), n]);
  }
  for (const list of children.values()) list.sort(order);

  const item = (n: TopoNode) => {
    const kids = children.get(n.id) ?? [];
    const badge = status[n.key] ? badgeOf(status[n.key]!, { deploying }) : null;
    const name = [`${KINDS[n.kind].word} ${n.label}`, n.health?.word, badge].filter(Boolean).join(", ");
    return (
      <li
        key={n.id}
        role="treeitem"
        aria-label={name}
        aria-selected={selected === n.id}
        aria-expanded={kids.length ? true : undefined}
        className="topo-list__item"
        onClick={(e) => {
          e.stopPropagation();
          onSelect?.(n.id);
        }}
      >
        <span className="topo-list__row">
          <span className="topo-list__kind">{KINDS[n.kind].word}</span> <span className="topo-list__name">{n.label}</span>
          {n.health && <span className={`topo-list__health topo-list__health--${n.health.tone}`}>{n.health.word}</span>}
          {badge && <span className="topo-list__badge">{badge}</span>}
        </span>
        {kids.length > 0 && <ul role="group">{kids.map(item)}</ul>}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label="Lab diagram (list)" className="topo-list">
      {(children.get(null) ?? []).map(item)}
    </ul>
  );
}
