// widgets/layout.ts
//
// Plain English: the arithmetic of rows, with no React in it. Which items
// of a row show, in the user's order, and the grid columns their weights
// make (a hidden widget's weight goes to the rest of the row); which widget
// can move left or right (only a row's direct items, within that row,
// stepping over hidden neighbours: a stack moves as one, by its members);
// and where a drop puts a dragged item.
//
// A view may draw a row differently for a while (Overview during a run: the
// run widget widens over traffic's slot and traffic joins the side stack).
// That is a variant: other items for the row, whose keys are some of the
// declared row's keys, and whose stacks may hold other members. Moves then
// act on what is drawn, and the saved order stays a permutation of the
// declared row, so nothing saved depends on the variant.

import type { PagePrefs } from "@shared/api";
import { REGISTRY, isVisible, itemKey, overfullHome, rowCapacity, widgetDef, widgetHome, type LayoutItem, type LayoutRow, type PageId, type Registry } from "@shared/widgets";

/** A registry with some rows drawn differently for now (see `WidgetArrangement`). */
export type Arranged = Registry & { variants?: Partial<Record<PageId, Record<string, LayoutItem[]>>> };

export interface RowItemView {
  /** The widget id, or the stack id. */
  key: string;
  kind: "widget" | "stack";
  weight: number;
  /** A stack's visible members in order (widget ids, or a nested row's id); a widget's own id. */
  members: string[];
}

export interface RowView {
  id: string;
  /** Visible items in the user's order. */
  items: RowItemView[];
  /** grid-template-columns from the visible items' weights, e.g. "minmax(0, 41fr) minmax(0, 45fr)". */
  template: string;
  /** Nothing in this row is hidden or moved: a view may keep its own CSS for it. */
  isDefault: boolean;
  /** False when nothing in the row is visible: do not render the row at all. */
  visible: boolean;
}

function rowsOf(page: PageId, reg: Registry): LayoutRow[] {
  return reg.layouts[page]?.rows ?? [];
}

/** The items a row is drawn with now: its variant's, or the declared ones. */
function itemsOf(page: PageId, row: LayoutRow, reg: Arranged): LayoutItem[] {
  return reg.variants?.[page]?.[row.id] ?? row.items;
}

/**
 * Hidden by the person (layout.hidden): never a pinned or a default-off
 * widget. The Layout menu's "Show hidden widgets" lists these. Not the same
 * as not drawn: a default-off widget that is not shown is off without being
 * hidden (see isOff).
 */
export function isHidden(prefs: PagePrefs, id: string, reg: Registry = REGISTRY): boolean {
  const d = widgetDef(id, reg);
  return !!prefs.layout?.hidden?.includes(id) && !d?.pinned && !d?.defaultOff;
}

/** Not drawn: hidden, or default-off and not in layout.shown (shared isVisible). */
export function isOff(prefs: PagePrefs, id: string, reg: Registry = REGISTRY): boolean {
  const d = widgetDef(id, reg);
  return d ? !isVisible(prefs, d) : !!prefs.layout?.hidden?.includes(id);
}

/** A row's declared item keys in the user's order (the declared order unless a valid saved one exists). */
function fullOrder(page: PageId, rowId: string, prefs: PagePrefs, reg: Registry): string[] {
  const row = rowsOf(page, reg).find((r) => r.id === rowId);
  if (!row) return [];
  const keys = row.items.map(itemKey);
  const saved = prefs.layout?.order?.[rowId];
  return saved && saved.length === keys.length && keys.every((k) => saved.includes(k)) ? [...saved] : keys;
}

/** A row's item keys as drawn now, in the user's order. */
export function rowOrder(page: PageId, rowId: string, prefs: PagePrefs, reg: Arranged = REGISTRY): string[] {
  const row = rowsOf(page, reg).find((r) => r.id === rowId);
  if (!row) return [];
  const drawn = itemsOf(page, row, reg).map(itemKey);
  return fullOrder(page, rowId, prefs, reg).filter((k) => drawn.includes(k));
}

/** Every widget a row holds as drawn now, in stacks and nested rows too. */
function widgetsIn(page: PageId, rowId: string, reg: Arranged): string[] {
  const row = rowsOf(page, reg).find((r) => r.id === rowId);
  if (!row) return [];
  return itemsOf(page, row, reg).flatMap((it) => ("widget" in it ? [it.widget] : it.widgets.flatMap((m) => (rowsOf(page, reg).some((r) => r.id === m) ? widgetsIn(page, m, reg) : [m]))));
}

