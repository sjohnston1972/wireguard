# AWS labs batch 2 (labs 06–10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Labs `soa-06-cloudformation`, `soa-07-iam-kms`, `soa-08-vpc-fix`, `soa-09-route53-cloudfront` and `soa-10-containers` run in cloudlabs exactly as batch 1's do, and pass a real-AWS release test with `clean: true`, together with the engine parts they first need: a CloudFormation template reader, lab 07's IAM user, the global (CloudFront, Route 53) pieces, ECS/ECR and NAT, and every new type's clean-up.

**Architecture:** Batch 1's engine is unchanged in shape. The new work is lists and handlers: `lab-scope-aws.mjs` gains the batch's types, a `template` rule for CloudFormation (`cfnTemplateProblems`), a per-resource global-region rule, an instance-target allow-list and a resource-policy rule; `lab-lint.mjs --cloud aws` reads `terraform/cfn/*.yaml`; the ABAC generator stops putting delete/update verbs in the create list and the role gains lab 07's credential clean-up; the safety net and Verify clean gain a handler and a real-state read for each new type; the Worker reads a global lab's us-east-1 tags, keeps lab 07's password behind **Show** and ignores KMS keys waiting to delete. Each lab is a folder, a learning file, a planned topology, a plan fixture and a test file, in batch 1's lab-task shape.

**Tech Stack:** Terraform 1.14.6 with `hashicorp/aws ~> 6.0` (6.69.0 in the fixtures), `random`, `time`, `archive`; CloudFormation (YAML, long-form functions); AWS CLI v2 + jq + bash (pipeline scripts); node:test (`scripts/test`); Cloudflare Worker (TypeScript, vitest); Python 3.13 (lab 07's rotation Lambda, runs in AWS only).

**Spec:** `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (binding, rulings A1–A58; §12.2 rows 06–10, §14 item 2, §15). Section numbers below (§n) are that spec's. Batch 1's plan (`docs/superpowers/plans/2026-10-15-aws-labs-batch1-plan.md`) is the model for each task's shape; its code is on `main` (baa2ab2).

## Global Constraints

- Steven's standing go (memory `aws-labs-autonomy.md`): plan, build, merge, deploy, bootstrap re-apply, quota requests and real-AWS release tests without stops. STOP only for: a surprise; AWS test spend that would pass **£15 for the whole AWS labs project** (about £0.04 spent so far; batch 2 aims at ≤ £2); or **any change to the VPN server**: `infra/aws/**`, `infra/main.tf`, `infra/cloud-init.yaml.tftpl`, `.github/workflows/wg.yml`, `.github/workflows/wg-aws.yml`, or the `wg-admin-deploy` role (its policy in `infra/aws-bootstrap/main.tf`). No task in this plan touches any of them; a fix that seems to need one is a STOP, designed around, never made.
- Labs run in **eu-west-2** (London). us-east-1 is used only because CloudFront and Route 53 are global APIs that sign there (lab 09; no third provider block, ruling P7). Ireland is not used in batch 2.
- Azure behaviour and batch 1's AWS behaviour do not change except where a task names the change (the template's pinned providers and hub tag with soa-01..05's version bumps, P2; `lab-release-test --ref` default, P18; Unblock's RDS read, P18). Every existing test stays green unchanged except those this plan names.
- An AWS lab owns: everything tagged `cloudlabs-lab = <id>`; IAM roles, instance profiles, customer policies and (lab 07 only) users at path `/cloudlabs-lab/` named `lab-<id>-*`; S3 buckets `cloudlabs-<name_prefix>-*`; untaggable types named `lab-<id>-*` (A4); log groups `/cloudlabs/<id>/...` (A56).
- Every `aws` provider block is exactly §4's. Instances as batch 1 (AL2023 arm64, IMDSv2, `volume_tags`, no public IPv4, `labadmin` with the session password, console SSH through an Instance Connect Endpoint, a free S3 gateway endpoint). IAM documents with `jsonencode()` only (A42).
- Every batch 2 lab is designed to pass first time under A47–A58: tags at create (A49), create-needs-tag ABAC with its two exemptions (A54, A55) and no new one, log groups by name with Lambda `logging_config` (A56), service-linked roles made ahead by the bootstrap (A57), and a short wait before the first tag-checked change on a service not yet proven (P15).
- Never read or print `.env`. Subagents copy `.env.example` (never the real `.env`) and never use the AWS admin keys; only the controller runs `scripts/aws-bootstrap.mjs`, `npm run labs-verify -- --aws-prices`, read-only AWS checks and real-AWS release tests. Kill processes only by PID. Do not use `python3` on this Windows machine (tests needing Python+PyYAML, bash, jq or terraform skip with a reason when missing; CI has them all).
- Files start with the house header comment (`// path/file` then a `// Plain English: …` paragraph; `#` for shell, HCL, YAML and Python). Match the surrounding comment density and naming.
- Tests while building: only the targeted files (`node --test scripts/test/<file>`, `npx vitest run <files>`), plus `npm run typecheck` when TypeScript changes. The full gate runs once, in Task 12.
- No D1 migration in batch 2.
- Work on branch `feat/aws-labs-batch2` (this plan's branch, from `main` at baa2ab2). Commit after each task. Commit messages end with `Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`; PR bodies end with `https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D`.

## Plan rulings (copied into spec §17 as A59–A77 in Task 12)

- **P1 (A59). Delete and update verbs are never creates.** The Service Authorization Reference gives a few of them the request tag (`access-analyzer:DeleteAnalyzer`, `cloudformation:UpdateStack`, `cognito-idp:UpdateUserPool`, `states:UpdateStateMachine`, `logs:UpdateDeliveryConfiguration`), which put them in the create list, where any call without a request tag (every delete) is refused: lab 07 could make its analyzer and never remove it (batch 1 Task 8's deferred item). `abacLists` judges an action whose name starts `Delete|Update|Remove|Disassociate|Detach|Deregister|Cancel|Stop|Terminate|Revoke|Reset|Disable|Reject|Untag` as a change, never a create. apigateway's HTTP-verb actions (`DELETE`, `PATCH`) are left to batch 3's API Gateway lab.
- **P2 (A60). The AWS template pins every allowed provider and marks its VPC the hub.** `labs/_template-aws/versions.tf` declares `aws ~> 6.0`, `archive ~> 2.0`, `random ~> 3.7`, `time ~> 0.13` and `tls ~> 4.0` (batch 1 final review Minor 6: soa-04 resolved `time` unpinned), and `aws_vpc.lab` carries `cloudlabs-peer = "hub"` so a re-peer without outputs finds the hub of a two-VPC lab (A38; lab 08). Labs copy both files byte for byte, so soa-01..05 take them with a version bump each and are release-tested again in Task 13 (about £0.06).
- **P3 (A61). A lab that cannot peer and has no instances has no `network.tf`.** Labs 06, 07 and 09 (`peering: "off"`, `subnets_used: 0`) keep the template's `main.tf` and `versions.tf` only; `commonAwsProblems` requires `network.tf` (unchanged from the template) only when `connectivity.peering` is not `off`.
- **P4 (A62). Lab 06's CloudFormation.** The template is `terraform/cfn/stack.yaml`, read by `jsonencode(yamldecode(file(...)))`, so it uses the long form of every function (`Ref:`, `Fn::GetAtt:`; yamldecode knows no YAML tags) and reaches the plan as JSON. The stack runs under the lab's own bounded service role `lab-<id>-cfn` (`iam_role_arn`, a lab role by reference), so CloudFormation's own calls are the boundary's, not wg-admin-labs's ABAC. A new scope rule, `template`, refuses a stack with `template_url`, a name not `lab-<id>-*`, macros or IAM capabilities, no own service role, or a template (`cfnTemplateProblems`) with a type off `CFN_TYPES` (SNS topic, SQS queue, SSM parameter, log group, alarm), a `Transform`, `Fn::ImportValue`, a `DeletionPolicy`/`UpdateReplacePolicy` other than `Delete`, a named topic, queue or alarm (CloudFormation names them from the stack: `lab-<id>-stack-...`), or a log group or SSM parameter outside `/cloudlabs/<id>/`. `lab-lint --cloud aws` reads `cfn/*.yaml` too (rule `cfn`). StackSets stay readme-only (`never`). A stack that ends `DELETE_FAILED` is deleted again with `FORCE_DELETE_STACK`; what it leaves carries the stack's tags and goes by its own handler.
- **P5 (A63). Lab 07's console password stays behind Show.** AWS makes it (`aws_iam_user_login_profile`; a password cannot be chosen), `password_reset_required = false` (the boundary allows the user no IAM, so it could never be changed), and it travels in the sensitive `users` output (`name → "password <p> at <sign-in URL>"`), which lab-aws.yml masks and only `GET /labs/:id/secret` returns. The Worker's session view withholds the values of an AWS session's `users` (names only).
- **P6 (A64). Lab 07's user can always be deleted.** `Lab07UsersOther` gains `iam:UntagUser`, `DeleteAccessKey`, `UpdateAccessKey`, `DeleteSSHPublicKey`, `DeleteSigningCertificate`, `DeleteServiceSpecificCredential` and `DeactivateMFADevice` on `user/cloudlabs-lab/lab-soa-07-*` (batch 1 Task 5 deferred item), the user has `force_destroy = true` (scope rule `lingering`), and the safety net removes hand-made keys, MFA devices, SSH keys, signing certificates and service credentials before the user. Making an access key stays denied (`DenyAccountAndBilling`).
- **P7 (A65). Global regions are judged per resource; lab 09 needs no third provider.** CloudFront and Route 53 are global APIs the aws provider signs for us-east-1 itself, so lab 09's resources use the default provider. Spec §7.3 rule 1 is narrowed (batch 1 ledger): a resource whose own region is us-east-1 must be `aws_wafv2_*` with scope `CLOUDFRONT`, and one in us-west-2 `aws_globalaccelerator_*`, both only in `AWS_GLOBAL_LABS` (`GLOBAL_REGION_TYPES`). The Worker reads a global lab's us-east-1 tags for its resources panel and live diagram, drawing them in the lab's London container as the planned graph does.
- **P8 (A66). Lab 09's DNS and edge.** The public zone is `<name_prefix>.labs.clydeford.net`, never delegated (A27), enforced by the scope check; one HTTP health check (cost: P8 keeps it to one, §15 V) on a `/health.html` cache behaviour with caching off and HTTP allowed; health checks, records and distributions name only the lab's own distribution, zone and bucket by reference; `price_class = "PriceClass_100"`.
- **P9 (A67). Instance targets are an allow-list** (replacing A50's deny-list; batch 1 final review, parked). In any `{ key, values }` target of an SSM association, maintenance window target or task, or EventBridge run-command target, only: `InstanceIds` naming the lab's own `aws_instance` by reference; `WindowTargetIds` naming the lab's own window targets by reference; `tag:cloudlabs-lab` = exactly the lab id; another `tag:<key>` whose every value is a literal starting `lab-<id>-`; `resource-groups:Name` = `lab-<id>`. `tag:managed = terraform`, a resource group of someone else's or any other key is refused.
- **P10 (A68). Resource policies and Lambda permissions.** `aws_s3_bucket_policy`, `aws_sns_topic_policy`, `aws_sqs_queue_policy`, `aws_ecr_repository_policy`, `aws_secretsmanager_secret_policy` documents and `aws_kms_key` policies must be known at plan; an `Allow` statement never names `Principal "*"`, `{ AWS: "*" }` or an AWS principal outside the lab's own account (a `Deny` may). An `aws_lambda_permission`'s principal is an AWS service (`*.amazonaws.com`) and never a function URL with `NONE` auth (batch 1 Task 2 deferred item, "resource policies unread"). Rule `public`.
- **P11 (A69). A KMS key waiting to delete is not an orphan.** Every lab key is scheduled for deletion with a 7-day window (§15: no charge while pending), and the tagging API lists it all week; the Worker's AWS orphan sweep leaves `kms:key` ARNs out, while Verify clean still judges each key by its state (`PendingDeletion` is clean, anything else a leftover).
- **P12 (A70). ECS task definitions are deleted, not only deregistered.** Terraform deregisters (`INACTIVE`), which the tagging API lists for ever; the safety net deregisters any `ACTIVE` one and deletes every one (`DeleteTaskDefinitions`), and Verify clean counts only `DELETE_IN_PROGRESS` or not found as clean.
- **P13 (A71). The role's tenth policy is in use.** Batch 2's additions take the rendered role from 9 to 10 managed policies (an offline packing of the current lists gave 10 with the last at about 1,200 characters). `ROLE_POLICIES_MAX` stays 10; batch 1's "one spare" assertion becomes "fits in 10"; the bootstrap asks IAM for 20 "Managed policies per role" (`iam`/`L-0DA4ABF3`, us-east-1, V) so a later regeneration has room once AWS approves it.
- **P14 (A72). Access Analyzer: lab 07 only, account analyzer only.** AWS allows one account-level analyzer per type per region per account (quota, not adjustable), so only `ACCESS_ANALYZER_LABS = ["soa-07-iam-kms"]` may make `aws_accessanalyzer_analyzer`, with `type = "ACCOUNT"` (organization analyzers need Organizations; unused-access analyzers are paid).
- **P15 (A73). A short wait before the first tag-checked change on a service not yet proven.** A56 found CloudWatch Logs reading a new item's tag seconds late. Secrets Manager (`PutSecretValue`, `RotateSecret`), Lambda (`AddPermission`) and ECR (`PutLifecyclePolicy`) are judged by `aws:ResourceTag` right after the create, so labs 07 and 10 put a 20-second `time_sleep` between the create and that change. No new `CREATE_TAG_EXEMPT` entry is made. If a release test still fails with `AccessDenied` on such a change, Task 13's fallback adds the service to `TAG_LAG_NAMED` with its `lab-*` name pattern (every batch 2 item of those services is named `lab-<id>-*` so the fallback is available). KMS keys cannot be named, so lab 07 makes no tag-checked KMS change at deploy (no key rotation; the readme switches it on by hand).
- **P16 (A74). Lab 10 runs `public.ecr.aws/nginx/nginx:stable-alpine` on Fargate ARM64**; its ECR repository starts empty (pushing an image is a Thing to try). No capacity providers or service autoscaling (`PutClusterCapacityProviders`, `PutScalingPolicy` are tag-checked changes right after create; neither is in §12.2's row).
- **P17 (A75). Lab 08's faults are §12.2's three, verbatim**, and the data VPC's Instance Connect Endpoint sits in the database subnet, so the subnet's network ACL (fault 2) never stands between it and `vm-db` (NACLs do not filter traffic inside a subnet). `vm-db` is a t4g.micro (MariaDB wants the memory); `vm-web` a t4g.nano.
- **P18 (A76). Small batch 1 follow-ups.** `scripts/lab-release-test.mjs --ref` defaults to `main` (AWS's role trusts only main; batch 1 final review Minor 1). Unblock reads an RDS instance's `DeletionProtection` and changes it only when it is not already false (final review Minor 3: the modify left databases "modifying").
- **P19 (A77). CloudFormation-made items fold into their stack on the live diagram.** They carry the stack's tags (and `aws:cloudformation:stack-name`), so without this the live view would draw them as added by hand.

## Review Focus

1. **Tear-down of every new type with no Terraform state**, including a CloudFront distribution (disable, wait for Deployed, delete with the newest ETag, then its origin access control), a Route 53 zone holding records, and a CloudFormation stack stuck in `DELETE_FAILED`. Tests: Task 4 "CloudFront: disabled, waited for until Deployed, deleted with the new ETag, then its origin access control" and "a stack that ends DELETE_FAILED is force-deleted, and what it left goes by its own handler".
2. **A lab can always delete what it made**: no delete or update verb in the ABAC create list (DeleteAnalyzer), and lab 07's user with hand-made credentials still goes. Tests: Task 2 "P1: a delete or update that takes a request tag is a change, never a create" and "what labs 06–10 do is allowed: tagged creates, deletes of tagged items, lab 07's user and its hand-made credentials".
3. **A CloudFormation template cannot escape the lab**: a template with an IAM type, a nested stack, a custom resource, a `Transform`, `Fn::ImportValue`, `Retain`, a named queue, a log group outside `/cloudlabs/<id>/`, or a stack without its own service role is refused at plan, and the text forms at lint. Tests: Task 3 "template: refuses …" (one evil plan each) and "cfn: lint refuses short-form tags, Transform, IAM types, custom resources, Retain and literal CIDRs".
4. **Nothing reaches the VPN server through a global region or an instance target**: a lab 09 resource other than CloudFront WAF in us-east-1, an SSM target `tag:managed = terraform` or `tag:Name = vm-wg`, and someone else's resource group are refused, while soa-02's own targets still pass. Tests: Task 3 "provider: refuses a bucket in us-east-1 in lab 09" and "P9: the instance-target allow-list passes soa-02's targets and refuses every other selector".
5. **Lab 07's console password never leaves Show, and a pending KMS key is never an orphan**: the session view withholds AWS `users` values, `/labs/:id/secret` returns them, and the AWS sweep leaves `kms:key` out. Tests: Task 5 "an AWS session's users values are withheld outside /labs/:id/secret" and "a KMS key waiting to delete is never an orphan; other leftovers still are".

---

## File map

| Path | Status | Task |
|---|---|---|
| `labs/_template-aws/{versions,network}.tf`, `labs/soa-0{1..5}-*/terraform/{versions,network}.tf`, `labs/soa-0{1..5}-*/lab.yaml` (version), `labs/soa-04-backup/terraform/compute.tf` (comment) | modify | 1 |
| `scripts/test/fixtures/labs/aws-content.mjs`, `scripts/test/fixtures/labs/plans/common-aws.mjs`, `scripts/lab-release-test.mjs` | modify | 1 |
| `scripts/test/{labs-aws-template,lab-release}.test.mjs` | modify | 1 |
| `scripts/lib/aws-lab-policies.mjs`, `scripts/lib/aws-bootstrap-labs.mjs`, `infra/aws-bootstrap/{lab-abac,lab-policies}.json` (generated), `scripts/test/aws-labs-iam.test.mjs` | modify | 2 |
| `infra/ci/lab-scope-aws.mjs`, `infra/ci/lab-lint.mjs`, `labs/soa-01-cloudwatch/terraform/monitoring.tf` (topic policy known at plan) | modify | 3 |
| `scripts/test/fixtures/labs/plans/{extract-computed.mjs,computed.json,schema-facts.json}` (regenerated), `scripts/test/{lab-scope-aws,lab-lint}.test.mjs` | modify | 3 |
| `infra/ci/lab-aws-safety-net.sh`, `infra/ci/lab-unblock-aws.sh`, `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/aws-labs-iam.test.mjs` (CLI coverage) | modify | 4 |
| `worker/src/labs/{resources,awsTopology,view,orphans}.ts`, `worker/test/{labs-aws-reads,topology-aws}.test.ts`, `worker/test/labs-helpers.ts` | modify | 5 |
| `shared/topology/rules/awsPlanned.ts`, `shared/topology/{kinds,awsLive}.ts`, `worker/test/topology-aws.test.ts` | modify | 6 |
| `labs/soa-06-cloudformation/**`, `labs/_learning/soa-06-cloudformation.yaml`, `shared/topology/planned/soa-06-cloudformation.json`, `shared/guides/soa-06-cloudformation/**`, `scripts/test/fixtures/labs/plans/labs/soa-06-cloudformation.mjs`, `scripts/test/labs-aws-soa-06.test.mjs` | create | 7 |
| the same seven paths for `soa-07-iam-kms` | create | 8 |
| the same seven paths for `soa-08-vpc-fix` | create | 9 |
| the same seven paths for `soa-09-route53-cloudfront` | create | 10 |
| the same seven paths for `soa-10-containers` | create | 11 |
| `shared/guides/{index,placement}.json`, `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts` | modify | 7–11 |
| `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 A59–A77) | modify | 12 |
| `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/soa-*.json`, the labs' plan fixtures | modify | 13 |

## Order and dependencies

Tasks run one at a time, in number order. Engine tasks (1–6) come before the labs that need them (7–11).

| Task | Title | Depends on |
|---|---|---|
| 1 | Template providers and hub tag, `network.tf` only where a lab can peer, soa-01..05 bumped, release-test default ref | – |
| 2 | ABAC and IAM: no delete/update creates, lab 07's credentials, Access Analyzer's role, policy count and quota, simulator and evaluator cases | – |
| 3 | Lint and scope: CloudFormation reader, batch 2 types, global regions per resource, instance-target allow-list, resource policies | 1 |
| 4 | Unblock, safety net and Verify clean for batch 2's types | 2 |
| 5 | Worker: global labs' us-east-1 tags, lab 07's password behind Show, pending KMS keys not orphans | – |
| 6 | Topology: batch 2's types on the planned and live diagrams | – |
| 7 | Lab soa-06-cloudformation | 1, 3, 6 |
| 8 | Lab soa-07-iam-kms | 1, 2, 3, 5, 6 |
| 9 | Lab soa-08-vpc-fix | 1, 3, 6 |
| 10 | Lab soa-09-route53-cloudfront | 1, 3, 5, 6 |
| 11 | Lab soa-10-containers | 1, 3, 6 |
| 12 | Full gate, price and link checks, V answers, spec rulings, PR and whole-branch review (controller) | 1–11 |
| 13 | Ship: spend check, bootstrap re-apply, merge, deploy, release tests 06–10 and 01–05, record, recalibrate (controller) | 12 |

---

### Task 1: Template providers and hub tag, `network.tf` only where a lab can peer, soa-01..05 bumped, release-test default ref

Spec: §4 (providers, every lab has), §5 step 9 and A38 (the hub tag), §14 item 2; rulings P2, P3, P18.

**Files:**
- Modify: `labs/_template-aws/versions.tf` (required_providers), `labs/_template-aws/network.tf` (`aws_vpc.lab` tags)
- Modify: `labs/soa-0{1..5}-*/terraform/versions.tf` and `network.tf` (copied from the template, byte for byte), `labs/soa-0{1..5}-*/lab.yaml` (`version`: soa-01 2→3, soa-02 3→4, soa-03 2→3, soa-04 3→4, soa-05 2→3), `labs/soa-04-backup/terraform/compute.tf` (its header's last sentence about the unpinned `time` provider)
- Modify: `scripts/test/fixtures/labs/aws-content.mjs` (`network.tf` required only when the lab can peer), `scripts/test/fixtures/labs/plans/common-aws.mjs` (the hub tag; `templateMainResources`)
- Modify: `scripts/lab-release-test.mjs` (`--ref` default `main`; header comment)
- Test: `scripts/test/labs-aws-template.test.mjs`, `scripts/test/lab-release.test.mjs`

**Interfaces:**
- Produces: `templateMainResources(c)` in `common-aws.mjs` (the template's `main.tf` resources only: the resource group), for labs with no `network.tf` (Tasks 7, 8, 10). `commonAwsProblems(id, labsDir)` keeps its signature.

**`labs/_template-aws/versions.tf`** (the `terraform` block; the rest unchanged; the header's first paragraph gains "every allowed provider is pinned here, so a lab that uses time or archive resolves the same versions as the fixtures (ruling P2)"):
```hcl
terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
```

**`labs/_template-aws/network.tf`** (`aws_vpc.lab` only; the header gains "The VPC carries cloudlabs-peer = hub: a peer run without Terraform outputs finds a two-VPC lab's hub by it (ruling A38)."):
```hcl
resource "aws_vpc" "lab" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-lab", "cloudlabs-peer" = "hub" }
}
```

**`scripts/test/fixtures/labs/plans/common-aws.mjs`**: `templateResources`' `aws_vpc.lab` entry gets `tags: { Name: "vpc-lab", "cloudlabs-peer": "hub" }`, and below `templateResources`:
```js
/** labs/_template-aws/main.tf's resources only (the lab's resource group): a lab with no network.tf (ruling P3). */
export const templateMainResources = (c) => templateResources(c).filter((r) => r.address === "aws_resourcegroups_group.lab");
```

**`scripts/test/fixtures/labs/aws-content.mjs`**, in `commonAwsProblems`, replace the byte-copy loop:
```js
  for (const f of ["main.tf", "versions.tf"]) if (l.files[f] !== tplFiles[f]) out.push(`${f} differs from labs/_template-aws/${f}`);
  // Ruling P3: a lab that can peer starts from the template's network; one that cannot (and so has no instances) may
  // leave it out, but never change it.
  const canPeer = l.yaml.connectivity?.peering !== "off";
  if (l.files["network.tf"] !== undefined ? l.files["network.tf"] !== tplFiles["network.tf"] : canPeer) out.push(l.files["network.tf"] === undefined ? "network.tf is missing: a lab that can peer starts from labs/_template-aws/network.tf" : "network.tf differs from labs/_template-aws/network.tf");
```

**`scripts/lab-release-test.mjs`**: `parseArgs`' default becomes `ref: "main"`; the header's usage line reads `[--ref main]` and the paragraph after it gains "--ref defaults to main: lab-aws.yml's role trusts only main, and Azure labs are tested from main since labs batch 4 (ruling P18)."

- [ ] **Step 1: Write the failing tests.** Append to `scripts/test/labs-aws-template.test.mjs`:

```js
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { commonAwsProblems } from "./fixtures/labs/aws-content.mjs";

test("ruling P2: every allowed provider is pinned, and the VPC is the hub", () => {
  const v = readFileSync(join(DIR, "versions.tf"), "utf8");
  for (const [name, version] of [["aws", "~> 6.0"], ["archive", "~> 2.0"], ["random", "~> 3.7"], ["time", "~> 0.13"], ["tls", "~> 4.0"]]) {
    assert.match(v, new RegExp(`${name} = \\{\\s*source\\s+= "hashicorp/${name}"\\s*version = "${version.replace(/[.*~>]/g, (m) => `\\${m}`)}"`), name);
  }
  assert.match(readFileSync(join(DIR, "network.tf"), "utf8"), /tags\s+= \{ Name = "vpc-lab", "cloudlabs-peer" = "hub" \}/);
  assert.deepEqual(templateResources(ctxAws("soa-01-cloudwatch", "01")).find((r) => r.address === "aws_vpc.lab").values.tags, { Name: "vpc-lab", "cloudlabs-peer": "hub" });
});

