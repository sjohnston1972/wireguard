// scripts/deploy-worker.mjs   (npm run deploy-worker [-- --dry-run])
//
// Plain English: publishes the dashboard to Cloudflare. Builds the app
// (web/dist), checks its size, prints the version now live (keep its id: it
// is what "npm run rollback-worker -- <id>" goes back to), applies any pending
// database migrations, then deploys. Uses the broad CLOUDFLARE_API_TOKEN from
// .env for wrangler only (it never leaves this machine). Stops at the first
// step that fails. --dry-run prints the steps and changes nothing.

import { writeFileSync } from "node:fs";
import { loadEnv } from "./lib/env.mjs";
import { deploySteps, runSteps, spawnRunner, dryRunner } from "./lib/deploy.mjs";

const dry = process.argv.includes("--dry-run");

if (!dry) {
  // Stamp this build so the Worker reports which deploy is live (session build id).
  const build = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  writeFileSync("worker/src/build.ts", `// build.ts (rewritten by "npm run deploy-worker"; the value only needs to change per deploy)\nexport const BUILD = "${build}";\n`);
  console.log(`build ${build}`);
}

const status = runSteps(deploySteps(), dry ? dryRunner : spawnRunner(loadEnv()));
if (status !== 0) process.exit(status);
console.log(dry ? "\nDry run: nothing was changed." : "\nDeployed. Open https://wg-admin.clydeford.net");
