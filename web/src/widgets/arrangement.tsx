// widgets/arrangement.tsx
//
// Plain English: a view that draws a row differently for a while (Overview
// during a run: the run widget widens over traffic's slot and traffic joins
// the side stack) says so by wrapping that row in <WidgetArrangement>. The
// widgets inside then move what is drawn: a widget that sits in a stack for
// now has no handle of its own, and its cog moves its stack. The saved
// order is still an order of the declared row (see layout.ts).

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { REGISTRY, type LayoutItem, type PageId } from "@shared/widgets";
import type { Arranged } from "./layout";

const ArrangementContext = createContext<Arranged>(REGISTRY);

/** The registry with the rows drawn differently here. */
export function useArranged(): Arranged {
  return useContext(ArrangementContext);
}

export interface WidgetArrangementProps {
  page: PageId;
  /** Row id -> the items it is drawn with now: some of the declared row's keys; a stack may hold other members. */
  rows: Record<string, LayoutItem[]>;
  children: ReactNode;
}

export function WidgetArrangement({ page, rows, children }: WidgetArrangementProps) {
  const parent = useArranged();
  const key = JSON.stringify(rows);
  const value = useMemo<Arranged>(
    () => ({ ...parent, variants: { ...(parent.variants ?? {}), [page]: { ...(parent.variants?.[page] ?? {}), ...(JSON.parse(key) as Record<string, LayoutItem[]>) } } }),
    [parent, page, key],
  );
  return <ArrangementContext.Provider value={value}>{children}</ArrangementContext.Provider>;
}
