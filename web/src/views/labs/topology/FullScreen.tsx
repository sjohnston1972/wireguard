// views/labs/topology/FullScreen.tsx
//
// Plain English: T0 stub of the full-screen diagram (/labs/:id/diagram). T2 replaces it.

import { PlannedDiagram, type PlacementProps } from "./DiagramTab";

export function FullScreen({ labId }: PlacementProps) {
  return <PlannedDiagram labId={labId} variant="full" />;
}
