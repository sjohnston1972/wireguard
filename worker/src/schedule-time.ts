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

/** Is the rule's window open right now, and how many minutes are left in it? */
export function windowNow(rule: { days: string; start_time: string; end_time: string }, now: Date): { open: boolean; minutesLeft: number; date: string } {
  const c = londonClock(now);
  const start = toMinutes(rule.start_time), end = toMinutes(rule.end_time);
  const open = rule.days.includes(String(c.weekday)) && c.minutes >= start && c.minutes < end;
  return { open, minutesLeft: open ? end - c.minutes : 0, date: c.date };
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
