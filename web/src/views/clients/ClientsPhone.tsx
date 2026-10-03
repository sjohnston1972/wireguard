import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import type { ClientsResponse } from "@shared/api";
import { cx } from "@/components";
import { useStarting, useWidget } from "@/widgets";
import { FILTERS, START_FILTERS, START_SORTS, TAB_FILTERS, sortClients, statusWord, type FilterKey } from "./model";
import { deviceIcon } from "./ClientsTable";
import { ClientPanel } from "./ClientPanel";
import { useKpiSettings } from "./KpiTiles";
import type { ClientHandlers } from "./ClientsScreen";
import "./ClientsPhone.css";

/**
 * The phone composition (spec 9): one line per device (a light, the name,
 * the latency or the state); a tap opens the client's panel as a bottom sheet.
 * The Client figures widget's tiles decide what the summary line says; the
 * Clients widget's starting filter and sort decide the list.
 */
export function ClientsPhone({ data, selectedId, rawId, h }: { data: ClientsResponse; selectedId: number | null; rawId: string | null; h: ClientHandlers }) {
  const selected = selectedId === null ? null : data.clients.find((c) => c.id === selectedId) ?? null;
  const kpis = useKpiSettings();
  const { settings } = useWidget("clients.table");
  // The starting filter, said above the list with a way out (for the visit, as the desktop tabs).
  const [filter, setFilter] = useStarting<FilterKey>(START_FILTERS[settings.filter as string] ?? "all");
  const filterLabel = TAB_FILTERS.find((t) => t.key === filter)?.label ?? filter;
  const sortName = settings.sort as string;
  const list = useMemo(() => {
    const filtered = data.clients.filter((c) => FILTERS[filter](c));
    // The server's order stays unless the sort was changed: it is today's list.
    return sortName === "nameAsc" || !START_SORTS[sortName] ? filtered : sortClients(filtered, START_SORTS[sortName]!);
  }, [data.clients, filter, sortName]);

  const has = (k: string) => (kpis.tiles as string[]).includes(k);
  const lead = has("online") && has("total") ? (
    <>
      <strong>{data.kpis.online}</strong> of {data.kpis.total} online
    </>
  ) : has("online") ? (
    <>
      <strong>{data.kpis.online}</strong> online
    </>
  ) : has("total") ? (
    <>
      <strong>{data.kpis.total}</strong> clients
    </>
  ) : null;
  const latency = has("latency") && data.kpis.avgLatencyMs !== null ? <>{Math.round(data.kpis.avgLatencyMs)} ms average</> : null;
  return (
    <>
      {!kpis.hidden && (lead || latency) && (
        <p className="pclients__sum">
          {lead}
          {lead && latency && " · "}
          {latency}
        </p>
      )}
      {filter !== "all" && (
        <p className="pclients__filter">
          Showing {filterLabel} clients only.{" "}
          <button type="button" className="pclients__clear" onClick={() => setFilter("all")}>
            Show all clients
          </button>
        </p>
      )}
      <ul className="pclients" aria-label="Clients">
        {list.map((c) => {
          const w = statusWord(c);
          const Icon = deviceIcon(c);
          const right = c.status === "online" && c.lastLatencyMs !== null ? `${Math.round(c.lastLatencyMs)} ms` : w.label;
          return (
            <li key={c.id}>
              <button type="button" className={cx("prow", selectedId === c.id && "prow--on")} onClick={() => h.open(c)}>
                <span className={cx("prow__light", `prow__light--${w.tone}`)} aria-hidden />
                <Icon size={18} aria-hidden className="prow__icon" />
                <span className="prow__name">{c.name}</span>
                <span className={cx("prow__right", c.status !== "online" && "prow__right--state")}>{right}</span>
                <ChevronRight size={16} aria-hidden className="prow__chev" />
              </button>
            </li>
          );
        })}
      </ul>
      {list.length === 0 && <p className="pclients__sum">No client is in the starting filter.</p>}
      {rawId !== null && <ClientPanel id={rawId} client={selected} data={data} h={h} />}
    </>
  );
}
