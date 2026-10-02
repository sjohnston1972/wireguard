// scripts/lib/deploy.mjs
//
// Plain English: what "npm run deploy-worker" and "npm run rollback-worker"
// do, as plain lists of commands, so the order can be tested without touching
// Cloudflare. The scripts hand each step to a runner: the real one starts it,
// a dry run only prints it.

import { spawnSync } from "node:child_process";

export const REPLACED_NOTE = "The version above is the one this deploy replaces: keep its id for a rollback.";

/**
 * Build the app, check its size, show the live version (the rollback target),
 * apply database migrations, publish. Spec section 3's order: build,
 * migrations, deploy.
 */
export function deploySteps() {
  return [
    ["npm", "run", "build:web"],
    ["npm", "run", "bundle-size"],
    ["wrangler", "deployments", "status"],
    ["wrangler", "d1", "migrations", "apply", "wg-admin", "--remote"],
    ["wrangler", "deploy"],
  ];
}

// A Worker version id, as "wrangler deployments list" prints it (a UUID).
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `wrangler rollback <id> --message <m> --yes` (flags as `wrangler rollback --help` prints them). */
export function rollbackArgs(id, message) {
  if (typeof id !== "string" || !VERSION_ID.test(id)) {
    throw new Error(`"${id}" is not a version id. Run "npm run rollback-worker" with no id to list them.`);
  }
  return ["wrangler", "rollback", id, "--message", message, "--yes"];
}

/**
 * "npm run dev" serves web/dist through wrangler's assets layer; on a fresh
 * checkout there is none yet, so it builds the app first.
 */
export function devBuildSteps(exists) {
  return exists("web/dist/index.html") ? [] : [["npm", "run", "build:web"]];
}

/** No id: list the recent versions and change nothing. An id: roll back to it. */
export function rollbackSteps(id) {
  if (!id) return [["wrangler", "deployments", "list"]];
  return [rollbackArgs(id, "switch-over rollback")];
}

/**
 * Runs each step with `run(step) -> exit status`, printing "$ step" first and
 * the rollback note after the status step. Stops at the first failure and
 * returns its status (0 when every step worked).
 */
export function runSteps(steps, run, log = console.log) {
  for (const step of steps) {
    log(`$ ${step.join(" ")}`);
    const status = run(step);
    if (status !== 0) return status ?? 1;
    if (step[0] === "wrangler" && step[1] === "deployments" && step[2] === "status") log(REPLACED_NOTE);
  }
  return 0;
}

/**
 * How to start a step: wrangler through npx (a devDependency; there is no
 * global wrangler) with the Cloudflare token from .env; npm steps without it.
 * On Windows the step goes through cmd.exe (npx and npm are .cmd files), which
 * Node hands the arguments joined by spaces, so one containing a space is quoted.
 */
export function toSpawn(step, dotEnv, baseEnv = process.env, windows = process.platform === "win32") {
  const quoted = windows ? step.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : step;
  const [tool, ...rest] = quoted;
  if (tool === "wrangler") {
    return {
      cmd: "npx",
      args: quoted,
      env: { ...baseEnv, CLOUDFLARE_API_TOKEN: dotEnv.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: dotEnv.CLOUDFLARE_ACCOUNT_ID },
    };
  }
  const env = { ...baseEnv };
  delete env.CLOUDFLARE_API_TOKEN;
  return { cmd: tool, args: rest, env };
}

/** The real runner: starts the step and waits, output straight to the terminal. */
export function spawnRunner(dotEnv) {
  return (step) => {
    const { cmd, args, env } = toSpawn(step, dotEnv);
    const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", env });
    return r.status ?? 1;
  };
}

/** A dry run's runner: the step is only printed (by runSteps). */
export const dryRunner = () => 0;
