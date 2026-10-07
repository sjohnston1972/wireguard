// views/labs/topology/PopOut.tsx
//
// Plain English: a lab's diagram in its own browser window (issue #93), at
// /labs/:id/diagram?popout=1, drawn chromeless (shell/Chromeless.tsx) so it
// can sit on a second screen beside the Azure portal. The same controls as
// the full screen (Live/Planned while it runs, search, dependencies, Diagram/
// List, Reset layout; the legend, MiniMap and zoom on the canvas), but no
// Close, Full screen or Pop out: the window is closed the browser's way.
// "Back to dashboard" brings the window that opened it forward, or opens the
// app in a new tab when that window has gone. The live view refreshes every
// 30 s while this window is visible (api/topology.ts); a move here is saved
// to ui_prefs like any other, and the main tab re-reads it when it gets focus.
// When the session it was showing ends, the planned design is drawn with a
// banner saying so. Focus lands on the canvas.

import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { LAB_LIVE_STATES } from "@shared/labs";
import { Placement, type PlacementProps } from "./DiagramTab";
import { LAB_ENDED_BANNER, focusOpener } from "./popOutWindow";

const isLive = (s: PlacementProps["session"]) => !!s && (LAB_LIVE_STATES as readonly string[]).includes(s.state);

export function PopOut({ labId, session = null, title, subtitle, leading }: PlacementProps & { title?: string; subtitle?: string; leading?: ReactNode }) {
  const live = isLive(session);
  // Seen running in this window: when it stops, the planned design is shown with a banner.
  const [seenLive, setSeenLive] = useState(live);
  if (live && !seenLive) setSeenLive(true);
  const ended = seenLive && !live;
  return (
    <div className="topo-full topo-popout">
      <Placement
        labId={labId}
        session={session}
        variant="full"
        popOut={false}
        autoFocus
        notice={ended ? LAB_ENDED_BANNER : null}
        header={
          <header className="topo-full__head topo-popout__head">
            {leading}
            <h1 className="topo-full__title">{title ?? labId}</h1>
            {subtitle && <span className="topo-full__sub">{subtitle}</span>}
            <a
              className="btn btn--ghost btn--sm topo-popout__back"
              href={`/labs/${encodeURIComponent(labId)}`}
              target="_blank"
              rel="noopener"
              onClick={(e) => {
                if (focusOpener()) e.preventDefault();
              }}
            >
              <ArrowLeft size={14} aria-hidden /> Back to dashboard
            </a>
          </header>
        }
      />
    </div>
  );
}
