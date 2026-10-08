// demo-clock.test.ts
//
// Plain English: the demo's moved clock (worker/src/demo/clock.ts). Inside a
// demo read the app sees the time the demo was seeded (to the minute); the
// answer's times are moved forward to now. Outside a demo read, nothing
// changes: the real clock, exactly. Proved here, plus that only the demo
// store's serve ever moves it (so cron, the watchman, the lab watch and
// insights never can).
import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { demoClock, demoClockFor, demoClockInstalled, installDemoClock, shiftTimes, DEMO_CLOCK_STEP_MS } from "../src/demo/clock";

afterEach(() => {
  vi.useRealTimers();
});

const HOUR = 3_600_000;

describe("installDemoClock", () => {
  it("is idempotent and leaves the real clock alone outside a demo read", () => {
    installDemoClock();
    const D = globalThis.Date;
    installDemoClock();
    expect(globalThis.Date).toBe(D);
    expect(demoClockInstalled()).toBe(true);
    const before = Date.now();
    const d = new Date();
    expect(Math.abs(d.getTime() - before)).toBeLessThan(1000);
    expect(d).toBeInstanceOf(Date);
    expect(Object.prototype.toString.call(d)).toBe("[object Date]");
    expect(typeof Date()).toBe("string");
    expect(new Date(0).toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(Date.parse("2026-10-08T10:00:00Z")).toBe(Date.UTC(2026, 9, 8, 10));
  });

  it("inside demoClock.run, now and new Date() are moved; dates made from a value are not", async () => {
    installDemoClock();
    const real = Date.now();
    const seen = await demoClock.run(-3 * HOUR, async () => {
      await Promise.resolve();
      return { now: Date.now(), made: new Date().getTime(), fixed: new Date(1_000).getTime(), text: Date() };
    });
    expect(Math.abs(seen.now - (real - 3 * HOUR))).toBeLessThan(1000);
    expect(Math.abs(seen.made - (real - 3 * HOUR))).toBeLessThan(1000);
    expect(seen.fixed).toBe(1_000);
    expect(Math.abs(Date.parse(seen.text) - (real - 3 * HOUR))).toBeLessThan(2000);
    // And after it, the real clock again.
    expect(Math.abs(Date.now() - real)).toBeLessThan(1000);
  });

  it("a real request running at the same time as a demo read keeps the real time", async () => {
    installDemoClock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const demo = demoClock.run(-48 * HOUR, async () => {
      await gate;
      return Date.now();
    });
    const realSide = (async () => {
      await Promise.resolve();
      const t = Date.now();
      release();
      return t;
    })();
    const [d, r] = await Promise.all([demo, realSide]);
    expect(Math.abs(r - Date.now())).toBeLessThan(1000);
    expect(Math.abs(d - (Date.now() - 48 * HOUR))).toBeLessThan(1000);
  });

  it("wraps a clock that replaced it (fake timers, the dev clock) without moving it twice", () => {
    installDemoClock();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00.000Z"));
    installDemoClock();
    expect(Date.now()).toBe(Date.UTC(2026, 9, 8, 10));
    expect(demoClock.run(-HOUR, () => Date.now())).toBe(Date.UTC(2026, 9, 8, 9));
    expect(demoClock.run(-HOUR, () => new Date().toISOString())).toBe("2026-10-08T09:00:00.000Z");
    vi.useRealTimers();
    installDemoClock();
    expect(Math.abs(demoClock.run(-HOUR, () => Date.now()) - (Date.now() - HOUR))).toBeLessThan(1000);
  });
});

describe("demoClockFor", () => {
  const seeded = Date.UTC(2026, 9, 8, 9);
  it("is zero in the first minute, and for a seed time in the future or unknown", () => {
    expect(demoClockFor(seeded, seeded + 59_000)).toEqual({ offset: 0, shift: 0 });
    expect(demoClockFor(seeded, seeded - HOUR)).toEqual({ offset: 0, shift: 0 });
    expect(demoClockFor(NaN, seeded)).toEqual({ offset: 0, shift: 0 });
  });
  it("moves by whole minutes, so the app sees at most a minute after the seed", () => {
    const r = demoClockFor(seeded, seeded + 3 * 86_400_000 + 17 * 60_000 + 42_000);
    expect(r.shift).toBe(3 * 86_400_000 + 17 * 60_000);
    expect(r.offset).toBe(-r.shift);
    expect(r.shift % DEMO_CLOCK_STEP_MS).toBe(0);
  });
});

describe("shiftTimes", () => {
  it("moves every ISO UTC time, keeping its form", () => {
    const text = JSON.stringify({ a: "2026-10-08T10:00:00.000Z", b: "2026-10-08T10:00:00Z", log: "2026-10-08T23:59:30.5Z ##[group]Apply" });
    const out = JSON.parse(shiftTimes(text, 2 * HOUR + 60_000));
    expect(out).toEqual({ a: "2026-10-08T12:01:00.000Z", b: "2026-10-08T12:01:00Z", log: "2026-10-09T02:00:30.5Z ##[group]Apply" });
  });
  it("leaves plain days, ids and other text alone", () => {
    const text = JSON.stringify({ day: "2026-10-07", id: "apply-20261008-100000-abc123", key: "backups/20261008T100000Z-apply.tfstate", n: 1759917600 });
    expect(shiftTimes(text, 5 * HOUR)).toBe(text);
  });
  it("moves a peer's latest_handshake (seconds since 1970) with them, but never a 0 (never shook hands)", () => {
    const text = JSON.stringify({ live: { latest_handshake: 1759917600, rx: 5 }, other: { latest_handshake: 0 } });
    expect(JSON.parse(shiftTimes(text, 2 * HOUR))).toEqual({ live: { latest_handshake: 1759917600 + 7200, rx: 5 }, other: { latest_handshake: 0 } });
  });
  it("does nothing with no shift", () => {
    expect(shiftTimes('"2026-10-08T10:00:00Z"', 0)).toBe('"2026-10-08T10:00:00Z"');
  });
});

describe("only the demo store moves the clock", () => {
  it("demoClock.run appears in worker/src only in demo/store.ts", () => {
    const walk = (dir: string): string[] => readdirSync(new URL(`../src/${dir}`, import.meta.url)).flatMap((f) => (/\.tsx?$/.test(f) ? [`${dir}${f}`] : f.includes(".") ? [] : walk(`${dir}${f}/`)));
    const users = walk("").filter((f) => /demoClock\.run\(/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")));
    expect(users).toEqual(["demo/store.ts"]);
  });
});
