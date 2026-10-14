# wg-admin on AWS (project 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** wg-admin can build its WireGuard headend in AWS (eu-west-2) as well as Azure, one cloud at a time, with every lifecycle feature Azure has today.

**Architecture:** A small cloud seam (`worker/src/cloud/`) sits between the Worker and the two clouds. The snapshot records which cloud the headend is in, and every power, firewall-edge or inventory call goes through the seam. AWS builds use their own Terraform root (`infra/aws/`) and workflow (`wg-aws.yml`). They share the cloud-init template and agent scripts with Azure. The big agent files reach an AWS VM as a token-protected "boot bundle" served by the Worker, because AWS caps user data at 16 KB. AWS logins are least-privilege: GitHub uses OIDC with no stored keys, and the Worker uses a narrow IAM user.

**Tech Stack:** Cloudflare Worker (Hono, D1, KV, R2, Durable Object), TypeScript, Vitest; `aws4fetch` for SigV4; Terraform ≥1.10 with `hashicorp/aws ~> 6.0` and `cloudflare ~> 5.0`; GitHub Actions; React + Vite dashboard.

**Spec:** `docs/superpowers/specs/2026-10-14-aws-vpn-design.md` (approved 2026-10-14). Executors read both.

## Global Constraints

- One headend at a time. Switching cloud needs `snapshot.state === "destroyed"`. Standby and failed both count as "something is deployed".
- AWS region `eu-west-2`. Instance `t4g.micro`, Ubuntu 24.04 arm64. Test VM `t4g.nano`.
- The AWS VPC reuses the Azure address plan: VPC `10.50.0.0/16`, headend subnet `10.50.1.0/24`, workload subnet `10.50.2.0/24`.
- Every AWS resource is tagged `wg-admin=vpn`. The headend instance and its security group also carry `wg-admin-role=headend`.
- The admin keys in `.env` (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, IAM user `claude`) **never** leave this machine. They must never go into GitHub secrets, Worker secrets, the repo, logs or a subagent brief. The Worker's own keys are named `AWS_WORKER_ACCESS_KEY_ID` / `AWS_WORKER_SECRET_ACCESS_KEY` and are set straight from Terraform output. They are never written to `.env`.
- Subagent briefs say "copy `.env.example`, never the real `.env`" (memory: subagent-env-rule). Only the controller session runs `scripts/aws-bootstrap.mjs`.
- Azure behaviour must not change. A missing `cloud` anywhere means Azure. An Azure dispatch payload has **no** `cloud` key, so it stays byte-identical to today.
- One monthly budget across clouds (`MONTHLY_BUDGET_GBP`, £10).
  - Cost Explorer is called at most once a day.
  - AWS figures are converted with `AWS_USD_GBP` (default 0.75).
- Demo mode never shows the cloud picker.
- Spend cap for live tests: **£3 combined Azure + AWS** (standing approval, memory: aws-autonomy). Stop and report anything unexpected.
- Testing cadence (memory: speed-preference): targeted tests while building, one full gate (`npm run typecheck && npm test`) at the end of each shipping task. CI covers the rest.
- Plain-English header comments on every new file, matching the repo's style (`// file.ts` then `// Plain English: …`).
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`. PR bodies end with `https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`.

### Deliberate deviations from the spec's wording (same behaviour)

- **The cloud lives on the `Snapshot`, not a D1 column.** There is no deployment table: live state is the RunLock snapshot. Each run's `payload_json` carries `cloud: "aws"` for AWS runs, so no migration is needed for it.
- **`worker/src/azure.ts` stays where it is.** `worker/src/cloud/azure.ts` is a thin adapter over it, so insights and labs keep their imports untouched.
- **AWS uses its own workflow file, `wg-aws.yml`, instead of a `cloud` input on `wg.yml`.** `wg.yml` and its pinning tests stay untouched, which removes all risk to Azure deploys. Both workflows share the same concurrency group.
- **The picker defaults to the last cloud deployed (`snapshot.cloud`), not a UI pref.** `ui_prefs` is CHECK-limited to page ids and would need a migration.
- **The firewall compiler keeps `eth0`.** On AWS, `wg-firewall-load.sh` rewrites `"eth0"` to the VM's real WAN interface, found from the default route. Azure rule text stays byte-identical.
- **`AWS_ENABLED` only hides the dashboard picker.** The API accepts `cloud: "aws"` whenever the AWS Worker keys are set, so the live test can run before the picker is shown.
- **The DNS record stays A-only, as on Azure today.** The spec's "(and the instance's IPv6)" is dropped to keep parity.
- **Scheduled starts (`schedule.ts`) keep deploying Azure.** Profiles are Azure regions.

## Review Focus

1. **A hibernated Azure headend after AWS is set up.** Resume, hibernate, drift and reconcile must all talk to Azure, because the cloud comes from the snapshot. Test: Task 7, "standby in Azure resumes through Azure with AWS configured".
2. **Deploying AWS while Azure is `failed`** (resources may be left behind) must be refused with "tear down first". If it were allowed, the failed-cleanup guard would look in the wrong cloud. Test: Task 7.
3. **AWS answers an error or throttles during the watchman's power refresh.** The view must return `error` and must not throw, and the snapshot must not change. Test: Task 6, "view reports an AWS error without throwing".
4. **Changing the SSH source on AWS must never leave port 22 closed.** Authorize the new rule before revoking the old. Test: Task 6, "adds the new SSH source before removing the old".
5. **A boot-bundle request with an older deploy's token answers 410.** With no bundle stored it answers 404, so curl retries rather than booting half-configured. Tests: Task 10.

---

## File map

| Path | Status | Responsibility |
|---|---|---|
| `worker/src/env.ts` | modify | `Cloud` type, AWS vars and secrets, `config().aws`, `canAws`, `ratesFor` |
| `worker/src/state.ts` | modify | `Snapshot.cloud`, `cloudOf` |
| `worker/src/cloud/index.ts` | create | `CloudOps` interface, `opsFor`, `headendOps` |
| `worker/src/cloud/azure.ts` | create | Azure adapter (wraps `../azure`) plus re-exports of the Azure cost pulls |
| `worker/src/cloud/awsApi.ts` | create | SigV4 calls (EC2 Query XML, JSON protocol), XML helpers, `AwsError` |
| `worker/src/cloud/aws.ts` | create | AWS adapter: view, inventory, power, SSH rule, published ports |
| `worker/src/cloud/awsCost.ts` | create | Cost Explorer daily pull |
| `worker/migrations/0023_aws_cost.sql` | create | `aws_cost_days` |
| `worker/src/{runs,standby,published,monitor,budget,github,oidc,profiles,activity,costview,index}.ts`, `worker/src/api/{lifecycle,overview,cost,settings,labs}.ts`, `worker/src/insights/runner.ts` | modify | go through the seam; per-cloud workflow and rates; boot bundle; guards |
| `worker/test/harness.ts` | modify | fake AWS (EC2, tagging, CE) |
| `worker/test/{cloud-seam,aws-api,aws-adapter,aws-cost,boot-bundle}.test.ts` | create | unit tests |
| `worker/test/lifecycle.test.ts` | modify | whole lifecycle once per cloud |
| `infra/cloud-init.yaml.tftpl`, `infra/test-vm.yaml.tftpl`, `infra/main.tf` | modify | cloud-neutral template variables |
| `infra/agent/*.sh` | modify | `WAN_IF`, AWS scheduled events, firewall WAN rewrite |
| `infra/aws/*.tf` | create | AWS headend root |
| `infra/aws-bootstrap/*.tf`, `scripts/aws-bootstrap.mjs` | create | one-off logins plus budget alarm |
| `infra/ci/{boot-bundle,aws-token,aws-safety-net}.sh` | create | workflow helpers |
| `.github/workflows/wg-aws.yml` | create | AWS apply and destroy |
| `scripts/tf-validate.mjs`, `.github/workflows/ci.yml`, `infra/ci/live-log.mjs`, `scripts/lib/secrets-map.mjs` | modify | validation, secret redaction, local-only keys |
| `scripts/test/{wg-aws-workflow,boot-bundle,agent-wan,tf-twins}.test.mjs` | create | static checks |
| `shared/api.ts` | modify | `Cloud`, `config.aws`, `CostResponse.byCloud`, `SettingsResponse.aws` |
| `web/src/views/overview/cloud.ts` | create | `cloudOf`, `cloudLabel`, `cloudFull` |
| `web/src/views/overview/actions.tsx`, `web/src/api/mutations.ts`, `web/src/shell/StateChip.tsx`, plus the copy files in Task 15 | modify | picker, badge, wording |
| `wrangler.toml`, `worker/src/demo/env.ts` | modify | AWS `[vars]` and `DEMO_VARS` |

---

## Phase A: the seam, Azure only (ships on its own)

### Task 1: Record the cloud on the snapshot

**Files:**
- Modify: `worker/src/env.ts` (add `Cloud`)
- Modify: `worker/src/state.ts:218-275` (`Snapshot`, `EMPTY`) and add `cloudOf`
- Modify: `worker/src/runs.ts` `startDeploy` (record `cloud: "azure"`)
- Modify: `shared/api.ts` (export `Cloud` the same way it already exposes `Snapshot`)
- Test: `worker/test/cloud-of.test.ts`

**Interfaces:**
- Produces: `type Cloud = "azure" | "aws"` (env.ts); `Snapshot.cloud: Cloud | null`; `cloudOf(snap: { cloud?: Cloud | null }): Cloud`

- [ ] **Step 0: Branch.** First merge the spec and plan PR: push `docs/aws-vpn-spec`, open the PR, then `gh pr merge --merge` once CI is green. Then:

```bash
git switch main && git pull && git switch -c feat/aws-seam
```

- [ ] **Step 1: Write the failing test** `worker/test/cloud-of.test.ts`

```ts
// Which cloud the headend is in: read from the snapshot, Azure when unsaid.
import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv } from "./harness";
import { cloudOf, getSnapshot, saveSnapshot } from "../src/state";
import { startDeploy } from "../src/runs";

afterEach(() => vi.unstubAllGlobals());

describe("cloudOf", () => {
  it("reads a fresh snapshot as Azure", async () => {
    const { env } = makeEnv();
    expect(cloudOf(await getSnapshot(env))).toBe("azure");
  });
  it("keeps the cloud a deploy recorded", async () => {
    const { env } = makeEnv();
    await saveSnapshot(env, { cloud: "aws" });
    expect(cloudOf(await getSnapshot(env))).toBe("aws");
  });
  it("reads a snapshot stored before the field existed as Azure", () => {
    expect(cloudOf({})).toBe("azure");
  });
  it("an Azure deploy records azure and sends no cloud key", async () => {
    const { env, world } = makeEnv();
    await startDeploy(env, { hours: 4, requesterIp: null, requestedBy: "steven" });
    expect((await getSnapshot(env)).cloud).toBe("azure");
    expect(world.dispatches[0].workflow).toBe("wg.yml");
    expect("cloud" in world.dispatches[0].payload).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run worker/test/cloud-of.test.ts`
Expected: FAIL. `cloudOf` is not exported, and `cloud` is not on `Snapshot`.

- [ ] **Step 3: Implement**

In `worker/src/env.ts`, above `export interface Env`:

```ts
/** Which cloud a headend lives in. A record without one is Azure (everything before AWS existed). */
export type Cloud = "azure" | "aws";
```

In `worker/src/state.ts`:
- Import `type Cloud` from `./env`.
- Add the field to `interface Snapshot` next to `region`:

```ts
  /** Which cloud this headend was built in. Kept after tear-down, so drift checks still look in the right place. Null on a fresh install: read it with cloudOf. */
  cloud: Cloud | null;
```

- Add `cloud: null,` to `EMPTY`.
- Add below `EMPTY`:

```ts
/** The headend's cloud. Anything stored before AWS existed has no cloud and is Azure. */
export function cloudOf(snap: { cloud?: Cloud | null }): Cloud {
  return snap.cloud ?? "azure";
}
```

In `worker/src/runs.ts` `startDeploy`, add `cloud: "azure"` to the `saveSnapshot` patch that sets `state: "deploying"` (fact sheet: runs.ts:96, step 6). Task 7 makes it `cloud`.

In `shared/api.ts`, add `Cloud` to the export that already brings `Snapshot` across from the worker. If `Snapshot` is imported from `../worker/src/state`, add `export type { Cloud } from "../worker/src/env";`.

- [ ] **Step 4: Run the test again**

Run: `npx vitest run worker/test/cloud-of.test.ts worker/test/lifecycle.test.ts worker/test/demo-schema.test.ts`
Expected: PASS. If a test builds a full `Snapshot` literal and now fails typecheck, add `cloud: null` to it.

- [ ] **Step 5: Commit**

```bash
git add worker/src/env.ts worker/src/state.ts worker/src/runs.ts shared/api.ts worker/test/cloud-of.test.ts
git commit -m "Snapshot records which cloud the headend is in (Azure when unsaid)"
```

### Task 2: The cloud seam and the Azure adapter

**Files:**
- Create: `worker/src/cloud/index.ts`, `worker/src/cloud/azure.ts`
- Modify: `worker/src/runs.ts` (52-54 `refreshInventory`, 505 `settleWithoutCallback`, 930-944 `detectDrift`, 956 `reconcile`)
- Modify: `worker/src/standby.ts` (35/44 `startHibernate`, 57/64 `startResume`, 87 `refreshPower`)
- Modify: `worker/src/published.ts:19`, `worker/src/monitor.ts` (40 import, 203-209, 273-298), `worker/src/api/lifecycle.ts:18,118`
- Test: `worker/test/cloud-seam.test.ts`

**Interfaces:**
- Consumes: `cloudOf`, `Cloud` (Task 1); `azureView`, `azureInventory`, `vmPower`, `setSshAllowedCidr`, `setPublishedPorts`, `costMonthToDate`, `costBreakdownMonthToDate`, `type AzureView` (worker/src/azure.ts); `canAzure` (env.ts:169); `type AzureInventory` (state.ts:49); `type PublishedNsgRule` (firewall.ts:86)
- Produces:

```ts
export type HeadendView = AzureView & { error?: string };
export type PowerOp = "hibernate" | "resume";
export interface CloudOps {
  id: Cloud;
  label: "Azure" | "AWS";
  configured(env: Env): boolean;
  view(env: Env): Promise<HeadendView>;          // never throws
  inventory(env: Env): Promise<AzureInventory>;  // never throws
  power(env: Env, op: PowerOp): Promise<void>;   // throws on refusal
  setSshAllowedCidr(env: Env, cidr: string): Promise<void>;
  setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void>;
}
export function opsFor(cloud: Cloud): CloudOps;
export async function headendOps(env: Env): Promise<CloudOps>;
```

The view keeps Azure's field names on purpose. `rg_exists` means "the headend's container exists" (the resource group, or AWS's tagged VPC). `power` uses Azure's words: `running`, `deallocated`, `deallocating`, `starting`. Callers and their tests stay unchanged.

- [ ] **Step 1: Write the failing test** `worker/test/cloud-seam.test.ts`

```ts
// The cloud seam: one door to whichever cloud the headend is in.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { makeEnv } from "./harness";
import { headendOps, opsFor } from "../src/cloud";
import { saveSnapshot } from "../src/state";

afterEach(() => vi.unstubAllGlobals());

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));

