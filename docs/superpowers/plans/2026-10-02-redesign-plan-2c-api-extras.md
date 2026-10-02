# Redesign plan 2c: backend for the mockup extras

> **For agentic workers:** four independent areas (F, G, H, J), each built by its own implementer in its own git worktree, in parallel, under superpowers:test-driven-development. Each brief gives the contract; you write the code, following the patterns of plans 2a and 2b (`worker/src/api/*.ts`, `worker/src/history.ts`, `worker/src/result.ts`, `worker/test/api-*.test.ts`). Read those first.

**Goal:** backend support for what Steven's mockups show and the API lacks: the firewall rule simulator, Azure's actual cost broken down by resource type and region, an on-demand health check, per-rule hit history with drop statistics, and previous-period comparisons for Activity.

**Spec:** `docs/superpowers/specs/2026-10-02-observability-redesign-design.md` (section 2 "Visual target" and section 8). The visual target is `redesign/screenshots/ChatGPT Image Oct 2, 2026, *.png`. These are local files, not in git; ask the integrator if you need a description of a screen.

**Moved to the Firewall view plan:** drag-to-reorder. It edits the firewall draft, which arrives with that plan.

## Global Constraints

- **Inherited:** plan 2b's Global Constraints apply unchanged (base branch, `result.ts`, upstream → 502 or `warning`, old routes unchanged, no secrets, strict input, the shared-file rules, the gate, the report).
- **Base:** branch from `redesign` at the commit the integrator names in your prompt. Your branch is `feat/api-<area>` (`simulator`, `costbreakdown`, `healthcheck`, `fwhistory`).
- **Migrations:** each new one gets the next free number. To avoid clashes, area G uses `0013_cost_breakdown.sql` and area J uses `0014_fw_history.sql`. Area H stores nothing new in D1; it uses the snapshot.
- **Write volume:** anything recorded per heartbeat follows plan 1's rules. Upsert into one-minute rows, write no row when nothing changed, `WITHOUT ROWID` tables, index-only reads in roll-up and expiry (prove it with a query-plan test), and fold into 5-minute summaries after 48 hours, kept for 30 days.

---

## Area F: Rule simulator

**Owns:** `worker/src/simulate.ts` (new), `worker/src/api/simulate.ts` (new), `worker/test/api-simulate.test.ts` (new).

**`simulate.ts`:** a pure function, `simulate(input, ctx): SimResult`.
- **Inputs:**
  - `input = { from: End; to: End; proto: "tcp" | "udp" | "icmp"; port: number | null }`, where `End = { kind: "any" | "zone" | "client" | "cidr"; value: string }`. These are the same end kinds the rules use (`worker/src/firewall.ts` `EndKind`).
  - `ctx = { rules: FwRule[]; defaultAction: "allow" | "deny"; cfg: Config; peers: Peer[] }`.
- **Evaluation:** in the VM's order: rules in `position` order, skipping disabled rules and rules with a compile problem (`ruleLines(...).problem`). The first matching rule wins, otherwise the default action.
- **Matching one side:**
  - Each end becomes IPv4 address sets via `endAddrs`, so it has the same meaning as the compiled firewall.
  - The flow's end **fully** matches when every address of the flow's set is inside the rule's set. Take `negate` ("the internet": everything except the private nets) into account.
  - The ends **partly** overlap when some but not all addresses are inside.
  - A rule matches when both ends fully match, its protocol covers the flow (`any`, or equal), and its ports cover the flow's port (blank means all; `parsePorts` syntax: lists and ranges).
- **Partial overlap:** when a rule would match only part of the flow (a partial end), it does **not** stop evaluation. It is recorded in `partial` so the screen can say "Depends on the exact address".
- **Result:**
  ```ts
  type SimResult = {
    verdict: "allow" | "deny";
    matched: { id: number; name: string; place: number } | null;   // null = the default
    reason: string;   // plain English, e.g. "Allowed by rule 3, Clients to home LAN." / "No rule matched; the default denies it."
    partial: { id: number; name: string; place: number }[];
    limited: string | null;   // e.g. "Published ports and replies to allowed connections are not simulated."
  };
  ```
- **The `limited` note** is set when the destination is the VM's public address or a published port's public port is involved. It is also set when `proto` is icmp (the VM allows ICMP echo to itself regardless). Look at `compileFirewall` for exactly what the VM always lets through, and say so.

**Route `POST /api/v1/firewall/simulate`**, body `{ from: End; to: End; proto; port?: number | null }` → `SimResult`, against the **live** rules and default.
- **Validation:** `kind` must be one of the four; a zone a key of `ZONE_LABEL`; a client a positive integer id that exists (404 otherwise); a cidr must pass `parseCidr` and be IPv4 (IPv6 gives 400 "IPv6 is not simulated yet"); a port an integer from 1 to 65535, only for tcp and udp. Failures are 400 naming the field (`from`, `to`, `proto`, `port`).
- **The Firewall view plan will add** `policy: "draft"` once drafts exist. For now, design the function so it takes the rule list as an argument.

