// The app's service worker (web/public/sw.js, served at /sw.js). Same URL and
// scope as the old dashboard registered, so an installed phone keeps its push
// subscription across the switch-over and the browser simply updates the file.

/** Registers /sw.js at scope "/". Never throws: the app works without it. */
export async function registerSw(nav: Navigator = navigator): Promise<void> {
  if (!("serviceWorker" in nav)) return;
  try {
    await nav.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    // Blocked (private window, settings): alerts show as unavailable in Settings.
  }
}
