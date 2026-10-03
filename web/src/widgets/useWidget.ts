// widgets/useWidget.ts
//
// Plain English: one widget's settings and controls. `settings` is the
// widget's defaults with the saved values on top, so a view reads
// `settings.rows` and never meets a missing or invalid value. A change
// applies at once and is saved in the background.

import { useMemo } from "react";
import type { PagePrefs, SettingValue } from "@shared/api";
import { settingProblem, widgetDef, widgetDefaults, type WidgetDef } from "@shared/widgets";
import { usePagePrefs, usePrefsStore, type PrefsStatus } from "./usePrefs";
import { canMoveIn, moveWithin, type MoveState } from "./layout";
import { useArranged } from "./arrangement";

export interface WidgetState {
  def: WidgetDef;
  /** Every setting: the default, or the saved value. */
  settings: Record<string, SettingValue>;
  /** Change one setting. Refused (false, nothing changes) when the value is invalid or the preferences are read-only. */
  set: (key: string, value: SettingValue) => boolean;
  /** Back to every default (Reset to default). */
  reset: () => void;
  /** Something differs from the defaults (Reset to default is enabled). */
  differs: boolean;
  hidden: boolean;
  /** Hide the widget (never a pinned one). */
  hide: () => void;
  show: () => void;
  /** Preferences not read (loading or failed): show the values, change nothing. */
  readOnly: boolean;
  status: PrefsStatus;
  /**
   * Where it can move (desktop order only): `movable` when it is a direct item
   * of a row with two or more visible items, or a member of a stack that is
   * (then `item` is the stack, which moves as one); `left`/`right` at the
   * ends are false. Rows a view draws differently for now (WidgetArrangement)
   * count as drawn.
   */
  canMove: MoveState;
  /** It (or its stack) one visible place left or right within its row; false when it cannot. */
  move: (dir: "left" | "right") => boolean;
}

/** Apply `fn` to one widget's saved values, keeping the entry sparse. */
function withValues(p: PagePrefs, def: WidgetDef, fn: (s: Record<string, SettingValue>) => void): PagePrefs {
  const s = { ...(p.widgets?.[def.id]?.s ?? {}) };
  fn(s);
  const widgets = { ...(p.widgets ?? {}) };
  if (Object.keys(s).length) widgets[def.id] = { v: def.version, s };
  else delete widgets[def.id];
  return { ...p, widgets };
}

function withHidden(p: PagePrefs, id: string, hide: boolean): PagePrefs {
  const cur = p.layout?.hidden ?? [];
  const hidden = hide ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id);
  return { ...p, layout: { ...(p.layout ?? {}), hidden } };
}

export function useWidget(id: string): WidgetState {
  const def = widgetDef(id);
  if (!def) throw new Error(`No widget ${id} (see shared/widgets.ts)`);
  const { prefs, status } = usePagePrefs(def.page);
  const store = usePrefsStore();
  const readOnly = status !== "ready";
  const saved = prefs.widgets?.[id]?.s;
  const settings = useMemo(() => ({ ...widgetDefaults(id), ...(saved ?? {}) }), [id, saved]);
  const hidden = !def.pinned && !!prefs.layout?.hidden?.includes(id);
  const reg = useArranged();
  const canMove = useMemo(() => canMoveIn(def.page, id, prefs, reg), [def.page, id, prefs, reg]);

  return {
    canMove,
    move: (dir) => {
      if (readOnly) return false;
      if (!moveWithin(def.page, prefs, id, dir, reg)) return false;
      store.change(def.page, (p) => moveWithin(def.page, p, id, dir, reg) ?? p);
      return true;
    },
    def,
    settings,
    differs: !!saved && Object.keys(saved).length > 0,
    hidden,
    readOnly,
    status,
    set: (key, value) => {
      const spec = def.settings.find((s) => s.key === key);
      if (readOnly || !spec || settingProblem(spec, value)) return false;
      store.change(def.page, (p) => withValues(p, def, (s) => void (s[key] = value)));
      return true;
    },
    reset: () => {
      if (readOnly) return;
      store.change(def.page, (p) => withValues(p, def, (s) => Object.keys(s).forEach((k) => delete s[k])));
    },
    hide: () => {
      if (readOnly || def.pinned) return;
      store.change(def.page, (p) => withHidden(p, id, true));
    },
    show: () => {
      if (readOnly) return;
      store.change(def.page, (p) => withHidden(p, id, false));
    },
  };
}
