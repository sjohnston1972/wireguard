// scripts/dev.mjs   (npm run dev)
//
// Plain English: runs the dashboard on this machine at http://localhost:8787
// with login switched off (AUTH_DEV_BYPASS) and a local on-disk database.
// Secrets are read from .env so GitHub, Azure and DNS checks work for real.
// The first run applies the database migrations locally.
//
// The Worker's secrets are handed to wrangler in a .dev.vars file (git
// ignores it), written fresh from .env each time. They used to go on the
// command line, where any program on the PC could read them in the process
// list and Windows' cmd.exe could mangle values containing & or %. While
// .dev.vars exists, wrangler also stops loading the whole of .env by itself,
// so only the keys the Worker needs reach it.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { loadEnv, devVarsText } from "./lib/env.mjs";
import { WORKER_KEYS } from "./lib/secrets-map.mjs";

const env = loadEnv();
const shell = process.platform === "win32";
const port = process.env.PORT || "8787";

spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "wg-admin", "--local"], { stdio: "inherit", shell });

const vars = { AUTH_DEV_BYPASS: "1", PUBLIC_URL: `http://localhost:${port}` };
for (const k of WORKER_KEYS) {
  const v = env[k];
  if (v && !/^REPLACE_ME/.test(v)) vars[k] = v;
}
writeFileSync(".dev.vars", devVarsText(vars), { mode: 0o600 });

const args = ["wrangler", "dev", "--port", port, "--test-scheduled"];
console.log(`wrangler dev on http://localhost:${port} (login bypassed; cron test at /__scheduled)`);
const r = spawnSync("npx", args, { stdio: "inherit", shell, env: { ...process.env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID } });
process.exit(r.status ?? 0);