describe("cloud seam", () => {
  it("routes power to Azure for a snapshot with no cloud", async () => {
    const { env, world } = makeEnv();
    world.azure.rg = true;
    await (await headendOps(env)).power(env, "hibernate");
    await (await headendOps(env)).power(env, "resume");
    expect(world.powerCalls).toEqual(["deallocate", "start"]);
  });
  it("names the cloud for messages", () => {
    expect(opsFor("azure").label).toBe("Azure");
  });
  it("the Azure view is the same as before", async () => {
    const { env, world } = makeEnv();
    world.azure.rg = true;
    world.azure.power = "deallocated";
    await saveSnapshot(env, { cloud: "azure" });
    const v = await (await headendOps(env)).view(env);
    expect(v).toMatchObject({ rg_exists: true, vm_exists: true, power: "deallocated", public_ip: "20.0.0.10" });
  });
  it("only the seam, insights and labs import azure.ts", () => {
    const root = join(process.cwd(), "worker", "src");
    const offenders = walk(root)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => relative(root, f).split(sep).join("/"))
      .filter((f) => !/^(cloud|insights|labs)\//.test(f) && f !== "azure.ts")
      .filter((f) => /from "\.{1,2}\/(\.\.\/)?azure"/.test(readFileSync(join(root, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run worker/test/cloud-seam.test.ts`
Expected: FAIL with "Cannot find module '../src/cloud'".

- [ ] **Step 3: Create `worker/src/cloud/index.ts`**

```ts
// cloud/index.ts
//
// Plain English: the one door the rest of the Worker uses to touch the
// headend's cloud. Which cloud answers depends on where the headend was built
// (the snapshot's cloud), never on a global setting, so a hibernated Azure
// headend is still woken through Azure after AWS is set up. Like a router
// config that names the uplink per interface rather than assuming one.

import type { Cloud, Env } from "../env";
import type { AzureInventory } from "../state";
import { cloudOf, getSnapshot } from "../state";
import type { PublishedNsgRule } from "../firewall";
import type { AzureView } from "../azure";
import { azureOps } from "./azure";

/** What exists right now. Azure's field names: rg_exists means "the headend's container exists" (resource group, or AWS's tagged VPC). */
export type HeadendView = AzureView & { error?: string };
export type PowerOp = "hibernate" | "resume";

export interface CloudOps {
  id: Cloud;
  label: "Azure" | "AWS";
  /** Are this cloud's Worker credentials set? */
  configured(env: Env): boolean;
  /** Never throws; a failed check comes back with `error`. */
  view(env: Env): Promise<HeadendView>;
  /** Never throws; a failed check comes back with `error`. */
  inventory(env: Env): Promise<AzureInventory>;
  /** Hibernate = stop paying for compute, keep disk and address. Throws when the cloud refuses. */
  power(env: Env, op: PowerOp): Promise<void>;
  /** Point the SSH rule at one source. Throws when the cloud refuses. */
  setSshAllowedCidr(env: Env, cidr: string): Promise<void>;
  /** Make the edge's published-port rules exactly these. Throws when the cloud refuses. */
  setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void>;
}

const OPS: Partial<Record<Cloud, CloudOps>> = { azure: azureOps };

export function opsFor(cloud: Cloud): CloudOps {
  const ops = OPS[cloud];
  if (!ops) throw new Error(`No adapter for ${cloud}`);
  return ops;
}

/** The adapter for wherever the headend is (or was last built). */
export async function headendOps(env: Env): Promise<CloudOps> {
  return opsFor(cloudOf(await getSnapshot(env)));
}
```

- [ ] **Step 4: Create `worker/src/cloud/azure.ts`**

```ts
// cloud/azure.ts
//
// Plain English: the Azure side of the cloud door. Everything real lives in
// ../azure.ts (insights and labs use it too); this only maps the door's words
// onto it: hibernate = deallocate, resume = start.

import { canAzure } from "../env";
import { azureView, azureInventory, vmPower, setSshAllowedCidr, setPublishedPorts } from "../azure";
import type { CloudOps } from "./index";

export { costMonthToDate, costBreakdownMonthToDate } from "../azure";

export const azureOps: CloudOps = {
  id: "azure",
  label: "Azure",
  configured: canAzure,
  view: azureView,
  inventory: azureInventory,
  power: (env, op) => vmPower(env, op === "hibernate" ? "deallocate" : "start"),
  setSshAllowedCidr,
  setPublishedPorts,
};
```

- [ ] **Step 5: Switch the callers.** Read each function before editing. Keep behaviour identical, and change only where the calls go.

| File / function | Before | After |
|---|---|---|
| `runs.ts` `refreshInventory` | `if (!canAzure(env)) return; const azure = await azureInventory(env);` | `const c = await headendOps(env); if (!c.configured(env)) return; const azure = await c.inventory(env);` The snapshot field stays `azure`; add the comment `// the headend's inventory, whichever cloud`. |
| `runs.ts` `settleWithoutCallback` | `if (canAzure(env)) ip = (await azureView(env)).public_ip;` | `const c = await headendOps(env); if (c.configured(env)) ip = (await c.view(env)).public_ip;` |
| `runs.ts` `detectDrift` | `if (!canAzure(env)) return null; const az = await azureView(env);` | `const c = await headendOps(env); if (!c.configured(env)) return null; const az = await c.view(env);` Drift messages that say "Azure" use `${c.label}`. |
| `runs.ts` `reconcile` | `canAzure(env) ? await azureView(env) : null`; "Cannot reach Azure to reconcile." | `c.configured(env) ? await c.view(env) : null`; `` `Cannot reach ${c.label} to reconcile.` `` |
| `standby.ts` `startHibernate` | `canAzure` guard; `vmPower(env, "deallocate")` | `const c = await headendOps(env);` guard `c.configured(env)` (the message names `c.label`); `c.power(env, "hibernate")` |
| `standby.ts` `startResume` | `vmPower(env, "start")` | `c.power(env, "resume")` (same guard pattern) |
| `standby.ts` `refreshPower` | `azureView(env)` | `(await headendOps(env)).view(env)` |
| `published.ts` `syncPublished` | `setPublishedPorts(env, …)` | `(await headendOps(env)).setPublishedPorts(env, …)` |
| `monitor.ts` 3c | `snap.state === "failed" && canAzure(env)` then `azureView(env)` | `const c = opsFor(cloudOf(snap)); if (snap.state === "failed" && c.configured(env)) { const az = await c.view(env); … }` |
| `monitor.ts` import | `import { costMonthToDate, costBreakdownMonthToDate, azureView } from "./azure"` | `import { costMonthToDate, costBreakdownMonthToDate } from "./cloud/azure"` (the step-6 cost pull stays Azure) |
| `api/lifecycle.ts` `/allow-ssh` | `setSshAllowedCidr(c.env, …)`; "Azure did not accept the change: …" | `const ops = await headendOps(c.env); await ops.setSshAllowedCidr(c.env, …)`; `` `${ops.label} did not accept the change: …` `` |

Remove the now-unused imports of `../azure` / `./azure` and `canAzure` from those files.

- [ ] **Step 6: Run the targeted tests**

Run: `npx vitest run worker/test/cloud-seam.test.ts worker/test/lifecycle.test.ts worker/test/appliance.test.ts worker/test/monitor*.test.ts worker/test/standby*.test.ts`
Expected: PASS (use the globs that exist). Then `npx tsc -p tsconfig.json --noEmit` should show no errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/cloud worker/src/runs.ts worker/src/standby.ts worker/src/published.ts worker/src/monitor.ts worker/src/api/lifecycle.ts worker/test/cloud-seam.test.ts
git commit -m "Cloud seam: headend power, edge rules and inventory go through one door (Azure only so far)"
```

### Task 3: Ship Phase A and prove Azure on the live site

**Files:** none new.

- [ ] **Step 1: Full gate.** Run `npm run typecheck && npm test`. Expected: everything passes. Fix anything before continuing.
- [ ] **Step 2: PR.**

```bash
git push -u origin feat/aws-seam
gh pr create --title "Cloud seam (Azure only, no behaviour change)" --body "First step of AWS support (spec docs/superpowers/specs/2026-10-14-aws-vpn-design.md §10.1). Azure calls for power, edge rules and inventory now go through worker/src/cloud/. No behaviour change.

https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
gh pr checks --watch
gh pr merge --merge
git switch main && git pull
```

- [ ] **Step 3: Deploy.** Run `npm run deploy-worker`. Record the new Worker version id and the previous one (the rollback) in memory `golive-versions.md`.
- [ ] **Step 4: Live Azure cycle.** Use the method used for earlier live tests (memory `wg-admin-project.md`; otherwise Claude in Chrome on https://wg-admin.clydeford.net).
  1. Deploy for 1 h. Wait for the "Ready" state, with the self-test passing.
  2. Hibernate. Wait for Standby.
  3. Resume. Wait for Running and a fresh heartbeat.
  4. Tear down. Wait for Destroyed.

  Expected: each step completes, and no drift flag appears. Spend is about £0.05. If anything fails, roll back with `npm run rollback-worker` and stop: this is "something unexpected".

---

## Phase B: AWS logins and safety net

### Task 4: AWS bootstrap (logins, OIDC provider, budget alarm)

**Files:**
- Create: `infra/aws-bootstrap/{backend.tf,main.tf,variables.tf,outputs.tf}`, `scripts/aws-bootstrap.mjs`
- Modify: `scripts/lib/secrets-map.mjs` (`LOCAL_ONLY`), `scripts/tf-validate.mjs`
- Test: `scripts/test/secrets-map.test.mjs` (extend the existing file; create it if absent)

**Interfaces:**
- Produces:
  - GitHub secret `AWS_DEPLOY_ROLE_ARN`
  - Worker secrets `AWS_WORKER_ACCESS_KEY_ID` and `AWS_WORKER_SECRET_ACCESS_KEY`
  - IAM role `wg-admin-deploy` and IAM user `wg-admin-worker`
  - AWS budget `wg-admin-guard`

- [ ] **Step 1: Branch.** `git switch -c feat/aws-headend` (from the updated `main`). Every task from here to Task 15 commits on this branch.

- [ ] **Step 2: Failing test.** Add to `scripts/test/secrets-map.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_MAP, OPTIONAL_GITHUB_MAP, WORKER_KEYS, LOCAL_ONLY } from "../lib/secrets-map.mjs";

test("the AWS admin keys never leave this machine", () => {
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"]) {
    assert.ok(LOCAL_ONLY.includes(k), `${k} must be LOCAL_ONLY`);
    assert.ok(!(k in GITHUB_MAP) && !(k in OPTIONAL_GITHUB_MAP) && !WORKER_KEYS.includes(k), `${k} must not be pushed`);
  }
});
```

Run: `node --test scripts/test/secrets-map.test.mjs`. Expected: FAIL (they are not in `LOCAL_ONLY`).

- [ ] **Step 3:** In `scripts/lib/secrets-map.mjs`, change `LOCAL_ONLY` to `["CLOUDFLARE_API_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"]`. Re-run the test. Expected: PASS.

- [ ] **Step 4: Write `infra/aws-bootstrap/backend.tf`**

```hcl
# backend.tf
#
# Plain English: the bootstrap's own state, in the same R2 bucket as the
# headend's, under its own key. Credentials come from a -backend-config file
# written by scripts/aws-bootstrap.mjs, never from AWS_* variables (those are
# the admin keys, for the AWS provider only).

terraform {
  backend "s3" {
    key                         = "wg-admin/aws-bootstrap/terraform.tfstate"
    region                      = "auto"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
```

- [ ] **Step 5: Write `infra/aws-bootstrap/variables.tf`**

```hcl
# variables.tf (aws-bootstrap)

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "github_repo" {
  description = "owner/name. Only this repo's main branch may assume the deploy role."
  type        = string
  default     = "sjohnston1972/wireguard"
}

variable "alert_email" {
  description = "Where the AWS budget alarm emails. Taken from CF_ACCESS_ALLOWED_EMAIL by the bootstrap script."
  type        = string
}

variable "budget_usd" {
  description = "Account-wide monthly alarm, in dollars (AWS Budgets only counts in USD). 19 USD is about 15 GBP."
  type        = string
  default     = "19"
}
```

- [ ] **Step 6: Write `infra/aws-bootstrap/main.tf`**

```hcl
# main.tf (aws-bootstrap)
#
# Plain English: the one-off setup that lets wg-admin use AWS without ever
# holding the admin keys. Run once from Steven's machine (scripts/aws-bootstrap.mjs).
#   - GitHub Actions gets a role it can assume with its own signed identity
#     (OIDC). No AWS keys are stored in GitHub at all.
#   - The Worker gets a small IAM user that can only look, start/stop the
#     wg-admin server, edit its firewall rules and read cost.
#   - A budget alarm emails if the whole account passes ~15 GBP in a month,
#     whatever wg-admin itself believes.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { project = "wg-admin", "wg-admin" = "bootstrap" }
  }
}

data "aws_caller_identity" "me" {}

locals {
  account = data.aws_caller_identity.me.account_id
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "deploy" {
  name                 = "wg-admin-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "wg-admin-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Ec2InTheRegion"
        Effect    = "Allow"
        Action    = ["ec2:*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid      = "ReadTags"
        Effect   = "Allow"
        Action   = ["tag:GetResources", "sts:GetCallerIdentity"]
        Resource = "*"
      },
      {
        Sid    = "OnlyWgAdminThings"
        Effect = "Deny"
        Action = [
          "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:ModifyInstanceAttribute",
          "ec2:DeleteVolume", "ec2:DeleteVpc", "ec2:DeleteSecurityGroup", "ec2:ReleaseAddress",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
    ]
  })
}

resource "aws_iam_user" "worker" {
  name = "wg-admin-worker"
}

resource "aws_iam_access_key" "worker" {
  user = aws_iam_user.worker.name
}

resource "aws_iam_user_policy" "worker" {
  name = "wg-admin-worker"
  user = aws_iam_user.worker.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Look"
        Effect    = "Allow"
        Action    = ["ec2:DescribeInstances", "ec2:DescribeVpcs", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeAddresses"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid       = "PowerOurServer"
        Effect    = "Allow"
        Action    = ["ec2:StartInstances", "ec2:StopInstances"]
        Resource  = "arn:aws:ec2:${var.region}:${local.account}:instance/*"
        Condition = { StringEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
      {
        Sid       = "EdgeRules"
        Effect    = "Allow"
        Action    = ["ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress"]
        Resource  = "arn:aws:ec2:${var.region}:${local.account}:security-group/*"
        Condition = { StringEquals = { "aws:ResourceTag/wg-admin" = "vpn" } }
      },
      {
        Sid      = "InventoryAndCost"
        Effect   = "Allow"
        Action   = ["tag:GetResources", "ce:GetCostAndUsage"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_budgets_budget" "guard" {
  name         = "wg-admin-guard"
  budget_type  = "COST"
  limit_amount = var.budget_usd
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}
```

- [ ] **Step 7: Write `infra/aws-bootstrap/outputs.tf`**

```hcl
# outputs.tf (aws-bootstrap). The script pipes these straight into gh and wrangler; they are never printed.

output "account_id" {
  value = local.account
}

output "deploy_role_arn" {
  value = aws_iam_role.deploy.arn
}

output "worker_access_key_id" {
  value     = aws_iam_access_key.worker.id
  sensitive = true
}

output "worker_secret_access_key" {
  value     = aws_iam_access_key.worker.secret
  sensitive = true
}
```

- [ ] **Step 8: Write `scripts/aws-bootstrap.mjs`**

```js
// scripts/aws-bootstrap.mjs   (node scripts/aws-bootstrap.mjs)
//
// Plain English: the one-off AWS setup, run from Steven's machine only.
// Uses the admin keys in .env (never copied anywhere) to create wg-admin's
// own narrow logins, then hands them to GitHub and the Worker:
//   GitHub secret AWS_DEPLOY_ROLE_ARN       (a role name, not a key)
//   Worker secrets AWS_WORKER_ACCESS_KEY_ID / AWS_WORKER_SECRET_ACCESS_KEY
// Values go in through stdin; only names are printed. Safe to run again.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCESS_ALLOWED_EMAIL"]) {
  if (!env[k]) throw new Error(`.env is missing ${k}`);
}
const dir = "infra/aws-bootstrap";
const tfEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: "eu-west-2",
  TF_VAR_alert_email: env.CF_ACCESS_ALLOWED_EMAIL,
  TF_IN_AUTOMATION: "1",
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: opts.input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], input: opts.input, env: opts.env ?? tfEnv, shell: opts.shell ?? false, encoding: "utf8" });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args[0]} failed`);
  return r;
}
function out(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { env: opts.env ?? tfEnv, encoding: "utf8", shell: opts.shell ?? false });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || "").slice(0, 300)}`);
  return r.stdout;
}

// The R2 keys go to the state backend in a file, so they never meet the AWS provider's variables.
const tmp = mkdtempSync(join(tmpdir(), "wg-aws-"));
const backend = join(tmp, "r2.hcl");
writeFileSync(backend, `bucket = "${env.R2_BUCKET}"\naccess_key = "${env.R2_ACCESS_KEY_ID}"\nsecret_key = "${env.R2_SECRET_ACCESS_KEY}"\nendpoints = { s3 = "https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" }\n`, { mode: 0o600 });
try {
  run("terraform", [`-chdir=${dir}`, "init", "-reconfigure", "-input=false", "-no-color", `-backend-config=${backend}`]);

  // An account that already trusts GitHub keeps its provider: adopt it rather than fail.
  const acct = out("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"]).trim();
  const providers = out("aws", ["iam", "list-open-id-connect-providers", "--output", "text"]);
  const arn = `arn:aws:iam::${acct}:oidc-provider/token.actions.githubusercontent.com`;
  const inState = spawnSync("terraform", [`-chdir=${dir}`, "state", "list"], { env: tfEnv, encoding: "utf8" }).stdout ?? "";
  if (providers.includes(arn) && !inState.includes("aws_iam_openid_connect_provider.github")) {
    run("terraform", [`-chdir=${dir}`, "import", "-input=false", "-no-color", "aws_iam_openid_connect_provider.github", arn]);
  }

  run("terraform", [`-chdir=${dir}`, "apply", "-auto-approve", "-input=false", "-no-color"]);
  const o = JSON.parse(out("terraform", [`-chdir=${dir}`, "output", "-json"]));

  run("gh", ["secret", "set", "AWS_DEPLOY_ROLE_ARN"], { input: o.deploy_role_arn.value, env: process.env });
  console.log("GitHub secret set: AWS_DEPLOY_ROLE_ARN");
  const wranglerShell = process.platform === "win32";
  for (const [name, value] of [["AWS_WORKER_ACCESS_KEY_ID", o.worker_access_key_id.value], ["AWS_WORKER_SECRET_ACCESS_KEY", o.worker_secret_access_key.value]]) {
    run("npx", ["wrangler", "secret", "put", name], { input: value, env: process.env, shell: wranglerShell });
    console.log(`Worker secret set: ${name}`);
  }

  // Cost Explorer answers only once it is enabled on the account.
  const today = new Date().toISOString().slice(0, 10);
  const first = `${today.slice(0, 8)}01`;
  const ce = spawnSync("aws", ["ce", "get-cost-and-usage", "--region", "us-east-1", "--time-period", `Start=${first === today ? "2026-01-01" : first},End=${today}`, "--granularity", "MONTHLY", "--metrics", "UnblendedCost", "--output", "text"], { env: tfEnv, encoding: "utf8" });
  console.log(ce.status === 0 ? "Cost Explorer: answering" : `Cost Explorer: NOT answering (${(ce.stderr || "").trim().slice(0, 200)}). Enable it in the AWS console (Billing > Cost Explorer).`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 9: Extend `scripts/tf-validate.mjs`** to validate every root. Replace the `opts` and `run` lines with:

```js
const ROOTS = ["infra", "infra/aws", "infra/aws-bootstrap"];

function run(cwd, args) {
  console.log(`$ (${cwd}) terraform ${args.join(" ")}`);
  const r = spawnSync("terraform", args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("infra", ["fmt", "-check", "-recursive", "-diff"]);
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  run(root, ["init", "-backend=false", "-input=false", "-no-color"]);
  run(root, ["validate", "-no-color"]);
}
console.log("Terraform OK");
```

Add `import { existsSync } from "node:fs";`. `infra/aws` does not exist until Task 12; the guard skips it until then.

- [ ] **Step 10:** Run `npm run tf-validate`. Expected: "Terraform OK".
- [ ] **Step 11: Apply it.** Controller session only, never a subagent. Run `node scripts/aws-bootstrap.mjs`.
  - Expected: "GitHub secret set: AWS_DEPLOY_ROLE_ARN", two "Worker secret set" lines, and "Cost Explorer: answering".
  - If Cost Explorer is not answering, note it in the PR description. The daily pull then fails quietly with a note until it is enabled. That is not a blocker.
- [ ] **Step 12: Verify with read-only checks.**

```bash
aws iam get-role --role-name wg-admin-deploy --query Role.Arn --output text
aws iam list-attached-user-policies --user-name wg-admin-worker
aws iam list-user-policies --user-name wg-admin-worker
aws budgets describe-budgets --account-id "$(aws sts get-caller-identity --query Account --output text)" --query 'Budgets[].BudgetName'
gh secret list | grep AWS_DEPLOY_ROLE_ARN
```

Expected:
- the role ARN prints
- the worker user lists exactly one inline policy, `wg-admin-worker`
- the budget list contains `wg-admin-guard`
- the GitHub secret is listed

- [ ] **Step 13: Commit**

```bash
git add infra/aws-bootstrap scripts/aws-bootstrap.mjs scripts/lib/secrets-map.mjs scripts/tf-validate.mjs scripts/test/secrets-map.test.mjs
git commit -m "AWS bootstrap: GitHub OIDC deploy role, narrow Worker user, account budget alarm"
```

Add `infra/aws-bootstrap/.terraform/` to `.gitignore` if `infra/.terraform` is not already covered by a pattern. Do commit `infra/aws-bootstrap/.terraform.lock.hcl`.

---

## Phase C: the Worker speaks AWS

### Task 5: Signed AWS calls and XML helpers

**Files:**
- Modify: `package.json` (devDependencies: `"aws4fetch": "1.0.20"`), then run `npm install`
- Modify: `worker/src/env.ts` (AWS vars, secrets, `config().aws`, `canAws`)
- Modify: `wrangler.toml` `[vars]`, `worker/src/demo/env.ts` `DEMO_VARS`
- Create: `worker/src/cloud/awsApi.ts`
- Test: `worker/test/aws-api.test.ts`

**Interfaces:**
- Produces:

```ts
// env.ts
interface Env {
  AWS_ENABLED?: string;
  AWS_REGION?: string;
  AWS_INSTANCE_TYPE?: string;
  AWS_HOURLY_RATE_GBP?: string;
  AWS_STANDBY_RATE_GBP?: string;
  AWS_USD_GBP?: string;
  GITHUB_WORKFLOW_AWS?: string;
  AWS_WORKER_ACCESS_KEY_ID?: string;
  AWS_WORKER_SECRET_ACCESS_KEY?: string;
}
interface Config {
  aws: { enabled: boolean; region: string; instanceType: string; hourlyRateGbp: number; standbyRateGbp: number; usdToGbp: number; workflow: string };
}
function canAws(env: Env): boolean;

// cloud/awsApi.ts
class AwsError extends Error { code: string; status: number }
function ec2(env: Env, action: string, params?: Record<string, string>): Promise<string>;  // XML text
function awsJson<T>(env: Env, o: { service: string; region: string; host: string; target: string; body: unknown }): Promise<T>;
function filters(list: [string, string[]][]): Record<string, string>;
function xmlFirst(xml: string, tag: string): string | null;
function xmlAll(xml: string, tag: string): string[];
function xmlRecords(xml: string, firstTag: string): string[];
```

- [ ] **Step 1: Failing test** `worker/test/aws-api.test.ts`

```ts
// Signed AWS calls: the request shape and the error mapping.
import { describe, it, expect, afterEach, vi } from "vitest";
import { ec2, awsJson, filters, xmlFirst, xmlAll, xmlRecords, AwsError } from "../src/cloud/awsApi";
import { canAws, config, type Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());
const env = { AWS_WORKER_ACCESS_KEY_ID: "AKIDTEST", AWS_WORKER_SECRET_ACCESS_KEY: "secret" } as unknown as Env;

describe("config", () => {
  it("defaults AWS to London, t4g.micro, hidden", () => {
    expect(config({} as Env).aws).toEqual({ enabled: false, region: "eu-west-2", instanceType: "t4g.micro", hourlyRateGbp: 0.011, standbyRateGbp: 0.005, usdToGbp: 0.75, workflow: "wg-aws.yml" });
  });
  it("canAws needs both worker keys, not placeholders", () => {
    expect(canAws(env)).toBe(true);
    expect(canAws({ AWS_WORKER_ACCESS_KEY_ID: "AKID" } as Env)).toBe(false);
    expect(canAws({ AWS_WORKER_ACCESS_KEY_ID: "REPLACE_ME", AWS_WORKER_SECRET_ACCESS_KEY: "x" } as Env)).toBe(false);
  });
});

describe("Query API helpers", () => {
  it("flattens filters", () => {
    expect(filters([["tag:wg-admin", ["vpn"]], ["instance-state-name", ["running", "stopped"]]])).toEqual({
      "Filter.1.Name": "tag:wg-admin", "Filter.1.Value.1": "vpn",
      "Filter.2.Name": "instance-state-name", "Filter.2.Value.1": "running", "Filter.2.Value.2": "stopped",
    });
  });
  it("reads XML fields and decodes entities", () => {
    const x = "<a><name>one &amp; two</name><name>three</name></a>";
    expect(xmlFirst(x, "name")).toBe("one & two");
    expect(xmlAll(x, "name")).toEqual(["one & two", "three"]);
    expect(xmlFirst(x, "missing")).toBeNull();
  });
  it("cuts a list into records at each first field", () => {
    const x = "<set><item><id>a</id><v>1</v></item><item><id>b</id><v>2</v></item></set>";
    expect(xmlRecords(x, "id").map((r) => xmlFirst(r, "v"))).toEqual(["1", "2"]);
  });
});

describe("ec2", () => {
  it("signs a POST to the regional endpoint with the Query API body", async () => {
    let seen: Request | null = null;
    vi.stubGlobal("fetch", async (input: Request) => {
      seen = input;
      return new Response("<DescribeVpcsResponse><vpcSet/></DescribeVpcsResponse>", { status: 200 });
    });
    const xml = await ec2(env, "DescribeVpcs", filters([["tag:wg-admin", ["vpn"]]]));
    expect(xml).toContain("DescribeVpcsResponse");
    expect(seen!.url).toBe("https://ec2.eu-west-2.amazonaws.com/");
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-2\/ec2\/aws4_request/);
    const body = new URLSearchParams(await seen!.text());
    expect(body.get("Action")).toBe("DescribeVpcs");
    expect(body.get("Version")).toBe("2016-11-15");
    expect(body.get("Filter.1.Name")).toBe("tag:wg-admin");
  });
  it("turns an EC2 error document into AwsError", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized</Message></Error></Errors></Response>", { status: 403 }));
    await expect(ec2(env, "StopInstances", { "InstanceId.1": "i-1" })).rejects.toMatchObject({ code: "UnauthorizedOperation", status: 403 });
  });
});

describe("awsJson", () => {
  it("sends the target header and maps __type errors", async () => {
    vi.stubGlobal("fetch", async (input: Request) => {
      expect(input.headers.get("x-amz-target")).toBe("ResourceGroupsTaggingAPI_20170126.GetResources");
      return new Response(JSON.stringify({ __type: "com.amazon#ThrottlingException", message: "Rate exceeded" }), { status: 400 });
    });
    const p = awsJson(env, { service: "tagging", region: "eu-west-2", host: "tagging.eu-west-2.amazonaws.com", target: "ResourceGroupsTaggingAPI_20170126.GetResources", body: {} });
    await expect(p).rejects.toBeInstanceOf(AwsError);
    await expect(p).rejects.toMatchObject({ code: "ThrottlingException", message: "Rate exceeded" });
  });
});
```

Run: `npx vitest run worker/test/aws-api.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 2: env.ts.** Add the fields above to `Env`:
  - plain settings next to the `AZURE_*` vars, each with a one-line comment
  - secrets next to the `AZURE_*` secrets, with the comment `// AWS: the Worker's own narrow IAM user (infra/aws-bootstrap). Never the admin keys.`

  Add `aws` to `Config`, and to `config(env)`:

```ts
    aws: {
      enabled: env.AWS_ENABLED === "1",
      region: env.AWS_REGION || "eu-west-2",
      instanceType: env.AWS_INSTANCE_TYPE || "t4g.micro",
      hourlyRateGbp: num(env.AWS_HOURLY_RATE_GBP, 0.011),
      standbyRateGbp: num(env.AWS_STANDBY_RATE_GBP, 0.005),
      usdToGbp: num(env.AWS_USD_GBP, 0.75),
      workflow: env.GITHUB_WORKFLOW_AWS || "wg-aws.yml",
    },
```

Below `canAzure`:

```ts
/** Are the Worker's AWS keys set? (Optional: without them AWS simply is not offered.) */
export function canAws(env: Env): boolean {
  const ok = (v?: string) => !!v && !/^REPLACE_ME/.test(v);
  return ok(env.AWS_WORKER_ACCESS_KEY_ID) && ok(env.AWS_WORKER_SECRET_ACCESS_KEY);
}
```

  Do **not** add AWS to `SECRET_GROUPS`, because AWS is optional.

- [ ] **Step 3: `wrangler.toml` `[vars]`.** Add these after the Azure block, and add the same keys to `DEMO_VARS` in `worker/src/demo/env.ts`:

```toml
# AWS (optional second cloud). AWS_ENABLED="1" shows it in the Deploy picker.
AWS_ENABLED = "0"
AWS_REGION = "eu-west-2"
AWS_INSTANCE_TYPE = "t4g.micro"
AWS_HOURLY_RATE_GBP = "0.011"
AWS_STANDBY_RATE_GBP = "0.005"
AWS_USD_GBP = "0.75"
GITHUB_WORKFLOW_AWS = "wg-aws.yml"
```

If `wrangler.toml` repeats `[vars]` under `[env.*]` sections, add the keys there too. `worker/test/demo-env.test.ts` checks this.

- [ ] **Step 4: Create `worker/src/cloud/awsApi.ts`**

```ts
// cloud/awsApi.ts
//
// Plain English: how the Worker talks to AWS. Every call is signed (SigV4)
// with the Worker's own narrow IAM user. EC2 answers in XML; tagging and
// Cost Explorer answer in JSON. We only ever need a handful of fields, so
// the XML is read with small, strict helpers rather than a full parser
// (Workers have no DOMParser).

import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { config } from "../env";

/** An AWS refusal: its error code ("UnauthorizedOperation", "ThrottlingException", ...) and HTTP status. */
export class AwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function client(env: Env, service: string, region: string): AwsClient {
  return new AwsClient({
    accessKeyId: env.AWS_WORKER_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AWS_WORKER_SECRET_ACCESS_KEY ?? "",
    service,
    region,
  });
}

/** One EC2 Query API call. `params` use the Query API's flat names (Filter.1.Name, InstanceId.1, ...). Returns the XML. */
export async function ec2(env: Env, action: string, params: Record<string, string> = {}): Promise<string> {
  const region = config(env).aws.region;
  const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params });
  const r = await client(env, "ec2", region).fetch(`https://ec2.${region}.amazonaws.com/`, {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
  });
  const text = await r.text();
  if (!r.ok) throw new AwsError(xmlFirst(text, "Code") ?? `HTTP${r.status}`, xmlFirst(text, "Message") ?? `EC2 ${action} failed (${r.status})`, r.status);
  return text;
}

/** One JSON-protocol call (tagging, Cost Explorer). */
export async function awsJson<T>(env: Env, o: { service: string; region: string; host: string; target: string; body: unknown }): Promise<T> {
  const r = await client(env, o.service, o.region).fetch(`https://${o.host}/`, {
    method: "POST",
    body: JSON.stringify(o.body),
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": o.target },
  });
  const text = await r.text();
  if (!r.ok) {
    let code = `HTTP${r.status}`;
    let message = `${o.target} failed (${r.status})`;
    try {
      const j = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
      if (j.__type) code = j.__type.split("#").pop() ?? code;
      message = j.message ?? j.Message ?? message;
    } catch {
      /* not JSON: keep the generic message */
    }
    throw new AwsError(code, message, r.status);
  }
  return JSON.parse(text) as T;
}

/** [["tag:wg-admin", ["vpn"]]] -> { "Filter.1.Name": "tag:wg-admin", "Filter.1.Value.1": "vpn" } */
export function filters(list: [string, string[]][]): Record<string, string> {
  const out: Record<string, string> = {};
  list.forEach(([name, values], i) => {
    out[`Filter.${i + 1}.Name`] = name;
    values.forEach((v, j) => (out[`Filter.${i + 1}.Value.${j + 1}`] = v));
  });
  return out;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The text of the first <tag>…</tag> (no nested elements), or null. */
export function xmlFirst(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decode(m[1]) : null;
}

/** The text of every <tag>…</tag> (no nested elements). */
export function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => decode(m[1]));
}

