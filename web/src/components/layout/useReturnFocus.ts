import { useRef } from "react";

/**
 * Radix Dialog only restores focus to a Dialog.Trigger. Our drawers and modals
 * are controlled from anywhere (a table row, a palette action), so remember the
 * element that had focus when `open` turned true and put focus back on close.
 */
export function useReturnFocus(open: boolean) {
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  // Captured during render: child effects (Radix FocusScope) would already have moved focus.
  if (open && !wasOpen.current) {
    const el = typeof document !== "undefined" ? document.activeElement : null;
    target.current = el instanceof HTMLElement && el !== document.body ? el : null;
  }
  wasOpen.current = open;

  return {
    onCloseAutoFocus(event: Event) {
      const el = target.current;
      if (el && el.isConnected) {
        event.preventDefault();
        el.focus();
      }
    },
  };
}
