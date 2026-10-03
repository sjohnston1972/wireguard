// healthcheck.ts
//
// Plain English: "check the tunnel now". The VM already proves the tunnel
// once at boot with its self-test (handshake, pings, DNS, internet). This asks
// it to run the same test again on demand. Same shape as the speed test: the
// dashboard can't reach the VM, so the request rides back on the next
// heartbeat reply and the result on a later heartbeat. A VM running an older
// agent ignores the request; the Worker gives up on it after 5 minutes.

import type { Env } from "./env";
import { getSnapshot, saveSnapshot } from "./state";
import { RunError } from "./runs";
import { randomToken } from "./auth";

export async function requestHealthCheck(env: Env): Promise<string> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running") throw new RunError("Nothing is running.");
  if (snap.selftest_req) throw new RunError("A health check is already running.");
  await saveSnapshot(env, { selftest_req: { id: randomToken().slice(0, 12), at: new Date().toISOString() } });
  return "Health check requested. The VM runs its self-test at its next heartbeat, within about 30 seconds.";
}