**Required tests:**
- The starter rules from the migration: tunnel clients → home LAN TCP 22 is allowed by "Clients to the home LAN"; workloads → home LAN is denied by the default.
- A client end inside a zone rule is fully matched.
- A zone end against a single-client rule is partial, and evaluation continues.
- A disabled rule is skipped.
- Port lists and ranges.
- The internet zone with `negate`.
- Default allow versus deny.
- The validation 400s, and a missing client is 404.

---

## Area G: Azure cost breakdown by resource type and region

**Owns:** `worker/migrations/0013_cost_breakdown.sql` (new), edits to the Azure cost-pull code (find where `cost_days` is filled: `worker/src/azure.ts` and its caller in `worker/src/monitor.ts`), `worker/src/api/cost.ts` (extend `GET /cost`), `worker/test/api-costbreakdown.test.ts` (new).

**Store:** a table `cost_breakdown (day TEXT, category TEXT, location TEXT, gbp REAL, fetched_at TEXT, PRIMARY KEY (day, category, location)) WITHOUT ROWID`.

**Pull:** in the same daily pull that fills `cost_days`, a second Cost Management query.
- **The query:** the same scope, time frame and currency as the existing one, grouped by `ServiceName` (or `MeterCategory`) and `ResourceLocation`, daily granularity.
- **Storage:** results are upserted per day, category and location.
- **Categories map to the four the screen shows:**
  - **compute:** Virtual Machines.
  - **network:** Bandwidth, Virtual Network, IP addresses, Load Balancer.
  - **disk:** Storage, Managed Disks.
  - **other:** anything else.

  Keep the raw category too, and store the mapped one in a column or map it on read; choose one and say which.
- **Failure:** a failure here must not break the existing `cost_days` pull (try/catch, log, carry on).
- **Expiry:** delete breakdown rows older than 400 days (the cost page compares periods).

**`GET /cost` gains:**
```ts
breakdown: {
  byType: { type: "compute" | "network" | "disk" | "other"; gbp: number; pct: number }[];
  byRegion: { location: string; name: string; gbp: number; pct: number }[];
  basis: "azure" | "estimate";
  asOfDay: string | null;
} | null
```
- **Actual data:** taken from `cost_breakdown` over the selected range when any rows exist, with `basis: "azure"`.
- **Estimate:** when there are none, `byRegion` is built from the sessions' estimated cost per region and `byType` is empty, with `basis: "estimate"`.
- **Empty:** `null` when there are neither actuals nor sessions.
- **Region names:** `name` is `regionName(location)` where known.

**Harness:** the harness's Azure stub answers `CostManagement` queries with an empty result. Extend it so a test can supply rows for the grouped query (for example a `world.costRows` map), with the default behaviour unchanged.

**Required tests:**
- The pull stores grouped rows mapped to the four types, and is idempotent (running it twice gives the same rows).
- A failing breakdown query leaves `cost_days` filled.
- `GET /cost` breakdown for the range: percentages add up to 100 within rounding; `basis` is `azure` with rows, `estimate` from sessions without, and `null` with neither.
- Expiry.
- A query-plan test for the range read.

---

## Area H: On-demand health check (Worker and VM agent)

**Owns:** `worker/src/healthcheck.ts` (new), `worker/src/api/healthcheck.ts` (new), edits to `worker/src/runs.ts` (`handleAgent`, the reply side only, in the speed-test style), `worker/src/state.ts` (one new snapshot field), `infra/agent/wg-agent.sh`, `worker/test/api-healthcheck.test.ts` (new).

**How it works:** the same request and reply pattern as the speed test (look at `startSpeedTest`, `speedtest_req` and the `speedtest_result` handling in `handleAgent`).
- **Snapshot:** gains `selftest_req: { id: string; at: string } | null`, defaulting to null in `EMPTY`.
- **`requestHealthCheck(env): Promise<string>`:** throws `RunError("Nothing is running.")` unless running, and `RunError("A health check is already running.")` while one is pending. Otherwise it sets `selftest_req` and returns "Health check requested. The VM runs its self-test at its next heartbeat, within about 30 seconds."
- **`handleAgent`:**
  - while a request is pending, it adds `selftest: { id }` to its reply;
  - when the heartbeat's `selftest` result arrives with a matching `id` (or any `selftest.at` newer than the request), it clears the request;
  - the existing self-test handling records the result and posts the alert as it does at boot;
  - after 5 minutes with no result, the request is dropped and a `failure` note says the VM did not report.