/** One chunk per record, cut where each record's first field starts. Read fields with xmlFirst on a chunk. */
export function xmlRecords(xml: string, firstTag: string): string[] {
  return xml.split(`<${firstTag}>`).slice(1).map((s) => `<${firstTag}>${s}`);
}
```

- [ ] **Step 5: Run the tests.** Run `npx vitest run worker/test/aws-api.test.ts worker/test/demo-env.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json worker/src/env.ts worker/src/cloud/awsApi.ts worker/test/aws-api.test.ts wrangler.toml worker/src/demo/env.ts
git commit -m "AWS: signed EC2/tagging/Cost Explorer calls, AWS settings (hidden by default)"
```

### Task 6: The AWS adapter, and a fake AWS in the harness

**Files:**
- Create: `worker/src/cloud/aws.ts`
- Modify: `worker/src/cloud/index.ts` (register `awsOps`)
- Modify: `worker/test/harness.ts` (fake AWS; `Request` inputs; per-workflow run listing; DNS answers for AWS)
- Test: `worker/test/aws-adapter.test.ts`

**Interfaces:**
- Consumes: `ec2`, `awsJson`, `filters`, `xmlFirst`, `xmlRecords`, `AwsError` (Task 5); `CloudOps` (Task 2)
- Produces:
  - `awsOps: CloudOps`
  - `World.aws: { exists: boolean; state: "running" | "stopped" | "stopping" | "pending"; ip: string; sg: FakeSgRule[]; nextRule: number }`
  - `FakeSgRule = { id: string; protocol: string; port: number; cidr: string; description: string }`
  - The fake pushes `"deallocate"` / `"start"` onto `world.powerCalls` for `StopInstances` / `StartInstances`, so lifecycle assertions are shared with Azure.
  - `makeEnv()` sets `AWS_WORKER_ACCESS_KEY_ID: "k"`, `AWS_WORKER_SECRET_ACCESS_KEY: "s"`.

- [ ] **Step 1: Harness changes** in `worker/test/harness.ts`.

  1. At the top of the `vi.stubGlobal("fetch", …)` callback, replace the `url` and `method` lines with:

```ts
    const req = typeof input === "object" && "url" in input && !(input instanceof URL) ? (input as Request) : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const bodyText = async () => (init?.body != null ? String(init.body) : req ? await req.clone().text() : "");
```

  2. In the GitHub run listing, list a workflow's own runs. A run without `workflow` is `wg.yml`'s:

```ts
      if (listed) {
        const wf = decodeURIComponent(listed[1]);
        return json({ workflow_runs: [...world.ghRuns.values()].filter((r) => (r.workflow ?? "wg.yml") === wf).reverse() });
      }
```

  3. Add to `World`:

```ts
  /** AWS: the tagged VPC and server exist, its state, Elastic IP, and the server's security-group ingress rules. */
  aws: { exists: boolean; state: "running" | "stopped" | "stopping" | "pending"; ip: string; sg: FakeSgRule[]; nextRule: number };
  /** Test-only: Cost Explorer's daily rows (USD). Unset: it answers empty. */
  awsCost?: { day: string; usd: number }[];
  /** Test-only: when set, every EC2 call answers this error code (HTTP 400). */
  awsFail?: string;
```

  with `export interface FakeSgRule { id: string; protocol: string; port: number; cidr: string; description: string }`. Default the field to `aws: { exists: false, state: "running", ip: "18.130.0.10", sg: [], nextRule: 1 }`, and add `AWS_WORKER_ACCESS_KEY_ID: "k", AWS_WORKER_SECRET_ACCESS_KEY: "s",` to the default env.

  4. In the `cloudflare-dns.com` branch, answer `world.aws.ip` when `world.aws.exists` (and keep `world.azure.ip` when `world.azure.rg`).

  5. Add the AWS hosts before the final `throw new Error("unexpected fetch …")`:

```ts
    // AWS: EC2 (Query API, XML), tagging and Cost Explorer (JSON).
    if (/^ec2\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) {
      const p = new URLSearchParams(await bodyText());
      const action = p.get("Action") ?? "";
      if (world.awsFail) return new Response(`<Response><Errors><Error><Code>${world.awsFail}</Code><Message>fake failure</Message></Error></Errors></Response>`, { status: 400 });
      const xml = (b: string) => new Response(`<${action}Response>${b}</${action}Response>`, { status: 200 });
      const a = world.aws;
      const headendAsked = [...p.entries()].some(([k, v]) => k.endsWith(".Name") && v === "tag:wg-admin-role");
      switch (action) {
        case "DescribeVpcs":
          return xml(a.exists ? "<vpcSet><item><vpcId>vpc-1</vpcId></item></vpcSet>" : "<vpcSet/>");
        case "DescribeInstances":
          return xml(a.exists ? `<reservationSet><item><instancesSet><item><instanceId>i-0abc</instanceId><instanceType>t4g.micro</instanceType><instanceState><code>16</code><name>${a.state}</name></instanceState><privateIpAddress>10.50.1.4</privateIpAddress>${a.state === "running" ? `<ipAddress>${a.ip}</ipAddress>` : ""}</item></instancesSet></item></reservationSet>` : "<reservationSet/>");
        case "DescribeAddresses":
          return xml(a.exists ? `<addressesSet><item><publicIp>${a.ip}</publicIp><allocationId>eipalloc-1</allocationId></item></addressesSet>` : "<addressesSet/>");
        case "DescribeSecurityGroups":
          return xml(a.exists && headendAsked ? "<securityGroupInfo><item><groupId>sg-wg</groupId></item></securityGroupInfo>" : "<securityGroupInfo/>");
        case "DescribeSecurityGroupRules":
          return xml(`<securityGroupRuleSet>${a.sg.map((r) => `<item><securityGroupRuleId>${r.id}</securityGroupRuleId><groupId>sg-wg</groupId><isEgress>false</isEgress><ipProtocol>${r.protocol}</ipProtocol><fromPort>${r.port}</fromPort><toPort>${r.port}</toPort><cidrIpv4>${r.cidr}</cidrIpv4><description>${r.description}</description></item>`).join("")}</securityGroupRuleSet>`);
        case "AuthorizeSecurityGroupIngress": {
          const rule = { id: `sgr-${a.nextRule++}`, protocol: p.get("IpPermissions.1.IpProtocol")!, port: Number(p.get("IpPermissions.1.FromPort")), cidr: p.get("IpPermissions.1.IpRanges.1.CidrIp")!, description: p.get("IpPermissions.1.IpRanges.1.Description") ?? "" };
          if (a.sg.some((r) => r.protocol === rule.protocol && r.port === rule.port && r.cidr === rule.cidr)) return new Response("<Response><Errors><Error><Code>InvalidPermission.Duplicate</Code><Message>dup</Message></Error></Errors></Response>", { status: 400 });
          a.sg.push(rule);
          return xml("<return>true</return>");
        }
        case "RevokeSecurityGroupIngress": {
          const gone = [...p.entries()].filter(([k]) => k.startsWith("SecurityGroupRuleId.")).map(([, v]) => v);
          a.sg = a.sg.filter((r) => !gone.includes(r.id));
          return xml("<return>true</return>");
        }
        case "StopInstances":
          world.powerCalls.push("deallocate");
          return xml("<instancesSet/>");
        case "StartInstances":
          world.powerCalls.push("start");
          return xml("<instancesSet/>");
      }
      return new Response(`<Response><Errors><Error><Code>InvalidAction</Code><Message>${action}</Message></Error></Errors></Response>`, { status: 400 });
    }
    if (/^tagging\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) {
      const arns = world.aws.exists
        ? ["vpc/vpc-1", "subnet/subnet-1", "security-group/sg-wg", "instance/i-0abc", "elastic-ip/eipalloc-1", "volume/vol-1"].map((r) => `arn:aws:ec2:eu-west-2:123456789012:${r}`)
        : [];
      return json({ ResourceTagMappingList: arns.map((ResourceARN) => ({ ResourceARN, Tags: [{ Key: "wg-admin", Value: "vpn" }] })), PaginationToken: "" });
    }
    if (u.hostname === "ce.us-east-1.amazonaws.com") {
      return json({ ResultsByTime: (world.awsCost ?? []).map((r) => ({ TimePeriod: { Start: r.day }, Total: { UnblendedCost: { Amount: String(r.usd), Unit: "USD" } } })) });
    }
```

- [ ] **Step 2: Failing test** `worker/test/aws-adapter.test.ts`

```ts
// The AWS adapter, against the harness's fake AWS.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";
import { opsFor } from "../src/cloud";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
  world.aws.exists = true;
});
afterEach(() => vi.unstubAllGlobals());
const aws = () => opsFor("aws");

describe("view", () => {
  it("running server: running, with its address", async () => {
    expect(await aws().view(env)).toMatchObject({ rg_exists: true, vm_exists: true, power: "running", public_ip: "18.130.0.10" });
  });
  it("stopped server reads as deallocated, like Azure", async () => {
    world.aws.state = "stopped";
    expect((await aws().view(env)).power).toBe("deallocated");
  });
  it("nothing built: nothing exists", async () => {
    world.aws.exists = false;
    expect(await aws().view(env)).toMatchObject({ rg_exists: false, vm_exists: false, power: null, public_ip: null });
  });
  it("view reports an AWS error without throwing", async () => {
    world.awsFail = "RequestLimitExceeded";
    const v = await aws().view(env);
    expect(v.error).toMatch(/fake failure/);
    expect(v.rg_exists).toBe(false);
  });
});

describe("power", () => {
  it("hibernate stops the server, resume starts it", async () => {
    await aws().power(env, "hibernate");
    await aws().power(env, "resume");
    expect(world.powerCalls).toEqual(["deallocate", "start"]);
  });
  it("says AWS refused, with the code", async () => {
    world.awsFail = "UnauthorizedOperation";
    await expect(aws().power(env, "hibernate")).rejects.toThrow(/AWS .*UnauthorizedOperation/);
  });
});

describe("SSH rule", () => {
  it("adds the new SSH source before removing the old", async () => {
    world.aws.sg = [{ id: "sgr-old", protocol: "tcp", port: 22, cidr: "203.0.113.1/32", description: "ssh-from-home" }];
    const order: string[] = [];
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (i: Request, init?: RequestInit) => {
      const body = typeof i === "object" && "clone" in i ? await i.clone().text() : String(init?.body ?? "");
      const a = new URLSearchParams(body).get("Action");
      if (a === "AuthorizeSecurityGroupIngress" || a === "RevokeSecurityGroupIngress") order.push(a);
      return real(i, init);
    });
    await aws().setSshAllowedCidr(env, "198.51.100.7/32");
    expect(order).toEqual(["AuthorizeSecurityGroupIngress", "RevokeSecurityGroupIngress"]);
    expect(world.aws.sg.map((r) => r.cidr)).toEqual(["198.51.100.7/32"]);
  });
  it("does nothing when the rule is already right", async () => {
    world.aws.sg = [{ id: "sgr-1", protocol: "tcp", port: 22, cidr: "198.51.100.7/32", description: "ssh-from-home" }];
    await aws().setSshAllowedCidr(env, "198.51.100.7/32");
    expect(world.aws.sg.map((r) => r.id)).toEqual(["sgr-1"]);
  });
});

describe("published ports", () => {
  it("adds missing rules, drops stale ones, leaves the rest", async () => {
    world.aws.sg = [
      { id: "sgr-wg", protocol: "udp", port: 51820, cidr: "0.0.0.0/0", description: "wireguard" },
      { id: "sgr-80", protocol: "tcp", port: 80, cidr: "0.0.0.0/0", description: "published-tcp-80" },
      { id: "sgr-25", protocol: "tcp", port: 25, cidr: "0.0.0.0/0", description: "published-tcp-25" },
    ];
    await aws().setPublishedPorts(env, [
      { name: "published-tcp-80", protocol: "Tcp", port: "80", source: "*" },
      { name: "published-udp-53", protocol: "Udp", port: "53", source: "192.0.2.0/24" },
    ]);
    expect(world.aws.sg.map((r) => `${r.description}:${r.cidr}`).sort()).toEqual(["published-tcp-80:0.0.0.0/0", "published-udp-53:192.0.2.0/24", "wireguard:0.0.0.0/0"]);
  });
  it("makes no calls when nothing changes", async () => {
    world.aws.sg = [{ id: "sgr-80", protocol: "tcp", port: 80, cidr: "0.0.0.0/0", description: "published-tcp-80" }];
    const before = world.calls.length;
    await aws().setPublishedPorts(env, [{ name: "published-tcp-80", protocol: "Tcp", port: "80", source: "*" }]);
    const writes = world.calls.slice(before).length;
    expect(writes).toBe(2); // DescribeSecurityGroups + DescribeSecurityGroupRules only
  });
});

describe("inventory", () => {
  it("lists tagged resources; the Public IP line starts with the address", async () => {
    const inv = await aws().inventory(env);
    expect(inv.exists).toBe(true);
    expect(inv.resources.find((r) => r.kind === "Public IP")?.detail.split(",")[0]).toBe("18.130.0.10");
    expect(inv.resources.find((r) => r.kind === "Virtual machine")?.detail).toMatch(/t4g\.micro, running/);
  });
  it("nothing built: exists is false", async () => {
    world.aws.exists = false;
    expect((await aws().inventory(env)).exists).toBe(false);
  });
});
```

Run: `npx vitest run worker/test/aws-adapter.test.ts`. Expected: FAIL ("No adapter for aws").

- [ ] **Step 3: Create `worker/src/cloud/aws.ts`**

```ts
// cloud/aws.ts
//
// Plain English: the AWS side of the cloud door. The headend is the EC2
// instance tagged wg-admin-role=headend; its "edge firewall" is the security
// group with the same tag. Everything wg-admin builds carries wg-admin=vpn,
// so "what exists" is simply "what carries that tag".
//
// Words are Azure's on purpose (deallocated = stopped), so the rest of the
// Worker reads one vocabulary whichever cloud answered.

import type { Env } from "../env";
import { canAws, config } from "../env";
import type { AzureInventory } from "../state";
import type { PublishedNsgRule } from "../firewall";
import type { CloudOps, HeadendView } from "./index";
import { AwsError, awsJson, ec2, filters, xmlFirst, xmlRecords } from "./awsApi";

const TAG: [string, string[]] = ["tag:wg-admin", ["vpn"]];
const HEADEND: [string, string[]] = ["tag:wg-admin-role", ["headend"]];
const LIVE = ["pending", "running", "stopping", "stopped", "shutting-down"];
const POWER: Record<string, string> = { running: "running", stopped: "deallocated", stopping: "deallocating", pending: "starting", "shutting-down": "deleting" };
const SSH_RULE = "ssh-from-home";

interface Headend {
  id: string;
  state: string;
  publicIp: string | null;
  type: string | null;
}

