import { useMemo, useState } from "react";
import type { OverviewResponse } from "@shared/api";
import { Button, KeyValue, LogView, ProgressBar, Sheet, StepList, cx } from "@/components";
import { useCost, useRunLog } from "@/api/queries";
import type { ActionName } from "./actions";
import { StateMark } from "./Banner";
import { healthChecks } from "./Lower";
import { STATE_TONE, STATE_WORD, ageOf, currentStep, gbp, inGithubRun, moveTargets, parseLog, regionFull, stepProgress, topology, uiSteps, type NodeStatus } from "./model";
import "./Phone.css";

type Tone = "green" | "amber" | "red" | "grey";
const TONE: Record<NodeStatus, Tone> = { healthy: "green", degraded: "amber", down: "red", unknown: "grey" };

function lights(o: OverviewResponse): { name: string; word: string; tone: Tone }[] {
  const s = o.snapshot;
  const d = o.derived;
  const running = s.state === "running";
  const stale = running && d.heartbeatStale;
  const tunnelBad = s.selftest && (s.selftest.tunnel === false || s.selftest.handshake === false);
  return [
    { name: "Tunnel", ...(!running ? { word: "Off", tone: "grey" as Tone } : stale ? { word: "No heartbeat", tone: "red" as Tone } : tunnelBad ? { word: "Failing", tone: "red" as Tone } : { word: "Up", tone: "green" as Tone }) },
    {
      name: "DNS",
      ...(!running
        ? { word: d.dnsParked ? "Parked" : "Off", tone: "grey" as Tone }
        : s.dns_live && s.agent?.dns?.up !== false
          ? { word: "OK", tone: "green" as Tone }
          : { word: "Problem", tone: "amber" as Tone }),
    },
    { name: "Clients online", ...(running && !stale ? { word: `${d.clientsOnline} of ${d.clientsEnabled}`, tone: (d.clientsOnline ? "green" : "amber") as Tone } : { word: "no data", tone: "grey" as Tone }) },
    // The overview does not say whether the home site is connected, only that it is set up.
    { name: "Home site", ...(o.site ? { word: `${o.site.name}, set up`, tone: "grey" as Tone } : { word: "none", tone: "grey" as Tone }) },
  ];
}

function PhoneLog({ o }: { o: OverviewResponse }) {
  const s = o.snapshot;
  const q = useRunLog(s.run_id ?? "none", inGithubRun(s.state), { enabled: !!s.run_id });
  const parsed = useMemo(() => parseLog(q.data?.log || s.log_tail), [q.data, s.log_tail]);
  return (
    <div className="ov-phone__log">
      <LogView lines={parsed.lines} aria-label="Run log" toolbar={false} />
    </div>
  );
}

