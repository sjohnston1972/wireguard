// widgets/useStarting.ts
//
// Plain English: an in-panel control whose first value is a widget's
// "Starting ..." setting (spec §3.8): the starting tab, filter, range,
// interface and so on. A pick in the panel changes the view for the visit
// and is never saved. The setting may arrive after the page has drawn (the
// preferences load late), and may change later (the cog, or another
// device): either way the control starts again from the new setting.

import { useCallback, useState } from "react";

/** Two settings are the same when equal, or (objects rebuilt each render) equal as JSON. */
function same<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `[value, set]`: the setting until the panel picks something else, or the setting changes. */
export function useStarting<T>(start: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ start: T; value: T }>({ start, value: start });
  const current = same(state.start, start);
  // The setting changed: start again from it (a state update during render, as React allows for derived state).
  if (!current) setState({ start, value: start });
  const set = useCallback((value: T) => setState((s) => ({ start: s.start, value })), []);
  return [current ? state.value : start, set];
}
