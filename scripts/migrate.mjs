// scripts/migrate.mjs   (npm run migrate [-- --local])
//
// Plain English: creates or updates the dashboard's database tables. Safe to
// run repeatedly; only new migration files are applied. --local targets the
// on-disk database that "npm run dev" uses.

import { spawnSync } from "node:child_process";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const local = process.argv.includes("--local");
const shell = process.platform === "win32";
const r = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "wg-admin", local ? "--local" : "--remote"], {
  stdio: "inherit",
  shell,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID },
});
process.exit(r.status ?? 1);
