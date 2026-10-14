import { describe, expect, it } from "vitest";
import { chipLabel } from "./StateChip";
import { overview } from "@/views/overview/testData";

describe("chipLabel", () => {
  it("names the cloud and region", () => {
    const o = overview("running");
    expect(chipLabel(o)).toMatch(/^Azure • /);
    o.snapshot.cloud = "aws";
    o.snapshot.region = "eu-west-2";
    expect(chipLabel(o)).toBe("AWS • London");
  });
});
