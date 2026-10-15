// AzureChanges.tsx
//
// Plain English: Activity's "Cloud changes" widget (titled "Azure change log"
// before AWS insights; the widget id is unchanged): who changed what in the
// cloud, the portal or console included. On an AWS server the rows are
// CloudTrail's, with AWS's own 5 to 15 minute delay said under the table
// (AWS insights spec 2026-10-15 sections 4.3 and 7).

import { History } from "lucide-react";
import { useState } from "react";
import type { AzureChangeRow, AzureChangesRange, AzureChangesWho, Cloud } from "@shared/api";
import { useAzureChanges } from "@/api/queries";
import { cloudLabel, insightsCloud } from "../overview/cloud";
import { Column, DataTable, Drawer, EmptyState, ErrorState, KeyValue, Panel, Skeleton } from "@/components";
import { useWidget } from "@/widgets";
import { ChangeStatus, FeedLine, NotConnected, callerLabel, changeLabel, isFailed, kindOf, notConnected, useHeld } from "./azure";
import { fmtWhen } from "./model";
import { Fill } from "./parts";
import { Chevron } from "./parts";

/** AWS's own delay before a change shows in CloudTrail (spec 4.3). */
export const AWS_DELAY_NOTE = "AWS shows changes 5–15 minutes after they happen.";

/** The widget's rows: the types it was set to, and (if asked) only the failed ones; and whose changes they are. */
export function useAzureChangeRows() {
  const { settings } = useWidget("activity.azureChanges");
  const q = useAzureChanges(settings.range as AzureChangesRange, settings.who as AzureChangesWho);
  const data = useHeld(q.data);
  const types = settings.types as string[];
  const rows = (data?.rows ?? []).filter((c) => types.includes(kindOf(c)) && (!settings.failedOnly || isFailed(c)));
  return { q, data, rows, settings, cloud: insightsCloud(data) };
}

/** What one change was, in a modal (a sheet on the phone). */
export function AzureChangeDrawer({ change, cloud = "azure", onClose }: { change: AzureChangeRow; cloud?: Cloud; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} side="auto" className="act__drawer" title={changeLabel(change)} subtitle={fmtWhen(change.at)}>
      <div className="act__drawer-body">
        <KeyValue
          items={[
            { label: "When", value: fmtWhen(change.at) },
            { label: "Result", value: <ChangeStatus status={change.status} /> },
            { label: "Caller", value: callerLabel(change, cloud) },
            { label: "Resource", value: change.resourceName },
            { label: "Resource type", value: change.resourceType },
            { label: "Operation", value: change.operation, mono: true },
          ]}
        />
      </div>
    </Drawer>
  );
}

/** Activity's "Cloud changes" widget: who changed what in the cloud. */
export function AzureChangesPanel() {
  const { q, data, rows, settings, cloud } = useAzureChangeRows();
  const label = cloudLabel(cloud);
  const [open, setOpen] = useState<string | null>(null);
  const cols: Column<AzureChangeRow>[] = [
    { key: "when", header: "When", cell: (c) => fmtWhen(c.at), className: "act__col-azwhen" },
    { key: "change", header: "Change", cell: (c) => <span className="act__azchange" title={changeLabel(c)}>{changeLabel(c)}</span> },
    { key: "what", header: "What", cell: (c) => <span className="act__note" title={c.resourceName ?? undefined}>{c.resourceName ?? "—"}</span>, className: "act__col-what" },
    ...(settings.status ? [{ key: "status", header: "Status", cell: (c: AzureChangeRow) => <ChangeStatus status={c.status} />, className: "act__col-azstatus" }] : []),
    ...(settings.caller ? [{ key: "caller", header: "Caller", cell: (c: AzureChangeRow) => <span title={callerLabel(c, cloud)}>{callerLabel(c, cloud)}</span>, className: "act__col-actor" }] : []),
    { key: "go", header: <span className="visually-hidden">Open</span>, cell: () => <Chevron />, align: "right", width: 28, className: "act__col-go" },
  ];
  const off = notConnected(data?.feed);
  const selected = rows.find((c) => c.id === open) ?? null;
  return (
    <Panel title="Cloud changes" className="act__log act__azlog" flush bodyClassName="act__list-body">
      {!data && q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <div aria-busy="true" className="act__skel">
          <Skeleton variant="block" height={96} />
        </div>
      ) : off ? (
        <NotConnected cloud={cloud} />
      ) : (
        <>
          <Fill>
            <DataTable
              aria-label={`${label} changes`}
              columns={cols}
              rows={rows}
              rowKey={(c) => c.id}
              selectedKey={open}
              onRowClick={(c) => setOpen(c.id)}
              rowLabel={changeLabel}
              empty={<EmptyState icon={<History size={20} />} title={`No ${label} changes`} description={settings.failedOnly ? "No failed changes in this range." : `Nothing changed in ${label} in this range.`} />}
            />
          </Fill>
          {cloud === "aws" && <p className="act__feed">{AWS_DELAY_NOTE}</p>}
          <FeedLine feed={data.feed} cloud={cloud} />
        </>
      )}
      {selected && <AzureChangeDrawer change={selected} cloud={cloud} onClose={() => setOpen(null)} />}
    </Panel>
  );
}
