// views/labs/LabDetailsPanel.tsx
//
// Plain English: the selected lab's details in their three containers (labs
// redesign spec §8.5, §9, §10): the wide screen's sticky panel beside the
// grid, the tablet's right-hand drawer and the phone's full-width view. Each
// shows the same summary: the lab's number, id, title and badge, its one
// primary action, the objective and what you will learn, the resources it
// deploys, learning time, deploy time, cost and session length (each labelled
// as such), the destination region and deploy warnings (GET /labs/:id),
// prerequisites (recommended, never blocking), history, the lab guide as a
// PDF ("Download PDF"), and what happens when the session ends. The lab's dialog (/labs/:id) stays the full details: the
// readme, the diagram, the Deploy confirmation and the running controls.
// Selecting a lab never deploys anything.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Check, ChevronLeft } from "lucide-react";
import type { LabCard, LabsResponse } from "@shared/api";
import { Button, Drawer, Skeleton } from "@/components";
import { useLab } from "@/api/queries";
import { regionLabel } from "@/shell/StateChip";
import type { DetailsProps, LabView } from "./contract";
import { LabGuideButton } from "./LabGuideButton";
import { LabLaunchAction, focusCard } from "./LabLaunchAction";
import { LabPrerequisites } from "./LabPrerequisites";
import { LabResourceSummary } from "./LabResourceSummary";
import { LabStatusBadge } from "./LabStatusBadge";
import type { LabsLayout } from "./layout";
import { fmtHourlyPrecise, fmtMinutes, fmtSessionCost } from "./money";
import { LEVEL_WORD, TYPE_WORD, endsAt, examsWord, fmtClock, fmtWhen, labHref } from "./model";
import { Warnings } from "./Warnings";
import "./LabDetailsPanel.css";

const PEERING_WORD = { off: "Off", optional: "Optional", required: "Required" } as const;

/** The current version's measured deploy ("measured 4 min 23 s") when its release test timed one, else null. */
function measuredDeploy(card: LabCard): string | null {
  const t = card.lastReleaseTest;
  if (!t || t.version !== card.version || t.deploySeconds === null || !(t.deploySeconds > 0)) return null;
  const m = Math.floor(t.deploySeconds / 60);
  const s = Math.round(t.deploySeconds % 60);
  return `measured ${m > 0 ? `${m} min ` : ""}${s} s`;
}

/** "UK South (uksouth)": the region's name and the code the deploy uses; the code alone when it is not one we know. */
function regionWords(code: string): string {
  const name = regionLabel(code);
  return name && name !== code ? `${name} (${code})` : code;
}

/** Keep a figure and its unit together ("2 h" never breaks before the h). */
const keepUnits = (s: string) => s.replace(/ (h|min|s)\b/g, "\u00a0$1");

/** Session length, or for a live session when it ends. */
function sessionWords(card: LabCard): string {
  const s = card.running;
  if (s) return `Ends ${fmtClock(endsAt(s))} unless extended (hard stop ${fmtClock(s.maxUntil)})`;
  return `${card.timing.sessionH} h, extendable to ${card.timing.maxH} h`;
}

function historyWords(card: LabCard): string {
  if (card.runs <= 0) return "Not run yet";
  const last = card.lastSession?.endedAt;
  return last ? `Run ${card.runs}×, last ${fmtWhen(last)}` : `Run ${card.runs}×`;
}

/** A fact row; `value` null shows "no data" (never a made-up figure). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  const none = children === null || children === undefined || children === "";
  return (
    <div className="lab-facts__row">
      <dt>{label}</dt>
      <dd className={none ? "lab-facts__none" : undefined}>{none ? "no data" : children}</dd>
    </div>
  );
}

/** The heading block: "Lab 6 · AZ-104", the id, the title (wide and phone; the drawer has its own title) and the badge. */
function DetailsHead({ view, headingId, titleRef, showTitle = true }: { view: LabView; headingId?: string; titleRef?: React.Ref<HTMLHeadingElement>; showTitle?: boolean }) {
  const c = view.card;
  return (
    <header className="lab-details__head">
      <p className="lab-details__eyebrow">
        <span>
          Lab {c.number} · {examsWord(c)}
        </span>
        <code className="lab-details__id">{c.id}</code>
      </p>
      {showTitle && (
        <h2 className="lab-details__title" id={headingId} ref={titleRef} tabIndex={titleRef ? -1 : undefined}>
          {c.title}
        </h2>
      )}
      <LabStatusBadge badge={view.badge} className="lab-details__badge" />
    </header>
  );
}

