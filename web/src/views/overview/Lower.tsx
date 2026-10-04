import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Coins, HeartPulse } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { todayHead, verdict, verdictThresholds } from "@shared/verdict";
import { Button, Panel, Sparkline, cx } from "@/components";
import { useAzureSummary, useCost, useSession } from "@/api/queries";
import { useAckNotes } from "@/api/mutations";
import { usePagePrefs, useWidget } from "@/widgets";
import { ageOf, gbp, hhmm } from "./model";
import { BootLogModal } from "./BootLog";
import { LEVEL_TONE, levelOf, levelWord, thresholdOn } from "./widgetSettings";
import "./Lower.css";

type CheckKey = "vm" | "wireguard" | "dns" | "tunnel" | "selftest";
type Check = { key: CheckKey; name: string; ok: boolean | null; age: string | null; why?: string };

const CHECK_NAMES: [CheckKey, string][] = [
  ["vm", "VM reachable"],
  ["wireguard", "WireGuard service"],
  ["dns", "DNS resolving"],
  ["tunnel", "Tunnel connectivity"],
  ["selftest", "Self-test"],
];

/**
 * The five checks, from the heartbeat and the VM's self-test, or those of
 * them in `keys` (the Health summary's Checks setting). null = not known
 * (nothing running, or not reported).
 */
export function healthChecks(o: OverviewResponse, now: number, keys?: readonly string[]): Check[] {
  const s = o.snapshot;
  const running = s.state === "running";
  const beat = ageOf(s.last_agent_at, now);
  const st = s.selftest;
  const stAge = ageOf(st?.at, now);
  const pick = (all: Check[]) => (keys ? all.filter((c) => keys.includes(c.key)) : all);
  if (!running) return pick(CHECK_NAMES.map(([key, name]) => ({ key, name, ok: null, age: null })));
  const fresh = !!s.last_agent_at && !o.derived.heartbeatStale;
  const tunnel = st ? (st.tunnel === false || st.handshake === false ? false : st.tunnel === true || st.handshake === true ? true : null) : null;
  return pick([
    { key: "vm", name: "VM reachable", ok: s.last_agent_at ? fresh : null, age: beat, why: fresh ? undefined : "no heartbeat for over 2 minutes" },
    { key: "wireguard", name: "WireGuard service", ok: s.agent ? s.agent.listen_port !== null : null, age: beat },
    { key: "dns", name: "DNS resolving", ok: s.dns_live && s.agent?.dns?.up !== false, age: beat, why: !s.dns_live ? "the name does not point at the VM" : s.agent?.dns?.up === false ? "tunnel DNS not answering" : undefined },
    { key: "tunnel", name: "Tunnel connectivity", ok: tunnel, age: stAge },
    { key: "selftest", name: "Self-test", ok: st ? o.derived.selftestFailures.length === 0 : null, age: stAge, why: o.derived.selftestFailures.join(", ") || undefined },
  ]);
}

