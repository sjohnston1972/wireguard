// shell/ServiceHealthIndicator.tsx
//
// Plain English: the top bar's Azure Service Health pill, beside the notes
// bell (spec 2026-10-04-azure-insights-design.md, section 10.2). It shows
// only while Azure has an active issue affecting VMs or networking in the
// configured region (useAzureSummary().data.serviceIssues), and never for
// planned maintenance. X0 mounts it rendering nothing; area X4 fills it.

export function ServiceHealthIndicator(): null {
  return null;
}
