// views/cost/lazyLabs.tsx
//
// Plain English: the Labs panel, loaded only when drawn (it is off by default;
// see web/src/widgets/lazy.tsx). The page imports it from here, never from
// ./LabsPanel directly, so it stays out of the main bundle.

import { widgetDef } from "@shared/widgets";
import { lazyWidget } from "@/widgets";

export const LabsPanel = lazyWidget(widgetDef("cost.labs")!.title, () => import("./LabsPanel").then((m) => m.LabsPanel));
