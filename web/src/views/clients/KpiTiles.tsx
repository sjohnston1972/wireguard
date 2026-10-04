import type { CSSProperties, ReactElement } from "react";
import { Activity, CalendarClock, Clock, Globe, Users, Wifi } from "lucide-react";
import { MetricTile, Ring, cx, type MetricTileProps } from "@/components";
import type { ClientsResponse } from "@shared/api";
import { thresholdTone, widgetDefaults, type Threshold } from "@shared/widgets";
import { WidgetCorner, useCornerHost, useWidget } from "@/widgets";
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

export type TileKey = "total" | "online" | "latency" | "fullTunnel" | "stale" | "expiring";
const TILE_ORDER: TileKey[] = ["total", "online", "latency", "fullTunnel", "stale", "expiring"];

/** The clients.kpis settings (the saved value, else today's). */
export function useKpiSettings() {
  const w = useWidget("clients.kpis");
  const d = widgetDefaults("clients.kpis");
  const s = w.settings;
  return {
    hidden: w.hidden,
    tiles: (s.tiles ?? d.tiles) as TileKey[],
    subLines: s.subLines !== false,
    onlineRing: s.onlineRing !== false,
    latency: (s.latency ?? d.latency) as Threshold,
  };
}

export function KpiTiles({ kpis, filter, onFilter }: { kpis: ClientsResponse["kpis"]; filter: FilterKey; onFilter: (f: FilterKey) => void }) {
  const { tiles, subLines, onlineRing, latency } = useKpiSettings();
  const host = useCornerHost();
  const toggle = (f: FilterKey) => () => onFilter(filter === f ? "all" : f);
  const onlinePct = kpis.total ? Math.round((kpis.online / kpis.total) * 100) : null;
  const sub = (text: string) => (subLines ? text : undefined);
  // Thresholds colour the tile, and a word always sits beside the colour.
  const lat = thresholdTone(kpis.avgLatencyMs, latency, "above");
  const latWord = lat === "bad" ? "Very slow" : lat === "warn" ? "Slow" : null;
  const latSub = kpis.avgLatencyMs === null ? "Nobody online" : "Across online clients";

  const all: Record<TileKey, ReactElement> = {
    total: (
      <FilterTile
        key="total"
        onPress={() => onFilter("all")}
        icon={<Users />}
        label="Total clients"
        value={kpis.total}
        sub={sub(`${kpis.online} online · ${kpis.total - kpis.online} offline`)}
      />
    ),
    online: (
      <FilterTile
        key="online"
        pressed={filter === "online"}
        onPress={toggle("online")}
        tone="green"
        icon={onlineRing ? <Ring value={onlinePct} label="Online now" size={34} stroke={4} /> : <Wifi />}
        label="Online now"
        value={kpis.online}
        sub={sub(onlinePct === null ? "no clients" : `${onlinePct}% of clients`)}
      />
    ),
    latency: (
      <FilterTile
        key="latency"
        pressed={filter === "latency"}
        onPress={toggle("latency")}
        tone={lat === "bad" ? "red" : lat === "warn" ? "amber" : undefined}
        valueTone={!!latWord}
        icon={<Activity />}
        label="Average latency"
        value={kpis.avgLatencyMs === null ? null : `${Math.round(kpis.avgLatencyMs)} ms`}
        sub={latWord ? (subLines ? `${latWord} · ${latSub}` : latWord) : sub(latSub)}
      />
    ),
    fullTunnel: <FilterTile key="fullTunnel" pressed={filter === "full"} onPress={toggle("full")} tone="purple" icon={<Globe />} label="Full-tunnel clients" value={kpis.fullTunnel} sub={sub("Route all traffic")} />,
    stale: (
      <FilterTile key="stale" pressed={filter === "stale"} onPress={toggle("stale")} tone="red" icon={<Clock />} label="Stale handshakes" value={kpis.stale} sub={sub("No handshake in 30 days")} />
    ),
    expiring: (
      <FilterTile key="expiring" pressed={filter === "expiring"} onPress={toggle("expiring")} tone="amber" icon={<CalendarClock />} label="Expiring soon" value={kpis.expiringSoon} sub={sub("Within 7 days")} />
    ),
  };
  const shown = TILE_ORDER.filter((k) => tiles.includes(k));
  // Fewer tiles share the row: the column count appears only once it differs from today's six.
  const style = shown.length !== 6 ? ({ "--kpi-cols": shown.length, "--kpi-cols-narrow": Math.min(shown.length, 3) } as CSSProperties) : undefined;
  return (
    <div className={cx("kpis", host)} role="group" aria-label="Client counts (each filters the table)" style={style}>
      {shown.map((k) => all[k])}
      <WidgetCorner />
    </div>
  );
}
