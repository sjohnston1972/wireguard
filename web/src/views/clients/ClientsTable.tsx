import type { ReactNode } from "react";
import { Gamepad2, Home, Laptop, Monitor, Server, Smartphone, Tablet, type LucideIcon } from "lucide-react";
import { DataTable, EmptyState, Sparkline, StatusPill, cx, type Column, type RowAction, type SortState } from "@/components";
import { ago, bytes, daysUntil, ipSortValue, lastHandshakeMs, routesOf, sessionTraffic, shortDate, statusWord, type Client } from "./model";
import "./ClientsTable.css";

/** A device icon guessed from the name (the mockup's icons); the home site is a house. */
export function deviceIcon(c: Client): LucideIcon {
  if (c.isSite) return Home;
  const n = c.name.toLowerCase();
  if (/phone|mobile|android|pixel/.test(n)) return Smartphone;
  if (/tablet|ipad/.test(n)) return Tablet;
  if (/gam|xbox|playstation|ps5|steam/.test(n)) return Gamepad2;
  if (/server|node|runner|nas|backup|pi\b|box|vm/.test(n)) return Server;
  if (/laptop|mac|book|notebook/.test(n)) return Laptop;
  return Monitor;
}

export function ClientTags({ c }: { c: Client }) {
  return (
    <>
      {c.isSite && <span className="ctag ctag--blue">site</span>}
      {!!c.needs_config && (
        <span className="ctag ctag--amber" title="The server key changed: this device needs a new config.">
          needs new config
        </span>
      )}
      {c.stale && (
        <span className="ctag ctag--grey" title="No handshake in 30 days.">
          stale
        </span>
      )}
    </>
  );
}

export function StatusCell({ c }: { c: Client }) {
  const w = statusWord(c);
  return (
    <span title={w.hint}>
      <StatusPill status={w.pill} label={w.label} tone={w.tone} />
    </span>
  );
}

export interface ClientsTableProps {
  rows: Client[];
  now: number;
  selectedId: number | null;
  onOpen: (c: Client) => void;
  actions: (c: Client) => RowAction[];
  sort: SortState | null;
  onSortChange: (s: SortState | null) => void;
  /** Shown when nothing matches (an EmptyState). */
  empty?: ReactNode;
}

export function ClientsTable({ rows, now, selectedId, onOpen, actions, sort, onSortChange, empty }: ClientsTableProps) {
  const columns: Column<Client>[] = [
    {
      key: "name",
      header: "Name",
      sortValue: (c) => c.name.toLowerCase(),
      cell: (c) => {
        const Icon = deviceIcon(c);
        return (
          <span className="cname">
            <Icon size={17} aria-hidden className="cname__icon" />
            <span className="cname__name">{c.name}</span>
            <ClientTags c={c} />
          </span>
        );
      },
    },
    { key: "address", header: "Address", className: "ccol-address", sortValue: (c) => ipSortValue(c.ip), cell: (c) => <span className="mono">{c.ip}</span> },
    { key: "status", header: "Status", cell: (c) => <StatusCell c={c} /> },
    {
      key: "handshake",
      header: "Last handshake",
      className: "ccol-handshake",
      sortValue: (c) => lastHandshakeMs(c),
      cell: (c) => {
        const t = lastHandshakeMs(c);
        return t === null ? <span className="muted">never</span> : <time dateTime={new Date(t).toISOString()}>{ago(t, now)}</time>;
      },
    },
    {
      key: "latency",
      header: "Latency",
      sortValue: (c) => c.lastLatencyMs,
      cell: (c) => (
        <span className="clat">
          <span className="clat__value">{c.lastLatencyMs === null ? "—" : `${Math.round(c.lastLatencyMs)} ms`}</span>
          {c.latency.length > 1 && (
            <Sparkline className="clat__spark ccol-spark" label={`${c.name} latency`} unit=" ms" data={c.latency} tone={c.status === "online" ? "green" : "grey"} width={64} height={20} />
          )}
        </span>
      ),
    },
    {
      key: "traffic",
      header: "Session traffic",
      className: "ccol-traffic",
      sortValue: (c) => {
        const t = sessionTraffic(c);
        return t ? t.up + t.down : null;
      },
      cell: (c) => {
        const t = sessionTraffic(c);
        if (!t) return <span className="muted">—</span>;
        return (
          <span className="ctraffic">
            {bytes(t.up)} <span aria-label="sent">↑</span> {bytes(t.down)} <span aria-label="received">↓</span>
          </span>
        );
      },
    },
    {
      key: "routes",
      header: "Allowed IPs",
      className: "ccol-routes",
      cell: (c) => {
        const r = routesOf(c);
        return (
          <span className="croutes" title={r.join(", ")}>
            <span className="croutes__ips mono">{r.length ? r.join(", ") : "—"}</span>
            {!!c.full_tunnel && <span className="ctag ctag--blue">Full tunnel</span>}
          </span>
        );
      },
    },
    {
      key: "expires",
      header: "Expires",
      className: "ccol-expires",
      sortValue: (c) => (c.expires_at ? Date.parse(c.expires_at) : null),
      cell: (c) => {
        if (c.isSite || !c.expires_at) return <span className="muted">Never</span>;
        if (c.expired) return <span className="cexp cexp--gone">Expired {shortDate(c.expires_at)}</span>;
        const d = daysUntil(c.expires_at, now);
        return (
          <span className="cexp">
            {shortDate(c.expires_at)}
            <span className={cx("ctag", c.expiresSoon ? "ctag--amber" : "ctag--grey")}>{d === 1 ? "1 day" : `${d} days`}</span>
          </span>
        );
      },
    },
  ];

  return (
    <DataTable
      className="ctable"
      aria-label="Clients"
      columns={columns}
      rows={rows}
      rowKey={(c) => String(c.id)}
      rowLabel={(c) => c.name}
      onRowClick={onOpen}
      selectedKey={selectedId === null ? null : String(selectedId)}
      rowActions={actions}
      sort={sort}
      onSortChange={onSortChange}
      empty={empty ?? <EmptyState title="No clients" />}
    />
  );
}
