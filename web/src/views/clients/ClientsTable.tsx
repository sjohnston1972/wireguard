import type { ReactNode } from "react";
import { Gamepad2, Home, Laptop, Monitor, Server, Smartphone, Tablet, type LucideIcon } from "lucide-react";
import { DataTable, EmptyState, Sparkline, StatusPill, cx, type Column, type RowAction, type SortState } from "@/components";
import { thresholdTone, type Threshold } from "@shared/widgets";
import { ago, bytes, daysUntil, ipSortValue, lastHandshakeMs, routesOf, sessionTraffic, shortDate, sortClients, statusWord, type Client } from "./model";
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
      {c.labsConfigDue && (
        <span className="ctag ctag--amber" title="Its config predates the labs network (10.64.0.0/13): get a new config to reach running labs.">
          config out of date: get config
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
  /** The optional columns shown (clients.table setting `columns`); default: the first six. */
  show?: readonly string[];
  /** Draw the latency sparkline (default true). */
  sparkline?: boolean;
  density?: "comfortable" | "compact";
  /** Colour the latency cell (above): off by default. */
  latency?: Threshold;
}

/** The columns today's table shows (the clients.table default). */
export const DEFAULT_COLUMNS = ["address", "handshake", "latency", "traffic", "allowedIps", "expires"] as const;
const NO_THRESHOLD: Threshold = { warn: null, bad: null };

export function ClientsTable({ rows, now, selectedId, onOpen, actions, sort, onSortChange, empty, show = DEFAULT_COLUMNS, sparkline = true, density, latency = NO_THRESHOLD }: ClientsTableProps) {
  const all: (Column<Client> & { opt?: string })[] = [
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
    { opt: "address", key: "address", header: "Address", className: "ccol-address", sortValue: (c) => ipSortValue(c.ip), cell: (c) => <span className="mono">{c.ip}</span> },
    { key: "status", header: "Status", cell: (c) => <StatusCell c={c} /> },
    {
      opt: "handshake",
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
      opt: "latency",
      key: "latency",
      header: "Latency",
      sortValue: (c) => c.lastLatencyMs,
      cell: (c) => {
        // A threshold colours the cell, and a word always sits beside the colour.
        const tone = thresholdTone(c.lastLatencyMs, latency, "above");
        return (
          <span className="clat">
            <span className="clat__value">{c.lastLatencyMs === null ? "—" : `${Math.round(c.lastLatencyMs)} ms`}</span>
            {tone === "warn" && <span className="ctag ctag--amber">Slow</span>}
            {tone === "bad" && <span className="ctag ctag--red">Very slow</span>}
            {sparkline && c.latency.length > 1 && (
              <Sparkline className="clat__spark ccol-spark" label={`${c.name} latency`} unit=" ms" data={c.latency} tone={c.status === "online" ? "green" : "grey"} width={64} height={20} />
            )}
          </span>
        );
      },
    },
    {
      opt: "traffic",
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
      opt: "allowedIps",
      key: "routes",
      header: "Allowed IPs",
      className: "ccol-routes",
      cell: (c) => {
        const r = routesOf(c);
        return (
          // The first route in full and "+n" for the rest (the whole list is the tooltip and, for screen readers, spelled out).
          <span className="croutes" title={r.join(", ")}>
            <span className="croutes__ips mono">{r.length ? r[0] : "—"}</span>
            {r.length > 1 && (
              <span className="croutes__more">
                +{r.length - 1}
                <span className="visually-hidden"> more: {r.slice(1).join(", ")}</span>
              </span>
            )}
            {!!c.full_tunnel && <span className="ctag ctag--blue">Full tunnel</span>}
          </span>
        );
      },
    },
    {
      opt: "expires",
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
    { opt: "ipv6", key: "ipv6", header: "IPv6 address", className: "ccol-ipv6", sortValue: (c) => c.ip6, cell: (c) => (c.ip6 ? <span className="mono">{c.ip6}</span> : <span className="muted">—</span>) },
    {
      opt: "created",
      key: "created",
      header: "Created",
      className: "ccol-created",
      sortValue: (c) => (c.created_at ? Date.parse(c.created_at) : null),
      cell: (c) => (c.created_at ? <span>{shortDate(c.created_at)}</span> : <span className="muted">—</span>),
    },
    {
      opt: "note",
      key: "note",
      header: "Note",
      className: "ccol-note",
      cell: (c) =>
        c.note ? (
          <span className="cnote" title={c.note}>
            {c.note}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  // Name and Status always show; the rest follow the setting, in the table's own order.
  const columns: Column<Client>[] = all.filter((c) => !c.opt || show.includes(c.opt));
  // A starting sort on a column that is not shown still orders the rows.
  const hiddenSort = !!sort && !columns.some((c) => c.key === sort.key);
  const ordered = hiddenSort ? sortClients(rows, sort) : rows;

  return (
    <DataTable
      className="ctable"
      aria-label="Clients"
      density={density}
      columns={columns}
      rows={ordered}
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
