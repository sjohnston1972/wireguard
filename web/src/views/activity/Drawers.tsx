import { ExternalLink } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { Button, Diff, Drawer, ErrorState, KeyValue, LogView, Skeleton, StatusPill, StepList, type Step } from "@/components";
import { actionWord, fmtClock, fmtDuration, fmtGbp, fmtWhen, jsonLines, resultPill, stepSeconds, stepState } from "./model";
import { useRunData } from "./useRunData";
import { LIVE_LOG_WAITING } from "@/lib/parseLog";

/** A run: its facts, the saved steps with durations, and its log (loaded on open; live while the run is going, GitHub's once it has finished). */
export function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { detail, run, steps, active, hasLog, log, lines, streaming, stalled, waiting, liveCopy } = useRunData(id);
  const pill = run ? resultPill(run.status) : null;
  const rows: Step[] = steps.map((s, i) => ({ id: `${i}`, label: s.name, state: stepState(s), duration: fmtDuration(stepSeconds(s)) ?? undefined, time: fmtClock(s.started_at) || undefined }));

  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      className="act__drawer"
      title={run ? `${actionWord(run.action)} run, ${fmtWhen(run.requested_at)}` : "Run"}
      subtitle={<span className="act__mono">{id}</span>}
      leading={pill ? <StatusPill {...pill} /> : undefined}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Back to activity
        </Button>
      }
    >
      {detail.isError ? (
        <ErrorState title="Could not load this run" message={detail.error.message} onRetry={() => void detail.refetch()} />
      ) : !run ? (
        <div aria-busy="true" className="act__skel">
          <Skeleton variant="line" width="50%" />
          <Skeleton variant="block" height={96} />
          <Skeleton variant="block" height={140} />
        </div>
      ) : (
        <div className="act__drawer-body">
          <KeyValue
            items={[
              { label: "Action", value: actionWord(run.action) },
              { label: "Requested", value: fmtWhen(run.requested_at) },
              { label: "Started", value: run.started_at ? fmtWhen(run.started_at) : "not started" },
              { label: "Finished", value: run.finished_at ? fmtWhen(run.finished_at) : active ? "in progress" : "not finished" },
              { label: "Duration", value: fmtDuration(run.durationSeconds) ?? (active ? "in progress" : null) },
              { label: "Requested by", value: run.requested_by },
              { label: "Source", value: run.source },
              { label: "Session cost (estimate)", value: typeof run.sessionCostGbp === "number" ? `est. ${fmtGbp(run.sessionCostGbp)}` : "not applicable" },
              { label: "Public IP", value: run.public_ip, mono: true },
            ]}
          />
          {run.error && <p className="act__error">{run.error}</p>}
          <h3 className="act__h3">Steps</h3>
          {rows.length === 0 ? <p className="act__muted">No steps were saved for this run.</p> : <StepList aria-label="Run steps" steps={rows} />}
          <h3 className="act__h3">
            Log
            {streaming && (stalled ? <StatusPill status="degraded" label="Stalled" variant="outline" className="act__stream" /> : <StatusPill status="online" label="Streaming" variant="outline" className="act__stream" />)}
            {run.github_run_url && (
              <a className="act__link" href={run.github_run_url} target="_blank" rel="noreferrer noopener">
                View on GitHub <ExternalLink size={13} aria-hidden />
              </a>
            )}
          </h3>
          {!hasLog ? (
            <p className="act__muted">This run has no GitHub log.</p>
          ) : log.isError ? (
            <p className="act__muted" role="alert">
              {log.error.message}
            </p>
          ) : !log.data ? (
            <div aria-busy="true" className="act__skel">
              <Skeleton variant="line" />
              <Skeleton variant="line" width="80%" />
            </div>
          ) : waiting ? (
            <p className="act__muted" role="status">
              {LIVE_LOG_WAITING}
            </p>
          ) : (
            <>
              {liveCopy && <p className="act__muted">GitHub's full log is not available, so this is the copy the workflow sent while it ran.</p>}
              <div className="act__drawer-log">
                <LogView aria-label="Run log" lines={lines} />
              </div>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** A change from the change log: who, when, and its before and after. */
export function ChangeDrawer({ change, onClose }: { change: ActivityResponse["changes"]["rows"][number] | null; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} className="act__drawer" title={change ? change.action : "Change"} subtitle={change && fmtWhen(change.at)}>
      {!change ? (
        <p className="act__muted">That change is not on this page of the change log. Clear the search or filter, or go back a page.</p>
      ) : (
        <div className="act__drawer-body">
          <KeyValue
            items={[
              { label: "When", value: fmtWhen(change.at) },
              { label: "By", value: change.user },
              { label: "Target", value: change.target || null },
            ]}
          />
          <h3 className="act__h3">What changed</h3>
          <Diff before={jsonLines(change.before_json)} after={jsonLines(change.after_json)} />
        </div>
      )}
    </Drawer>
  );
}
