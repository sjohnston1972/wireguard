// views/labs/LabsFilterToolbar.tsx
//
// Plain English: the catalogue's search and filters (labs redesign spec §8.3)
// as one horizontal, wrapping toolbar above the cards: search, exam, skill
// area, difficulty and "Ready to run only", with Type and "Not run yet" in a
// More filters popover. Below it, "Showing N of M labs" and Clear filters.
// On the phone: the search and a Filters button that opens a sheet with every
// control. Every filter lives in the address (each write a replace, other
// parameters such as ?lab kept), so a reload or a shared link keeps them. The
// search box keeps its own text and writes the address 250 ms after typing
// stops; it only takes a new value from the address when the address changes
// to something it did not write (Back, Clear filters), so typing never jumps.

import { useCallback, useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { SlidersHorizontal } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type { LabExam, LabLevel, LabType } from "@shared/labs";
import { Button, Chips, EmptyState, SearchInput, SegmentedControl, Select, Sheet, Switch } from "@/components";
import { useLabCoverage } from "@/api/queries";
import type { LabView } from "./contract";
import { useLabsLayout } from "./layout";
import { EXAMS, LEVEL_WORD, NO_FILTERS, TYPE_WORD, anyFilter, applyFilters, readFilters, writeFilters, type Filters } from "./model";
import "./LabsFilterToolbar.css";

/**
 * Change the address's query with replace, from its latest value (never a stale render's), keeping
 * the path and the history entry's state (a tablet's pushed selection stays closable with Back).
 */
export function useReplaceSearch(): (change: (p: URLSearchParams) => URLSearchParams) => void {
  const location = useLocation();
  const navigate = useNavigate();
  const latest = useRef(location);
  latest.current = location;
  return useCallback(
    (change) => {
      const l = latest.current;
      const next = change(new URLSearchParams(l.search)).toString();
      if (`?${next}` === l.search || (next === "" && l.search === "")) return;
      navigate({ pathname: l.pathname, search: next ? `?${next}` : "" }, { replace: true, state: l.state });
    },
    [navigate],
  );
}

/** The filters in the address and a setter (replace; ?lab, ?view and the rest kept). */
export function useLabFilters(): [Filters, (f: Filters) => void] {
  const { search } = useLocation();
  const replace = useReplaceSearch();
  const f = readFilters(new URLSearchParams(search));
  const set = useCallback((next: Filters) => replace((p) => writeFilters(p, next)), [replace]);
  return [f, set];
}

/** Skill area key -> its official name (from coverage); the key itself until coverage answers. */
function useAreaNames(): Map<string, string> {
  const cov = useLabCoverage();
  const names = new Map<string, string>();
  for (const e of cov.data?.exams ?? []) for (const a of e.areas) names.set(a.key, a.name);
  return names;
}

const EXAM_ITEMS = [{ value: "all", label: "All" }, ...EXAMS.map((e) => ({ value: e, label: e }))];
const LEVEL_OPTIONS = [{ value: "all", label: "All difficulties" }, ...Object.entries(LEVEL_WORD).map(([value, label]) => ({ value, label }))];
const TYPE_ITEMS = Object.entries(TYPE_WORD).map(([value, label]) => ({ value, label }));

/** How many filters (not the search) are on: the phone's "Filters (n)". */
const activeCount = (f: Filters) => [f.exam, f.area, f.level, f.type.length > 0, f.notRun, f.ready].filter(Boolean).length;

/** The search box: its own text, written to ?q 250 ms after typing stops. */
function SearchField() {
  const { search } = useLocation();
  const replace = useReplaceSearch();
  const urlQ = new URLSearchParams(search).get("q") ?? "";
  const [text, setText] = useState(urlQ);
  const written = useRef(urlQ);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The address changed to a value this box did not write (Back, Clear filters): show it.
  useEffect(() => {
    if (urlQ === written.current) return;
    written.current = urlQ;
    clearTimeout(timer.current);
    setText(urlQ);
  }, [urlQ]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChange = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      written.current = v.trim();
      replace((p) => {
        const next = new URLSearchParams(p);
        if (v.trim()) next.set("q", v.trim());
        else next.delete("q");
        return next;
      });
    }, 250);
  };
  return <SearchInput label="Find a lab" placeholder="Find a lab…" value={text} onChange={onChange} className="labs-toolbar__search" />;
}

interface ControlsProps {
  f: Filters;
  set: (f: Filters) => void;
  views: readonly LabView[];
}

