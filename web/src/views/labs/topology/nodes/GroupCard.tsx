// views/labs/topology/nodes/GroupCard.tsx
//
// Plain English: a container on the diagram (lab topology spec §9.2): a
// resource group (dashed border, translucent fill, name top-left with region,
// role and tag chips), a VNet (Azure-blue border, address space), a subnet
// (lighter, nested, prefix and NSG / route table / delegation chips), a
// virtual hub (like a VNet with a hub chip) or a lane (a plain titled band).
// The box itself is sized by the layout; this draws its header.

import type { TopoNode } from "@shared/topology/model";
import { propText } from "../words";
import { TopoIcon } from "./TopoIcon";

export interface GroupCardProps {
  node: TopoNode;
  badge: string | null;
  ghost?: boolean;
  compact?: boolean;
  dim?: boolean;
  match?: boolean;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

function headerBits(node: TopoNode): { sub: string | null; chips: string[] } {
  const p = node.props;
  switch (node.kind) {
    case "resourceGroup":
      return { sub: null, chips: [...list(p.region), ...list(p.chips), ...list(p.tags)] };
    case "vnet":
      return {
        sub: p.addressSpace !== undefined ? propText("addressSpace", p.addressSpace) : null,
        chips: [...(p.peerTarget === true ? ["Peered to the gateway"] : []), ...(p.dnsServers !== undefined ? [`DNS ${propText("dnsServers", p.dnsServers)}`] : []), ...list(p.chips)],
      };
    case "subnet":
      return { sub: p.prefix !== undefined ? propText("prefix", p.prefix) : null, chips: list(p.chips) };
    case "virtualHub":
      return {
        sub: p.prefix !== undefined ? propText("prefix", p.prefix) : null,
        chips: ["hub", ...(p.sku !== undefined ? [String(p.sku)] : []), ...(p.routing !== undefined ? [`routing ${propText("routing", p.routing)}`] : []), ...list(p.chips)],
      };
    default:
      return { sub: null, chips: list(p.chips) };
  }
}

export function GroupCard({ node, badge, ghost = false, compact = false, dim = false, match = false }: GroupCardProps) {
  const { sub, chips } = headerBits(node);
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
