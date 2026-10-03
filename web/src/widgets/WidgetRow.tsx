// widgets/WidgetRow.tsx
//
// Plain English: a page row of widgets in the user's order, minus the
// hidden ones. While nothing in the row has changed, the view's own CSS
// decides the columns; once something has, the columns come from the
// widgets' weights, so a hidden widget's width goes to the rest of the row
// and the row's height never changes. A row with nothing left is not drawn.

import { Fragment, type HTMLAttributes, type ReactNode } from "react";
import { LAYOUTS, itemKey, type PageId } from "@shared/widgets";
import { usePagePrefs } from "./usePrefs";
import { rowView, type RowView } from "./layout";

/** A row's visible items in the user's order, its grid columns, and whether it is as shipped. For views that keep their own markup. */
export function useRowItems(page: PageId, row: string): RowView {
  const { prefs } = usePagePrefs(page);
  return rowView(page, row, prefs);
}

export interface WidgetRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  page: PageId;
  /** The row's id in shared/widgets.ts LAYOUTS (r1, r2, ... or a nested row such as "bottom"). */
  row: string;
  /** What to draw for each item key: widget ids and stack ids. */
  children: Record<string, ReactNode>;
}

/** The row's <div>, its items in the user's order; gridTemplateColumns is set only once the row differs from the default. */
export function WidgetRow({ page, row, children, style, ...rest }: WidgetRowProps) {
  const v = useRowItems(page, row);
  if (!v.visible) return null;
  return (
    <div {...rest} style={v.isDefault ? style : { ...style, gridTemplateColumns: v.template }}>
      {v.items.map((i) => (
        <Fragment key={i.key}>{children[i.key]}</Fragment>
      ))}
    </div>
  );
}

export interface WidgetStackProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  page: PageId;
  /** The stack's id in its row (for example "side"). */
  stack: string;
  /** What to draw for each member: widget ids, or a nested row's id. */
  children: Record<string, ReactNode>;
}

/** A vertical stack: its visible members in their declared order; nothing at all when none is visible. */
export function WidgetStack({ page, stack, children, ...rest }: WidgetStackProps) {
  const { prefs } = usePagePrefs(page);
  const row = LAYOUTS[page].rows.find((r) => r.items.some((i) => itemKey(i) === stack));
  const members = row ? (rowView(page, row.id, prefs).items.find((i) => i.key === stack)?.members ?? []) : [];
  if (!members.length) return null;
  return (
    <div {...rest}>
      {members.map((m) => (
        <Fragment key={m}>{children[m]}</Fragment>
      ))}
    </div>
  );
}
