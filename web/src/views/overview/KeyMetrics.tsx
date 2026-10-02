import { useState, type ReactNode } from "react";
import { Coins, Globe, HeartPulse, ShieldCheck, TrendingUp, Users } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { CopyButton, DataAge, MetricTile, Panel, SegmentedControl, cx, type MetricTileProps } from "@/components";
import { useCost, useHistory } from "@/api/queries";
import { RANGE_WORD, ageOf, gbp, historyRange, latencyNow, latencySeries, peak, type MetricRange } from "./model";
import "./KeyMetrics.css";

const RANGES: { value: MetricRange; label: string; dot?: "green" }[] = [
  { value: "live", label: "Live", dot: "green" },
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/** A tile as a named group, so its label, value and window read together. */
function Tile({ className, ...p }: MetricTileProps & { className?: string }) {
  return (
    <div role="group" aria-label={p.label} className={cx("ov-tile", className)}>
      <MetricTile variant="inset" {...p} />
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="ov-tile__sub">{children}</span>;
}

export function KeyMetrics({ o, now }: { o: OverviewResponse; now: number }) {
  const [range, setRange] = useState<MetricRange>("live");
  const hist = useHistory({ scope: "vm", range: historyRange(range) });
  const cost = useCost("month");
  const s = o.snapshot;
  const d = o.derived;
  const running = s.state === "running";
  const stale = running && d.heartbeatStale;
  const live = range === "live";
  const word = RANGE_WORD[range];
  const beatAge = ageOf(s.last_agent_at, now);
  const points = hist.data?.points ?? [];
  const histWord = hist.isLoading ? "loading…" : hist.isError ? "history unavailable" : word;

  // Connected clients: live now, or the peak in the range.
  let clients: { value: string | null; pct: number | null; sub: string };
  if (live) {
    clients = running
      ? { value: `${d.clientsOnline} / ${d.clientsEnabled}`, pct: d.clientsEnabled ? (d.clientsOnline / d.clientsEnabled) * 100 : null, sub: `live · ${beatAge ?? "no heartbeat"}` }
      : { value: null, pct: null, sub: "VM not running" };
  } else {
    const p = peak(points.map((x) => x.peers_online));
    clients = p === null ? { value: null, pct: null, sub: `peak · ${histWord}` } : { value: `${p} / ${d.clientsEnabled}`, pct: d.clientsEnabled ? Math.min(100, (p / d.clientsEnabled) * 100) : null, sub: `peak · ${word}` };
  }

  // Latency: the VM keeps recent round-trip times per client, not per range.
  const lat = running ? latencyNow(s.latency) : null;
  const latSpark = running ? latencySeries(s.latency) : [];

  // Tunnel DNS: the heartbeat's answer now, or how often it was up in the range.
  let dns: { value: string | null; tone: "green" | "amber" | "red" | "grey"; sub: string };
  if (live) {
    const up = running ? s.agent?.dns?.up : undefined;
    dns = up === true ? { value: "Healthy", tone: "green", sub: "Tunnel DNS resolving · live" } : up === false ? { value: "Down", tone: "red", sub: "Tunnel DNS not answering · live" } : { value: null, tone: "grey", sub: running ? "not reported · live" : "VM not running" };
  } else {
    const vals = points.map((x) => x.dns_up).filter((v): v is number => v !== null);
    if (!vals.length) dns = { value: null, tone: "grey", sub: `tunnel DNS · ${histWord}` };
    else {
      const pct = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
      dns = pct === 100 ? { value: "Healthy", tone: "green", sub: `up all the time · ${word}` } : { value: `Up ${pct}%`, tone: "amber", sub: `tunnel DNS · ${word}` };
    }
  }

  const beat: { value: string | null; tone: "green" | "amber" | "grey"; sub: string } = !running
    ? { value: null, tone: "grey", sub: s.last_agent_at ? `last heard ${beatAge}` : "VM not running" }
    : !s.last_agent_at
      ? { value: null, tone: "grey", sub: "no heartbeat yet" }
      : stale
        ? { value: "Late", tone: "amber", sub: `Last seen ${beatAge} · stale` }
        : { value: "Online", tone: "green", sub: `Last seen ${beatAge}` };

  const sessionGbp = cost.data?.session.estimateGbp ?? null;
  const session = running || s.state === "standby" ? sessionGbp : null;

  const avail = hist.data?.availability.pct ?? null;

  return (
    <Panel
      title="Key metrics"
      className="ov-metrics"
      bodyClassName="ov-metrics__body"
      status={running && s.last_agent_at ? <DataAge at={Date.parse(s.last_agent_at)} now={now} /> : undefined}
      actions={<SegmentedControl aria-label="Metrics range" items={RANGES} value={range} onChange={(v) => setRange(v as MetricRange)} />}
    >
      <div className="ov-tiles" data-testid="ov-tiles" data-stale={stale ? "true" : "false"}>
        <div className="ov-tiles__row ov-tiles__row--3">
          <Tile
            icon={<Globe size={26} />}
            label="Public endpoint"
            value={o.config.dnsName ? <span className="mono ov-tile__mono">{o.config.dnsName}</span> : null}
            sub={<Sub>{d.dnsParked ? "parked, nothing running" : s.public_ip ? <span className="mono">{s.public_ip}</span> : "not deployed"}</Sub>}
            action={o.config.dnsName ? <CopyButton text={o.config.dnsName} label="Copy public endpoint" /> : undefined}
          />
          <Tile icon={<Users size={26} />} label="Connected clients" value={clients.value} progress={clients.value ? { value: clients.pct, tone: "green" } : undefined} sub={<Sub>{clients.sub}</Sub>} />
          <Tile icon={<TrendingUp size={26} />} label="Latency (avg)" value={lat === null ? null : `${lat} ms`} spark={latSpark.length > 1 ? latSpark : undefined} sparkTone="green" sub={<Sub>{running ? `live · ${Object.keys(s.latency).length} clients` : "VM not running"}</Sub>} />
        </div>
        <div className="ov-tiles__row ov-tiles__row--4">
          <Tile icon={<ShieldCheck size={26} />} tone={dns.tone} label="DNS status" value={dns.value} valueTone sub={<Sub>{dns.sub}</Sub>} />
          <Tile icon={<HeartPulse size={26} />} tone={beat.tone} label="Heartbeat (VM)" value={beat.value} valueTone sub={<Sub>{beat.sub}</Sub>} className="ov-tile--beat" />
          <Tile icon={<Coins size={26} />} tone="blue" label="Session cost" value={session === null ? null : gbp(session)} sub={<Sub>{session === null ? (running ? "estimate not ready" : "nothing running") : "this session, estimate"}</Sub>} />
          <Tile tone={avail === null ? "grey" : avail >= 99 ? "green" : avail >= 90 ? "amber" : "red"} label="Availability" value={avail === null ? null : `${avail === 100 ? 100 : avail.toFixed(1)}%`} ring={{ value: avail }} sub={<Sub>{avail === null ? `heartbeats · ${histWord}` : word === "live" ? "last hour" : word}</Sub>} />
        </div>
      </div>
    </Panel>
  );
}
