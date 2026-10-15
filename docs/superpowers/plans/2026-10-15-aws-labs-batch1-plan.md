# AWS labs batch 1 (engine + labs 01–05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AWS hands-on labs run in cloudlabs exactly as Azure labs do (Worker → `lab-aws.yml` → Terraform, state in R2, live log, timers, budget guard, safety net, verify clean), with labs `soa-01` to `soa-05` released on real AWS.

**Architecture:** One catalogue and one engine for both clouds: `lab.yaml` gains `cloud`, AWS ids/exams and AWS cost/capacity fields; the Worker picks the workflow, region, peering rules and AWS reads by `cloudOfId(lab_id)`. A sister workflow `lab-aws.yml` keeps `lab.yml`'s 16 step names and runs AWS-specific scripts (`lab-scope-aws.mjs`, `lab-ready-aws.sh`, `lab-peer-aws.sh`, `lab-unblock-aws.sh`, `lab-aws-safety-net.sh`) under a new IAM role `wg-admin-labs` bounded by `wg-admin-lab-boundary`. Azure paths keep their behaviour.

**Tech Stack:** Cloudflare Worker (TypeScript, Hono, D1, KV), `aws4fetch` SigV4 (`worker/src/cloud/awsApi.ts`), React web app (Vite, vitest + Testing Library), Terraform 1.14.6 with `hashicorp/aws ~> 6.0`, GitHub Actions (bash, AWS CLI v2, jq, Python+PyYAML on ubuntu-24.04), node:test for `scripts/test`.

**Spec:** `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (binding, rulings A1–A30), on top of the Azure labs spec `docs/superpowers/specs/2026-10-04-labs-design.md` (rulings 1–72). Executors read the spec sections each task names. Section numbers below (§n) are the AWS labs spec's.

## Global Constraints

- Steven approved planning, building, merging, deploying, the IAM role and boundary, quota increases, activating the cost tag and real-AWS release tests without stops (memory aws-labs-autonomy). STOP only for: a surprise, AWS test spend that would pass £15 for the whole AWS labs project, or any change to the VPN server itself (`infra/aws/**`, `infra/main.tf`, `infra/cloud-init.yaml.tftpl`, `.github/workflows/wg.yml`, `.github/workflows/wg-aws.yml`). B1 aims to spend ≤ £3.
- Azure behaviour must not change: every existing test stays green unchanged except tests that pin the three-exam lists, the `Azure Labs` title, the lab id pattern or the old "labs connect only to an Azure headend" wording, which this plan names where it changes them. `lab.yml` changes only in that Parse payload refuses an AWS lab. An Azure dispatch payload stays byte-identical.
- Internal names stay `wg-admin` where they already are (`wg-admin-labs`, `wg-admin-lab-boundary`, `wg-admin-deploy`, `config.workflow`); user-facing text says cloudlabs.
- Lab ids: `^(az(104|305|700)|soa|saa|ans)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$` in every copy (A1); AWS ids at most 30 characters (A2); lab numbers unique per cloud (A3).
- An AWS lab owns: everything tagged `cloudlabs-lab = <id>`; IAM roles, instance profiles and customer policies at path `/cloudlabs-lab/` named `lab-<id>-*`; S3 buckets `cloudlabs-<name_prefix>-*`; untaggable types named `lab-<id>-*` (A4). AWS `name_prefix` = `a` + two-digit lab number + 5 random lowercase characters (A5).
- Sessions run in `eu-west-2` (London) only; `eu-west-1` (Ireland) only as `regions.secondary`.
- Every `aws` provider block is exactly `region = var.region` (or `var.secondary_region` with `alias = "secondary"`) plus `default_tags { tags = var.tags }`: no credentials, profiles, `assume_role`, endpoints or account settings.
- Instances: Amazon Linux 2023 arm64 from `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`, `t4g.*`, `http_tokens = "required"`, no public IPv4, `volume_tags` carrying the lab's tags, cloud-init user `labadmin` with `var.admin_password`, `ssh_pwauth: true`; console SSH through an EC2 Instance Connect Endpoint; a free S3 gateway endpoint in every VPC with instances.
- Never print `.env` secrets. Subagents copy `.env.example` (never the real `.env`) and never use the AWS admin keys; only the controller runs `scripts/aws-bootstrap.mjs`, `npm run labs-verify -- --aws-prices` and real-AWS release tests. Kill processes only by PID. Do not use `python3` on this Windows machine (tests that need Python+PyYAML, bash, jq or terraform skip with a reason when missing; CI has them all).
- Files start with the house header comment (`// path/file.ts` then a `// Plain English: …` paragraph; `#` for shell, HCL and YAML). Match the surrounding comment density and naming.
- Tests while building: only the targeted files (`npx vitest run <files>`, `node --test scripts/test/<file>`), plus `npm run typecheck` when TypeScript changes. The full gate (`npm run typecheck && npm test && npm run build:web && npm run labs-check && npm run labs-tf`) runs once, in Task 17.
- No D1 migration in B1 (`0025_lab_files.sql` and lab 31's `files` output are batch 4).
- Work on branch `feat/aws-labs`. Commit after each task. Commit messages end with `Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`; PR bodies end with `https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`.

## Plan rulings (copied into spec §17 as A31–A46 in Task 17)

- **P1 (A31).** `gateway_cidr` travels in the AWS dispatch payload (the Worker's `config.vnetCidr`, default `10.50.0.0/16`); Parse payload validates it and defaults it. The Azure payload never carries it. (§5 says "same payload keys"; A10 needs the value from the Worker.)
- **P2 (A32).** Peer and Unpeer steps ask STS for 3600-second sessions: `wg-admin-deploy` has `max_session_duration = 3600`, so A14's 10800 applies to `wg-admin-labs` steps only.
- **P3 (A33).** Lab 03 makes no IAM, so its `identity.creates` is `[]` (§3.2's `[role]` was illustrative).
- **P4 (A34).** Lab 05 runs MySQL 8.4 (8.0 left standard support on 2026-07-31 and bills Extended Support) with Performance Insights off (not offered for MySQL on db.t4g.micro, V); its readme points to CloudWatch Database Insights standard mode. No RDS log exports (they create untagged log groups).
- **P5 (A35).** On diagrams an EC2 Instance Connect Endpoint draws as `bastion`, and the lab's `aws_resourcegroups_group` (`lab-<id>`, one per region) is the container where Azure draws the resource group (the region lane of §10).
- **P6 (A36).** The ready check knows every §5.1 type; the scope allow-list (`AWS_TYPES`), the safety net's handlers and Verify clean's real-state reads cover batch 1's types. A tagged resource of a type with no handler is never counted clean: Verify clean reports it as a leftover ("no handler for <type>"), so a later batch adds the handler test-first (§14: each batch brings the engine parts its labs need).
- **P7 (A37).** The AWS orphan sweep is its own hourly step (`sweepAwsOrphans`, KV `labs:sweep-aws`), because the watch's 20 calls cannot hold the Azure sweep (11) and the AWS sweep (12) in one run; each sweep rewrites only its own cloud's entries in KV `labs:orphans` and releases only its own cloud's `ended_dirty` slots.
- **P8 (A38).** A peer run without Terraform outputs (action `peer`) finds the lab VPC by tag: the VPC tagged `cloudlabs-lab = <id>` and `cloudlabs-peer = hub`, else the lab's only VPC; its route tables are those of that VPC carrying the lab tag.
- **P9 (A39).** API additions: `LabCard.cloud`; `LabDetail.cloud`, `.secondaryRegion`, `.consoleUrls` (`{ region, label, url }[]`, one per lab region, in place of `portalUrl` for AWS), `.connect { possible, note }`; `LabPermissions.awsRole/awsBoundary/awsCostTag`; `LabBlockerKind` `"aws_setup"`; `LabCostLine.source` `"aws"`; `LabTopologyResponse.status` `"no_aws"`.
- **P10 (A40).** Scope rule `size` also caps RDS `allocated_storage` at 30 GiB with no storage autoscaling (`max_allocated_storage` unset or 0).
- **P11 (A41).** A30's unpeer runs carry the reason `server tear-down`; when one settles the session's peering becomes `disconnected` (so Re-peer is offered), not `off`.
- **P12 (A42).** Batch 1 labs write IAM documents with `jsonencode()`, never `data "aws_iam_policy_document"`, so the scope check reads literal documents in the plan.
- **P13 (A43).** The `wg-admin-labs` trust uses `aud` and `sub` only, as `wg-admin-deploy` does; a `job_workflow_ref` condition is not used (V unconfirmed that STS evaluates it).
- **P14 (A44).** An AWS lab's capacity warning adds the vCPUs of AWS lab sessions requested after the capacity reading was taken (earlier ones are already in its "used"), plus the AWS headend's type when no AWS headend instance exists.
- **P15 (A45).** Lab instance security groups always admit `var.gateway_cidr` (Peer can come after deploy without a new apply); it is unreachable until the lab is peered.
- **P16 (A46).** The ABAC generator puts an action in the change list only when every resource type it names accepts `aws:ResourceTag/${TagKey}`, none is AWS-owned (`ec2:image`, `ec2:snapshot`, `ec2:prefix-list`, `ssm:document`, `ssm:parameter`), and it is not in the create list; the create list is every action whose `ActionConditionKeys` include `aws:RequestTag/${TagKey}` (`ec2:RunInstances` scoped to instance, volume and network-interface ARNs).

## Review Focus

1. **A destroy with no or broken Terraform state** (a failed apply, a lab gone from the catalogue): the safety net must still remove everything tagged for the lab in dependency order, and Verify clean must judge each candidate by its real state (a terminated instance the tagging API still lists is clean). Tests: Task 5 "safety net with no state deletes the tagged instance, then its security group, subnet and VPC, in that order" and "a tagging-API ghost (terminated) counts clean".
2. **The AWS server torn down while AWS labs are peered, and every cross-cloud mix** (an Azure lab with an AWS server, an AWS lab with an Azure server, no server at all): Peer, Re-peer, deploy-with-peer and release tests must follow the same-cloud rule with the right sentence, and an AWS server destroy must start one unpeer run per peered AWS lab first. Tests: Task 6 "an AWS server destroy dispatches an unpeer per peered AWS lab before wg-aws.yml" and the cross-cloud table.
3. **The watch running out of calls between the two orphan sweeps**: a half sweep is never recorded, and neither sweep erases the other cloud's leftovers from KV `labs:orphans`. Test: Task 7 "the AWS sweep keeps Azure entries and the Azure sweep keeps AWS entries; with 11 calls left the AWS sweep waits".
4. **A price reference that matches no product, or several, or prices in Ireland**: the feed stores nothing for it (the authored figure stays, source "authored"), and `{usage}` becomes `EU` in eu-west-1. Test: Task 7 "a reference matching two products stores nothing" and "Ireland fills {usage} with EU".
5. **A hand-made untagged instance inside a lab VPC**: Verify clean names it ("untagged inside lab VPC: i-…") instead of reporting clean or failing with no name, and the session ends `ended_dirty`. Test: Task 5 "an untagged instance in a lab VPC is a named leftover".

---

## File map

| Path | Status | Task |
|---|---|---|
| `shared/labs.ts`, `scripts/lib/labs.mjs`, `scripts/lib/labs.d.mts`, `labs/skill-areas.yaml`, `shared/api.ts` | modify | 1 |
| LAB_ID_RE copies: `infra/ci/lab-{scope.mjs,parse.sh,peer.sh,ready.sh,safety-net.sh,state-reset.sh,unblock.sh}`; number regexes in `scripts/labs-tf.mjs`, `scripts/labs-topology.mjs`, `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/rows-from-planned.ts`, `web/src/api/topology.test.ts` | modify | 1 |
| `infra/ci/lab-scope-aws.mjs` | create | 2 |
| `infra/ci/lab-scope.mjs` (`planResources` keeps four variables) | modify | 2 |
| `scripts/test/fixtures/labs/plans/{extract-computed.mjs,computed.json,schema-facts.json,realistic.mjs}`, `common-aws.mjs` (create) | modify/create | 2 |
| `labs/_template-aws/{versions,variables,main,network,outputs}.tf` | create | 3 |
| `infra/ci/lab-lint.mjs`, `scripts/labs-check.mjs`, `scripts/labs-tf.mjs` | modify | 3 |
| `.github/workflows/lab-aws.yml`, `infra/ci/{aws-lab-creds.sh,lab-ready-aws.sh,lab-peer-aws.sh}` | create | 4 |
| `infra/ci/{lab-parse.sh,lab-plan.sh,lab-tf-run.sh,lab-transient.mjs}`, `.github/workflows/lab.yml` (Parse payload only) | modify | 4 |
| `infra/ci/{lab-unblock-aws.sh,lab-aws-safety-net.sh}` | create | 5 |
| `worker/src/labs/{engine,net,callbacks,settle,refresh,cards,summary,view}.ts`, `worker/src/{oidc,runs}.ts`, `worker/src/api/labs.ts` | modify | 6 |
| `worker/src/cloud/awsApi.ts`, `worker/src/labs/{orphans,cost,prices,warnings,permissions,availability,resources,awsReads}.ts`, `worker/src/insights/aws/{types,ctx}.ts`, `worker/src/insights/aws/feeds/{capacity,labPrices,index}.ts`, `worker/test/harness.ts` | modify/create | 7 |
| `infra/aws-bootstrap/{labs.tf,main.tf,outputs.tf,lab-abac.json,lab-policies.json}`, `scripts/aws-labs-abac.mjs`, `scripts/lib/aws-lab-policies.mjs`, `scripts/aws-bootstrap.mjs` | create/modify | 8 |
| `shared/topology/{model,kinds,planned,awsLive}.ts`, `shared/topology/rules/{planned,awsPlanned}.ts`, `worker/src/labs/topology.ts`, `scripts/topology-icons.mjs`, `web/src/views/labs/topology/icons/{aws.svg,sprite.ts,README.md}`, `scripts/labs-diagrams.mjs` | modify/create | 9 |
| `web/src/views/labs/**`, `web/src/views/settings/LabsSection.tsx`, `web/src/test/fixtures.ts` | modify | 10 |
| `scripts/labs-verify.mjs`, `scripts/lab-release-test.mjs`, `README.md` | modify | 11 |
| `labs/soa-0{1..5}-*/**`, `labs/_learning/soa-0{1..5}-*.yaml`, `shared/topology/planned/soa-0*.json`, `shared/guides/soa-0*/**`, `shared/guides/{index,placement}.json`, `scripts/test/fixtures/labs/plans/labs/soa-0*.mjs`, `scripts/test/labs-aws-soa-0*.test.mjs` | create | 12–16 |

## Order and dependencies

Tasks run one at a time, in number order. Depends-on lists the tasks whose outputs a task consumes; tasks with disjoint lists could run in parallel worktrees.

| Task | Title | Depends on |
|---|---|---|
| 1 | Contract: clouds, AWS ids, exams, fields, skill areas, API types | – |
| 2 | Plan scope check for AWS (`lab-scope-aws.mjs`) and AWS plan fixtures | 1 |
| 3 | AWS template, `lab-lint --cloud aws`, labs-check and labs-tf | 1, 2 |
| 4 | `lab-aws.yml`, creds, parse, plan, ready check, peer/unpeer | 1, 2, 3 |
| 5 | Unblock, safety net and Verify clean for AWS | 1 |
| 6 | Worker: cloud through the engine, dispatch, OIDC, same-cloud peering, A15/A30 | 1 |
| 7 | Worker: AWS reads (orphans, cost, prices feed, capacity, permissions, resources) | 1, 6 |
| 8 | Bootstrap IAM: role, boundary, ABAC lists, policy sizes, simulator, Worker reads, quotas, cost tag | 1 |
| 9 | Topology: AWS kinds, planned and live AWS graphs, AWS icon sprite, diagrams | 1, 3, 7 |
| 10 | Web: header, cloud filter, badge, coverage, AWS modal, settings ticks | 1, 6, 7, 9 |
| 11 | `labs-verify --aws-prices`, release-test script by cloud, README setup | 1 |
| 12 | Lab soa-01-cloudwatch | 2, 3, 9 |
| 13 | Lab soa-02-systems-manager | 2, 3, 9 |
| 14 | Lab soa-03-auto-scaling | 2, 3, 9 |
| 15 | Lab soa-04-backup | 2, 3, 9 |
| 16 | Lab soa-05-rds | 2, 3, 9 |
| 17 | Full gate, price check, spec rulings, PR and whole-branch review (controller) | 1–16 |
| 18 | Ship: bootstrap, merge, deploy, real-AWS release tests, headend-destroy check, record (controller) | 17 |

---
### Task 1: Contract: clouds, AWS ids, exams, fields, skill areas, API types

Spec: §3.1, §3.2 (every field rule), §3.3 footer, §4 variables, §6 first bullet, §9 (A20), §12.1, rulings A1–A7, A20, A22.

**Files:**
- Modify: `shared/labs.ts` (types and constants at lines 18–66, 157–176, `labNeeds` at 249)
- Modify: `scripts/lib/labs.mjs` (constants 21–35, `readmeFooter` 41, `ITEM`/`SCHEMA` 102–119, `validateLab` 152–199, `variablesProblems` 426, `buildCatalogue` 548–642)
- Modify: `scripts/lib/labs.d.mts`
- Modify: `labs/skill-areas.yaml` (append 13 AWS areas)
- Modify: `shared/api.ts` (`LabCard` 881, `LabBlockerKind` 926, `LabPermissions` 942, `LabCostLine` 981, `LabDetail` 990, `LabTopologyResponse` 1074)
- Modify the eight other `LAB_ID_RE` copies: `infra/ci/lab-scope.mjs:106`, `infra/ci/lab-parse.sh:60` (and its comment at line 9), `infra/ci/lab-peer.sh:39`, `infra/ci/lab-ready.sh:19`, `infra/ci/lab-safety-net.sh:52`, `infra/ci/lab-state-reset.sh:22`, `infra/ci/lab-unblock.sh:64`
- Modify the lab-number regexes: `scripts/labs-tf.mjs:93` and `scripts/labs-topology.mjs:136` (`/^az\d{3}-(\d{2})-/` → `/^[a-z0-9]+-(\d{2})-/`), `worker/test/fixtures/topology/rows-from-planned.ts:31` (same), `worker/test/topology-golden.test.ts:704` (filter with `LAB_ID_RE` imported from `shared/labs`), `web/src/api/topology.test.ts:58` (`expect(LAB_ID_RE.test(id)).toBe(true)`)
- Modify compile fallout (no behaviour change; Tasks 6, 7 and 10 make these real): `worker/src/labs/cards.ts` (`cloud: def.cloud`), `worker/src/api/labs.ts:114` and `worker/src/labs/availability.ts` `NO_PERMISSIONS` (add the three AWS fields as `null`), the `GET /labs/:id` detail builder in `worker/src/api/labs.ts` (add `cloud: def.cloud`, `secondaryRegion: def.regions.secondary`, `consoleUrls: null`, `connect: { possible: true, note: null }`), `worker/test/labs-helpers.ts` `base()` (add `cloud: "azure"` and `capacity: { vm_sizes: [], instance_types: [] }`), `web/src/test/fixtures.ts` and `web/src/views/labs/testData.ts` (same defaults), and any other `LabDef`/`LabCard`/`LabDetail`/`LabPermissions` literal `npm run typecheck` names
- Test: `scripts/test/labs-aws-contract.test.mjs` (create), `scripts/test/labs-lib.test.mjs:224-246` (the id pattern test), `worker/test/labs-shared.test.ts` (lines 129–136 and 226–241)

**Interfaces:**
- Consumes: nothing new.
- Produces (`shared/labs.ts`; the same names, values and behaviour in `scripts/lib/labs.mjs`, kept equal by `worker/test/labs-shared.test.ts`):

```ts
export type LabCloud = "azure" | "aws";
export type LabExam = "AZ-104" | "AZ-305" | "AZ-700" | "SOA-C03" | "SAA-C03" | "ANS-C01";
export const LAB_EXAMS: readonly LabExam[]; // ["AZ-104","AZ-305","AZ-700","SOA-C03","SAA-C03","ANS-C01"]
export const EXAM_CLOUD: Readonly<Record<LabExam, LabCloud>>;
export const examOfId: (id: string) => LabExam;   // az104-→AZ-104, az305-→AZ-305, az700-→AZ-700, soa-→SOA-C03, saa-→SAA-C03, ans-→ANS-C01; anything else AZ-700 (as today)
export const cloudOfId: (id: string) => LabCloud; // EXAM_CLOUD[examOfId(id)]
export const LAB_ID_RE: RegExp;                    // /^(az(104|305|700)|soa|saa|ans)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/
export const LAB_ID_MAX = 40;
export const AWS_LAB_ID_MAX = 30;
export interface AwsPriceRef { service: string; unit: "Hrs" | "GB-Mo"; gb?: number; filters: Record<string, string> }
export interface LabCostItem { name: string; gbp_h: number; qty?: number; region?: "secondary"; retail?: { meter?: string; unit?: string; sku?: string }; aws_price?: AwsPriceRef; whole_hours?: boolean }
// LabDef gains: cloud: LabCloud; capacity: { vm_sizes: string[]; instance_types: string[] }; identity.creates: ("user" | "group" | "role")[]
export const LAB_TF_VARS_AWS: readonly string[]; // ["lab_id","name_prefix","region","secondary_region","address_space","gateway_cidr","peered","admin_password","ssh_public_key","tags"]
export const labTfVars: (cloud: LabCloud) => readonly string[];
export const AWS_LAB_REGIONS: readonly ["eu-west-2", "eu-west-1"];
export const AWS_GLOBAL_REGIONS: readonly ["us-east-1", "us-west-2"];
export const LAB_TAG = "cloudlabs-lab";
export const LAB_SESSION_TAG = "cloudlabs-session";
export const AWS_IAM_PATH = "/cloudlabs-lab/";
export const AWS_LABS_ROLE = "wg-admin-labs";
export const AWS_BOUNDARY = "wg-admin-lab-boundary";
export const AWS_GATEWAY_CIDR = "10.50.0.0/16";
export const AWS_IAM_USER_LABS: readonly string[]; // ["soa-07-iam-kms"]
export const AWS_CONFIG_LABS: readonly string[];   // ["soa-02-systems-manager"]
export const AWS_GLOBAL_LABS: readonly string[];   // ["soa-09-route53-cloudfront","ans-26-edge"]
export const AWS_INSTANCE_TYPES: readonly string[]; // ["t4g.nano","t4g.micro","t4g.small","t3.micro","t3.small","t4g.medium"]
export const AWS_MEDIUM_LABS: readonly string[];   // ["saa-19-eks"]: the only lab that may list t4g.medium
export const AWS_USAGE_PREFIX: Readonly<Record<string, string>>; // { "eu-west-2": "EUW2", "eu-west-1": "EU", "us-east-1": "USE1", "us-west-2": "USW2" } (V per region)
export function awsUsagePrefix(region: string): string; // throws RangeError for a region not in AWS_USAGE_PREFIX
export const NAME_PREFIX_LETTER: Readonly<Record<LabCloud, string>>; // { azure: "l", aws: "a" }
export const labResourceGroupName: (id: string) => string; // "lab-<id>" (the AWS Resource Groups group)
export function awsConsoleUrl(id: string, region: string): string; // `https://${region}.console.aws.amazon.com/resource-groups/group/lab-${id}?region=${region}` (V)
export function wholeHoursGbpH(items: readonly LabCostItem[], priceOf?: (i: LabCostItem) => number | null): number; // Σ over whole_hours items of (priceOf ?? gbp_h) × qty, 6 dp
export function sessionEstimateGbp(gbpH: number, wholeGbpH: number, ms: number): number; // h = ms/3.6e6; gbpH×h + wholeGbpH×(ceil(h)−h), 6 dp; 0 for ms ≤ 0
export function labNeeds(def: Pick<LabDef, "id" | "identity"> & { cloud?: LabCloud }): { role: boolean; graph: boolean }; // aws → { role: false, graph: false }
```

- `scripts/lib/labs.mjs` also exports `readmeFooter(id)` (cloud by `cloudOfId(id)`), `variablesProblems(tf, cloud = "azure")`, and `validateLab` returning `def.cloud` and both capacity lists.
- `shared/api.ts` additions (exact):

```ts
// LabCard
cloud: LabCloud;
// LabBlockerKind gains "aws_setup"
// LabPermissions gains
awsRole: boolean | null;     // iam:GetRole wg-admin-labs answered
awsBoundary: boolean | null; // iam:GetPolicy wg-admin-lab-boundary answered
awsCostTag: boolean | null;  // cloudlabs-lab is an Active cost allocation tag (a warning only)
// LabCostLine.source becomes "azure" | "aws" | "authored"
// LabDetail gains
cloud: LabCloud;
secondaryRegion: string | null;
/** AWS: the lab's Resource Groups console page per lab region while a session is live; null for Azure (portalUrl) or no session. */
consoleUrls: { region: string; label: string; url: string }[] | null;
/** Whether "Peer to gateway" can work now (same cloud as a live server, or no server yet) and, when not, the sentence. */
connect: { possible: boolean; note: string | null };
// LabTopologyResponse.status gains "no_aws"
```

- [ ] **Step 1: Write the failing contract test** `scripts/test/labs-aws-contract.test.mjs`

```js
// labs-aws-contract.test.mjs
//
// Plain English: the AWS half of the lab contract (AWS labs spec §3, §6 first
// bullet, rulings A1-A7): the ids, exams and clouds; lab.yaml's AWS field
// rules, each refused with its field; per-cloud lab numbers and
// prerequisites; and the AWS readme footer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { AWS_LAB_ID_MAX, buildCatalogue, cloudOfId, EXAM_CLOUD, examOfId, LAB_EXAMS, LAB_ID_RE, LAB_TF_VARS_AWS, readmeFooter, validateLab, variablesProblems } from "../lib/labs.mjs";

const AREAS = [
  { key: "soa.reliability", exam: "SOA-C03", name: "Reliability and Business Continuity" },
  { key: "soa.deployment", exam: "SOA-C03", name: "Deployment, Provisioning, and Automation" },
  { key: "saa.resilient", exam: "SAA-C03", name: "Design Resilient Architectures" },
  { key: "az104.compute", exam: "AZ-104", name: "Deploy and manage Azure compute resources" },
];
const EC2 = { service: "AmazonEC2", unit: "Hrs", filters: { instanceType: "t4g.micro", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" } };
const awsLab = (over = {}) => ({
  id: "soa-03-auto-scaling", version: 1, cloud: "aws", title: "Auto Scaling behind an Application Load Balancer", summary: "A launch template and an Auto Scaling group.",
  exam: "SOA-C03", skill_areas: ["soa.reliability", "soa.deployment", "saa.resilient"], level: "associate", type: "explore", prerequisites: [],
  cost: { items: [
    { name: "EC2 t4g.micro, Linux (2 running)", gbp_h: 0.0071, qty: 2, aws_price: EC2 },
    { name: "Application Load Balancer, hourly", gbp_h: 0.0199, whole_hours: true, aws_price: { service: "AWSELB", unit: "Hrs", filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } } },
    { name: "EBS gp3 root volume, 8 GiB", gbp_h: 0.0008, qty: 2, aws_price: { service: "AmazonEC2", unit: "GB-Mo", gb: 8, filters: { productFamily: "Storage", volumeApiName: "gp3" } } },
  ], pricey: null },
  timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 },
  capacity: { instance_types: ["t4g.micro", "t4g.micro"] },
  regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: false, subnets_used: 1 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});
const azureLab = (over = {}) => ({
  id: "az104-08-vms", version: 1, title: "VMs", summary: "Two VMs.", exam: "AZ-104", skill_areas: ["az104.compute"], level: "associate", type: "explore", prerequisites: [],
  cost: { items: [{ name: "Linux VM, Standard_B1s", gbp_h: 0.0092, qty: 2, retail: { sku: "Standard_B1s" } }], pricey: null },
  timing: { deploy_min: 6, destroy_min: 5, session_h: 2, max_h: 6 }, capacity: { vm_sizes: ["Standard_B1s", "Standard_B1s"] }, regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: false, subnets_used: 1 }, identity: { creates: [], roles: [], governance: false }, ...over,
});
const problemsOf = (raw) => validateLab(raw, { folder: raw.id, skillAreas: AREAS }).problems;
/** The lab with its first cost item changed by f. */
const firstItem = (lab, f) => ({ ...lab, cost: { ...lab.cost, items: lab.cost.items.map((i, n) => (n === 0 ? f(i) : i)) } });

test("the id pattern takes the AWS prefixes and refuses the rest (A1)", () => {
  for (const ok of ["soa-03-auto-scaling", "saa-11-three-tier", "ans-31-client-vpn", "az104-06-blob-security", "az700-44-flow-logs-bastion"]) assert.ok(LAB_ID_RE.test(ok), ok);
  for (const bad of ["soc-01-x", "sa-01-x", "aws-01-x", "ans-1-x", "SOA-01-x", "soa-01-", "soa-01-x_y"]) assert.ok(!LAB_ID_RE.test(bad), bad);
  assert.equal(AWS_LAB_ID_MAX, 30);
});

test("six exams in catalogue order, each with its cloud, read from the id", () => {
  assert.deepEqual([...LAB_EXAMS], ["AZ-104", "AZ-305", "AZ-700", "SOA-C03", "SAA-C03", "ANS-C01"]);
  assert.deepEqual(Object.fromEntries(LAB_EXAMS.map((e) => [e, EXAM_CLOUD[e]])), { "AZ-104": "azure", "AZ-305": "azure", "AZ-700": "azure", "SOA-C03": "aws", "SAA-C03": "aws", "ANS-C01": "aws" });
  assert.deepEqual(["soa-01-x", "saa-11-x", "ans-20-x", "az305-20-x"].map(examOfId), ["SOA-C03", "SAA-C03", "ANS-C01", "AZ-305"]);
  assert.deepEqual(["soa-01-x", "az104-01-x"].map(cloudOfId), ["aws", "azure"]);
});

test("a good AWS lab validates, with cloud aws and an empty vm_sizes", () => {
  const r = validateLab(awsLab(), { folder: "soa-03-auto-scaling", skillAreas: AREAS });
  assert.deepEqual(r.problems, []);
  assert.equal(r.def.cloud, "aws");
  assert.deepEqual(r.def.capacity, { vm_sizes: [], instance_types: ["t4g.micro", "t4g.micro"] });
  assert.deepEqual(r.def.exams, ["SOA-C03", "SAA-C03"]);
});

test("an Azure lab without cloud is cloud azure with an empty instance_types", () => {
  const r = validateLab(azureLab(), { folder: "az104-08-vms", skillAreas: AREAS });
  assert.deepEqual(r.problems, []);
  assert.equal(r.def.cloud, "azure");
  assert.deepEqual(r.def.capacity, { vm_sizes: ["Standard_B1s", "Standard_B1s"], instance_types: [] });
});

// [what, raw lab, field, message pattern]
const REFUSED = [
  ["an AWS id without cloud: aws", awsLab({ cloud: undefined }), "cloud", /soa-03-auto-scaling is an AWS lab: set cloud: aws/],
  ["cloud: aws on an Azure id", azureLab({ cloud: "aws" }), "cloud", /cloud aws does not match the id az104-08-vms \(an azure lab\)/],
  ["an AWS id over 30 characters", awsLab({ id: `soa-03-${"a".repeat(24)}` }), "id", /longer than 30 characters/],
  ["an exam that is not the id's", awsLab({ exam: "SAA-C03" }), "exam", /does not match the id/],
  ["an Azure area on an AWS lab", awsLab({ skill_areas: ["soa.reliability", "az104.compute"] }), "skill_areas", /az104\.compute is an AZ-104 area: an AWS lab names only AWS exams' areas/],
  ["retail on an AWS item", firstItem(awsLab(), (i) => ({ ...i, retail: { sku: "Standard_B1s" } })), "cost.items", /retail is Azure's list price: an AWS lab uses aws_price/],
  ["GB-Mo without gb", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, unit: "GB-Mo" } })), "cost.items", /unit GB-Mo needs gb/],
  ["gb with Hrs", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, gb: 8 } })), "cost.items", /gb goes with unit GB-Mo/],
  ["an instanceType not in instance_types", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: { ...EC2.filters, instanceType: "t3.small" } } })), "capacity.instance_types", /t3\.small: list it in capacity\.instance_types too/],
  ["{usage} outside usagetype", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: { ...EC2.filters, operatingSystem: "{usage}" } } })), "cost.items", /\{usage\} only in a usagetype filter/],
  ["empty filters", firstItem(awsLab(), (i) => ({ ...i, aws_price: { ...EC2, filters: {} } })), "cost.items", /filters needs at least one/],
  ["vm_sizes on an AWS lab", awsLab({ capacity: { vm_sizes: ["Standard_B1s"], instance_types: ["t4g.micro", "t4g.micro"] } }), "capacity.vm_sizes", /an AWS lab lists capacity\.instance_types, not vm_sizes/],
  ["no instance_types on an AWS lab", awsLab({ capacity: {} }), "capacity.instance_types", /an AWS lab lists capacity\.instance_types/],
  ["an instance type off the list", awsLab({ capacity: { instance_types: ["m5.large"] } }), "capacity.instance_types", /m5\.large is not an allowed instance type/],
  ["t4g.medium outside saa-19-eks", awsLab({ capacity: { instance_types: ["t4g.medium"] } }), "capacity.instance_types", /t4g\.medium is only for saa-19-eks/],
  ["a secondary region other than Ireland", awsLab({ regions: { secondary: "us-east-1" } }), "regions.secondary", /null or eu-west-1/],
  ["dns_link on an AWS lab (A8)", awsLab({ connectivity: { peering: "optional", dns_link: true, subnets_used: 1 } }), "connectivity.dns_link", /dns_link is always false for an AWS lab/],
  ["a user outside soa-07", awsLab({ identity: { creates: ["user"], roles: [], governance: false } }), "identity.creates", /only soa-07-iam-kms may create an IAM user/],
  ["group on an AWS lab", awsLab({ identity: { creates: ["group"], roles: [], governance: false } }), "identity.creates", /an AWS lab creates role or user/],
  ["roles on an AWS lab", awsLab({ identity: { creates: [], roles: [{ role: "Reader", scope: "resource_group" }], governance: false } }), "identity.roles", /always \[\] for an AWS lab/],
  ["governance on an AWS lab", awsLab({ identity: { creates: [], roles: [], governance: true } }), "identity.governance", /always false for an AWS lab/],
  ["aws_price on an Azure item", firstItem(azureLab(), (i) => ({ ...i, aws_price: EC2 })), "cost.items", /aws_price is AWS's list price: an Azure lab uses retail/],
  ["whole_hours on an Azure item", firstItem(azureLab(), (i) => ({ ...i, whole_hours: true })), "cost.items", /whole_hours is for AWS items/],
  ["instance_types on an Azure lab", azureLab({ capacity: { vm_sizes: ["Standard_B1s"], instance_types: ["t4g.micro"] } }), "capacity.instance_types", /an Azure lab lists capacity\.vm_sizes, not instance_types/],
  ["role on an Azure lab", azureLab({ identity: { creates: ["role"], roles: [], governance: false } }), "identity.creates", /an Azure lab creates user or group/],
];
for (const [what, raw, field, re] of REFUSED) {
  test(`refused with its field: ${what}`, () => {
    const p = problemsOf(raw);
    assert.ok(p.some((x) => x.field === field && re.test(x.message)), `${field} ${re}: got ${JSON.stringify(p)}`);
  });
}

test("the AWS readme footer names the tag (A9); an Azure id keeps its footer", () => {
  assert.equal(readmeFooter("soa-01-cloudwatch"), "Everything this lab builds carries the tag `cloudlabs-lab = soa-01-cloudwatch` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.");
  assert.match(readmeFooter("az104-08-vms"), /^Anything you build by hand inside `rg-lab-az104-08-vms`/);
});

test("an AWS variables.tf may declare gateway_cidr but not resource_group_name", () => {
  assert.deepEqual([...LAB_TF_VARS_AWS], ["lab_id", "name_prefix", "region", "secondary_region", "address_space", "gateway_cidr", "peered", "admin_password", "ssh_public_key", "tags"]);
  assert.deepEqual(variablesProblems('variable "gateway_cidr" {}\nvariable "tags" {}', "aws"), []);
  assert.equal(variablesProblems('variable "resource_group_name" {}', "aws").length, 1);
  assert.equal(variablesProblems('variable "gateway_cidr" {}', "azure").length, 1);
});

/** A labs folder with the skill areas and the given labs (each a raw lab.yaml), each with a minimal good readme. */
function root(labs) {
  const dir = mkdtempSync(join(tmpdir(), "labs-aws-"));
  writeFileSync(join(dir, "skill-areas.yaml"), stringify(AREAS));
  for (const raw of labs) {
    mkdirSync(join(dir, raw.id));
    writeFileSync(join(dir, raw.id, "lab.yaml"), stringify(raw));
    writeFileSync(join(dir, raw.id, "readme.md"), `Intro.\n\n## What it deploys\n\n- a thing\n\n## Things to try\n\n- one\n- two\n- three\n\n## Learn more\n\n- [Docs](https://docs.aws.amazon.com/)\n\n${readmeFooter(raw.id)}\n`);
  }
  return dir;
}

test("numbers are unique per cloud (A3); prerequisites stay in their cloud; AWS labs sort after Azure", () => {
  const ok = buildCatalogue(root([awsLab({ id: "soa-08-x" }), azureLab()]));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.catalogue.labs.map((l) => l.id), ["az104-08-vms", "soa-08-x"]);
  const twice = buildCatalogue(root([awsLab({ id: "soa-08-x" }), awsLab({ id: "saa-08-y", exam: "SAA-C03", skill_areas: ["saa.resilient"] })]));
  assert.ok(twice.problems.some((p) => p.field === "id" && /lab number 8 is also used by/.test(p.message)));
  const cross = buildCatalogue(root([awsLab({ id: "soa-03-x", prerequisites: ["az104-08-vms"] }), azureLab()]));
  assert.ok(cross.problems.some((p) => p.field === "prerequisites" && /az104-08-vms is an Azure lab: prerequisites are labs of the same cloud/.test(p.message)));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-contract.test.mjs`
Expected: FAIL (`AWS_LAB_ID_MAX`, `EXAM_CLOUD`, `cloudOfId`, `LAB_TF_VARS_AWS` are not exported).

- [ ] **Step 3: Update `shared/labs.ts`**

Add the Interfaces block's types, constants and functions. Replace `LabExam`, `LAB_EXAMS`, `LAB_ID_RE`, `examOfId`. In `LabDef` add `cloud: LabCloud;` after `number`, change `capacity` to `{ vm_sizes: string[]; instance_types: string[] }` and `identity.creates` to `("user" | "group" | "role")[]`. In `LabCostItem` add `aws_price?: AwsPriceRef;` and `whole_hours?: boolean;` with doc comments from §3.2. Bodies:

```ts
const PREFIX_EXAM: Readonly<Record<string, LabExam>> = { az104: "AZ-104", az305: "AZ-305", az700: "AZ-700", soa: "SOA-C03", saa: "SAA-C03", ans: "ANS-C01" };
export const examOfId = (id: string): LabExam => PREFIX_EXAM[id.split("-")[0] ?? ""] ?? "AZ-700";
export const cloudOfId = (id: string): LabCloud => EXAM_CLOUD[examOfId(id)];
export function awsUsagePrefix(region: string): string {
  const p = AWS_USAGE_PREFIX[region];
  if (!p) throw new RangeError(`no AWS usage-type prefix known for ${region}`);
  return p;
}
export function wholeHoursGbpH(items: readonly LabCostItem[], priceOf?: (item: LabCostItem) => number | null): number {
  const sum = items.filter((i) => i.whole_hours).reduce((n, i) => n + (priceOf?.(i) ?? i.gbp_h) * (i.qty ?? 1), 0);
  return Math.round(sum * 1e6) / 1e6;
}
export function sessionEstimateGbp(gbpH: number, wholeGbpH: number, ms: number): number {
  if (!(ms > 0)) return 0;
  const h = ms / 3_600_000;
  return Math.round((gbpH * h + wholeGbpH * (Math.ceil(h) - h)) * 1e6) / 1e6;
}
export function labNeeds(def: Pick<LabDef, "id" | "identity"> & { cloud?: LabCloud }): { role: boolean; graph: boolean } {
  if ((def.cloud ?? cloudOfId(def.id)) === "aws") return { role: false, graph: false };
  return { role: def.identity.governance || isGovernanceLab(def.id) || def.identity.roles.length > 0, graph: def.identity.creates.length > 0 };
}
```

Update the header comment and the `LabCatalogue` comment ("sorted by exam in LAB_EXAMS order, then number").

- [ ] **Step 4: Update `scripts/lib/labs.mjs`**

Copy every constant and function of the Interfaces block that scripts need (`LAB_ID_RE`, `LAB_EXAMS`, `EXAM_CLOUD`, `examOfId`, `cloudOfId`, `AWS_LAB_ID_MAX`, `LAB_TF_VARS_AWS`, `AWS_LAB_REGIONS`, `AWS_GLOBAL_REGIONS`, `LAB_TAG`, `AWS_IAM_USER_LABS`, `AWS_CONFIG_LABS`, `AWS_GLOBAL_LABS`, `AWS_INSTANCE_TYPES`, `AWS_MEDIUM_LABS`, `AWS_USAGE_PREFIX`). Then:

- `readmeFooter(id)`: for `cloudOfId(id) === "aws"` return exactly the string the test pins; else today's string.
- `variablesProblems(tf, cloud = "azure")`: check against `cloud === "aws" ? LAB_TF_VARS_AWS : LAB_TF_VARS`, the message naming "§4" of the AWS spec for AWS.
- Schema: add `cloud: [oneOf("azure", "aws"), "azure or aws", true]` to `SCHEMA`; in `ITEM` add `aws_price: [{ service: [(v) => str(v) && /^(Amazon|AWS)[A-Za-z0-9]+$/.test(v), "a Price List service code (AmazonEC2, AWSELB, ...)"], unit: [oneOf("Hrs", "GB-Mo"), "Hrs or GB-Mo"], gb: [num(0), "a size in GB", true], filters: [isObj, "a mapping of attribute -> value"] }, "", true]` and `whole_hours: [bool, "true or false", true]`; `capacity` becomes `{ vm_sizes: [[(v) => str(v) && VM_SIZE.test(v)], "a list of VM sizes (Standard_...)", true], instance_types: [[str], "a list of EC2 instance types", true] }`; `identity.creates` takes `oneOf("user", "group", "role")`.
- `validateLab`: after the shape check, with `const cloud = raw?.cloud ?? "azure"` and `const idCloud = LAB_ID_RE.test(id) ? cloudOfId(id) : null`, push exactly these problems (field, message). Today's governance check runs only for Azure ids; today's `retail.sku`-in-`vm_sizes` check runs only for Azure labs.

| Condition | Field | Message |
|---|---|---|
| `idCloud === "aws" && raw.cloud !== "aws"` | `cloud` | `${id} is an AWS lab: set cloud: aws` |
| `idCloud === "azure" && raw.cloud !== undefined && raw.cloud !== "azure"` | `cloud` | `cloud ${raw.cloud} does not match the id ${id} (an azure lab)` |
| `idCloud === "aws" && id.length > AWS_LAB_ID_MAX` | `id` | `id "${id}" is longer than 30 characters (an AWS lab's IAM names need the room, ruling A2)` |
| AWS: an area whose exam's cloud is azure | `skill_areas` | `skill area ${k} is an ${exam} area: an AWS lab names only AWS exams' areas` |
| Azure: an area whose exam's cloud is aws | `skill_areas` | `skill area ${k} is an ${exam} area: an Azure lab names only Azure exams' areas` |
| AWS item with `retail` | `cost.items` | `cost item "${name}": retail is Azure's list price: an AWS lab uses aws_price` |
| Azure item with `aws_price` | `cost.items` | `cost item "${name}": aws_price is AWS's list price: an Azure lab uses retail` |
| Azure item with `whole_hours` | `cost.items` | `cost item "${name}": whole_hours is for AWS items (AWS bills those hours whole)` |
| `aws_price.unit === "GB-Mo"` and `gb` missing | `cost.items` | `cost item "${name}": aws_price unit GB-Mo needs gb (the size)` |
| `gb` given with `unit === "Hrs"` | `cost.items` | `cost item "${name}": aws_price gb goes with unit GB-Mo` |
| `filters` empty, or a value not a non-empty string | `cost.items` | `cost item "${name}": aws_price filters needs at least one attribute, each a text value` |
| `{usage}` in any filter value other than `usagetype` | `cost.items` | `cost item "${name}": {usage} only in a usagetype filter` |
| `filters.instanceType` not in `capacity.instance_types` | `capacity.instance_types` | `cost item "${name}" is a ${t}: list it in capacity.instance_types too` |
| AWS with `capacity.vm_sizes` present | `capacity.vm_sizes` | `an AWS lab lists capacity.instance_types, not vm_sizes` |
| AWS without `capacity.instance_types` | `capacity.instance_types` | `an AWS lab lists capacity.instance_types (one entry per instance)` |
| AWS type not in `AWS_INSTANCE_TYPES` | `capacity.instance_types` | `${t} is not an allowed instance type (${AWS_INSTANCE_TYPES.join(", ")})` |
| `t4g.medium` and id not in `AWS_MEDIUM_LABS` | `capacity.instance_types` | `t4g.medium is only for saa-19-eks` |
| Azure with `capacity.instance_types` | `capacity.instance_types` | `an Azure lab lists capacity.vm_sizes, not instance_types` |
| Azure without `capacity.vm_sizes` | `capacity.vm_sizes` | `capacity.vm_sizes is missing` |
| AWS `regions.secondary` neither null nor `eu-west-1` | `regions.secondary` | `an AWS lab's regions.secondary is null or eu-west-1` |
| AWS `connectivity.dns_link === true` | `connectivity.dns_link` | `dns_link is always false for an AWS lab (ruling A8)` |
| AWS `creates` holds anything but role/user | `identity.creates` | `an AWS lab creates role or user` |
| AWS `user` in creates and id not in `AWS_IAM_USER_LABS` | `identity.creates` | `only soa-07-iam-kms may create an IAM user` |
| Azure `role` in creates | `identity.creates` | `an Azure lab creates user or group` |
| AWS `roles.length > 0` | `identity.roles` | `identity.roles is always [] for an AWS lab` |
| AWS `governance === true` | `identity.governance` | `identity.governance is always false for an AWS lab` |

The returned `def` is `{ ...raw, cloud, capacity: { vm_sizes: raw.capacity.vm_sizes ?? [], instance_types: raw.capacity.instance_types ?? [] }, number, exams }`.
- `buildCatalogue`: the number rule compares only labs of the same cloud (`o.cloud === d.cloud`); a prerequisite of the other cloud is `{ field: "prerequisites", message: `prerequisite ${p} is an ${other === "aws" ? "AWS" : "Azure"} lab: prerequisites are labs of the same cloud` }` (the word names the prerequisite's cloud); the skill-areas file check accepts the six exams (it already uses `LAB_EXAMS`).
- `scripts/lib/labs.d.mts`: declare every new export with the types above.

- [ ] **Step 5: Append the AWS skill areas to `labs/skill-areas.yaml`** (exactly §12.1; the header comment says the AWS exam guides were read 2026-10-15)

```yaml
- { key: soa.monitoring, exam: SOA-C03, name: "Monitoring, Logging, Analysis, Remediation, and Performance Optimization" }
- { key: soa.reliability, exam: SOA-C03, name: "Reliability and Business Continuity" }
- { key: soa.deployment, exam: SOA-C03, name: "Deployment, Provisioning, and Automation" }
- { key: soa.security, exam: SOA-C03, name: "Security and Compliance" }
- { key: soa.networking, exam: SOA-C03, name: "Networking and Content Delivery" }
- { key: saa.secure, exam: SAA-C03, name: "Design Secure Architectures" }
- { key: saa.resilient, exam: SAA-C03, name: "Design Resilient Architectures" }
- { key: saa.performance, exam: SAA-C03, name: "Design High-Performing Architectures" }
- { key: saa.cost, exam: SAA-C03, name: "Design Cost-Optimized Architectures" }
- { key: ans.design, exam: ANS-C01, name: "Network Design" }
- { key: ans.implementation, exam: ANS-C01, name: "Network Implementation" }
- { key: ans.operations, exam: ANS-C01, name: "Network Management and Operation" }
- { key: ans.security, exam: ANS-C01, name: "Network Security, Compliance, and Governance" }
```

- [ ] **Step 6: Change the other eight id-pattern copies and the number regexes** listed under Files to `^(az(104|305|700)|soa|saa|ans)-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$` (bash copies spell `\d` as `[0-9]`). In `scripts/test/labs-lib.test.mjs` change the expected pattern at line 237 to `"^(az(104|305|700)|soa|saa|ans)-\\d{2}-[a-z0-9]+(-[a-z0-9]+)*$"`, add `"soa-03-auto-scaling"` to the accepted list and `"soc-01-x"` to the refused list, and change the bash check at line 243 to the new pattern with `soa-03-auto-scaling` added (expected output `az700-31-ip-nat-outbound yes\nsoa-03-auto-scaling yes\naz701-31-x no`).

- [ ] **Step 7: Update `shared/api.ts`** with the Interfaces block's additions, then fix every literal `npm run typecheck` reports (Files list): the three AWS permission fields `null`, `cloud: "azure"`, `instance_types: []`, `secondaryRegion: null`, `consoleUrls: null`, `connect: { possible: true, note: null }`.

- [ ] **Step 8: Update `worker/test/labs-shared.test.ts`**: line 136 expects the six exams; the copies test (line 226) also compares `EXAM_CLOUD`, `AWS_LAB_ID_MAX`, `LAB_TF_VARS_AWS`, `AWS_LAB_REGIONS`, `LAB_TAG`, `AWS_IAM_USER_LABS`, `AWS_CONFIG_LABS`, `AWS_GLOBAL_LABS`, `AWS_INSTANCE_TYPES`, `AWS_MEDIUM_LABS`, `AWS_USAGE_PREFIX`, and `examOfId`/`cloudOfId` on `soa-01-x`, `saa-11-x`, `ans-20-x`. Add:

```ts
  it("sessionEstimateGbp counts whole-hours items per started hour (A20)", () => {
    expect(sessionEstimateGbp(0.05, 0.02, 30 * 60_000)).toBe(0.035); // 0.05 × 0.5 + 0.02 × 0.5
    expect(sessionEstimateGbp(0.05, 0.02, 2 * 3_600_000)).toBe(0.1);
    expect(sessionEstimateGbp(0.05, 0, 0)).toBe(0);
    expect(wholeHoursGbpH([{ name: "ALB", gbp_h: 0.0199, whole_hours: true }, { name: "EC2", gbp_h: 0.0071, qty: 2 }, { name: "IP", gbp_h: 0.0038, qty: 2, whole_hours: true }])).toBe(0.0275);
  });
  it("AWS helpers: usage prefixes, the console link and labNeeds", () => {
    expect(awsUsagePrefix("eu-west-2")).toBe("EUW2");
    expect(awsUsagePrefix("eu-west-1")).toBe("EU");
    expect(() => awsUsagePrefix("ap-south-1")).toThrow(RangeError);
    expect(awsConsoleUrl("soa-01-cloudwatch", "eu-west-2")).toBe("https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-01-cloudwatch?region=eu-west-2");
    expect(labNeeds({ id: "soa-02-systems-manager", cloud: "aws", identity: { creates: ["role"], roles: [], governance: false } })).toEqual({ role: false, graph: false });
  });
```

- [ ] **Step 9: Run the targeted tests**

Run: `node --test scripts/test/labs-aws-contract.test.mjs scripts/test/labs-lib.test.mjs`, then `npx vitest run worker/test/labs-shared.test.ts worker/test/topology-golden.test.ts web/src/api/topology.test.ts`, then `npm run typecheck`, then `npm run labs-check`
Expected: all PASS; labs-check reports 43 labs.

- [ ] **Step 10: Commit**

```bash
git add shared scripts labs/skill-areas.yaml infra/ci worker web
git commit -m "feat(aws labs): the contract: clouds, AWS ids and exams, lab.yaml AWS rules, skill areas, API types

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 2: Plan scope check for AWS (`lab-scope-aws.mjs`) and AWS plan fixtures

Spec: §7.3 (`lab-scope-aws.mjs`, rules 1–13), §7.4, §11 (one evil plan per rule), rulings A4, A10, A11, P6, P10, P12.

**Files:**
- Create: `infra/ci/lab-scope-aws.mjs`
- Modify: `infra/ci/lab-scope.mjs` (`planResources`, line ~364: keep the variables `region`, `secondary_region`, `address_space`, `gateway_cidr`; no Azure rule reads the new ones)
- Modify: `scripts/test/fixtures/labs/plans/extract-computed.mjs` (append the AWS types below to `TYPES`; the regeneration comment pins `hashicorp/aws` at the 6.x version `terraform init` resolves on the day, plus `tls` and `archive`), then regenerate `scripts/test/fixtures/labs/plans/computed.json` and `schema-facts.json` with the commands in that file's header comment (add `aws = { source = "hashicorp/aws", version = "<6.x pinned>" }` to the scratch `versions.tf`)
- Modify: `scripts/test/fixtures/labs/plans/realistic.mjs` (`realisticPlan` takes an optional `providerConfig` object merged over the default `provider_config`)
- Create: `scripts/test/fixtures/labs/plans/common-aws.mjs`
- Modify: `scripts/test/lab-plans.test.mjs` (the per-lab scope test uses `checkPlanAws` for `cloudOfId(id) === "aws"`, `checkPlan` otherwise)
- Modify: `scripts/test/labs-content-suite.test.mjs:180` (the address check iterates Azure labs only: `Object.entries(LAB_PLANS).filter(([id]) => cloudOfId(id) === "azure")`)
- Test: `scripts/test/lab-scope-aws.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1's `LAB_ID_RE`, `AWS_LAB_ID_MAX`, `AWS_CONFIG_LABS`, `AWS_GLOBAL_LABS`, `AWS_IAM_USER_LABS`, `AWS_INSTANCE_TYPES`, `AWS_MEDIUM_LABS` (copied as constants into `lab-scope-aws.mjs`, which runs on the runner with no packages; a test keeps them equal to `scripts/lib/labs.mjs`); `planResources`, `hclResources`, `Unknown` from `infra/ci/lab-scope.mjs`.
- Produces (`infra/ci/lab-scope-aws.mjs`):

```js
export const AWS_RULES = ["provider", "provisioner", "import", "type", "never", "tag", "untaggable", "iam", "gateway", "address", "public", "lingering", "size"];
export const AWS_PROVIDER_SOURCES = ["registry.terraform.io/hashicorp/aws", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time", "registry.terraform.io/hashicorp/tls", "registry.terraform.io/hashicorp/archive"];
export const AWS_TYPES;         // Map<type, reason> (list below)
export const AWS_DATA;          // Map<type, reason> (list below)
export const NEVER_TYPES;       // RegExp[] (rule 5)
export const UNTAGGABLE;        // Map<type, nameAttribute> (rule 7)
export const MANAGED_POLICIES;  // string[]: the 14 attachable AWS managed policy ARNs (§7.1)
export const BOUNDARY_RE = /^arn:aws:iam::\d{12}:policy\/wg-admin-lab-boundary$/;
export const PUBLIC_INSTANCE_LABS = ["ans-22-s2s-vpn"];
export function scopeProblemsAws(input, labId, { mode }); // mode "plan" | "hcl" | "mock"; input: planResources(plan) or hclResources(hcl, id) plus
//   plan/mock: { configKeys: Record<address, provider_config_key>, providerConfigs: plan.configuration.provider_config, planVariables: Record<name, value> }
//   hcl: { providerBlocks: hcl.provider }; returns [{ rule, address, message }]
export const LAB_ID_RE, AWS_CONFIG_LABS, AWS_GLOBAL_LABS, AWS_IAM_USER_LABS, AWS_INSTANCE_TYPES, AWS_MEDIUM_LABS; // copies of scripts/lib/labs.mjs (the test keeps them equal)
export const checkPlanAws = (plan, labId) => [...];       // terraform show -json
export const checkHclAws = (hcl, labId) => [...];         // hcl2json of the lab's .tf files
// CLI: node infra/ci/lab-scope-aws.mjs (--plan <file> | --hcl <file>) --lab <id>   exit 0 clean / 1 "rule: address (message)" lines / 2 bad input
```

- `scripts/test/fixtures/labs/plans/common-aws.mjs` exports `AWS_REGION` ("eu-west-2"), `AWS_SECONDARY` ("eu-west-1"), `ACCOUNT` ("123456789012"), `BOUNDARY` (`arn:aws:iam::123456789012:policy/wg-admin-lab-boundary`), `AMI` ("ami-0123456789abcdef0"), `GATEWAY_CIDR` ("10.50.0.0/16"), `AWS_PROVIDER_CONFIG`, `ctxAws(id, n, { slot = 1 })`, `awsData()`, `templateResources(c)`, `al2023Instance(c, opts)`; Tasks 3 and 12–16 build every AWS plan fixture from them.

AWS_TYPES for batch 1 (type → reason; later batches add their own, ruling 21):

| Type | Reason (one line in the Map) |
|---|---|
| `aws_resourcegroups_group` | the lab's own console group, a tag query on its own id |
| `aws_vpc`, `aws_subnet`, `aws_route_table`, `aws_route_table_association`, `aws_route`, `aws_internet_gateway` | the lab's own network inside its slot |
| `aws_security_group`, `aws_vpc_security_group_ingress_rule`, `aws_vpc_security_group_egress_rule` | the lab's own firewall rules |
| `aws_vpc_endpoint` | S3 gateway endpoint and interface endpoints inside the lab VPC |
| `aws_ec2_instance_connect_endpoint` | console SSH into the lab's private instances |
| `aws_instance`, `aws_launch_template`, `aws_ebs_volume`, `aws_volume_attachment`, `aws_ebs_snapshot` | the lab's compute and disks |
| `aws_autoscaling_group`, `aws_autoscaling_policy`, `aws_autoscaling_schedule`, `aws_autoscaling_lifecycle_hook` | lab 03's group and its scaling settings |
| `aws_lb`, `aws_lb_target_group`, `aws_lb_listener` | lab 03's load balancer |
| `aws_iam_role`, `aws_iam_instance_profile`, `aws_iam_policy`, `aws_iam_role_policy_attachment` | lab identities under the boundary, path /cloudlabs-lab/ |
| `aws_cloudwatch_log_group`, `aws_cloudwatch_log_metric_filter`, `aws_cloudwatch_metric_alarm`, `aws_cloudwatch_dashboard`, `aws_cloudwatch_query_definition` | lab 01's monitoring |
| `aws_cloudwatch_event_rule`, `aws_cloudwatch_event_target`, `aws_sns_topic`, `aws_sns_topic_policy` | lab 01's notifications |
| `aws_ssm_patch_baseline`, `aws_ssm_patch_group`, `aws_ssm_association` | lab 02's Systems Manager settings |
| `aws_config_configuration_recorder`, `aws_config_delivery_channel`, `aws_config_configuration_recorder_status`, `aws_config_config_rule`, `aws_config_remediation_configuration` | lab 02's Config (recorder only in AWS_CONFIG_LABS) |
| `aws_s3_bucket`, `aws_s3_bucket_versioning`, `aws_s3_bucket_lifecycle_configuration`, `aws_s3_bucket_replication_configuration`, `aws_s3_bucket_public_access_block`, `aws_s3_bucket_policy`, `aws_s3_object` | lab buckets named cloudlabs-<name_prefix>-* |
| `aws_backup_vault`, `aws_backup_plan`, `aws_backup_selection` | lab 04's backups |
| `aws_db_instance`, `aws_db_subnet_group`, `aws_db_parameter_group` | lab 05's database |

AWS_DATA: `aws_ssm_parameter` (name must start `/aws/service/`), `aws_ami` (`owners` exactly `["amazon"]`), `aws_availability_zones`, `aws_caller_identity`, `aws_region`, `aws_partition`, `aws_iam_policy_document`, `aws_ec2_managed_prefix_list` (name must start `com.amazonaws.`), `archive_file`.

NEVER_TYPES (rule 5): `^aws_dx_`, `^aws_networkmanager_`, `^aws_organizations_`, `^aws_ram_`, `^aws_fms_`, `^aws_shield_`, `^aws_verifiedaccess_`, `^aws_acmpca_`, `^aws_route53domains_`, `^aws_ec2_host$`, `^aws_ec2_capacity_reservation$`, `^aws_ec2_capacity_block_reservation$`, `^aws_guardduty_`, `^aws_securityhub_`, `^aws_macie2_`, `^aws_iam_service_linked_role$`, `^aws_iam_access_key$`, `^aws_iam_account_`, `^aws_budgets_`, `^aws_ce_`, `^aws_ec2_byoip_`, `^aws_vpc_ipam_pool_cidr$` outside `ans-20-vpc-design`; plus any resource with `tenancy` or `placement.tenancy` = `dedicated` or `host`.

UNTAGGABLE (rule 7, type → the attribute that must start `lab-<id>-`; `aws_kms_alias` must start `alias/lab-<id>-`): `aws_cloudwatch_dashboard` → `dashboard_name`, `aws_cloudwatch_query_definition` → `name`, `aws_config_configuration_recorder` → `name`, `aws_config_delivery_channel` → `name`, `aws_config_configuration_recorder_status` → `name`, `aws_ssm_patch_group` → `patch_group`, `aws_kms_alias` → `name`, `aws_cloudfront_function` → `name`, `aws_cloudfront_origin_access_control` → `name`, `aws_cloudfront_cache_policy` → `name`, `aws_cloudfront_origin_request_policy` → `name`.

MANAGED_POLICIES: `arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`, `arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy`, `arn:aws:iam::aws:policy/AmazonEKSClusterPolicy`, `arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy`, `arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy`, `arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly`, `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`, `arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`, `arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`, `arn:aws:iam::aws:policy/service-role/AWS_ConfigRole`, `arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup`, `arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores`, `arn:aws:iam::aws:policy/service-role/AmazonSSMAutomationRole`, `arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole` (V each path; Task 17's controller checks them with `aws iam get-policy`).

Rules, in this order, one problem per resource (the first that applies), each `{ rule, address, message }`:

1. `provider` — a resource or provider whose source is not in `AWS_PROVIDER_SOURCES`; an `aws` provider config (plan: `configuration.provider_config`; HCL: `provider "aws"` blocks) with any key other than `region`, `alias`, `default_tags`; a `region` that is not `var.region`, `var.secondary_region` (only under `alias = "secondary"`, and in plan mode only when the plan's `secondary_region` variable is non-empty and differs from `region`), `"us-east-1"` or `"us-west-2"` (both only for a lab in `AWS_GLOBAL_LABS`); `default_tags` other than `tags = var.tags`. Messages name the key or value.
2. `provisioner`, 3. `import` — as `lab-scope.mjs` (a resource with provisioners; a change with `importing`).
4. `type` — a managed type not in `AWS_TYPES` (`${type} is not on AWS_TYPES: add it with its reason (ruling 21)`); a data source not in `AWS_DATA`, or one breaking its condition; Config recorder, delivery channel or recorder status outside `AWS_CONFIG_LABS`. A type in NEVER_TYPES is reported under rule 5 instead.
5. `never` — NEVER_TYPES or dedicated/host tenancy (`${type} is only explained in a readme (Not built here)`).
6. `tag` (plan mode) — every resource whose values have `tags_all` must have `tags_all["cloudlabs-lab"] === labId` (an Unknown `tags_all` is refused: "tags_all is not known at plan: tag through default_tags and var.tags"); `aws_instance` also `volume_tags["cloudlabs-lab"]`; `aws_launch_template` a `tag_specifications` entry for each of `instance`, `volume`, `network-interface` whose `tags` carry the lab tag; `aws_autoscaling_group` a `tag` block `{ key: "cloudlabs-lab", value: labId, propagate_at_launch: true }`; `aws_ecs_service` `propagate_tags = "SERVICE"`; `aws_db_instance`/`aws_rds_cluster` `copy_tags_to_snapshot = true`; `aws_backup_plan` every `rule.recovery_point_tags["cloudlabs-lab"] === labId`.
7. `untaggable` — UNTAGGABLE types whose name attribute does not start `lab-<id>-` (`alias/lab-<id>-` for KMS aliases). In HCL mode a name built from `var.lab_id` counts.
8. `iam` — `aws_iam_role`, `aws_iam_instance_profile`, `aws_iam_policy`: `path === "/cloudlabs-lab/"` and `name` starting `lab-<id>-`; `aws_iam_role` (and `aws_iam_user`) `permissions_boundary` matching `BOUNDARY_RE`; `aws_iam_user`, `aws_iam_user_login_profile`, `aws_iam_user_policy_attachment` only in `AWS_IAM_USER_LABS`; `aws_iam_role_policy_attachment.policy_arn` in `MANAGED_POLICIES` or Unknown with a reference to an `aws_iam_policy` of this configuration; any policy document (`aws_iam_policy.policy`, `aws_iam_role_policy.policy`, inline `inline_policy`) with an `Action` or `NotAction` key whose value is `"*"`, starts `iam:`, or any `NotAction` at all; a trust policy (`assume_role_policy`) whose `Principal` is not only `{ Service: "<x>.amazonaws.com" | [...] }` or `{ AWS: <the lab's own role ARNs, arn:aws:iam::<12 digits>:role/cloudlabs-lab/lab-<id>-*> }`, or holds `Federated` or `"*"`. Documents are parsed from JSON strings; a document that is Unknown in plan mode is refused ("the policy must be known at plan: write it with jsonencode, ruling A42").
9. `gateway` — any string value or object key anywhere in the resource matching `/\b(vpc-wg|snet-wg|rt-wg|sg-wg|igw-wg|rt-workloads|snet-workloads)\b/`, any object key `wg-admin`, any string containing `wg-admin` other than one matching `BOUNDARY_RE`; `aws_vpc_peering_connection_accepter`; an `aws_vpc_peering_connection` whose `vpc_id` or `peer_vpc_id` is not an Unknown referencing an `aws_vpc` of this configuration, or that sets `peer_owner_id` or `peer_region`; in plan mode any known string matching `/^(vpc|subnet|rtb|sg|igw|nat|pcx|tgw|tgw-attach|eni|i|eipalloc|vpce|lt|eigw|pl)-[0-9a-f]{8,17}$/` ("names an existing AWS resource the lab did not make").
10. `address` (plan mode, needs `variables.address_space`) — `aws_vpc.cidr_block`, `aws_vpc_ipv4_cidr_block_association.cidr_block` and `aws_subnet.cidr_block` inside the slot; two lab VPCs (or a VPC and a secondary CIDR) overlapping; a route (`aws_route.destination_cidr_block`, or an inline `aws_route_table.route[*].cidr_block`) other than inside the slot, `variables.gateway_cidr` or `0.0.0.0/0`; an IPv6 route other than `::/0`; `ipv6_ipam_pool_id` outside `ans-20-vpc-design`.
11. `public` — `aws_instance.associate_public_ip_address === true`, a launch template `network_interfaces[*].associate_public_ip_address` of `true` or `"true"`, `aws_eip` with `instance` or `network_interface` set, `aws_eip_association` (all three allowed only in `PUBLIC_INSTANCE_LABS`), `aws_subnet.map_public_ip_on_launch === true`; an ingress rule (`aws_vpc_security_group_ingress_rule`, or `aws_security_group.ingress[*]`) admitting TCP port 22 (any range that covers 22, or protocol `-1`) from `0.0.0.0/0` or `::/0` (§7.4).
12. `lingering` — refused when any of these REQUIRED settings does not hold: `aws_db_instance`/`aws_rds_cluster` `skip_final_snapshot === true`, `deletion_protection === false`, `delete_automated_backups === true`; `aws_s3_bucket.force_destroy === true`; `aws_secretsmanager_secret.recovery_window_in_days === 0`; `aws_kms_key.deletion_window_in_days === 7` and a key policy granting `arn:aws:iam::<acct>:root` `kms:*`; `aws_cloudwatch_log_group.retention_in_days` in 1..7 and `skip_destroy !== true`; every `aws_lambda_function`, `aws_ecs_task_definition` log configuration, `aws_api_gateway_stage`/`aws_apigatewayv2_stage` access log, `aws_flow_log` with a CloudWatch destination and `aws_route53_query_log` writes to a log group declared in this configuration; `aws_ecr_repository.force_delete === true`; `aws_backup_vault.force_destroy === true`; `aws_lb.enable_deletion_protection !== true`; `aws_dynamodb_table.deletion_protection_enabled !== true`; `aws_networkfirewall_firewall.delete_protection !== true`; `aws_instance` `disable_api_termination !== true` and `disable_api_stop !== true`; `aws_cloudfront_distribution.retain_on_delete !== true`; `aws_route53_zone.force_destroy === true`. Refused outright: any `aws_s3_bucket_object_lock_configuration`, `aws_backup_vault_lock_configuration` or `aws_glacier_vault_lock`, and `aws_kms_key.bypass_policy_lockout_safety_check === true`.
13. `size` — instance types (`aws_instance.instance_type`, `aws_launch_template.instance_type`) in `AWS_INSTANCE_TYPES` (`t4g.medium` only for `AWS_MEDIUM_LABS`); `aws_db_instance.instance_class === "db.t4g.micro"`, `allocated_storage <= 30`, `max_allocated_storage` unset or 0 (P10); `aws_elasticache_*` node type `cache.t4g.micro`; EBS sizes (`aws_ebs_volume.size`, `root_block_device[*].volume_size`, `ebs_block_device[*].volume_size`, launch template `block_device_mappings[*].ebs[*].volume_size`) ≤ 30 and io2 `iops` ≤ 500; `aws_autoscaling_group.max_size <= 4`; `aws_eks_node_group.scaling_config.max_size <= 2`; Fargate task `cpu <= 512`; `aws_kinesis_stream.shard_count === 1` (provisioned); `aws_networkfirewall_firewall` one `subnet_mapping`; at most 2 `aws_nat_gateway` instances.

In HCL mode rules 6, 10 and the known-id part of 9 are skipped (values are not known); rule 1 reads the HCL provider blocks; rules 7, 8, 11, 12, 13 read literal values where the HCL has them. A third mode, `"mock"` (Task 3's labs-tf runs it on `terraform test`'s mocked plan, where the provider never computes `tags_all` and has no provider configuration in the stream), is plan mode without rule 6 and without rule 1's provider-config checks.

- [ ] **Step 1: Write `common-aws.mjs`** (fixture helpers; the template's resources exactly as Task 3 writes `labs/_template-aws/`)

```js
// scripts/test/fixtures/labs/plans/common-aws.mjs
//
// Plain English: what every AWS lab's plan fixture shares (AWS labs spec §4):
// a session's values (slot 1, London, an a<NN> name prefix, the cloudlabs
// tags), the aws provider as the template configures it, the data sources
// every lab reads, the template's network (labs/_template-aws) and an Amazon
// Linux 2023 instance as the labs build one. Fake ids only.

import { cidrOverlaps, slotCidr } from "../../../../lib/labs.mjs";

export const AWS_REGION = "eu-west-2";
export const AWS_SECONDARY = "eu-west-1";
export const ACCOUNT = "123456789012";
export const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/wg-admin-lab-boundary`;
export const AMI = "ami-0123456789abcdef0";
export const GATEWAY_CIDR = "10.50.0.0/16";
export const AWS_PROVIDER_CONFIG = {
  aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } },
};
const sub = (cidr, newbits, n) => {
  const [ip, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits) - newbits);
  const start = ip.split(".").reduce((a, x) => a * 256 + Number(x), 0) + n * size;
  return `${[24, 16, 8, 0].map((s) => Math.floor(start / 2 ** s) % 256).join(".")}/${Number(bits) + newbits}`;
};
export { sub as cidrsubnet, cidrOverlaps };

/** A session's values for AWS lab `id` (number `n`, two digits) in slot `slot`. */
export const ctxAws = (id, n, { slot = 1 } = {}) => {
  const tags = { "cloudlabs-lab": id, "cloudlabs-session": "ls-20261015090000-ab12cd", project: "cloudlabs" };
  const address = slotCidr(slot);
  const vpcCidr = sub(address, 2, 0);
  return {
    id, n, tags, address, vpcCidr, prefix: `a${n}k3x9q`,
    variables: { lab_id: id, name_prefix: `a${n}k3x9q`, region: AWS_REGION, secondary_region: "", address_space: address, gateway_cidr: GATEWAY_CIDR, peered: false, tags },
  };
};
/** values with tags_all as the provider plans it: default tags (var.tags) merged with the resource's own. */
export const tagged = (c, values) => ({ ...values, tags_all: { ...c.tags, ...(values.tags ?? {}) } });
export const ref = (address, attr) => [`${address}.${attr}`, address];

/** The data sources the template reads (known at plan). */
export const awsData = () => [
  { address: "data.aws_availability_zones.available", values: { state: "available", names: ["eu-west-2a", "eu-west-2b", "eu-west-2c"] }, refs: {} },
  { address: "data.aws_ssm_parameter.al2023_arm64", values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", insecure_value: AMI }, refs: {} },
  { address: "data.aws_caller_identity.current", values: { account_id: ACCOUNT }, refs: {} },
  { address: "data.aws_partition.current", values: { partition: "aws" }, refs: {} },
];

/** labs/_template-aws's resources, as its .tf files make them (Task 3). */
export function templateResources(c) {
  const VPC = "aws_vpc.lab";
  return [
    { address: "aws_resourcegroups_group.lab", values: tagged(c, { name: `lab-${c.id}`, resource_query: [{ type: "TAG_FILTERS_1_0", query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [c.id] }] }) }] }), refs: { name: ["var.lab_id"], "resource_query.query": ["var.lab_id"] } },
    { address: VPC, values: tagged(c, { cidr_block: c.vpcCidr, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-lab" } }), refs: { cidr_block: ["local.vpc_cidr"] } },
    ...[0, 1].map((i) => ({ address: `aws_subnet.private[${i}]`, count: 2, values: tagged(c, { cidr_block: sub(c.vpcCidr, 4, i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-private-${i + 1}` } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id"), cidr_block: ["local.vpc_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] } })),
    { address: "aws_route_table.private", values: tagged(c, { tags: { Name: "rt-private" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    ...[0, 1].map((i) => ({ address: `aws_route_table_association.private[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: [`aws_subnet.private[${"count.index"}].id`, "aws_subnet.private", "count.index"], route_table_id: ref("aws_route_table.private", "id") } })),
    { address: "aws_vpc_endpoint.s3", values: tagged(c, { service_name: `com.amazonaws.${AWS_REGION}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref(VPC, "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.private", "id") } },
    { address: "aws_security_group.eice", values: tagged(c, { name: "lab-eice", description: "EC2 Instance Connect Endpoint: SSH out to the lab's instances", tags: { Name: "sg-eice" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    { address: "aws_vpc_security_group_egress_rule.eice_ssh", values: tagged(c, { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.eice", "id"), cidr_ipv4: ["local.vpc_cidr"] } },
    { address: "aws_ec2_instance_connect_endpoint.lab", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-lab" } }), unknown: ["subnet_id", "security_group_ids"], refs: { subnet_id: ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"], security_group_ids: ref("aws_security_group.eice", "id") } },
    { address: "aws_security_group.vms", values: tagged(c, { name: "lab-vms", description: "Lab instances: SSH from the Instance Connect Endpoint, anything from the gateway when peered", tags: { Name: "sg-vms" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    { address: "aws_vpc_security_group_ingress_rule.vms_ssh_eice", values: tagged(c, { ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id", "referenced_security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id"), referenced_security_group_id: ref("aws_security_group.eice", "id") } },
    { address: "aws_vpc_security_group_ingress_rule.vms_from_gateway", values: tagged(c, { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id"), cidr_ipv4: ["var.gateway_cidr"] } },
    { address: "aws_vpc_security_group_egress_rule.vms_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } },
  ];
}

/**
 * An Amazon Linux 2023 instance as the labs build one: IMDSv2, no public IP, an 8 GiB gp3 root disk, the lab's
 * tags on its volumes, the session's cloud-init (unknown at plan: it holds the password). opts: { key, name,
 * subnet ("aws_subnet.private[0]"), type ("t4g.micro"), profile (an aws_iam_instance_profile address or null),
 * sgs (security group addresses, default ["aws_security_group.vms"]), monitoring (false) }.
 */
export function al2023Instance(c, { key, name, subnet = "aws_subnet.private[0]", type = "t4g.micro", profile = null, sgs = ["aws_security_group.vms"], monitoring = false }) {
  return {
    address: `aws_instance.${key}`,
    values: tagged(c, {
      ami: AMI, instance_type: type, associate_public_ip_address: false, disable_api_termination: false, disable_api_stop: false, monitoring,
      metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
      root_block_device: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: true }],
      volume_tags: { ...c.tags, Name: name },
      tags: { Name: name },
    }),
    unknown: ["subnet_id", "vpc_security_group_ids", "user_data", ...(profile ? ["iam_instance_profile"] : [])],
    refs: {
      ami: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"],
      subnet_id: [`${subnet}.id`, subnet, subnet.replace(/\[\d+\]$/, "")],
      vpc_security_group_ids: sgs.flatMap((s) => ref(s, "id")),
      user_data: ["local.cloud_init"],
      volume_tags: ["var.tags"],
      ...(profile ? { iam_instance_profile: ref(profile, "name") } : {}),
    },
  };
}
```

Also add to `realistic.mjs`: `realisticPlan({ ..., providerConfig = {} })` builds `provider_config` as today and then `Object.assign(provider_config, providerConfig)`. An AWS fixture description passes `providers: ["aws"]` and `providerConfig: AWS_PROVIDER_CONFIG`.

- [ ] **Step 2: Write the failing scope test** `scripts/test/lab-scope-aws.test.mjs`

```js
// lab-scope-aws.test.mjs
//
// Plain English: the AWS plan scope check (AWS labs spec §7.3): the
// template's plan passes, and each rule refuses one evil plan naming itself
// (§11). Plans are built as terraform show -json prints them
// (fixtures/labs/plans/realistic.mjs) from the AWS fixture helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWS_CONFIG_LABS, AWS_GLOBAL_LABS, AWS_IAM_USER_LABS, AWS_INSTANCE_TYPES, AWS_MEDIUM_LABS, LAB_ID_RE } from "../lib/labs.mjs";
import * as scope from "../../infra/ci/lab-scope-aws.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";
import { al2023Instance, AWS_PROVIDER_CONFIG, awsData, BOUNDARY, ctxAws, ref, tagged, templateResources } from "./fixtures/labs/plans/common-aws.mjs";

const ID = "soa-01-cloudwatch";
const c = ctxAws(ID, "01");
const plan = (extra = [], { providerConfig = AWS_PROVIDER_CONFIG, variables = c.variables, base = templateResources(c) } = {}) =>
  realisticPlan({ resources: [...base, ...extra], data: awsData(), providers: ["aws"], providerConfig, variables });
const rules = (p, id = ID) => scope.checkPlanAws(p, id).map((x) => `${x.rule}: ${x.address}`);

test("the template's plan passes, and with an instance", () => {
  assert.deepEqual(rules(plan()), []);
  assert.deepEqual(rules(plan([al2023Instance(c, { key: "app", name: "vm-app" })])), []);
});

test("the constants equal the contract's copies", () => {
  assert.equal(scope.LAB_ID_RE.source, LAB_ID_RE.source);
  for (const [a, b] of [[scope.AWS_CONFIG_LABS, AWS_CONFIG_LABS], [scope.AWS_GLOBAL_LABS, AWS_GLOBAL_LABS], [scope.AWS_IAM_USER_LABS, AWS_IAM_USER_LABS], [scope.AWS_INSTANCE_TYPES, AWS_INSTANCE_TYPES], [scope.AWS_MEDIUM_LABS, AWS_MEDIUM_LABS]]) assert.deepEqual([...a], [...b]);
});

const role = (over = {}) => ({
  address: "aws_iam_role.vm",
  values: tagged(c, { name: `lab-${ID}-vm`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] }), ...over }),
  refs: {},
});
const policy = (doc) => ({ address: "aws_iam_policy.extra", values: tagged(c, { name: `lab-${ID}-extra`, path: "/cloudlabs-lab/", policy: JSON.stringify(doc) }), refs: {} });

// [rule, what, a change to the clean plan]
const EVIL = [
  ["provider", "an aws provider with a profile", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, profile: { constant_value: "admin" } } } } })],
  ["provider", "an aws provider in us-east-1 outside the global labs", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, region: { constant_value: "us-east-1" } } } } })],
  ["provider", "a null provider resource", () => plan([{ address: "null_resource.x", values: {}, refs: {} }])],
  ["import", "adopting an existing VPC", () => plan([{ ...templateResources(c)[1], address: "aws_vpc.adopted", importing: { id: "vpc-0123456789abcdef0" } }])],
  ["type", "a type not on the allow-list", () => plan([{ address: "aws_lambda_function.x", values: tagged(c, { function_name: "x" }), refs: {} }])],
  ["type", "a data source that looks up a VPC", () => realisticPlan({ resources: templateResources(c), data: [...awsData(), { address: "data.aws_vpc.wg", values: { tags: { Name: "vpc-x" } }, refs: {} }], providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c.variables })],
  ["type", "a Config recorder outside lab 02", () => plan([{ address: "aws_config_configuration_recorder.r", values: { name: `lab-${ID}-recorder` }, unknown: ["role_arn"], refs: {} }])],
  ["never", "a Direct Connect gateway", () => plan([{ address: "aws_dx_gateway.x", values: { name: "x", amazon_side_asn: "64512" }, refs: {} }])],
  ["never", "an access key", () => plan([{ address: "aws_iam_access_key.x", values: { user: "x" }, refs: {} }])],
  ["tag", "a resource without the lab tag", () => plan([{ address: "aws_sns_topic.x", values: { name: "x", tags_all: { project: "cloudlabs" } }, refs: {} }])],
  ["tag", "an instance whose volumes miss the tag", () => { const i = al2023Instance(c, { key: "app", name: "vm-app" }); i.values.volume_tags = { Name: "vm-app" }; return plan([i]); }],
  ["untaggable", "a dashboard not named lab-<id>-*", () => plan([{ address: "aws_cloudwatch_dashboard.d", values: { dashboard_name: "overview", dashboard_body: "{}" }, refs: {} }])],
  ["iam", "a role outside /cloudlabs-lab/", () => plan([role({ path: "/" })])],
  ["iam", "a role without the boundary", () => plan([role({ permissions_boundary: null })])],
  ["iam", "a role trusting an account", () => plan([role({ assume_role_policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }] }) })])],
  ["iam", "a policy with an iam: action", () => plan([policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["iam:PassRole"], Resource: "*" }] })])],
  ["iam", "a policy with Action *", () => plan([policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] })])],
  ["iam", "AdministratorAccess attached", () => plan([role(), { address: "aws_iam_role_policy_attachment.admin", values: { policy_arn: "arn:aws:iam::aws:policy/AdministratorAccess" }, unknown: ["role"], refs: { role: ref("aws_iam_role.vm", "name") } }])],
  ["iam", "a user outside soa-07", () => plan([{ address: "aws_iam_user.u", values: tagged(c, { name: `lab-${ID}-u`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY }), refs: {} }])],
  ["gateway", "a route table named rt-wg", () => plan([{ address: "aws_route_table.gw", values: tagged(c, { tags: { Name: "rt-wg" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["gateway", "a subnet in an existing VPC by id", () => plan([{ address: "aws_subnet.other", values: tagged(c, { vpc_id: "vpc-0a1b2c3d4e5f60718", cidr_block: "10.64.65.0/24" }), refs: {} }])],
  ["gateway", "a peering accepter", () => plan([{ address: "aws_vpc_peering_connection_accepter.x", values: tagged(c, { auto_accept: true }), unknown: ["vpc_peering_connection_id"], refs: {} }])],
  ["gateway", "a tag key wg-admin", () => plan([{ address: "aws_sns_topic.x", values: { name: "x", tags: { "wg-admin": "vpn" }, tags_all: { ...c.tags, "wg-admin": "vpn" } }, refs: {} }])],
  ["address", "a VPC outside the slot", () => { const base = templateResources(c); base[1] = { ...base[1], values: { ...base[1].values, cidr_block: "10.65.0.0/20" } }; return plan([], { base }); }],
  ["address", "a route to another lab's slot", () => plan([{ address: "aws_route.other", values: { destination_cidr_block: "10.66.0.0/18" }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id") } }])],
  ["public", "an instance with a public IP", () => { const i = al2023Instance(c, { key: "app", name: "vm-app" }); i.values.associate_public_ip_address = true; return plan([i]); }],
  ["public", "a subnet that maps public IPs", () => { const base = templateResources(c); base[2] = { ...base[2], values: { ...base[2].values, map_public_ip_on_launch: true } }; return plan([], { base }); }],
  ["public", "SSH from the internet", () => plan([{ address: "aws_vpc_security_group_ingress_rule.ssh_world", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } }])],
  ["lingering", "a database that keeps a final snapshot", () => plan([{ address: "aws_db_instance.db", values: tagged(c, { instance_class: "db.t4g.micro", allocated_storage: 20, skip_final_snapshot: false, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true }), unknown: ["db_subnet_group_name"], refs: {} }])],
  ["lingering", "a bucket that cannot be force-destroyed", () => plan([{ address: "aws_s3_bucket.b", values: tagged(c, { bucket: `cloudlabs-${c.prefix}-x`, force_destroy: false }), refs: {} }])],
  ["lingering", "a log group kept for 30 days", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: "/cloudlabs/x", retention_in_days: 30, skip_destroy: false }), refs: {} }])],
  ["lingering", "a load balancer with deletion protection", () => plan([{ address: "aws_lb.web", values: tagged(c, { name: "alb-x", internal: false, load_balancer_type: "application", enable_deletion_protection: true }), unknown: ["subnets", "security_groups"], refs: {} }])],
  ["size", "an m5.large instance", () => plan([al2023Instance(c, { key: "big", name: "vm-big", type: "m5.large" })])],
  ["size", "a 100 GiB volume", () => plan([{ address: "aws_ebs_volume.big", values: tagged(c, { availability_zone: "eu-west-2a", size: 100, type: "gp3" }), refs: {} }])],
  ["size", "an Auto Scaling group of 10", () => plan([{ address: "aws_autoscaling_group.g", values: { min_size: 2, max_size: 10, desired_capacity: 2, tag: [{ key: "cloudlabs-lab", value: ID, propagate_at_launch: true }] }, unknown: ["vpc_zone_identifier"], refs: {} }])],
];
for (const [rule, what, make] of EVIL) {
  test(`${rule}: refuses ${what}`, () => {
    const got = scope.checkPlanAws(make(), ID);
    assert.ok(got.some((p) => p.rule === rule), `${rule} expected, got ${JSON.stringify(got.map((p) => `${p.rule}: ${p.address} (${p.message})`))}`);
  });
}

test("the Config recorder passes in lab 02; the us-east-1 provider passes in lab 09", () => {
  const c2 = ctxAws("soa-02-systems-manager", "02");
  const rec = { address: "aws_config_configuration_recorder.r", values: { name: "lab-soa-02-systems-manager-recorder" }, unknown: ["role_arn"], refs: {} };
  assert.deepEqual(scope.checkPlanAws(realisticPlan({ resources: [...templateResources(c2), rec], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c2.variables }), c2.id), []);
  const c9 = ctxAws("soa-09-route53-cloudfront", "09");
  const pc = { ...AWS_PROVIDER_CONFIG, "aws.us_east_1": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "us_east_1", expressions: { alias: { constant_value: "us_east_1" }, region: { constant_value: "us-east-1" }, default_tags: [{ tags: { references: ["var.tags"] } }] } } };
  assert.deepEqual(scope.checkPlanAws(realisticPlan({ resources: templateResources(c9), data: awsData(), providers: ["aws"], providerConfig: pc, variables: c9.variables }), c9.id), []);
});

test("the command line: exit 0 for the template, 1 with one line per refusal, 2 for bad arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-aws-"));
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(plan()));
  writeFileSync(bad, JSON.stringify(EVIL.find(([, w]) => w === "SSH from the internet")[2]()));
  const run = (...a) => spawnSync(process.execPath, ["infra/ci/lab-scope-aws.mjs", ...a], { encoding: "utf8" });
  assert.equal(run("--plan", good, "--lab", ID).status, 0);
  const r = run("--plan", bad, "--lab", ID);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^public: aws_vpc_security_group_ingress_rule\.ssh_world \(/m);
  assert.equal(run("--plan", good).status, 2);
  assert.equal(run("--plan", good, "--lab", "az104-08-vms").status, 2, "an Azure id is refused: this is the AWS check");
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `node --test scripts/test/lab-scope-aws.test.mjs`
Expected: FAIL (`infra/ci/lab-scope-aws.mjs` does not exist).

- [ ] **Step 4: Regenerate the fixture schema data**: add these AWS types to `TYPES` in `extract-computed.mjs` (the AWS_TYPES table above, plus `aws_vpc_peering_connection`, `aws_eip`, `aws_nat_gateway`, `aws_iam_user`, `aws_sns_topic`), run the header's commands with the aws, tls and archive providers added, and commit the regenerated `computed.json` and `schema-facts.json`. The header comment records the exact aws provider version.

- [ ] **Step 5: Write `infra/ci/lab-scope-aws.mjs`** with the header comment listing the 13 rules (as `lab-scope.mjs` does), the exports above, `checkPlanAws = (plan, labId) => scopeProblemsAws({ ...planResources(plan), configKeys: configKeysOf(plan), providerConfigs: plan?.configuration?.provider_config ?? {}, planVariables: Object.fromEntries(Object.entries(plan?.variables ?? {}).map(([k, v]) => [k, v?.value])) }, labId, { mode: "plan" })` (`configKeysOf` maps each configured resource address to its `provider_config_key`), `checkHclAws = (hcl, labId) => scopeProblemsAws({ ...hclResources(hcl, labId), providerBlocks: hcl.provider ?? {} }, labId, { mode: "hcl" })`, and a `main` like `lab-scope.mjs`'s whose `--lab` must match `LAB_ID_RE` and be an AWS id (prefix `soa-`, `saa-` or `ans-`). Plain Node, no packages.

- [ ] **Step 6: Make `planResources` keep the four variables** (`infra/ci/lab-scope.mjs`): `.filter(([k]) => ["region", "secondary_region", "address_space", "gateway_cidr"].includes(k))`. Update `lab-plans.test.mjs` to pick `checkPlanAws` for AWS ids and `labs-content-suite.test.mjs:180` to Azure labs only.

- [ ] **Step 7: Run the targeted tests**

Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-scope.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-content-suite.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add infra/ci/lab-scope-aws.mjs infra/ci/lab-scope.mjs scripts/test
git commit -m "feat(aws labs): the AWS plan scope check, one evil plan per rule, AWS plan fixtures

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 3: AWS template, `lab-lint --cloud aws`, labs-check and labs-tf

Spec: §3.1 (`labs/_template-aws`), §4 (variables, providers, every-lab resources, instances, outputs), §7.3 (`lab-lint.mjs --cloud aws`), §11 (labs-check and labs-tf for AWS labs), rulings A10, A11, A12, P12, P15.

**Files:**
- Create: `labs/_template-aws/versions.tf`, `variables.tf`, `main.tf`, `network.tf`, `outputs.tf` (content below)
- Modify: `infra/ci/lab-lint.mjs` (`lintTfText(files, { cloud })`, `lintDir(dir, { cloud })`, `ALLOWED_PROVIDER_SOURCES_AWS`, the AWS text rules, the CLI's `--cloud aws`)
- Modify: `scripts/labs-check.mjs` (lint and variables per lab by its cloud; `_template-aws` linted as AWS)
- Modify: `scripts/labs-tf.mjs` (`labsTfTargets` adds `_template-aws` as `TEMPLATE_AWS_ID = "soa-00-template"` second; `MOCKABLE` adds `aws`, `tls`, `archive`; `mockPlanFile` writes the AWS mock for AWS ids; the HCL scope check uses `checkHclAws` for AWS ids; AWS labs also run `terraform test -verbose -json` and `scopeProblemsAws` in mode `"mock"` on its `test_plan` message)
- Test: `scripts/test/lab-lint.test.mjs`, `scripts/test/lab-tf.test.mjs`, `scripts/test/labs-aws-template.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1's `cloudOfId`, `LAB_TF_VARS_AWS`, `variablesProblems(tf, cloud)`, `slotCidr`; Task 2's `checkHclAws(hcl, labId)` and `scopeProblemsAws(input, labId, { mode: "mock" })`, `planResources` from `lab-scope.mjs`, and `templateResources(c)` in `common-aws.mjs` (the template's resources must match it address for address).
- Produces: `labs/_template-aws/*.tf` (labs copy it); in `infra/ci/lab-lint.mjs`: `export const ALLOWED_PROVIDER_SOURCES_AWS = ["registry.terraform.io/hashicorp/aws", "registry.terraform.io/hashicorp/random", "registry.terraform.io/hashicorp/time", "registry.terraform.io/hashicorp/tls", "registry.terraform.io/hashicorp/archive"]`, `lintTfText(files, { cloud = "azure" } = {})`, `lintDir(dir, { cloud = "azure" } = {})`, CLI `node infra/ci/lab-lint.mjs [--cloud aws] <dir>`; TfProblem `rule` gains `"aws-provider"`; in `scripts/labs-tf.mjs`: `export const TEMPLATE_AWS_ID = "soa-00-template"`, `mockPlanFile(labId, providers)` (AWS variant below).

The template (every AWS lab copies these files and adds its own `.tf` files beside them):

`labs/_template-aws/versions.tf`
```hcl
# versions.tf
#
# Plain English: the providers an AWS lab uses (AWS labs spec §4): Terraform
# 1.14.6 in the workflow, hashicorp/aws 6.x, and only as a lab needs them
# random, time, tls and archive. Credentials come from the run's per-step STS
# session in the environment, never from here: the provider block holds the
# region and the lab's tags only. The state lives in R2 at
# labs/<id>/terraform.tfstate; lab-aws.yml passes the bucket, keys and key
# at init from a file, so nothing secret or lab-specific is written here.

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    region       = "auto"
    use_lockfile = true

    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = var.tags
  }
}
```

`labs/_template-aws/variables.tf`
```hcl
# variables.tf
#
# Plain English: everything lab-aws.yml fills in (AWS labs spec §4). A lab
# declares only the ones it uses; labs-check refuses any other variable. The
# template declares them all so a new lab can copy it and delete what it does
# not need (keep secondary_region only with regions.secondary).

variable "lab_id" {
  type        = string
  description = "The lab's id, e.g. soa-01-cloudwatch."
}

variable "name_prefix" {
  type        = string
  description = "a + lab number + 5 random lowercase characters (a01k3x9q), for globally unique names (S3 buckets, load balancers)."
}

variable "region" {
  type        = string
  description = "The session's region: always eu-west-2 (London)."
}

variable "secondary_region" {
  type        = string
  description = "eu-west-1 (Ireland) for a lab with regions.secondary; empty otherwise."
  default     = ""
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "gateway_cidr" {
  type        = string
  description = "The VPN server's VPC range (the Worker's AZURE_VNET_CIDR): the one other address a lab may write (ruling A10). No default: lab-aws.yml always sets it, and the lint refuses literal CIDRs."
}

variable "peered" {
  type        = bool
  description = "Whether this session asked to peer to the VPN server's VPC (the pipeline adds the peering and routes)."
  default     = false
}

variable "admin_password" {
  type        = string
  description = "The session's password for labadmin on every instance (ruling A12)."
  sensitive   = true
}

variable "ssh_public_key" {
  type        = string
  description = "The operator's SSH public key, for labs that want one."
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "cloudlabs-lab = <id>, cloudlabs-session = <session id>, project = cloudlabs: on everything, through default_tags."
}
```

`labs/_template-aws/main.tf`
```hcl
# main.tf
#
# Plain English: what every AWS lab has (AWS labs spec §4). Its own AWS
# Resource Groups group, lab-<id>, a free tag query that is the dashboard's
# "Open in AWS console" link, and the IAM permission boundary every lab role
# must carry. A lab with regions.secondary adds a second group there with
# provider = aws.secondary (groups are regional).

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  # Every lab role and user carries this boundary (spec §7.2); the scope check refuses one without it.
  boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/wg-admin-lab-boundary"
}

resource "aws_resourcegroups_group" "lab" {
  name = "lab-${var.lab_id}"

  resource_query {
    type = "TAG_FILTERS_1_0"
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "cloudlabs-lab", Values = [var.lab_id] }]
    })
  }
}
```

`labs/_template-aws/network.tf`
```hcl
# network.tf
#
# Plain English: the network most AWS labs start from (AWS labs spec §4).
# One VPC, the slot's first /20, with two private /24 subnets in two
# Availability Zones; a free S3 gateway endpoint so Amazon Linux 2023 installs
# packages with no NAT gateway (ruling A11); an EC2 Instance Connect Endpoint
# for console SSH with no public IP; and the instances' security group:
# SSH from the endpoint, and anything from the VPN server's VPC, which only
# reaches the lab once it is peered (the pipeline adds the peering and the
# route back). Also the AMI and the cloud-init every instance starts from.

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  vpc_cidr = cidrsubnet(var.address_space, 2, 0)
  azs      = slice(data.aws_availability_zones.available.names, 0, 2)

  # The labadmin user with the session's password (ruling A12), password SSH on. A lab adds its own
  # keys: user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, { runcmd = [...] }))}".
  cloud_init_base = {
    ssh_pwauth = true
    users = [
      "default",
      { name = "labadmin", groups = ["wheel"], sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", lock_passwd = false },
    ]
    chpasswd = { expire = false, list = "labadmin:${var.admin_password}\n" }
  }
  cloud_init = "#cloud-config\n${yamlencode(local.cloud_init_base)}"
}

resource "aws_vpc" "lab" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-lab" }
}

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-private-${count.index + 1}" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-private" }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.lab.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "vpce-s3" }
}

resource "aws_security_group" "eice" {
  name        = "lab-eice"
  description = "EC2 Instance Connect Endpoint: SSH out to the lab's instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-eice" }
}

resource "aws_vpc_security_group_egress_rule" "eice_ssh" {
  security_group_id = aws_security_group.eice.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "lab" {
  subnet_id          = aws_subnet.private[0].id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false
  tags               = { Name = "eice-lab" }
}

resource "aws_security_group" "vms" {
  name        = "lab-vms"
  description = "Lab instances: SSH from the Instance Connect Endpoint, anything from the gateway when peered"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-vms" }
}

resource "aws_vpc_security_group_ingress_rule" "vms_ssh_eice" {
  security_group_id            = aws_security_group.vms.id
  referenced_security_group_id = aws_security_group.eice.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# Always present (ruling A45): Peer can come after deploy without a new apply.
resource "aws_vpc_security_group_ingress_rule" "vms_from_gateway" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "vms_all" {
  security_group_id = aws_security_group.vms.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
```

`labs/_template-aws/outputs.tf`
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (AWS labs spec
# §4). private_ips: name -> address. connect: short lines, for example
# "aws ec2-instance-connect ssh --instance-id i-... --os-user labadmin
# --connection-type eice" (works anywhere) and, while peered, "ssh
# labadmin@10.64.64.10" and "curl http://10.64.64.10". peer_vpc_id: the VPC
# the pipeline peers to the VPN server's (the hub in a multi-VPC lab, which
# also carries the tag cloudlabs-peer = hub); peer_route_table_ids: the lab
# route tables that get the route back to var.gateway_cidr.

output "private_ips" {
  value = {}
}

output "connect" {
  value = []
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

The AWS mock written by `mockPlanFile(labId, providers)` for an AWS id (n = the id's two digits):
```hcl
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012", arn = "arn:aws:iam::123456789012:user/labs-tf-mock", user_id = "AIDALABSTFMOCK" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_region" {
    defaults = { name = "eu-west-2", region = "eu-west-2" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-2a", "eu-west-2b", "eu-west-2c"], zone_ids = ["euw2-az2", "euw2-az3", "euw2-az1"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0", insecure_value = "ami-0123456789abcdef0", type = "String" }
  }
}
# plus mock_provider "<p>" {} for each other provider in `providers`

variables {
  lab_id           = "<labId>"
  name_prefix      = "a<n>k3x9q"
  region           = "eu-west-2"
  secondary_region = "eu-west-1"
  address_space    = "<slotCidr(31)>"
  gateway_cidr     = "10.50.0.0/16"
  peered           = false
  admin_password   = "Mock-Passw0rd-labs-tf-not-real"
  ssh_public_key   = "<MOCK_SSH_KEY>"
  tags             = { "cloudlabs-lab" = "<labId>", "cloudlabs-session" = "ls-labs-tf-mock", project = "cloudlabs" }
}

run "plan" {
  command = plan
}
```

- [ ] **Step 1: Write the failing tests**

`scripts/test/labs-aws-template.test.mjs`:
```js
// labs-aws-template.test.mjs
//
// Plain English: labs/_template-aws keeps the AWS contract (AWS labs spec §4):
// exactly the §4 variables, the one allowed provider block, the lab's
// resource group as a tag query on its own id, the template network the
// plan fixtures describe, and the outputs the pipeline reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAB_TF_VARS_AWS, variablesProblems } from "../lib/labs.mjs";
import { lintDir } from "../../infra/ci/lab-lint.mjs";
import { ctxAws, templateResources } from "./fixtures/labs/plans/common-aws.mjs";

const DIR = fileURLToPath(new URL("../../labs/_template-aws/", import.meta.url));
const text = readdirSync(DIR).filter((f) => f.endsWith(".tf")).map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");

test("the template declares exactly the §4 variables and passes the AWS lint", () => {
  const vars = [...text.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(vars, [...LAB_TF_VARS_AWS]);
  assert.deepEqual(variablesProblems(readFileSync(join(DIR, "variables.tf"), "utf8"), "aws"), []);
  assert.deepEqual(lintDir(DIR, { cloud: "aws" }), []);
});

test("one provider block: the session's region and the lab's tags, nothing else", () => {
  const blocks = [...text.matchAll(/^provider "aws" \{([\s\S]*?)^\}/gm)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(blocks, ["region = var.region default_tags { tags = var.tags }"]);
});

test("the template's resources are the ones the plan fixtures describe", () => {
  const tf = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`).sort();
  const fixture = [...new Set(templateResources(ctxAws("soa-00-template", "00")).map((r) => r.address.replace(/\[\d+\]$/, "")))].sort();
  assert.deepEqual(tf, fixture);
});

test("the resource group queries the lab tag on the lab's own id; outputs are the §4 ones", () => {
  assert.match(text, /name = "lab-\$\{var\.lab_id\}"/);
  assert.match(text, /TagFilters\s+= \[\{ Key = "cloudlabs-lab", Values = \[var\.lab_id\] \}\]/);
  assert.deepEqual([...text.matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]), ["private_ips", "connect", "peer_vpc_id", "peer_route_table_ids"]);
});
```

Add to `scripts/test/lab-lint.test.mjs`:
```js
const aws = (files) => lintTfText(files, { cloud: "aws" }).map((p) => `${p.rule}: ${p.message}`);
const AWS_OK = 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.0" }\n  }\n}\nprovider "aws" {\n  region = var.region\n  default_tags {\n    tags = var.tags\n  }\n}\n';

test("every lab and both templates pass, each by its own cloud", () => {
  for (const folder of labFolders(LABS)) {
    const cloud = cloudOfId(folder);
    assert.deepEqual(lintDir(join(LABS, folder, "terraform"), { cloud }), [], folder);
  }
  assert.deepEqual(lintDir(join(LABS, "_template-aws"), { cloud: "aws" }), []);
});

test("AWS: aws, random, time, tls and archive by full source address; azurerm is refused", () => {
  assert.deepEqual(aws({ "main.tf": AWS_OK }), []);
  assert.ok(aws({ "main.tf": 'terraform {\n  required_providers {\n    azurerm = { source = "hashicorp/azurerm" }\n  }\n}\n' }).some((p) => p.startsWith("provider:")));
  assert.ok(aws({ "main.tf": 'terraform {\n  required_providers {\n    aws = { source = "evil/aws" }\n  }\n}\n' }).some((p) => p.startsWith("provider:")));
});

test("AWS: a provider block may hold only region, alias and default_tags with var.tags", () => {
  for (const extra of ['profile = "admin"', 'access_key = "x"', "assume_role {\n    role_arn = \"x\"\n  }", 'endpoints {\n    s3 = "https://x"\n  }', 'skip_credentials_validation = true']) {
    const tf = AWS_OK.replace("region = var.region", `region = var.region\n  ${extra}`);
    assert.ok(aws({ "main.tf": tf }).some((p) => p.startsWith("aws-provider:")), extra);
  }
  assert.ok(aws({ "main.tf": AWS_OK.replace("tags = var.tags", 'tags = { x = "y" }') }).some((p) => p.startsWith("aws-provider:")));
  assert.ok(aws({ "main.tf": AWS_OK.replace("region = var.region", 'region = "us-east-2"') }).some((p) => p.startsWith("aws-provider:")));
  assert.deepEqual(aws({ "main.tf": `${AWS_OK}provider "aws" {\n  alias  = "secondary"\n  region = var.secondary_region\n  default_tags {\n    tags = var.tags\n  }\n}\n` }), []);
});

test("AWS: literal CIDRs only 0.0.0.0/0 and ::/0", () => {
  assert.deepEqual(aws({ "main.tf": 'locals {\n  a = "0.0.0.0/0"\n  b = "::/0"\n}\n' }), []);
  assert.ok(aws({ "main.tf": 'locals {\n  a = "10.50.0.0/16"\n}\n' }).some((p) => p.startsWith("literal-cidr:")));
  assert.ok(aws({ "main.tf": 'locals {\n  a = "2001:db8::/32"\n}\n' }).some((p) => p.startsWith("literal-cidr:")));
});

test("AWS: the VPN server's names and the wg-admin key are refused; the boundary's name is not", () => {
  for (const n of ["vpc-wg", "snet-wg", "rt-wg", "sg-wg", "igw-wg", "rt-workloads", "snet-workloads"]) assert.ok(aws({ "main.tf": `locals {\n  x = "${n}"\n}\n` }).some((p) => p.startsWith("gateway:")), n);
  assert.ok(aws({ "main.tf": 'locals {\n  t = { "wg-admin" = "vpn" }\n}\n' }).some((p) => p.startsWith("gateway:")));
  assert.ok(aws({ "main.tf": 'locals {\n  r = "wg-admin-deploy"\n}\n' }).some((p) => p.startsWith("gateway:")));
  assert.deepEqual(aws({ "main.tf": 'locals {\n  b = "arn:aws:iam::1:policy/wg-admin-lab-boundary"\n}\n' }), []);
});

test("AWS: no data tls_certificate, and archive_file only inside path.module", () => {
  assert.ok(aws({ "main.tf": 'data "tls_certificate" "x" {\n  url = "https://example.com"\n}\n' }).some((p) => p.startsWith("provider:") || p.startsWith("data:")));
  assert.ok(aws({ "main.tf": 'data "archive_file" "x" {\n  type        = "zip"\n  source_file = "/etc/passwd"\n  output_path = "x.zip"\n}\n' }).some((p) => p.startsWith("data:")));
  assert.deepEqual(aws({ "main.tf": 'data "archive_file" "x" {\n  type        = "zip"\n  source_dir  = "${path.module}/src"\n  output_path = "${path.module}/x.zip"\n}\n' }).filter((p) => p.startsWith("data:")), []);
});

test("the command line takes --cloud aws", () => {
  const r = spawnSync(process.execPath, ["infra/ci/lab-lint.mjs", "--cloud", "aws", "labs/_template-aws"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
```
(`cloudOfId` is imported from `../lib/labs.mjs`; `spawnSync` from `node:child_process`. Replace the existing "every lab and the template pass" test with the first one above. The `data:` rule is new: `data "tls_certificate"` and an `archive_file` whose `source_file`/`source_dir`/`source` does not start with `${path.module}` are `{ rule: "data" }`.)

Add to `scripts/test/lab-tf.test.mjs`:
```js
test("labs-tf checks the AWS template second, as soa-00-template", () => {
  const t = labsTfTargets(LABS);
  assert.deepEqual(t.slice(0, 2).map((x) => [x.folder, x.labId]), [["_template", "az104-00-template"], ["_template-aws", "soa-00-template"]]);
});

test("the AWS mock plan mocks aws with the data the labs read and fills the AWS variables", () => {
  const f = mockPlanFile("soa-03-auto-scaling", ["aws", "random"]);
  for (const s of ['mock_provider "aws" {', 'mock_data "aws_ssm_parameter"', 'insecure_value = "ami-0123456789abcdef0"', 'mock_data "aws_availability_zones"', 'mock_provider "random" {}', 'name_prefix      = "a03k3x9q"', 'region           = "eu-west-2"', 'gateway_cidr     = "10.50.0.0/16"', '"cloudlabs-lab" = "soa-03-auto-scaling"']) assert.ok(f.includes(s), s);
  assert.ok(!f.includes("resource_group_name"));
  assert.ok(mockPlanFile("az104-08-vms", ["azurerm"]).includes('resource_group_name = "rg-lab-az104-08-vms"'), "the Azure mock is unchanged");
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-aws-template.test.mjs scripts/test/lab-lint.test.mjs scripts/test/lab-tf.test.mjs`
Expected: FAIL (no `labs/_template-aws`, `lintTfText` ignores `cloud`, no `_template-aws` target).

- [ ] **Step 3: Create the five template files** exactly as above.

- [ ] **Step 4: Teach `infra/ci/lab-lint.mjs` the AWS rules**: `lintTfText(files, { cloud = "azure" } = {})` and `lintDir(dir, { cloud = "azure" } = {})`. For `cloud === "aws"`: the provider allow-list is `ALLOWED_PROVIDER_SOURCES_AWS`; the `literal-cidr` rule also matches IPv6 (`/(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\/\d{1,3}\b/g`) and allows `0.0.0.0/0` and `::/0`; the `gateway` rule is `/\b(vpc-wg|snet-wg|rt-wg|sg-wg|igw-wg|rt-workloads|snet-workloads)\b/g` plus every `/\bwg-admin[\w-]*/g` match other than `wg-admin-lab-boundary`; a new `aws-provider` rule reads each `provider "aws"` block body and refuses any key but `region`, `alias`, `default_tags`, a `region` other than `var.region`, `var.secondary_region`, `"us-east-1"`, `"us-west-2"`, and a `default_tags` body other than `tags = var.tags`; the new `data` rule as Step 1 says; Bicep files are not read for AWS, and CloudFormation templates (`terraform/cfn/*.yaml`, lab 06) are read in batch 2, which brings the first one. `main(argv)` accepts `--cloud aws` before the folder; its last log line names the cloud's providers. Azure behaviour and messages are unchanged.

- [ ] **Step 5: Update `scripts/labs-check.mjs`**: the Terraform loop is `[["_template", "_template", "azure"], ["_template-aws", "_template-aws", "aws"], ...labFolders(root).map((f) => [f, join(f, "terraform"), cloudOfLab(f)])]` where `cloudOfLab(f)` reads `labs/<f>/lab.yaml`'s `cloud` (default `cloudOfId(f)`); lint with `lintDir(tf, { cloud })` and `variablesProblems(files["variables.tf"], cloud)`. The success line says "the pool and both templates are fine".

- [ ] **Step 6: Update `scripts/labs-tf.mjs`**: `TEMPLATE_AWS_ID`; `labsTfTargets` puts `{ folder: "_template-aws", dir: join(labsDir, "_template-aws"), labId: TEMPLATE_AWS_ID, problem: null }` second; `MOCKABLE = ["azurerm", "azuread", "random", "time", "aws", "tls", "archive"]`; `mockPlanFile` returns the AWS text above when `cloudOfId(labId) === "aws"` (n from `/^[a-z0-9]+-(\d{2})-/`); the HCL step calls `cloudOfId(t.labId) === "aws" ? checkHclAws(json, t.labId) : checkHcl(json, t.labId)`; for AWS targets the mock plan runs `terraform test -no-color -verbose -json` and, after it passes, `scopeProblemsAws({ ...planResources(mockPlan), configKeys: {}, providerConfigs: {}, planVariables: <the mock's variables> }, t.labId, { mode: "mock" })` on `mockPlan = { planned_values: { root_module: { resources: changes.map((c) => ({ address: c.address, mode: c.mode, type: c.type, name: c.name, index: c.index, provider_name: c.provider_name, values: c.change.after ?? {} })) } }, resource_changes: changes, configuration: { root_module: { resources: [] } } }` where `changes` is the stream's `test_plan.resource_changes` (read with `messages()` from `scripts/lib/topology-stream.mjs`; never printed: it holds the mock password). A problem fails the target as `mock plan scope: <rule>: <address> (<message>)`.

- [ ] **Step 7: Run the targeted tests and the static checks**

Run: `node --test scripts/test/labs-aws-template.test.mjs scripts/test/lab-lint.test.mjs scripts/test/lab-tf.test.mjs`, then `npm run labs-check`, then `npm run labs-tf -- _template-aws` (needs terraform; downloads the aws provider once)
Expected: all PASS; labs-tf prints `ok   _template-aws`.

- [ ] **Step 8: Commit**

```bash
git add labs/_template-aws infra/ci/lab-lint.mjs scripts/labs-check.mjs scripts/labs-tf.mjs scripts/test
git commit -m "feat(aws labs): the AWS lab template, lint --cloud aws, labs-check and labs-tf for AWS labs

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 4: `lab-aws.yml`, creds, parse, plan, ready check, peer/unpeer

Spec: §5 (all of it, with §5.1), §2 connectivity rule, §6 callbacks bullet, rulings A10, A14, A25, P1, P2, P8.

**Files:**
- Create: `.github/workflows/lab-aws.yml` (full text below)
- Create: `infra/ci/aws-lab-creds.sh`, `infra/ci/lab-ready-aws.sh`, `infra/ci/lab-peer-aws.sh`
- Modify: `infra/ci/lab-parse.sh` (cloud by `LAB_WORKFLOW_CLOUD`, AWS payload rules, AWS outputs)
- Modify: `.github/workflows/lab.yml` (only the "Check out, Parse payload" step gains `env: { LAB_WORKFLOW_CLOUD: azure }`)
- Modify: `infra/ci/lab-plan.sh` (scope script by `$LAB_CLOUD`; `TF_VAR_gateway_vnet_id` only for Azure)
- Modify: `infra/ci/lab-tf-run.sh` (messages say "the cloud" instead of "Azure"; no logic change)
- Modify: `infra/ci/lab-transient.mjs` (AWS transient and refusal patterns)
- Modify: `infra/ci/live-log.mjs` (`SECRET_ENV` adds `AWS_SESSION_TOKEN`, `AWS_LABS_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`)
- Modify: `scripts/test/labs-lib.test.mjs` (`ID_RE_COPIES` gains `infra/ci/lab-ready-aws.sh` and `infra/ci/lab-peer-aws.sh`: both define `LAB_ID_RE` the bash way and refuse a bad id with exit 2)
- Test: `scripts/test/lab-aws-workflow.test.mjs` (create), `scripts/test/lab-aws-pipeline.test.mjs` (create), `scripts/test/lab-apply-retry.test.mjs` (AWS cases), `scripts/test/live-log.test.mjs` (if it pins `SECRET_ENV`'s length)

**Interfaces:**
- Consumes: Task 1's `LAB_STEPS` names (unchanged), `AWS_GLOBAL_LABS`, `AWS_LAB_ID_MAX`; Task 2's `infra/ci/lab-scope-aws.mjs --plan <file> --lab <id>`; Task 3's `node infra/ci/lab-lint.mjs --cloud aws <dir>` and the template outputs `peer_vpc_id`, `peer_route_table_ids`; Task 5's `infra/ci/lab-unblock-aws.sh <id>` and `infra/ci/lab-aws-safety-net.sh [--verify] <id>` (called by path; Task 5 writes them).
- Produces:
  - `lab-aws.yml` with the run name `lab <action> <lab id> <run id>`, steps named exactly `LAB_STEPS[].name`, the step-16 callback body `{ run_id, action, status, github_run_id, github_run_url, outputs: { private_ips, connect, users, peer_vpc_id, clean, leftovers, deploy_seconds, destroy_seconds } }` (Task 6's `readOutputs` accepts `peer_vpc_id`).
  - `lab-parse.sh` environment for AWS runs: `LAB_CLOUD=aws`, `LAB_REGION`, `LAB_SECONDARY_REGION`, `LAB_REGIONS` (space-separated: always `eu-west-2 eu-west-1`, the two lab regions the safety net sweeps, plus `us-east-1 us-west-2` for `AWS_GLOBAL_LABS`), `LAB_DELETE_POLL_SECONDS=30`, `LAB_UNBLOCK_VAULT_WAIT_SECONDS=300`, `TF_VAR_gateway_cidr`, `TF_VAR_tags={"cloudlabs-lab":"<id>","cloudlabs-session":"<sid>","project":"cloudlabs"}` and the shared keys (`LAB_ID`, `LAB_ACTION`, `LAB_NUMBER`, `LAB_VERSION`, `LAB_FOLDER`, `LAB_HAS_TF`, `LAB_DEPLOY_MIN`, `LAB_DESTROY_MIN`, `LAB_DELETE_WAIT_SECONDS`, `LAB_JOB_DEADLINE`, `LAB_PEERING`, `WORKER_RUN_ID`, `SESSION_ID`, `CALLBACK_URL`, `LAB_PEER_URL`, `LIVE_LOG_URL`, `SECRETS_URL`, `TF_VAR_lab_id`, `TF_VAR_name_prefix`, `TF_VAR_region`, `TF_VAR_secondary_region`, `TF_VAR_address_space`, `TF_VAR_peered`). Azure runs also get `LAB_CLOUD=azure`; nothing else of theirs changes.
  - `source infra/ci/aws-lab-creds.sh <role-arn> [seconds=10800]`: exports `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (each `::add-mask::`ed), `AWS_REGION` and `AWS_DEFAULT_REGION` (`$LAB_REGION`, default eu-west-2), and unsets `AWS_ENDPOINT_URL_S3`; returns 1 with `::error::` when GitHub or STS refuses.
  - `bash infra/ci/lab-ready-aws.sh <id> <deploy_min>`: exit 0 ready, 1 not ready (each problem a line `not ready: <type> <name> (<state>)`).
  - `bash infra/ci/lab-peer-aws.sh peer|unpeer <id>`: never fails the run (exit 0; exit 2 only for bad arguments).

`.github/workflows/lab-aws.yml` (the workflow; every step that talks to AWS sources the creds script BEFORE `live-log.sh`, so the live log's filter knows the session's values and hides them):

```yaml
# .github/workflows/lab-aws.yml
#
# Plain English: the AWS lab runner (AWS labs spec §5), lab.yml's sister.
# Same inputs, payload, run name, concurrency and the same 16 step names
# (the dashboard's "step 7/16" and live log work unchanged); what differs is
# the cloud:
#   - Credentials per step, never in the workflow's env: R2 by file
#     (Terraform init writes $RUNNER_TEMP/r2.hcl), AWS by OIDC: each AWS step
#     trades a fresh GitHub token for a 3-hour session of wg-admin-labs
#     (infra/ci/aws-lab-creds.sh; steps 6-8 and 11-14), or a 1-hour session
#     of wg-admin-deploy for Peer and Unpeer only (it owns the VPN server's
#     VPC; ruling A25). Never ARM_*, the Cloudflare DNS token or the
#     WireGuard key.
#   - lab-lint --cloud aws before init; lab-scope-aws.mjs on the plan; the
#     AWS ready check, peering, unblock, safety net and clean check.
# Every teardown step runs even when an earlier one failed, and Safety net
# and Verify clean need no Terraform state, so cleaning up leftovers is a
# destroy run. The payload is public (the repo is): nothing secret in it.

name: lab-aws
# The Worker finds this run by its title: "lab <action> <lab id> <run id>".
run-name: "lab ${{ inputs.action }} ${{ fromJSON(inputs.payload).lab_id || 'none' }} ${{ fromJSON(inputs.payload).run_id || 'manual' }}"

on:
  workflow_dispatch:
    inputs:
      action:
        description: "deploy, destroy, peer, unpeer, or test (deploy then destroy)"
        type: choice
        required: true
        default: deploy
        options: [deploy, destroy, peer, unpeer, test]
      payload:
        description: >-
          JSON object, nothing secret: lab_id, version, run_id, session_id,
          region, secondary_region, slot_cidr, name_prefix, peering,
          timeout_min, callback_url, secrets_url, gateway_cidr.
        type: string
        required: true
        default: "{}"

concurrency:
  group: lab-${{ fromJSON(inputs.payload).lab_id || 'none' }}-${{ inputs.action }}
  cancel-in-progress: false

permissions:
  contents: read
  actions: read
  id-token: write

env:
  # R2 for the state backup steps; each AWS step sets its own region (aws-lab-creds.sh).
  AWS_REGION: auto
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "0"
  TF_PLUGIN_CACHE_DIR: ${{ github.workspace }}/.terraform-plugins
  LAB_ACTION_INPUT: ${{ inputs.action }}

jobs:
  lab:
    name: lab ${{ inputs.action }}
    runs-on: ubuntu-24.04
    timeout-minutes: ${{ fromJSON(inputs.payload).timeout_min || 60 }}
    defaults:
      run:
        shell: bash

    steps:
      - name: Check out repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      # ── 1 ──
      - name: Check out, Parse payload
        id: parse
        env:
          LAB_WORKFLOW_CLOUD: aws
        run: bash "$GITHUB_WORKSPACE/infra/ci/lab-parse.sh"

      # ── 2 ── (exactly lab.yml's step 2)
      - name: Collect run secrets
        id: secrets
        run: |
          <lab.yml's step 2 script, unchanged>

      # ── 3 ── (exactly lab.yml's step 3)
      - name: Start live log
        if: env.LIVE_LOG_URL != '' && env.CALLBACK_TOKEN != ''
        continue-on-error: true
        run: |
          <lab.yml's step 3 script, unchanged>

      # ── 4 ── (lab.yml's step 4 with lab-aws.yml's own runs)
      - name: Wait for earlier run of this lab
        id: wait
        timeout-minutes: 15
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          <lab.yml's step 4 script with actions/workflows/lab-aws.yml/runs in place of lab.yml/runs>

      # The account id is in the role ARNs: not a password, but no place in a public log.
      - name: Mask the AWS account id
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
          AWS_DEPLOY_ROLE_ARN: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
        run: |
          for a in "$AWS_LABS_ROLE_ARN" "$AWS_DEPLOY_ROLE_ARN"; do [ -n "$a" ] && echo "::add-mask::$(cut -d: -f5 <<<"$a")"; done
          true

      - name: Set up Terraform
        if: always() && steps.wait.outcome == 'success' && env.LAB_HAS_TF == 'true'
        uses: hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e # v4.0.1
        with:
          terraform_version: "1.14.6"
          terraform_wrapper: false

      - name: Cache Terraform providers
        if: always() && steps.wait.outcome == 'success' && env.LAB_HAS_TF == 'true'
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: ${{ github.workspace }}/.terraform-plugins
          key: tf-plugins-labs-aws-${{ hashFiles('labs/_template-aws/versions.tf') }}

      # ── 5 ── lint the text, then init with the R2 keys in a file (never in AWS_* variables).
      - name: Terraform init
        id: init
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && env.LAB_HAS_TF == 'true' && (inputs.action == 'deploy' || inputs.action == 'destroy' || inputs.action == 'test')
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_ENDPOINT: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Terraform init"
          set -euo pipefail
          node "$GITHUB_WORKSPACE/infra/ci/lab-lint.mjs" --cloud aws "$GITHUB_WORKSPACE/labs/$LAB_ID/terraform"
          ( umask 077; printf 'bucket = "%s"\naccess_key = "%s"\nsecret_key = "%s"\nendpoints = { s3 = "%s" }\n' \
              "$R2_BUCKET" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY" "$R2_ENDPOINT" > "$RUNNER_TEMP/r2.hcl" )
          mkdir -p "$TF_PLUGIN_CACHE_DIR"
          cd "$GITHUB_WORKSPACE/labs/$LAB_ID/terraform"
          terraform init -no-color -input=false -backend-config="$RUNNER_TEMP/r2.hcl" -backend-config="key=labs/$LAB_ID/terraform.tfstate"

      # ── 6 ──
      - name: Plan and scope check
        id: plan
        if: success() && steps.init.outcome == 'success' && (inputs.action == 'deploy' || inputs.action == 'test')
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
          TF_VAR_ssh_public_key: ${{ secrets.SSH_PUBLIC_KEY }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Plan and scope check"
          set -euo pipefail
          echo "LAB_T0=$(date +%s)" >> "$GITHUB_ENV"
          bash "$GITHUB_WORKSPACE/infra/ci/lab-plan.sh"

      # ── 7 ── retried only on AWS transient errors, after a fresh plan that passes the scope check.
      - name: Apply
        id: apply
        if: success() && steps.plan.outcome == 'success' && (inputs.action == 'deploy' || inputs.action == 'test')
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
          TF_VAR_ssh_public_key: ${{ secrets.SSH_PUBLIC_KEY }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Apply"
          set -euo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-tf-run.sh" apply
          cd "$GITHUB_WORKSPACE/labs/$LAB_ID/terraform"
          terraform output -no-color -json > "$RUNNER_TEMP/outputs.json"
          jq -r '.. | strings' "$RUNNER_TEMP/outputs.json" | while IFS= read -r s; do
            [ "${#s}" -ge 4 ] && echo "::add-mask::$s"
          done
          peer_vpc="$(jq -r '.peer_vpc_id.value // empty' "$RUNNER_TEMP/outputs.json")"
          [ -n "$peer_vpc" ] && echo "PEER_VPC_ID=$peer_vpc" >> "$GITHUB_ENV"
          echo "PEER_ROUTE_TABLE_IDS=$(jq -c '.peer_route_table_ids.value // []' "$RUNNER_TEMP/outputs.json")" >> "$GITHUB_ENV"
          echo "applied; outputs kept for the Worker"

      # ── 8 ──
      - name: Ready check
        id: ready
        if: success() && steps.apply.outcome == 'success' && (inputs.action == 'deploy' || inputs.action == 'test')
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Ready check"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-ready-aws.sh" "$LAB_ID" "$LAB_DEPLOY_MIN"
          rc=$?
          echo "LAB_DEPLOY_SECONDS=$(( $(date +%s) - LAB_T0 ))" >> "$GITHUB_ENV"
          exit "$rc"

      # ── 9 ── wg-admin-deploy, 1-hour session (its maximum; ruling A32).
      - name: Peer
        id: peer
        if: success() && env.LAB_PEERING == 'true' && (inputs.action == 'deploy' || inputs.action == 'peer' || inputs.action == 'test')
        env:
          AWS_DEPLOY_ROLE_ARN: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_DEPLOY_ROLE_ARN" 3600 || exit 0
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Peer"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-peer-aws.sh" peer "$LAB_ID"

      # ── 10 ── teardown: from here every step runs even after a failure.
      - name: Unpeer
        id: unpeer
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && (inputs.action == 'destroy' || inputs.action == 'unpeer' || inputs.action == 'test')
        continue-on-error: true
        env:
          AWS_DEPLOY_ROLE_ARN: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
        run: |
          echo "LAB_T1=$(date +%s)" >> "$GITHUB_ENV"
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_DEPLOY_ROLE_ARN" 3600 || exit 0
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Unpeer"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-peer-aws.sh" unpeer "$LAB_ID"

      # ── 11 ──
      - name: Unblock
        id: unblock
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && (inputs.action == 'destroy' || inputs.action == 'test')
        continue-on-error: true
        timeout-minutes: 60
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Unblock"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-unblock-aws.sh" "$LAB_ID"

      # ── 12 ── allowed to fail: the safety net finishes the job.
      - name: Destroy
        id: destroy
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && steps.init.outcome == 'success' && (inputs.action == 'destroy' || inputs.action == 'test')
        continue-on-error: true
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
          TF_VAR_ssh_public_key: ${{ secrets.SSH_PUBLIC_KEY }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Destroy"
          set -euo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-tf-run.sh" destroy

      # ── 13 ──
      - name: Safety net
        id: safety
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && (inputs.action == 'destroy' || inputs.action == 'test')
        continue-on-error: true
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN"
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Safety net"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-aws-safety-net.sh" "$LAB_ID"

      # ── 14 ── the verdict: fails the run when anything of the lab is left or AWS could not be asked.
      - name: Verify clean
        id: verify
        if: always() && steps.wait.outcome == 'success' && env.LAB_ID != '' && (inputs.action == 'destroy' || inputs.action == 'test')
        env:
          AWS_LABS_ROLE_ARN: ${{ secrets.AWS_LABS_ROLE_ARN }}
        run: |
          source "$GITHUB_WORKSPACE/infra/ci/aws-lab-creds.sh" "$AWS_LABS_ROLE_ARN" || { echo "clean=false" >> "$GITHUB_OUTPUT"; echo 'leftovers=["could not sign in to AWS"]' >> "$GITHUB_OUTPUT"; exit 1; }
          source "$GITHUB_WORKSPACE/infra/ci/live-log.sh" "Verify clean"
          set -uo pipefail
          bash "$GITHUB_WORKSPACE/infra/ci/lab-aws-safety-net.sh" --verify "$LAB_ID"
          rc=$?
          echo "LAB_DESTROY_SECONDS=$(( $(date +%s) - ${LAB_T1:-$(date +%s)} ))" >> "$GITHUB_ENV"
          exit "$rc"

      # ── 15 ── (exactly lab.yml's step 15: R2 in this step's env, no AWS credentials)
      - name: Back up state
        if: always() && env.LAB_ID != ''
        continue-on-error: true
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          AWS_ENDPOINT_URL_S3: https://${{ secrets.CLOUDFLARE_ACCOUNT_ID }}.r2.cloudflarestorage.com
          R2_BUCKET: ${{ secrets.R2_BUCKET }}
          VERIFY_CLEAN: ${{ steps.verify.outputs.clean }}
        run: |
          <lab.yml's step 15 script, unchanged>

      # ── 16 ── (lab.yml's step 16 with peer_vpc_id, and no lab output named files ever leaves)
      - name: Finish live log, Report result
        if: always()
        env:
          JOB_STATUS: ${{ job.status }}
          VERIFY_CLEAN: ${{ steps.verify.outputs.clean }}
          VERIFY_LEFTOVERS: ${{ steps.verify.outputs.leftovers }}
          DESTROY_OUTCOME: ${{ steps.destroy.outcome }}
          GH_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          <lab.yml's step 16 script, with these two changes:
           outputs="$(jq 'del(.files) | with_entries(.value = .value.value)' "$RUNNER_TEMP/outputs.json")"
           and in the body: peer_vpc_id:($o.peer_vpc_id // null) in place of peer_vnet_id:($o.peer_vnet_id // null)>
```

The `<…>` lines mean: copy that step's `run:` block from `.github/workflows/lab.yml` verbatim (lines 121–151, 157–165, 180–204, 453–476, 491–526), changing only what the line says. The implementer writes the real text into the file; the test below pins the parts that matter.

- [ ] **Step 1: Write the failing workflow test** `scripts/test/lab-aws-workflow.test.mjs`

```js
// lab-aws-workflow.test.mjs
//
// Plain English: lab-aws.yml keeps lab.yml's contract (AWS labs spec §5) and
// hands each step only the credentials it needs: R2 by file, wg-admin-labs
// for steps 6-8 and 11-14, wg-admin-deploy for Peer and Unpeer only, never
// Azure's or Cloudflare's keys. lab.yml refuses an AWS lab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SECRET_ENV } from "../../infra/ci/live-log.mjs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const text = read(".github/workflows/lab-aws.yml");
const wf = parse(text);
const steps = Object.values(wf.jobs)[0].steps;
const HELPERS = ["Check out repository", "Mask the AWS account id", "Set up Terraform", "Cache Terraform providers"];
const STEP_NAMES = [...read("shared/labs.ts").matchAll(/\{ n: (\d+), name: "([^"]+)"/g)].map((m) => m[2]);
const step = (name) => steps.find((s) => s.name === name);
const envOf = (s) => Object.keys(s.env ?? {});
const LABS_ROLE_STEPS = ["Plan and scope check", "Apply", "Ready check", "Unblock", "Destroy", "Safety net", "Verify clean"];
const DEPLOY_ROLE_STEPS = ["Peer", "Unpeer"];

test("no tabs; the 16 steps in order, named as LAB_STEPS", () => {
  assert.doesNotMatch(text, /\t/);
  assert.deepEqual(steps.map((s) => s.name).filter((n) => !HELPERS.includes(n)), STEP_NAMES);
});

test("run name, concurrency and timeout as lab.yml", () => {
  const lab = parse(read(".github/workflows/lab.yml"));
  assert.equal(wf["run-name"], lab["run-name"]);
  assert.deepEqual(wf.concurrency, lab.concurrency);
  assert.equal(Object.values(wf.jobs)[0]["timeout-minutes"], Object.values(lab.jobs)[0]["timeout-minutes"]);
  assert.deepEqual(wf.on.workflow_dispatch.inputs.action.options, ["deploy", "destroy", "peer", "unpeer", "test"]);
  assert.equal(wf.permissions["id-token"], "write");
});

test("Parse payload says aws here and azure in lab.yml", () => {
  assert.equal(step("Check out, Parse payload").env.LAB_WORKFLOW_CLOUD, "aws");
  const lab = parse(read(".github/workflows/lab.yml"));
  assert.equal(Object.values(lab.jobs)[0].steps.find((s) => s.name === "Check out, Parse payload").env.LAB_WORKFLOW_CLOUD, "azure");
});

test("never Azure's keys, the UPN domain, the Cloudflare DNS token or the WireGuard key", () => {
  assert.doesNotMatch(text, /ARM_|LAB_UPN_DOMAIN|CLOUDFLARE_DNS_TOKEN|WG_SERVER_PRIVATE_KEY|AZURE_RESOURCE_GROUP/);
  assert.equal(wf.env.AWS_ACCESS_KEY_ID, undefined);
});

test("wg-admin-labs only in steps 6-8 and 11-14, wg-admin-deploy only in Peer and Unpeer, each through aws-lab-creds.sh", () => {
  for (const s of steps) {
    const labs = envOf(s).includes("AWS_LABS_ROLE_ARN");
    const deploy = envOf(s).includes("AWS_DEPLOY_ROLE_ARN");
    if (s.name === "Mask the AWS account id") continue;
    assert.equal(labs, LABS_ROLE_STEPS.includes(s.name), `${s.name}: wg-admin-labs`);
    assert.equal(deploy, DEPLOY_ROLE_STEPS.includes(s.name), `${s.name}: wg-admin-deploy`);
    if (labs) assert.match(s.run, /^source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-lab-creds\.sh" "\$AWS_LABS_ROLE_ARN"/m);
    if (deploy) assert.match(s.run, /source "\$GITHUB_WORKSPACE\/infra\/ci\/aws-lab-creds\.sh" "\$AWS_DEPLOY_ROLE_ARN" 3600/);
    if (labs || deploy) assert.ok(s.run.indexOf("aws-lab-creds.sh") < s.run.indexOf("live-log.sh"), `${s.name}: credentials before the live log, so its filter hides them`);
  }
});

test("R2 keys never sit in AWS_* beside AWS credentials: init writes them to a file, umask 077", () => {
  const init = step("Terraform init");
  assert.deepEqual(envOf(init).sort(), ["R2_ACCESS_KEY_ID", "R2_BUCKET", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY"]);
  assert.match(init.run, /umask 077; printf 'bucket = "%s"\\naccess_key/);
  assert.match(init.run, /-backend-config="\$RUNNER_TEMP\/r2\.hcl" -backend-config="key=labs\/\$LAB_ID\/terraform\.tfstate"/);
  assert.match(init.run, /lab-lint\.mjs" --cloud aws/);
  for (const s of steps) if (envOf(s).some((k) => k.includes("ROLE_ARN")) && s.name !== "Mask the AWS account id") assert.ok(!envOf(s).includes("AWS_ACCESS_KEY_ID"), s.name);
  assert.deepEqual(envOf(step("Back up state")).filter((k) => k.startsWith("AWS_")).sort(), ["AWS_ACCESS_KEY_ID", "AWS_ENDPOINT_URL_S3", "AWS_SECRET_ACCESS_KEY"]);
});

test("teardown steps and the report always run; Destroy may fail; the result carries peer_vpc_id and never files", () => {
  for (const n of ["Unpeer", "Unblock", "Destroy", "Safety net", "Verify clean"]) assert.match(step(n).if, /^always\(\)/, n);
  for (const n of ["Unpeer", "Unblock", "Destroy", "Safety net"]) assert.equal(step(n)["continue-on-error"], true, n);
  const report = step("Finish live log, Report result");
  assert.equal(report.if, "always()");
  assert.match(report.run, /peer_vpc_id:\(\$o\.peer_vpc_id \/\/ null\)/);
  assert.doesNotMatch(report.run, /peer_vnet_id/);
  assert.match(report.run, /del\(\.files\)/);
  assert.match(step("Wait for earlier run of this lab").run, /actions\/workflows\/lab-aws\.yml\/runs/);
  assert.match(step("Apply").run, /PEER_ROUTE_TABLE_IDS=/);
});

test("the live log hides the AWS session and both role ARNs", () => {
  for (const k of ["AWS_SESSION_TOKEN", "AWS_LABS_ROLE_ARN", "AWS_DEPLOY_ROLE_ARN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "TF_VAR_admin_password", "CALLBACK_TOKEN"]) assert.ok(SECRET_ENV.includes(k), k);
});
```

- [ ] **Step 2: Write the failing pipeline-script tests** `scripts/test/lab-aws-pipeline.test.mjs` (bash scripts against the fake `aws`/`curl` of `fixtures/labs/harness.mjs`; skipped without bash, and the parse tests without Python+PyYAML, exactly as `lab-workflow.test.mjs` skips)

```js
// lab-aws-pipeline.test.mjs
//
// Plain English: lab-aws.yml's own bash steps against a pretend AWS CLI
// (fixtures/labs/harness.mjs records every call): Parse payload's AWS rules,
// the per-step STS session, the ready check and peering to the VPN server's
// VPC and back (AWS labs spec §5, §5.1, ruling A25).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { BASH, fwd, JQ, REPO, world } from "./fixtures/labs/harness.mjs";
import { AWS_GLOBAL_LABS } from "../lib/labs.mjs";

const skip = BASH && JQ ? false : "needs bash and jq (CI has both)";
const PY = (() => { for (const p of ["python3", "python"]) { const r = spawnSync(p, ["-c", "import yaml"]); if (r.status === 0) return p; } return null; })();
const skipParse = !BASH ? "no bash found" : !PY ? "no Python with PyYAML here (the runner has it)" : false;
const ID = "soa-03-auto-scaling";
const LAB = { id: ID, version: 2, cloud: "aws", connectivity: { peering: "optional", dns_link: false, subnets_used: 1 }, timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 }, identity: { creates: [], roles: [], governance: false } };
const PAYLOAD = { lab_id: ID, version: 2, run_id: "lab-deploy-20261015120000-ab12cd", session_id: "ls-20261015120000-cd34ef", region: "eu-west-2", secondary_region: null, slot_cidr: "10.64.64.0/18", name_prefix: "a03k3x9q", peering: true, timeout_min: 44, callback_url: "https://wg.example.net/api/callback", secrets_url: "https://wg.example.net/api/callback/lab-secrets", gateway_cidr: "10.50.0.0/16" };

function parseRun(cloud, payload, lab = LAB, action = "deploy") {
  const ws = mkdtempSync(join(tmpdir(), "lab-aws-ws-"));
  mkdirSync(join(ws, "labs", lab.id, "terraform"), { recursive: true });
  writeFileSync(join(ws, "labs", lab.id, "lab.yaml"), stringify(lab));
  writeFileSync(join(ws, "labs", lab.id, "terraform", "main.tf"), "# test\n");
  const dir = mkdtempSync(join(tmpdir(), "lab-aws-parse-"));
  const event = join(dir, "event.json");
  const envFile = join(dir, "env");
  writeFileSync(event, JSON.stringify({ inputs: { action, payload: JSON.stringify(payload) } }));
  writeFileSync(envFile, "");
  const r = spawnSync(BASH, ["-eo", "pipefail", fwd(join(REPO, "infra", "ci", "lab-parse.sh"))], { encoding: "utf8", env: { ...process.env, LAB_PYTHON: PY ?? "", LAB_WORKFLOW_CLOUD: cloud, LAB_ACTION_INPUT: action, GITHUB_EVENT_PATH: fwd(event), GITHUB_ENV: fwd(envFile), GITHUB_WORKSPACE: fwd(ws) } });
  const env = {};
  for (const m of readFileSync(envFile, "utf8").matchAll(/^(\w+)<<(EOV_\w+)\n([^\n]*)\n\2$/gm)) env[m[1]] = m[3];
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), env };
}

test("Parse payload: an AWS deploy gets the AWS variables, tags and regions", { skip: skipParse }, () => {
  const r = parseRun("aws", PAYLOAD);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_CLOUD, "aws");
  assert.equal(r.env.TF_VAR_region, "eu-west-2");
  assert.equal(r.env.TF_VAR_gateway_cidr, "10.50.0.0/16");
  assert.deepEqual(JSON.parse(r.env.TF_VAR_tags), { "cloudlabs-lab": ID, "cloudlabs-session": PAYLOAD.session_id, project: "cloudlabs" });
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1");
  assert.equal(r.env.LAB_SECONDARY_REGION, "");
  assert.equal(r.env.TF_VAR_resource_group_name, undefined);
  assert.equal(r.env.LAB_DELETE_POLL_SECONDS, "30");
});

test("Parse payload: a global lab also sweeps us-east-1 and us-west-2, and keeps its secondary region", { skip: skipParse }, () => {
  const g = { ...LAB, id: AWS_GLOBAL_LABS[0], version: 1 };
  const r = parseRun("aws", { ...PAYLOAD, lab_id: g.id, version: 1, name_prefix: "a09k3x9q", secondary_region: "eu-west-1" }, g);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.env.LAB_REGIONS, "eu-west-2 eu-west-1 us-east-1 us-west-2");
  assert.equal(r.env.TF_VAR_secondary_region, "eu-west-1");
});

// [what, workflow cloud, payload change, error pattern]
const PARSE_REFUSED = [
  ["an AWS lab on lab.yml", "azure", {}, /soa-03-auto-scaling is an AWS lab: it runs on lab-aws\.yml/],
  ["an Azure id on lab-aws.yml", "aws", { lab_id: "az104-08-vms" }, /az104-08-vms is an Azure lab: it runs on lab\.yml/],
  ["a region other than London", "aws", { region: "us-east-1" }, /region must be eu-west-2/],
  ["a secondary other than Ireland", "aws", { secondary_region: "eu-central-1" }, /secondary_region must be eu-west-1 or empty/],
  ["an Azure name prefix", "aws", { name_prefix: "l03k3x9q" }, /name_prefix is not a03 and 5 lowercase/],
  ["a gateway range inside the lab pool", "aws", { gateway_cidr: "10.64.0.0/16" }, /gateway_cidr must be an IPv4 range outside 10\.64\.0\.0\/13/],
];
for (const [what, cloud, change, re] of PARSE_REFUSED) {
  test(`Parse payload refuses ${what}`, { skip: skipParse }, () => {
    const r = parseRun(cloud, { ...PAYLOAD, ...change });
    assert.notEqual(r.status, 0);
    assert.match(r.out, re);
  });
}

test("aws-lab-creds.sh trades a GitHub token for a 3-hour session, masks it and exports it for the step", { skip }, () => {
  const w = world([
    { cmd: "curl", match: "audience=sts.amazonaws.com", out: '{"value":"gh-oidc-token"}' },
    { cmd: "aws", match: "^sts assume-role-with-web-identity", out: '{"AccessKeyId":"ASIAFAKE","SecretAccessKey":"fakesecret","SessionToken":"faketoken","Expiration":"2026-10-15T15:00:00Z"}' },
  ]);
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", `PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; source "${fwd(join(REPO, "infra/ci/aws-lab-creds.sh"))}" arn:aws:iam::123456789012:role/wg-admin-labs && echo "id=$AWS_ACCESS_KEY_ID region=$AWS_REGION s3=\${AWS_ENDPOINT_URL_S3:-none}"`], { encoding: "utf8", env: w.env({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t", ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example?x=1", RUNNER_TEMP: fwd(w.dir), LAB_ID: ID, GITHUB_RUN_ID: "42", LAB_REGION: "eu-west-2", AWS_ENDPOINT_URL_S3: "https://r2.example" }) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /::add-mask::ASIAFAKE/);
  assert.match(r.stdout, /::add-mask::fakesecret/);
  assert.match(r.stdout, /::add-mask::faketoken/);
  assert.match(r.stdout, /id=ASIAFAKE region=eu-west-2 s3=none/);
  const call = w.calls().find((c) => c.startsWith("aws sts"));
  assert.match(call, /--role-arn arn:aws:iam::123456789012:role\/wg-admin-labs/);
  assert.match(call, /--duration-seconds 10800/);
  assert.match(call, /--role-session-name lab-soa-03-auto-scaling-42/);
  assert.doesNotMatch(call, /gh-oidc-token/, "the token goes by file, never on the command line");
});

test("the ready check waits for an initializing instance, passes active and available things, and fails an impaired one", { skip }, () => {
  const arns = JSON.stringify({ ResourceTagMappingList: [
    { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0aaa" },
    { ResourceARN: "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/alb-a03k3x9q/50dc6c495c0c9188" },
    { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:instance-connect-endpoint/eice-0bbb" },
    { ResourceARN: "arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0ccc" },
  ] });
  const ok = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: ['{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"initializing"},"SystemStatus":{"Status":"initializing"}}]}', '{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"ok"},"SystemStatus":{"Status":"ok"}}]}'] },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints", out: '{"InstanceConnectEndpoints":[{"State":"create-complete"}]}' },
  ]);
  const r = ok.run("infra/ci/lab-ready-aws.sh", [ID, "6"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(r.status, 0, r.out);
  assert.equal(ok.calls().filter((c) => c.startsWith("aws ec2 describe-instance-status")).length, 2, "polled until the checks passed");
  const bad = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: arns },
    { cmd: "aws", match: "^ec2 describe-instance-status", out: '{"InstanceStatuses":[{"InstanceId":"i-0aaa","InstanceState":{"Name":"running"},"InstanceStatus":{"Status":"impaired"},"SystemStatus":{"Status":"ok"}}]}' },
    { cmd: "aws", match: "^elbv2 describe-load-balancers", out: '{"LoadBalancers":[{"State":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-instance-connect-endpoints", out: '{"InstanceConnectEndpoints":[{"State":"create-complete"}]}' },
  ]);
  const b = bad.run("infra/ci/lab-ready-aws.sh", [ID, "6"], { LAB_REGIONS: "eu-west-2", LAB_READY_POLL_SECONDS: "0" });
  assert.equal(b.status, 1);
  assert.match(b.out, /not ready: ec2:instance i-0aaa \(impaired\)/);
  assert.doesNotMatch(b.out, /123456789012/, "no account id in the log");
});

const WG = { vpc: '{"Vpcs":[{"VpcId":"vpc-0wg"}]}', rt: '{"RouteTables":[{"RouteTableId":"rtb-0wg","Routes":[]}]}' };
test("peer asks the Worker, peers the lab VPC to vpc-wg, tags the connection and adds both routes", { skip }, () => {
  const w = world([
    { cmd: "curl", match: '"phase":"begin"', out: '{"go":true}' },
    { cmd: "curl", match: '"phase":"end"', out: '{"message":"peered"}' },
    { cmd: "aws", match: "^ec2 describe-vpcs.*tag:Name,Values=vpc-wg", out: WG.vpc },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: WG.rt },
    // The first matching rule answers: the wait for pcx-0lab before the search for the lab's existing connections.
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections.*pcx-0lab", out: '{"VpcPeeringConnections":[{"Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[]}' },
    { cmd: "aws", match: "^ec2 create-vpc-peering-connection", out: '{"VpcPeeringConnection":{"VpcPeeringConnectionId":"pcx-0lab"}}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", TF_VAR_address_space: "10.64.64.0/18", TF_VAR_gateway_cidr: "10.50.0.0/16", PEER_VPC_ID: "vpc-0lab", PEER_ROUTE_TABLE_IDS: '["rtb-0lab"]', LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls().filter((c) => c.startsWith("aws ec2 ") && !c.startsWith("aws ec2 describe"));
  assert.match(calls[0], /^aws ec2 create-vpc-peering-connection --vpc-id vpc-0lab --peer-vpc-id vpc-0wg .*Key=cloudlabs-lab,Value=soa-03-auto-scaling.*Key=Name,Value=lab-soa-03-auto-scaling-headend/);
  assert.match(calls[1], /^aws ec2 accept-vpc-peering-connection --vpc-peering-connection-id pcx-0lab/);
  assert.ok(calls.some((c) => /^aws ec2 create-route --route-table-id rtb-0wg --destination-cidr-block 10\.64\.64\.0\/18 --vpc-peering-connection-id pcx-0lab/.test(c)));
  assert.ok(calls.some((c) => /^aws ec2 create-route --route-table-id rtb-0lab --destination-cidr-block 10\.50\.0\.0\/16 --vpc-peering-connection-id pcx-0lab/.test(c)));
  assert.match(w.calls().filter((c) => c.startsWith("curl")).at(-1), /"phase":"end","ok":true/);
});

test("peer waits when the Worker says wait, and touches nothing", { skip }, () => {
  const w = world([{ cmd: "curl", match: '"phase":"begin"', out: '{"go":false,"reason":"the gateway is not running"}' }]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["peer", ID], { LAB_PEER_URL: "https://wg.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "cb", WORKER_RUN_ID: "lab-peer-1", PEER_VPC_ID: "vpc-0lab" });
  assert.equal(r.status, 0);
  assert.equal(w.calls().filter((c) => c.startsWith("aws")).length, 0);
});

test("unpeer removes only this lab's route from rt-wg, the lab's routes, its connections and blackholes in the lab pool", { skip }, () => {
  const rt = { RouteTables: [{ RouteTableId: "rtb-0wg", Routes: [
    { DestinationCidrBlock: "10.64.64.0/18", VpcPeeringConnectionId: "pcx-0lab", State: "active" },
    { DestinationCidrBlock: "10.64.128.0/18", VpcPeeringConnectionId: "pcx-0other", State: "active" },
    { DestinationCidrBlock: "10.65.0.0/18", VpcPeeringConnectionId: "pcx-0gone", State: "blackhole" },
    { DestinationCidrBlock: "192.168.1.0/24", NetworkInterfaceId: "eni-0wg", State: "active" },
  ] }] };
  const w = world([
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:Name,Values=rt-wg", out: JSON.stringify(rt) },
    { cmd: "aws", match: "^ec2 describe-vpc-peering-connections", out: '{"VpcPeeringConnections":[{"VpcPeeringConnectionId":"pcx-0lab","Status":{"Code":"active"}}]}' },
    { cmd: "aws", match: "^ec2 describe-route-tables.*tag:cloudlabs-lab", out: '{"RouteTables":[{"RouteTableId":"rtb-0lab","Routes":[{"DestinationCidrBlock":"10.50.0.0/16","VpcPeeringConnectionId":"pcx-0lab"}]}]}' },
  ]);
  const r = w.run("infra/ci/lab-peer-aws.sh", ["unpeer", ID], { LAB_REGION: "eu-west-2" });
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (delete|create|replace)/.test(c));
  assert.deepEqual(writes, [
    "aws ec2 delete-route --route-table-id rtb-0wg --destination-cidr-block 10.64.64.0/18 --region eu-west-2",
    "aws ec2 delete-route --route-table-id rtb-0lab --destination-cidr-block 10.50.0.0/16 --region eu-west-2",
    "aws ec2 delete-vpc-peering-connection --vpc-peering-connection-id pcx-0lab --region eu-west-2",
    "aws ec2 delete-route --route-table-id rtb-0wg --destination-cidr-block 10.65.0.0/18 --region eu-west-2",
  ]);
});
```

(The fakes answer the first rule that matches each call; the exact argument spellings above are the contract: every `aws` call passes `--region "$LAB_REGION"` last and `--output json` where it reads, and the scripts use `--filters Name=tag:Name,Values=vpc-wg Name=tag:wg-admin,Values=vpn` for the server's VPC and route table. If the fake's matching needs the order of `--filters` arguments, keep the order shown.)

- [ ] **Step 3: Run them to make sure they fail**

Run: `node --test scripts/test/lab-aws-workflow.test.mjs scripts/test/lab-aws-pipeline.test.mjs`
Expected: FAIL (no `lab-aws.yml`, no scripts).

- [ ] **Step 4: `lab-parse.sh`.** In the Python: `CLOUD = os.environ.get("LAB_WORKFLOW_CLOUD") or "azure"`; the new `LAB_ID_RE`; `AWS_PREFIXES = ("soa-", "saa-", "ans-")`; `AWS_GLOBAL_LABS = ("soa-09-route53-cloudfront", "ans-26-edge")` (a test in `labs-aws-contract.test.mjs` keeps it equal to `scripts/lib/labs.mjs`: add `test("lab-parse.sh's AWS_GLOBAL_LABS equals the contract's", ...)` reading the tuple with a regex). `id_cloud = "aws" if lab_id.startswith(AWS_PREFIXES) else "azure"`; refuse before anything else (any action, a destroy too: the other workflow has the other cloud's keys) with `f"{lab_id} is an {'AWS' if id_cloud == 'aws' else 'Azure'} lab: it runs on {'lab-aws.yml' if id_cloud == 'aws' else 'lab.yml'}"` when `id_cloud != CLOUD`; refuse an AWS id over 30 characters; refuse a lab.yaml whose `cloud` (default azure) differs from `id_cloud`. For AWS: `region` must be `eu-west-2` (default `eu-west-2`; error "region must be eu-west-2 (London) for an AWS lab"), `secondary_region` `""` or `eu-west-1` ("secondary_region must be eu-west-1 or empty"), `name_prefix` `^a{number}[a-z0-9]{5}$` ("name_prefix is not a{number} and 5 lowercase letters or digits"), `gateway_cidr` (KNOWN gains it) an IPv4 network that does not overlap `10.64.0.0/13` (default `10.50.0.0/16`; "gateway_cidr must be an IPv4 range outside 10.64.0.0/13"). The AWS output drops `TF_VAR_resource_group_name`, sets `LAB_ENTRA=false`, `LAB_DNS_LINK=false` and adds the keys the Interfaces block lists. Azure output gains only `LAB_CLOUD=azure`.

- [ ] **Step 5: `aws-lab-creds.sh`** (sourced; header comment as `aws-token.sh`'s): fetch the token with audience `sts.amazonaws.com` into `$RUNNER_TEMP/aws-lab-token` (umask 077, `jq -er .value`), call `env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN aws sts assume-role-with-web-identity --role-arn "$1" --role-session-name "lab-${LAB_ID:-none}-${GITHUB_RUN_ID:-0}" --web-identity-token "file://$RUNNER_TEMP/aws-lab-token" --duration-seconds "${2:-10800}" --region "${LAB_REGION:-eu-west-2}" --output json`, delete the token file, mask and export the three values, export `AWS_REGION`/`AWS_DEFAULT_REGION`, `unset AWS_ENDPOINT_URL_S3`, and `return 1` (never `exit`) with `::error::GitHub or AWS STS refused the <role name> session` on any failure.

- [ ] **Step 6: `lab-ready-aws.sh <id> <deploy_min>`**: refuse a bad id (exit 2); `deadline = now + 60 × deploy_min`; poll every `${LAB_READY_POLL_SECONDS:-15}` s: list ARNs in each of `$LAB_REGIONS` (`aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region R --output json`), classify each by `service:type` from the ARN (`arn:aws:ec2:…:instance/i-1` → `ec2:instance`; ELB `loadbalancer/app/...` → `elasticloadbalancing:loadbalancer`), and check every §5.1 type with its own describe (instances `describe-instance-status --include-all-instances`: running with both checks `ok` ready, `initializing` pending, `impaired` failed, terminated ignored; ELBv2 `State.Code` `active`/`failed`; RDS `DBInstanceStatus` `available`; ElastiCache `available`; NAT gateways, VPC endpoints, transit gateways and attachments, VPN connections `available` (`failed` fails); Client VPN `Status.Code` `available`; EKS clusters and node groups `ACTIVE`; ECS services `runningCount == desiredCount`; Network Firewall `READY`; CloudFront `Deployed` (in us-east-1); Global Accelerator `DEPLOYED` (in us-west-2); VPC Lattice `ACTIVE`; Resolver endpoints `OPERATIONAL`; EC2 Instance Connect Endpoints `create-complete` (`create-failed` fails)); anything else is ready by existing. At the deadline, instances still `initializing` pass with `::warning::`; anything else not ready fails. Names in lines are the ARN's resource part (never the account id).

- [ ] **Step 7: `lab-peer-aws.sh peer|unpeer <id>`** as the tests and spec §5 steps 9–10 say: peer begins with the Worker (`curl -sS --max-time 20 -X POST -H "Authorization: Bearer $CALLBACK_TOKEN" -d '{"run_id":"…","phase":"begin"}' "$LAB_PEER_URL"`; no `LAB_PEER_URL` means "no Worker: peering skipped"), finds `vpc-wg` and `rt-wg` by `Name` and `wg-admin=vpn` tags, finds the lab VPC (`PEER_VPC_ID`, else ruling P8: the VPC tagged `cloudlabs-lab=<id>` and `cloudlabs-peer=hub`, else the lab's only VPC) and its route tables (`PEER_ROUTE_TABLE_IDS`, else that VPC's route tables tagged for the lab), reuses an active or pending connection tagged for the lab or creates one (`--tag-specifications 'ResourceType=vpc-peering-connection,Tags=[{Key=cloudlabs-lab,Value=<id>},{Key=Name,Value=lab-<id>-headend}]'`), accepts it, waits up to 60 s for `active`, then `create-route` (falling back to `replace-route` on `RouteAlreadyExists`) for the slot in `rt-wg` and for `gateway_cidr` in each lab route table, and ends with `{"phase":"end","ok":true|false}`. Unpeer (no Worker, no lock) deletes, in this order: the `rt-wg` routes whose target is one of the lab's connections, the lab route tables' routes to those connections, the connections, then every blackhole route in `rt-wg` whose destination lies inside `10.64.0.0/13`. Both never fail the run.

- [ ] **Step 8: `lab-plan.sh`, `lab-tf-run.sh`, `lab-transient.mjs`, `live-log.mjs`, `lab.yml`**: `lab-plan.sh` runs `node "$here/lab-scope-aws.mjs"` when `${LAB_CLOUD:-azure} = aws` (and exports `TF_VAR_gateway_vnet_id` only for Azure); `lab-tf-run.sh`'s messages say "the cloud dropped the connection"; `lab-transient.mjs` adds TRANSIENT `["Throttling", /\bThrottling(?:Exception)?\b/]`, `["RequestLimitExceeded", /\bRequestLimitExceeded\b/]`, `["SlowDown", /\bSlowDown\b/]`, `["5xx", /\bStatusCode: 5\d\d\b/]`, `["send request failed", /\bsend request failed\b/]`, REFUSED `/\bStatusCode: 4(?!08|29)\d\d\b/`, `/\b(AccessDenied\w*|UnauthorizedOperation|InvalidParameter\w*|ValidationException|InvalidClientTokenId|ExpiredToken)\b/`, and a throttle code in the same diagnostic (`Throttling`, `ThrottlingException`, `RequestLimitExceeded`, `TooManyRequestsException`, `SlowDown`) overrides only the generic `StatusCode: 4xx` refusal; `SECRET_ENV` gains the three names; `lab.yml`'s Parse step gains `env: { LAB_WORKFLOW_CLOUD: azure }`.

Add to `scripts/test/lab-apply-retry.test.mjs`:
```js
test("AWS: throttling and 5xx are retried; AccessDenied and a plain 400 are not", () => {
  const diag = (msg) => `Error: ${msg}\n\n  with aws_vpc.lab,\n`;
  assert.equal(transientFailure(diag("creating EC2 VPC: operation error EC2: CreateVpc, https response error StatusCode: 400, RequestID: x, api error RequestLimitExceeded: Request limit exceeded.")).transient, true);
  assert.equal(transientFailure(diag("operation error EC2: RunInstances, https response error StatusCode: 503, RequestID: x, api error Unavailable")).transient, true);
  assert.equal(transientFailure(diag("operation error EC2: CreateVpc, https response error StatusCode: 403, RequestID: x, api error UnauthorizedOperation: You are not authorized")).transient, false);
  assert.equal(transientFailure(diag("operation error EC2: CreateVpc, https response error StatusCode: 400, RequestID: x, api error InvalidParameterValue: bad")).transient, false);
});
```

- [ ] **Step 9: Write `.github/workflows/lab-aws.yml`** as above, with the copied scripts in place of each `<…>` line.

- [ ] **Step 10: Run the targeted tests**

Run: `node --test scripts/test/lab-aws-workflow.test.mjs scripts/test/lab-aws-pipeline.test.mjs scripts/test/lab-workflow.test.mjs scripts/test/lab-apply-retry.test.mjs scripts/test/live-log.test.mjs scripts/test/labs-aws-contract.test.mjs`
Expected: PASS (bash/jq/Python tests skip with their reason where the tool is missing; CI runs them).

- [ ] **Step 11: Commit**

```bash
git add .github/workflows/lab-aws.yml .github/workflows/lab.yml infra/ci scripts/test
git commit -m "feat(aws labs): lab-aws.yml with per-step STS sessions, AWS parse, ready check and peering

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 5: Unblock, safety net and Verify clean for AWS

Spec: §8 (8.1, 8.2, 8.3), §5 steps 11, 13, 14, rulings A4, A16, A18, A26, P6.

**Files:**
- Create: `infra/ci/lab-unblock-aws.sh`
- Create: `infra/ci/lab-aws-safety-net.sh`
- Test: `scripts/test/lab-aws-cleanup.test.mjs` (create)

**Interfaces:**
- Consumes: Task 1's id pattern (copied as `LAB_ID_RE` in each script; add both files to `ID_RE_COPIES` in `scripts/test/labs-lib.test.mjs`); the environment Task 4's Parse payload writes (`LAB_REGIONS`, `LAB_DELETE_POLL_SECONDS`, `LAB_UNBLOCK_VAULT_WAIT_SECONDS`, `LAB_JOB_DEADLINE`); the fake `aws` of `scripts/test/fixtures/labs/harness.mjs`.
- Produces:
  - `bash infra/ci/lab-unblock-aws.sh <id>`: always exit 0 (2 for a bad id).
  - `bash infra/ci/lab-aws-safety-net.sh <id>`: deletes; exit 0 (2 for a bad id).
  - `bash infra/ci/lab-aws-safety-net.sh --verify <id>`: prints and appends to `$GITHUB_OUTPUT` exactly `clean=true|false` and `leftovers=<JSON array of names>`; exit 0 when clean, 1 otherwise. A name is `<service:type> <id>` plus ` (<Name tag>)` when it has one; IAM names are the role/profile/policy/user name; never an account id.

Shared rules for both scripts (header comments say them):
- AWS CLI v2 and jq only; every call passes `--region <r>` (IAM calls none) and `--output json` where it reads. `LAB_REGIONS` defaults to `eu-west-2 eu-west-1`.
- Candidates: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region <r> --output json` in each region; IAM by path and prefix (`aws iam list-roles --path-prefix /cloudlabs-lab/ --output json`, `list-instance-profiles --path-prefix /cloudlabs-lab/`, `list-policies --scope Local --path-prefix /cloudlabs-lab/`, `list-users --path-prefix /cloudlabs-lab/`, keeping names that start `lab-<id>-`); and the named untaggables in each lab region: `aws cloudwatch list-dashboards --dashboard-name-prefix lab-<id>-`, `aws configservice describe-configuration-recorders` and `describe-delivery-channels` (names starting `lab-<id>-`), `aws logs describe-query-definitions --query-definition-name-prefix lab-<id>-`, `aws kms list-aliases` (`alias/lab-<id>-*`).
- The type key is `service:type` from the ARN: `arn:aws:ec2:r:a:instance/i-1` → `ec2:instance`; `arn:aws:elasticloadbalancing:r:a:loadbalancer/app/n/x` → `elasticloadbalancing:loadbalancer`; `arn:aws:elasticloadbalancing:r:a:targetgroup/n/x` → `elasticloadbalancing:targetgroup`; `arn:aws:rds:r:a:db:name` → `rds:db` (also `rds:subgrp`, `rds:pg`, `rds:snapshot`); `arn:aws:s3:::bucket` → `s3:bucket`; `arn:aws:sns:r:a:topic` → `sns:topic`; `arn:aws:logs:r:a:log-group:/x` → `logs:log-group`; `arn:aws:cloudwatch:r:a:alarm:x` → `cloudwatch:alarm`; `arn:aws:events:r:a:rule/x` → `events:rule`; `arn:aws:ssm:r:a:association/x` → `ssm:association`; `arn:aws:ssm:r:a:patchbaseline/pb-x` → `ssm:patchbaseline`; `arn:aws:config:r:a:config-rule/config-rule-x` → `config:config-rule`; `arn:aws:autoscaling:r:a:autoScalingGroup:uuid:autoScalingGroupName/x` → `autoscaling:autoScalingGroup`; `arn:aws:backup:r:a:backup-plan:x` → `backup:backup-plan`; `arn:aws:backup:r:a:backup-vault:x` → `backup:backup-vault`; `arn:aws:resource-groups:r:a:group/x` → `resource-groups:group`; `arn:aws:iam::a:role/...` → `iam:role` (and so on).
- An answer that is empty (no output, exit 0) counts as an empty list; a non-zero exit is a failed listing.
- Deletes poll every `LAB_DELETE_POLL_SECONDS` (30) and stop at `LAB_JOB_DEADLINE − 420`; what is still there is a `::warning::` "left behind: <name>".

Safety net order (§8.2), batch 1's handlers (P6; any other type key gets `::warning::no handler for <type> yet: <name> (left for Verify clean to report)`):

| Phase | Type key | What the script runs |
|---|---|---|
| 1 workloads | `autoscaling:autoScalingGroup` | `aws autoscaling delete-auto-scaling-group --auto-scaling-group-name N --force-delete`, then poll `describe-auto-scaling-groups` until absent |
| 1 | `events:rule` | `aws events list-targets-by-rule --rule N` → `remove-targets --rule N --ids …`, then `delete-rule --name N` |
| 1 | `config:config-rule` | `aws configservice delete-remediation-configuration --config-rule-name N` (ignore NoSuchRemediationConfiguration), then `delete-config-rule --config-rule-name N` |
| 1 | named Config recorder / delivery channel | `stop-configuration-recorder`, `delete-delivery-channel --delivery-channel-name N`, `delete-configuration-recorder --configuration-recorder-name N` |
| 3 network services | `elasticloadbalancing:loadbalancer` then `:targetgroup` | `aws elbv2 delete-load-balancer --load-balancer-arn A` (poll until `describe-load-balancers` says LoadBalancerNotFound), then `delete-target-group --target-group-arn A` |
| 3 | `rds:db` (replicas first: `ReadReplicaSourceDBInstanceIdentifier` set), then `rds:subgrp`, `rds:pg`, `rds:snapshot` | `aws rds delete-db-instance --db-instance-identifier N --skip-final-snapshot --delete-automated-backups` (poll until DBInstanceNotFound), `delete-db-subnet-group --db-subnet-group-name N`, `delete-db-parameter-group --db-parameter-group-name N`, `delete-db-snapshot --db-snapshot-identifier N` |
| 3 | `ec2:instance` | `aws ec2 terminate-instances --instance-ids I`, poll `describe-instances --instance-ids I` until `terminated` |
| 3 | `ec2:launch-template`, `ec2:natgateway` (poll `deleted`), `ec2:elastic-ip` (`release-address --allocation-id`), `ec2:vpc-peering-connection`, `ec2:vpc-endpoint` (`delete-vpc-endpoints --vpc-endpoint-ids`, poll), `ec2:instance-connect-endpoint` (`delete-instance-connect-endpoint --instance-connect-endpoint-id`, poll), `ec2:volume` | their `delete-*` call, then poll where noted |
| 4 VPC fabric | `ec2:network-interface` (detached only), `ec2:security-group` (first revoke every rule of a lab group that references another lab group, then `delete-security-group --group-id`; never a group named `default`), `ec2:subnet`, `ec2:route-table` (disassociate non-main associations first), `ec2:network-acl` (non-default), `ec2:internet-gateway` (`detach-internet-gateway --internet-gateway-id G --vpc-id V` first), `ec2:egress-only-internet-gateway`, `ec2:prefix-list` (`delete-managed-prefix-list`), `ec2:vpc` | in that order |
| 5 data and the rest | `s3:bucket` (every version and delete marker removed with `list-object-versions`/`delete-objects`, then `delete-bucket`), `sns:topic`, `logs:log-group`, `cloudwatch:alarm` (`delete-alarms`), named dashboards (`delete-dashboards`), named query definitions, `ssm:association` (`delete-association --association-id`), `ssm:patchbaseline` (`deregister-patch-baseline-for-patch-group` for each of its groups, then `delete-patch-baseline`), `backup:backup-plan` (its selections first), `backup:backup-vault` (after Unblock emptied it), `ec2:snapshot`, `ec2:image` (`deregister-image`), `resource-groups:group` (`aws resource-groups delete-group --group N`) | in that order |
| 6 IAM | instance profiles (`remove-role-from-instance-profile`, `delete-instance-profile`), roles (`list-attached-role-policies` → `detach-role-policy`, `list-role-policies` → `delete-role-policy`, `delete-role`), users (login profile, policies, then `delete-user`), customer policies (non-default versions first, then `delete-policy`) | only names starting `lab-<id>-` under `/cloudlabs-lab/`; service-linked roles never (A18) |

Verify clean (§8.3): the same candidates, each judged by its real state: an instance `terminated`, a NAT gateway or VPC endpoint `deleted`, an Instance Connect Endpoint `delete-complete`, anything whose describe says NotFound/NoSuchEntity/`*.NotFound`/`DBInstanceNotFound`/`LoadBalancerNotFound`/404 is clean (a KMS key `PendingDeletion` too); a type with no handler is a leftover `no handler for <type>: <name>` (P6). While any `ec2:vpc` candidate still exists: `aws ec2 describe-instances --filters Name=vpc-id,Values=<vpc>` and `describe-network-interfaces --filters Name=vpc-id,Values=<vpc>`; every instance not `terminated` and every interface not `RequesterManaged` that lacks the lab tag is a leftover `untagged inside lab VPC: <id>` (A26). A listing that fails makes `clean=false` with a leftover `could not list <what> in <region>`.

Unblock (§8.1), for the lab's tagged resources only, never failing (each call `|| ::warning::`): RDS `modify-db-instance --db-instance-identifier N --no-deletion-protection --apply-immediately`; ELBv2 `modify-load-balancer-attributes --load-balancer-arn A --attributes Key=deletion_protection.enabled,Value=false`; DynamoDB `update-table --table-name N --no-deletion-protection-enabled`; Network Firewall `update-firewall-delete-protection --firewall-arn A --no-delete-protection`; EC2 `modify-instance-attribute --instance-id I --no-disable-api-termination` and `--no-disable-api-stop` (two calls); CloudFormation `update-termination-protection --stack-name N --no-enable-termination-protection`; named Config recorders `stop-configuration-recorder`; every recovery point in each tagged Backup vault `delete-recovery-point`, polling `list-recovery-points-by-backup-vault` every 15 s until empty or `LAB_UNBLOCK_VAULT_WAIT_SECONDS` (300) or the job deadline; Client VPN: `describe-client-vpn-connections --client-vpn-endpoint-id E`, then `terminate-client-vpn-connections --client-vpn-endpoint-id E --connection-id C` for each active connection; Lambda functions in a VPC: wait (bounded by the deadline) until `describe-network-interfaces --filters Name=requester-id,Values=*:<function>` is empty; a tagged bucket with Object Lock enabled (`get-object-lock-configuration` answers) prints `::warning::Object Lock is on in <bucket>: its locked versions cannot be deleted until they expire`.

- [ ] **Step 1: Write the failing tests** `scripts/test/lab-aws-cleanup.test.mjs`

```js
// lab-aws-cleanup.test.mjs
//
// Plain English: the AWS clean-up steps (AWS labs spec §8) against a pretend
// AWS CLI (fixtures/labs/harness.mjs records every call): Unblock turns off
// what stops a delete, the safety net deletes everything tagged or named for
// the lab in dependency order with no Terraform state at all, and Verify
// clean judges each candidate by its real state, naming untagged leftovers
// inside the lab's VPCs. Skipped without bash and jq (CI has both).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASH, fwd, JQ, REPO, world } from "./fixtures/labs/harness.mjs";

const skip = BASH && JQ ? false : "needs bash and jq (CI has both)";
const ID = "soa-03-auto-scaling";
const A = (r) => `arn:aws:ec2:eu-west-2:123456789012:${r}`;
const tagged = (...arns) => JSON.stringify({ ResourceTagMappingList: arns.map((x) => ({ ResourceARN: x, Tags: [{ Key: "cloudlabs-lab", Value: ID }] })) });
const ENV = { LAB_REGIONS: "eu-west-2", LAB_DELETE_POLL_SECONDS: "0", LAB_UNBLOCK_VAULT_WAIT_SECONDS: "0", LAB_JOB_DEADLINE: String(Math.floor(Date.now() / 1000) + 3600) };
const EMPTY_IAM = [
  { cmd: "aws", match: "^iam list-roles", out: '{"Roles":[]}' },
  { cmd: "aws", match: "^iam list-instance-profiles", out: '{"InstanceProfiles":[]}' },
  { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
  { cmd: "aws", match: "^iam list-users", out: '{"Users":[]}' },
];

for (const f of ["lab-unblock-aws.sh", "lab-aws-safety-net.sh"]) {
  test(`${f} passes bash -n and refuses a bad id before calling AWS`, { skip }, () => {
    assert.equal(spawnSync(BASH, ["-n", fwd(join(REPO, "infra", "ci", f))], { encoding: "utf8" }).status, 0);
    const w = world([]);
    assert.equal(w.run(`infra/ci/${f}`, ["bad id"], ENV).status, 2);
    assert.equal(w.calls().filter((c) => c.startsWith("aws")).length, 0);
  });
}

test("safety net with no state deletes the tagged instance, then its security group, subnet and VPC, in that order", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("vpc/vpc-0a"), A("subnet/subnet-0b"), A("security-group/sg-0c"), A("instance/i-0d")) },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0d", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0d","State":{"Name":"terminated"}}]}]}' },
    { cmd: "aws", match: "^ec2 describe-security-groups", out: '{"SecurityGroups":[{"GroupId":"sg-0c","GroupName":"lab-vms","VpcId":"vpc-0a","IpPermissions":[],"IpPermissionsEgress":[]}]}' },
    ...EMPTY_IAM,
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const writes = w.calls().filter((c) => /^aws ec2 (terminate|delete)/.test(c));
  const at = (re) => writes.findIndex((c) => re.test(c));
  assert.ok(at(/terminate-instances --instance-ids i-0d/) >= 0);
  assert.ok(at(/terminate-instances/) < at(/delete-security-group --group-id sg-0c/));
  assert.ok(at(/delete-security-group/) < at(/delete-subnet --subnet-id subnet-0b/));
  assert.ok(at(/delete-subnet/) < at(/delete-vpc --vpc-id vpc-0a/));
});

test("safety net deletes only this lab's IAM, by path and prefix, profiles before roles, never another lab's or the pipeline's", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^iam list-roles", out: JSON.stringify({ Roles: [{ RoleName: `lab-${ID}-web`, Path: "/cloudlabs-lab/" }, { RoleName: "lab-soa-04-backup-backup", Path: "/cloudlabs-lab/" }, { RoleName: "wg-admin-labs", Path: "/cloudlabs-lab/" }] }) },
    { cmd: "aws", match: "^iam list-instance-profiles", out: JSON.stringify({ InstanceProfiles: [{ InstanceProfileName: `lab-${ID}-web`, Roles: [{ RoleName: `lab-${ID}-web` }] }] }) },
    { cmd: "aws", match: "^iam list-attached-role-policies", out: '{"AttachedPolicies":[{"PolicyArn":"arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"}]}' },
    { cmd: "aws", match: "^iam list-role-policies", out: '{"PolicyNames":[]}' },
    { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
    { cmd: "aws", match: "^iam list-users", out: '{"Users":[]}' },
  ]);
  const r = w.run("infra/ci/lab-aws-safety-net.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const iam = w.calls().filter((c) => /^aws iam (delete|remove|detach)/.test(c));
  assert.deepEqual(iam, [
    `aws iam remove-role-from-instance-profile --instance-profile-name lab-${ID}-web --role-name lab-${ID}-web`,
    `aws iam delete-instance-profile --instance-profile-name lab-${ID}-web`,
    `aws iam detach-role-policy --role-name lab-${ID}-web --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore`,
    `aws iam delete-role --role-name lab-${ID}-web`,
  ]);
});

test("Verify clean: a tagging-API ghost (terminated) counts clean and writes the outputs", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("instance/i-0dead")) },
    { cmd: "aws", match: "^ec2 describe-instances --instance-ids i-0dead", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0dead","State":{"Name":"terminated"}}]}]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(out, "utf8"), /^clean=true\nleftovers=\[\]$/m);
  assert.equal(w.calls().filter((c) => /^aws \S+ (delete|terminate)/.test(c)).length, 0, "verify never deletes");
});

test("Verify clean: an untagged instance in a lab VPC is a named leftover (A26), and the run is dirty", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(A("vpc/vpc-0a")) },
    { cmd: "aws", match: "^ec2 describe-vpcs --vpc-ids vpc-0a", out: '{"Vpcs":[{"VpcId":"vpc-0a","Tags":[{"Key":"cloudlabs-lab","Value":"soa-03-auto-scaling"},{"Key":"Name","Value":"vpc-lab"}]}]}' },
    { cmd: "aws", match: "^ec2 describe-instances --filters Name=vpc-id,Values=vpc-0a", out: '{"Reservations":[{"Instances":[{"InstanceId":"i-0hand","State":{"Name":"running"},"Tags":[{"Key":"Name","Value":"my-test"}]}]}]}' },
    { cmd: "aws", match: "^ec2 describe-network-interfaces --filters Name=vpc-id,Values=vpc-0a", out: '{"NetworkInterfaces":[]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.ok(left.includes("ec2:vpc vpc-0a (vpc-lab)"), JSON.stringify(left));
  assert.ok(left.includes("untagged inside lab VPC: i-0hand (my-test)"), JSON.stringify(left));
  assert.doesNotMatch(readFileSync(out, "utf8"), /123456789012/);
});

test("Verify clean: a tagged type with no handler yet is a leftover, never clean (P6)", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:lambda:eu-west-2:123456789012:function:lab-x") },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  const r = w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1);
  assert.match(readFileSync(out, "utf8"), /no handler for lambda:function: lab-x/);
});

test("Verify clean: a listing AWS refuses makes the run dirty with a reason", { skip }, () => {
  const w = world([{ cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: "", code: 254, err: "An error occurred (AccessDeniedException)" }, ...EMPTY_IAM]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  assert.match(readFileSync(out, "utf8"), /could not list tagged resources in eu-west-2/);
});

test("Unblock turns off deletion protection, stops the Config recorder, empties the vault, and never fails", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q", "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/alb-a03k3x9q/1", A("instance/i-0d"), "arn:aws:backup:eu-west-2:123456789012:backup-vault:lab-soa-03-auto-scaling-vault") },
    { cmd: "aws", match: "^configservice describe-configuration-recorders", out: `{"ConfigurationRecorders":[{"name":"lab-${ID}-recorder"},{"name":"default"}]}` },
    { cmd: "aws", match: "^backup list-recovery-points-by-backup-vault", out: ['{"RecoveryPoints":[{"RecoveryPointArn":"arn:aws:ec2:eu-west-2::snapshot/snap-1"}]}', '{"RecoveryPoints":[]}'] },
    { cmd: "aws", match: "^rds modify-db-instance", out: "", code: 254, err: "InvalidDBInstanceState" },
  ]);
  const r = w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  for (const re of [/^aws rds modify-db-instance --db-instance-identifier db-a05k3x9q --no-deletion-protection --apply-immediately/, /^aws elbv2 modify-load-balancer-attributes .*Key=deletion_protection\.enabled,Value=false/, /^aws ec2 modify-instance-attribute --instance-id i-0d --no-disable-api-termination/, /^aws ec2 modify-instance-attribute --instance-id i-0d --no-disable-api-stop/, new RegExp(`^aws configservice stop-configuration-recorder --configuration-recorder-name lab-${ID}-recorder`), /^aws backup delete-recovery-point --backup-vault-name lab-soa-03-auto-scaling-vault --recovery-point-arn arn:aws:ec2:eu-west-2::snapshot\/snap-1/]) assert.ok(calls.some((c) => re.test(c)), String(re));
  assert.ok(!calls.some((c) => /stop-configuration-recorder --configuration-recorder-name default/.test(c)), "never another recorder");
  assert.match(r.out, /::warning::/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs`
Expected: FAIL (the scripts do not exist; on a machine without jq every test skips: run it where jq exists, or rely on CI).

- [ ] **Step 3: Write `infra/ci/lab-unblock-aws.sh`** per the Unblock paragraph above (header comment as `lab-unblock.sh`'s).

- [ ] **Step 4: Write `infra/ci/lab-aws-safety-net.sh`** per the tables above: argument parsing (`--verify` first), the id check, candidate discovery, the phase loops, the polling helper, Verify's real-state reads, the VPC scan and the two output lines. Add both scripts to `ID_RE_COPIES` in `scripts/test/labs-lib.test.mjs`.

- [ ] **Step 5: Run the targeted tests**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/labs-lib.test.mjs`
Expected: PASS (or skipped with "needs bash and jq" where jq is missing).

- [ ] **Step 6: Commit**

```bash
git add infra/ci/lab-unblock-aws.sh infra/ci/lab-aws-safety-net.sh scripts/test
git commit -m "feat(aws labs): unblock, tag-based safety net and real-state Verify clean for AWS labs

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 6: Worker: cloud through the engine, dispatch, OIDC, same-cloud peering, A15/A30

Spec: §2 connectivity rule, §6 bullets Engine, Dispatch, Callbacks, Release tests, Catalogue and API (fields only), §9 (A20), §10 modal bullets, rulings A15, A20, A22, A25, A30, P1, P9, P11.

**Files:**
- Modify: `worker/src/labs/net.ts` (`LAB_WORKFLOW` → `LAB_WORKFLOWS`, `labWorkflowOf`; `dispatchLab` and `findLabRun` pick the workflow by lab id)
- Modify: `worker/src/labs/engine.ts` (`headendCloud`, `crossCloudMessage`, `namePrefix(def)`, AWS region rule, `payloadFor` adds `gateway_cidr` for AWS, same-cloud `deployLab`/`peerLab`/`rePeerLabs`, `UNPEER_FOR_SERVER`, `unpeerAwsLabsForServerTeardown`, `disconnectAwsPeerings`; remove `awsHeadend` and `onAws`)
- Modify: `worker/src/labs/refresh.ts:36` (`findLabRun(env, net, run.id, run.lab_id)`)
- Modify: `worker/src/labs/callbacks.ts` (secrets from either workflow, checked against the run's cloud; peer begin same-cloud)
- Modify: `worker/src/oidc.ts` (comment of `claimsProblem`: lab-secrets accepts lab.yml or lab-aws.yml)
- Modify: `worker/src/labs/settle.ts` (`OUTPUT_KEYS` and `LabOutputs` gain `peer_vpc_id`; the deploy settle keeps it in `outputs_json`; an unpeer run whose `reason` is `UNPEER_FOR_SERVER` leaves peering `disconnected`)
- Modify: `worker/src/labs/view.ts` (`estimateSoFar(s, now, wholeGbpH = 0)` uses `sessionEstimateGbp`; callers pass `wholeHoursGbpH(labDef(s.lab_id)?.cost.items ?? [])`)
- Modify: `worker/src/labs/summary.ts:22` (`rePeer` counts only sessions whose lab cloud equals `headendCloud`, or all when it is null)
- Modify: `worker/src/runs.ts` (`startDeploy` with cloud aws calls `disconnectAwsPeerings`; `startDestroy` with cloud aws calls `unpeerAwsLabsForServerTeardown` after taking the gateway lock and before `dispatchWorkflow`)
- Modify: `worker/src/api/labs.ts` (deploy route, region rule, `GET /labs/:id` fields)
- Modify: `worker/test/labs-helpers.ts` (`base()` takes exam and cloud from the id; new `AWS_TEST_LABS` and `withAwsLabs()`)
- Modify: `worker/test/labs-aws-headend.test.ts` (same-cloud wording), `worker/test/labs-peering.test.ts:318-324` (message)
- Test: `worker/test/labs-aws-engine.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `LabCloud`, `cloudOfId`, `NAME_PREFIX_LETTER`, `AWS_LAB_REGIONS`, `awsConsoleUrl`, `wholeHoursGbpH`, `sessionEstimateGbp`, `LabDetail.consoleUrls/connect/secondaryRegion/cloud`; `cloudOf(snap)` from `worker/src/state.ts`; `awsRegionName` from `shared/azureMetrics.ts`; `config(env).aws.region` and `config(env).vnetCidr`.
- Produces:

```ts
// worker/src/labs/net.ts
export const LAB_WORKFLOWS: Readonly<Record<LabCloud, string>>; // { azure: "lab.yml", aws: "lab-aws.yml" }
export const labWorkflowOf: (labId: string) => string;            // LAB_WORKFLOWS[cloudOfId(labId)]
export async function dispatchLab(env: Env, net: Net, action: string, payload: Record<string, unknown> & { lab_id: string }): Promise<void>;
export async function findLabRun(env: Env, net: Net, runId: string, labId: string): Promise<GhLabRun | null>;
// worker/src/labs/engine.ts
export async function headendCloud(env: Env): Promise<LabCloud | null>;        // cloudOf(snap) when snap.state !== "destroyed", else null
export function crossCloudMessage(lab: LabCloud, server: LabCloud): string;
//   aws lab, azure server: "AWS labs connect only to an AWS server (the server is in Azure)."
//   azure lab, aws server: "Azure labs connect only to an Azure server (the server is in AWS)."
export function namePrefix(def: Pick<LabDef, "number" | "cloud">): string;     // l|a + two digits + 5 random [a-z0-9]
export const UNPEER_FOR_SERVER = "server tear-down";
export async function unpeerAwsLabsForServerTeardown(env: Env, by: string): Promise<{ started: string[]; failed: string[] }>;
export async function disconnectAwsPeerings(env: Env): Promise<number>; // AWS sessions with peering 'on' → 'disconnected'; returns how many
// worker/src/labs/callbacks.ts
export async function issueLabSecrets(env: Env, runId: string, ghRunId: number, workflowRef?: string): Promise<CallbackReply>;
//   with workflowRef: 403 { error: "that workflow does not build this lab's cloud" } unless it equals workflowRef(env, labWorkflowOf(run.lab_id))
// worker/src/labs/settle.ts
export interface LabOutputs { private_ips; connect; users; peer_vnet_id: string | null; peer_vpc_id: string | null; clean; leftovers; deploy_seconds; destroy_seconds }
// worker/test/labs-helpers.ts
export const AWS_TEST_LABS: LabDef[]; // soa-03-auto-scaling (cloud aws, peering optional, instance_types [t4g.micro, t4g.micro], cost items exactly:
//   { name: "ALB, hourly", gbp_h: 0.0199, whole_hours: true, aws_price: { service: "AWSELB", unit: "Hrs", filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } } },
//   { name: "EC2 t4g.micro", gbp_h: 0.0071, qty: 2, aws_price: { service: "AmazonEC2", unit: "Hrs", filters: { instanceType: "t4g.micro", operatingSystem: "Linux", tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used" } } }),
// soa-05-rds (peering optional, regions.secondary null, base cost), saa-16-dr-pilot-light (peering optional, regions.secondary eu-west-1, base cost); each with exam/exams/skill_areas of its own exam
export function withAwsLabs(): void;  // setCatalogueForTest({ ...TEST_CATALOGUE, labs: [...TEST_LABS, ...AWS_TEST_LABS], skillAreas: [...TEST_CATALOGUE.skillAreas, the SOA/SAA areas they name] })
```

Behaviour (spec §2, §6):
- `deployLab`: `region` is `cfg.aws.region` for an AWS lab; an `input.region` other than it is `RunError("AWS labs run in London (eu-west-2).", "bad_input")`. A release test of a lab that peers, or a lab whose peering is required, is refused when `headendCloud` is a different cloud: `RunError(`${crossCloudMessage(def.cloud, hc)} ${test ? `The release test of ${def.title} peers it, so it cannot run now` : `${def.title} needs its peering, so it cannot deploy now`}.`)`. With a different-cloud server a deploy that asked to peer runs with peering `off`. `name_prefix` is `namePrefix(def)`.
- `payloadFor` adds `gateway_cidr: config(env).vnetCidr` only when `cloudOfId(s.lab_id) === "aws"` (P1). Azure payloads are byte-identical to today.
- `peerLab`: refused with `crossCloudMessage(...) + " It keeps running unconnected."` when the server is up in the other cloud. `rePeerLabs`: refuses (as today) when no server runs; otherwise starts a peer run for each waiting/disconnected session of the server's cloud and puts each other-cloud session in `failed` as `"<title>: <crossCloudMessage>"`.
- `handleLabPeer` begin: after the running/standby check, `go: false` with `reason: crossCloudMessage(cloudOfId(run.lab_id), cloudOf(snap))` when they differ (session peering `waiting`); `dns_link` is always false for AWS labs.
- `handleLabSecrets`: `verifyGithubOidc(env, token, [LAB_WORKFLOWS.azure, LAB_WORKFLOWS.aws])`, then `issueLabSecrets(env, run_id, Number(claims.run_id), claims.workflow_ref)`.
- `unpeerAwsLabsForServerTeardown`: for each live AWS session (`state = 'running'`) with peering `on`, `startLabRun(env, s.id, "unpeer", by, UNPEER_FOR_SERVER)` then peering `disconnected`; a refusal (the lab's lock is held: a destroy is already removing its peering) goes in `failed` and is noted with `db.addAlert(env, "info", ...)`; never throws. When the unpeer run settles with `run.reason === UNPEER_FOR_SERVER` the session's peering stays `disconnected`.
- `GET /labs/:id`: `defaults.region` is `cfg.aws.region` for AWS; `secondaryRegion: def.regions.secondary`; `consoleUrls` (live AWS session only) `[{ region: "eu-west-2", label: "London", url: awsConsoleUrl(id, "eu-west-2") }, ...(secondary ? [{ region: "eu-west-1", label: "Ireland", url: awsConsoleUrl(id, "eu-west-1") }] : [])]`; `portalUrl` null for AWS; `connect`: `{ possible: false, note: crossCloudMessage(def.cloud, hc) + " This lab runs unconnected." }` when `hc` is a different cloud, else `{ possible: def.connectivity.peering !== "off", note: null }`; `gatewayUp` is true only when the server is running or in Standby in the lab's cloud.
- `POST /labs/:id/deploy`: `peer: b.peer && (hc === null || hc === def.cloud)`; the message adds `" " + crossCloudMessage(def.cloud, hc) + " This lab runs unconnected."` when the peer tick was dropped.

- [ ] **Step 1: Write the failing test** `worker/test/labs-aws-engine.test.ts`

```ts
// labs-aws-engine.test.ts
//
// Plain English: AWS labs through the lab engine (AWS labs spec §2, §6):
// the right workflow, region, name prefix and gateway range in the payload;
// secrets only to the workflow of the lab's cloud; the same-cloud peering
// rule in every mix of lab and server; and an AWS server tear-down that
// unpeers the AWS labs first (ruling A30) and leaves them ready to Re-peer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { saveSnapshot, getSnapshot } from "../src/state";
import { claimsProblem } from "../src/oidc";
import { issueLabSecrets, handleLabPeer } from "../src/labs/callbacks";
import { estimateSoFar } from "../src/labs/view";
import { finishRun } from "../src/labs/settle";
import { getLabRun } from "../src/labs/store";
import { startDestroy, startDeploy } from "../src/runs";
import { UNPEER_FOR_SERVER } from "../src/labs/engine";
import { runLabWatch } from "../src/labs/watch";
import { api, deployLab, freeze, labDispatches, labEnv, runningLab, withAwsLabs, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const server = (env: Env, cloud: "azure" | "aws", state: "running" | "destroyed" = "running") => saveSnapshot(env, { state, running_since: NOW, cloud });

describe("dispatch by cloud", () => {
  it("an AWS lab dispatches lab-aws.yml with London, an a<NN> prefix and the gateway range; an Azure payload is unchanged", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await deployLab(env, "soa-03-auto-scaling");
    await deployLab(env, "az104-05-storage");
    const [aws, az] = labDispatches(world);
    expect(aws.workflow).toBe("lab-aws.yml");
    expect(aws.payload).toMatchObject({ lab_id: "soa-03-auto-scaling", region: "eu-west-2", gateway_cidr: "10.50.0.0/16" });
    expect(aws.payload.name_prefix).toMatch(/^a03[a-z0-9]{5}$/);
    expect(az.workflow).toBe("lab.yml");
    expect("gateway_cidr" in az.payload).toBe(false);
    expect(az.payload.name_prefix).toMatch(/^l05[a-z0-9]{5}$/);
  });

  it("an AWS lab refuses another region", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    const r = await api(env, "POST", "/labs/soa-03-auto-scaling/deploy", { hours: 1, peer: false, region: "eu-west-1" });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("AWS labs run in London (eu-west-2).");
  });

  it("cancelling an AWS deploy looks for its run among lab-aws.yml's runs", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await deployLab(env, "soa-03-auto-scaling");
    await api(env, "POST", "/labs/soa-03-auto-scaling/cancel");
    expect(world.calls.some((c) => c.path.includes("/actions/workflows/lab-aws.yml/runs"))).toBe(true);
    expect(world.calls.some((c) => c.path.includes("/actions/workflows/lab.yml/runs"))).toBe(false);
  });
});

describe("secrets go only to the workflow of the lab's cloud", () => {
  it("lab-secrets accepts either lab workflow's token, never wg.yml's", () => {
    const env = { GITHUB_REPO: "o/r" } as Env;
    const c = (wf: string) => ({ repository: "o/r", ref: "refs/heads/main", workflow_ref: `o/r/.github/workflows/${wf}@refs/heads/main`, event_name: "workflow_dispatch", run_id: "1" });
    expect(claimsProblem(env, c("lab-aws.yml"), ["lab.yml", "lab-aws.yml"])).toBeNull();
    expect(claimsProblem(env, c("lab.yml"), ["lab.yml", "lab-aws.yml"])).toBeNull();
    expect(claimsProblem(env, c("wg-aws.yml"), ["lab.yml", "lab-aws.yml"])).toMatch(/wrong workflow/);
  });

  it("an AWS run's secrets are refused to a lab.yml token, and handed to a lab-aws.yml one", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { run } = await deployLab(env, "soa-03-auto-scaling");
    world.ghRuns = [{ id: 77, display_title: `lab deploy soa-03-auto-scaling ${run.id}`, html_url: "https://github.com/o/r/actions/runs/77", status: "in_progress", conclusion: null, created_at: NOW }];
    const wrong = await issueLabSecrets(env, run.id, 77, `${env.GITHUB_REPO}/.github/workflows/lab.yml@refs/heads/main`);
    expect(wrong).toEqual({ status: 403, body: { error: "that workflow does not build this lab's cloud" } });
    const right = await issueLabSecrets(env, run.id, 77, `${env.GITHUB_REPO}/.github/workflows/lab-aws.yml@refs/heads/main`);
    expect(right.status).toBe(200);
  });
});

// [lab, server cloud or null for none, deploy-with-peer's session peering, message pattern or null]
const MIX: [string, "azure" | "aws" | null, "waiting" | "off", RegExp | null][] = [
  ["soa-03-auto-scaling", "aws", "waiting", null],
  ["soa-03-auto-scaling", "azure", "off", /AWS labs connect only to an AWS server \(the server is in Azure\)\. This lab runs unconnected\./],
  ["az104-07-files", "aws", "off", /Azure labs connect only to an Azure server \(the server is in AWS\)\. This lab runs unconnected\./],
  ["az104-07-files", "azure", "waiting", null],
  ["soa-03-auto-scaling", null, "waiting", null],
];
describe("same-cloud peering (spec §2, decision 5)", () => {
  for (const [lab, cloud, peering, re] of MIX) {
    it(`${lab} with ${cloud ?? "no"} server: deploy with Peer → ${peering}`, async () => {
      freeze();
      const { env } = await labEnv();
      withAwsLabs();
      if (cloud) await server(env, cloud);
      const r = await api(env, "POST", `/labs/${lab}/deploy`, { hours: 1, peer: true });
      expect(r.status).toBe(200);
      if (re) expect(r.json.message).toMatch(re);
      const s = await env.DB.prepare("SELECT peering FROM lab_sessions WHERE lab_id = ?1").bind(lab).first<{ peering: string }>();
      expect(s?.peering).toBe(peering);
    });
  }

  it("Peer and a release test refuse across clouds with the sentence; the same cloud goes ahead", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    await server(env, "azure");
    const p = await api(env, "POST", "/labs/soa-03-auto-scaling/peer");
    expect(p.status).toBe(409);
    expect(p.json.error.message).toBe("AWS labs connect only to an AWS server (the server is in Azure). It keeps running unconnected.");
    const t = await api(env, "POST", "/labs/soa-05-rds/test");
    expect(t.status).toBe(409);
    expect(t.json.error.message).toMatch(/^AWS labs connect only to an AWS server \(the server is in Azure\)\. The release test of .* peers it, so it cannot run now\.$/);
    await server(env, "aws");
    expect((await api(env, "POST", "/labs/soa-03-auto-scaling/peer")).status).toBe(200);
  });

  it("peer begin says go only when the running server is in the lab's cloud, and never links DNS for AWS", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { run, token } = await runningLab(env, world, "soa-03-auto-scaling", { peerRun: true });
    await server(env, "azure");
    const no = await handleLabPeer(env, token, { run_id: run.id, phase: "begin" });
    expect(no.body).toEqual({ go: false, reason: "AWS labs connect only to an AWS server (the server is in Azure)." });
    await server(env, "aws");
    const yes = await handleLabPeer(env, token, { run_id: run.id, phase: "begin" });
    expect(yes.body).toEqual({ go: true, dns_link: false });
  });

  it("Re-peer acts on the running server's cloud only and names the others", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const z = await runningLab(env, world, "az104-07-files");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'disconnected' WHERE id IN (?1, ?2)").bind(a.sid, z.sid).run();
    await server(env, "aws");
    const before = labDispatches(world).length;
    const r = await api(env, "POST", "/labs/repeer");
    expect(r.status).toBe(200);
    const sent = labDispatches(world).slice(before);
    expect(sent.map((d) => [d.workflow, d.action, d.payload.lab_id])).toEqual([["lab-aws.yml", "peer", "soa-03-auto-scaling"]]);
    expect(r.json.message).toMatch(/Azure labs connect only to an Azure server \(the server is in AWS\)/);
  });
});

describe("the AWS server's tear-down (A30) and apply (A15)", () => {
  it("an AWS server destroy dispatches an unpeer per peered AWS lab before wg-aws.yml, and leaves them disconnected", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    const b = await runningLab(env, world, "soa-05-rds");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await server(env, "aws");
    const before = world.dispatches.length;
    await startDestroy(env, "steven", "dashboard");
    const sent = world.dispatches.slice(before).map((d) => [d.workflow, d.action, (d.payload as { lab_id?: string }).lab_id ?? null]);
    expect(sent).toEqual([["lab-aws.yml", "unpeer", "soa-03-auto-scaling"], ["wg-aws.yml", "destroy", null]]);
    const peering = async (sid: string) => (await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(sid).first<{ peering: string }>())?.peering;
    expect(await peering(a.sid)).toBe("disconnected");
    expect(await peering(b.sid)).toBe("off");
    const unpeer = (await env.DB.prepare("SELECT id FROM lab_runs WHERE session_id = ?1 AND action = 'unpeer'").bind(a.sid).first<{ id: string }>())!;
    const run = (await getLabRun(env, unpeer.id))!;
    expect(run.reason).toBe(UNPEER_FOR_SERVER);
    await finishRun(env, run, { ok: true, via: "callback" });
    expect(await peering(a.sid)).toBe("disconnected");
  });

  it("an Azure server destroy starts no lab run", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await server(env, "azure");
    const before = world.dispatches.length;
    await startDestroy(env, "steven", "dashboard");
    expect(world.dispatches.slice(before).map((d) => d.workflow)).toEqual(["wg.yml"]);
  });

  it("at 100% of the budget the guard tears an AWS lab down through lab-aws.yml and never touches the server", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    await server(env, "aws");
    await env.DB.prepare("INSERT INTO lab_cost_days (day, rg, lab_id, gbp, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(NOW.slice(0, 10), "aws:soa-03-auto-scaling", "soa-03-auto-scaling", 1000, NOW).run();
    const before = world.dispatches.length;
    await runLabWatch(env, new Date(NOW));
    expect(world.dispatches.slice(before).map((d) => [d.workflow, d.action])).toEqual([["lab-aws.yml", "destroy"]]);
  });

  it("an AWS server apply marks AWS-peered labs disconnected (A15)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const a = await runningLab(env, world, "soa-03-auto-scaling");
    await env.DB.prepare("UPDATE lab_sessions SET peering = 'on' WHERE id = ?1").bind(a.sid).run();
    await server(env, "aws", "destroyed");
    await startDeploy(env, { hours: 1, requesterIp: null, requestedBy: "steven", cloud: "aws" });
    expect((await env.DB.prepare("SELECT peering FROM lab_sessions WHERE id = ?1").bind(a.sid).first<{ peering: string }>())?.peering).toBe("disconnected");
    expect((await getSnapshot(env)).cloud).toBe("aws");
  });
});

describe("what the screens get", () => {
  it("a session's estimate counts the ALB's started hour whole (A20)", () => {
    const s = { est_gbp_h: 0.0341, requested_at: "2026-10-15T09:00:00.000Z", ended_at: "2026-10-15T09:30:00.000Z", est_gbp: null };
    expect(estimateSoFar(s, 0, 0.0199)).toBeCloseTo(0.0341 * 0.5 + 0.0199 * 0.5, 6);
  });

  it("GET /labs/:id for an AWS lab: cloud, London, console links per region while live, and the connect note", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "saa-16-dr-pilot-light");
    await server(env, "azure");
    const r = await api(env, "GET", "/labs/saa-16-dr-pilot-light");
    expect(r.json).toMatchObject({
      cloud: "aws",
      secondaryRegion: "eu-west-1",
      portalUrl: null,
      defaults: { region: "eu-west-2" },
      gatewayUp: false,
      connect: { possible: false, note: "AWS labs connect only to an AWS server (the server is in Azure). This lab runs unconnected." },
      consoleUrls: [
        { region: "eu-west-2", label: "London", url: "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-saa-16-dr-pilot-light?region=eu-west-2" },
        { region: "eu-west-1", label: "Ireland", url: "https://eu-west-1.console.aws.amazon.com/resource-groups/group/lab-saa-16-dr-pilot-light?region=eu-west-1" },
      ],
    });
    expect(r.json.card.cloud).toBe("aws");
  });

  it("the result callback keeps an AWS lab's peer_vpc_id", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const { sid } = await runningLab(env, world, "soa-03-auto-scaling", { outputs: { private_ips: { "vm-web": "10.64.64.10" }, connect: [], users: {}, peer_vpc_id: "vpc-0abc" } });
    const s = await env.DB.prepare("SELECT outputs_json FROM lab_sessions WHERE id = ?1").bind(sid).first<{ outputs_json: string }>();
    expect(JSON.parse(s!.outputs_json).peer_vpc_id).toBe("vpc-0abc");
  });
});
```

(`runningLab(env, world, id, opts?)` already deploys, collects secrets and reports a successful deploy; extend it with `opts.outputs` passed to the result callback and `opts.peerRun` that starts a peer run and returns `{ run, token }` for it, plus `world.ghRuns` support for `issueLabSecrets` if `labs-helpers.ts` does not already stub GitHub's run lookup; `labEnv()` sets the Worker's AWS keys the way `worker/test/deploy-cloud.test.ts` does, so `startDeploy(..., cloud: "aws")` is allowed. Read `labs-helpers.ts`, `harness.ts` and `deploy-cloud.test.ts` first and reuse what exists.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run worker/test/labs-aws-engine.test.ts`
Expected: FAIL (`withAwsLabs`, `UNPEER_FOR_SERVER`, `lab-aws.yml` dispatch do not exist).

- [ ] **Step 3: Implement** the Files list in this order: `labs-helpers.ts`; `net.ts` and its callers (`engine.ts` `cancelRun`, `refresh.ts`, `callbacks.ts` imports); `engine.ts`; `settle.ts`; `callbacks.ts`; `view.ts` and its callers (grep `estimateSoFar(`); `summary.ts`; `runs.ts`; `api/labs.ts`. Header comments of each changed file get one sentence on the cloud. Update `labs-aws-headend.test.ts`: its header comment describes the same-cloud rule; `NAMES_AWS` becomes `/Azure labs connect only to an Azure server \(the server is in AWS\)/`; and `labs-peering.test.ts:324` expects `/Azure labs connect only to an Azure server \(the server is in AWS\)\. This lab runs unconnected\./`.

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run worker/test/labs-aws-engine.test.ts worker/test/labs-aws-headend.test.ts worker/test/labs-peering.test.ts worker/test/labs-callbacks.test.ts worker/test/labs-oidc.test.ts worker/test/labs-sessions.test.ts worker/test/labs-watch.test.ts worker/test/labs-read.test.ts worker/test/deploy-cloud.test.ts` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker
git commit -m "feat(aws labs): the engine dispatches lab-aws.yml, peers within one cloud, unpeers AWS labs before an AWS server tear-down

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 7: Worker: AWS reads (orphans, cost, prices feed, capacity, permissions, resources)

Spec: §6 bullets Orphans, Cost, Prices, Budget, Capacity, Permissions check, Catalogue and API (resources), Worker IAM user (what the reads need); §8.4; §9; rulings A16, A17, A20, P7, P14.

**Files:**
- Create: `shared/sha256.ts` (a small synchronous SHA-256 of a UTF-8 string → hex; no dependency)
- Modify: `shared/labs.ts` (`canonicalAwsPrice`, `awsPriceKey`)
- Modify: `worker/src/cloud/awsApi.ts` (`ec2(env, action, params, region?)`, `ec2Pages(env, action, params, maxPages, region?)`, `awsQuery(env, service, action, params, version, at?: { region?: string; host?: string })`; defaults keep today's behaviour)
- Create: `worker/src/labs/awsReads.ts` (every AWS read the lab engine makes, each taking one call from the `Net` first)
- Modify: `worker/src/labs/orphans.ts` (`sweepAwsOrphans`; both sweeps keep the other cloud's KV entries and release only their own cloud's slots)
- Modify: `worker/src/labs/cost.ts` (`fetchAwsLabCostDays`)
- Modify: `worker/src/labs/watch.ts:203-204` (steps `aws orphans` and `aws lab costs` after the Azure ones)
- Create: `worker/src/insights/aws/feeds/labPrices.ts`; Modify: `worker/src/insights/aws/types.ts` (`AwsFeedId`, `AWS_FEED_IDS`, `AWS_STANDS_IN`, `AWS_SOURCES`, `AwsFeedCtx.ec2(action, params?, region?)`), `worker/src/insights/aws/ctx.ts` (the region argument), `worker/src/insights/aws/feeds/index.ts` (labPrices after prices), `worker/src/insights/aws/feeds/prices.ts` (export `products`)
- Modify: `worker/src/insights/aws/feeds/capacity.ts` (sizes from the catalogue, both lab regions, `calls: 8`)
- Modify: `worker/src/labs/prices.ts` (AWS items priced from `aws_prices`, source `"aws"`; `readLabPrices` also returns the `lab:` rows of `aws_prices`)
- Modify: `worker/src/labs/warnings.ts` (`capacityWarning` for AWS labs; `capacityProblems(doc, sizes, gateway, region, words?)`)
- Modify: `worker/src/labs/permissions.ts`, `worker/src/labs/availability.ts` (AWS ticks; the `aws_setup` blocker)
- Modify: `worker/src/labs/resources.ts` (`labResources(env, def)` reads tags for an AWS lab), and its caller in `worker/src/api/labs.ts`
- Modify: `worker/test/harness.ts` (`world.labAws` and the fake answers listed below)
- Test: `worker/test/labs-aws-reads.test.ts` (create), `worker/test/labs-shared.test.ts` (`awsPriceKey`)

**Interfaces:**
- Consumes: Task 1's constants and `LabPermissions`/`LabBlockerKind`/`LabCostLine`; Task 6's `headendCloud`, `withAwsLabs()`, `AWS_TEST_LABS`; `canAws`, `config(env).aws.usdToGbp`; `readAwsCapacity`, `readAwsPrices`, `storeAwsPrices`, `awsRegionName`, `labIdOf`, `budgetedNet`, `BudgetExceeded`.
- Produces:

```ts
// shared/sha256.ts
export function sha256Hex(text: string): string;
// shared/labs.ts
export function canonicalAwsPrice(ref: AwsPriceRef): string; // JSON.stringify({ service, unit, gb: ref.gb ?? null, filters: entries sorted by key })
export function awsPriceKey(ref: AwsPriceRef): string;       // "lab:" + sha256Hex(canonicalAwsPrice(ref)).slice(0, 16)
// worker/src/labs/awsReads.ts (each read: net.take(1), then the call; errors as AwsError)
export interface TaggedArn { arn: string; tags: Record<string, string> }
export async function labTagged(env: Env, net: Net, region: string, labId?: string): Promise<TaggedArn[]>; // GetResources, TagFilters [{ Key: "cloudlabs-lab", Values?: [labId] }], one page of 100
export async function iamLabNames(env: Env, net: Net, what: "roles" | "instance-profiles" | "policies" | "users"): Promise<string[]>; // PathPrefix=/cloudlabs-lab/ (policies Scope=Local)
export async function configRecorderNames(env: Env, net: Net, region: string): Promise<string[]>;
export async function dashboardNames(env: Env, net: Net, region: string): Promise<string[]>; // DashboardNamePrefix=lab-
export async function awsAccountId(env: Env, net: Net): Promise<string>;                  // STS GetCallerIdentity
export async function iamRoleExists(env: Env, net: Net, name: string): Promise<boolean>;  // false on NoSuchEntity
export async function iamPolicyExists(env: Env, net: Net, arn: string): Promise<boolean>;
export async function costTagStatus(env: Env, net: Net, key: string): Promise<"Active" | "Inactive" | null>;
export async function costByLabTag(env: Env, net: Net, start: string, end: string): Promise<{ day: string; lab: string; usd: number }[]>;
// worker/src/labs/orphans.ts
export const AWS_SWEEP_CALLS = 12;
export const AWS_ORPHAN_GRACE_MS = 90 * 60_000;
export async function sweepAwsOrphans(env: Env, net: Net, now: Date): Promise<string | null>; // null when not due or !canAws
// worker/src/labs/cost.ts
export async function fetchAwsLabCostDays(env: Env, net: Net, now: Date): Promise<string | null>;
// worker/src/insights/aws/feeds/labPrices.ts
export interface AwsPriceAskRow { item: string; region: string; ref: AwsPriceRef }
export function labPriceAsks(labs: readonly LabDef[], sessionRegion: string): AwsPriceAskRow[]; // one per distinct (item, region)
export function labPriceBody(ref: AwsPriceRef, region: string): { ServiceCode: string; FormatVersion: "aws_v1"; MaxResults: number; Filters: { Type: "TERM_MATCH"; Field: string; Value: string }[] };
export const LAB_PRICE_REFRESH_MS = 3 * 86_400_000;
export default labPrices: AwsFeed; // id "aws.labPrices", title "Lab list prices", cadenceMin 60, when "always", calls 5
// worker/src/labs/prices.ts
export function awsListPrice(item: LabCostItem, rows: PriceRow[], region: string, now: Date, secondaryRegion: string | null): { gbpH: number; age: number } | null;
```

Behaviour:
- **AWS orphan sweep (§6, §8.4, A16, P7):** runs when `canAws(env)` and an hour has passed since KV `labs:sweep-aws`'s `at`; needs `AWS_SWEEP_CALLS` left on the `Net` or throws `BudgetExceeded` before any call. 12 calls: `labTagged` in eu-west-2, eu-west-1, us-east-1, us-west-2; `iamLabNames` × 4; `configRecorderNames` and `dashboardNames` in eu-west-2 and eu-west-1. The lab of a tagged item is its `cloudlabs-lab` tag value (kept only when it passes `LAB_ID_RE` and `cloudOfId` is aws); of a name, `labIdOf(name)`. Names shown: tagged items as `<service:type> <resource id>`, IAM as `iam role <name>` (and `instance profile`, `policy`, `user`), Config as `config recorder <name>`, dashboards as `dashboard <name>`. An item counts after 90 minutes unseen by a live session of its lab (first-seen times kept in `labs:sweep-aws`). Notes, KV `labs:orphans` and dirty-slot release as the Azure sweep, but: each sweep writes `labs:orphans` as (the other cloud's existing entries) + (its own fresh list), and releases only its own cloud's `ended_dirty` slots. The Azure `sweepOrphans` gets the same two changes.
- **Cost (A17):** `fetchAwsLabCostDays` once a day (KV `labs:cost_day_aws`), `canAws` only: one `GetCostAndUsage` (DAILY, UnblendedCost, `GroupBy: [{ Type: "TAG", Key: "cloudlabs-lab" }]`, the Azure pull's time frame via `costTimeframe(now)`); each group key `cloudlabs-lab$<id>` with a charge and an AWS id becomes a `lab_cost_days` row `(day, rg = "aws:<id>", lab_id = <id>, gbp = usd × config(env).aws.usdToGbp)` (upsert as the Azure pull does); the key `cloudlabs-lab$` (untagged spend) is skipped.
- **Price feed (§6 Prices):** `labPriceAsks` lists each distinct `aws_price` of every AWS lab in the catalogue, at the session region (`config.aws.region`) or, for `region: "secondary"` items, the lab's secondary region. A run reads `aws_prices` rows whose item starts `lab:`, takes the asks whose row is missing or older than `LAB_PRICE_REFRESH_MS` (missing first, then oldest), at most 5, and for each calls `GetProducts` with `labPriceBody(ref, region)`: TERM_MATCH filters for each `ref.filters` entry (a `usagetype` value's `{usage}` replaced by `awsUsagePrefix(region)`) plus `regionCode = region`, `MaxResults: 100`. Exactly one product with an OnDemand USD price in `ref.unit` stores `(region, item, gbp = max OnDemand USD × usdToGbp, unit = ref.unit, meter = the product's usagetype)`; none or several store nothing and the feed ends `error` naming each ask (`<item> in <region>: 0 products` / `: 2 products`).
- **Pricing (§6, §9):** for an AWS lab the region is `AWS_LAB_REGIONS[0]`; an item with `aws_price` uses the `aws_prices` row `awsPriceKey(ref)` at that region (or the lab's secondary for `region: "secondary"`) with `unit === ref.unit`, under 7 days old (`PRICE_STALE_MS`): `Hrs` is per hour, `GB-Mo` is `gbp × gb ÷ 730`; else the authored `gbp_h`. `pricedItems` gives such lines `source: "aws"`. `readLabPrices(env, region)` also returns `readAwsPrices(env.DB)` rows whose item starts `lab:`.
- **Capacity (§6, P14):** the `aws.capacity` feed reads `[...new Set([...awsCapacitySizes(cfg), ...every AWS catalogue lab's instance_types])]` in `config.aws.region` and `eu-west-1` (4 calls each, `calls: 8`), storing one `aws_capacity` row per region. An AWS lab's capacity warning reads `eu-west-2`'s reading; the lab's sizes are its `instance_types` plus the `instance_types` of every live AWS session requested after the reading's `fetchedAt`; the gateway list is `[cfg.aws.instanceType]` when no AWS headend instance exists (the snapshot is not AWS, or is destroyed, failed or deploying); words use `awsRegionName(region)` and the family word "On-Demand Standard": `May not be available: Needs 8 On-Demand Standard vCPUs (8 for this lab's t4g.micro); 30 of 32 used in London.` (`capacityProblems`' optional `words: { place: string; family: (f: string) => string }` replaces `azureRegionName` and `familyWords`).
- **Permissions (§6):** with `canAws(env)`, `checkLabPermissions` also makes 4 calls: `awsAccountId`, `iamRoleExists("wg-admin-labs")`, `iamPolicyExists("arn:aws:iam::<acct>:policy/wg-admin-lab-boundary")`, `costTagStatus("cloudlabs-lab")`; `awsRole`/`awsBoundary` are those answers, `awsCostTag` is `status === "Active"`; failures add `AWS: the wg-admin-labs role does not exist yet: run node scripts/aws-bootstrap.mjs --labs.` and/or `AWS: the wg-admin-lab-boundary policy does not exist yet: run node scripts/aws-bootstrap.mjs --labs.`, and an inactive tag adds `AWS: the cloudlabs-lab cost tag is not active yet, so AWS lab actuals show as estimates.`; without AWS keys the three are `false`, `false`, `null` with `AWS is not connected: the Worker has no AWS keys.`. The Azure part runs only with `canAzure` (today's early return applies to it alone). `blockersOf` for an AWS lab: github, then `{ kind: "aws_setup", message: "AWS labs are not set up yet: run the AWS bootstrap, then Check permissions." }` unless `awsRole === true && awsBoundary === true`, then slots and max_running; no role or graph blockers.
- **Resources (§6):** `labResources(env, def)` for an AWS lab: `labTagged` in eu-west-2 (and the secondary region) for the lab id via `directNet()`: `{ name: tags.Name ?? <resource id>, type: "<service>:<type>", group: "lab-<id> (London)" | "lab-<id> (Ireland)", state: null }`, at most 200; null when `!canAws` or AWS refuses.

Harness (`worker/test/harness.ts`): `world.labAws = { tagged: Record<string, TaggedArn[]>, iam: { roles: string[]; instanceProfiles: string[]; policies: string[]; users: string[] }, recorders: Record<string, string[]>, dashboards: Record<string, string[]>, costByTag: { day: string; lab: string; usd: number }[], costTags: { key: string; status: "Active" | "Inactive" }[], role: boolean, boundary: boolean, products: (body: { ServiceCode: string; Filters: { Field: string; Value: string }[] }) => unknown[] }` with every list empty, both booleans false and `products` returning `[]` by default; `world.calls` records `{ method, host, path, target?, action?, body? }` for these hosts: `tagging.<r>.amazonaws.com` (a `TagFilters` key of `cloudlabs-lab` answers from `labAws.tagged[r]`, filtered by `Values` when given; key `wg-admin` keeps today's answer), `iam.amazonaws.com` (`ListRoles`, `ListInstanceProfiles`, `ListPolicies`, `ListUsers`, `GetRole`, `GetPolicy` by the form's `Action`, XML), `sts.amazonaws.com` (`GetCallerIdentity` → `<Account>123456789012</Account>`), `config.<r>.amazonaws.com` (`StarlingDoveService.DescribeConfigurationRecorders`), `monitoring.<r>.amazonaws.com` (`ListDashboards`, XML), `ce.us-east-1.amazonaws.com` (`GetCostAndUsage` with `GroupBy` answers groups from `costByTag`; `ListCostAllocationTags` from `costTags`), `api.pricing.us-east-1.amazonaws.com` (`GetProducts` → `{ PriceList: products(body).map((p) => JSON.stringify(p)) }`).

- [ ] **Step 1: Write the failing test** `worker/test/labs-aws-reads.test.ts`

```ts
// labs-aws-reads.test.ts
//
// Plain English: what the Worker reads from AWS for AWS labs (AWS labs spec
// §6): the hourly orphan sweep with its 90-minute grace and its own share of
// the leftovers list, the daily cost by lab tag, the lab price feed, AWS
// list prices in the estimate, the capacity warning, the permission ticks
// and the running lab's resources. Pretend AWS answers from world.labAws.

import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { sweepAwsOrphans, sweepOrphans, readOrphans, AWS_SWEEP_CALLS } from "../src/labs/orphans";
import { fetchAwsLabCostDays } from "../src/labs/cost";
import { budgetedNet, directNet, BudgetExceeded } from "../src/labs/net";
import { checkLabPermissions } from "../src/labs/permissions";
import { awsListPrice, pricedItems } from "../src/labs/prices";
import { capacityProblems } from "../src/labs/warnings";
import labPrices, { labPriceAsks, labPriceBody } from "../src/insights/aws/feeds/labPrices";
import { makeAwsCtx } from "../src/insights/aws/ctx";
import { makeBudget } from "../src/insights/types";
import { config } from "../src/env";
import { getSnapshot } from "../src/state";
import { awsPriceKey } from "../../shared/labs";
import { api, freeze, labEnv, runningLab, withAwsLabs, AWS_TEST_LABS, NOW } from "./labs-helpers";

afterEach(() => {
  setCatalogueForTest(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ARN = (r: string, region = "eu-west-2") => `arn:aws:ec2:${region}:123456789012:${r}`;
const tagged = (lab: string, r: string, name?: string) => ({ arn: ARN(r), tags: { "cloudlabs-lab": lab, ...(name ? { Name: name } : {}) } });

describe("the AWS orphan sweep", () => {
  it("makes 12 calls, waits 90 minutes, skips live labs and names what it found", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    world.labAws.tagged["eu-west-2"] = [tagged("soa-03-auto-scaling", "vpc/vpc-0live"), tagged("soa-05-rds", "instance/i-0left", "vm-client")];
    world.labAws.iam.roles = ["lab-soa-05-rds-x", "wg-admin-labs"];
    world.labAws.dashboards["eu-west-2"] = ["lab-soa-05-rds-overview"];
    const t0 = new Date(NOW);
    const before = world.calls.length;
    expect(await sweepAwsOrphans(env, budgetedNet(20), t0)).toMatch(/aws orphans: 0 lab/);
    expect(world.calls.length - before).toBe(AWS_SWEEP_CALLS);
    const later = new Date(t0.getTime() + 91 * 60_000);
    expect(await sweepAwsOrphans(env, budgetedNet(20), later)).toMatch(/aws orphans: 1 lab/);
    const o = await readOrphans(env);
    expect(o).toEqual([{ labId: "soa-05-rds", names: ["dashboard lab-soa-05-rds-overview", "ec2:instance i-0left", "iam role lab-soa-05-rds-x"].sort(), since: t0.toISOString() }]);
  });

  it("with fewer than 12 calls left it waits, records nothing, and stays due", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    await expect(sweepAwsOrphans(env, budgetedNet(11), new Date(NOW))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(await env.STATUS.get("labs:sweep-aws")).toBeNull();
  });

  it("the AWS sweep keeps Azure entries and the Azure sweep keeps AWS entries", async () => {
    freeze();
    const { env } = await labEnv();
    withAwsLabs();
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "az104-07-files", names: ["rg-lab-az104-07-files"], since: NOW }, { labId: "soa-05-rds", names: ["ec2:vpc vpc-0x"], since: NOW }]));
    await sweepAwsOrphans(env, budgetedNet(20), new Date(NOW));
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["az104-07-files"]);
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: "soa-05-rds", names: ["ec2:vpc vpc-0x"], since: NOW }]));
    await sweepOrphans(env, budgetedNet(20), new Date(NOW));
    expect((await readOrphans(env)).map((o) => o.labId)).toEqual(["soa-05-rds"]);
  });
});

describe("AWS lab costs by tag (A17)", () => {
  it("keeps charged rows as aws:<id> in pounds, skips untagged spend, and asks once a day", async () => {
    freeze();
    const { env, world } = await labEnv();
    world.labAws.costByTag = [{ day: "2026-10-14", lab: "soa-03-auto-scaling", usd: 2 }, { day: "2026-10-14", lab: "", usd: 3 }];
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBe("aws lab costs: 1 row(s)");
    const rows = (await env.DB.prepare("SELECT day, rg, lab_id, gbp FROM lab_cost_days").all()).results;
    expect(rows).toEqual([{ day: "2026-10-14", rg: "aws:soa-03-auto-scaling", lab_id: "soa-03-auto-scaling", gbp: 1.5 }]);
    expect(await fetchAwsLabCostDays(env, budgetedNet(20), new Date(NOW))).toBeNull();
  });
});

describe("the lab price feed and AWS list prices", () => {
  const ALB = AWS_TEST_LABS[0].cost.items.find((i) => i.name === "ALB, hourly")!; // aws_price AWSELB, usagetype {usage}-LoadBalancerUsage
  it("fills {usage} per region and adds the region code", () => {
    const body = labPriceBody(ALB.aws_price!, "eu-west-1");
    expect(body.Filters).toContainEqual({ Type: "TERM_MATCH", Field: "usagetype", Value: "EU-LoadBalancerUsage" });
    expect(body.Filters).toContainEqual({ Type: "TERM_MATCH", Field: "regionCode", Value: "eu-west-1" });
    expect(labPriceBody(ALB.aws_price!, "eu-west-2").Filters).toContainEqual({ Type: "TERM_MATCH", Field: "usagetype", Value: "EUW2-LoadBalancerUsage" });
  });

  it("stores exactly-one matches in pounds, stores nothing for two products, and says which", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const product = (usd: string) => ({ product: { attributes: { usagetype: "EUW2-LoadBalancerUsage" } }, terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: usd } } } } } } });
    world.labAws.products = (body) => (body.ServiceCode === "AWSELB" ? [product("0.0265")] : [product("0.01"), product("0.02")]);
    const ctx = makeAwsCtx(env, new Date(NOW), await getSnapshot(env), config(env), makeBudget(20));
    const r = await labPrices.run(ctx);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/2 products/);
    const row = await env.DB.prepare("SELECT gbp, unit FROM aws_prices WHERE region = 'eu-west-2' AND item = ?1").bind(awsPriceKey(ALB.aws_price!)).first<{ gbp: number; unit: string }>();
    expect(row?.unit).toBe("Hrs");
    expect(row?.gbp).toBeCloseTo(0.0265 * 0.75, 9);
    expect(labPriceAsks(AWS_TEST_LABS, "eu-west-2").length).toBeGreaterThan(0);
  });

  it("an AWS item uses its fresh list price (Hrs per hour, GB-Mo × gb ÷ 730), else the authored figure", () => {
    const now = new Date(NOW);
    const fresh = new Date(now.getTime() - 86_400_000).toISOString();
    const stale = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    const gp3 = { name: "gp3", gbp_h: 0.0008, aws_price: { service: "AmazonEC2", unit: "GB-Mo" as const, gb: 8, filters: { productFamily: "Storage", volumeApiName: "gp3" } } };
    const rows = [{ region: "eu-west-2", item: awsPriceKey(gp3.aws_price), gbp: 0.0696, unit: "GB-Mo", fetched_at: fresh }];
    expect(awsListPrice(gp3, rows, "eu-west-2", now, null)?.gbpH).toBeCloseTo((0.0696 * 8) / 730, 9);
    expect(awsListPrice(gp3, [{ ...rows[0], fetched_at: stale }], "eu-west-2", now, null)).toBeNull();
    const lines = pricedItems({ ...AWS_TEST_LABS[0], cost: { items: [gp3], pricey: null } }, rows, "uksouth", now);
    expect(lines[0]).toMatchObject({ source: "aws" });
  });
});

describe("capacity, permissions and resources", () => {
  it("the AWS capacity sentence sums vCPUs against the On-Demand Standard quota", () => {
    const doc = { sizes: [{ name: "t4g.micro", available: true, reason: null, vcpus: 2, family: "standard" }], usages: [{ family: "standard", used: 30, limit: 32 }], cores: { used: 30, limit: 32 } };
    const words = { place: "London", family: () => "On-Demand Standard" };
    expect(capacityProblems(doc, ["t4g.micro", "t4g.micro", "t4g.micro", "t4g.micro"], [], "eu-west-2", words)).toEqual(["Needs 8 On-Demand Standard vCPUs (8 for this lab's t4g.micro); 30 of 32 used in London."]);
  });

  it("the AWS ticks gate AWS labs with aws_setup; an inactive cost tag only warns", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.role = true;
    world.labAws.boundary = false;
    world.labAws.costTags = [{ key: "cloudlabs-lab", status: "Inactive" }];
    const p = await checkLabPermissions(env, directNet());
    expect(p).toMatchObject({ awsRole: true, awsBoundary: false, awsCostTag: false });
    expect(p.message).toMatch(/wg-admin-lab-boundary policy does not exist yet/);
    expect(p.message).toMatch(/cost tag is not active yet/);
    const card = (await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "soa-03-auto-scaling");
    expect(card.blockers[0]).toEqual({ kind: "aws_setup", message: "AWS labs are not set up yet: run the AWS bootstrap, then Check permissions." });
    world.labAws.boundary = true;
    await checkLabPermissions(env, directNet());
    const again = (await api(env, "GET", "/labs")).json.labs.find((c: { id: string }) => c.id === "soa-03-auto-scaling");
    expect(again.blockers.map((b: { kind: string }) => b.kind)).not.toContain("aws_setup");
  });

  it("a running AWS lab's resources come from its tags, named by their Name tag", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    world.labAws.tagged["eu-west-2"] = [tagged("soa-03-auto-scaling", "vpc/vpc-0a", "vpc-lab"), tagged("soa-03-auto-scaling", "instance/i-0b")];
    const r = await api(env, "GET", "/labs/soa-03-auto-scaling");
    expect(r.json.resources).toEqual([
      { name: "vpc-lab", type: "ec2:vpc", group: "lab-soa-03-auto-scaling (London)", state: null },
      { name: "i-0b", type: "ec2:instance", group: "lab-soa-03-auto-scaling (London)", state: null },
    ]);
  });
});
```

Add to `worker/test/labs-shared.test.ts`:
```ts
  it("sha256Hex matches node's, and awsPriceKey is stable and order-free", async () => {
    const { createHash } = await import("node:crypto");
    for (const s of ["", "abc", "cloudlabs £ ✓", "x".repeat(1000)]) expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    const a = awsPriceKey({ service: "AmazonEC2", unit: "Hrs", filters: { instanceType: "t4g.micro", operatingSystem: "Linux" } });
    expect(a).toMatch(/^lab:[0-9a-f]{16}$/);
    expect(awsPriceKey({ service: "AmazonEC2", unit: "Hrs", filters: { operatingSystem: "Linux", instanceType: "t4g.micro" } })).toBe(a);
  });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/labs-shared.test.ts`
Expected: FAIL (modules and exports missing).

- [ ] **Step 3: Implement** in this order: `shared/sha256.ts` and the two shared functions; `awsApi.ts`'s optional region/host; the harness; `awsReads.ts`; `orphans.ts` (and the two `watch.ts` steps); `cost.ts`; the insights types/ctx changes, `labPrices.ts` and the capacity feed; `prices.ts`; `warnings.ts`; `permissions.ts` and `availability.ts`; `resources.ts` and its caller. Update the header comments (orphans: "an AWS sweep beside the Azure one"; cost: "and Cost Explorer by tag for AWS labs"; prices: "AWS labs from aws_prices").

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/labs-shared.test.ts worker/test/labs-orphans.test.ts worker/test/labs-budget.test.ts worker/test/labs-blockers.test.ts worker/test/labs-read.test.ts worker/test/labs-watch.test.ts worker/test/insights-aws-region.test.ts worker/test/insights-aws-runner.test.ts` then `npm run typecheck`
Expected: PASS. (An insights test that pinned the capacity feed's 4 calls or one region now expects 8 and both regions; change only that expectation.)

- [ ] **Step 5: Commit**

```bash
git add shared worker
git commit -m "feat(aws labs): AWS orphan sweep, cost by lab tag, lab price feed, capacity, permission ticks and resources

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 8: Bootstrap IAM: role, boundary, ABAC lists, policy sizes, simulator, Worker reads, quotas, cost tag

Spec: §7.1 (every statement), §7.2, §7.5, §6 "Worker IAM user", §13, rulings A19, A23, A29, P13, P16.

**Files:**
- Create: `scripts/aws-labs-abac.mjs` (fetch the Service Authorization Reference, write `infra/aws-bootstrap/lab-abac.json`; `--render` writes `infra/aws-bootstrap/lab-policies.json` from it offline; `--check` exits 1 when `lab-policies.json` is not what `--render` would write)
- Create: `scripts/lib/aws-lab-policies.mjs` (pure: the ABAC lists from SAR documents, the wildcard folding, the rendered role policies and boundary)
- Create: `scripts/lib/aws-bootstrap-labs.mjs` (the `--labs` steps with an injected command runner: simulator cases, quotas, cost tag)
- Create: `infra/aws-bootstrap/labs.tf`, `infra/aws-bootstrap/lab-abac.json`, `infra/aws-bootstrap/lab-policies.json`
- Modify: `infra/aws-bootstrap/main.tf` (Worker user: `LabsLook`, `LabsGlobalLook`; `Look` and `Insights` region conditions gain eu-west-1), `infra/aws-bootstrap/outputs.tf` (`labs_role_arn`)
- Modify: `scripts/aws-bootstrap.mjs` (`--labs`: after apply, set `AWS_LABS_ROLE_ARN`, run the simulator cases, the quotas and the cost tag through `aws-bootstrap-labs.mjs`; the header comment documents the flag)
- Test: `scripts/test/aws-labs-iam.test.mjs` (create), `scripts/test/aws-infra.test.mjs` (the `Insights` region condition at line 56)

**Interfaces:**
- Consumes: Task 1's `AWS_LAB_REGIONS`, `AWS_GLOBAL_REGIONS`, `LAB_TAG`, `AWS_IAM_PATH`, `AWS_LABS_ROLE`, `AWS_BOUNDARY`; the attachable managed policy list (same 14 ARNs as Task 2's `MANAGED_POLICIES`, imported from `infra/ci/lab-scope-aws.mjs`).
- Produces:

```js
// scripts/lib/aws-lab-policies.mjs
export const LAB_SERVICES;        // §7.1 service allow-list, in the spec's order (servicequotas reads only)
export const ABAC_SERVICES;       // LAB_SERVICES without "tag", "resource-groups" and "servicequotas"
export const PASS_SERVICES;       // §7.1 pass list as "<x>.amazonaws.com"
export const SERVICE_LINKED;      // §7.1 service-linked list as "<x>.amazonaws.com"
export const AWS_OWNED_TYPES = ["ec2:image", "ec2:snapshot", "ec2:prefix-list", "ssm:document", "ssm:parameter"];
export function abacLists(sar /* Record<service, SAR JSON> */): { create: string[]; change: string[] }; // P16
export function foldWildcards(actions: string[], allOfService: string[]): string[]; // "ec2:CreateVpc*" only when every action it matches is in `actions`
export function renderLabPolicies(abac: { create: string[]; change: string[] }): { role: object[]; boundary: object }; // placeholders __ACCOUNT__ and "__DEFAULT_VPC_ARNS__"
export function policySize(doc: object, fill?: { account: string; vpcArns: string[] }): number; // characters of the filled JSON, whitespace excluded
export const POLICY_MAX = 6000;   // under AWS's 6,144 (A29)
export const ROLE_POLICIES_MAX = 10;
// scripts/lib/aws-bootstrap-labs.mjs
export function simulatorCases(account: string): { name: string; action: string; resource: string; context: { key: string; type: "string" | "stringList"; values: string[] }[]; want: "allowed" | "denied" }[];
export function simulatorProblems(results: { name: string; decision: string }[], cases: ReturnType<typeof simulatorCases>): string[];
export const LAB_QUOTAS: { service: string; code: string; name: string; want: number; raise: "always" | "if-below" }[];
export function quotaPlan(current: { service: string; code: string; region: string; value: number | null; pending: boolean }[]): { service: string; code: string; region: string; to: number }[];
export async function runLabsBootstrap(run: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string }, o: { account: string; roleArn: string; log: (s: string) => void }): Promise<{ ok: boolean }>;
```

Role policy statements (rendered into as few managed policies as fit, each `Version: "2012-10-17"`, greedy packing in this order, at most 10, each under 6,000 characters filled; Sids exactly as below, a split list numbered `CreateNeedsLabTag1`, `CreateNeedsLabTag2`, …):

| Sid | Effect | Action / NotAction | Resource / NotResource | Condition |
|---|---|---|---|---|
| `LabServices` | Allow | `<svc>:*` for each of LAB_SERVICES except servicequotas, plus `servicequotas:Get*`, `servicequotas:List*` | `*` | `StringEquals aws:RequestedRegion [eu-west-2, eu-west-1]` |
| `LabBuckets` | Allow | `s3:*` | `arn:aws:s3:::cloudlabs-*`, `arn:aws:s3:::cloudlabs-*/*` | – |
| `BucketList` | Allow | `s3:ListAllMyBuckets`, `s3:GetBucketLocation` | `*` | – |
| `GlobalServices` | Allow | `cloudfront:*`, `route53:*`, `wafv2:*`, `globalaccelerator:*`, `tag:GetResources` | `*` | `StringEquals aws:RequestedRegion [us-east-1, us-west-2]` |
| `Identity` | Allow | `sts:GetCallerIdentity`, `iam:Get*`, `iam:List*` | `*` | – |
| `LabRolesBounded` | Allow | `iam:CreateRole`, `iam:PutRolePermissionsBoundary`, `iam:AttachRolePolicy`, `iam:DetachRolePolicy`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy` | `arn:aws:iam::__ACCOUNT__:role/cloudlabs-lab/lab-*` | `StringEquals iam:PermissionsBoundary arn:aws:iam::__ACCOUNT__:policy/wg-admin-lab-boundary` |
| `LabRolesOther` | Allow | §7.1's 15 actions | `role/cloudlabs-lab/lab-*`, `instance-profile/cloudlabs-lab/lab-*`, `policy/cloudlabs-lab/lab-*` (full ARNs) | – |
| `Lab07UsersBounded` / `Lab07UsersOther` | Allow | the bounded six / the other four | `arn:aws:iam::__ACCOUNT__:user/cloudlabs-lab/lab-soa-07-*` | bounded: as LabRolesBounded |
| `PassLabRoles` | Allow | `iam:PassRole` | `arn:aws:iam::__ACCOUNT__:role/cloudlabs-lab/lab-*` | `StringEquals iam:PassedToService` PASS_SERVICES |
| `ServiceLinkedRoles` | Allow | `iam:CreateServiceLinkedRole` | `*` | `StringEquals iam:AWSServiceName` SERVICE_LINKED |
| `DenyVpnServer` | Deny | `*` | `*` | `StringEquals aws:ResourceTag/wg-admin vpn` |
| `DenyVpnTagRequest` | Deny | `*` | `*` | `Null aws:RequestTag/wg-admin false` |
| `DenyVpnTagKeys` | Deny | `*` | `*` | `ForAnyValue:StringEquals aws:TagKeys [wg-admin]` |
| `DenyDefaultVpc` | Deny | `ec2:*` | `"__DEFAULT_VPC_ARNS__"` | – |
| `DenyDefaultVpcChildren` | Deny | `ec2:*` | `*` | `ArnEquals ec2:Vpc "__DEFAULT_VPC_ARNS__"` |
| `DenyAccountAndBilling` | Deny | §7.1's list | `*` | – |
| `DenyIamOutsideLab` | Deny | §7.1's iam write list | NotResource: the role, instance-profile, policy, user (lab-soa-07-*) ARNs and `arn:aws:iam::__ACCOUNT__:role/aws-service-role/*` | – |
| `DenyBoundaryRemoval` | Deny | `iam:DeleteRolePermissionsBoundary`, `iam:DeleteUserPermissionsBoundary` | `*` | – |
| `DenyOtherRoles` | Deny | `sts:AssumeRole*` | `*` | – |
| `DenyOtherRegions` | Deny | NotAction `iam:*`, `sts:*`, `cloudfront:*`, `route53:*`, `wafv2:*`, `globalaccelerator:*`, `tag:GetResources`, `s3:ListAllMyBuckets` | `*` | `StringNotEquals aws:RequestedRegion [eu-west-2, eu-west-1, us-east-1, us-west-2]`; and a second statement `DenyGlobalRegionsForLabServices`: Action = LabServices' actions, `StringEquals aws:RequestedRegion [us-east-1, us-west-2]` |
| `CreateNeedsLabTag<n>` | Deny | slices of the create list (`ec2:RunInstances` in its own statement `CreateNeedsLabTagRunInstances` with Resource `arn:aws:ec2:*:*:instance/*`, `…:volume/*`, `…:network-interface/*`) | `*` | `Null aws:RequestTag/cloudlabs-lab true` |
| `ChangeNeedsLabTag<n>` | Deny | slices of the change list | `*` | `Null aws:ResourceTag/cloudlabs-lab true` plus, for slices holding ec2 actions, `Null ec2:CreateAction true` |
| `KeepLabTag` | Deny | `ec2:DeleteTags`, `tag:UntagResources`, and `<svc>:Untag*` for each ABAC service | `*` | `ForAnyValue:StringEquals aws:TagKeys [cloudlabs-lab]` |

(`DenyOtherRegions` is two statements because one condition cannot both allow the two global regions for the global services and refuse them for everything else.)

Boundary (`wg-admin-lab-boundary`, one policy): Allow the §7.2 workload set (`<svc>:*` for ec2, ssm, ssmmessages, ec2messages, cloudwatch, logs, events, sns, sqs, states, lambda, dynamodb, kms, secretsmanager, s3, ecr, ecs, eks, elasticloadbalancing, autoscaling, kinesis, firehose, glue, athena, config, backup, rds, elasticfilesystem, vpc-lattice-svcs) on `*` with `aws:RequestedRegion` in the lab regions, plus `sts:GetCallerIdentity`; Deny the IAM writes (§7.2 list), `sts:AssumeRole*`, `organizations:*`, `account:*`, `billing:*`, `aws-portal:*`, `budgets:*`, `ce:Create*`, `ce:Update*`, `ce:Delete*`; Deny `*` on `aws:ResourceTag/wg-admin = vpn`, on `aws:RequestTag/wg-admin` present, on `aws:TagKeys` containing `wg-admin`; Deny NotAction `sts:GetCallerIdentity` outside the lab regions.

The ABAC lists (P16), from each service's Service Authorization Reference JSON (`https://servicereference.us-east-1.amazonaws.com/` lists `{ service, url }`; each url's JSON has `Actions[{ Name, ActionConditionKeys, Resources[{ Name }], Annotations.Properties{ IsList, IsWrite, IsPermissionManagement, IsTaggingOnly } }]` and `Resources[{ Name, ConditionKeys }]`; V the address and field names when fetching): **create** = actions of ABAC_SERVICES whose `ActionConditionKeys` include `aws:RequestTag/${TagKey}` (tagging-only actions excluded); **change** = non-read actions (`IsWrite` or `IsPermissionManagement`, not `IsTaggingOnly`, not `IsList`) every one of whose resource types has `aws:ResourceTag/${TagKey}` in its `ConditionKeys`, none in `AWS_OWNED_TYPES`, and not in the create list. Then `foldWildcards` per service (longest common verb-prefix groups only, e.g. `ec2:CreateVpc*` when every `ec2:CreateVpc…` action is in the list). `lab-abac.json` = `{ "source": "<url>", "fetched": "<YYYY-MM-DD>", "services": [...ABAC_SERVICES], "create": [...sorted], "change": [...sorted] }`. If the rendered role policies do not fit 10 × 6,000 characters, the change list falls back to `<svc>:Delete*`, `<svc>:Modify*`, `<svc>:Update*`, `<svc>:Terminate*` per ABAC service (A29) and `--render` says so.

`infra/aws-bootstrap/labs.tf` (role, policies and the default VPC lookup):
```hcl
# labs.tf (aws-bootstrap)
#
# Plain English: the AWS labs' own login (AWS labs spec §7). GitHub workflows
# on main assume wg-admin-labs with their signed identity, for 3-hour
# sessions. Its permissions are the managed policies rendered into
# lab-policies.json by scripts/aws-labs-abac.mjs --render (several, as AWS
# caps one at 6,144 characters; ruling A29): free hands inside resources
# tagged cloudlabs-lab in London and Ireland, IAM only under
# /cloudlabs-lab/lab-*, and never the VPN server, the default VPC, other
# regions, other roles, access keys or billing. Every role or user a lab
# makes must carry wg-admin-lab-boundary, so nothing a lab creates can do more.

provider "aws" {
  alias  = "ireland"
  region = "eu-west-1"
  default_tags {
    tags = { project = "wg-admin", "wg-admin" = "bootstrap" }
  }
}

data "aws_vpcs" "default_london" {
  filter {
    name   = "is-default"
    values = ["true"]
  }
}

data "aws_vpcs" "default_ireland" {
  provider = aws.ireland
  filter {
    name   = "is-default"
    values = ["true"]
  }
}

locals {
  lab_policies     = jsondecode(file("${path.module}/lab-policies.json"))
  default_vpc_arns = concat([for id in data.aws_vpcs.default_london.ids : "arn:aws:ec2:${var.region}:${local.account}:vpc/${id}"], [for id in data.aws_vpcs.default_ireland.ids : "arn:aws:ec2:eu-west-1:${local.account}:vpc/${id}"])
  # A Resource list may not be empty: with no default VPC, an ARN that matches nothing.
  vpc_arns_json = join(",", [for a in(length(local.default_vpc_arns) > 0 ? local.default_vpc_arns : ["arn:aws:ec2:${var.region}:${local.account}:vpc/vpc-00000000000000000"]) : jsonencode(a)])
  role_docs     = [for d in local.lab_policies.role : replace(replace(jsonencode(d), "__ACCOUNT__", local.account), "\"__DEFAULT_VPC_ARNS__\"", local.vpc_arns_json)]
  boundary_doc  = replace(jsonencode(local.lab_policies.boundary), "__ACCOUNT__", local.account)
}

resource "aws_iam_policy" "lab_boundary" {
  name   = "wg-admin-lab-boundary"
  policy = local.boundary_doc
}

resource "aws_iam_policy" "labs" {
  count  = length(local.role_docs)
  name   = "wg-admin-labs-${count.index + 1}"
  policy = local.role_docs[count.index]
}

resource "aws_iam_role" "labs" {
  name                 = "wg-admin-labs"
  max_session_duration = 10800
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "${var.github_sub_prefix}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "labs" {
  count      = length(aws_iam_policy.labs)
  role       = aws_iam_role.labs.name
  policy_arn = aws_iam_policy.labs[count.index].arn
}
```

Worker user additions in `main.tf` (`aws_iam_user_policy.worker`):
```hcl
      # AWS labs (docs/superpowers/specs/2026-10-15-aws-labs-design.md section 6): read only.
      {
        Sid       = "LabsLook"
        Effect    = "Allow"
        Action    = ["ec2:Describe*", "elasticloadbalancing:Describe*", "config:DescribeConfigurationRecorders", "cloudwatch:ListDashboards"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = [var.region, "eu-west-1"] } }
      },
      {
        Sid      = "LabsGlobalLook"
        Effect   = "Allow"
        Action   = ["iam:ListRoles", "iam:ListInstanceProfiles", "iam:ListPolicies", "iam:ListUsers", "iam:GetRole", "iam:GetPolicy", "ce:ListCostAllocationTags"]
        Resource = "*"
      },
```
and `Look` and `Insights` change `Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }` to `Condition = { StringEquals = { "aws:RequestedRegion" = [var.region, "eu-west-1"] } }`.

Simulator cases (`simulatorCases(account)`, A19; context keys as `aws iam simulate-principal-policy --context-entries ContextKeyName=…,ContextKeyValues=…,ContextKeyType=…`):

| name | action | resource | context | want |
|---|---|---|---|---|
| tagged VPC | `ec2:CreateVpc` | `arn:aws:ec2:eu-west-2:<acct>:vpc/*` | RequestedRegion eu-west-2; RequestTag/cloudlabs-lab soa-01-x; TagKeys [cloudlabs-lab] | allowed |
| bounded lab role | `iam:CreateRole` | `arn:aws:iam::<acct>:role/cloudlabs-lab/lab-soa-01-x-vm` | PermissionsBoundary = the boundary ARN | allowed |
| untagged VPC | `ec2:CreateVpc` | as above | RequestedRegion eu-west-2 | denied |
| the VPN server | `ec2:TerminateInstances` | `arn:aws:ec2:eu-west-2:<acct>:instance/i-0123456789abcdef0` | RequestedRegion eu-west-2; ResourceTag/wg-admin vpn; ResourceTag/cloudlabs-lab soa-01-x | denied |
| role without the boundary | `iam:CreateRole` | `…:role/cloudlabs-lab/lab-soa-01-x-vm` | – | denied |
| role outside the path | `iam:CreateRole` | `arn:aws:iam::<acct>:role/lab-soa-01-x-vm` | PermissionsBoundary = the boundary ARN | denied |
| access key | `iam:CreateAccessKey` | `arn:aws:iam::<acct>:user/cloudlabs-lab/lab-soa-07-iam-kms-ann` | – | denied |
| a third region | `ec2:CreateVpc` | `arn:aws:ec2:us-east-2:<acct>:vpc/*` | RequestedRegion us-east-2; RequestTag/cloudlabs-lab soa-01-x; TagKeys [cloudlabs-lab] | denied |

`LAB_QUOTAS` (A23): VPCs per Region `vpc`/`L-F678F1CE` → 20 (always); EC2-VPC Elastic IPs `ec2`/`L-0263D0A3` → 10 (always); Running On-Demand Standard vCPUs `ec2`/`L-1216C47A` → 32 (if below); EC2 Instance Connect Endpoints per Region → 10 (if below; the code is found once by name with `aws service-quotas list-service-quotas --service-code ec2 --query "Quotas[?contains(QuotaName, 'Instance Connect')]"`, V, and written into `LAB_QUOTAS`). In eu-west-2 and eu-west-1; a quota already at or above its target, or with a pending request (`list-requested-service-quota-change-history-by-quota` status PENDING or CASE_OPENED), is left alone.

`runLabsBootstrap` steps, each printed with its answer: simulator cases (any mismatch → `ok: false` and the list, loudly); quota reads and requests; cost tag (`aws ce list-cost-allocation-tags --tag-keys cloudlabs-lab --region us-east-1`: Active → "Cost tag cloudlabs-lab: active"; Inactive → `update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=cloudlabs-lab,Status=Active` then "activated"; absent → "not seen in billing yet: it appears about a day after the first tagged resource; run --labs again then").

- [ ] **Step 1: Write the failing test** `scripts/test/aws-labs-iam.test.mjs`

```js
// aws-labs-iam.test.mjs
//
// Plain English: the AWS labs' IAM (AWS labs spec §7, rulings A19 and A29):
// the ABAC lists are made by the rule and pinned; every rendered role policy
// and the boundary fit AWS's size cap, the role holds at most 10 of them, and
// each §7.1 statement says what it must; the Worker user can only read; the
// bootstrap's simulator cases, quotas and cost tag steps behave.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { abacLists, foldWildcards, renderLabPolicies, policySize, POLICY_MAX, ROLE_POLICIES_MAX, LAB_SERVICES, ABAC_SERVICES } from "../lib/aws-lab-policies.mjs";
import { simulatorCases, simulatorProblems, quotaPlan, LAB_QUOTAS } from "../lib/aws-bootstrap-labs.mjs";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const ABAC = JSON.parse(read("infra/aws-bootstrap/lab-abac.json"));
const POLICIES = JSON.parse(read("infra/aws-bootstrap/lab-policies.json"));
const FILL = { account: "123456789012", vpcArns: ["arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0123456789abcdef0", "arn:aws:ec2:eu-west-1:123456789012:vpc/vpc-0fedcba9876543210"] };
const statements = POLICIES.role.flatMap((d) => d.Statement);
const sid = (s) => statements.find((x) => x.Sid === s);

// A small Service Authorization Reference, shaped as the real one (V).
const SAR = {
  ec2: {
    Name: "ec2",
    Resources: [
      { Name: "vpc", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "instance", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "volume", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
      { Name: "image", ConditionKeys: ["aws:ResourceTag/${TagKey}"] },
    ],
    Actions: [
      { Name: "CreateVpc", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "DeleteVpc", ActionConditionKeys: [], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "DescribeVpcs", ActionConditionKeys: [], Resources: [], Annotations: { Properties: { IsList: true } } },
      { Name: "AttachVolume", ActionConditionKeys: [], Resources: [{ Name: "instance" }, { Name: "volume" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "RunInstances", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "instance" }, { Name: "image" }, { Name: "volume" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "ModifyImageAttribute", ActionConditionKeys: [], Resources: [{ Name: "image" }], Annotations: { Properties: { IsWrite: true } } },
      { Name: "CreateTags", ActionConditionKeys: ["aws:RequestTag/${TagKey}"], Resources: [{ Name: "vpc" }], Annotations: { Properties: { IsTaggingOnly: true } } },
    ],
  },
};

test("the ABAC rule: creates by RequestTag, changes only where every resource takes ResourceTag and none is AWS-owned (P16)", () => {
  const { create, change } = abacLists(SAR);
  assert.deepEqual(create.sort(), ["ec2:CreateVpc", "ec2:RunInstances"]);
  assert.deepEqual(change.sort(), ["ec2:AttachVolume", "ec2:DeleteVpc"]);
});

test("wildcards fold only where every action they match is listed", () => {
  const all = ["ec2:CreateVpc", "ec2:CreateVpcEndpoint", "ec2:CreateVpcPeeringConnection", "ec2:CreateVolume"];
  assert.deepEqual(foldWildcards(["ec2:CreateVpc", "ec2:CreateVpcEndpoint", "ec2:CreateVpcPeeringConnection"], all), ["ec2:CreateVpc*"]);
  assert.deepEqual(foldWildcards(["ec2:CreateVpc", "ec2:CreateVpcEndpoint"], all).sort(), ["ec2:CreateVpc", "ec2:CreateVpcEndpoint"]);
});

test("lab-abac.json is the generator's, sorted, for the allow-listed services only, and pinned", () => {
  assert.deepEqual(ABAC.services, [...ABAC_SERVICES]);
  for (const list of [ABAC.create, ABAC.change]) {
    assert.deepEqual(list, [...list].sort());
    assert.equal(new Set(list).size, list.length);
    for (const a of list) assert.ok(ABAC_SERVICES.includes(a.split(":")[0]), a);
  }
  assert.ok(ABAC.create.some((a) => /^ec2:(RunInstances|Run\*)$/.test(a)));
  // Regenerating changes this pin on purpose: review the new lists, then update it.
  assert.equal(createHash("sha256").update(JSON.stringify({ create: ABAC.create, change: ABAC.change })).digest("hex"), "<the hash of the committed lists>");
});

test("lab-policies.json is what --render makes from lab-abac.json", () => {
  assert.deepEqual(POLICIES, renderLabPolicies(ABAC));
});

test("every role policy and the boundary fit (A29), and the role holds at most 10", () => {
  assert.ok(POLICIES.role.length <= ROLE_POLICIES_MAX, `${POLICIES.role.length} role policies`);
  for (const [i, d] of POLICIES.role.entries()) assert.ok(policySize(d, FILL) < POLICY_MAX, `role policy ${i + 1}: ${policySize(d, FILL)}`);
  assert.ok(policySize(POLICIES.boundary, FILL) < POLICY_MAX);
});

test("each §7.1 statement says what it must", () => {
  for (const s of ["LabServices", "LabBuckets", "BucketList", "GlobalServices", "Identity", "LabRolesBounded", "LabRolesOther", "Lab07UsersBounded", "Lab07UsersOther", "PassLabRoles", "ServiceLinkedRoles", "DenyVpnServer", "DenyVpnTagRequest", "DenyVpnTagKeys", "DenyDefaultVpc", "DenyDefaultVpcChildren", "DenyAccountAndBilling", "DenyIamOutsideLab", "DenyBoundaryRemoval", "DenyOtherRoles", "DenyOtherRegions", "DenyGlobalRegionsForLabServices", "CreateNeedsLabTagRunInstances", "KeepLabTag"]) assert.ok(sid(s), s);
  assert.ok(statements.some((s) => /^CreateNeedsLabTag\d+$/.test(s.Sid)) && statements.some((s) => /^ChangeNeedsLabTag\d+$/.test(s.Sid)));
  assert.deepEqual(sid("DenyVpnServer").Condition, { StringEquals: { "aws:ResourceTag/wg-admin": "vpn" } });
  assert.deepEqual(sid("LabRolesBounded").Condition, { StringEquals: { "iam:PermissionsBoundary": "arn:aws:iam::__ACCOUNT__:policy/wg-admin-lab-boundary" } });
  assert.deepEqual(sid("LabServices").Condition, { StringEquals: { "aws:RequestedRegion": ["eu-west-2", "eu-west-1"] } });
  assert.deepEqual(sid("LabServices").Action, [...LAB_SERVICES.filter((s) => s !== "servicequotas").map((s) => `${s}:*`), "servicequotas:Get*", "servicequotas:List*"]);
  assert.equal(sid("DenyDefaultVpc").Resource, "__DEFAULT_VPC_ARNS__");
  assert.deepEqual(sid("Lab07UsersOther").Resource, "arn:aws:iam::__ACCOUNT__:user/cloudlabs-lab/lab-soa-07-*");
  for (const s of statements.filter((x) => x.Effect === "Allow")) for (const a of [].concat(s.Action ?? [])) assert.ok(a !== "*" && a !== "iam:*" && !/^iam:(Create|Delete|Put|Attach|Pass)/.test(a) || ["LabRolesBounded", "LabRolesOther", "Lab07UsersBounded", "Lab07UsersOther", "PassLabRoles", "ServiceLinkedRoles"].includes(s.Sid), `${s.Sid} allows ${a}`);
  const b = POLICIES.boundary.Statement;
  assert.ok(b.some((s) => s.Effect === "Deny" && s.Condition?.StringEquals?.["aws:ResourceTag/wg-admin"] === "vpn"));
  assert.ok(b.some((s) => s.Effect === "Deny" && [].concat(s.Action).includes("iam:PassRole")));
});

test("labs.tf: wg-admin-labs trusts main only, for 3 hours, with every rendered policy attached", () => {
  const tf = read("infra/aws-bootstrap/labs.tf");
  assert.match(tf, /name\s+= "wg-admin-labs"\n\s+max_session_duration = 10800/);
  assert.match(tf, /"token\.actions\.githubusercontent\.com:sub" = "\$\{var\.github_sub_prefix\}:ref:refs\/heads\/main"/);
  assert.match(tf, /resource "aws_iam_policy" "lab_boundary" \{\n\s+name\s+= "wg-admin-lab-boundary"/);
  assert.match(tf, /count\s+= length\(aws_iam_policy\.labs\)/);
});

test("the Worker user may read lab things in both lab regions, and change nothing", () => {
  const main = read("infra/aws-bootstrap/main.tf");
  for (const s of ["LabsLook", "LabsGlobalLook"]) assert.match(main, new RegExp(`Sid\\s+= "${s}"`));
  assert.match(main, /"aws:RequestedRegion" = \[var\.region, "eu-west-1"\]/);
  /** One statement: from its Sid to the next Sid (or the end), as aws-infra.test.mjs reads them. */
  const block = (s) => {
    const i = main.search(new RegExp(`Sid\\s+= "${s}"`));
    const rest = main.slice(i + 1);
    const j = rest.search(/Sid\s+=\s+"/);
    return j < 0 ? rest : rest.slice(0, j);
  };
  for (const s of ["LabsLook", "LabsGlobalLook"]) assert.doesNotMatch(block(s), /:(Create|Delete|Modify|Put|Update|Start|Stop|Terminate|Run|Attach|Detach|Tag|Untag)/);
});

test("the simulator cases are the eight of A19, and a wrong answer is a problem", () => {
  const cases = simulatorCases("123456789012");
  assert.deepEqual(cases.map((c) => [c.name, c.want]), [["tagged VPC", "allowed"], ["bounded lab role", "allowed"], ["untagged VPC", "denied"], ["the VPN server", "denied"], ["role without the boundary", "denied"], ["role outside the path", "denied"], ["access key", "denied"], ["a third region", "denied"]]);
  const ok = cases.map((c) => ({ name: c.name, decision: c.want === "allowed" ? "allowed" : "explicitDeny" }));
  assert.deepEqual(simulatorProblems(ok, cases), []);
  assert.deepEqual(simulatorProblems([{ ...ok[0], decision: "implicitDeny" }, ...ok.slice(1)], cases), ["tagged VPC: wanted allowed, AWS said implicitDeny"]);
});

test("quotas: VPCs and EIPs always raised to 20 and 10, vCPUs only if below 32, pending requests left alone", () => {
  assert.deepEqual(LAB_QUOTAS.slice(0, 3).map((q) => [q.service, q.code, q.want, q.raise]), [["vpc", "L-F678F1CE", 20, "always"], ["ec2", "L-0263D0A3", 10, "always"], ["ec2", "L-1216C47A", 32, "if-below"]]);
  const plan = quotaPlan([
    { service: "vpc", code: "L-F678F1CE", region: "eu-west-2", value: 5, pending: false },
    { service: "vpc", code: "L-F678F1CE", region: "eu-west-1", value: 5, pending: true },
    { service: "ec2", code: "L-1216C47A", region: "eu-west-2", value: 64, pending: false },
    { service: "ec2", code: "L-0263D0A3", region: "eu-west-2", value: 10, pending: false },
  ]);
  assert.deepEqual(plan, [{ service: "vpc", code: "L-F678F1CE", region: "eu-west-2", to: 20 }]);
});
```

(Replace `<the hash of the committed lists>` with the hash printed by the first run after `lab-abac.json` is generated: that run fails with both hashes in the message, and the reviewer checks the lists before the pin is written.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (the modules and files do not exist).

- [ ] **Step 3: Write `scripts/lib/aws-lab-policies.mjs`** (pure; header comment states P16 and A29) and `scripts/aws-labs-abac.mjs` (fetch index, fetch each ABAC service's JSON with a 20 s timeout, `abacLists`, write `lab-abac.json` with two-space JSON and a newline; `--render` writes `lab-policies.json`; `--check` compares). Run `node scripts/aws-labs-abac.mjs` (network, no credentials) then `node scripts/aws-labs-abac.mjs --render`; if the SAR address does not answer from this machine, say so in the task report and leave both JSON files for the controller to generate in Task 17 (the test's pin and size checks then wait for them).

- [ ] **Step 4: Write `labs.tf`, the `main.tf` additions, `outputs.tf`'s `labs_role_arn = aws_iam_role.labs.arn`, and `scripts/lib/aws-bootstrap-labs.mjs`**; wire `--labs` into `scripts/aws-bootstrap.mjs` (after apply: `gh secret set AWS_LABS_ROLE_ARN --repo <repo>` from stdin, then `runLabsBootstrap(run, …)`; exit 1 when it returns `ok: false`). Validate offline: `terraform -chdir=infra/aws-bootstrap init -backend=false && terraform -chdir=infra/aws-bootstrap validate` (in a scratch copy, as labs-tf does, so no `.terraform` lands in the repo).

- [ ] **Step 5: Update `scripts/test/aws-infra.test.mjs:56`** to expect `Condition = { StringEquals = { "aws:RequestedRegion" = [var.region, "eu-west-1"] } }` for `Insights`.

- [ ] **Step 6: Run the targeted tests**

Run: `node --test scripts/test/aws-labs-iam.test.mjs scripts/test/aws-infra.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add infra/aws-bootstrap scripts/aws-labs-abac.mjs scripts/lib/aws-lab-policies.mjs scripts/lib/aws-bootstrap-labs.mjs scripts/aws-bootstrap.mjs scripts/test
git commit -m "feat(aws labs): the wg-admin-labs role, its boundary, generated ABAC lists within AWS's size caps, simulator checks and the Worker's lab reads

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 9: Topology: AWS kinds, planned and live AWS graphs, AWS icon sprite, diagrams

Spec: §10 Topology bullet (kinds, mapping, region lane, peering, sprite, `labs-diagrams`), §6 `GET /labs/:id/topology` for AWS, rulings P5.

**Files:**
- Modify: `shared/topology/model.ts` (`TOPO_ASSET_KINDS` gains `transitGateway`, `internetGateway`, `lambda`, `dynamodb`, `messaging`, `cache`, `stream`, `lattice`, `clientVpn`; `TopoNode` gains optional `cloud?: "aws"`)
- Modify: `shared/topology/kinds.ts` (`KindDef` gains `awsTypes: string[]` and `awsIcon: string | null`; AWS Terraform types join `tfTypes`; the nine new kinds)
- Create: `shared/topology/rules/awsPlanned.ts` (`AWS_TF_RULES`, merged into `TF_RULES` by `rules/planned.ts`)
- Modify: `shared/topology/planned.ts` (AWS containers: each `aws_resourcegroups_group` is a `resourceGroup` group node labelled `lab-<id> · London` (or `· Ireland` for one under `provider = aws.secondary`); an AWS resource's group is the one of its region; AWS nodes carry `cloud: "aws"`; the gateway node links to the VPC named by the `peer_vpc_id` output; the mock name prefix is `a<number>k3x9q` for an AWS id, so labels read `alb-a03…`)
- Create: `shared/topology/awsLive.ts` (`awsLiveGraph(rows, ctx)` → `TopologyGraph` with the planned graph's keys)
- Modify: `worker/src/labs/topology.ts` (an AWS lab's live graph from at most 14 tag-filtered reads, cached 30 s like Azure's; `no_aws` without AWS keys)
- Modify: `scripts/lib/topology-stream.mjs` (`PLAN_OUTPUTS` adds `peer_vpc_id`; `RESOURCE_REF` adds `aws|tls|archive`; `refsFromHcl` also records a resource's `provider` meta-argument as `refs[addr].provider`)
- Modify: `scripts/topology-icons.mjs` (a second, pinned pack: AWS Architecture Icons → `web/src/views/labs/topology/icons/aws.svg`, symbols `aws-<icon>`; its README section quotes AWS's terms, V)
- Create: `web/src/views/labs/topology/icons/aws.svg` (generated); Modify: `web/src/views/labs/topology/icons/README.md` (generated), `web/src/views/labs/topology/icons/sprite.ts` (`ensureSprite(clouds?: ("azure" | "aws")[])`; the AWS sprite loads only when asked), the node renderer (grep `#az-` in `web/src/views/labs/topology/`) and `web/src/views/labs/LabResourceSummary.tsx` (AWS icon for `cloud: "aws"` nodes and AWS cards)
- Modify: `scripts/labs-diagrams.mjs` (`PATHS.spriteAws`; the architecture renderer gets both sprites' symbols)
- Modify: `worker/test/fixtures/topology/round-trip.ts` (`export const AWS_LAB_IDS: readonly string[] = []`: AWS labs have no Azure round trip; each AWS lab task adds its id) and `worker/test/topology-golden.test.ts:742` (`expect([...LAB_IDS, ...AWS_LAB_IDS].sort()).toEqual(labFolders)`)
- Test: `worker/test/topology-aws.test.ts` (create), `scripts/test/topology-icons.test.mjs` (the AWS map), `scripts/test/labs-topology.test.mjs` (`PLAN_OUTPUTS`, the aws reference regex)

**Interfaces:**
- Consumes: Task 3's AWS mock plan (`labs-topology` runs it for AWS labs unchanged), Task 7's `labTagged`, `awsApi.ec2(env, action, params, region)`, `awsQuery`; Task 1's `LabDetail`/`LabCard.cloud`, `LabTopologyResponse.status "no_aws"`.
- Produces:

```ts
// shared/topology/kinds.ts
export interface KindDef { /* as today, plus: */ awsTypes: string[]; awsIcon: string | null }
export function kindOfAws(awsType: string): TopoKind; // tagging-API type ("ec2:vpc") → kind; generic when unknown
// shared/topology/awsLive.ts
export interface AwsRow { arn: string; type: string; id: string; region: string; name: string | null; tags: Record<string, string>; props: Record<string, unknown>; refs: { vpc?: string; subnet?: string; subnets?: string[]; peerVpc?: string; targets?: string[] } }
export interface AwsLiveCtx { labId: string; version: number; gatewayVpcIds: string[]; at: string }
export function awsLiveGraph(rows: readonly AwsRow[], ctx: AwsLiveCtx): TopologyGraph;
// worker/src/labs/topology.ts
export const AWS_TOPOLOGY_CALLS_MAX = 14;
```

The mapping (§10; `arm` of every AWS rule is its tagging-API type, so planned and live keys agree: key = `<awsType>/<Name tag, else name, else the address's name>`):

| Terraform type | awsType | Kind | Placement / rule |
|---|---|---|---|
| `aws_resourcegroups_group` | `resource-groups:group` | `resourceGroup` (group) | the region container (P5) |
| `aws_vpc` | `ec2:vpc` | `vnet` (group) | in its region's container; props `addressSpace` = cidr_block |
| `aws_subnet` | `ec2:subnet` | `subnet` (group) | in the VPC its `vpc_id` references; props `prefix` |
| `aws_instance` | `ec2:instance` | `vm` | in the subnet `subnet_id` references; props `size` = instance_type |
| `aws_launch_template` | – | folds into the `aws_autoscaling_group` that references it |
| `aws_autoscaling_group` | `autoscaling:autoScalingGroup` | `vmss` | in the first subnet of `vpc_zone_identifier`; props `size` (its template's type), `instances` = desired_capacity; policies, schedules and lifecycle hooks fold into it |
| `aws_lb` | `elasticloadbalancing:loadbalancer` | `loadBalancer` | in its VPC (from its subnets); props `sku` = load_balancer_type; target groups and listeners fold in; a traffic edge LB → each ASG or instance its target groups reach, labelled `HTTP <port>` from the listener |
| `aws_security_group` | `ec2:security-group` | `nsg` | in its VPC; its `aws_vpc_security_group_*_rule`s fold in |
| `aws_route_table` | `ec2:route-table` | `routeTable` | in its VPC; associations and `aws_route`s fold in; a dependency edge to each IGW, NAT gateway or peering a route targets |
| `aws_internet_gateway` | `ec2:internet-gateway` | `internetGateway` (new) | in its VPC |
| `aws_nat_gateway` | `ec2:natgateway` | `natGateway` | in its subnet |
| `aws_eip` | `ec2:elastic-ip` | `publicIp` | folds into the NAT gateway or instance that uses it |
| `aws_vpc_endpoint` | `ec2:vpc-endpoint` | `privateEndpoint` | Gateway type: in its VPC; Interface: in its first subnet; props `groupId` = the service's last dot-part (`s3`, `ssm`, `logs`) |
| `aws_ec2_instance_connect_endpoint` | `ec2:instance-connect-endpoint` | `bastion` (P5) | in its subnet |
| `aws_vpc_peering_connection` | `ec2:vpc-peering-connection` | – | an undirected peering edge between its two VPCs, as Azure peering |
| `aws_db_instance` | `rds:db` | `sqlServer` | in the VPC of its subnet group; subnet and parameter groups fold in; a dependency edge primary → replica labelled `replicates` |
| `aws_s3_bucket` | `s3:bucket` | `storage` | in the region container; versioning, lifecycle, public access block, policy, objects fold in; a dependency edge source → destination labelled `replicates` from a replication configuration |
| `aws_backup_vault` | `backup:backup-vault` | `recoveryVault` | in the region container; plans (by `target_vault_name`) and selections fold in |
| `aws_ebs_volume` | `ec2:volume` | folds into the instance its attachment names (else `generic`); `aws_volume_attachment` and `aws_ebs_snapshot` fold with it |
| `aws_iam_role` | `iam:role` | `managedIdentity` | in the region container; instance profiles, policy attachments and the lab's policies fold in |
| `aws_cloudwatch_metric_alarm`, `aws_cloudwatch_dashboard` | `cloudwatch:alarm`, – | `monitor` | in the region container |
| `aws_cloudwatch_log_group` | `logs:log-group` | `logAnalytics` | in the region container; metric filters and query definitions fold in |
| `aws_sns_topic`, `aws_cloudwatch_event_rule`, `aws_sqs_queue`, `aws_sfn_state_machine` | `sns:topic`, `events:rule`, `sqs:queue`, `states:stateMachine` | `messaging` (new) | in the region container; event targets and topic policies fold in; a dependency edge rule → each target |
| `aws_ec2_transit_gateway` | `ec2:transit-gateway` | `transitGateway` (new) | attachments fold in, one edge per attachment (B4 uses it) |
| `aws_lambda_function`, `aws_dynamodb_table`, `aws_elasticache_*`, `aws_kinesis_*`, `aws_vpclattice_*`, `aws_ec2_client_vpn_endpoint` | their types | `lambda`, `dynamodb`, `cache`, `stream`, `lattice`, `clientVpn` (new) | later batches; kinds only |
| other AWS types (SSM, Config) | – | `generic` | in the region container |

New kinds' `def(...)` (word, plural, Azure icon id for the Azure sprite fallback, placement, order, armTypes [], tfTypes, cardProps): `transitGateway` ("Transit gateway", …, "virtual-wans", "rg", 17), `internetGateway` ("Internet gateway", …, "public-ip-addresses", "vnet", 18), `lambda` ("Lambda function", …, "function-apps", "rg", 28), `dynamodb` ("DynamoDB table", …, "azure-cosmos-db", "rg", 36), `messaging` ("Messaging", …, "service-bus", "rg", 68), `cache` ("Cache", …, "cache-redis", "rg", 37), `stream` ("Stream", …, "event-hubs", "rg", 69), `lattice` ("VPC Lattice", …, "private-link-services", "rg", 71), `clientVpn` ("Client VPN", …, "virtual-network-gateways", "subnet", 19). Every kind an AWS rule uses has an `awsIcon` naming a symbol in `aws.svg`.

Live AWS reads (`worker/src/labs/topology.ts`, all through `directNet()`, tag-filtered with `Filter tag:cloudlabs-lab = <id>`): in eu-west-2: `labTagged`, `DescribeVpcs`, `DescribeSubnets`, `DescribeInstances`, `DescribeRouteTables`, `DescribeVpcPeeringConnections`, `DescribeTransitGatewayAttachments`, `DescribeNatGateways`, `DescribeVpcEndpoints`, and ELBv2 `DescribeLoadBalancers` with the tagged load balancer ARNs (10); in the lab's secondary region: `labTagged`, `DescribeVpcs`, `DescribeSubnets`, `DescribeInstances` (4). The VPN server's VPC ids for the gateway node come from the peering connections' accepter side. Errors: AWS refusal → `failed` (plain message), throttling → `throttled` with the last graph.

- [ ] **Step 1: Write the failing test** `worker/test/topology-aws.test.ts`

```ts
// topology-aws.test.ts
//
// Plain English: AWS labs on the diagram (AWS labs spec §10): the template's
// planned resources become a region container holding the VPC, its subnets,
// the instance, the Instance Connect Endpoint (drawn as a bastion), the S3
// endpoint and the security group, with AWS icons; the live graph built from
// tag-filtered describes keys the same nodes the same way, so the diff lines
// them up; and the route answers no_aws without AWS keys.

import { describe, expect, it } from "vitest";
import { plannedGraph } from "../../shared/topology/planned";
import { awsLiveGraph, type AwsRow } from "../../shared/topology/awsLive";
import { KINDS, kindOfAws } from "../../shared/topology/kinds";
import { diffGraphs } from "../../shared/topology/diff";
import { api, freeze, labEnv, runningLab, withAwsLabs } from "./labs-helpers";

const ID = "soa-01-cloudwatch";
const ch = (address: string, after: Record<string, unknown>) => ({ address, type: address.split(".")[0]!, name: address.split(".")[1]!.replace(/\[.*$/, ""), index: /\[(\d+)\]/.exec(address)?.[1] ? Number(/\[(\d+)\]/.exec(address)![1]) : null, after });
const PLANNED = {
  labId: ID,
  version: 1,
  number: "01",
  changes: [
    ch("aws_resourcegroups_group.lab", { name: `lab-${ID}` }),
    ch("aws_vpc.lab", { cidr_block: "10.71.192.0/20", tags: { Name: "vpc-lab" } }),
    ch("aws_subnet.private[0]", { cidr_block: "10.71.192.0/24", tags: { Name: "snet-private-1" } }),
    ch("aws_subnet.private[1]", { cidr_block: "10.71.193.0/24", tags: { Name: "snet-private-2" } }),
    ch("aws_security_group.vms", { name: "lab-vms", tags: { Name: "sg-vms" } }),
    ch("aws_vpc_endpoint.s3", { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3" } }),
    ch("aws_ec2_instance_connect_endpoint.lab", { tags: { Name: "eice-lab" } }),
    ch("aws_instance.app", { instance_type: "t4g.micro", tags: { Name: "vm-app" } }),
  ],
  outputs: { peer_vpc_id: null },
  refs: {
    "aws_subnet.private": { vpc_id: ["aws_vpc.lab"] },
    "aws_security_group.vms": { vpc_id: ["aws_vpc.lab"] },
    "aws_vpc_endpoint.s3": { vpc_id: ["aws_vpc.lab"] },
    "aws_ec2_instance_connect_endpoint.lab": { subnet_id: ["aws_subnet.private"] },
    "aws_instance.app": { subnet_id: ["aws_subnet.private"], vpc_security_group_ids: ["aws_security_group.vms"] },
    "output.peer_vpc_id": { value: ["aws_vpc.lab"] },
  },
};

describe("AWS on the planned diagram", () => {
  it("the region container holds the VPC; subnets, instance, endpoint and bastion sit where AWS puts them", () => {
    const g = plannedGraph(PLANNED as never);
    const node = (key: string) => g.nodes.find((n) => n.key === key)!;
    const rg = node(`resource-groups:group/lab-${ID}`);
    expect(rg).toMatchObject({ kind: "resourceGroup", cloud: "aws" });
    expect(rg.label).toBe(`lab-${ID} · London`);
    expect(node("ec2:vpc/vpc-lab")).toMatchObject({ kind: "vnet", parent: rg.id });
    expect(node("ec2:subnet/snet-private-1")).toMatchObject({ kind: "subnet", parent: node("ec2:vpc/vpc-lab").id });
    expect(node("ec2:instance/vm-app")).toMatchObject({ kind: "vm", parent: node("ec2:subnet/snet-private-1").id, props: { size: "t4g.micro" } });
    expect(node("ec2:instance-connect-endpoint/eice-lab").kind).toBe("bastion");
    expect(node("ec2:vpc-endpoint/vpce-s3")).toMatchObject({ kind: "privateEndpoint", parent: node("ec2:vpc/vpc-lab").id });
    expect(node("ec2:security-group/sg-vms").kind).toBe("nsg");
  });

  it("every AWS kind has an AWS icon, and tagging types map to kinds", () => {
    for (const k of ["vnet", "subnet", "vm", "vmss", "loadBalancer", "nsg", "routeTable", "internetGateway", "privateEndpoint", "bastion", "sqlServer", "storage", "recoveryVault", "managedIdentity", "monitor", "logAnalytics", "messaging", "resourceGroup"] as const) expect(KINDS[k].awsIcon, k).toBeTruthy();
    expect(kindOfAws("ec2:vpc")).toBe("vnet");
    expect(kindOfAws("ec2:instance-connect-endpoint")).toBe("bastion");
    expect(kindOfAws("ssm:association")).toBe("generic");
  });
});

describe("AWS on the live diagram", () => {
  const rows: AwsRow[] = [
    { arn: `arn:aws:resource-groups:eu-west-2:123456789012:group/lab-${ID}`, type: "resource-groups:group", id: `lab-${ID}`, region: "eu-west-2", name: `lab-${ID}`, tags: { "cloudlabs-lab": ID }, props: {}, refs: {} },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:vpc/vpc-0a", type: "ec2:vpc", id: "vpc-0a", region: "eu-west-2", name: "vpc-lab", tags: { Name: "vpc-lab" }, props: { addressSpace: ["10.71.192.0/20"] }, refs: {} },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:subnet/subnet-0b", type: "ec2:subnet", id: "subnet-0b", region: "eu-west-2", name: "snet-private-1", tags: { Name: "snet-private-1" }, props: { prefix: "10.71.192.0/24" }, refs: { vpc: "vpc-0a" } },
    { arn: "arn:aws:ec2:eu-west-2:123456789012:instance/i-0c", type: "ec2:instance", id: "i-0c", region: "eu-west-2", name: "vm-app", tags: { Name: "vm-app" }, props: { size: "t4g.micro", privateIp: "10.71.192.10" }, refs: { vpc: "vpc-0a", subnet: "subnet-0b" } },
  ];
  it("keys live nodes as the planned ones, so the diff matches them", () => {
    const live = awsLiveGraph(rows, { labId: ID, version: 1, gatewayVpcIds: [], at: "2026-10-15T10:00:00.000Z" });
    const planned = plannedGraph(PLANNED as never);
    const keys = (g: { nodes: { key: string }[] }) => new Set(g.nodes.map((n) => n.key).filter(Boolean));
    for (const k of ["ec2:vpc/vpc-lab", "ec2:subnet/snet-private-1", "ec2:instance/vm-app", `resource-groups:group/lab-${ID}`]) {
      expect(keys(live).has(k), k).toBe(true);
      expect(keys(planned).has(k), k).toBe(true);
    }
    expect(Object.values(diffGraphs(planned, live).status).filter((s) => s === "both").length).toBeGreaterThanOrEqual(4);
  });

  it("the route answers no_aws without AWS keys, never asking AWS", async () => {
    freeze();
    const { env, world } = await labEnv({ awsKeys: false });
    withAwsLabs();
    await runningLab(env, world, "soa-03-auto-scaling");
    const before = world.calls.length;
    const r = await api(env, "GET", "/labs/soa-03-auto-scaling/topology");
    expect(r.json.status).toBe("no_aws");
    expect(world.calls.slice(before).filter((c) => c.host.endsWith("amazonaws.com"))).toEqual([]);
  });
});
```

(`diffGraphs(planned, live)` returns `{ status: Record<node key, "both" | "added" | "missing" | "azure" | "unlisted"> }`; node keys are lower case. `labEnv({ awsKeys: false })` is a small option Task 6's helpers gain if they lack it.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run worker/test/topology-aws.test.ts`
Expected: FAIL (no AWS rules, no `awsLive.ts`).

- [ ] **Step 3: Implement the model, kinds, `awsPlanned.ts` rules and the AWS branch of `planned.ts`**, then `awsLive.ts` and the Worker route. Keep every Azure rule and output byte-identical: run `npx vitest run worker/test/topology-golden.test.ts` after this step; it must pass unchanged.

- [ ] **Step 4: The AWS sprite.** In `scripts/topology-icons.mjs` add `AWS_PACK_VERSION`, `AWS_PACK_URL` (the official "AWS Architecture Icons" asset package linked from https://aws.amazon.com/architecture/icons/, V), `AWS_PACK_SHA256` (first run with `""` prints the hash and stops; pin it), `AWS_PACK_ROOT`, `AWS_ICON_FILES` (one entry per distinct `awsIcon`, the closest official icon, with `AWS_NEAREST` explaining any stand-in), and the same optimiser writing `aws.svg` with `<symbol id="aws-<icon>">`. Add the AWS terms to the README section (quoted with the link). Run it: `node scripts/topology-icons.mjs` (downloads into a scratch folder, never the repo). Extend `scripts/test/topology-icons.test.mjs`: every `KINDS[k].awsIcon` has a file in `AWS_ICON_FILES` and a symbol in the committed `aws.svg`.

- [ ] **Step 5: Web and diagrams.** `sprite.ts`: `ensureSprite(clouds = ["azure"])` loads `aws.svg` (a second hashed asset, host id `topo-sprite-aws`) when `clouds` includes aws; the node renderer uses `#aws-${KINDS[kind].awsIcon}` for `node.cloud === "aws"`; `LabResourceSummary` picks AWS icons for AWS cards. `labs-diagrams.mjs` passes both sprites' symbols to `architectureSvg` (`sprite: azureSprite + awsSprite`). `topology-stream.mjs` changes as listed; update `labs-topology.test.mjs`'s expectations for `PLAN_OUTPUTS` and the reference regex.

- [ ] **Step 6: Run the targeted tests**

Run: `npx vitest run worker/test/topology-aws.test.ts worker/test/topology-golden.test.ts worker/test/labs-topology-route.test.ts web/src/views/labs/topology` then `node --test scripts/test/topology-icons.test.mjs scripts/test/labs-topology.test.mjs scripts/test/labs-diagrams.test.mjs` then `npm run typecheck` then `npm run labs-diagrams -- --check`
Expected: PASS (Azure diagrams unchanged).

- [ ] **Step 7: Commit**

```bash
git add shared/topology worker web/src/views/labs scripts
git commit -m "feat(aws labs): AWS on the lab diagrams: kinds, planned and live graphs, the AWS icon sprite

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 10: Web: header, cloud filter, badge, coverage, AWS modal, settings ticks

Spec: §10 (Header, Cards, Filters, Coverage map, Lab modal AWS, Connect lines, Elsewhere), §6 Permissions check, rulings A22, P9.

**Files:**
- Modify: `web/src/views/labs/LabsHeader.tsx` (title `Labs`; `LABS_SUBTITLE`)
- Modify: `web/src/views/labs/model.ts` (`Filters.cloud`, URL param `cloud`, `examsFor(cloud)`, `applyFilters` by cloud, `labNumberWord`)
- Modify: `web/src/views/labs/LabsFilterToolbar.tsx` (Cloud control before Exam; Exam lists the chosen cloud's exams)
- Modify: `web/src/views/labs/LabCard.tsx` (AWS badge; number label), `CoverageMap.tsx` (two headings), `LabPrerequisites.tsx`, `LabCatalogueGrid.tsx:46`, `LabDetailsPanel.tsx:293`, `LabModal.tsx:13`, `LabsPage.tsx:109` (number words), `DeployForm.tsx` (AWS region text, connect note), `RunningLab.tsx` (console links, connect hint), the cost lines' source word (grep `"authored"` under `web/src/views/labs`), `RunningStrip.tsx` and the running-labs widget (grep `runningLabs` under `web/src/widgets`) (AWS badge on chips)
- Modify: `web/src/views/labs/topics.ts` (`Topic.aws` word; `labTopics(resources, cloud)`; topics for the nine new kinds)
- Modify: `web/src/views/settings/LabsSection.tsx` (three AWS ticks)
- Modify: the Activity view's lab-run link if it names `lab.yml` (grep `lab.yml` under `web/src` and `worker/src/api/activity.ts`; use the run's `github_run_url`, or the workflow of `cloudOfId(lab_id)`)
- Modify: `web/src/test/fixtures.ts`, `web/src/views/labs/testData.ts` (AWS examples: `card({ id: "soa-03-auto-scaling", number: 3, cloud: "aws", exam: "SOA-C03", exams: ["SOA-C03", "SAA-C03"] })`)
- Modify tests that pin `Azure Labs`: `web/src/views/labs/header.test.tsx:16-39`, `web/src/labs-contract.test.tsx:55`, `web/src/views/labs/history.test.tsx:54`, `web/src/views/labs/modal.test.tsx:61`, `web/src/views/labs/page.test.tsx:42` (heading `Labs`)
- Test: `web/src/views/labs/aws.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1's `LabCloud`, `EXAM_CLOUD`, `LAB_EXAMS`, `LabCard.cloud`, `LabDetail.cloud/secondaryRegion/consoleUrls/connect`, `LabPermissions.awsRole/awsBoundary/awsCostTag`, `LabCostLine.source "aws"`; Task 9's `KINDS[k].awsIcon` (resource icons).
- Produces:

```ts
// web/src/views/labs/model.ts
export interface Filters { q: string; cloud: LabCloud | null; exam: LabExam | null; area: string | null; level: LabLevel | null; type: LabType[]; notRun: boolean; ready: boolean }
export const examsFor: (cloud: LabCloud | null) => readonly LabExam[]; // LAB_EXAMS, or those whose EXAM_CLOUD is cloud
export const labNumberWord: (c: Pick<LabCard, "number" | "cloud">) => string; // "Lab 7" | "AWS 3" (A22)
// web/src/views/labs/LabsHeader.tsx
export const LABS_SUBTITLE = "Hands-on Azure (AZ-104, AZ-305, AZ-700) and AWS (SOA-C03, SAA-C03, ANS-C01) environments: pick a lab, deploy it, learn by doing.";
// web/src/views/labs/topics.ts
export function labTopics(resources: Resources, cloud?: LabCloud): string[]; // AWS words for cloud "aws"
```

Words: Cloud control items `All`, `Azure`, `AWS`; the AWS badge text `AWS` (a `Pill` with tone `orange` and a word, never colour alone); coverage headings `Azure` and `AWS`; deploy form region line for AWS `Region: London (eu-west-2)` plus `, and Ireland (eu-west-1) for the second region` when `secondaryRegion`; when `connect.possible` is false the peer tick is not shown and `connect.note` is shown in its place; console links `Open in AWS console (London)` / `(Ireland)` (new tab, `rel="noopener noreferrer"`); under an AWS lab's connect lines: `The ssh and curl lines work while the lab is peered; the aws ec2-instance-connect line works anywhere the AWS CLI is signed in.`; a cost line with `source: "aws"` reads `AWS list price`; Settings → Labs ticks `AWS labs role`, `Lab boundary`, `Cost tag active` (the third shows a warning tone, not an error, when false).

AWS topic words (`Topic.aws`): EC2 (vm), Auto Scaling (vmss), VPCs (vnet), Security groups (nsg), Route tables (routeTable), Elastic IPs (publicIp), NAT gateways (natGateway), Elastic Load Balancing (loadBalancer), VPC endpoints (privateEndpoint, privateLinkService), Instance Connect (bastion), Route 53 (DNS kinds), CloudFront (frontDoor), Global Accelerator (trafficManager), Site-to-site VPN (vpnGateway, localNetworkGateway), Network Firewall (firewall, firewallPolicy), AWS WAF (wafPolicy), IAM roles (managedIdentity), KMS (keyVault), CloudWatch (monitor), CloudWatch Logs (logAnalytics), AWS Backup (recoveryVault), S3 (storage), Amazon RDS (sqlServer, sqlDatabase), EKS (aks), ECS (containerApp, containerAppEnv), ECR (registry); new topics: Transit Gateway (transitGateway, networking), Internet gateways (internetGateway, networking), Lambda (lambda, compute), DynamoDB (dynamodb, data), Messaging (messaging, messaging), ElastiCache (cache, data), Kinesis (stream, data), VPC Lattice (lattice, networking), Client VPN (clientVpn, networking).

- [ ] **Step 1: Write the failing test** `web/src/views/labs/aws.test.tsx`

```tsx
// aws.test.tsx
//
// Plain English: AWS labs on the Labs tab (AWS labs spec §10): the header
// names both clouds, a Cloud filter narrows the cards and the exam list,
// AWS cards wear an AWS badge and read "AWS 3", the coverage map has an
// Azure and an AWS heading, and an AWS lab's modal deploys to London with
// console links and the same-cloud connect note.

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { LabsHeader, LABS_SUBTITLE } from "./LabsHeader";
import { applyFilters, examsFor, labNumberWord, NO_FILTERS, readFilters } from "./model";
import { LabCard } from "./LabCard";
import { ExamCoverage } from "./CoverageMap";
import { labView } from "./contract";
import { labTopics } from "./topics";
import { card, session } from "./testData";
import { labDetailFixture } from "@/test/fixtures";
import { DeployFormView } from "./DeployForm";
import { RunningLabView } from "./RunningLab";

const aws = (over = {}) => card({ id: "soa-03-auto-scaling", number: 3, title: "Auto Scaling behind an Application Load Balancer", cloud: "aws", exam: "SOA-C03", exams: ["SOA-C03", "SAA-C03"], ...over });

describe("header and filters", () => {
  it("the page is titled Labs and names both clouds' exams", () => {
    renderWithProviders(<LabsHeader />);
    expect(screen.getByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();
    expect(LABS_SUBTITLE).toBe("Hands-on Azure (AZ-104, AZ-305, AZ-700) and AWS (SOA-C03, SAA-C03, ANS-C01) environments: pick a lab, deploy it, learn by doing.");
  });

  it("the cloud filter keeps one cloud's cards, lists that cloud's exams, and drops the other cloud's exam", () => {
    const views = [labView(aws(), true), labView(card(), true)];
    expect(applyFilters(views, { ...NO_FILTERS, cloud: "aws" }).map((v) => v.card.id)).toEqual(["soa-03-auto-scaling"]);
    expect([...examsFor("aws")]).toEqual(["SOA-C03", "SAA-C03", "ANS-C01"]);
    expect([...examsFor(null)]).toHaveLength(6);
    expect(readFilters(new URLSearchParams("cloud=azure&exam=SOA-C03"))).toMatchObject({ cloud: "azure", exam: null });
    expect(readFilters(new URLSearchParams("cloud=aws&exam=SOA-C03"))).toMatchObject({ cloud: "aws", exam: "SOA-C03" });
  });
});

describe("cards and coverage", () => {
  it("an AWS card wears an AWS badge and reads AWS 3; an Azure card is unchanged", () => {
    expect(labNumberWord({ number: 3, cloud: "aws" })).toBe("AWS 3");
    expect(labNumberWord({ number: 7, cloud: "azure" })).toBe("Lab 7");
    renderWithProviders(<LabCard view={labView(aws(), true)} onOpen={() => {}} />);
    expect(screen.getByText("AWS", { selector: ".pill *, .pill" })).toBeInTheDocument();
    expect(screen.getByText(/AWS 3 · SOA-C03/)).toBeInTheDocument();
  });

  it("coverage boxes say AWS 3", () => {
    renderWithProviders(<ExamCoverage e={{ exam: "SOA-C03", areas: [{ key: "soa.reliability", name: "Reliability and Business Continuity", labs: [{ id: "soa-03-auto-scaling", number: 3, title: "Auto Scaling", run: false }], run: 0, available: 1 }] }} />);
    expect(screen.getByRole("img", { name: "AWS 3, Auto Scaling: not run yet" })).toBeInTheDocument();
  });

  it("AWS labs' topics use AWS words", () => {
    expect(labTopics({ vm: 2, nsg: 1, vnet: 1, bastion: 1 }, "aws")).toEqual(["Instance Connect", "Security groups", "EC2", "VPCs"]);
  });
});

describe("the AWS lab modal", () => {
  it("deploys to London with no region box, and shows the connect note in place of the peer tick", async () => {
    const d = labDetailFixture({ card: aws(), cloud: "aws", secondaryRegion: null, defaults: { region: "eu-west-2", peer: true, hours: 2 }, connect: { possible: false, note: "AWS labs connect only to an AWS server (the server is in Azure). This lab runs unconnected." } });
    renderWithProviders(<DeployFormView d={d} />);
    expect(screen.queryByLabelText(/region/i, { selector: "input" })).toBeNull();
    expect(screen.getByText("Region: London (eu-west-2)")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /peer/i })).toBeNull();
    expect(screen.getByText(/AWS labs connect only to an AWS server/)).toBeInTheDocument();
  });

  it("a running AWS lab links to its console group per region and explains the connect lines", () => {
    const d = labDetailFixture({ card: aws({ running: session({ labId: "soa-03-auto-scaling", state: "running" }) }), cloud: "aws", portalUrl: null, consoleUrls: [{ region: "eu-west-2", label: "London", url: "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-03-auto-scaling?region=eu-west-2" }], session: session({ labId: "soa-03-auto-scaling", state: "running", outputs: { privateIps: { "vm-web": "10.64.64.10" }, connect: ["aws ec2-instance-connect ssh --instance-id i-0abc --os-user labadmin --connection-type eice", "ssh labadmin@10.64.64.10"], users: {} } }) });
    renderWithProviders(<RunningLabView d={d} />);
    const link = screen.getByRole("link", { name: "Open in AWS console (London)" });
    expect(link).toHaveAttribute("href", "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-03-auto-scaling?region=eu-west-2");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /portal/i })).toBeNull();
    expect(screen.getByText(/the aws ec2-instance-connect line works anywhere/)).toBeInTheDocument();
  });
});
```

(Use the components' real exported names and props: read `LabCard.tsx`, `DeployForm.tsx` and `RunningLab.tsx` first; where the form or running view is not exported as a pure view, export a `…View` taking the detail as the test does, without changing what the page renders. `labDetailFixture(over)` and `session(over)`/`card(over)` exist in `web/src/test/fixtures.ts` and `testData.ts`.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run web/src/views/labs/aws.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** the Files list; then change the five `Azure Labs` heading expectations to `Labs`, and the header test's subtitle to `LABS_SUBTITLE`. Settings test (`web/src/views/settings/labs.test.tsx`) gains: `it("shows the three AWS ticks, the cost tag as a warning", …)` rendering the section with `permissions: { ..., awsRole: true, awsBoundary: false, awsCostTag: false }` and expecting the words `AWS labs role`, `Lab boundary`, `Cost tag active` with the boundary marked failed and the cost tag in the warning tone.

- [ ] **Step 4: Run the targeted tests and the bundle check**

Run: `npx vitest run web/src/views/labs web/src/views/settings web/src/labs-contract.test.tsx` then `npm run typecheck` then `npm run build:web && npm run bundle-size`
Expected: PASS; the entry chunk grows by under 1 kB (the AWS sprite is a separate asset).

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(aws labs): the Labs tab shows both clouds: cloud filter, AWS badge and numbers, coverage by cloud, the AWS modal and permission ticks

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 11: `labs-verify --aws-prices`, release-test script by cloud, README setup

Spec: §11 (`labs-verify --aws-prices`, release test), §13, §14 B1 "README setup steps", ruling A7.

**Files:**
- Modify: `scripts/labs-verify.mjs` (`--aws-prices`; exported `awsPriceProblems`, `verifyAwsPrices`)
- Modify: `scripts/lab-release-test.mjs` (workflow, region, name prefix and `gateway_cidr` by the lab's cloud)
- Modify: `README.md` (section "AWS labs: one-time setup", after "Labs: one-time setup")
- Test: `scripts/test/labs-verify.test.mjs`, `scripts/test/lab-release.test.mjs`

**Interfaces:**
- Consumes: Task 1's `cloudOfId`, `awsUsagePrefix`, `AwsPriceRef`; `loadEnv` from `scripts/lib/env.mjs` (the controller's local keys; never printed).
- Produces:

```js
// scripts/labs-verify.mjs
export function awsPriceProblems(products /* parsed PriceList entries */, ref, region): string[]; // [] when exactly one product has an OnDemand USD price in ref.unit
export async function verifyAwsPrices(labs /* [{ id, items, secondary }] */, { run, usdToGbp = 0.75 }): Promise<{ problems: string[]; lines: string[] }>;
//   run(args: string[]) → { status, stdout, stderr } for `aws pricing get-products ...`
// scripts/lab-release-test.mjs
export function labWorkflow(def): "lab.yml" | "lab-aws.yml";
export function buildPayload(def, { slot, region, runId, namePrefix }): object; // AWS: region eu-west-2, name_prefix a<NN>…, gateway_cidr "10.50.0.0/16"
```

`--aws-prices` asks, for every AWS lab's `aws_price` in eu-west-2 (and in the lab's secondary region for `region: "secondary"` items): `aws pricing get-products --region us-east-1 --service-code <service> --format-version aws_v1 --max-results 100 --output json --filters Type=TERM_MATCH,Field=regionCode,Value=<region> Type=TERM_MATCH,Field=<k>,Value=<v> ...` (`{usage}` filled with `awsUsagePrefix(region)`), with the `.env` keys `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the child's environment only (read only: `pricing:GetProducts`). Problems: `<id>: <item>: no product matches in <region>`, `<id>: <item>: <n> products match in <region> (<their usagetypes>)`, `<id>: <item>: authored £<a>/h is more than 25% from AWS's £<b>/h`; lines: `<id>: <item> (<region>): $<usd>/<unit> = £<gbp>/h (authored £<a>/h)`. Hrs → `usd × usdToGbp`; GB-Mo → `usd × gb ÷ 730 × usdToGbp`. Not part of the default run (it needs keys): only with the flag.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/test/labs-verify.test.mjs`:
```js
test("awsPriceProblems wants exactly one product with an OnDemand price in the unit", () => {
  const p = (usd, unit = "Hrs", usagetype = "EUW2-LoadBalancerUsage") => ({ product: { attributes: { usagetype } }, terms: { OnDemand: { a: { priceDimensions: { b: { unit, pricePerUnit: { USD: usd } } } } } } });
  const ref = { service: "AWSELB", unit: "Hrs", filters: { usagetype: "{usage}-LoadBalancerUsage" } };
  assert.deepEqual(awsPriceProblems([p("0.0265")], ref, "eu-west-2"), []);
  assert.match(awsPriceProblems([], ref, "eu-west-2")[0], /no product matches in eu-west-2/);
  assert.match(awsPriceProblems([p("0.0265"), p("0.03", "Hrs", "EUW2-Other")], ref, "eu-west-2")[0], /2 products match in eu-west-2 \(EUW2-LoadBalancerUsage, EUW2-Other\)/);
  assert.match(awsPriceProblems([p("0.0265", "LCU-Hrs")], ref, "eu-west-2")[0], /no product matches/);
});

test("verifyAwsPrices fills {usage}, asks us-east-1 with the region code, and flags a 25% drift", async () => {
  const calls = [];
  const answer = (usd) => ({ status: 0, stdout: JSON.stringify({ PriceList: [JSON.stringify({ product: { attributes: { usagetype: "EUW2-LoadBalancerUsage" } }, terms: { OnDemand: { a: { priceDimensions: { b: { unit: "Hrs", pricePerUnit: { USD: usd } } } } } } })] }), stderr: "" });
  const lab = { id: "soa-03-auto-scaling", secondary: null, items: [{ name: "ALB", gbp_h: 0.0199, aws_price: { service: "AWSELB", unit: "Hrs", filters: { usagetype: "{usage}-LoadBalancerUsage" } } }, { name: "LCU", gbp_h: 0.006 }] };
  const ok = await verifyAwsPrices([lab], { run: (args) => (calls.push(args), answer("0.0265")) });
  assert.deepEqual(ok.problems, []);
  assert.equal(calls.length, 1, "authored-only items are not asked");
  assert.ok(calls[0].includes("--region") && calls[0][calls[0].indexOf("--region") + 1] === "us-east-1");
  assert.ok(calls[0].includes("Type=TERM_MATCH,Field=usagetype,Value=EUW2-LoadBalancerUsage"));
  assert.ok(calls[0].includes("Type=TERM_MATCH,Field=regionCode,Value=eu-west-2"));
  const drift = await verifyAwsPrices([lab], { run: () => answer("0.05") });
  assert.match(drift.problems[0], /more than 25% from AWS's/);
});
```

Add to `scripts/test/lab-release.test.mjs`:
```js
test("an AWS lab's release test dispatches lab-aws.yml in London with an a<NN> prefix and the gateway range", () => {
  const def = { id: "soa-03-auto-scaling", cloud: "aws", version: 1, regions: { secondary: null }, connectivity: { peering: "optional" }, timing: { deploy_min: 6, destroy_min: 6 } };
  assert.equal(labWorkflow(def), "lab-aws.yml");
  assert.equal(labWorkflow({ ...def, id: "az104-08-vms", cloud: "azure" }), "lab.yml");
  const p = buildPayload(def, { slot: 31, region: "uksouth", runId: "lab-test-1" });
  assert.equal(p.region, "eu-west-2");
  assert.match(p.name_prefix, /^a03[a-z0-9]{5}$/);
  assert.equal(p.gateway_cidr, "10.50.0.0/16");
  assert.equal(p.peering, false);
});
```
(and a test that the dispatch and run listing use `labWorkflow(def)`: drive `runRelease` with its injected `gh` as the existing tests do and assert the `workflow run` and `run list --workflow` arguments name `lab-aws.yml` for an AWS id.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-verify.test.mjs scripts/test/lab-release.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement** the two scripts (header comments gain the AWS sentences; `--region` applies to Azure labs only and is documented so), and write the README section:

```markdown
## AWS labs: one-time setup

AWS labs build in the same AWS account as the AWS VPN server, under their own role.
Run these once, on this PC (they use the admin keys in `.env`, which never leave it):

1. `node scripts/aws-bootstrap.mjs --labs` creates or updates the `wg-admin-labs` role (assumed only by GitHub
   workflows on `main`), its policies and the `wg-admin-lab-boundary` permission boundary; adds the Worker's
   read-only lab permissions; stores the role's ARN as the GitHub secret `AWS_LABS_ROLE_ARN`; proves the guards
   with `iam simulate-principal-policy` (it stops loudly if any answer is wrong); asks for the quota increases
   (VPCs 20 and Elastic IPs 10 in London and Ireland, vCPUs and Instance Connect Endpoints only if low); and
   activates the `cloudlabs-lab` cost allocation tag once AWS has seen it.
2. In the dashboard, Settings → Labs → **Check permissions**: "AWS labs role" and "Lab boundary" must tick.
   "Cost tag active" ticks about a day after the first AWS lab runs; run step 1 again then.
3. To regenerate the tag-guard lists after AWS adds actions: `node scripts/aws-labs-abac.mjs`, then
   `node scripts/aws-labs-abac.mjs --render`, review the diff, update the pin in `scripts/test/aws-labs-iam.test.mjs`,
   and run step 1.

Check AWS's list prices for every AWS lab: `npm run labs-verify -- --aws-prices`.
Release-test an AWS lab from `main` (pennies; it always tears down): `node scripts/lab-release-test.mjs soa-01-cloudwatch --confirm-cost --ref main`.
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test scripts/test/labs-verify.test.mjs scripts/test/lab-release.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/labs-verify.mjs scripts/lab-release-test.mjs README.md scripts/test
git commit -m "feat(aws labs): labs-verify --aws-prices, release tests by cloud, AWS labs setup in the README

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 12: Lab soa-01-cloudwatch

Spec: §12.2 row 01, §3–§4 (lab definition and Terraform contract), §9 (cost items), §10 (connect lines), rulings A9, A11, A12, P12, P15. Not built here: none for this lab (§12.2's list names no batch 1 lab).

**Files:**
- Create: `labs/soa-01-cloudwatch/lab.yaml`, `labs/soa-01-cloudwatch/readme.md`
- Create: `labs/soa-01-cloudwatch/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's, keeping only `lab_id`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `outputs.tf`, `compute.tf`, `monitoring.tf` (below)
- Create: `labs/_learning/soa-01-cloudwatch.yaml`
- Create: `scripts/test/fixtures/labs/aws-content.mjs` (shared AWS lab content checks; Tasks 13–16 use it)
- Create: `scripts/test/fixtures/labs/plans/labs/soa-01-cloudwatch.mjs` (the plan fixture)
- Create (generated): `shared/topology/planned/soa-01-cloudwatch.json` (`node scripts/labs-topology.mjs soa-01-cloudwatch`), `shared/guides/soa-01-cloudwatch/architecture.svg` and the `index.json`/`placement.json` entries (`npm run labs-diagrams`)
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-01-cloudwatch"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS` gains the id)
- Test: `scripts/test/labs-aws-soa-01.test.mjs` (create)

**Interfaces:**
- Consumes: `labs/_template-aws/*` (Task 3: `local.vpc_cidr`, `local.azs`, `local.cloud_init_base`, `local.boundary_arn`, `aws_vpc.lab`, `aws_subnet.private[0..1]`, `aws_route_table.private`, `aws_security_group.vms`, `data.aws_ssm_parameter.al2023_arm64`); `ctxAws`, `templateResources`, `al2023Instance`, `awsData`, `AWS_PROVIDER_CONFIG`, `tagged`, `ref`, `BOUNDARY` from `common-aws.mjs` (Task 2); `readmeFooter` (Task 1); the AWS topology rules (Task 9).
- Produces: `scripts/test/fixtures/labs/aws-content.mjs`:

```js
export function awsLab(id): { yaml: object; tf: string; files: Record<string, string>; readme: string; learning: object };
export function commonAwsProblems(id): string[]; // [] when the lab keeps every §4 rule this file checks (below)
```
`commonAwsProblems` checks: `main.tf`, `network.tf` and `versions.tf` equal `labs/_template-aws`'s byte for byte (LF); `variables.tf` declares only `LAB_TF_VARS_AWS` names, each block as the template writes it; every `resource "aws_instance"` block has `ami = data.aws_ssm_parameter.al2023_arm64.insecure_value`, `http_tokens = "required"`, `volume_tags = merge(var.tags,`, no `associate_public_ip_address = true`; every `aws_launch_template` has `http_tokens = "required"` and `tag_specifications` for `instance`, `volume` and `network-interface` each with `merge(var.tags,`; every `aws_iam_role`, `aws_iam_instance_profile` and `aws_iam_policy` has `path = "/cloudlabs-lab/"` and a name starting `"lab-${var.lab_id}-`, and every role `permissions_boundary = local.boundary_arn`; no `data "aws_iam_policy_document"` (P12); `outputs.tf` has `private_ips`, `connect`, `peer_vpc_id`, `peer_route_table_ids` when the lab can peer; the readme's text before `## What it deploys` contains `From the ${exam} outline:` and names `` `lab-<id>` ``, every Learn more link starts `https://docs.aws.amazon.com/`, and it ends with `readmeFooter(id)`; `lint` (`lintDir(<tf>, { cloud: "aws" })`) and `variablesProblems(<variables.tf>, "aws")` are empty.

**`labs/soa-01-cloudwatch/lab.yaml`**
```yaml
# Lab soa-01 (AWS labs batch 1). SOA-C03 skills this lab touches ((V) the
# wording against the current exam guide): Monitoring, Logging, Analysis,
# Remediation, and Performance Optimization: metrics, alarms and filters in
# CloudWatch, the CloudWatch agent, CloudWatch Logs Insights, EventBridge.
# Costs: London list prices in USD × 0.75 (config.aws.usdToGbp), from the
# Price List API (npm run labs-verify -- --aws-prices soa-01-cloudwatch):
#   t4g.micro           $0.0094/h  -> £0.0071
#   gp3                 $0.0928/GB-month × 8 / 730 -> £0.0008
#   interface endpoint  $0.011/h per AZ (V), billed per started hour -> £0.0083
# Authored (no hourly or GB-month price): detailed monitoring (7 metrics ×
# $0.30/month), 2 agent metrics, 3 alarms ($0.10/month each), the dashboard
# ($3/month), log ingestion of a few MB.
id: soa-01-cloudwatch
version: 1
cloud: aws
title: "CloudWatch: agent, custom metrics, alarms, Logs Insights"
summary: >-
  An Amazon Linux instance whose CloudWatch agent sends memory, disk and an app log, a metric filter, three alarms to an
  SNS topic, a dashboard and an EventBridge rule: watch a workload and get told when it misbehaves.
exam: SOA-C03
skill_areas: [soa.monitoring]
level: foundation
type: explore
prerequisites: []
cost:
  items:
    - name: "EC2 t4g.micro, Linux"
      gbp_h: 0.0071
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "Interface VPC endpoints (logs, monitoring), one AZ"
      gbp_h: 0.0083
      qty: 2
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { productFamily: VpcEndpoint, usagetype: "{usage}-VpcEndpoint-Hours" } }
    - { name: "EC2 detailed monitoring (7 metrics)", gbp_h: 0.0022 }
    - { name: "CloudWatch agent metrics (2)", gbp_h: 0.0006 }
    - { name: "CloudWatch alarms (3)", gbp_h: 0.0003 }
    - { name: "CloudWatch dashboard", gbp_h: 0.0031 }
    - { name: "CloudWatch Logs ingestion, a few MB", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/soa-01-cloudwatch/terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 01's instance, vm-app, and what it needs to report
# without any internet route: a role allowed to put metrics and logs
# (CloudWatchAgentServerPolicy, under the lab boundary), and interface
# endpoints for CloudWatch Logs and CloudWatch in one subnet. A small
# service, lab-app, writes a log line every 10 seconds, one in ten an ERROR,
# which the agent ships with memory and disk use.

resource "aws_iam_role" "vm" {
  name                 = "lab-${var.lab_id}-vm"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "vm_cloudwatch" {
  role       = aws_iam_role.vm.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_instance_profile" "vm" {
  name = "lab-${var.lab_id}-vm"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.vm.name
}

resource "aws_security_group" "endpoints" {
  name        = "lab-endpoints"
  description = "Interface endpoints: HTTPS from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["logs", "monitoring"])
  vpc_id              = aws_vpc.lab.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "vpce-${each.key}" }
}

locals {
  agent_config = jsonencode({
    agent = { metrics_collection_interval = 60 }
    metrics = {
      namespace         = "cloudlabs/${var.lab_id}"
      append_dimensions = { InstanceId = "$${aws:InstanceId}" }
      metrics_collected = {
        mem  = { measurement = ["mem_used_percent"] }
        disk = { measurement = ["used_percent"], resources = ["/"] }
      }
    }
    logs = { logs_collected = { files = { collect_list = [{ file_path = "/var/log/lab-app.log", log_group_name = "/cloudlabs/${var.lab_id}/app", log_stream_name = "{instance_id}" }] } } }
  })
  app_script = <<-EOT
    #!/bin/bash
    # One log line every 10 seconds; every tenth is an ERROR (lab 01's metric filter counts them).
    n=0
    while true; do
      n=$((n + 1))
      if [ $((n % 10)) -eq 0 ]; then echo "$(date -Is) ERROR payment service timed out (request $n)"; else echo "$(date -Is) INFO served request $n"; fi
      sleep 10
    done >> /var/log/lab-app.log
  EOT
  app_unit = "[Unit]\nDescription=Lab 01 sample app log\nAfter=network-online.target\n[Service]\nExecStart=/usr/local/bin/lab-app.sh\nRestart=always\n[Install]\nWantedBy=multi-user.target\n"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.vm.name
  monitoring             = true
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/opt/aws/amazon-cloudwatch-agent/etc/lab.json", permissions = "0644", content = local.agent_config },
      { path = "/usr/local/bin/lab-app.sh", permissions = "0755", content = local.app_script },
      { path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit },
    ]
    runcmd = [
      "dnf install -y amazon-cloudwatch-agent",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/lab.json",
      "systemctl daemon-reload",
      "systemctl enable --now lab-app.service",
    ]
  }))}"
  user_data_replace_on_change = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-app" })
  tags        = { Name = "vm-app" }
  depends_on  = [aws_vpc_endpoint.interface, aws_vpc_endpoint.s3, aws_cloudwatch_log_group.app]
}
```

**`labs/soa-01-cloudwatch/terraform/monitoring.tf`**
```hcl
# monitoring.tf
#
# Plain English: what lab 01 watches with. The app log's group (kept one
# day), a metric filter counting ERROR lines, three alarms (CPU from EC2's
# own 1-minute metrics, app errors, memory from the agent) that notify an SNS
# topic with no subscribers until you add one, a dashboard, a saved Logs
# Insights query, and an EventBridge rule that sends vm-app's state changes
# to the same topic. Dashboards and query definitions cannot carry tags, so
# they are named lab-<id>-* (ruling A4).

resource "aws_cloudwatch_log_group" "app" {
  name              = "/cloudlabs/${var.lab_id}/app"
  retention_in_days = 1
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "lab-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "ERROR"
  metric_transformation {
    name          = "AppErrors"
    namespace     = "cloudlabs/${var.lab_id}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "lab-${var.lab_id}-alerts"
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EventsAndAlarms"
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "cloudwatch.amazonaws.com"] }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alerts.arn
    }]
  })
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "lab-${var.lab_id}-cpu-high"
  alarm_description   = "vm-app's CPU above 70% for two minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 70
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "lab-${var.lab_id}-app-errors"
  alarm_description   = "Five or more ERROR lines in a minute"
  namespace           = "cloudlabs/${var.lab_id}"
  metric_name         = "AppErrors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "lab-${var.lab_id}-memory-high"
  alarm_description   = "vm-app's memory above 80% for two minutes (from the agent)"
  namespace           = "cloudlabs/${var.lab_id}"
  metric_name         = "mem_used_percent"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "overview" {
  dashboard_name = "lab-${var.lab_id}-overview"
  dashboard_body = jsonencode({
    widgets = [
      { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { title = "vm-app CPU", region = var.region, stat = "Average", period = 60, metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.app.id]] } },
      { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { title = "vm-app memory", region = var.region, stat = "Average", period = 60, metrics = [["cloudlabs/${var.lab_id}", "mem_used_percent", "InstanceId", aws_instance.app.id]] } },
      { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = { title = "App errors a minute", region = var.region, stat = "Sum", period = 60, metrics = [["cloudlabs/${var.lab_id}", "AppErrors"]] } },
      { type = "log", x = 12, y = 6, width = 12, height = 6, properties = { title = "Latest errors", region = var.region, query = "SOURCE '${aws_cloudwatch_log_group.app.name}' | fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20" } },
    ]
  })
}

resource "aws_cloudwatch_query_definition" "errors" {
  name            = "lab-${var.lab_id}-errors"
  log_group_names = [aws_cloudwatch_log_group.app.name]
  query_string    = "fields @timestamp, @message\n| filter @message like /ERROR/\n| sort @timestamp desc\n| limit 50"
}

resource "aws_cloudwatch_event_rule" "state" {
  name        = "lab-${var.lab_id}-ec2-state"
  description = "vm-app starts, stops or terminates"
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail        = { "instance-id" = [aws_instance.app.id] }
  })
}

resource "aws_cloudwatch_event_target" "state_sns" {
  rule      = aws_cloudwatch_event_rule.state.name
  target_id = "sns"
  arn       = aws_sns_topic.alerts.arn
}
```

**`labs/soa-01-cloudwatch/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 01 is up (AWS labs spec §4, §10).

output "private_ips" {
  value = { "vm-app" = aws_instance.app.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.app.id} --os-user labadmin --connection-type eice",
    "ssh labadmin@${aws_instance.app.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/soa-01-cloudwatch/readme.md`** (exactly):
````markdown
One small Amazon Linux instance that reports more than EC2 does on its own: the CloudWatch agent sends memory and disk use and an application log, a metric filter turns log lines into a metric, and alarms and an EventBridge rule tell an SNS topic when things change. Everything is listed in the lab's resource group, `lab-soa-01-cloudwatch`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement metrics, alarms and filters with Amazon CloudWatch, install and configure the CloudWatch agent, analyse logs with CloudWatch Logs Insights, and use Amazon EventBridge to act on events.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and no route to the internet: an S3 gateway endpoint lets the instance install packages, and interface endpoints for CloudWatch Logs and CloudWatch (`vpce-logs`, `vpce-monitoring`) carry the agent's data
- `vm-app`, a t4g.micro Amazon Linux 2023 instance with no public IP, detailed (1-minute) monitoring and the role `lab-soa-01-cloudwatch-vm` (CloudWatchAgentServerPolicy). A small service, `lab-app`, writes a line every 10 seconds to `/var/log/lab-app.log`; every tenth is an `ERROR`
- The CloudWatch agent, sending `mem_used_percent` and the root disk's `used_percent` to the namespace `cloudlabs/soa-01-cloudwatch`, and the app log to the log group `/cloudlabs/soa-01-cloudwatch/app` (kept for one day)
- A metric filter, `lab-errors`, that counts `ERROR` lines as the metric `AppErrors`
- Three alarms, `lab-soa-01-cloudwatch-cpu-high`, `lab-soa-01-cloudwatch-app-errors` and `lab-soa-01-cloudwatch-memory-high`, which notify the SNS topic `lab-soa-01-cloudwatch-alerts` (no subscribers until you add one)
- The dashboard `lab-soa-01-cloudwatch-overview`, the saved Logs Insights query `lab-soa-01-cloudwatch-errors`, and the EventBridge rule `lab-soa-01-cloudwatch-ec2-state`, which sends `vm-app`'s state changes to the same topic
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH from the console with no public IP

Sign in as `labadmin`; the password is behind **Show**. Connect from the console (EC2, `vm-app`, Connect, EC2 Instance Connect, Connect using EC2 Instance Connect Endpoint) or with the first Connect line. With **Peer to gateway** (only while the VPN server runs in AWS) the ssh line works from a tunnel client.

```text
lab-soa-01-cloudwatch (London)
  vpc-lab (slot /20)
    snet-private-1: vm-app (t4g.micro) + CloudWatch agent --> vpce-logs, vpce-monitoring
                    eice-lab (console SSH)
    vpce-s3 (packages)
  log group /cloudlabs/<id>/app --> metric filter lab-errors --> alarm app-errors --+
  alarms cpu-high and memory-high ------------------------------------------------+--> SNS lab-<id>-alerts
  EventBridge rule ec2-state (vm-app's state changes) ----------------------------+
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Subscribe your email to `lab-soa-01-cloudwatch-alerts` (SNS, Topics, Create subscription, protocol Email) and confirm it. Then stop and start `vm-app` from the console: the EventBridge rule sends each state change to your inbox.
- Connect to `vm-app` and load its CPU with `yes > /dev/null &` twice (`pkill yes` when you are done). Watch `lab-soa-01-cloudwatch-cpu-high` go to In alarm on the dashboard within about three minutes: detailed monitoring gives 1-minute points, and the alarm wants two.
- In CloudWatch Logs Insights pick the saved query `lab-soa-01-cloudwatch-errors` and run it, then count errors a minute with `stats count(*) by bin(1m)`. Logs Insights charges for the data it scans, about half a penny per GB; this log is tiny.
- Change the metric filter to count only lines containing `timed out`, or lower the `app-errors` alarm's threshold, and see how quickly the alarm follows. Then add an EC2 action that stops the instance to the CPU alarm and watch CloudWatch act on its own.
- Read the agent's configuration in `/opt/aws/amazon-cloudwatch-agent/etc/lab.json`, add `swap_used_percent` to the memory measurements and reload it with `sudo amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/lab.json`. Each custom metric costs about 23p a month while it reports.

## Learn more

- [Collect metrics and logs with the CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html)
- [Using Amazon CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [Creating metrics from log events using filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html)
- [Analyzing log data with CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)
- [Using Amazon CloudWatch dashboards](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [Rules in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)
- [Connect using EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-01-cloudwatch` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````
(Every link is V: Task 17 runs `npm run labs-verify -- --links soa-01-cloudwatch`; replace one that does not answer 200 with the page it moved to.)

**`labs/_learning/soa-01-cloudwatch.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Watch an EC2 workload with the CloudWatch agent, metric filters, alarms and EventBridge.
learn:
  - Install and configure the CloudWatch agent for memory, disk and logs
  - Turn log lines into a metric and alarm on it through SNS
  - Query an application log with CloudWatch Logs Insights
learning_min: 45
```

**The diagram** must contain (review `shared/topology/planned/soa-01-cloudwatch.json` against this before writing GOLDEN from it): `resourceGroup lab-soa-01-cloudwatch · London`; `vnet vpc-lab`; `subnet snet-private-1`, `subnet snet-private-2` under it; `vm vm-app`, `bastion eice-lab`, `privateEndpoint vpce-logs`, `privateEndpoint vpce-monitoring` under `snet-private-1`; `privateEndpoint vpce-s3`, `nsg sg-eice`, `nsg sg-vms`, `nsg sg-endpoints`, `routeTable rt-private` under `vpc-lab`; `managedIdentity lab-soa-01-cloudwatch-vm`, `logAnalytics /cloudlabs/soa-01-cloudwatch/app`, four `monitor` nodes (three alarms and the dashboard), `messaging lab-soa-01-cloudwatch-alerts` and `messaging lab-soa-01-cloudwatch-ec2-state` in the region container. A node missing or misplaced is a Task 9 rule bug to fix there (with a topology-aws test) rather than in this lab.

- [ ] **Step 1: Write the shared checks and the failing lab test.** `scripts/test/fixtures/labs/aws-content.mjs` as the Interfaces block says. `scripts/test/labs-aws-soa-01.test.mjs`:

```js
// labs-aws-soa-01.test.mjs
//
// Plain English: lab soa-01-cloudwatch is the lab AWS labs spec §12.2 row 01
// describes, built to the §4 contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-01-cloudwatch";

test("soa-01 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-01's lab.yaml: §12.2 row 01", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "foundation", "explore", ["soa.monitoring"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro"] });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.025 && total < 0.035, `about £0.03/h (tier £), got ${total}`);
  assert.equal(yaml.cost.items.find((i) => i.name.startsWith("Interface VPC endpoints")).whole_hours, true);
});

test("soa-01 builds the agent, filter, alarms, dashboard, query, rule and endpoints the readme names", () => {
  const { tf, readme } = awsLab(ID);
  for (const re of [
    /resource "aws_cloudwatch_log_group" "app"[\s\S]*?retention_in_days = 1/,
    /resource "aws_cloudwatch_log_metric_filter" "errors"[\s\S]*?pattern\s+= "ERROR"/,
    /resource "aws_cloudwatch_metric_alarm" "cpu_high"/, /resource "aws_cloudwatch_metric_alarm" "app_errors"/, /resource "aws_cloudwatch_metric_alarm" "memory_high"/,
    /dashboard_name = "lab-\$\{var\.lab_id\}-overview"/, /resource "aws_cloudwatch_query_definition" "errors"/,
    /resource "aws_cloudwatch_event_rule" "state"/, /resource "aws_sns_topic" "alerts"/,
    /for_each\s+= toset\(\["logs", "monitoring"\]\)/, /policy_arn = "arn:aws:iam::aws:policy\/CloudWatchAgentServerPolicy"/, /monitoring\s+= true/,
  ]) assert.match(tf, re);
  for (const name of ["vm-app", "lab-soa-01-cloudwatch-alerts", "lab-soa-01-cloudwatch-overview", "lab-errors", "/cloudlabs/soa-01-cloudwatch/app"]) assert.ok(readme.includes(name), name);
});

test("soa-01's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-01.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` from `labs/_template-aws/` unchanged and trim `variables.tf` to the six variables named.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-01-cloudwatch.mjs`: `export default () => { const c = ctxAws("soa-01-cloudwatch", "01"); return { lab: c.id, variables: c.variables, providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, data: awsData(), resources: [...templateResources(c), <one entry per instance of every resource block in compute.tf and monitoring.tf>] }; }`. Each entry sets exactly the attributes the block sets: values known at plan in `values` (wrapped with `tagged(c, …)` for taggable types, so `tags_all` is present), computed or reference-built ones in `unknown`, and HCL references in `refs` (`ref(address, attr)`); `aws_instance.app` comes from `al2023Instance(c, { key: "app", name: "vm-app", profile: "aws_iam_instance_profile.vm", monitoring: true })` with `user_data_replace_on_change: false` added; `aws_vpc_endpoint.interface["logs"]` and `["monitoring"]` carry `forEach: { references: [] , constant_value: ["logs", "monitoring"] }` as the batch 3 fixtures write for_each; IAM documents are JSON strings in `values` (known at plan). `lab-plans.test.mjs` then proves it matches the `.tf` files and passes `checkPlanAws`.

- [ ] **Step 5: Generate the planned graph and the readme diagram**: `node scripts/labs-topology.mjs soa-01-cloudwatch` (terraform; writes `shared/topology/planned/soa-01-cloudwatch.json`), review it against "The diagram" above, then `npm run labs-diagrams` (writes `shared/guides/soa-01-cloudwatch/architecture.svg` and the index/placement entries; the readme's one sketch becomes the architecture diagram). Add `GOLDEN["soa-01-cloudwatch"]` (nodes and edges as the test's `shape()` prints them for the generated graph) and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-01.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, then `npm run labs-tf -- soa-01-cloudwatch`, then `npm run labs-topology -- --check soa-01-cloudwatch` and `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-01-cloudwatch labs/_learning/soa-01-cloudwatch.yaml shared/topology/planned/soa-01-cloudwatch.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-01 CloudWatch: agent, custom metrics, alarms, Logs Insights

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 13: Lab soa-02-systems-manager

Spec: §12.2 row 02, §3–§4, §7.3 rule 4 (`AWS_CONFIG_LABS`), §9, rulings A4, A11, A12, P12, P15. Not built here: none for this lab.

**Files:**
- Create: `labs/soa-02-systems-manager/lab.yaml`, `readme.md`; `terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged from `labs/_template-aws/`), `variables.tf` (the template's, keeping `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `outputs.tf`, `ssm.tf`, `config.tf` (below)
- Create: `labs/_learning/soa-02-systems-manager.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-02-systems-manager.mjs`, `scripts/test/labs-aws-soa-02.test.mjs`
- Create (generated): `shared/topology/planned/soa-02-systems-manager.json`, `shared/guides/soa-02-systems-manager/architecture.svg`, the `shared/guides/{index,placement}.json` entries
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-02-systems-manager"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)

**Interfaces:**
- Consumes: `labs/_template-aws/*` (Task 3), `common-aws.mjs` helpers (Task 2), `awsLab`/`commonAwsProblems` from `scripts/test/fixtures/labs/aws-content.mjs` (Task 12), `AWS_CONFIG_LABS` contains this id (Task 1), the AWS topology rules (Task 9).
- Produces: the lab.

**`lab.yaml`**
```yaml
# Lab soa-02 (AWS labs batch 1). SOA-C03 skills ((V) against the current
# exam guide): Monitoring, Logging, Analysis, Remediation, and Performance
# Optimization (automated remediation with AWS Config and Systems Manager
# Automation); Deployment, Provisioning, and Automation (Run Command, State
# Manager, Patch Manager); Security and Compliance (Config rules).
# The only lab that makes a Config recorder (AWS_CONFIG_LABS): AWS allows one
# per region per account. London list prices × 0.75 (labs-verify --aws-prices).
# Authored: Config items ($0.003 each) and rule evaluations ($0.001 each).
id: soa-02-systems-manager
version: 1
cloud: aws
title: "Systems Manager and Config auto-remediation"
summary: >-
  Two instances managed by Systems Manager with no SSH needed (Run Command, Session Manager, Patch Manager and State
  Manager), and an AWS Config rule that finds SSH open to the internet and removes it by itself.
exam: SOA-C03
skill_areas: [soa.monitoring, soa.deployment, soa.security]
level: associate
type: explore
prerequisites: [soa-01-cloudwatch]
cost:
  items:
    - name: "EC2 t4g.micro, Linux (2 running)"
      gbp_h: 0.0071
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volumes, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "Interface VPC endpoints (ssm, ssmmessages, ec2messages), one AZ"
      gbp_h: 0.0083
      qty: 3
      whole_hours: true
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { productFamily: VpcEndpoint, usagetype: "{usage}-VpcEndpoint-Hours" } }
    - { name: "AWS Config items recorded (security groups and instances)", gbp_h: 0.002 }
    - { name: "AWS Config rule evaluations (a few an hour)", gbp_h: 0.0008 }
    - { name: "S3 bucket for Config's snapshots, a few KB", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 4, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.micro, t4g.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`terraform/ssm.tf`**
```hcl
# ssm.tf
#
# Plain English: lab 02's two instances, managed by Systems Manager with no
# SSH or internet: their role (AmazonSSMManagedInstanceCore), interface
# endpoints for ssm, ssmmessages and ec2messages, a patch baseline for
# Amazon Linux 2023 and its patch group (the instances' "Patch Group" tag),
# and two State Manager associations: a daily patch scan and a software
# inventory every 30 minutes.

resource "aws_iam_role" "ssm" {
  name                 = "lab-${var.lab_id}-ssm"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "lab-${var.lab_id}-ssm"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.ssm.name
}

resource "aws_security_group" "endpoints" {
  name        = "lab-endpoints"
  description = "Interface endpoints: HTTPS from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ssm", "ssmmessages", "ec2messages"])
  vpc_id              = aws_vpc.lab.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "vpce-${each.key}" }
}

resource "aws_instance" "web" {
  count                  = 2
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[count.index].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.ssm.name
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-web${count.index + 1}" })
  tags        = { Name = "vm-web${count.index + 1}", "Patch Group" = "lab-${var.lab_id}-web" }
  depends_on  = [aws_vpc_endpoint.interface, aws_vpc_endpoint.s3]
}

resource "aws_ssm_patch_baseline" "al2023" {
  name             = "lab-${var.lab_id}-al2023"
  description      = "Security updates rated Critical or Important, approved at once"
  operating_system = "AMAZON_LINUX_2023"
  approval_rule {
    approve_after_days = 0
    compliance_level   = "HIGH"
    patch_filter {
      key    = "CLASSIFICATION"
      values = ["Security"]
    }
    patch_filter {
      key    = "SEVERITY"
      values = ["Critical", "Important"]
    }
  }
}

resource "aws_ssm_patch_group" "web" {
  baseline_id = aws_ssm_patch_baseline.al2023.id
  patch_group = "lab-${var.lab_id}-web"
}

resource "aws_ssm_association" "patch_scan" {
  name                = "AWS-RunPatchBaseline"
  association_name    = "lab-${var.lab_id}-patch-scan"
  schedule_expression = "rate(1 day)"
  parameters          = { Operation = "Scan" }
  targets {
    key    = "tag:Patch Group"
    values = ["lab-${var.lab_id}-web"]
  }
}

resource "aws_ssm_association" "inventory" {
  name                = "AWS-GatherSoftwareInventory"
  association_name    = "lab-${var.lab_id}-inventory"
  schedule_expression = "rate(30 minutes)"
  targets {
    key    = "tag:cloudlabs-lab"
    values = [var.lab_id]
  }
}
```

**`terraform/config.tf`**
```hcl
# config.tf
#
# Plain English: AWS Config in lab 02 (the only lab allowed a recorder: one
# per region per account). It records security groups and instances only,
# delivers snapshots to the lab's own bucket, and runs the managed rule
# restricted-ssh (INCOMING_SSH_DISABLED) with automatic remediation by the
# SSM Automation document AWS-DisablePublicAccessForSecurityGroup, under a
# role of the lab's own. sg-demo is an empty group to try it on. The
# recorder and delivery channel cannot carry tags, so they are named
# lab-<id>-* (ruling A4).

locals {
  config_bucket     = "cloudlabs-${var.name_prefix}-config"
  config_bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-config"
}

resource "aws_s3_bucket" "config" {
  bucket        = local.config_bucket
  force_destroy = true
  tags          = { Name = "config-snapshots" }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "config" {
  name                 = "lab-${var.lab_id}-config"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "config.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "config_managed" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_iam_policy" "config_delivery" {
  name = "lab-${var.lab_id}-config-delivery"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetBucketAcl", "s3:ListBucket"], Resource = local.config_bucket_arn },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${local.config_bucket_arn}/AWSLogs/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "config_delivery" {
  role       = aws_iam_role.config.name
  policy_arn = aws_iam_policy.config_delivery.arn
}

resource "aws_config_configuration_recorder" "lab" {
  name     = "lab-${var.lab_id}-recorder"
  role_arn = aws_iam_role.config.arn
  recording_group {
    all_supported                 = false
    include_global_resource_types = false
    resource_types                = ["AWS::EC2::SecurityGroup", "AWS::EC2::Instance"]
  }
}

resource "aws_config_delivery_channel" "lab" {
  name           = "lab-${var.lab_id}-channel"
  s3_bucket_name = aws_s3_bucket.config.bucket
  depends_on     = [aws_config_configuration_recorder.lab, aws_iam_role_policy_attachment.config_delivery]
}

resource "aws_config_configuration_recorder_status" "lab" {
  name       = aws_config_configuration_recorder.lab.name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.lab]
}

resource "aws_config_config_rule" "restricted_ssh" {
  name = "lab-${var.lab_id}-restricted-ssh"
  source {
    owner             = "AWS"
    source_identifier = "INCOMING_SSH_DISABLED"
  }
  scope {
    compliance_resource_types = ["AWS::EC2::SecurityGroup"]
  }
  depends_on = [aws_config_configuration_recorder_status.lab]
}

resource "aws_iam_role" "remediation" {
  name                 = "lab-${var.lab_id}-remediation"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ssm.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "remediation_managed" {
  role       = aws_iam_role.remediation.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonSSMAutomationRole"
}

resource "aws_iam_policy" "remediation" {
  name = "lab-${var.lab_id}-remediation"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ec2:DescribeSecurityGroups", "ec2:RevokeSecurityGroupIngress"], Resource = "*" }]
  })
}

resource "aws_iam_role_policy_attachment" "remediation" {
  role       = aws_iam_role.remediation.name
  policy_arn = aws_iam_policy.remediation.arn
}

resource "aws_config_remediation_configuration" "restricted_ssh" {
  config_rule_name           = aws_config_config_rule.restricted_ssh.name
  target_type                = "SSM_DOCUMENT"
  target_id                  = "AWS-DisablePublicAccessForSecurityGroup"
  resource_type              = "AWS::EC2::SecurityGroup"
  automatic                  = true
  maximum_automatic_attempts = 3
  retry_attempt_seconds      = 60
  parameter {
    name         = "AutomationAssumeRole"
    static_value = aws_iam_role.remediation.arn
  }
  parameter {
    name           = "GroupId"
    resource_value = "RESOURCE_ID"
  }
}

resource "aws_security_group" "demo" {
  name        = "lab-demo"
  description = "Empty and attached to nothing: open SSH here to watch Config remove it"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-demo" }
}
```

**`terraform/outputs.tf`**: as lab 01's, with `private_ips = { "vm-web1" = aws_instance.web[0].private_ip, "vm-web2" = aws_instance.web[1].private_ip }` and `connect = [ "aws ssm start-session --target ${aws_instance.web[0].id}", "aws ssm start-session --target ${aws_instance.web[1].id}", "aws ec2-instance-connect ssh --instance-id ${aws_instance.web[0].id} --os-user labadmin --connection-type eice", "ssh labadmin@${aws_instance.web[0].private_ip}" ]`, plus `peer_vpc_id` and `peer_route_table_ids` as the template's.

**`readme.md`** (exactly):
````markdown
Two Amazon Linux instances you manage without SSH: Systems Manager runs commands, opens shell sessions, scans for patches and keeps an inventory through private endpoints, and AWS Config watches the lab's security groups and removes SSH opened to the internet by itself. Everything is listed in the lab's resource group, `lab-soa-02-systems-manager`, in AWS Resource Groups (London).
From the SOA-C03 outline: manage instances with AWS Systems Manager (Run Command, Session Manager, Patch Manager, State Manager), evaluate compliance with AWS Config rules, and remediate automatically with Systems Manager Automation.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and no route to the internet: interface endpoints for `ssm`, `ssmmessages` and `ec2messages` carry Systems Manager's traffic, and an S3 gateway endpoint carries package downloads and patches
- `vm-web1` and `vm-web2`, t4g.micro Amazon Linux 2023 instances with no public IP, one in each subnet, with the role `lab-soa-02-systems-manager-ssm` (AmazonSSMManagedInstanceCore) and the tag `Patch Group = lab-soa-02-systems-manager-web`
- The patch baseline `lab-soa-02-systems-manager-al2023` (security updates rated Critical or Important) for that patch group, a State Manager association that scans both instances against it daily (`lab-soa-02-systems-manager-patch-scan`), and one that gathers their software inventory every 30 minutes (`lab-soa-02-systems-manager-inventory`)
- AWS Config: the recorder `lab-soa-02-systems-manager-recorder` (security groups and instances only), its delivery channel to the bucket `cloudlabs-a02…-config`, and the rule `lab-soa-02-systems-manager-restricted-ssh` (the managed rule restricted-ssh), which remediates automatically with the Automation document `AWS-DisablePublicAccessForSecurityGroup` under the role `lab-soa-02-systems-manager-remediation`
- `sg-demo` (`lab-demo`), an empty security group attached to nothing, for trying the remediation
- An EC2 Instance Connect Endpoint, `eice-lab`, if you want SSH as well

Sign in as `labadmin`; the password is behind **Show**. Session Manager needs no password: Systems Manager, Session Manager, Start session. AWS allows one Config recorder per region in an account: if the account already records Config in London, this lab cannot deploy until that recorder is turned off.

```text
lab-soa-02-systems-manager (London)
  vpc-lab (slot /20)
    snet-private-1: vm-web1 --+--> vpce-ssm, vpce-ssmmessages, vpce-ec2messages --> Systems Manager
    snet-private-2: vm-web2 --+    (Run Command, Session Manager, patch scan, inventory)
    vpce-s3 (packages and patches)
    sg-demo (empty) <-- watched by Config rule restricted-ssh --> remediation: remove 0.0.0.0/0 on 22
  Config recorder (security groups, instances) --> bucket cloudlabs-<prefix>-config
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Run Command: Systems Manager, Run Command, `AWS-RunShellScript`, target the tag `Patch Group` = `lab-soa-02-systems-manager-web`, command `uptime; dnf check-update --security | tail -n 5`. Read each instance's output in the console; Run Command itself is free.
- Open a shell on `vm-web1` with Session Manager (no SSH, no key, no open port), then compare it with the Instance Connect Endpoint and with `aws ssm start-session --target <instance id>` from the Connect lines.
- After the patch scan association has run (a few minutes after deploy), open Patch Manager and the Compliance page: which updates are missing, and which baseline decided that? Then run Patch now with Install on `vm-web2` only and compare the two instances.
- On `sg-demo`, add an inbound rule allowing TCP 22 from `0.0.0.0/0`. Within a few minutes Config marks `lab-soa-02-systems-manager-restricted-ssh` non-compliant and the automatic remediation removes the rule; follow it in Config's rule page and in Systems Manager, Automation, Executions. Each recorded change costs about 0.2p and each rule evaluation about 0.08p.
- Open Fleet Manager or Inventory and list the packages the inventory association collected; then on State Manager choose `lab-soa-02-systems-manager-inventory`, Apply association now, and read its execution history.

## Learn more

- [AWS Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html)
- [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [AWS Systems Manager Patch Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/patch-manager.html)
- [AWS Systems Manager State Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-state.html)
- [Improve the security of EC2 instances by using VPC endpoints for Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html)
- [restricted-ssh (AWS Config managed rule)](https://docs.aws.amazon.com/config/latest/developerguide/restricted-ssh.html)
- [Remediating noncompliant resources with AWS Config](https://docs.aws.amazon.com/config/latest/developerguide/remediation.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-02-systems-manager` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-02-systems-manager.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Manage EC2 instances with Systems Manager and let AWS Config fix open SSH by itself.
learn:
  - Run commands and open shell sessions with no SSH or public IP
  - Scan instances against a patch baseline and read their compliance
  - Remediate a noncompliant security group automatically with Config
learning_min: 60
```

**The diagram** must contain: the region container; `vnet vpc-lab` with `subnet snet-private-1` and `snet-private-2`; `vm vm-web1` in the first and `vm vm-web2` in the second; `bastion eice-lab`, `privateEndpoint vpce-ssm`, `vpce-ssmmessages`, `vpce-ec2messages` in `snet-private-1`; `privateEndpoint vpce-s3`, `nsg sg-eice`, `sg-vms`, `sg-endpoints`, `sg-demo`, `routeTable rt-private` in `vpc-lab`; `managedIdentity` nodes for the `ssm`, `config` and `remediation` roles, `storage cloudlabs-a02…-config`, and `generic` nodes for the patch baseline, the associations and the Config recorder, channel, rule and remediation in the region container (or folded where Task 9's rules fold them).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-02.test.mjs`:

```js
// labs-aws-soa-02.test.mjs
//
// Plain English: lab soa-02-systems-manager is AWS labs spec §12.2 row 02,
// built to the §4 contract, and the only lab with a Config recorder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_CONFIG_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "soa-02-systems-manager";

test("soa-02 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-02's lab.yaml: §12.2 row 02", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.monitoring", "soa.deployment", "soa.security"], ["soa-01-cloudwatch"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 4, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.micro"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.035 && total < 0.05, `about £0.04-0.05/h, got ${total}`);
  assert.ok(AWS_CONFIG_LABS.includes(ID));
});

test("soa-02 builds the SSM pieces and the Config rule with automatic remediation", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /for_each\s+= toset\(\["ssm", "ssmmessages", "ec2messages"\]\)/,
    /operating_system = "AMAZON_LINUX_2023"/, /patch_group = "lab-\$\{var\.lab_id\}-web"/,
    /name\s+= "AWS-RunPatchBaseline"/, /name\s+= "AWS-GatherSoftwareInventory"/,
    /name\s+= "lab-\$\{var\.lab_id\}-recorder"/, /resource_types\s+= \["AWS::EC2::SecurityGroup", "AWS::EC2::Instance"\]/,
    /source_identifier = "INCOMING_SSH_DISABLED"/, /target_id\s+= "AWS-DisablePublicAccessForSecurityGroup"/, /automatic\s+= true/,
    /resource "aws_security_group" "demo"/, /force_destroy = true/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /cidr_ipv4\s+= "0\.0\.0\.0\/0"[\s\S]{0,80}from_port\s+= 22/, "the lab never opens SSH itself");
});

test("soa-02's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**: `node --test scripts/test/labs-aws-soa-02.test.mjs` → FAIL (no lab folder).

- [ ] **Step 3: Write the lab** (files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf`).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-02-systems-manager.mjs` from `ctxAws("soa-02-systems-manager", "02")`, `templateResources(c)`, `awsData()`, `AWS_PROVIDER_CONFIG` and one entry per instance of every block in `ssm.tf` and `config.tf` (`aws_instance.web[0]` and `[1]` from `al2023Instance(c, { key: "web[0]", … })` with `count: 2`, the "Patch Group" tag and `user_data` referencing `local.cloud_init`; for_each endpoints with their three keys; IAM documents as known JSON strings; `aws_config_configuration_recorder.lab`, `aws_config_delivery_channel.lab` and `aws_config_configuration_recorder_status.lab` with their literal names), exactly the attributes each block sets.

- [ ] **Step 5: Generate the planned graph and the diagram**: `node scripts/labs-topology.mjs soa-02-systems-manager`, review against "The diagram" above, `npm run labs-diagrams`, add `GOLDEN["soa-02-systems-manager"]` from the generated graph and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**: `node --test scripts/test/labs-aws-soa-02.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, `npx vitest run worker/test/topology-golden.test.ts`, `npm run labs-check`, `npm run labs-tf -- soa-02-systems-manager`, `npm run labs-topology -- --check soa-02-systems-manager`, `npm run labs-diagrams -- --check` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-02-systems-manager labs/_learning/soa-02-systems-manager.yaml shared/topology/planned/soa-02-systems-manager.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-02 Systems Manager and Config auto-remediation

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 14: Lab soa-03-auto-scaling

Spec: §3.2 (this lab's lab.yaml is the spec's example), §12.2 row 03, §4, §7.4 (internet-facing ALB is public by nature), §9 (`whole_hours`), rulings A20, P3, P15. Not built here: none for this lab.

**Files:**
- Create: `labs/soa-03-auto-scaling/lab.yaml`, `readme.md`; `terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged from `labs/_template-aws/`), `variables.tf` (keeping `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `outputs.tf`, `public.tf`, `alb.tf`, `asg.tf` (below)
- Create: `labs/_learning/soa-03-auto-scaling.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-03-auto-scaling.mjs`, `scripts/test/labs-aws-soa-03.test.mjs`
- Create (generated): `shared/topology/planned/soa-03-auto-scaling.json`, `shared/guides/soa-03-auto-scaling/architecture.svg`, the `index.json`/`placement.json` entries
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-03-auto-scaling"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)

**Interfaces:**
- Consumes: as Task 13 (template, `common-aws.mjs`, `aws-content.mjs`, topology rules).
- Produces: the lab.

**`lab.yaml`** (§3.2's example with ruling P3's `creates: []`):
```yaml
# Lab soa-03 (AWS labs batch 1), the AWS labs spec's own example (§3.2).
# SOA-C03 ((V) against the current exam guide): Reliability and Business
# Continuity (scaling, load balancing, replacing unhealthy instances);
# Deployment, Provisioning, and Automation (launch templates, instance
# refresh); and SAA-C03's Design Resilient Architectures.
# London list prices × 0.75 (labs-verify --aws-prices). The ALB bills each
# started hour whole (V), so a session costs at least an hour of it (A20).
# It makes no IAM (ruling A33): identity.creates is [].
id: soa-03-auto-scaling
version: 1
cloud: aws
title: "Auto Scaling behind an Application Load Balancer"
summary: >-
  A launch template and an Auto Scaling group across two Availability Zones behind an internet-facing ALB, with
  target tracking, a scheduled action and a lifecycle hook, so you can watch AWS replace and scale instances.
exam: SOA-C03
skill_areas: [soa.reliability, soa.deployment, saa.resilient]
level: associate
type: explore
prerequisites: [soa-01-cloudwatch]
cost:
  items:
    - name: "EC2 t4g.micro, Linux (2 running)"
      gbp_h: 0.0071
      qty: 2
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "Application Load Balancer, hourly"
      gbp_h: 0.0199
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }
    - name: "Public IPv4 addresses on the ALB (2 AZs)"
      gbp_h: 0.0038
      qty: 2
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - { name: "EC2 Instance Connect Endpoint", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.micro, t4g.micro, t4g.micro, t4g.micro] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`terraform/public.tf`**
```hcl
# public.tf
#
# Plain English: the two public subnets lab 03's load balancer lives in, one
# per Availability Zone (the slot's /24s 8 and 9), with a route to an
# internet gateway. Nothing in them gets a public IP by default; only the
# internet-facing ALB has public addresses (public by nature, spec §7.4).

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "igw-lab" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = cidrsubnet(local.vpc_cidr, 4, 8 + count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-public-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.lab.id
  tags   = { Name = "rt-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.lab.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
```

**`terraform/alb.tf`**
```hcl
# alb.tf
#
# Plain English: lab 03's internet-facing Application Load Balancer. It takes
# HTTP on port 80 from anywhere and sends it to the group's instances, which
# admit port 80 only from the load balancer. Health checks every 15 seconds
# decide which instances get traffic; deregistration waits 30 seconds.

resource "aws_security_group" "alb" {
  name        = "lab-alb"
  description = "The load balancer: HTTP from the internet, HTTP on to the instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_vms" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "vms_http_alb" {
  security_group_id            = aws_security_group.vms.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "web" {
  name                       = "alb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = false
  tags                       = { Name = "alb-web" }
}

resource "aws_lb_target_group" "web" {
  name                 = "tg-${var.name_prefix}"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
  tags = { Name = "tg-web" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  tags = { Name = "listener-http" }
}
```

**`terraform/asg.tf`**
```hcl
# asg.tf
#
# Plain English: lab 03's instances. A launch template (Amazon Linux 2023,
# t4g.micro, IMDSv2, the lab's tags on instance, volume and network
# interface) and an Auto Scaling group of 2 to 4 across the two private
# subnets, registered with the ALB's target group and replaced when the ALB
# says unhealthy. Each instance serves a page naming itself and its zone
# with python3 (no packages to install). Scaling: target tracking at 50%
# CPU, a scheduled action back to two every evening, a launch lifecycle hook
# that holds new instances for 60 seconds, and rolling instance refresh when
# the template changes.

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 03 web page (this instance's id and zone) on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 300\") && for k in instance-id placement/availability-zone; do curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$k; echo; done > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  web_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_launch_template" "web" {
  name                   = "lt-${var.name_prefix}"
  image_id               = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.web_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tags = { Name = "lt-web" }
}

resource "aws_autoscaling_group" "web" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = aws_subnet.private[*].id
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 120
  force_delete              = true
  wait_for_capacity_timeout = "10m"

  launch_template {
    id      = aws_launch_template.web.id
    version = aws_launch_template.web.latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }
  tag {
    key                 = "cloudlabs-lab"
    value               = var.lab_id
    propagate_at_launch = true
  }
  tag {
    key                 = "Name"
    value               = "vm-web"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3]
}

resource "aws_autoscaling_policy" "cpu" {
  name                   = "cpu-50"
  autoscaling_group_name = aws_autoscaling_group.web.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 50
  }
}

resource "aws_autoscaling_schedule" "evening" {
  scheduled_action_name  = "evening-back-to-two"
  autoscaling_group_name = aws_autoscaling_group.web.name
  recurrence             = "0 22 * * *"
  time_zone              = "Europe/London"
  min_size               = 2
  max_size               = 4
  desired_capacity       = 2
}

resource "aws_autoscaling_lifecycle_hook" "launch" {
  name                   = "launch-wait"
  autoscaling_group_name = aws_autoscaling_group.web.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  heartbeat_timeout      = 60
  default_result         = "CONTINUE"
}
```

**`terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 03 is up. The group's
# instances come and go, so there are no fixed addresses: the Connect lines
# are the ALB's address and how to find an instance to connect to.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl http://${aws_lb.web.dns_name}",
    "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names ${aws_autoscaling_group.web.name} --query 'AutoScalingGroups[0].Instances[].InstanceId'",
    "aws ec2-instance-connect ssh --instance-id <an instance id from the group> --os-user labadmin --connection-type eice",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`readme.md`** (exactly):
````markdown
An Auto Scaling group of two to four small instances across two Availability Zones behind an internet-facing Application Load Balancer, so you can watch AWS keep a service running: it replaces unhealthy instances, scales on CPU, follows a schedule, holds new instances at a lifecycle hook and rolls out a new launch template. Everything is listed in the lab's resource group, `lab-soa-03-auto-scaling`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement scaling and load balancing with Amazon EC2 Auto Scaling and Elastic Load Balancing, and deploy with launch templates and instance refresh; from SAA-C03: design highly available architectures across Availability Zones.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets for the instances and two public subnets for the load balancer, an internet gateway, and an S3 gateway endpoint for packages
- The launch template `lt-a03…`: Amazon Linux 2023 on t4g.micro, IMDSv2, no public IP, and a small service that serves a page with the instance's id and Availability Zone on port 80
- The Auto Scaling group `asg-a03…`: at least 2 and at most 4 instances named `vm-web` across both private subnets, with ELB health checks (a failed check replaces the instance), a target tracking policy at 50% average CPU, the scheduled action `evening-back-to-two` (22:00 London time), the lifecycle hook `launch-wait` (60 seconds) and rolling instance refresh
- The internet-facing Application Load Balancer `alb-a03…` (HTTP on port 80 from anywhere), its target group `tg-a03…` and listener; the instances admit port 80 only from the load balancer
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH to an instance from the console

Sign in as `labadmin`; the password is behind **Show**. Open the first Connect line's address in a browser and refresh: the instance and zone change as the load balancer spreads requests.

```text
lab-soa-03-auto-scaling (London)
  internet --> alb-<prefix> (snet-public-1, snet-public-2) : HTTP 80
                 |  target group tg-<prefix>, health check /
  vpc-lab (slot /20)
    snet-private-1 (zone a): vm-web ... --+-- Auto Scaling group asg-<prefix> (2 to 4)
    snet-private-2 (zone b): vm-web ... --+   target tracking 50% CPU, schedule, lifecycle hook
    eice-lab (console SSH), vpce-s3 (packages)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Terminate one instance from the EC2 console and watch the group notice, launch a replacement, hold it at `launch-wait` (Pending:Wait) for 60 seconds, and add it back to the target group. With `aws autoscaling complete-lifecycle-action` you can release it sooner.
- Connect to both instances and run `yes > /dev/null &` on each: within about 10 minutes (basic 5-minute metrics) target tracking adds instances, up to four, and removes them once you `pkill yes`. Follow it in the group's Activity tab.
- Change the launch template (a new version with another `Description=` line in the service, or another instance size from the allowed t4g ones), then start an instance refresh and watch the rolling replacement keep at least half the group healthy.
- Edit the scheduled action to run five minutes from now with a desired capacity of 3 and watch it happen; then set it back.
- Stop the web service on one instance (`sudo systemctl stop lab-web`) and watch the target group mark it unhealthy and the group replace it. The load balancer bills its capacity units for traffic; light testing costs pennies.

## Learn more

- [Target tracking scaling policies for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html)
- [Scheduled scaling for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html)
- [Amazon EC2 Auto Scaling lifecycle hooks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/lifecycle-hooks.html)
- [Use an instance refresh to update instances in an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-instance-refresh.html)
- [Health checks for instances in an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-health-checks.html)
- [What is an Application Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-03-auto-scaling` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-03-auto-scaling.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Keep a web service running with an Auto Scaling group behind an Application Load Balancer.
learn:
  - Watch Auto Scaling replace unhealthy instances across two zones
  - Scale out and in with a target tracking policy on CPU
  - Roll out a new launch template with an instance refresh
learning_min: 60
```

**The diagram** must contain: the region container; `vnet vpc-lab` with four subnets (`snet-private-1`, `snet-private-2`, `snet-public-1`, `snet-public-2`); `vmss asg-a03…` in `snet-private-1` (launch template, policy, schedule and hook folded in); `loadBalancer alb-a03…` in `vpc-lab` (target group and listener folded in) with a traffic edge to the group labelled `HTTP 80`; `internetGateway igw-lab`; `routeTable rt-private`, `routeTable rt-public` (with a dependency edge to `igw-lab`); `bastion eice-lab`; `privateEndpoint vpce-s3`; `nsg sg-eice`, `sg-vms`, `sg-alb`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-03.test.mjs`:

```js
// labs-aws-soa-03.test.mjs
//
// Plain English: lab soa-03-auto-scaling is the AWS labs spec's own example
// (§3.2) and §12.2 row 03, built to the §4 contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-03-auto-scaling";

test("soa-03 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-03's lab.yaml is §3.2's example (identity.creates [] by ruling A33)", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "soa.deployment", "saa.resilient"], ["soa-01-cloudwatch"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 6, destroy_min: 6, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.micro", "t4g.micro", "t4g.micro"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.cost.items.map((i) => [i.name, i.gbp_h, i.qty ?? 1, !!i.whole_hours]), [
    ["EC2 t4g.micro, Linux (2 running)", 0.0071, 2, false],
    ["EBS gp3 root volume, 8 GiB", 0.0008, 2, false],
    ["Application Load Balancer, hourly", 0.0199, 1, true],
    ["ALB capacity units, light test traffic", 0.006, 1, false],
    ["Public IPv4 addresses on the ALB (2 AZs)", 0.0038, 2, false],
    ["EC2 Instance Connect Endpoint", 0, 1, false],
  ]);
});

test("soa-03 builds the group, template, ALB and its scaling settings; no IAM", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /min_size\s+= 2\n\s+max_size\s+= 4/, /health_check_type\s+= "ELB"/, /predefined_metric_type = "ASGAverageCPUUtilization"/,
    /recurrence\s+= "0 22 \* \* \*"/, /lifecycle_transition\s+= "autoscaling:EC2_INSTANCE_LAUNCHING"/, /strategy = "Rolling"/,
    /load_balancer_type\s+= "application"/, /enable_deletion_protection = false/, /internal\s+= false/,
    /key\s+= "cloudlabs-lab"\n\s+value\s+= var\.lab_id\n\s+propagate_at_launch = true/, /map_public_ip_on_launch = false/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /resource "aws_iam_/);
});

test("soa-03's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**: `node --test scripts/test/labs-aws-soa-03.test.mjs` → FAIL.

- [ ] **Step 3: Write the lab** (files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf`).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-03-auto-scaling.mjs` from `ctxAws("soa-03-auto-scaling", "03")`, `templateResources(c)`, `awsData()`, `AWS_PROVIDER_CONFIG` and one entry per instance of every block in `public.tf`, `alb.tf`, `asg.tf` (count instances `[0]`, `[1]`), exactly the attributes each block sets; the ASG has no `tags_all` (its `tag` blocks carry the lab tag), the launch template's `tag_specifications` hold `{ ...c.tags, Name: "vm-web" }` known at plan, and its `user_data` is unknown (it holds the password).

- [ ] **Step 5: Generate the planned graph and the diagram**: `node scripts/labs-topology.mjs soa-03-auto-scaling`, review against "The diagram" above, `npm run labs-diagrams`, add `GOLDEN["soa-03-auto-scaling"]` from the generated graph and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**: `node --test scripts/test/labs-aws-soa-03.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, `npx vitest run worker/test/topology-golden.test.ts`, `npm run labs-check`, `npm run labs-tf -- soa-03-auto-scaling`, `npm run labs-topology -- --check soa-03-auto-scaling`, `npm run labs-diagrams -- --check` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-03-auto-scaling labs/_learning/soa-03-auto-scaling.yaml shared/topology/planned/soa-03-auto-scaling.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-03 Auto Scaling behind an Application Load Balancer

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 15: Lab soa-04-backup

Spec: §12.2 row 04, §4, §7.3 rules 6, 8, 12 (Backup `recovery_point_tags`, `force_destroy`, the bucket name), §8.1 (Unblock empties the vault), rulings A4, P12, P15. Not built here: none for this lab.

**Files:**
- Create: `labs/soa-04-backup/lab.yaml`, `readme.md`; `terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (keeping `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `outputs.tf`, `compute.tf`, `backup.tf`, `s3.tf` (below)
- Create: `labs/_learning/soa-04-backup.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-04-backup.mjs`, `scripts/test/labs-aws-soa-04.test.mjs`
- Create (generated): `shared/topology/planned/soa-04-backup.json`, `shared/guides/soa-04-backup/architecture.svg`, the index/placement entries
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-04-backup"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)

**Interfaces:**
- Consumes: as Task 13.
- Produces: the lab.

**`lab.yaml`**
```yaml
# Lab soa-04 (AWS labs batch 1). SOA-C03 ((V) against the current exam
# guide): Reliability and Business Continuity (AWS Backup plans and vaults,
# EBS snapshots and restores, S3 versioning, lifecycle and replication);
# SAA-C03 Design Resilient Architectures. London list prices × 0.75.
# Authored: snapshot and backup storage ($0.053/GB-month), S3 for a few KB.
id: soa-04-backup
version: 1
cloud: aws
title: "Backup, snapshots, S3 versioning and replication"
summary: >-
  An AWS Backup plan and vault that back up a tagged EBS volume, a snapshot to restore from, and an S3 bucket with
  versioning and a lifecycle rule that replicates every version to a second bucket.
exam: SOA-C03
skill_areas: [soa.reliability, saa.resilient]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - name: "EC2 t4g.nano, Linux"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - name: "EBS gp3 data volume, 1 GiB"
      gbp_h: 0.0001
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 1, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "EBS snapshot and backups of the data volume", gbp_h: 0.0001 }
    - { name: "S3 Standard, two buckets with a few objects", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 6 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`terraform/compute.tf`**
```hcl
# compute.tf
#
# Plain English: lab 04's instance, vm-data (t4g.nano), with a 1 GiB gp3
# data volume tagged for the backup plan (cloudlabs-backup = daily) and
# mounted at /data, and a snapshot of that volume taken at deploy, to
# restore from.

resource "aws_instance" "data" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = [
      "for i in $(seq 1 60); do [ -e /dev/sdf ] && break; sleep 5; done",
      "blkid /dev/sdf || mkfs.xfs /dev/sdf",
      "mkdir -p /data",
      "mount /dev/sdf /data",
      "grep -q ' /data ' /etc/fstab || echo '/dev/sdf /data xfs defaults,nofail 0 2' >> /etc/fstab",
      "date -Is > /data/first-write.txt",
    ]
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-data" })
  tags        = { Name = "vm-data" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.azs[0]
  size              = 1
  type              = "gp3"
  tags              = { Name = "vol-data", "cloudlabs-backup" = "daily" }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.data.id
  stop_instance_before_detaching = true
}

resource "aws_ebs_snapshot" "data" {
  volume_id   = aws_ebs_volume.data.id
  description = "Lab soa-04: the data volume as it was at deploy"
  tags        = { Name = "snap-data" }
  depends_on  = [aws_volume_attachment.data]
}
```
(`volume_tags` and a separately managed `aws_ebs_volume` with its own `tags` can fight over the data volume's tags; `volume_tags` on `aws_instance` applies only to volumes created with the instance in provider 6.x (V). If the mock or real plan shows a perpetual tag diff on `vol-data`, move the root volume's tags into `root_block_device { tags = merge(var.tags, { Name = "vm-data" }) }` instead and record that in the task report.)

**`terraform/backup.tf`**
```hcl
# backup.tf
#
# Plain English: AWS Backup in lab 04. A vault of the lab's own (removable
# with its recovery points: Unblock deletes them first), a daily plan whose
# recovery points carry the lab's tags and expire after a day, and a
# selection of resources tagged cloudlabs-backup = daily that also belong to
# this lab, backed up by a role of the lab's own.

resource "aws_backup_vault" "lab" {
  name          = "lab-${var.lab_id}-vault"
  force_destroy = true
  tags          = { Name = "lab-vault" }
}

resource "aws_iam_role" "backup" {
  name                 = "lab-${var.lab_id}-backup"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each   = toset(["arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup", "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"])
  role       = aws_iam_role.backup.name
  policy_arn = each.key
}

resource "aws_backup_plan" "daily" {
  name = "lab-${var.lab_id}-daily"
  rule {
    rule_name           = "daily"
    target_vault_name   = aws_backup_vault.lab.name
    schedule            = "cron(0 5 ? * * *)"
    start_window        = 60
    completion_window   = 120
    recovery_point_tags = var.tags
    lifecycle {
      delete_after = 1
    }
  }
  tags = { Name = "lab-daily" }
}

resource "aws_backup_selection" "tagged" {
  name         = "lab-${var.lab_id}-tagged"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = ["*"]
  selection_tag {
    type  = "STRINGEQUALS"
    key   = "cloudlabs-backup"
    value = "daily"
  }
  condition {
    string_equals {
      key   = "aws:ResourceTag/cloudlabs-lab"
      value = var.lab_id
    }
  }
}
```

**`terraform/s3.tf`**
```hcl
# s3.tf
#
# Plain English: lab 04's buckets, cloudlabs-<name_prefix>-src and -dst,
# private, versioned and removable with every version (force_destroy). The
# source has a lifecycle rule (current objects to Standard-IA after 30 days,
# old versions gone after 30) and replicates every object and delete marker
# to the destination, through a role and policy of the lab's own whose
# documents name the buckets by their ARNs, known at plan (ruling A42).

locals {
  src_bucket = "cloudlabs-${var.name_prefix}-src"
  dst_bucket = "cloudlabs-${var.name_prefix}-dst"
  src_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-src"
  dst_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-dst"
}

resource "aws_s3_bucket" "src" {
  bucket        = local.src_bucket
  force_destroy = true
  tags          = { Name = "src" }
}

resource "aws_s3_bucket" "dst" {
  bucket        = local.dst_bucket
  force_destroy = true
  tags          = { Name = "dst" }
}

resource "aws_s3_bucket_public_access_block" "src" {
  bucket                  = aws_s3_bucket.src.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "dst" {
  bucket                  = aws_s3_bucket.dst.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "src" {
  bucket = aws_s3_bucket.src.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "dst" {
  bucket = aws_s3_bucket.dst.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "src" {
  bucket = aws_s3_bucket.src.id
  rule {
    id     = "tidy"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.src]
}

resource "aws_iam_role" "replication" {
  name                 = "lab-${var.lab_id}-replication"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "replication" {
  name = "lab-${var.lab_id}-replication"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = local.src_arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${local.src_arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${local.dst_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

resource "aws_s3_bucket_replication_configuration" "src" {
  bucket = aws_s3_bucket.src.id
  role   = aws_iam_role.replication.arn
  rule {
    id     = "all"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.dst.arn
      storage_class = "STANDARD"
    }
  }
  depends_on = [aws_s3_bucket_versioning.src, aws_s3_bucket_versioning.dst, aws_iam_role_policy_attachment.replication]
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.src.id
  key          = "hello.txt"
  content      = "first version\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_replication_configuration.src]
}
```

**`terraform/outputs.tf`**: `private_ips = { "vm-data" = aws_instance.data.private_ip }`; `connect = [ "aws ec2-instance-connect ssh --instance-id ${aws_instance.data.id} --os-user labadmin --connection-type eice", "ssh labadmin@${aws_instance.data.private_ip}", "aws s3api list-object-versions --bucket ${aws_s3_bucket.src.bucket} --prefix hello.txt" ]`; `peer_vpc_id`, `peer_route_table_ids` as the template's (header comment as lab 01's).

**`readme.md`** (exactly):
````markdown
Backups three ways: an AWS Backup plan and vault that back up a tagged EBS volume, a snapshot of that volume to restore from, and S3 versioning with a lifecycle rule and replication of every version to a second bucket. Everything is listed in the lab's resource group, `lab-soa-04-backup`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement backup and restore with AWS Backup, EBS snapshots and S3 versioning, lifecycle and replication; from SAA-C03: design resilient storage.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and an S3 gateway endpoint
- `vm-data`, a t4g.nano Amazon Linux 2023 instance with no public IP, and `vol-data`, a 1 GiB gp3 volume attached as `/dev/sdf` and mounted at `/data`, with a file written at deploy (`/data/first-write.txt`)
- `snap-data`, a snapshot of `vol-data` taken at deploy
- The backup vault `lab-soa-04-backup-vault`, the plan `lab-soa-04-backup-daily` (daily at 05:00 UTC, recovery points kept one day and tagged for the lab) and the selection `lab-soa-04-backup-tagged`, which backs up this lab's resources tagged `cloudlabs-backup = daily` with the role `lab-soa-04-backup-backup`
- Two private buckets, `cloudlabs-a04…-src` and `cloudlabs-a04…-dst`, both versioned; the source has the lifecycle rule `tidy` (current objects to Standard-IA after 30 days, old versions removed after 30 days) and replicates every object and delete marker to the destination with the role `lab-soa-04-backup-replication`. `hello.txt` is the first object
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH from the console

Sign in as `labadmin`; the password is behind **Show**. Restores and copies you make by hand are yours to tag: give them `cloudlabs-lab = soa-04-backup` (the console asks for tags when you restore) so tear-down removes them too.

```text
lab-soa-04-backup (London)
  vpc-lab (slot /20)
    snet-private-1: vm-data (t4g.nano) + vol-data (1 GiB, /data) --> snap-data
                    eice-lab (console SSH), vpce-s3
  AWS Backup: plan lab-<id>-daily --> selection (tag cloudlabs-backup = daily) --> vault lab-<id>-vault
  S3: cloudlabs-<prefix>-src (versioned, lifecycle tidy) --replication--> cloudlabs-<prefix>-dst (versioned)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- In AWS Backup start an on-demand backup of `vol-data` into `lab-soa-04-backup-vault` and wait for it to complete. Then restore it to a new volume (add the tag `cloudlabs-lab = soa-04-backup`), attach it to `vm-data` as `/dev/sdg`, mount it read-only and compare `first-write.txt`. Restores are charged by the GB; this one is 1 GiB.
- Create a volume from `snap-data` in the same zone (tagged for the lab), attach and mount it, and see what was on the disk at deploy compared with what you have written since.
- Upload a new `hello.txt` to the source bucket twice, then list its versions (the third Connect line) and restore an old version by copying it over the current one. Check that each version also appears in the destination bucket, with its replication status.
- Delete `hello.txt` in the source bucket: a delete marker is added, and it replicates too. Remove the delete marker and the object is back. Then read the lifecycle rule and work out when a current object would move to Standard-IA.
- Change the backup plan's lifecycle or schedule, or add a second rule, and see how the next backup job follows it. Tear-down removes every recovery point in the vault first, so the vault can go.

## Learn more

- [What is AWS Backup?](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- [Assigning resources to a backup plan](https://docs.aws.amazon.com/aws-backup/latest/devguide/assigning-resources.html)
- [Amazon EBS snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html)
- [Retaining multiple versions of objects with S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)
- [Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [Replicating objects within and across Regions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-04-backup` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-04-backup.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Back up and restore an EBS volume and S3 objects with AWS Backup, snapshots and versioning.
learn:
  - Run an on-demand backup and restore it to a new volume
  - Recover an overwritten or deleted object with S3 versioning
  - See every version and delete marker replicate to a second bucket
learning_min: 50
```

**The diagram** must contain: the region container; `vnet vpc-lab` with two subnets; `vm vm-data` in `snet-private-1` (its volume, attachment and snapshot folded in); `bastion eice-lab`; `privateEndpoint vpce-s3`; `nsg sg-eice`, `sg-vms`; `routeTable rt-private`; `recoveryVault lab-soa-04-backup-vault` (plan and selection folded in); `storage cloudlabs-a04…-src` and `storage cloudlabs-a04…-dst` with a `replicates` edge from src to dst; `managedIdentity` nodes for the backup and replication roles.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-04.test.mjs`:

```js
// labs-aws-soa-04.test.mjs
//
// Plain English: lab soa-04-backup is AWS labs spec §12.2 row 04, built to
// the §4 contract, and leaves nothing a tear-down cannot remove.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-04-backup";

test("soa-04 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-04's lab.yaml: §12.2 row 04", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "saa.resilient"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 5, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total < 0.01, `about £0.005/h (tier £), got ${total}`);
});

test("soa-04 makes everything removable: vault and buckets force-destroyed, recovery points tagged, no vault lock or object lock", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /resource "aws_backup_vault" "lab" \{\n\s+name\s+= "lab-\$\{var\.lab_id\}-vault"\n\s+force_destroy = true/,
    /recovery_point_tags = var\.tags/, /key\s+= "aws:ResourceTag\/cloudlabs-lab"\n\s+value = var\.lab_id/,
    /bucket\s+= local\.src_bucket\n\s+force_destroy = true/, /bucket\s+= local\.dst_bucket\n\s+force_destroy = true/,
    /delete_marker_replication \{\n\s+status = "Enabled"/, /storage_class = "STANDARD_IA"/, /"cloudlabs-backup" = "daily"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /object_lock|vault_lock/);
  // Policy documents name the buckets by ARNs known at plan (A42), never aws_s3_bucket.<x>.arn.
  assert.match(tf, /Resource = local\.src_arn/);
  assert.match(tf, /Resource = "\$\{local\.dst_arn\}\/\*"/);
});

test("soa-04's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**: `node --test scripts/test/labs-aws-soa-04.test.mjs` → FAIL.

- [ ] **Step 3: Write the lab** (files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf`).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-04-backup.mjs` from `ctxAws("soa-04-backup", "04")`, `templateResources(c)`, `awsData()`, `AWS_PROVIDER_CONFIG` and one entry per instance of every block in `compute.tf`, `backup.tf`, `s3.tf` (the attachment `for_each` with its two policy ARNs), exactly the attributes each block sets; `aws_backup_plan.daily`'s `rule` carries `recovery_point_tags: c.tags` (known), the replication policy JSON is known.

- [ ] **Step 5: Generate the planned graph and the diagram**: `node scripts/labs-topology.mjs soa-04-backup`, review against "The diagram", `npm run labs-diagrams`, add `GOLDEN["soa-04-backup"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**: `node --test scripts/test/labs-aws-soa-04.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, `npx vitest run worker/test/topology-golden.test.ts`, `npm run labs-check`, `npm run labs-tf -- soa-04-backup`, `npm run labs-topology -- --check soa-04-backup`, `npm run labs-diagrams -- --check` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-04-backup labs/_learning/soa-04-backup.yaml shared/topology/planned/soa-04-backup.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-04 Backup, snapshots, S3 versioning and replication

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 16: Lab soa-05-rds

Spec: §12.2 row 05, §4, §7.3 rules 12 and 13 (RDS no-lingering settings, `db.t4g.micro`), §15 "Lab 05 Performance Insights", rulings P4, P10, P15. Not built here: none for this lab.

**Files:**
- Create: `labs/soa-05-rds/lab.yaml`, `readme.md`; `terraform/versions.tf`, `main.tf`, `network.tf` (copied unchanged), `variables.tf` (keeping `lab_id`, `name_prefix`, `address_space`, `gateway_cidr`, `admin_password`, `tags`, `region`), `outputs.tf`, `database.tf`, `client.tf` (below)
- Create: `labs/_learning/soa-05-rds.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-05-rds.mjs`, `scripts/test/labs-aws-soa-05.test.mjs`
- Create (generated): `shared/topology/planned/soa-05-rds.json`, `shared/guides/soa-05-rds/architecture.svg`, the index/placement entries
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-05-rds"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)

**Interfaces:**
- Consumes: as Task 13.
- Produces: the lab.

**`lab.yaml`**
```yaml
# Lab soa-05 (AWS labs batch 1). SOA-C03 ((V) against the current exam
# guide): Reliability and Business Continuity (Multi-AZ failover, read
# replicas, snapshots); Monitoring and Performance (RDS metrics, slow query
# log); SAA-C03 Design High-Performing Architectures (read scaling).
# MySQL 8.4 (8.0 left standard support on 2026-07-31 and bills Extended
# Support) with Performance Insights off: not offered for MySQL on
# db.t4g.micro (V); the readme uses CloudWatch Database Insights standard
# mode, which is free (ruling A34). London list prices × 0.75 (V each
# filter: labs-verify --aws-prices soa-05-rds). RDS bills by the second.
id: soa-05-rds
version: 1
cloud: aws
title: "RDS MySQL: Multi-AZ failover, read replica, insights"
summary: >-
  A Multi-AZ RDS for MySQL database with a read replica, its own parameter group and a client instance, so you can
  force a failover, read from the replica, take a snapshot and find slow queries.
exam: SOA-C03
skill_areas: [soa.reliability, soa.monitoring, saa.performance]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - name: "RDS for MySQL db.t4g.micro, Multi-AZ (primary and standby)"
      gbp_h: 0.0270
      aws_price: { service: AmazonRDS, unit: Hrs, filters: { instanceType: db.t4g.micro, databaseEngine: MySQL, deploymentOption: Multi-AZ } }
    - name: "RDS for MySQL db.t4g.micro, read replica"
      gbp_h: 0.0135
      aws_price: { service: AmazonRDS, unit: Hrs, filters: { instanceType: db.t4g.micro, databaseEngine: MySQL, deploymentOption: Single-AZ } }
    - name: "RDS General Purpose (gp2) storage, 20 GiB, Multi-AZ"
      gbp_h: 0.0055
      aws_price: { service: AmazonRDS, unit: GB-Mo, gb: 20, filters: { productFamily: Database Storage, volumeType: General Purpose, databaseEngine: MySQL, deploymentOption: Multi-AZ } }
    - name: "RDS General Purpose (gp2) storage, 20 GiB, replica"
      gbp_h: 0.0027
      aws_price: { service: AmazonRDS, unit: GB-Mo, gb: 20, filters: { productFamily: Database Storage, volumeType: General Purpose, databaseEngine: MySQL, deploymentOption: Single-AZ } }
    - name: "EC2 t4g.nano, Linux (the client)"
      gbp_h: 0.0035
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "Automated backups and snapshots (inside the free backup storage)", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: []
  roles: []
  governance: false
```

**`terraform/database.tf`**
```hcl
# database.tf
#
# Plain English: lab 05's database. RDS for MySQL 8.4 on db.t4g.micro,
# Multi-AZ (a standby in the other subnet's zone), 20 GiB gp2, encrypted
# with AWS's own key, private, in a subnet group of the template's two
# subnets, with its own parameter group (slow query log on, 1 second) and a
# single-AZ read replica. Everything a tear-down needs is set: no final
# snapshot, no deletion protection, automated backups deleted, and the
# lab's tags copied onto any snapshot, by hand too (spec §7.3 rule 12).
# Performance Insights stays off (ruling A34). Port 3306 is open to the lab
# instances and, once peered, the VPN server's VPC.

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "MySQL from the lab's instances and, when peered, the gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_vms" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
}

resource "aws_vpc_security_group_ingress_rule" "db_from_gateway" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = var.gateway_cidr
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
}

resource "aws_db_subnet_group" "db" {
  name       = "lab-${var.lab_id}-db"
  subnet_ids = aws_subnet.private[*].id
  tags       = { Name = "lab-db" }
}

resource "aws_db_parameter_group" "mysql" {
  name   = "lab-${var.lab_id}-mysql84"
  family = "mysql8.4"
  parameter {
    name  = "slow_query_log"
    value = "1"
  }
  parameter {
    name  = "long_query_time"
    value = "1"
  }
  parameter {
    name  = "log_output"
    value = "FILE"
  }
  tags = { Name = "lab-mysql84" }
}

resource "aws_db_instance" "primary" {
  identifier                   = "db-${var.name_prefix}"
  engine                       = "mysql"
  engine_version               = "8.4"
  instance_class               = "db.t4g.micro"
  allocated_storage            = 20
  storage_type                 = "gp2"
  storage_encrypted            = true
  multi_az                     = true
  db_name                      = "labdb"
  username                     = "labadmin"
  password                     = var.admin_password
  db_subnet_group_name         = aws_db_subnet_group.db.name
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.mysql.name
  publicly_accessible          = false
  backup_retention_period      = 1
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-primary" }
}

resource "aws_db_instance" "replica" {
  identifier                   = "db-${var.name_prefix}-replica"
  replicate_source_db          = aws_db_instance.primary.identifier
  instance_class               = "db.t4g.micro"
  storage_type                 = "gp2"
  multi_az                     = false
  vpc_security_group_ids       = [aws_security_group.db.id]
  parameter_group_name         = aws_db_parameter_group.mysql.name
  publicly_accessible          = false
  backup_retention_period      = 0
  skip_final_snapshot          = true
  deletion_protection          = false
  delete_automated_backups     = true
  copy_tags_to_snapshot        = true
  performance_insights_enabled = false
  auto_minor_version_upgrade   = true
  apply_immediately            = true
  tags                         = { Name = "db-replica" }
}
```

**`terraform/client.tf`**
```hcl
# client.tf
#
# Plain English: vm-client, a t4g.nano Amazon Linux 2023 instance with the
# MySQL client (mariadb105, from the S3-hosted repositories through the
# gateway endpoint) and a ~/.my.cnf for labadmin that points mysql at the
# primary and, with --defaults-group-suffix=-replica, at the replica. The
# password is the session's, in user data like the login (ruling A12).

locals {
  my_cnf = join("\n", [
    "[client]",
    "host=${aws_db_instance.primary.address}",
    "user=labadmin",
    "password=${var.admin_password}",
    "database=labdb",
    "[client-replica]",
    "host=${aws_db_instance.replica.address}",
    "",
  ])
}

resource "aws_instance" "client" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/home/labadmin/.my.cnf", owner = "labadmin:labadmin", permissions = "0600", content = local.my_cnf, defer = true }]
    runcmd      = ["dnf install -y mariadb105"]
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-client" })
  tags        = { Name = "vm-client" }
  depends_on  = [aws_vpc_endpoint.s3]
}
```

**`terraform/outputs.tf`**: `private_ips = { "vm-client" = aws_instance.client.private_ip, "db-primary" = aws_db_instance.primary.address, "db-replica" = aws_db_instance.replica.address }`; `connect = [ "aws ec2-instance-connect ssh --instance-id ${aws_instance.client.id} --os-user labadmin --connection-type eice", "ssh labadmin@${aws_instance.client.private_ip}", "mysql -e 'SELECT @@hostname, @@version'", "mysql --defaults-group-suffix=-replica -e 'SHOW REPLICA STATUS\\G'" ]`; `peer_vpc_id`, `peer_route_table_ids` as the template's (header comment: "the two mysql lines run on vm-client").

**`readme.md`** (exactly):
````markdown
A Multi-AZ RDS for MySQL database with a read replica and a client instance to drive it: force a failover and time it, read from the replica and watch its lag, take a snapshot, and find slow queries with the slow query log. Everything is listed in the lab's resource group, `lab-soa-05-rds`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement high availability with Amazon RDS Multi-AZ, scale reads with read replicas, back up and restore with snapshots, and monitor database performance; from SAA-C03: design high-performing database solutions.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets in two Availability Zones, and an S3 gateway endpoint for packages
- `db-a05…` (shown as `db-primary`), RDS for MySQL 8.4 on db.t4g.micro, Multi-AZ, 20 GiB of General Purpose storage, encrypted, not public, in the subnet group `lab-soa-05-rds-db`, with automated backups kept for a day
- `db-a05…-replica` (shown as `db-replica`), a single-AZ read replica of it
- The parameter group `lab-soa-05-rds-mysql84`: the slow query log on, for statements over one second
- `vm-client`, a t4g.nano Amazon Linux 2023 instance with no public IP and the MySQL client; its `~/.my.cnf` points `mysql` at the primary and `mysql --defaults-group-suffix=-replica` at the replica
- The security group `lab-db` (MySQL on 3306 from the lab's instances and, when peered, the VPN server's VPC) and an EC2 Instance Connect Endpoint, `eice-lab`

The database user is `labadmin` with the session password (behind **Show**). Performance Insights is not offered for MySQL on db.t4g.micro, so use CloudWatch Database Insights in its free standard mode and the RDS metrics instead. Deploying takes about 20 minutes: Multi-AZ and the replica each take a while.

```text
lab-soa-05-rds (London)
  vpc-lab (slot /20)
    snet-private-1 (zone a): vm-client (mysql) ---3306---> db-primary (Multi-AZ, primary)
                             eice-lab (console SSH)          |  synchronous standby in zone b
    snet-private-2 (zone b): standby                         |  asynchronous replication
                             db-replica (read replica) <-----+
    vpce-s3 (packages)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- On `vm-client`, create a table and add rows (`mysql -e "CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, at DATETIME); INSERT INTO t (at) VALUES (NOW());"`), then read them back from the replica with `mysql --defaults-group-suffix=-replica -e "SELECT COUNT(*) FROM t"` and check `Seconds_Behind_Source` in `SHOW REPLICA STATUS`.
- Force a failover: `aws rds reboot-db-instance --db-instance-identifier <the primary's identifier> --force-failover`, or Reboot with failover in the console. Run `dig +short <the primary's endpoint>` and a loop of `mysql -e "SELECT NOW()"` on `vm-client` to see the address change and how long writes stop.
- Run `mysql -e "SELECT SLEEP(2)"` a few times, then read the slow query log in the console (the database, Logs and events). Change `long_query_time` in `lab-soa-05-rds-mysql84` and see it apply without a reboot.
- Take a manual snapshot of the primary. Because the database copies its tags to snapshots, the snapshot carries `cloudlabs-lab = soa-05-rds` and tear-down removes it; a snapshot restored to a new database is yours to tag the same way.
- Open the database's Monitoring tab and CloudWatch Database Insights (standard mode): compare CPU, connections and replica lag on the primary and the replica while you run the inserts above in a loop.

## Learn more

- [Multi-AZ DB instance deployments for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [Working with DB instance read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Parameter groups for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithParamGroups.html)
- [Creating a DB snapshot for a Single-AZ DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateSnapshot.html)
- [Rebooting a DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RebootInstance.html)
- [Monitoring Amazon RDS with CloudWatch Database Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Database-Insights.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-05-rds` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-05-rds.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Run MySQL on RDS with a Multi-AZ standby and a read replica, then fail it over on purpose.
learn:
  - Force a Multi-AZ failover and measure how long writes stop
  - Read from a replica and check its replication lag
  - Find slow queries with a parameter group and the slow query log
learning_min: 60
```

**The diagram** must contain: the region container; `vnet vpc-lab` with two subnets; `vm vm-client` and `bastion eice-lab` in `snet-private-1`; `sqlServer db-primary` and `sqlServer db-replica` in `vpc-lab` (subnet and parameter groups folded in) with a `replicates` edge from primary to replica; `privateEndpoint vpce-s3`; `nsg sg-eice`, `sg-vms`, `sg-db`; `routeTable rt-private`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-05.test.mjs`:

```js
// labs-aws-soa-05.test.mjs
//
// Plain English: lab soa-05-rds is AWS labs spec §12.2 row 05, built to the
// §4 contract, with every RDS setting a tear-down needs (§7.3 rule 12).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-05-rds";

test("soa-05 keeps the AWS lab contract", () => assert.deepEqual(commonAwsProblems(ID), []));

test("soa-05's lab.yaml: §12.2 row 05", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", ["soa.reliability", "soa.monitoring", "saa.performance"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 20, destroy_min: 15, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano"] });
  assert.deepEqual(yaml.identity.creates, []);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.06, `about £0.05/h, got ${total}`);
});

test("both databases are removable and small (rules 12 and 13), MySQL 8.4, Performance Insights off (A34)", () => {
  const { tf } = awsLab(ID);
  for (const db of ["primary", "replica"]) {
    const block = tf.slice(tf.indexOf(`resource "aws_db_instance" "${db}"`), tf.indexOf("\n}\n", tf.indexOf(`resource "aws_db_instance" "${db}"`)));
    for (const re of [/skip_final_snapshot\s+= true/, /deletion_protection\s+= false/, /delete_automated_backups\s+= true/, /copy_tags_to_snapshot\s+= true/, /instance_class\s+= "db\.t4g\.micro"/, /performance_insights_enabled = false/, /publicly_accessible\s+= false/]) assert.match(block, re, `${db}: ${re}`);
  }
  assert.match(tf, /engine_version\s+= "8\.4"/);
  assert.match(tf, /family = "mysql8\.4"/);
  assert.match(tf, /multi_az\s+= true/);
  assert.match(tf, /replicate_source_db\s+= aws_db_instance\.primary\.identifier/);
  assert.doesNotMatch(tf, /enabled_cloudwatch_logs_exports|max_allocated_storage/);
});

test("soa-05's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**: `node --test scripts/test/labs-aws-soa-05.test.mjs` → FAIL.

- [ ] **Step 3: Write the lab** (files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf`).

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-05-rds.mjs` from `ctxAws("soa-05-rds", "05")`, `templateResources(c)`, `awsData()`, `AWS_PROVIDER_CONFIG` and one entry per block in `database.tf` and `client.tf`, exactly the attributes each block sets (`password` is sensitive: put it under the fixture's sensitive paths as the Azure VM fixtures do for `admin_password`; `aws_instance.client`'s `user_data` is unknown).

- [ ] **Step 5: Generate the planned graph and the diagram**: `node scripts/labs-topology.mjs soa-05-rds`, review against "The diagram", `npm run labs-diagrams`, add `GOLDEN["soa-05-rds"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**: `node --test scripts/test/labs-aws-soa-05.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, `npx vitest run worker/test/topology-golden.test.ts`, `npm run labs-check`, `npm run labs-tf -- soa-05-rds`, `npm run labs-topology -- --check soa-05-rds`, `npm run labs-diagrams -- --check` → all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-05-rds labs/_learning/soa-05-rds.yaml shared/topology/planned/soa-05-rds.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-05 RDS MySQL: Multi-AZ failover, read replica, insights

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 17: Full gate, price check, spec rulings, PR and whole-branch review (controller)

The controller runs this task itself: it needs the local AWS admin keys (read-only calls only here) and the PR. Spec: §11, §14, §17.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 gains A31–A46: rulings P1–P16 of this plan, each with its reason, worded as the other rulings)
- Modify (only if a check below fails): the labs' `lab.yaml` cost items and readme links, `scripts/lib/aws-lab-policies.mjs`/`infra/aws-bootstrap/lab-abac.json`/`lab-policies.json` (Task 8, if the SAR could not be fetched there), `infra/ci/lab-scope-aws.mjs` `MANAGED_POLICIES`
- Create: the PR

- [ ] **Step 1: Generate what an implementer could not.** If Task 8 left `lab-abac.json` ungenerated: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render`, pin the hash in `scripts/test/aws-labs-iam.test.mjs`, run `node --test scripts/test/aws-labs-iam.test.mjs` (PASS), commit `chore(aws labs): generate the ABAC lists and the rendered policies`.

- [ ] **Step 2: Prices and links on the real services** (local keys, read only):
Run: `npm run labs-verify -- --aws-prices soa-01-cloudwatch soa-02-systems-manager soa-03-auto-scaling soa-04-backup soa-05-rds` and `npm run labs-verify -- --links soa-01-cloudwatch soa-02-systems-manager soa-03-auto-scaling soa-04-backup soa-05-rds`
Expected: no problems. A filter set that matches 0 or several products is fixed in `lab.yaml` (add the distinguishing attribute the error lists, or make the item authored-only), an authored figure more than 25% off is set to AWS's; a dead link is replaced by the page it moved to. The labs are still version 1 (new since `main`), so no bump. Record each answer for the batch report.

- [ ] **Step 3: The (V) facts B1 relies on** (local keys, read only; record each answer in the PR body under "V answers"):
  - `aws iam get-policy --policy-arn <each of MANAGED_POLICIES>`: all 14 exist (fix a path in `lab-scope-aws.mjs` and `aws-lab-policies.mjs` if not).
  - `aws ssm get-parameter --region eu-west-2 --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` and the same in eu-west-1: both answer.
  - `aws rds describe-orderable-db-instance-options --region eu-west-2 --engine mysql --engine-version 8.4 --db-instance-class db.t4g.micro --query "OrderableDBInstanceOptions[0].[SupportsPerformanceInsights,MultiAZCapable,ReadReplicaCapable,StorageType]"`: Multi-AZ and replicas capable (if 8.4 is not offered, use the newest offered 8.4.x as `engine_version` and its family).
  - `aws configservice describe-configuration-recorders --region eu-west-2`: no recorder (if one exists, lab 02 cannot deploy: note it in the PR and in its release test row; not a stop).
  - `aws service-quotas list-service-quotas --service-code ec2 --region eu-west-2 --query "Quotas[?contains(QuotaName, 'Instance Connect')].[QuotaCode,Value]"`: write the code into `LAB_QUOTAS` (Task 8) if it was left to look up.
  - `aws pricing get-products --region us-east-1 --service-code AmazonVPC --filters Type=TERM_MATCH,Field=regionCode,Value=eu-west-2 Type=TERM_MATCH,Field=productFamily,Value=VpcEndpoint --max-results 5`: the usage type behind `{usage}-VpcEndpoint-Hours` (Step 2 already proves it).

- [ ] **Step 4: Copy the rulings into the spec**: append A31–A46 to §17 (P1 → A31 … P16 → A46, each "**Ann. Title.** sentence. Reason."). Commit `docs(aws labs): batch 1 rulings A31-A46`.

- [ ] **Step 5: The full gate**
Run: `npm run typecheck && npm test && npm run build:web && npm run bundle-size && npm run labs-check -- --base origin/main && npm run labs-tf && npm run labs-topology -- --check && npm run labs-diagrams -- --check`
Expected: all PASS; the web entry grew by under 1 kB. Fix anything red test-first and commit.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/aws-labs
gh pr create --base main --title "AWS labs batch 1: engine + labs soa-01 to soa-05" --body "$(cat <<'EOF'
AWS hands-on labs, batch 1 (spec docs/superpowers/specs/2026-10-15-aws-labs-design.md §14 B1; plan docs/superpowers/plans/2026-10-15-aws-labs-batch1-plan.md).

- One catalogue and engine for both clouds: AWS ids, exams, lab.yaml fields, skill areas (SOA-C03, SAA-C03, ANS-C01)
- lab-aws.yml (same 16 steps as lab.yml) with per-step STS sessions, lint --cloud aws, lab-scope-aws.mjs, ready check, peering via wg-admin-deploy, unblock, tag-based safety net and real-state Verify clean
- Worker: dispatch by cloud, same-cloud peering, unpeer before an AWS server tear-down (A30), AWS orphan sweep, cost by lab tag, lab price feed, capacity, permission ticks
- IAM: wg-admin-labs (main only, 3-hour sessions), wg-admin-lab-boundary, generated ABAC lists within AWS's size caps, simulator checks; Worker read-only lab statements
- Labs tab: both clouds, Cloud filter, AWS badge and numbers, coverage by cloud, AWS modal, AWS diagrams and icons
- Labs soa-01 CloudWatch, soa-02 Systems Manager and Config, soa-03 Auto Scaling + ALB, soa-04 Backup, soa-05 RDS (all Untested until their release tests from main)

Rulings A31-A46 are in the spec's §17. V answers (pasted from Steps 2 and 3):

https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D
EOF
)"
gh pr checks --watch
```
Expected: CI green (the labs job runs labs-tf, labs-topology --check and labs-diagrams --check with terraform, hcl2json and jq).

- [ ] **Step 7: Whole-branch review**: dispatch one fresh reviewer on the most capable model with the spec, this plan and `git diff origin/main...feat/aws-labs`. Ask specifically about: the Review Focus list; `lab-scope-aws.mjs` (can a plan escape the lab?); the role and boundary policies (can the role touch `wg-admin=vpn`, IAM outside `/cloudlabs-lab/lab-*`, other regions, billing?); `lab-aws.yml`'s credentials per step and the live log's redaction; the safety net's order and its never-touch rules; same-cloud peering and A30; the two orphan sweeps sharing KV. Fix each finding test-first, re-run Step 5's gate, push, and wait for CI green.

---

### Task 18: Ship: bootstrap, merge, deploy, real-AWS release tests, headend-destroy check, record (controller)

The controller runs this task itself. Spec: §11 (release tests, spend), §13 (account changes), §14 (B1 test cycle, A24), §15 (peering and headend destroy). Budget: B1 aims at ≤ £3 of AWS spend; the whole AWS labs project may spend ≤ £15 (a projected overrun is a STOP). A change needed in `wg-aws.yml` or `infra/aws/**` is a STOP.

**Files:**
- Modify (after the tests): `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/soa-0{1..5}-*.json` (written by `lab-release-test.mjs`), the labs' plan fixtures if a recorded shape differs (with a version bump only if the lab's own folder changes), memories `aws-support.md`, `labs-feature.md`, `golive-versions.md`, `MEMORY.md` (one line each)

- [ ] **Step 1: Spend check.** `aws ce get-cost-and-usage --region us-east-1 --time-period Start=<first of month>,End=<today> --granularity MONTHLY --metrics UnblendedCost` (local keys). Expected B1 test spend: five single-pass release tests ≈ £0.20 (one hour minimum on the ALB and endpoints; RDS about 40 minutes), the peering check ≈ £0.10, retries ≤ £0.50: well under £3. If the month's AWS total plus £3 would pass the AWS labs project's £15 cap, STOP and report.

- [ ] **Step 2: Bootstrap the account** (local admin keys, from the PR branch: the role must exist before the tests).
Run: `node scripts/aws-bootstrap.mjs --labs`
Expected: Terraform creates `wg-admin-labs`, its `wg-admin-labs-<n>` policies (at most 10) and `wg-admin-lab-boundary`, and adds `LabsLook`/`LabsGlobalLook` to the Worker user; "GitHub secret set: AWS_LABS_ROLE_ARN"; all eight simulator cases print as wanted; quota requests filed for VPCs (20) and Elastic IPs (10) in eu-west-2 and eu-west-1 (vCPU and Instance Connect only if low); "Cost tag cloudlabs-lab: not seen in billing yet". A simulator mismatch is fixed in `scripts/lib/aws-lab-policies.mjs` (test-first, `node scripts/aws-labs-abac.mjs --render`), pushed to the PR, and the bootstrap run again.

- [ ] **Step 3: Merge and deploy.**

```bash
gh pr merge <PR number> --merge
git switch main && git pull
npm run deploy-worker
git checkout -- worker/src/build.ts
```
Expected: deploy prints the new Worker version id (no migration in B1). Write it, with the previous version as the rollback target, into memory `golive-versions.md`.

- [ ] **Step 4: Dashboard checks** (Steven's signed-in Chrome through the Claude in Chrome tools; if they are not available, do Steps 5 and 8 only and list these as "needs Steven's sign-in" in the report): Settings → Labs → Check permissions shows "AWS labs role" and "Lab boundary" ticked and "Cost tag active" as a warning; the Labs tab shows five AWS cards with the AWS badge, "AWS 1" to "AWS 5" and "Untested v1"; the Cloud filter and the coverage map's AWS heading work.

- [ ] **Step 5: Release tests from main**, cheapest first, one at a time (each always tears down):

```bash
node scripts/lab-release-test.mjs soa-04-backup --confirm-cost --ref main
node scripts/lab-release-test.mjs soa-01-cloudwatch --confirm-cost --ref main
node scripts/lab-release-test.mjs soa-03-auto-scaling --confirm-cost --ref main
node scripts/lab-release-test.mjs soa-02-systems-manager --confirm-cost --ref main
node scripts/lab-release-test.mjs soa-05-rds --confirm-cost --ref main
```
Expected: each row in `docs/labs/release-tests.md` reads pass, clean yes; each saves its plan shape. After each: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region eu-west-2` lists nothing that is not terminated or deleted. A failure: read the run's log, fix test-first on a `fix/aws-labs-<id>` branch (the lab's version rises to 2 if its folder changes; engine fixes need no bump), PR, CI green, merge, `npm run deploy-worker`, test again (A24). Record each deploy and destroy time against `deploy_min`/`destroy_min` and raise them in `lab.yaml` (with a version bump) when the real time is longer.

- [ ] **Step 6: Peering and the AWS server's tear-down** (dashboard, Steven's Chrome; §15's open question and A30). Deploy the VPN server in AWS (test VM off). Deploy `soa-01-cloudwatch` with **Peer to gateway**; wait until its peering reads on. Check with local keys: `aws ec2 describe-vpc-peering-connections --region eu-west-2 --filters Name=tag:cloudlabs-lab,Values=soa-01-cloudwatch` is `active`, and `rt-wg` has the slot's route to it. From a tunnel client (if one is at hand) `ssh labadmin@<vm-app's address>` answers. Then tear the server down from the dashboard. Expected: Activity shows the unpeer run for soa-01 dispatched before `wg-aws.yml`'s destroy; the destroy succeeds and its safety net says AWS clean; the lab's peering reads disconnected and Re-peer is offered for when an AWS server runs again. Record whether the unpeer run had finished before the destroy reached the VPC, and whether AWS would have deleted the VPC with the peering still there (from the destroy log). If the server's destroy failed because of the peering, STOP: the fix touches `wg-aws.yml`. Then tear the lab down and confirm Verify clean.

- [ ] **Step 7: Mark the versions released.** For each lab whose script test passed, press **Test** in Settings → Labs (Chrome) so `lab_release_tests` records it and the cards drop "Untested"; or, without the dashboard, note in the report that the cards stay "Untested" until Steven presses Test.

- [ ] **Step 8: Record and clean up.** Commit `docs/labs/release-tests.md` and the shapes on `chore/aws-labs-b1-release` (fixtures updated so `lab-plans.test.mjs` passes with the recorded shapes), PR, merge when green. Run `node scripts/aws-bootstrap.mjs --labs` once more at the end: if the cost tag now appears, it is activated; otherwise B2's plan starts with it. Confirm no leftovers: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab --region eu-west-2` and `--region eu-west-1` list only terminated or deleted items; `aws iam list-roles --path-prefix /cloudlabs-lab/` lists none. Record the month's AWS spend before and after. Update memories: `aws-support.md` (B1 live, Worker version, V answers, the A30 finding), `labs-feature.md` (AWS labs 01–05 released or not, with spend), `golive-versions.md`, and `MEMORY.md`'s index lines.

