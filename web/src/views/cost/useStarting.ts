import { useState } from "react";

/**
 * A "starting" setting (spec section 3, ruling 8): the value a control has until
 * the visitor changes it in the panel. The visit's own choice is kept, but a
 * change of the setting itself (in the cog) takes over at once, so the page
 * follows what the cog says.
 */
export function useStarting<T>(start: T): [T, (value: T) => void] {
  const [state, setState] = useState<{ start: T; value: T }>({ start, value: start });
  if (!Object.is(state.start, start)) setState({ start, value: start });
  return [Object.is(state.start, start) ? state.value : start, (value) => setState({ start, value })];
}
