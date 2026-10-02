import { configure } from "@testing-library/react";
import { vi } from "vitest";

// The Clients tests walk whole pages (fetch, render, mutate, navigate). The
// full suite runs many jsdom files at once, so give findBy/waitFor 5 s
// instead of 1 s before calling something missing.
configure({ asyncUtilTimeout: 5_000 });
// Whole-page journeys: the slowest takes about 7 s with every file running at once.
vi.setConfig({ testTimeout: 20_000 });
