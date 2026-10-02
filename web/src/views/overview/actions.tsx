import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { OverviewResponse } from "@shared/api";
import { Button, Chips, ConfirmByTyping, Modal } from "@/components";
import { useCancel, useCleanup, useDeploy, useDestroy, useExtend, useHibernate, useMove, useResume, useSpeedTest } from "@/api/mutations";
import { chipHours, defaultHoursChip, formatSpan, gbp, hourChoices, moveTargets, regionShort } from "./model";
import "./actions.css";

/** Every reviewed form the Overview can open (the palette's ?action= names plus the banner's own). */
export type ActionName = "deploy" | "destroy" | "hibernate" | "resume" | "extend" | "speedtest" | "move" | "cancel" | "cleanup";
export const PALETTE_ACTIONS: ActionName[] = ["deploy", "destroy", "hibernate", "resume", "extend", "speedtest"];
export const ACTION_WORD: Record<ActionName, string> = {
  deploy: "Deploy",
  destroy: "Tear down",
  hibernate: "Hibernate",
  resume: "Resume",
  extend: "Extend",
  speedtest: "Speed test",
  move: "Move",
  cancel: "Cancel",
  cleanup: "Clean up",
};

/** Which forms make sense in a state (a palette action that does not is ignored). */
export function actionAllowed(name: ActionName, o: OverviewResponse): boolean {
  const s = o.snapshot.state;
  switch (name) {
    case "deploy":
      return s === "destroyed" || s === "failed";
    case "destroy":
      return s === "running" || s === "standby";
    case "hibernate":
    case "extend":
    case "speedtest":
      return s === "running";
    case "move":
      return s === "running" && moveTargets(o).length > 0;
    case "resume":
      return s === "standby";
    case "cancel":
      return s === "deploying" || s === "destroying";
    case "cleanup":
      return s === "failed";
  }
}

/** Why the GitHub-run actions cannot start, or null when they can. */
export function blockedReason(o: OverviewResponse): string | null {
  if (!o.actions.canDispatch) return "GitHub is not connected. Finish setup in Settings.";
  if (o.actions.lockHolder) return `Another run holds the lock (${o.actions.lockHolder}).`;
  return null;
}

function Blocked({ o }: { o: OverviewResponse }) {
  const why = blockedReason(o);
  if (!why) return null;
  return (
    <p className="ov-form__note" role="note">
      {why} {!o.actions.canDispatch && <Link to="/settings/setup">Open setup</Link>}
    </p>
  );
}

function FieldError({ text }: { text?: string }) {
  return text ? (
    <p className="ov-form__error" role="alert">
      {text}
    </p>
  ) : null;
}

// ── Deploy ──

/** Where to build: one chip per profile, plus the nearest region when no profile covers it. Values "p:<id>" or "r:<region>". */
function whereChoices(o: OverviewResponse, profileId?: number | null): { items: { value: string; label: string }[]; initial: string } {
  const near = o.near.region;
  if (o.profiles.length) {
    // A profile asked for by id (Settings' "Use") wins while it still exists.
    const current =
      o.profiles.find((p) => p.id === profileId) ?? o.profiles.find((p) => p.region === o.config.region && p.vm_size === o.config.vmSize) ?? o.profiles[0];
    const items = o.profiles.map((p) => ({ value: `p:${p.id}`, label: p.name }));
    if (near && !o.profiles.some((p) => p.region === near)) items.push({ value: `r:${near}`, label: `Nearest: ${regionShort(near)}` });
    return { items, initial: `p:${current.id}` };
  }
  const home = o.config.region;
  const items = [{ value: `r:${home}`, label: regionShort(home) || "Usual region" }];
  if (near && near !== home) items.push({ value: `r:${near}`, label: `Nearest: ${regionShort(near)}` });
  return { items, initial: `r:${home}` };
}

