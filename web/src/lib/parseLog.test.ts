import { describe, expect, it } from "vitest";
import { parseLog } from "./parseLog";

// One reader for a run's log, used by the Overview (live log) and Activity
// (run drawer, live output). It takes GitHub's raw log and the dev seed's log.

describe("parseLog", () => {
  it("nothing gives no lines and no groups", () => {
    expect(parseLog(null)).toEqual({ lines: [], groups: [] });
    expect(parseLog("")).toEqual({ lines: [], groups: [] });
    expect(parseLog("\n  \r\n")).toEqual({ lines: [], groups: [] });
  });

  it("GitHub's raw log: the timestamp becomes the time, bracket tags the level", () => {
    const { lines } = parseLog(
      [
        "2026-10-02T11:51:02.1234567Z [INFO] Applying Terraform configuration...",
        "2026-10-02T11:51:09.0000000Z [WARNING] retrying after a slow response",
        "2026-10-02T11:51:12.0000000Z [ERROR] quota check failed for 203.0.113.9",
      ].join("\r\n"),
    );
    expect(lines.map((l) => [l.time, l.level, l.text])).toEqual([
      ["11:51:02", "INFO", "Applying Terraform configuration..."],
      ["11:51:09", "WARN", "retrying after a slow response"],
      ["11:51:12", "ERROR", "quota check failed for 203.0.113.9"],
    ]);
  });

  it("GitHub's markers: groups are titled lines and remembered, endgroup is dropped, error and warning set the level", () => {
    const log = parseLog(
      [
        "2026-10-02T11:51:00.0000000Z ##[group]Run terraform apply",
        "2026-10-02T11:51:01.0000000Z azurerm_public_ip.wg: Creating...",
        "2026-10-02T11:51:02.0000000Z ##[endgroup]",
        "##[warning]Node 16 is deprecated",
        "2026-10-02T11:51:03.0000000Z ##[error]Process completed with exit code 1.",
        "##[group]Set DNS record",
      ].join("\n"),
    );
    expect(log.lines.map((l) => [l.level, l.text])).toEqual([
      ["INFO", "▸ Run terraform apply"],
      ["INFO", "azurerm_public_ip.wg: Creating..."],
      ["WARN", "Node 16 is deprecated"],
      ["ERROR", "Process completed with exit code 1."],
      ["INFO", "▸ Set DNS record"],
    ]);
    expect(log.lines[0]!.time).toBe("11:51:00");
    expect(log.groups).toEqual([
      { title: "Run terraform apply", index: 0 },
      { title: "Set DNS record", index: 4 },
    ]);
  });

  it("the dev seed's lines keep their time and level", () => {
    const { lines } = parseLog("10:24:27 INFO Creating the VM\n10:24:30 WARN Slow answer\n10:24:31 ERROR It broke");
    expect(lines.map((l) => [l.time, l.level, l.text])).toEqual([
      ["10:24:27", "INFO", "Creating the VM"],
      ["10:24:30", "WARN", "Slow answer"],
      ["10:24:31", "ERROR", "It broke"],
    ]);
  });

  it("colour codes and a byte-order mark are removed; a plain line starting with error is an error", () => {
    const { lines } = parseLog("﻿\u001b[32mGreen text\u001b[0m\nError: terraform apply failed\nplain text");
    expect(lines.map((l) => [l.level, l.text])).toEqual([
      ["INFO", "Green text"],
      ["ERROR", "Error: terraform apply failed"],
      ["INFO", "plain text"],
    ]);
  });

  it("ids are unique and follow the lines in order", () => {
    const { lines } = parseLog("a\n\nb\n##[endgroup]\nc");
    expect(lines.map((l) => l.id)).toEqual(["0", "1", "2"]);
  });
});
