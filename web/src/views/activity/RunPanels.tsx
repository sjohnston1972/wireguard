import { Check, ExternalLink, Minus, X } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LogView, Panel, Skeleton, StatusPill } from "@/components";
import { actionWord, fmtDuration, fmtWhen, resultPill, stepSeconds, stepState, type ApiStep } from "./model";
import { Fill } from "./parts";
import { useRunData } from "./useRunData";

/** The run's steps left to right: a mark, the name and how long it took. */
export function StepTrack({ steps }: { steps: ApiStep[] }) {
  if (steps.length === 0) return <p className="act__muted">No steps were saved for this run.</p>;
  return (
    <ol className="act__track" aria-label="Run progress">
      {steps.map((s, i) => {
        const st = stepState(s);
        const d = fmtDuration(stepSeconds(s));
        return (
          <li key={`${s.name}-${i}`} className={`act__step act__step--${st}`} aria-current={st === "running" ? "step" : undefined}>
            <span className="act__step-mark" aria-hidden>
              {st === "done" && <Check size={13} strokeWidth={3} />}
              {st === "failed" && <X size={13} strokeWidth={3} />}
              {st === "skipped" && <Minus size={13} strokeWidth={3} />}
            </span>
            <span className="act__step-name">{s.name}</span>
            <span className="act__step-time">{st === "running" ? "Running…" : st === "pending" ? "Pending" : st === "skipped" ? "Skipped" : (d ?? "")}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Bottom left: the selected run (else the latest) as a row of steps. */
export function RunDetails({ id }: { id: string | null }) {
  const { detail, run, steps } = useRunData(id);
  const pill = run ? resultPill(run.status) : null;
  return (
    <Panel
      title="Run details"
      className="act__rundetails"
      status={
        run && (
          <>
            <span className="act__muted">{fmtWhen(run.requested_at)}</span>
            {pill && <StatusPill {...pill} />}
          </>
        )
      }
    >
      {id === null ? (
        <EmptyState title="No runs yet" description="A deploy or tear-down shows its steps here." />
      ) : detail.isError ? (
        <ErrorState title="Could not load this run" message={detail.error.message} onRetry={() => void detail.refetch()} />
      ) : !run ? (
        <div aria-busy="true" className="act__skel">
          <Skeleton variant="line" width="40%" />
          <Skeleton variant="block" height={44} />
        </div>
      ) : (
        <>
          <p className="act__muted act__sub">
            {actionWord(run.action)} requested by {run.requested_by ?? "unknown"}
            {run.error ? `: ${run.error}` : run.status === "running" ? ", in progress" : ""}
          </p>
          <StepTrack steps={steps} />
        </>
      )}
    </Panel>
  );
}

/** Bottom right: the tail of the selected run's log, with a way to the whole thing. */
export function LiveOutput({ id, search }: { id: string | null; search: string }) {
  const { run, hasLog, log, lines } = useRunData(id);
  const to = id ? { pathname: `/activity/runs/${encodeURIComponent(id)}`, search: search ? `?${search}` : "" } : null;
  return (
    <Panel
      title="Live output"
      className="act__output"
      flush
      actions={
        to && (
          <Link className="act__link" to={to}>
            Open in logs <ExternalLink size={13} aria-hidden />
          </Link>
        )
      }
    >
      <Fill>
        <div className="act__scroll act__output-body">
          {id === null ? (
            <p className="act__muted act__pad">No run to show output for.</p>
          ) : run && !hasLog ? (
            <p className="act__muted act__pad">This run has no GitHub log.</p>
          ) : log.isError ? (
            <p className="act__muted act__pad" role="alert">
              {log.error.message}
            </p>
          ) : !log.data ? (
            <div aria-busy="true" className="act__skel">
              <Skeleton variant="line" />
              <Skeleton variant="line" width="80%" />
              <Skeleton variant="line" width="60%" />
            </div>
          ) : (
            <LogView aria-label="Live output log" toolbar={false} lines={lines.slice(-60)} />
          )}
        </div>
      </Fill>
    </Panel>
  );
}
