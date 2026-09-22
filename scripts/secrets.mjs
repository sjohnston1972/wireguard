// scripts/secrets.mjs   (npm run secrets [-- --github|--worker|--dry-run])
//
// Plain English: pushes each value in .env to where it is needed.
//   - GitHub repository secrets, via the gh CLI you are already logged into.
//     Terraform in Actions reads these.
//   - Worker secrets, via wrangler. The Cloudflare Worker reads these (Phase 2).
//
// By default it does GitHub only until wrangler is installed. Nothing is ever
// printed except secret NAMES. With --dry-run it only shows what it would set.

import { execFileSync, spawnSync } from "node:child_process";
import { loadEnv } from "./lib/env.mjs";
import { buildGithubSecrets, buildWorkerSecrets } from "./lib/secrets-map.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const wantGithub = args.has("--github") || !args.has("--worker");
const wantWorker = args.has("--worker");

const env = loadEnv();

// gh is a real .exe so it runs without a shell (arguments stay exact, secret
// values are never re-parsed). wrangler is an npm .cmd shim on Windows and
// needs one; it only ever receives a fixed secret NAME, the value goes via stdin.
const WRANGLER_SHELL = process.platform === "win32";

function have(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: cmd === "wrangler" && WRANGLER_SHELL });
  return r.status === 0;
}

let failed = false;

// ── GitHub ──────────────────────────────────────────────────────────────────
if (wantGithub) {
  const { secrets, warnings, errors } = buildGithubSecrets(env);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (errors.length) {
    console.error("Cannot push GitHub secrets yet:");
    for (const e of errors) console.error(`  - ${e}`);
    failed = true;
  } else if (!have("gh")) {
    console.error("gh CLI not found. Install GitHub CLI and run: gh auth login");
    failed = true;
  } else {
    const repo = env.GITHUB_REPO;
    console.log(`GitHub secrets for ${repo}:`);
    for (const [name, value] of Object.entries(secrets)) {
      if (dryRun) {
        console.log(`  would set ${name}`);
        continue;
      }
      execFileSync("gh", ["secret", "set", name, "--repo", repo, "--body", value], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      console.log(`  set ${name}`);
    }
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────
if (wantWorker) {
  const { secrets, errors } = buildWorkerSecrets(env);
  if (errors.length) {
    console.error("Cannot push Worker secrets yet:");
    for (const e of errors) console.error(`  - ${e}`);
    failed = true;
  } else if (!have("wrangler")) {
    console.error("wrangler not found. Install with: npm i -g wrangler   then: wrangler login");
    failed = true;
  } else {
    console.log("Worker secrets:");
    for (const [name, value] of Object.entries(secrets)) {
      if (dryRun) {
        console.log(`  would set ${name}`);
        continue;
      }
      const r = spawnSync("wrangler", ["secret", "put", name], {
        input: value,
        stdio: ["pipe", "ignore", "inherit"],
        shell: WRANGLER_SHELL,
      });
      if (r.status !== 0) {
        console.error(`  FAILED ${name}`);
        failed = true;
      } else {
        console.log(`  set ${name}`);
      }
    }
  }
}

process.exit(failed ? 1 : 0);
