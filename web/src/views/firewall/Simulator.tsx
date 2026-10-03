import { CheckCircle2, Play, XCircle } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import type { FirewallResponse, SimEnd, SimRequest, SimResult } from "@shared/api";
import { Button, Field, Panel, SegmentedControl, Select, cx } from "@/components";
import { useSimulate } from "@/api/mutations";
import { useStarting, useWidget } from "@/widgets";
import { EndPicker } from "./EndPicker";
import "./Simulator.css";

export interface SimulatorHandle {
  focus: () => void;
}

const ref = (r: { name: string; place: number }) => `${r.name} (rule ${r.place})`;

function Result({ result, policy, defaultAction }: { result: SimResult; policy: "live" | "draft"; defaultAction: string }) {
  const allow = result.verdict === "allow";
  const Icon = allow ? CheckCircle2 : XCircle;
  return (
    <div className={cx("fw-sim__result", allow ? "fw-sim__result--allow" : "fw-sim__result--deny")} role="status" aria-label="Simulation result">
      <Icon className="fw-sim__icon" size={22} aria-hidden />
      <div className="fw-sim__text">
        <p className="fw-sim__verdict">
          Would be {allow ? "ALLOWED" : "DENIED"}
          {policy === "draft" && <span className="fw-sim__by"> by the draft</span>}
        </p>
        <p className="fw-sim__match">{result.matched ? <>Matched rule: {ref(result.matched)}</> : <>No rule matched: the default action ({defaultAction}) decided.</>}</p>
        {result.partial.length > 0 && <p className="fw-sim__note">Partial matches, which depend on the exact address: {result.partial.map(ref).join(", ")}.</p>}
        {result.limited && <p className="fw-sim__note fw-sim__note--limited">Limited simulation: {result.limited}</p>}
      </div>
    </div>
  );
}

type Policy = "live" | "draft";

/** Live rules or the draft: shown only while a draft exists. */
function PolicySwitch({ value, onChange, className }: { value: Policy; onChange: (v: Policy) => void; className?: string }) {
  return (
    <SegmentedControl
      aria-label="Test against"
      value={value}
      onChange={(v) => onChange(v as Policy)}
      items={[
        { value: "live", label: "Live rules" },
        { value: "draft", label: "Draft" },
      ]}
      className={className}
    />
  );
}

/**
 * "Test specific traffic": which rule would decide one flow, against the live
 * rules or the draft. The panel puts the Live/Draft switch in its title row
 * (`choice` and `onChoice`); on its own (a tab) the form shows it inline.
 */
export const SimulatorForm = forwardRef<SimulatorHandle, { fw: FirewallResponse; choice?: Policy; onChoice?: (v: Policy) => void }>(function SimulatorForm(
  { fw, choice: outerChoice, onChoice },
  handle,
) {
  const sim = useSimulate();
  // The Test specific traffic widget's starting values (Clients to Home, TCP 22 as shipped).
  const { settings } = useWidget("firewall.simulator");
  const [from, setFrom] = useStarting<SimEnd>({ kind: "zone", value: settings.from as string });
  const [to, setTo] = useStarting<SimEnd>({ kind: "zone", value: settings.to as string });
  const [proto, setProto] = useStarting(settings.proto as SimRequest["proto"]);
  const [port, setPort] = useStarting(String(settings.port));
  const [innerChoice, setInnerChoice] = useState<Policy>("live");
  const choice = outerChoice ?? innerChoice;
  const setChoice = onChoice ?? setInnerChoice;
  const [asked, setAsked] = useState<"live" | "draft">("live");
  const form = useRef<HTMLFormElement>(null);
  useImperativeHandle(handle, () => ({
    focus: () => {
      const el = form.current?.querySelector<HTMLElement>("button, input");
      el?.scrollIntoView?.({ block: "nearest" });
      el?.focus();
    },
  }));
  const policy = fw.draft ? choice : "live";
  const shownDefault = (policy === "draft" ? fw.draft?.defaultAction : fw.defaultAction) ?? fw.defaultAction;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = proto === "icmp" || port.trim() === "" ? null : Number(port);
    setAsked(policy);
    sim.mutate({ from, to, proto, port: p, policy });
  };
  const general = sim.error && !(sim.error as { field?: string }).field ? sim.error.message : null;

  return (
    <form ref={form} className="fw-sim" onSubmit={submit} noValidate>
      <div className="fw-sim__row">
        <EndPicker label="From (source)" end={from} onChange={setFrom} fw={fw} error={sim.fieldError("from")} />
        <EndPicker label="To (destination)" end={to} onChange={setTo} fw={fw} error={sim.fieldError("to")} />
      </div>
      <div className="fw-sim__row fw-sim__row--go">
        <Select
          label="Protocol"
          showLabel
          value={proto}
          onValueChange={(v) => setProto(v as SimRequest["proto"])}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
            { value: "icmp", label: "ICMP" },
          ]}
        />
        <Field label="Port" error={sim.fieldError("port")}>
          {(p) => <input {...p} className="input fw-sim__port" inputMode="numeric" disabled={proto === "icmp"} value={proto === "icmp" ? "" : port} onChange={(e) => setPort(e.target.value)} />}
        </Field>
        <Button type="submit" variant="primary" icon={<Play size={14} aria-hidden />} loading={sim.isPending} disabled={sim.isPending} className="fw-sim__go">
          Simulate
        </Button>
      </div>
      {fw.draft && !onChoice && <PolicySwitch value={choice} onChange={setChoice} className="fw-sim__policy" />}
      {general && (
        <p className="fw-form__error" role="alert">
          {general}
        </p>
      )}
      {sim.data && !sim.isPending && <Result result={sim.data} policy={asked} defaultAction={shownDefault} />}
    </form>
  );
});

export const SimulatorPanel = forwardRef<SimulatorHandle, { fw: FirewallResponse }>(function SimulatorPanel({ fw }, handle) {
  const [choice, setChoice] = useState<Policy>("live");
  return (
    <Panel title="Test specific traffic" scroll className="fw-sim-panel" actions={fw.draft ? <PolicySwitch value={choice} onChange={setChoice} className="fw-sim__policy" /> : undefined}>
      <p className="fw-panel-sub">See which rule would match a connection request.</p>
      <SimulatorForm ref={handle} fw={fw} choice={choice} onChoice={setChoice} />
    </Panel>
  );
});
