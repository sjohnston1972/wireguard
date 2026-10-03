import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Maximize2, Minus, X } from "lucide-react";
import type { OverviewResponse, RunLogResponse } from "@shared/api";
import { EmptyState, IconButton, LogView, Modal, Panel, Select, StepList, Tabs, cx, type LogLine } from "@/components";
import { useRunLog } from "@/api/queries";
import { inGithubRun, stepLine, stepMatches, stepState, uiSteps, type StepFilter } from "./model";
import { LIVE_LOG_WAITING, parseLog } from "@/lib/parseLog";
import type { ActionName } from "./actions";
import "./Run.css";

type LevelFilter = "all" | "warn" | "error";
const LEVEL_OPTIONS = [
  { value: "all", label: "All levels" },
  { value: "warn", label: "Warnings and errors" },
  { value: "error", label: "Errors only" },
];
const keep = (l: LogLine, f: LevelFilter) => f === "all" || l.level === "ERROR" || (f === "warn" && l.level === "WARN");

/** Find the n-th line whose text is `text` inside a LogView and bring it into view. */
function scrollToLine(host: HTMLElement | null, lines: LogLine[], index: number) {
  if (!host) return;
  const target = lines[index];
  if (!target) return;
  const nth = lines.slice(0, index).filter((l) => l.text === target.text).length;
  const matches = Array.from(host.querySelectorAll<HTMLElement>(".log__line")).filter((el) => el.querySelector(".log__text")?.textContent === target.text);
  const el = matches[nth] ?? matches[0];
  el?.scrollIntoView({ block: "start", behavior: "smooth" });
  el?.classList.add("ov-log__hit");
  setTimeout(() => el?.classList.remove("ov-log__hit"), 1600);
}

