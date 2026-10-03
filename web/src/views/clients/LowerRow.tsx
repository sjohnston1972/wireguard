import { useMemo, type ReactNode } from "react";
import type { ClientsResponse } from "@shared/api";
import { Donut, Panel, TimeSeriesChart, type ChartRange } from "@/components";
import { useHistory } from "@/api/queries";
import { useMedia } from "@/lib/useMedia";
import { useWidget } from "@/widgets";
import { bytes, talkerTotals, type Client, type TalkerMeasure } from "./model";
import { deviceIcon } from "./ClientsTable";
import "./LowerRow.css";

/** Horizontal bars, biggest first: label, bar, value. */
export function HBarList({ items, label, format }: { items: { key: string; label: ReactNode; value: number; icon?: ReactNode }[]; label: string; format: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="hbars" aria-label={label}>
      {items.map((i) => (
        <li key={i.key} className="hbars__row">
          <span className="hbars__label">
            {i.icon}
            {i.label}
          </span>
          <span className="hbars__track" aria-hidden>
            <span className="hbars__bar" style={{ width: `${Math.max(2, (i.value / max) * 100)}%` }} />
          </span>
          <span className="hbars__value">{format(i.value)}</span>
        </li>
      ))}
    </ul>
  );
}

const MEASURE_LABEL: Record<TalkerMeasure, string> = {
  total: "Traffic by client this session",
  sent: "Traffic sent by client this session",
  received: "Traffic received by client this session",
};

export function TopTalkers({ data }: { data: ClientsResponse }) {
  const { settings } = useWidget("clients.talkers");
  const rows = settings.rows as number;
  const measure = settings.measure as TalkerMeasure;
  const items = useMemo(() => {
    const totals = talkerTotals(data.talkers, measure);
    const byIp = new Map(data.clients.map((c) => [c.ip, c] as const));
    return [...totals.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, rows)
      .map(([ip, v]) => {
        const c = byIp.get(ip);
        const Icon = c ? deviceIcon(c) : null;
        return { key: ip, label: c?.name ?? ip, value: v, icon: Icon ? <Icon size={14} aria-hidden className="hbars__icon" /> : undefined };
      });
  }, [data, rows, measure]);
  return (
    <Panel
      title={
        <>
          Top talkers <span className="lower__muted">(this session)</span>
        </>
      }
      className="lower__panel"
      scroll
    >
      {items.length ? <HBarList items={items} label={MEASURE_LABEL[measure]} format={bytes} /> : <p className="lower__none">no data: nobody has moved traffic this session</p>}
    </Panel>
  );
}

export function StatusDonut({ clients }: { clients: Client[] }) {
  const { settings } = useWidget("clients.statusDonut");
  const extras = settings.extras as string[];
  const percentages = settings.percentages !== false;
  const online = clients.filter((c) => c.status === "online").length;
  const off = clients.filter((c) => c.status === "disabled" || c.status === "expired").length;
  const offline = clients.length - online - off;
  const expiring = clients.filter((c) => c.expiresSoon).length;
  const full = clients.filter((c) => !!c.full_tunnel).length;
  const share = (n: number) => (percentages ? <span className="cstatus__share">{clients.length ? `${Math.round((n / clients.length) * 100)}%` : ""}</span> : null);
  return (
    <Panel title="Client status" className="lower__panel">
      <div className="cstatus">
        <Donut
          title="Client status"
          size={112}
          stroke={12}
          legend={false}
          centre={{ value: clients.length, label: "Total clients" }}
          segments={[
            { label: "Online", value: online, color: "green" },
            { label: "Offline", value: offline, color: "red" },
            { label: "Disabled or expired", value: off, color: "grey" },
          ]}
        />
        <ul className="cstatus__legend">
          <li>
            <span className="cstatus__sw cstatus__sw--green" aria-hidden />
            {online} Online{share(online)}
          </li>
          <li>
            <span className="cstatus__sw cstatus__sw--red" aria-hidden />
            {offline} Offline{share(offline)}
          </li>
          {off > 0 && (
            <li>
              <span className="cstatus__sw cstatus__sw--grey" aria-hidden />
              {off} Disabled or expired{share(off)}
            </li>
          )}
          {extras.includes("expiring") && (
            <li className="cstatus__extra">
              <span className="cstatus__sw cstatus__sw--amber" aria-hidden />
              {expiring} Expiring ≤ 7 days{share(expiring)}
            </li>
          )}
          {extras.includes("fullTunnel") && (
            <li className="cstatus__extra">
              <span className="cstatus__sw cstatus__sw--blue" aria-hidden />
              {full} Full-tunnel clients{share(full)}
            </li>
          )}
        </ul>
      </div>
    </Panel>
  );
}

const HISTORY_WORD = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days", "30d": "last 30 days" } as const;

/** All clients' throughput: this session (one sample per heartbeat), or the VM's history for a longer range. Bytes/s. */
export function SessionTraffic({ hist }: { hist: ClientsResponse["trafficHist"] }) {
  const { settings } = useWidget("clients.sessionTraffic");
  const range = settings.range as "session" | "1h" | "24h" | "7d" | "30d";
  const mbps = settings.units === "mbps";
  const series = settings.series as string[];
  const history = useHistory({ scope: "vm", range: range === "session" ? "1h" : range }, { enabled: range !== "session" });
  // The lower row is 124 px on a short window (LowerRow.css): the chart keeps to it, axis labels included.
  const short = useMedia("(max-height: 760px) and (min-width: 1100px)");

  const points = range === "session" ? hist.map((p) => ({ t: p.t, rx: p.rx as number | null, tx: p.tx as number | null })) : (history.data?.points ?? []).map((p) => ({ t: p.t, rx: p.rx_rate, tx: p.tx_rate }));
  const x = points.map((p) => Math.floor(Date.parse(p.t) / 1000));
  // Mbit/s: bytes per second x 8 / 1,000,000.
  const conv = (v: number | null) => (v === null ? null : mbps ? (v * 8) / 1_000_000 : v);
  const title = range === "session" ? "Traffic this session" : `Traffic, ${HISTORY_WORD[range]}`;
  const chartRange: ChartRange = range === "session" ? "1h" : range;
  return (
    <Panel title={title} className="lower__panel">
      <TimeSeriesChart
        title={range === "session" ? "Traffic this session, all clients" : `${title}, all clients`}
        range={chartRange}
        x={x}
        height={short ? 70 : 104}
        {...(mbps ? { unit: " Mbit/s" } : { format: (v: number) => `${bytes(v)}/s` })}
        series={[
          ...(series.includes("in") ? [{ label: "Inbound", color: "blue" as const, data: points.map((p) => conv(p.rx)) }] : []),
          ...(series.includes("out") ? [{ label: "Outbound", color: "purple" as const, data: points.map((p) => conv(p.tx)) }] : []),
        ]}
      />
    </Panel>
  );
}