/** The Deploy form: duration chips, where chips, the over-budget box. Inline in the banner, or in a dialog. */
export function DeployForm({ o, onDone, compact, profileId }: { o: OverviewResponse; onDone?: () => void; compact?: boolean; profileId?: number | null }) {
  const deploy = useDeploy();
  const where = whereChoices(o, profileId);
  const [hours, setHours] = useState(() => defaultHoursChip(o));
  const [choice, setChoice] = useState(where.initial);
  const [overOk, setOverOk] = useState(false);
  const titleId = useId();
  const overId = useId();
  const over = o.budget.level === "over";
  const blocked = blockedReason(o);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocked || (over && !overOk)) return;
    const target = choice.startsWith("p:") ? { profileId: Number(choice.slice(2)) } : { region: choice.slice(2) };
    deploy.mutate({ hours: chipHours(hours), ...target, overBudgetOk: overOk }, { onSuccess: () => onDone?.() });
  };

  return (
    <form className={compact ? "ov-deploy ov-deploy--compact" : "ov-deploy"} aria-labelledby={titleId} onSubmit={submit}>
      <span id={titleId} className="visually-hidden">
        Deploy
      </span>
      <div className="ov-deploy__fields">
        <div className="ov-deploy__field">
          <span className="ov-deploy__caption" aria-hidden>
            For how long?
          </span>
          <Chips aria-label="For how long?" mode="single" shape="rect" items={hourChoices()} value={[hours]} onChange={(v) => setHours(v[0] ?? hours)} />
          <FieldError text={deploy.fieldError("hours")} />
        </div>
        <div className="ov-deploy__field">
          <span className="ov-deploy__caption" aria-hidden>
            Where?
          </span>
          <Chips aria-label="Where?" mode="single" shape="rect" items={where.items} value={[choice]} onChange={(v) => setChoice(v[0] ?? choice)} />
          <FieldError text={deploy.fieldError("profileId") ?? deploy.fieldError("region")} />
        </div>
      </div>
      {over && (
        <div className="ov-deploy__over">
          <p>
            This month is at {Math.round(o.budget.pct)}% of the {gbp(o.budget.budget)} budget ({gbp(o.budget.total)} so far). <Link to="/cost">See Cost</Link>
          </p>
          <label htmlFor={overId} className="ov-check">
            <input id={overId} type="checkbox" checked={overOk} onChange={(e) => setOverOk(e.target.checked)} />
            Deploy anyway, over budget
          </label>
        </div>
      )}
      <div className="ov-deploy__go">
        <Button type="submit" variant="primary" size={compact ? "md" : "lg"} disabled={!!blocked || (over && !overOk) || deploy.isPending} loading={deploy.isPending}>
          Deploy
        </Button>
        <span className="ov-deploy__cost">About {gbp(o.config.hourlyRateGbp)} an hour while up</span>
      </div>
      <Blocked o={o} />
    </form>
  );
}

// ── The dialogs ──

interface DialogProps {
  o: OverviewResponse;
  onClose: () => void;
}

function DeployDialog({ o, onClose, profileId }: DialogProps & { profileId?: number | null }) {
  return (
    <Modal open onOpenChange={(v) => !v && onClose()} title="Deploy" description={`Builds a ${o.config.vmSize} in Azure and points ${o.config.dnsName} at it.`} width={560}>
      <DeployForm o={o} onDone={onClose} compact profileId={profileId} />
    </Modal>
  );
}

function TearDownDialog({ o, onClose }: DialogProps) {
  const destroy = useDestroy();
  const standby = o.snapshot.state === "standby";
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Tear down"
      description={
        standby
          ? "Removes the VM, its disk and address, back to £0. The next start is a full deploy."
          : "Removes the VM, its address and the DNS record. Clients keep their configs and reconnect after the next deploy."
      }
    >
      <ConfirmByTyping phrase="destroy" actionLabel="Tear down now" pending={destroy.isPending} onConfirm={() => destroy.mutate({ confirm: "destroy" }, { onSuccess: onClose })} />
      <FieldError text={destroy.fieldError("confirm")} />
      <Blocked o={o} />
    </Modal>
  );
}

