// views/labs/topology/DiagramTab.tsx
//
// Plain English: T0 stub of the lab panel's Diagram tab: the lab's planned
// graph on the stub Canvas. T2 replaces it (live data, saved layout, toolbar).

import { useState } from "react";
import { usePlannedTopology } from "@/api/topology";
import { Canvas } from "./Canvas";
import type { DiagramVariant } from "./contract";

export interface PlacementProps {
  labId: string;
}

/** The planned graph of `labId` drawn in one variant (shared by the T0 stubs). */
export function PlannedDiagram({ labId, variant }: PlacementProps & { variant: DiagramVariant }) {
  const q = usePlannedTopology(labId);
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isError) return <p role="alert">Could not load the diagram: {q.error.message}</p>;
  if (!q.data) return <p>Loading the diagram…</p>;
  return <Canvas graph={q.data} status={{}} saved={null} view="list" showDependencies search="" variant={variant} selected={selected} onSelect={setSelected} />;
}

export function DiagramTab({ labId }: PlacementProps) {
  return <PlannedDiagram labId={labId} variant="tab" />;
}
