// views/labs/LabsPage.tsx
//
// Plain English: /labs, the catalogue (labs redesign spec §4, §9, §12):
// header, summary strip, notices, running labs, the filter toolbar and the
// card grid with the selected lab's details. Wide screens (1200 px and up)
// show the details in a sticky panel beside the grid, always for some lab:
// the one in ?lab when the filters show it, else the first one shown (never
// written to the address). Tablets open the details in a right-hand drawer
// and phones as a full-width view, only when a card is chosen (a push, so
// Back closes them). ?lab is a selection, never a dialog: /labs/:id is the
// lab's dialog (readme, diagram, cost and the Deploy confirmation), drawn
// over this page. Nothing on this page deploys.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState, ErrorState, Skeleton, StaleBanner, cx, useToast } from "@/components";
import { useLabs } from "@/api/queries";
import { useLabViews } from "./contract";
import { LabCatalogueGrid } from "./LabCatalogueGrid";
import { LabDetailsDrawer, LabDetailsPanel, LabDetailsView } from "./LabDetailsPanel";
import { LabsFilterToolbar, LabsNoMatches, useReplaceSearch } from "./LabsFilterToolbar";
import { LabsHeader } from "./LabsHeader";
import { LabsNotices } from "./LabsNotices";
import { LabsSummaryStrip } from "./LabsSummaryStrip";
import { useLabsLayout } from "./layout";
import { applyFilters, fmtClock, readFilters, readSelection, revealFilters, selectedLab, withSelection, writeFilters } from "./model";
import { RunningStrip } from "./RunningStrip";
import "./LabsPage.css";

/** History state on an entry this page pushed to open a lab's drawer or view (with `from`, the grid's query): Back closes it. */
const PUSHED = { labsSelect: true } as const;
const pushed = (state: unknown) => !!state && typeof state === "object" && (state as { labsSelect?: boolean }).labsSelect === true;
/** A query without ?lab, as URLSearchParams writes it. */
const sansLab = (search: string) => withSelection(new URLSearchParams(search), null).toString();

/** The details panel's place while the catalogue loads. */
function PanelSkeleton() {
  return (
    <div className="labs-details-skeleton" aria-hidden="true">
      <Skeleton variant="line" width="40%" />
      <Skeleton variant="line" width="75%" height={20} />
      <Skeleton variant="line" width="30%" />
      <Skeleton variant="block" height={44} />
      <Skeleton variant="line" />
      <Skeleton variant="line" width="85%" />
      <Skeleton variant="line" width="60%" />
    </div>
  );
}

/**
 * The catalogue page. `dialogId`: the lab whose dialog is open (/labs/:id), the selection on wide
 * when ?lab names none. `children`: the dialog (or the notice that it could not open).
 */
