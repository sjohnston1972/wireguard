// demo/clock.ts
//
// Plain English: why the demo never goes stale. The demo store is seeded once
// (at most a few times a day: a refresh writes thousands of rows and has a
// daily allowance), but the VM's heartbeat counts as late after 2 minutes and
// a client as offline after 3. So a demo seeded at 09:00 and looked at at
// 15:00 used to show a greyed-out dashboard with nobody connected.
//
// The fix keeps the data and moves the clock, like replaying a capture with
// its timestamps rebased to now:
//
//   1. While a demo read runs (demoClock.run, demo/store.ts serve), the
//      app's code sees a clock that stands within a minute of the moment the
//      demo was seeded. Every page is worked out exactly as it was then:
//      heartbeat fresh, clients connected, the last 24 hours full.
//   2. The answer's times are then moved forward by whole minutes, by how
//      long ago that was (shiftTimes), so the browser, which compares them
//      with its own clock, sees data from the last minute or so.
//
// The clock cycles: within each minute after seeding it runs normally, then
// steps back a minute while the shift steps forward one. So "last seen 12 s
// ago" counts up and starts again every minute, like a heartbeat arriving.
//
// Only code inside demoClock.run sees the moved clock. The global Date is
// wrapped once (installDemoClock is idempotent, like the outbound guard in
// guard.ts); outside a demo read the wrapper answers exactly what the real
// clock does, so cron, the watchman, the lab watch, insights and every real
// request keep the real time. Nothing here writes anything.

import { AsyncLocalStorage } from "node:async_hooks";

/** Set while a demo read runs: milliseconds to add to the real clock (always 0 or negative). */
export const demoClock = new AsyncLocalStorage<number>();

/** The clock steps back in whole minutes, so shifted times keep their minute boundaries (history buckets). */
export const DEMO_CLOCK_STEP_MS = 60_000;

/**
 * How far to move the clock for a demo seeded at `seededMs`, read at `nowMs`:
 * `offset` for demoClock.run (zero or negative) and `shift` for shiftTimes
 * (its opposite). Both are whole minutes; zero in the first minute after
 * seeding, and zero when the seed time is unknown or in the future.
 */
export function demoClockFor(seededMs: number, nowMs: number): { offset: number; shift: number } {
  const elapsed = nowMs - seededMs;
  if (!Number.isFinite(elapsed) || elapsed < DEMO_CLOCK_STEP_MS) return { offset: 0, shift: 0 };
  const shift = Math.floor(elapsed / DEMO_CLOCK_STEP_MS) * DEMO_CLOCK_STEP_MS;
  return { offset: -shift, shift };
}

const ours = new WeakSet<object>();

/** True when the global Date is currently the demo clock's wrapper (tests). */
export function demoClockInstalled(): boolean {
  return ours.has(globalThis.Date);
}

/**
 * Wrap the global Date once (again only if something replaced it since, as
 * the dev clock and test fake timers do). `new Date()` and `Date.now()` add
 * the current demo read's offset; everything else (a date made from a value,
 * Date.parse, Date.UTC) is the real Date's.
 */
export function installDemoClock(): void {
  const Inner = globalThis.Date;
  if (ours.has(Inner)) return;
  const offset = () => demoClock.getStore() ?? 0;
  function DemoDate(this: unknown, ...args: unknown[]) {
    const off = offset();
    // Date() called as a function answers a string, as the real one does.
    if (!new.target) return off ? new Inner(Inner.now() + off).toString() : (Inner as unknown as () => string)();
    if (args.length || !off) return Reflect.construct(Inner, args, new.target);
    return Reflect.construct(Inner, [Inner.now() + off], new.target);
  }
  DemoDate.prototype = Inner.prototype;
  DemoDate.now = () => Inner.now() + offset();
  DemoDate.parse = Inner.parse;
  DemoDate.UTC = Inner.UTC;
  ours.add(DemoDate);
  globalThis.Date = DemoDate as unknown as DateConstructor;
}

/** An ISO time in UTC as the app writes them: 2026-10-08T14:00:00Z or 2026-10-08T14:00:00.000Z. */
const ISO_UTC = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z\b/g;

/**
 * Every ISO time in `text` (a JSON answer, a log) moved forward by `shiftMs`,
 * keeping its form (with or without milliseconds). Plain dates (2026-10-08,
 * the Cost page's days) are left alone: they stay with the demo's own month.
 */
export function shiftTimes(text: string, shiftMs: number): string {
  if (!shiftMs) return text;
  return text.replace(ISO_UTC, (whole, main: string, frac: string | undefined) => {
    const ms = Date.parse(`${main}${frac ?? ""}Z`);
    if (!Number.isFinite(ms)) return whole;
    const out = new Date(ms + shiftMs).toISOString();
    if (frac === undefined) return out.replace(/\.\d{3}Z$/, "Z");
    // The same number of fraction digits as the original.
    return `${out.slice(0, 19)}${out.slice(19, 20 + frac.length - 1)}Z`;
  });
}
