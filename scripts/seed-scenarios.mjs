// scripts/seed-scenarios.mjs   (npm run seed -- running)
//
// Plain English: asks the local dev server ("npm run dev:api") to wipe its
// local database and load one canned story: a running VM with clients on it, a
// deploy half-way through, a failed one and so on. The Worker only answers
// when it is on localhost with the login bypass on; on anything else it says
// 404 and this script says so.
//
//   node scripts/seed-scenarios.mjs <scenario> [--api http://localhost:8787] [--now 2026-10-02T14:00:00Z]
//   node scripts/seed-scenarios.mjs --list

import { pathToFileURL } from "node:url";

export const SCENARIOS = ["empty", "destroyed", "deploying", "running", "failed", "standby", "busy-month"];

/**
 * Seed one scenario on the dev server at `api`. Returns the Worker's summary or throws with a plain reason.
 * `freeze` (npm run shots -- --freeze-time) also stops the dev Worker's clock at `now` until the next seed.
 */
export async function seed(api, scenario, now, freeze = false) {
  const qs = new URLSearchParams({ scenario });
  if (now) qs.set("now", now);
  if (freeze) qs.set("freeze", "1");
  let r;
  try {
    r = await fetch(`${api}/__dev/seed?${qs}`, { method: "POST" });
  } catch (e) {
    throw new Error(`Could not reach ${api}. Start the dev server first: npm run dev:api (${e.cause?.code ?? e.message})`);
  }
  if (r.status === 404) {
    throw new Error(`${api} answered 404. The seeder only exists on the local dev server (npm run dev:api) reached as localhost; is something else on that port?`);
  }
  const text = await r.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new Error(body?.error ?? `Seeding failed (${r.status}): ${text.slice(0, 200)}`);
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    console.log(SCENARIOS.join("\n"));
    return 0;
  }
  let api = "http://localhost:8787";
  let now;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api") api = (args[++i] ?? "").replace(/\/+$/, "");
    else if (args[i] === "--now") now = args[++i];
    else rest.push(args[i]);
  }
  const scenario = rest[0];
  if (!scenario || rest.length > 1 || !SCENARIOS.includes(scenario)) {
    console.error(`Usage: node scripts/seed-scenarios.mjs <scenario> [--api URL] [--now ISO]\nScenarios: ${SCENARIOS.join(", ")}`);
    return 2;
  }
  try {
    const res = await seed(api, scenario, now);
    const c = res.counts ?? {};
    console.log(`Seeded "${scenario}" at ${res.now}: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
