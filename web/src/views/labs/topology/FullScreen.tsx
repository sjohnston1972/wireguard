// views/labs/topology/FullScreen.tsx
//
// Plain English: a lab's diagram filling the page at /labs/:id/diagram (lab
// topology spec §9.1): a header with the lab's title, the controls (Live/
// Planned while it runs, search, dependencies, Diagram/List, Reset layout,
// Close), the canvas in its full variant (MiniMap and Controls, but no
// MiniMap on the phone) and the details beside it. Close goes back to the
// lab's panel at /labs/:id, keeping the query string (filters, ?view=diagram).

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Placement, type PlacementProps } from "./DiagramTab";

export function FullScreen({ labId, session = null, title, subtitle, leading }: PlacementProps & { title?: string; subtitle?: string; leading?: ReactNode }) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const close = () => navigate({ pathname: `/labs/${encodeURIComponent(labId)}`, search });
  return (
    <div className="topo-full">
      <Placement
        labId={labId}
        session={session}
        variant="full"
        onClose={close}
        header={
          <header className="topo-full__head">
            {leading}
            <h1 className="topo-full__title">{title ?? labId}</h1>
            {subtitle && <span className="topo-full__sub">{subtitle}</span>}
          </header>
        }
      />
    </div>
  );
}
