// Theme: follows the OS unless the user picked one. The choice is kept in
// localStorage, which can be missing or throw (private window, blocked site
// data), so every access is wrapped and the app works without it.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark";
const KEY = "wg-admin-theme";

export function storedTheme(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** The theme actually showing: the user's choice, else the OS setting. */
export function currentTheme(): ThemeChoice {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen === "light" || chosen === "dark") return chosen;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyStoredTheme(): void {
  const t = storedTheme();
  if (t) document.documentElement.setAttribute("data-theme", t);
}

export function setTheme(t: ThemeChoice): void {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* not stored; still applied for this visit */
  }
  notify();
}

// ── One shared store: every control that shows or switches the theme reads it ──

const listeners = new Set<() => void>();
function notify() {
  listeners.forEach((l) => l());
}

/** Subscribe to the showing theme: setTheme, any change to data-theme, or the OS setting. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  const obs = typeof MutationObserver !== "undefined" ? new MutationObserver(listener) : null;
  obs?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
  mq?.addEventListener?.("change", listener);
  return () => {
    listeners.delete(listener);
    obs?.disconnect();
    mq?.removeEventListener?.("change", listener);
  };
}

/** The theme showing now, kept in step across the top-bar toggle, the account menu and anything else. */
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "dark");
}
