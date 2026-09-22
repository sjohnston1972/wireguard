// scripts/deploy-worker.mjs   (npm run deploy-worker)
//
// Plain English: publishes the dashboard to Cloudflare. Uses the broad
// CLOUDFLARE_API_TOKEN from .env for wrangler (it never leaves this machine),
// applies any pending database migrations first, then deploys.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const shell = process.platform === "win32";
const wranglerEnv = { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID };

function run(args) {
  console.log(`$ wrangler ${args.join(" ")}`);
  const r = spawnSync("npx", ["wrangler", ...args], { stdio: "inherit", shell, env: wranglerEnv });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Stamp this build so browsers fetch fresh CSS and script after every deploy.
const build = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
writeFileSync("worker/src/build.ts", `// build.ts (rewritten by "npm run deploy-worker"; the value only needs to change per deploy)\nexport const BUILD = "${build}";\n`);
console.log(`build ${build}`);

run(["d1", "migrations", "apply", "wg-admin", "--remote"]);
run(["deploy"]);
console.log("\nDeployed. Open https://wg-admin.clydeford.net");
