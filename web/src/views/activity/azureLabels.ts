// azureLabels.ts
//
// Plain English: the wording for the cloud's operations and callers that the
// Change log's "Include Azure changes" opt-in needs. Kept apart from
// azure.tsx (the rest of the cloud parts, code-split with their widgets) so
// the always-on Change log does not pull those into the main bundle. Azure's
// operations read "Microsoft.Network/.../write"; AWS's are CloudTrail event
// names ("AuthorizeSecurityGroupIngress", AWS insights spec 4.3).

import type { AzureChangeRow, AzureChangesRange, Cloud } from "@shared/api";
import type { ActivityRange } from "../../../../worker/src/activity";

/** The Azure range that covers an Activity page range. */
export const azureRangeFor = (r: ActivityRange): AzureChangesRange => (r === "30d" ? "30d" : r === "7d" ? "7d" : "24h");

const VERBS: Record<string, string> = { write: "Changed", delete: "Deleted", start: "Started", deallocate: "Stopped", restart: "Restarted", powerOff: "Powered off" };

/** A CloudTrail event name's first word and what it did; anything else (Modify, Authorize, Revoke, Associate, ...) changed the resource. */
const AWS_VERBS: Record<string, string> = {
  Run: "Created",
  Create: "Created",
  Allocate: "Created",
  Import: "Created",
  Delete: "Deleted",
  Release: "Deleted",
  Terminate: "Deleted",
  Start: "Started",
  Stop: "Stopped",
  Reboot: "Restarted",
  Attach: "Attached",
  Detach: "Detached",
};

/** The resource's plain name inside a sentence: "network security group", but "EC2 instance" and "VPC" keep their capitals. */
const inSentence = (type: string) => (/^[A-Z][a-z]/.test(type) ? type.replace(/^./, (ch) => ch.toLowerCase()) : type);

/** "Changed network security group": the operation's verb and the resource's plain name. */
export function changeLabel(c: AzureChangeRow): string {
  const parts = c.operation.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  // A CloudTrail event name has no slashes: its first word is the verb.
  const verb = parts.length === 1 && !(last in VERBS) ? (AWS_VERBS[/^[A-Z][a-z]*/.exec(last)?.[0] ?? ""] ?? "Changed") : last === "action" ? (VERBS[parts.at(-2) ?? ""] ?? "Ran an action on") : (VERBS[last] ?? "Changed");
  return `${verb} ${inSentence(c.resourceType)}`;
}

/** cloudlabs's own changes say so; a portal or console change shows the person; the platform says Azure (or AWS). */
export const callerLabel = (c: AzureChangeRow, cloud: Cloud = "azure"): string => (c.callerKind === "wgadmin" ? "cloudlabs" : c.callerKind === "azure" ? (cloud === "aws" ? "AWS" : "Azure") : (c.caller ?? "Unknown"));
