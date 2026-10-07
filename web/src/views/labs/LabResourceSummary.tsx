// views/labs/LabResourceSummary.tsx
//
// Plain English: "Resources deployed" in a lab's details (labs redesign spec
// §7, §8.5 item 4): what the lab's planned diagram puts in Azure, as tiles with
// the same official Azure icons as the Diagram (the sprite, fetched once), the
// first six and then a link to the diagram for the rest, plus every topic the
// lab touches. Real data only: a lab with no planned diagram says so.

import { useEffect, useId } from "react";
import { Link } from "react-router-dom";
import type { TopoKind } from "@shared/topology/model";
import { ensureSprite } from "./topology/icons/sprite";
import { TopoIcon } from "./topology/nodes/TopoIcon";
import { resourceSummary } from "./topics";
import "./LabResourceSummary.css";

/** Tiles shown before "+N more: see the diagram" (spec §7). */
export const RESOURCE_TILES = 6;

export function LabResourceSummary({ resources, topics, diagramHref }: { resources: Record<string, number> | null; topics: readonly string[]; diagramHref: string }) {
  const h = useId();
  const lines = resourceSummary(resources);
  useEffect(() => {
    if (lines.length > 0) void ensureSprite();
  }, [lines.length]);
  const shown = lines.slice(0, RESOURCE_TILES);
  const more = lines.length - shown.length;
  return (
    <section className="lab-details__section lab-resources" aria-labelledby={h}>
      <h3 className="lab-details__h" id={h}>
        Resources deployed
      </h3>
      {lines.length === 0 ? (
        <p className="lab-details__muted">Resource list unavailable</p>
      ) : (
        <ul className="lab-resources__grid">
          {shown.map((l) => (
            <li key={l.kind} className="lab-resources__tile">
              <TopoIcon kind={l.kind as TopoKind} size={24} className="lab-resources__icon" />
              <span className="lab-resources__label">{l.label}</span>
              {l.count > 1 && <span className="lab-resources__count">×{l.count}</span>}
            </li>
          ))}
          {more > 0 && (
            <li className="lab-resources__more">
              <Link to={diagramHref}>+{more} more: see the diagram</Link>
            </li>
          )}
        </ul>
      )}
      {topics.length > 0 && (
        <ul className="lab-resources__topics" aria-label="Topics">
          {topics.map((t) => (
            <li key={t} className="lab-resources__topic">
              {t}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
