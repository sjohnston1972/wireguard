// schedule-time.ts
//
// Plain English: the clock arithmetic behind schedules, on its own so the
// screens can use it without pulling in the deploy machinery. UK wall-clock
// time (Europe/London), so the clock changes in March and October are handled.

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** UK wall-clock parts for an instant: ISO weekday (1 = Monday), minutes past midnight, and the date. */
export function londonClock(now: Date): { weekday: number; minutes: number; date: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { weekday: DAY_NAMES.indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** What a UK clock reads at an instant, written as if that reading were UTC (milliseconds). */
function londonWallMs(t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value])
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/**
 * The real moment a UK clock reads `hhmm` on `date` ("2026-03-29"), in
 * milliseconds. Twice a year that is not simple:
 *   - March (clocks go forward at 01:00): 01:00-01:59 never appears on the
 *     clock. Such a time is moved on by the hour the clocks skip, the way the
 *     clocks themselves do, so 01:30 means 02:30 BST.
 *   - October (clocks go back at 02:00): 01:00-01:59 appears twice. The
 *     first time counts.
 */
export function londonInstant(date: string, hhmm: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d) + toMinutes(hhmm) * 60_000;
  // The UK offset from UTC half a day either side: equal except on a change day.
  const offBefore = londonWallMs(wall - 12 * 3_600_000) - (wall - 12 * 3_600_000);
  const offAfter = londonWallMs(wall + 12 * 3_600_000) - (wall + 12 * 3_600_000);
  const fits = [wall - offBefore, wall - offAfter].filter((t) => londonWallMs(t) === wall);
  return fits.length ? Math.min(...fits) : wall - offBefore;
}

/**
 * Is the rule's window open right now, and how many minutes are left in it?
 * Worked out from the real start and end moments, not by subtracting clock
 * readings, so on the two clock-change Sundays a window lasts as long as it
 * really does (and one that starts in the hour the clocks skip still opens).
 */
export function windowNow(rule: { days: string; start_time: string; end_time: string }, now: Date): { open: boolean; minutesLeft: number; date: string } {
  const c = londonClock(now);
  if (!rule.days.includes(String(c.weekday))) return { open: false, minutesLeft: 0, date: c.date };
  const t = now.getTime();
  const startAt = londonInstant(c.date, rule.start_time), endAt = londonInstant(c.date, rule.end_time);
  const open = t >= startAt && t < endAt;
  return { open, minutesLeft: open ? (endAt - t) / 60_000 : 0, date: c.date };
}

/** "Mon–Fri", "Sat, Sun", "Every day": how a rule's days read on screen. */
export function daysText(days: string): string {
  const d = [...new Set(days.split(""))].map(Number).filter((n) => n >= 1 && n <= 7).sort();
  if (d.length === 7) return "Every day";
  const run = d.length > 2 && d.every((n, i) => i === 0 || n === d[i - 1] + 1);
  return run ? `${DAY_NAMES[d[0]]}–${DAY_NAMES[d[d.length - 1]]}` : d.map((n) => DAY_NAMES[n]).join(", ");
}

/** The next time any enabled rule opens, as "Mon 08:00", within the coming week. */
export function nextStart(rules: { days: string; start_time: string; enabled: number }[], now: Date): string | null {
  const c = londonClock(now);
  let best: { inMin: number; text: string } | null = null;
  for (const r of rules.filter((x) => x.enabled)) {
    for (let ahead = 0; ahead < 8; ahead++) {
      const wd = ((c.weekday - 1 + ahead) % 7) + 1;
      if (!r.days.includes(String(wd))) continue;
      const inMin = ahead * 1440 + toMinutes(r.start_time) - c.minutes;
      if (inMin <= 0) continue;
      if (!best || inMin < best.inMin) best = { inMin, text: `${ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : DAY_NAMES[wd]} ${r.start_time}` };
      break;
    }
  }
  return best?.text ?? null;
}

export function validRule(days: string, start: string, end: string): string | null {
  if (!/^[1-7]{1,7}$/.test(days)) return "Pick at least one day.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return "Times must look like 08:00.";
  if (toMinutes(end) <= toMinutes(start)) return "The end must be later than the start (windows cannot cross midnight).";
  return null;
}