async function findHeadend(env: Env): Promise<Headend | null> {
  const xml = await ec2(env, "DescribeInstances", filters([TAG, HEADEND, ["instance-state-name", LIVE]]));
  const id = xmlFirst(xml, "instanceId");
  if (!id) return null;
  const state = xml.match(/<instanceState>\s*<code>\d+<\/code>\s*<name>([a-z-]+)<\/name>/)?.[1] ?? "unknown";
  return { id, state, publicIp: xmlFirst(xml, "ipAddress"), type: xmlFirst(xml, "instanceType") };
}

async function view(env: Env): Promise<HeadendView> {
  const checked_at = new Date().toISOString();
  try {
    const [vpcs, h] = await Promise.all([ec2(env, "DescribeVpcs", filters([TAG])), findHeadend(env)]);
    return { rg_exists: !!xmlFirst(vpcs, "vpcId") || !!h, vm_exists: !!h, power: h ? (POWER[h.state] ?? h.state) : null, public_ip: h?.publicIp ?? null, checked_at };
  } catch (e) {
    return { rg_exists: false, vm_exists: false, power: null, public_ip: null, checked_at, error: (e as Error).message };
  }
}

const KIND: Record<string, string> = {
  instance: "Virtual machine",
  "elastic-ip": "Public IP",
  vpc: "Virtual network",
  subnet: "Subnet",
  "security-group": "Security group",
  "internet-gateway": "Internet gateway",
  "route-table": "Route table",
  volume: "OS disk",
  "key-pair": "Key pair",
  "network-interface": "Network interface",
};
const ORDER = ["Virtual network", "Subnet", "Internet gateway", "Route table", "Security group", "Public IP", "Network interface", "Virtual machine", "OS disk", "Key pair"];

async function taggedArns(env: Env): Promise<string[]> {
  const region = config(env).aws.region;
  const arns: string[] = [];
  let token = "";
  for (let page = 0; page < 10; page++) {
    const r = await awsJson<{ ResourceTagMappingList?: { ResourceARN: string }[]; PaginationToken?: string }>(env, {
      service: "tagging",
      region,
      host: `tagging.${region}.amazonaws.com`,
      target: "ResourceGroupsTaggingAPI_20170126.GetResources",
      body: { TagFilters: [{ Key: "wg-admin", Values: ["vpn"] }], ...(token ? { PaginationToken: token } : {}) },
    });
    arns.push(...(r.ResourceTagMappingList ?? []).map((m) => m.ResourceARN));
    token = r.PaginationToken ?? "";
    if (!token) break;
  }
  return arns;
}

async function inventory(env: Env): Promise<AzureInventory> {
  const region = config(env).aws.region;
  const out: AzureInventory = { checked_at: new Date().toISOString(), resource_group: `wg-admin=vpn (${region})`, exists: false, resources: [] };
  try {
    const [arns, h, addrs] = await Promise.all([taggedArns(env), findHeadend(env), ec2(env, "DescribeAddresses", filters([TAG]))]);
    const eip = xmlFirst(addrs, "publicIp");
    for (const arn of arns) {
      const [type, id = ""] = (arn.split(":")[5] ?? "").split("/");
      const kind = KIND[type] ?? type;
      let detail = id;
      if (type === "instance" && h?.id === id) detail = `${h.type ?? "?"}, ${POWER[h.state] ?? h.state}, Ubuntu 24.04, SSH key only`;
      if (type === "elastic-ip") detail = `${eip ?? "not yet allocated"}, Elastic IP`;
      out.resources.push({ kind, name: id, detail });
    }
    out.resources.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    out.exists = arns.length > 0 || !!h;
    return out;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
}

async function power(env: Env, op: "hibernate" | "resume"): Promise<void> {
  const verb = op === "hibernate" ? "stop" : "start";
  try {
    const h = await findHeadend(env);
    if (!h) throw new Error(`there is no wg-admin server to ${verb}`);
    await ec2(env, op === "hibernate" ? "StopInstances" : "StartInstances", { "InstanceId.1": h.id });
  } catch (e) {
    const code = e instanceof AwsError ? ` (${e.code})` : "";
    throw new Error(`AWS refused to ${verb} the server${code}: ${(e as Error).message}`.slice(0, 300));
  }
}

interface SgRule {
  id: string;
  protocol: string;
  from: number;
  to: number;
  cidr: string | null;
  description: string;
}

async function headendGroup(env: Env): Promise<string> {
  const id = xmlFirst(await ec2(env, "DescribeSecurityGroups", filters([TAG, HEADEND])), "groupId");
  if (!id) throw new Error("AWS would not show the server's security group");
  return id;
}

async function ingressRules(env: Env, group: string): Promise<SgRule[]> {
  const xml = await ec2(env, "DescribeSecurityGroupRules", filters([["group-id", [group]]]));
  return xmlRecords(xml, "securityGroupRuleId")
    .filter((r) => xmlFirst(r, "isEgress") !== "true")
    .map((r) => ({
      id: xmlFirst(r, "securityGroupRuleId") ?? "",
      protocol: xmlFirst(r, "ipProtocol") ?? "",
      from: Number(xmlFirst(r, "fromPort") ?? -1),
      to: Number(xmlFirst(r, "toPort") ?? -1),
      cidr: xmlFirst(r, "cidrIpv4"),
      description: xmlFirst(r, "description") ?? "",
    }));
}

const permission = (p: { protocol: string; port: number; cidr: string; description: string }): Record<string, string> => ({
  "IpPermissions.1.IpProtocol": p.protocol,
  "IpPermissions.1.FromPort": String(p.port),
  "IpPermissions.1.ToPort": String(p.port),
  "IpPermissions.1.IpRanges.1.CidrIp": p.cidr,
  "IpPermissions.1.IpRanges.1.Description": p.description,
});

const revokeIds = (ids: string[]) => Object.fromEntries(ids.map((id, i) => [`SecurityGroupRuleId.${i + 1}`, id]));

/** New SSH source first, old one after: there is never a moment with SSH shut. */
async function setSshAllowedCidr(env: Env, cidr: string): Promise<void> {
  try {
    const g = await headendGroup(env);
    const old = (await ingressRules(env, g)).filter((r) => r.description === SSH_RULE);
    const keep = old.find((r) => r.cidr === cidr && r.from === 22 && r.to === 22);
    if (!keep) await ec2(env, "AuthorizeSecurityGroupIngress", { GroupId: g, ...permission({ protocol: "tcp", port: 22, cidr, description: SSH_RULE }) });
    const drop = old.filter((r) => r !== keep).map((r) => r.id);
    if (drop.length) await ec2(env, "RevokeSecurityGroupIngress", { GroupId: g, ...revokeIds(drop) });
  } catch (e) {
    throw new Error(`AWS refused the security group change: ${(e as Error).message}`.slice(0, 300));
  }
}

/** The security group's published-* rules become exactly `rules`. Every other rule (WireGuard, SSH, VPC) is left alone. */
async function setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void> {
  try {
    const g = await headendGroup(env);
    const have = (await ingressRules(env, g)).filter((r) => r.description.startsWith("published-"));
    const want = rules.map((w) => ({ description: w.name, protocol: w.protocol === "Udp" ? "udp" : "tcp", port: Number(w.port), cidr: w.source === "*" ? "0.0.0.0/0" : w.source }));
    const same = (h: SgRule, w: (typeof want)[number]) => h.description === w.description && h.protocol === w.protocol && h.from === w.port && h.to === w.port && h.cidr === w.cidr;
    const add = want.filter((w) => !have.some((h) => same(h, w)));
    const drop = have.filter((h) => !want.some((w) => same(h, w)));
    for (const w of add) await ec2(env, "AuthorizeSecurityGroupIngress", { GroupId: g, ...permission(w) });
    if (drop.length) await ec2(env, "RevokeSecurityGroupIngress", { GroupId: g, ...revokeIds(drop.map((r) => r.id)) });
  } catch (e) {
    throw new Error(`AWS refused to update the published ports: ${(e as Error).message}`.slice(0, 300));
  }
}

export const awsOps: CloudOps = {
  id: "aws",
  label: "AWS",
  configured: canAws,
  view,
  inventory,
  power,
  setSshAllowedCidr,
  setPublishedPorts,
};
```

  When a published port changes source, it gets the same name with a new CIDR. AWS accepts the new rule because the CIDR differs, and the old one is dropped afterwards. So the port is never shut.

- [ ] **Step 4: Register it.** In `cloud/index.ts`, add `import { awsOps } from "./aws";` and change `OPS` to `const OPS: Record<Cloud, CloudOps> = { azure: azureOps, aws: awsOps };`. Delete the `if (!ops)` throw in `opsFor`, and the "refuses a cloud with no adapter" idea if you added it.
- [ ] **Step 5: Run the tests.** Run `npx vitest run worker/test/aws-adapter.test.ts worker/test/cloud-seam.test.ts worker/test/lifecycle.test.ts`. Expected: PASS. The harness change must not break the Azure lifecycle.
- [ ] **Step 6: Commit**

```bash
git add worker/src/cloud worker/test/harness.ts worker/test/aws-adapter.test.ts
git commit -m "AWS adapter: view, inventory, hibernate/resume, SSH and published-port rules; fake AWS in the harness"
```

### Task 7: Deploy to a chosen cloud, one at a time

**Files:**
- Modify: `worker/src/runs.ts` (`DeployOptions`, `startDeploy`, `startDestroy`, the `findRunByTitle` callers, plus a new `runCloud`)
- Modify: `worker/src/github.ts` (`workflowFor`, plus optional `workflow` params on `dispatchWorkflow` and `findRunByTitle`)
- Modify: `worker/src/oidc.ts` (accept a list of workflows) and the `/api/callback/secrets` route in `worker/src/index.ts:130`
- Modify: `worker/src/api/lifecycle.ts:44-57` (`cloud` in the body)
- Modify: `worker/src/profiles.ts` `startMove` (refuse on AWS)
- Test: `worker/test/deploy-cloud.test.ts`

**Interfaces:**
- Consumes: `opsFor`, `cloudOf`, `canAws`, `config().aws.workflow`
- Produces:
  - `DeployOptions.cloud?: Cloud`
  - `workflowFor(cfg: Config, cloud: Cloud): string`
  - `runCloud(run: { payload_json: string | null }): Cloud`
  - An AWS apply payload carries `cloud: "aws"`, `region: cfg.aws.region` and `vm_size: cfg.aws.instanceType`. An AWS destroy payload carries `cloud: "aws"`.

- [ ] **Step 1: Failing test** `worker/test/deploy-cloud.test.ts`

```ts
// Choosing a cloud at deploy: the right workflow, one cloud at a time.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import { startDeploy, startDestroy, issueRunSecrets, handleCallback, runCloud } from "../src/runs";
import { startResume } from "../src/standby";
import { getSnapshot, saveSnapshot } from "../src/state";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

describe("deploy to AWS", () => {
  it("dispatches wg-aws.yml with London, t4g.micro and cloud=aws, and records aws", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect(world.dispatches[0]).toMatchObject({ workflow: "wg-aws.yml", action: "apply" });
    expect(world.dispatches[0].payload).toMatchObject({ cloud: "aws", region: "eu-west-2", vm_size: "t4g.micro" });
    expect((await getSnapshot(env)).cloud).toBe("aws");
    expect(runCloud(run)).toBe("aws");
  });
  it("is refused without the Worker's AWS keys", async () => {
    ({ env, world } = makeEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined }));
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" })).rejects.toThrow(/AWS is not set up/);
  });
  it("is refused while Azure is failed (it may have left things behind)", async () => {
    await saveSnapshot(env, { state: "failed", cloud: "azure" });
    await expect(startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" })).rejects.toThrow(/Tear down the Azure headend first/);
  });
  it("the AWS run's secrets go only to a wg-aws.yml run, and tear-down uses wg-aws.yml", async () => {
    const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    const s = await issueRunSecrets(env, run.id, lastGhRun(world));
    expect(s.status).toBe(200);
    world.aws.exists = true;
    await handleCallback(env, s.body.callback_token as string, { run_id: run.id, action: "apply", status: "success", outputs: { public_ip: world.aws.ip } });
    await startDestroy(env, "steven");
    expect(world.dispatches[1]).toMatchObject({ workflow: "wg-aws.yml", action: "destroy" });
    expect(world.dispatches[1].payload).toMatchObject({ cloud: "aws" });
  });
});

describe("a headend keeps its cloud", () => {
  it("standby in Azure resumes through Azure with AWS configured", async () => {
    world.azure.rg = true;
    world.azure.power = "deallocated";
    await saveSnapshot(env, { state: "standby", cloud: "azure", standby_since: new Date().toISOString() });
    await startResume(env, "steven", null);
    expect(world.powerCalls).toEqual(["start"]);
    expect(world.calls.some((c) => c.host.startsWith("ec2."))).toBe(false);
  });
});
```

If `startResume` needs a current deployment row, seed one the way `lifecycle.test.ts` does (`deployToRunning` for Azure, then hibernate, then `refreshPower`). Keep the assertion: no `ec2.` host was called.

Run: `npx vitest run worker/test/deploy-cloud.test.ts`. Expected: FAIL.

- [ ] **Step 2: github.ts.**

```ts
/** Which workflow builds and tears down a headend in this cloud. */
export function workflowFor(cfg: Config, cloud: Cloud): string {
  return cloud === "aws" ? cfg.aws.workflow : cfg.workflow;
}
```

  Give `dispatchWorkflow` a fourth parameter, `workflow: string = config(env).workflow`, and use it in the URL in place of `cfg.workflow`. Give `findRunByTitle(env, runId, workflow = config(env).workflow)` the same treatment.

- [ ] **Step 3: runs.ts.**

```ts
/** The cloud a run was for: AWS runs say so in their payload; everything else is Azure. */
export function runCloud(run: { payload_json: string | null }): Cloud {
  try {
    return (JSON.parse(run.payload_json || "{}") as { cloud?: string }).cloud === "aws" ? "aws" : "azure";
  } catch {
    return "azure";
  }
}
```

  - `DeployOptions` gains `cloud?: Cloud`.
  - In `startDeploy`, before taking the lock:

```ts
  const cloud: Cloud = opts.cloud ?? "azure";
  const was = cloudOf(snap);
  if (cloud !== was && snap.state !== "destroyed") {
    throw new RunError(`Tear down the ${opsFor(was).label} headend first. wg-admin runs one cloud at a time.`);
  }
  if (cloud === "aws" && !opsFor("aws").configured(env)) throw new RunError("AWS is not set up yet: the Worker has no AWS keys.", "bad_input");
```

  (Use the snapshot variable `startDeploy` already reads. If it reads none, add `const snap = await getSnapshot(env);`.)

  - Build the payload as today. Then, when `cloud === "aws"`, set `payload.region = cfg.aws.region`, `payload.vm_size = cfg.aws.instanceType` and `payload.cloud = "aws"`, and set the snapshot's `region`, `vm_size` and `profile: null` the same way.
  - Dispatch with `dispatchWorkflow(env, "apply", payload, workflowFor(cfg, cloud))`, and put `cloud` in the `deploying` snapshot patch, replacing Task 1's literal.
  - `startDestroy`: `const cloud = cloudOf(snap);`. Add `...(cloud === "aws" ? { cloud: "aws" } : {})` to the payload, and dispatch with `workflowFor(cfg, cloud)`.
  - Every `findRunByTitle(env, run.id)` becomes `findRunByTitle(env, run.id, workflowFor(cfg, runCloud(run)))`. Find them with `grep -n findRunByTitle worker/src`.

- [ ] **Step 4: OIDC.** In `oidc.ts`, let the workflow parameter be `wf: string | string[]`, and compare with:

```ts
  const allowed = (Array.isArray(wf) ? wf : [wf]).map((w) => `${repo}/.github/workflows/${w}@refs/heads/main`);
  if (!c.workflow_ref || !allowed.includes(c.workflow_ref)) return `wrong workflow ${c.workflow_ref}`;
```

  In the `/api/callback/secrets` route, pass `[cfg.workflow, cfg.aws.workflow]`. Then, in `issueRunSecrets`, after the run is loaded, refuse a token whose `workflow_ref` names the other cloud's workflow. Pass the claims' `workflow_ref` through, or compare the GitHub run id to `findRunByTitle(env, run.id, workflowFor(cfg, runCloud(run)))`. Whichever the existing code already does to bind the token to "this dispatch", keep that binding and make it use the run's workflow. The existing lifecycle test "refuses a GitHub run that is not this dispatch" must still pass.

- [ ] **Step 5: Route.** In `api/lifecycle.ts` `POST /deploy`:
  - Read `cloud` from the body.
  - `if (b.cloud !== undefined && b.cloud !== "azure" && b.cloud !== "aws") return fail(c, 400, "bad_input", "Unknown cloud.", "cloud");`
  - For `"aws"`, reject `profileId` or `region` with a 400 on field `cloud`: "AWS deploys to London; leave region and profile empty." Skip `resolveDeployTarget`, and pass `cloud: "aws"` to `startDeploy`. The budget check is unchanged.
- [ ] **Step 6: Move.** At the top of `startMove`, refuse an AWS headend:

```ts
  if (cloudOf(await getSnapshot(env)) === "aws") throw new RunError("Move works between Azure regions. Tear down the AWS server, then deploy in Azure.");
```

- [ ] **Step 7: Run the tests.** Run `npx vitest run worker/test/deploy-cloud.test.ts worker/test/lifecycle.test.ts worker/test/api-*.test.ts worker/test/oidc*.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add worker/src worker/test/deploy-cloud.test.ts
git commit -m "Deploy to Azure or AWS: per-cloud workflow and OIDC, one cloud at a time, Move stays Azure"
```

### Task 8: The whole lifecycle, once per cloud

**Files:**
- Modify: `worker/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `World.aws` (Task 6); `startDeploy(..., { cloud })` (Task 7)

- [ ] **Step 1:** Wrap every `describe` in `lifecycle.test.ts` in:

```ts
describe.each(["azure", "aws"] as const)("%s", (cloud) => {
  const up = () => (cloud === "aws" ? (world.aws.exists = true) : (world.azure.rg = true));
  const down = () => (cloud === "aws" ? (world.aws.exists = false) : (world.azure.rg = false));
  const ip = () => (cloud === "aws" ? world.aws.ip : world.azure.ip);
  const setPower = (p: "running" | "deallocated") => (cloud === "aws" ? (world.aws.state = p === "running" ? "running" : "stopped") : (world.azure.power = p));
  const workflow = cloud === "aws" ? "wg-aws.yml" : "wg.yml";
  // … existing describes …
});
```

  Then in `deployToRunning`:
  - pass `cloud` to `startDeploy`
  - `world.azure.rg = true` becomes `up()`
  - `outputs: { public_ip: world.azure.ip }` becomes `outputs: { public_ip: ip() }`

  Throughout the file:
  - `world.azure.power = X` becomes `setPower(X)`
  - `world.azure.rg = false` becomes `down()`
  - any expectation of `"wg.yml"` becomes `workflow`

  `world.powerCalls` expectations stay as they are; the fake AWS records the same words.

- [ ] **Step 2: Run the tests.** Run `npx vitest run worker/test/lifecycle.test.ts`. Expected: every test passes twice ("azure > …" and "aws > …"). The AWS run of "flags drift when a standby VM is actually running" must flag drift using the AWS view.
- [ ] **Step 3: Commit**

```bash
git add worker/test/lifecycle.test.ts
git commit -m "Lifecycle tests run against Azure and AWS"
```

### Task 9: AWS money (rates, daily actuals, budget, cost page data)

**Files:**
- Create: `worker/migrations/0023_aws_cost.sql`, `worker/src/cloud/awsCost.ts`
- Modify: `worker/src/db.ts` (`upsertAwsCostDay`, `awsCostDays`), `worker/src/env.ts` (`ratesFor`), `worker/src/monitor.ts` step 6, `worker/src/budget.ts`, plus the rate call sites `runs.ts:310`, `activity.ts:20`, `costview.ts:106`, `api/cost.ts:36,55,56`, `api/overview.ts:73-74`, `standby.ts:102`
- Modify: `shared/api.ts` (`CostResponse.byCloud`)
- Regenerate: `worker/src/demo/schema.gen.ts` (`npm run demo-schema`)
- Test: `worker/test/aws-cost.test.ts`

**Interfaces:**
- Produces:
  - `ratesFor(cfg: Config, cloud: Cloud): { hourlyRateGbp: number; standbyRateGbp: number }`
  - `awsCostMonthToDate(env: Env, now?: Date): Promise<{ day: string; usd: number }[]>`
  - `db.upsertAwsCostDay(env, day: string, gbp: number, usd: number)`
  - `db.awsCostDays(env, sinceDay: string): Promise<{ day: string; gbp: number; usd: number; fetched_at: string }[]>`
  - `CostResponse.byCloud: { azure: number; aws: number }`

- [ ] **Step 1: Failing test** `worker/test/aws-cost.test.ts`

