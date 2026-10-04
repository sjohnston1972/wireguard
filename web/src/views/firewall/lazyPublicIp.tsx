// views/firewall/lazyPublicIp.tsx
//
// Plain English: the Public IP and DDoS widget, loaded only when drawn (it is
// off by default; see web/src/widgets/lazy.tsx). Import it from here, never
// from ./PublicIp, so it stays out of the main bundle.

import { widgetDef } from "@shared/widgets";
import { lazyWidget } from "@/widgets";

export const PublicIp = lazyWidget(widgetDef("firewall.publicIp")!.title, () => import("./PublicIp").then((m) => m.PublicIp));
