// insights/aws/feeds/metrics.ts
//
// Plain English: the headend's AWS/EC2 metrics from CloudWatch (GetMetricData), the last 45 minutes of 5-minute slots every 15 minutes, stored in hist_aws_vm.
// Spec 2026-10-15-aws-insights-design.md, section 4.1.
//
// A stub until its task builds it (AWS insights plan): the contract
// (id, cadence, when, calls) is final; run() answers "Not built yet."

import type { AwsFeed } from "../types";

const metrics: AwsFeed = {
  id: "aws.metrics",
  title: "CloudWatch metrics",
  cadenceMin: 15,
  when: "running",
  calls: 1,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default metrics;
