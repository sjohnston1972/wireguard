// devclock.ts
//
// Plain English: a clock that stands still, for screenshots on the
// developer's own PC. "npm run shots -- --freeze-time" seeds a story at a
// fixed time and asks the dev Worker to stop its clock there, so "updated
// 12 s ago", "Up for 2h 12m" and every other age come out the same on every
// run, and two runs can be compared pixel for pixel.
//
// Only the seed route calls this, and only after its dev guard passes
// (AUTH_DEV_BYPASS exactly "1" and a localhost request; see devseed.ts), so
// the live Worker's clock is never touched. A seed without freeze=1 puts the
// real clock back.

/** The clock in use before the freeze, put back by freezeDevClock(null); null while not frozen. */
let before: DateConstructor | null = null;

/** Stop the Worker's clock at `ms` (milliseconds since 1970), or start it again with null. */
export function freezeDevClock(ms: number | null): void {
  if (ms === null) {
    // Not frozen: leave the clock alone (it may be a test's fake one).
    if (before) globalThis.Date = before;
    before = null;
    return;
  }
  const Real = before ?? globalThis.Date;
  // `new Date()` and `Date.now()` read the frozen time; a date made from a value works as normal.
  function Frozen(this: unknown, ...args: unknown[]) {
    if (!new.target) return new Real(ms!).toString();
    return args.length ? new (Real as unknown as new (...a: unknown[]) => Date)(...args) : new Real(ms!);
  }
  Frozen.prototype = Real.prototype;
  Frozen.now = () => ms;
  Frozen.parse = Real.parse;
  Frozen.UTC = Real.UTC;
  before = Real;
  globalThis.Date = Frozen as unknown as DateConstructor;
}
