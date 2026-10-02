import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
// The one place jsdom gets the browser APIs Radix, cmdk and the charts touch
// (pointer capture, scrollIntoView, ResizeObserver, matchMedia).
import "./polyfills";

// jsdom has no canvas, so every test draws uPlot charts with a stand-in
// (test/fakeUplot.ts). A test file may still vi.mock("uplot") itself.
vi.mock("uplot", () => import("./fakeUplot"));

afterEach(() => cleanup());
