// views/labs/LabPrerequisites.tsx
//
// Plain English: the labs worth doing first (labs redesign spec §8.5 item 6,
// ruling 5). A lab's prerequisites never block Start lab (LabDef: "never
// blocks Deploy"), so every one is "Recommended first", by its number and
// title, a link that selects that lab in the catalogue (?lab=<id>); nothing
// here deploys. One the catalogue no longer has is named by its id.

import { useId } from "react";
import { Link, useLocation } from "react-router-dom";
import type { LabCard } from "@shared/api";
import { withSelection } from "./model";
import "./LabPrerequisites.css";

export function LabPrerequisites({ ids, labs, onSelect }: { ids: readonly string[]; labs: readonly LabCard[] | undefined; onSelect: (id: string) => void }) {
  const h = useId();
  const { pathname, search } = useLocation();
  // The selection lives on the catalogue (/labs); a link from anywhere else still lands there.
  const base = pathname.startsWith("/labs") ? "/labs" : pathname;
  return (
    <section className="lab-details__section lab-prereqs" aria-labelledby={h}>
      <h3 className="lab-details__h" id={h}>
        Prerequisites
      </h3>
      {ids.length === 0 ? (
        <p className="lab-details__muted">None</p>
      ) : (
        <>
          <p className="lab-prereqs__kind">Recommended first</p>
          <ul className="lab-prereqs__list">
            {ids.map((id) => {
              const c = labs?.find((l) => l.id === id);
              if (!c)
                return (
                  <li key={id} className="lab-prereqs__item">
                    {id} (not in the catalogue)
                  </li>
                );
              const q = withSelection(new URLSearchParams(search), id).toString();
              return (
                <li key={id} className="lab-prereqs__item">
                  <Link
                    to={`${base}?${q}`}
                    onClick={(e) => {
                      // The page writes ?lab (replace on wide, push on tablet and phone): spec §9.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      onSelect(id);
                    }}
                  >
                    Lab {c.number}: {c.title}
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="lab-details__muted">Recommended, never required: Start lab works without them.</p>
        </>
      )}
    </section>
  );
}
