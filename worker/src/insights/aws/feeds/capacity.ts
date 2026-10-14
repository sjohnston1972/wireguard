// insights/aws/feeds/capacity.ts
//
// Plain English: can the next AWS deploy get its instance type? Whether the
// region offers it (DescribeInstanceTypeOfferings), its vCPUs
// (DescribeInstanceTypes), the On-Demand Standard vCPU quota (Service Quotas)
// and what is running (DescribeInstances), stored in aws_capacity as a
// CapacityDoc; and awsCapacityCheck, which turns that into the deploy form's
// warning (OverviewResponse.awsCapacity).
// Spec 2026-10-15-aws-insights-design.md, section 4.5.
//
// A stub until its task builds it (AWS insights plan, Task 4): the contract
// (id, cadence, when, calls) and awsCapacityCheck's signature are final;
// run() answers "Not built yet." and awsCapacityCheck throws.

import type { CapacityCheck } from "../../../../../shared/api";
import type { CapacityDoc } from "../../types";
import type { AwsFeed } from "../types";

/**
 * The capacity check for `size` in `region` from the stored doc (null = not
 * read yet): vCPUs needed = the size's, plus the test VM's (t4g.nano) when
 * `needTestVm`; family.name "Standard (T family)".
 */
export function awsCapacityCheck(doc: CapacityDoc | null, region: string, size: string, needTestVm: boolean, fetchedAt: string | null): CapacityCheck {
  void doc;
  void region;
  void size;
  void needTestVm;
  void fetchedAt;
  throw new Error("Not built yet.");
}

const capacity: AwsFeed = {
  id: "aws.capacity",
  title: "Capacity and quota",
  cadenceMin: 1440,
  when: "always",
  calls: 4,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default capacity;