```ts
// AWS money: rates per cloud, the once-a-day Cost Explorer pull, one budget.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import { config, ratesFor, type Env } from "../src/env";
import * as db from "../src/db";
import { runScheduled } from "../src/monitor";
import { budgetStatus } from "../src/budget";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

describe("ratesFor", () => {
  it("gives each cloud its own rates", () => {
    const cfg = config(env);
    expect(ratesFor(cfg, "azure")).toEqual({ hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp });
    expect(ratesFor(cfg, "aws")).toEqual({ hourlyRateGbp: 0.011, standbyRateGbp: 0.005 });
  });
});

describe("daily AWS actuals", () => {
  it("pulls once a day, converts to pounds, and counts in the one budget", async () => {
    const day = new Date().toISOString().slice(0, 10);
    world.awsCost = [{ day, usd: 2 }];
    await runScheduled(env);
    await runScheduled(env);
    const ceCalls = world.calls.filter((c) => c.host === "ce.us-east-1.amazonaws.com");
    expect(ceCalls).toHaveLength(1);
    expect(await db.awsCostDays(env, day)).toMatchObject([{ day, gbp: 1.5, usd: 2 }]);
    expect((await budgetStatus(env)).actualGbp).toBeGreaterThanOrEqual(1.5);
  });
  it("skips Cost Explorer when the Worker has no AWS keys", async () => {
    ({ env, world } = makeEnv({ AWS_WORKER_ACCESS_KEY_ID: undefined, AWS_WORKER_SECRET_ACCESS_KEY: undefined }));
    await runScheduled(env);
    expect(world.calls.some((c) => c.host === "ce.us-east-1.amazonaws.com")).toBe(false);
  });
});
```

Use the field name `budgetStatus` actually returns for actual spend (read `budget.ts:74-160`; it may be `actual` or `actualGbp`). Adjust the assertion to that name, not the code to the test.

Run: `npx vitest run worker/test/aws-cost.test.ts`. Expected: FAIL.

- [ ] **Step 2: Migration** `worker/migrations/0023_aws_cost.sql`

```sql
-- 0023_aws_cost.sql
--
-- Plain English: what AWS actually billed for the headend, one row per day.
-- Cost Explorer answers in dollars; the Worker stores both the dollars and
-- the pounds it converted with AWS_USD_GBP. Azure's figures stay in cost_days.

CREATE TABLE aws_cost_days (
  day TEXT PRIMARY KEY,
  gbp REAL NOT NULL,
  usd REAL NOT NULL,
  fetched_at TEXT NOT NULL
);
```

  Then run `npm run demo-schema`.

- [ ] **Step 3: db.ts**, next to `upsertCostDay`:

```ts
export interface AwsCostDay {
  day: string;
  gbp: number;
  usd: number;
  fetched_at: string;
}

export async function upsertAwsCostDay(env: Env, day: string, gbp: number, usd: number): Promise<void> {
  await env.DB.prepare("INSERT INTO aws_cost_days (day, gbp, usd, fetched_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(day) DO UPDATE SET gbp = excluded.gbp, usd = excluded.usd, fetched_at = excluded.fetched_at")
    .bind(day, gbp, usd, new Date().toISOString())
    .run();
}

export async function awsCostDays(env: Env, sinceDay: string): Promise<AwsCostDay[]> {
  return (await env.DB.prepare("SELECT * FROM aws_cost_days WHERE day >= ?1 ORDER BY day").bind(sinceDay).all<AwsCostDay>()).results;
}
```

- [ ] **Step 4: `worker/src/cloud/awsCost.ts`**

```ts
// cloud/awsCost.ts
//
// Plain English: what AWS billed for everything tagged wg-admin=vpn, per day,
// month to date (reaching back into last month for the first 3 days, as the
// Azure pull does). Cost Explorer charges about 1p a question, so the watchman
// asks once a day. It needs the wg-admin tag activated as a cost allocation
// tag; until then it simply answers zero.

import type { Env } from "../env";
import { costTimeframe } from "../azure";
import { awsJson } from "./awsApi";

export async function awsCostMonthToDate(env: Env, now = new Date()): Promise<{ day: string; usd: number }[]> {
  const tf = costTimeframe(now);
  const start = tf.timeframe === "MonthToDate" ? `${now.toISOString().slice(0, 7)}-01` : tf.timePeriod.from.slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10); // exclusive
  const r = await awsJson<{ ResultsByTime?: { TimePeriod: { Start: string }; Total?: { UnblendedCost?: { Amount: string } } }[] }>(env, {
    service: "ce",
    region: "us-east-1",
    host: "ce.us-east-1.amazonaws.com",
    target: "AWSInsightsIndexService.GetCostAndUsage",
    body: { TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"], Filter: { Tags: { Key: "wg-admin", Values: ["vpn"] } } },
  });
  return (r.ResultsByTime ?? []).map((x) => ({ day: x.TimePeriod.Start, usd: Number(x.Total?.UnblendedCost?.Amount ?? 0) || 0 }));
}
```

- [ ] **Step 5: env.ts**, below `canAws`:

```ts
/** The running and standby rates for a headend in this cloud. */
export function ratesFor(cfg: Config, cloud: Cloud): { hourlyRateGbp: number; standbyRateGbp: number } {
  return cloud === "aws" ? { hourlyRateGbp: cfg.aws.hourlyRateGbp, standbyRateGbp: cfg.aws.standbyRateGbp } : { hourlyRateGbp: cfg.hourlyRateGbp, standbyRateGbp: cfg.standbyRateGbp };
}
```

- [ ] **Step 6: monitor.ts step 6.** After the two Azure pulls, add a third block in the same style (same `today` key logic, same note-on-failure pattern):

```ts
  if (canAws(env) && (await env.STATUS.get("cost:aws_fetched_day")) !== today) {
    try {
      const rate = config(env).aws.usdToGbp;
      for (const d of await awsCostMonthToDate(env, now)) await db.upsertAwsCostDay(env, d.day, Math.round(d.usd * rate * 10000) / 10000, d.usd);
      await env.STATUS.put("cost:aws_fetched_day", today);
    } catch (e) {
      notes.push(`AWS cost pull failed: ${(e as Error).message}`);
    }
  }
```

  Use the local names step 6 already uses for "today", "now" and the notes array. Match them; don't introduce new ones.

- [ ] **Step 7: Rates per cloud.**
  - Current headend (from the snapshot): `budget.ts` session estimate, `api/cost.ts` (`session.estimateGbp`, `standby.perDayGbp`), `api/overview.ts` (`config.hourlyRateGbp` / `standbyRateGbp` for the live headend), `standby.ts:102` push text, `runs.ts:310` `sessionSummary`. Each uses `ratesFor(cfg, cloudOf(snap))`.
  - Past runs: `activity.ts:20` `sessionCost` and `costview.ts:106` `perHourGbp` use `ratesFor(cfg, runCloud(run))` for the run being described.
  - Leave `api/settings.ts:54` and `insights/price.ts:66` on the Azure rates. They describe Azure settings.

- [ ] **Step 8: Budget.** In `budgetStatus`, load `db.awsCostDays(env, monthStart)` and pass it to `budgetFigures` as a new `awsDays` argument. In `budgetFigures`:
  - add the AWS days to `actual`
  - start the session estimate after the last *billed* day of the headend's own cloud: `cost_days` for Azure, `aws_cost_days` for AWS
  - use `ratesFor(cfg, cloudOf(snap)).hourlyRateGbp`

  Existing budget tests must still pass unchanged. That is the Azure behaviour.

- [ ] **Step 9: Cost API.** In `api/cost.ts`:
  - add the AWS days for the range into `daily`, summing by day with any Azure figure
  - add the same for `previous`
  - set `monthToDate` to the Azure total plus the AWS total
  - add `byCloud: { azure, aws }` (month to date)

  Add `byCloud: { azure: number; aws: number };` to `CostResponse` in `shared/api.ts`, with a doc comment. Update the web cost test fixture so it typechecks (`byCloud: { azure: <its monthToDate>, aws: 0 }`).

- [ ] **Step 10: Run the tests.** Run `npx vitest run worker/test/aws-cost.test.ts worker/test/budget*.test.ts worker/test/*cost*.test.ts worker/test/demo-schema.test.ts worker/test/lifecycle.test.ts`. Expected: PASS.
- [ ] **Step 11: Commit**

```bash
git add worker/migrations/0023_aws_cost.sql worker/src worker/test/aws-cost.test.ts shared/api.ts web/src
git commit -m "AWS money: per-cloud rates, daily Cost Explorer actuals in one budget, cost split by cloud"
```

### Task 10: The boot bundle route

