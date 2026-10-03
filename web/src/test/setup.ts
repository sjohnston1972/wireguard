import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import { dropPrefsStores } from "@/widgets/store";
// The one place jsdom gets the browser APIs Radix, cmdk and the charts touch
// (pointer capture, scrollIntoView, ResizeObserver, matchMedia).
import "./polyfills";

// jsdom has no canvas, so every test draws uPlot charts with a stand-in
// (test/fakeUplot.ts). A test file may still vi.mock("uplot") itself.
vi.mock("uplot", () => import("./fakeUplot"));

// findBy*/waitFor give up after 1 s by default. Whole-app renders (shell plus a
// real view) can take longer than that while every test file runs in parallel,
// which made passing tests fail at random. A passing wait returns as soon as it
// passes, so the longer limit costs nothing when the machine is idle.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  // A widget change still waiting to be saved must not reach the next test's mocked server.
  dropPrefsStores();
});
