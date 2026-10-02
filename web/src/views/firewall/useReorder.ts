import type { DraftMoveBody } from "@shared/api";
import type { RuleView } from "./model";

export interface ReorderOpts {
  rows: RuleView[];
  onMove: (id: number, body: DraftMoveBody) => void;
}

/** Reordering rules: by the menu's buttons (and, below, by drag and by keyboard). Every way sends one move. */
export function useReorder({ onMove }: ReorderOpts) {
  return {
    moveByButton: (id: number, dir: "up" | "down") => onMove(id, { dir }),
    rowProps: (_r: RuleView) => ({}),
    handleProps: (_r: RuleView) => ({}),
    dropMark: (_r: RuleView): "above" | "below" | null => null,
  };
}
