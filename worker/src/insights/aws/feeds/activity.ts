// insights/aws/feeds/activity.ts
//
// Plain English: CloudTrail's write events (LookupEvents) that touch cloudlabs' AWS resources, stored in aws_activity.
// Spec 2026-10-15-aws-insights-design.md, section 4.3.
//
// A stub until its task builds it (AWS insights plan): the contract
// (id, cadence, when, calls) is final; run() answers "Not built yet."

import type { AwsFeed } from "../types";

const activity: AwsFeed = {
  id: "aws.activity",
  title: "Change log",
  cadenceMin: 5,
  when: "always",
  calls: 4,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default activity;
