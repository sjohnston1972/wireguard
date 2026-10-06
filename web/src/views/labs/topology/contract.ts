// views/labs/topology/contract.ts
//
// Plain English: the props the diagram's parts agree on (lab topology plan,
// T0 names). T1 builds the canvas, toolbar and details panel behind these;
// T2 places them (the Diagram tab, the full screen, the Overview hover). A
// change goes through the integrator, with the plan's names section.

import type { TopologyGraph } from "@shared/topology/model";
import type { NodeDiffStatus } from "@shared/topology/diff";
import type { TopologyLayout } from "@shared/topology/layout";

export type DiagramVariant = "tab" | "full" | "mini";

export interface CanvasProps {
  /** From mergeForView (live + ghosts) or the planned graph. */
  graph: TopologyGraph;
  /** By node key; {} for planned. */
  status: Record<string, NodeDiffStatus>;
  /** null: none, or failed to load. */
  saved: TopologyLayout | null;
  /** Absent in mini. */
  onMove?: (key: string, at: { x: number; y: number; p: string | null }) => void;
  view: "diagram" | "list";
  showDependencies: boolean;
  search: string;
  variant: DiagramVariant;
  /** Node id. */
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** The session is deploying: a missing node's badge reads "Not deployed yet" (badgeOf's `deploying`). T2 addition. */
  deploying?: boolean;
}

export interface ToolbarProps {
  source: "live" | "planned" | null;
  onSource?: (s: "live" | "planned") => void;
  search: string;
  onSearch: (s: string) => void;
  showDependencies: boolean;
  onDependencies: (b: boolean) => void;
  view: "diagram" | "list";
  onView: (v: "diagram" | "list") => void;
  onReset?: () => void;
  fullScreenHref?: string;
  onClose?: () => void;
  variant: DiagramVariant;
}

export interface DetailsProps {
  graph: TopologyGraph;
  status: Record<string, NodeDiffStatus>;
  nodeId: string | null;
  onClose: () => void;
}
