// Plain English: small helpers the Overview's widgets share for their
// settings (shared/widgets.ts, "overview.*"). A threshold colours this
// dashboard only, and always comes with a word. ("Starting" settings use
// useStarting from @/widgets.)

import type { SettingValue } from "@shared/api";
import { thresholdTone, type Threshold } from "@shared/widgets";

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
