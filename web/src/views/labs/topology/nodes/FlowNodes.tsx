// views/labs/topology/nodes/FlowNodes.tsx
//
// Plain English: the two React Flow node types, a group box and an asset
// card, each with a handle on all four sides (hidden: nothing is connected
// by hand; edges pick the nearest sides themselves).

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { TopoFlowNode } from "../flowNodes";
import { AssetCard } from "./AssetCard";
import { GroupCard } from "./GroupCard";

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

function Handles() {
  return (
    <>
      {SIDES.map((p) => (
        <Handle key={p} id={p} type="source" position={p} isConnectable={false} className="topo-handle" />
      ))}
    </>
  );
}

export const AssetFlowNode = memo(function AssetFlowNode({ data }: NodeProps<TopoFlowNode>) {
  return (
    <>
      <Handles />
      <AssetCard node={data.node} badge={data.badge} ghost={data.ghost} compact={data.compact} dim={data.dim} match={data.match} />
    </>
  );
});

export const GroupFlowNode = memo(function GroupFlowNode({ data }: NodeProps<TopoFlowNode>) {
  return (
    <>
      <Handles />
      <GroupCard node={data.node} badge={data.badge} ghost={data.ghost} compact={data.compact} dim={data.dim} match={data.match} />
    </>
  );
});

export const NODE_TYPES = { topoAsset: AssetFlowNode, topoGroup: GroupFlowNode };
