import { useEffect, useState } from "react";
import type { Tone } from "../cx";

/** CSS colour for a tone (SVG and HTML can use the variable directly). */
export function toneVar(tone: Tone): string {
  return tone === "grey" ? "var(--text-muted)" : `var(--${tone})`;
}

/** Resolves a tone to a concrete colour string (canvas drawing cannot use var()). */
export function resolveTone(el: Element, tone: Tone): string {
  const name = tone === "grey" ? "--text-muted" : `--${tone}`;
  return getComputedStyle(el).getPropertyValue(name).trim() || "#888888";
}

export function resolveVar(el: Element, name: string, fallback = "#888888"): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** "#3776fb" + 0.2 -> "#3776fb33". Other colour formats are returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color + Math.round(alpha * 255).toString(16).padStart(2, "0");
  }
  return color;
}

/** Bumps when the theme changes (data-theme attribute or the OS preference), so canvas charts can redraw. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((n) => n + 1);
    const obs = new MutationObserver(bump);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
    mq?.addEventListener?.("change", bump);
    return () => {
      obs.disconnect();
      mq?.removeEventListener?.("change", bump);
    };
  }, []);
  return v;
}

/** "no data"-safe number formatting for chart summaries. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "no data";
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return String(r);
}

/** Round "nice" axis maximum: 0.2, 0.5, 1, 2, 5, 10 ... */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / 10 ** exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}