**Files:**
- Modify: `worker/src/runs.ts` (extract `runForAgentToken`; add `bootBundle`; clear `boot/` in `completeDestroy`)
- Modify: `worker/src/index.ts` (route `GET /api/agent/bundle`, next to `POST /api/agent`)
- Test: `worker/test/boot-bundle.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/agent/bundle` with header `Authorization: Bearer <agent token>`. It answers 200 `application/gzip` (the R2 object `boot/<run id>.tgz`), or 401 (unknown token), 410 (an older deploy's token), 404 (no bundle stored).
  - R2 key convention: `boot/<apply run id>.tgz`, written by `wg-aws.yml` (Task 13).

- [ ] **Step 1: Failing test** `worker/test/boot-bundle.test.ts`

```ts
// The AWS VM's first-boot bundle: only for the current deploy's token.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, lastGhRun, type World } from "./harness";
import type { Env } from "../src/env";
import { startDeploy, issueRunSecrets, bootBundle } from "../src/runs";

let env: Env;
let world: World;
beforeEach(() => ({ env, world } = makeEnv()));
afterEach(() => vi.unstubAllGlobals());

async function deployAws() {
  const run = await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
  const s = await issueRunSecrets(env, run.id, lastGhRun(world));
  await env.STATE.put(`boot/${run.id}.tgz`, new Uint8Array([0x1f, 0x8b, 8, 0]));
  return { run, token: s.body.agent_token as string, cb: s.body.callback_token as string };
}

describe("boot bundle", () => {
  it("serves this deploy's bundle to its agent token", async () => {
    const { token } = await deployAws();
    const r = await bootBundle(env, token);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await new Response(r.body as ReadableStream).arrayBuffer())[0]).toBe(0x1f);
  });
  it("refuses a wrong or missing token", async () => {
    await deployAws();
    expect((await bootBundle(env, "nope")).status).toBe(401);
    expect((await bootBundle(env, "")).status).toBe(401);
  });
  it("answers 404 when no bundle was stored, so the VM retries", async () => {
    const { run, token } = await deployAws();
    await env.STATE.delete(`boot/${run.id}.tgz`);
    expect((await bootBundle(env, token)).status).toBe(404);
  });
  it("answers 410 to an older deploy's token", async () => {
    const first = await deployAws();
    // A newer apply exists (as after a fresh deploy): the first token is stale.
    await env.DB.prepare("UPDATE runs SET requested_at = '2000-01-01T00:00:00Z' WHERE id = ?1").bind(first.run.id).run();
    await env.DB.prepare("INSERT INTO runs (id, action, status, requested_at) VALUES ('apply-newer', 'apply', 'success', ?1)").bind(new Date().toISOString()).run();
    expect((await bootBundle(env, first.token)).status).toBe(410);
  });
});
```

Insert the extra run with the column set the `runs` table requires. Read `worker/migrations/0001_init.sql` and add any NOT NULL columns it needs.

For the tear-down cleanup, add one assertion to the AWS run of `lifecycle.test.ts` "tear down" (Task 8 made it run per cloud). Before the destroy, put `boot/<apply run id>.tgz` in `env.STATE`. After the destroy completes, `expect(await env.STATE.get(key)).toBeNull()`.

Run: `npx vitest run worker/test/boot-bundle.test.ts`. Expected: FAIL (`bootBundle` not exported).

- [ ] **Step 2: runs.ts.** Pull the token lookup out of `handleAgent` into:

```ts
/** The apply run an agent token belongs to, or why not: 401 unknown, 410 an older deployment's. */
async function runForAgentToken(env: Env, token: string): Promise<{ run: db.Run } | { status: 401 | 410; error: string }> {
  if (!token) return { status: 401, error: "no token" };
  const hash = await sha256Hex(token);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE action = 'apply' AND agent_token_hash = ?1 ORDER BY requested_at DESC LIMIT 1").bind(hash).first<db.Run>();
  if (!run) return { status: 401, error: "unknown token" };
  const latestApply = await env.DB.prepare("SELECT id FROM runs WHERE action = 'apply' ORDER BY requested_at DESC LIMIT 1").first<{ id: string }>();
  if (latestApply && latestApply.id !== run.id) return { status: 410, error: "token from an older deployment" };
  return { run };
}
```

  `handleAgent` starts with `const who = await runForAgentToken(env, token); if (!("run" in who)) return { status: who.status, body: { error: who.error } }; const run = who.run;`. The rest is unchanged.

  Then add:

```ts
/**
 * An AWS VM's first-boot bundle: the agent scripts and firewall rules that do
 * not fit in AWS's 16 KB of user data. wg-aws.yml stores it in R2 as
 * boot/<run id>.tgz; the VM fetches it once, with the same per-deploy token
 * it uses for heartbeats, and checks its SHA-256 before unpacking.
 */
export async function bootBundle(env: Env, token: string): Promise<{ status: number; body: ReadableStream | string }> {
  const who = await runForAgentToken(env, token);
  if (!("run" in who)) return { status: who.status, body: who.error };
  const obj = await env.STATE.get(`boot/${who.run.id}.tgz`);
  if (!obj) return { status: 404, body: "no bundle for this deploy" };
  return { status: 200, body: obj.body };
}
```

  In `completeDestroy`, after the snapshot is cleared:

```ts
  // AWS boot bundles hold firewall rules; none outlives its server.
  const boots = await env.STATE.list({ prefix: "boot/" });
  await Promise.all(boots.objects.map((o) => env.STATE.delete(o.key)));
```

- [ ] **Step 3: index.ts route**, next to `app.post("/api/agent", …)`:

```ts
// An AWS VM's first-boot files (runs.ts bootBundle). Same token and brake as the heartbeat.
app.get("/api/agent/bundle", async (c) => {
  const key = failKey(c, "bundle");
  if (tooManyFailures(key)) return c.text("slow down", 429);
  const r = await bootBundle(c.env, bearer(c));
  if (r.status === 401) noteFailure(key);
  if (r.status !== 200) return c.text(r.body as string, r.status as 401);
  return new Response(r.body as ReadableStream, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store" } });
});
```

  Check that this route is registered where the other `/api/agent*` routes are, outside `requireAccess`. The Cloudflare Access bypass for `/api/agent` already covers sub-paths (the capture upload at `/api/agent/capture/:id` works today).

- [ ] **Step 4: Run the tests.** Run `npx vitest run worker/test/boot-bundle.test.ts worker/test/lifecycle.test.ts worker/test/capture*.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add worker/src/runs.ts worker/src/index.ts worker/test/boot-bundle.test.ts worker/test/lifecycle.test.ts
git commit -m "Boot bundle: an AWS VM fetches its agent files with its own token; gone after tear-down"
```

---

## Phase D: the VM and the infrastructure

### Task 11: A cloud-neutral boot template and agent

**Files:**
- Modify: `infra/cloud-init.yaml.tftpl`, `infra/test-vm.yaml.tftpl`, `infra/main.tf` (`templatefile` calls), `infra/variables.tf` (description of `ssh_password` only)
- Modify: `infra/agent/wg-agent.sh` (lines 44, 295-300), `wg-selftest.sh:51`, `wg-capture.sh:32`, `wg-vitals.sh` (`job_events`), `wg-firewall-load.sh`
- Modify: `worker/test/cloud-init-size.test.ts` (`worstVars()` gets the new keys)
- Test: `scripts/test/agent-wan.test.mjs`

**Interfaces:**
- Produces new template variables (Azure values in brackets):
  - `admin_user` ("azureuser")
  - `wan_if` ("eth0")
  - `azure_only` ("1")
  - `cloud` ("azure")
  - `boot_bundle_sha256` ("")
- `/etc/wireguard/wg-agent.env` gains `CLOUD=` and `WAN_IF=`.
- Every agent script that needs the WAN interface reads `${WAN_IF:-eth0}`.

- [ ] **Step 1: Failing test** `scripts/test/agent-wan.test.mjs`

```js
// The agent never assumes the WAN interface is eth0 (AWS calls it ens5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

test("agent scripts read the WAN interface from WAN_IF", () => {
  for (const f of readdirSync("infra/agent").filter((f) => f.endsWith(".sh"))) {
    const lines = readFileSync(`infra/agent/${f}`, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/^\s*#/.test(l) || !/\beth0\b/.test(l)) return;
      assert.ok(/WAN_IF/.test(l), `${f}:${i + 1} uses eth0 without WAN_IF: ${l.trim()}`);
    });
  }
});

test("the template writes CLOUD and WAN_IF for the agent, and has no fixed azureuser", () => {
  const t = readFileSync("infra/cloud-init.yaml.tftpl", "utf8");
  assert.match(t, /CLOUD=\$\{cloud\}/);
  assert.match(t, /WAN_IF=\$\{wan_if\}/);
  assert.doesNotMatch(t, /name: azureuser/);
  assert.match(t, /%\{ if boot_bundle_sha256 != "" ~\}/);
});
```

Run: `node --test scripts/test/agent-wan.test.mjs`. Expected: FAIL.

- [ ] **Step 2: Template edits** (`infra/cloud-init.yaml.tftpl`):
  1. Lines 15 and 21: `azureuser` becomes `${admin_user}`. The comment reads "Per-deploy password for the admin user".
  2. Lines 119-121: `net.ipv6.conf.eth0.accept_ra = 2` becomes `net.ipv6.conf.${wan_if}.accept_ra = 2`. The comment becomes "Keep learning the IPv6 default route from the cloud's router adverts".
  3. Wrap the netplan DHCPv6 block (lines 123-132) in `%{ if azure_only != "" ~}` … `%{ endif ~}`. EC2's own netplan already asks for DHCPv6.
  4. Wrap the seven `server=/…/168.63.129.16` lines (198-207), and their comment, in `%{ if azure_only != "" ~}` … `%{ endif ~}`.
  5. In the `wg-agent.env` content (around 259-266), add two lines:

```
      CLOUD=${cloud}
      WAN_IF=${wan_if}
```

  6. Make this the first `runcmd` entry:

```yaml
%{ if boot_bundle_sha256 != "" ~}
  # AWS: the agent files and firewall do not fit in 16 KB of user data, so
  # they come from the Worker (this deploy's token), checked against the
  # SHA-256 Terraform was given, before anything below starts using them.
  - [sh, -c, '. /etc/wireguard/wg-agent.env; for i in 1 2 3 4 5 6 7 8 9 10; do curl -fsS --max-time 20 -H "Authorization: Bearer $AGENT_TOKEN" "$AGENT_URL/bundle" -o /run/wg-boot.tgz && break; sleep 6; done; echo "${boot_bundle_sha256}  /run/wg-boot.tgz" | sha256sum -c - && tar -xzf /run/wg-boot.tgz -C / && rm -f /run/wg-boot.tgz']
%{ endif ~}
```

  `$AGENT_TOKEN` and `$AGENT_URL` are shell, not Terraform. Terraform only expands `${…}`, so they pass through. Keep `${boot_bundle_sha256}` as the Terraform variable. The agent env file already holds `AGENT_URL` (`…/api/agent`) and `AGENT_TOKEN`, so the bundle URL is `…/api/agent/bundle`. Check that `wg-agent.env` uses plain `KEY=value` lines that `.` can source. If its values are quoted or unusual, read them with `sed -n 's/^AGENT_URL=//p'` instead.

- [ ] **Step 3:** In `infra/test-vm.yaml.tftpl`, line 17 `azureuser` becomes `${admin_user}`.
- [ ] **Step 4: `infra/main.tf`**
  - In the cloud-init `templatefile` call, add:

```hcl
    admin_user         = "azureuser"
    wan_if             = "eth0"
    azure_only         = "1"
    cloud              = "azure"
    boot_bundle_sha256 = ""
```

  - In the test-vm call, add `admin_user = "azureuser"`.
  - In `infra/variables.tf`, change the `ssh_password` description to "for the VM's admin user".

- [ ] **Step 5: Agent scripts.**
  - **`wg-agent.sh`:** the agent already sources `/etc/wireguard/wg-agent.env`. Line 44: `eth0` becomes `"${WAN_IF:-eth0}"`. Line 300 (`ip -4 -o addr show dev eth0`) becomes `dev "${WAN_IF:-eth0}"`. In `keep_out` (line 295), add `169.254.169.253/32` (the Amazon DNS resolver) after `169.254.169.254/32`, and change the comment to "the clouds' platform addresses".
  - **`wg-selftest.sh:51` and `wg-capture.sh:32`:** if the script does not already read the agent env, add near the top:

```bash
# The WAN interface: eth0 on Azure, ens5 on AWS (written by cloud-init).
WAN_IF="$(sed -n 's/^WAN_IF=//p' /etc/wireguard/wg-agent.env 2>/dev/null)"; WAN_IF="${WAN_IF:-eth0}"
```

    In `wg-selftest.sh`, replace `eth0` on line 51 with `"$WAN_IF"`. In `wg-capture.sh`, keep accepting the name `eth0` from the Worker (it means "the cloud side") and map it before use:

```bash
[[ "$IFACE" == eth0 ]] && IFACE="$WAN_IF"   # "eth0" from the Worker means the WAN side; on AWS that is ens5 (WAN_IF)
```

    Place this right after the `case "$IFACE" in wg0|eth0|any` validation.

  - **`wg-vitals.sh`:** read `CLOUD` the same way (`CLOUD="$(sed -n 's/^CLOUD=//p' /etc/wireguard/wg-agent.env 2>/dev/null)"`). Rename the existing function to `job_events_azure`, and add:

```bash
# ── Job: AWS scheduled events ───────────────────────────────────────────────
# EC2's metadata service (IMDSv2: a short-lived token first) lists planned
# maintenance for this instance: reboots, retirements, stops. Same shape as
# the Azure list, so the Worker reads one format.
job_events_aws() {
  local tok body
  tok="$(curl -s -f --noproxy '*' -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' --max-time 2 http://169.254.169.254/latest/api/token 2>/dev/null)" || return 0
  body="$(curl -s -f --noproxy '*' -H "X-aws-ec2-metadata-token: $tok" --max-time 2 http://169.254.169.254/latest/meta-data/events/maintenance/scheduled 2>/dev/null)" || return 0
  save events "$(jq -c --arg at "$(now_iso)" '
    def str: if type == "string" and . != "" then . else null end;
    {incarnation: null,
     at: $at,
     items: [(if type == "array" then . else [] end)[] | select(type == "object") | {
       id: (.EventId | tostring),
       type: .Code,
       status: .State,
       not_before: (.NotBefore | str),
       source: "Platform",
       duration_s: null,
       description: (.Description | str | if . then .[0:200] else null end),
       self: true
     }][0:10]}' <<<"$body" 2>/dev/null)"
}
job_events() { if [[ "${CLOUD:-azure}" == aws ]]; then job_events_aws; else job_events_azure; fi; }
```

    Read `worker/src/runs.ts:804-818` (where the Worker reads `events`). If it maps `type` through a fixed list of Azure event types, make an unknown type show as itself rather than being dropped. Add a unit test there with `type: "instance-reboot"`.

  - **`wg-firewall-load.sh`:** read the script. Where it loads `/etc/wg-admin/firewall.nft` (with `nft -f`), load a rewritten copy when the WAN interface is not `eth0`:

```bash
# The Worker writes rules for "eth0" (Azure's name). On AWS the WAN is ens5:
# load the same rules with the name swapped. Azure is untouched (eth0 = eth0).
WAN_IF="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}')"
WAN_IF="${WAN_IF:-eth0}"
rules=/etc/wg-admin/firewall.nft
if [[ "$WAN_IF" != eth0 ]]; then
  sed "s/\"eth0\"/\"$WAN_IF\"/g" /etc/wg-admin/firewall.nft > /run/wg-firewall.nft
  rules=/run/wg-firewall.nft
fi
```

    Then load `"$rules"` where it loaded the file before. The `WAN_IF` lines contain `eth0` and `WAN_IF`, so the Step 1 test accepts them. If `wg-agent.sh` loads firewall updates itself rather than through this script, route those through the same rewrite (call the loader).

- [ ] **Step 6: Size test.** In `worker/test/cloud-init-size.test.ts` `worstVars()`, add the five Azure values from Step 4. Run `npx vitest run worker/test/cloud-init-size.test.ts`. Expected: PASS, with Azure still under the 58 KB ceiling.
- [ ] **Step 7: Run the tests.** Run `node --test scripts/test/agent-wan.test.mjs scripts/test/wg-workflow.test.mjs` and `npm run tf-validate`. Expected: PASS. `wg-workflow.test.mjs` line 309 checks the seven Azure dnsmasq forwards in the template. If it reads the raw template, the `%{ if }` wrapper keeps them present. If it now fails, change its expectation to "present inside the azure_only block", and nothing else.
- [ ] **Step 8: Commit**

```bash
git add infra worker/test/cloud-init-size.test.ts scripts/test/agent-wan.test.mjs worker/src/runs.ts worker/test
git commit -m "Boot template and agent work in either cloud: admin user, WAN interface, Azure-only DNS, AWS scheduled events, boot bundle fetch"
```

### Task 12: The AWS Terraform root

**Files:**
- Create: `infra/aws/{backend.tf,providers.tf,variables.tf,main.tf,outputs.tf}` and `infra/aws/.terraform.lock.hcl` (from `terraform init`)
- Modify: `.github/workflows/ci.yml` (validate `infra/aws`)
- Modify: `worker/test/cloud-init-size.test.ts` (AWS render under 12 KB gzipped; template keys present in `infra/aws/main.tf`)
- Test: `scripts/test/tf-twins.test.mjs`

**Interfaces:**
- Consumes: the template variables from Task 11
- Produces:
  - Terraform variables with the same names as Azure's where they mean the same thing (`region`, `vm_size`, `peers_json`, …), plus `boot_bundle_sha256`
  - outputs with Azure's names (`public_ip`, `public_ip6`, `vm_private_ip`, `resource_group`, `dns_name`, `wg_server_ip`, `loopback_ip`, `deployed_at`, `test_vm_ip`)

- [ ] **Step 1: Failing test** `scripts/test/tf-twins.test.mjs`

```js
// Azure and AWS build the same peer list the same way: one copy each, kept identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const block = (f) => {
  const t = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const a = t.indexOf("  peers = [");
  const b = t.indexOf("\n  ])\n", t.indexOf("  peers_conf ="));
  assert.ok(a > 0 && b > a, `${f}: peers..peers_conf block not found`);
  return t.slice(a, b)
    .split("\n")
    .filter((l) => !/^\s*(subnet_cidr6|common_tags|project|run_id|managed)\b/.test(l))
    .join("\n");
};

test("peer and site-route logic is identical in both roots", () => {
  assert.equal(block("infra/aws/main.tf"), block("infra/main.tf"));
});
```

The filter drops Azure's `subnet_cidr6` and `common_tags` lines, which sit inside that range in `infra/main.tf` and are Azure-only. If more Azure-only lines turn up in the range, add them to the filter rather than copying them into the AWS root.

Run: `node --test scripts/test/tf-twins.test.mjs`. Expected: FAIL (no `infra/aws/main.tf`).

- [ ] **Step 2: `infra/aws/backend.tf`.** A copy of `infra/backend.tf` with `key = "wg-admin/aws/terraform.tfstate"`, and the header comment saying the credentials come from `-backend-config` (wg-aws.yml writes them to a file).

- [ ] **Step 3: `infra/aws/providers.tf`**

```hcl
# providers.tf (AWS)
#
# Plain English: the drivers for AWS and Cloudflare, pinned. Credentials are
# not here: in GitHub Actions the AWS provider assumes the wg-admin-deploy role
# with the run's own signed identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE),
# and Cloudflare reads the narrow DNS token from CLOUDFLARE_API_TOKEN.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      "wg-admin" = "vpn"
      project    = "wg-admin"
      run_id     = var.run_id
      managed    = "terraform"
    }
  }
}

provider "cloudflare" {}
```

- [ ] **Step 4: `infra/aws/variables.tf`.** Copy these blocks from `infra/variables.tf` unchanged, with the same names, types, defaults and validations:
  - `cloudflare_zone_id`, `ssh_public_key`, `wg_server_private_key`, `wg_dns_name`, `wg_port`, `wg_subnet`, `wg_subnet6`, `loopback_ip`
  - `vnet_cidr`, `subnet_cidr`, `workload_subnet_cidr`, `test_vm`, `published_ports`
  - `home_lan_cidr`, `ssh_allowed_cidr`, `ssh_password`, `peers_json`, `agent_url`, `agent_token`, `run_id`

  Then add:

```hcl
variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-2"
}

variable "vm_size" {
  description = "EC2 instance type for the headend. A 'g' type (t4g) is ARM; the AMI follows."
  type        = string
  default     = "t4g.micro"
}

variable "test_vm_size" {
  description = "EC2 instance type for the optional test VM. Must be the same CPU family as vm_size."
  type        = string
  default     = "t4g.nano"
}

variable "boot_bundle_sha256" {
  description = "SHA-256 of boot/<run id>.tgz in R2 (wg-aws.yml). Empty only for destroy."
  type        = string
  default     = ""
  validation {
    condition     = var.boot_bundle_sha256 == "" || can(regex("^[0-9a-f]{64}$", var.boot_bundle_sha256))
    error_message = "boot_bundle_sha256 must be 64 hex characters."
  }
}
```

  Do not declare `resource_group`, `vnet_cidr6` or `firewall_nft_b64` (Azure-only). A `TF_VAR_` with no matching variable is ignored.

- [ ] **Step 5: `infra/aws/main.tf`.** Start the file with this header and `locals {`. Then copy, verbatim from `infra/main.tf`, every line from `  peers = [` through the closing `  ])` of `peers_conf`, except the Azure-only `subnet_cidr6` and `common_tags` entries. That covers `peers`, `wg_server_ip`, `wg_prefix_len`, `ipv6`, `wg_server_ip6`, `peer_ip6`, `route_keep_out`, `site_routes` and `peers_conf`, and keeps their comments. `tf-twins.test.mjs` checks the copy. Then continue the same `locals` block, and the file, with the rest below.

```hcl
# main.tf (AWS)
#
# Plain English: the same headend as infra/main.tf, built in AWS London.
#   VPC 10.50.0.0/16 (the same plan as Azure's VNet, so client configs never change)
#     snet-wg 10.50.1.0/24        the WireGuard server, Elastic IP, IPv6
#     snet-workloads 10.50.2.0/24 servers behind it; default route = the server
#   Security group sg-wg: WireGuard UDP, SSH from home, published ports, the VPC.
# The server routes between tunnel, VPC and internet, so its source/destination
# check is off (AWS drops forwarded packets otherwise).
# Everything carries wg-admin=vpn (provider default_tags) so the workflow's
# safety net and the Worker can find it all.

locals {
  # ── Copied from infra/main.tf (scripts/test/tf-twins.test.mjs keeps them identical) ──
  # (peers … peers_conf, pasted here)

  arm = can(regex("^[a-z]+[0-9]+g[a-z]*\\.", var.vm_size))

  # The server's boot script. Same template as Azure; the agent files arrive
  # in the boot bundle (AWS allows 16 KB of user data), so they are empty here.
  cloud_init = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
    wg_server_private_key = var.wg_server_private_key
    wg_server_ip          = local.wg_server_ip
    wg_prefix_len         = local.wg_prefix_len
    wg_server_ip6         = local.wg_server_ip6
    wg_prefix_len6        = local.ipv6 ? split("/", var.wg_subnet6)[1] : ""
    wg_port               = var.wg_port
    loopback_ip           = var.loopback_ip
    ssh_password          = var.ssh_password
    peers_conf            = local.peers_conf
    agent_url             = var.agent_url
    agent_token           = var.agent_token
    agent_script_gz       = base64gzip("")
    agent_service         = file("${path.module}/../agent/wg-agent.service")
    agent_timer           = file("${path.module}/../agent/wg-agent.timer")
    selftest_script       = ""
    selftest_service      = file("${path.module}/../agent/wg-selftest.service")
    blocklist_script      = ""
    blocklist_service     = file("${path.module}/../agent/wg-blocklist.service")
    speedtest_script      = ""
    capture_script        = ""
    firewall_load_script  = ""
    vnet_cidr             = var.vnet_cidr
    firewall_nft_gz       = base64gzip("")
    vitals_script_gz      = base64gzip("")
    admin_user            = "ubuntu"
    wan_if                = "ens5"
    azure_only            = ""
    cloud                 = "aws"
    boot_bundle_sha256    = var.boot_bundle_sha256
  })
}

data "aws_availability_zones" "up" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.arm ? "arm64" : "amd64"}-server-*"]
  }
}

resource "aws_vpc" "wg" {
  cidr_block                       = var.vnet_cidr
  assign_generated_ipv6_cidr_block = local.ipv6
  enable_dns_support               = true
  enable_dns_hostnames             = true
  tags                             = { Name = "vpc-wg" }
}

resource "aws_internet_gateway" "wg" {
  vpc_id = aws_vpc.wg.id
  tags   = { Name = "igw-wg" }
}

resource "aws_subnet" "wg" {
  vpc_id                          = aws_vpc.wg.id
  cidr_block                      = var.subnet_cidr
  availability_zone               = data.aws_availability_zones.up.names[0]
  ipv6_cidr_block                 = local.ipv6 ? cidrsubnet(aws_vpc.wg.ipv6_cidr_block, 8, 1) : null
  assign_ipv6_address_on_creation = local.ipv6
  tags                            = { Name = "snet-wg" }
}

resource "aws_route_table" "wg" {
  vpc_id = aws_vpc.wg.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.wg.id
  }
  dynamic "route" {
    for_each = local.ipv6 ? [1] : []
    content {
      ipv6_cidr_block = "::/0"
      gateway_id      = aws_internet_gateway.wg.id
    }
  }
  tags = { Name = "rt-wg" }
}

resource "aws_route_table_association" "wg" {
  subnet_id      = aws_subnet.wg.id
  route_table_id = aws_route_table.wg.id
}

resource "aws_key_pair" "wg" {
  key_name   = "wg-admin-${var.run_id}"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "wg" {
  name        = "sg-wg"
  description = "wg-admin headend"
  vpc_id      = aws_vpc.wg.id
  tags        = { Name = "sg-wg", "wg-admin-role" = "headend" }

  ingress {
    description      = "wireguard"
    protocol         = "udp"
    from_port        = var.wg_port
    to_port          = var.wg_port
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  # The Worker edits this rule live (SSH from here); same name.
  dynamic "ingress" {
    for_each = var.ssh_allowed_cidr != "" ? [var.ssh_allowed_cidr] : []
    content {
      description = "ssh-from-home"
      protocol    = "tcp"
      from_port   = 22
      to_port     = 22
      cidr_blocks = [ingress.value]
    }
  }

  # Published ports; the Worker keeps these in step with the Firewall tab.
  dynamic "ingress" {
    for_each = var.published_ports
    content {
      description = ingress.value.name
      protocol    = lower(ingress.value.protocol)
      from_port   = tonumber(ingress.value.port)
      to_port     = tonumber(ingress.value.port)
      cidr_blocks = [ingress.value.source == "*" ? "0.0.0.0/0" : ingress.value.source]
    }
  }

  ingress {
    description = "from-vpc"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [var.vnet_cidr]
  }

  egress {
    protocol         = "-1"
    from_port        = 0
    to_port          = 0
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_instance" "wg" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.vm_size
  subnet_id                   = aws_subnet.wg.id
  vpc_security_group_ids      = [aws_security_group.wg.id]
  key_name                    = aws_key_pair.wg.key_name
  source_dest_check           = false
  ipv6_address_count          = local.ipv6 ? 1 : 0
  user_data_base64            = base64gzip(local.cloud_init)
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
    # default_tags do not reach the root volume; tag it so the safety net and cost see it.
    tags = { "wg-admin" = "vpn", project = "wg-admin", run_id = var.run_id, Name = "osdisk-wg" }
  }

  tags = { Name = "vm-wg", "wg-admin-role" = "headend" }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "wg" {
  domain   = "vpc"
  instance = aws_instance.wg.id
  tags     = { Name = "pip-wg" }
}

# ── Workloads: servers behind the WireGuard firewall ─────────────────────────
resource "aws_subnet" "workloads" {
  vpc_id            = aws_vpc.wg.id
  cidr_block        = var.workload_subnet_cidr
  availability_zone = data.aws_availability_zones.up.names[0]
  tags              = { Name = "snet-workloads" }
}

resource "aws_route_table" "workloads" {
  vpc_id = aws_vpc.wg.id
  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = aws_instance.wg.primary_network_interface_id
  }
  tags = { Name = "rt-workloads" }
}

resource "aws_route_table_association" "workloads" {
  subnet_id      = aws_subnet.workloads.id
  route_table_id = aws_route_table.workloads.id
}

resource "aws_security_group" "workloads" {
  name        = "sg-workloads"
  description = "wg-admin workloads: reachable from the tunnel, the VPC and home only"
  vpc_id      = aws_vpc.wg.id
  tags        = { Name = "sg-workloads" }

  ingress {
    description = "tunnel-vpc-home"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = compact([var.wg_subnet, "${var.loopback_ip}/32", var.vnet_cidr, var.home_lan_cidr])
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "test" {
  count                  = var.test_vm ? 1 : 0
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.test_vm_size
  subnet_id              = aws_subnet.workloads.id
  vpc_security_group_ids = [aws_security_group.workloads.id]
  key_name               = aws_key_pair.wg.key_name
  user_data              = templatefile("${path.module}/../test-vm.yaml.tftpl", { ssh_password = var.ssh_password, admin_user = "ubuntu" })

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
    tags                  = { "wg-admin" = "vpn", project = "wg-admin", run_id = var.run_id, Name = "osdisk-test" }
  }

  tags       = { Name = "vm-test" }
  depends_on = [aws_route_table_association.workloads]

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "cloudflare_dns_record" "wg" {
  zone_id = var.cloudflare_zone_id
  name    = var.wg_dns_name
  type    = "A"
  content = aws_eip.wg.public_ip
  ttl     = 60
  proxied = false
  comment = "Managed by wg-admin Terraform. Do not edit by hand."
}
```

  Check `cloudflare_dns_record.wg` against `infra/main.tf:462` and copy any attribute this version lacks.

- [ ] **Step 6: `infra/aws/outputs.tf`.** Same output names and descriptions as `infra/outputs.tf`, with these values:

```hcl
output "public_ip" {
  description = "The server's public (WAN) address. wg.clydeford.net points at it."
  value       = aws_eip.wg.public_ip
}

output "public_ip6" {
  description = "The server's IPv6 WAN address, or empty."
  value       = local.ipv6 ? aws_instance.wg.ipv6_addresses[0] : ""
}

output "vm_private_ip" {
  description = "The server's address inside the VPC."
  value       = aws_instance.wg.private_ip
}

output "resource_group" {
  description = "AWS has no resource groups here: everything is tagged wg-admin=vpn."
  value       = "wg-admin=vpn (${var.region})"
}

output "dns_name" {
  description = "The name clients dial."
  value       = cloudflare_dns_record.wg.name
}

output "wg_server_ip" {
  description = "The server's tunnel address."
  value       = local.wg_server_ip
}

output "loopback_ip" {
  description = "The server's loopback test address. Ping it from a connected client."
  value       = var.loopback_ip
}

output "deployed_at" {
  description = "UTC timestamp of this apply."
  value       = timestamp()
}

output "test_vm_ip" {
  description = "The test VM's address in the workloads subnet, or empty."
  value       = var.test_vm ? aws_instance.test[0].private_ip : ""
}
```

- [ ] **Step 7: Init and lock.** From `infra/aws`, run `terraform init -backend=false` and then `terraform providers lock -platform=linux_amd64 -platform=windows_amd64`. Commit the `.terraform.lock.hcl`. Run `npm run tf-validate`. Expected: "Terraform OK" for all three roots.

- [ ] **Step 8: AWS size test.** In `worker/test/cloud-init-size.test.ts`, add:

```ts
describe("AWS user data", () => {
  const AWS_LIMIT = 16 * 1024;
  const AWS_CEILING = 12 * 1024;
  it("every template variable is passed by infra/aws/main.tf too", () => {
    const tf = read("infra/aws/main.tf");
    const start = tf.indexOf('cloud_init = templatefile("${path.module}/../cloud-init.yaml.tftpl", {');
    const call = tf.slice(start, tf.indexOf("\n  })\n", start));
    const names = new Set([...read("infra/cloud-init.yaml.tftpl").matchAll(/\$\{(?:indent\(\d+, )?([a-z0-9_]+)\)?\}/g)].map((m) => m[1]));
    for (const n of names) expect(call, n).toMatch(new RegExp(`\\n    ${n}\\s+=`));
  });
  it("the worst case, gzipped as Terraform sends it, stays under 12 KB", () => {
    const v = { ...worstVars(), agent_script_gz: b64gzip(""), vitals_script_gz: b64gzip(""), firewall_nft_gz: b64gzip(""), selftest_script: "", blocklist_script: "", speedtest_script: "", capture_script: "", firewall_load_script: "", admin_user: "ubuntu", wan_if: "ens5", azure_only: "", cloud: "aws", boot_bundle_sha256: "a".repeat(64) };
    const rendered = renderTemplate(read("infra/cloud-init.yaml.tftpl"), v);
    const bytes = gzipSync(Buffer.from(rendered, "utf8"), { level: 9 }).length;
    expect(bytes).toBeLessThanOrEqual(AWS_CEILING);
    expect(bytes).toBeLessThan(AWS_LIMIT);
    expect(rendered).toContain("/bundle");
    expect(rendered).not.toContain("168.63.129.16");
  });
});
```

  Use the helper names the file already has (`read`, `worstVars`, `b64gzip`, `renderTemplate`, `gzipSync`). If the regex for names would also catch shell `${…}` inside the template (it should not, since those are escaped as `$${`), filter to names that appear in Azure's `templatefile` call.

- [ ] **Step 9: CI.** In `.github/workflows/ci.yml` job `terraform`, after the existing `validate` step, add:

```yaml
      - name: validate (AWS)
        working-directory: infra/aws
        run: |
          terraform init -backend=false -input=false -no-color
          terraform validate -no-color
```

  If the CI `fmt` step only covers `infra` recursively, it already includes `infra/aws`.

- [ ] **Step 10: Run the tests.** Run `node --test scripts/test/tf-twins.test.mjs` and `npx vitest run worker/test/cloud-init-size.test.ts`. Expected: PASS.
- [ ] **Step 11: Commit**

```bash
git add infra/aws scripts/test/tf-twins.test.mjs worker/test/cloud-init-size.test.ts .github/workflows/ci.yml
git commit -m "infra/aws: the headend in AWS London (VPC, Elastic IP, security group, workloads, test VM)"
```

### Task 13: The `wg-aws.yml` workflow and its safety net

**Files:**
- Create: `.github/workflows/wg-aws.yml`, `infra/ci/boot-bundle.sh`, `infra/ci/aws-token.sh`, `infra/ci/aws-safety-net.sh`
- Modify: `infra/ci/live-log.mjs` (`SECRET_ENV`)
- Test: `scripts/test/wg-aws-workflow.test.mjs`, `scripts/test/boot-bundle.test.mjs`

**Interfaces:**
- Consumes: GitHub secret `AWS_DEPLOY_ROLE_ARN` (Task 4); the existing repo secrets `R2_*`, `CLOUDFLARE_*`, `SSH_PUBLIC_KEY`, `WG_SERVER_PRIVATE_KEY`; the payload keys from Task 7; `boot/<run id>.tgz` (Task 10)
- Produces: the run-name `wg <action> <run id>` (the Worker finds it by title), and the same callbacks as `wg.yml`.

- [ ] **Step 1: Failing tests.**

  `scripts/test/boot-bundle.test.mjs`:

```js
// The boot bundle carries each file with the same mode cloud-init would have given it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("bundle paths and modes match the template", () => {
  const tpl = readFileSync("infra/cloud-init.yaml.tftpl", "utf8").replace(/\r\n/g, "\n");
  const modes = new Map([...tpl.matchAll(/- path: (\S+)\n\s+permissions: "(\d+)"/g)].map((m) => [m[1], m[2]]));
  const sh = readFileSync("infra/ci/boot-bundle.sh", "utf8").replace(/\r\n/g, "\n");
  const puts = [...sh.matchAll(/^put "\$root\/(\S+)" (\S+) (\d+)$/gm)].map((m) => ({ src: m[1], path: m[2], mode: m[3] }));
  assert.ok(puts.length >= 7, "boot-bundle.sh puts the agent scripts");
  for (const p of puts) assert.equal(p.mode, modes.get(p.path), `${p.path} mode`);
  assert.equal(modes.get("/etc/wg-admin/firewall.nft"), "0600");
  assert.match(sh, /install -D -m 0600 .*etc\/wg-admin\/firewall\.nft/);
});
```

  `scripts/test/wg-aws-workflow.test.mjs`:

```js
// wg-aws.yml: AWS in by role (no keys), R2 by file, the same shape as wg.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";

const aws = YAML.parse(readFileSync(".github/workflows/wg-aws.yml", "utf8"));
const az = YAML.parse(readFileSync(".github/workflows/wg.yml", "utf8"));
const steps = aws.jobs.terraform.steps;
const step = (n) => steps.find((s) => s.name === n) ?? assert.fail(`missing step ${n}`);

test("same inputs, run-name, concurrency and permissions as wg.yml", () => {
  assert.deepEqual(Object.keys(aws.on.workflow_dispatch.inputs), Object.keys(az.on.workflow_dispatch.inputs));
  assert.equal(aws["run-name"], az["run-name"]);
  assert.deepEqual(aws.concurrency, az.concurrency);
  assert.equal(aws.permissions["id-token"], "write");
  assert.equal(aws.jobs.terraform.defaults.run["working-directory"], "infra/aws");
});

test("no Azure, no AWS keys: the role and a web identity token", () => {
  for (const s of steps) {
    const env = s.env ?? {};
    assert.ok(!Object.keys(env).some((k) => k.startsWith("ARM_")), `${s.name} has ARM_*`);
  }
  for (const n of ["terraform apply", "terraform destroy", "Verify AWS is clean (fallback delete)"]) {
    const env = step(n).env ?? {};
    assert.ok(!("AWS_ACCESS_KEY_ID" in env), `${n} must not carry access keys`);
    assert.match(String(env.AWS_ROLE_ARN), /secrets\.AWS_DEPLOY_ROLE_ARN/);
    assert.match(step(n).run, /source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-token\.sh"/);
  }
});

test("R2 state credentials go in by file, never as AWS_* variables", () => {
  const init = step("terraform init (state in R2)");
  assert.ok(!("AWS_ACCESS_KEY_ID" in (init.env ?? {})));
  assert.match(init.run, /-backend-config="\$RUNNER_TEMP\/r2\.hcl"/);
});

test("streamed steps start the live log; destroy steps only on destroy", () => {
  for (const n of ["terraform init (state in R2)", "Build boot bundle", "terraform apply", "terraform destroy", "Verify AWS is clean (fallback delete)", "Park DNS record", "Back up state"]) {
    assert.equal(step(n).run.split("\n")[0], `source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "${n}"`);
  }
  for (const n of ["terraform destroy", "Verify AWS is clean (fallback delete)", "Park DNS record"]) assert.equal(step(n).if, "inputs.action == 'destroy'");
  assert.equal(step("Build boot bundle").if, "inputs.action == 'apply'");
  const names = steps.map((s) => s.name);
  assert.ok(names.indexOf("Build boot bundle") < names.indexOf("terraform apply"));
});
```

  Run: `node --test scripts/test/wg-aws-workflow.test.mjs scripts/test/boot-bundle.test.mjs`. Expected: FAIL.

- [ ] **Step 2: `infra/ci/boot-bundle.sh`**

```bash
#!/usr/bin/env bash
# boot-bundle.sh OUT.tgz
#
# Plain English: packs the files an AWS server needs at first boot that will
# not fit in AWS's 16 KB of user data: the agent scripts and this deploy's
# firewall rules. wg-aws.yml uploads it to R2 as boot/<run id>.tgz; the server
# fetches it from the Worker with its own token and checks the SHA-256.
# Modes match cloud-init.yaml.tftpl (scripts/test/boot-bundle.test.mjs).
set -euo pipefail
out="$1"
root="$(cd "$(dirname "$0")/../agent" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage" "$stage.list"' EXIT
put() { install -D -m "$3" "$1" "$stage$2"; }

put "$root/wg-agent.sh" /usr/local/sbin/wg-agent.sh 0755
put "$root/wg-vitals.sh" /usr/local/sbin/wg-vitals.sh 0755
put "$root/wg-selftest.sh" /usr/local/sbin/wg-selftest.sh 0755
put "$root/wg-blocklist.sh" /usr/local/sbin/wg-blocklist.sh 0755
put "$root/wg-speedtest.sh" /usr/local/sbin/wg-speedtest.sh 0755
put "$root/wg-capture.sh" /usr/local/sbin/wg-capture.sh 0755
put "$root/wg-firewall-load.sh" /usr/local/sbin/wg-firewall-load.sh 0755

# This deploy's firewall (from the Worker, via "Collect run secrets"), else the open default.
if [[ -n "${TF_VAR_firewall_nft_b64:-}" ]]; then
  base64 -d <<<"$TF_VAR_firewall_nft_b64" > "$stage/fw.tmp"
else
  cp "$root/firewall-open.nft" "$stage/fw.tmp"
fi
install -D -m 0600 "$stage/fw.tmp" "$stage/etc/wg-admin/firewall.nft"
rm -f "$stage/fw.tmp"

# Files only, no directory entries: unpacking never changes /usr or /etc themselves.
( cd "$stage" && find . -type f | sed 's#^\./##' | sort ) > "$stage.list"
tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 00:00Z' -czf "$out" -T "$stage.list"
```

  Before relying on the modes above, check them against the `permissions:` lines in `infra/cloud-init.yaml.tftpl`. The test enforces this, so fix the script if any differ (for example `wg-firewall-load.sh` may be `0700`).

- [ ] **Step 3: `infra/ci/aws-token.sh`**

```bash
# aws-token.sh: sourced by every step that talks to AWS.
#
# Plain English: fetch a fresh signed identity from GitHub for AWS (audience
# sts.amazonaws.com). The AWS provider and CLI trade it for the
# wg-admin-deploy role (AWS_ROLE_ARN). Tokens last minutes and a run can last
# longer, so each step gets its own. Never printed.
curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value > "$RUNNER_TEMP/aws-token"
chmod 600 "$RUNNER_TEMP/aws-token"
export AWS_WEB_IDENTITY_TOKEN_FILE="$RUNNER_TEMP/aws-token"
```

- [ ] **Step 4: `infra/ci/aws-safety-net.sh`**

```bash
#!/usr/bin/env bash
# aws-safety-net.sh
#
# Plain English: after terraform destroy, make sure nothing tagged
# wg-admin=vpn is left in the region (the AWS twin of "delete the resource
# group by name"). Deletes in dependency order, then checks again and fails
# loudly if anything survived. Never touches anything without the tag.
set -euo pipefail
R="${AWS_REGION:-eu-west-2}"
TAG=(Name=tag:wg-admin,Values=vpn)
q() { aws ec2 "$@" --region "$R" --output text; }

inst="$(q describe-instances --filters "${TAG[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId')"
if [[ -n "$inst" ]]; then
  echo "::warning::terminating $inst"
  aws ec2 terminate-instances --region "$R" --instance-ids $inst >/dev/null
  aws ec2 wait instance-terminated --region "$R" --instance-ids $inst
fi
for a in $(q describe-addresses --filters "${TAG[@]}" --query 'Addresses[].AllocationId'); do
  echo "::warning::releasing $a"; aws ec2 release-address --region "$R" --allocation-id "$a" || true
done
for v in $(q describe-volumes --filters "${TAG[@]}" Name=status,Values=available --query 'Volumes[].VolumeId'); do
  echo "::warning::deleting $v"; aws ec2 delete-volume --region "$R" --volume-id "$v" || true
done
for k in $(q describe-key-pairs --filters "${TAG[@]}" --query 'KeyPairs[].KeyName'); do
  aws ec2 delete-key-pair --region "$R" --key-name "$k" || true
done
for vpc in $(q describe-vpcs --filters "${TAG[@]}" --query 'Vpcs[].VpcId'); do
  echo "::warning::removing $vpc and what is in it"
  for sg in $(q describe-security-groups --filters Name=vpc-id,Values="$vpc" --query "SecurityGroups[?GroupName!='default'].GroupId"); do
    aws ec2 delete-security-group --region "$R" --group-id "$sg" || true
  done
  for igw in $(q describe-internet-gateways --filters Name=attachment.vpc-id,Values="$vpc" --query 'InternetGateways[].InternetGatewayId'); do
    aws ec2 detach-internet-gateway --region "$R" --internet-gateway-id "$igw" --vpc-id "$vpc" || true
    aws ec2 delete-internet-gateway --region "$R" --internet-gateway-id "$igw" || true
  done
  for sn in $(q describe-subnets --filters Name=vpc-id,Values="$vpc" --query 'Subnets[].SubnetId'); do
    aws ec2 delete-subnet --region "$R" --subnet-id "$sn" || true
  done
  for rt in $(q describe-route-tables --filters Name=vpc-id,Values="$vpc" --query 'RouteTables[?length(Associations[?Main==`true`])==`0`].RouteTableId'); do
    aws ec2 delete-route-table --region "$R" --route-table-id "$rt" || true
  done
  aws ec2 delete-vpc --region "$R" --vpc-id "$vpc" || true
done

left="$(q describe-instances --filters "${TAG[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId') $(q describe-vpcs --filters "${TAG[@]}" --query 'Vpcs[].VpcId') $(q describe-addresses --filters "${TAG[@]}" --query 'Addresses[].AllocationId')"
if [[ -n "${left// /}" ]]; then
  echo "::error::still in AWS after clean-up: $left"
  exit 1
fi
echo "AWS clean: nothing tagged wg-admin=vpn in $R"
```

- [ ] **Step 5: `.github/workflows/wg-aws.yml`.** Build it from `wg.yml`. Exact sources:
  - **Header comment.** A new plain-English header: "the AWS twin of wg.yml: same inputs, same callbacks; AWS by role (OIDC), state in R2 by file".
  - **Top-level keys:**
    - `name: wg-aws`
    - `run-name`: identical to `wg.yml:39`
    - `on`: identical to `wg.yml:41-59`
    - `concurrency`: identical to `wg.yml:68-70`
    - `permissions`: identical to `wg.yml:72-77`
  - **`env`:**

```yaml
env:
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "0"
  TF_PLUGIN_CACHE_DIR: ${{ github.workspace }}/.terraform-plugins
```

    No workflow-level `AWS_REGION`; each step sets its own.
  - **Job `terraform`:** same `name`, `runs-on`, `timeout-minutes` as `wg.yml`, with `defaults.run.working-directory: infra/aws`. Steps in this order:
    1. **Check out** (copy).
    2. **Parse payload** (copy `wg.yml:113-146` verbatim). The extra `cloud` key in the payload is simply not in its list.
    3. **Collect run secrets from the Worker** (copy `wg.yml:152-181`).
    4. **Start live log** (copy).
    5. **Wait for any earlier wg run to finish** (copy `wg.yml:206-220`). If it lists runs of one workflow file, make it check both `wg.yml` and `wg-aws.yml`.
    6. **Set up Terraform** (copy).
    7. **Cache Terraform providers** (copy, with the key `tf-plugins-aws-${{ hashFiles('infra/aws/.terraform.lock.hcl') }}`).
    8. **terraform init (state in R2):**

```yaml
      - name: terraform init (state in R2)
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_ENDPOINT: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "terraform init (state in R2)"
          set -euo pipefail
          mkdir -p "$TF_PLUGIN_CACHE_DIR"
          # The R2 keys go to the backend in a file, so they never sit in
          # AWS_* variables the AWS provider would also read.
          umask 077
          printf 'bucket = "%s"\naccess_key = "%s"\nsecret_key = "%s"\nendpoints = { s3 = "%s" }\n' \
            "$R2_BUCKET" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" "$R2_ENDPOINT" > "$RUNNER_TEMP/r2.hcl"
          terraform init -no-color -backend-config="$RUNNER_TEMP/r2.hcl"
```

    9. **Build boot bundle:**

```yaml
      - name: Build boot bundle
        if: inputs.action == 'apply'
        env:
          # R2, spoken to as S3, for this one upload.
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_ENDPOINT_URL_S3: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
          AWS_REGION: auto
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Build boot bundle"
          set -euo pipefail
          out="$RUNNER_TEMP/boot.tgz"
          bash "$GITHUB_WORKSPACE/infra/ci/boot-bundle.sh" "$out"
          aws s3 cp --only-show-errors "$out" "s3://$R2_BUCKET/boot/$WORKER_RUN_ID.tgz"
          echo "TF_VAR_boot_bundle_sha256=$(sha256sum "$out" | cut -d' ' -f1)" >> "$GITHUB_ENV"
          echo "boot bundle: $(stat -c %s "$out") bytes"
```

    10. **terraform apply:** `if: inputs.action == 'apply'`, `id: apply`.

```yaml
        env:
          AWS_ROLE_ARN: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          AWS_ROLE_SESSION_NAME: wg-admin-${{ github.run_id }}
          AWS_REGION: eu-west-2
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_DNS_TOKEN }}
          TF_VAR_cloudflare_zone_id: ${{ secrets.CLOUDFLARE_ZONE_ID }}
          TF_VAR_ssh_public_key: ${{ secrets.SSH_PUBLIC_KEY }}
          TF_VAR_wg_server_private_key: ${{ secrets.WG_SERVER_PRIVATE_KEY }}
          NAME: ${{ env.TF_VAR_wg_dns_name || 'wg.clydeford.net' }}
```

        `run:` starts with:

```bash
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "terraform apply"
          set -euo pipefail
          source "$GITHUB_WORKSPACE/infra/ci/aws-token.sh"
          [ -n "${TF_VAR_boot_bundle_sha256:-}" ] || { echo "::error::no boot bundle"; exit 1; }
```

        Then copy the body of `wg.yml`'s apply step verbatim, from the parked-record adoption comment through the `GITHUB_STEP_SUMMARY` lines (`wg.yml:270-300`).
    11. **terraform destroy:** `if: inputs.action == 'destroy'`, `id: destroy`, `continue-on-error: true`. Same env as apply without `NAME`. `run:` starts with the live-log line, `set -euo pipefail` and `source …/aws-token.sh`, followed by the body of `wg.yml`'s destroy step (`wg.yml:401-410`).
    12. **Verify AWS is clean (fallback delete):** `if: inputs.action == 'destroy'`. Env: `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `AWS_REGION: eu-west-2`.

```yaml
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Verify AWS is clean (fallback delete)"
          set -euo pipefail
          source "$GITHUB_WORKSPACE/infra/ci/aws-token.sh"
          bash "$GITHUB_WORKSPACE/infra/ci/aws-safety-net.sh"
```

    13. **Park DNS record**, **Note destroy fallback**, **Back up state** (use the backup key prefix `backups/aws-`), **Finish live log**, **Report result to the Worker**: copy `wg.yml:439-523` verbatim, changing only the backup prefix.

  There is no "Remove lab peerings" step, because labs never peer with AWS.

- [ ] **Step 6: `infra/ci/live-log.mjs`.** Add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` and `AWS_ROLE_ARN` to `SECRET_ENV`, along with any other secret-sourced env name the new workflow uses that is missing. `scripts/test/live-log.test.mjs` checks every workflow it reads. If it only reads `wg.yml`, extend its file list to include `wg-aws.yml`.
- [ ] **Step 7: Run the tests.** Run `node --test scripts/test/wg-aws-workflow.test.mjs scripts/test/boot-bundle.test.mjs scripts/test/live-log.test.mjs scripts/test/wg-workflow.test.mjs`. Expected: PASS. If `bash` is on PATH, also run `bash -n infra/ci/boot-bundle.sh infra/ci/aws-safety-net.sh infra/ci/aws-token.sh`.
- [ ] **Step 8: Commit**

```bash
git add .github/workflows/wg-aws.yml infra/ci scripts/test
git commit -m "wg-aws.yml: AWS apply/destroy by OIDC role, boot bundle upload, tag-based safety net"
```

---

## Phase E: the dashboard

### Task 14: Cloud picker and badge

**Files:**
- Modify: `worker/src/api/overview.ts` (`config.aws`), `shared/api.ts` (`OverviewResponse.config.aws`)
- Create: `web/src/views/overview/cloud.ts`
- Modify: `web/src/views/overview/actions.tsx` (`DeployForm` 94-119, `DeployDialog` 180-183), `web/src/api/mutations.ts:100-106`, `web/src/shell/StateChip.tsx:62-65`, the web region helper (wherever `regionFull` / `regionShort` / `regionLabel` live: `grep -rn "export function regionFull" web/src shared`), and `web/src/views/overview/testData.ts` (fixture gains `config.aws`)
- Test: `web/src/views/overview/overview.test.tsx` (new cases), `web/src/shell/StateChip.test.tsx` (create if absent)

**Interfaces:**
- Produces:
  - `OverviewResponse.config.aws: { enabled: boolean; region: string; instanceType: string; hourlyRateGbp: number; standbyRateGbp: number }`. `enabled` = `AWS_ENABLED === "1"` and the Worker keys are set.
  - `DeployVars.cloud?: "aws"`
  - `cloudOf(o)`, `cloudLabel(c)`, `cloudFull(c)`

- [ ] **Step 1: Failing web tests.** Add to `overview.test.tsx`, following the file's existing style with `routes(overview(...))`:

```tsx
  it("AWS off: the deploy form has no cloud choice", async () => {
    renderApp("/", { routes: routes(overview("destroyed")) });
    const form = within(await banner()).getByRole("form", { name: "Deploy" });
    expect(within(form).queryByRole("group", { name: "Cloud" })).toBeNull();
  });

  it("deploys to AWS: London, no region or profile, cloud=aws", async () => {
    const user = userEvent.setup();
    const o = overview("destroyed");
    o.config.aws.enabled = true;
    const r = renderApp("/", { routes: routes(o, { "POST /api/v1/deploy": ok }) });
    const form = within(await banner()).getByRole("form", { name: "Deploy" });
    await user.click(within(form).getByRole("button", { name: "AWS" }));
    expect(within(form).getByText(/AWS London/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")[0].body).toEqual({ hours: 4, cloud: "aws", overBudgetOk: false });
  });

  it("an Azure deploy body is unchanged with AWS on", async () => {
    const user = userEvent.setup();
    const o = overview("destroyed");
    o.config.aws.enabled = true;
    const r = renderApp("/", { routes: routes(o, { "POST /api/v1/deploy": ok }) });
    const form = within(await banner()).getByRole("form", { name: "Deploy" });
    await user.click(within(form).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")).toHaveLength(1));
    expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")[0].body).toEqual({ hours: 4, profileId: 1, overBudgetOk: false });
  });
```

  Match how `Chips` exposes its group and items (group and button roles, or radiogroup and radio) by reading `components/forms/Chips.tsx`, and use those roles in the queries.

  `StateChip.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { chipLabel } from "./StateChip";
import { overview } from "@/views/overview/testData";

describe("chipLabel", () => {
  it("names the cloud and region", () => {
    const o = overview("running");
    expect(chipLabel(o)).toMatch(/^Azure • /);
    o.snapshot.cloud = "aws";
    o.snapshot.region = "eu-west-2";
    expect(chipLabel(o)).toBe("AWS • London");
  });
});
```

  If `overview()` is not importable from there, build the minimal object the function reads.

  Run: `npx vitest run --project web web/src/views/overview/overview.test.tsx web/src/shell/StateChip.test.tsx`. Expected: FAIL.

- [ ] **Step 2: Server and shared types.**
  - `api/overview.ts`: add `aws: { enabled: cfg.aws.enabled && canAws(c.env), region: cfg.aws.region, instanceType: cfg.aws.instanceType, hourlyRateGbp: cfg.aws.hourlyRateGbp, standbyRateGbp: cfg.aws.standbyRateGbp }` to `config`.
  - `shared/api.ts`: add the matching type to `OverviewResponse.config`.
  - `testData.ts`: give `overview()` `config.aws = { enabled: false, region: "eu-west-2", instanceType: "t4g.micro", hourlyRateGbp: 0.011, standbyRateGbp: 0.005 }` and `snapshot.cloud = null`. Do the same in any other fixture that builds an `OverviewResponse` (`grep -rln "hourlyRateGbp" web/src --include=*.ts*`).

- [ ] **Step 3: `web/src/views/overview/cloud.ts`**

```ts
// cloud.ts
//
// Plain English: which cloud the headend is in, and its name for the screen.
// No cloud recorded means Azure (everything before AWS existed).

import type { Cloud, OverviewResponse } from "@shared/api";

export const cloudOf = (o: Pick<OverviewResponse, "snapshot">): Cloud => o.snapshot.cloud ?? "azure";
export const cloudLabel = (c: Cloud): "Azure" | "AWS" => (c === "aws" ? "AWS" : "Azure");
export const cloudFull = (c: Cloud): string => (c === "aws" ? "Amazon Web Services" : "Microsoft Azure");
```

  Use whatever alias `@shared` is in this repo (check an existing import in `web/src/views/overview/*.tsx`).

- [ ] **Step 4: Regions.** In the web region helper, add the AWS region so that `regionFull("eu-west-2")` returns "London (AWS)" and `regionShort` / `regionLabel` return "London":

```ts
/** AWS regions wg-admin uses. Only London today. */
export const AWS_REGIONS: Record<string, string> = { "eu-west-2": "London" };
```

  Each helper falls back to `AWS_REGIONS[id]` before its existing "unknown" result.

- [ ] **Step 5: `mutations.ts`.** Add to `DeployVars`: `/** Only for AWS; an Azure deploy sends no cloud (the server's default). */ cloud?: "aws";`.

- [ ] **Step 6: `DeployForm`** (`actions.tsx:94-119`):

```tsx
  const awsOn = o.config.aws.enabled && !demo;
  const [cloud, setCloud] = useState<Cloud>(() => (awsOn ? cloudOf(o) : "azure"));
  const current = cloudOf(o);
  const switching = cloud !== current && o.snapshot.state !== "destroyed";
```

  Render, above the "Where?" chips:

```tsx
      {awsOn && (
        <Chips mode="single" shape="rect" aria-label="Cloud"
          items={[{ value: "azure", label: "Azure" }, { value: "aws", label: "AWS" }]}
          value={[cloud]} onChange={(v) => v[0] && setCloud(v[0] as Cloud)} />
      )}
```

  Wrap it in the same field or label component the "Where?" and "For how long?" chips use, with the visible label "Cloud".
  - Show the "Where?" chips and the capacity warning only when `cloud === "azure"`.
  - When `cloud === "aws"`, show in their place: `<p className="…same class as the form's hints…">AWS London · {o.config.aws.instanceType} · about {gbp(o.config.aws.hourlyRateGbp)}/h running</p>`, using the money formatter `actions.tsx` already uses.
  - When `switching`, show `<p role="note">Tear down the {cloudLabel(current)} headend first. wg-admin runs one cloud at a time.</p>` and disable the Deploy button.
  - Submit:

```tsx
  const submit = () =>
    cloud === "aws"
      ? deploy.mutate({ hours: chipHours(hours), cloud: "aws", overBudgetOk: overOk }, { onSuccess: () => onDone?.() })
      : deploy.mutate({ hours: chipHours(hours), ...target, overBudgetOk: overOk }, { onSuccess: () => onDone?.() });
```

  `DeployDialog` description becomes `` `Builds the WireGuard server and points ${o.config.dnsName} at it.` ``

- [ ] **Step 7: `StateChip.chipLabel`**

```ts
export function chipLabel(o: OverviewResponse): string {
  const cloud = cloudLabel(cloudOf(o));
  const region = regionLabel(o.snapshot.region ?? (cloudOf(o) === "aws" ? o.config?.aws?.region : o.config?.region));
  return region ? `${cloud} • ${region}` : cloud;
}
```

  Keep the function's existing parameter type and the null-safety it already has.

- [ ] **Step 8: Run the tests.** Run `npx vitest run --project web web/src/views/overview web/src/shell`. Expected: PASS.
- [ ] **Step 9: Commit**

```bash
git add worker/src/api/overview.ts shared/api.ts web/src
git commit -m "Dashboard: Azure/AWS choice at deploy (hidden until AWS_ENABLED), cloud in the top-bar chip"
```

### Task 15: Settings, cost, insights placeholder, wording, labs guard

**Files:**
- Modify: `worker/src/api/settings.ts`, `shared/api.ts` (`SettingsResponse.aws`), `web/src/views/settings/DeploymentSection.tsx`
- Modify: `web/src/views/cost/{index.tsx,Tiles.tsx}`
- Modify: `web/src/views/overview/Insights.tsx`, `web/src/views/firewall/PublicIp.tsx`, `web/src/views/activity/{AzureChanges.tsx,ServiceHealth.tsx,PhoneAzure.tsx}`
- Modify: `worker/src/insights/runner.ts` (skip while AWS is live)
- Modify: `worker/src/api/labs.ts` (deploy: no connect on AWS)
- Modify: copy in the files listed in Step 6
- Test: new cases in `web/src/views/settings/*.test.tsx`, `web/src/views/cost/*.test.tsx`, `web/src/views/overview/insights*.test.tsx`, `worker/test/labs*.test.ts`, `worker/test/insights*.test.ts`

**Interfaces:**
- Produces:
  - `SettingsResponse.aws: { enabled: boolean; configured: boolean; region: string; instanceType: string; hourlyRateGbp: number; standbyRateGbp: number }`
  - `AWS_SOON_TEXT` (exported from `Insights.tsx`)

- [ ] **Step 1: Failing tests.** One case for each behaviour, in the existing test files, in their existing style:
  1. **Settings → Deployment.** With `aws.configured: true`, an "AWS" panel shows "London", "t4g.micro" and the two rates. With `configured: false` it says "Not set up: run scripts/aws-bootstrap.mjs".
  2. **Cost.** With `byCloud: { azure: 1.2, aws: 0.4 }`, the month-to-date tile shows "Azure £1.20 · AWS £0.40". With `aws: 0` the tile is unchanged.
  3. **Insights.** With `snapshot.cloud = "aws"` and state running, the Azure health panel shows `AWS_SOON_TEXT`, and no Azure figures.
  4. **Worker insights.** With `snapshot.cloud = "aws"`, a collector run makes no `management.azure.com` call. Use the existing insights test harness.
  5. **Worker labs.** With `snapshot.cloud = "aws"`, a lab deploy that asks to connect is accepted with `peer` off. Its message says "Connect needs an Azure headend; this lab runs unconnected."

  Run them. Expected: FAIL.

- [ ] **Step 2: Settings.**
  - `api/settings.ts` returns `aws: { enabled: cfg.aws.enabled, configured: canAws(c.env), region, instanceType, hourlyRateGbp, standbyRateGbp }`. Add the type to `shared/api.ts`.
  - `DeploymentSection.tsx`: after the "Next deploy" panel, add a read-only panel titled "AWS", using the same panel and field components as the section:
    - Region "London (eu-west-2)"
    - Instance type
    - "Running about £X/h · hibernated about £Y/h"
    - a status line: "Shown in Deploy" / "Set up; hidden from Deploy (AWS_ENABLED=0)" / "Not set up: run scripts/aws-bootstrap.mjs".

- [ ] **Step 3: Cost.**
  - `Tiles.tsx` month-to-date `sub`: when `cost.byCloud.aws > 0`, show `` `Azure ${gbp(cost.byCloud.azure)} · AWS ${gbp(cost.byCloud.aws)}` ``; otherwise keep today's text.
  - `index.tsx:132` subtitle: when `byCloud.aws > 0`, "…what the WireGuard server costs on Azure and AWS."; otherwise unchanged.

- [ ] **Step 4: Insights placeholder.**
  - In `Insights.tsx`, next to `NOT_CONNECTED_TEXT`:

```tsx
export const AWS_SOON_TEXT = "AWS insights are coming soon. These panels show Azure's figures when the server runs in Azure.";
```

  - In `VmPerformance`, `AzureHealth`, `Vitals` and `PublicIp`, add a first branch before the existing "not configured" check. Use `useOverview()` if the component doesn't already have `o`:

```tsx
  if (o && cloudOf(o) === "aws" && o.snapshot.state !== "destroyed") body = <AzNote>{AWS_SOON_TEXT}</AzNote>;
```

  - In `AzureChangesPanel`, `ServiceHealthPanel` and `PhoneAzure`, use `<EmptyState title="AWS insights are coming soon" description="These panels show Azure's figures when the server runs in Azure." />` under the same condition.
  - `insights/runner.ts`: at the start of a collector run, after it reads the snapshot or state, add:

```ts
  // An AWS headend has no Azure figures to collect (AWS insights are project 2).
  if (cloudOf(snap) === "aws" && snap.state !== "destroyed") return;
```

    If the runner records per-feed status, set each feed to `"skipped"` the way it already does for other skips.

- [ ] **Step 5: Labs.** In `worker/src/api/labs.ts`, in the lab deploy handler, where `peer` (connect to the headend) is read:

```ts
  const snap = await getSnapshot(c.env);
  const awsHeadend = cloudOf(snap) === "aws" && snap.state !== "destroyed";
  const peer = wantPeer && !awsHeadend;
```

  `wantPeer` is the existing value from the body. When `awsHeadend && wantPeer`, append "Connect needs an Azure headend; this lab runs unconnected." to the success message.

- [ ] **Step 6: Wording.** Change these user-facing strings (fact-sheet class "a": they really mean "the cloud"). `L` is `cloudLabel(cloudOf(o))` where an `OverviewResponse` is in scope.

| File:line | Now | Becomes |
|---|---|---|
| `views/overview/index.tsx:24` | "…your WireGuard environment on Azure." | "…your WireGuard environment in the cloud." |
| `views/overview/actions.tsx:319` | "Azure to ${site}…" | `` `${L} to ${site}…` `` |
| `views/overview/actions.tsx:372` | "…nothing was left in Azure…" | `` `…nothing was left in ${L}…` `` |
| `views/overview/Banner.tsx:32` (×2) | "Setting up WireGuard on Azure: …" | `` `Setting up WireGuard on ${L}: …` `` |
| `views/overview/Banner.tsx:42` | `regionShort(...) \|\| "Azure"` | `regionShort(...) \|\| L` |
| `views/overview/Banner.tsx:50` | "Nothing in Azure, £0." | "Nothing in the cloud, £0." |
| `views/overview/Run.tsx:124` | "Removing Azure resources…" / "Provisioning Azure resources…" | `` `Removing ${L} resources…` `` / `` `Provisioning ${L} resources…` `` |
| `views/overview/Topology.tsx:110` | `title="Microsoft Azure"` | `title={cloudFull(cloudOf(o))}` |
| `views/overview/Phone.tsx:115` | node label "Azure" | `L` |
| `views/overview/Side.tsx:188` | "…measure Azure to the home site." | `` `…measure ${L} to the home site.` `` |
| `views/overview/drawers.tsx:100,105,125,127` | "In Azure right now", "Check Azure now", "Azure reports nothing in …", "Waiting for the first Azure check…" | the same with `L` |
| `views/overview/model.ts:251` | "the resource group is not in Azure" | `` cloudOf(o) === "aws" ? "nothing tagged wg-admin=vpn is in AWS" : "the resource group is not in Azure" `` |
| `views/clients/AddClientWizard.tsx:131` | title "+ Azure VNet", hint "Reach … in Azure." | "+ Cloud network", "Reach … in the cloud network." |
| `views/clients/AddClientWizard.tsx:132` | "…through Azure (an exit node)…" | "…through the cloud server (an exit node)…" |
| `views/clients/ClientPanel.tsx:228` | "Azure VNet" | "Cloud network" |
| `views/firewall/Ports.tsx:71,98,168` | "This changes Azure and the VM…", "An address in the Azure VNet…", "The port closes on Azure and the VM…" | "This changes the cloud's firewall and the VM…", "An address in the cloud network…", "The port closes in the cloud and on the VM…" |
| `views/settings/MaintenanceSection.tsx:61,82` | "…everything Azure built…", "The VM and its Azure resources are deleted…" | "…everything the cloud built…", "The VM and its cloud resources are deleted…" |
| `shared/widgets.ts:182` | firewall zone label "Azure" | "Cloud" |

  The cost-page strings in `Tiles.tsx` / `Panels.tsx` that describe Azure's billing lag and breakdown stay, because they really are Azure's figures. Settings "Azure region", "Azure price" and the setup group "Azure checks and cost" stay too, because they are Azure settings.

  Then search the Worker's own message strings:

```bash
grep -n "Azure" worker/src/runs.ts worker/src/standby.ts worker/src/monitor.ts worker/src/actions.ts worker/src/budget.ts worker/src/notify*.ts
```

  For each message about the headend (ready, heads-up, session summary, drift, failure, cost guard), replace "Azure" with the label from `opsFor(cloudOf(snap)).label`. Leave messages about Azure-only things (labs, insights, service health) as they are.

  Also grep `azureuser` in `web/src` and `worker/src`. Where it is shown to Steven (the SSH hint), use `cloudOf(o) === "aws" ? "ubuntu" : "azureuser"`.

  Existing tests that assert the old strings: change each one to the new string, and nothing else.

- [ ] **Step 7: Run the tests.** Run `npx vitest run --project web` and `npx vitest run worker/test/labs*.test.ts worker/test/insights*.test.ts worker/test/lifecycle.test.ts`. Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add worker/src web/src shared worker/test
git commit -m "Dashboard: AWS settings panel, cost split, AWS-insights placeholder, cloud-neutral wording, labs stay Azure"
```

---

## Phase F: ship and prove

### Task 16: Full gate, merge, deploy, live AWS cycle, then show the picker

**Files:** `wrangler.toml` (rates after the price check; `AWS_ENABLED = "1"` at the end), memory files, `README.md`.

- [ ] **Step 1: Full gate.** Run `npm run typecheck && npm test && npm run tf-validate`. Expected: everything passes. Fix before going on.
- [ ] **Step 2: Review.** Run the superpowers:requesting-code-review skill on `feat/aws-headend` against `main`, with the spec. Fix the findings that matter, then re-run the gate.
- [ ] **Step 3: PR and merge.**

```bash
git push -u origin feat/aws-headend
gh pr create --title "AWS as a second cloud for the WireGuard headend" --body "Implements docs/superpowers/specs/2026-10-14-aws-vpn-design.md (plan: docs/superpowers/plans/2026-10-14-aws-vpn-plan.md). The picker stays hidden (AWS_ENABLED=0) until the live AWS cycle passes.

https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
gh pr checks --watch
gh pr merge --merge
git switch main && git pull
```

- [ ] **Step 4: Deploy.**
  - Run `npm run migrate` if that is how D1 migrations reach production here (check `scripts/migrate.mjs`; `0023` must be applied before the new code runs).
  - Then run `npm run deploy-worker`. Record the version and the rollback id in memory `golive-versions.md`.
  - Smoke check: the dashboard loads, Overview shows the Azure state, and there is no AWS picker yet.

- [ ] **Step 5: Price check.** This uses read-only admin keys from `.env`, locally.

```bash
set -a; . ./.env; set +a
aws pricing get-products --region us-east-1 --service-code AmazonEC2 --output json --filters \
  Type=TERM_MATCH,Field=instanceType,Value=t4g.micro Type=TERM_MATCH,Field=location,Value="EU (London)" \
  Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared \
  Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(JSON.parse(s).PriceList[0]);const d=Object.values(Object.values(p.terms.OnDemand)[0].priceDimensions)[0];console.log(d.pricePerUnit.USD,"USD/h")})'
