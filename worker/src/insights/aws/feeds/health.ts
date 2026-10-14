// insights/aws/feeds/health.ts
//
// Plain English: the headend's two AWS status checks and its power state (EC2 DescribeInstanceStatus), and AWS's scheduled events for it, stored in aws_latest['health'].
// Spec 2026-10-15-aws-insights-design.md, section 4.2.
//
// A stub until its task builds it (AWS insights plan): the contract
// (id, cadence, when, calls) is final; run() answers "Not built yet."

import type { AwsFeed } from "../types";

const health: AwsFeed = {
  id: "aws.health",
  title: "Instance health",
  cadenceMin: 5,
  when: "server",
  calls: 1,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default health;
