// ServiceHealth.tsx
//
// Plain English: Activity's "Cloud service health" widget (titled "Azure
// service health" before AWS insights; the widget id is unchanged): this
// region's issues and planned maintenance, active first. On an AWS server
// they come from AWS's public status feed for EC2 and VPC (AWS insights spec
// 2026-10-15 sections 4.4 and 7), and the words name AWS.

import { useState } from "react";
import type { AzureServiceHealthRange, ServiceEvent } from "@shared/api";
import { useAzureServiceHealth, useAzureSummary } from "@/api/queries";
import { cloudLabel, insightsCloud } from "../overview/cloud";
import { Drawer, EmptyState, ErrorState, KeyValue, Panel, Skeleton } from "@/components";
import { useWidget } from "@/widgets";
import { EventPill, FeedLine, NotConnected, activeFirst, notConnected, useHeld } from "./azure";
import { fmtWhen } from "./model";

/** The widget's events: the types it was set to, active ones first, the region's name in plain words, and whose events they are. */
export function useServiceEvents() {
  const { settings } = useWidget("activity.serviceHealth");
  const q = useAzureServiceHealth(settings.range as AzureServiceHealthRange);
  const data = useHeld(q.data);
  const summary = useAzureSummary();
  const types = settings.types as string[];
  const events = activeFirst((data?.events ?? []).filter((e) => types.includes(e.type === "ServiceIssue" ? "issue" : "maintenance")));
  return { q, data, events, settings, region: summary.data?.region.name ?? "your region", cloud: insightsCloud(data ?? summary.data) };
}

/** One event's facts, in a modal (a sheet on the phone). */
export function ServiceEventDrawer({ event, region, onClose }: { event: ServiceEvent; region: string; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} side="auto" className="act__drawer" title={event.title} subtitle={event.trackingId} leading={<EventPill e={event} />}>
      <div className="act__drawer-body">
        <KeyValue
          items={[
            { label: "Region", value: region },
            { label: "Services", value: event.services.join(", ") || null },
            { label: "Started", value: event.startsAt ? fmtWhen(event.startsAt) : null },
            { label: "Ended", value: event.endsAt ? fmtWhen(event.endsAt) : event.status === "Active" ? "not yet" : null },
            { label: "Last update", value: fmtWhen(event.updatedAt) },
          ]}
        />
        {event.summary && <p>{event.summary}</p>}
      </div>
    </Drawer>
  );
}

/** Activity's "Cloud service health" widget: this region's issues and planned maintenance, active first. */
export function ServiceHealthPanel() {
  const { q, data, events, settings, region, cloud } = useServiceEvents();
  const label = cloudLabel(cloud);
  const [open, setOpen] = useState<string | null>(null);
  const selected = events.find((e) => e.trackingId === open) ?? null;
  return (
    <Panel title="Cloud service health" className="act__health">
      {!data && q.isError ? (
        <ErrorState message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !data ? (
        <div aria-busy="true" className="act__skel">
          <Skeleton variant="line" />
        </div>
      ) : notConnected(data.feed) ? (
        <NotConnected cloud={cloud} />
      ) : events.length === 0 ? (
        <EmptyState title={`No ${label} issues or maintenance in ${region}`} description={`Nothing affecting VMs or networking in the last ${settings.range === "7d" ? "7 days" : settings.range === "90d" ? "90 days" : "30 days"}.`} />
      ) : (
        <ul className="act__events act__health-list" aria-label={`${label} service events`}>
          {events.map((e) => (
            <li key={e.trackingId} className="act__health-item">
              <button type="button" className="act__health-open" aria-label={`${e.title}, ${e.type === "ServiceIssue" ? "issue" : "maintenance"}`} onClick={() => setOpen(e.trackingId)}>
                <EventPill e={e} />
                <span className="act__event-text">
                  <strong>{e.title}</strong>
                  <span>
                    {e.services.join(", ")}
                    {e.startsAt ? ` · ${fmtWhen(e.startsAt)}` : ""}
                  </span>
                  {settings.summaries && e.summary && <span>{e.summary}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {data && <FeedLine feed={data.feed} cloud={cloud} />}
      {selected && <ServiceEventDrawer event={selected} region={region} onClose={() => setOpen(null)} />}
    </Panel>
  );
}