export function rowView(page: PageId, rowId: string, prefs: PagePrefs, reg: Arranged = REGISTRY): RowView {
  const rows = rowsOf(page, reg);
  const row = rows.find((r) => r.id === rowId);
  if (!row) return { id: rowId, items: [], template: "", isDefault: true, visible: false };
  const drawn = itemsOf(page, row, reg);
  const order = rowOrder(page, rowId, prefs, reg);
  const items: RowItemView[] = [];
  for (const key of order) {
    const it = drawn.find((i) => itemKey(i) === key)!;
    if ("widget" in it) {
      if (!isOff(prefs, it.widget, reg)) items.push({ key, kind: "widget", weight: it.weight, members: [it.widget] });
      continue;
    }
    const members = it.widgets.filter((m) => (rows.some((r) => r.id === m) ? rowView(page, m, prefs, reg).visible : !isOff(prefs, m, reg)));
    if (members.length) items.push({ key, kind: "stack", weight: it.weight, members });
  }
  const declared = drawn.map(itemKey);
  // As shipped: the declared order, and every widget on or off as it ships (a default-off widget left off is as shipped).
  const isDefault = order.join("\n") === declared.join("\n") && widgetsIn(page, rowId, reg).every((id) => isOff(prefs, id, reg) === isOff({}, id, reg));
  return { id: rowId, items, template: items.map((i) => `minmax(0, ${i.weight}fr)`).join(" "), isDefault, visible: items.length > 0 };
}

/** A stack's visible members in order (as drawn now), or none. */
export function stackMembers(page: PageId, stack: string, prefs: PagePrefs, reg: Arranged = REGISTRY): string[] {
  const row = rowHolding(page, stack, reg);
  return row ? (rowView(page, row.id, prefs, reg).items.find((i) => i.key === stack)?.members ?? []) : [];
}

export interface MoveState {
  /**
   * It can move: it is a direct item of a row with two or more visible
   * items, or a member of a stack that is (then the whole stack moves).
   */
  movable: boolean;
  left: boolean;
  right: boolean;
  /** Its row (null when it is in no row's direct items or stacks). */
  row: string | null;
  /** The place among the row's visible items (0-based) of what moves, and how many there are. */
  index: number;
  count: number;
  /** What moves: the widget's own id, or its stack's id. */
  item: string | null;
  /** It carries the move handle: a widget that moves itself always; for a stack, only its first visible widget. */
  handle: boolean;
}

/** The row whose items as drawn now include `key` directly, or null. */
function rowHolding(page: PageId, key: string, reg: Arranged): LayoutRow | null {
  return rowsOf(page, reg).find((r) => itemsOf(page, r, reg).some((i) => itemKey(i) === key)) ?? null;
}

/** The row, and the stack among its items as drawn now, holding widget `id` as a member; or null. */
function stackHolding(page: PageId, id: string, reg: Arranged): { row: LayoutRow; stack: string } | null {
  for (const row of rowsOf(page, reg))
    for (const it of itemsOf(page, row, reg)) if (!("widget" in it) && it.widgets.includes(id)) return { row, stack: it.stack };
  return null;
}

export function canMoveIn(page: PageId, id: string, prefs: PagePrefs, reg: Arranged = REGISTRY): MoveState {
  const direct = rowHolding(page, id, reg);
  const held = direct ? null : stackHolding(page, id, reg);
  const row = direct ?? held?.row ?? null;
  const item = direct ? id : (held?.stack ?? null);
  const none: MoveState = { movable: false, left: false, right: false, row: row?.id ?? null, index: 0, count: 0, item, handle: false };
  if (!row || !item || isOff(prefs, id, reg)) return none;
  const view = rowView(page, row.id, prefs, reg);
  const visible = view.items.map((i) => i.key);
  const index = visible.indexOf(item);
  if (visible.length < 2 || index < 0) return { ...none, index: Math.max(index, 0), count: visible.length };
  // A stack's handle sits on its first visible member that is a widget (not a nested row).
  const lead = held ? view.items[index]!.members.find((m) => !rowsOf(page, reg).some((r) => r.id === m)) : id;
  return { movable: true, left: index > 0, right: index < visible.length - 1, row: row.id, index, count: visible.length, item, handle: lead === id };
}

/** `prefs` with the row's order set to `order` (left out when it is the declared one). */
function withOrder(page: PageId, prefs: PagePrefs, rowId: string, order: string[], reg: Registry): PagePrefs {
  const declared = rowsOf(page, reg).find((r) => r.id === rowId)!.items.map(itemKey);
  const all = { ...(prefs.layout?.order ?? {}) };
  if (order.join("\n") === declared.join("\n")) delete all[rowId];
  else all[rowId] = order;
  return { ...prefs, layout: { ...(prefs.layout ?? {}), order: all } };
}

/** What widget `id` moves (itself, or its stack) one visible place left or right, swapping with that neighbour; null when it cannot move that way. */
export function moveWithin(page: PageId, prefs: PagePrefs, id: string, dir: "left" | "right", reg: Arranged = REGISTRY): PagePrefs | null {
  const m = canMoveIn(page, id, prefs, reg);
  if (!m.movable || !m.row || !m.item || !(dir === "left" ? m.left : m.right)) return null;
  const visible = rowView(page, m.row, prefs, reg).items.map((i) => i.key);
  const other = visible[m.index + (dir === "left" ? -1 : 1)]!;
  const order = fullOrder(page, m.row, prefs, reg);
  const a = order.indexOf(m.item);
  const b = order.indexOf(other);
  [order[a], order[b]] = [order[b]!, order[a]!];
  return withOrder(page, prefs, m.row, order, reg);
}

