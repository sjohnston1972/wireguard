import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Coins, HeartPulse } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { Button, Panel, Sparkline, cx } from "@/components";
import { useCost, useSession } from "@/api/queries";
import { useAckNotes } from "@/api/mutations";
import { ageOf, gbp, hhmm } from "./model";
import "./Lower.css";

type Check = { name: string; ok: boolean | null; age: string | null; why?: string };

/** The five checks, from the heartbeat and the VM's self-test. null = not known (nothing running, or not reported). */
export function healthChecks(o: OverviewResponse, now: number): Check[] {
  const s = o.snapshot;
  const running = s.state === "running";
  const beat = ageOf(s.last_agent_at, now);
  const st = s.selftest;
  const stAge = ageOf(st?.at, now);
  if (!running) return ["VM reachable", "WireGuard service", "DNS resolving", "Tunnel connectivity", "Self-test"].map((name) => ({ name, ok: null, age: null }));
  const fresh = !!s.last_agent_at && !o.derived.heartbeatStale;
  const tunnel = st ? (st.tunnel === false || st.handshake === false ? false : st.tunnel === true || st.handshake === true ? true : null) : null;
  return [
    { name: "VM reachable", ok: s.last_agent_at ? fresh : null, age: beat, why: fresh ? undefined : "no heartbeat for over 2 minutes" },
    { name: "WireGuard service", ok: s.agent ? s.agent.listen_port !== null : null, age: beat },
    { name: "DNS resolving", ok: s.dns_live && s.agent?.dns?.up !== false, age: beat, why: !s.dns_live ? "the name does not point at the VM" : s.agent?.dns?.up === false ? "tunnel DNS not answering" : undefined },
    { name: "Tunnel connectivity", ok: tunnel, age: stAge },
    { name: "Self-test", ok: st ? o.derived.selftestFailures.length === 0 : null, age: stAge, why: o.derived.selftestFailures.join(", ") || undefined },
  ];
}

export function HealthSummary({ o, now }: { o: OverviewResponse; now: number }) {
  const checks = healthChecks(o, now);
  const bad = checks.filter((c) => c.ok === false);
  const known = checks.some((c) => c.ok !== null);
  const head = !known ? { tone: "grey", title: "No health data", sub: o.snapshot.state === "running" ? "Waiting for the first heartbeat." : "Nothing is running to check." } : bad.length ? { tone: "red", title: `${bad.length} check${bad.length === 1 ? "" : "s"} failing`, sub: bad.map((c) => c.name).join(", ") } : { tone: "green", title: "All systems healthy", sub: "Running and responding normally." };
  return (
    <Panel title="Health summary" className="ov-health" bodyClassName="ov-health__body">
      <div className="ov-health__head">
        <span className={cx("ov-health__icon", `ov-health__icon--${head.tone}`)} aria-hidden>
          <HeartPulse size={22} />
        </span>
        <div>
          <p className={cx("ov-health__title", `ov-health__title--${head.tone}`)}>{head.title}</p>
          <p className="ov-health__sub">{head.sub}</p>
        </div>
      </div>
      <ul className="ov-health__list">
        {checks.map((c) => {
          const word = c.ok === null ? "no data" : c.ok ? "OK" : "Failing";
          return (
            <li key={c.name} className="ov-check-item" data-ok={c.ok === null ? "unknown" : String(c.ok)} aria-label={`${c.name}: ${word}${c.age ? `, ${c.age}` : ""}${c.ok === false && c.why ? `, ${c.why}` : ""}`}>
              <span className="ov-check-item__dot" aria-hidden />
              <span className="ov-check-item__name">{c.name}</span>
              <span className="ov-check-item__age">{c.ok === null ? "no data" : c.ok === false ? `Failing · ${c.age ?? ""}` : c.age}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

const median = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** This session's estimate against a typical one, with recent sessions as bars. */
export function CostImpact({ o }: { o: OverviewResponse }) {
  const q = useCost("month");
  const est = o.snapshot.state === "running" || o.snapshot.state === "standby" ? (q.data?.session.estimateGbp ?? null) : null;
  const finished = (q.data?.sessions ?? []).filter((x) => !x.stillRunning);
  const typical = median(finished.map((x) => x.estimatedGbp));
  const bars = [...(q.data?.sessions ?? [])].reverse().slice(-16).map((x) => x.estimatedGbp);
  return (
    <Panel title="Cost impact" className="ov-cost" bodyClassName="ov-cost__body">
      <div className="ov-cost__now">
        <span className="ov-cost__icon" aria-hidden>
          <Coins size={20} />
        </span>
        <div>
          <p className="ov-cost__value">{q.isLoading ? "…" : est === null ? "no data" : gbp(est)}</p>
          <p className="ov-cost__sub">{est === null && o.snapshot.state !== "running" ? "nothing running" : "this session"}</p>
        </div>
      </div>
      <div className="ov-cost__bars">{bars.length ? <Sparkline variant="bars" data={bars} label="Recent sessions' cost" unit=" GBP" tone="amber" width={96} height={36} /> : <span className="ov-cost__sub">no sessions yet</span>}</div>
      <div className="ov-cost__typical">
        <p className="ov-cost__value ov-cost__value--sm">{typical === null ? "no data" : `~${gbp(typical)}`}</p>
        <p className="ov-cost__sub">typical session</p>
        <Link className="ov-link" to="/cost">
          View cost details <ArrowRight size={14} aria-hidden />
        </Link>
      </div>
    </Panel>
  );
}

/** Watchman notes nobody has read yet (the mockup's "Activity feed" slot), with Acknowledge. */
export function WatchmanNotes() {
  const q = useSession();
  const ack = useAckNotes();
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const notes = (q.data?.notes ?? []).filter((n) => !hidden.has(n.id));
  const acknowledge = () => {
    const ids = notes.map((n) => n.id);
    ack.mutate(undefined, { onSuccess: () => setHidden((h) => new Set([...h, ...ids])) });
  };
  return (
    <Panel
      title="Watchman notes"
      className="ov-notes"
      bodyClassName="ov-scroll"
      actions={
        notes.length ? (
          <Button size="sm" variant="secondary" loading={ack.isPending} disabled={ack.isPending} onClick={acknowledge}>
            Acknowledge
          </Button>
        ) : (
          <Link className="ov-link" to="/activity">
            View all <ArrowRight size={14} aria-hidden />
          </Link>
        )
      }
    >
      {notes.length === 0 ? (
        <p className="ov-notes__empty">{q.isLoading ? "Loading notes…" : "No unread notes."}</p>
      ) : (
        <ul className="ov-notes__list">
          {notes.map((n) => (
            <li key={n.id} className="ov-note">
              <span className="ov-note__dot" aria-hidden />
              <span className="ov-note__time">{hhmm(n.at)}</span>
              <span className="ov-note__msg">{n.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

