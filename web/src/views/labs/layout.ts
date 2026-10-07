// views/labs/layout.ts
//
// Plain English: which of the catalogue's three layouts the window is wide
// enough for (labs redesign spec §9, ruling 9). Wide (1200 px and up): the
// grid with an inline sticky details panel. Tablet (641-1199 px): the grid,
// details in a right-hand drawer. Phone (640 px and below): one column,
// details as a full-width view. One hook decides, so every part agrees.

import { useSyncExternalStore } from "react";
import { useIsPhone } from "@/components";

export type LabsLayout = "wide" | "tablet" | "phone";

export const WIDE_QUERY = "(min-width: 1200px)";

function subscribeWide(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}
const isWide = () => (typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY).matches : true);

/** "wide" | "tablet" | "phone" from the window's width; "wide" on the server. */
export function useLabsLayout(): LabsLayout {
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const phone = useIsPhone();
  return phone ? "phone" : wide ? "wide" : "tablet";
}
