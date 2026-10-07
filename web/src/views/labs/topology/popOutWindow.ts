// views/labs/topology/popOutWindow.ts
//
// Plain English: a lab's diagram popped out into its own browser window
// (issue #93), to sit on a second screen beside the Azure portal. The window
// shows /labs/:id/diagram?popout=1, which the app draws without its
// navigation (shell/Chromeless.tsx). One window per lab, by name: a second
// Pop out brings the open one forward instead of opening (or reloading)
// another. A browser that blocks pop-ups gets a plain new-tab link instead
// (the caller shows it).

export const POPOUT_FEATURES = "popup,width=1400,height=900";
/** The pop-out's banner when the session it was showing ends: the planned design is drawn instead. */
export const LAB_ENDED_BANNER = "Lab ended — showing the planned design.";

/** The address the pop-out window shows. */
export const popOutUrl = (labId: string) => `/labs/${encodeURIComponent(labId)}/diagram?popout=1`;
/** The window's name: the browser reuses a window of this name. */
export const popOutName = (labId: string) => `wg-lab-diagram-${labId}`;

/** The windows this tab opened, by name, so a second Pop out focuses the one still open. */
const opened = new Map<string, Window>();

/**
 * Open (or bring forward) the lab's pop-out window. False when the browser
 * blocked the pop-up, so the caller can offer a new-tab link instead.
 */
export function openPopOut(labId: string): boolean {
  const name = popOutName(labId);
  const prior = opened.get(name);
  if (prior && !prior.closed) {
    prior.focus();
    return true;
  }
  const w = window.open(popOutUrl(labId), name, POPOUT_FEATURES);
  if (!w) return false;
  opened.set(name, w);
  w.focus?.();
  return true;
}

/** Forget the windows opened so far (tests). */
export function forgetPopOuts(): void {
  opened.clear();
}

/**
 * The pop-out's "Back to dashboard": bring forward the window that opened it.
 * False when there is none (it was closed, or the pop-out was opened by hand),
 * so the link opens the app in a new tab instead.
 */
export function focusOpener(): boolean {
  let o: Window | null = null;
  try {
    o = window.opener as Window | null;
    if (!o || o.closed) return false;
    o.focus();
    return true;
  } catch {
    return false; // another origin's window: leave it alone
  }
}
