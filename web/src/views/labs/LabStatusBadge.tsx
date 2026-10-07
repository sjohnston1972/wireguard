// views/labs/LabStatusBadge.tsx
//
// Plain English: a lab's status badge on its card and in its details (labs
// redesign spec §6.3): the word and tone statusBadge chose, as the shared
// StatusPill, so it is always a dot and a word, never colour alone.

import { StatusPill } from "@/components";
import type { LabBadge } from "./status";

export function LabStatusBadge({ badge, className }: { badge: LabBadge; className?: string }) {
  return <StatusPill status="unknown" label={badge.label} tone={badge.tone} className={className} />;
}
