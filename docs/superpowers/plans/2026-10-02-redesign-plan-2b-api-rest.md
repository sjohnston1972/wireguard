# Redesign plan 2b: JSON API, the rest (firewall, activity, cost, settings, push)

> **For agentic workers:** this plan is split into five independent areas (A–E), each built by its own implementer in its own git worktree, in parallel, under superpowers:test-driven-development. Each area brief gives the exact contract (routes, request and response shapes, what moves where, required tests). Write the code yourself, following the patterns plan 2a already established in `worker/src/api/*.ts`, `worker/src/clients.ts` and `worker/test/api-*.test.ts`. Read those first.

**Goal:** finish the `/api/v1` data API so it covers everything today's dashboard does, apart from firewall rule editing (drafts arrive with the Firewall view in plan 4).

**Architecture:** same as plan 2a: one Hono sub-app (`worker/src/api/`), one file per area registering its routes, domain logic in `worker/src/*.ts` shared with the old page routes, response types in `shared/api.ts`.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md` (sections 4, 8, 10, 11). Plan 2a: `docs/superpowers/plans/2026-10-02-redesign-plan-2a-api-core.md` (its Global Constraints apply here unchanged).

**Execution (Steven, 2026-10-02):** parallel subagents. No approval stops on the `redesign` branch. A fresh whole-branch review runs after the areas are merged together.

## Global Constraints (all areas)

Everything in plan 2a's Global Constraints, plus:

- **Base:** branch from `redesign` at commit `c8471ad` or later. Your branch is `feat/api-<area>` (`firewall`, `activity`, `cost`, `settings`, `push`).
- **Refusals:** use `worker/src/result.ts` (`Done<T>`, `Refusal`, `no(status, code, message, field?)`). An API route turns a `Refusal` into `fail(c, r.status, r.code, r.message, r.field)`.
- **Outside services:** a failure in Azure, GitHub or the push service that the person should see is `RunError(message, "upstream")`, which `statusFor` maps to 502. A change saved locally but refused outside answers 200 with `ApiOk.warning`.
- **Old routes:** when you move logic out of an old page route in `worker/src/index.ts`, that route must behave exactly as before: the same messages, redirects and HTML. Write a test that pins the old behaviour **before** you refactor, and watch it pass both before and after.
- **No secrets in any response:** no SSH password, token hashes or `payload_json` (strip them from run rows), and no push `endpoint`, `p256dh` or `auth`. Each area has a test that checks this on the serialised JSON.
- **Strict input:** wrong types answer 400 naming the field, with nothing written. Numbers must be JSON numbers, switches JSON booleans, ids positive integers (use `idParam` from `worker/src/api/clients.ts`).
- **Shared files, to keep merges clean:**
  - `worker/src/api/index.ts`: add exactly one import line and one `register<Area>(api);` line, directly after `registerClients(api);`, in area order A, B, C, D, E.
  - `shared/api.ts`: append your types at the end, under a comment line `// ── <Area name> ──`. Add type imports at the top only if needed, one per line.
  - `worker/test/harness.ts`: only area B may change it (adding a jobs-log answer).
- **Gate:** before you finish, `npm test` and `npm run typecheck` both pass, each run on its own with its exit code read. Commit in small steps with the attribution line (`Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV`), then push your branch. Do not open a PR or merge.
- **Report back:**
  - your branch name and final commit;
  - the test counts;
  - every place you departed from this brief, and why;
  - anything you could not do.

---

## Area A: Firewall (read, published ports, captures, counters)

**Owns:** `worker/src/fwview.ts` (new), `worker/src/published.ts` (new), `worker/src/api/firewall.ts` (new), `worker/test/api-firewall.test.ts` (new), and edits to `worker/src/firewall.ts`, `worker/src/capture.ts`, `worker/src/db.ts` (one new function), `worker/src/views/firewall.ts` and the firewall routes in `worker/src/index.ts`.

**Moves (old routes keep their behaviour):**
- **`appliedState` and `totalHits`** move from `views/firewall.ts` to `fwview.ts`:
  - `policyState(snap: Snapshot, hash: string): { state: "not_running" | "no_firewall" | "refused" | "applied" | "pending"; text: string }`, with the same texts as today;
  - `totalHits(snap, key)`, unchanged.
  - `views/firewall.ts` imports both and keeps `export { totalHits } from "../fwview";`, because `worker/test/firewall.test.ts` imports it from there. The view maps the states to its kinds: applied→up, pending→busy, refused→down, not_running/no_firewall→idle.