/** The pipeline: one row per GitHub step; a row is a button that jumps to its group in the log. */
function Pipeline({ steps, filter, onPick }: { steps: OverviewResponse["snapshot"]["steps"]; filter: StepFilter; onPick: (i: number) => void }) {
  const ui = uiSteps(steps);
  const shown = ui.map((s, i) => ({ s, i })).filter(({ i }) => stepMatches(steps[i], filter));
  if (!shown.length) return <p className="ov-run__none">No steps in this group.</p>;
  return (
    <ol className="steps ov-pipeline">
      {shown.map(({ s, i }) => (
        <li key={s.id} className={cx("steps__item", `steps__item--${s.state}`)} aria-current={s.state === "running" ? "step" : undefined}>
          <button type="button" className="ov-pipeline__btn" onClick={() => onPick(i)} aria-label={`${s.label}, ${s.state === "running" ? "running" : s.state}${s.duration ? `, ${s.duration}` : ""}. Show in the log`}>
            <span className={cx("steps__icon", `steps__icon--${s.state}`)} aria-hidden>
              {s.state === "done" && <Check size={12} strokeWidth={3} />}
              {s.state === "failed" && <X size={12} strokeWidth={3} />}
              {s.state === "skipped" && <Minus size={12} strokeWidth={3} />}
              {s.state === "running" && <span className="steps__spinner" />}
            </span>
            <span className="steps__label">{s.label}</span>
            <span className={cx("steps__state", s.state === "running" || s.state === "failed" ? "" : "visually-hidden")} aria-hidden>
              {s.state === "running" ? "Running…" : s.state === "failed" ? "Failed" : s.state}
            </span>
            <span className="steps__duration">{s.duration ?? ""}</span>
            <span className="steps__time">{s.time ?? ""}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * The word beside "Live logs": "Streaming" only while the run is going and the
 * log is the live copy; "Finished" once the run is over or the log is
 * GitHub's; "Waiting" while the first answer is still on its way.
 */
function streamState(running: boolean, data: RunLogResponse | undefined): "Streaming" | "Waiting" | "Finished" {
  if (!running || data?.source === "github" || data?.active === false) return "Finished";
  return data?.source === "live" ? "Streaming" : "Waiting";
}

/** During a deploy or tear-down: the step chips, the pipeline and the live log, side by side. */
export function RunPanels({ o }: { o: OverviewResponse }) {
  const s = o.snapshot;
  const live = inGithubRun(s.state);
  const runLog = useRunLog(s.run_id ?? "none", live, { enabled: !!s.run_id });
  const [filter, setFilter] = useState<StepFilter>("all");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [full, setFull] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  // While the run is going the log is the live copy the workflow sends; once
  // it has finished, GitHub's full log (the API decides, see RunLogResponse).
  const fromApi = runLog.data?.log;
  const parsed = useMemo(() => parseLog(fromApi || s.log_tail), [fromApi, s.log_tail]);
  const lines = useMemo(() => parsed.lines.filter((l) => keep(l, level)), [parsed, level]);
  const stream = streamState(live, runLog.data);
  const waiting = stream === "Streaming" && parsed.lines.length === 0;

  const counts = {
    all: s.steps.length,
    running: s.steps.filter((x) => stepMatches(x, "running")).length,
    done: s.steps.filter((x) => stepMatches(x, "done")).length,
    pending: s.steps.filter((x) => stepMatches(x, "pending")).length,
  };

  const pick = (i: number) => {
    const at = stepLine(s.steps, i, parsed);
    if (at === null) return;
    const idx = lines.indexOf(parsed.lines[at]);
    if (idx >= 0) return scrollToLine(host.current, lines, idx);
    // The level filter hides the group's first line: show every level, then jump.
    setLevel("all");
    requestAnimationFrame(() => scrollToLine(host.current, parsed.lines, at));
  };

  const failed = s.steps.some((x) => stepState(x) === "failed");
  const what = s.state === "destroying" ? "tear-down" : "deployment";

  return (
    <div className="ov-run">
      <div className="ov-run__chips">
        <Tabs
          variant="pill"
          aria-label="Show steps"
          value={filter}
          onValueChange={(v) => setFilter(v as StepFilter)}
          items={[
            { value: "all", label: "All", count: counts.all },
            { value: "running", label: "In progress", count: counts.running, dot: "amber" },
            { value: "done", label: "Completed", count: counts.done, dot: failed ? "red" : "green" },
            { value: "pending", label: "Pending", count: counts.pending, dot: "grey" },
          ]}
        />
      </div>
      <div className="ov-run__panels">
        <Panel title={s.state === "destroying" ? "Tear-down pipeline" : "Deployment pipeline"} className="ov-run__pipeline" bodyClassName="ov-scroll">
          <p className="ov-run__intro">{s.state === "destroying" ? "Removing Azure resources and the DNS record." : "Provisioning Azure resources and configuring WireGuard."} Click a step to find it in the log.</p>
          <Pipeline steps={s.steps} filter={filter} onPick={pick} />
        </Panel>
        <Panel
          title="Live logs"
          className="ov-run__log"
          flush
          bodyClassName="ov-run__logbody"
          status={
            <span className={cx("ov-stream", stream === "Streaming" && "ov-stream--on")}>
              <span className="ov-stream__dot" aria-hidden />
              {stream}
            </span>
          }
          actions={
            <>
              <Select label="Log level" options={LEVEL_OPTIONS} value={level} onValueChange={(v) => setLevel(v as LevelFilter)} className="ov-run__level" />
              <IconButton label="Full screen log" size="sm" onClick={() => setFull(true)}>
                <Maximize2 size={14} aria-hidden />
              </IconButton>
            </>
          }
        >
          <div ref={host} className="ov-run__loghost">
            <LogView lines={lines} aria-label={`${what === "deployment" ? "Deployment" : "Tear-down"} log`} emptyText={waiting ? LIVE_LOG_WAITING : undefined} />
          </div>
          {runLog.isError && !s.log_tail && <p className="ov-run__none">{runLog.error.message}</p>}
        </Panel>
      </div>
      <Modal open={full} onOpenChange={setFull} title="Run log" width={1100}>
        <div className="ov-run__fulllog">
          <LogView lines={lines} aria-label="Run log, full screen" />
        </div>
      </Modal>
    </div>
  );
}

/** No run in progress: the last run's steps, read-only, with a link to its log. */
export function LastRun({ o, onAction }: { o: OverviewResponse; onAction: (a: ActionName) => void }) {
  const s = o.snapshot;
  const failed = s.steps.some((x) => stepState(x) === "failed");
  return (
    <Panel
      title="Last run"
      className="ov-lastrun"
      bodyClassName="ov-scroll"
      status={s.steps.length ? <span className={cx("ov-result", failed ? "ov-result--bad" : "ov-result--ok")}>{failed ? "Failed" : "Succeeded"}</span> : undefined}
      actions={
        s.run_id && s.steps.length ? (
          <Link className="ov-link" to={`/activity/runs/${encodeURIComponent(s.run_id)}`}>
            View log
          </Link>
        ) : undefined
      }
    >
      {s.steps.length ? (
        <StepList steps={uiSteps(s.steps)} aria-label="Last run steps" />
      ) : (
        <EmptyState
          title="No run steps to show"
          description={
            <>
              A tear-down clears the last run's steps; earlier runs are in <Link to="/activity">Activity</Link>. A deploy's steps show here as GitHub runs them.
            </>
          }
          action={s.state === "destroyed" ? { label: "Deploy", onClick: () => onAction("deploy") } : undefined}
        />
      )}
    </Panel>
  );
}
