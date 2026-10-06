// views/labs/topology/Canvas.tsx
//
// Plain English: the T0 stub of the diagram canvas. It honours CanvasProps
// (contract.ts) but draws the List view; T1 replaces it with the React Flow
// canvas behind the same props.

import type { CanvasProps } from "./contract";
import { ListView } from "./ListView";

export function Canvas({ graph, status, selected, onSelect, deploying }: CanvasProps) {
  return <ListView graph={graph} status={status} selected={selected} onSelect={onSelect} deploying={deploying} />;
}
