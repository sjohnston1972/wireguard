// views/labs/topology/ListView.tsx
//
// Plain English: the diagram as a nested list (lab topology spec §9.3), the
// accessible alternative to the canvas and the default for graphs over 300
// nodes. Groups (resource group → VNet → subnet) hold their resources; each
// item has the same name as its canvas node ("VM vm-app in snet-app,
// Running, private IP 10.64.0.4"), shows its kind word, health word and badge,
// and describes its connections in and out. A WAI-ARIA tree: one tab stop,
// arrows move, Right/Left expand and collapse, Home/End jump, Enter selects.

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import { matchesSearch, nodeIndex, nodeName } from "./words";
import "./ListView.css";

export interface ListViewProps {
  graph: TopologyGraph;
  status: Record<string, NodeDiffStatus>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  /** While the session deploys, missing reads "Not deployed yet". */
  deploying?: boolean;
  /** Highlights matches by name, kind word and prop values. */
  search?: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const order = (a: TopoNode, b: TopoNode) => KINDS[a.kind].order - KINDS[b.kind].order || cmp(a.label, b.label) || cmp(a.id, b.id);

export function ListView({ graph, status, selected = null, onSelect, deploying = false, search = "" }: ListViewProps) {
  const byId = useMemo(() => nodeIndex(graph), [graph]);
  const children = useMemo(() => {
    const m = new Map<string | null, TopoNode[]>();
    for (const n of graph.nodes) {
      const p = n.parent && byId.has(n.parent) && n.parent !== n.id ? n.parent : null;
      m.set(p, [...(m.get(p) ?? []), n]);
    }
    for (const list of m.values()) list.sort(order);
    return m;
  }, [graph, byId]);
  const connections = useMemo(() => {
    const m = new Map<string, string[]>();
    const add = (id: string, s: string) => m.set(id, [...(m.get(id) ?? []), s]);
    for (const e of graph.edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      const what = `${e.label ?? (e.kind === "dependency" ? "depends on" : "traffic")}${e.kind === "dependency" ? " (dependency)" : ""}${e.state ? `, ${e.state.word}` : ""}`;
      add(e.from, `to ${byId.get(e.to)!.label}: ${what}`);
      add(e.to, `from ${byId.get(e.from)!.label}: ${what}`);
    }
    // Incoming first, then outgoing, each in label order: a stable reading order.
    for (const [k, v] of m) m.set(k, [...v.filter((s) => s.startsWith("from")).sort(), ...v.filter((s) => s.startsWith("to")).sort()]);
    return m;
  }, [graph, byId]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());

  // The visible items in reading order, with their parents, for the keys.
  const visible = useMemo(() => {
    const out: { id: string; parent: string | null; hasKids: boolean }[] = [];
    const walk = (p: string | null) => {
      for (const n of children.get(p) ?? []) {
        const kids = (children.get(n.id) ?? []).length > 0;
        out.push({ id: n.id, parent: p, hasKids: kids });
        if (kids && !collapsed.has(n.id)) walk(n.id);
      }
    };
    walk(null);
    return out;
  }, [children, collapsed]);

  const tabStop = visible.some((v) => v.id === focusId) ? focusId : visible.some((v) => v.id === selected) ? selected : (visible[0]?.id ?? null);

  const move = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
    const id = target?.dataset.nodeId;
    if (!id) return;
    const i = visible.findIndex((v) => v.id === id);
    const cur = visible[i];
    if (!cur) return;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(visible[i + 1]?.id);
        break;
      case "ArrowUp":
        move(visible[i - 1]?.id);
        break;
      case "Home":
        move(visible[0]?.id);
        break;
      case "End":
        move(visible.at(-1)?.id);
        break;
      case "ArrowRight":
        if (cur.hasKids && collapsed.has(id)) setCollapsed((s) => new Set([...s].filter((x) => x !== id)));
        else if (cur.hasKids) move(visible[i + 1]?.id);
        break;
      case "ArrowLeft":
        if (cur.hasKids && !collapsed.has(id)) setCollapsed((s) => new Set([...s, id]));
        else if (cur.parent) move(cur.parent);
        break;
      case "Enter":
      case " ":
        onSelect?.(id);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const item = (n: TopoNode, level: number) => {
    const kids = children.get(n.id) ?? [];
    const open = kids.length > 0 && !collapsed.has(n.id);
    const st = status[n.key];
    const badge = st ? badgeOf(st, { deploying }) : null;
    const parent = n.parent ? byId.get(n.parent) : undefined;
    const conns = connections.get(n.id);
    const descId = `topo-list-${graph.labId}-${n.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
    const match = search.trim() !== "" && matchesSearch(n, search);
    const cls = ["topo-list__item", match && "topo-list__item--match", search.trim() !== "" && !match && "topo-list__item--dim", (st === "missing" || st === "unlisted") && "topo-list__item--ghost"].filter(Boolean).join(" ");
    return (
      <li
        key={n.id}
        ref={(el) => {
          if (el) refs.current.set(n.id, el);
          else refs.current.delete(n.id);
        }}
        role="treeitem"
        data-node-id={n.id}
        aria-label={nodeName(n, parent, badge)}
        aria-describedby={conns ? descId : undefined}
        aria-level={level}
        aria-selected={selected === n.id}
        aria-expanded={kids.length ? open : undefined}
        tabIndex={tabStop === n.id ? 0 : -1}
        className={cls}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusId(n.id);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setFocusId(n.id);
          onSelect?.(n.id);
        }}
      >
        <span className="topo-list__row">
          <span className="topo-list__kind">{n.id.startsWith("stack:") ? KINDS[n.kind].plural : KINDS[n.kind].word}</span> <span className="topo-list__name">{n.label}</span>
          {n.health && <span className={`topo-list__health topo-list__health--${n.health.tone}`}>{n.health.word}</span>}
          {badge && <span className="topo-list__badge">{badge}</span>}
          {conns && (
            <span id={descId} className="topo-list__conns">
              {`Connections: ${conns.join("; ")}`}
            </span>
          )}
        </span>
        {open && <ul role="group">{kids.map((k) => item(k, level + 1))}</ul>}
      </li>
    );
  };

  return (
    <ul role="tree" aria-label="Lab diagram (list)" className="topo-list" onKeyDown={onKeyDown}>
      {(children.get(null) ?? []).map((n) => item(n, 1))}
    </ul>
  );
}