- **`syncPublished`** moves from `index.ts` to `published.ts`, unchanged.
- **Published-port checks** move into `firewall.ts` as `checkForward(raw, cfg): { ok: true; value: Omit<Forward, "id" | "enabled"> } | { ok: false; message: string; field: string }`. It uses the old route's exact messages and rules: name trimmed, at most 60 characters; proto `udp` or else `tcp`; target port defaults to the public port; reserved ports; target in the VNet or home LAN; allow-from as an IPv4 CIDR. The old `/firewall/forwards` route uses it and still says `Not published: <message>`.
- **The capture filter** moves into `capture.ts` as `captureFilter(env, who: string, extra: string): Promise<string>`, the old route's "client:<id> → host <ip> and (extra)" logic. The old route uses it.
- **New in `db.ts`:** `updateForward(env, id, patch: Partial<Omit<Forward, "id">>)`, a dynamic `UPDATE fw_forwards SET ...` like `updateRun`.
- **New in `fwview.ts`:** `dropsSince(env, sinceIso: string): Promise<number>` is `SELECT COALESCE(SUM(n), 0) FROM hist_drops WHERE t >= ?1`. It must be an index search; add a query-plan test like plan 1's.

**Routes:**
- **`GET /firewall`** → `FirewallResponse`:
  ```ts
  {
    now: string;
    running: boolean;
    defaultAction: "deny" | "allow";
    policy: { hash: string; state: PolicyState; text: string };
    rules: (FwRule & { place: number; fromLabel: string; toLabel: string; service: string; hits: [number, number] | null; lastHit: string | null; problem: string | null })[];
    defaultHits: [number, number] | null;
    defaultLastHit: string | null;
    countersClearedAt: string | null;
    drops: { recent: { at: string; src: string; dst: string; proto: string; dport: number | null; fromName: string; toName: string }[]; last24h: number };
    zones: { zone: Zone; label: string; v4: string[]; v6: string[]; negate: boolean }[];
    testVm: { ip: string | null; enabled: boolean };
    forwards: (Forward & { connections: [number, number] | null; lastHit: string | null })[];
    captures: Capture[];
    capture: { busy: boolean; ifaces: Record<string, string> };
    publicIp: string | null;
    dnsName: string;
    kpis: { rules: number; enabled: number; defaultAction: "deny" | "allow"; drops24h: number; published: number; captureBusy: boolean };
  }
  ```
  - `rules` come from `db.listFwRules` in order; `place` starts at 1.
  - Labels come from `endLabel` and `serviceLabel`; hits from `totalHits(snap, "r<id>")`, last hit from `snap.firewall.last_hit`. A problem comes from `compileFirewall(...).problems`, and the hash from the same call.
  - `drops.recent` is the snapshot's drops, newest first, with names mapped from client IPs (as `dropsTable` does today); `last24h` is `dropsSince(now - 24h)`.
  - `zones` covers all of `ZONE_LABEL` with `zoneAddrs`.
  - Forward connections are hits under `"f<id>"`.
- **`POST /firewall/forwards`**, body `{ name: string; proto: "tcp" | "udp"; public_port: number; target_ip: string; target_port?: number; allow_from?: string }`:
  - **Validation:** strict JSON types first (400 naming the field), then `checkForward` (400 with its field).
  - **Duplicate:** 409 `"<PROTO> <port> is already published."`
  - **On success:** the same alert and audit as the old route, then `syncPublished`. The answer is `ApiOk`, with `warning` if Azure refused.
- **`PUT /firewall/forwards/:id`**, body any of the POST fields plus `enabled: boolean`:
  - The body is merged onto the existing forward, then `checkForward` runs on the merged value.
  - Audit `firewall.forward.edit`, or `.enable` / `.disable` when only `enabled` changed. Then `syncPublished`.
  - 404 if the forward is missing.
- **`DELETE /firewall/forwards/:id`:** 404 if missing; otherwise audit `firewall.forward.delete`, then `syncPublished`. The answer is `ApiOk`.
- **`POST /firewall/captures`**, body `{ iface: string; who: "any" | number; filter?: string; seconds: number }`:
  - `iface` must be in `CAPTURE_IFACES` (400, field `iface`); `seconds` an integer from 5 to 300 (400).
  - A `who` that is a client id that does not exist is 404 (stricter than the old page, which silently captured everyone).
  - The filter must pass `validFilter` (400, field `filter`).
  - Otherwise `startCapture` runs (its RunErrors map through `statusFor`), with the same audit as the old route.
