import { FileText } from "lucide-react";
import type { ActivityResponse } from "@shared/api";
import { AUDIT_KINDS } from "../../../../worker/src/activity";
import { Column, DataTable, EmptyState, Panel, SearchInput, Select } from "@/components";
import { useWidget } from "@/widgets";
import { fmtWhen, inWindow, type Change, type Window } from "./model";
import { Chevron, Fill, Pager } from "./parts";
import type { ActivityParams } from "./useActivityParams";

const ALL = "all";
const OPTIONS = AUDIT_KINDS.map((k) => ({ value: k.value || ALL, label: k.label }));

export interface ChangeLogProps {
  changes: ActivityResponse["changes"];
  params: Pick<ActivityParams, "kind" | "q" | "page">;
  set: (patch: Record<string, string | number | null>, opts?: { replace?: boolean }) => void;
  window: Window | null;
  selected: number | null;
  onOpen: (id: number) => void;
}

/** The dashboard's change log: search, a kind filter (both asked of the API), and a row that opens the change. */
export function ChangeLog({ changes, params, set, window: win, selected, onOpen }: ChangeLogProps) {
  const { settings } = useWidget("activity.changeLog");
  const rows = changes.rows.filter((c) => inWindow(c.at, win));
  const cols: Column<Change>[] = [
    { key: "when", header: "When", cell: (c) => fmtWhen(c.at) },
    { key: "change", header: "Change", cell: (c) => <code className="act__code">{c.action}</code> },
    ...(settings.whatChanged ? [{ key: "what", header: "What changed", cell: (c: Change) => <span className="act__note">{c.lines.join(", ") || c.target || "—"}</span>, className: "act__col-what" }] : []),
    ...(settings.by ? [{ key: "by", header: "By", cell: (c: Change) => c.user, className: "act__col-actor" }] : []),
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
          rowKey={(c) => String(c.id)}
          selectedKey={selected === null ? null : String(selected)}
          onRowClick={(c) => onOpen(c.id)}
          rowLabel={(c) => c.action}
          empty={<EmptyState icon={<FileText size={20} />} title="No changes" description={params.q || params.kind || win ? "Nothing matches. Clear the search or reset the timeline." : "Changes made in the dashboard are logged here."} />}
        />
      </Fill>
      {(changes.more || params.page > 1) && <Pager label="Change log pages" page={changes.page} more={changes.more} onPage={(p) => set({ page: p })} />}
    </Panel>
  );
}