```

  Look up gp3 storage (`--service-code AmazonEC2`, `Field=volumeApiName,Value=gp3`, London) and the public IPv4 charge ($0.005/h) the same way.
  - Running = instance + IPv4 + 8 GB × gp3 / 730.
  - Standby = IPv4 + 8 GB × gp3 / 730.

  Convert with 0.75 and round to 4 places. If either differs from 0.011 / 0.005 by more than 10%, update `AWS_HOURLY_RATE_GBP` / `AWS_STANDBY_RATE_GBP` in `wrangler.toml` (and `DEMO_VARS` if it holds values), commit "AWS rates from the price list", and redeploy.

- [ ] **Step 6: Live AWS cycle.** Total spend is well under £1.
  1. In Settings, turn on the test VM if it is off. Note the previous value to restore later.
  2. From the logged-in dashboard tab (Claude in Chrome, `javascript_tool`), run:

```js
await fetch("/api/v1/deploy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hours: 1, cloud: "aws" }) }).then((r) => r.json())
```

     Expected: `{ ok: true }`. Watch the live log. The GitHub run is "wg-aws" / "wg apply <run id>".
  3. Wait for Running and "Ready". The self-test must pass: handshake, tunnel, loopback, dns, internet and internet6.
     - The home site client shows online, because the home container dials `wg.clydeford.net`.
     - From this PC, run `curl -s --max-time 5 http://<test_vm_ip>:8080/`. If it answers, record it. If not, record "test VM not reachable from this PC" and confirm the test VM's address shows on Overview.
     - Run a speed test from Overview.
     - On the box: `aws ec2 describe-instances --region eu-west-2 --filters Name=tag:wg-admin,Values=vpn --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]' --output text`
  4. Hibernate from the dashboard. Wait for Standby. The same describe call shows `stopped`.
  5. Resume. Wait for Running and a new heartbeat.
  6. Tear down. Wait for Destroyed. The GitHub run ends with "AWS clean".
  7. Check the account is empty:

```bash
aws ec2 describe-instances --region eu-west-2 --filters Name=tag:wg-admin,Values=vpn Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text
aws ec2 describe-vpcs --region eu-west-2 --filters Name=tag:wg-admin,Values=vpn --query 'Vpcs[].VpcId' --output text
aws ec2 describe-addresses --region eu-west-2 --query 'Addresses[?AssociationId==null].AllocationId' --output text
aws ec2 describe-volumes --region eu-west-2 --filters Name=status,Values=available Name=tag:wg-admin,Values=vpn --query 'Volumes[].VolumeId' --output text
```

     Expected: all four print nothing.
  8. Restore the test-VM setting.
  9. Activate the cost tag. It works once AWS has seen the tag, which may take a day:

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 --cost-allocation-tags-status TagKey=wg-admin,Status=Active
```

     If it answers that the tag is not found yet, note it in memory `aws-support.md` as a follow-up for the next session. It is not a blocker.

  Anything failing in steps 2-7 is "something unexpected": stop, leave the picker hidden, and report.
  - If AWS resources are left over, run the safety net by hand with the admin keys (`AWS_REGION=eu-west-2 bash infra/ci/aws-safety-net.sh`) so nothing keeps billing.
  - Write down exactly what failed.

- [ ] **Step 7: Show the picker.** Set `AWS_ENABLED = "1"` in `wrangler.toml` (and `[env.*]` copies). Commit "Show AWS in the Deploy picker" on a branch, then PR, merge and `npm run deploy-worker`. The Deploy form shows Azure / AWS, and Settings → Deployment shows the AWS panel as "Shown in Deploy".
- [ ] **Step 8: Records.**
  - Update memory `aws-support.md`: project 1 live, the Worker version, the cost-tag status, and what project 2 starts from.
  - Update `golive-versions.md`.
  - Update `wg-admin-project.md` with one line saying AWS is live.
  - Add an "AWS" section to `README.md` (what it is, `node scripts/aws-bootstrap.mjs`, the one-cloud-at-a-time rule). Commit and push through a small PR.