- **`POST /firewall/counters/clear`:** the same as the old route (clear, alert, audit). The answer is `ApiOk`.

**Required tests (each must fail first):**
- `GET /firewall` destroyed, then running after a heartbeat whose firewall report has counters and drops:
  - hits and `lastHit` per rule;
  - `last24h` counts the recorded drops;
  - `policy.state` moves from `pending` to `applied` when the report's hash matches.
- Every validation failure above names its field and writes nothing.
- Publish succeeds while destroyed, with no Azure call and no `warning`.
- Publish while running when Azure's NSG update fails: 200 with a `warning` (make the harness's Azure answer 404 by setting `world.azure.rg = false` after the deploy).
- A duplicate publish is 409.
- Edit merges, and a bad merged value is 400.
- Delete twice answers 200 then 404.
- A capture for an unknown client is 404; a capture while destroyed is 409 "Nothing is running.".
- The old `/firewall/forwards` route still answers `Not published: Give it a name.` for an empty name, pinned before the refactor.
- `dropsSince` uses the index.

---

## Area B: Activity and runs

**Owns:** `worker/src/activity.ts` (new), `worker/src/api/activity.ts` (new), `worker/test/api-activity.test.ts` (new), and edits to `worker/src/views/activity.ts` and `worker/test/harness.ts`.

**Moves:**
- `sessionCost`, `AUDIT_PAGE`, `AUDIT_KINDS`, `shortValue` and `describeChange` move from `views/activity.ts` to `activity.ts`.
- `views/activity.ts` re-exports `sessionCost`, `AUDIT_PAGE`, `AUDIT_KINDS` and `describeChange`, so `index.ts` and `views/cost.ts` keep working untouched.

**New in `activity.ts`:**
- `type ActivityRange = "1h" | "6h" | "24h" | "7d" | "30d"`, `ACTIVITY_RANGE_MS`, and the timeline bucket per range: 5 min, 30 min, 1 h, 6 h, 1 day.
- `interface RunRow`, a run without secrets:
  ```ts
  { id; action; status; requested_at; requested_by; started_at; finished_at; github_run_url; public_ip; reason; error; durationSeconds: number | null; sessionCostGbp: number | null; source: string }
  ```
  `source` is `reason`, or `"watchman"` when `requested_by === "watchman"`, else `"dashboard"`. Function `runRow(run, runs, cfg, now): RunRow`.
- `type EventType = "deploy" | "destroy" | "failure" | "config" | "firewall" | "watchman"`, and
  `interface ActivityEvent { at: string; type: EventType; title: string; detail: string | null; ref: { kind: "run" | "note" | "change"; id: string | number } }`.
  `eventsOf(runs, alerts, audit): ActivityEvent[]`, newest first:
  - **Runs:** a successful apply is `deploy`, a successful destroy is `destroy`, any other finished status is `failure`. Unfinished runs are left out.
  - **Notes:** kinds `deploy`, `destroy` and `session` are left out (the runs cover them); every other kind is `watchman`.
  - **Changes:** `firewall.*` is `firewall`; everything else is `config`.
- `timeline(events, range, now): { start: string; counts: Record<EventType, number> }[]`. One bucket per step covers the whole range, empty buckets included, oldest first.
- `activityKpis(runs, alerts, audit, range, now)` returns the following, each over runs requested, notes posted or changes made inside the range:
  ```ts
  {
    deploys: number;
    medianDeploySeconds: number | null;   // successful applies in the range
    successRate: { success: number; finished: number; pct: number | null };  // finished runs in the range
    failedRuns: number;
    configChanges: number;
    watchmanProblems: number;              // notes of kind failure, drift, cost_guard or unreachable
  }
  ```

**Routes:**
- **`GET /activity?range=24h&kind=&q=&page=`** → `ActivityResponse`:
  ```ts
  { range; now; kpis; timeline; runs: RunRow[]; notes: Alert[]; all: ActivityEvent[]; changes: { rows: (AuditEntry & { lines: string[] })[]; more: boolean; page: number; kind: string; q: string } }
  ```
  - `runs`, `notes` and `all` cover the range only (capped at 200).
  - `changes` uses the old page's paging and filter (`listAudit` with `AUDIT_PAGE`; `kind` must be one of `AUDIT_KINDS` values or it is treated as all). `lines` is `describeChange`.
  - Range defaults to `24h`; an invalid one is 400 (field `range`).
