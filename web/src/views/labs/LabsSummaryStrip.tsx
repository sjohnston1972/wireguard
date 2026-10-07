// views/labs/LabsSummaryStrip.tsx
//
// Plain English: one compact row under the header (labs redesign spec §8.1)
// with real counts only: how many labs of the chosen exam have been run (no
// completion feature, Appendix A), how many labs are running against the
// limit, and "Auto-cleanup on" only when the Worker says the watchman can tear
// labs down by itself. While the catalogue loads it shows grey pills, never a
// placeholder number.

import { Link } from "react-router-dom";
import { ListChecks, Play, RefreshCw } from "lucide-react";
import type { LabsResponse } from "@shared/api";
import type { LabExam } from "@shared/labs";
import { Skeleton } from "@/components";
import { useLabsLayout } from "./layout";
import "./LabsSummaryStrip.css";

/** The labs an exam keeps (tagged ones included, ruling 39) and how many of them have run. */
export function runCounts(data: Pick<LabsResponse, "labs">, exam: LabExam | null): { run: number; total: number } {
  const mine = exam ? data.labs.filter((c) => (c.exams?.length ? c.exams : [c.exam]).includes(exam)) : data.labs;
  return { run: mine.filter((c) => c.runs > 0).length, total: mine.length };
}

export function LabsSummaryStrip({ data, exam }: { data: LabsResponse | undefined; exam: LabExam | null }) {
  const wide = useLabsLayout() === "wide";
  if (!data) {
    return (
      <section className="labs-summary" aria-label="Labs summary" aria-busy="true">
        <ul className="labs-summary__list">
          {[150, 120, 110].map((w) => (
            <li key={w} className="labs-summary__item">
              <Skeleton variant="line" width={w} height={14} />
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const { run, total } = runCounts(data, exam);
  const live = data.running.length;
  const full = live >= data.maxRunning;
  return (
    <section className="labs-summary" aria-label="Labs summary">
      <ul className="labs-summary__list">
        <li className="labs-summary__item">
          <ListChecks size={16} aria-hidden className="labs-summary__icon" />
          <span className="labs-summary__strong">{exam ?? "All exams"}</span>
          <span title="A lab counts once it has run for 15 minutes or more">
            {run} of {total} labs run
          </span>
          <Link className="labs-summary__link" to="/labs/history">
            Coverage
          </Link>
        </li>
        <li className={full ? "labs-summary__item labs-summary__item--amber" : "labs-summary__item"}>
          <Play size={16} aria-hidden className="labs-summary__icon" />
          <span>
            <span className="labs-summary__strong">
              {live} of {data.maxRunning} running
            </span>
            {full && ", limit reached"}
          </span>
          {wide && (
            <span className="labs-summary__muted">
              · {data.slots.used} of {data.slots.total} address slots
            </span>
          )}
        </li>
        {data.autoCleanup && (
          <li className="labs-summary__item labs-summary__item--green" title="Checked every 5 minutes: each lab is torn down at its timer or hard stop.">
            <RefreshCw size={16} aria-hidden className="labs-summary__icon" />
            <span>Auto-cleanup on</span>
          </li>
        )}
      </ul>
    </section>
  );
}
