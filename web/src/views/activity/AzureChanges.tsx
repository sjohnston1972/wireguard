import { History } from "lucide-react";
import { useState } from "react";
import type { AzureChangeRow, AzureChangesRange, AzureChangesWho } from "@shared/api";
import { useAzureChanges, useAzureSummary } from "@/api/queries";
import { Column, DataTable, Drawer, EmptyState, ErrorState, KeyValue, Panel, Skeleton } from "@/components";
import { useWidget } from "@/widgets";
import { ChangeStatus, FeedLine, NotConnected, callerLabel, changeLabel, isFailed, kindOf, notConnected, useHeld } from "./azure";
import { fmtWhen } from "./model";
import { Fill } from "./parts";
import { Chevron } from "./parts";

/** The widget's rows: the types it was set to, and (if asked) only the failed ones. */
export function useAzureChangeRows() {
  const { settings } = useWidget("activity.azureChanges");
  const q = useAzureChanges(settings.range as AzureChangesRange, settings.who as AzureChangesWho);
  const data = useHeld(q.data);
  const summary = useAzureSummary();
  const types = settings.types as string[];
  const rows = (data?.rows ?? []).filter((c) => types.includes(kindOf(c)) && (!settings.failedOnly || isFailed(c)));
  return { q, data, rows, settings };
}

/** What one Azure change was, in a modal (a sheet on the phone). */
export function AzureChangeDrawer({ change, onClose }: { change: AzureChangeRow; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} side="auto" className="act__drawer" title={changeLabel(change)} subtitle={fmtWhen(change.at)}>
      <div className="act__drawer-body">
        <KeyValue
          items={[
            { label: "When", value: fmtWhen(change.at) },
            { label: "Result", value: <ChangeStatus status={change.status} /> },
            { label: "Caller", value: callerLabel(change) },
            { label: "Resource", value: change.resourceName },
            { label: "Resource type", value: change.resourceType },
            { label: "Operation", value: change.operation, mono: true },
          ]}
        />
      </div>
    </Drawer>
  );
}

/** Activity's "Azure change log" widget: who changed what in Azure, the portal included. */
export function AzureChangesPanel() {
  const { q, data, rows, settings } = useAzureChangeRows();
  const [open, setOpen] = useState<string | null>(null);
  const cols: Column<AzureChangeRow>[] = [
    { key: "when", header: "When", cell: (c) => fmtWhen(c.at) },
    { key: "change", header: "Change", cell: (c) => <span className="act__azchange" title={changeLabel(c)}>{changeLabel(c)}</span> },
    { key: "what", header: "What", cell: (c) => <span className="act__note">{c.resourceName ?? "—"}</span>, className: "act__col-what" },
    ...(settings.status ? [{ key: "status", header: "Status", cell: (c: AzureChangeRow) => <ChangeStatus status={c.status} /> }] : []),
    ...(settings.caller ? [{ key: "caller", header: "Caller", cell: (c: AzureChangeRow) => callerLabel(c), className: "act__col-actor" }] : []),
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: () => <Chevron />, align: "right", width: 28 },
  ];
  const off = notConnected(data?.feed);
  const selected = rows.find((c) => c.id === open) ?? null;
  return (
    <Panel title="Azure change log" className="act__log act__azlog" flush bodyClassName="act__list-body">
      {!data && q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <div aria-busy="true" className="act__skel">
          <Skeleton variant="block" height={96} />
        </div>
      ) : off ? (
        <NotConnected />
      ) : (
        <>
          <Fill>
            <DataTable
              aria-label="Azure changes"
              columns={cols}
              rows={rows}
              rowKey={(c) => c.id}
              selectedKey={open}
              onRowClick={(c) => setOpen(c.id)}
              rowLabel={changeLabel}
              empty={<EmptyState icon={<History size={20} />} title="No Azure changes" description={settings.failedOnly ? "No failed changes in this range." : "Nothing changed in Azure in this range."} />}
            />
          </Fill>
          <FeedLine feed={data.feed} />
        </>
      )}
      {selected && <AzureChangeDrawer change={selected} onClose={() => setOpen(null)} />}
    </Panel>
  );
}
