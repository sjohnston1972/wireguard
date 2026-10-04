// azureLabels.ts
//
// Plain English: the wording for Azure's operations and callers that the
// Change log's "Include Azure changes" opt-in needs. Kept apart from
// azure.tsx (the rest of the Azure parts, code-split with their widgets) so
// the always-on Change log does not pull those into the main bundle.

import type { AzureChangeRow, AzureChangesRange } from "@shared/api";
import type { ActivityRange } from "../../../../worker/src/activity";

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

/** wg-admin's own changes say so; a portal change shows the person; the platform says Azure. */
export const callerLabel = (c: AzureChangeRow): string => (c.callerKind === "wgadmin" ? "wg-admin" : c.callerKind === "azure" ? "Azure" : (c.caller ?? "Unknown"));
