import { useMemo, useState } from "react";
import type { ClientsResponse } from "@shared/api";
import type { Threshold } from "@shared/widgets";
import { DataAge, EmptyState, Panel, SearchInput, Select, SplitView, Tabs, type SortState } from "@/components";
import { Widget, WidgetRow, useStarting, useWidget } from "@/widgets";
import { FILTERS, SORT_OPTIONS, START_FILTERS, START_SORTS, TAB_FILTERS, matchesSearch, type FilterKey } from "./model";
import { KpiTiles } from "./KpiTiles";
import { ClientsTable } from "./ClientsTable";
import { SessionTraffic, StatusDonut, TopTalkers } from "./LowerRow";
import { ClientPanel } from "./ClientPanel";
import type { ClientHandlers } from "./ClientsScreen";
import "./ClientsDesktop.css";

const sortValue = (s: SortState | null) => (s ? `${s.key}:${s.dir}` : "");

/** The desktop and tablet composition (Clients mockup regions 2-6). */
export function ClientsDesktop({ data, selectedId, rawId, h }: { data: ClientsResponse; selectedId: number | null; rawId: string | null; h: ClientHandlers }) {
  const { settings } = useWidget("clients.table");
  // The widget's starting filter and sort show until the in-panel controls are used (those change the view for the visit only);
  // a changed setting (the cog, another device) starts them again.
  const startFilter = START_FILTERS[settings.filter as string] ?? "all";
  const startSort = START_SORTS[settings.sort as string] ?? START_SORTS.nameAsc!;
  const [filter, setFilter] = useStarting<FilterKey>(startFilter);
  const [sort, setSort] = useStarting<SortState | null>(startSort);
  const [query, setQuery] = useState("");
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
        <Widget id="clients.kpis" headerless>
          <KpiTiles kpis={data.kpis} filter={filter} onFilter={setFilter} />
        </Widget>

        <Widget id="clients.table" headerless>
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
              onSortChange={(s) => setSort(s ?? startSort)}
              show={settings.columns as string[]}
              sparkline={settings.sparkline !== false}
              density={settings.density === "compact" ? "compact" : "comfortable"}
              latency={settings.latency as Threshold}
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
        </Widget>

        <WidgetRow page="clients" row="r3" className="lower">
          {{
            "clients.talkers": (
              <Widget id="clients.talkers">
                <TopTalkers data={data} />
              </Widget>
            ),
            "clients.statusDonut": (
              <Widget id="clients.statusDonut">
                <StatusDonut clients={data.clients} />
              </Widget>
            ),
            "clients.sessionTraffic": (
              <Widget id="clients.sessionTraffic">
                <SessionTraffic hist={data.trafficHist} />
              </Widget>
            ),
          }}
        </WidgetRow>
      </div>
    </SplitView>
  );
}