/** What a drag carries: the row it came from and the item's key. */
export interface DragItem {
  row: string;
  key: string;
}

/** The row item a drop onto widget `targetId` lands on: the widget, or the stack holding it. */
export function dropKey(page: PageId, targetId: string, reg: Arranged = REGISTRY): { row: string; key: string } | null {
  const direct = rowHolding(page, targetId, reg);
  if (direct) return { row: direct.id, key: targetId };
  const held = stackHolding(page, targetId, reg);
  return held ? { row: held.row.id, key: held.stack } : null;
}

/** The dragged item moved to the place of the item dropped on (same row only), or null for no change. */
export function dropMove(page: PageId, prefs: PagePrefs, drag: DragItem, targetId: string, reg: Arranged = REGISTRY): PagePrefs | null {
  const target = dropKey(page, targetId, reg);
  if (!target || target.row !== drag.row || target.key === drag.key) return null;
  const order = fullOrder(page, drag.row, prefs, reg);
  const from = order.indexOf(drag.key);
  const to = order.indexOf(target.key);
  if (from < 0 || to < 0) return null;
  order.splice(from, 1);
  order.splice(to, 0, drag.key);
  return withOrder(page, prefs, drag.row, order, reg);
}

// ── Turning widgets on and off (insights spec 9.2, 9.3) ───────────────────

/** What enable() answers: on; or its home row (or stack) is full, with what Replace may offer; or nothing may change (read-only). */
export type EnableResult = { ok: true } | { ok: false; full: true; candidates: string[]; suggestion: string | null } | { ok: false; full: false };

/** `prefs` with widget `id` on: off the hidden list, or (default-off) onto the end of shown. No capacity check. */
function withOn(prefs: PagePrefs, id: string, reg: Registry): PagePrefs {
  const d = widgetDef(id, reg);
  const layout = { ...(prefs.layout ?? {}) };
  if (d?.defaultOff) layout.shown = [...(layout.shown ?? []).filter((x) => x !== id), id];
  else layout.hidden = (layout.hidden ?? []).filter((x) => x !== id);
  return { ...prefs, layout };
}

/** `prefs` with widget `id` off: out of shown (default-off), or onto the hidden list. A pinned widget stays on. */
export function disableIn(prefs: PagePrefs, id: string, reg: Registry = REGISTRY): PagePrefs {
  const d = widgetDef(id, reg);
  if (!d || d.pinned) return prefs;
  const layout = { ...(prefs.layout ?? {}) };
  if (d.defaultOff) layout.shown = (layout.shown ?? []).filter((x) => x !== id);
  else layout.hidden = [...(layout.hidden ?? []).filter((x) => x !== id), id];
  return { ...prefs, layout };
}

/**
 * Widget `id` turned on in its home row or stack, at its declared place (a
 * saved order already holds every declared item), or the reason it cannot:
 * the home is full, with Replace's candidates and suggestion.
 */
export function enableIn(page: PageId, prefs: PagePrefs, id: string, reg: Registry = REGISTRY): { prefs: PagePrefs } | { full: true; candidates: string[]; suggestion: string | null } {
  const d = widgetDef(id, reg);
  if (!d || isVisible(prefs, d)) return { prefs };
  const next = withOn(prefs, id, reg);
  if (!overfullHome(page, next, reg)) return { prefs: next };
  const home = widgetHome(id, reg);
  const c = home ? rowCapacity(page, home.home, prefs, id, reg) : null;
  return { full: true, candidates: c?.candidates ?? [], suggestion: c?.suggestion ?? null };
}

/**
 * Widget `id` on in place of `oldId` (one of its home's Replace candidates),
 * as one change: `oldId` off, `id` on and, in a row, `id` moved to the place
 * `oldId` (or the stack holding it) had, so the row keeps its geometry.
 * Null when `oldId` is not a candidate or the result would not fit.
 */
export function replaceIn(page: PageId, prefs: PagePrefs, id: string, oldId: string, reg: Registry = REGISTRY): PagePrefs | null {
  const home = widgetHome(id, reg);
  if (!home || home.page !== page) return null;
  if (!rowCapacity(page, home.home, prefs, id, reg).candidates.includes(oldId)) return null;
  let next = disableIn(withOn(prefs, id, reg), oldId, reg);
  if (home.stack === null) {
    const oldKey = dropKey(page, oldId, reg)?.key;
    const order = fullOrder(page, home.row, prefs, reg);
    const a = order.indexOf(id);
    const b = oldKey ? order.indexOf(oldKey) : -1;
    if (a >= 0 && b >= 0) {
      [order[a], order[b]] = [order[b]!, order[a]!];
      next = withOrder(page, next, home.row, order, reg);
    }
  }
  return overfullHome(page, next, reg) ? null : next;
}