- **`GET /runs/:id`** → `{ run: RunRow; steps: Step[]; active: boolean }`. Steps come from `runs.steps_json`, or from the snapshot when this run is the active one; `[]` when unknown. 404 if missing.
- **`GET /runs/:id/log`** → `{ log: string }`:
  - 503 `not_configured` when GitHub isn't set up;
  - 404 `no_log` when the run has no GitHub id, no jobs, or GitHub has no log;
  - the first job's log through `getJobLogTail(env, jobId, 200_000)`; a thrown fetch error is `RunError(..., "upstream")`.

**Harness:** add `logs: Map<number, string>` to `World` (job id to text), and answer `GET /repos/.../actions/jobs/:id/logs` from it, or 404 when absent.

**Required tests:**
- KPIs and timeline over seeded runs, notes and changes at known offsets from now: buckets, counts, median, success rate, and `pct: null` when nothing finished.
- **No secrets:** `ssh_password`, both token hashes and `payload_json` are absent from the serialised `/activity` and `/runs/:id`.
- Change paging (`more` and the page size) and the kind filter.
- An invalid range is 400.
- Run steps come from `steps_json`.
- Log: found (from `world.logs`), `no_log` 404, and 503 without GitHub (`GITHUB_TOKEN: "REPLACE_ME"`).
- `index.ts`'s `/activity` page still renders (the existing tests stay green).

---

## Area C: Cost

**Owns:** `worker/src/costview.ts` (new), `worker/src/api/cost.ts` (new), `worker/test/api-cost.test.ts` (new).

