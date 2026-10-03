import { useEffect, useState } from "react";
import type { RunLogResponse } from "@shared/api";

/** A live log with nothing new for longer than this, while its run is still going, has stalled. */
export const LIVE_LOG_STALL_MS = 30_000;

export type StreamState = "Streaming" | "Stalled" | "Waiting" | "Finished";

/**
 * The word beside a run's log: "Streaming" while the run is going and the
 * log is the live copy, "Stalled" (amber) if that copy has had nothing new
 * for over 30 s, "Finished" once the run is over or the log is GitHub's, and
 * "Waiting" while the first answer is still on its way. Before the first
 * lines arrive (no updatedAt yet) it is "Streaming": the panel shows its
 * waiting note.
 */
export function streamState(running: boolean, data: RunLogResponse | undefined, now: number): StreamState {
  if (!running || data?.source === "github" || data?.active === false) return "Finished";
  if (data?.source !== "live") return "Waiting";
  const at = data.updatedAt ? Date.parse(data.updatedAt) : NaN;
  return Number.isFinite(at) && now - at > LIVE_LOG_STALL_MS ? "Stalled" : "Streaming";
}

/** The time now, ticking every `everyMs` while `on` (so "Streaming" can turn "Stalled" with no new answer). */
export function useNowWhile(on: boolean, everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [on, everyMs]);
  return now;
}
