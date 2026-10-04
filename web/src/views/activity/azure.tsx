// azure.tsx
//
// Plain English: what the Azure parts of the Activity page share: wording for
// Azure's operations, callers and events, the footer line that says how fresh
// the data is, and the messages for "not connected", "empty" and "failing".

import { useRef, type ReactNode } from "react";
import type { AzureChangeRow, AzureChangesRange, FeedStatus, ServiceEvent } from "@shared/api";
import { AZURE_RESOURCE_KINDS, feedIsStale } from "@shared/azureMetrics";
import type { ActivityRange } from "../../../../worker/src/activity";
import { DataAge, EmptyState, StatusPill, type PillStatus, type Tone } from "@/components";

/** The last good answer, so a new range keeps the old rows on screen until the new ones arrive. */
export function useHeld<T>(data: T | undefined): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  if (data !== undefined) ref.current = data;
  return data ?? ref.current;
}

/** The Azure range that covers an Activity page range. */
export const azureRangeFor = (r: ActivityRange): AzureChangesRange => (r === "30d" ? "30d" : r === "7d" ? "7d" : "24h");

const VERBS: Record<string, string> = { write: "Changed", delete: "Deleted", start: "Started", deallocate: "Stopped", restart: "Restarted", powerOff: "Powered off" };

/** "Changed network security group": the operation's verb and the resource's plain name. */
export function changeLabel(c: AzureChangeRow): string {
  const parts = c.operation.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  const verb = last === "action" ? (VERBS[parts.at(-2) ?? ""] ?? "Ran an action on") : (VERBS[last] ?? "Changed");
  return `${verb} ${c.resourceType.replace(/^./, (ch) => ch.toLowerCase())}`;
}

/** The kind (vm, nsg, ...) a row's plain resource name stands for; "other" for anything unlisted. */
export const kindOf = (c: AzureChangeRow): string => AZURE_RESOURCE_KINDS.find((k) => k.label === c.resourceType)?.value ?? "other";

/** wg-admin's own changes say so; a portal change shows the person; the platform says Azure. */
export const callerLabel = (c: AzureChangeRow): string => (c.callerKind === "wgadmin" ? "wg-admin" : c.callerKind === "azure" ? "Azure" : (c.caller ?? "Unknown"));

export const isFailed = (c: AzureChangeRow): boolean => /fail/i.test(c.status);

/** Azure's own status word, with a colour: Succeeded green, Failed red, anything else (Started, Accepted) amber. */
export function ChangeStatus({ status }: { status: string }) {
  const ok = /succe/i.test(status);
  const bad = /fail/i.test(status);
  const pill: PillStatus = ok ? "success" : bad ? "failure" : "running";
  return <StatusPill status={pill} label={status} />;
}

/** Active issue (amber) or Severe issue (red at level Error); Resolved; Maintenance (blue) or Maintenance done. */
export function eventPill(e: ServiceEvent): { label: string; tone: Tone } {
  if (e.type === "PlannedMaintenance") return e.status === "Active" ? { label: "Maintenance", tone: "blue" } : { label: "Maintenance done", tone: "grey" };
  if (e.status === "Resolved") return { label: "Resolved", tone: "green" };
  return /^error$/i.test(e.level ?? "") ? { label: "Severe issue", tone: "red" } : { label: "Active issue", tone: "amber" };
}

export const EventPill = ({ e }: { e: ServiceEvent }) => <StatusPill status="custom" dot {...eventPill(e)} />;

/** Active events first, then the rest, each group keeping the API's order. */
export const activeFirst = (events: ServiceEvent[]): ServiceEvent[] => [...events.filter((e) => e.status === "Active"), ...events.filter((e) => e.status !== "Active")];

/** The feed's state in words under a widget: when it last worked, amber once stale, or why it is failing. */
export function FeedLine({ feed }: { feed: FeedStatus }) {
  const stale = feed.status === "ok" && feedIsStale(feed, Date.now());
  if (feed.status === "error") return <p className="act__feed act__feed--bad" role="status">Azure is not answering: {feed.error ?? "unknown error"}. Showing the last data.</p>;
  if (feed.status !== "ok" && feed.status !== "idle") return null;
  return (
    <p className={stale ? "act__feed act__feed--stale" : "act__feed"}>
      Azure · <DataAge at={feed.lastOkAt ? Date.parse(feed.lastOkAt) : null} />
      {stale ? " · Out of date" : ""}
    </p>
  );
}

export const notConnected = (feed: FeedStatus | undefined): boolean => feed?.status === "not_configured";

/** The empty body for a widget that has nothing to list. */
export const NotConnected = (): ReactNode => <EmptyState title="Azure isn't connected" description="Add the service principal secrets to the Worker, and Azure's data appears here." />;
