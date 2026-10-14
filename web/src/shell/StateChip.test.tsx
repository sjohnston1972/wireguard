import { describe, expect, it } from "vitest";
import { chipFor, chipLabel } from "./StateChip";
import { overview } from "@/views/overview/testData";

describe("chipLabel", () => {
  it("names the cloud and region", () => {
    const o = overview("running");
    expect(chipLabel(o)).toMatch(/^Azure • /);
    o.snapshot.cloud = "aws";
    o.snapshot.region = "eu-west-2";
    expect(chipLabel(o)).toBe("AWS • London");
  });

  it("chipFor falls back to the AWS region for an AWS headend with no region recorded", () => {
    const o = overview("running");
    o.snapshot.cloud = "aws";
    o.snapshot.region = null;
    expect(chipFor(o).text).toContain("London");
    expect(chipFor(o).text).not.toContain("UK South");
  });
});
