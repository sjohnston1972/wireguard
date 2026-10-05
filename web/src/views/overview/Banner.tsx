import { Clock, Gauge, Hourglass, Link2, MoveRight, PauseCircle, Play, Timer, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { OverviewResponse } from "@shared/api";
import { Button, ProgressBar, cx } from "@/components";
import { useRePeerLabs } from "@/api/mutations";
import { WidgetCorner, useCornerHost, useWidget } from "@/widgets";
import { DeployForm, actionAllowed, type ActionName } from "./actions";
import { STATE_TONE, STATE_WORD, currentStep, failedStep, formatElapsed, formatSpan, hhmm, inGithubRun, isBusy, moveTargets, regionShort, stepProgress, usually } from "./model";
import { useServerNow } from "./hooks";
import { labsBannerText } from "./labs";
import "./Banner.css";

interface Props {
  o: OverviewResponse;
  now: number;
  receivedAt: number;
  onAction: (a: ActionName) => void;
}

/** The round state mark: a ring in the state's colour (turning while busy) with a dot. */
export function StateMark({ state, size = 40 }: { state: OverviewResponse["snapshot"]["state"]; size?: number }) {
  return <span className={cx("ov-mark", `ov-mark--${STATE_TONE[state]}`, isBusy(state) && "ov-mark--busy")} style={{ width: size, height: size }} aria-hidden />;
}

/** The line under the state word. `autoDestroy` false leaves the timer out (the Auto-destroy time setting). */
function gatewaySubline(o: OverviewResponse, now: number, autoDestroy = true, labs = false): string {
  const s = o.snapshot;
  const step = currentStep(s.steps);
  switch (s.state) {
    case "deploying":
      return step ? `Setting up WireGuard on Azure: ${step.name}` : "Setting up WireGuard on Azure: waiting for GitHub to start";
    case "destroying":
      return step ? `Removing the VM, its address and DNS record: ${step.name}` : "Removing the VM, its address and DNS record";
    case "hibernating":
      return "Powering the VM off; its disk and address are kept";
    case "resuming":
      return "Powering the VM back on; clients reconnect by themselves";
    case "running": {
      const at = s.auto_destroy_at ? Date.parse(s.auto_destroy_at) - now : null;
      const timer = at === null ? "no timer set" : at > 0 ? `${o.config.expiryAction === "hibernate" ? "hibernates" : "tears down"} in ${formatSpan(at)}` : "timer due";
      const up = `Up at ${o.config.dnsName || "its address"} in ${regionShort(s.region ?? o.config.region) || "Azure"}`;
      return autoDestroy ? `${up} · ${timer}` : up;
    }
    case "standby":
      return "Powered off; disk and address kept. Resume takes about a minute";
    case "failed":
      return s.error ?? "The last run failed";
    case "destroyed":
      return `${labs ? "No gateway VM, £0 for it." : "Nothing in Azure, £0."} Deploy builds a ${o.config.vmSize || "VM"} and points ${o.config.dnsName || "the name"} at it`;
  }
}

/** The line under the state word, with "· 2 labs running (£0.12/h)" added while labs run. */
function subline(o: OverviewResponse, now: number, autoDestroy = true): string {
  const labs = labsBannerText(o.labs);
  const base = gatewaySubline(o, now, autoDestroy, !!labs);
  return labs ? `${base} · ${labs}` : base;
}

/** The middle block: elapsed time and the usual duration (a run), or how long it has been in this state. */
function Timing({ o, receivedAt, autoDestroy }: { o: OverviewResponse; receivedAt: number; autoDestroy: boolean }) {
  const now = useServerNow(o.now, receivedAt, 1000);
  const s = o.snapshot;
  const since = s.state === "running" ? s.running_since ?? s.since : s.state === "standby" ? s.standby_since ?? s.since : s.state === "hibernating" || s.state === "resuming" ? s.power_op_at ?? s.since : s.since;
  if (s.state === "destroyed" || !since) return null;
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  const label = isBusy(s.state) ? "Elapsed time" : s.state === "running" ? "Up for" : s.state === "standby" ? "In standby for" : "Failed";
  const typical = s.state === "deploying" ? usually(o.typicalSeconds.deploy) : s.state === "destroying" ? usually(o.typicalSeconds.destroy) : null;
  let note: string | null = typical;
  if (s.state === "running") note = !autoDestroy ? null : s.auto_destroy_at ? `Auto-destroy at ${hhmm(s.auto_destroy_at)}` : "No auto-destroy timer";
  if (s.state === "failed") note = null;
  return (
    <div className="ov-banner__timing">
      <Clock size={22} aria-hidden className="ov-banner__clock" />
      <div>
        <div className="ov-banner__caption">{label}</div>
        <div className="ov-banner__elapsed">{s.state === "failed" ? `${formatSpan(ms)} ago` : formatElapsed(ms)}</div>
        {note && <div className="ov-banner__note">{note}</div>}
        {isBusy(s.state) && !typical && (s.state === "deploying" || s.state === "destroying") && <div className="ov-banner__note">no typical time yet</div>}
      </div>
    </div>
  );
}

/** Labs waiting or disconnected, now that the gateway is up: one press peers them all. */
function RePeer({ n }: { n: number }) {
  const repeer = useRePeerLabs();
  return (
    <Button variant="secondary" className="ov-banner__icon-btn" title={`Re-peer ${n} ${n === 1 ? "lab" : "labs"}`} icon={<Link2 size={16} aria-hidden />} loading={repeer.isPending} disabled={repeer.isPending} onClick={() => repeer.mutate()}>
      <span className="ov-banner__btn-word">{`Re-peer ${n} ${n === 1 ? "lab" : "labs"}`}</span>
    </Button>
  );
}

function Actions({ o, onAction }: { o: OverviewResponse; onAction: (a: ActionName) => void }) {
  const s = o.snapshot.state;
  if (inGithubRun(s))
    return (
      <Button variant="danger" className="ov-banner__cancel" onClick={() => onAction("cancel")}>
        {s === "destroying" ? "Cancel tear-down" : "Cancel deploy"}
      </Button>
    );
  if (s === "running")
    return (
      <div className="ov-banner__buttons">
        <Button variant="primary" icon={<Timer size={16} aria-hidden />} onClick={() => onAction("extend")}>
          Extend
        </Button>
        <Button variant="secondary" className="ov-banner__icon-btn" title="Hibernate" icon={<PauseCircle size={16} aria-hidden />} onClick={() => onAction("hibernate")}>
          <span className="ov-banner__btn-word">Hibernate</span>
        </Button>
        <Button
          variant="secondary"
          className="ov-banner__icon-btn"
          icon={<MoveRight size={16} aria-hidden />}
          disabled={!moveTargets(o).length}
          title={moveTargets(o).length ? "Move" : "No other profile to move to"}
          onClick={() => onAction("move")}
        >
          <span className="ov-banner__btn-word">Move</span>
        </Button>
        {o.labs.rePeer > 0 && <RePeer n={o.labs.rePeer} />}
        <Button variant="secondary" className="ov-banner__icon-btn" title={o.snapshot.speedtest_req ? "Speed test running…" : "Speed test"} icon={<Gauge size={16} aria-hidden />} disabled={!!o.snapshot.speedtest_req} onClick={() => onAction("speedtest")}>
          <span className="ov-banner__btn-word">{o.snapshot.speedtest_req ? "Speed test running…" : "Speed test"}</span>
        </Button>
        <Button variant="danger" className="ov-banner__icon-btn" title="Tear down" icon={<Trash2 size={16} aria-hidden />} onClick={() => onAction("destroy")}>
          <span className="ov-banner__btn-word">Tear down</span>
        </Button>
      </div>
    );
  if (s === "standby")
    return (
      <div className="ov-banner__buttons">
        <Button variant="primary" icon={<Play size={16} aria-hidden />} onClick={() => onAction("resume")}>
          Resume
        </Button>
        <Button variant="danger" icon={<Trash2 size={16} aria-hidden />} onClick={() => onAction("destroy")}>
          Tear down
        </Button>
      </div>
    );
  if (s === "failed")
    return (
      <div className="ov-banner__buttons">
        <Button variant="primary" disabled={!actionAllowed("cleanup", o)} onClick={() => onAction("cleanup")}>
          Clean up
        </Button>
        <Button variant="secondary" onClick={() => onAction("deploy")}>
          Deploy again
        </Button>
      </div>
    );
  if (s === "hibernating" || s === "resuming")
    return (
      <span className="ov-banner__wait">
        <Hourglass size={16} aria-hidden /> Usually about a minute
      </span>
    );
  return null;
}

/** The full-width status banner: state, progress, timing and the state's actions. */
export function StatusBanner({ o, now, receivedAt, onAction }: Props) {
  const { settings: st } = useWidget("overview.status");
  const host = useCornerHost();
  const autoDestroy = st.autoDestroy as boolean;
  const s = o.snapshot;
  const progress = inGithubRun(s.state) ? stepProgress(s.steps) : null;
  const failed = s.state === "failed" ? failedStep(s.steps) : null;
  const tone = STATE_TONE[s.state];
  return (
    <section className={cx("ov-banner", `ov-banner--${s.state}`, host)} aria-label="Status">
      <div className="ov-banner__state">
        <div className="ov-banner__head">
          <StateMark state={s.state} />
          <div className="ov-banner__words">
            <p className={cx("ov-banner__word", `ov-tone--${tone}`)}>{STATE_WORD[s.state]}</p>
            <p className="ov-banner__sub">{subline(o, now, autoDestroy)}</p>
          </div>
        </div>
        {inGithubRun(s.state) && st.progress && (
          <div className="ov-banner__progress">
            <ProgressBar label={`${STATE_WORD[s.state]} progress`} value={progress ? progress.pct : null} showValue tone="blue" />
            <p className="ov-banner__steps">{progress ? `${progress.done} of ${progress.total} steps completed` : "Waiting for GitHub to list the steps"}</p>
          </div>
        )}
        {failed && (
          <p className="ov-banner__failed">
            Failed at step {failed.place}: {failed.name}
            {s.run_id && (
              <Link className="ov-banner__link" to={`/activity/runs/${encodeURIComponent(s.run_id)}`}>
                View log
              </Link>
            )}
          </p>
        )}
      </div>
      {s.state === "destroyed" ? (
        <div className="ov-banner__deploy">
          <DeployForm o={o} />
        </div>
      ) : (
        <>
          {st.timing && <Timing o={o} receivedAt={receivedAt} autoDestroy={autoDestroy} />}
          <div className="ov-banner__actions">
            <Actions o={o} onAction={onAction} />
          </div>
        </>
      )}
      <WidgetCorner />
    </section>
  );
}