export function HealthSummary({ o, now }: { o: OverviewResponse; now: number }) {
  const { settings: st } = useWidget("overview.health");
  const ages = st.ages as boolean;
  const [bootLog, setBootLog] = useState(false);
  const checks = healthChecks(o, now, st.checks as string[]);
  // The Verdict line (on by default): Azure's and the VM's own figures rewrite the head; with none of them it is today's head.
  const on = st.verdict as boolean;
  const { prefs } = usePagePrefs("overview");
  const thresholds = useMemo(() => verdictThresholds(prefs), [prefs]);
  const azure = useAzureSummary({ enabled: on }).data;
  const head = on ? verdict({ state: o.snapshot.state, checks, azure, capacity: o.capacity, thresholds, now }) : { ...todayHead(o.snapshot.state, checks), bootLog: false };
  return (
    <Panel title="Health summary" className="ov-health" bodyClassName="ov-health__body">
      <div className="ov-health__head">
        <span className={cx("ov-health__icon", `ov-health__icon--${head.tone}`)} aria-hidden>
          <HeartPulse size={22} />
        </span>
        <div>
          <p className={cx("ov-health__title", `ov-health__title--${head.tone}`)} title={on ? head.title : undefined}>
            {head.title}
          </p>
          <p className="ov-health__sub">
            {head.sub}
            {head.bootLog && (
              <>
                {" · "}
                <button type="button" className="ov-health__bootlog" onClick={() => setBootLog(true)}>
                  Boot log
                </button>
              </>
            )}
          </p>
        </div>
      </div>
      <BootLogModal open={bootLog} onOpenChange={setBootLog} />
      <ul className="ov-health__list">
        {checks.map((c) => {
          const word = c.ok === null ? "no data" : c.ok ? "OK" : "Failing";
          const age = ages ? c.age : null;
          return (
            <li key={c.name} className="ov-check-item" data-ok={c.ok === null ? "unknown" : String(c.ok)} aria-label={`${c.name}: ${word}${age ? `, ${age}` : ""}${c.ok === false && c.why ? `, ${c.why}` : ""}`}>
              <span className="ov-check-item__dot" aria-hidden />
              <span className="ov-check-item__name">{c.name}</span>
              {/* Check ages off: a failing or unknown check keeps its word. */}
              {(ages || c.ok !== true) && <span className="ov-check-item__age">{c.ok === null ? "no data" : c.ok === false ? (ages ? `Failing · ${c.age ?? ""}` : "Failing") : c.age}</span>}
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
  const { settings: st } = useWidget("overview.costImpact");
  const q = useCost("month");
  const est = o.snapshot.state === "running" || o.snapshot.state === "standby" ? (q.data?.session.estimateGbp ?? null) : null;
  const finished = (q.data?.sessions ?? []).filter((x) => !x.stillRunning);
  const typical = median(finished.map((x) => x.estimatedGbp));
  const bars = [...(q.data?.sessions ?? [])].reverse().slice(-(st.sessions as number)).map((x) => x.estimatedGbp);
  // The Session estimate threshold (off unless set) colours this session's figure, with a word.
  const level = thresholdOn(st.session) ? levelOf(est, st.session, "above") : null;
  const word = levelWord(level, "above");
  return (
    <Panel
      title="Cost impact"
      className="ov-cost"
      bodyClassName="ov-cost__body"
      actions={
        <Link className="ov-link" to="/cost">
          View cost details <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      <div className="ov-cost__now">
        <span className="ov-cost__icon" aria-hidden>
          <Coins size={20} />
        </span>
        <div>
          <p className={cx("ov-cost__value", word && level && `ov-cost__value--${LEVEL_TONE[level]}`)}>{q.isLoading ? "…" : est === null ? "no data" : gbp(est)}</p>
          <p className="ov-cost__sub">
            {est === null && o.snapshot.state !== "running" ? "nothing running" : "this session"}
            {word && level && (
              <>
                {" · "}
                <span className={cx("ov-cost__word", `ov-cost__word--${LEVEL_TONE[level]}`)}>{word}</span>
              </>
            )}
          </p>
        </div>
      </div>
      <div className="ov-cost__bars">{bars.length ? <Sparkline variant="bars" data={bars} label="Recent sessions' cost" unit=" GBP" tone="amber" width={96} height={36} /> : <span className="ov-cost__sub">no sessions yet</span>}</div>
      {st.typical && (
        <div className="ov-cost__typical">
          <p className="ov-cost__value ov-cost__value--sm">{typical === null ? "no data" : `~${gbp(typical)}`}</p>
          <p className="ov-cost__sub">typical session</p>
        </div>
      )}
    </Panel>
  );
}

/** Watchman notes nobody has read yet (the mockup's "Activity feed" slot), with Acknowledge. */
export function WatchmanNotes() {
  const { settings: st } = useWidget("overview.notes");
  const q = useSession();
  const ack = useAckNotes();
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const unread = (q.data?.notes ?? []).filter((n) => !hidden.has(n.id));
  // Show at most: the newest few. Acknowledge still marks every unread note read (the server's ack is for all).
  const notes = st.max === "all" ? unread : unread.slice(0, Number(st.max));
  const acknowledge = () => {
    const ids = unread.map((n) => n.id);
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
            <li key={n.id} className={cx("ov-note", !st.times && "ov-note--notime")}>
              <span className="ov-note__dot" aria-hidden />
              {st.times && <span className="ov-note__time">{hhmm(n.at)}</span>}
              <span className="ov-note__msg">{n.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

