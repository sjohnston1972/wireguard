// views/activity/lazyAzure.tsx
//
// Plain English: the Activity page's Azure parts (the Azure change log and
// service health widgets, their phone cards, and the change and event
// modals), loaded only when drawn: they are off by default (see
// web/src/widgets/lazy.tsx). Import them from here, never from
// ./AzureChanges, ./ServiceHealth or ./PhoneAzure, so they stay out of the
// main bundle.

import { widgetDef } from "@shared/widgets";
import { lazyPart, lazyWidget } from "@/widgets";

export const AzureChangesPanel = lazyWidget(widgetDef("activity.azureChanges")!.title, () => import("./AzureChanges").then((m) => m.AzureChangesPanel));
export const ServiceHealthPanel = lazyWidget(widgetDef("activity.serviceHealth")!.title, () => import("./ServiceHealth").then((m) => m.ServiceHealthPanel));
export const PhoneAzure = lazyPart(() => import("./PhoneAzure").then((m) => m.PhoneAzure));
export const AzureChangeDrawer = lazyPart(() => import("./AzureChanges").then((m) => m.AzureChangeDrawer));
export const ServiceEventDrawer = lazyPart(() => import("./ServiceHealth").then((m) => m.ServiceEventDrawer));
/** What the Service Health pill links to (/activity?widget=serviceHealth); ActivityView mounts it only once the address asks. */
export const ServiceHealthLink = lazyPart(() => import("./ServiceHealthLink").then((m) => m.ServiceHealthLink));
