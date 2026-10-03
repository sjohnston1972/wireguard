// The widget framework. Import from "@/widgets". See the "W0 names as built"
// section at the top of docs/superpowers/plans/2026-10-03-widgets-plan.md.
export { usePrefs, usePrefsStatus, usePagePrefs, type PrefsStatus } from "./usePrefs";
export { useWidget, type WidgetState } from "./useWidget";
export { Widget, WidgetCorner, WIDGET_DRAG_TYPE, type WidgetProps } from "./Widget";
export { WidgetCog, WidgetSettings } from "./WidgetCog";
export { SettingsForm, THRESHOLD_HINT, type SettingsFormProps } from "./SettingsForm";
export { WidgetRow, WidgetStack, useRowItems, type WidgetRowProps, type WidgetStackProps } from "./WidgetRow";
export { LayoutMenu } from "./LayoutMenu";
export type { RowView, RowItemView, MoveState } from "./layout";
export { SAVE_DELAY_MS, PREFS_MIRROR_KEY } from "./store";
export { thresholdTone } from "@shared/widgets";
