import type { OverviewResponse } from "@shared/api";
import { REGIONS } from "../../../worker/src/region";
import { useOverview } from "@/api/queries";
import { isBusyState } from "@/api/queries";
import "./status.css";

/** "UK South" from the Azure region code; the code itself when it is not one we know. */
export function regionLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const full = REGIONS[code];
  return full ? full.replace(/\s*\(.*\)\s*$/, "") : code;
}

/** "3h 12m", "45m", "1d 2h", "under a minute". */
export function formatRemaining(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export type ChipTone = "ok" | "busy" | "bad" | "idle";

export interface ChipView {
  text: string;
  tone: ChipTone;
}

const WORDS: Record<string, string> = {
  running: "Running",
  deploying: "Deploying",
  destroying: "Tearing down",
  hibernating: "Hibernating",
  standby: "Standby",
  resuming: "Resuming",
  failed: "Failed",
  destroyed: "Destroyed",
};

/** What the top-bar chip says for an /overview answer. No data gives no numbers. */
export function chipFor(o: OverviewResponse): ChipView {
  const state = o.snapshot.state;
  if (state === "destroyed") return { text: "Destroyed · £0", tone: "idle" };
  const parts = [WORDS[state] ?? state];
  const region = regionLabel(o.snapshot.region ?? o.config?.region);
  if (region) parts.push(region);
  if (state === "running" && o.snapshot.auto_destroy_at) {
    const left = Date.parse(o.snapshot.auto_destroy_at) - Date.parse(o.now);
    if (Number.isFinite(left)) parts.push(left > 0 ? `tears down in ${formatRemaining(left)}` : "tear-down due");
  }
  const tone: ChipTone = state === "running" ? "ok" : state === "failed" ? "bad" : isBusyState(state) ? "busy" : "idle";
  return { text: parts.join(" · "), tone };
}

/** The tone of the wordmark's light. */
export function useStateTone(): ChipTone | "unknown" {
  const { data } = useOverview();
  return data ? chipFor(data).tone : "unknown";
}

export function StateChip() {
  const { data, isError } = useOverview();
  let view: ChipView | { text: string; tone: "unknown" };
  if (data) view = chipFor(data);
  else if (isError) view = { text: "State unknown", tone: "unknown" };
  else view = { text: "Checking state…", tone: "unknown" };
  return (
    <div className="topbar__chip" data-tone={view.tone}>
      <span className="topbar__chip-dot" aria-hidden="true" />
      <span>{view.text}</span>
    </div>
  );
}

/** One environment exists, so this is a label, not a selector. */
export function EnvLabel() {
  return <span className="topbar__env">Production</span>;
}
