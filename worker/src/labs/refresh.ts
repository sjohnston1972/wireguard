// labs/refresh.ts
//
// Plain English: re-reading a lab run from GitHub, so a missed callback heals
// (labs spec §7.4 step 1), as refreshActiveRun does for the gateway. A run
// GitHub never shows within 3 minutes failed to start; a run GitHub says
// finished but whose result never arrived is settled from GitHub's word
// after 2 minutes' grace (a destroy settled that way has no clean check, so
// its session goes back to failed and the watch tears it down again: the
// safe answer when Azure's state is unknown. It counts as one of the
// session's DESTROY_TRIES, so this cannot loop forever).

import type { Env } from "../env";
import { directNet, findLabRun, getGhRun, getSteps, type Net } from "./net";
import { getLabRun, updateRun, type LabRunDb } from "./store";
import { finishRun } from "./settle";

const MIN = 60_000;
/** GitHub has this long to show a dispatched run before it counts as never started. */
export const NEVER_STARTED_MS = 3 * MIN;
/** How long after GitHub says "done" the result callback has before GitHub's word settles the run. */
export const CALLBACK_GRACE_MS = 2 * MIN;

/** A lab run's steps only (one GitHub call), saved when they changed. */
export async function refreshLabSteps(env: Env, runId: string): Promise<void> {
  const run = await getLabRun(env, runId);
  if (!run?.github_run_id || run.finished_at) return;
  const steps = await getSteps(env, directNet(), run.github_run_id);
  const json = steps?.length ? JSON.stringify(steps) : null;
  if (json && json !== run.steps_json) await updateRun(env, run.id, { steps_json: json }, "finished_at IS NULL");
}

/** One run, from GitHub (at most 3 calls). Returns a line for the log, or null. */
export async function refreshLabRun(env: Env, run: LabRunDb, net: Net, now: Date, canNotify: () => boolean = () => true): Promise<string | null> {
  let ghId = run.github_run_id;
  if (!ghId) {
    const found = await findLabRun(env, net, run.id);
    if (!found) {
      if (now.getTime() - Date.parse(run.requested_at) <= NEVER_STARTED_MS) return null;
      await finishRun(env, run, { ok: false, error: "GitHub never started the lab workflow. Check the Actions tab and the GITHUB_TOKEN permissions.", via: "watch", canNotify }, now);
      return `${run.id}: GitHub never started it`;
    }
    ghId = found.id;
    await updateRun(env, run.id, { github_run_id: found.id, github_run_url: found.html_url, status: "running", started_at: run.started_at ?? found.created_at }, "finished_at IS NULL");
  }
  const gh = await getGhRun(env, net, ghId);
  if (gh?.status !== "completed" || gh.conclusion !== "success") {
    const steps = await getSteps(env, net, ghId);
    const json = steps?.length ? JSON.stringify(steps) : null;
    if (json && json !== run.steps_json) await updateRun(env, run.id, { steps_json: json });
  }
  if (gh?.status !== "completed") return null;
  const fresh = await getLabRun(env, run.id);
  if (!fresh || fresh.finished_at) return null;
  if (gh.conclusion === "success") {
    if (now.getTime() - Date.parse(gh.updated_at ?? gh.created_at) <= CALLBACK_GRACE_MS) return null;
    await finishRun(env, fresh, { ok: true, outputs: null, via: "GitHub's status (the result never arrived)", canNotify }, now);
    return `${run.id}: settled from GitHub (no result arrived)`;
  }
  await finishRun(env, fresh, { ok: false, error: `GitHub run finished with "${gh.conclusion}".`, via: "github", canNotify }, now);
  return `${run.id}: GitHub says ${gh.conclusion}`;
}
