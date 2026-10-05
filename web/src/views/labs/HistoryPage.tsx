import { Link } from "react-router-dom";
import type { LabEndReason, LabSession } from "@shared/api";
import { DataTable, EmptyState, Panel, type Column } from "@/components";
import { useLabSessions } from "@/api/queries";
import { CoverageMap } from "./CoverageMap";
import { LabsHeader } from "./LabsPage";
import { fmtGbp, fmtSpan, fmtWhen, stateWord, useLabClock, type Tone } from "./model";
import { Word } from "./RunningStrip";

const REASON: Record<LabEndReason, string> = {
  manual: "You tore it down",
  timer: "Timer",
  max: "Hard stop",
  budget: "Budget",
  failed: "Failed",
  orphan: "Clean-up",
  test: "Release test",
};

/** How a session ended, as a coloured word; a live one says what it is doing. */
export function endWord(s: LabSession): { label: string; tone: Tone } {
  if (s.state !== "ended" && s.state !== "ended_dirty") return stateWord(s);
  const reason = s.endReason ? REASON[s.endReason] : "Ended";
  if (s.state === "ended_dirty") return { label: `${reason}, leftovers`, tone: "red" };
  return { label: reason, tone: s.endReason === "failed" || s.endReason === "budget" ? "amber" : "grey" };
}

const duration = (s: LabSession, now: number) => (s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.requestedAt);

/** The sessions table (spec §10): date, lab, duration, cost (estimate or actual), how it ended, note. */
export function SessionsTable({ sessions, loading, error, onRetry }: { sessions: LabSession[]; loading?: boolean; error?: string | null; onRetry?: () => void }) {
  const now = useLabClock();
  const columns: Column<LabSession>[] = [
    { key: "date", header: "Date", cell: (s) => fmtWhen(s.requestedAt), sortValue: (s) => s.requestedAt, width: 120 },
    {
      key: "lab",
      header: "Lab",
      cell: (s) => (
        <Link className="labs-table__lab" to={`/labs/${encodeURIComponent(s.labId)}`}>
          {s.title}
        </Link>
      ),
      sortValue: (s) => s.title,
    },
    { key: "duration", header: "Duration", cell: (s) => fmtSpan(duration(s, now)), sortValue: (s) => duration(s, now), width: 96 },
    {
      key: "cost",
      header: "Cost",
      cell: (s) =>
        s.costGbp === null ? (
          <span className="labs-muted">no data</span>
        ) : (
          <span className="labs-table__cost">
            <span>{fmtGbp(s.costGbp)}</span> <span className="labs-muted">{s.costBasis}</span>
          </span>
        ),
      sortValue: (s) => s.costGbp,
      width: 120,
    },
    { key: "ended", header: "Ended", cell: (s) => <Word {...endWord(s)} />, width: 190 },
    {
      key: "note",
      header: "Note",
      cell: (s) =>
        s.note ? (
          <span className="labs-table__note" title={s.note}>
            {s.note}
          </span>
        ) : (
          <span className="labs-muted">—</span>
        ),
    },
  ];
  return (
    <DataTable
      aria-label="Sessions"
      columns={columns}
      rows={sessions}
      rowKey={(s) => s.id}
      density="compact"
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={<EmptyState title="No lab sessions yet" description="Each deploy is listed here once it starts, with what it cost." />}
      className="labs-sessions"
    />
  );
}

/** /labs/history: the sessions on the left, the coverage map on the right; each scrolls inside its panel. */
export function HistoryPage() {
  const q = useLabSessions(undefined, 200);
  return (
    <section className="labs">
      <LabsHeader />
      <div className="labs-history">
        <Panel title="Sessions" className="labs-sessions-panel" bodyClassName="labs-sessions__body" flush widgetChrome={false}>
          <div className="labs-sessions__scroll">
            <SessionsTable sessions={q.data?.sessions ?? []} loading={!q.data && !q.isError} error={q.isError && !q.data ? (q.error instanceof Error ? q.error.message : "Could not load the sessions.") : null} onRetry={() => void q.refetch()} />
          </div>
        </Panel>
        <CoverageMap />
      </div>
    </section>
  );
}