export function LabsPage({ dialogId = null, children }: { dialogId?: string | null; children?: ReactNode }) {
  const q = useLabs();
  const data = q.data;
  const { views, byId, loaded } = useLabViews(q);
  const layout = useLabsLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const replace = useReplaceSearch();
  const { toast } = useToast();
  // The setup banner's Hide, kept here for the page visit: the phone's detail view unmounts the notices.
  const [setupHidden, setSetupHidden] = useState(false);
  const hideSetup = useCallback(() => setSetupHidden(true), []);

  const params = new URLSearchParams(location.search);
  const filters = readFilters(params);
  // Keyed on the filters' value (a new object every render), so the pass runs once per change.
  const filterKey = JSON.stringify(filters);
  const visible = useMemo(() => applyFilters(views, JSON.parse(filterKey) as typeof filters), [views, filterKey]);
  const knownIds = useMemo(() => views.map((v) => v.card.id), [views]);
  const visibleIds = useMemo(() => visible.map((v) => v.card.id), [visible]);
  const urlLab = readSelection(params);
  // On wide, an open dialog's lab is the selection when ?lab names none (the palette's /labs/:id links).
  const implied = urlLab ?? (layout === "wide" && dialogId && byId.has(dialogId) ? dialogId : null);
  const sel = selectedLab(visibleIds, implied, layout, knownIds);
  const shown = sel.shown ? (byId.get(sel.shown) ?? null) : null;
  const drop = sel.drop && !!urlLab;

  // ?lab names a lab the filters hide (wide) or no lab at all: remove it, once (it only ever removes, so it cannot loop).
  const dropped = useRef<string | null>(null);
  useEffect(() => {
    if (!drop || !urlLab) {
      dropped.current = null;
      return;
    }
    if (dropped.current === urlLab) return;
    dropped.current = urlLab;
    if (loaded && !byId.has(urlLab)) toast({ title: `Lab ${urlLab} isn't in the catalogue.`, tone: "warning" });
    replace((p) => withSelection(p, null));
  }, [drop, urlLab, loaded, byId, replace, toast]);

  // Select a lab. From a card: wide replaces ?lab (the panel follows); tablet and phone push it, so Back closes the
  // drawer or view. From inside the details (a prerequisite): always a replace, so closing never lands on the lab
  // before. A lab the filters hide first clears exactly the filters that hide it, and says so: never the first
  // visible lab in its place.
  const latest = useRef({ location, layout, byId });
  latest.current = { location, layout, byId };
  const go = useCallback(
    (id: string, from: "card" | "details") => {
      const { location: l, layout: lay, byId: views } = latest.current;
      let p = new URLSearchParams(l.search);
      const v = views.get(id);
      const shown = v ? revealFilters(readFilters(p), v) : null;
      if (v && shown?.cleared) {
        p = writeFilters(p, shown.filters);
        toast({ title: `Filters cleared to show Lab ${v.card.number}.`, tone: "info" });
      }
      const next = withSelection(p, id).toString();
      const to = { pathname: l.pathname, search: next ? `?${next}` : "" };
      if (lay === "wide" || from === "details") {
        if (to.search !== l.search) navigate(to, { replace: true, state: l.state });
        return;
      }
      navigate(to, { state: { ...PUSHED, from: sansLab(l.search) } });
    },
    [navigate, toast],
  );
  const select = useCallback((id: string) => go(id, "card"), [go]);
  const selectWithin = useCallback((id: string) => go(id, "details"), [go]);

  // Close the drawer or the phone view, always to the grid (no ?lab): Back when this page opened it from that same
  // grid, else a replace that drops ?lab (a prerequisite cleared filters since). The phone then focuses the card.
  const refocus = useRef<string | null>(null);
  const close = useCallback(() => {
    const { location: l, layout: lay } = latest.current;
    if (lay === "phone") refocus.current = readSelection(new URLSearchParams(l.search));
    const st = l.state as { labsSelect?: boolean; from?: string } | null;
    if (pushed(st) && st?.from === sansLab(l.search)) return navigate(-1);
    const next = withSelection(new URLSearchParams(l.search), null).toString();
    navigate({ pathname: l.pathname, search: next ? `?${next}` : "" }, { replace: true, state: null });
  }, [navigate]);
  useEffect(() => {
    if (shown || !refocus.current) return;
    const id = refocus.current;
    refocus.current = null;
    document.querySelector<HTMLElement>(`[data-lab-card="${CSS.escape(id)}"] .lab-card__select`)?.focus();
  }, [shown]);

  // The query without ?lab and ?view: the same string across selections, so the cards' memo holds.
  const search = useMemo(() => {
    const p = new URLSearchParams(location.search);
    p.delete("lab");
    p.delete("view");
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [location.search]);

  const failed = q.isError && !data;
  const stale = q.isError && !!data;
  const phoneView = layout === "phone" && !!shown;
  // An empty catalogue or no matches: the empty state has the workspace to itself (no "Select a lab" box beside it).
  const nothingShown = !!data && visible.length === 0;
  const details = { view: shown, data, layout, onSelect: selectWithin };

  // The phone's details are a full-width view right under the header; the strip, notices and running labs wait on the catalogue.
  if (phoneView && !failed) {
    return (
      <section className="labs labs-page">
        <LabsHeader />
        {children}
        <LabDetailsView {...details} onBack={close} />
      </section>
    );
  }

  return (
    <section className="labs labs-page">
      <LabsHeader />
      <LabsSummaryStrip data={data} exam={filters.exam} />
      {/* The notices and running labs: on a tablet or desktop one block that scrolls inside itself when tall, so the
          grid always keeps the rest of the screen (LabsPage.css); on the phone it is no box at all. */}
      <div className="labs-page__alerts">
        {data && <LabsNotices data={data} setupHidden={setupHidden} onHideSetup={hideSetup} />}
        {children}
        {data && <RunningStrip sessions={data.running} />}
        {stale && <StaleBanner at={q.dataUpdatedAt || null} message={`Couldn't refresh the labs; showing them as of ${fmtClock(new Date(q.dataUpdatedAt).toISOString())}.`} onRetry={() => void q.refetch()} />}
      </div>
      {failed ? (
        <ErrorState title="Couldn't load the labs" message={q.error instanceof Error ? q.error.message : "The catalogue could not be loaded."} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <LabsFilterToolbar views={views} visible={data ? visible.length : null} />
          <div className={cx("labs-workspace", nothingShown && "labs-workspace--single")} aria-busy={data ? undefined : true}>
            <div className="labs-workspace__main">
              {data && data.labs.length === 0 ? (
                <EmptyState title="No labs in the catalogue yet" description="Labs arrive with a Worker deploy that includes them." />
              ) : data && visible.length === 0 ? (
                <LabsNoMatches views={views} />
              ) : (
                <LabCatalogueGrid views={data ? visible : null} selectedId={shown?.card.id ?? null} onSelect={select} search={search} layout={layout} skeletons={layout === "phone" ? 3 : 6} />
              )}
            </div>
            {layout === "wide" && !nothingShown && (data ? <LabDetailsPanel {...details} /> : <PanelSkeleton />)}
          </div>
          {/* Never under the lab's dialog (/labs/:id?lab=:id): one modal, one focus trap. */}
          {layout === "tablet" && <LabDetailsDrawer {...details} open={!!shown && !dialogId} onOpenChange={(o) => !o && close()} />}
        </>
      )}
    </section>
  );
}
