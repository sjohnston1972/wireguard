import { vi } from "vitest";
import { configure } from "@testing-library/react";

// The Overview renders the whole page (a dozen panels) for every test, which
// is slow in jsdom on a busy machine: allow more time than the defaults.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });
