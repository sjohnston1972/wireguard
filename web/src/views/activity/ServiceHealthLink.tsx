// views/activity/ServiceHealthLink.tsx
//
// Plain English: what the top bar's Service Health pill links to,
// /activity?widget=serviceHealth (insights spec 10.2). With the Azure service
// health widget on and drawn, the page scrolls to it and puts focus on it.
// With it off (or not drawn: a short desktop window has no bottom row), the
// active issue's details open in the same modal the widget uses, so the link
// never lands on a page that ignores it and never turns a widget on by itself.
// Either way the parameter is then taken out of the address.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAzureSummary } from "@/api/queries";
import { ServiceEventDrawer } from "./ServiceHealth";

const KEY = "widget";
const VALUE = "serviceHealth";
/** The widget's panel on the desktop page and its card on the phone. */
const TARGET = ".act__health, .act__health-card";

/** `drawn`: the Azure service health widget is on and on screen (desktop bottom row or phone card). Render once the page's data is in. */
export function ServiceHealthLink({ drawn }: { drawn: boolean }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get(KEY) === VALUE;
  const summary = useAzureSummary({ enabled: asked && !drawn });
  const [open, setOpen] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (!asked) {
      handled.current = false;
      return;
    }
    if (handled.current) return;
    if (drawn) {
      const el = document.querySelector<HTMLElement>(TARGET);
      if (!el) return; // not in the page yet: the next render tries again
      handled.current = true;
      el.scrollIntoView?.({ block: "nearest" });
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus({ preventScroll: true });
    } else {
      if (!summary.data && !summary.isError) return; // wait for the answer
      handled.current = true;
      const issue = (summary.data?.serviceIssues ?? []).find((e) => e.type === "ServiceIssue" && e.status === "Active");
      if (issue) setOpen(issue.trackingId);
    }
    const next = new URLSearchParams(params);
    next.delete(KEY);
    setParams(next, { replace: true });
  });

  const event = open ? (summary.data?.serviceIssues ?? []).find((e) => e.trackingId === open) : undefined;
  if (!event) return null;
  return <ServiceEventDrawer event={event} region={summary.data?.region.name ?? "your region"} onClose={() => setOpen(null)} />;
}
