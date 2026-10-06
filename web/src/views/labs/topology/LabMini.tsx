// views/labs/topology/LabMini.tsx
//
// Plain English: T0 stub of the mini diagram on the Overview hover. T2 replaces it.

import { PlannedDiagram, type PlacementProps } from "./DiagramTab";

export function LabMini({ labId }: PlacementProps) {
  return <PlannedDiagram labId={labId} variant="mini" />;
}
