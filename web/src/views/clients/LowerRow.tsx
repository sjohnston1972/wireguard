import { useMemo, type ReactNode } from "react";
import type { ClientsResponse } from "@shared/api";
import { Donut, Panel, TimeSeriesChart } from "@/components";
import { bytes, talkerTotals, type Client } from "./model";
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

export function TopTalkers({ data }: { data: ClientsResponse }) {
  const items = useMemo(() => {
    const totals = talkerTotals(data.talkers);
    const byIp = new Map(data.clients.map((c) => [c.ip, c] as const));
    return [...totals.entries()]
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ip, v]) => {
        const c = byIp.get(ip);
        const Icon = c ? deviceIcon(c) : null;
        return { key: ip, label: c?.name ?? ip, value: v, icon: Icon ? <Icon size={14} aria-hidden className="hbars__icon" /> : undefined };
      });
  }, [data]);
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
      {items.length ? <HBarList items={items} label="Traffic by client this session" format={bytes} /> : <p className="lower__none">no data: nobody has moved traffic this session</p>}
    </Panel>
  );
}

export function StatusDonut({ clients }: { clients: Client[] }) {
  const online = clients.filter((c) => c.status === "online").length;
  const off = clients.filter((c) => c.status === "disabled" || c.status === "expired").length;
  const offline = clients.length - online - off;
  const expiring = clients.filter((c) => c.expiresSoon).length;
  const full = clients.filter((c) => !!c.full_tunnel).length;
  const share = (n: number) => (clients.length ? `${Math.round((n / clients.length) * 100)}%` : "");
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
            {online} Online<span>{share(online)}</span>
          </li>
          <li>
            <span className="cstatus__sw cstatus__sw--red" aria-hidden />
            {offline} Offline<span>{share(offline)}</span>
          </li>
          {off > 0 && (
            <li>
              <span className="cstatus__sw cstatus__sw--grey" aria-hidden />
              {off} Disabled or expired<span>{share(off)}</span>
            </li>
          )}
          <li className="cstatus__extra">
            <span className="cstatus__sw cstatus__sw--amber" aria-hidden />
            {expiring} Expiring ≤ 7 days<span>{share(expiring)}</span>
          </li>
          <li className="cstatus__extra">
            <span className="cstatus__sw cstatus__sw--blue" aria-hidden />
            {full} Full-tunnel clients<span>{share(full)}</span>
          </li>
        </ul>
      </div>
    </Panel>
  );
}

/** All clients' throughput this session, one sample per heartbeat (the mockup's UX-notes slot). */
export function SessionTraffic({ hist }: { hist: ClientsResponse["trafficHist"] }) {
  const x = hist.map((p) => Math.floor(Date.parse(p.t) / 1000));
  return (
    <Panel title="Traffic this session" className="lower__panel">
      <TimeSeriesChart
        title="Traffic this session, all clients"
        range="1h"
        x={x}
        height={104}
        format={(v) => `${bytes(v)}/s`}
        series={[
          { label: "Inbound", color: "blue", data: hist.map((p) => p.rx) },
          { label: "Outbound", color: "purple", data: hist.map((p) => p.tx) },
        ]}
      />
    </Panel>
  );
}
