// views/labs/topology/nodes/GroupCard.tsx
//
// Plain English: a container on the diagram (lab topology spec §9.2): a
// resource group (dashed border, translucent fill, name top-left with region,
// role and tag chips), a VNet (Azure-blue border, address space), a subnet
// (lighter, nested, prefix and NSG / route table / delegation chips), a
// virtual hub (like a VNet with a hub chip) or a lane (a plain titled band).
// The box itself is sized by the layout; this draws its header.

import type { TopoNode } from "@shared/topology/model";
import { groupHeaderBits } from "../words";
import { TopoIcon } from "./TopoIcon";

export interface GroupCardProps {
  node: TopoNode;
  badge: string | null;
  ghost?: boolean;
  compact?: boolean;
  dim?: boolean;
  match?: boolean;
}

export function GroupCard({ node, badge, ghost = false, compact = false, dim = false, match = false }: GroupCardProps) {
  const { sub, chips } = groupHeaderBits(node);
  const cls = ["topo-group", `topo-group--${node.kind}`, ghost && "topo-group--ghost", dim && "topo-group--dim", match && "topo-group--match"].filter(Boolean).join(" ");
  return (
    <div className={cls} data-testid="topo-group">
      <div className="topo-group__head">
        {node.kind !== "lane" && <TopoIcon kind={node.kind} size={16} className="topo-group__icon" />}
        <span className="topo-group__name" title={node.label}>
          {node.label}
        </span>
        {!compact && sub && <span className="topo-group__sub topo-mono">{sub}</span>}
        {!compact &&
          chips.map((c) => (
            <span key={c} className="topo-chip">
              {c}
            </span>
          ))}
        {badge && (
          <span className={`topo-badge topo-badge--inline${ghost ? " topo-badge--ghost" : ""}`} data-testid="topo-badge">
            {badge}
          </span>
        )}
      </div>
    </div>
  );
}
