// The demo mode fixture (GET /api/v1/demo) the app's tests build on: off,
// never seeded and no dev seeder by default, with any field overridable.
import { describe, it, expect } from "vitest";
import { demoStatusFixture } from "./fixtures";
import { DEMO_STORY } from "@shared/demo";

describe("demoStatusFixture", () => {
  it("is off, never refreshed, refreshable now and without the dev seeder by default", () => {
    expect(demoStatusFixture()).toEqual({ on: false, refreshedAt: null, story: DEMO_STORY, rowsToday: 0, dailyRows: 30_000, nextRefreshAt: null, devSeed: null });
  });

  it("takes overrides, and a fresh object each time", () => {
    const on = demoStatusFixture({ on: true, refreshedAt: "2026-10-02T10:00:00.000Z", devSeed: { scenarios: ["empty", "everything"] } });
    expect(on.on).toBe(true);
    expect(on.devSeed?.scenarios).toEqual(["empty", "everything"]);
    expect(demoStatusFixture()).not.toBe(demoStatusFixture());
  });
});