test("ruling P3: a lab that cannot peer may leave network.tf out; one that can must keep it unchanged", () => {
  const LABS = fileURLToPath(new URL("../../labs/", import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), "aws-content-"));
  try {
    mkdirSync(join(tmp, "_learning"));
    for (const p of ["_template-aws", "soa-01-cloudwatch", "_learning/soa-01-cloudwatch.yaml"]) cpSync(join(LABS, p), join(tmp, p), { recursive: true });
    assert.deepEqual(commonAwsProblems("soa-01-cloudwatch", tmp), []);
    rmSync(join(tmp, "soa-01-cloudwatch", "terraform", "network.tf"));
    assert.ok(commonAwsProblems("soa-01-cloudwatch", tmp).includes("network.tf is missing: a lab that can peer starts from labs/_template-aws/network.tf"));
    const yamlPath = join(tmp, "soa-01-cloudwatch", "lab.yaml");
    writeFileSync(yamlPath, readFileSync(yamlPath, "utf8").replace(/connectivity: \{ peering: optional, dns_link: false, subnets_used: 1 \}/, 'connectivity: { peering: "off", dns_link: false, subnets_used: 0 }'));
    assert.ok(!commonAwsProblems("soa-01-cloudwatch", tmp).some((p) => p.startsWith("network.tf")));
    writeFileSync(join(tmp, "soa-01-cloudwatch", "terraform", "network.tf"), "# changed\n");
    assert.ok(commonAwsProblems("soa-01-cloudwatch", tmp).includes("network.tf differs from labs/_template-aws/network.tf"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

In `scripts/test/lab-release.test.mjs`, in "refuses an unknown lab id, and refuses to spend without --confirm-cost", add:
```js
  // Ruling P18: lab-aws.yml's role trusts only main, so main is the default.
  assert.equal(parseArgs(["az104-07-files", "--confirm-cost"], DEFS).ref, "main");
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/labs-aws-template.test.mjs scripts/test/lab-release.test.mjs`
Expected: FAIL (versions.tf has only aws; no hub tag; network.tf always required; ref is feat/labs).

- [ ] **Step 3: Make the changes** above: the template's two files; copy `versions.tf` and `network.tf` over each of soa-01..05's (`cp labs/_template-aws/{versions,network}.tf labs/<id>/terraform/`); bump each `lab.yaml` `version` (and nothing else in it); in `labs/soa-04-backup/terraform/compute.tf` replace the header's "(the time provider is hashicorp/time, resolved without a required_providers entry because the AWS template's versions.tf is copied unchanged)" with "(hashicorp/time, pinned in the template's versions.tf; ruling P2)"; `aws-content.mjs`, `common-aws.mjs`, `lab-release-test.mjs` as above.

- [ ] **Step 4: Run the targeted checks**

Run: `node --test scripts/test/labs-aws-template.test.mjs scripts/test/lab-release.test.mjs scripts/test/labs-aws-soa-01.test.mjs scripts/test/labs-aws-soa-02.test.mjs scripts/test/labs-aws-soa-03.test.mjs scripts/test/labs-aws-soa-04.test.mjs scripts/test/labs-aws-soa-05.test.mjs scripts/test/lab-plans.test.mjs`, then `npm run labs-check -- --base origin/main` and `npm run labs-tf -- soa-01-cloudwatch soa-04-backup`
Expected: all PASS (the recorded shapes still match: a tag value is not part of a plan's shape; labs-check sees the five version bumps).

- [ ] **Step 5: Commit**

```bash
git add labs/_template-aws labs/soa-01-cloudwatch labs/soa-02-systems-manager labs/soa-03-auto-scaling labs/soa-04-backup labs/soa-05-rds scripts/test scripts/lab-release-test.mjs
git commit -m "feat(aws labs): template pins every allowed provider and tags its VPC the hub; network.tf only where a lab can peer; release tests default to main

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 2: ABAC and IAM: no delete/update creates, lab 07's credentials, Access Analyzer's role, policy count and quota, simulator and evaluator cases

Spec: §7.1 (create and change lists, `Lab07Users`, service-linked list), §13 (quotas), §15 (ABAC gaps), rulings A19, A29, A46, A57, P1, P6, P13, P14.

**Files:**
- Modify: `scripts/lib/aws-lab-policies.mjs` (`NON_CREATE_VERB` in `abacLists`; `SERVICE_LINKED` gains `access-analyzer`; `Lab07UsersOther` gains seven actions)
- Modify: `scripts/lib/aws-bootstrap-labs.mjs` (eight simulator cases; `LAB_QUOTAS` gains IAM's managed-policies-per-role quota with its own region; `quotas()` reads each quota's regions)
- Regenerate: `infra/aws-bootstrap/lab-abac.json` (`node scripts/aws-labs-abac.mjs`, network, no credentials), `infra/aws-bootstrap/lab-policies.json` (`node scripts/aws-labs-abac.mjs --render`)
- Test: `scripts/test/aws-labs-iam.test.mjs`

**Interfaces:**
- Produces: `export const NON_CREATE_VERB: RegExp` (aws-lab-policies.mjs); `LAB_QUOTAS` entries may carry `regions: string[]` (default `AWS_LAB_REGIONS`). Task 4's clean-up calls rely on the regenerated policies; Task 8's lab relies on `Lab07UsersOther` and the analyzer's change-list delete.

**`scripts/lib/aws-lab-policies.mjs`**, above `abacLists`:
```js
/**
 * Ruling P1 (A59): verbs that never make anything. The reference gives a few of them the request tag
 * (access-analyzer:DeleteAnalyzer, cloudformation:UpdateStack, cognito-idp:UpdateUserPool, states:UpdateStateMachine,
 * logs:UpdateDeliveryConfiguration), which put them in the create list, where a call without a request tag (every
 * delete) is always refused: lab 07 could make an analyzer and never remove it. They are judged as changes instead.
 * apigateway's HTTP-verb actions (DELETE, PATCH) are left to batch 3's API Gateway lab.
 */
export const NON_CREATE_VERB = /^(Delete|Update|Remove|Disassociate|Detach|Deregister|Cancel|Stop|Terminate|Revoke|Reset|Disable|Reject|Untag)/;
```
and in `abacLists`, the two lines that decide a create become:
```js
      const maker = !NON_CREATE_VERB.test(a.Name);
      const onAction = maker && (a.ActionConditionKeys ?? []).includes(RT);
      const onTypes = maker ? res.filter((r) => (r.ConditionKeys ?? []).includes(RT)).map((r) => r.Name) : [];
```
(an action that is not a maker falls through to the change test below them, unchanged). The header's ABAC paragraph gains "A delete or update verb is never a create (ruling P1), whatever keys the reference lists for it."

`SERVICE_LINKED` (ruling P14: the account analyzer uses `AWSServiceRoleForAccessAnalyzer`; A57 makes it ahead):
```js
export const SERVICE_LINKED = ["elasticloadbalancing", "autoscaling", "rds", "elasticache", "ecs", "eks", "eks-nodegroup", "network-firewall", "globalaccelerator", "backup", "config", "remediation.config", "transitgateway", "vpc-lattice", "ssm", "ec2-instance-connect", "access-analyzer"].map(svc);
```

`Lab07UsersOther` (ruling P6):
```js
    allow("Lab07UsersOther", ["iam:DeleteUser", "iam:TagUser", "iam:UntagUser", "iam:CreateLoginProfile", "iam:DeleteLoginProfile", "iam:DeleteAccessKey", "iam:UpdateAccessKey", "iam:DeleteSSHPublicKey", "iam:DeleteSigningCertificate", "iam:DeleteServiceSpecificCredential", "iam:DeactivateMFADevice"], LAB07_USER),
```

**`scripts/lib/aws-bootstrap-labs.mjs`**: in `simulatorCases`, after `...ssmSettingCases(account),` and before `...defaultVpcCase(...)`:
```js
    // Batch 2 (labs 06–10).
    { name: "a lab 07 user under the boundary", action: "iam:CreateUser", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, context: bounded, want: "allowed" },
    { name: "a user for another lab", action: "iam:CreateUser", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-06-cloudformation-ann`, context: bounded, want: "denied" },
    { name: "remove a hand-made key from the lab 07 user", action: "iam:DeleteAccessKey", resource: `arn:aws:iam::${account}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`, context: [], want: "allowed" },
    { name: "delete the lab's analyzer", action: "access-analyzer:DeleteAnalyzer", resource: `arn:aws:access-analyzer:eu-west-2:${account}:analyzer/lab-soa-07-iam-kms-account`, context: [region, ctx(`aws:ResourceTag/${LAB_TAG}`, ["soa-07-iam-kms"])], want: "allowed" },
    { name: "an untagged CloudFormation stack", action: "cloudformation:CreateStack", resource: `arn:aws:cloudformation:eu-west-2:${account}:stack/lab-soa-06-x-stack/*`, context: [region], want: "denied" },
    { name: "a CloudFront distribution", action: "cloudfront:CreateDistribution", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"])], want: "allowed" },
    { name: "a Route 53 hosted zone", action: "route53:CreateHostedZone", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"])], want: "allowed" },
    { name: "an ECS cluster in us-east-1", action: "ecs:CreateCluster", resource: "*", context: [ctx("aws:RequestedRegion", ["us-east-1"]), ...labTag], want: "denied" },
```
`LAB_QUOTAS` gains a fifth entry, and the header's step 2 reads "reads the lab quotas (London and Ireland; IAM's in us-east-1) …":
```js
  // Ruling P13: the role holds 10 managed policies after batch 2; 20 leaves room for a regenerated reference (V: the code,
  // and that IAM's quota is adjustable to 20).
  { service: "iam", code: "L-0DA4ABF3", name: "Managed policies per role", want: 20, raise: "if-below", regions: ["us-east-1"] },
```
and in `quotas()` the inner loop becomes `for (const region of q.regions ?? AWS_LAB_REGIONS) {`.

- [ ] **Step 1: Write the failing tests** in `scripts/test/aws-labs-iam.test.mjs`. Import `NON_CREATE_VERB` with the other `aws-lab-policies.mjs` names. Add:

```js
test("ruling P1: a delete or update that takes a request tag is a change, never a create (DeleteAnalyzer)", () => {
  const props = { Annotations: { Properties: { IsWrite: true } } };
  const sar = {
    "access-analyzer": {
      Name: "access-analyzer",
      Resources: [{ Name: "Analyzer", ConditionKeys: ["aws:ResourceTag/${TagKey}"] }],
      Actions: [
        { Name: "CreateAnalyzer", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Analyzer" }], ...props },
        { Name: "DeleteAnalyzer", ActionConditionKeys: ["aws:RequestTag/${TagKey}", "aws:TagKeys"], Resources: [{ Name: "Analyzer" }], ...props },
        { Name: "UpdateAnalyzer", ActionConditionKeys: [], Resources: [{ Name: "Analyzer" }], ...props },
      ],
    },
  };
  const { create, change } = abacLists(sar);
  assert.deepEqual(create, ["access-analyzer:CreateAnalyzer"]);
  assert.deepEqual(change, ["access-analyzer:DeleteAnalyzer", "access-analyzer:UpdateAnalyzer"]);
});

test("ruling P1: the committed create list holds no delete or update verb", { skip }, () => {
  const { ABAC } = files();
  assert.deepEqual(ABAC.create.filter((a) => NON_CREATE_VERB.test(a.split(":")[1])), []);
  assert.ok(ABAC.change.includes("access-analyzer:DeleteAnalyzer"), "the analyzer's delete is a change, judged by the lab tag");
});

test("rulings P6 and P14: lab 07's user can lose hand-made credentials; Access Analyzer's role is made ahead", { skip }, () => {
  const { sid } = files();
  for (const a of ["iam:DeleteAccessKey", "iam:UpdateAccessKey", "iam:DeleteSSHPublicKey", "iam:DeleteSigningCertificate", "iam:DeleteServiceSpecificCredential", "iam:DeactivateMFADevice", "iam:UntagUser"]) assert.ok(sid("Lab07UsersOther").Action.includes(a), a);
  assert.ok(!sid("Lab07UsersOther").Action.includes("iam:CreateAccessKey"));
  assert.ok(SERVICE_LINKED.includes("access-analyzer.amazonaws.com"));
});

test("ruling P13: the managed-policies-per-role quota is asked for in us-east-1 only", () => {
  const q = LAB_QUOTAS.find((x) => x.code === "L-0DA4ABF3");
  assert.deepEqual([q.service, q.want, q.raise, q.regions], ["iam", 20, "if-below", ["us-east-1"]]);
});

test("what labs 06–10 do is allowed: tagged creates, deletes of tagged items, lab 07's user and its hand-made credentials", { skip }, () => {
  const { POLICIES } = files();
  const allowed = (action, resource, ctx) => assert.equal(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const denied = (action, resource, ctx) => assert.notEqual(decide(POLICIES.role, { action, resource, ctx }), "allowed", `${action} on ${resource}`);
  const R = { "aws:RequestedRegion": "eu-west-2" };
  const arn = (svc, rest) => `arn:aws:${svc}:eu-west-2:${A}:${rest}`;
  // Lab 06: a tagged stack, run by its own role; its update and delete are changes on the tagged stack (P1).
  allowed("cloudformation:CreateStack", arn("cloudformation", "stack/lab-soa-06-x-stack/*"), NEW);
  denied("cloudformation:CreateStack", arn("cloudformation", "stack/lab-soa-06-x-stack/*"), R);
  for (const a of ["cloudformation:UpdateStack", "cloudformation:DeleteStack"]) allowed(a, arn("cloudformation", "stack/lab-soa-06-x-stack/0abc"), LAB);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-06-x-cfn`, { "iam:PassedToService": "cloudformation.amazonaws.com" });
  // Lab 07: the user, its login profile and policy; hand-made credentials removed; never an access key made.
  const ann = `arn:aws:iam::${A}:user/cloudlabs-lab/lab-soa-07-iam-kms-ann`;
  allowed("iam:CreateUser", ann, BOUNDED);
  for (const a of ["iam:TagUser", "iam:CreateLoginProfile", "iam:DeleteLoginProfile", "iam:DeleteAccessKey", "iam:DeactivateMFADevice", "iam:DeleteSSHPublicKey", "iam:DeleteSigningCertificate", "iam:DeleteServiceSpecificCredential", "iam:DeleteUser"]) allowed(a, ann, {});
  allowed("iam:AttachUserPolicy", ann, { ...BOUNDED, "iam:PolicyARN": `arn:aws:iam::${A}:policy/cloudlabs-lab/lab-soa-07-iam-kms-ann` });
  denied("iam:CreateAccessKey", ann, {});
  denied("iam:DeleteAccessKey", `arn:aws:iam::${A}:user/someone`, {});
  allowed("access-analyzer:CreateAnalyzer", arn("access-analyzer", "analyzer/lab-soa-07-iam-kms-account"), NEW);
  allowed("access-analyzer:DeleteAnalyzer", arn("access-analyzer", "analyzer/lab-soa-07-iam-kms-account"), LAB);
  denied("access-analyzer:DeleteAnalyzer", arn("access-analyzer", "analyzer/other"), R);
  allowed("kms:CreateKey", "*", NEW);
  allowed("kms:ScheduleKeyDeletion", arn("kms", "key/0abc"), LAB);
  allowed("secretsmanager:CreateSecret", arn("secretsmanager", "secret:lab-soa-07-iam-kms-app-a07k3x9q-AbCdEf"), NEW);
  for (const a of ["secretsmanager:PutSecretValue", "secretsmanager:RotateSecret", "secretsmanager:DeleteSecret", "secretsmanager:CancelRotateSecret"]) allowed(a, arn("secretsmanager", "secret:lab-soa-07-iam-kms-app-a07k3x9q-AbCdEf"), LAB);
  allowed("lambda:CreateFunction", arn("lambda", "function:lab-soa-07-iam-kms-rotate"), NEW);
  for (const a of ["lambda:AddPermission", "lambda:DeleteFunction", "lambda:RemovePermission"]) allowed(a, arn("lambda", "function:lab-soa-07-iam-kms-rotate"), LAB);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-07-iam-kms-rotate`, { "iam:PassedToService": "lambda.amazonaws.com" });
  allowed("iam:CreateServiceLinkedRole", `arn:aws:iam::${A}:role/aws-service-role/access-analyzer.amazonaws.com/AWSServiceRoleForAccessAnalyzer`, { "iam:AWSServiceName": "access-analyzer.amazonaws.com" });
  // Lab 08: a second VPC, its own network ACL (entries and association on the lab's ACL), peering, flow logs.
  allowed("ec2:CreateNetworkAcl", arn("ec2", "network-acl/*"), NEW);
  allowed("ec2:ReplaceNetworkAclAssociation", arn("ec2", "network-acl/acl-0lab"), LAB);
  allowed("ec2:CreateVpcPeeringConnection", arn("ec2", "vpc-peering-connection/*"), NEW);
  allowed("ec2:AcceptVpcPeeringConnection", arn("ec2", "vpc-peering-connection/pcx-0lab"), LAB);
  allowed("ec2:CreateFlowLogs", arn("ec2", "vpc-flow-log/*"), NEW);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-08-vpc-fix-flowlogs`, { "iam:PassedToService": "vpc-flow-logs.amazonaws.com" });
  // Lab 09: CloudFront and Route 53 in us-east-1 (global APIs), the site bucket by name and its policy.
  for (const a of ["cloudfront:CreateDistribution", "cloudfront:CreateOriginAccessControl", "cloudfront:DeleteDistribution", "route53:CreateHostedZone", "route53:ChangeResourceRecordSets", "route53:CreateHealthCheck", "route53:DeleteHostedZone"]) allowed(a, "*", { "aws:RequestedRegion": "us-east-1" });
  allowed("s3:PutBucketPolicy", "arn:aws:s3:::cloudlabs-a09k3x9q-site", R);
  // Lab 10: NAT gateway and its address, ECR, ECS (deregistering takes no resource), the task execution role.
  allowed("ec2:AllocateAddress", arn("ec2", "elastic-ip/*"), NEW);
  allowed("ec2:CreateNatGateway", arn("ec2", "natgateway/*"), NEW);
  allowed("ecr:CreateRepository", arn("ecr", "repository/lab-soa-10-containers-web"), NEW);
  for (const a of ["ecr:PutLifecyclePolicy", "ecr:DeleteRepository"]) allowed(a, arn("ecr", "repository/lab-soa-10-containers-web"), LAB);
  for (const [a, r] of [["ecs:CreateCluster", "cluster/lab-soa-10-containers"], ["ecs:RegisterTaskDefinition", "task-definition/lab-soa-10-containers-web:1"], ["ecs:CreateService", "service/lab-soa-10-containers/lab-soa-10-containers-web"]]) allowed(a, arn("ecs", r), NEW);
  for (const [a, r] of [["ecs:UpdateService", "service/lab-soa-10-containers/x"], ["ecs:DeleteService", "service/lab-soa-10-containers/x"], ["ecs:DeleteCluster", "cluster/lab-soa-10-containers"], ["ecs:DeleteTaskDefinitions", "task-definition/lab-soa-10-containers-web:1"]]) allowed(a, arn("ecs", r), LAB);
  allowed("ecs:DeregisterTaskDefinition", "*", R);
  allowed("iam:PassRole", `arn:aws:iam::${A}:role/cloudlabs-lab/lab-soa-10-containers-exec`, { "iam:PassedToService": "ecs-tasks.amazonaws.com" });
});
```

Change the existing tests:
- "every role policy and the boundary fit (A29), and the role holds at most 10": delete the "one policy spare" assertion and its comment, and add `// Ruling P13: batch 2 fills the tenth; the bootstrap asks IAM for 20 (LAB_QUOTAS).` above the first `assert`.
- "the simulator cases are the eight of A19 and fix round 1's": the expected list gains, after `["reset an SSM setting", "denied"]` and before `["a subnet in the default VPC", "denied"]`: `["a lab 07 user under the boundary", "allowed"], ["a user for another lab", "denied"], ["remove a hand-made key from the lab 07 user", "allowed"], ["delete the lab's analyzer", "allowed"], ["an untagged CloudFormation stack", "denied"], ["a CloudFront distribution", "allowed"], ["a Route 53 hosted zone", "allowed"], ["an ECS cluster in us-east-1", "denied"]`; rename it "the simulator cases are A19's, fix round 1's and batch 2's, and a wrong answer is a problem".
- "--labs: every simulator case …": `sims.length` 27 → 35; the fake's `quotas` gains `"L-0DA4ABF3 us-east-1": 10`; `raised` gains `["L-0DA4ABF3", "us-east-1", "20"]` last.
- "lab-abac.json is the generator's …": the pinned hash is replaced by the regenerated lists' hash (the first run after Step 4 fails with both hashes; the reviewer reads the lists' diff first: only the P1 moves and whatever AWS added to the reference since 2026-10-15).

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no `NON_CREATE_VERB`; DeleteAnalyzer in the create list; seven actions missing; 27 cases; no IAM quota).

- [ ] **Step 3: Change `aws-lab-policies.mjs` and `aws-bootstrap-labs.mjs`** as above.

- [ ] **Step 4: Regenerate the lists and the policies**

Run: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`
Expected: `lab-abac.json` rewritten (fetched 2026-10-1x) and `lab-policies.json` rendered with **at most 10** role policies, none of them A29's fall-back (`--render` says so if it was). An offline packing of today's lists with these changes gave 10 (the tenth about 1,200 characters). If the render needs 11 or falls back, stop the task and report it to the controller: Task 12 Step 1 decides (raise `ROLE_POLICIES_MAX` to 20 once AWS has granted Step 3's quota, or accept the fall-back). If the SAR address does not answer from this machine, say so in the task report and leave both files for the controller (Task 12 Step 1).

- [ ] **Step 5: Run the targeted tests**

Run: `node --test scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (after the hash pin is updated as Step 1 says).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/aws-lab-policies.mjs scripts/lib/aws-bootstrap-labs.mjs infra/aws-bootstrap/lab-abac.json infra/aws-bootstrap/lab-policies.json scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): delete and update verbs are never creates; lab 07's user can lose hand-made credentials; Access Analyzer's role made ahead; IAM policy quota asked for

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 3: Lint and scope: CloudFormation reader, batch 2 types, global regions per resource, instance-target allow-list, resource policies

Spec: §7.3 (lint; scope rules 1, 4–13), §7.4, §7.5, §12.2 rows 06–10, rulings A4, A27, A42, A50, A56, P4, P7–P10, P14.

**Files:**
- Modify: `infra/ci/lab-scope-aws.mjs` (lists, the `template` rule and `cfnTemplateProblems`, the rules' batch 2 parts below; header comment's rule table gains `template` and the new clauses)
- Modify: `infra/ci/lab-lint.mjs` (`lintCfnText`, read by `lintDir` from `terraform/cfn/`; rule `cfn`; header)
- Modify: `labs/soa-01-cloudwatch/terraform/monitoring.tf` (the topic policy's `Resource` from known parts, so the policy is known at plan: ruling P10; soa-01 is already at version 3 from Task 1), `scripts/test/fixtures/labs/plans/labs/soa-01-cloudwatch.mjs` and `scripts/test/fixtures/labs/plans/shapes/soa-01-cloudwatch.json` (that resource's entry: `policy` known, its new references; Task 13's retest records it again)
- Modify: `scripts/test/fixtures/labs/plans/extract-computed.mjs` (`TYPES` gains batch 2's), regenerate `computed.json` and `schema-facts.json`
- Test: `scripts/test/lab-scope-aws.test.mjs`, `scripts/test/lab-lint.test.mjs`

**Interfaces:**
- Produces (lab-scope-aws.mjs): `export const CFN_TYPES: Map<string, string>`, `export const ACCESS_ANALYZER_LABS = ["soa-07-iam-kms"]`, `export const GLOBAL_REGION_TYPES: Record<"us-east-1" | "us-west-2", RegExp[]>`, `export const LAB_ZONE_SUFFIX = ".labs.clydeford.net"`, `export const RESOURCE_POLICIES: Map<string, string>`, `export function cfnTemplateProblems(doc: object, o: { labId: string; parameters?: Record<string, string> }): string[]`; `AWS_RULES` gains `"template"` after `"never"`. (lab-lint.mjs): `export function lintCfnText(files: Record<string, string>): { file, line, rule: "cfn" | "literal-cidr" | "gateway", message }[]`. Task 7's lab test calls `cfnTemplateProblems` on its own template.

**`infra/ci/lab-scope-aws.mjs`: lists.** `AWS_TYPES` gains (before the closing `]);`):
```js
  ["random_password", "a lab secret's first value (hashicorp/random), never leaves the lab's state"],
  ["aws_cloudformation_stack", "lab 06's stack: its template is read against CFN_TYPES (rule template) and it runs as the lab's own bounded service role"],
  ...["aws_iam_user", "aws_iam_user_login_profile", "aws_iam_user_policy_attachment"].map((t) => [t, "lab 07's console user under the boundary (AWS_IAM_USER_LABS only, rule iam)"]),
  ...["aws_kms_key", "aws_kms_alias"].map((t) => [t, "a lab key (7-day deletion window, the account root granted kms:*) and its alias/lab-<id>-* name"]),
  ...["aws_secretsmanager_secret", "aws_secretsmanager_secret_version", "aws_secretsmanager_secret_rotation"].map((t) => [t, "a lab secret, deleted without recovery, rotated by the lab's own function"]),
  ...["aws_lambda_function", "aws_lambda_permission"].map((t) => [t, "a lab function writing to the lab's own log group, invoked only by AWS services (rule public)"]),
  ["aws_accessanalyzer_analyzer", "lab 07's account analyzer (ACCESS_ANALYZER_LABS only: one per region per account)"],
  ["aws_vpc_peering_connection", "peering between two of the lab's own VPCs, by reference (rule gateway)"],
  ...["aws_network_acl", "aws_network_acl_rule", "aws_network_acl_association"].map((t) => [t, "the lab's own network ACLs on its own subnets"]),
  ["aws_flow_log", "flow logs of the lab's VPCs to the lab's own log group (rule lingering)"],
  ...["aws_route53_zone", "aws_route53_record", "aws_route53_health_check"].map((t) => [t, "lab 09's public zone <name_prefix>.labs.clydeford.net (never delegated, A27), its records and a health check of its own site"]),
  ...["aws_cloudfront_distribution", "aws_cloudfront_origin_access_control"].map((t) => [t, "lab 09's distribution in front of the lab's own private bucket"]),
  ...["aws_eip", "aws_nat_gateway"].map((t) => [t, "a lab NAT gateway and its address (public by nature, §7.4); at most 2 (rule size)"]),
  ...["aws_ecr_repository", "aws_ecr_lifecycle_policy"].map((t) => [t, "lab 10's image repository, deleted with its images"]),
  ...["aws_ecs_cluster", "aws_ecs_task_definition", "aws_ecs_service"].map((t) => [t, "lab 10's Fargate cluster, task and service (0.5 vCPU a task, at most 4 tasks)"]),
```
`DEFERRED` keeps only `aws_vpc_peering_connection_accepter: "gateway"`. `NEVER_TYPES` gains `/^aws_cloudformation_stack_set/, /^aws_cloudformation_stack_instances$/, /^aws_cloudformation_type$/` (StackSets are readme-only, spec §12.2; registering a type changes the whole account). `AWS_RULES` becomes `["provider", "provisioner", "import", "type", "never", "template", "tag", "untaggable", "iam", "gateway", "address", "public", "lingering", "size", "description"]`. New lists:
```js
/** Ruling P14: the one lab that may make an Access Analyzer analyzer (one account analyzer per region per account). */
export const ACCESS_ANALYZER_LABS = ["soa-07-iam-kms"];
/** Ruling P7: in AWS_GLOBAL_LABS, the only types whose own region may be a global one. */
export const GLOBAL_REGION_TYPES = { "us-east-1": [/^aws_wafv2_/], "us-west-2": [/^aws_globalaccelerator_/] };
/** Ruling A27: lab 09's public zone is <name_prefix> under this, never delegated. */
export const LAB_ZONE_SUFFIX = ".labs.clydeford.net";
/** Ruling P4: what a lab's CloudFormation stack may make, each with why it stays inside the lab. */
export const CFN_TYPES = new Map([
  ["AWS::SNS::Topic", "named by CloudFormation from the stack's name, lab-<id>-..."],
  ["AWS::SQS::Queue", "named by CloudFormation from the stack's name"],
  ["AWS::CloudWatch::Alarm", "named by CloudFormation from the stack's name"],
  ["AWS::Logs::LogGroup", "named /cloudlabs/<id>/..., kept at most 7 days (A56)"],
  ["AWS::SSM::Parameter", "named /cloudlabs/<id>/..."],
]);
/** Ruling P10: resource policy documents a lab may write (type -> attribute), read for who they let in. */
export const RESOURCE_POLICIES = new Map([["aws_s3_bucket_policy", "policy"], ["aws_sns_topic_policy", "policy"], ["aws_sqs_queue_policy", "policy"], ["aws_ecr_repository_policy", "policy"], ["aws_secretsmanager_secret_policy", "policy"], ["aws_kms_key", "policy"]]);
/** An AWS service principal (events.amazonaws.com). */
const SERVICE_PRINCIPAL = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/;
/** Ruling P9: the resources whose { key, values } blocks select instances. */
const TARGET_ATTRS = { aws_ssm_association: ["targets"], aws_ssm_maintenance_window_target: ["targets"], aws_ssm_maintenance_window_task: ["targets"], aws_cloudwatch_event_target: ["run_command_targets"] };
```

**`cfnTemplateProblems`** (exported, below `grantsRoot`):
```js
/**
 * Ruling P4: why a lab's CloudFormation template (as JSON) may not run, as sentences. Types only from CFN_TYPES; no
 * Transform, Fn::Transform or Fn::ImportValue; nothing kept after tear-down; no names CloudFormation would otherwise
 * make from the stack; log groups and parameters under /cloudlabs/<id>/ (a literal, or a Ref to a stack parameter).
 */
export function cfnTemplateProblems(doc, { labId, parameters = {} }) {
  if (!isObj(doc)) return ["the template is not a JSON object"];
  const out = [];
  const own = `/cloudlabs/${labId}/`;
  if ("Transform" in doc) out.push("Transform runs a macro (SAM and the like) this check never sees");
  /** A literal, or a Ref to a parameter: the stack's value for it, else the parameter's default. */
  const value = (x) => (isObj(x) && Object.keys(x).length === 1 && typeof x.Ref === "string" ? (parameters[x.Ref] ?? doc.Parameters?.[x.Ref]?.Default) : x);
  for (const [name, res] of Object.entries(isObj(doc.Resources) ? doc.Resources : {})) {
    if (!isObj(res)) {
      out.push(`${name}: not a resource this check can read`);
      continue;
    }
    const t = res.Type;
    if (!CFN_TYPES.has(t)) out.push(`${name}: ${t} is not on CFN_TYPES (${[...CFN_TYPES.keys()].join(", ")}); nested stacks, custom resources, macros and IAM never are`);
    for (const p of ["DeletionPolicy", "UpdateReplacePolicy"]) if (res[p] !== undefined && res[p] !== "Delete") out.push(`${name}: ${p} ${JSON.stringify(res[p])} would keep it after tear-down (only Delete)`);
    const props = isObj(res.Properties) ? res.Properties : {};
    for (const k of ["TopicName", "QueueName", "AlarmName"]) if (k in props) out.push(`${name}: ${k} is set: leave it out, so CloudFormation names it from the stack (lab-${labId}-...)`);
    if (t === "AWS::Logs::LogGroup") {
      const n = value(props.LogGroupName);
      if (typeof n !== "string" || !n.startsWith(own)) out.push(`${name}: LogGroupName must start ${own} (a literal or a Ref to a stack parameter; ruling A56)`);
      const d = Number(value(props.RetentionInDays));
      if (!(d >= 1 && d <= 7)) out.push(`${name}: RetentionInDays must be 1 to 7`);
    }
    if (t === "AWS::SSM::Parameter") {
      const n = value(props.Name);
      if (typeof n !== "string" || !n.startsWith(own)) out.push(`${name}: Name must start ${own}`);
    }
  }
  walk(doc, [], (kind, path, s) => {
    if (kind === "key" && (s === "Fn::ImportValue" || s === "Fn::Transform")) out.push(`${path.slice(0, -1).join(".")}: ${s} reaches outside this template`);
  });
  return [...new Set(out)];
}
```

**The rules' batch 2 parts, in `scopeProblemsAws`:**

Rule 1, after the per-resource region block:
```js
    // Ruling P7: what may live in a global region, judged per resource (a plan knows each resource's own region).
    if (mode === "plan" && isManaged && r.provider === AWS_SOURCE && GLOBAL_REGIONS.includes(v.region)) {
      const ok = globalLab && GLOBAL_REGION_TYPES[v.region].some((re) => re.test(type)) && (type !== "aws_wafv2_web_acl" || v.scope === "CLOUDFRONT");
      if (!ok) refuse("provider", `${type} in ${v.region}: only ${v.region === "us-east-1" ? "a WAF web ACL for CloudFront (aws_wafv2_*, scope CLOUDFRONT)" : "Global Accelerator (aws_globalaccelerator_*)"} lives there, and only in ${AWS_GLOBAL_LABS.join(", ")} (ruling P7)`);
    }
    if (isManaged && type === "aws_secretsmanager_secret" && list(v.replica).length) refuse("provider", "replica: a secret copied to another region is outside the lab's regions");
    if (isManaged && type === "aws_kms_key" && v.multi_region === true) refuse("provider", "multi_region: a key's replicas live outside the lab's regions");
```
Rule 4, after the `CONFIG_TYPES` line:
```js
      else if (type === "aws_accessanalyzer_analyzer" && !ACCESS_ANALYZER_LABS.includes(labId)) refuse("type", `an Access Analyzer analyzer only in ${ACCESS_ANALYZER_LABS.join(", ")} (one account analyzer per region per account; ruling P14)`);
      else if (type === "aws_accessanalyzer_analyzer" && typeof v.type === "string" && v.type !== "ACCOUNT") refuse("type", `analyzer type ${v.type}: only ACCOUNT (organization analyzers need Organizations; unused-access analyzers are paid; ruling P14)`);
```
Rule `template` (new), after rule 5:
```js
    // template (ruling P4)
    if (isManaged && type === "aws_cloudformation_stack") stackProblems(r, v);
```
with, among the closing helpers:
```js
    function stackProblems(res, val) {
      const no = (m) => refuse("template", m);
      if (res.configured?.has("template_url") || nonEmpty(val.template_url)) no('template_url: the template is the lab\'s own, template_body = jsonencode(yamldecode(file("${path.module}/cfn/stack.yaml")))');
      if (!startsKnown(val.name, prefix)) no(`the stack's name must start ${prefix} (CloudFormation names what it makes from it)`);
      const caps = list(val.capabilities).filter((x) => typeof x === "string");
      if (caps.length) no(`capabilities ${caps.join(", ")}: a lab's stack makes no IAM and runs no macros`);
      const role = val.iam_role_arn;
      const roleRefs = role instanceof Unknown ? refsOf(role, res, "iam_role_arn") : [];
      const roleOk = role instanceof Unknown && (mode === "hcl" || (mode === "mock" && !roleRefs.length) || ownRefs(roleRefs, ["aws_iam_role"]));
      if (!roleOk) no("iam_role_arn must be the lab's own service role, by reference (aws_iam_role.<name>.arn; ruling P4)");
      const body = val.template_body;
      if (body instanceof Unknown) {
        if (plan) no("template_body must be known at plan: jsonencode(yamldecode(file(...)))");
        return;
      }
      const j = jsonDoc(body);
      if (j.bad) return no("template_body is not JSON: write template_body = jsonencode(yamldecode(file(...)))");
      for (const m of cfnTemplateProblems(j.doc, { labId, parameters: isObj(val.parameters) ? val.parameters : {} })) no(m);
    }
```
Rule 8, `iamProblems`: the path/name list becomes `["aws_iam_role", "aws_iam_instance_profile", "aws_iam_policy", "aws_iam_user"]`, and before `// Identity policy documents.`:
```js
      if (type === "aws_iam_user_login_profile") {
        const u = val.user;
        const ownUser = typeof u === "string" ? u.startsWith(prefix) : u instanceof Unknown && (ownRefs(refsOf(u, res, "user"), ["aws_iam_user"]) || (mode === "mock" && !refsOf(u, res, "user").length));
        if (!ownUser) refuse("iam", `user must be one of the lab's own (aws_iam_user.<name>.name, named ${prefix}*)`);
        if (val.password_reset_required === true) refuse("iam", "password_reset_required: the boundary allows the user no IAM, so it could never set a new password (ruling P5)");
      }
      // A lab function or task runs as a lab role, by reference.
      for (const [t, attr] of [["aws_lambda_function", "role"], ["aws_ecs_task_definition", "execution_role_arn"], ["aws_ecs_task_definition", "task_role_arn"]]) {
        if (type !== t || (val[attr] === undefined && !res.configured?.has(attr))) continue;
        const x = val[attr];
        const refs = x instanceof Unknown ? refsOf(x, res, attr) : [];
        if (!(x instanceof Unknown && (mode === "hcl" || (mode === "mock" && !refs.length) || ownRefs(refs, ["aws_iam_role"])))) refuse("iam", `${attr} must be one of the lab's own roles, by reference (aws_iam_role.<name>.arn)`);
      }
```
Rule 9, inside `if (plan && isManaged) { … }` after the existing `scan` loop (so a wildcard id still reads "every instance" first):
```js
        // Ruling P9: the instance-target allow-list.
        for (const attr of TARGET_ATTRS[type] ?? []) list(v[attr]).forEach((t, i) => {
          const why = targetWhy(t, `${attr}.${i}.values`);
          if (why) refuse("gateway", `${attr}.${i}: ${why} (ruling P9)`);
        });
        if (type === "aws_ssm_association" && (r.configured?.has("instance_id") || nonEmpty(v.instance_id)) && !(v.instance_id instanceof Unknown && (ownRefs(refsOf(v.instance_id, r, "instance_id"), ["aws_instance"]) || (mode === "mock" && !refsOf(v.instance_id, r, "instance_id").length)))) refuse("gateway", "instance_id must be one of the lab's own instances, by reference (ruling P9)");
        // Ruling P8: lab 09's zone, records, health checks and distributions name only the lab's own.
        const ownRef = (attr, types) => v[attr] instanceof Unknown && (ownRefs(refsOf(v[attr], r, attr), types) || (mode === "mock" && !refsOf(v[attr], r, attr).length));
        if (type === "aws_route53_zone" && !list(v.vpc).length) {
          const want = nonEmpty(variables.name_prefix) ? `${variables.name_prefix}${LAB_ZONE_SUFFIX}` : null;
          if (!(typeof v.name === "string" && want && v.name.replace(/\.$/, "") === want)) refuse("gateway", `a public zone is named ${want ?? `<name_prefix>${LAB_ZONE_SUFFIX}`} only (never delegated; ruling A27): another name could answer for a domain someone else owns`);
        }
        if (type === "aws_route53_zone" && (r.configured?.has("delegation_set_id") || nonEmpty(v.delegation_set_id))) refuse("gateway", "delegation_set_id: a reusable delegation set outlives the lab");
        if (type === "aws_route53_record" && !ownRef("zone_id", ["aws_route53_zone"])) refuse("gateway", "zone_id must be the lab's own zone, by reference (ruling P8)");
        if (type === "aws_route53_health_check") {
          if (r.configured?.has("ip_address") || nonEmpty(v.ip_address)) refuse("gateway", "a health check probes the lab's own endpoint by name, never an address (ruling P8)");
          else if (v.type !== "CALCULATED" && !ownRef("fqdn", ["aws_cloudfront_distribution", "aws_lb"])) refuse("gateway", "fqdn must be the lab's own distribution or load balancer, by reference (ruling P8)");
        }
        if (type === "aws_cloudfront_distribution") {
          list(v.origin).forEach((o, i) => {
            const d = isObj(o) ? o.domain_name : undefined;
            const refs = r.refs?.[`origin.${i}.domain_name`] ?? r.refs?.origin ?? [];
            const ok = d instanceof Unknown ? (mode === "mock" && !refs.length) || ownRefs(refs, ["aws_s3_bucket", "aws_lb"]) : typeof d === "string" && d.startsWith(`cloudlabs-${variables.name_prefix}-`);
            if (!ok) refuse("gateway", `origin ${i}: a distribution fronts only the lab's own bucket or load balancer, by reference (ruling P8)`);
          });
        }
```
with, among the closing helpers:
```js
    /** Ruling P9: why one { key, values } target may not be used, or null. `path`: where its values' references are. */
    function targetWhy(t, path) {
      if (!isObj(t) || typeof t.key !== "string") return "a target this check cannot read";
      const key = t.key;
      const known = list(t.values).filter((x) => typeof x === "string");
      const refs = r.refs?.[path] ?? [];
      if (key === "InstanceIds" || key === "WindowTargetIds") {
        const own = key === "InstanceIds" ? ["aws_instance"] : ["aws_ssm_maintenance_window_target"];
        if (known.length) return `${key} must name the lab's own by reference, never a literal`;
        return (mode === "mock" && !refs.length) || ownRefs(refs, own) ? null : `${key} must name the lab's own ${own[0]} by reference`;
      }
      if (key === `tag:${LAB_TAG}`) return known.length && known.every((x) => x === labId) ? null : `tag:${LAB_TAG} must be exactly the lab's id`;
      if (/^tag:/i.test(key)) return known.length && known.every((x) => x.startsWith(prefix) && !/[*?]/.test(x)) ? null : `${key}'s values must each start ${prefix}, a tag value only the lab gives`;
      if (key === "resource-groups:Name") return known.length === 1 && known[0] === `lab-${labId}` ? null : `resource-groups:Name must be the lab's own group, lab-${labId}`;
      return `${key} is not a target a lab may use: InstanceIds or WindowTargetIds by reference, tag:${LAB_TAG} = the lab id, a tag valued ${prefix}*, or resource-groups:Name = lab-${labId}`;
    }
```
Rule 11, `publicProblems`, at its end:
```js
      // Ruling P10: who a resource policy lets in, and who may invoke a lab function.
      const docAttr = RESOURCE_POLICIES.get(type);
      if (docAttr && !(type === "aws_kms_key" && val.policy === undefined)) {
        const j = jsonDoc(val[docAttr]);
        if (j.unknown) {
          if (plan) no("public", `${docAttr} must be known at plan, so who it lets in can be read (ruling P10)`);
        } else if (j.bad) no("public", `${docAttr} is not a policy document this check can read`);
        else {
          const why = resourcePolicyProblem(j.doc, callerAccount);
          if (why) no("public", `${docAttr}: ${why} (ruling P10)`);
        }
      }
      if (type === "aws_lambda_permission") {
        if (typeof val.principal === "string" && !SERVICE_PRINCIPAL.test(val.principal)) no("public", "principal: a lab function is invoked only by AWS services (ruling P10)");
        if (val.function_url_auth_type === "NONE") no("public", "a function URL with no auth is open to the internet");
      }
      if (type === "aws_ecs_service" && list(val.network_configuration).some((n) => isObj(n) && n.assign_public_ip === true)) no("public", "assign_public_ip: tasks reach out through the lab's NAT gateway, never from a public address");
```
and, beside `trustProblem` (module level):
```js
/** Ruling P10: why a resource policy lets in too much, or null. An Allow never names everyone or another account. */
function resourcePolicyProblem(doc, account) {
  for (const s of list(doc.Statement)) {
    if (!isObj(s)) return "it has a statement this check cannot read";
    if (s.Effect !== "Allow") continue;
    if ("NotPrincipal" in s) return "an Allow with NotPrincipal lets in everyone else";
    const p = s.Principal;
    if (p === "*") return 'it allows Principal "*"';
    if (!isObj(p)) return "it has a principal this check cannot read";
    for (const [k, v] of Object.entries(p)) {
      if (k === "Service" && list(v).every((x) => typeof x === "string" && SERVICE_PRINCIPAL.test(x))) continue;
      if (k === "AWS" && account && list(v).every((x) => typeof x === "string" && (x === account || x.startsWith(`arn:aws:iam::${account}:`)))) continue;
      return `it allows ${k} ${JSON.stringify(v).replace(/\d{12}/g, "<account>")}: only AWS services and the lab's own account`;
    }
  }
  return null;
}
```
Rule 12, `lingeringProblems`, a new case: `case "aws_iam_user": must("force_destroy", true, false); break;` (ruling P6).
Rule 13, `sizeProblems`, at its end:
```js
      if (type === "aws_ecs_service") max(val.desired_count, 4, "desired_count");
      if (type === "aws_lambda_function") {
        max(val.memory_size, 512, "memory_size (MB)");
        max(val.timeout, 300, "timeout (s)");
      }
      if (type === "aws_cloudfront_distribution" && !skip(val.price_class) && val.price_class !== "PriceClass_100") no("size", `price_class ${JSON.stringify(val.price_class ?? "PriceClass_All")}: only PriceClass_100 (ruling P8)`);
      if (type === "aws_route53_health_check") {
        if (typeof val.request_interval === "number" && val.request_interval !== 30) no("size", "request_interval: a 10-second check costs more; 30 only");
        if (val.measure_latency === true) no("size", "measure_latency costs more: leave it off");
      }
```

**`infra/ci/lab-lint.mjs`.** Header gains: "`--cloud aws` also reads the CloudFormation templates in `terraform/cfn/` (lab 06; rule cfn, ruling P4): short-form tags (`!Ref`: Terraform's yamldecode reads none), `Transform`, nested stacks, custom resources, macros, StackSets, SAM, IAM types, `Fn::ImportValue`, and `DeletionPolicy`/`UpdateReplacePolicy` other than Delete; plus the literal-cidr and gateway rules." Below `AWS_TEXT_RULES`:
```js
/** Ruling P4: a lab's CloudFormation templates (terraform/cfn/*.yaml), read as text before init. */
const CFN_RULES = [
  ...AWS_TEXT_RULES.filter((r) => ["literal-cidr", "gateway"].includes(r.rule)),
  { rule: "cfn", re: /^\s*Transform\s*:/gm, message: () => "Transform: macros and SAM run code this check never sees" },
  { rule: "cfn", re: /\b(AWS::CloudFormation::(?:Stack|StackSet|CustomResource|Macro|ModuleDefaultVersion|ResourceVersion)|AWS::Serverless::\w+|AWS::IAM::\w+|AWS::Include|Custom::[\w-]+|Fn::Transform|Fn::ImportValue)\b/g, message: (m) => `${m}: a lab's template makes only what lab-scope-aws.mjs CFN_TYPES lists, and reaches nothing outside itself` },
  { rule: "cfn", re: /(?:^|[:\-[,]\s*)!(?:Ref|Sub|GetAtt|Join|If|Equals|Select|Split|FindInMap|Base64|Cidr|GetAZs|ImportValue|Not|And|Or|Condition|Transform|Length|ToJsonString)\b/gm, message: (m) => `${m.trim().replace(/^[:\-[,]\s*/, "")}: write the long form (Ref:, Fn::Sub:): Terraform's yamldecode reads no YAML tags` },
  { rule: "cfn", re: /\b(?:DeletionPolicy|UpdateReplacePolicy)\s*:\s*(?:Retain|RetainExceptOnCreate|Snapshot)\b/g, message: (m) => `${m}: a lab keeps nothing after tear-down (Delete only)` },
];
/** Lint a lab's CloudFormation templates ({ "cfn/stack.yaml": text }), comment lines left out. */
export function lintCfnText(files) {
  const out = [];
  for (const [file, src] of Object.entries(files)) {
    const code = src.replace(/\r\n/g, "\n").replace(/^\s*#.*$/gm, (m) => " ".repeat(m.length));
    for (const r of CFN_RULES) {
      for (const m of code.matchAll(r.re)) {
        if (r.ok?.(m[0])) continue;
        out.push({ file, line: lineOf(code, m.index + (m[0].length - m[0].trimStart().length)), rule: r.rule, message: r.message(m[0].trim()) });
      }
    }
  }
  return out;
}
```
and `lintDir` (its comment loses "CloudFormation templates are read in batch 2"):
```js
export function lintDir(dir, { cloud = "azure" } = {}) {
  const names = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const read = (re) => Object.fromEntries(names.filter((f) => re.test(f)).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  const cfnDir = join(dir, "cfn");
  const cfn = cloud === "aws" && existsSync(cfnDir) ? Object.fromEntries(readdirSync(cfnDir).filter((f) => /\.(ya?ml|json)$/i.test(f)).map((f) => [`cfn/${f}`, readFileSync(join(cfnDir, f), "utf8")])) : {};
  return [...fileProblems(names), ...lintTfText(read(/\.tf$/), { cloud }), ...(cloud === "aws" ? lintCfnText(cfn) : lintBicepText(read(/\.bicep$/i)))];
}
```
(`existsSync` joins the `node:fs` import.)

**`labs/soa-01-cloudwatch/terraform/monitoring.tf`**: above `aws_sns_topic_policy.alerts`,
```hcl
locals {
  # Known at plan (ruling P10: a resource policy is read for who it lets in, so it must be known before apply).
  alerts_arn = "arn:${data.aws_partition.current.partition}:sns:${var.region}:${data.aws_caller_identity.current.account_id}:lab-${var.lab_id}-alerts"
}
```
and both statements' `Resource = aws_sns_topic.alerts.arn` become `Resource = local.alerts_arn`. The fixture's `aws_sns_topic_policy.alerts` gets its `policy` in `values` (the JSON with `arn:aws:sns:eu-west-2:123456789012:lab-soa-01-cloudwatch-alerts`), drops `policy` from `unknown`, and its `refs.policy` becomes `["data.aws_partition.current.partition", "data.aws_partition.current", "var.region", "data.aws_caller_identity.current.account_id", "data.aws_caller_identity.current", "var.lab_id"]`; in `shapes/soa-01-cloudwatch.json` the same resource's `unknown` loses `"policy"` and `refs.policy` takes that list (the shape test names exactly what differs; Task 13 re-records it).

**`extract-computed.mjs`**: `TYPES` gains, under a `// AWS labs batch 2` comment: `aws_cloudformation_stack`, `aws_cloudformation_stack_set`, `aws_iam_user_login_profile`, `aws_iam_user_policy_attachment`, `aws_kms_key`, `aws_kms_alias`, `aws_secretsmanager_secret`, `aws_secretsmanager_secret_version`, `aws_secretsmanager_secret_rotation`, `aws_lambda_permission`, `aws_accessanalyzer_analyzer`, `aws_network_acl`, `aws_network_acl_rule`, `aws_network_acl_association`, `aws_flow_log`, `aws_route53_zone`, `aws_route53_record`, `aws_route53_health_check`, `aws_cloudfront_distribution`, `aws_cloudfront_origin_access_control`, `aws_ecr_repository`, `aws_ecr_lifecycle_policy`, `aws_ecs_cluster`, `aws_ecs_task_definition`, `aws_ecs_service`, `aws_sqs_queue_policy`, `aws_eks_cluster`, `aws_wafv2_web_acl` (the last three for the evil plans and tests).

- [ ] **Step 1: Write the failing tests.** In `scripts/test/lab-scope-aws.test.mjs`: import `templateMainResources` from `common-aws.mjs`; change the EVIL loop to take an optional lab id, `for (const [rule, what, make, id = ID] of EVIL) { test(…, () => { const got = scope.checkPlanAws(make(), id); … }) }`; change the evil "a type not on the allow-list" to use `aws_eks_cluster.x` (`values: tagged(c, { name: "x" })`), since `aws_lambda_function` is now listed; and in "rule 4 hands IAM users to rule 8 …" give `user7` `force_destroy: true` (rule `lingering` now asks it of a user, ruling P6; the soa-01 `user` there still fails `iam` first). Add, above `EVIL`:

```js
const c7 = ctxAws("soa-07-iam-kms", "07");
const c9 = ctxAws("soa-09-route53-cloudfront", "09");
const planFor = (cx) => (extra = []) => realisticPlan({ resources: [...templateMainResources(cx), ...extra], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: cx.variables });
const plan7 = planFor(c7);
const plan9 = planFor(c9);
const user7 = (over = {}) => ({ address: "aws_iam_user.ann", values: tagged(c7, { name: "lab-soa-07-iam-kms-ann", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, force_destroy: true, ...over }), refs: {} });
const tpl = (Resources) => JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources });
const cfnRole = () => ({ ...role({ name: `lab-${ID}-cfn`, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }), address: "aws_iam_role.cfn" });
const stack = (over = {}, { noRole = false } = {}) => ({
  address: "aws_cloudformation_stack.lab",
  values: tagged(c, { name: `lab-${ID}-stack`, template_body: tpl({ Q: { Type: "AWS::SQS::Queue" } }), parameters: {}, ...over }),
  unknown: noRole ? [] : ["iam_role_arn"],
  refs: noRole ? {} : { iam_role_arn: ref("aws_iam_role.cfn", "arn") },
});
const stackPlan = (over, opts) => plan([cfnRole(), stack(over, opts)]);
const fnLogs = { address: "aws_cloudwatch_log_group.f", values: tagged(c, { name: `/cloudlabs/${ID}/f`, retention_in_days: 1, skip_destroy: false }), refs: {} };
const lambdaFn = (over = {}) => ({ address: "aws_lambda_function.f", values: tagged(c, { function_name: `lab-${ID}-f`, runtime: "python3.13", handler: "f.handler", memory_size: 128, timeout: 30, logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${ID}/f` }], ...over }), unknown: ["role"], refs: { role: ref("aws_iam_role.vm", "arn") } });
const ecsService = (over = {}) => ({ address: "aws_ecs_service.s", values: tagged(c, { name: `lab-${ID}-s`, desired_count: 2, launch_type: "FARGATE", propagate_tags: "SERVICE", ...over }), unknown: ["cluster", "task_definition"], refs: {} });
```
and append to `EVIL`:
```js
  // Batch 2 (rulings P4, P6–P10, P14).
  ["type", "an Access Analyzer analyzer outside lab 07", () => plan([{ address: "aws_accessanalyzer_analyzer.a", values: tagged(c, { analyzer_name: `lab-${ID}-a`, type: "ACCOUNT" }), refs: {} }])],
  ["type", "an organization analyzer in lab 07", () => plan7([{ address: "aws_accessanalyzer_analyzer.a", values: tagged(c7, { analyzer_name: "lab-soa-07-iam-kms-a", type: "ORGANIZATION" }), refs: {} }]), "soa-07-iam-kms"],
  ["never", "a StackSet", () => plan([{ address: "aws_cloudformation_stack_set.s", values: tagged(c, { name: `lab-${ID}-set` }), refs: {} }])],
  ["template", "a stack from a template URL", () => stackPlan({ template_url: "https://example.com/t.json" })],
  ["template", "a stack without its own service role", () => stackPlan({}, { noRole: true })],
  ["template", "a stack with IAM capabilities", () => stackPlan({ capabilities: ["CAPABILITY_NAMED_IAM"] })],
  ["template", "a template with an IAM role", () => stackPlan({ template_body: tpl({ R: { Type: "AWS::IAM::Role", Properties: {} } }) })],
  ["template", "a template with a nested stack", () => stackPlan({ template_body: tpl({ N: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://example.com/n.json" } } }) })],
  ["template", "a template with a custom resource", () => stackPlan({ template_body: tpl({ C: { Type: "Custom::Thing", Properties: { ServiceToken: "arn:aws:lambda:eu-west-2:123456789012:function:x" } } }) })],
  ["template", "a template with a Transform", () => stackPlan({ template_body: JSON.stringify({ Transform: "AWS::Serverless-2016-10-31", Resources: { Q: { Type: "AWS::SQS::Queue" } } }) })],
  ["template", "a template that keeps a queue after tear-down (Retain)", () => stackPlan({ template_body: tpl({ Q: { Type: "AWS::SQS::Queue", DeletionPolicy: "Retain" } }) })],
  ["template", "a template that names its queue", () => stackPlan({ template_body: tpl({ Q: { Type: "AWS::SQS::Queue", Properties: { QueueName: "orders" } } }) })],
  ["template", "a template with a log group outside /cloudlabs/<id>/", () => stackPlan({ template_body: tpl({ L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/aws/other", RetentionInDays: 1 } } }) })],
  ["template", "a template importing another stack's output", () => stackPlan({ template_body: tpl({ T: { Type: "AWS::SNS::Topic", Properties: { DisplayName: { "Fn::ImportValue": "other-export" } } } }) })],
  ["provider", "a bucket in us-east-1 in lab 09 (only WAF for CloudFront lives there)", () => plan9([{ address: "aws_s3_bucket.far", values: tagged(c9, { bucket: `cloudlabs-${c9.prefix}-far`, force_destroy: true, region: "us-east-1" }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["provider", "a secret replicated to Ireland", () => plan([{ address: "aws_secretsmanager_secret.s", values: tagged(c, { name: `lab-${ID}-s`, recovery_window_in_days: 0, replica: [{ region: "eu-west-1" }] }), refs: {} }])],
  ["iam", "a login profile that forces a password reset", () => plan7([user7(), { address: "aws_iam_user_login_profile.ann", values: { user: "lab-soa-07-iam-kms-ann", password_reset_required: true }, refs: { user: ref("aws_iam_user.ann", "name") } }]), "soa-07-iam-kms"],
  ["iam", "a function running as a role the lab did not make", () => plan([fnLogs, { ...lambdaFn({ role: "arn:aws:iam::123456789012:role/wg-admin-labs" }), unknown: [], refs: {} }])],
  ["lingering", "a user that hand-made keys would keep (force_destroy false)", () => plan7([user7({ force_destroy: false })]), "soa-07-iam-kms"],
  ["gateway", "an SSM association on tag:managed = terraform (ruling P9)", () => plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:managed", values: ["terraform"] }] }), refs: {} }])],
  ["gateway", "an SSM association on someone else's resource group", () => plan([{ address: "aws_ssm_association.rg", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "resource-groups:Name", values: ["everything"] }] }), refs: {} }])],
  ["gateway", "a public zone not named <name_prefix>.labs.clydeford.net", () => plan9([{ address: "aws_route53_zone.z", values: tagged(c9, { name: "example.com", force_destroy: true }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["gateway", "a health check on a site the lab does not own", () => plan9([{ address: "aws_route53_health_check.h", values: tagged(c9, { fqdn: "www.example.com", type: "HTTP", port: 80, resource_path: "/", request_interval: 30, failure_threshold: 3 }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["public", "a bucket policy allowing Principal *", () => plan([{ address: "aws_s3_bucket_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::cloudlabs-${c.prefix}-x/*` }] }) }, unknown: ["bucket"], refs: {} }])],
  ["public", "a topic policy allowing another account", () => plan([{ address: "aws_sns_topic_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sns:Publish", Resource: "*" }] }) }, unknown: ["arn"], refs: {} }])],
  ["public", "a Lambda permission for anyone (principal *)", () => plan([{ address: "aws_lambda_permission.p", values: { action: "lambda:InvokeFunction", principal: "*", statement_id: "all" }, unknown: ["function_name"], refs: {} }])],
  ["public", "an ECS service giving its tasks public IPs", () => plan([ecsService({ network_configuration: [{ assign_public_ip: true }] })])],
  ["size", "a distribution in every edge location (PriceClass_All)", () => plan9([{ address: "aws_cloudfront_distribution.d", values: tagged(c9, { enabled: true, price_class: "PriceClass_All", retain_on_delete: false }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["size", "an ECS service of 10 tasks", () => plan([ecsService({ desired_count: 10 })])],
  ["size", "a Lambda function with 3 GB of memory", () => plan([role(), fnLogs, lambdaFn({ memory_size: 3008 })])],
```
and these tests:
```js
test("ruling P9: the instance-target allow-list passes soa-02's targets and refuses every other selector", () => {
  const own = (targets) => rules(plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets }), refs: {} }]));
  for (const t of [[{ key: "tag:cloudlabs-lab", values: [ID] }], [{ key: "tag:Patch Group", values: [`lab-${ID}-web`] }], [{ key: "resource-groups:Name", values: [`lab-${ID}`] }]]) assert.deepEqual(own(t), [], JSON.stringify(t));
  for (const t of [[{ key: "tag:Patch Group", values: ["web"] }], [{ key: "tag:cloudlabs-lab", values: ["soa-02-systems-manager"] }], [{ key: "tag:Name", values: [`lab-${ID}-*`] }], [{ key: "resource-groups:Name", values: ["lab-soa-02-systems-manager"] }], [{ key: "ParameterValues", values: ["x"] }]]) assert.deepEqual(own(t), ["gateway: aws_ssm_association.x"], JSON.stringify(t));
});

test("ruling P7: in lab 09 only a WAF web ACL for CloudFront may live in us-east-1; CloudFront and Route 53 carry no region", () => {
  const waf = (aclScope) => scope.checkPlanAws(plan9([{ address: "aws_wafv2_web_acl.w", values: tagged(c9, { name: "lab-soa-09-route53-cloudfront-w", scope: aclScope, region: "us-east-1" }), refs: {} }]), c9.id).map((x) => x.rule);
  assert.ok(!waf("CLOUDFRONT").includes("provider"), "a CloudFront WAF may be in us-east-1 (its type is batch 4's to list)");
  assert.ok(waf("REGIONAL").includes("provider"));
  const cf = realisticPlan({ resources: [{ address: "aws_cloudfront_distribution.d", values: tagged(c9, { enabled: true }), refs: {} }], providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c9.variables });
  assert.equal(cf.resource_changes.find((x) => x.address === "aws_cloudfront_distribution.d").change.after.region, undefined, "global types have no region of their own (computed.json)");
});

test("ruling P10: a bucket policy for CloudFront and soa-01's topic policy pass; an unknown one is refused", () => {
  const p = (doc, unknown = []) => rules(plan([{ address: "aws_s3_bucket_policy.p", values: doc === null ? {} : { policy: JSON.stringify(doc) }, unknown: ["bucket", ...unknown], refs: {} }]));
  assert.deepEqual(p({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::cloudlabs-${c.prefix}-site/*`, Condition: { ArnLike: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/*` } } }] }), []);
  assert.deepEqual(p({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "s3:*", Resource: "*" }, { Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }] }), []);
  assert.deepEqual(p(null, ["policy"]), ["public: aws_s3_bucket_policy.p"]);
});

test("ruling P4: cfnTemplateProblems reads a parameter's value through Ref, and a clean template has no problems", () => {
  const doc = { Parameters: { LogGroupName: { Type: "String" } }, Resources: { L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: { Ref: "LogGroupName" }, RetentionInDays: 1 } }, Q: { Type: "AWS::SQS::Queue" } } };
  assert.deepEqual(scope.cfnTemplateProblems(doc, { labId: ID, parameters: { LogGroupName: `/cloudlabs/${ID}/stack` } }), []);
  assert.deepEqual(scope.cfnTemplateProblems(doc, { labId: ID, parameters: { LogGroupName: "/cloudlabs/soa-02-systems-manager/x" } }), [`L: LogGroupName must start /cloudlabs/${ID}/ (a literal or a Ref to a stack parameter; ruling A56)`]);
});
```
In `scripts/test/lab-lint.test.mjs`, add (with `mkdirSync` in its `node:fs` import):
```js
test("cfn (ruling P4): --cloud aws reads terraform/cfn/*.yaml: short-form tags, Transform, IAM types, custom resources, Retain and literal CIDRs are refused; the long form passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "lint-cfn-"));
  mkdirSync(join(dir, "cfn"));
  writeFileSync(join(dir, "main.tf"), "# main.tf\n");
  const good = ["# cfn/stack.yaml", "# Short forms such as !Ref are not read here.", "Resources:", "  Q:", "    Type: AWS::SQS::Queue", "    Properties:", "      VisibilityTimeout:", "        Ref: Timeout", "    DeletionPolicy: Delete", ""].join("\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), good);
  assert.deepEqual(lintDir(dir, { cloud: "aws" }), []);
  const bad = [
    "Transform: AWS::Serverless-2016-10-31",
    "Resources:",
    "  R:",
    "    Type: AWS::IAM::Role",
    "  C:",
    "    Type: Custom::Thing",
    "    DeletionPolicy: Retain",
    "  Q:",
    "    Type: AWS::SQS::Queue",
    "    Properties:",
    "      VisibilityTimeout: !Ref Timeout",
    "      Cidr: 10.1.0.0/16",
    "",
  ].join("\n");
  writeFileSync(join(dir, "cfn", "stack.yaml"), bad);
  const got = lintDir(dir, { cloud: "aws" }).map((p) => `${p.rule}: ${p.file}:${p.line}`);
  assert.deepEqual(got.sort(), ["cfn: cfn/stack.yaml:1", "cfn: cfn/stack.yaml:11", "cfn: cfn/stack.yaml:4", "cfn: cfn/stack.yaml:6", "cfn: cfn/stack.yaml:7", "literal-cidr: cfn/stack.yaml:12"].sort());
  // An Azure lab's folder never has its cfn/ read.
  assert.deepEqual(lintDir(dir, { cloud: "azure" }).filter((p) => p.file.startsWith("cfn/")), []);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs`
Expected: FAIL (no template rule, `cfnTemplateProblems`, `lintCfnText`, `templateMainResources` types in `computed.json`; batch 2's types refused by `type`).

- [ ] **Step 3: Regenerate the schema facts** (terraform; downloads the providers, no cloud calls): as `extract-computed.mjs`'s header says, in a scratch folder with the same pinned versions (aws 6.69.0, archive 2.8.1, random 3.9.1, time 0.14.2, tls 4.4.1, azurerm 4.81.0, azuread 3.10.0), then `node scripts/test/fixtures/labs/plans/extract-computed.mjs <scratch>/schema.json`. Expected: `computed.json` and `schema-facts.json` gain the new types; no existing type's entry changes (`git diff --stat` shows additions only; if an existing entry changed, the pinned versions differ: fix them, never the entries).

- [ ] **Step 4: Write the code** above in `lab-scope-aws.mjs` and `lab-lint.mjs`; the soa-01 policy change, its fixture and shape entry.

- [ ] **Step 5: Run the targeted checks**

Run: `node --test scripts/test/lab-scope-aws.test.mjs scripts/test/lab-lint.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-aws-soa-01.test.mjs scripts/test/labs-aws-soa-02.test.mjs`, then `npm run labs-tf -- soa-01-cloudwatch soa-02-systems-manager`
Expected: all PASS (soa-02's targets pass the allow-list; soa-01's policy is known at plan and passes rule `public`).

- [ ] **Step 6: Commit**

```bash
git add infra/ci/lab-scope-aws.mjs infra/ci/lab-lint.mjs labs/soa-01-cloudwatch scripts/test
git commit -m "feat(aws labs): scope and lint for batch 2: CloudFormation templates, global regions per resource, an instance-target allow-list, resource policies, and the new types' rules

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 4: Unblock, safety net and Verify clean for batch 2's types

Spec: §8.1–§8.3, §15 (slow deletes, KMS pending deletion, Route 53 zone charge), rulings A36, A53, A58, P4, P6, P11, P12, P18.

**Files:**
- Modify: `infra/ci/lab-aws-safety-net.sh` (discovery of lab-named CloudFront origin access controls; `describe`, `judge`, `gone_err`; handlers; `HANDLED`; the run order; header comment's phase list)
- Modify: `infra/ci/lab-unblock-aws.sh` (RDS: read `DeletionProtection` first; header)
- Test: `scripts/test/lab-aws-cleanup.test.mjs`, `scripts/test/aws-labs-iam.test.mjs` (the CLI-coverage test's lists)

**Interfaces:**
- Consumes: Task 2's policies (every new CLI call is a `LabServices`, `GlobalServices`, `Lab07UsersOther` or tagged change the role may make; the CLI-coverage test proves it). Produces nothing other tasks call.
- Already there from batch 1, used unchanged by lab 10: NAT gateways (delete, polled until `deleted`) before their Elastic IPs (released), load balancers, listeners and target groups, VPC endpoints and Instance Connect Endpoints; Verify clean's real-state reads for each. Lab 08's network ACL goes with the VPC fabric (`fab_acl`, after its subnet), and its VPC peering connection with `del_pcx`.

**Discovery** (in `discover()`, inside the region loop, after the KMS aliases): CloudFront origin access controls take no tags (A4) and are global, so they are listed by name in us-east-1, which `$REGIONS` holds only for `AWS_GLOBAL_LABS`:
```bash
    if [ "$r" = us-east-1 ]; then
      if json="$(awsq "$r" cloudfront list-origin-access-controls)"; then
        while IFS=$'\x1f' read -r n x; do [ -n "$n" ] && add "$r" cloudfront:origin-access-control "$x" "" "$n" 0; done < <(jq -r --arg p "$PREFIX" '.OriginAccessControlList.Items[]? | select((.Name // "") | startswith($p)) | [.Name, .Id] | join("\u001f")' <<<"$json")
      else
        list_failed "CloudFront origin access controls"
      fi
    fi
```

**`gone_err`** gains SQS's two codes: `*NotFound* | NoSuch* | *DoesNotExist* | *NonExistentQueue* | 404) return 0 ;;`.

**`describe`** gains (before `iam:role)`), and `kms:alias` changes to read the alias itself:
```bash
    cloudformation:stack) set -- cloudformation describe-stacks --stack-name "$x"; q='.Stacks[]?' ;;
    sqs:queue) set -- sqs get-queue-url --queue-name "$id"; q='.' ;;
    ssm:parameter) set -- ssm get-parameter --name "/$id"; q='.Parameter' ;;
    secretsmanager:secret) set -- secretsmanager describe-secret --secret-id "$x"; q='select(.DeletedDate == null)' ;;
    lambda:function) set -- lambda get-function-configuration --function-name "${id%%:*}"; q='.' ;;
    access-analyzer:analyzer) set -- accessanalyzer get-analyzer --analyzer-name "$id"; q='.analyzer' ;;
    ecr:repository) set -- ecr describe-repositories --repository-names "$id"; q='.repositories[]?' ;;
    ecs:cluster) set -- ecs describe-clusters --clusters "$x"; q='.clusters[]?' ;;
    ecs:service) set -- ecs describe-services --cluster "${id%%/*}" --services "$x"; q='.services[]?' ;;
    ecs:task) set -- ecs describe-tasks --cluster "${id%%/*}" --tasks "$x"; q='.tasks[]?' ;;
    ecs:task-definition) set -- ecs describe-task-definition --task-definition "$x"; q='.taskDefinition' ;;
    ec2:vpc-flow-log) set -- ec2 describe-flow-logs --flow-log-ids "$id"; q='.FlowLogs[]?' ;;
    cloudfront:distribution) set -- cloudfront get-distribution --id "$id"; q='.Distribution' ;;
    cloudfront:origin-access-control) set -- cloudfront get-origin-access-control --id "$id"; q='.OriginAccessControl' ;;
    route53:hostedzone) set -- route53 get-hosted-zone --id "$id"; q='.HostedZone' ;;
    route53:healthcheck) set -- route53 get-health-check --health-check-id "$id"; q='.HealthCheck' ;;
    kms:alias)
      [ -n "$x" ] || return 3
      set -- kms list-aliases --key-id "$x"; q='.Aliases[]? | select(.AliasName == $id)' ;;
```
and, after `if ! json="$(awsq …)"; then`, before `gone_err && return 1`: `[ "${C_T[$i]}" = ecs:task-definition ] && [ "$(errcode)" = ClientException ] && return 1  # a deleted task definition describes as ClientException (V; Task 13)`.

**`judge`**'s `case` gains, and loses its last line (`[[ "${C_T[$i]}" == kms:* && "$J" = there ]] && J=nohandler`: keys now have a handler, so one still enabled is a named leftover):
```bash
    cloudformation:stack) g='.StackStatus == "DELETE_COMPLETE"' ;;
    ecs:cluster | ecs:service) g='.status == "INACTIVE"' ;;
    ecs:task) g='.lastStatus == "STOPPED"' ;;
    ecs:task-definition) g='.status == "DELETE_IN_PROGRESS"' ;;
    kms:key) g='.KeyState == "PendingDeletion"' ;;
```
(the existing `kms:key | kms:alias)` line becomes this `kms:key)` one; an alias is judged by whether it is still listed).

**Handlers** (new, beside their phase's):
```bash
# Phase 1, workloads. CloudFormation stacks first (ruling P4): deleted and waited for; one that ends DELETE_FAILED
# (a resource its role could not remove, or a hand-made change) is deleted again with FORCE_DELETE_STACK, which leaves
# those resources: they carry the stack's tags, so their own handlers below remove them.
stack_status() {
  describe "$1"
  case $? in
    0) if [ -z "$DJ" ]; then echo DELETE_COMPLETE; else jq -r '.StackStatus // "DELETE_COMPLETE"' <<<"$DJ"; fi ;;
    1) echo DELETE_COMPLETE ;;
    *) echo UNKNOWN ;;
  esac
}
stacks() {
  local i s pass
  local -a left next
  for pass in 1 2; do
    left=()
    for i in $(of_type cloudformation:stack); do
      s="$(stack_status "$i")"
      case "$s" in
        DELETE_COMPLETE | UNKNOWN) ;;
        DELETE_IN_PROGRESS) left+=("$i") ;;
        DELETE_FAILED) wr "$i" "force-delete $(label "$i") (DELETE_FAILED: what it could not delete is left to its own handler)" cloudformation delete-stack --stack-name "${C_A[$i]}" --deletion-mode FORCE_DELETE_STACK && left+=("$i") ;;
        *) [ "$pass" = 1 ] && wr "$i" "delete $(label "$i")" cloudformation delete-stack --stack-name "${C_A[$i]}" && left+=("$i") ;;
      esac
    done
    while [ "${#left[@]}" -gt 0 ]; do
      next=()
      for i in "${left[@]}"; do [[ "$(stack_status "$i")" == *_IN_PROGRESS ]] && next+=("$i"); done
      left=("${next[@]}")
      [ "${#left[@]}" -eq 0 ] && break
      if past_until; then
        for i in "${left[@]}"; do warn "left behind: $(label "$i")"; done
        return 0
      fi
      echo "safety net: waiting for ${#left[@]} stack(s) to delete"
      sleep "$POLL_S"
    done
  done
}
# ECS (ruling P12): services scaled to 0 and deleted, running tasks stopped, clusters deleted once their tasks are gone,
# task definitions deregistered and deleted (Terraform only deregisters, and the tagging API lists them for ever).
del_ecs_service() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.status // ""' <<<"$DJ" 2>/dev/null)" = INACTIVE ] && return 1
  wr "$i" "scale $(label "$i") to 0" ecs update-service --cluster "${C_I[$i]%%/*}" --service "${C_A[$i]}" --desired-count 0
  wr "$i" "delete $(label "$i")" ecs delete-service --cluster "${C_I[$i]%%/*}" --service "${C_A[$i]}" --force
}
del_ecs_task() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.lastStatus // "STOPPED"' <<<"$DJ" 2>/dev/null)" = STOPPED ] && return 1
  wr "$i" "stop $(label "$i")" ecs stop-task --cluster "${C_I[$i]%%/*}" --task "${C_A[$i]}"
}
ecs_clusters() {
  local i pass
  local -a left next
  mapfile -t left < <(of_type ecs:cluster)
  for pass in 1 2 3 4 5 6 7 8 9 10; do
    next=()
    for i in "${left[@]}"; do
      judge "$i"
      [ "$J" = gone ] && continue
      wr "$i" "delete $(label "$i")" ecs delete-cluster --cluster "${C_A[$i]}" || case "$WCODE" in ClusterContains*) next+=("$i") ;; esac
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && return 0
    past_until && break
    echo "safety net: waiting for the tasks of ${#left[@]} ECS cluster(s) to stop (pass $pass)"
    sleep "$POLL_S"
  done
  for i in "${left[@]}"; do warn "left behind: $(label "$i") (its tasks are still stopping)"; done
}
del_taskdef() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  case "$(jq -r '.status // ""' <<<"$DJ" 2>/dev/null)" in
    DELETE_IN_PROGRESS) return 1 ;;
    ACTIVE) wr "$i" "deregister $(label "$i")" ecs deregister-task-definition --task-definition "${C_A[$i]}" ;;
  esac
  wr "$i" "delete $(label "$i")" ecs delete-task-definitions --task-definitions "${C_A[$i]}"
}
del_lambda() { wr "$1" "delete $(label "$1")" lambda delete-function --function-name "${C_I[$1]%%:*}"; }

# Phase 2, edge and DNS. CloudFront (spec §15, slow deletes): every enabled distribution is disabled; then each is
# waited for until Deployed (AWS takes minutes; V up to 20, by UNTIL) and deleted with its newest ETag; then the lab's
# origin access controls, each with its own ETag.
distributions() {
  local i id json etag s e
  local -a left next
  for i in $(of_type cloudfront:distribution); do
    id="${C_I[$i]}"
    if ! json="$(awsq "${C_R[$i]}" cloudfront get-distribution-config --id "$id")"; then
      gone_err || warn "could not read $(label "$i") ($(code))"
      continue
    fi
    if [ "$(jq -r '.DistributionConfig.Enabled' <<<"$json")" = true ]; then
      jq '.DistributionConfig | .Enabled = false' <<<"$json" >"$TMPD/cf-$id.json"
      wr "$i" "disable $(label "$i")" cloudfront update-distribution --id "$id" --if-match "$(jq -r '.ETag' <<<"$json")" --distribution-config "file://$TMPD/cf-$id.json" || continue
    fi
    left+=("$i")
  done
  while [ "${#left[@]}" -gt 0 ]; do
    next=()
    for i in "${left[@]}"; do
      if ! json="$(awsq "${C_R[$i]}" cloudfront get-distribution --id "${C_I[$i]}")"; then
        gone_err || { warn "could not read $(label "$i") ($(code))"; next+=("$i"); }
        continue
      fi
      s="$(jq -r '.Distribution.Status // ""' <<<"$json")"
      e="$(jq -r '.Distribution.DistributionConfig.Enabled' <<<"$json")"
      if [ "$s" = Deployed ] && [ "$e" = false ]; then
        etag="$(jq -r '.ETag' <<<"$json")"
        wr "$i" "delete $(label "$i")" cloudfront delete-distribution --id "${C_I[$i]}" --if-match "$etag"
      else
        next+=("$i")
      fi
    done
    left=("${next[@]}")
    [ "${#left[@]}" -eq 0 ] && break
    if past_until; then
      for i in "${left[@]}"; do warn "left behind: $(label "$i") (still deploying its disabled configuration)"; done
      return 0
    fi
    echo "safety net: waiting for ${#left[@]} CloudFront distribution(s) to finish disabling"
    sleep "$POLL_S"
  done
}
del_oac() {
  local i="$1" json
  if ! json="$(awsq "${C_R[$i]}" cloudfront get-origin-access-control --id "${C_I[$i]}")"; then
    gone_err || warn "could not read $(label "$i") ($(code))"
    return 1
  fi
  wr "$i" "delete $(label "$i")" cloudfront delete-origin-access-control --id "${C_I[$i]}" --if-match "$(jq -r '.ETag' <<<"$json")"
}
# Route 53: every record but the zone's own NS and SOA, as one change batch, then the zone; health checks after (a
# record that names one would stop its delete).
del_zone() {
  local i="$1" z="${C_I[$1]}" json name
  if ! json="$(awsq "${C_R[$i]}" route53 get-hosted-zone --id "$z")"; then
    gone_err || warn "could not read $(label "$i") ($(code))"
    return 1
  fi
  name="$(jq -r '.HostedZone.Name' <<<"$json")"
  if ! json="$(awsq "${C_R[$i]}" route53 list-resource-record-sets --hosted-zone-id "$z")"; then
    warn "could not list the records of $(label "$i") ($(code))"
    return 1
  fi
  jq --arg n "$name" '{Changes: [.ResourceRecordSets[]? | select(((.Type == "NS" or .Type == "SOA") and .Name == $n) | not) | {Action: "DELETE", ResourceRecordSet: .}]}' <<<"$json" >"$TMPD/rr-$z.json"
  if [ "$(jq '.Changes | length' "$TMPD/rr-$z.json")" -gt 0 ]; then
    wr "$i" "delete the records of $(label "$i")" route53 change-resource-record-sets --hosted-zone-id "$z" --change-batch "file://$TMPD/rr-$z.json"
  fi
  wr "$i" "delete $(label "$i")" route53 delete-hosted-zone --id "$z"
}
del_healthcheck() { wr "$1" "delete $(label "$1")" route53 delete-health-check --health-check-id "${C_I[$1]}"; }

# Phase 3, network services: flow logs (before the VPC fabric).
del_flowlog() { wr "$1" "delete $(label "$1")" ec2 delete-flow-logs --flow-log-ids "${C_I[$1]}"; }

# Phase 5, data and the rest.
del_queue() {
  local i="$1" json
  if ! json="$(awsq "${C_R[$i]}" sqs get-queue-url --queue-name "${C_I[$i]}")"; then
    gone_err || warn "could not find $(label "$i") ($(code))"
    return 1
  fi
  wr "$i" "delete $(label "$i")" sqs delete-queue --queue-url "$(jq -r '.QueueUrl' <<<"$json")"
}
del_param() { wr "$1" "delete $(label "$1")" ssm delete-parameter --name "/${C_I[$1]}"; }
del_alias() { wr "$1" "delete $(label "$1")" kms delete-alias --alias-name "${C_I[$1]}"; }
# Ruling P11: a key is scheduled for deletion with the shortest window (7 days, no charge while pending); one already
# pending is left as it is.
del_key() {
  local i="$1"
  describe "$i"
  [ $? -eq 1 ] && return 1
  [ "$(jq -r '.KeyState // ""' <<<"$DJ" 2>/dev/null)" = PendingDeletion ] && return 1
  wr "$i" "schedule $(label "$i") for deletion in 7 days" kms schedule-key-deletion --key-id "${C_I[$i]}" --pending-window-in-days 7
}
del_secret() { wr "$1" "delete $(label "$1") (no recovery window)" secretsmanager delete-secret --secret-id "${C_A[$1]}" --force-delete-without-recovery; }
del_repo() { wr "$1" "delete $(label "$1") and its images" ecr delete-repository --repository-name "${C_I[$1]}" --force; }
del_analyzer() { wr "$1" "delete $(label "$1")" accessanalyzer delete-analyzer --analyzer-name "${C_I[$1]}"; }
```
`del_user` (ruling P6) gains, after the login profile delete and before the attached policies:
```bash
  # Credentials made by hand (the lab makes none): keys, MFA devices, SSH keys, signing certificates, service
  # credentials, each of which stops DeleteUser.
  if json="$(awsq iam iam list-access-keys --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete an access key of $(label "$i")" iam delete-access-key --user-name "$n" --access-key-id "$p"; done < <(jq -r '.AccessKeyMetadata[]?.AccessKeyId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-mfa-devices --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "deactivate an MFA device of $(label "$i")" iam deactivate-mfa-device --user-name "$n" --serial-number "$p"; done < <(jq -r '.MFADevices[]?.SerialNumber // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-ssh-public-keys --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete an SSH key of $(label "$i")" iam delete-ssh-public-key --user-name "$n" --ssh-public-key-id "$p"; done < <(jq -r '.SSHPublicKeys[]?.SSHPublicKeyId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-signing-certificates --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete a signing certificate of $(label "$i")" iam delete-signing-certificate --user-name "$n" --certificate-id "$p"; done < <(jq -r '.Certificates[]?.CertificateId // empty' <<<"$json")
  fi
  if json="$(awsq iam iam list-service-specific-credentials --user-name "$n")"; then
    while IFS= read -r p; do [ -n "$p" ] && wr "$i" "delete a service credential of $(label "$i")" iam delete-service-specific-credential --user-name "$n" --service-specific-credential-id "$p"; done < <(jq -r '.ServiceSpecificCredentials[]?.ServiceSpecificCredentialId // empty' <<<"$json")
  fi
```
`HANDLED` gains `cloudformation:stack ecs:service ecs:task ecs:cluster ecs:task-definition lambda:function cloudfront:distribution cloudfront:origin-access-control route53:hostedzone route53:healthcheck ec2:vpc-flow-log sqs:queue ssm:parameter kms:alias kms:key secretsmanager:secret ecr:repository access-analyzer:analyzer`.

**Run order** (the main body; new lines marked by their phase comment, existing ones unchanged):
```bash
# 1 workloads
stacks
run ecs:service poll del_ecs_service
run ecs:task - del_ecs_task
ecs_clusters
run ecs:task-definition - del_taskdef
run lambda:function - del_lambda
run autoscaling:autoScalingGroup poll del_asg
…(events, Config: unchanged)…
# 2 edge and DNS
distributions
run cloudfront:origin-access-control - del_oac
run route53:hostedzone - del_zone
run route53:healthcheck - del_healthcheck
# 3 network services
…(load balancers … RDS … instances … NAT, EIPs, peering, endpoints, EICE, volumes: unchanged)…
run ec2:vpc-flow-log - del_flowlog
# 4 VPC fabric … (unchanged)
# 5 data and the rest
run s3:bucket - del_bucket
run sns:topic - del_topic
run sqs:queue - del_queue
run ssm:parameter - del_param
run logs:log-group - del_loggroup
…(alarms … baselines, Backup: unchanged)…
run kms:alias - del_alias
run kms:key - del_key
run secretsmanager:secret - del_secret
run ecr:repository - del_repo
run access-analyzer:analyzer - del_analyzer
run ec2:image - del_image
…(snapshots, resource groups, IAM: unchanged)…
```

**`infra/ci/lab-unblock-aws.sh`** (ruling P18), the `rds:db)` case:
```bash
      rds:db)
        # Only when it is on (or cannot be read): the modify leaves a database "modifying", which a destroy then waits on.
        if dj="$(awsq "$r" rds describe-db-instances --db-instance-identifier "$id")" && [ "$(jq -r '.DBInstances[0].DeletionProtection' <<<"$dj" 2>/dev/null)" = false ]; then
          echo "unblock: rds:db $id has no deletion protection"
        else
          do_write "$r" "turn off deletion protection on rds:db $id" rds modify-db-instance --db-instance-identifier "$id" --no-deletion-protection --apply-immediately
        fi ;;
```

- [ ] **Step 1: Write the failing tests** in `scripts/test/lab-aws-cleanup.test.mjs` (same harness, `world` and `ENV` as the file's other tests; `G` for global-region items):

```js
const G = { ...ENV, LAB_REGIONS: "us-east-1" };
const ARNOF = (svc, rest, region = "eu-west-2") => `arn:aws:${svc}:${region}:123456789012:${rest}`;
const writes = (w, re = /^aws \S+ (delete|terminate|stop|update|deregister|schedule|deactivate|change|disable)/) => w.calls().filter((c) => re.test(c));
const before = (list, a, b) => list.findIndex((c) => a.test(c)) >= 0 && list.findIndex((c) => a.test(c)) < list.findIndex((c) => b.test(c));

test("Review Focus 1: a stack that ends DELETE_FAILED is force-deleted, and what it left goes by its own handler", { skip }, () => {
  const stack = ARNOF("cloudformation", "stack/lab-soa-06-cloudformation-stack/0abc");
  const st = (s) => JSON.stringify({ Stacks: [{ StackName: "lab-soa-06-cloudformation-stack", StackStatus: s }] });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(stack, ARNOF("sqs", "lab-soa-06-cloudformation-stack-WorkQueue-AbC")) },
    { cmd: "aws", match: "^cloudformation describe-stacks", out: [st("CREATE_COMPLETE"), st("DELETE_FAILED"), st("DELETE_FAILED"), st("DELETE_COMPLETE")] },
    { cmd: "aws", match: "^sqs get-queue-url", out: '{"QueueUrl":"https://sqs.eu-west-2.amazonaws.com/123456789012/lab-soa-06-cloudformation-stack-WorkQueue-AbC"}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-06-cloudformation"], ENV).status, 0);
  const ws = writes(w);
  assert.equal(ws.filter((c) => c.startsWith("aws cloudformation delete-stack")).length, 2);
  assert.ok(before(ws, /delete-stack --stack-name \S+ --region/, /--deletion-mode FORCE_DELETE_STACK/));
  assert.ok(before(ws, /FORCE_DELETE_STACK/, /^aws sqs delete-queue --queue-url https:\/\/sqs/));
  w.cleanup();
});

test("Review Focus 1: CloudFront is disabled, waited for until Deployed, deleted with the new ETag, then its origin access control", { skip }, () => {
  const dist = "arn:aws:cloudfront::123456789012:distribution/E1ABC";
  const d = (status, enabled, etag) => JSON.stringify({ ETag: etag, Distribution: { Id: "E1ABC", Status: status, DistributionConfig: { Enabled: enabled } } });
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(dist) },
    { cmd: "aws", match: "^cloudfront list-origin-access-controls", out: JSON.stringify({ OriginAccessControlList: { Items: [{ Id: "OAC1", Name: "lab-soa-09-route53-cloudfront-a09k3x9q" }, { Id: "OAC2", Name: "someone-else" }] } }) },
    { cmd: "aws", match: "^cloudfront get-distribution-config", out: JSON.stringify({ ETag: "E1", DistributionConfig: { Enabled: true, Comment: "lab" } }) },
    { cmd: "aws", match: "^cloudfront get-distribution --id", out: [d("InProgress", false, "E2"), d("Deployed", false, "E3")] },
    { cmd: "aws", match: "^cloudfront get-origin-access-control --id OAC1", out: '{"ETag":"O1","OriginAccessControl":{"Id":"OAC1"}}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-09-route53-cloudfront"], G).status, 0);
  const ws = writes(w, /^aws cloudfront (update|delete)/);
  assert.match(ws[0], /^aws cloudfront update-distribution --id E1ABC --if-match E1 --distribution-config file:\/\/\S+ --region us-east-1$/);
  assert.match(ws[1], /^aws cloudfront delete-distribution --id E1ABC --if-match E3 --region us-east-1$/);
  assert.match(ws[2], /^aws cloudfront delete-origin-access-control --id OAC1 --if-match O1 --region us-east-1$/);
  assert.equal(ws.length, 3, "never someone else's origin access control");
  w.cleanup();
});

// The change batch file lives in the script's temp folder, which is gone when the script ends, so the NS/SOA filter is
// pinned by running the script's own jq line on the same answer.
test("Route 53: the records go in one batch (never the zone's own NS and SOA), then the zone, then its health check", { skip }, () => {
  const jqLine = readFileSync(join(REPO, "infra", "ci", "lab-aws-safety-net.sh"), "utf8").match(/jq --arg n "\$name" '([^']+)'/)[1];
  const rr = { ResourceRecordSets: [{ Name: "z.", Type: "NS" }, { Name: "z.", Type: "SOA" }, { Name: "www.z.", Type: "CNAME" }, { Name: "sub.z.", Type: "NS" }] };
  const filtered = spawnSync(BASH, ["-c", `jq -c --arg n z. '${jqLine}'`], { input: JSON.stringify(rr), encoding: "utf8" });
  assert.deepEqual(JSON.parse(filtered.stdout).Changes.map((c) => `${c.ResourceRecordSet.Name} ${c.ResourceRecordSet.Type}`), ["www.z. CNAME", "sub.z. NS"]);
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:route53:::hostedzone/Z0LAB", "arn:aws:route53:::healthcheck/hc-1") },
    { cmd: "aws", match: "^route53 get-hosted-zone", out: '{"HostedZone":{"Id":"/hostedzone/Z0LAB","Name":"a09k3x9q.labs.clydeford.net."}}' },
    { cmd: "aws", match: "^route53 list-resource-record-sets", out: JSON.stringify({ ResourceRecordSets: [{ Name: "a09k3x9q.labs.clydeford.net.", Type: "NS" }, { Name: "a09k3x9q.labs.clydeford.net.", Type: "SOA" }, { Name: "www.a09k3x9q.labs.clydeford.net.", Type: "CNAME", SetIdentifier: "primary", Failover: "PRIMARY", TTL: 60, ResourceRecords: [{ Value: "blue" }] }] }) },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-09-route53-cloudfront"], G).status, 0);
  const ws = writes(w, /^aws route53 (change|delete)/);
  assert.equal(ws.length, 3);
  assert.match(ws[0], /^aws route53 change-resource-record-sets --hosted-zone-id Z0LAB --change-batch file:\/\//);
  assert.match(ws[1], /^aws route53 delete-hosted-zone --id Z0LAB/);
  assert.match(ws[2], /^aws route53 delete-health-check --health-check-id hc-1/);
  w.cleanup();
});

test("ECS: services scaled to 0 and deleted, then the cluster; task definitions deregistered and deleted (ruling P12)", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARNOF("ecs", "cluster/lab-soa-10-containers"), ARNOF("ecs", "service/lab-soa-10-containers/lab-soa-10-containers-web"), ARNOF("ecs", "task-definition/lab-soa-10-containers-web:1")) },
    { cmd: "aws", match: "^ecs describe-services", out: ['{"services":[{"status":"ACTIVE"}]}', '{"services":[{"status":"INACTIVE"}]}'] },
    { cmd: "aws", match: "^ecs describe-clusters", out: ['{"clusters":[{"status":"ACTIVE"}]}'] },
    { cmd: "aws", match: "^ecs describe-task-definition", out: '{"taskDefinition":{"status":"ACTIVE"}}' },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-10-containers"], ENV).status, 0);
  const ws = writes(w, /^aws ecs /);
  const order = ["update-service", "delete-service", "delete-cluster", "deregister-task-definition", "delete-task-definitions"].map((v) => ws.findIndex((c) => c.startsWith(`aws ecs ${v} `)));
  assert.ok(order.every((x, k) => x >= 0 && (k === 0 || x > order[k - 1])), ws.join("\n"));
  assert.match(ws.find((c) => c.startsWith("aws ecs delete-service")), /--force/);
  w.cleanup();
});

test("ruling P6: hand-made keys, MFA devices and SSH keys go before lab 07's user", { skip }, () => {
  const n = "lab-soa-07-iam-kms-ann";
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged() },
    { cmd: "aws", match: "^iam list-roles", out: '{"Roles":[]}' },
    { cmd: "aws", match: "^iam list-instance-profiles", out: '{"InstanceProfiles":[]}' },
    { cmd: "aws", match: "^iam list-policies", out: '{"Policies":[]}' },
    { cmd: "aws", match: "^iam list-users", out: JSON.stringify({ Users: [{ UserName: n }, { UserName: "steven" }] }) },
    { cmd: "aws", match: "^iam list-access-keys", out: '{"AccessKeyMetadata":[{"AccessKeyId":"AKIAEXAMPLE1"}]}' },
    { cmd: "aws", match: "^iam list-mfa-devices", out: '{"MFADevices":[{"SerialNumber":"arn:aws:iam::123456789012:mfa/ann"}]}' },
    { cmd: "aws", match: "^iam list-ssh-public-keys", out: '{"SSHPublicKeys":[{"SSHPublicKeyId":"APKAEXAMPLE"}]}' },
    { cmd: "aws", match: "^iam list-attached-user-policies", out: '{"AttachedPolicies":[]}' },
    { cmd: "aws", match: "^iam list-user-policies", out: '{"PolicyNames":[]}' },
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-07-iam-kms"], ENV).status, 0);
  const ws = writes(w, /^aws iam (delete|deactivate)/);
  for (const v of ["delete-access-key", "deactivate-mfa-device", "delete-ssh-public-key"]) assert.ok(before(ws, new RegExp(`^aws iam ${v} --user-name ${n} `), /^aws iam delete-user /), v);
  assert.ok(!ws.some((c) => c.includes("steven")), "never a user outside the lab's prefix");
  w.cleanup();
});

test("ruling P11: the key is scheduled for deletion (7 days) after its alias goes; Verify clean counts a pending key clean", { skip }, () => {
  const key = ARNOF("kms", "key/1234abcd-12ab-34cd-56ef-1234567890ab");
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(key) },
    { cmd: "aws", match: "^kms list-aliases --key-id", out: '{"Aliases":[]}' },
    { cmd: "aws", match: "^kms list-aliases", out: '{"Aliases":[{"AliasName":"alias/lab-soa-07-iam-kms-data","TargetKeyId":"1234abcd-12ab-34cd-56ef-1234567890ab"}]}' },
    { cmd: "aws", match: "^kms describe-key", out: ['{"KeyMetadata":{"KeyState":"Enabled"}}', '{"KeyMetadata":{"KeyState":"PendingDeletion"}}'] },
    ...EMPTY_IAM,
  ]);
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["soa-07-iam-kms"], ENV).status, 0);
  const ws = writes(w, /^aws kms /);
  assert.ok(before(ws, /^aws kms delete-alias --alias-name alias\/lab-soa-07-iam-kms-data/, /^aws kms schedule-key-deletion --key-id 1234abcd-12ab-34cd-56ef-1234567890ab --pending-window-in-days 7/), ws.join("\n"));
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", "soa-07-iam-kms"], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 0, readFileSync(out, "utf8"));
  w.cleanup();
});

test("Verify clean judges batch 2's types by their real state; an inactive task definition and an enabled key are named", { skip }, () => {
  const w = world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged(ARNOF("cloudformation", "stack/s/0abc"), ARNOF("ecs", "cluster/c"), ARNOF("ecs", "task-definition/t:1"), ARNOF("ecs", "task-definition/t:2"), ARNOF("secretsmanager", "secret:lab-x-AbCdEf"), ARNOF("sqs", "q"), ARNOF("kms", "key/k1"), ARNOF("lambda", "function:f"), ARNOF("ec2", "vpc-flow-log/fl-0abc")) },
    { cmd: "aws", match: "^cloudformation describe-stacks", out: '{"Stacks":[{"StackStatus":"DELETE_COMPLETE"}]}' },
    { cmd: "aws", match: "^ecs describe-clusters", out: '{"clusters":[{"status":"INACTIVE"}]}' },
    { cmd: "aws", match: "task-definition/t:1", out: '{"taskDefinition":{"status":"DELETE_IN_PROGRESS"}}' },
    { cmd: "aws", match: "task-definition/t:2", out: '{"taskDefinition":{"status":"INACTIVE"}}' },
    { cmd: "aws", match: "^secretsmanager describe-secret", out: "", code: 254, err: "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: x" },
    { cmd: "aws", match: "^sqs get-queue-url", out: "", code: 254, err: "An error occurred (AWS.SimpleQueueService.NonExistentQueue) when calling the GetQueueUrl operation: x" },
    { cmd: "aws", match: "^kms describe-key", out: '{"KeyMetadata":{"KeyState":"Enabled"}}' },
    { cmd: "aws", match: "^lambda get-function-configuration", out: "", code: 254, err: "An error occurred (ResourceNotFoundException) when calling the GetFunctionConfiguration operation: x" },
    { cmd: "aws", match: "^ec2 describe-flow-logs", out: '{"FlowLogs":[]}' },
    ...EMPTY_IAM,
  ]);
  const out = join(w.dir, "gh-output");
  writeFileSync(out, "");
  assert.equal(w.run("infra/ci/lab-aws-safety-net.sh", ["--verify", ID], { ...ENV, GITHUB_OUTPUT: fwd(out) }).status, 1);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["ecs:task-definition t:2", "kms:key k1"]);
  w.cleanup();
});

test("ruling P18: Unblock changes an RDS instance's deletion protection only when it is not already off", { skip }, () => {
  const db = (on) => world([
    { cmd: "aws", match: "^resourcegroupstaggingapi get-resources", out: tagged("arn:aws:rds:eu-west-2:123456789012:db:db-a05k3x9q") },
    { cmd: "aws", match: "^rds describe-db-instances", out: JSON.stringify({ DBInstances: [{ DeletionProtection: on }] }) },
  ]);
  for (const [on, calls] of [[false, 0], [true, 1]]) {
    const w = db(on);
    assert.equal(w.run("infra/ci/lab-unblock-aws.sh", [ID], ENV).status, 0);
    assert.equal(w.calls().filter((c) => c.startsWith("aws rds modify-db-instance")).length, calls, String(on));
    w.cleanup();
  }
});
```

In `scripts/test/aws-labs-iam.test.mjs`'s CLI-coverage test: `SERVICES_RE`'s service list gains `sqs|secretsmanager|lambda|ecr|accessanalyzer|route53`; `CLI_SERVICE` gains `accessanalyzer: "access-analyzer"`; in `requestsOf` the region default becomes `const r = region ?? (["cloudfront", "route53"].includes(svc) ? "us-east-1" : "eu-west-2");`, the IAM `what` test for users becomes `/user|login-profile|access-key|mfa-device|ssh-public-key|signing-certificate|service-specific-credential/`, and the `named` test gains `|origin-access-control`; the `must` list gains `"cloudformation delete-stack", "cloudfront delete-distribution", "cloudfront delete-origin-access-control", "route53 delete-hosted-zone", "ecs delete-service", "ecs delete-task-definitions", "kms schedule-key-deletion", "iam delete-access-key", "accessanalyzer delete-analyzer"`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: FAIL (no handlers for the new types; Unblock always modifies; the CLI-coverage test does not find the new calls).

- [ ] **Step 3: Write the scripts' changes** above; the header comment's phase list names the new handlers and rulings P4, P6, P11, P12; `bash -n` both scripts.

- [ ] **Step 4: Run the targeted tests**

Run: `node --test scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs`
Expected: PASS (every earlier cleanup test unchanged; the CLI-coverage test finds every new call allowed to wg-admin-labs on a tagged or lab-named item, CloudFront and Route 53 in us-east-1).

- [ ] **Step 5: Commit**

```bash
git add infra/ci/lab-aws-safety-net.sh infra/ci/lab-unblock-aws.sh scripts/test/lab-aws-cleanup.test.mjs scripts/test/aws-labs-iam.test.mjs
git commit -m "feat(aws labs): safety net and Verify clean for stacks, ECS, CloudFront, Route 53, KMS, secrets, Lambda, ECR, Access Analyzer, flow logs and lab 07's user; Unblock reads RDS protection first

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 5: Worker: global labs' us-east-1 tags, lab 07's password behind Show, pending KMS keys not orphans

Spec: §6 (orphans, `GET /labs/:id`, topology), §10, rulings A16, A39, P5, P7, P11.

**Files:**
- Modify: `worker/src/labs/resources.ts` (a global lab's us-east-1 tags), `worker/src/labs/awsTopology.ts` (the same, drawn in the session's region), `worker/src/labs/view.ts` (AWS `users` values withheld), `worker/src/labs/orphans.ts` (`kms:key` ARNs left out of the AWS sweep)
- Modify: `worker/test/labs-helpers.ts` (`AWS_TEST_LABS` gains soa-07 and soa-09)
- Test: `worker/test/labs-aws-reads.test.ts`, `worker/test/topology-aws.test.ts`

**Interfaces:**
- Consumes: `AWS_GLOBAL_LABS` (`shared/labs.ts`). Produces no new API field: `LabSession.outputs.users` keeps its type (`Record<string, string>`), with each AWS value `""`.

**`worker/src/labs/resources.ts`** (`awsLabResources`):
```ts
  // A global lab's CloudFront and Route 53 items are tagged in us-east-1 (ruling P7).
  const regions = [AWS_LAB_REGIONS[0], ...(def.regions.secondary ? [def.regions.secondary] : []), ...(AWS_GLOBAL_LABS.includes(def.id) ? ["us-east-1"] : [])];
  try {
    const out: NonNullable<LabDetail["resources"]> = [];
    for (const region of regions) {
      const group = region === "us-east-1" ? `${labResourceGroupName(def.id)} (global: CloudFront, Route 53)` : `${labResourceGroupName(def.id)} (${awsRegionName(region)})`;
```
(the rest unchanged; `AWS_GLOBAL_LABS` joins the `shared/labs` import; the header's first paragraph gains "and in us-east-1 for a global lab").

**`worker/src/labs/awsTopology.ts`** (`readAwsTopology`, before `const own = …`):
```ts
  // Ruling P7: a global lab's CloudFront and Route 53 items, tagged in us-east-1, sit in the lab's own container (the
  // planned graph draws them there): one more tagging call, no describes.
  if (AWS_GLOBAL_LABS.includes(labId)) {
    const tg = await labTagged(env, net, "us-east-1", labId);
    rows.push(...joinRows(tg, [], region));
    truncated = truncated || tg.truncated;
  }
```

**`worker/src/labs/view.ts`** (`labSession`):
```ts
  // Ruling P5: an AWS lab's users carry an AWS-made password; only GET /labs/:id/secret (Show) returns it.
  const users = outputs?.users ?? {};
  const shownUsers = cloudOfId(s.lab_id) === "aws" ? Object.fromEntries(Object.keys(users).map((k) => [k, ""])) : users;
```
and `outputs: outputs ? { privateIps: outputs.private_ips ?? {}, connect: outputs.connect ?? [], users: shownUsers } : null,` (`cloudOfId` joins the `shared/labs` import).

**`worker/src/labs/orphans.ts`** (`listAws`'s tagging mapping):
```ts
/** Ruling P11: a lab's KMS key waits 7 days to delete (no charge) and the tagging API lists it all week: never an orphan. */
const AWS_SWEEP_SKIP = /^arn:aws[a-z-]*:kms:[^:]*:\d*:key\//;
…
      return page.filter((t) => !AWS_SWEEP_SKIP.test(t.arn)).map((t) => ({ name: taggedName(t.arn), created: null, lab: awsLabId(t.tags[LAB_TAG]) }));
```

**`worker/test/labs-helpers.ts`**: `AWS_TEST_LABS` gains `base("soa-07-iam-kms", 7, { title: "IAM, permission boundaries and KMS", connectivity: { peering: "off", dns_link: false, subnets_used: 0 } })` and `base("soa-09-route53-cloudfront", 9, { title: "Route 53 routing and CloudFront in front of S3", connectivity: { peering: "off", dns_link: false, subnets_used: 0 } })`; `withAwsLabs`' skill areas gain `{ key: "soa.security", exam: "SOA-C03", name: "Security and Compliance" }` and `{ key: "soa.networking", exam: "SOA-C03", name: "Networking and Content Delivery" }` if `base` gives them those areas.

- [ ] **Step 1: Write the failing tests.** In `worker/test/labs-aws-reads.test.ts`, inside `describe("the AWS orphan sweep")`:
```ts
  it("Review Focus 5: a KMS key waiting to delete is never an orphan; other leftovers still are (P11)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    world.labAws.tagged["eu-west-2"] = [
      { arn: "arn:aws:kms:eu-west-2:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab", tags: { "cloudlabs-lab": "soa-07-iam-kms" } },
      { arn: "arn:aws:secretsmanager:eu-west-2:123456789012:secret:lab-soa-07-iam-kms-app-AbCdEf", tags: { "cloudlabs-lab": "soa-07-iam-kms" } },
    ];
    const t0 = new Date(NOW);
    await sweepAwsOrphans(env, budgetedNet(20), t0);
    await sweepAwsOrphans(env, budgetedNet(20), new Date(t0.getTime() + 91 * 60_000));
    const o = await readOrphans(env);
    expect(o).toHaveLength(1);
    expect(o[0].names.some((n) => n.startsWith("kms:key"))).toBe(false);
    expect(o[0].names.some((n) => n.startsWith("secretsmanager:secret"))).toBe(true);
  });
```
and inside `describe("capacity, permissions and resources")`:
```ts
  it("ruling P7: a global lab's resources include what is tagged in us-east-1", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-09-route53-cloudfront");
    world.labAws.tagged["eu-west-2"] = [{ arn: "arn:aws:s3:::cloudlabs-a09k3x9q-site", tags: { "cloudlabs-lab": "soa-09-route53-cloudfront", Name: "site" } }];
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:cloudfront::123456789012:distribution/E1ABC", tags: { "cloudlabs-lab": "soa-09-route53-cloudfront", Name: "cdn-site" } }];
    const r = await api(env, "GET", "/labs/soa-09-route53-cloudfront");
    expect(r.json.resources).toEqual([
      { name: "site", type: "s3:bucket", group: "lab-soa-09-route53-cloudfront (London)", state: null },
      { name: "cdn-site", type: "cloudfront:distribution", group: "lab-soa-09-route53-cloudfront (global: CloudFront, Route 53)", state: null },
    ]);
  });

  it("Review Focus 5: an AWS session's users values are withheld outside /labs/:id/secret (P5)", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const users = { "lab-soa-07-iam-kms-ann": "password Xy7-not-a-real-one at https://123456789012.signin.aws.amazon.com/console" };
    await runningLab(env, world, "soa-07-iam-kms", { hours: 2, peer: false }, { private_ips: {}, connect: [], users, peer_vpc_id: null });
    const d = await api(env, "GET", "/labs/soa-07-iam-kms");
    expect(JSON.stringify(d.json)).not.toContain("Xy7-not-a-real-one");
    expect(JSON.stringify(d.json)).toContain("lab-soa-07-iam-kms-ann");
    const s = await api(env, "GET", "/labs/soa-07-iam-kms/secret");
    expect(s.json.users).toEqual(users);
  });
```
In `worker/test/topology-aws.test.ts`, inside `describe("GET /labs/:id/topology for an AWS lab")`:
```ts
  it("ruling P7: a global lab's us-east-1 items join its London container, within the call cap", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    await runningLab(env, world, "soa-09-route53-cloudfront");
    world.labAws.tagged["us-east-1"] = [{ arn: "arn:aws:cloudfront::123456789012:distribution/E1ABC", tags: { "cloudlabs-lab": "soa-09-route53-cloudfront", Name: "cdn-site" } }];
    const before = world.calls.length;
    const r = await api(env, "GET", "/labs/soa-09-route53-cloudfront/topology");
    expect(world.calls.length - before).toBeLessThanOrEqual(AWS_TOPOLOGY_CALLS_MAX);
    const node = r.json.live.nodes.find((n: { key: string }) => n.key === "cloudfront:distribution/cdn-site");
    expect(node).toMatchObject({ kind: "frontDoor", cloud: "aws" });
    expect(r.json.live.nodes.find((n: { key: string }) => n.key === node.parent).kind).toBe("resourceGroup");
  });
```
(adapt `r.json.live` to the route's response field names as `topology-aws.test.ts`'s existing route test reads them).

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts`
Expected: FAIL (the key is an orphan; no us-east-1 reads; the password shows in the session).

- [ ] **Step 3: Write the code** above.

- [ ] **Step 4: Run the targeted tests and the type check**

Run: `npx vitest run worker/test/labs-aws-reads.test.ts worker/test/topology-aws.test.ts worker/test/labs-aws-engine.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/labs worker/test
git commit -m "feat(aws labs): Worker reads a global lab's us-east-1 tags, keeps lab 07's password behind Show, and never names a pending KMS key an orphan

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 6: Topology: batch 2's types on the planned and live diagrams

Spec: §10 (kinds, the region lane), rulings A35, P7, P19.

**Files:**
- Modify: `shared/topology/rules/awsPlanned.ts` (rules for batch 2's types; `behind()` reaches ECS services), `shared/topology/kinds.ts` (AWS mappings: `flowLog` gains `ec2:vpc-flow-log`/`aws_flow_log` with the `cloudwatch-logs` icon; `monitor` gains `route53:healthcheck`), `shared/topology/awsLive.ts` (skip `ecs:task` and `ecs:task-definition`; fold CloudFormation-made rows into their stack)
- Test: `worker/test/topology-aws.test.ts`

**Interfaces:**
- Consumes: `kindOfAws`, `TfRule` helpers (`into`, `intoReferrer`, `each`). Produces the planned/live keys Tasks 7–11's goldens record: `cloudformation:stack/stack-lab`, `iam:user/user-ann`, `kms:key/key-data`, `secretsmanager:secret/secret-app`, `lambda:function/fn-rotate`, `access-analyzer:analyzer/analyzer-account`, `ec2:network-acl/acl-db`, `ec2:vpc-flow-log/<Name>`, `route53:hostedzone/zone-lab`, `route53:healthcheck/hc-primary`, `cloudfront:distribution/cdn-site`, `ecr:repository/ecr-web`, `ecs:cluster/ecs-lab`, `ecs:service/svc-web`, `ec2:natgateway/nat-lab`.

**`shared/topology/rules/awsPlanned.ts`**: `behind()` gains ECS services:
```ts
/** The targets behind a listener's target groups: Auto Scaling groups, ECS services and instances. */
function behind(tg: TfInst, h: PlannedHelpers): TfInst[] {
  const out: TfInst[] = [...h.referrers(tg, ["aws_autoscaling_group", "aws_ecs_service"])];
```
the ignore list gains `random_password` (`...each(["tls_private_key", "tls_self_signed_cert", "tls_cert_request", "archive_file", "random_password"], { ignore: true })`), and before `// ── Systems Manager and Config`:
```ts
  // ── Batch 2 (labs 06–10) ──
  aws_cloudformation_stack: { arm: "cloudformation:stack" },
  aws_iam_user: { arm: "iam:user", kind: "managedIdentity" },
  ...each(["aws_iam_user_login_profile", "aws_iam_user_policy_attachment"], into("user")),
  aws_kms_key: { arm: "kms:key" },
  aws_kms_alias: into("target_key_id"),
  aws_secretsmanager_secret: { arm: "secretsmanager:secret", kind: "keyVault" },
  ...each(["aws_secretsmanager_secret_version", "aws_secretsmanager_secret_rotation"], into("secret_id")),
  aws_lambda_permission: into("function_name"),
  aws_accessanalyzer_analyzer: { arm: "access-analyzer:analyzer" },
  aws_network_acl: { arm: "ec2:network-acl" },
  ...each(["aws_network_acl_rule", "aws_network_acl_association"], into("network_acl_id")),
  aws_flow_log: { arm: "ec2:vpc-flow-log", kind: "flowLog" },
  aws_route53_zone: { arm: "route53:hostedzone" },
  aws_route53_record: into("zone_id"),
  aws_route53_health_check: { arm: "route53:healthcheck", kind: "monitor" },
  aws_cloudfront_distribution: {
    arm: "cloudfront:distribution",
    edges: (i, h) => h.refs(i, ["origin"]).filter((t) => t.type === "aws_s3_bucket" || t.type === "aws_lb").map((t) => ({ from: i, to: t, kind: "traffic" as const, label: "origin" })),
  },
  aws_cloudfront_origin_access_control: intoReferrer("aws_cloudfront_distribution"),
  aws_ecr_repository: { arm: "ecr:repository" },
  aws_ecr_lifecycle_policy: into("repository"),
  aws_ecs_cluster: { arm: "ecs:cluster" },
  aws_ecs_task_definition: { arm: "ecs:task-definition", ...intoReferrer("aws_ecs_service") },
  aws_ecs_service: { arm: "ecs:service", props: (i) => ({ instances: num(i.after.desired_count) }) },
```
(`awsNameOf` gains `?? str(a.analyzer_name) ?? str(a.family)` before the address fallback.)

**`shared/topology/kinds.ts`** (the `AWS` table): `flowLog: { icon: "cloudwatch-logs", types: ["ec2:vpc-flow-log"], tf: ["aws_flow_log"] }`, and `monitor`'s `types` gains `"route53:healthcheck"`. No new sprite symbol: both icons are in `icons/aws.svg` already.

**`shared/topology/awsLive.ts`**: `AWS_LIVE_SKIP` gains `"ecs:task"` and `"ecs:task-definition"` (the plan folds the task definition into its service; tasks come and go); and where rows become nodes:
```ts
  // Ruling P19: what a CloudFormation stack made carries the stack's tags too, and CloudFormation's own
  // aws:cloudformation:stack-name: the planned graph draws only the stack, so the live one folds them into it.
  const fromStack = (row: AwsRow) => typeof row.tags["aws:cloudformation:stack-name"] === "string" && row.type !== "cloudformation:stack";
```
with rows for which `fromStack(row)` is true left out (as `AWS_LIVE_SKIP` rows are).

- [ ] **Step 1: Write the failing tests** in `worker/test/topology-aws.test.ts`:
```ts
describe("batch 2's types on the diagrams", () => {
  const b2 = (labId: string, changes: ReturnType<typeof ch>[], refs: Record<string, Record<string, string[]>>) => plannedGraph({ labId, version: 1, number: "10", changes: [ch("aws_resourcegroups_group.lab", { name: `lab-${labId}` }), ...changes], outputs: { peer_vpc_id: null }, refs } as never);

  it("an ECS service behind an ALB: the task definition folds in, the LB's edge reaches the service; ECR and the cluster are their own cards", () => {
    const g = b2("soa-10-containers", [
      ch("aws_lb.web", { load_balancer_type: "application", tags: { Name: "alb-web" } }),
      ch("aws_lb_target_group.web", { tags: { Name: "tg-web" } }),
      ch("aws_lb_listener.http", { port: 80, protocol: "HTTP", tags: { Name: "listener-http" } }),
      ch("aws_ecs_cluster.lab", { name: "lab-soa-10-containers", tags: { Name: "ecs-lab" } }),
      ch("aws_ecs_task_definition.web", { family: "lab-soa-10-containers-web", tags: { Name: "td-web" } }),
      ch("aws_ecs_service.web", { name: "lab-soa-10-containers-web", desired_count: 2, tags: { Name: "svc-web" } }),
      ch("aws_ecr_repository.web", { name: "lab-soa-10-containers-web", tags: { Name: "ecr-web" } }),
      ch("aws_ecr_lifecycle_policy.web", {}),
    ], {
      "aws_lb_listener.http": { load_balancer_arn: ["aws_lb.web"], default_action: ["aws_lb_target_group.web"] },
      "aws_ecs_service.web": { cluster: ["aws_ecs_cluster.lab"], task_definition: ["aws_ecs_task_definition.web"], load_balancer: ["aws_lb_target_group.web"] },
      "aws_ecr_lifecycle_policy.web": { repository: ["aws_ecr_repository.web"] },
    });
    const keys = g.nodes.map((n) => n.key);
    for (const k of ["ecs:service/svc-web", "ecs:cluster/ecs-lab", "ecr:repository/ecr-web", "elasticloadbalancing:loadbalancer/alb-web"]) expect(keys).toContain(k);
    expect(keys).not.toContain("ecs:task-definition/td-web");
    expect(g.nodes.find((n) => n.key === "ecs:service/svc-web")).toMatchObject({ kind: "containerApp" });
    expect(g.edges.some((e) => e.from === "elasticloadbalancing:loadbalancer/alb-web" && e.to === "ecs:service/svc-web" && e.label === "HTTP 80")).toBe(true);
  });

  it("a distribution fronting its bucket, a zone and a health check; a user, a key and a secret; a stack; a flow log", () => {
    const g = b2("soa-09-route53-cloudfront", [
      ch("aws_s3_bucket.site", { bucket: "cloudlabs-a09k3x9q-site", tags: { Name: "site" } }),
      ch("aws_cloudfront_origin_access_control.site", { name: "lab-soa-09-route53-cloudfront-a09k3x9q" }),
      ch("aws_cloudfront_distribution.site", { tags: { Name: "cdn-site" } }),
      ch("aws_route53_zone.lab", { name: "a09k3x9q.labs.clydeford.net", tags: { Name: "zone-lab" } }),
      ch("aws_route53_record.www_primary", { name: "www.a09k3x9q.labs.clydeford.net" }),
      ch("aws_route53_health_check.primary", { tags: { Name: "hc-primary" } }),
      ch("aws_iam_user.ann", { name: "lab-x-ann", tags: { Name: "user-ann" } }),
      ch("aws_kms_key.data", { tags: { Name: "key-data" } }),
      ch("aws_kms_alias.data", { name: "alias/lab-x-data" }),
      ch("aws_secretsmanager_secret.app", { name: "lab-x-app", tags: { Name: "secret-app" } }),
      ch("aws_cloudformation_stack.lab", { name: "lab-x-stack", tags: { Name: "stack-lab" } }),
      ch("aws_flow_log.data", { tags: { Name: "flow-data" } }),
    ], {
      "aws_cloudfront_distribution.site": { origin: ["aws_s3_bucket.site", "aws_cloudfront_origin_access_control.site"] },
      "aws_route53_record.www_primary": { zone_id: ["aws_route53_zone.lab"] },
      "aws_kms_alias.data": { target_key_id: ["aws_kms_key.data"] },
    });
    const kind = (k: string) => g.nodes.find((n) => n.key === k)?.kind;
    expect([kind("cloudfront:distribution/cdn-site"), kind("route53:hostedzone/zone-lab"), kind("route53:healthcheck/hc-primary"), kind("iam:user/user-ann"), kind("kms:key/key-data"), kind("secretsmanager:secret/secret-app"), kind("ec2:vpc-flow-log/flow-data")]).toEqual(["frontDoor", "dnsZone", "monitor", "managedIdentity", "keyVault", "keyVault", "flowLog"]);
    expect(kind("cloudformation:stack/stack-lab")).toBe("generic");
    expect(g.nodes.some((n) => n.key.includes("origin-access-control") || n.key.startsWith("route53:record"))).toBe(false);
    expect(g.edges.some((e) => e.from === "cloudfront:distribution/cdn-site" && e.to === "s3:bucket/site" && e.label === "origin")).toBe(true);
  });

  it("ruling P19: live rows CloudFormation made fold into their stack; ECS tasks and task definitions are left out", () => {
    const row = (type: string, id: string, tags: Record<string, string>): AwsRow => ({ arn: `arn:aws:${type.split(":")[0]}:eu-west-2:123456789012:${type.split(":")[1]}/${id}`, type, id, region: "eu-west-2", name: tags.Name ?? null, tags: { "cloudlabs-lab": "soa-06-cloudformation", ...tags }, props: {}, refs: {} });
    const g = awsLiveGraph([
      row("resource-groups:group", "lab-soa-06-cloudformation", { Name: "lab-soa-06-cloudformation" }),
      row("cloudformation:stack", "lab-soa-06-cloudformation-stack", { Name: "stack-lab" }),
      row("sqs:queue", "lab-soa-06-cloudformation-stack-WorkQueue-AbC", { "aws:cloudformation:stack-name": "lab-soa-06-cloudformation-stack" }),
      row("ecs:task", "c/0abc", {}),
      row("ecs:task-definition", "t:1", {}),
    ], { labId: "soa-06-cloudformation", version: 1, gatewayVpcIds: [], at: "2026-10-16T00:00:00Z" });
    const keys = g.nodes.map((n) => n.key);
    expect(keys).toContain("cloudformation:stack/stack-lab");
    expect(keys.some((k) => k.startsWith("sqs:queue") || k.startsWith("ecs:task"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run worker/test/topology-aws.test.ts`
Expected: FAIL (the new types are generic Terraform-only cards; no ECS edge; CloudFormation rows drawn as added by hand).

- [ ] **Step 3: Write the rules, kinds and live changes** above.

- [ ] **Step 4: Run the targeted tests**

Run: `npx vitest run worker/test/topology-aws.test.ts worker/test/topology-golden.test.ts && npm run typecheck`
Expected: PASS (batch 1's goldens unchanged; the icon coverage test passes: `flowLog` and `monitor` use symbols the sprite has).

- [ ] **Step 5: Commit**

```bash
git add shared/topology worker/test/topology-aws.test.ts
git commit -m "feat(aws labs): batch 2's types on the planned and live diagrams (stacks, users, keys, secrets, flow logs, Route 53, CloudFront, ECR, ECS)

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 7: Lab soa-06-cloudformation

Spec: §12.2 row 06 (deployment; associate; explore; £ 0.01; peering off; 4/4; 2/6; no prerequisite; a stack from `cfn/stack.yaml` (allow-listed types), change sets, drift detection, stack policy), "Not built here": StackSets; §3–§4; rulings A4, A42, A56, P3, P4, P19.

**Files:**
- Create: `labs/soa-06-cloudformation/lab.yaml`, `readme.md`
- Create: `labs/soa-06-cloudformation/terraform/versions.tf`, `main.tf` (both copied unchanged from `labs/_template-aws/`; no `network.tf`, ruling P3), `variables.tf` (the template's `lab_id`, `region` and `tags` blocks only), `stack.tf`, `outputs.tf`, `cfn/stack.yaml`
- Create: `labs/_learning/soa-06-cloudformation.yaml`
- Create: `scripts/test/fixtures/labs/plans/labs/soa-06-cloudformation.mjs`
- Create (generated): `shared/topology/planned/soa-06-cloudformation.json`, `shared/guides/soa-06-cloudformation/architecture.svg` and its `index.json`/`placement.json` entries
- Modify: `worker/test/topology-golden.test.ts` (`GOLDEN["soa-06-cloudformation"]`), `worker/test/fixtures/topology/round-trip.ts` (`AWS_LAB_IDS`)
- Test: `scripts/test/labs-aws-soa-06.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`templateMainResources`, `network.tf` optional), Task 3 (`cfnTemplateProblems`, `lintCfnText`, the `template` rule), Task 6 (`aws_cloudformation_stack` on the diagram), `awsLab`/`commonAwsProblems` (batch 1), `readmeFooter`.

**`labs/soa-06-cloudformation/lab.yaml`**
```yaml
# Lab soa-06 (AWS labs batch 2). SOA-C03 ((V) the wording against the current
# exam guide): Deployment, Provisioning, and Automation: provision resources
# with CloudFormation; change sets; drift detection; stack policies; service
# roles. Costs, authored (nothing here has an hourly or GB-month list price):
# one CloudWatch alarm ($0.10/month), two idle SQS queues, an SNS topic, a
# parameter and a log group: well under a penny an hour. StackSets are
# described under Not built here; lab-scope-aws.mjs refuses them (never).
id: soa-06-cloudformation
version: 1
cloud: aws
title: "CloudFormation inside Terraform"
summary: >-
  A CloudFormation stack written in YAML in the lab's folder and run by its own service role: a work queue with a
  dead-letter queue, a topic, an alarm, a log group and a parameter. Change it with change sets, find drift, and see a
  stack policy refuse an update.
exam: SOA-C03
skill_areas: [soa.deployment]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - { name: "CloudWatch alarm (1)", gbp_h: 0.0001 }
    - { name: "SQS queues, SNS topic, SSM parameter and log group, idle", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 4, destroy_min: 4, session_h: 2, max_h: 6 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: "off", dns_link: false, subnets_used: 0 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/soa-06-cloudformation/terraform/stack.tf`**
```hcl
# stack.tf
#
# Plain English: lab 06's CloudFormation stack, lab-<id>-stack. Its template
# is cfn/stack.yaml in this folder, written with CloudFormation's long-form
# functions (Ref:, Fn::GetAtt:) because Terraform reads it with yamldecode,
# which knows no YAML tags; CloudFormation receives it as JSON. The stack is
# built by the lab's own service role, lab-<id>-cfn (under the lab boundary),
# allowed only the queues, topic, alarm, log group and parameter this stack
# names, so the stack can do no more than its template says (ruling P4). A
# stack policy keeps any update from replacing or deleting the work queue.

locals {
  stack_name = "lab-${var.lab_id}-stack"
  account    = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "cfn" {
  name                 = "lab-${var.lab_id}-cfn"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "cloudformation.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "cfn" {
  name = "lab-${var.lab_id}-cfn"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StackItems"
        Effect = "Allow"
        Action = ["sns:*", "sqs:*", "cloudwatch:*"]
        Resource = [
          "arn:aws:sns:${var.region}:${local.account}:${local.stack_name}-*",
          "arn:aws:sqs:${var.region}:${local.account}:${local.stack_name}-*",
          "arn:aws:cloudwatch:${var.region}:${local.account}:alarm:${local.stack_name}-*",
        ]
      },
      { Sid = "StackLogs", Effect = "Allow", Action = "logs:*", Resource = "arn:aws:logs:${var.region}:${local.account}:log-group:/cloudlabs/${var.lab_id}/*" },
      { Sid = "StackParameters", Effect = "Allow", Action = "ssm:*", Resource = "arn:aws:ssm:${var.region}:${local.account}:parameter/cloudlabs/${var.lab_id}/*" },
      { Sid = "Reads", Effect = "Allow", Action = ["sns:ListTopics", "sqs:ListQueues", "cloudwatch:DescribeAlarms", "logs:DescribeLogGroups", "ssm:DescribeParameters"], Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "cfn" {
  role       = aws_iam_role.cfn.name
  policy_arn = aws_iam_policy.cfn.arn
}

# A new role takes a moment to reach CloudFormation; a stack created at once can be refused it.
resource "time_sleep" "cfn_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.cfn]
}

resource "aws_cloudformation_stack" "lab" {
  name          = local.stack_name
  template_body = jsonencode(yamldecode(file("${path.module}/cfn/stack.yaml")))
  iam_role_arn  = aws_iam_role.cfn.arn
  on_failure    = "DELETE"
  parameters = {
    LabId             = var.lab_id
    VisibilityTimeout = "30"
    MaxReceiveCount   = "3"
    LogGroupName      = "/cloudlabs/${var.lab_id}/stack"
    ParameterName     = "/cloudlabs/${var.lab_id}/config/greeting"
  }
  # The stack policy: any update may go ahead, but never one that replaces or deletes the work queue.
  policy_body = jsonencode({
    Statement = [
      { Effect = "Allow", Action = "Update:*", Principal = "*", Resource = "*" },
      { Effect = "Deny", Action = ["Update:Replace", "Update:Delete"], Principal = "*", Resource = "LogicalResourceId/WorkQueue" },
    ]
  })
  tags       = { Name = "stack-lab" }
  depends_on = [time_sleep.cfn_role]
}
```

**`labs/soa-06-cloudformation/terraform/cfn/stack.yaml`**
```yaml
# cfn/stack.yaml
#
# Plain English: lab 06's CloudFormation template (AWS labs spec §12.2 row
# 06). Terraform reads it with yamldecode and hands it to CloudFormation as
# JSON, so every function is in its long form (Ref:, Fn::GetAtt:): yamldecode
# knows no YAML tags, so the short forms would fail. Only the types on
# lab-scope-aws.mjs CFN_TYPES: a work queue and its dead-letter queue, a
# topic, an alarm on the age of the oldest message, a log group under
# /cloudlabs/<lab id>/ and a parameter. CloudFormation names the queues, topic
# and alarm from the stack's name (lab-<id>-stack-...), so nothing here can
# clash with another lab.
AWSTemplateFormatVersion: "2010-09-09"
Description: cloudlabs lab soa-06, a work queue with a dead-letter queue, an alarm and a topic
Parameters:
  LabId:
    Type: String
    Description: The lab's id (Terraform passes var.lab_id)
  VisibilityTimeout:
    Type: Number
    Default: 30
    MinValue: 0
    MaxValue: 900
    Description: Seconds a received message stays hidden from other consumers
  MaxReceiveCount:
    Type: Number
    Default: 3
    MinValue: 1
    MaxValue: 10
    Description: Receives before a message moves to the dead-letter queue
  LogGroupName:
    Type: String
    AllowedPattern: "^/cloudlabs/.+"
  ParameterName:
    Type: String
    AllowedPattern: "^/cloudlabs/.+"
Resources:
  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      MessageRetentionPeriod: 3600
  WorkQueue:
    Type: AWS::SQS::Queue
    Properties:
      VisibilityTimeout:
        Ref: VisibilityTimeout
      RedrivePolicy:
        deadLetterTargetArn:
          Fn::GetAtt: [DeadLetterQueue, Arn]
        maxReceiveCount:
          Ref: MaxReceiveCount
  AlertTopic:
    Type: AWS::SNS::Topic
    Properties:
      DisplayName: lab soa-06 alerts
  OldestMessageAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: A message has waited more than five minutes in the work queue
      Namespace: AWS/SQS
      MetricName: ApproximateAgeOfOldestMessage
      Dimensions:
        - Name: QueueName
          Value:
            Fn::GetAtt: [WorkQueue, QueueName]
      Statistic: Maximum
      Period: 60
      EvaluationPeriods: 5
      Threshold: 300
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions:
        - Ref: AlertTopic
  StackLog:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName:
        Ref: LogGroupName
      RetentionInDays: 1
  Greeting:
    Type: AWS::SSM::Parameter
    Properties:
      Name:
        Ref: ParameterName
      Type: String
      Value: hello from CloudFormation
      Description: Change me by hand, then detect drift
Outputs:
  WorkQueueUrl:
    Value:
      Ref: WorkQueue
  DeadLetterQueueUrl:
    Value:
      Ref: DeadLetterQueue
  AlertTopicArn:
    Value:
      Ref: AlertTopic
```
(CloudFormation copies the stack's tags, `cloudlabs-lab` among them, onto what it makes (V: Task 13 lists the lab's tagged items while it runs); the safety net needs only the stack's tag, ruling P4.)

**`labs/soa-06-cloudformation/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 06 is up (AWS labs spec
# §4, §10): no instances and no peering, so only Connect lines that read the
# stack, send it a message and ask it about drift.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws cloudformation describe-stacks --stack-name ${aws_cloudformation_stack.lab.name} --query Stacks[0].Outputs",
    "aws sqs send-message --queue-url ${aws_cloudformation_stack.lab.outputs["WorkQueueUrl"]} --message-body hello",
    "aws cloudformation detect-stack-drift --stack-name ${aws_cloudformation_stack.lab.name}",
  ]
}
```

**`labs/soa-06-cloudformation/readme.md`** (exactly):
````markdown
A CloudFormation stack inside a Terraform lab: Terraform makes a service role and hands CloudFormation the template in this lab's folder, and CloudFormation builds a small work queue system from it. Practise changing a stack with change sets, finding drift and seeing a stack policy refuse an update. Everything is listed in the lab's resource group, `lab-soa-06-cloudformation`, in AWS Resource Groups (London), and the stack under CloudFormation, Stacks.
From the SOA-C03 outline: provision and maintain cloud resources with AWS CloudFormation, troubleshoot deployment issues, and manage stacks with change sets, drift detection and stack policies.

## What it deploys

- The stack `lab-soa-06-cloudformation-stack`, from `terraform/cfn/stack.yaml`, with five parameters (the lab's id, the queue's visibility timeout, receives before a message is dead-lettered, and the names of its log group and parameter)
- A work queue and its dead-letter queue (`lab-soa-06-cloudformation-stack-WorkQueue-…` and `…-DeadLetterQueue-…`): a message received three times without being deleted moves to the dead-letter queue
- An SNS topic and the alarm `…-OldestMessageAlarm-…`, which notifies it when a message has waited five minutes
- The log group `/cloudlabs/soa-06-cloudformation/stack` (one day) and the parameter `/cloudlabs/soa-06-cloudformation/config/greeting`
- The service role `lab-soa-06-cloudformation-cfn`: CloudFormation builds the stack as this role, which may touch only what the stack names
- A stack policy that lets any update through except one that replaces or deletes `WorkQueue`

The template is YAML written with the long form of each function (`Ref: VisibilityTimeout`, `Fn::GetAtt: [WorkQueue, Arn]`): Terraform reads it with `yamldecode`, which does not understand the short forms (`!Ref`, `!GetAtt`) you will see in most examples. CloudFormation treats both forms the same.

```text
lab-soa-06-cloudformation (London)
  Terraform --> service role lab-<id>-cfn --> stack lab-<id>-stack (cfn/stack.yaml)
    WorkQueue --(3 receives)--> DeadLetterQueue
    OldestMessageAlarm (WorkQueue age > 5 min) --> AlertTopic
    StackLog /cloudlabs/<id>/stack     Greeting /cloudlabs/<id>/config/greeting
    stack policy: no Update:Replace or Update:Delete on WorkQueue
```

## Things to try

- In CloudFormation, open the stack and choose **Update**, **Make a direct update**, keep the current template and change `VisibilityTimeout` to 60. Choose **Create change set** rather than executing: read what it will modify (one property, no replacement), then execute it. Terraform will see the difference at tear-down and still delete the stack.
- Edit the parameter `/cloudlabs/soa-06-cloudformation/config/greeting` in Systems Manager, Parameter Store, then run **Detect drift** on the stack (or the third Connect line) and read **View drift results**: the parameter shows as modified, with the expected and actual values side by side.
- Try a change the stack policy refuses: a change set that sets `QueueName` on `WorkQueue` (renaming a queue replaces it) fails on execution with the policy's reason, and the stack rolls back. Read the events tab to see where it stopped.
- Send messages with the second Connect line, receive one three times without deleting it (`aws sqs receive-message --queue-url … --visibility-timeout 0`), and find it in the dead-letter queue. Leave one unread for five minutes and watch the alarm go to In alarm.
- Look at the stack's **Template** tab: CloudFormation shows the JSON Terraform handed it. Compare it with `cfn/stack.yaml`.

## Not built here

**StackSets.** A StackSet deploys one template to many accounts and regions from an administrator account, usually across an AWS Organization. This lab works in one account and one region, so StackSets are described here only, and the lab scope check refuses `aws_cloudformation_stack_set`. See [Working with AWS CloudFormation StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html).

## Learn more

- [Updating stacks using change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html)
- [Detect unmanaged configuration changes to stacks and resources with drift detection](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Prevent updates to stack resources (stack policies)](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/protect-stack-resources.html)
- [AWS CloudFormation service role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [Intrinsic function reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html)
- [Using Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-06-cloudformation` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````
(Every link is V: Task 12 runs `npm run labs-verify -- --links soa-06-cloudformation`.)

**`labs/_learning/soa-06-cloudformation.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Change a CloudFormation stack safely with change sets, drift detection and a stack policy.
learn:
  - Read a template's parameters, resources and outputs, and the stack CloudFormation built from it
  - Preview and execute a change set, and see a stack policy refuse a replacement
  - Detect drift after a change made outside CloudFormation
learning_min: 45
```

**The diagram** must contain: `resourceGroup lab-soa-06-cloudformation · London`; `generic stack-lab` (`cloudformation:stack`); `managedIdentity lab-soa-06-cloudformation-cfn` in the region container; and nothing for the role's policy, its attachment or the wait (they fold or are ignored). What the stack makes is not on the planned diagram (ruling P19).

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-06.test.mjs`:

```js
// labs-aws-soa-06.test.mjs
//
// Plain English: lab soa-06-cloudformation is the lab AWS labs spec §12.2
// row 06 describes, built to the §4 contract, and its CloudFormation template
// passes the lint and the plan's template rule (ruling P4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";
import { CFN_TYPES, cfnTemplateProblems } from "../../infra/ci/lab-scope-aws.mjs";
import { lintCfnText } from "../../infra/ci/lab-lint.mjs";

const ID = "soa-06-cloudformation";

test("soa-06 keeps the AWS lab contract (no network.tf: it cannot peer, ruling P3)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.equal(awsLab(ID).files["network.tf"], undefined);
});

test("soa-06's lab.yaml: §12.2 row 06", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.deployment"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 4, destroy_min: 4, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity, { creates: ["role"], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0 && total < 0.01, `under a penny an hour (tier £), got ${total}`);
});

test("soa-06's template: only CFN_TYPES, long-form functions, names from the stack, and the template rule passes it (ruling P4)", () => {
  const { tfDir, tf } = awsLab(ID);
  const text = readFileSync(join(tfDir, "cfn", "stack.yaml"), "utf8");
  assert.deepEqual(lintCfnText({ "cfn/stack.yaml": text }), []);
  const doc = parseYaml(text);
  assert.deepEqual(Object.values(doc.Resources).map((r) => r.Type).sort(), ["AWS::CloudWatch::Alarm", "AWS::Logs::LogGroup", "AWS::SNS::Topic", "AWS::SQS::Queue", "AWS::SQS::Queue", "AWS::SSM::Parameter"]);
  for (const r of Object.values(doc.Resources)) assert.ok(CFN_TYPES.has(r.Type));
  const parameters = { LabId: ID, VisibilityTimeout: "30", MaxReceiveCount: "3", LogGroupName: `/cloudlabs/${ID}/stack`, ParameterName: `/cloudlabs/${ID}/config/greeting` };
  assert.deepEqual(cfnTemplateProblems(JSON.parse(JSON.stringify(doc)), { labId: ID, parameters }), []);
  // stack.tf passes these values (the test above checked the template with them).
  assert.match(tf, /LogGroupName\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/stack"/);
  assert.match(tf, /ParameterName\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/config\/greeting"/);
  assert.match(tf, /VisibilityTimeout = "30"/);
  assert.match(tf, /MaxReceiveCount\s+= "3"/);
  assert.match(tf, /template_body = jsonencode\(yamldecode\(file\("\$\{path\.module\}\/cfn\/stack\.yaml"\)\)\)/);
  assert.match(tf, /iam_role_arn\s+= aws_iam_role\.cfn\.arn/);
  assert.match(tf, /Principal = \{ Service = "cloudformation\.amazonaws\.com" \}/);
  assert.match(tf, /Action = \["Update:Replace", "Update:Delete"\], Principal = "\*", Resource = "LogicalResourceId\/WorkQueue"/);
});

test("soa-06's readme names what it builds and explains StackSets", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-06-cloudformation-stack", "lab-soa-06-cloudformation-cfn", "/cloudlabs/soa-06-cloudformation/config/greeting", "## Not built here", "StackSets", "Ref: VisibilityTimeout"]) assert.ok(readme.includes(s), s);
});

test("soa-06's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-06.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf` and `main.tf` from `labs/_template-aws/` unchanged; `variables.tf` keeps the template's `lab_id`, `region` and `tags` blocks (byte for byte) and its header comment.

- [ ] **Step 4: Write the plan fixture** `scripts/test/fixtures/labs/plans/labs/soa-06-cloudformation.mjs`, in batch 1's fixture shape (`ctxAws(ID, "06")`, `providers: ["aws"]`, `AWS_PROVIDER_CONFIG`, `awsData()`): `resources: [...templateMainResources(c), <one entry per resource block of stack.tf>]`. The role and policy as soa-04's fixture writes its replication role and policy (documents known at plan, the policy's references `var.region`, `local.account` → `data.aws_caller_identity.current…`, `local.stack_name` → `var.lab_id`). `time_sleep.cfn_role`: `values: { create_duration: "20s" }`, `unknown: ["id", "triggers"]` as soa-04's sleep. The stack:
```js
const TEMPLATE = (() => {
  const doc = parseYaml(readFileSync(new URL("../../../../../../labs/soa-06-cloudformation/terraform/cfn/stack.yaml", import.meta.url), "utf8"));
  // jsonencode writes object keys in lexical order.
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(doc));
})();
…
{
  address: "aws_cloudformation_stack.lab",
  values: tagged(c, {
    name: `lab-${c.id}-stack`, template_body: TEMPLATE, on_failure: "DELETE",
    parameters: { LabId: c.id, VisibilityTimeout: "30", MaxReceiveCount: "3", LogGroupName: `/cloudlabs/${c.id}/stack`, ParameterName: `/cloudlabs/${c.id}/config/greeting` },
    policy_body: JSON.stringify({ Statement: [{ Action: "Update:*", Effect: "Allow", Principal: "*", Resource: "*" }, { Action: ["Update:Replace", "Update:Delete"], Effect: "Deny", Principal: "*", Resource: "LogicalResourceId/WorkQueue" }] }),
    tags: { Name: "stack-lab" },
  }),
  unknown: ["iam_role_arn", "outputs", "id"],
  refs: { name: ["local.stack_name"], template_body: ["path.module"], iam_role_arn: ref("aws_iam_role.cfn", "arn"), parameters: ["var.lab_id"] },
}
```
`lab-plans.test.mjs` then proves the fixture matches the `.tf` files and passes `checkPlanAws` (the `template` rule reads `TEMPLATE`).

- [ ] **Step 5: Generate the planned graph and the readme diagram**: `node scripts/labs-topology.mjs soa-06-cloudformation`, review it against "The diagram" above, then `npm run labs-diagrams`. Add `GOLDEN["soa-06-cloudformation"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-06.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- soa-06-cloudformation`, `npm run labs-topology -- --check soa-06-cloudformation` and `npm run labs-diagrams -- --check`
Expected: all PASS (labs-tf's mocked plan reads `template_body` from the file; the lint reads `cfn/stack.yaml`).

- [ ] **Step 7: Commit**

```bash
git add labs/soa-06-cloudformation labs/_learning/soa-06-cloudformation.yaml shared/topology/planned/soa-06-cloudformation.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-06 CloudFormation inside Terraform

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 8: Lab soa-07-iam-kms

Spec: §12.2 row 07 (security, saa.secure; associate; explore; £ 0.01; peering off; 3/3; 2/6; lab roles and one console user under the boundary, Access Analyzer (external), customer key and key policy, secret with Lambda rotation), "Not built here": Organizations and SCPs; §3.1, §3.2 (identity `user`), §4 (`users` output), §7.1 (`Lab07Users`), §15 (KMS pending deletion); rulings A12, A42, A56, A57, P3, P5, P6, P10, P14, P15.

**Files:**
- Create: `labs/soa-07-iam-kms/lab.yaml`, `readme.md`
- Create: `labs/soa-07-iam-kms/terraform/versions.tf`, `main.tf` (copied unchanged; no `network.tf`), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `tags` blocks), `identity.tf`, `kms.tf`, `secret.tf`, `outputs.tf`, `lambda/rotate.py`
- Create: `labs/_learning/soa-07-iam-kms.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-07-iam-kms.mjs`
- Create (generated): `shared/topology/planned/soa-07-iam-kms.json`, `shared/guides/soa-07-iam-kms/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-soa-07.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`Lab07UsersOther`, `access-analyzer:DeleteAnalyzer` as a change, the analyzer's service-linked role), Task 3 (users, analyzer, KMS, secrets, Lambda rules; resource policies), Task 4 (handlers), Task 5 (`users` withheld), Task 6.

**`labs/soa-07-iam-kms/lab.yaml`**
```yaml
# Lab soa-07 (AWS labs batch 2). SOA-C03 ((V) the wording against the current
# exam guide): Security and Compliance (IAM users and roles, permission
# boundaries, IAM Access Analyzer, KMS keys and key policies, Secrets Manager
# rotation); and SAA-C03's Design Secure Architectures.
# Costs, authored (no hourly list price): a KMS key $1/month prorated hourly
# (no charge while it waits to delete, spec §15) -> £0.0010; a secret
# $0.40/month prorated -> £0.0004; Lambda, the account analyzer and IAM free.
id: soa-07-iam-kms
version: 1
cloud: aws
title: "IAM, permission boundaries and KMS"
summary: >-
  A console user and a Lambda role held by a permission boundary, IAM Access Analyzer watching the account, a customer
  managed KMS key with its own key policy, and a secret encrypted with it that a Lambda function rotates.
exam: SOA-C03
skill_areas: [soa.security, saa.secure]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - { name: "KMS customer managed key ($1/month, prorated hourly)", gbp_h: 0.0010 }
    - { name: "Secrets Manager secret ($0.40/month, prorated)", gbp_h: 0.0004 }
    - { name: "Lambda rotations, IAM Access Analyzer (account analyzer), IAM", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: "off", dns_link: false, subnets_used: 0 }
identity:
  creates: [role, user]
  roles: []
  governance: false
```

**`labs/soa-07-iam-kms/terraform/identity.tf`**
```hcl
# identity.tf
#
# Plain English: lab 07's console user, ann (lab-<id>-ann at /cloudlabs-lab/),
# held by the same permission boundary as every lab role. Her own policy
# allows EC2 and CloudFormation reads, the lab's key (by its alias) and the
# lab's secret; the boundary allows EC2, KMS and Secrets Manager but no
# CloudFormation, so the console shows her CloudFormation as not authorised:
# what she may do is where the two overlap. AWS makes her password (it cannot
# be chosen; ruling P5), shown behind Show; she is never asked to change it,
# because the boundary allows her no IAM. force_destroy removes any key or
# MFA device made for her by hand (ruling P6). And the account's IAM Access
# Analyzer for external access (free; one per region per account, ruling P14).

resource "aws_iam_user" "ann" {
  name                 = "lab-${var.lab_id}-ann"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  force_destroy        = true
  tags                 = { Name = "user-ann" }
}

resource "aws_iam_user_login_profile" "ann" {
  user                    = aws_iam_user.ann.name
  password_length         = 20
  password_reset_required = false
}

resource "aws_iam_policy" "ann" {
  name = "lab-${var.lab_id}-ann"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LookAround", Effect = "Allow", Action = ["ec2:Describe*", "cloudformation:ListStacks", "cloudformation:DescribeStacks", "kms:ListKeys", "kms:ListAliases", "secretsmanager:ListSecrets"], Resource = "*" },
      {
        Sid       = "LabKey"
        Effect    = "Allow"
        Action    = ["kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "kms:ResourceAliases" = local.key_alias } }
      },
      { Sid = "LabSecret", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:lab-${var.lab_id}-*" },
    ]
  })
}

resource "aws_iam_user_policy_attachment" "ann" {
  user       = aws_iam_user.ann.name
  policy_arn = aws_iam_policy.ann.arn
}

resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = "lab-${var.lab_id}-account"
  type          = "ACCOUNT"
  tags          = { Name = "analyzer-account" }
}
```

**`labs/soa-07-iam-kms/terraform/kms.tf`**
```hcl
# kms.tf
#
# Plain English: lab 07's customer managed key, alias/lab-<id>-data, which
# encrypts the lab's secret. Its key policy gives the account (its root) every
# KMS action, which is what lets IAM policies (ann's, the rotation role's)
# grant use of the key; the scope check refuses a key policy without it, so
# the key can always be deleted. Deleting waits the shortest window AWS
# allows, 7 days, at no charge. Automatic rotation is left off here (a change
# IAM would judge by a tag that may not be readable yet, ruling P15): switch it
# on by hand (Things to try).

locals {
  key_alias = "alias/lab-${var.lab_id}-data"
}

resource "aws_kms_key" "data" {
  description             = "lab ${var.lab_id}, encrypts the lab secret"
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TheAccountAndItsIamPolicies", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
    ]
  })
  tags = { Name = "key-data" }
}

resource "aws_kms_alias" "data" {
  name          = local.key_alias
  target_key_id = aws_kms_key.data.key_id
}
```

**`labs/soa-07-iam-kms/terraform/secret.tf`**
```hcl
# secret.tf
#
# Plain English: lab 07's secret, lab-<id>-app-<name prefix> (a user name and
# password, encrypted with the lab's key), and a Lambda function,
# lab-<id>-rotate, that rotates it. Secrets Manager calls it in four steps:
# create the new version, set it where it is used, test it, make it current.
# This lab has no database, so "set" only logs; the other three are what any
# rotation does. It rotates once at deploy, then every 30 days, or when you
# press Rotate. The function has no VPC (it calls Secrets Manager's public
# endpoint), writes its log to /cloudlabs/<id>/rotate (one day; ruling A56)
# and runs as lab-<id>-rotate, under the lab boundary, allowed only this lab's
# secrets and key. A 20-second wait lets the new secret's and function's tags
# reach IAM before the first change it judges by them (ruling P15).

resource "random_password" "app" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "lab-${var.lab_id}-app-${var.name_prefix}"
  description             = "lab ${var.lab_id}, an application database login"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 0
  tags                    = { Name = "secret-app" }
}

resource "aws_iam_role" "rotate" {
  name                 = "lab-${var.lab_id}-rotate"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rotate_logs" {
  role       = aws_iam_role.rotate.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "rotate" {
  name = "lab-${var.lab_id}-rotate"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabSecrets", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:lab-${var.lab_id}-*" },
      { Sid = "NewPasswords", Effect = "Allow", Action = "secretsmanager:GetRandomPassword", Resource = "*" },
      {
        Sid       = "LabKey"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "kms:ResourceAliases" = local.key_alias } }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "rotate" {
  role       = aws_iam_role.rotate.name
  policy_arn = aws_iam_policy.rotate.arn
}

resource "aws_cloudwatch_log_group" "rotate" {
  name              = "/cloudlabs/${var.lab_id}/rotate"
  retention_in_days = 1
}

data "archive_file" "rotate" {
  type        = "zip"
  source_file = "${path.module}/lambda/rotate.py"
  output_path = "${path.module}/.terraform/rotate.zip"
}

resource "aws_lambda_function" "rotate" {
  function_name    = "lab-${var.lab_id}-rotate"
  role             = aws_iam_role.rotate.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "rotate.handler"
  filename         = data.archive_file.rotate.output_path
  source_code_hash = data.archive_file.rotate.output_base64sha256
  memory_size      = 128
  timeout          = 30
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.rotate.name
  }
  tags       = { Name = "fn-rotate" }
  depends_on = [aws_iam_role_policy_attachment.rotate, aws_iam_role_policy_attachment.rotate_logs]
}

# Ruling P15: the secret's and the function's tags reach IAM a few seconds after they are made.
resource "time_sleep" "tags" {
  create_duration = "20s"
  depends_on      = [aws_secretsmanager_secret.app, aws_lambda_function.rotate]
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ username = "app", password = random_password.app.result })
  depends_on    = [time_sleep.tags]
  # Rotation writes new versions; this is only the first.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_lambda_permission" "secrets_manager" {
  statement_id  = "SecretsManagerRotation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rotate.function_name
  principal     = "secretsmanager.amazonaws.com"
  source_arn    = aws_secretsmanager_secret.app.arn
  depends_on    = [time_sleep.tags]
}

resource "aws_secretsmanager_secret_rotation" "app" {
  secret_id           = aws_secretsmanager_secret.app.id
  rotation_lambda_arn = aws_lambda_function.rotate.arn
  rotation_rules {
    automatically_after_days = 30
  }
  depends_on = [aws_secretsmanager_secret_version.app, aws_lambda_permission.secrets_manager]
}
```
(`.terraform/` is ignored by git and is where `terraform init` writes anyway; the lint keeps `source_file` inside `path.module`.)

**`labs/soa-07-iam-kms/terraform/lambda/rotate.py`**
```python
# lambda/rotate.py
#
# Plain English: lab 07's rotation function. Secrets Manager calls it four
# times per rotation, with the secret, a token naming the new version, and the
# step: createSecret (make the new version, labelled AWSPENDING, with a new
# password), setSecret (put the password where it is used: this lab has no
# database, so it only logs), testSecret (read the new version back) and
# finishSecret (move AWSCURRENT to it). Every step is safe to run twice.
import json

import boto3

sm = boto3.client("secretsmanager")


def handler(event, context):
    arn, token, step = event["SecretId"], event["ClientRequestToken"], event["Step"]
    meta = sm.describe_secret(SecretId=arn)
    if not meta.get("RotationEnabled"):
        raise ValueError("rotation is not enabled on this secret")
    stages = meta["VersionIdsToStages"]
    if token not in stages:
        raise ValueError("this version is not one of the secret's")
    if "AWSCURRENT" in stages[token]:
        print(f"{step}: version {token} is already current")
        return
    if "AWSPENDING" not in stages[token]:
        raise ValueError("this version is not pending")

    if step == "createSecret":
        current = json.loads(sm.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")["SecretString"])
        try:
            sm.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")
            print("createSecret: the pending version is already there")
        except sm.exceptions.ResourceNotFoundException:
            current["password"] = sm.get_random_password(PasswordLength=24, ExcludePunctuation=True)["RandomPassword"]
            sm.put_secret_value(SecretId=arn, ClientRequestToken=token, SecretString=json.dumps(current), VersionStages=["AWSPENDING"])
            print("createSecret: made the pending version")
    elif step == "setSecret":
        print("setSecret: no database in this lab; a real rotation sets the new password where it is used")
    elif step == "testSecret":
        json.loads(sm.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")["SecretString"])
        print("testSecret: the pending version reads back")
    elif step == "finishSecret":
        for version, labels in stages.items():
            if "AWSCURRENT" in labels and version != token:
                sm.update_secret_version_stage(SecretId=arn, VersionStage="AWSCURRENT", MoveToVersionId=token, RemoveFromVersionId=version)
                print(f"finishSecret: {token} is now current")
                break
    else:
        raise ValueError(f"unknown step {step}")
```

**`labs/soa-07-iam-kms/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 07 is up (AWS labs spec
# §4, §10). users is ann's console sign-in: her user name, and the password
# AWS made with the address to sign in at. It is sensitive, masked in the
# run's log, and shown only behind Show (ruling P5).

output "private_ips" {
  value = {}
}

output "users" {
  sensitive = true
  value = {
    (aws_iam_user.ann.name) = "password ${aws_iam_user_login_profile.ann.password} at https://${data.aws_caller_identity.current.account_id}.signin.aws.amazon.com/console"
  }
}

output "connect" {
  value = [
    "Sign in as ${aws_iam_user.ann.name} (the password is behind Show), in a private window",
    "aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.app.name} --query SecretString --output text",
    "aws secretsmanager rotate-secret --secret-id ${aws_secretsmanager_secret.app.name}",
    "aws accessanalyzer list-findings-v2 --analyzer-arn ${aws_accessanalyzer_analyzer.account.arn}",
  ]
}
```

**`labs/soa-07-iam-kms/readme.md`** (exactly):
````markdown
Identity and encryption with nothing to run but the services themselves: a console user and a Lambda role held by a permission boundary, IAM Access Analyzer looking for anything shared outside the account, a customer managed KMS key with its own key policy, and a secret encrypted with that key which a Lambda function rotates. Everything is listed in the lab's resource group, `lab-soa-07-iam-kms`, in AWS Resource Groups (London); the user and roles are in IAM under the path `/cloudlabs-lab/`.
From the SOA-C03 outline: implement and manage IAM users, roles and policies, permission boundaries and IAM Access Analyzer, protect data with AWS KMS keys and key policies, and store and rotate secrets with AWS Secrets Manager.

## What it deploys

- The console user `lab-soa-07-iam-kms-ann`, with the permission boundary `wg-admin-lab-boundary` and her own policy `lab-soa-07-iam-kms-ann` (EC2 and CloudFormation reads, the lab key through its alias, the lab secret). Her password is behind **Show**; she signs in at the account's sign-in address shown with it
- The customer managed key `alias/lab-soa-07-iam-kms-data`, whose key policy lets the account's IAM policies grant its use, and which waits 7 days (the shortest window) when deleted
- The secret `lab-soa-07-iam-kms-app-<name prefix>` (a user name and password), encrypted with that key
- The function `lab-soa-07-iam-kms-rotate` (Python, no VPC), run as the role `lab-soa-07-iam-kms-rotate` under the same boundary, which rotates the secret once at deploy and every 30 days, and logs to `/cloudlabs/soa-07-iam-kms/rotate`
- The account's IAM Access Analyzer `lab-soa-07-iam-kms-account` (external access, London)

```text
lab-soa-07-iam-kms (London)
  user ann --(own policy AND boundary)--> EC2 reads, key (via alias), secret;  CloudFormation: refused by the boundary
  key alias/lab-<id>-data (key policy: the account's IAM decides) --encrypts--> secret lab-<id>-app-<prefix>
  Secrets Manager --invokes--> function lab-<id>-rotate (role under the boundary) --> new password, AWSCURRENT
  Access Analyzer lab-<id>-account: anything in London shared outside the account
```

## Things to try

- Sign in as `lab-soa-07-iam-kms-ann` in a private window (the first Connect line). EC2 opens; CloudFormation says she is not authorised, although her own policy allows `cloudformation:ListStacks`: the boundary does not, and what she may do is where the two overlap. In IAM, open her user and read **Permissions boundary**; then use the IAM policy simulator (as yourself) on her user for both actions.
- As ann, open the secret in Secrets Manager and **Retrieve secret value**: it decrypts because her policy allows the key through its alias (`kms:ResourceAliases`). Then rotate it (the third Connect line, as yourself), watch `/cloudlabs/soa-07-iam-kms/rotate` for the four steps, and see a new value and a new AWSCURRENT version.
- Turn on **Automatic key rotation** on the key (KMS, Customer managed keys, Key rotation), and read the key policy: it names only the account, which is why IAM policies can grant the key at all.
- Add a statement to the key policy that allows another account (any 12-digit id you invent) `kms:Decrypt`, then open IAM Access Analyzer: a new active finding names the key as shared outside the account. **Archive** it, or remove the statement and **Rescan**; both clear it.
- Make an access key for ann (IAM, her user, Security credentials) and see its last-used date stay empty. Tear-down removes it with her (`force_destroy`); the lab's own pipeline may never make one.

## Not built here

**AWS Organizations and service control policies.** An SCP is a guardrail on a whole account or organizational unit: like a permission boundary it grants nothing and only limits, but it applies to every principal in the account, root included. It needs an AWS Organization, which this single account is not part of, so it is described here only, and the lab scope check refuses `aws_organizations_*`. See [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html).

## Learn more

- [Permissions boundaries for IAM entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [Using AWS Identity and Access Management Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [Key policies in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)
- [Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
- [Rotate AWS Secrets Manager secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [Lambda function rotation](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-07-iam-kms` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-07-iam-kms.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: See permission boundaries, key policies, Access Analyzer and secret rotation decide what is allowed.
learn:
  - Work out a user's effective permissions from an identity policy and a permission boundary
  - Grant use of a KMS key through its key policy and IAM, and find external access with Access Analyzer
  - Rotate a Secrets Manager secret with a Lambda function and read its four steps
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-soa-07-iam-kms · London`; `managedIdentity user-ann`, `managedIdentity lab-soa-07-iam-kms-rotate`; `keyVault key-data`, `keyVault secret-app`; `lambda fn-rotate`; `logAnalytics /cloudlabs/soa-07-iam-kms/rotate`; `generic analyzer-account`; nothing for the alias, login profile, attachments, versions, rotation, permission, password or waits.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-07.test.mjs`:

```js
// labs-aws-soa-07.test.mjs
//
// Plain English: lab soa-07-iam-kms is the lab AWS labs spec §12.2 row 07
// describes: the one AWS lab with an IAM user, held by the boundary, whose
// AWS-made password reaches the dashboard only through the sensitive users
// output (ruling P5); a key whose policy keeps it deletable; a secret its own
// function rotates; and the account's analyzer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_IAM_USER_LABS, validateLearning } from "../lib/labs.mjs";
import { ACCESS_ANALYZER_LABS } from "../../infra/ci/lab-scope-aws.mjs";

const ID = "soa-07-iam-kms";

test("soa-07 keeps the AWS lab contract (no network.tf, ruling P3)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-07's lab.yaml: §12.2 row 07; the one lab with a user and an analyzer", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.security", "saa.secure"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 3, destroy_min: 3, session_h: 2, max_h: 6 });
  assert.deepEqual(yaml.identity, { creates: ["role", "user"], roles: [], governance: false });
  assert.deepEqual([AWS_IAM_USER_LABS, ACCESS_ANALYZER_LABS], [[ID], [ID]]);
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.001 && total < 0.01, `about £0.0014/h, got ${total}`);
});

test("soa-07's user: boundary, force_destroy, no forced reset, and the password only in the sensitive users output (rulings P5, P6)", () => {
  const { tf, files } = awsLab(ID);
  assert.match(tf, /resource "aws_iam_user" "ann" \{[\s\S]*?permissions_boundary = local\.boundary_arn[\s\S]*?force_destroy\s+= true/);
  assert.match(tf, /password_reset_required = false/);
  assert.match(files["outputs.tf"], /output "users" \{\n\s+sensitive = true/);
  const passwordUses = [...tf.matchAll(/aws_iam_user_login_profile\.ann\.password/g)].length;
  assert.equal(passwordUses, 1, "the password appears only in the users output");
  assert.doesNotMatch(files["outputs.tf"].split('output "connect"')[1], /password\}/);
});

test("soa-07's key, secret and rotation: 7-day window, root grant, no recovery window, own function, own log group, waits for tags (ruling P15)", () => {
  const { tf, tfDir } = awsLab(ID);
  for (const re of [
    /deletion_window_in_days = 7/, /Principal = \{ AWS = "arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root" \}, Action = "kms:\*"/,
    /recovery_window_in_days = 0/, /kms_key_id\s+= aws_kms_key\.data\.arn/,
    /log_group\s+= aws_cloudwatch_log_group\.rotate\.name/, /name\s+= "\/cloudlabs\/\$\{var\.lab_id\}\/rotate"/,
    /principal\s+= "secretsmanager\.amazonaws\.com"/, /resource "time_sleep" "tags" \{\n\s+create_duration = "20s"/,
    /type\s+= "ACCOUNT"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /enable_key_rotation\s+= true/, "rotation is switched on by hand (ruling P15)");
  const py = readFileSync(join(tfDir, "lambda", "rotate.py"), "utf8");
  for (const step of ["createSecret", "setSecret", "testSecret", "finishSecret"]) assert.ok(py.includes(`"${step}"`), step);
});

test("soa-07's readme names what it builds and explains SCPs", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-07-iam-kms-ann", "alias/lab-soa-07-iam-kms-data", "lab-soa-07-iam-kms-rotate", "lab-soa-07-iam-kms-account", "## Not built here", "service control policies"]) assert.ok(readme.includes(s), s);
});

test("soa-07's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-07.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf` unchanged; `variables.tf` keeps the template's `lab_id`, `name_prefix`, `region` and `tags` blocks.

- [ ] **Step 4: Write the plan fixture** `soa-07-iam-kms.mjs` in batch 1's fixture shape: `templateMainResources(c)` plus one entry per resource block (the user, login profile, policies and attachments, analyzer, key, alias, `random_password`, secret, role, attachments, log group, function, `time_sleep`, version, permission, rotation) and `data.archive_file.rotate` among `data` (`values: { type: "zip", source_file: "<path>/lambda/rotate.py", output_path: "<path>/.terraform/rotate.zip", output_base64sha256: "(the zip's hash)" }`, known at plan as Terraform reads data sources during plan). Known at plan: every name, the three IAM documents and the key policy (`data.aws_caller_identity`, `var.region`, `var.lab_id`), the login profile's `user` (the user's literal name), `password_reset_required`, the alias name, `recovery_window_in_days`, the function's settings and `logging_config.0.log_group` (the group's literal name). Unknown: ids and ARNs, `aws_iam_user_login_profile.ann.password` (sensitive), `random_password.app.result` (sensitive), the version's `secret_string` (sensitive), the key's `key_id`, the permission's `source_arn`. The plan's `output_changes` hold `users` as sensitive and unknown. `lab-plans.test.mjs` then proves the match and passes `checkPlanAws`.

- [ ] **Step 5: Generate the planned graph and the readme diagram**: `node scripts/labs-topology.mjs soa-07-iam-kms`, review against "The diagram", `npm run labs-diagrams`, add `GOLDEN["soa-07-iam-kms"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-07.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- soa-07-iam-kms`, `npm run labs-topology -- --check soa-07-iam-kms` and `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-07-iam-kms labs/_learning/soa-07-iam-kms.yaml shared/topology/planned/soa-07-iam-kms.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-07 IAM, permission boundaries and KMS

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 9: Lab soa-08-vpc-fix

Spec: §12.2 row 08 (networking, monitoring, ans.operations; associate; break-fix; £ 0.01; peering optional; 5/4; 2/4; app and data VPCs peered, web and db instances, flow logs to CloudWatch; Reachability Analyzer by hand) and its three faults, verbatim; §3.3 (Symptom, What was broken); §4; §9 (per-use charges named); rulings A11, A12, A28, A38, A45, A56, P2, P17.

**Files:**
- Create: `labs/soa-08-vpc-fix/lab.yaml`, `readme.md`
- Create: `labs/soa-08-vpc-fix/terraform/versions.tf`, `main.tf`, `network.tf` (all three copied unchanged), `variables.tf` (the template's `lab_id`, `region`, `address_space`, `gateway_cidr`, `admin_password`, `tags`), `web.tf`, `data.tf`, `flowlogs.tf`, `outputs.tf`
- Create: `labs/_learning/soa-08-vpc-fix.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-08-vpc-fix.mjs`
- Create (generated): `shared/topology/planned/soa-08-vpc-fix.json`, `shared/guides/soa-08-vpc-fix/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-soa-08.test.mjs`

**Interfaces:**
- Consumes: the template network (`aws_vpc.lab` with `cloudlabs-peer = hub`, `aws_subnet.private`, `aws_route_table.private`, `aws_security_group.vms`, `local.vpc_cidr`, `local.azs`, `local.cloud_init_base`, `data.aws_ssm_parameter.al2023_arm64`); Task 3 (peering, network ACLs, flow logs); Task 6 (`aws_network_acl`, `aws_flow_log` on the diagram).

**`labs/soa-08-vpc-fix/lab.yaml`**
```yaml
# Lab soa-08 (AWS labs batch 2), a break-fix lab. SOA-C03 ((V) the wording
# against the current exam guide): Networking and Content Delivery (VPC
# routing, security groups and network ACLs, peering); Monitoring, Logging,
# Analysis, Remediation, and Performance Optimization (VPC Flow Logs); and
# ANS-C01's Network Management and Operation (troubleshooting connectivity).
# The three faults are AWS labs spec §12.2's, verbatim (ruling A28, P17).
# London list prices × 0.75 (labs-verify --aws-prices):
#   t4g.micro $0.0094/h -> £0.0071; t4g.nano (V) -> £0.0037; gp3 8 GiB -> £0.0008 each.
# Authored: flow logs to CloudWatch Logs (a few MB); Instance Connect
# Endpoints and peering inside one AZ are free. Reachability Analyzer is
# charged per analysis (about 7.5p): the readme says so where it suggests one.
id: soa-08-vpc-fix
version: 1
cloud: aws
title: "Break-fix: VPC connectivity troubleshooting"
summary: >-
  An app VPC and a data VPC, peered, and a web instance that cannot reach its database on TCP 3306. Find the three
  faults with VPC Flow Logs, Reachability Analyzer, route tables, network ACLs and security groups, and fix them.
exam: SOA-C03
skill_areas: [soa.networking, soa.monitoring, ans.operations]
level: associate
type: break-fix
prerequisites: []
cost:
  items:
    - name: "EC2 t4g.micro, Linux (vm-db)"
      gbp_h: 0.0071
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.micro, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EC2 t4g.nano, Linux (vm-web)"
      gbp_h: 0.0037
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { instanceType: t4g.nano, operatingSystem: Linux, tenancy: Shared, preInstalledSw: NA, capacitystatus: Used } }
    - name: "EBS gp3 root volume, 8 GiB"
      gbp_h: 0.0008
      qty: 2
      aws_price: { service: AmazonEC2, unit: GB-Mo, gb: 8, filters: { productFamily: Storage, volumeApiName: gp3 } }
    - { name: "VPC Flow Logs to CloudWatch Logs, a few MB", gbp_h: 0.0002 }
    - { name: "EC2 Instance Connect Endpoints (2) and VPC peering in one AZ", gbp_h: 0 }
  pricey: null
timing: { deploy_min: 5, destroy_min: 4, session_h: 2, max_h: 4 }
capacity: { instance_types: [t4g.micro, t4g.nano] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 2 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`labs/soa-08-vpc-fix/terraform/web.tf`**
```hcl
# web.tf
#
# Plain English: lab 08's web instance, vm-web (t4g.nano), in the app VPC
# (the template's vpc-lab, snet-private-1), with the MariaDB client, from
# which the database should answer and does not.

resource "aws_instance" "web" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = ["for i in 1 2 3 4 5; do dnf install -y mariadb105 && break; sleep 10; done"]
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
  volume_tags = merge(var.tags, { Name = "vm-web" })
  tags        = { Name = "vm-web" }
  depends_on  = [aws_vpc_endpoint.s3]
}
```

**`labs/soa-08-vpc-fix/terraform/data.tf`**
```hcl
# data.tf
#
# Plain English: lab 08's data VPC, vpc-data (the slot's second /20), peered
# to the app VPC (vpc-lab). One subnet, snet-db, holds vm-db (MariaDB on TCP
# 3306, user app with the session's password) and the data VPC's own Instance
# Connect Endpoint, in the same subnet so the subnet's network ACL never
# stands between them (ruling P17). snet-db has its own network ACL, acl-db,
# and vm-db its own security group, sg-db. THREE THINGS HERE ARE BROKEN ON
# PURPOSE (readme, What was broken); each is marked FAULT.

locals {
  data_cidr = cidrsubnet(var.address_space, 2, 1)
  db_cidr   = cidrsubnet(local.data_cidr, 4, 0)
  # FAULT 3 aims here: the app VPC's second subnet, where nothing runs (vm-web is in the first).
  wrong_cidr = cidrsubnet(local.vpc_cidr, 4, 1)
}

resource "aws_vpc" "data" {
  cidr_block           = local.data_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "vpc-data" }
}

resource "aws_subnet" "db" {
  vpc_id                  = aws_vpc.data.id
  cidr_block              = local.db_cidr
  availability_zone       = local.azs[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "snet-db" }
}

# FAULT 1: no route back to the app VPC through the peering (rt-private, on the app side, has its route).
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.data.id
  tags   = { Name = "rt-data" }
}

resource "aws_route_table_association" "db" {
  subnet_id      = aws_subnet.db.id
  route_table_id = aws_route_table.data.id
}

resource "aws_vpc_endpoint" "data_s3" {
  vpc_id            = aws_vpc.data.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.data.id]
  tags              = { Name = "vpce-s3-data" }
}

resource "aws_vpc_peering_connection" "app_data" {
  vpc_id      = aws_vpc.lab.id
  peer_vpc_id = aws_vpc.data.id
  auto_accept = true
  tags        = { Name = "pcx-app-data" }
}

resource "aws_route" "app_to_data" {
  route_table_id            = aws_route_table.private.id
  destination_cidr_block    = local.data_cidr
  vpc_peering_connection_id = aws_vpc_peering_connection.app_data.id
}

resource "aws_network_acl" "db" {
  vpc_id = aws_vpc.data.id
  tags   = { Name = "acl-db" }
}

resource "aws_network_acl_association" "db" {
  network_acl_id = aws_network_acl.db.id
  subnet_id      = aws_subnet.db.id
}

resource "aws_network_acl_rule" "in_mysql" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 100
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = local.vpc_cidr
  from_port      = 3306
  to_port        = 3306
}

# Replies to vm-db's own downloads (packages through the S3 endpoint).
resource "aws_network_acl_rule" "in_replies" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 110
  egress         = false
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 1024
  to_port        = 65535
}

# FAULT 2: HTTPS out (packages), but no outbound rule for ephemeral ports: vm-db's replies to the app VPC are dropped.
resource "aws_network_acl_rule" "out_https" {
  network_acl_id = aws_network_acl.db.id
  rule_number    = 100
  egress         = true
  protocol       = "tcp"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
  from_port      = 443
  to_port        = 443
}

resource "aws_security_group" "eice_data" {
  name        = "lab-eice-data"
  description = "Instance Connect Endpoint in vpc-data: SSH out to vm-db"
  vpc_id      = aws_vpc.data.id
  tags        = { Name = "sg-eice-data" }
}

resource "aws_vpc_security_group_egress_rule" "eice_data_ssh" {
  security_group_id = aws_security_group.eice_data.id
  cidr_ipv4         = local.data_cidr
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
}

resource "aws_ec2_instance_connect_endpoint" "data" {
  subnet_id          = aws_subnet.db.id
  security_group_ids = [aws_security_group.eice_data.id]
  preserve_client_ip = false
  tags               = { Name = "eice-data" }
}

resource "aws_security_group" "db" {
  name        = "lab-db"
  description = "vm-db: MySQL from the app VPC, SSH from the Instance Connect Endpoint"
  vpc_id      = aws_vpc.data.id
  tags        = { Name = "sg-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_ssh" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.eice_data.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

# FAULT 3: MySQL from the wrong /24 (the app VPC's second subnet, not vm-web's).
resource "aws_vpc_security_group_ingress_rule" "db_mysql" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = local.wrong_cidr
  ip_protocol       = "tcp"
  from_port         = 3306
  to_port           = 3306
}

resource "aws_vpc_security_group_egress_rule" "db_all" {
  security_group_id = aws_security_group.db.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "db" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.db.id
  vpc_security_group_ids = [aws_security_group.db.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/my.cnf.d/lab.cnf", permissions = "0644", content = "[mysqld]\nbind-address = 0.0.0.0\n" }]
    runcmd = [
      "for i in 1 2 3 4 5; do dnf install -y mariadb105-server && break; sleep 10; done",
      "systemctl enable --now mariadb",
      "mysql -e \"CREATE DATABASE IF NOT EXISTS shop; CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY '${var.admin_password}'; GRANT ALL ON shop.* TO 'app'@'%';\"",
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
  volume_tags = merge(var.tags, { Name = "vm-db" })
  tags        = { Name = "vm-db" }
  depends_on  = [aws_vpc_endpoint.data_s3, aws_network_acl_rule.in_replies, aws_network_acl_rule.out_https, aws_network_acl_association.db]
}
```

**`labs/soa-08-vpc-fix/terraform/flowlogs.tf`**
```hcl
# flowlogs.tf
#
# Plain English: VPC Flow Logs for both of lab 08's VPCs, every accepted and
# rejected flow, in one-minute records, to /cloudlabs/<id>/flow (one day;
# ruling A56), written by the VPC Flow Logs service as the lab's role
# lab-<id>-flowlogs (under the lab boundary), allowed only that log group.

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/cloudlabs/${var.lab_id}/flow"
  retention_in_days = 1
}

resource "aws_iam_role" "flowlogs" {
  name                 = "lab-${var.lab_id}-flowlogs"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_policy" "flowlogs" {
  name = "lab-${var.lab_id}-flowlogs"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabFlowLogGroup", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/cloudlabs/${var.lab_id}/flow:*" },
      { Sid = "FindGroups", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "flowlogs" {
  role       = aws_iam_role.flowlogs.name
  policy_arn = aws_iam_policy.flowlogs.arn
}

resource "aws_flow_log" "app" {
  vpc_id                   = aws_vpc.lab.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-app" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}

resource "aws_flow_log" "data" {
  vpc_id                   = aws_vpc.data.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-data" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}
```

**`labs/soa-08-vpc-fix/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 08 is up (AWS labs spec
# §4, §10). The app VPC is the one peered to the VPN server's (the hub); the
# data VPC is reachable only from the app VPC, through its own peering.

output "private_ips" {
  value = { "vm-web" = aws_instance.web.private_ip, "vm-db" = aws_instance.db.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.web.id} --os-user labadmin --connection-type eice",
    "mysql -h ${aws_instance.db.private_ip} -u app -p shop   (on vm-web; the password is labadmin's)",
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.db.id} --os-user labadmin --connection-type eice",
    "aws logs tail /cloudlabs/${var.lab_id}/flow --since 10m",
    "ssh labadmin@${aws_instance.web.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/soa-08-vpc-fix/readme.md`** (exactly):
````markdown
Two VPCs, an app VPC and a data VPC, joined by a peering connection: a web instance in one and a MariaDB database in the other, and VPC Flow Logs recording both. The web instance cannot reach the database. Use the tools an operator would (flow logs, Reachability Analyzer, route tables, network ACLs, security groups) to find out why, and fix it. Everything is listed in the lab's resource group, `lab-soa-08-vpc-fix`, in AWS Resource Groups (London).
From the SOA-C03 outline: troubleshoot VPC connectivity (route tables, security groups, network ACLs and peering) and analyse network traffic with VPC Flow Logs and VPC Reachability Analyzer.

## What it deploys

- `vpc-lab`, the app VPC (the slot's first /20), with `vm-web` (t4g.nano, the MariaDB client) in `snet-private-1`, the route table `rt-private` and the Instance Connect Endpoint `eice-lab`
- `vpc-data`, the data VPC (the slot's second /20), with `vm-db` (t4g.micro, MariaDB on TCP 3306, database `shop`, user `app` with the session's password) in `snet-db`, the route table `rt-data`, the network ACL `acl-db`, the security group `sg-db` and its own Instance Connect Endpoint `eice-data`
- `pcx-app-data`, the peering connection between the two VPCs
- VPC Flow Logs for both VPCs (`flow-app`, `flow-data`), every flow, one-minute records, to the log group `/cloudlabs/soa-08-vpc-fix/flow` (kept one day), written as the role `lab-soa-08-vpc-fix-flowlogs`

Sign in as `labadmin`; the password is behind **Show**, and the database user `app` has the same password. Connect from the console (EC2, the instance, Connect, EC2 Instance Connect Endpoint) or with the Connect lines. With **Peer to gateway** (only while the VPN server runs in AWS) `vm-web` is reachable from a tunnel client; `vm-db` is not, as a peering never carries traffic onward to a third network.

```text
lab-soa-08-vpc-fix (London)
  vpc-lab (app)                                  vpc-data (data)
    snet-private-1: vm-web --mysql:3306--> pcx-app-data --> snet-db [acl-db]: vm-db [sg-db], eice-data
    rt-private: vpc-data -> pcx                  rt-data: (no route back)
    eice-lab                                     vpce-s3-data
  flow-app, flow-data --> /cloudlabs/<id>/flow
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Symptom

On `vm-web`, `mysql -h <vm-db's address> -u app -p shop` (the second Connect line) waits and then fails with `Can't connect to MySQL server ... (110)`, a timeout. `vm-db` is up and MariaDB is listening: on `vm-db` itself, `sudo ss -ltn` shows `0.0.0.0:3306` and `sudo mysql -e 'SELECT 1'` answers. Find what stops the connection, fix it, and show that the command on `vm-web` now connects.

<details>
<summary>What was broken</summary>

Three faults, and the connection only works once all three are fixed:

- **The database's security group admits MySQL from the wrong /24.** `sg-db` allows TCP 3306 from `snet-private-2`'s range, where nothing runs; `vm-web` is in `snet-private-1`. A Reachability Analyzer path from `vm-web` to `vm-db` on TCP 3306 stops at `sg-db`, and the flow log for `vm-db`'s interface shows the SYNs from `vm-web` as `REJECT`. Fix: change the rule's source to `snet-private-1`'s /24 (or to `vpc-lab`'s whole range).
- **The database subnet's network ACL has no outbound rule for ephemeral ports.** `acl-db` lets 3306 in from `vpc-lab` and HTTPS out, but network ACLs are stateless: the replies from port 3306 go back to `vm-web` on a high port, and nothing allows that outbound, so they hit the final deny. With the first fault fixed, the flow log shows `vm-db`'s inbound 3306 as `ACCEPT` and its replies as `REJECT`. Fix: add an outbound rule allowing TCP 1024-65535 to `vpc-lab`'s range.
- **The data VPC's route table has no route back to the app VPC.** `rt-private` sends `vpc-data`'s range to `pcx-app-data`, but `rt-data` has no route for `vpc-lab`'s range, so the replies have nowhere to go. A peering needs a route on both sides. A Reachability Analyzer path from `vm-db` back to `vm-web` (the replies' way) shows no route; `rt-data`'s Routes tab has only `local` and the S3 endpoint. Fix: add a route to `vpc-lab`'s range through `pcx-app-data` in `rt-data`.

</details>

## Things to try

- Before fixing anything, run **Reachability Analyzer** (VPC, Network Manager, Reachability Analyzer) from `vm-web` to `vm-db` on TCP 3306, and again after each fix. Each analysis costs about 7.5p.
- In CloudWatch Logs Insights, on `/cloudlabs/soa-08-vpc-fix/flow`, run `fields @timestamp, @message | filter @message like / 3306 / | sort @timestamp desc | limit 50` and read the source, destination, ports and `ACCEPT`/`REJECT` of each record. Logs Insights charges for the data scanned (about half a penny per GB).
- With everything fixed, remove `rt-private`'s route to `vpc-data` instead. The connection fails again, but `flow-data` records nothing for it: the packets never reach the data VPC. Compare that with what the first fault looked like.
- Delete `acl-db`'s inbound rule 110 (replies to downloads) and run `sudo dnf check-update` on `vm-db`: it hangs, though nothing else changes. A security group would have let those replies in without a rule; a network ACL does not.
- With **Peer to gateway**, from a tunnel client `ssh labadmin@<vm-web>` works and `ssh labadmin@<vm-db>` does not, even with every fault fixed: the peering between the two lab VPCs never carries the VPN server's traffic onward.

## Learn more

- [Troubleshoot VPC peering connections and route tables](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-routing.html)
- [Control subnet traffic with network access control lists](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html)
- [Security group rules](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html)
- [Logging IP traffic using VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html)
- [What is Reachability Analyzer?](https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-08-vpc-fix` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-08-vpc-fix.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Find and fix three VPC faults between two peered VPCs with flow logs and Reachability Analyzer.
learn:
  - Read VPC Flow Logs records to tell a security group refusal from a network ACL one
  - Use Reachability Analyzer on a path and on its return path
  - Remember that a peering needs routes on both sides and network ACLs need rules both ways
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-soa-08-vpc-fix · London`; `vnet vpc-lab` and `vnet vpc-data` joined by a `peering` edge; `subnet snet-private-1`, `snet-private-2` under `vpc-lab` and `subnet snet-db` under `vpc-data`; `vm vm-web` in `snet-private-1`; `vm vm-db`, `bastion eice-data` in `snet-db`; `bastion eice-lab`; `routeTable rt-private`, `routeTable rt-data`; `nsg sg-vms`, `sg-eice`, `sg-db`, `sg-eice-data`; `generic acl-db`; `privateEndpoint vpce-s3`, `vpce-s3-data`; `flowLog flow-app`, `flowLog flow-data`; `logAnalytics /cloudlabs/soa-08-vpc-fix/flow`; `managedIdentity lab-soa-08-vpc-fix-flowlogs`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-08.test.mjs`:

```js
// labs-aws-soa-08.test.mjs
//
// Plain English: lab soa-08-vpc-fix is the break-fix lab AWS labs spec §12.2
// row 08 describes, with exactly its three faults (ruling A28): no route back
// in the data VPC, no outbound ephemeral rule in the database subnet's ACL,
// and MySQL admitted from the wrong /24.

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-08-vpc-fix";

test("soa-08 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("soa-08's lab.yaml: §12.2 row 08", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "break-fix", ["soa.networking", "soa.monitoring", "ans.operations"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 5, destroy_min: 4, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.008 && total < 0.02, `about £0.01/h, got ${total}`);
});

test("fault 1: rt-data has no route back to the app VPC, while rt-private has one to the data VPC", () => {
  const { lab, tf } = awsLab(ID);
  const routes = resources(lab, "aws_route");
  assert.deepEqual(routes.map((r) => r.labels[1]), ["app_to_data"]);
  assert.match(routes[0].body, /route_table_id\s+= aws_route_table\.private\.id/);
  assert.doesNotMatch(resources(lab, "aws_route_table").find((r) => r.labels[1] === "data").body, /route\s*\{/);
  assert.match(tf, /# FAULT 1/);
});

test("fault 2: acl-db has no outbound rule for ephemeral ports", () => {
  const { lab } = awsLab(ID);
  const rules = resources(lab, "aws_network_acl_rule").map((r) => r.body);
  const out = rules.filter((b) => /egress\s+= true/.test(b));
  assert.equal(out.length, 1);
  assert.match(out[0], /from_port\s+= 443/);
  assert.ok(!out.some((b) => /from_port\s+= 1024/.test(b)));
  assert.ok(rules.some((b) => /egress\s+= false/.test(b) && /from_port\s+= 3306/.test(b)));
});

test("fault 3: sg-db admits 3306 from the app VPC's second /24, not vm-web's", () => {
  const { lab, tf } = awsLab(ID);
  const mysql = resources(lab, "aws_vpc_security_group_ingress_rule").find((r) => r.labels[1] === "db_mysql").body;
  assert.match(mysql, /cidr_ipv4\s+= local\.wrong_cidr/);
  assert.match(tf, /wrong_cidr = cidrsubnet\(local\.vpc_cidr, 4, 1\)/);
  assert.match(resources(lab, "aws_instance").find((r) => r.labels[1] === "web").body, /subnet_id\s+= aws_subnet\.private\[0\]\.id/);
});

test("soa-08's second Instance Connect Endpoint sits in vm-db's subnet (ruling P17); both VPCs have flow logs to the lab's group", () => {
  const { lab } = awsLab(ID);
  assert.match(resources(lab, "aws_ec2_instance_connect_endpoint").find((r) => r.labels[1] === "data").body, /subnet_id\s+= aws_subnet\.db\.id/);
  const flows = resources(lab, "aws_flow_log");
  assert.deepEqual(flows.map((r) => r.labels[1]).sort(), ["app", "data"]);
  for (const f of flows) assert.match(f.body, /log_destination\s+= aws_cloudwatch_log_group\.flow\.arn/);
});

test("soa-08's readme: Symptom, a closed What was broken naming the three faults, and the Reachability Analyzer charge", () => {
  const { readme } = awsLab(ID);
  assert.match(readme, /## Symptom/);
  assert.match(readme, /<details>\n<summary>What was broken<\/summary>/);
  for (const s of ["sg-db", "acl-db", "rt-data", "pcx-app-data", "7.5p"]) assert.ok(readme.includes(s), s);
});

test("soa-08's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-08.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged; trim `variables.tf` to the six variables named.

- [ ] **Step 4: Write the plan fixture** `soa-08-vpc-fix.mjs`: `[...templateResources(c), …]`; `aws_instance.web` and `.db` from `al2023Instance(c, { key: "web", name: "vm-web", type: "t4g.nano" })` and `al2023Instance(c, { key: "db", name: "vm-db", subnet: "aws_subnet.db", sgs: ["aws_security_group.db"] })` (the db's cloud-init holds `var.admin_password`: sensitive, known at plan); `aws_vpc.data` with `cidr_block: cidrsubnet(c.address, 2, 1)`, `aws_subnet.db` with `cidrsubnet(cidrsubnet(c.address, 2, 1), 4, 0)`; the route's `destination_cidr_block` known; each ACL rule's values known (`cidr_block` from `local.vpc_cidr` or the literal); `aws_vpc_security_group_ingress_rule.db_mysql`'s `cidr_ipv4: cidrsubnet(c.vpcCidr, 4, 1)`; the flow logs' `log_destination`, `iam_role_arn`, `vpc_id` unknown with their references; the role and policy documents known. `lab-plans.test.mjs` proves it (rule `address`: both VPCs inside the slot, no overlap; rule `gateway`: the peering is between the lab's own VPCs).

- [ ] **Step 5: Generate the planned graph and the readme diagram**: `node scripts/labs-topology.mjs soa-08-vpc-fix`, review against "The diagram", `npm run labs-diagrams`, add `GOLDEN["soa-08-vpc-fix"]` and the id to `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-08.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs scripts/test/lab-lint.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- soa-08-vpc-fix`, `npm run labs-topology -- --check soa-08-vpc-fix` and `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-08-vpc-fix labs/_learning/soa-08-vpc-fix.yaml shared/topology/planned/soa-08-vpc-fix.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-08 break-fix VPC connectivity troubleshooting

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 10: Lab soa-09-route53-cloudfront

Spec: §12.2 row 09 (networking, ans.design; associate; explore; £ 0.01; peering off; 8/12; 2/4; public zone `<name_prefix>.labs.clydeford.net` (not delegated), health checks, failover and weighted records, CloudFront with OAC to a private bucket); §15 (slow CloudFront deletes, Route 53 zone charge); rulings A4, A27, P3, P7, P8, P10.

**Files:**
- Create: `labs/soa-09-route53-cloudfront/lab.yaml`, `readme.md`
- Create: `labs/soa-09-route53-cloudfront/terraform/versions.tf`, `main.tf` (copied unchanged; no `network.tf`), `variables.tf` (`lab_id`, `name_prefix`, `region`, `tags`), `site.tf`, `cdn.tf`, `dns.tf`, `outputs.tf`
- Create: `labs/_learning/soa-09-route53-cloudfront.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-09-route53-cloudfront.mjs`
- Create (generated): `shared/topology/planned/soa-09-route53-cloudfront.json`, `shared/guides/soa-09-route53-cloudfront/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-soa-09.test.mjs`

**Interfaces:**
- Consumes: Task 3 (zone name, health check and origin rules, `PriceClass_100`, resource policies), Task 4 (CloudFront and Route 53 handlers), Task 5 (us-east-1 resources), Task 6.

**`labs/soa-09-route53-cloudfront/lab.yaml`**
```yaml
# Lab soa-09 (AWS labs batch 2). SOA-C03 ((V) the wording against the current
# exam guide): Networking and Content Delivery (Route 53 routing policies and
# health checks, CloudFront with an S3 origin); and ANS-C01's Network Design
# (DNS and edge design). No third provider: CloudFront and Route 53 are global
# APIs the aws provider signs for us-east-1 itself (ruling P7).
# Costs, authored (no hourly list price): a hosted zone $0.50/month, not
# charged when deleted within 12 hours (V, spec §15); one HTTP health check
# $0.50-0.75/month (V: whether a partial month is prorated; worst case
# about 56p a session, ruling P8 keeps it to one); CloudFront and S3 requests
# for a few test pages: pennies a month.
id: soa-09-route53-cloudfront
version: 1
cloud: aws
title: "Route 53 routing and CloudFront in front of S3"
summary: >-
  A private S3 bucket served through CloudFront with origin access control, and a public Route 53 zone of the lab's own
  with weighted and failover records and a health check, queried straight from its name servers.
exam: SOA-C03
skill_areas: [soa.networking, ans.design]
level: associate
type: explore
prerequisites: []
cost:
  items:
    - { name: "Route 53 hosted zone ($0.50/month; none if deleted within 12 hours)", gbp_h: 0.0005 }
    - { name: "Route 53 health check, HTTP ($0.75/month)", gbp_h: 0.0008 }
    - { name: "CloudFront and S3 requests, a few test pages", gbp_h: 0.0001 }
  pricey: null
timing: { deploy_min: 8, destroy_min: 12, session_h: 2, max_h: 4 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: "off", dns_link: false, subnets_used: 0 }
identity:
  creates: []
  roles: []
  governance: false
```

**`labs/soa-09-route53-cloudfront/terraform/site.tf`**
```hcl
# site.tf
#
# Plain English: lab 09's site, a private bucket cloudlabs-<name prefix>-site
# (every public access block on) holding index.html and health.html. Only
# CloudFront may read it: the bucket policy lets the CloudFront service read
# objects for a distribution of this account (origin access control signs
# each request). The policy is known at plan (ruling P10), so it names this
# account's distributions rather than the one the lab is about to make.

locals {
  bucket     = "cloudlabs-${var.name_prefix}-site"
  bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-site"
}

resource "aws_s3_bucket" "site" {
  bucket        = local.bucket
  force_destroy = true
  tags          = { Name = "site" }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadsThroughOriginAccessControl"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${local.bucket_arn}/*"
      Condition = { ArnLike = { "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  content      = "<!doctype html><title>lab ${var.lab_id}</title><h1>Served by CloudFront from a private bucket</h1>\n"
  content_type = "text/html"
}

resource "aws_s3_object" "health" {
  bucket       = aws_s3_bucket.site.id
  key          = "health.html"
  content      = "ok\n"
  content_type = "text/plain"
}
```

**`labs/soa-09-route53-cloudfront/terraform/cdn.tf`**
```hcl
# cdn.tf
#
# Plain English: lab 09's CloudFront distribution (Europe and North America
# edges only, PriceClass_100) in front of the site bucket, through an origin
# access control that signs every request with SigV4. Pages are cached with
# AWS's managed CachingOptimized policy and served over HTTPS; /health.html,
# which the Route 53 health check reads, is never cached and answers HTTP too,
# so deleting it fails the check within a minute or two. Deleting the
# distribution first disables it and waits for that to reach every edge
# (several minutes: destroy_min 12).

locals {
  # AWS's managed cache policies (the same ids in every account; V: Task 12).
  caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "lab-${var.lab_id}-${var.name_prefix}"
  description                       = "lab ${var.lab_id}, CloudFront signs its requests to the site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "lab ${var.lab_id}"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  retain_on_delete    = false
  wait_for_deployment = true

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern           = "/health.html"
    target_origin_id       = "site"
    viewer_protocol_policy = "allow-all"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_disabled
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "cdn-site" }
}
```

**`labs/soa-09-route53-cloudfront/terraform/dns.tf`**
```hcl
# dns.tf
#
# Plain English: lab 09's public hosted zone, <name prefix>.labs.clydeford.net
# (ruling A27). It is never delegated from clydeford.net, so the internet
# never asks it: you ask its own name servers directly (dig @<name server>).
# Two names stand for two releases of the site, blue and green (both point at
# the distribution); app answers blue 70% of the time and green 30%
# (weighted); www answers blue while the health check of /health.html passes,
# and sorry when it fails (failover); cdn is an alias straight to the
# distribution. One health check (ruling P8: Route 53 may bill a whole month).

locals {
  zone = "${var.name_prefix}.labs.clydeford.net"
  cdn  = aws_cloudfront_distribution.site.domain_name
}

resource "aws_route53_zone" "lab" {
  name          = local.zone
  comment       = "lab ${var.lab_id}, not delegated, ask its own name servers"
  force_destroy = true
  tags          = { Name = "zone-lab" }
}

resource "aws_route53_health_check" "primary" {
  fqdn              = aws_cloudfront_distribution.site.domain_name
  type              = "HTTP"
  port              = 80
  resource_path     = "/health.html"
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = false
  tags              = { Name = "hc-primary" }
}

resource "aws_route53_record" "release" {
  for_each = toset(["blue", "green", "sorry"])
  zone_id  = aws_route53_zone.lab.zone_id
  name     = "${each.key}.${local.zone}"
  type     = "CNAME"
  ttl      = 60
  records  = [local.cdn]
}

resource "aws_route53_record" "app" {
  for_each       = { blue = 70, green = 30 }
  zone_id        = aws_route53_zone.lab.zone_id
  name           = "app.${local.zone}"
  type           = "CNAME"
  ttl            = 60
  set_identifier = each.key
  records        = ["${each.key}.${local.zone}"]
  weighted_routing_policy {
    weight = each.value
  }
}

resource "aws_route53_record" "www_primary" {
  zone_id         = aws_route53_zone.lab.zone_id
  name            = "www.${local.zone}"
  type            = "CNAME"
  ttl             = 60
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id
  records         = ["blue.${local.zone}"]
  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "www_secondary" {
  zone_id        = aws_route53_zone.lab.zone_id
  name           = "www.${local.zone}"
  type           = "CNAME"
  ttl            = 60
  set_identifier = "secondary"
  records        = ["sorry.${local.zone}"]
  failover_routing_policy {
    type = "SECONDARY"
  }
}

resource "aws_route53_record" "cdn" {
  zone_id = aws_route53_zone.lab.zone_id
  name    = "cdn.${local.zone}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
```

**`labs/soa-09-route53-cloudfront/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 09 is up (AWS labs spec
# §4, §10): no instances and no peering; the site's address and dig lines
# that ask the lab's zone on its own name server.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -s https://${aws_cloudfront_distribution.site.domain_name}/",
    "dig +short www.${local.zone} @${aws_route53_zone.lab.name_servers[0]}",
    "for i in $(seq 10); do dig +short app.${local.zone} @${aws_route53_zone.lab.name_servers[0]} | head -1; done",
    "aws s3 rm s3://${aws_s3_bucket.site.bucket}/health.html",
  ]
}
```

**`labs/soa-09-route53-cloudfront/readme.md`** (exactly):
````markdown
A static site in a private S3 bucket, served worldwide through CloudFront, and a public Route 53 zone of the lab's own that answers with weighted and failover routing and watches the site with a health check. The zone is never delegated, so you ask its name servers directly. Everything is listed in the lab's resource group, `lab-soa-09-route53-cloudfront`, in AWS Resource Groups (London); the distribution and the zone are also under CloudFront and Route 53, which are global.
From the SOA-C03 outline: configure Amazon Route 53 hosted zones, routing policies and health checks, and configure Amazon CloudFront distributions with an S3 origin and origin access control.

## What it deploys

- The bucket `cloudlabs-<name prefix>-site` with `index.html` and `health.html`, every public access block on, and a bucket policy that lets only CloudFront read it
- The distribution `cdn-site` (Europe and North America edges) with the origin access control `lab-soa-09-route53-cloudfront-<name prefix>`; pages are cached and served over HTTPS, while `/health.html` is never cached and also answers HTTP
- The public hosted zone `<name prefix>.labs.clydeford.net`, not delegated, with `blue`, `green` and `sorry` (all to the distribution), `app` (weighted: blue 70, green 30), `www` (failover: blue while the health check passes, sorry when it fails) and `cdn` (an alias to the distribution)
- The health check `hc-primary`: HTTP, every 30 seconds, `/health.html` on the distribution, three failures to fail

```text
lab-soa-09-route53-cloudfront (London; CloudFront and Route 53 are global)
  you --https--> cdn-site (CloudFront) --origin access control--> bucket cloudlabs-<prefix>-site (private)
  zone <prefix>.labs.clydeford.net (not delegated: dig @its name server)
    app  -> blue (70) | green (30)          weighted
    www  -> blue (primary, hc-primary) | sorry (secondary)    failover
    cdn  -> alias to cdn-site
  hc-primary --HTTP /health.html every 30 s--> cdn-site
```

## Things to try

- Run the third Connect line a few times: about seven answers in ten are `blue.<zone>` and three `green.<zone>`. Change the weights in Route 53 (green to 0, then both to 0) and see what a weight of zero does.
- Delete `health.html` (the fourth Connect line) and watch `hc-primary` turn unhealthy in Route 53, Health checks (about a minute and a half), then ask for `www` again (the second line): it now answers `sorry`. Upload it again (`aws s3 cp` any small file to the same key) and watch it fail back.
- Try the bucket directly: `curl -I https://cloudlabs-<name prefix>-site.s3.eu-west-2.amazonaws.com/index.html` answers 403, while the distribution serves the page. Read the bucket policy and the origin access control to see why.
- Change `index.html` in the bucket and fetch the site: CloudFront still serves the old page from cache. Create an invalidation for `/index.html` (CloudFront, the distribution, Invalidations; the first 1,000 paths a month are free) and fetch again.
- In CloudFront, open the distribution's **Behaviors** and compare the default behaviour with `/health.html`'s: cache policy, viewer protocol and why the health check needs both.

## Learn more

- [Choosing a routing policy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html)
- [Configuring DNS failover](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-configuring.html)
- [Creating Amazon Route 53 health checks](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating.html)
- [Restricting access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html)
- [Using the managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html)
- [Invalidating files](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-09-route53-cloudfront` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-09-route53-cloudfront.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Route traffic with Route 53 weighted and failover records and serve a private bucket through CloudFront.
learn:
  - Answer queries with weighted and failover routing tied to a health check
  - Serve a private S3 bucket through CloudFront with origin access control
  - Control what CloudFront caches with cache behaviours and invalidations
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-soa-09-route53-cloudfront · London`; `storage site`; `frontDoor cdn-site` with a `traffic` edge labelled `origin` to `storage site`; `dnsZone zone-lab`; `monitor hc-primary`; nothing for the origin access control, the records, the bucket's pieces or the objects.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-09.test.mjs`:

```js
// labs-aws-soa-09.test.mjs
//
// Plain English: lab soa-09-route53-cloudfront is the lab AWS labs spec
// §12.2 row 09 describes: a zone named <name prefix>.labs.clydeford.net and
// never delegated (A27), weighted and failover records with one health check
// (P8), and CloudFront with origin access control to a private bucket, all on
// the default provider (P7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "soa-09-route53-cloudfront";

test("soa-09 keeps the AWS lab contract and is a global lab with no third provider (ruling P7)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_GLOBAL_LABS.includes(ID));
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/provider "aws"/g)].length, 1);
  assert.doesNotMatch(tf, /us-east-1/);
});

test("soa-09's lab.yaml: §12.2 row 09", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.networking", "ans.design"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 12, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
});

test("soa-09's zone, records and one health check (rulings A27, P8)", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(tf, /zone = "\$\{var\.name_prefix\}\.labs\.clydeford\.net"/);
  assert.match(tf, /force_destroy = true\n\s+tags\s+= \{ Name = "zone-lab" \}/);
  assert.equal(resources(lab, "aws_route53_health_check").length, 1);
  assert.match(tf, /for_each\s+= \{ blue = 70, green = 30 \}/);
  for (const t of ["PRIMARY", "SECONDARY"]) assert.match(tf, new RegExp(`type = "${t}"`));
  assert.match(tf, /fqdn\s+= aws_cloudfront_distribution\.site\.domain_name/);
});

test("soa-09's distribution: OAC to a private bucket, PriceClass_100, an uncached /health.html", () => {
  const { tf } = awsLab(ID);
  for (const re of [/price_class\s+= "PriceClass_100"/, /retain_on_delete\s+= false/, /origin_access_control_id = aws_cloudfront_origin_access_control\.site\.id/, /path_pattern\s+= "\/health\.html"/, /cache_policy_id\s+= local\.caching_disabled/, /restrict_public_buckets = true/, /Principal = \{ Service = "cloudfront\.amazonaws\.com" \}/]) assert.match(tf, re);
});

test("soa-09's readme names what it builds", () => {
  const { readme } = awsLab(ID);
  for (const s of ["cdn-site", "hc-primary", "labs.clydeford.net", "weighted", "failover", "origin access control"]) assert.ok(readme.includes(s), s);
});

test("soa-09's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-09.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`; `variables.tf` keeps `lab_id`, `name_prefix`, `region`, `tags`.

- [ ] **Step 4: Write the plan fixture** `soa-09-route53-cloudfront.mjs`: `templateMainResources(c)` plus every resource block's instances (`aws_route53_record.release["blue"|"green"|"sorry"]` and `.app["blue"|"green"]` with `forEach` as batch 1's fixtures write it). Known at plan: the bucket's name and policy (account from the data source), the objects' keys and contents, the OAC's settings, the distribution's settings and blocks (its `origin.0.domain_name` and `origin_access_control_id` unknown with their references), the zone's `name` (`a09k3x9q.labs.clydeford.net`), the health check's settings with `fqdn` unknown (the distribution's domain), the records' names; unknown: ids, ARNs, the zone's `zone_id` and `name_servers`, the distribution's `domain_name` and `hosted_zone_id`. The global types carry no `region` (computed.json). `lab-plans.test.mjs` proves it, including rule `gateway`'s zone name, health-check and origin checks.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["soa-09-route53-cloudfront"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-09.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- soa-09-route53-cloudfront`, `npm run labs-topology -- --check soa-09-route53-cloudfront`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-09-route53-cloudfront labs/_learning/soa-09-route53-cloudfront.yaml shared/topology/planned/soa-09-route53-cloudfront.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-09 Route 53 routing and CloudFront in front of S3

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 11: Lab soa-10-containers

Spec: §12.2 row 10 (deployment, monitoring; associate; explore; £ 0.10; peering optional; 8/6; 2/4; prerequisite soa-03; ECR repository, ECS cluster with Container Insights, Fargate service (2 tasks) behind an ALB, NAT gateway), "Not built here": EKS as a comparison; §4 (NAT only where a lab teaches or needs it); §7.4 (ALB, NAT public by nature); rulings A20, A45, A56, P15, P16.

**Files:**
- Create: `labs/soa-10-containers/lab.yaml`, `readme.md`
- Create: `labs/soa-10-containers/terraform/versions.tf`, `main.tf`, `network.tf` (all copied unchanged), `variables.tf` (the template's `lab_id`, `name_prefix`, `region`, `address_space`, `gateway_cidr`, `admin_password` (the template network's cloud-init names it), `tags`), `public.tf` (soa-03's, unchanged in content), `nat.tf`, `alb.tf`, `ecs.tf`, `outputs.tf`
- Create: `labs/_learning/soa-10-containers.yaml`, `scripts/test/fixtures/labs/plans/labs/soa-10-containers.mjs`
- Create (generated): `shared/topology/planned/soa-10-containers.json`, `shared/guides/soa-10-containers/**`
- Modify: `worker/test/topology-golden.test.ts`, `worker/test/fixtures/topology/round-trip.ts`
- Test: `scripts/test/labs-aws-soa-10.test.mjs`

**Interfaces:**
- Consumes: the template network; soa-03's `public.tf` (copied); Task 3 (ECS, ECR, NAT rules); Task 4 (ECS, ECR handlers); Task 6 (ECS behind an ALB).

**`labs/soa-10-containers/lab.yaml`**
```yaml
# Lab soa-10 (AWS labs batch 2). SOA-C03 ((V) the wording against the current
# exam guide): Deployment, Provisioning, and Automation (container images in
# ECR, ECS services on Fargate); Monitoring (Container Insights).
# London list prices × 0.75 (labs-verify --aws-prices); the NAT gateway and the
# ALB bill each started hour whole (V, A20). Authored: Fargate ARM64 2 tasks ×
# (0.25 vCPU × $0.03725/h + 0.5 GB × $0.00409/h) (V) -> £0.0171; ALB capacity
# units; Container Insights metrics; logs. EKS is described under Not built here.
id: soa-10-containers
version: 1
cloud: aws
title: "Containers: ECR and ECS Fargate behind an ALB"
summary: >-
  An ECS cluster with Container Insights running two Fargate tasks behind an internet-facing Application Load Balancer,
  pulling through a NAT gateway, and an ECR repository with scanning and a lifecycle policy for your own images.
exam: SOA-C03
skill_areas: [soa.deployment, soa.monitoring]
level: associate
type: explore
prerequisites: [soa-03-auto-scaling]
cost:
  items:
    - name: "NAT gateway, hourly"
      gbp_h: 0.0375
      whole_hours: true
      aws_price: { service: AmazonEC2, unit: Hrs, filters: { productFamily: "NAT Gateway", usagetype: "{usage}-NatGateway-Hours" } }
    - name: "Application Load Balancer, hourly"
      gbp_h: 0.0199
      whole_hours: true
      aws_price: { service: AWSELB, unit: Hrs, filters: { productFamily: "Load Balancer-Application", usagetype: "{usage}-LoadBalancerUsage" } }
    - { name: "ALB capacity units, light test traffic", gbp_h: 0.0060 }
    - name: "Public IPv4 addresses (the ALB's 2 and the NAT gateway's)"
      gbp_h: 0.0038
      qty: 3
      aws_price: { service: AmazonVPC, unit: Hrs, filters: { group: VPCPublicIPv4Address, usagetype: "{usage}-PublicIPv4:InUseAddress" } }
    - { name: "Fargate ARM64, 2 tasks of 0.25 vCPU and 0.5 GB", gbp_h: 0.0171 }
    - { name: "Container Insights metrics, CloudWatch Logs, ECR storage (empty)", gbp_h: 0.0020 }
  pricey: null
timing: { deploy_min: 8, destroy_min: 6, session_h: 2, max_h: 4 }
capacity: { instance_types: [] }
regions: { secondary: null }
connectivity: { peering: optional, dns_link: false, subnets_used: 1 }
identity:
  creates: [role]
  roles: []
  governance: false
```

**`public.tf`** is soa-03's `public.tf` with its header's first line changed to "lab 10's" (the internet gateway, `snet-public-1/2` at /24s 8 and 9, `rt-public` with its route).

**`labs/soa-10-containers/terraform/nat.tf`**
```hcl
# nat.tf
#
# Plain English: lab 10's way out for the private subnets: a NAT gateway in
# snet-public-1 with an Elastic IP (public by nature, spec §7.4), and a
# default route to it in rt-private. The Fargate tasks pull their image from
# Amazon ECR Public and send their logs through it. While the lab is peered,
# the route the pipeline adds for the VPN server's range is more specific, so
# that traffic still goes through the peering.

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "eip-nat" }
}

resource "aws_nat_gateway" "lab" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "nat-lab" }
  depends_on    = [aws_internet_gateway.lab, aws_route.public_internet]
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.lab.id
}
```

**`labs/soa-10-containers/terraform/alb.tf`**
```hcl
# alb.tf
#
# Plain English: lab 10's internet-facing Application Load Balancer, HTTP on
# port 80 from anywhere, forwarding to the service's tasks by their own
# addresses (target type ip, as Fargate needs), which admit port 80 only from
# the load balancer.

resource "aws_security_group" "alb" {
  name        = "lab-alb"
  description = "The load balancer: HTTP from the internet, HTTP on to the tasks"
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

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.tasks.id
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
  depends_on                 = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "web" {
  name                 = "tg-${var.name_prefix}"
  port                 = 80
  protocol             = "HTTP"
  target_type          = "ip"
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

**`labs/soa-10-containers/terraform/ecs.tf`**
```hcl
# ecs.tf
#
# Plain English: lab 10's containers. An ECR repository, lab-<id>-web, that
# scans each pushed image and keeps the five newest (it starts empty: pushing
# an image is a Thing to try; ruling P16). An ECS cluster with Container
# Insights. A task, lab-<id>-web: nginx from Amazon ECR Public on Fargate
# ARM64 (Graviton), 0.25 vCPU and 0.5 GB, logging to /cloudlabs/<id>/web (one
# day; ruling A56), started with the role lab-<id>-exec (pull and log only,
# AmazonECSTaskExecutionRolePolicy, under the lab boundary). And the service,
# two tasks in the private subnets behind the load balancer. A 20-second wait
# lets the repository's tag reach IAM before its lifecycle policy (ruling P15).

locals {
  log_group = "/cloudlabs/${var.lab_id}/web"
}

resource "aws_ecr_repository" "web" {
  name                 = "lab-${var.lab_id}-web"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = { Name = "ecr-web" }
}

resource "time_sleep" "ecr_tags" {
  create_duration = "20s"
  depends_on      = [aws_ecr_repository.web]
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "keep the five newest images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
  depends_on = [time_sleep.ecr_tags]
}

resource "aws_ecs_cluster" "lab" {
  name = "lab-${var.lab_id}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = { Name = "ecs-lab" }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = local.log_group
  retention_in_days = 1
}

resource "aws_iam_role" "exec" {
  name                 = "lab-${var.lab_id}-exec"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "exec" {
  role       = aws_iam_role.exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "web" {
  family                   = "lab-${var.lab_id}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.exec.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "web"
    image        = "public.ecr.aws/nginx/nginx:stable-alpine"
    essential    = true
    portMappings = [{ containerPort = 80, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { "awslogs-group" = local.log_group, "awslogs-region" = var.region, "awslogs-stream-prefix" = "web" }
    }
  }])
  tags       = { Name = "td-web" }
  depends_on = [aws_cloudwatch_log_group.web]
}

resource "aws_security_group" "tasks" {
  name        = "lab-tasks"
  description = "The service tasks: HTTP from the load balancer, out through the NAT gateway"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-tasks" }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_http_alb" {
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_ecs_service" "web" {
  name                              = "lab-${var.lab_id}-web"
  cluster                           = aws_ecs_cluster.lab.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = 2
  launch_type                       = "FARGATE"
  propagate_tags                    = "SERVICE"
  enable_ecs_managed_tags           = true
  health_check_grace_period_seconds = 30

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 80
  }

  tags       = { Name = "svc-web" }
  depends_on = [aws_lb_listener.http, aws_route.private_nat, aws_iam_role_policy_attachment.exec]
}
```

**`labs/soa-10-containers/terraform/outputs.tf`**
```hcl
# outputs.tf
#
# Plain English: what the dashboard shows once lab 10 is up (AWS labs spec
# §4, §10). The tasks come and go, so no fixed addresses: the load balancer's
# address, how to list the tasks, and how to push an image of your own.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "curl -sI http://${aws_lb.web.dns_name}/",
    "aws ecs list-tasks --cluster ${aws_ecs_cluster.lab.name} --service-name ${aws_ecs_service.web.name}",
    "aws ecr get-login-password | docker login --username AWS --password-stdin ${aws_ecr_repository.web.repository_url}",
    "docker pull --platform linux/arm64 public.ecr.aws/nginx/nginx:stable-alpine && docker tag public.ecr.aws/nginx/nginx:stable-alpine ${aws_ecr_repository.web.repository_url}:v1 && docker push ${aws_ecr_repository.web.repository_url}:v1",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
```

**`labs/soa-10-containers/readme.md`** (exactly):
````markdown
Containers on AWS without a server to manage: an ECS cluster running two nginx tasks on Fargate behind an internet-facing Application Load Balancer, with Container Insights watching them, and an ECR repository ready for an image of your own. The tasks live in private subnets and reach out through a NAT gateway. Everything is listed in the lab's resource group, `lab-soa-10-containers`, in AWS Resource Groups (London).
From the SOA-C03 outline: deploy and manage containers with Amazon ECS on AWS Fargate and images in Amazon ECR, and monitor them with CloudWatch Container Insights.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20): two private subnets for the tasks, two public subnets (`snet-public-1/2`) for the load balancer and the NAT gateway, the internet gateway `igw-lab`, and `nat-lab` with its Elastic IP, the private subnets' way out
- The repository `lab-soa-10-containers-web` in Amazon ECR: images scanned on push, the five newest kept. It starts empty
- The cluster `lab-soa-10-containers` with Container Insights, and the service `lab-soa-10-containers-web`: two Fargate tasks (ARM64, 0.25 vCPU and 0.5 GB each) running `public.ecr.aws/nginx/nginx:stable-alpine`, logging to `/cloudlabs/soa-10-containers/web`, started with the role `lab-soa-10-containers-exec`
- The load balancer `alb-<name prefix>` (Name `alb-web`): HTTP on port 80 from anywhere, to the tasks' own addresses (target group `tg-web`, target type ip)

The first Connect line asks the load balancer for the page's headers; the `Server: nginx` line comes from one of the two tasks.

```text
lab-soa-10-containers (London)
  you --HTTP 80--> alb-web (snet-public-1/2) --> tg-web (ip) --> 2 Fargate tasks (snet-private-1/2) [sg-tasks]
  tasks --> nat-lab (snet-public-1) --> igw-lab --> ECR Public (nginx image), CloudWatch Logs
  cluster lab-<id> (Container Insights)     ECR lab-<id>-web (empty, scan on push)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Stop one task (ECS, the cluster, Tasks, Stop) and watch the service start a new one to get back to two, while `curl` through the load balancer keeps answering. Then set the service's desired count to 3 and back to 2.
- Open CloudWatch, Container Insights, and look at the cluster's and the service's CPU and memory. Load it with `for i in $(seq 2000); do curl -s -o /dev/null http://<alb>/; done` and watch the numbers move.
- Push an image of your own (needs Docker on your PC; the third and fourth Connect lines), see its scan findings in ECR, then create a new revision of the task definition with that image and update the service. Watch the deployment replace the tasks one at a time.
- Read the task's logs in `/cloudlabs/soa-10-containers/web`: one stream per task, nginx's access log lines from the load balancer's health checks every 15 seconds.
- Compare the target group's targets (task IP addresses) with a load balancer in front of instances (soa-03): Fargate tasks register themselves, by address, as they start.

## Not built here

**Amazon EKS.** EKS runs Kubernetes, with pods, deployments and services instead of ECS tasks and services; Fargate can run either. A cluster costs about 7p an hour on its own before any node, so it has its own lab later (SAA-C03's `saa-19-eks`). See [Amazon EKS and Amazon ECS compared](https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html).

## Learn more

- [Amazon ECS on AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [Use a load balancer to distribute Amazon ECS service traffic](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html)
- [Amazon ECS task execution IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)
- [Monitor Amazon ECS containers using Container Insights](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cloudwatch-container-insights.html)
- [Pushing a Docker image to an Amazon ECR private repository](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-10-containers` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
````

**`labs/_learning/soa-10-containers.yaml`**
```yaml
# Labs catalogue learning content (labs redesign spec §5). Outside the lab folder: editing it never needs a version bump.
objective: Run and watch a containerised service on ECS Fargate behind a load balancer, with images in ECR.
learn:
  - Read a task definition, a service and how the service keeps its tasks running
  - Put Fargate tasks behind an Application Load Balancer by IP address
  - Watch a service with Container Insights and push an image to ECR
learning_min: 60
```

**The diagram** must contain: `resourceGroup lab-soa-10-containers · London`; `vnet vpc-lab` with `subnet snet-private-1/2`, `snet-public-1/2`; `internetGateway igw-lab`; `natGateway nat-lab`; `loadBalancer alb-web` with a `traffic` edge `HTTP 80` to `containerApp svc-web`; `generic ecs-lab`; `registry ecr-web`; `logAnalytics /cloudlabs/soa-10-containers/web`; `managedIdentity lab-soa-10-containers-exec`; `routeTable rt-private` with a `dependency` edge `0.0.0.0/0` to `nat-lab`; `nsg sg-alb`, `sg-tasks`, `sg-vms`, `sg-eice`; `bastion eice-lab`; `privateEndpoint vpce-s3`.

- [ ] **Step 1: Write the failing test** `scripts/test/labs-aws-soa-10.test.mjs`:

```js
// labs-aws-soa-10.test.mjs
//
// Plain English: lab soa-10-containers is the lab AWS labs spec §12.2 row 10
// describes: ECR, an ECS cluster with Container Insights, two Fargate tasks
// behind an ALB, and a NAT gateway (ruling P16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "soa-10-containers";

test("soa-10 keeps the AWS lab contract; its public subnets are soa-03's", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const body = (p) => readFileSync(fileURLToPath(new URL(`../../labs/${p}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#")).join("\n");
  assert.equal(body(`${ID}/terraform/public.tf`), body("soa-03-auto-scaling/terraform/public.tf"));
});

test("soa-10's lab.yaml: §12.2 row 10, about £0.10/h with the NAT gateway and the ALB billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.deployment", "soa.monitoring"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 6, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.08 && total < 0.12, `about £0.10/h (tier £), got ${total}`);
  for (const n of ["NAT gateway, hourly", "Application Load Balancer, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
});

test("soa-10's ECS: Container Insights, Fargate ARM64 at 0.25 vCPU, two tasks with no public IP, tags from the service, logs to the lab's group", () => {
  const { tf } = awsLab(ID);
  for (const re of [
    /name\s+= "containerInsights"\n\s+value = "enabled"/, /cpu_architecture\s+= "ARM64"/, /cpu\s+= "256"/, /desired_count\s+= 2/,
    /assign_public_ip = false/, /propagate_tags\s+= "SERVICE"/, /"awslogs-group" = local\.log_group/, /log_group = "\/cloudlabs\/\$\{var\.lab_id\}\/web"/,
    /image\s+= "public\.ecr\.aws\/nginx\/nginx:stable-alpine"/, /target_type\s+= "ip"/, /policy_arn = "arn:aws:iam::aws:policy\/service-role\/AmazonECSTaskExecutionRolePolicy"/,
  ]) assert.match(tf, re);
  assert.doesNotMatch(tf, /awslogs-create-group/);
  assert.doesNotMatch(tf, /aws_ecs_cluster_capacity_providers|aws_appautoscaling_/, "ruling P16");
});

test("soa-10's ECR and NAT: force_delete, scan on push, a lifecycle policy after the tag wait; one NAT gateway in a public subnet", () => {
  const { tf } = awsLab(ID);
  for (const re of [/force_delete\s+= true/, /scan_on_push = true/, /depends_on = \[time_sleep\.ecr_tags\]/, /subnet_id\s+= aws_subnet\.public\[0\]\.id/, /nat_gateway_id\s+= aws_nat_gateway\.lab\.id/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("soa-10's readme names what it builds and explains EKS", () => {
  const { readme } = awsLab(ID);
  for (const s of ["lab-soa-10-containers-web", "nat-lab", "Container Insights", "## Not built here", "Amazon EKS"]) assert.ok(readme.includes(s), s);
});

test("soa-10's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test scripts/test/labs-aws-soa-10.test.mjs`
Expected: FAIL (no lab folder).

- [ ] **Step 3: Write the lab**: the files above; copy `versions.tf`, `main.tf`, `network.tf` unchanged and soa-03's `public.tf`; trim `variables.tf` to the seven variables named.

- [ ] **Step 4: Write the plan fixture** `soa-10-containers.mjs`: `[...templateResources(c), …]`, the public subnets, route table, route and associations as soa-03's fixture writes them, the ALB pieces as soa-03's (`target_type: "ip"`), the NAT gateway pieces, and the ECS and ECR pieces. Known at plan: the repository's and cluster's names and settings, the task definition's `family`, `cpu`, `memory`, `runtime_platform` and `container_definitions` (built from locals and `var.region`; rule `lingering` reads its awslogs group), the service's `name`, `desired_count`, `launch_type`, `propagate_tags`; unknown with references: `execution_role_arn`, the service's `cluster`, `task_definition`, `network_configuration.0.subnets` and `security_groups`, `load_balancer.0.target_group_arn`. `lab-plans.test.mjs` proves it.

- [ ] **Step 5: Generate the planned graph and the readme diagram**, `GOLDEN["soa-10-containers"]`, `AWS_LAB_IDS`.

- [ ] **Step 6: Run the checks**

Run: `node --test scripts/test/labs-aws-soa-10.test.mjs scripts/test/lab-plans.test.mjs scripts/test/labs-readmes.test.mjs scripts/test/labs-diagrams.test.mjs scripts/test/labs-learning-content.test.mjs`, then `npx vitest run worker/test/topology-golden.test.ts`, then `npm run labs-check`, `npm run labs-tf -- soa-10-containers`, `npm run labs-topology -- --check soa-10-containers`, `npm run labs-diagrams -- --check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add labs/soa-10-containers labs/_learning/soa-10-containers.yaml shared/topology/planned/soa-10-containers.json shared/guides scripts/test worker/test
git commit -m "feat(aws labs): lab soa-10 containers: ECR and ECS Fargate behind an ALB

Claude-Session: https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D"
```

---

### Task 12: Full gate, price and link checks, V answers, spec rulings, PR and whole-branch review (controller)

The controller runs this task itself: it needs the local AWS admin keys (read-only calls only here) and the PR. Spec: §11, §14, §17.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-aws-labs-design.md` (§17 gains "### Rulings from the batch 2 plan (A59 on)": P1–P19 as A59–A77, each "**Ann. Title.** sentence. Reason.", worded as the other rulings)
- Modify (only if a check below fails): the labs' `lab.yaml` cost items and readme links; `infra/aws-bootstrap/lab-abac.json`/`lab-policies.json` and the pin (Task 2, if the reference could not be fetched there); `scripts/test/fixtures/labs/plans/computed.json`/`schema-facts.json` (Task 3, likewise)
- Create: the PR

- [ ] **Step 1: Generate what an implementer could not, and settle the policy count.** If Task 2 left the ABAC files ungenerated: `node scripts/aws-labs-abac.mjs && node scripts/aws-labs-abac.mjs --render && node scripts/aws-labs-abac.mjs --check`, pin the hash, `node --test scripts/test/aws-labs-iam.test.mjs` (PASS), commit `chore(aws labs): regenerate the ABAC lists and rendered policies for batch 2`. If Task 3 left the schema facts ungenerated, run Task 3 Step 3 and commit. If the render needs **more than 10** role policies (ruling P13): first read `aws service-quotas get-service-quota --service-code iam --quota-code L-0DA4ABF3 --region us-east-1`; when it is already 20 (or a request is approved), set `ROLE_POLICIES_MAX = 20` with a comment naming the quota and re-render (no STOP: a quota increase is pre-approved); otherwise accept A29's fall-back only if Task 2's evaluator tests still pass with it, and say which in the PR body.

- [ ] **Step 2: Prices and links on the real services** (local keys, read only):
Run: `npm run labs-verify -- --aws-prices soa-06-cloudformation soa-07-iam-kms soa-08-vpc-fix soa-09-route53-cloudfront soa-10-containers` and `npm run labs-verify -- --links soa-06-cloudformation soa-07-iam-kms soa-08-vpc-fix soa-09-route53-cloudfront soa-10-containers`
Expected: every `aws_price` (lab 08's t4g.micro, t4g.nano and gp3; lab 10's NAT gateway, ALB and public IPv4) matches exactly one product and each authored figure is within 25%; every link answers 200. A filter set matching 0 or several products is fixed in `lab.yaml` (the distinguishing attribute the error names, or the item made authored-only); a figure more than 25% off is set to AWS's; a dead link is replaced by the page it moved to. The labs are new since `main` (version 1), so no bump. Record each answer for the PR body.

- [ ] **Step 3: The (V) facts batch 2 relies on** (local keys, read only; each answer under "V answers" in the PR body):
  - `aws accessanalyzer list-analyzers --type ACCOUNT --region eu-west-2 --query "analyzers[].name"`: empty. If an account analyzer exists, lab 07 cannot deploy (one per region per account, ruling P14): note it in the PR and in lab 07's release row; not a stop (Steven may delete his or keep lab 07 untested).
  - `aws cloudfront get-cache-policy --id 658327ea-f89d-4fab-a63d-7e88639e58f6 --region us-east-1 --query CachePolicy.CachePolicyConfig.Name` is `Managed-CachingOptimized`, and `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` is `Managed-CachingDisabled` (else fix lab 09's locals).
  - `aws route53 list-hosted-zones --query "HostedZones[].Name"`: none under `labs.clydeford.net` (spec §7.5: the account holds no other zones; Route 53 is allowed account-wide).
  - `aws service-quotas get-service-quota --service-code iam --quota-code L-0DA4ABF3 --region us-east-1 --query "Quota.[QuotaName,Value,Adjustable]"`: "Managed policies per role", 10, true (else find the right code with `list-service-quotas --service-code iam` and fix `LAB_QUOTAS`).
  - `aws iam get-role --role-name AWSServiceRoleForECS --query Role.RoleName`: exists (A57 made it in batch 1).
  - `aws ecs list-account-settings --effective-settings --name awsvpcTrunking --region eu-west-2` answers (ECS is usable in the account) and `aws ec2 describe-instance-type-offerings --region eu-west-2 --filters Name=instance-type,Values=t4g.nano --query "InstanceTypeOfferings[].Location"` lists at least eu-west-2a.
  - Left to Task 13's release tests, each named there: CloudFormation copying stack tags; Route 53 and CloudFront signing for us-east-1 (`aws:RequestedRegion`); the tag waits (P15); `ReplaceNetworkAclAssociation` judged on the new ACL; the nginx image's arm64 variant; Python 3.13 on arm64 Lambda; CloudFront's delete time; a deleted task definition describing as `ClientException`; the tagging API listing ECS and KMS items after deletion; Route 53 billing.

- [ ] **Step 4: Copy the rulings into the spec**: append "### Rulings from the batch 2 plan (A59 on)" to §17 with A59–A77 (P1 → A59 … P19 → A77). Commit `docs(aws labs): batch 2 rulings A59-A77`.

- [ ] **Step 5: The full gate**
Run: `npm run typecheck && npm test && npm run build:web && npm run bundle-size && npm run labs-check -- --base origin/main && npm run labs-tf && npm run labs-topology -- --check && npm run labs-diagrams -- --check`
Expected: all PASS; the web entry did not grow (no web change in batch 2). Fix anything red test-first and commit.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin feat/aws-labs-batch2
gh pr create --base main --title "AWS labs batch 2: labs soa-06 to soa-10" --body "$(cat <<'EOF'
AWS hands-on labs, batch 2 (spec docs/superpowers/specs/2026-10-15-aws-labs-design.md §14 B2; plan docs/superpowers/plans/2026-10-15-aws-labs-batch2-plan.md).

- Labs soa-06 CloudFormation inside Terraform, soa-07 IAM/permission boundaries/KMS, soa-08 break-fix VPC connectivity, soa-09 Route 53 and CloudFront, soa-10 ECR and ECS Fargate (all Untested until their release tests from main)
- Scope and lint: CloudFormation templates read at lint and plan (rule template), global regions judged per resource, an instance-target allow-list, resource policies and Lambda permissions, batch 2's types with their lingering and size rules
- IAM: delete and update verbs are never creates (DeleteAnalyzer), lab 07's user can lose hand-made credentials, Access Analyzer's service-linked role made ahead, the role's tenth policy, the IAM managed-policies quota asked for
- Clean-up: stacks (incl. DELETE_FAILED), ECS, CloudFront (disable, wait, delete), Route 53 zones with records, KMS keys (7 days), secrets, Lambda, ECR, Access Analyzer, flow logs, lab 07's user
- Worker: a global lab's us-east-1 tags, lab 07's password only behind Show, pending KMS keys never orphans; diagrams for batch 2's types
- Template pins every allowed provider and tags its VPC the hub: soa-01..05 bumped, to be release-tested again

Rulings A59-A77 are in the spec's §17. V answers (from Steps 1-3):

https://claude.ai/code/session_01XbTiZpZyCJcrqEvHH5rA3D
EOF
)"
gh pr checks --watch
```
Expected: CI green.

- [ ] **Step 7: Whole-branch review**: one fresh reviewer on the most capable model, with the spec, this plan and `git diff origin/main...feat/aws-labs-batch2`. Ask about: the Review Focus list; `cfnTemplateProblems` and the `template` rule (can a template make or reach anything outside the lab?); the per-resource global-region rule and the instance-target allow-list (can a plan reach the VPN server?); the regenerated ABAC lists' diff (anything newly refused that a lab needs, or newly allowed?); the safety net's new handlers (order, never-touch rules, no deletion by name of anything not `lab-<id>-*`); lab 07's password path (logs, D1, API); each lab against its §12.2 row. Fix each finding test-first, re-run Step 5's gate, push, wait for CI green.

---

### Task 13: Ship: spend check, bootstrap re-apply, merge, deploy, release tests 06–10 and 01–05, record, recalibrate (controller)

The controller runs this task itself. Spec: §11 (release tests, spend), §13, §14 (A24), §15. Budget: batch 2 aims at ≤ £2 of AWS test spend; the whole AWS labs project may spend ≤ £15 (a projected overrun is a STOP). A change needed in `wg-aws.yml`, `infra/aws/**` or the deploy role is a STOP.

**Files:**
- Modify (after the tests): `docs/labs/release-tests.md`, `scripts/test/fixtures/labs/plans/shapes/soa-*.json` (written by `lab-release-test.mjs`), the labs' plan fixtures where a recorded shape differs (and `realistic.mjs` where the provider prints a new type its own way, as batch 1's recalibration did), memories `aws-support.md`, `labs-feature.md`, `golive-versions.md`, `MEMORY.md` (one line each)

Expected test spend (London list, one pass): soa-06 ≈ £0.001; soa-07 ≈ £0.002 (the key costs nothing while it waits to delete, §15); soa-08 ≈ £0.005; soa-09 ≈ £0.002 likely, up to about £0.60 if Route 53 bills the hosted zone and the health check by the whole month (V); soa-10 ≈ £0.08 (one whole hour of the NAT gateway and the ALB); soa-01..05 again ≈ £0.06 (their batch 1 pass). About £0.15 likely and £1.30 worst with one retry each.

- [ ] **Step 1: Spend check.** `aws ce get-cost-and-usage --region us-east-1 --time-period Start=<first of month>,End=<today> --granularity MONTHLY --metrics UnblendedCost` and the labs' tag (`--group-by Type=TAG,Key=cloudlabs-lab`, once the tag is active). If the AWS labs project's test spend so far plus £2 would pass £15, STOP and report.

- [ ] **Step 2: Bootstrap the account** (local admin keys, from the PR branch: the role's new policies must exist before the tests).
Run: `node scripts/aws-bootstrap.mjs --labs`
Expected: Terraform's plan (read it before applying) adds `wg-admin-labs-10` and its attachment and changes the other nine role policies' contents; the boundary and the deploy role unchanged. All 35 role and 10 boundary simulator cases print as wanted; "Service-linked roles made ahead: access-analyzer.amazonaws.com"; "Quota Managed policies per role in us-east-1: 10; asked for 20"; the cost tag active. A simulator mismatch is fixed in `scripts/lib/aws-lab-policies.mjs` test-first, re-rendered, pushed, and the bootstrap run again.

- [ ] **Step 3: Merge and deploy.**

```bash
gh pr merge <PR number> --merge
git switch main && git pull
npm run deploy-worker
git checkout -- worker/src/build.ts
```
Expected: the new Worker version id (no migration). Write it, with the previous version as the rollback target, into memory `golive-versions.md`.

- [ ] **Step 4: Dashboard checks** (Steven's signed-in Chrome; if not available, note "needs Steven's sign-in" and go on): the Labs tab shows ten AWS cards, soa-06..10 "Untested v1" and soa-01..05 "Untested" at their new versions; the modals of soa-06, soa-07 and soa-09 (peering off) offer no **Peer to gateway**; lab 10 names soa-03 as "run before".

- [ ] **Step 5: Release tests from main**, cheapest first, one at a time (each always tears down; `--ref` defaults to main, ruling P18):

```bash
node scripts/lab-release-test.mjs soa-06-cloudformation --confirm-cost
node scripts/lab-release-test.mjs soa-07-iam-kms --confirm-cost
node scripts/lab-release-test.mjs soa-08-vpc-fix --confirm-cost
node scripts/lab-release-test.mjs soa-09-route53-cloudfront --confirm-cost
node scripts/lab-release-test.mjs soa-10-containers --confirm-cost
node scripts/lab-release-test.mjs soa-04-backup --confirm-cost
node scripts/lab-release-test.mjs soa-01-cloudwatch --confirm-cost
node scripts/lab-release-test.mjs soa-03-auto-scaling --confirm-cost
node scripts/lab-release-test.mjs soa-02-systems-manager --confirm-cost
node scripts/lab-release-test.mjs soa-05-rds --confirm-cost
```
Expected: each row in `docs/labs/release-tests.md` reads pass, clean yes, and saves its plan shape. After each: `aws resourcegroupstaggingapi get-resources --tag-filters Key=cloudlabs-lab,Values=<id> --region eu-west-2` (and `--region us-east-1` for soa-09) lists nothing that is not terminated, deleted or (a KMS key) pending deletion; `aws iam list-users --path-prefix /cloudlabs-lab/` and `list-roles` list none. The V answers each test gives, recorded in the batch report:
  - soa-06: the stack-made queue, topic, parameter, log group and alarm appear in that tagging listing with `cloudlabs-lab` (CloudFormation copied the stack's tags; they stay listed for about an hour after deletion).
  - soa-07: the apply passed `PutSecretValue`, `AddPermission` and `RotateSecret` after the 20-second wait (P15); the run's Apply log shows no `AccessDenied`; Verify clean counts the key `PendingDeletion` clean; Access Analyzer's delete passed (P1).
  - soa-08: `ReplaceNetworkAclAssociation` passed (the association to `acl-db`); both flow logs were created.
  - soa-09: CloudFront and Route 53 calls were allowed (they sign for us-east-1); the destroy time against `destroy_min` 12; the next day, Cost Explorer's line for Route 53 (zone and health check) for the test, recorded.
  - soa-10: the service reached 2 running tasks (Ready check; the nginx image's arm64 variant pulled through the NAT gateway); Verify clean judged the cluster and service `INACTIVE` and the task definition `DELETE_IN_PROGRESS` or `ClientException` as clean.
  A failure: read the run's log, fix test-first on `fix/aws-labs-b2-<id>` (the lab's version rises if its folder changes; engine fixes need no bump), PR, CI green, merge, `npm run deploy-worker`, test again (A24). Two pre-planned fixes: an `AccessDenied` on a change right after a create in Secrets Manager, Lambda or ECR (ruling P15) adds that service to `TAG_LAG_NAMED` with its `lab-*` name pattern (test-first in `aws-labs-iam.test.mjs`, `--render`, `node scripts/aws-bootstrap.mjs --labs`); an `AccessDenied` on `ec2:ReplaceNetworkAclAssociation` in soa-08 is a STOP for the controller to decide (the fix would let a lab re-associate a subnet's ACL judged only by the new ACL's tag). Record each deploy and destroy time and raise `deploy_min`/`destroy_min` (with a version bump) where the real time is longer.

- [ ] **Step 6: Leftovers and orphans, two hours on.** At least 90 minutes after the last test, after the Worker's next hourly AWS sweep, the Labs tab's leftovers list (KV `labs:orphans`) has no AWS entry. A `kms:key` there means ruling P11's skip failed; an ECS cluster, service or task definition there means the tagging API keeps them past the grace (P12): fix test-first in `worker/src/labs/orphans.ts` (skip that type, once the safety net has proved it gone) and deploy.

- [ ] **Step 7: Mark the versions released.** For each lab whose script test passed, press **Test** in Settings → Labs (Chrome) so `lab_release_tests` records it and the cards drop "Untested"; or, without the dashboard, note that the cards stay "Untested" until Steven presses Test.

- [ ] **Step 8: Record, recalibrate and clean up.** On `chore/aws-labs-b2-release`: commit `docs/labs/release-tests.md` and the shapes; make each lab's plan fixture match its recorded shape (`node --test scripts/test/lab-plans.test.mjs` names every difference; where the aws provider prints a batch 2 type in a way every fixture should follow, put it in `realistic.mjs` with a test, as batch 1's "realistic plans print batch 1 AWS labs'…" test does); PR, merge when green. Record the month's AWS spend before and after. Update memories: `aws-support.md` (B2 live, Worker version, V answers), `labs-feature.md` (AWS labs 06–10 released or not, with spend), `golive-versions.md`, and `MEMORY.md`'s index lines.

---

## Carried forward

Batch 1's deferred items (ledger `deferred-and-rulings.txt`, final review triage) and what batch 2 does with each:

| Item | Batch 2 |
|---|---|
| Task 8: deletes/updates left in the ABAC create list | **Done** (P1, Task 2); apigateway's HTTP verbs left to batch 3's API Gateway lab |
| Final: instance-target check is a deny-list | **Done** (P9, Task 3) |
| Task 15 / final Minor 6: `hashicorp/time` unpinned | **Done** (P2, Task 1) |
| Task 11 / final Minor 1: `lab-release-test --ref` default | **Done** (P18, Task 1) |
| Task 5: IAM user delete-conflict prerequisites | **Done** (P6, Tasks 2 and 4) |
| Spec ledger: §7.3 rule 1's narrower global-region mapping | **Done** (P7, Task 3) |
| Task 2: resource policies (SNS/S3 `Principal "*"`) unread | **Done** (P10, Task 3) |
| Final Minor 3: Unblock's RDS modify without reading | **Done** (P18, Task 4) |
| Final Minor 7: `LabBuckets` has no region condition | Covered at plan time by P7 (a bucket's own region must be the session's); IAM unchanged: an S3 region deny risks S3's and CloudFront's global calls |
| Final Minor 5 / Task 14: soa-03 `alb.tf` comment vs `depends_on` | Already right on main (`aws_route.public_internet` is in `depends_on`) |
| Ruling: Unblock's Lambda ENI wait moves into the safety net | Batch 3: lab 07's function has no VPC |
| Task 2 / final Minor 4: IPv6 "internet" only at `/0` | Batch 4, before lab 20 (no batch 2 lab uses IPv6) |
| Task 2: `aws_db_instance.publicly_accessible` not refused | Batch 3, with lab 11 (no batch 2 database) |
| Task 2: `aws_iam_instance_profile.role` not checked own; bucket sub-resource ownership | IAM stops both (PassRole to lab roles only; buckets `cloudlabs-*` only) |
| Task 4: ElastiCache failed states not fail-fast | Batch 3, with lab 11 |
| Task 4: timings lost under `bash -e`; `delet*` matches `DELETE_FAILED`; NotFound from another region | Inherited from `lab.yml`; no batch 2 effect (the ready check's stacks are judged by Terraform's own wait) |
| Task 4 (parked): five `lab-aws.yml` steps duplicate `lab.yml` | Steven's call (C20); the equality test holds them |
| Task 5: inline-policy `gone_err`, `split_arn` duplicated, ordering tests, fabric retry window, describe comment, empty stdout, `rds_wait` warnings | Low value; the new handlers follow the existing patterns |
| Task 1, 3, 6, 7, 9, 10, 12, 13, 16: cosmetic and test-debt items | Unchanged; none affects a batch 2 lab |
| Final Minor 8: A30's unpeer and destroy run together | Watch item from batch 1; batch 2 does not change it |
| Final Minor 9: spec §7.5's "id as a parameter" wording | Spec wording only; left for the next spec edit outside a batch |

## Spec coverage (self-review)

| Spec item | Where |
|---|---|
| §12.2 rows 06–10: areas, level, type, tier, peer, D/X, S/M, prerequisites, key resources | Tasks 7–11 (`lab.yaml` and the per-lab tests pin each) |
| §12.2 lab 08's three faults, verbatim | Task 9 (`data.tf` FAULT 1–3; three tests) |
| §12.2 "Not built here": StackSets (06), Organizations and SCPs (07), EKS (10) | Tasks 7, 8, 11 readmes; `never` for StackSets (Task 3) |
| §14 item 2: CloudFormation template reader | Task 3 (`cfnTemplateProblems`, `lintCfnText`, rule `template`) |
| §14 item 2: lab 07's user, login profile and files | Tasks 2, 3, 4, 5, 8 (the `users` output; lab 31's `files` stays batch 4) |
| §14 item 2: us-east-1 plumbing for CloudFront and Route 53 | Tasks 3 (P7), 4 (us-east-1 handlers), 5 (Worker reads) |
| §14 item 2: ECS (lab 10) | Tasks 3, 4, 6, 11 |
| §7.1 create/change lists, service-linked list, `Lab07Users` | Task 2 |
| §7.3 rules 1, 4–13 for batch 2's types | Task 3 |
| §8.1–§8.3 for every new type | Task 4 |
| §15 KMS pending deletion, slow CloudFront deletes, Route 53 zone charge | Tasks 4, 5 (P11), 13 (V answers) |
| §17: plan rulings copied as A59 on | Task 12 Step 4 |