function HibernateDialog({ o, onClose }: DialogProps) {
  const hib = useHibernate();
  const month = (rate: number) => gbp(rate * 24 * 30);
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Hibernate"
      description={`Powers the VM off but keeps its disk and address: about ${month(o.config.standbyRateGbp)} a month instead of ${month(o.config.hourlyRateGbp)}. Resume takes about a minute.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep running
          </Button>
          <Button variant="primary" loading={hib.isPending} disabled={hib.isPending} onClick={() => hib.mutate(undefined, { onSuccess: onClose })}>
            Hibernate now
          </Button>
        </>
      }
    />
  );
}

function HoursDialog({ o, onClose, kind }: DialogProps & { kind: "extend" | "resume" }) {
  const extend = useExtend();
  const resume = useResume();
  const m = kind === "extend" ? extend : resume;
  const [hours, setHours] = useState(() => (kind === "extend" ? "2" : defaultHoursChip(o)));
  const at = o.snapshot.auto_destroy_at;
  const left = at ? Date.parse(at) - Date.parse(o.now) : null;
  const go = () => {
    const h = chipHours(hours);
    if (kind === "extend") extend.mutate({ hours: h }, { onSuccess: onClose });
    else resume.mutate({ hours: h }, { onSuccess: onClose });
  };
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={kind === "extend" ? "Extend the timer" : "Resume"}
      description={
        kind === "extend"
          ? at && left !== null
            ? `Auto-destroy is set for ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" })}, in ${formatSpan(left)}. The new time counts from now.`
            : "No timer is set: the VM runs until you tear it down."
          : `Powers the VM back on. Same address, same DNS, same clients. About a minute, at ${gbp(o.config.hourlyRateGbp)} an hour while up.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={m.isPending} onClick={go}>
            {kind === "extend" ? "Set from now" : "Resume now"}
          </Button>
        </>
      }
    >
      <div className="ov-form__field">
        <span className="ov-deploy__caption" aria-hidden>
          For how long?
        </span>
        <Chips aria-label="For how long?" mode="single" shape="rect" items={hourChoices(kind === "extend" ? "+" : "")} value={[hours]} onChange={(v) => setHours(v[0] ?? hours)} />
        <FieldError text={m.fieldError("hours")} />
      </div>
    </Modal>
  );
}

function MoveDialog({ o, onClose }: DialogProps) {
  const move = useMove();
  const targets = moveTargets(o);
  const [pick, setPick] = useState<string>(targets[0] ? String(targets[0].id) : "");
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Move to another profile"
      description={`Tears this one down and builds the chosen profile straight after, about 6 minutes in all. Clients follow on their own: they dial ${o.config.dnsName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Stay here
          </Button>
          <Button variant="primary" disabled={!pick || move.isPending || !!blockedReason(o)} loading={move.isPending} onClick={() => move.mutate({ profileId: Number(pick) }, { onSuccess: onClose })}>
            Move now
          </Button>
        </>
      }
    >
      {targets.length ? (
        <Chips aria-label="Move to" mode="single" shape="rect" items={targets.map((p) => ({ value: String(p.id), label: `${p.name} · ${regionShort(p.region)}` }))} value={[pick]} onChange={(v) => setPick(v[0] ?? pick)} />
      ) : (
        <p>No other profile to move to. Add one in Settings.</p>
      )}
      <FieldError text={move.fieldError("profileId")} />
      <Blocked o={o} />
    </Modal>
  );
}

function SpeedDialog({ o, onClose }: DialogProps) {
  const speed = useSpeedTest();
  const pending = !!o.snapshot.speedtest_req;
  const last = o.speedtests[0];
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Speed test"
      description={`Azure to ${o.site?.name ?? "the home site"} and back over the tunnel: iperf3 for 5 seconds each way, then ten pings.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={pending || speed.isPending} loading={speed.isPending} onClick={() => speed.mutate(undefined, { onSuccess: onClose })}>
            {pending ? "Speed test running…" : "Run speed test"}
          </Button>
        </>
      }
    >
      {last ? (
        <p className="ov-form__note">
          Last result: {last.error ? last.error : `${last.down_mbps ?? "no data"} Mbit/s down, ${last.up_mbps ?? "no data"} Mbit/s up, ${last.rtt_ms ?? "no data"} ms`}.
        </p>
      ) : (
        <p className="ov-form__note">No speed test has run yet.</p>
      )}
    </Modal>
  );
}

function CancelDialog({ o, onClose }: DialogProps) {
  const cancel = useCancel();
  const what = o.snapshot.state === "destroying" ? "tear-down" : "deploy";
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Cancel the ${what}?`}
      description="Asks GitHub to stop the run. Anything it already built stays until a clean-up or tear-down removes it."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep going
          </Button>
          <Button variant="danger" disabled={cancel.isPending} loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onSuccess: onClose })}>
            Cancel the run
          </Button>
        </>
      }
    />
  );
}

function CleanupDialog({ o, onClose }: DialogProps) {
  const clean = useCleanup();
  return (
    <Modal
      open
      onOpenChange={(v) => !v && onClose()}
      title="Clean up"
      description="Runs a tear-down to make sure nothing was left in Azure after the failure."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" disabled={clean.isPending || !!blockedReason(o)} loading={clean.isPending} onClick={() => clean.mutate(undefined, { onSuccess: onClose })}>
            Start clean-up
          </Button>
        </>
      }
    >
      <Blocked o={o} />
    </Modal>
  );
}

/** The open action's reviewed form, or nothing. */
export function ActionDialog({ name, o, onClose, profileId }: { name: ActionName | null; o: OverviewResponse; onClose: () => void; profileId?: number | null }) {
  if (!name) return null;
  const p = { o, onClose };
  switch (name) {
    case "deploy":
      return <DeployDialog {...p} profileId={profileId} />;
    case "destroy":
      return <TearDownDialog {...p} />;
    case "hibernate":
      return <HibernateDialog {...p} />;
    case "extend":
      return <HoursDialog {...p} kind="extend" />;
    case "resume":
      return <HoursDialog {...p} kind="resume" />;
    case "move":
      return <MoveDialog {...p} />;
    case "speedtest":
      return <SpeedDialog {...p} />;
    case "cancel":
      return <CancelDialog {...p} />;
    case "cleanup":
      return <CleanupDialog {...p} />;
  }
}

