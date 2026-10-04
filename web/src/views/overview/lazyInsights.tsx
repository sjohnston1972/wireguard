// views/overview/lazyInsights.tsx
//
// Plain English: the Overview's Azure insights widgets and the boot log
// modal, loaded only when drawn (they are off by default; see
// web/src/widgets/lazy.tsx). Pages import them from here, never from
// ./Insights or ./BootLog directly, so those stay out of the main bundle.

import { useRef } from "react";
import { widgetDef } from "@shared/widgets";
import { lazyPart, lazyWidget } from "@/widgets";

const title = (id: string) => widgetDef(id)!.title;

export const VmPerformance = lazyWidget(title("overview.vmPerformance"), () => import("./Insights").then((m) => m.VmPerformance));
export const AzureHealth = lazyWidget(title("overview.azureHealth"), () => import("./Insights").then((m) => m.AzureHealth));
export const Vitals = lazyWidget(title("overview.vitals"), () => import("./Insights").then((m) => m.Vitals));

const LazyBootLog = lazyPart(() => import("./BootLog").then((m) => m.BootLogModal));

/** The boot log modal: its code is fetched the first time it opens, and it stays mounted after that (so it can close smoothly). */
export function BootLogModal(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const opened = useRef(false);
  if (props.open) opened.current = true;
  return opened.current ? <LazyBootLog {...props} /> : null;
}
