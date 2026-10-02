import { Download } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import type { FirewallResponse } from "@shared/api";
import { Button, Field, Panel, Select, cx } from "@/components";
import { useStartCapture } from "@/api/mutations";
import { useClients } from "@/api/queries";
import "./Capture.css";

type Capture = FirewallResponse["captures"][number];

const STATUS: Record<Capture["status"], string> = { waiting: "Waiting for the VM", running: "Running", done: "Ready", failed: "Failed" };
const ukTime = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
const size = (b: number | null) => (b === null ? "" : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export interface CaptureFormHandle {
  focus: () => void;
}

/** Start a capture on the VM (instant, not part of the draft); the latest captures to download. */
export const CaptureForm = forwardRef<CaptureFormHandle, { fw: FirewallResponse }>(function CaptureForm({ fw }, ref) {
  const start = useStartCapture();
  const clients = useClients();
  const ifaces = Object.entries(fw.capture.ifaces);
  const [iface, setIface] = useState(ifaces[0]?.[0] ?? "wg0");
  const [who, setWho] = useState("any");
  const [seconds, setSeconds] = useState("30");
  const [filter, setFilter] = useState("");
  const wrap = useRef<HTMLFormElement>(null);
  useImperativeHandle(ref, () => ({
    focus: () => {
      const el = wrap.current?.querySelector<HTMLElement>("button, input");
      el?.scrollIntoView?.({ block: "nearest" });
      el?.focus();
    },
  }));

  const busy = fw.capture.busy;
  const why = !fw.running ? "The VM is not running." : busy ? "A capture is already running." : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (why) return;
    start.mutate({ iface, who: who === "any" ? "any" : Number(who), seconds: Number(seconds), filter: filter.trim() });
  };
  const whoOptions = [{ value: "any", label: "Everyone" }, ...(clients.data?.clients ?? []).map((c) => ({ value: String(c.id), label: c.name }))];

  return (
    <div className="fw-cap">
      <form ref={wrap} className="fw-cap__form" onSubmit={submit} noValidate>
        <div className="fw-cap__row">
          <Select label="Interface" showLabel value={iface} onValueChange={setIface} options={ifaces.map(([k, v]) => ({ value: k, label: `${k} · ${v.split(" (")[0]}` }))} />
          <Select label="Who" showLabel value={who} onValueChange={setWho} options={whoOptions} />
        </div>
        <div className="fw-cap__row">
          <Field label="Seconds" error={start.fieldError("seconds")}>
            {(p) => <input {...p} className="input" inputMode="numeric" value={seconds} onChange={(e) => setSeconds(e.target.value)} />}
          </Field>
          <Field label="Filter" error={start.fieldError("filter")}>
            {(p) => <input {...p} className="input input--mono" value={filter} placeholder="port 53" onChange={(e) => setFilter(e.target.value)} />}
          </Field>
        </div>
        <div className="fw-cap__go">
          <Button type="submit" variant="primary" size="sm" loading={start.isPending} disabled={!!why || start.isPending}>
            Start capture
          </Button>
          {why && <span className="fw-cap__why">{why}</span>}
        </div>
      </form>
      {fw.captures.length > 0 && (
        <ul className="fw-cap__list" aria-label="Recent captures">
          {fw.captures.slice(0, 5).map((c) => (
            <li key={c.id} className="fw-cap__item">
              <span className={cx("fw-cap__status", `fw-cap__status--${c.status}`)}>{STATUS[c.status]}</span>
              <span className="fw-cap__what">
                {c.iface}, {c.seconds} s · {ukTime.format(new Date(c.requested_at))}
                {c.error && <span className="fw-cap__err"> · {c.error}</span>}
              </span>
              {c.status === "done" && (
                <a className="fw-cap__dl" href={`/captures/${encodeURIComponent(c.id)}`} download aria-label={`Download capture of ${c.iface}, ${c.seconds} s, ${size(c.bytes)}`}>
                  <Download size={14} aria-hidden /> {size(c.bytes)}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

export const CapturePanel = forwardRef<CaptureFormHandle, { fw: FirewallResponse }>(function CapturePanel({ fw }, ref) {
  return (
    <Panel title="Packet capture" scroll className="fw-cap-panel">
      <CaptureForm ref={ref} fw={fw} />
    </Panel>
  );
});
