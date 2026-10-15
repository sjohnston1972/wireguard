// views/labs/topology/nodes/TopoIcon.tsx
//
// Plain English: one official icon, Azure's (az-) or, for an AWS lab's nodes
// (cloud "aws"), AWS's (aws-), drawn from the sprite the diagram inlines once
// into the page (icons/sprite.ts), so the icons' gradients resolve within the
// same document.

import type { TopoKind } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";

export function TopoIcon({ kind, size = 32, className, cloud }: { kind: TopoKind; size?: number; className?: string; cloud?: "aws" | "azure" | null }) {
  const aws = cloud === "aws" && KINDS[kind].awsIcon;
  return (
    <svg className={className ?? "topo-icon"} width={size} height={size} aria-hidden="true" focusable="false">
      <use href={aws ? `#aws-${aws}` : `#az-${KINDS[kind].icon}`} width="100%" height="100%" />
    </svg>
  );
}
