// speedtest.ts
//
// Plain English: how fast is the tunnel, really? The VM runs iperf3 against
// the home site container, over the tunnel, both ways, plus ten pings for
// latency and jitter. Same idea as an iperf test across a WAN link before
// handing it over. The dashboard can't reach the VM directly, so the request
// rides back on the next heartbeat reply and the result on a later heartbeat:
// about a minute end to end.

import type { Env } from "./env";
import * as db from "./db";
import { getSnapshot, saveSnapshot, peerOnline } from "./state";
import { RunError } from "./runs";
import { randomToken } from "./auth";

export async function startSpeedTest(env: Env): Promise<string> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running") throw new RunError("Nothing is running.");
  if (snap.speedtest_req) throw new RunError("A speed test is already running.");
  const site = await db.sitePeer(env);
  if (!site) throw new RunError("The speed test needs the home site. On the PC run: npm run home");
  const live = snap.agent?.peers.find((p) => p.public_key === site.public_key);
  if (!live || !peerOnline(live)) throw new RunError(`The home site (${site.name}) is not connected. Is the wg-home container running?`);
  await saveSnapshot(env, { speedtest_req: { id: randomToken().slice(0, 12), target: site.ip, target_name: site.name, at: new Date().toISOString() } });
  return "Speed test started: 5 seconds each way plus pings. Results in about a minute.";
}
