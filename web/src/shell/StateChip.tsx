import * as Popover from "@radix-ui/react-popover";
import type { OverviewResponse } from "@shared/api";
import { useConnectionLevel, type ConnectionLevel } from "./Connection";
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

/** The chip's short on-screen label: "Azure • UK South" (the mockups' wording). */
export function chipLabel(o: OverviewResponse | undefined): string {
  const region = o ? regionLabel(o.snapshot.region ?? o.config?.region) : null;
  return region ? `Azure • ${region}` : "Azure";
}

export type DotTone = ChipTone | "stale" | "unknown";

const CONN_WORDS: Record<ConnectionLevel, string> = { connecting: "Connecting", live: "Live", stale: "Stale", disconnected: "Disconnected" };

/**
 * The top bar's state chip: a dot (green running, amber busy or stale, red
 * failed, grey idle, unknown or disconnected) and "Azure • UK South". The
 * whole sentence (state, countdown, connection) is its accessible name and
 * opens as details on click or Enter.
 */
export function StateChip() {
  const { data, isError } = useOverview();
  const level = useConnectionLevel();
  let view: ChipView | { text: string; tone: "unknown" };
  if (data) view = chipFor(data);
  else if (isError) view = { text: "State unknown", tone: "unknown" };
  else view = { text: "Checking state…", tone: "unknown" };
  const dot: DotTone = level === "disconnected" ? "unknown" : level === "stale" && view.tone !== "bad" ? "stale" : view.tone;
  const conn = CONN_WORDS[level];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="topbar__chip" data-tone={dot}>
          <span className="topbar__chip-dot" aria-hidden="true" />
          <span className="topbar__chip-text" aria-hidden="true">
            {chipLabel(data)}
          </span>
          <span className="visually-hidden">
            State: {view.text}. Connection: {conn}.
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="chip-pop" align="end" sideOffset={8} aria-label="Environment state">
          <dl className="chip-pop__list">
            <div>
              <dt>State</dt>
              <dd>{view.text}</dd>
            </div>
            <div>
              <dt>Connection</dt>
              <dd data-level={level}>{conn}</dd>
            </div>
          </dl>
          {level === "stale" && <p className="chip-pop__note">The last refresh failed or the VM has not reported for two minutes; values may be old.</p>}
          {level === "disconnected" && <p className="chip-pop__note">The dashboard cannot be reached; showing the last values.</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The read-only environment control for a page header (Overview, Clients,
 * Settings mockups): "Environment" over a green dot and "Production". One
 * environment exists, so it is a labelled group, not a selector.
 */
export function EnvironmentField() {
  return (
    <div className="env-field" role="group" aria-label="Environment">
      <span className="env-field__caption" aria-hidden="true">
        Environment
      </span>
      <span className="env-field__value">
        <span className="env-field__dot" aria-hidden="true" />
        Production
      </span>
    </div>
  );
}
