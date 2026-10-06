// views/labs/topology/nodes/AssetCard.tsx
//
// Plain English: a resource's card on the diagram (lab topology spec §9.2): a
// fixed 200 × 84 bento tile with its Azure icon, name (full name on hover),
// type word, one or two key props and a health chip in words. A database's
// status is the large chip. A badge on the top edge says when it was added
// by hand, made by Azure, or is planned but missing (a ghost: dashed, faded).

import type { TopoNode } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { cardProps, databaseStatus, IP_PROPS, propLabel, propText } from "../words";
import { TopoIcon } from "./TopoIcon";

export interface AssetCardProps {
  node: TopoNode;
  badge: string | null;
  ghost?: boolean;
  /** The mini variant: icon and name only. */
  compact?: boolean;
  dim?: boolean;
  match?: boolean;
}

export function AssetCard({ node, badge, ghost = false, compact = false, dim = false, match = false }: AssetCardProps) {
  const kind = KINDS[node.kind];
  const db = compact ? null : databaseStatus(node);
  const stack = node.id.startsWith("stack:");
  const cls = ["topo-card", `topo-card--${node.kind}`, ghost && "topo-card--ghost", dim && "topo-card--dim", match && "topo-card--match", stack && "topo-card--stack", compact && "topo-card--compact", node.kind === "gateway" && "topo-card--gateway"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} data-testid="topo-asset">
      {badge && (
        <span className={`topo-badge${ghost ? " topo-badge--ghost" : ""}`} data-testid="topo-badge">
          {badge}
        </span>
      )}
      <TopoIcon kind={node.kind} size={compact ? 24 : 32} />
      <div className="topo-card__text">
        <span className="topo-card__name" title={node.label}>
          {node.label}
        </span>
        {!compact && <span className="topo-card__kind">{stack ? kind.plural : kind.word}</span>}
        {!compact && (
          <span className="topo-card__props">
            {cardProps(node).map(([p, v]) => (
              <span key={p} className={IP_PROPS.has(p) ? "topo-card__prop topo-mono" : "topo-card__prop"} title={propLabel(p)}>
                {propText(p, v)}
              </span>
            ))}
          </span>
        )}
      </div>
      {db ? (
        <span className={`topo-health topo-health--large topo-health--${db.tone}`}>{db.word}</span>
      ) : (
        !compact && node.health && <span className={`topo-health topo-health--${node.health.tone}`}>{node.health.word}</span>
      )}
    </div>
  );
}
