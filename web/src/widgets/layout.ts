// widgets/layout.ts
//
// Plain English: the arithmetic of rows, with no React in it. Which items
// of a row show, in the user's order, and the grid columns their weights
// make (a hidden widget's weight goes to the rest of the row); which widget
// can move left or right (only a row's direct items, within that row,
// stepping over hidden neighbours); and where a drop puts a dragged item.

import type { PagePrefs } from "@shared/api";
import { REGISTRY, itemKey, widgetDef, type LayoutRow, type PageId, type Registry } from "@shared/widgets";

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

/** Hidden (never a pinned widget). */
export function isHidden(prefs: PagePrefs, id: string, reg: Registry = REGISTRY): boolean {
  return !!prefs.layout?.hidden?.includes(id) && !widgetDef(id, reg)?.pinned;
}

/** A row's item keys in the user's order (the declared order unless a valid saved one exists). */
export function rowOrder(page: PageId, rowId: string, prefs: PagePrefs, reg: Registry = REGISTRY): string[] {
  const row = rowsOf(page, reg).find((r) => r.id === rowId);
  if (!row) return [];
  const keys = row.items.map(itemKey);
  const saved = prefs.layout?.order?.[rowId];
  return saved && saved.length === keys.length && keys.every((k) => saved.includes(k)) ? [...saved] : keys;
}

/** Every widget a row holds, in stacks and nested rows too. */
function widgetsIn(page: PageId, rowId: string, reg: Registry): string[] {
  const row = rowsOf(page, reg).find((r) => r.id === rowId);
  if (!row) return [];
  return row.items.flatMap((it) => ("widget" in it ? [it.widget] : it.widgets.flatMap((m) => (rowsOf(page, reg).some((r) => r.id === m) ? widgetsIn(page, m, reg) : [m]))));
}

export function rowView(page: PageId, rowId: string, prefs: PagePrefs, reg: Registry = REGISTRY): RowView {
  const rows = rowsOf(page, reg);
  const row = rows.find((r) => r.id === rowId);
  if (!row) return { id: rowId, items: [], template: "", isDefault: true, visible: false };
  const order = rowOrder(page, rowId, prefs, reg);
  const items: RowItemView[] = [];
  for (const key of order) {
    const it = row.items.find((i) => itemKey(i) === key)!;
    if ("widget" in it) {
      if (!isHidden(prefs, it.widget, reg)) items.push({ key, kind: "widget", weight: it.weight, members: [it.widget] });
      continue;
    }
    const members = it.widgets.filter((m) => (rows.some((r) => r.id === m) ? rowView(page, m, prefs, reg).visible : !isHidden(prefs, m, reg)));
    if (members.length) items.push({ key, kind: "stack", weight: it.weight, members });
  }
  const declared = row.items.map(itemKey);
  const isDefault = order.join("\n") === declared.join("\n") && widgetsIn(page, rowId, reg).every((id) => !isHidden(prefs, id, reg));
  return { id: rowId, items, template: items.map((i) => `minmax(0, ${i.weight}fr)`).join(" "), isDefault, visible: items.length > 0 };
}

export interface MoveState {
  /** The widget is a direct item of a row with two or more visible items: it has a handle and Move items. */
  movable: boolean;
  left: boolean;
  right: boolean;
  /** Its row (null when it is in no row's direct items). */
  row: string | null;
  /** Its place among the visible items (0-based) and how many there are. */
  index: number;
  count: number;
}

/** The row whose direct items include `key`, or null. */
function rowHolding(page: PageId, key: string, reg: Registry): LayoutRow | null {
  return rowsOf(page, reg).find((r) => r.items.some((i) => itemKey(i) === key)) ?? null;
}

export function canMoveIn(page: PageId, id: string, prefs: PagePrefs, reg: Registry = REGISTRY): MoveState {
  const row = rowHolding(page, id, reg);
  const none: MoveState = { movable: false, left: false, right: false, row: row?.id ?? null, index: 0, count: 0 };
  if (!row || isHidden(prefs, id, reg)) return none;
  const visible = rowView(page, row.id, prefs, reg).items.map((i) => i.key);
  const index = visible.indexOf(id);
  if (visible.length < 2 || index < 0) return { ...none, index: Math.max(index, 0), count: visible.length };
  return { movable: true, left: index > 0, right: index < visible.length - 1, row: row.id, index, count: visible.length };
}

/** `prefs` with the row's order set to `order` (left out when it is the declared one). */
function withOrder(page: PageId, prefs: PagePrefs, rowId: string, order: string[], reg: Registry): PagePrefs {
  const declared = rowsOf(page, reg).find((r) => r.id === rowId)!.items.map(itemKey);
  const all = { ...(prefs.layout?.order ?? {}) };
  if (order.join("\n") === declared.join("\n")) delete all[rowId];
  else all[rowId] = order;
  return { ...prefs, layout: { ...(prefs.layout ?? {}), order: all } };
}

/** The widget one visible place left or right (swapping with that neighbour), or null when it cannot move that way. */
export function moveWithin(page: PageId, prefs: PagePrefs, id: string, dir: "left" | "right", reg: Registry = REGISTRY): PagePrefs | null {
  const m = canMoveIn(page, id, prefs, reg);
  if (!m.movable || !m.row || !(dir === "left" ? m.left : m.right)) return null;
  const visible = rowView(page, m.row, prefs, reg).items.map((i) => i.key);
  const other = visible[m.index + (dir === "left" ? -1 : 1)]!;
  const order = rowOrder(page, m.row, prefs, reg);
  const a = order.indexOf(id);
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
export function dropKey(page: PageId, targetId: string, reg: Registry = REGISTRY): { row: string; key: string } | null {
  const direct = rowHolding(page, targetId, reg);
  if (direct) return { row: direct.id, key: targetId };
  for (const r of rowsOf(page, reg))
    for (const it of r.items) if (!("widget" in it) && it.widgets.includes(targetId)) return { row: r.id, key: it.stack };
  return null;
}

/** The dragged item moved to the place of the item dropped on (same row only), or null for no change. */
export function dropMove(page: PageId, prefs: PagePrefs, drag: DragItem, targetId: string, reg: Registry = REGISTRY): PagePrefs | null {
  const target = dropKey(page, targetId, reg);
  if (!target || target.row !== drag.row || target.key === drag.key) return null;
  const order = rowOrder(page, drag.row, prefs, reg);
  const from = order.indexOf(drag.key);
  const to = order.indexOf(target.key);
  if (from < 0 || to < 0) return null;
  order.splice(from, 1);
  order.splice(to, 0, drag.key);
  return withOrder(page, prefs, drag.row, order, reg);
}
