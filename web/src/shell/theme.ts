// Theme: follows the OS unless the user picked one. The choice is kept in
// localStorage, which can be missing or throw (private window, blocked site
// data), so every access is wrapped and the app works without it.

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
}
