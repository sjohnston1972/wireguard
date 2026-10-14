// insights/aws/feeds/bootLog.ts
//
// Plain English: the headend's console output (EC2 GetConsoleOutput,
// Latest=true), redacted and capped at 64 KB, stored in aws_latest['bootlog']
// after each start; and the on-demand fetch behind POST /api/v1/azure/bootlog
// when the server is in AWS (one a minute, as on Azure).
// Spec 2026-10-15-aws-insights-design.md, section 4.7.
//
// A stub until its task builds it (AWS insights plan, Task 2): the contract
// (id, cadence, when, calls) and fetchAwsBootLogNow's signature are final;
// run() answers "Not built yet." and fetchAwsBootLogNow throws.

import type { Env } from "../../../env";
import type { BootLogResponse } from "../../../../../shared/api";
import type { AwsFeed } from "../types";

/**
 * Fetch the boot log now for POST /api/v1/azure/bootlog (its own budget of 2
 * calls), the same shape as Azure's fetchBootLogNow (insights/ondemand.ts):
 * the stored doc, or why not ("slow_down": one a minute).
 */
export async function fetchAwsBootLogNow(env: Env, now: Date): Promise<{ ok: true; doc: BootLogResponse } | { ok: false; why: "slow_down" | "error"; message: string }> {
  void env;
  void now;
  throw new Error("Not built yet.");
}

const bootLog: AwsFeed = {
  id: "aws.bootLog",
  title: "Boot log",
  cadenceMin: null,
  when: "server",
  calls: 1,
  async run() {
    return { status: "error", error: "Not built yet." };
  },
};

export default bootLog;
