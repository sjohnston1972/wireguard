// views/labs/LabLaunchAction.tsx
//
// Plain English: the selected lab's one primary action (labs redesign spec
// §6.3, §8.5 item 2) and the two ways into its full details. Every action
// here only navigates or selects: "Start lab" opens the lab's dialog
// (/labs/:id), whose Deploy form is the existing confirmation (session length,
// cost, region), so nothing on the catalogue can deploy (ruling 3). A lab that
// cannot start says why, one sentence per blocker, each with the place to fix
// it. "Lab guide" and "Diagram" open the dialog's Readme and Diagram tabs.

import { useId } from "react";
import { Link, useLocation } from "react-router-dom";
import { BookOpen, Network, Play } from "lucide-react";
import type { LabBlocker, LabBlockerKind } from "@shared/api";
import { Button } from "@/components";
import type { DetailsProps, LabView } from "./contract";
import type { LabsLayout } from "./layout";
import { labHref } from "./model";
import { blockerFix, panelAction, type LabAction } from "./status";
import "./LabLaunchAction.css";

/** Focus a lab's card select button (the catalogue's `[data-lab-card]`); false when it is not on the page. */
export function focusCard(id: string): boolean {
  const el = document.querySelector<HTMLElement>(`[data-lab-card="${CSS.escape(id)}"] h3 button, [data-lab-card="${CSS.escape(id)}"] button`);
  if (!el) return false;
  el.focus();
  return true;
}

/** Focus the leftovers notice's Clean up button for a lab (the notice B renders as #labs-orphans). */
export function focusOrphanCleanup(labId: string): boolean {
  const host = document.getElementById("labs-orphans") ?? document.querySelector<HTMLElement>('[aria-label="Lab leftovers"]');
  const btn = host?.querySelector<HTMLElement>(`button[aria-label="Clean up ${CSS.escape(labId)}"]`) ?? host?.querySelector<HTMLElement>("button");
  if (!btn) return false;
  btn.scrollIntoView?.({ block: "center" });
  btn.focus();
  return true;
}

/** A card's blockers (an older Worker: its single `unavailable` sentence). */
const blockersOf = (view: LabView): LabBlocker[] =>
  Array.isArray(view.card.blockers) ? view.card.blockers : view.card.unavailable ? [{ kind: "unavailable" as LabBlockerKind, message: view.card.unavailable }] : [];

function Primary({ action, href, onSelect, describedBy }: { action: LabAction; href: string | undefined; onSelect: (id: string) => void; describedBy?: string }) {
  const cls = `btn btn--${action.variant} btn--md lab-launch__primary`;
  const icon = action.kind === "start" ? <Play size={15} aria-hidden /> : null;
  if (action.kind === "disabled")
    return (
      <Button variant={action.variant} className="lab-launch__primary" disabled icon={<Play size={15} aria-hidden />} aria-describedby={describedBy}>
        {action.label}
      </Button>
    );
  if ((action.kind === "select" || action.kind === "prerequisite") && action.labId) {
    const id = action.labId;
    return (
      <Button variant={action.variant} className="lab-launch__primary" onClick={() => onSelect(id)}>
        {action.label}
      </Button>
    );
  }
  return (
    <Link className={cls} to={href ?? action.href ?? "/labs"}>
      {icon}
      {action.label}
    </Link>
  );
}

/**
 * The launch area: the primary action, why it cannot start (when it cannot), then Lab guide and
 * Diagram. `onLeave`: the container closes itself before focus moves elsewhere on the page (the
 * tablet drawer and the phone view, for the leftovers notice's Clean up).
 */
export function LabLaunchAction({ view, layout, onSelect, data, onLeave, compact = false }: Omit<DetailsProps, "view"> & { view: LabView; onLeave?: (then: () => void) => void; compact?: boolean }) {
  const { search } = useLocation();
  const why = useId();
  const card = view.card;
  const action = panelAction(view.readiness, view.status, card);
  const href = action.href?.startsWith("/labs/") ? labHref(card.id, search, layout) : action.href;
  const shown = view.status === "none" && (view.readiness === "setup-required" || view.readiness === "unavailable") ? blockersOf(view) : [];
  const describedBy = action.kind === "disabled" ? why : undefined;
  return (
    <div className="lab-launch" role="group" aria-label="Launch">
      <Primary action={action} href={href} onSelect={onSelect} describedBy={describedBy} />
      {action.kind === "disabled" && shown.length === 0 && (
        <p className="lab-launch__detail" id={why}>
          {action.detail}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="lab-launch__reasons" aria-label="Why this lab can't start">
          {shown.map((b, i) => {
            const fix = blockerFix(b.kind, { labId: card.id, orphans: data?.orphans });
            // The primary action already is this fix (Complete setup): not again.
            const repeat = fix && action.href === fix.href && action.label === fix.label;
            return (
              <li key={`${b.kind}-${i}`} className="lab-launch__reason">
                <p id={i === 0 ? describedBy : undefined}>{b.message}</p>
                {fix && !repeat && <FixLink fix={fix} labId={card.id} layout={layout} onLeave={onLeave} />}
              </li>
            );
          })}
        </ul>
      )}
      {!compact && <SecondaryLinks id={card.id} search={search} layout={layout} />}
    </div>
  );
}

function FixLink({ fix, labId, layout, onLeave }: { fix: { label: string; href: string }; labId: string; layout: LabsLayout; onLeave?: (then: () => void) => void }) {
  if (fix.href.startsWith("#")) {
    const go = () => void focusOrphanCleanup(labId);
    return (
      <a
        className="lab-launch__fix"
        href={fix.href}
        onClick={(e) => {
          e.preventDefault();
          if (layout !== "wide" && onLeave) onLeave(go);
          else go();
        }}
      >
        {fix.label}
      </a>
    );
  }
  return (
    <Link className="lab-launch__fix" to={fix.href}>
      {fix.label}
    </Link>
  );
}

/** Lab guide (the dialog's Readme tab) and Diagram (its Diagram tab). */
export function SecondaryLinks({ id, search, layout }: { id: string; search: string; layout: LabsLayout }) {
  return (
    <nav className="lab-launch__more" aria-label="Lab guide and diagram">
      <Link className="btn btn--secondary btn--sm" to={labHref(id, search, layout)}>
        <BookOpen size={14} aria-hidden />
        Lab guide
      </Link>
      <Link className="btn btn--secondary btn--sm" to={labHref(id, search, layout, "diagram")}>
        <Network size={14} aria-hidden />
        Diagram
      </Link>
    </nav>
  );
}
