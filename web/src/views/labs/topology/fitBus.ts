// views/labs/topology/fitBus.ts
//
// Plain English: the toolbar's search box asks the canvas to fit the view to
// the search's matches when Enter is pressed (lab topology spec §9.2). The
// two sit side by side in a placement and share only CanvasProps and
// ToolbarProps, so the request goes through this small in-chunk signal.

import { useEffect } from "react";

const bus = new EventTarget();

/** Ask every diagram on screen to fit its view to its search matches (all nodes when there is no search). */
export function requestFit(): void {
  bus.dispatchEvent(new Event("fit"));
}

/** Calls `onFit` on each request while mounted. */
export function useFitRequests(onFit: () => void): void {
  useEffect(() => {
    const h = () => onFit();
    bus.addEventListener("fit", h);
    return () => bus.removeEventListener("fit", h);
  }, [onFit]);
}
