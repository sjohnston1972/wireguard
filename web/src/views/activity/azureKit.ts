import type { AzureChangeRow, AzureChangesResponse, AzureServiceHealthResponse, PagePrefs, ServiceEvent, SettingValue } from "@shared/api";
import { widgetDef } from "@shared/widgets";
import { feedFixture } from "@/test/fixtures";
import { NOW } from "./testkit";

// Test data for the Azure parts of the Activity page (TEST-NET and example names only).

const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();

export const azChange = (over: Partial<AzureChangeRow> = {}): AzureChangeRow => ({
  id: "c1",
  at: ago(30),
  operation: "Microsoft.Network/networkSecurityGroups/securityRules/write",
  status: "Succeeded",
  caller: "someone@example.net",
  callerKind: "person",
  resourceType: "Network security group",
  resourceName: "wg-nsg",
  ...over,
});

/** Newest first: a portal NSG edit, wg-admin starting the VM, a failed disk write, a platform event. */
export const azChangeRows = (): AzureChangeRow[] => [
  azChange(),
  azChange({ id: "c2", at: ago(90), operation: "Microsoft.Compute/virtualMachines/start/action", caller: "wg-admin", callerKind: "wgadmin", resourceType: "Virtual machine", resourceName: "wg-vm" }),
  azChange({ id: "c3", at: ago(300), operation: "Microsoft.Compute/disks/write", status: "Failed", resourceType: "Disk", resourceName: "wg-disk" }),
  azChange({ id: "c4", at: ago(600), operation: "Microsoft.Network/publicIPAddresses/delete", caller: null, callerKind: "azure", resourceType: "Public IP", resourceName: "wg-ip" }),
];

export const azChangesResponse = (over: Partial<AzureChangesResponse> = {}): AzureChangesResponse => ({ range: "7d", feed: feedFixture("activity"), rows: azChangeRows(), ...over });

export const issue = (over: Partial<ServiceEvent> = {}): ServiceEvent => ({
  trackingId: "TRK-1",
  type: "ServiceIssue",
  status: "Active",
  level: "Warning",
  title: "Virtual Machines: connectivity problems",
  summary: "Some VMs in UK South may fail to start.",
  services: ["Virtual Machines"],
  startsAt: ago(120),
  endsAt: null,
  updatedAt: ago(20),
  ...over,
});

/** Newest first as the API sends them after "active first": an active issue, a resolved one, a planned maintenance. */
export const healthEvents = (): ServiceEvent[] => [
  issue({ trackingId: "TRK-2", status: "Resolved", title: "Network Infrastructure: packet loss", summary: "Mitigated.", services: ["Network Infrastructure"], startsAt: ago(3000), endsAt: ago(2900), updatedAt: ago(2900) }),
  issue({ trackingId: "TRK-3", type: "PlannedMaintenance", status: "Resolved", level: null, title: "Planned: host update", summary: "A host update.", services: ["Virtual Machines"], startsAt: ago(6000), endsAt: ago(5900), updatedAt: ago(5900) }),
  issue(),
];

export const healthResponse = (events = healthEvents(), over: Partial<AzureServiceHealthResponse> = {}): AzureServiceHealthResponse => ({ events, feed: feedFixture("serviceHealth"), ...over });

export const azRoutes = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  "GET /api/v1/azure/changes": azChangesResponse(),
  "GET /api/v1/azure/service-health": healthResponse(),
  ...over,
});

/** Turn a default-off widget on, hiding the one it would replace in its full row, with these saved settings. */
export const turnedOn = (id: string, hide: string, settings: Record<string, SettingValue> = {}): PagePrefs => ({
  layout: { shown: [id], hidden: [hide] },
  ...(Object.keys(settings).length ? { widgets: { [id]: { v: widgetDef(id)!.version, s: settings } } } : {}),
});
