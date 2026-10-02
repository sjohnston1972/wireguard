import { ChevronRight } from "lucide-react";
import type { ClientsResponse } from "@shared/api";
import { cx } from "@/components";
import { statusWord } from "./model";
import { deviceIcon } from "./ClientsTable";
import { ClientPanel } from "./ClientPanel";
import type { ClientHandlers } from "./ClientsScreen";
import "./ClientsPhone.css";

/**
 * The phone composition (spec 9): one line per device (a light, the name,
 * the latency or the state); a tap opens the client's panel as a bottom sheet.
 */
export function ClientsPhone({ data, selectedId, h }: { data: ClientsResponse; selectedId: number | null; h: ClientHandlers }) {
  const selected = selectedId === null ? null : data.clients.find((c) => c.id === selectedId) ?? null;
  const online = data.kpis.online;
  return (
    <>
      <p className="pclients__sum">
        <strong>{online}</strong> of {data.kpis.total} online
        {data.kpis.avgLatencyMs !== null && <> · {Math.round(data.kpis.avgLatencyMs)} ms average</>}
      </p>
      <ul className="pclients" aria-label="Clients">
        {data.clients.map((c) => {
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
      {selectedId !== null && <ClientPanel id={selectedId} client={selected} data={data} h={h} />}
    </>
  );
}
