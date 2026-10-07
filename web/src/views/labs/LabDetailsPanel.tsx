// views/labs/LabDetailsPanel.tsx
//
// Plain English: the selected lab's details in their three containers (labs
// redesign spec §8.5): the wide screen's sticky panel, the tablet's right-hand
// drawer and the phone's full-width view. STUB from plan E8: each shows only
// the lab's title and badge; area C fills in the content, the launch action
// and the focus handling, keeping these three exports and DetailsProps.

import { useId } from "react";
import { Button, Drawer } from "@/components";
import type { DetailsProps } from "./contract";
import { LabStatusBadge } from "./LabStatusBadge";

/** Wide: the inline details panel beside the grid. */
export function LabDetailsPanel({ view }: DetailsProps) {
  const id = useId();
  return (
    <aside className="labs-details" aria-labelledby={view ? id : undefined} aria-label={view ? undefined : "Lab details"}>
      {view && (
        <>
          <h2 id={id}>{view.card.title}</h2>
          <LabStatusBadge badge={view.badge} />
        </>
      )}
    </aside>
  );
}

/** Tablet: the details in a right-hand drawer; `open` follows ?lab. */
export function LabDetailsDrawer({ view, open, onOpenChange }: DetailsProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Drawer side="right" open={open && !!view} onOpenChange={onOpenChange} title={view?.card.title ?? "Lab"} subtitle={view ? `Lab ${view.card.number} · ${view.card.id}` : undefined}>
      {view && <LabStatusBadge badge={view.badge} />}
    </Drawer>
  );
}

/** Phone: the details as a full-width view in place of the grid, with Back to labs. */
export function LabDetailsView({ view, onBack }: DetailsProps & { onBack: () => void }) {
  const id = useId();
  return (
    <section className="labs-details-view" aria-labelledby={view ? id : undefined}>
      <Button variant="ghost" size="sm" onClick={onBack}>
        Back to labs
      </Button>
      {view && (
        <>
          <h2 id={id}>{view.card.title}</h2>
          <LabStatusBadge badge={view.badge} />
        </>
      )}
    </section>
  );
}