/** The phone composition (spec §9): state word, compact topology, lights, the main action and small buttons; steps, log and details in sheets. */
export function PhoneOverview({ o, now, onAction }: { o: OverviewResponse; now: number; onAction: (a: ActionName) => void }) {
  const [sheet, setSheet] = useState<"steps" | "log" | "details" | null>(null);
  const cost = useCost("month");
  const s = o.snapshot;
  const t = topology(o);
  const run = inGithubRun(s.state);
  const progress = run ? stepProgress(s.steps) : null;
  const step = currentStep(s.steps);
  const stepNo = step ? s.steps.indexOf(step) + 1 : null;

  let main: { label: string; action: ActionName; variant: "primary" | "danger" } | null = null;
  if (s.state === "destroyed") main = { label: "Deploy", action: "deploy", variant: "primary" };
  else if (s.state === "running") main = { label: "Extend", action: "extend", variant: "primary" };
  else if (s.state === "standby") main = { label: "Resume", action: "resume", variant: "primary" };
  else if (s.state === "failed") main = { label: "Clean up", action: "cleanup", variant: "primary" };
  else if (run) main = { label: s.state === "destroying" ? "Cancel tear-down" : "Cancel deploy", action: "cancel", variant: "danger" };

  const small: { label: string; onClick: () => void; disabled?: boolean }[] = [];
  if (s.state === "running") {
    small.push({ label: "Hibernate", onClick: () => onAction("hibernate") });
    small.push({ label: "Tear down", onClick: () => onAction("destroy") });
    small.push({ label: "Speed", onClick: () => onAction("speedtest"), disabled: !!s.speedtest_req });
    small.push({ label: "Move", onClick: () => onAction("move"), disabled: !moveTargets(o).length });
  }
  if (s.state === "standby") small.push({ label: "Tear down", onClick: () => onAction("destroy") });
  if (s.state === "failed") small.push({ label: "Deploy again", onClick: () => onAction("deploy") });
  if (run || s.state === "failed") {
    small.push({ label: "Steps", onClick: () => setSheet("steps") });
    small.push({ label: "Log", onClick: () => setSheet("log") });
  }
  small.push({ label: "Details", onClick: () => setSheet("details") });

  const nodes: [string, NodeStatus, string][] = [
    ["Clients", t.clients.status, t.clients.word],
    ["VM", t.endpoint.status, t.endpoint.word],
    ["Azure", t.azure.status, t.azure.word],
  ];

  return (
    <section className="ov-phone" aria-label="Environment status">
      <div className="ov-phone__state">
        <StateMark state={s.state} size={34} />
        <div>
          <p className={cx("ov-phone__word", `ov-phone__word--${STATE_TONE[s.state]}`)}>{STATE_WORD[s.state]}</p>
          <p className="ov-phone__sub">{s.state === "failed" ? s.error ?? "The last run failed" : `${o.config.dnsName} · ${regionFull(s.region ?? o.config.region)}`}</p>
        </div>
      </div>

      {run && (
        <div className="ov-phone__progress">
          <p className="ov-phone__step">{step && stepNo ? `Step ${stepNo} of ${s.steps.length}: ${step.name}` : progress ? `${progress.done} of ${progress.total} steps completed` : "Waiting for GitHub to start"}</p>
          <ProgressBar label="Run progress" value={progress ? progress.pct : null} showValue />
        </div>
      )}

      <ol className="ov-phone__topo" aria-label="Topology">
        {nodes.map(([name, st, word], i) => (
          <li key={name} className="ov-phone__node" data-status={st} aria-label={`${name}: ${word}`}>
            {i > 0 && <span className="ov-phone__line" data-status={i === 1 ? t.edges[0] : t.edges[1]} aria-hidden />}
            <span className="ov-phone__dot" aria-hidden />
            <span className="ov-phone__name">{name}</span>
          </li>
        ))}
      </ol>

      <ul className="ov-phone__lights" aria-label="Status lights">
        {lights(o).map((l) => (
          <li key={l.name} className="ov-light" data-tone={l.tone} aria-label={`${l.name}: ${l.word}`}>
            <span className="ov-light__dot" aria-hidden />
            <span className="ov-light__name">{l.name}</span>
            <span className="ov-light__word">{l.word}</span>
          </li>
        ))}
      </ul>

      {main && (
        <Button size="lg" variant={main.variant} className="ov-phone__main" onClick={() => onAction(main.action)}>
          {main.label}
        </Button>
      )}
      <div className="ov-phone__small">
        {small.map((b) => (
          <Button key={b.label} size="md" variant="secondary" disabled={b.disabled} onClick={b.onClick}>
            {b.label}
          </Button>
        ))}
      </div>

      <Sheet open={sheet === "steps"} onOpenChange={(v) => !v && setSheet(null)} title="Steps" subtitle={progress ? `${progress.done} of ${progress.total} completed` : undefined}>
        {s.steps.length ? <StepList steps={uiSteps(s.steps)} aria-label="Run steps" /> : <p className="ov-phone__sub">GitHub has not listed the steps yet.</p>}
      </Sheet>
      <Sheet open={sheet === "log"} onOpenChange={(v) => !v && setSheet(null)} title="Log">
        <PhoneLog o={o} />
      </Sheet>
      <Sheet open={sheet === "details"} onOpenChange={(v) => !v && setSheet(null)} title="Details">
        <KeyValue
          items={[
            { label: "Endpoint", value: o.config.dnsName || null, mono: true, copy: true },
            { label: "Public IP", value: s.public_ip, mono: true, copy: true },
            { label: "Region", value: regionFull(s.region ?? o.config.region) || null },
            { label: "VM size", value: s.vm_size ?? (o.config.vmSize || null) },
            { label: "Heartbeat", value: s.state === "running" ? ageOf(s.last_agent_at, now) : null },
            { label: "Session cost", value: s.state === "running" || s.state === "standby" ? (cost.data?.session.estimateGbp == null ? null : gbp(cost.data.session.estimateGbp)) : null },
          ]}
        />
        <ul className="ov-phone__checks" aria-label="Health checks">
          {healthChecks(o, now).map((c) => (
            <li key={c.name} className="ov-light" data-tone={c.ok === null ? "grey" : c.ok ? "green" : "red"}>
              <span className="ov-light__dot" aria-hidden />
              <span className="ov-light__name">{c.name}</span>
              <span className="ov-light__word">{c.ok === null ? "no data" : c.ok ? `OK · ${c.age ?? ""}` : "Failing"}</span>
            </li>
          ))}
        </ul>
      </Sheet>
    </section>
  );
}