**New in `costview.ts`:**
- `type CostRange = "month" | "7d" | "30d"`, and `costWindow(range, now): { from: string; to: string; prevFrom: string; prevTo: string }` as days (`YYYY-MM-DD`). `month` runs from the 1st to today, and the previous period is the same days of last month.
- `projection(days: CostDay[], now): { gbp: number; basis: string } | null`: null when this month has no Azure day yet; otherwise month-to-date actual ÷ days elapsed (today's day of month) × days in the month. The basis says so in plain words.
- `interface SessionRow { runId: string; started: string; ended: string | null; durationSeconds: number; region: string; vmSize: string; estimatedGbp: number; perHourGbp: number; stillRunning: boolean }` and `sessionsOf(runs, cfg, now): SessionRow[]`:
  - **Rows:** successful applies, newest first.
  - **End time:** the next successful destroy, else still running.
  - **Region and size:** from the payload, falling back to config. The payload itself is never returned.

**Route `GET /cost?range=month`** → `CostResponse`:
```ts
{
  now; range;
  meta: { currency: "GBP"; timezone: "Europe/London"; azureLagHours: 24; hourlyRateGbp: number; standbyRateGbp: number; asOfDay: string | null };
  session: { running: boolean; since: string | null; estimateGbp: number | null };
  standby: { since: string; perDayGbp: number } | null;
  monthToDate: number;   // budget.actual
  projection: { gbp: number; basis: string } | null;
  budget: BudgetStatus;
  daily: CostDay[];
  previous: CostDay[];
  sessions: SessionRow[];
  insights: string[];
}
```
- `asOfDay` is the `cost:fetched_day` KV value.
- `insights` holds only facts backed by data:
  - in Standby: `"Standby costs about £X a day for the disk and address."`;
  - budget level `warn` or `over`: the budget sentence.
- An invalid range is 400.

**Required tests:**
- Projection maths on seeded `cost_days` for a fixed `now`, and null with no days this month.
- The previous-period window.
- Sessions: end time, still running, and no `payload_json` / `ssh_password` in the serialised response.
- Standby insight.
- Invalid range.

---

## Area D: Settings and backups

**Owns:** `worker/src/api/settings.ts` (new), `worker/src/api/backup.ts` (new), `worker/test/api-settings.test.ts` (new), `worker/test/api-backup.test.ts` (new), and edits to `worker/src/settings.ts`, `worker/src/profiles.ts`, `worker/src/db.ts` (two new functions), `worker/src/backup.ts`, `worker/src/views/settings.ts` (only to import a moved constant), and the settings and backup routes in `worker/src/index.ts`.

**Moves:**
- **VM sizes:** `VM_SIZES = ["Standard_B1s", "Standard_B1ms", "Standard_B2s", "Standard_B2ats_v2"]` goes in `settings.ts`, and the settings view imports it.
- **Profile checks:** `profileProblem({ name, region, vm_size }): string | null` goes in `profiles.ts`, with the old route's regexes and `REGIONS`; the old route uses it.
- **Restore lock:** `restoreBlocked(env)` moves from `index.ts` to `backup.ts`, unchanged.
- **New in `db.ts`:** `updateProfile(env, id, patch: { name?; region?; vm_size? })` and `updateSchedule(env, id, patch: { days?; start_time?; end_time?; profile_id?; enabled? })`.

**Routes:**
- **`GET /settings`** → `SettingsResponse`:
  ```ts
  {
    values: Config-subset { region; vmSize; testVm; autoDestroyDefaultHours; expiryAction; standbyMaxDays; idleDestroyMinutes; monthlyBudgetGbp; hourlyRateGbp; standbyRateGbp; sshAllowedCidr; firewallDefault };
    overrides: Record<string, string>;
    overridable: string[];
    regions: Record<string, string>;
    vmSizes: string[];
    profiles: (Profile & { deployed: boolean })[];   // deployed: name === snapshot.profile while not destroyed
    schedules: (Schedule & { daysText: string; profileName: string | null })[];
    nextScheduledStart: string | null;
    setup: { group: string; missing: string[] }[];
    phones: { id: number; label: string | null; created_at: string; last_ok: string | null; last_error: string | null }[];
    webhook: boolean;
    repo: string | null;
    key: { publicKey: string | null; short: string; rotation: RotationStatus };
    backups: BackupStatus;   // fresh
    lock: { held: boolean; runId: string | null; since: string | null };
    vapidPublic: string | null;
    notifyError: { at: string; why: string } | null;
    publicUrl: string;
  }
  ```
- **`PUT /settings`**, body `Record<string, string | number | boolean>`:
  - An unknown key is 400 naming it.
  - Values are turned into strings (booleans become `"1"` / `"0"`) and **all** are checked against `OVERRIDABLE` before anything is saved; any failure is 400 naming the first bad key, with nothing saved.
  - Then `saveOverrides`, and audit `settings.save` with before and after. The answer is `ApiOk`.
- **Profiles:**
  - `POST /profiles { name, region, vmSize }`: `profileProblem` gives 400; a duplicate is 409; audit `profile.add`.
  - `PUT /profiles/:id`: any of those fields; the merged value goes through `profileProblem`; audit `profile.edit`; 404 if missing.
  - `DELETE /profiles/:id`: 404 if missing; audit `profile.delete`.
- **Schedules:**
  - `POST /schedules { days: number[] (1–7), start: "HH:MM", end: "HH:MM", profileId?: number | null }`: `validRule` gives 400 (field `days`, `start` or `end` as its message implies); a `profileId` that does not exist is 404; the same alert and audit as the old route.
  - `PUT /schedules/:id`: any of those fields plus `enabled: boolean`; checked on the merged value; audit `schedule.edit`, or `.enable` / `.disable`.
  - `DELETE /schedules/:id`.
- **`POST /lock/release`:** the same as the old route (release, audit, alert). The answer is `ApiOk`.
- **`GET /backup/export`:** the same answer as the old `/settings/backup/export` (an attachment).
- **`GET /backup/config/:day`:** the same as the old route.
- **`POST /backup/restore/preview`**, body: the export file's JSON object itself:
  - Over `MAX_RESTORE_BYTES` (by Content-Length or length of text) is 400.
  - `restoreBlocked` gives 409; `checkRestoreFile` returning a reason gives 400.
  - Otherwise the token is stored in KV for 15 minutes (as the old route does) and the answer is `{ token, exportedAt, file: counts, current: currentCounts, labels: TABLE_LABEL }`.
  - **Never echo the rows:** they include push keys.
- **`POST /backup/restore/confirm { token, confirm: "restore" }`:**
  - An unknown or expired token is 404 `expired`; a wrong word is 422 `confirm_required` (field `confirm`); blocked is 409; `applyRestore` throwing is 400 `"Nothing was changed: ..."`.
  - **On success:** delete the token; the same audit and alert as the old route; `syncPublished` (import it from `../published` if area A has merged, otherwise from `index.ts`'s current location; the integrator fixes the import).
  - The answer is `ApiOk`.

**Required tests:**
- `GET /settings` contains no push `endpoint` / `p256dh` / `auth`, and no secret values, in the serialised JSON (seed a push sub with recognisable strings).
- `PUT /settings`:
  - all-or-nothing (one bad key, nothing saved);
  - unknown key;
  - boolean conversion for `test_vm`.
- Profile create, edit and delete: validation, duplicate 409, 404.
- Schedule create and edit:
  - a bad window is 400;
  - a missing profile is 404;
  - enable and disable audit actions.
- Lock release.
- **Restore:**
  - the round trip (export → preview counts → confirm applies);
  - a wrong word is 422 and an expired token is 404;
  - blocked while a run is active is 409;
  - an oversized body is 400.
- Old routes:
  - `/settings/profiles` with a bad name still redirects to `/settings?err=profile`;
  - `/settings/backup/restore` still renders its page.

  Pin these before refactoring.

---

## Area E: Phone alerts (push)

**Owns:** `worker/src/pushsubs.ts` (new), `worker/src/api/push.ts` (new), `worker/test/api-push.test.ts` (new), and edits to the push routes in `worker/src/index.ts`.

**New in `pushsubs.ts`:** the old route logic as commands returning `Done<T>`, which the old routes then call. Keep the old routes' answers byte-for-byte: they are used by `worker/public/app.js` and `sw.js` today.
- **`subscribePhone(env, user, input: { endpoint?; keys?: { p256dh?; auth? }; label? }): Promise<Done<null>>`:**
  - the same checks as the old route (`isPushEndpoint`, key formats);
  - the same alert and audit;
  - a bad subscription is 400 `"That does not look like a push subscription."`.
- **`unsubscribePhone(env, user, endpoint: unknown): Promise<Done<null>>`.**
- **`phoneStatus(env, endpoint: string): Promise<{ registered: boolean; id: number | null; last_error: string | null; vapid: string | null }>`.**
- **`sendTestAlert(env): Promise<Done<{ phones: number }>>`:** clears `notify:last_error`, notifies, then reads `lastNotifyError`. An error is `no(502, "upstream", why)`.
- **`removePhone(env, user, id: number): Promise<Done<{ label: string }>>`:** 404 if missing; the same audit as the old route.

**Routes:**
- `POST /push/subscribe` → `ApiOk`.
- `POST /push/unsubscribe` → `ApiOk`.
- `GET /push/status?endpoint=` → the `phoneStatus` object.
- `POST /push/test` → `ApiOk`, message `"Test alert sent to N phone(s)."`.
- `DELETE /push/:id` → `ApiOk`.

**Required tests:**
- Subscribe:
  - valid (an `https://fcm.googleapis.com/...` endpoint with a p256dh of the right length and alphabet) → registered, with alert and audit;
  - invalid → 400, nothing stored.
- Status, registered and not.
- Unsubscribe.
- Delete: 200 then 404.
- The test alert reaches the ntfy stub (`world.notes` grows), and a notify failure answers 502.
- The old `/api/push/subscribe` and `/api/push/status` answers are unchanged, pinned before the refactor.
- No route ever returns `p256dh` or `auth`.

---

## Integration (after all five areas)

1. A branch `feat/api-rest` from `redesign` merges the five area branches in order A–E, resolving the shared-file conflicts by keeping both sides (registration order A–E, types appended in order).
2. `npm test` and `npm run typecheck` on the merged branch.
3. A fresh whole-branch review (most capable model) against this plan, the spec and the Review Focus below, then one fix pass (each fix with a failing test first).
4. A PR into `redesign` with CI green, then merge (standing approval).

## Review Focus

1. **Secrets:** run rows, restore previews, settings and push answers must not carry the SSH password, token hashes, run payloads, or push endpoint keys.
2. **Half-done changes:** a published port saved but refused by Azure, or a restore that fails mid-way. The person must be told exactly what happened (`warning`, 502 or 400 "Nothing was changed"), never a silent success.
3. **Old routes still serving the live dashboard:** firewall forwards and captures, settings profiles and schedules, backup and restore, and the push routes the service worker calls must behave exactly as before.
4. **All-or-nothing settings save:** one bad value must save nothing. The old page saves the good ones and rejects the bad; the API must not.
5. **Ranges and empty data:** the activity timeline and cost projection with no data must say "no data" (null, empty buckets), never 0 % success or a £0 forecast.
