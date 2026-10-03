// The widget framework. Import from "@/widgets". See the "W0 names as built"
// section at the top of docs/superpowers/plans/2026-10-03-widgets-plan.md.
export { usePrefs, usePrefsStatus, usePagePrefs, type PrefsStatus } from "./usePrefs";
export { useWidget, type WidgetState } from "./useWidget";
export { SAVE_DELAY_MS, PREFS_MIRROR_KEY } from "./store";
export { thresholdTone } from "@shared/widgets";
