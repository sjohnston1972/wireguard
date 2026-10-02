import { useEffect, useRef, useState, type DragEvent } from "react";
import type { DraftMoveBody } from "@shared/api";
import { dropIndex, type RuleView } from "./model";

export interface ReorderOpts {
  /** Every rule in policy order (not just the filtered ones): drops land at an index in this list. */
  rows: RuleView[];
  onMove: (id: number, body: DraftMoveBody) => void;
}

/**
 * Reordering rules three ways, each sending exactly one move to the draft:
 * native drag and drop from a row's handle onto another rule's row
 * (`{to}`, the index the target holds; dropping on its own place sends
 * nothing; the default row has no handlers, so it is never a drop target),
 * Alt+Arrow on a focused row and the menu's Move up/down (`{dir}`). After a
 * keyboard move, focus follows the row to its new place.
 */
export function useReorder({ rows, onMove }: ReorderOpts) {
  const order = rows.map((r) => r.id);
  const dragging = useRef<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const follow = useRef<{ id: number; from: number } | null>(null);

  // After a keyboard move the list is refetched and the row re-rendered at its
  // new place, which drops focus to <body>: put it back on the row.
  useEffect(() => {
    const f = follow.current;
    if (!f) return;
    const el = document.querySelector<HTMLElement>(`tr[data-rule-id="${f.id}"]`);
    const active = document.activeElement;
    if (el && (active === el || active === null || active === document.body)) el.focus();
    if (order.indexOf(f.id) !== f.from) follow.current = null;
  });

  const step = (id: number, dir: "up" | "down"): boolean => {
    const i = order.indexOf(id);
    if (i < 0 || (dir === "up" && i === 0) || (dir === "down" && i === order.length - 1)) return false;
    onMove(id, { dir });
    return true;
  };

  const clear = () => {
    dragging.current = null;
    setDragId(null);
    setOverId(null);
  };

  return {
    moveByButton: (id: number, dir: "up" | "down") => void step(id, dir),
    moveByKey: (id: number, dir: "up" | "down") => {
      const from = order.indexOf(id);
      if (step(id, dir)) follow.current = { id, from };
    },
    handleProps: (r: RuleView) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        dragging.current = r.id;
        setDragId(r.id);
        const dt = e.dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          dt.setData?.("text/plain", r.name);
          const row = (e.currentTarget as HTMLElement).closest("tr");
          if (row) dt.setDragImage?.(row, 24, 24);
        }
      },
      onDragEnd: clear,
    }),
    rowProps: (r: RuleView) => ({
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        if (dragging.current === null) return;
        e.preventDefault();
        setOverId(r.id);
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (dragging.current === null) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (overId !== r.id) setOverId(r.id);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const from = dragging.current;
        clear();
        if (from === null) return;
        e.preventDefault();
        const to = dropIndex(order, from, r.id);
        if (to !== null) onMove(from, { to });
      },
    }),
    dropMark: (r: RuleView): "above" | "below" | null => {
      if (dragId === null || overId !== r.id || r.id === dragId) return null;
      return order.indexOf(dragId) < order.indexOf(r.id) ? "below" : "above";
    },
    isDragging: (r: RuleView) => dragId === r.id,
  };
}
