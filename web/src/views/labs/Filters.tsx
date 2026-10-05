import { useSearchParams } from "react-router-dom";
import type { LabCard } from "@shared/api";
import { Button, Chips, Panel, SegmentedControl, Select, Switch } from "@/components";
import { useLabCoverage } from "@/api/queries";
import { EXAMS, LEVEL_WORD, NO_FILTERS, TYPE_WORD, anyFilter, readFilters, writeFilters, type Filters as F } from "./model";
import type { LabExam, LabLevel, LabType } from "@shared/labs";

/** The catalogue's filters, kept in the address so a reload or Back keeps them. */
export function useFilters(): [F, (f: F) => void] {
  const [params, setParams] = useSearchParams();
  return [readFilters(params), (f) => setParams(writeFilters(params, f), { replace: true })];
}

/** Skill area key -> its official name (from coverage); the key itself until coverage answers. */
export function useAreaNames(): Map<string, string> {
  const cov = useLabCoverage();
  const names = new Map<string, string>();
  for (const e of cov.data?.exams ?? []) for (const a of e.areas) names.set(a.key, a.name);
  return names;
}

/** Left column (spec §10): exam, skill area, level, type and "not run yet". */
export function Filters({ cards }: { cards: LabCard[] }) {
  const [f, setF] = useFilters();
  const names = useAreaNames();
  const areas = [...new Set(cards.filter((c) => !f.exam || c.exam === f.exam).flatMap((c) => c.skillAreas))].sort();
  const areaOptions = [{ value: "all", label: "All skill areas" }, ...areas.map((a) => ({ value: a, label: names.get(a) ?? a }))];
  if (f.area && !areas.includes(f.area)) areaOptions.push({ value: f.area, label: names.get(f.area) ?? f.area });
  return (
    <Panel title="Filters" className="labs-filters" bodyClassName="labs-filters__body" widgetChrome={false}>
      <div className="labs-filters__scroll">
        <div className="labs-filter">
          <span className="labs-filter__label" id="labs-f-exam">
            Exam
          </span>
          <SegmentedControl
            aria-label="Exam"
            items={[{ value: "all", label: "All" }, ...EXAMS.map((e) => ({ value: e, label: e }))]}
            value={f.exam ?? "all"}
            onChange={(v) => setF({ ...f, exam: v === "all" ? null : (v as LabExam) })}
          />
        </div>
        <div className="labs-filter">
          <span className="labs-filter__label">Skill area</span>
          <Select label="Skill area" options={areaOptions} value={f.area ?? "all"} onValueChange={(v) => setF({ ...f, area: v === "all" ? null : v })} className="labs-filter__select" />
        </div>
        <div className="labs-filter">
          <span className="labs-filter__label">Level</span>
          <Chips aria-label="Level" items={Object.entries(LEVEL_WORD).map(([value, label]) => ({ value, label }))} value={f.level} onChange={(v) => setF({ ...f, level: v as LabLevel[] })} />
        </div>
        <div className="labs-filter">
          <span className="labs-filter__label">Type</span>
          <Chips aria-label="Type" items={Object.entries(TYPE_WORD).map(([value, label]) => ({ value, label }))} value={f.type} onChange={(v) => setF({ ...f, type: v as LabType[] })} />
        </div>
        <label className="labs-filter labs-filter--switch">
          <span className="labs-filter__label">Not run yet</span>
          <Switch label="Not run yet" checked={f.notRun} onCheckedChange={(on) => setF({ ...f, notRun: on })} />
        </label>
        {anyFilter(f) && (
          <Button variant="ghost" size="sm" onClick={() => setF(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
    </Panel>
  );
}
