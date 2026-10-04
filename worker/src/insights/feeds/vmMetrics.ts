// insights/feeds/vmMetrics.ts
//
// Plain English: Azure Monitor's platform metrics for vm-wg (CPU, memory,
// network, disk, CPU credits, availability), one call every 5 minutes while
// it runs and for 15 minutes after it stops, into hist_az_vm. See metrics.ts.

import type { FeedModule } from "../runner";
import { paths } from "../common";
import { runMetrics } from "./metrics";

export { normaliseMetrics as normaliseVmMetrics, storeMetrics } from "./metrics";

export async function fetchAndStoreVmMetrics(ctx: Parameters<FeedModule["run"]>[0]): Promise<void> {
  await runMetrics(ctx, "vm", paths(ctx.env, ctx.cfg).vm);
}

const vmMetrics: FeedModule = {
  id: "vmMetrics",
  title: "VM metrics",
  cadenceMin: 5,
  when: "running",
  calls: 1,
  arm: true,
  async run(ctx) {
    await fetchAndStoreVmMetrics(ctx);
    return { status: "ok", error: null };
  },
};

export default vmMetrics;
