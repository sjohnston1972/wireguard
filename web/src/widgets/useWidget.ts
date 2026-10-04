// widgets/useWidget.ts
//
// Plain English: one widget's settings and controls. `settings` is the
// widget's defaults with the saved values on top, so a view reads
// `settings.rows` and never meets a missing or invalid value. A change
// applies at once and is saved in the background.

import { useMemo } from "react";
import type { PagePrefs, SettingValue } from "@shared/api";
import { settingProblem, widgetDef, widgetDefaults, type WidgetDef } from "@shared/widgets";
import { usePagePart, usePrefsStore, type PrefsStatus } from "./usePrefs";
import { canMoveIn, disableIn, enableIn, isOff, moveWithin, replaceIn, type EnableResult, type MoveState } from "./layout";
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
  /** Not drawn: hidden, or a default-off widget that is not turned on. */
  hidden: boolean;
  /** Hide the widget (never a pinned one); the same as disable(). */
  hide: () => void;
  /** Bring it back: enable(), with the answer ignored (nothing changes when its row is full). */
  show: () => void;
  /**
   * Turn it on in its home row or stack at its declared place and save
   * (layout.shown for a default-off widget, else off the hidden list).
   * A full home changes nothing and answers the Replace candidates and the
   * suggestion; read-only answers { ok: false, full: false }.
   */
  enable: () => EnableResult;
  /** Turn it off (out of shown, or onto hidden). Never a pinned widget. */
  disable: () => void;
  /** Turn it on in place of `oldId`, one of enable()'s candidates, in one save. False (nothing changes) for anything else. */
  replace: (oldId: string) => boolean;
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

export function useWidget(id: string): WidgetState {
  const def = widgetDef(id);
  if (!def) throw new Error(`No widget ${id} (see shared/widgets.ts)`);
  // Only this widget's saved values and the page layout are read, each the
  // same object while unchanged, so another widget's change does not
  // re-render this one.
  const { value: saved, status } = usePagePart(def.page, (p) => p.widgets?.[id]?.s);
  const { value: layout } = usePagePart(def.page, (p) => p.layout);
  const prefs = useMemo<PagePrefs>(() => (layout ? { layout } : {}), [layout]);
  const store = usePrefsStore();
  const readOnly = status !== "ready";
  const settings = useMemo(() => ({ ...widgetDefaults(id), ...(saved ?? {}) }), [id, saved]);
  const hidden = isOff(prefs, id);
  const reg = useArranged();
  const canMove = useMemo(() => canMoveIn(def.page, id, prefs, reg), [def.page, id, prefs, reg]);

  const enable = (): EnableResult => {
    if (readOnly) return { ok: false, full: false };
    const r = enableIn(def.page, prefs, id);
    if ("full" in r) return { ok: false, full: true, candidates: r.candidates, suggestion: r.suggestion };
    store.change(def.page, (p) => {
      const x = enableIn(def.page, p, id);
      return "prefs" in x ? x.prefs : p;
    });
    return { ok: true };
  };
  const disable = () => {
    if (readOnly || def.pinned) return;
    store.change(def.page, (p) => disableIn(p, id));
  };

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
    hide: disable,
    show: () => void enable(),
    enable,
    disable,
    replace: (oldId) => {
      if (readOnly || !replaceIn(def.page, prefs, id, oldId)) return false;
      store.change(def.page, (p) => replaceIn(def.page, p, id, oldId) ?? p);
      return true;
    },
  };
}
