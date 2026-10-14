// insights/aws/feeds/serviceHealth.ts
//
// Plain English: AWS's public status feeds (RSS) for EC2 and VPC in the region, stored in aws_service_events.
// Spec 2026-10-15-aws-insights-design.md, section 4.4.
//
// A stub until its task builds it (AWS insights plan): the contract
// (id, cadence, when, calls) is final; run() answers "Not built yet."

import type { AwsFeed } from "../types";

const serviceHealth: AwsFeed = {
  id: "aws.serviceHealth",
  title: "Service health",
  cadenceMin: 15,
  when: "always",
  calls: 2,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default serviceHealth;
