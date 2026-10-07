// money.test.ts
//
// Plain English: labs redesign spec §11 (and Review Focus 12). Cost and time
// words: a nonzero cost is never shown as £0.00, a missing estimate says so,
// and learning time, deploy time, session length and £/hour each have their
// own words.

import { describe, expect, it } from "vitest";
import { fmtHourlyPrecise, fmtHourlyShort, fmtMinutes, fmtSessionCost, hourlyAria } from "./money";

describe("fmtHourlyShort (cards)", () => {
  it("0 → < £0.01/hour (card)", () => expect(fmtHourlyShort(0)).toBe("< £0.01/hour"));
  it("0.00004 and 0.0099 → < £0.01/hour", () => {
    expect(fmtHourlyShort(0.00004)).toBe("< £0.01/hour");
    expect(fmtHourlyShort(0.0099)).toBe("< £0.01/hour");
  });
  it("0.01 → £0.01/hour, and pounds with two places above", () => {
    expect(fmtHourlyShort(0.01)).toBe("£0.01/hour");
    expect(fmtHourlyShort(0.42)).toBe("£0.42/hour");
    expect(fmtHourlyShort(1.1)).toBe("£1.10/hour");
  });
  it("NaN, Infinity, a negative or no number → Estimate unavailable", () => {
    for (const x of [NaN, Infinity, -0.5, null, undefined]) expect(fmtHourlyShort(x as number)).toBe("Estimate unavailable");
  });
  it("its accessible words", () => {
    expect(hourlyAria(0.004)).toBe("under 1p an hour");
    expect(hourlyAria(0)).toBe("under 1p an hour");
    expect(hourlyAria(0.42)).toBe("£0.42 an hour");
    expect(hourlyAria(NaN)).toBe("Estimate unavailable");
  });
});

describe("fmtHourlyPrecise (panel, tooltip)", () => {
  it("0 → No hourly charge at list price (panel)", () => expect(fmtHourlyPrecise(0)).toBe("No hourly charge at list price"));
  it("0.00004 → < £0.0001/hour", () => expect(fmtHourlyPrecise(0.00004)).toBe("< £0.0001/hour"));
  it("small figures keep the places they need", () => {
    expect(fmtHourlyPrecise(0.0001)).toBe("£0.0001/hour");
    expect(fmtHourlyPrecise(0.0082)).toBe("£0.0082/hour");
    expect(fmtHourlyPrecise(0.0099)).toBe("£0.0099/hour");
    expect(fmtHourlyPrecise(0.042)).toBe("£0.042/hour");
    expect(fmtHourlyPrecise(0.42)).toBe("£0.42/hour");
  });
  it("NaN → Estimate unavailable", () => {
    expect(fmtHourlyPrecise(NaN)).toBe("Estimate unavailable");
    expect(fmtHourlyPrecise(-1)).toBe("Estimate unavailable");
  });
});

describe("fmtSessionCost", () => {
  it("about £x for n h; under a penny says so", () => {
    expect(fmtSessionCost(0.025, 2)).toBe("about £0.05 for 2 h");
    expect(fmtSessionCost(0.0004, 2)).toBe("under £0.01 for 2 h");
    expect(fmtSessionCost(0, 2)).toBe("no charge at list price for 2 h");
    expect(fmtSessionCost(NaN, 2)).toBe("Estimate unavailable");
    expect(fmtSessionCost(0.1, 0)).toBe("Estimate unavailable");
  });
});

describe("no nonzero ever prints £0.00", () => {
  it("across tiny and penny figures", () => {
    for (const x of [1e-9, 0.000049, 0.00005, 0.0001, 0.0009, 0.001, 0.0049, 0.005, 0.0099, 0.01, 0.0149]) {
      for (const s of [fmtHourlyShort(x), fmtHourlyPrecise(x), fmtSessionCost(x, 1), fmtSessionCost(x, 3)]) expect(s, `${x}: ${s}`).not.toMatch(/£0\.0+(?![0-9])/);
    }
  });
});

describe("fmtMinutes", () => {
  it("45 min, 1 h 15 min, 2 h", () => {
    expect(fmtMinutes(45)).toBe("45 min");
    expect(fmtMinutes(75)).toBe("1 h 15 min");
    expect(fmtMinutes(120)).toBe("2 h");
    expect(fmtMinutes(0)).toBe("0 min");
  });
});
