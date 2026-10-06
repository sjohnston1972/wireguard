// views/labs/topology/nodes/TopoIcon.tsx
//
// Plain English: one official Azure icon, drawn from the sprite the diagram
// inlines once into the page (icons/sprite.ts), so the icons' gradients
// resolve within the same document.

import type { TopoKind } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";

export function TopoIcon({ kind, size = 32, className }: { kind: TopoKind; size?: number; className?: string }) {
  return (
    <svg className={className ?? "topo-icon"} width={size} height={size} aria-hidden="true" focusable="false">
      <use href={`#az-${KINDS[kind].icon}`} width="100%" height="100%" />
    </svg>
  );
}
