import { useCallback, useState } from "react";

/**
 * A control whose first value is a widget's "Starting ..." setting (spec
 * 2026-10-03 §3.8). It follows the setting (which may arrive after the page
 * when the preferences load late) until the user picks a value in the
 * panel; that choice lasts for the visit and is never saved.
 */
export function useStarting<T>(start: T): [T, (v: T) => void] {
  const [own, setOwn] = useState<{ v: T } | null>(null);
  const set = useCallback((v: T) => setOwn({ v }), []);
  return [own ? own.v : start, set];
}
