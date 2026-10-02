import { useMemo, useState } from "react";
import type { ClientsResponse } from "@shared/api";
import { DataAge, EmptyState, Panel, SearchInput, Select, SplitView, Tabs, type SortState } from "@/components";
import { FILTERS, SORT_OPTIONS, TAB_FILTERS, matchesSearch, type FilterKey } from "./model";
import { KpiTiles } from "./KpiTiles";
import { ClientsTable } from "./ClientsTable";
import { SessionTraffic, StatusDonut, TopTalkers } from "./LowerRow";
import { ClientPanel } from "./ClientPanel";
import type { ClientHandlers } from "./ClientsScreen";
import "./ClientsDesktop.css";

const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };
const sortValue = (s: SortState | null) => (s ? `${s.key}:${s.dir}` : "");

/** The desktop and tablet composition (Clients mockup regions 2-6). */
export function ClientsDesktop({ data, selectedId, rawId, h }: { data: ClientsResponse; selectedId: number | null; rawId: string | null; h: ClientHandlers }) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(DEFAULT_SORT);
  const now = Date.parse(data.now) || Date.now();

  const counts = useMemo(() => Object.fromEntries(TAB_FILTERS.map((t) => [t.key, data.clients.filter(FILTERS[t.key]).length])), [data.clients]);
  const rows = useMemo(() => data.clients.filter((c) => FILTERS[filter](c) && matchesSearch(c, query)), [data.clients, filter, query]);

  // The Sort menu and the column headers set the same order; a header order the menu lacks is added to it.
  const options = useMemo(() => {
    const opts = SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
    const v = sortValue(sort);
    if (v && !opts.some((o) => o.value === v)) opts.push({ value: v, label: `${sort!.key[0]!.toUpperCase()}${sort!.key.slice(1)} (${sort!.dir === "asc" ? "ascending" : "descending"})` });
    return opts;
  }, [sort]);

  const selected = selectedId === null ? null : data.clients.find((c) => c.id === selectedId) ?? null;
  const tabValue = TAB_FILTERS.some((t) => t.key === filter) ? filter : "";

  return (
    <SplitView
      className="clients__split"
      panel={rawId !== null && <ClientPanel id={rawId} client={selected} data={data} h={h} />}
    >
      <div className="clients__main">
        <KpiTiles kpis={data.kpis} filter={filter} onFilter={setFilter} />

        <div className="clients__toolbar">
          <Tabs
            variant="pill"
            aria-label="Filter clients"
            value={tabValue}
            onValueChange={(v) => setFilter(v as FilterKey)}
            items={TAB_FILTERS.map((t) => ({ value: t.key, label: t.label, count: counts[t.key] }))}
            className="clients__tabs"
          />
          <SearchInput className="clients__search" label="Search clients" placeholder="Search clients by name, address, or public key..." value={query} onChange={setQuery} />
          <Select
            className="clients__sort"
            label="Sort by"
            options={options}
            value={sortValue(sort)}
            onValueChange={(v) => setSort(SORT_OPTIONS.find((o) => o.value === v)?.sort ?? sort)}
          />
          <DataAge className="clients__age" at={data.heartbeatAt ? Date.parse(data.heartbeatAt) : null} />
        </div>

        <Panel className="clients__table-panel clients-table-host" flush>
          <ClientsTable
            rows={rows}
            now={now}
            selectedId={selectedId}
            onOpen={h.open}
            actions={h.actions}
            sort={sort}
            onSortChange={(s) => setSort(s ?? DEFAULT_SORT)}
            empty={
              <EmptyState
                title="No clients match"
                description={query ? `Nothing matches “${query}” in this filter.` : "No client is in this filter."}
                action={{
                  label: "Show all clients",
                  onClick: () => {
                    setFilter("all");
                    setQuery("");
                  },
                }}
              />
            }
          />
        </Panel>

        <div className="lower">
          <TopTalkers data={data} />
          <StatusDonut clients={data.clients} />
          <SessionTraffic hist={data.trafficHist} />
        </div>
      </div>
    </SplitView>
  );
}
