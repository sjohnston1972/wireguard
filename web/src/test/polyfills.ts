import { mediaList } from "./media";

// jsdom lacks a few browser APIs that Radix (Select, Toast, menus), cmdk and the
// charts touch. Loaded once for every web test by setup.ts; test files do not
// stub these themselves.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};

// matchMedia: every test is a 1600 x 900 dark desktop unless it calls
// setViewport (test/viewport.ts). uPlot reads it as it loads, so without
// this, importing the "@/components" barrel would throw.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) => mediaList(query, () => [1600, 900]);
}
