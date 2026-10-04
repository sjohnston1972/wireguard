// views/labs/index.tsx
//
// Plain English: the Labs tab (/labs, /labs/:id, /labs/history), loaded lazily
// by views/pages.tsx. Contract placeholder (plan L0): the page header only.
// Plan area L3 replaces this folder with the catalogue, the lab modal, the
// running strip and history; the default export stays the whole tab.

import { PageHeader } from "@/components/layout/PageHeader";
import { EnvironmentField } from "@/shell/StateChip";

export default function LabsTab() {
  return (
    <section className="placeholder">
      <PageHeader title="Labs" subtitle="On-demand AZ-104 and AZ-305 lab environments. Built in plan area L3." env={<EnvironmentField />} />
    </section>
  );
}
