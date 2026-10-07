// shared/topology/query.ts
//
// Plain English: the one Azure Resource Graph query a live diagram makes
// (lab topology spec §6.1, ruling 16). It lists every resource in the lab's
// own groups, rg-lab-<id> and rg-lab-<id>-*, and those groups' own rows (from
// resourcecontainers, in the same request), and nothing else; the Worker
// names the subscription in the request and re-checks every row's group with
// ownsName afterwards, so a longer lab id sharing the prefix can never leak
// in. The lab id must be a catalogue id (the caller checks) and must match
// LAB_ID_RE here, so nothing can be injected into the text. The Worker and
// scripts/topology-capture.mjs both use this function: one query form.

import { LAB_ID_MAX, LAB_ID_RE } from "../labs";

/** Resource Graph's REST API version (POST /providers/Microsoft.ResourceGraph/resources). */
export const ARG_API = "2022-10-01";
/** Rows per answer; more than this answers with a $skipToken, used as truncated. */
export const ARG_TOP = 1000;

/** The KQL text for one lab. Throws for anything that is not a lab id. */
export function topologyQuery(labId: string): string {
  if (typeof labId !== "string" || labId.length > LAB_ID_MAX || !LAB_ID_RE.test(labId)) throw new Error("not a lab id");
  const rg = `rg-lab-${labId}`;
  // The groups' own rows (resourcecontainers) come too, so a group with nothing in it yet is drawn, not "not deployed".
  return (
    `resources | where resourceGroup =~ '${rg}' or resourceGroup startswith '${rg}-' | project id, name, type, kind, location, resourceGroup, sku, tags, zones, identity, managedBy, properties` +
    ` | union (resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and (name =~ '${rg}' or name startswith '${rg}-') | project id, name, type, location, resourceGroup = name, tags, managedBy)` +
    ` | order by id asc`
  );
}

/** The request body for one lab in one subscription. */
export function topologyRequest(subscriptionId: string, labId: string): { subscriptions: string[]; query: string; options: { resultFormat: "objectArray"; $top: number } } {
  return { subscriptions: [subscriptionId], query: topologyQuery(labId), options: { resultFormat: "objectArray", $top: ARG_TOP } };
}