/** The deploy checks from GET /labs/:id (one per selected lab, cached): warnings, a skeleton while loading, Retry when it fails. */
function Checks({ q, card }: { q: ReturnType<typeof useLab>; card: LabCard }) {
  const h = useId();
  const d = q.data;
  // The launch action above already says each blocker's sentence (with its fix): never twice.
  const said = new Set((card.blockers ?? []).map((b) => b.message));
  const warnings = d ? d.warnings.filter((w) => !said.has(w.message)) : [];
  const dropped = d ? d.warnings.length - warnings.length : 0;
  return (
    <section className="lab-details__section" aria-labelledby={h} aria-busy={!d && !q.isError ? true : undefined}>
      <h3 className="lab-details__h" id={h}>
        Deploy checks
      </h3>
      {d ? (
        warnings.length > 0 ? (
          <Warnings warnings={warnings} />
        ) : (
          <p className="lab-details__muted">{d.session ? "A session is live: see it in the lab's dialog." : dropped > 0 ? "No other warnings for a deploy." : "No warnings for a deploy now."}</p>
        )
      ) : q.isError ? (
        <p className="lab-details__retry">
          <span>Couldn't load the deploy checks.</span>
          <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </p>
      ) : (
        <div className="lab-details__lines">
          <Skeleton width="90%" />
          <Skeleton width="70%" />
        </div>
      )}
    </section>
  );
}

