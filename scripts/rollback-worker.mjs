// scripts/rollback-worker.mjs   (npm run rollback-worker [-- <version id>] [--dry-run])
//
// Plain English: puts the previous dashboard back. With no id it only lists
// the recent versions (dates and ids) and changes nothing; pick the one from
// before the deploy you want to undo. With an id it makes that version live
// again, static files included, in about 30 seconds. The database is not
// touched (migrations only ever add tables). Uses the token from .env, like
// deploy-worker. --dry-run prints the command and changes nothing.
//
// It always warns about cron triggers: a rollback brings back the old code
// but keeps today's crons (wrangler.toml [triggers]). Going back across a
// change to them is "revert the merge on main, then npm run deploy-worker".

import { loadEnv } from "./lib/env.mjs";
import { readFileSync } from "node:fs";
import { rollbackSteps, runSteps, spawnRunner, dryRunner, cronTriggers, cronRollbackWarning } from "./lib/deploy.mjs";

const dry = process.argv.includes("--dry-run");
const id = process.argv.slice(2).filter((a) => a !== "--dry-run")[0];

let steps;
try {
  steps = rollbackSteps(id);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

let crons = [];
try {
  crons = cronTriggers(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8"));
} catch {
  // No wrangler.toml beside the script: the warning still says what to do.
}
console.log(cronRollbackWarning(crons) + "\n");

const status = runSteps(steps, dry ? dryRunner : spawnRunner(loadEnv()));
if (status !== 0) process.exit(status);
if (dry) console.log("\nDry run: nothing was changed.");
else if (!id) console.log('\nTo go back to one of these: npm run rollback-worker -- <version id>');
else console.log("\nRolled back. Open https://wg-admin.clydeford.net to check.");