/** Exam, skill area, difficulty and "Ready to run only". */
function MainControls({ f, set, views }: ControlsProps) {
  const names = useAreaNames();
  // The areas of the labs the exam filter keeps (a lab tagged for that exam too, ruling 39).
  const areas = [...new Set(applyFilters(views, { ...NO_FILTERS, exam: f.exam }).flatMap((v) => v.card.skillAreas))].sort();
  const areaOptions = [{ value: "all", label: "All skill areas" }, ...areas.map((a) => ({ value: a, label: names.get(a) ?? a }))];
  if (f.area && !areas.includes(f.area)) areaOptions.push({ value: f.area, label: names.get(f.area) ?? f.area });
  return (
    <>
      <SegmentedControl aria-label="Exam" items={EXAM_ITEMS} value={f.exam ?? "all"} onChange={(v) => set({ ...f, exam: v === "all" ? null : (v as LabExam) })} className="labs-toolbar__exam" />
      <Select label="Skill area" options={areaOptions} value={f.area ?? "all"} onValueChange={(v) => set({ ...f, area: v === "all" ? null : v })} className="labs-toolbar__select" />
      <Select label="Difficulty" options={LEVEL_OPTIONS} value={f.level ?? "all"} onValueChange={(v) => set({ ...f, level: v === "all" ? null : (v as LabLevel) })} className="labs-toolbar__select" />
      <label className="labs-toolbar__switch">
        <Switch label="Ready to run only" checked={f.ready} onCheckedChange={(on) => set({ ...f, ready: on })} />
        <span aria-hidden="true">Ready to run only</span>
      </label>
    </>
  );
}

/** Type (Explore, Break-fix) and "Not run yet": the filters that do not fit the bar. */
function MoreControls({ f, set }: Omit<ControlsProps, "views">) {
  return (
    <>
      <div className="labs-toolbar__field">
        <span className="labs-toolbar__caption" aria-hidden="true">
          Type
        </span>
        <Chips aria-label="Type" items={TYPE_ITEMS} value={f.type} onChange={(v) => set({ ...f, type: v as LabType[] })} />
      </div>
      <label className="labs-toolbar__switch">
        <Switch label="Not run yet" checked={f.notRun} onCheckedChange={(on) => set({ ...f, notRun: on })} />
        <span aria-hidden="true">Not run yet</span>
      </label>
    </>
  );
}

function MoreFilters({ f, set }: Omit<ControlsProps, "views">) {
  const n = f.type.length + (f.notRun ? 1 : 0);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="secondary" icon={<SlidersHorizontal size={14} aria-hidden />} aria-label={n ? `More filters, ${n} active` : "More filters"} className="labs-toolbar__more">
          More filters
          {n > 0 && (
            <span className="labs-toolbar__count" aria-hidden="true">
              {n}
            </span>
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="labs-more" align="end" sideOffset={6} aria-label="More filters">
          <MoreControls f={f} set={set} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The toolbar (spec §8.3). `visible`: how many labs the filters keep; `views`: every lab. */
export function LabsFilterToolbar({ views, visible }: { views: readonly LabView[]; visible: number }) {
  const [f, set] = useLabFilters();
  const phone = useLabsLayout() === "phone";
  const [sheet, setSheet] = useState(false);
  const n = activeCount(f);
  return (
    <form role="search" aria-label="Filter labs" className="labs-toolbar" onSubmit={(e) => e.preventDefault()}>
      <div className="labs-toolbar__row">
        <SearchField />
        {phone ? (
          <Button variant="secondary" icon={<SlidersHorizontal size={14} aria-hidden />} onClick={() => setSheet(true)}>
            {n ? `Filters (${n})` : "Filters"}
          </Button>
        ) : (
          <>
            <MainControls f={f} set={set} views={views} />
            <MoreFilters f={f} set={set} />
          </>
        )}
      </div>
      <div className="labs-toolbar__status">
        <p className="labs-toolbar__result" aria-live="polite">
          Showing {visible} of {views.length} labs
        </p>
        {anyFilter(f) && (
          <Button variant="ghost" size="sm" onClick={() => set(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
      {phone && (
        <Sheet
          open={sheet}
          onOpenChange={setSheet}
          title="Filters"
          className="labs-filter-sheet"
          footer={
            <div className="labs-filter-sheet__foot">
              <Button variant="ghost" onClick={() => set(NO_FILTERS)}>
                Clear
              </Button>
              <Button variant="primary" onClick={() => setSheet(false)}>
                Show {visible} {visible === 1 ? "lab" : "labs"}
              </Button>
            </div>
          }
        >
          <div className="labs-filter-sheet__body">
            <MainControls f={f} set={set} views={views} />
            <MoreControls f={f} set={set} />
          </div>
        </Sheet>
      )}
    </form>
  );
}

/** No lab matches (spec §8.3): what "Ready to run only" hides, and Clear filters. */
export function LabsNoMatches({ views }: { views: readonly LabView[] }) {
  const [f, set] = useLabFilters();
  const hidden = f.ready ? applyFilters(views, { ...f, ready: false }).length - applyFilters(views, f).length : 0;
  const description = hidden > 0 ? (hidden === 1 ? "1 lab is hidden because it isn't ready to run." : `${hidden} labs are hidden because they aren't ready to run.`) : undefined;
  return <EmptyState title="No labs match these filters" description={description} action={{ label: "Clear filters", onClick: () => set(NO_FILTERS) }} />;
}
