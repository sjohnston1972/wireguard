// views/overview/labs.ts
//
// Plain English: the small words and sums the Overview (and the command
// palette) use about running labs. No React, so it adds almost nothing to the
// main bundle.

import type { LabPeering, LabSession, LabsSummary } from "@shared/api";
import { formatSpan, gbp } from "./model";

/** "waiting to peer", never just a colour. */
export const PEERING_WORD: Record<LabPeering, string> = { on: "peered", waiting: "waiting to peer", off: "not peered", disconnected: "disconnected" };

/** "£0.12/h": two places, but a real price under a penny is not shown as £0.00. */
export function gbpHour(v: number): string {
  return v > 0 && v < 0.005 ? "under £0.01/h" : `${gbp(v)}/h`;
}

/** "2 labs running (£0.12/h)" for the banner; null with none. */
export function labsBannerText(l: LabsSummary): string | null {
  const n = l.running.length;
  return n ? `${n} ${n === 1 ? "lab" : "labs"} running (${gbpHour(l.gbpH)})` : null;
}

/** Time to the auto-destroy, "1h 15m left"; "ending now" when due; null with no timer (still deploying). */
export function labTimeLeft(s: LabSession, now: number): string | null {
  if (!s.autoDestroyAt) return null;
  const ms = Date.parse(s.autoDestroyAt) - now;
  return ms > 0 ? `${formatSpan(ms)} left` : "ending now";
}

/** The state word of a live session. */
export const LAB_STATE_WORD: Record<LabSession["state"], string> = {
  deploying: "Deploying",
  running: "Running",
  failed: "Failed",
  tearing_down: "Tearing down",
  ended: "Ended",
  ended_dirty: "Ended, left things behind",
};
