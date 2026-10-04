import { FileText } from "lucide-react";
import { useState } from "react";
import type { AzureChangeRow } from "@shared/api";
import type { ActivityResponse } from "@shared/api";
import { AUDIT_KINDS } from "../../../../worker/src/activity";
import { useAzureChanges } from "@/api/queries";
import { Column, DataTable, EmptyState, Panel, SearchInput, Select } from "@/components";
import { useWidget } from "@/widgets";
import { AzureChangeDrawer } from "./AzureChanges";
import { azureRangeFor, callerLabel, changeLabel } from "./azure";
import { fmtWhen, inWindow, type Change, type Window } from "./model";
import { Chevron, Fill, Pager } from "./parts";
import type { ActivityParams } from "./useActivityParams";

const ALL = "all";
const OPTIONS = AUDIT_KINDS.map((k) => ({ value: k.value || ALL, label: k.label }));

type Row = Change & { az?: AzureChangeRow };

export interface ChangeLogProps {
  changes: ActivityResponse["changes"];
  params: Pick<ActivityParams, "kind" | "q" | "page" | "range">;
  set: (patch: Record<string, string | number | null>, opts?: { replace?: boolean }) => void;
  window: Window | null;
  selected: number | null;
  onOpen: (id: number) => void;
}

/** The dashboard's change log: search, a kind filter (both asked of the API), and a row that opens the change. */
export function ChangeLog({ changes, params, set, window: win, selected, onOpen }: ChangeLogProps) {
  const { settings } = useWidget("activity.changeLog");
  // "Include Azure changes": Azure's rows (first page only, so a page change never repeats them) join in time order, tagged Azure.
  const azure = settings.azure === true;
  const az = useAzureChanges(azureRangeFor(params.range), "all", { enabled: azure });
  const [azOpen, setAzOpen] = useState<AzureChangeRow | null>(null);
  const needle = params.q.trim().toLowerCase();
  const azRows: Row[] =
    azure && !params.kind && params.page <= 1
      ? (az.data?.rows ?? [])
          .map((a): Row => ({ id: 0, at: a.at, user: callerLabel(a), action: changeLabel(a), target: a.resourceName ?? "", before_json: null, after_json: null, lines: [a.resourceName ?? ""], az: a }))
          .filter((c) => !needle || `${c.user} ${c.action} ${c.target}`.toLowerCase().includes(needle))
      : [];
  const rows: Row[] = [...changes.rows, ...azRows].filter((c) => inWindow(c.at, win)).sort((a, b) => (azRows.length ? Date.parse(b.at) - Date.parse(a.at) : 0));
  const cols: Column<Row>[] = [
    { key: "when", header: "When", cell: (c) => fmtWhen(c.at) },
    { key: "change", header: "Change", cell: (c) => (c.az ? <span className="act__code">{c.action} <span className="act__tag">Azure</span></span> : <code className="act__code">{c.action}</code>) },
    ...(settings.whatChanged ? [{ key: "what", header: "What changed", cell: (c: Row) => <span className="act__note">{c.lines.join(", ") || c.target || "—"}</span>, className: "act__col-what" }] : []),
    ...(settings.by ? [{ key: "by", header: "By", cell: (c: Row) => c.user, className: "act__col-actor" }] : []),
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: () => <Chevron />, align: "right", width: 28 },
  ];
  return (
    <Panel
      title="Change log"
      className="act__log"
      flush
      actions={
        <>
          <SearchInput label="Search changes" placeholder="Search who, what or which..." value={params.q} onChange={(v) => set({ q: v }, { replace: true })} className="act__search" />
          <Select label="Change kind" value={params.kind || ALL} onValueChange={(v) => set({ kind: v === ALL ? null : v })} options={OPTIONS} />
        </>
      }
      bodyClassName="act__list-body"
    >
      <Fill>
        <DataTable
          aria-label="Changes"
          columns={cols}
          rows={rows}
          rowKey={(c) => (c.az ? `az-${c.az.id}` : String(c.id))}
          selectedKey={selected === null ? null : String(selected)}
          onRowClick={(c) => (c.az ? setAzOpen(c.az) : onOpen(c.id))}
          rowLabel={(c) => c.action}
          empty={<EmptyState icon={<FileText size={20} />} title="No changes" description={params.q || params.kind || win ? "Nothing matches. Clear the search or reset the timeline." : "Changes made in the dashboard are logged here."} />}
        />
      </Fill>
      {(changes.more || params.page > 1) && <Pager label="Change log pages" page={changes.page} more={changes.more} onPage={(p) => set({ page: p })} />}
      {azOpen && <AzureChangeDrawer change={azOpen} onClose={() => setAzOpen(null)} />}
    </Panel>
  );
}
