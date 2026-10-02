import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
// The one place jsdom gets the browser APIs Radix, cmdk and the charts touch
// (pointer capture, scrollIntoView, ResizeObserver).
import "./polyfills";

afterEach(() => cleanup());
