import type { RefObject } from "react";
import type { FirewallResponse } from "@shared/api";
import type { CaptureFormHandle } from "./Capture";
import type { RuleView } from "./model";

export interface FirewallPhoneProps {
  fw: FirewallResponse;
  rows: RuleView[];
  waiting: boolean;
  updatedAt: number;
  sheet: string | null;
  onSheet: (s: string | null) => void;
  onReview: () => void;
  onAddRule: () => void;
  onAddForward: () => void;
  onEditForward: (f: FirewallResponse["forwards"][number]) => void;
  captureRef: RefObject<CaptureFormHandle | null>;
}

/** The phone composition (built in the next step). */
export function FirewallPhone(_p: FirewallPhoneProps) {
  return <h1>Firewall</h1>;
}
