// views/overview/lazyLabs.tsx
//
// Plain English: the Running labs widget, loaded only when drawn (it is off by
// default; see web/src/widgets/lazy.tsx). Pages import it from here, never from
// ./LabsParts directly, so it stays out of the main bundle.

import { widgetDef } from "@shared/widgets";
import { lazyWidget } from "@/widgets";

export const RunningLabs = lazyWidget(widgetDef("overview.runningLabs")!.title, () => import("./LabsParts").then((m) => m.RunningLabs));
