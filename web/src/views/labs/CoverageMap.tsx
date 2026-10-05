import type { LabCoverage } from "@shared/api";
import { EmptyState, ErrorState, Panel, Skeleton } from "@/components";
import { useLabCoverage } from "@/api/queries";

/** One exam: a row per skill area with labs run of labs available, and a box per lab (filled once run for 15 minutes or more). */
export function ExamCoverage({ e }: { e: LabCoverage }) {
  return (
    <section className="labs-cov" aria-labelledby={`labs-cov-${e.exam}`}>
      <h3 className="labs-exam__title" id={`labs-cov-${e.exam}`}>
        {e.exam}
      </h3>
      <ul className="labs-cov__list">
        {e.areas.map((a) => (
          <li key={a.key} className="labs-cov__row" aria-label={`${a.name}: ${a.run} of ${a.available} run`}>
            <span className="labs-cov__name">{a.name}</span>
            <span className="labs-cov__count">
              {a.run} of {a.available}
            </span>
            <span className="labs-cov__boxes">
              {a.labs.map((l) => {
                const label = `Lab ${l.number}, ${l.title}: ${l.run ? "run" : "not run yet"}`;
                return <span key={l.id} role="img" aria-label={label} title={label} className={l.run ? "labs-box labs-box--run" : "labs-box"} />;
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The coverage map (spec §10): per exam, one row per skill area. */
export function CoverageMap({ bare = false }: { bare?: boolean }) {
  const q = useLabCoverage();
  const body = (
    <div className="labs-coverage__scroll">
      {q.isError && !q.data ? (
        <ErrorState title="Could not load coverage" message={q.error instanceof Error ? q.error.message : "Coverage could not be loaded."} onRetry={() => void q.refetch()} />
      ) : !q.data ? (
        <Skeleton variant="block" height={120} />
      ) : q.data.exams.length === 0 ? (
        <EmptyState title="No skill areas yet" description="Coverage fills in as the catalogue grows." />
      ) : (
        q.data.exams.map((e) => <ExamCoverage key={e.exam} e={e} />)
      )}
      <p className="labs-muted labs-cov__key">
        <span className="labs-box labs-box--run" aria-hidden /> run for 15 minutes or more <span className="labs-box" aria-hidden /> not yet
      </p>
    </div>
  );
  if (bare) return <section aria-label="Coverage">{body}</section>;
  return (
    <Panel title="Coverage" className="labs-coverage" bodyClassName="labs-coverage__body" widgetChrome={false}>
      {body}
    </Panel>
  );
}
