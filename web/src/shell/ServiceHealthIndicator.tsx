// shell/ServiceHealthIndicator.tsx
//
// Plain English: the top bar's place for the Azure Service Health pill
// (ServiceHealthPill.tsx), just before the notes bell. Nothing at all while
// Azure has no active issue in the region, which is nearly always; the
// pill's code is fetched only when there is one (code-split, like the Azure
// widgets), so the main bundle stays small.

import { useAzureSummary } from "@/api/queries";
import { lazyPart } from "@/widgets";

const Pill = lazyPart(() => import("./ServiceHealthPill").then((m) => m.ServiceHealthPill));

export function ServiceHealthIndicator() {
  const { data } = useAzureSummary();
  const lit = (data?.serviceIssues ?? []).some((e) => e.type === "ServiceIssue" && e.status === "Active");
  return lit ? <Pill /> : null;
}