- **`infra/agent/wg-agent.sh`:** when the heartbeat reply carries `selftest.id`, run the existing self-test script (`infra/agent/wg-selftest.sh`, the same one the boot service runs, in the background so the heartbeat is not delayed). Make the next heartbeat carry its result with that `id`. Read how the boot self-test result already reaches the heartbeat and reuse it; keep the change small. `bash -n` must pass.
- **Deployment:** the agent change reaches the VM only on a fresh deploy from `main`, so it is live only after switch-over. Until then a VM on the old agent ignores the request, and the 5-minute timeout tells the person so.
- **Route `POST /api/v1/health-check`** → `ApiOk` (409 via `statusFor` for the RunErrors). `GET /api/v1/overview` already returns the snapshot, so the pending request and the result are visible there.

**Required tests:**
- Request while destroyed is 409, while pending is 409.
- The heartbeat reply carries the request.
- A matching result clears it and records the self-test with its alert.
- The 5-minute timeout clears it with a failure note.
- The old boot self-test path is unchanged (the existing tests stay green).
- `bash -n infra/agent/wg-agent.sh` succeeds (run it from a test with `node:child_process`, or as a step the report quotes).

---

## Area J: Firewall hit history, drop statistics, previous-period comparisons

**Owns:**
- `worker/migrations/0014_fw_history.sql` (new);
- edits to `worker/src/history.ts` (record, roll up, read), `worker/src/runs.ts` (pass the counters to the recorder; the recorder call is already after the snapshot save);
- `worker/src/api/firewall.ts` (extend `GET /firewall`), `worker/src/api/activity.ts` (extend `GET /activity`), `worker/src/api/history.ts` (a new scope);
- `worker/test/api-fwhistory.test.ts` (new).

**Store:** `hist_fw (res INTEGER, t TEXT, rule TEXT, packets INTEGER, bytes INTEGER, PRIMARY KEY (res, t, rule)) WITHOUT ROWID`. `rule` is the counter key (`"r<id>"`, `"default"`, `"f<id>"`).

**Recording:**
- **When:** on every heartbeat with a firewall report, store each counter's increase since the previous report.
- **Counter resets:** the counters restart whenever the rule set changes or the VM reboots. Look at how `nextFirewall` and `fw_base` already handle that, and use the same reset rule: a counter that went down counts from zero.
- **Writes:** only for counters that went up, upserted into the minute (adding).
- **Housekeeping:** roll-up and expiry exactly as `hist_client`, inside the existing `rollUp` batch.

**`GET /firewall` gains:**
- per rule: `hits24h: number | null` (packets in the last 24 hours from `hist_fw`; null when no history at all) and `trend24h: number[]` (24 hourly packet counts, oldest first);
- the same for the default rule (`defaultHits24h`, `defaultTrend24h`);
- `drops` gains `uniqueSources24h: number` (distinct `src` in `hist_drops` over 24 hours), `previous24h: number` (the 24 hours before) and `hourly24h: number[]`;
- every rule row gains `starter: boolean`, true when the rule matches one of `STARTER_RULES` by name and ends. The mockup's "Custom / Default" filter needs it.

**`GET /history` gains `scope=rule&id=<counter key>`:** `{ range, step, from, to, points: { t; packets; bytes }[], latest }`, with the same ranges and steps as the other scopes.

**`GET /activity` gains `previous: ActivityKpis`:** the same KPIs for the equally long period just before the selected range, for the mockup's "vs yesterday" figures.

**Required tests:**
- **Recording:** the deltas, a counter reset counted from zero, no rows for unchanged counters, and roll-up and expiry with a query-plan test.
- **`GET /firewall`:** `hits24h`, `trend24h`, `uniqueSources24h`, `previous24h` and `starter` against seeded data.
- **History:** the rule scope, a 400 for an unknown key format, and empty data giving `points: []` (never zeros).
- **Activity:** `previous` over seeded runs.

---

## Integration

As in plan 2b:
1. Merge F, G, H, J onto a branch from `redesign`. Resolve the shared files by keeping both sides, and check the seams of `shared/api.ts`.
2. Run the full suite and typecheck.
3. Get one fresh whole-branch review on the most capable model, then do one fix pass with failing tests first.
4. Open a PR into `redesign` with CI green, then merge.

## Review Focus

1. **The simulator must agree with the VM.** Any flow the simulator calls allowed or denied must get the same answer from the compiled nftables rules, or carry a `partial` or `limited` note. Watch the edges: disabled and broken rules, the internet zone's negation, port ranges, the default.
2. **The health check must never interfere with the boot self-test** or delay a heartbeat; a VM on the old agent must time out cleanly.
3. **Cost breakdown failures must not break the existing cost pull.** Percentages must be honest, with no 0 % slices invented when there is no data.
4. **Hit history after counter resets** (rule change, reboot, rebuild): no negative or doubled hits, and nothing written when idle.
5. **The extra queries on the Firewall and Activity screens** must read by index and stay cheap at 30 days of history.
