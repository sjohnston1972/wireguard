import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Cog, Eye, Rocket, Shield, Trash2, XCircle } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { Button, EmptyState, ErrorState, Panel, SegmentedControl, Skeleton, TimeSeriesChart, cx } from "@/components";
import { useActivity, useHistory } from "@/api/queries";
import { useWidget } from "@/widgets";
import { useElementHeight } from "./hooks";
import { useStarting } from "./widgetSettings";
import { ageOf, hhmm } from "./model";
import type { ActionName } from "./actions";
import "./Side.css";

const EVENT_ICON = { deploy: Rocket, destroy: Trash2, failure: XCircle, config: Cog, firewall: Shield, watchman: Eye } as const;
const EVENT_TONE = { deploy: "green", destroy: "grey", failure: "red", config: "blue", firewall: "blue", watchman: "amber" } as const;

type EventRange = "1h" | "6h" | "24h" | "7d";
const EVENT_RANGE_WORD: Record<EventRange, string> = { "1h": "the last hour", "6h": "the last 6 h", "24h": "the last 24 h", "7d": "the last 7 days" };

/** The latest of Activity's combined list (runs, notes, changes): by default five from the last 24 hours. */
export function RecentEvents() {
  const { settings: st } = useWidget("overview.events");
  const range = st.range as EventRange;
  const types = st.types as string[];
  const q = useActivity({ range });
  const events = (q.data?.all ?? []).filter((e) => types.includes(e.type)).slice(0, st.rows as number);
  return (
    <Panel
      title="Recent events"
      className="ov-events"
      bodyClassName="ov-scroll"
      actions={
        <Link className="ov-link" to="/activity">
          View all <ArrowRight size={14} aria-hidden />
        </Link>
      }
    >
      {q.isLoading ? (
        <div className="ov-events__skel" aria-busy="true" aria-label="Loading events">
          <Skeleton variant="row" />
          <Skeleton variant="row" />
          <Skeleton variant="row" />
        </div>
      ) : q.isError ? (
        <ErrorState title="Could not load events" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : events.length === 0 ? (
        <EmptyState title={`No events in ${EVENT_RANGE_WORD[range]}`} description="Deploys, tear-downs, notes and changes show here." />
      ) : (
        <ul className="ov-events__list">
          {events.map((e, i) => {
            const Icon = EVENT_ICON[e.type] ?? CheckCircle2;
            return (
              <li key={`${e.ref.kind}-${e.ref.id}-${i}`} className="ov-event">
                <span className={cx("ov-event__icon", `ov-event__icon--${EVENT_TONE[e.type] ?? "grey"}`)} aria-hidden>
                  <Icon size={14} />
                </span>
                <span className="ov-event__time">{hhmm(e.at)}</span>
                <span className="ov-event__text">
                  <span className="ov-event__title">{e.title}</span>
                  {st.detail && e.detail && <span className="ov-event__detail">{e.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

type TrafficWindow = "5m" | "15m" | "1h" | "session" | "24h" | "7d";
const WINDOW_MS: Record<"5m" | "15m" | "1h" | "session", number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, session: Infinity };
const SESSION_WINDOWS: { value: TrafficWindow; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "session", label: "Session" },
];
const HISTORY_WORD = { "24h": "last 24 hours", "7d": "last 7 days" } as const;

/** One sample: when, bytes per second in and out, and (history only) the peaks. */
interface Sample {
  t: number;
  rx: number | null;
  tx: number | null;
  rxMax?: number | null;
  txMax?: number | null;
}

/**
 * Throughput (in = clients to Azure, out = Azure to clients). Session windows
 * read this session's samples (one per heartbeat); 24h and 7d read the VM's
 * history (rx_rate, tx_rate, and their peaks for the Peak line).
 */
export function Traffic({ o, now, className }: { o: OverviewResponse; now: number; className?: string }) {
  const { settings: st } = useWidget("overview.traffic");
  const [win, setWin] = useStarting(st.window as TrafficWindow);
  const { ref, height } = useElementHeight<HTMLDivElement>(140);
  const fromHistory = win === "24h" || win === "7d";
  const histQ = useHistory({ scope: "vm", range: win === "7d" ? "7d" : "24h" }, { enabled: fromHistory });
  const samples: Sample[] = fromHistory
    ? (histQ.data?.points ?? []).map((p) => ({ t: Date.parse(p.t), rx: p.rx_rate, tx: p.tx_rate, rxMax: p.rx_rate_max, txMax: p.tx_rate_max }))
    : o.snapshot.traffic_hist.filter((p) => now - Date.parse(p.t) <= WINDOW_MS[win as keyof typeof WINDOW_MS]).map((p) => ({ t: Date.parse(p.t), rx: p.rx, tx: p.tx }));
  const x = samples.map((p) => Math.floor(p.t / 1000));
  const mbps = st.units === "mbps";
  const conv = (v: number | null | undefined) => (v === null || v === undefined ? null : mbps ? Math.round(((v * 8) / 1e6) * 100) / 100 : Math.round((v / 1024) * 10) / 10);
  const series = st.series as string[];
  const lines = [
    ...(series.includes("in") ? [{ label: "In", color: "blue" as const, data: samples.map((p) => conv(p.rx)) }] : []),
    ...(series.includes("out") ? [{ label: "Out", color: "purple" as const, data: samples.map((p) => conv(p.tx)) }] : []),
    // The Peak line: the busiest moment in each history bucket (24h and 7d only).
    ...(fromHistory && st.peak && series.includes("in") ? [{ label: "In peak", color: "grey" as const, area: false, data: samples.map((p) => conv(p.rxMax)) }] : []),
    ...(fromHistory && st.peak && series.includes("out") ? [{ label: "Out peak", color: "grey" as const, area: false, data: samples.map((p) => conv(p.txMax)) }] : []),
  ];
  // The control offers the session windows, and the starting history window when that is one.
  const items = st.window === "24h" || st.window === "7d" ? [...SESSION_WINDOWS, { value: st.window as TrafficWindow, label: st.window as string }] : SESSION_WINDOWS;
  const running = o.snapshot.state === "running";
  return (
    <Panel
      title="Network traffic"
      className={cx("ov-traffic", className)}
      bodyClassName="ov-traffic__body"
      actions={<SegmentedControl aria-label="Traffic window" items={items} value={win} onChange={(v) => setWin(v as TrafficWindow)} />}
    >
      <div ref={ref} className="ov-traffic__chart">
        {fromHistory && histQ.isLoading ? (
          <Skeleton variant="block" height={Math.max(60, height - 8)} />
        ) : fromHistory && samples.length < 2 ? (
          <EmptyState title={histQ.isError ? "Traffic history unavailable" : "No traffic history in this window"} description={histQ.isError ? histQ.error.message : "The VM's heartbeats are kept as history while it runs."} />
        ) : samples.length < 2 ? (
          <EmptyState
            title={running ? "No traffic samples in this window" : "No traffic: nothing is running"}
            description={running ? "Samples arrive with each heartbeat; try a longer window." : "The chart fills once the VM is up and clients connect."}
          />
        ) : (
          <TimeSeriesChart
            title={fromHistory ? `Network traffic, ${HISTORY_WORD[win as "24h" | "7d"]}` : "Network traffic this session"}
            x={x}
            range={fromHistory ? (win as "24h" | "7d") : win === "5m" || win === "15m" ? "live" : "1h"}
            unit={mbps ? " Mbit/s" : " KB/s"}
            height={Math.max(60, height - 8)}
            series={lines}
          />
        )}
      </div>
    </Panel>
  );
}

/** Latest speed tests (Azure to the home site over the tunnel) and the button that opens the reviewed form. */
export function SpeedTests({ o, now, onAction }: { o: OverviewResponse; now: number; onAction: (a: ActionName) => void }) {
  const running = o.snapshot.state === "running";
  const pending = !!o.snapshot.speedtest_req;
  const { settings: st } = useWidget("overview.speedTest");
  const tests = o.speedtests.slice(0, st.shown as number);
  const n = (v: number | null, unit: string) => (v === null ? "no data" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${unit}`);
  return (
    <Panel
      title="Speed test"
      className="ov-speed"
      bodyClassName="ov-scroll"
      actions={
        <Button size="sm" variant="secondary" disabled={!running || pending} onClick={() => onAction("speedtest")} title={running ? undefined : "Needs a running VM"}>
          {pending ? "Running…" : "Run speed test"}
        </Button>
      }
    >
      {tests.length === 0 ? (
        <EmptyState title="No speed tests yet" description={running ? "Run one to measure Azure to the home site." : "Speed tests need a running VM."} />
      ) : (
        <ul className="ov-speed__list">
          {tests.map((t) => (
            <li key={t.id} className="ov-speed__row">
              <span className="ov-speed__when">{ageOf(t.at, now)}</span>
              {t.error ? (
                <span className="ov-speed__err">{t.error}</span>
              ) : (
                <>
                  <span>
                    <b>{n(t.down_mbps, "Mbit/s")}</b> down
                  </span>
                  <span>
                    <b>{n(t.up_mbps, "Mbit/s")}</b> up
                  </span>
                  <span>
                    {n(t.rtt_ms, "ms")}
                    {st.jitter && <span className="ov-speed__jitter">, jitter {n(t.jitter_ms, "ms")}</span>}
                  </span>
                </>
              )}
              {st.server && <span className="ov-speed__server">to {t.target_name ?? "an unnamed server"}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
