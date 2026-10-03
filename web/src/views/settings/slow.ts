import { configure } from "@testing-library/react";
import { vi } from "vitest";

// The Settings view is a big page: with the whole suite running at once the
// first render can take more than testing-library's default 1 s wait. Import
// this first in a Settings test file to give waits and tests more room.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });
