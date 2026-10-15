// views/labs/CloudBadge.tsx
//
// Plain English: the small "AWS" badge a lab wears wherever it is listed (catalogue
// card, running-labs chip, Overview widget). A word, never colour alone; an Azure
// lab wears nothing. Kept in its own tiny module so the lazy Overview widget can use
// it without pulling in the labs views.

import type { LabCloud } from "@shared/labs";
import { StatusPill } from "@/components";

export function CloudBadge({ cloud }: { cloud: LabCloud }) {
  return cloud === "aws" ? <StatusPill status="custom" label="AWS" tone="amber" dot={false} /> : null;
}
