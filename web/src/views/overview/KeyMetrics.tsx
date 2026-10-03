import { Fragment, type ReactNode } from "react";
import { Coins, Globe, HeartPulse, ShieldCheck, TrendingUp, Users } from "lucide-react";
import type { OverviewResponse } from "@shared/api";
import { CopyButton, DataAge, MetricTile, Panel, SegmentedControl, cx, type MetricTileProps } from "@/components";
import { useCost, useHistory } from "@/api/queries";
import { useWidget } from "@/widgets";
import { RANGE_WORD, ageOf, gbp, historyRange, latencyNow, latencySeries, peak, type MetricRange } from "./model";
import { LEVEL_TONE, levelOf, levelWord, thresholdOn, useStarting, type Level } from "./widgetSettings";
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

/**
 * A figure with its threshold's word beside it, in the threshold's colour
 * (just the figure when all is well). Beside the value, not in the sub-line,
 * so the word shows wherever the colour does: short windows hide sub-lines.
 */
function withWord(value: string | null, level: Level, direction: "above" | "below"): ReactNode {
  const word = levelWord(level, direction);
  if (value === null || !word || !level) return value;
  return (
    <>
      {value} <span className={cx("ov-tile__word", `ov-tile__word--${LEVEL_TONE[level]}`)}>{word}</span>
    </>
  );
}

/** A tile's sub-line, or none with Sub-lines off. */
function subLine(on: boolean, text: ReactNode): ReactNode {
  return on ? <Sub>{text}</Sub> : undefined;
}

type TileKey = "endpoint" | "clients" | "latency" | "dns" | "heartbeat" | "sessionCost" | "availability";

export function KeyMetrics({ o, now }: { o: OverviewResponse; now: number }) {
  const { settings: st } = useWidget("overview.keyMetrics");
  const [range, setRange] = useStarting(st.range as MetricRange);
  const charts = st.charts as boolean;
  const subs = st.subLines as boolean;
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
  // Its threshold is off unless set; then the tile takes its colour and word.
  const lat = running ? latencyNow(s.latency) : null;
  const latSpark = running ? latencySeries(s.latency) : [];
  const latLevel = thresholdOn(st.latency) ? levelOf(lat, st.latency, "above") : null;
  const latTone = latLevel ? LEVEL_TONE[latLevel] : undefined;

  // Tunnel DNS: the heartbeat's answer now, or how often it was up in the range
  // (coloured by the DNS up threshold; the value "Up N%" is the word).
  let dns: { value: string | null; tone: "green" | "amber" | "red" | "grey"; sub: string };
  if (live) {
    const up = running ? s.agent?.dns?.up : undefined;
    dns = up === true ? { value: "Healthy", tone: "green", sub: "Tunnel DNS resolving · live" } : up === false ? { value: "Down", tone: "red", sub: "Tunnel DNS not answering · live" } : { value: null, tone: "grey", sub: running ? "not reported · live" : "VM not running" };
  } else {
    const vals = points.map((x) => x.dns_up).filter((v): v is number => v !== null);
    if (!vals.length) dns = { value: null, tone: "grey", sub: `tunnel DNS · ${histWord}` };
    else {
      const pct = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100);
      const tone = LEVEL_TONE[levelOf(pct, st.dnsUp, "below") ?? "ok"];
      dns = pct === 100 ? { value: "Healthy", tone, sub: `up all the time · ${word}` } : { value: `Up ${pct}%`, tone, sub: `tunnel DNS · ${word}` };
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
  // "Live" reads the last hour of heartbeats for availability.
  const availWord = live ? RANGE_WORD["1h"] : word;
  const availLevel = levelOf(avail, st.availability, "below");

  const tiles: { key: TileKey; node: ReactNode }[] = [
    {
      key: "endpoint",
      node: (
        <Tile
          icon={<Globe size={26} />}
          label="Public endpoint"
          value={o.config.dnsName ? <span className="mono ov-tile__mono">{o.config.dnsName}</span> : null}
          sub={subLine(subs, d.dnsParked ? "parked, nothing running" : s.public_ip ? <span className="mono">{s.public_ip}</span> : "not deployed")}
          action={o.config.dnsName ? <CopyButton text={o.config.dnsName} label="Copy public endpoint" /> : undefined}
        />
      ),
    },
    { key: "clients", node: <Tile icon={<Users size={26} />} label="Connected clients" value={clients.value} progress={charts && clients.value ? { value: clients.pct, tone: "green" } : undefined} sub={subLine(subs, clients.sub)} /> },
    {
      key: "latency",
      node: (
        <Tile
          icon={<TrendingUp size={26} />}
          tone={latTone}
          valueTone={latLevel === "warn" || latLevel === "bad"}
          label="Latency (avg)"
          value={withWord(lat === null ? null : `${lat} ms`, latLevel, "above")}
          spark={charts && latSpark.length > 1 ? latSpark : undefined}
          sparkTone={latLevel === "warn" || latLevel === "bad" ? latTone : "green"}
          sub={subLine(subs, running ? `live · ${Object.keys(s.latency).length} clients` : "VM not running")}
        />
      ),
    },
    { key: "dns", node: <Tile icon={<ShieldCheck size={26} />} tone={dns.tone} label="DNS status" value={dns.value} valueTone sub={subLine(subs, dns.sub)} /> },
    { key: "heartbeat", node: <Tile icon={<HeartPulse size={26} />} tone={beat.tone} label="Heartbeat (VM)" value={beat.value} valueTone sub={subLine(subs, beat.sub)} className="ov-tile--beat" /> },
    { key: "sessionCost", node: <Tile icon={<Coins size={26} />} tone="blue" label="Session cost" value={session === null ? null : gbp(session)} sub={subLine(subs, session === null ? (running ? "estimate not ready" : "nothing running") : "this session, estimate")} /> },
    {
      key: "availability",
      node: (
        <Tile
          tone={availLevel === null ? "grey" : LEVEL_TONE[availLevel]}
          label="Availability"
          value={withWord(avail === null ? null : `${avail === 100 ? 100 : avail.toFixed(1)}%`, availLevel, "below")}
          ring={charts ? { value: avail } : undefined}
          sub={subLine(subs, avail === null ? `heartbeats · ${hist.isLoading || hist.isError ? histWord : availWord}` : availWord)}
        />
      ),
    },
  ];
  const shown = tiles.filter((t) => (st.tiles as string[]).includes(t.key));
  // Two rows as today (three over four); fewer tiles flow into the same two rows, one tile is one row.
  const split = Math.floor(shown.length / 2);
  const rows = split ? [shown.slice(0, split), shown.slice(split)] : [shown];

  return (
    <Panel
      title="Key metrics"
      className="ov-metrics"
      bodyClassName="ov-metrics__body"
      status={running && s.last_agent_at ? <DataAge at={Date.parse(s.last_agent_at)} now={now} /> : undefined}
      actions={<SegmentedControl aria-label="Metrics range" items={RANGES} value={range} onChange={(v) => setRange(v as MetricRange)} />}
    >
      <div className="ov-tiles" data-testid="ov-tiles" data-stale={stale ? "true" : "false"}>
        {rows.map((row, i) => (
          <div key={i} className={cx("ov-tiles__row", `ov-tiles__row--${row.length}`)}>
            {row.map((t) => (
              <Fragment key={t.key}>{t.node}</Fragment>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}
