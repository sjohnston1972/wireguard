// views/labs/LabCatalogueGrid.tsx
//
// Plain English: the catalogue's cards (labs redesign spec §8.4): one flat
// list in lab number order (ruling 13), three columns, two when a card would
// be narrower than about 280 px, one on the phone, decided by the grid's own
// width (a container query) so the wide panel and the tablet layout agree.
// While the catalogue loads it shows skeleton cards as tall as real ones. A
// selection by the user is announced politely ("Showing Lab 6, …"); on the
// wide layout a "Skip to lab details" link jumps past the cards to the panel.

import { useCallback, useRef, useState, type MouseEvent } from "react";
import { Skeleton } from "@/components";
import type { LabView } from "./contract";
import type { LabsLayout } from "./layout";
import { LabCard } from "./LabCard";
import "./LabCatalogueGrid.css";

export interface LabCatalogueGridProps {
  /** The labs to show, in order; null while the catalogue loads (skeleton cards). */
  views: readonly LabView[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The page's query without ?lab and ?view (stable across selections). */
  search: string;
  layout: LabsLayout;
  /** How many skeleton cards while loading (6; 3 on the phone). */
  skeletons?: number;
}

/** Focus the details panel (it takes focus without joining the tab order). */
function focusDetails(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  const panel = document.querySelector<HTMLElement>(".labs-details");
  if (!panel) return;
  if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
  panel.focus();
}

export function LabCatalogueGrid({ views, selectedId, onSelect, search, layout, skeletons = 6 }: LabCatalogueGridProps) {
  const [said, setSaid] = useState("");
  const latest = useRef({ views, onSelect });
  latest.current = { views, onSelect };
  // Stable, so a selection re-renders only the two cards whose `selected` changed.
  const select = useCallback((id: string) => {
    const v = latest.current.views?.find((x) => x.card.id === id);
    if (v) setSaid(`Showing Lab ${v.card.number}, ${v.card.title}`);
    latest.current.onSelect(id);
  }, []);
  return (
    <div className="lab-catalogue">
      {layout === "wide" && views && views.length > 0 && (
        <a className="lab-catalogue__skip" href="#lab-details" onClick={focusDetails}>
          Skip to lab details
        </a>
      )}
      {views ? (
        <ul className="lab-grid" aria-label="Labs">
          {views.map((v) => (
            <li key={v.card.id}>
              <LabCard view={v} selected={v.card.id === selectedId} onSelect={select} search={search} layout={layout} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="lab-grid" aria-label="Labs" aria-busy="true">
          {Array.from({ length: skeletons }, (_, i) => (
            <li key={i}>
              <div className="lab-card lab-card--skeleton" aria-hidden="true">
                <Skeleton variant="line" width="45%" />
                <Skeleton variant="circle" width={28} height={28} />
                <Skeleton variant="line" width="80%" height={16} />
                <Skeleton variant="line" />
                <Skeleton variant="line" width="70%" />
                <Skeleton variant="block" height={36} className="lab-card__footer-skeleton" />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="visually-hidden" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
