// views/labs/topology/FlowCanvas.tsx
//
// Plain English: the React Flow diagram (T1.5 fills it in).

import type { CanvasProps } from "./contract";

export function FlowCanvas({ variant }: CanvasProps) {
  return <div className={`topo-canvas topo-canvas--${variant}`} role="region" aria-label="Lab diagram" />;
}
