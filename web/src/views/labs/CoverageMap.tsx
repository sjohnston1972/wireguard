import type { LabCoverage } from "@shared/api";
import { EXAM_CLOUD, type LabCloud } from "@shared/labs";
import { EmptyState, ErrorState, Panel, Skeleton } from "@/components";
import { useLabCoverage } from "@/api/queries";
import { labNumberWord } from "./model";

const CLOUD_HEADING: Record<LabCloud, string> = { azure: "Azure", aws: "AWS" };

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
                const label = `${labNumberWord({ number: l.number, cloud: EXAM_CLOUD[e.exam] })}, ${l.title}: ${l.run ? "run" : "not run yet"}`;
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
        (["azure", "aws"] as const).map((cloud) => {
          const exams = q.data.exams.filter((e) => EXAM_CLOUD[e.exam] === cloud);
          return (
            exams.length > 0 && (
              <section key={cloud} className="labs-cov-cloud" aria-labelledby={`labs-cov-cloud-${cloud}`}>
                <h3 className="labs-cov-cloud__title" id={`labs-cov-cloud-${cloud}`}>
                  {CLOUD_HEADING[cloud]}
                </h3>
                {exams.map((e) => (
                  <ExamCoverage key={e.exam} e={e} />
                ))}
              </section>
            )
          );
        })
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
