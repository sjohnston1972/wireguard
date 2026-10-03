/** Joins class names, skipping falsy values. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Status tones shared by pills, tiles, rings and bars. */
export type Tone = "green" | "amber" | "red" | "blue" | "purple" | "grey";
