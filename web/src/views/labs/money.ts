// views/labs/money.ts
//
// Plain English: the catalogue's cost and time words (labs redesign spec §11).
// Labs cost pennies, so a small but real cost is never rounded to "£0.00": a
// card says "< £0.01/hour", the details give the precise figure, and a missing
// estimate says "Estimate unavailable". Learning time, deploy time, session
// length and £/hour each have their own words; never one figure for two.

import { fmtGbp } from "./model";

export const ESTIMATE_UNAVAILABLE = "Estimate unavailable";

/** A usable £ figure: a finite number of 0 or more. */
const valid = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;

/** Cards: "£0.42/hour"; anything under a penny (0 included) "< £0.01/hour". */
export function fmtHourlyShort(x: number): string {
  if (!valid(x)) return ESTIMATE_UNAVAILABLE;
  return x < 0.01 ? "< £0.01/hour" : `£${x.toFixed(2)}/hour`;
}

/** fmtHourlyShort's accessible words: "under 1p an hour", "£0.42 an hour". */
export function hourlyAria(x: number): string {
  if (!valid(x)) return ESTIMATE_UNAVAILABLE;
  return x < 0.01 ? "under 1p an hour" : `£${x.toFixed(2)} an hour`;
}

/** Details and tooltips: "£0.0082/hour", "£0.042/hour"; 0 "No hourly charge at list price"; a sliver "< £0.0001/hour". */
export function fmtHourlyPrecise(x: number): string {
  if (!valid(x)) return ESTIMATE_UNAVAILABLE;
  if (x === 0) return "No hourly charge at list price";
  if (x < 0.00005) return "< £0.0001/hour";
  return `${fmtGbp(x)}/hour`;
}

/** A session at `gbpH` £/hour for `hours`: "about £0.05 for 2 h"; under a penny "under £0.01 for 2 h". */
export function fmtSessionCost(gbpH: number, hours: number): string {
  if (!valid(gbpH) || !valid(hours) || hours === 0) return ESTIMATE_UNAVAILABLE;
  const total = gbpH * hours;
  if (total === 0) return `no charge at list price for ${hours} h`;
  if (total < 0.01) return `under £0.01 for ${hours} h`;
  return `about £${total.toFixed(2)} for ${hours} h`;
}

/** "45 min", "1 h 15 min", "2 h". */
export function fmtMinutes(n: number): string {
  const min = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
