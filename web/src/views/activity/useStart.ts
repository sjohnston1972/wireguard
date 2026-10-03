import { useState } from "react";

/**
 * State that starts at a widget setting ("starting tab", "starting event
 * type", "auto-scroll at start") and can then be changed in place. The
 * preferences may arrive after the first render, and the cog may change the
 * setting later: either way the state starts again from the new setting.
 */
export function useStart<T>(start: T): [T, (v: T) => void] {
  const [value, setValue] = useState(start);
  const [seen, setSeen] = useState(start);
  if (!Object.is(seen, start)) {
    setSeen(start);
    setValue(start);
  }
  return [value, setValue];
}
