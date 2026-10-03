import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2, Cog, Eye, Rocket, Shield, Trash2, XCircle } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { Button, EmptyState, ErrorState, Panel, SegmentedControl, Skeleton, TimeSeriesChart, cx } from "@/components";
import { useActivity } from "@/api/queries";
import { useElementHeight } from "./hooks";
import { ageOf, hhmm } from "./model";
import type { ActionName } from "./actions";
import "./Side.css";

const EVENT_ICON = { deploy: Rocket, destroy: Trash2, failure: XCircle, config: Cog, firewall: Shield, watchman: Eye } as const;
const EVENT_TONE = { deploy: "green", destroy: "grey", failure: "red", config: "blue", firewall: "blue", watchman: "amber" } as const;

/** The latest five of Activity's combined list (runs, notes, changes), last 24 hours. */
export function RecentEvents() {
  const q = useActivity({ range: "24h" });
  const events = (q.data?.all ?? []).slice(0, 5);
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
        <EmptyState title="No events in the last 24 h" description="Deploys, tear-downs, notes and changes show here." />
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
                  {e.detail && <span className="ov-event__detail">{e.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

type TrafficWindow = "5m" | "15m" | "1h" | "session";
const WINDOW_MS: Record<TrafficWindow, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, session: Infinity };

/** Throughput this session (one sample per heartbeat): in = clients to Azure, out = Azure to clients. */
export function Traffic({ o, now, className }: { o: OverviewResponse; now: number; className?: string }) {
  const [win, setWin] = useState<TrafficWindow>("session");
  const { ref, height } = useElementHeight<HTMLDivElement>(140);
  const hist = o.snapshot.traffic_hist.filter((p) => now - Date.parse(p.t) <= WINDOW_MS[win]);
  const x = hist.map((p) => Math.floor(Date.parse(p.t) / 1000));
  const kb = (v: number) => Math.round((v / 1024) * 10) / 10;
  return (
    <Panel
      title="Network traffic"
      className={cx("ov-traffic", className)}
      bodyClassName="ov-traffic__body"
      actions={
        <SegmentedControl
          aria-label="Traffic window"
          items={[
            { value: "5m", label: "5m" },
            { value: "15m", label: "15m" },
            { value: "1h", label: "1h" },
            { value: "session", label: "Session" },
          ]}
          value={win}
          onChange={(v) => setWin(v as TrafficWindow)}
        />
      }
    >
      <div ref={ref} className="ov-traffic__chart">
        {hist.length < 2 ? (
          <EmptyState
            title={o.snapshot.state === "running" ? "No traffic samples in this window" : "No traffic: nothing is running"}
            description={o.snapshot.state === "running" ? "Samples arrive with each heartbeat; try a longer window." : "The chart fills once the VM is up and clients connect."}
          />
        ) : (
          <TimeSeriesChart
            title="Network traffic this session"
            x={x}
            range={win === "5m" || win === "15m" ? "live" : "1h"}
            unit=" KB/s"
            height={Math.max(60, height - 8)}
            series={[
              { label: "In", color: "blue", data: hist.map((p) => kb(p.rx)) },
              { label: "Out", color: "purple", data: hist.map((p) => kb(p.tx)) },
            ]}
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
  const tests = o.speedtests.slice(0, 3);
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
                  <span>{n(t.rtt_ms, "ms")}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
