import { Activity, CalendarClock, Clock, Globe, Users } from "lucide-react";
import { MetricTile, Ring, cx, type MetricTileProps } from "@/components";
import type { ClientsResponse } from "@shared/api";
import type { FilterKey } from "./model";
import "./KpiTiles.css";

/**
 * A metric tile that is also a button. With `pressed` it is a toggle (a
 * filter: aria-pressed says whether it is on); without, a plain action.
 */
export function FilterTile({ pressed, onPress, ...tile }: MetricTileProps & { pressed?: boolean; onPress: () => void }) {
  return (
    <button type="button" className={cx("filter-tile", pressed && "filter-tile--on")} aria-pressed={pressed} onClick={onPress}>
      <MetricTile {...tile} />
    </button>
  );
}

export function KpiTiles({ kpis, filter, onFilter }: { kpis: ClientsResponse["kpis"]; filter: FilterKey; onFilter: (f: FilterKey) => void }) {
  const toggle = (f: FilterKey) => () => onFilter(filter === f ? "all" : f);
  const onlinePct = kpis.total ? Math.round((kpis.online / kpis.total) * 100) : null;
  return (
    <div className="kpis" role="group" aria-label="Client counts (each filters the table)">
      <FilterTile
        onPress={() => onFilter("all")}
        icon={<Users />}
        label="Total clients"
        value={kpis.total}
        sub={`${kpis.online} online · ${kpis.total - kpis.online} offline`}
      />
      <FilterTile
        pressed={filter === "online"}
        onPress={toggle("online")}
        tone="green"
        icon={<Ring value={onlinePct} label="Online now" size={34} stroke={4} />}
        label="Online now"
        value={kpis.online}
        sub={onlinePct === null ? "no clients" : `${onlinePct}% of clients`}
      />
      <FilterTile
        pressed={filter === "latency"}
        onPress={toggle("latency")}
        icon={<Activity />}
        label="Average latency"
        value={kpis.avgLatencyMs === null ? null : `${Math.round(kpis.avgLatencyMs)} ms`}
        sub={kpis.avgLatencyMs === null ? "Nobody online" : "Across online clients"}
      />
      <FilterTile pressed={filter === "full"} onPress={toggle("full")} tone="purple" icon={<Globe />} label="Full-tunnel clients" value={kpis.fullTunnel} sub="Route all traffic" />
      <FilterTile
        pressed={filter === "stale"}
        onPress={toggle("stale")}
        tone="red"
        icon={<Clock />}
        label="Stale handshakes"
        value={kpis.stale}
        sub="No handshake in 30 days"
      />
      <FilterTile
        pressed={filter === "expiring"}
        onPress={toggle("expiring")}
        tone="amber"
        icon={<CalendarClock />}
        label="Expiring soon"
        value={kpis.expiringSoon}
        sub="Within 7 days"
      />
    </div>
  );
}
