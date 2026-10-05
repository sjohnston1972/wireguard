import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { History } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { AUDIT_KINDS } from "../../../../worker/src/activity";
import { Column, DataTable, EmptyState, Panel, SearchInput, Select, StatusPill, Tabs } from "@/components";
import { EVENT_TYPES, fmtDuration, fmtGbp, fmtWhen, inWindow, noteKind, resultPill, runWord, TABS, type Change, type EventRow, type Note, type RunRow, type Tab, type Window } from "./model";
import { Chevron, Fill, Pager, TypeTag } from "./parts";
import type { ActivityParams } from "./useActivityParams";
import { useWidget } from "@/widgets";

const ALL = "all";
const dash = "—";

const RESULTS = [
  { value: ALL, label: "All results" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failed" },
  { value: "running", label: "Running" },
];
const TYPES = [{ value: ALL, label: "All events" }, ...EVENT_TYPES.map((e) => ({ value: e.value as string, label: e.label }))];
const CHANGE_KINDS = AUDIT_KINDS.map((k) => ({ value: k.value || ALL, label: k.label }));

export interface ActivityListProps {
  data: ActivityResponse;
  params: Pick<ActivityParams, "tab" | "kind" | "q" | "page" | "range">;
  set: (patch: Record<string, string | number | null>, opts?: { replace?: boolean }) => void;
  window: Window | null;
  selectedRun: string | null;
  onOpenRun: (id: string) => void;
  onOpenChange: (id: number) => void;
}

const has = (blob: string, find: string) => !find.trim() || blob.toLowerCase().includes(find.trim().toLowerCase());

const runBlob = (r: RunRow) => [runWord(r), r.lab?.title, resultPill(r.status).label, r.requested_by, r.source, r.error, r.public_ip].filter(Boolean).join(" ");

/** The four tabs (Runs, All activity, Config changes, Watchman notes) with search and one filter. */
export function ActivityList({ data, params, set, window: win, selectedRun, onOpenRun, onOpenChange }: ActivityListProps) {
  const { tab } = params;
  const navigate = useNavigate();
  const { settings } = useWidget("activity.list");
  const density = settings.density as "comfortable" | "compact";
  const [filters, setFilters] = useState<Partial<Record<Tab, string>>>({});
  const [find, setFind] = useState("");
  const [labsOnly, setLabsOnly] = useState(false);
  const anyLab = data.runs.some((r) => r.lab);
  const filter = filters[tab] ?? ALL;
  const setFilter = (v: string) => setFilters((f) => ({ ...f, [tab]: v }));

  const runs = data.runs.filter((r) => (!labsOnly || !!r.lab) && inWindow(r.requested_at, win) && (filter === ALL || (filter === "running" ? r.status === "running" || r.status === "queued" : r.status === filter)) && has(runBlob(r), find));
  const all = data.all.filter((e) => inWindow(e.at, win) && (filter === ALL || e.type === filter) && has(`${e.title} ${e.detail ?? ""} ${e.type}`, find));
  const noteKinds = [...new Set(data.notes.map((n) => n.kind))];
  const notes = data.notes.filter((n) => inWindow(n.at, win) && (filter === ALL || n.kind === filter) && has(`${n.kind} ${n.message}`, find));
  const changes = data.changes.rows.filter((c) => inWindow(c.at, win));

  const shownRunCols = new Set(settings.runColumns as string[]);
  const runExtras: Column<RunRow>[] = [
    { key: "duration", header: "Duration", cell: (r) => fmtDuration(r.durationSeconds) ?? dash },
    { key: "cost", header: "Cost impact", cell: (r) => (typeof r.sessionCostGbp === "number" ? `est. ${fmtGbp(r.sessionCostGbp)}` : dash) },
    { key: "actor", header: "Actor", cell: (r) => r.requested_by ?? dash, className: "act__col-actor" },
    { key: "source", header: "Source", cell: (r) => r.source, className: "act__col-source" },
    { key: "notes", header: "Notes", cell: (r) => <span className="act__note">{r.error ?? dash}</span>, className: "act__col-notes" },
    { key: "publicIp", header: "Public IP", cell: (r) => r.public_ip ?? dash },
  ];
  const runCols: Column<RunRow>[] = [
    { key: "when", header: "When", cell: (r) => fmtWhen(r.requested_at) },
    { key: "action", header: "Action", cell: (r) => (
        <>
          <strong className="act__action">{runWord(r)}</strong>
          {r.lab && <span className="act__muted act__lab"> {r.lab.title}</span>}
        </>
      ),
    },
    { key: "result", header: "Result", cell: (r) => <StatusPill {...resultPill(r.status)} /> },
    ...runExtras.filter((c) => shownRunCols.has(c.key)),
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: () => <Chevron />, align: "right", width: 32 },
  ];
  const allCols: Column<EventRow>[] = [
    { key: "when", header: "When", cell: (e) => fmtWhen(e.at) },
    { key: "type", header: "Type", cell: (e) => <TypeTag type={e.type} /> },
    { key: "event", header: "Event", cell: (e) => <strong className="act__action">{e.title}</strong> },
    { key: "detail", header: "Detail", cell: (e) => <span className="act__note">{e.detail ?? dash}</span> },
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: (e) => (e.ref.kind === "note" ? null : <Chevron />), align: "right", width: 32 },
  ];
  const changeCols: Column<Change>[] = [
    { key: "when", header: "When", cell: (c) => fmtWhen(c.at) },
    { key: "change", header: "Change", cell: (c) => <code className="act__code">{c.action}</code> },
    { key: "what", header: "What changed", cell: (c) => <span className="act__note">{c.lines.join(", ") || c.target || dash}</span> },
    { key: "by", header: "By", cell: (c) => c.user, className: "act__col-actor" },
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: () => <Chevron />, align: "right", width: 32 },
  ];
  const noteCols: Column<Note>[] = [
    { key: "when", header: "When", cell: (n) => fmtWhen(n.at) },
    { key: "kind", header: "Kind", cell: (n) => <strong className="act__action">{noteKind(n.kind)}</strong> },
    { key: "message", header: "Message", cell: (n) => <span className="act__note">{n.message}</span> },
    { key: "seen", header: "Seen", cell: (n) => (n.acknowledged ? "Yes" : "New") },
  ];

  const empty = (what: string, hint: string, action?: { label: string; onClick: () => void }) => (
    <EmptyState icon={<History size={20} />} title={`No ${what} in this range`} description={hint} action={action} />
  );

  const filterOptions = tab === "runs" ? RESULTS : tab === "all" ? TYPES : tab === "changes" ? CHANGE_KINDS : [{ value: ALL, label: "All notes" }, ...noteKinds.map((k) => ({ value: k, label: noteKind(k) }))];
  const filterValue = tab === "changes" ? params.kind || ALL : filter;
  const onFilter = (v: string) => (tab === "changes" ? set({ kind: v === ALL ? null : v }) : setFilter(v));
  const search = tab === "changes" ? params.q : find;
  const onSearch = (v: string) => (tab === "changes" ? set({ q: v }, { replace: true }) : setFind(v));
  const firewallOnly = params.kind === "firewall";

  return (
    <Panel className="act__list" flush bodyClassName="act__list-body">
      <div className="act__toolbar">
        <Tabs
          variant="pill"
          aria-label="Activity views"
          value={tab}
          onValueChange={(v) => set({ tab: v })}
          items={TABS.map((t) => ({ value: t.value, label: t.label }))}
        />
        <div className="act__tools">
          {tab === "runs" && anyLab && (
            <button type="button" className="act__toggle" aria-pressed={labsOnly} onClick={() => setLabsOnly((v) => !v)}>
              Labs
            </button>
          )}
          {tab === "changes" && (
            <button type="button" className="act__toggle" aria-pressed={firewallOnly} onClick={() => set({ kind: firewallOnly ? null : "firewall" })}>
              Firewall events
            </button>
          )}
          <Select label="Filter" value={filterValue} onValueChange={onFilter} options={filterOptions} />
          <SearchInput label="Search this list" placeholder="Search runs, IPs, users..." value={search} onChange={onSearch} className="act__search" />
        </div>
      </div>
      <Fill>
        {tab === "runs" && (
          <DataTable
            aria-label="Runs"
            density={density}
            columns={runCols}
            rows={runs}
            rowKey={(r) => r.id}
            selectedKey={selectedRun}
            onRowClick={(r) => onOpenRun(r.id)}
            rowLabel={(r) => `${runWord(r)}${r.lab ? ` ${r.lab.title}` : ""} ${fmtWhen(r.requested_at)}`}
            empty={empty("runs", win || find || filter !== ALL ? "Nothing matches the window or filter. Reset the timeline or clear the search." : "Deploy from Overview to start a session.", win || find || filter !== ALL ? undefined : { label: "Open Overview", onClick: () => navigate("/") })}
          />
        )}
        {tab === "all" && (
          <DataTable
            aria-label="All activity"
            density={density}
            columns={allCols}
            rows={all}
            rowKey={(e) => `${e.ref.kind}-${e.ref.id}-${e.at}`}
            onRowClick={(e) => (e.ref.kind === "run" ? onOpenRun(String(e.ref.id)) : e.ref.kind === "change" ? onOpenChange(Number(e.ref.id)) : undefined)}
            rowLabel={(e) => e.title}
            empty={empty("activity", "Runs, notes and changes show up here as they happen.")}
          />
        )}
        {tab === "changes" && (
          <DataTable
            aria-label="Config changes"
            density={density}
            columns={changeCols}
            rows={changes}
            rowKey={(c) => String(c.id)}
            onRowClick={(c) => onOpenChange(c.id)}
            rowLabel={(c) => c.action}
            empty={empty("config changes", params.q || params.kind ? "Nothing matches this search or filter. Clear it to see every change." : "Changes made in the dashboard are logged here.")}
          />
        )}
        {tab === "notes" && (
          <DataTable aria-label="Watchman notes" density={density} columns={noteCols} rows={notes} rowKey={(n) => String(n.id)} rowLabel={(n) => n.kind} empty={empty("watchman notes", "The watchman writes a note when something looks wrong.")} />
        )}
      </Fill>
      {tab === "changes" && (data.changes.more || params.page > 1) && <Pager label="Config changes pages" page={data.changes.page} more={data.changes.more} onPage={(p) => set({ page: p })} />}
    </Panel>
  );
}
