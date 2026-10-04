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
    const done = () => {
      handled.current = true;
      const next = new URLSearchParams(params);
      next.delete(KEY);
      setParams(next, { replace: true });
    };
    if (drawn) {
      // The widget's code may still be loading (it is code-split): wait for its panel, for up to 10 s.
      const focus = (el: HTMLElement) => {
        el.scrollIntoView?.({ block: "nearest" });
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        el.focus({ preventScroll: true });
        done();
      };
      const now = document.querySelector<HTMLElement>(TARGET);
      if (now) return focus(now);
      const watch = new MutationObserver(() => {
        const el = document.querySelector<HTMLElement>(TARGET);
        if (el) {
          stop();
          focus(el);
        }
      });
      const timer = window.setTimeout(() => {
        stop();
        done();
      }, 10_000);
      const stop = () => {
        watch.disconnect();
        window.clearTimeout(timer);
      };
      watch.observe(document.body, { childList: true, subtree: true });
      return stop;
    }
    if (!summary.data && !summary.isError) return; // wait for the answer
    const issue = (summary.data?.serviceIssues ?? []).find((e) => e.type === "ServiceIssue" && e.status === "Active");
    if (issue) setOpen(issue.trackingId);
    done();
  }, [asked, drawn, summary.data, summary.isError, params, setParams]);

  const event = open ? (summary.data?.serviceIssues ?? []).find((e) => e.trackingId === open) : undefined;
  if (!event) return null;
  return <ServiceEventDrawer event={event} region={summary.data?.region.name ?? "your region"} onClose={() => setOpen(null)} />;
}
