import type { LogLevel, LogLine } from "@/components";

// A run's log as LogView lines, for the Overview's live log and Activity's
// run drawer and live output. It reads GitHub's raw log (an ISO timestamp,
// then the text; "##[group]" and friends as markers) and the dev seed's
// "10:24:27 INFO text" lines.

export interface ParsedLog {
  lines: LogLine[];
  /** Where GitHub marks a group ("##[group]Title"): the title and the line it starts at. */
  groups: { title: string; index: number }[];
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** GitHub's per-line timestamp: "2026-10-02T11:51:02.1234567Z ". */
const STAMP = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)(?:\.\d+)?Z?\s?/;
const MARKER = /^##\[(group|endgroup|error|warning|debug|notice|command)\](.*)$/;
const SEEDED = /^(\d{2}:\d{2}:\d{2}) (INFO|WARN|ERROR|DEBUG) (.*)$/;
const TAG = /^\[(INFO|WARN|WARNING|ERROR|DEBUG)\]\s*/i;

const MARKER_LEVEL: Record<string, LogLevel> = { error: "ERROR", warning: "WARN", debug: "DEBUG" };

export function parseLog(text: string | null | undefined): ParsedLog {
  const lines: LogLine[] = [];
  const groups: ParsedLog["groups"] = [];
  if (!text) return { lines, groups };
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const clean = raw.replace(ANSI, "");
    if (!clean.trim()) continue;
    const stamp = STAMP.exec(clean);
    const time = stamp?.[1];
    const rest = stamp ? clean.slice(stamp[0].length) : clean;
    const id = String(lines.length);

    const marker = MARKER.exec(rest);
    if (marker) {
      const [, kind, body] = marker;
      if (kind === "endgroup") continue;
      if (kind === "group") {
        groups.push({ title: body.trim(), index: lines.length });
        lines.push({ id, time, level: "INFO", text: `▸ ${body.trim()}` });
      } else lines.push({ id, time, level: MARKER_LEVEL[kind] ?? "INFO", text: body });
      continue;
    }

    const seeded = SEEDED.exec(rest);
    if (seeded) {
      lines.push({ id, time: seeded[1], level: seeded[2] as LogLevel, text: seeded[3] });
      continue;
    }

    const tag = TAG.exec(rest);
    if (tag) {
      const word = tag[1].toUpperCase();
      lines.push({ id, time, level: word === "WARNING" ? "WARN" : (word as LogLevel), text: rest.slice(tag[0].length) });
      continue;
    }

    lines.push({ id, time, level: /^error\b/i.test(rest.trim()) ? "ERROR" : "INFO", text: rest });
  }
  return { lines, groups };
}
