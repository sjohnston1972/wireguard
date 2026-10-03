// Plain English: small helpers the Overview's widgets share for their
// settings (shared/widgets.ts, "overview.*"). A "starting" setting is only
// where an in-panel control begins; a threshold colours this dashboard
// only, and always comes with a word.

import { useState } from "react";
import type { SettingValue } from "@shared/api";
import { thresholdTone, type Threshold } from "@shared/widgets";

/**
 * An in-panel control that starts at a saved setting (spec §3.8): the
 * control changes the view for the visit without saving; when the setting
 * itself changes (the cog, or another device), the control follows it.
 */
export function useStarting<T extends string>(setting: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(setting);
  const [from, setFrom] = useState<T>(setting);
  if (from !== setting) {
    setFrom(setting);
    setValue(setting);
  }
  return [value, setValue];
}

export type Level = "ok" | "warn" | "bad" | null;
export type LevelTone = "green" | "amber" | "red" | "grey";

/** A value against a threshold setting: ok, warn, bad, or null (no data). */
export function levelOf(value: number | null | undefined, t: SettingValue, direction: "above" | "below"): Level {
  return thresholdTone(value, t as Threshold, direction);
}

export const LEVEL_TONE: Record<"ok" | "warn" | "bad", LevelTone> = { ok: "green", warn: "amber", bad: "red" };

/** The word that goes with a threshold's colour, so colour is never the only sign. */
export function levelWord(level: Level, direction: "above" | "below"): string | null {
  if (level === "warn") return direction === "above" ? "High" : "Low";
  if (level === "bad") return direction === "above" ? "Very high" : "Very low";
  return null;
}

/** Whether a threshold has either level set. */
export function thresholdOn(t: SettingValue): boolean {
  const v = t as Threshold;
  return v.warn !== null || v.bad !== null;
}