/** Everything below the launch action: the same in all three containers. */
function DetailsBody({ view, data, layout, onSelect }: { view: LabView; data: LabsResponse | undefined; layout: LabsLayout; onSelect: (id: string) => void }) {
  const c = view.card;
  const { search } = useLocation();
  const q = useLab(c.id);
  const learnId = useId();
  const cleanupId = useId();
  const guideId = useId();
  const region = c.running ? c.running.region : q.data ? q.data.defaults.region : null;
  const destination = region ? regionWords(region) : q.isError ? null : <Skeleton width={80} />;
  const autoCleanup = data?.autoCleanup ?? false;
  const measured = measuredDeploy(c);
  return (
    <>
      {c.learning ? (
        <>
          <section className="lab-details__section" aria-labelledby={`${learnId}-o`}>
            <h3 className="lab-details__h" id={`${learnId}-o`}>
              Objective
            </h3>
            <p className="lab-details__text">{c.learning.objective}</p>
          </section>
          <section className="lab-details__section" aria-labelledby={`${learnId}-l`}>
            <h3 className="lab-details__h" id={`${learnId}-l`}>
              What you will learn
            </h3>
            <ul className="lab-details__learn" aria-label="What you will learn">
              {c.learning.learn.map((l) => (
                <li key={l}>
                  <Check size={16} aria-hidden className="lab-details__tick" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <section className="lab-details__section" aria-labelledby={`${learnId}-s`}>
          <h3 className="lab-details__h" id={`${learnId}-s`}>
            About this lab
          </h3>
          <p className="lab-details__text">{c.summary}</p>
        </section>
      )}

      <LabResourceSummary resources={c.resources} topics={view.topics} diagramHref={labHref(c.id, search, layout, "diagram")} />

      <dl className="lab-facts lab-facts--key" aria-label="Times and cost">
        <Fact label="Learning time">{c.learning ? keepUnits(fmtMinutes(c.learning.learningMin)) : null}</Fact>
        <Fact label="Deploy time">
          <span className="lab-facts__main">{keepUnits(`about ${c.timing.deployMin} min`)}</span>
          {measured && <span className="lab-facts__sub">{keepUnits(measured)}</span>}
        </Fact>
        <Fact label="Estimated cost">
          <span className="lab-facts__main">{fmtHourlyPrecise(c.estGbpH)}</span>
          {Number.isFinite(c.estGbpH) && c.estGbpH > 0 && <span className="lab-facts__sub">{keepUnits(fmtSessionCost(c.estGbpH, c.timing.sessionH))}</span>}
        </Fact>
      </dl>
      <dl className="lab-facts" aria-label="Lab facts">
        <Fact label="Session">{sessionWords(c)}</Fact>
        <Fact label="Destination">{destination}</Fact>
        <Fact label="Level">{LEVEL_WORD[c.level]}</Fact>
        <Fact label="Type">{TYPE_WORD[c.type]}</Fact>
        <Fact label="Peering">{PEERING_WORD[c.peering]}</Fact>
        <Fact label="Release test">{c.released ? `Passed v${c.version}` : `Untested v${c.version}`}</Fact>
        <Fact label="History">{historyWords(c)}</Fact>
      </dl>

      <section className="lab-details__section" aria-labelledby={guideId}>
        <h3 className="lab-details__h" id={guideId}>
          Lab guide
        </h3>
        <p className="lab-details__text lab-details__small">The readme, diagrams and Learn links as a PDF, to keep open while you work.</p>
        <LabGuideButton labId={c.id} />
      </section>

      <Checks q={q} card={c} />

      <LabPrerequisites ids={c.prerequisites} labs={data?.labs} onSelect={onSelect} />

      <section className="lab-details__section" aria-labelledby={cleanupId}>
        <h3 className="lab-details__h" id={cleanupId}>
          Session and cleanup
        </h3>
        {autoCleanup ? (
          <p className="lab-details__text lab-details__small">
            Ends by itself after {c.timing.sessionH} h unless you extend it (never past {c.timing.maxH} h). Then everything in <code>rg-lab-{c.id}</code> is torn down and a clean check looks for
            leftovers; anything found is flagged on this page. Azure can take a day to bill the last hour.
          </p>
        ) : (
          <p className="lab-details__text lab-details__small">
            Automatic tear-down needs GitHub connected: tear the lab down yourself. Azure can take a day to bill the last hour.
          </p>
        )}
      </section>
    </>
  );
}

/** No lab to show: a skeleton before the first answer, else a plain line (never placeholder figures). */
function NoLab({ loading }: { loading: boolean }) {
  return loading ? (
    <div className="lab-details__lines">
      <Skeleton width="40%" />
      <Skeleton variant="block" height={28} width="80%" />
      <Skeleton variant="block" height={40} />
      <Skeleton width="95%" />
      <Skeleton width="85%" />
      <Skeleton width="60%" />
    </div>
  ) : (
    <p className="lab-details__muted">Select a lab to see its details.</p>
  );
}

/** Wide: the inline details panel beside the grid (sticky, scrolls inside itself). */
export function LabDetailsPanel({ view, data, layout, onSelect }: DetailsProps) {
  const id = useId();
  return (
    <aside className="labs-details lab-details" aria-labelledby={view ? id : undefined} aria-label={view ? undefined : "Lab details"} aria-busy={!view && !data ? true : undefined}>
      {view ? (
        <>
          <DetailsHead view={view} headingId={id} />
          <LabLaunchAction view={view} data={data} layout={layout} onSelect={onSelect} />
          <DetailsBody view={view} data={data} layout={layout} onSelect={onSelect} />
        </>
      ) : (
        <NoLab loading={!data} />
      )}
    </aside>
  );
}

/**
 * Tablet: the details in a right-hand drawer. It stays mounted, `open` following ?lab, so Escape,
 * the X, the backdrop and Back all take Radix's close path; focus then goes to the lab's card.
 * The last lab stays drawn while the drawer slides away.
 */
export function LabDetailsDrawer({ view, data, layout, onSelect, open, onOpenChange }: DetailsProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const last = useRef<LabView | null>(view);
  if (view) last.current = view;
  const shown = view ?? last.current;
  const after = useRef<(() => void) | null>(null);
  const leave = (then: () => void) => {
    after.current = then;
    onOpenChange(false);
  };
  return (
    <Drawer
      side="right"
      open={open && !!shown}
      onOpenChange={onOpenChange}
      title={shown?.card.title ?? "Lab"}
      subtitle={shown ? `Lab ${shown.card.number} · ${examsWord(shown.card)}` : undefined}
      className="lab-details-drawer"
      footer={shown ? <LabLaunchAction view={shown} data={data} layout={layout} onSelect={onSelect} onLeave={leave} /> : undefined}
      onCloseAutoFocus={(e) => {
        const then = after.current;
        after.current = null;
        if (then) {
          e.preventDefault();
          then();
          return;
        }
        if (shown && focusCard(shown.card.id)) e.preventDefault();
      }}
    >
      {shown && (
        <div className="lab-details lab-details--drawer">
          <div className="lab-details__drawer-meta">
            <code className="lab-details__id">{shown.card.id}</code>
            <LabStatusBadge badge={shown.badge} className="lab-details__badge" />
          </div>
          <DetailsBody view={shown} data={data} layout={layout} onSelect={onSelect} />
        </div>
      )}
    </Drawer>
  );
}

/** Try to focus a lab's card for a few frames (the grid comes back after the view goes). */
function focusCardSoon(id: string, tries = 10) {
  if (focusCard(id) || tries <= 0) return;
  setTimeout(() => focusCardSoon(id, tries - 1), 16);
}

/** Phone: the details as a full-width view in place of the grid; its heading takes focus, Back focuses the card. */
export function LabDetailsView({ view, data, layout, onSelect, onBack }: DetailsProps & { onBack: () => void }) {
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const labId = view?.card.id ?? null;
  useEffect(() => {
    if (labId) title.current?.focus();
  }, [labId]);
  const back = () => {
    onBack();
    if (labId) focusCardSoon(labId);
  };
  const leave = (then: () => void) => {
    onBack();
    setTimeout(then, 32);
  };
  return (
    <section className="labs-details-view lab-details lab-details--view" aria-labelledby={view ? id : undefined} aria-label={view ? undefined : "Lab details"}>
      <Button variant="ghost" size="sm" onClick={back} className="lab-details__back">
        <ChevronLeft size={16} aria-hidden="true" />
        Back to labs
      </Button>
      {view ? (
        <>
          <DetailsHead view={view} headingId={id} titleRef={title} />
          <LabLaunchAction view={view} data={data} layout={layout} onSelect={onSelect} onLeave={leave} />
          <DetailsBody view={view} data={data} layout={layout} onSelect={onSelect} />
        </>
      ) : (
        <NoLab loading={!data} />
      )}
    </section>
  );
}
