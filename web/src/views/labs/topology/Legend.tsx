// views/labs/topology/Legend.tsx
//
// Plain English: what the diagram's pictures mean (lab topology spec §9.2):
// only the kinds this diagram shows (icon and word), the two line styles in
// use, each traffic source's line colour ("from lbi-web"), and the badges in
// use.

import type { TopologyGraph, TopoKind } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import { TopoIcon } from "./nodes/TopoIcon";
import { sourceColours } from "./edges/buildEdges";
import { nodeIndex } from "./words";
import "./Legend.css";

export interface LegendProps {
  graph: TopologyGraph;
  status: Record<string, NodeDiffStatus>;
  deploying?: boolean;
}

export function Legend({ graph, status, deploying = false }: LegendProps) {
  const kinds = [...new Set(graph.nodes.map((n) => n.kind))].filter((k) => k !== "lane").sort((a: TopoKind, b: TopoKind) => KINDS[a].order - KINDS[b].order || (KINDS[a].word < KINDS[b].word ? -1 : 1));
  const keys = new Set(graph.nodes.map((n) => n.key));
  const badges = [...new Set(Object.entries(status).filter(([k]) => keys.has(k)).map(([, s]) => badgeOf(s, { deploying })).filter((b): b is string => !!b))].sort();
  const traffic = graph.edges.some((e) => e.kind === "traffic");
  const dependency = graph.edges.some((e) => e.kind === "dependency");
  const sources = sourceColours(graph, nodeIndex(graph));
  return (
    <div className="topo-legend">
      <ul className="topo-legend__list" aria-label="Kinds">
        {kinds.map((k) => (
          <li key={k}>
            <TopoIcon kind={k} size={18} />
            {KINDS[k].word}
          </li>
        ))}
      </ul>
      {(traffic || dependency) && (
        <ul className="topo-legend__list" aria-label="Lines">
          {traffic && (
            <li>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" className="topo-legend__traffic" />
              </svg>
              Traffic (solid)
            </li>
          )}
          {dependency && (
            <li>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" className="topo-legend__dependency" />
              </svg>
              Dependency (dashed)
            </li>
          )}
        </ul>
      )}
      {sources.length > 0 && (
        <ul className="topo-legend__list" aria-label="Lines by source">
          {sources.map((s) => (
            <li key={s.source}>
              <svg width="28" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="28" y2="4" className={`topo-legend__traffic topo-legend__traffic--c${s.colour}`} />
              </svg>
              {`from ${s.label}`}
            </li>
          ))}
        </ul>
      )}
      {badges.length > 0 && (
        <ul className="topo-legend__list" aria-label="Badges">
          {badges.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
