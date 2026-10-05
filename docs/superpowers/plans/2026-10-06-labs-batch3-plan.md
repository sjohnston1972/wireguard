# Labs batch 3 (labs 20–27, the first AZ-305 batch): implementation plan

## C0 names as built (`feat/labs-b3-engine`, 2026-10-05)

The contract on `feat/labs-b3-engine`. Content areas branch from its head and use these names exactly; a change goes
through the integrator, who updates this section. Batch 1's L0 names and batch 2's "B0 names as built"
(`docs/superpowers/plans/2026-10-05-labs-batch2-plan.md`) all still hold unless changed here. **Changed from the planned
names** (content builders take note): no define-only roles (identity change 2: lab 20's roles are assigned by Terraform);
`identity: "match"` also names a lab custom role from `azurerm_role_definition.<x>.role_definition_resource_id`; test 4
counts a replicated VM's failover VM in `capacity.vm_sizes` and test 5 prices `retail.sku` items per region too;
`time` resolves to 0.14.2 (not 0.13.x); a policy rule a plan cannot read is refused; unknown ids inside nested blocks are
scope-checked; the ready check's columns are `name, type, provisioningState`; the mock plan mocks only the providers a lab
installs.

**Content suite, `scripts/test/fixtures/labs/content.mjs`**
- `labContentSuite(id, { marker, secondary = false, identity = "none" })`, unchanged for batch 1–2 callers (defaults).
  `contentChecks(id, opts)` returns the same checks as `[{ name, skip?, fn }]` without registering them (`opts.labsDir`,
  `opts.load` for fixture labs); `lab(id, labsDir?)`.
  - `secondary: true` renames test 3 to `${id}: two resource groups, rg-lab-<id> in the region and rg-lab-<id>-secondary in
    the secondary region, and everything else inside one of them with the tags` and expects exactly
    `azurerm_resource_group.lab` (`var.resource_group_name`, `var.region`, `var.tags`) and `azurerm_resource_group.secondary`
    (`"${var.resource_group_name}-secondary"`, `var.secondary_region`, `var.tags`); `lab.yaml` `regions.secondary: ukwest`;
    `variables.tf`'s `secondary_region` has a `validation` whose condition is exactly
    `var.secondary_region != "" && var.secondary_region != var.region`.
  - Test 3 is schema-driven: a resource whose type takes `resource_group_name` (or sets it) must name
    `azurerm_resource_group.lab.name` (or `.secondary.name` with `secondary`), a `resource_group_id` must be one of the
    groups' `.id`, and a type that takes `tags` must set `var.tags`. A type missing from `plans/schema-facts.json` fails
    (the integrator adds it). `CHILD_TYPES` stays exported for batch 1–2 tests.
  - Test 4: `capacity.vm_sizes` = one entry per VM at its maximum **plus one per `azurerm_site_recovery_replicated_vm`**
    (its failover VM, at the size of the VM its `source_vm_id = azurerm_linux_virtual_machine.<x>.id` names).
    `identity: "match"` replaces the identity clause: every role assignment sets `principal_type`; `identity.roles` equals
    the role assignments as `{ role, scope }` (order free); `identity.creates` equals the `azuread_user`/`azuread_group`
    kinds made; `identity.governance` equals membership of `GOVERNANCE_LABS`.
  - Test 5: `retail.sku` items **without** `region` = the VMs' default count; `retail.meter: "S4 LRS Disk"` without `region`
    = the VMs' default count, with `region: secondary` = the number of `azurerm_site_recovery_replicated_vm`.
- `roleAssignments(l)` → `[{ address, role, scope, principalType }]`: `role` is a literal `role_definition_name`, or the
  lab's custom role's name (`"lab-${var.lab_id}-x"` with the id filled in) when `role_definition_id` (or
  `role_definition_name`) is `azurerm_role_definition.<x>.role_definition_resource_id` / `.role_definition_id` / `.name` /
  `.id`; `scope` is `resource_group` (`azurerm_resource_group.*.id`), `management_group` (`azurerm_management_group.*.id`)
  or `resource`.
- Fixture labs for the suite's own tests: `scripts/test/fixtures/labs/suite/az305-9{1,2,3,4}-*` (not in the catalogue).

**Plan fixtures, `scripts/test/fixtures/labs/plans/`**
- `common.mjs`: `SECONDARY` (`ukwest`); `ctx(id, n)` also returns `rgSecondary` (`rg-lab-<id>-secondary`) and
  `variables.secondary_region` (`ukwest`); `rgSecondaryResource(c)` (`azurerm_resource_group.secondary`, refs
  `var.resource_group_name`, `var.secondary_region`, `var.tags`); `linuxVm(c, { ..., image })` with `image = { offer, sku }`
  (default `ubuntu-24_04-lts` / `server`; lab 26: `0001-com-ubuntu-server-jammy` / `22_04-lts-gen2`).
- `computed.json` and `schema-facts.json` from azurerm 4.81.0, azuread 3.10.0, **time 0.14.2** and random 3.9.1 (what
  `~> 0.13` and `~> 3.7` resolve to on 2026-10-05; `labs/_template` pins neither, so a lab using them declares
  `hashicorp/time` / `hashicorp/random` in its `versions.tf`). `TYPES` gains every C0.1 type plus
  `data.azurerm_resource_group`. `realistic.mjs` exports `SCHEMA_FACTS`.
- `shape.mjs`: `planShape(plan)` (re-exported from `infra/ci/lab-plan-shape.mjs`) → `{ resources: { "<address>": { type,
  refs: { "<attr or block.0.attr>": [...] }, unknown: [paths], sensitive: [paths] } } }`, values never included, data
  sources read at plan included; `recordedShape(id)` → `shapes/<id>.json` or `null`; `compareShapes(real, fixture)` → one
  line per difference (references compared as sets). `lab-plans.test.mjs`: `${id}: the plan fixture has the recorded real
  plan's shape` (skips, naming the file, until a release test records one).

**Scope** (`infra/ci/lab-scope.mjs`, no new rule names):
- `GOVERNANCE_TYPES` + `azurerm_management_group_policy_set_definition`.
- `immutability`: an `azurerm_key_vault` with `purge_protection_enabled = true`, or unknown when configured.
- `role`: an `azurerm_policy_definition` whose `policy_rule` (JSON, keys case-insensitive, whatever the effect says) has a
  `roleDefinitionIds` entry that is not a **built-in** on the allow-list; in a plan, a `policy_rule` that is not known (built
  from apply-time values: pass those to the assignment as parameters) or not JSON.
- `outside-scope`: such a rule with `deploymentScope` `subscription`; and an **unknown id inside a nested block** (last path
  segment `id`, `*_id` or `*_ids`, not an Entra id) must come from the lab's own resources, as top-level ids already must
  (a failover group's `partner_server.0.id`, a replicated VM's `managed_disk.0.target_resource_group_id`).
  **Integration fix:** `terraform show -json` splits references by path only for schema *blocks*; an *attribute* holding
  objects or lists (`managed_disk`, `network_interface`, `databases`) lists every reference under the attribute while
  `after_unknown` marks the nested paths (checked on a real offline plan). So an unknown nested value takes the nearest
  enclosing path's references, and one named as an id or made from ids (`databases.0`) must have every one of them place it
  in the lab.
- `rg-lab-<id>-secondary` passes and `rg-lab-<id>secondary` is refused (pinned by tests).
- Lab 20 may assign its own two custom roles (by GUID or through its `azurerm_role_definition`), no other lab may.

**Roles (identity change 2, approved by Steven 2026-10-05):** `labs/setup/allowed-roles.json` `custom` holds lab 1's
`lab-az104-01-identity-vm-operator` and lab 20's `lab-az305-20-landing-zone-netops` (`60bdbc03-b25a-4a83-9fce-b2c5afff563c`)
and `lab-az305-20-landing-zone-appops` (`bd52e05a-22cb-4bd5-b56c-3396add9b7c0`), ordinary entries, one per line.
`governance-condition.txt` was regenerated with `node scripts/labs-setup.mjs --condition` (both GUIDs appended to both
lists) and must be re-applied in Azure before lab 20's release test. No `"assign"` key exists.

**Prices:** `shared/labs.ts` `LabCostItem.region?: "secondary"`; `scripts/lib/labs.mjs` accepts `region: secondary` only
with `regions.secondary` (else a `cost.items` problem); `worker/src/labs/prices.ts` `retailPrice(item, rows, region, now,
secondaryRegion = null)` (a secondary item with no secondary region: the authored figure); `pricedItems` and `gbpHFrom`
pass `def.regions.secondary`; `labGbpH` reads the region's and the lab's secondary region's rows; new
`readLabPrices(env, region)` (the region plus every catalogue lab's secondary region) feeds the cards, the modal and the
warnings. `labs-verify --meters` checks a `region: secondary` item in the lab's `regions.secondary` and prints it as
`<meter> (ukwest): ...`; such an item in a lab without one is a problem.

**Unblock** (`infra/ci/lab-unblock.sh`, same "never fails" contract): `5. Site Recovery`, per vault: DELETE every
`replicationRecoveryPlans` first (integration fix: a learner's hand-made plan blocks item removal and vault deletion); list
`replicationProtectedItems` (`value[].[id, properties.testFailoverState]`); an item whose state is not empty, `None` or
`MarkedForDeletion` → POST `<item>/testFailoverCleanup` (`{"properties":{"comments":...}}`); POST `<item>/remove`; poll
the vault's items every 15 s until none, at most `LAB_UNBLOCK_ASR_WAIT_SECONDS` (default 900; a failed list is
"unverified"); then DELETE every `replicationNetworkMappings`, POST `remove` on every
`replicationProtectionContainerMappings` (`{"properties":{"providerSpecificInput":{}}}`), DELETE every `replicationPolicies`
(vault-level lists, `az rest`, api-version 2023-08-01). `6. SQL`: servers listed across all lab groups first; per server,
`az sql failover-group list` (`[name, replicationRole]`) → `delete` where the role is `Primary`; then per database (not
`master`) `az sql db replica list-links` (`[partnerServer, role]`) → `az sql db replica delete-link --resource-group <g>
--server <s> --name <db> --partner-server <p> --partner-resource-group <p's lab group> --yes` where the role is `Primary`.

**Safety net** (`infra/ci/lab-safety-net.sh`): after the group deletes, `az keyvault list-deleted --resource-type vault`
rows whose `properties.vaultId` names one of the lab's groups → `az keyvault purge --name <n> --location <l>`; `--verify`
lists each as `"<name> (soft-deleted vault)"`, and a list that fails is `unverified: soft-deleted Key Vaults`.

**Ready check** (`infra/ci/lab-ready.sh`): `READY_NO_STATE_TYPES=()` (empty); the query is `[].[name, type,
provisioningState]` (state last: an empty middle field would collapse in `read`); a resource with an empty state passes
only when its type is listed (case-insensitive).

**labs-tf** (`scripts/labs-tf.mjs`): after validate, `tests/labs-mock.tftest.hcl` in the throw-away copy (`mockPlanFile`,
`mockedProviders`): `mock_provider` for each of azurerm, azuread, random and time **that the lab installs** (its lock file;
mocking one it does not install fails with "unknown provider"), azurerm with `mock_data` for `azurerm_subscription` and
`azurerm_client_config` (real-looking ids: azurerm validates a role definition's scope even in a mocked plan); file-level
`variables` (slot 31 `10.71.192.0/18`, `uksouth`/`ukwest`, `l<NN>k3x9q`, a parseable throw-away SSH key, fake password);
one `run "plan" { command = plan }`; then `terraform test -no-color`. A failure is `mock plan (terraform test): ...` for
that lab.

**lab.yml step 6 and the release test:** after `terraform show -json`, `node "$GITHUB_WORKSPACE/infra/ci/lab-plan-shape.mjs"
"$RUNNER_TEMP/plan.json" || echo "::warning::..."` prints `LAB_PLAN_SHAPE <base64 of gzipped shape JSON>` (before the scope
check); `scripts/lab-release-test.mjs` `parseLabPlanShape(log)` reads the test run's line and writes
`scripts/test/fixtures/labs/plans/shapes/<id>.json` (`SHAPES_DIR`; `deps.shapesDir` in tests).

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands **C0** first. Then three content areas run **in parallel**, each in its own
> git worktree with one implementer under superpowers:test-driven-development: **C1** governance and identity (labs 20–22),
> **C2** data (23–25), **C3** continuity and multi-region (26–27). Steps use checkbox (`- [ ]`) syntax.

**Goal:** labs 20–27 deployable from the Labs tab, each priced honestly, scope-checked before apply, and passing a real-Azure
release test with `clean: true`, covering the AZ-305 identity, data and continuity areas (infrastructure follows in batch 4).

**Architecture:** content on the batch 1–2 engine: a folder per lab, a realistic plan fixture per lab, a content test file
per area. C0 closes the engine gaps these labs expose: a second resource group in a second region, secondary-region prices,
lab 20's Terraform-assigned custom roles, remediating policies, and teardown for Key Vault, SQL failover groups and Site
Recovery. One small Worker change (secondary-region prices); no route, D1 or app change; the deploy bundles the new
catalogue.

**Tech stack:** unchanged. Terraform 1.14.6, azurerm `~> 4.0` (4.81.0 in the lock), azuread 3.10.0, `hashicorp/time` for
lab 22's wait, node:test for scripts, Vitest for the Worker, Bicep 0.47.16 (no batch 3 lab uses Bicep).

**Spec:** `docs/superpowers/specs/2026-10-04-labs-design.md` is binding, with decisions A and B (§14), §16 and §17. This
plan's rulings are already in §17 as 23–37 (they win over §12.2's planning columns). **(V)** marks a fact checked live or on
the official page during the build; each area's report records the answer.

**Facts established before planning** (read-only, on Steven's pay-as-you-go subscription, 2026-10-05):
- App Service quota 0 for P0v3 and S1 in uksouth. SQL vCore quota 0 in uksouth, 320 in ukwest; SQL server quota 250.
- `standardBSFamily` 10 vCPUs and total 10 vCPUs in each of uksouth and ukwest; DSv5 families 0.
- Registered: Sql, DocumentDB, Cdn, KeyVault, RecoveryServices, PolicyInsights, Insights, Network, Web, App. App Gateway Basic
  preview not registered.
- Offline checks for this plan: azurerm 4.81.0's schema (scratch `terraform providers schema -json`) has every resource named
  below and **no** SQL free-offer attribute; `azurerm_policy_definition` and `azurerm_policy_set_definition` still take
  `management_group_id`; `azurerm_subnet.default_outbound_access_enabled` exists. The AZ-305 outline ("Skills measured as of
  April 17, 2026") matches `labs/skill-areas.yaml`'s four areas. Site Recovery's Azure-to-Azure matrix (2026-09-11) supports
  Ubuntu 22.04 and 24.04 by kernel list; 22.04's 6.8-azure series is listed through 9.66. Failover groups (Learn, 2026-01-29):
  customer-managed policy recommended, Microsoft-managed needs a grace period of at least 1 hour; adding a database that
  already has a geo-secondary inherits that link. Monitoring Contributor holds `Microsoft.Insights/DiagnosticSettings/*`,
  `Microsoft.Resources/deployments/*`, `Microsoft.OperationalInsights/workspaces/sharedKeys/action`.
  `mcr.microsoft.com/azurelinux/base/python:3.12` exists.

## Global Constraints

- **Inherited** from batches 1–2 unchanged: commit trailer `Claude-Session:
  https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV` and push after every commit; never read `.env` (worktrees `cp
  .env.example .env`); Windows skips with a reason for missing bash, terraform, hcl2json or bicep; fixtures use TEST-NET,
  `contoso.onmicrosoft.com` and fake GUIDs; the gateway is never touched; £0 always; kill processes by PID only.
- **Branches:** C0 `feat/labs-b3-engine` from `main`; C1 `feat/labs-b3-identity`, C2 `feat/labs-b3-data`, C3
  `feat/labs-b3-continuity` from C0's head; integration `feat/labs-b3` from C0's head, which becomes the batch PR.
- **STOP: ask Steven** before any real-Azure run, any identity change, any merge to `main`, and any deploy.
- **Frozen files** (C0 or the integrator only): batch 2's list, plus `shared/labs.ts`, `worker/src/labs/prices.ts`,
  `scripts/lib/labs.mjs`, `scripts/test/fixtures/labs/plans/{shape.mjs,schema-facts.json,shapes/**}`, `infra/ci/lab-plan-shape.mjs`.
- **No App Service, no vCore SQL in uksouth, no preview SKU, no DSv5, no locked immutability, no purge protection.**
- **Every resource inside `rg-lab-<id>` or `rg-lab-<id>-secondary`.** Named Azure-made exceptions only: Azure's own
  `NetworkWatcherRG` (Azure creates `NetworkWatcher_ukwest` there with the first ukwest VNet; ignored by the sweep, ruling 8).
  Diagnostic settings written by lab 21's policy, Site Recovery's replica disks and failover VMs, and the DINE deployments all
  land in the lab's own groups.
- **Identity:** labs 20 and 21 are governance labs (named in code already). Role assignments only as each lab's table row says,
  every one with `principal_type` and inside the lab's groups. No Entra users or groups in batch 3.
- **Cheapest SKUs:** `Standard_B1s`, `Standard_LRS` OS disks (S4); Key Vault Standard; SQL Basic (DTU) and one GP_S_Gen5_1;
  Cosmos DB serverless; Storage StandardV2 LRS/RA-GRS; Recovery Services Standard LRS; ACI 0.5 vCPU / 0.5 GB; Front Door
  Standard (no WAF policy); Traffic Manager with external endpoints.
- **Addresses:** every one from `cidrsubnet(var.address_space, 2, n)` (a /20) and smaller cuts of it; a secondary-region VNet
  takes its own /20 of the slot.
- **`lab.yaml`:** as batches 1–2 (YAML 1.1, `"off"` quoted, whole minutes, `retail` meters unique in uksouth or authored,
  ruling 2); a header comment naming the AZ-305 study-guide skills (outline of April 17, 2026) and where each price came from,
  with the `labs-verify --meters` answer.
- **Readmes, identical in shape to labs 1–19:** an introduction (no `#` title) naming the part of the "AZ-305 outline" covered;
  `## What it deploys` (bullets, then a ` ```text ` diagram); `## Things to try` (3–6 bullets); `## Learn more`
  (learn.microsoft.com only, each answering 200); the `readmeFooter(id)` footer verbatim. Labs with a secondary region say the
  lab must be deployed in uksouth with ukwest as its pair, and what the secondary group holds.
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run labs-check`, `npm run labs-tf -- <own
  ids>` (including the mock plan), `npm run labs-verify -- --links --meters <own ids>`.

## The eight labs

Planning figures; release tests replace the times. £/h is the authored estimate (Retail Prices API, GBP, 2026-10-05).
Markers from `costMarker` (ruling 13 of §16): £ under £0.05/h, ££ under £0.50/h, £££ from £0.50/h or a 30-minute deploy.

| # | Id | Builds | £/h | Peer | Regions | /20s | Deploy/destroy | Sess/max | Prereq | Job timeout |
|---|---|---|---|---|---|---|---|---|---|---|
| 20 | az305-20-landing-zone | 6 lab MGs, MG-scope initiative + 2 assignments, 2 custom roles assigned to 2 managed identities · G | 0.000 £ | off | uksouth | 0 | 8/6 | 2/4 | 3 | 48 |
| 21 | az305-21-monitoring-scale | capped workspace, Key Vault, DINE diagnostics policy at the group, MI with Monitoring Contributor, audit policy · G | 0.001 £ | off | uksouth | 0 | 4/4 | 2/6 | 18 | 36 |
| 22 | az305-22-keyvault-mi | Key Vault (RBAC), 2 secrets, B1s VM with system MI + user-assigned MI, vault- and secret-scope roles | 0.011 £ | opt | uksouth | 1 | 7/5 | 2/6 | 8 | 44 |
| 23 | az305-23-sql-failover | 2 SQL servers, Basic primary + Basic geo-secondary, failover group (Manual), serverless DB in ukwest, 2 private endpoints | 0.151 ££ | opt | uksouth + ukwest | 1 | 15/10 | 2/4 | — | 70 |
| 24 | az305-24-cosmos | Cosmos DB serverless (SQL API), 3 containers with different partition keys | 0.003 £ | off | uksouth | 0 | 10/10 | 2/4 | — | 60 |
| 25 | az305-25-storage-design | HNS data lake with lifecycle tiering, RA-GRS account with an unlocked 1-day container policy | 0.000 £ | off | uksouth | 0 | 3/3 | 2/6 | 5 | 32 |
| 26 | az305-26-site-recovery | B1s VM (Ubuntu 22.04) replicated by ASR to ukwest; vault, target and test VNets in the secondary group | 0.063 ££ | opt | uksouth + ukwest | 3 | 25/20 | 3/8 | 8 | 110 |
| 27 | az305-27-multi-region | ACI in uksouth and ukwest, Traffic Manager (priority) and Front Door Standard in front | 0.078 ££ | off | uksouth + ukwest | 0 | 12/12 | 2/4 | — | 68 |

Skill areas: 20–22 `az305.identity`; 23 `az305.data, az305.continuity`; 24–25 `az305.data`; 26 `az305.continuity`; 27
`az305.infra, az305.continuity`. Level `expert`, type `explore` for all eight. `dns_link: true` only for 23. Lab 26's title
is "Cross-region VM recovery with Site Recovery" (ruling 32; confirmed by Steven 2026-10-05); the others keep §12.2's titles.

Retail entries (all checked unique in uksouth by `labs-verify --meters`, else authored): `{ sku: Standard_B1s }` (£0.0089/h);
`S4 LRS Disk` (`1/Month`, £1.2755); `B DTU` (`1/Day`, £0.1517, uksouth); `B Secondary Active DTU` (`1/Day`, £0.1517,
`region: secondary`); `VM Replicated to Azure` (`1/Month`, £18.8686). Authored (ruling 2 or no regional row): serverless
`vCore` (shared meter; £0.4922 per vCore-hour in ukwest), private endpoint (region Global), private DNS zone, ACI vCPU and
memory (shared), Front Door `Standard Base Fees` (region "Zone N", £26.4161/month), Traffic Manager (region Global), Cosmos
`1M RUs` (unit `1M` is not a feed unit) and `Data Stored` (shared), Log Analytics, Key Vault operations, storage, inter-region
transfer (`Standard Inter-Region Data Transfer` £0.0151/GB).

### Per-lab design

**Lab 20 `az305-20-landing-zone`: "Landing zone lite: management groups, policy initiatives, role design"** (C1)
- Deploys: `rg-lab-<id>` (nothing billable in it; it anchors the custom roles' assignable scope and holds the two
  identities they are assigned to). Management groups
  under the tenant root (lab 3's pattern): `lab-<id>-root` → `-platform`, `-landingzones` → (`-corp`, `-online`), and
  `-sandbox` under root (six). A custom audit definition `lab-<id>-audit-costcentre` at `-root`; an initiative
  `azurerm_management_group_policy_set_definition` `lab-<id>-baseline` at `-root` with policy definition groups, holding
  built-in Allowed locations (`e56962a6-4747-49cd-b67b-bf8b01975c4c`, parameter `[var.region]`), built-in Require a tag on
  resource groups (`96670d01-0a4d-4649-9c89-2d3abc0a5025`, `costcentre`) and the custom audit. Assignments (names at most
  24 characters, display name `lab-<id>-…`, as lab 3): `lz-baseline` (the initiative) at `-landingzones`; `sandbox-no-pip`
  (built-in Not allowed resource types `6c112d4e-5bc7-47ae-a041-ea2d9dccd749`, `Microsoft.Network/publicIPAddresses`) at
  `-sandbox`. Two custom roles defined at the subscription, assignable only at `rg-lab-<id>`, **assigned by the lab's
  Terraform** (identity change 2, approved by Steven 2026-10-05; ruling 27): `lab-<id>-netops`
  (`60bdbc03-b25a-4a83-9fce-b2c5afff563c`: `Microsoft.Network/*/read`, NSG rule and route write/delete,
  `Microsoft.Resources/subscriptions/resourceGroups/read`) and `lab-<id>-appops` (`bd52e05a-22cb-4bd5-b56c-3396add9b7c0`:
  `Microsoft.Compute/*/read`, VM start/restart/deallocate, `Microsoft.Insights/metrics/read`, resource group read). Each
  is assigned at `rg-lab-<id>` (the only scope it is assignable at) to its own user-assigned managed identity in
  `rg-lab-<id>` (`id-<prefix>-netops`, `id-<prefix>-appops`; free; the "persona" the role is designed for), with
  `role_definition_id = azurerm_role_definition.<x>.role_definition_resource_id` and `principal_type = "ServicePrincipal"`.
- Regions uksouth; no addresses; peering off. `identity: { creates: [], roles: [{ role: "lab-az305-20-landing-zone-netops",
  scope: resource_group }, { role: "lab-az305-20-landing-zone-appops", scope: resource_group }], governance: true }`
  (content suite `identity: "match"`).
- Teardown blockers: management groups must be empty (children first, Terraform's dependency order; the safety net deletes
  `lab-<id>-` MGs deepest first and everything assigned or defined in them first); custom roles: their assignments go first
  (Terraform's order; the group delete takes RG-scope assignments with it, and the safety net deletes any assignment of the
  fixed GUIDs before the role). The MGs hold no subscription and never will (scope `association`).
- Cost: three free items (management groups; definitions, initiative and assignments; custom roles, their two identities
  and assignments). £0/h, marker £.
- Timing 8/6 (lab 3 took 4 min for three MGs; six, three deep). Session 2, max 4.
- Things to try: compliance per scope (nothing is evaluated: no subscription is inside, and the readme says why); assign
  `lab-<id>-netops` to yourself at `rg-lab-<id>` by hand and try an NSG change; add an exemption at `-corp`; sketch where the
  real subscription would sit (never move it: the gateway would inherit the deny).
- Live-only: six MGs within 8 minutes; the MG-scope initiative assignment; destroy and Verify clean with MG list eventual
  consistency (lab 3 passed the same path).

**Lab 21 `az305-21-monitoring-scale`: "Monitoring at scale: workspace design, diagnostics via policy"** (C1)
- Deploys: `rg-lab-<id>`; Log Analytics workspace `PerGB2018`, daily cap 0.05 GB, 30 days (lab 18's settings,
  `permanently_delete_on_destroy`); a Key Vault Standard (RBAC, retention 7 days, no purge protection) as the resource to be
  governed; a custom definition `lab-<id>-kv-diagnostics` (DINE: if a `Microsoft.KeyVault/vaults` has no diagnostic setting
  sending `allLogs` to the given workspace, deploy one; `roleDefinitionIds` = Monitoring Contributor only, ruling 28); its
  assignment `lab-<id>-kv-diagnostics` at `rg-lab-<id>` with a system-assigned identity and `location = var.region`; a role
  assignment Monitoring Contributor (`749f88d5-…`) at `rg-lab-<id>` to that identity (`principal_type = "ServicePrincipal"`,
  `skip_service_principal_aad_check = true`); built-in AuditIfNotExists "Resource logs in Key Vault should be enabled"
  (`cf820ca0-f99e-4f3e-84fb-66e913812d21`) assigned as `lab-<id>-kv-logs-audit`. The vault `depends_on` the assignment and
  the role assignment, so policy's create-time evaluation remediates it about 15 minutes after deploy without a remediation task.
- Regions uksouth; no addresses; peering off. `identity: { creates: [], roles: [{ role: "Monitoring Contributor", scope:
  resource_group }], governance: true }`.
- Teardown blockers: the vault (ruling 30); the policy-made diagnostic setting is removed with the vault (V: the Learn
  warning about settings surviving a deleted resource; harmless with a random vault name); the assignment's identity goes with
  the assignment; the safety net deletes `lab-<id>-` assignments and definitions; the workspace is deleted permanently.
- Cost: ingestion under the cap £0.0005; Key Vault operations £0.0001; policy free. **£0.0006/h, marker £.**
- Timing 4/4. Session 2, max 6.
- Things to try: watch compliance and the DINE deployment appear in the group's deployments; a remediation task for a second
  vault created by hand; KQL on `AzureDiagnostics`; read the assignment's identity and its one role; sketch central vs
  per-team workspaces and resource-context access.
- Live-only (the soak, Integration step 9, not the release test, which ends before policy evaluates): the remediation succeeds
  with Monitoring Contributor alone. **If it fails for permissions, STOP: identity change 1 below.**

**Lab 22 `az305-22-keyvault-mi`: "Key Vault and managed identities"** (C1)
- Deploys: `rg-lab-<id>`; VNet from /20 0, subnet /24 with `default_outbound_access_enabled = true` (ruling 37); one
  `Standard_B1s` Ubuntu 24.04 VM (`linuxVm`) with system-assigned identity and a user-assigned identity `id-<prefix>-app`;
  Key Vault Standard `${var.name_prefix}kv` (RBAC on, public network access on, retention 7 days, no purge protection);
  secrets `app-db-password` and `reports-api-key` (`random_password`); role assignments: Key Vault Secrets Officer to the
  pipeline's own principal at the vault (`data.azurerm_client_config.current.object_id`, `ServicePrincipal`, so Terraform can
  write the secrets), Key Vault Secrets User to the VM's system identity at the vault, Key Vault Secrets User to the
  user-assigned identity at **one secret** (`reports-api-key`'s `resource_versionless_id`). A `time_sleep` of 120 s between the
  Officer assignment and the secrets (RBAC propagation; V). Provider features: `key_vault { purge_soft_delete_on_destroy =
  true, purge_soft_deleted_secrets_on_destroy = false, recover_soft_deleted_key_vaults = false }`.
- Regions uksouth; 1 /20; peering optional (the VM is reachable over the tunnel; the vault is reached on its public endpoint).
- `identity: { creates: [], roles: [{ role: "Key Vault Secrets Officer", scope: resource }, { role: "Key Vault Secrets
  User", scope: resource }, { role: "Key Vault Secrets User", scope: resource }], governance: false }`.
- Teardown blockers: secrets are destroyed before the Officer assignment (dependency order); the vault purges on destroy;
  ruling 30's safety net for a vault left by a failed destroy.
- Cost: B1s £0.0089, S4 £0.0017, Key Vault operations £0.0001. **£0.0107/h, marker £.**
- Timing 7/5 (the 2-minute wait). Session 2, max 6.
- Things to try: Run command `curl` IMDS for a vault token and read `app-db-password` as the system identity; do the same with
  the user-assigned identity (`client_id`) and see `app-db-password` refused but `reports-api-key` allowed; add a secret version;
  detach the user-assigned identity and see it survive; compare with access policies (readme only).
- Live-only: RBAC propagation within 120 s (else the secret write 403s; raise the wait, version bump); IMDS token and vault
  read from the VM over default outbound access.

**Lab 23 `az305-23-sql-failover`: "Azure SQL Database: serverless, geo-replication, failover groups"** (C2; ruling 24)
- Deploys: `rg-lab-<id>` (uksouth): `azurerm_mssql_server` `${var.name_prefix}-sqlp` (version 12.0, TLS 1.2, SQL login
  `labadmin` / `var.admin_password`, public network access on with no firewall rules); database `appdb` **Basic**; VNet from
  /20 0 with a /24 `snet-pe`; two private endpoints there (one per server, `sqlServer`); private DNS zone
  `privatelink.database.windows.net` linked to the lab VNet with both A records (zone groups). `rg-lab-<id>-secondary`
  (ukwest): server `${var.name_prefix}-sqls`; database `appdb` **Basic**, `create_mode = "Secondary"`,
  `creation_source_database_id` the primary; database `scratch` **GP_S_Gen5_1**, `min_capacity = 0.5`,
  `auto_pause_delay_in_minutes = 60` (V: the provider's minimum; 15 if accepted), `max_size_gb = 1`, not in the group.
  `azurerm_mssql_failover_group` `${var.name_prefix}-fog` on the primary, `partner_server` the secondary, `databases =
  [primary appdb]`, `read_write_endpoint_failover_policy { mode = "Manual" }`, `depends_on` the secondary database (its link is
  inherited).
- Regions uksouth + ukwest; 1 /20 (both endpoints sit in the uksouth VNet, so both servers are reachable over the tunnel
  before and after a failover); peering optional; `dns_link: true` (the gateway's dnsmasq already forwards
  `database.windows.net`; the listener `<fog>.database.windows.net` resolves to whichever server is primary).
- `identity: { creates: [], roles: [], governance: false }`.
- Teardown blockers: failover group and geo-link (ruling 31: unblock deletes the group, then the links; Terraform's order is
  group → secondary → primary otherwise); after a failover the roles are swapped and Terraform's view is stale, which unblock
  covers; servers have no soft delete; dropped-database restore points are not billed.
- Cost: `B DTU` £0.0063; `B Secondary Active DTU` £0.0063 (`region: secondary`); serverless at 0.5 vCore for about half the
  session £0.1231 (authored: £0.4922/vCore-h × 0.5 × 0.5; billed per second only while online); 2 private endpoints £0.0076
  each; DNS zone £0.0005. **£0.1514/h, marker ££.**
- Timing 15/10. Session 2, max 4.
- Things to try: connect over the tunnel to `<fog>.database.windows.net` and write a row; failover the group (Manual) and
  watch the listener move, then fail back; query `sys.dm_geo_replication_link_status`; leave `scratch` idle and watch it pause,
  then wake it; compare DTU and vCore tiers and the read-only listener.
- Live-only: Basic geo-secondary seeding time; failover group create with an inherited link; serverless auto-pause minimum;
  destroy with a swapped failover (soak); a second lab linking the same zone name to `vnet-wg` (none in batch 3; batch 4's
  labs 30–31 must not run beside 23 peered).

**Lab 24 `az305-24-cosmos`: "Cosmos DB: partitioning and consistency"** (C2; ruling 33)
- Deploys: `rg-lab-<id>`; `azurerm_cosmosdb_account` `${var.name_prefix}-cosmos` (`GlobalDocumentDB`, `capabilities {
  name = "EnableServerless" }`, one `geo_location` uksouth priority 0, `consistency_policy` Session, `free_tier_enabled =
  false`, public network access on, key auth on); SQL database `shop`; containers `orders` (`/customerId`), `events`
  (hierarchical `/tenantId`, `/userId`: `partition_key_kind = "MultiHash"`, version 2) and `bykey-status` (`/status`, the
  deliberate hot-partition example). No throughput anywhere (serverless).
- Regions uksouth; no addresses; peering off. `identity: { creates: [], roles: [], governance: false }`.
- Teardown blockers: none beyond time (account delete takes minutes: destroy 10).
- Cost: light use about 10,000 RU an hour £0.0022 (authored from `1M RUs` £0.2242); storage under 1 GB £0.0003.
  **£0.0025/h, marker £.**
- Timing 10/10. Session 2, max 4.
- Things to try: Data Explorer inserts and the request charge with and without the partition key; a cross-partition query;
  change the default consistency and read the trade-offs; see why serverless refuses a second region; design notes for
  synthetic keys.
- Live-only: uksouth Cosmos capacity (the "high demand" refusal some regions show; `az cosmosdb locations show` in pre-flight);
  create and delete times.

**Lab 25 `az305-25-storage-design`: "Storage design: data lake, immutability, tiering"** (C2; ruling 34)
- Deploys: `rg-lab-<id>`; `${var.name_prefix}lake` StorageV2 LRS, `is_hns_enabled = true`, Hot, containers (file systems)
  `raw` and `curated` (`azurerm_storage_container`, management plane), lifecycle policy (`azurerm_storage_management_policy`:
  `raw` to Cool after 30 days, Cold after 90, Archive after 180; `curated` delete after 365); `${var.name_prefix}rec` StorageV2
  **RA-GRS**, container `evidence` with `azurerm_storage_container_immutability_policy` 1 day, `locked = false`,
  `protected_append_writes_enabled = true`. Public blob access off, shared key on, no SFTP, no versioning-level immutability.
- Regions uksouth; no addresses; peering off. `identity: { creates: [], roles: [], governance: false }`.
- Teardown blockers: the unlocked policy and any legal hold Steven adds (unblock steps 2–3 already remove them before
  destroy; C0 adds a test on an HNS account); a locked policy is refused at plan and the readme says never to lock one.
- Cost: two accounts with a few MB £0.0002; lifecycle and policy free. **£0.0002/h, marker £.**
- Timing 3/3. Session 2, max 6.
- Things to try: upload to `evidence` and fail to delete it; add a legal hold and clear it; HNS directories and ACLs in
  Storage browser; archive a blob and read the rehydration options; the RA-GRS secondary endpoint.
- Live-only: HNS with lifecycle archive on LRS; container immutability on an RA-GRS account (unblock removes it in the
  release test only if a blob was added; the soak adds one).

**Lab 26 `az305-26-site-recovery`: "Cross-region VM recovery with Site Recovery"** (C3; ruling 32)
- Deploys: `rg-lab-<id>` (uksouth): VNet `vnet-source` from /20 0 (subnet /24, default outbound on); one `Standard_B1s`
  Ubuntu 22.04 Gen2 VM (`Canonical`/`0001-com-ubuntu-server-jammy`/`22_04-lts-gen2`, standard security type) serving its
  name on port 80; cache storage account `${var.name_prefix}cache` (LRS, no blob soft delete, shared key on).
  `rg-lab-<id>-secondary` (ukwest): Recovery Services vault Standard, `storage_mode_type = "LocallyRedundant"`,
  `soft_delete_enabled = true` (azurerm insists; unblock turns it off), `immutability = "Disabled"`; `vnet-target` from /20 1
  and `vnet-test` from /20 2. Site Recovery: fabrics for uksouth and ukwest, a protection container in each, a replication
  policy (recovery points kept 360 minutes, app-consistent snapshots off), a container mapping (automatic update off), a
  network mapping `vnet-source` → `vnet-target`, and `azurerm_site_recovery_replicated_vm` with `target_resource_group_id` the
  secondary group, `managed_disk` (staging the cache account, target and replica disk types `Standard_LRS`, target group the
  secondary), `network_interface` to `vnet-target`'s subnet, `test_network_id` `vnet-test`.
- Regions uksouth + ukwest; 3 /20s; peering optional (the hub is `vnet-source`; after a failover the VM is in ukwest and not
  reachable over the tunnel: serial console).
- `identity: { creates: [], roles: [], governance: false }`.
- Teardown blockers: replication (Terraform disables it; unblock's ruling-31 path cleans a test failover, removes items and
  waits, then removes mappings and policies); a committed failover leaves the VM running in the secondary group (deleted with
  it); the vault's soft delete (lab 19's unblock path); the Mobility extension on the source VM (removed with replication or
  with the VM). Everything ASR makes is in a group we named; the readme says never to re-protect into another group.
- Cost: B1s £0.0089; S4 £0.0017; `VM Replicated to Azure` £0.0258 (the first 31 days of each protected instance are free, so
  usually £0); replica S4 £0.0017 (`region: secondary`); cache and recovery-point snapshots £0.0010; initial replication about
  3 GB uksouth→ukwest over a 3-hour session £0.0151; test failover VM B1s £0.0089 (`region: secondary`, only while a test
  failover runs). **£0.0631/h, marker ££** (£££ if the release test measures a deploy of 30 minutes or more; marker rule).
  `capacity.vm_sizes`: two `Standard_B1s` (ruling 3).
- Timing 25/20. Session 3, max 8.
- Things to try: test failover into `vnet-test`, check the VM, clean up; read RPO and recovery points; build a recovery plan by
  hand; an unplanned failover and commit (then tear down; no re-protect in a session).
- Live-only: the enable-replication job's time (decides the marker); Mobility agent on the marketplace 22.04 kernel; default
  outbound access to Site Recovery endpoints; destroy within 20 minutes (job timeout 110); vault deletion after unblock.

**Lab 27 `az305-27-multi-region`: "Multi-region app with Traffic Manager and Front Door"** (C3; ruling 23)
- Deploys: `rg-lab-<id>`: ACI `ci-uks` (Linux, 0.5 vCPU, 0.5 GB, `ip_address_type = "Public"`, `dns_name_label =
  "${var.name_prefix}-uks"`, port 80, image `mcr.microsoft.com/azurelinux/base/python:3.12`, command writes the region into
  `index.html` and runs `python3 -m http.server 80`); Traffic Manager profile `${var.name_prefix}-tm` (Priority, TTL 30, HTTP
  probe on `/` every 30 s) with two external endpoints (priority 1 uksouth FQDN, 2 ukwest); Front Door Standard profile, endpoint,
  origin group (HTTP probe `/` every 100 s, sample 4/3), two origins (`host_name` and `origin_host_header` the ACI FQDNs,
  `http_port 80`, priorities 1 and 2, certificate name check on), one route `/*` (HTTP and HTTPS in, `HttpOnly` forwarding, no
  caching). `rg-lab-<id>-secondary` (ukwest): ACI `ci-ukw`, the same.
- Regions uksouth + ukwest (Traffic Manager and Front Door are global, kept in `rg-lab-<id>`); no addresses; peering off.
- `identity: { creates: [], roles: [], governance: false }`.
- Teardown blockers: none known; Front Door profile deletion takes minutes (destroy 12).
- Cost: ACI uksouth £0.0196 (0.5 × £0.0352 + 0.5 × £0.0039); ACI ukwest £0.0212; Front Door base fee £0.0362; Front Door
  requests £0.0001; Traffic Manager external endpoint checks £0.0006 × 2; DNS queries £0.0001. **£0.0784/h, marker ££.**
- Timing 12/12. Session 2, max 4.
- Things to try: stop `ci-uks` (`az container stop`) and watch Traffic Manager answer ukwest after about 90 s, and Front Door
  move by probe; switch Traffic Manager to Weighted or Performance; compare DNS-based and anycast-proxy failover; why
  Traffic Manager needs a backend that ignores the Host header (and App Service's custom-domain story, readme only).
- Live-only: the image's shell and command; ACI quota in ukwest; Front Door serving within ~10 minutes (the ready check does
  not wait for edge propagation; the readme says so); the Traffic Manager profile reports a `provisioningState` (else ruling 36).

## Identity changes (STOP: Steven approves)

One identity change is in batch 3: **change 2 below, approved by Steven 2026-10-05.** Labs 21 and 22 need none:
- Lab 21's remediation identity gets **Monitoring Contributor** (`749f88d5-cbae-40b8-bcfc-e573ddc772fa`), already allowed.
- Lab 22 uses **Key Vault Secrets Officer** (`b86a8fe4-44ce-4948-aee5-eccb2c155cd7`) and **Key Vault Secrets User**
  (`4633458b-17de-408a-b874-0445c86b69e6`), already allowed.

1. **Log Analytics Contributor `92aaf0da-9dab-42b6-94a3-d43ce8d16293`** (contingent, a STOP if it happens), only if the lab
   21 soak shows the DINE deployment refused with Monitoring Contributor alone. Change: add it to `allowed-roles.json`
   `builtIn`, the §8.1 list and `lab-roles.test.mjs`'s expected list, regenerate `governance-condition.txt` (`node
   scripts/labs-setup.mjs --condition`), Steven re-applies the condition on the governance role assignment (README "Labs:
   one-time setup", step 2), lab 21 version bump with the role in its definition and assignment.
2. **Lab 20's custom roles are assigned by its Terraform** (`60bdbc03-b25a-4a83-9fce-b2c5afff563c` netops,
   `bd52e05a-22cb-4bd5-b56c-3396add9b7c0` appops). **Change 2 APPROVED by Steven 2026-10-05; applied by Claude with Steven's
   az login after integration (the role assignment's condition re-applied).** Steven chose this over define-only roles, so
   the define-only mechanism (`"assign": false`) was never built. C0.4 added both roles to `allowed-roles.json` `custom` as
   ordinary entries and regenerated `governance-condition.txt` with `node scripts/labs-setup.mjs --condition`: the only
   change is the two GUIDs appended to both GUID lists (write and delete). **The condition must be re-applied in Azure
   before lab 20's release test** (the integrator or the main session does it; Integration step 6); until then Azure refuses
   lab 20's role assignments.

## Review Focus

1. **A lab that cannot get back to £0.** C0: `unblock deletes SQL failover groups, then geo-replication links`; `unblock cleans
   up a test failover before removing replication`; `unblock waits until a vault has no replicated items, then removes network
   mappings, container mappings and policies, never failing the run`; `the safety net purges soft-deleted Key Vaults that lived
   in a lab group, and verify counts one as a leftover`; `unblock removes an unlocked policy and a legal hold on an HNS
   account`. Areas: `az305-22-keyvault-mi: versions.tf purges the vault on destroy and never recovers one`;
   `az305-23-sql-failover: the failover group depends on the explicit geo-secondary`; `az305-26-site-recovery: everything Site
   Recovery makes is in rg-lab-<id>-secondary`. Release tests prove each path once; the soaks prove the swapped-failover and
   committed-failover paths.
2. **Escaping the scope.** C0: `a management-group initiative is a governance definition`; `a Key Vault with purge protection
   is refused`; `a remediating policy may list only allow-listed roles and never deploy at subscription scope`; `lab 20 may
   assign its own custom roles inside its group, and no other lab may`; `rg-lab-<id>-secondary is the lab's and
   rg-lab-<id>secondary is not`;
   `a Site Recovery target group outside the lab is refused`; `a failover group whose partner server is outside the lab is
   refused`.
3. **Fixtures tidier than real plans** (batch 2's lesson). Every batch 3 fixture goes through `realisticPlan`; references are
   written as Terraform 1.14 prints them (`azurerm_x.web[count.index].id` → `["azurerm_x.web", "count.index"]`, a nested
   block's reference listed under the block's attribute); the first release test records each lab's real shape and the shape
   test must pass after the integrator copies it in; the mock plan in `labs-tf` catches plan-time errors `validate` misses.
4. **Azure says no.** SQL vCore only in ukwest; Basic geo-secondary and failover group; Cosmos uksouth capacity; ACI in ukwest;
   Ubuntu 22.04 kernel for Site Recovery; B-series vCPUs with the gateway (lab 22 1, lab 26 1 + 1 in ukwest on test failover);
   providers `Microsoft.ManagedIdentity`, `Microsoft.ContainerInstance`, `Microsoft.OperationalInsights` and those already
   listed. Integration step 5 checks each before any spend.
5. **Prices that drift or match the wrong product.** C0: `a secondary-region item is priced at the session's secondary region`;
   `labs-verify checks a secondary-region meter in ukwest`. Areas: `${id}: costs what its marker says`; lab 23's serverless and
   lab 27's Front Door fee stay authored (shared meter; no uksouth row) and the readmes say how they are billed.
6. **Timeouts.** Lab 26's job timeout is 110 (25 + 20); an enable-replication job slower than 25 minutes fails the ready check.
   The release test measures it; if over, raise `deploy_min` (marker £££ at 30) with a version bump before the dashboard pass.

---

## C0: Engine gaps (integrator, first)

**Branch:** `feat/labs-b3-engine`. **Owns:** every frozen file; `labs/setup/allowed-roles.json`; `worker/test/labs-read.test.ts`;
`.github/workflows/lab.yml`; `infra/ci/**`; this plan's names section. **Why it exists:** without it labs 23, 26 and 27 fail
the suite (two groups), labs 20–22 fail its identity clause, lab 20's roles would change the ABAC condition, the plan
fixtures cannot be checked against reality, and Key Vault, SQL failover groups and Site Recovery can each leave a lab dirty.

- [x] **C0.1 Types and fixtures.** `lab-plans.test.mjs` adds `computed.json has every type batch 3 labs use` (types:
  `azurerm_key_vault`, `_key_vault_secret`, `_user_assigned_identity`, `_log_analytics_workspace`, `_policy_set_definition`,
  `_management_group_policy_set_definition`, `_resource_group_policy_assignment`, `_mssql_server`, `_mssql_database`,
  `_mssql_failover_group`, `_private_endpoint`, `_private_dns_zone`, `_private_dns_zone_virtual_network_link`,
  `_cosmosdb_account`, `_cosmosdb_sql_database`, `_cosmosdb_sql_container`, `_storage_container_immutability_policy`,
  `_storage_management_policy`, `_recovery_services_vault`, `_site_recovery_fabric`, `_site_recovery_protection_container`,
  `_site_recovery_replication_policy`, `_site_recovery_protection_container_mapping`, `_site_recovery_network_mapping`,
  `_site_recovery_replicated_vm`, `_container_group`, `_traffic_manager_profile`, `_traffic_manager_external_endpoint`,
  `_cdn_frontdoor_profile`, `_cdn_frontdoor_endpoint`, `_cdn_frontdoor_origin_group`, `_cdn_frontdoor_origin`,
  `_cdn_frontdoor_route`, `time_sleep`, `random_password`); `schema-facts.json says which types take a resource group and
  tags`; `ctx gives a secondary group and region`. `labs-content-suite.test.mjs` adds `the suite accepts a lab with a
  secondary group and refuses a resource in rg-lab-<id>secondary` and `identity "match" compares lab.yaml roles with the role
  assignments` (on small fixture labs under `scripts/test/fixtures/labs/suite/`). FAIL; regenerate both JSON files
  (`extract-computed.mjs` recipe with `time` added, in the scratchpad); implement; PASS; commit.
  **Done when** `node --test scripts/test/lab-plans.test.mjs scripts/test/labs-content-suite.test.mjs` passes and every
  batch 1–2 content test still passes (`npm test`).
- [x] **C0.2 Real-plan shapes and the offline mock plan.** `lab-plans.test.mjs`: `planShape keeps addresses, references,
  unknown and sensitive paths and no values` (a fixture plan holding a password: the shape has no value of it);
  `the shape test skips a lab with no recorded shape and fails a fixture whose references differ`. `lab-workflow.test.mjs`:
  `plan and scope check prints the plan's shape, never its values`. `lab-release.test.mjs`: `the release test saves the
  LAB_PLAN_SHAPE line as the lab's shape file`. `lab-tf.test.mjs`: `labs-tf plans each lab offline with mocked providers
  and names a lab whose plan fails` (fake terraform). FAIL; implement `infra/ci/lab-plan-shape.mjs` (plain Node, as
  `lab-scope.mjs`), `shape.mjs`, the step 6 line, the release-test reader and `labs-tf`'s mock plan; PASS. Run `npm run
  labs-tf` on all 19 labs: a lab 1–19 mock-plan failure is reported (and fixed here only if it is the mock file's fault).
  (V) `mock_provider` covers `azurerm_client_config` and `azurerm_subscription` data sources; the `s3` backend block is
  ignored by `terraform test`. Commit. **Done when** the four tests pass and `npm run labs-tf` exits 0.
  **(V) answers (Terraform 1.14.6, 2026-10-05):** `mock_provider` mocks data sources too, but with random strings, and
  azurerm's own validation still runs on known values (lab 1's role definition `scope` was refused), so the mock file gives
  `mock_data` defaults for `azurerm_subscription` and `azurerm_client_config`; the `s3` backend block is ignored; mocking a
  provider the lab does not install fails ("unknown provider"), so only installed ones are mocked; undeclared contract
  variables in the file's `variables` block are ignored. Labs 1–19 and the template all pass the mock plan; the only
  failures found were the mock file's own (an unparseable fake SSH key, now a real throw-away public key).
- [x] **C0.3 Scope.** `lab-scope.test.mjs` adds the Review Focus 2 tests (C0 names) plus `a DINE definition with Monitoring
  Contributor only passes for a governance lab`. FAIL; implement (C0 names: scope); PASS; commit. **Done when** `node --test
  scripts/test/lab-scope.test.mjs` passes and `npm run labs-check` still passes on labs 1–19.
- [x] **C0.4 Lab 20's custom roles** (changed 2026-10-05: Steven chose Terraform-assigned roles, identity change 2, over
  define-only ones; no `"assign": false` mechanism). `lab-roles.test.mjs`: `allowed-roles.json: the custom roles are lab 1's
  vm-operator and lab 20's netops and appops, each with its fixed GUID, one per line`; `lab-setup.test.mjs`:
  `governance-condition.txt allows lab 20's two custom roles, to write and to delete an assignment`; `lab-scope.test.mjs`:
  `lab 20 may assign its own custom roles inside its group, and no other lab may`; `labs-lib.test.mjs`: `lab 20 may list its
  own custom roles under identity.roles; another lab may not`. FAIL; add lab 20's two entries to `allowed-roles.json`
  `custom`; regenerate `governance-condition.txt` (`node scripts/labs-setup.mjs --condition`); PASS; commit. **Done when** the
  tests pass and the condition's only change against `origin/main` is the two GUIDs in each list.
- [x] **C0.5 Teardown.** `lab-cleanup.test.mjs` (fake `az`): the Review Focus 1 C0 tests, plus `unblock removes locks, legal
  holds, unlocked immutability, backup protection, replication and SQL links in that order` (replaces the batch 2 ordering
  test, keeping its assertions). (V) `az sql db replica delete-link` arguments in the runner's az; the Site Recovery REST paths
  and api-version; whether vault deletion needs the mapping and policy removals (harmless if not). FAIL; implement; PASS;
  commit. **Done when** `node --test scripts/test/lab-cleanup.test.mjs` passes and `bash -n infra/ci/*.sh` is clean.
  **(V) answers:** az 2.86.0's `az sql db replica delete-link` takes the local database (`--resource-group --server --name`),
  `--partner-server` (required), `--partner-resource-group` (defaults to the local group, so unblock passes the partner's lab
  group) and `--yes`. Site Recovery REST (Learn, api-version 2023-08-01): POST `.../replicationProtectedItems/{item}/
  testFailoverCleanup` with `{"properties":{"comments":"..."}}` (an item being cleaned up shows `MarkedForDeletion`); POST
  `.../replicationProtectionContainerMappings/{m}/remove` with `{"properties":{"providerSpecificInput":{}}}`. Learn's
  "Delete an Azure Site Recovery vault" (2026-02-11): an Azure-to-Azure vault needs only its protected items removed, so
  removing mappings and policies is harmless tidy-up, kept so nothing is left half-made.
- [x] **C0.6 Prices per region.** `worker/test/labs-read.test.ts`: `a secondary-region item is priced at the session's
  secondary region`; `an item without region keeps the session's region`. `labs-verify.test.mjs`: `labs-verify checks a
  secondary-region meter in ukwest`. `labs-lib.test.mjs`: `region: secondary needs regions.secondary`. FAIL; implement in
  `shared/labs.ts`, `scripts/lib/labs.mjs`, `worker/src/labs/prices.ts`, `scripts/labs-verify.mjs`; PASS; commit.
  **Done when** `npm test` and `npm run typecheck` pass.
- [x] **C0.7 Ready check.** `lab-cleanup.test.mjs` (or `lab-ready` tests where they live): `ready check accepts an empty state
  only for types listed as never giving one` (list empty; a fake listed type passes, an unlisted one stays pending). FAIL;
  implement; PASS; commit. **Done when** the test passes.
- [x] **C0.8 Contract check.** (Done 2026-10-05: gate green locally, CI green on draft PR #82.) This plan's names section rewritten "as built"; spec §17 rulings 23–37 corrected to what was
  built. Gate plus `labs-tf`; CI green on a draft PR. Push; send the areas the commit and the names section. **Done when** CI's
  `labs` job is green on the draft PR and the areas have the commit id.

## C1: Governance and identity, labs 20–22

**Branch:** `feat/labs-b3-identity`. **Owns:** `labs/az305-2{0,1,2}-*/**`, `scripts/test/fixtures/labs/plans/labs/az305-{20,21,22}-*.mjs`,
`scripts/test/labs-az305-identity.test.mjs`. **Consumes:** the C0 names; labs 1 and 3 (custom role, management groups,
MG-scope policy), lab 18 (workspace) and lab 8 (VM) as models.

Each step: write `labContentSuite(id, { marker: "£", identity: "match" })` and the lab's own tests in the area file, plus the
plan fixture; run them (FAIL: no folder); write `lab.yaml`, `readme.md`, `terraform/`; run `node --test
scripts/test/labs-az305-identity.test.mjs scripts/test/lab-plans.test.mjs`, `npm run labs-tf -- <id>`, `npm run labs-verify --
--links --meters <id>`, `npm run labs-check` (PASS); commit.

- [ ] **C1.1 Lab 20:** `az305-20-landing-zone: six lab management groups three deep under the tenant root, none holding a
  subscription`; `az305-20-landing-zone: an initiative at lab-<id>-root with grouped built-in and custom definitions`;
  `az305-20-landing-zone: the initiative is assigned at landingzones and a deny of public IPs at sandbox, names at most 24
  characters`; `az305-20-landing-zone: two custom roles with their fixed GUIDs, assignable only at rg-lab-<id>, each assigned
  there to its own managed identity` (identity change 2). **Done when** the step's commands pass.
- [ ] **C1.2 Lab 21:** `az305-21-monitoring-scale: a PerGB2018 workspace capped at 0.05 GB a day, deleted permanently on
  destroy`; `az305-21-monitoring-scale: a DINE definition whose only role is Monitoring Contributor`; `az305-21-monitoring-scale:
  its assignment at rg-lab-<id> has a system identity holding exactly that role at rg-lab-<id>`; `az305-21-monitoring-scale: the
  vault is created after the assignment and its role, with no purge protection`; `az305-21-monitoring-scale: the readme says
  diagnostics arrive about 15 minutes after deploy`. **Done when** the step's commands pass.
- [ ] **C1.3 Lab 22:** `az305-22-keyvault-mi: an RBAC Key Vault with 7-day retention and no purge protection`;
  `az305-22-keyvault-mi: the VM has a system identity and the user-assigned identity`; `az305-22-keyvault-mi: Secrets User for
  the VM at the vault and for the user-assigned identity at one secret only`; `az305-22-keyvault-mi: the secrets wait for the
  pipeline's Officer assignment`; `az305-22-keyvault-mi: versions.tf purges the vault on destroy and never recovers one`;
  `az305-22-keyvault-mi: the subnet sets default outbound access on`. **Done when** the step's commands pass.
- **Done when (area):** the gate passes for labs 20–22 and the report lists every (V) answer.

## C2: Data, labs 23–25

**Branch:** `feat/labs-b3-data`. **Owns:** `labs/az305-2{3,4,5}-*/**`, their `plans/labs/*.mjs`,
`scripts/test/labs-az305-data.test.mjs`. Same step shape as C1 (`identity: "none"`; lab 23 `secondary: true`, marker ££;
24 and 25 marker £).

- [ ] **C2.1 Lab 23:** `az305-23-sql-failover: a Basic primary in rg-lab-<id> and a Basic geo-secondary on the ukwest server
  in rg-lab-<id>-secondary`; `az305-23-sql-failover: the failover group is Manual, holds the primary and depends on the explicit
  geo-secondary`; `az305-23-sql-failover: the serverless database is GP_S_Gen5_1 with auto-pause, on the ukwest server, outside
  the group`; `az305-23-sql-failover: no vCore database in the primary region`; `az305-23-sql-failover: both servers have a
  private endpoint in the uksouth VNet and dns_link is true, and Terraform never links the zone to the gateway`;
  `az305-23-sql-failover: variables.tf refuses a secondary region equal to the region`. (V) `auto_pause_delay_in_minutes`
  minimum (the mock plan and validate answer it). **Done when** the step's commands pass.
- [ ] **C2.2 Lab 24:** `az305-24-cosmos: a serverless SQL API account in one region with the free tier off`;
  `az305-24-cosmos: three containers with single, hierarchical and deliberately poor partition keys, and no throughput`;
  `az305-24-cosmos: Session consistency by default`. **Done when** the step's commands pass.
- [ ] **C2.3 Lab 25:** `az305-25-storage-design: an HNS account with raw and curated file systems and a lifecycle to Cool, Cold
  and Archive`; `az305-25-storage-design: an RA-GRS account whose evidence container has an unlocked 1-day policy`;
  `az305-25-storage-design: no SFTP, no public blob access, nothing written through the data plane`; `az305-25-storage-design:
  the readme says never to lock the policy`. **Done when** the step's commands pass.
- **Done when (area):** the gate passes for labs 23–25 and the report lists every (V) answer.

## C3: Continuity and multi-region, labs 26–27

**Branch:** `feat/labs-b3-continuity`. **Owns:** `labs/az305-2{6,7}-*/**`, their `plans/labs/*.mjs`,
`scripts/test/labs-az305-continuity.test.mjs`. Same step shape (`secondary: true`, marker ££ for both).

- [ ] **C3.1 Lab 26:** `az305-26-site-recovery: one Ubuntu 22.04 Standard_B1s source VM with no public IP and default outbound
  on`; `az305-26-site-recovery: the vault and the target and test VNets are in rg-lab-<id>-secondary, the VNets from /20s 1 and
  2`; `az305-26-site-recovery: the replicated VM's target group, disks' target group and networks are the lab's own`;
  `az305-26-site-recovery: the container mapping does not auto-update the agent (no automation account)`;
  `az305-26-site-recovery: vm_sizes lists two Standard_B1s and the replica disk is priced in the secondary region`;
  `az305-26-site-recovery: the readme says never to re-protect into another group`. **Done when** the step's commands pass.
- [ ] **C3.2 Lab 27:** `az305-27-multi-region: one container group per region, public with a DNS label, serving the region's
  name`; `az305-27-multi-region: Traffic Manager priority routing over the two external endpoints`; `az305-27-multi-region:
  Front Door Standard with one origin group of both origins and one route, no WAF`; `az305-27-multi-region: no App Service and
  no azurerm_public_ip`; `az305-27-multi-region: connect lists the Traffic Manager and Front Door URLs`. **Done when** the step's
  commands pass.
- **Done when (area):** the gate passes for labs 26–27 and the report lists every (V) answer.

---

## Integration

1. **Merge** onto `feat/labs-b3` in the order C1, C2, C3, running the gate after each. A conflict means an area edited a
   frozen file: reject that change, or fold it into C0. **Done when** the gate passes after the third merge.
2. **Full gate:** `labs-check -- --base origin/main`, `labs-tf` (all 27 labs, mock plans included), `labs-verify -- --links
   --meters`, `bundle-size` unchanged. CI's `labs` job green on a draft PR. **Done when** all exit 0 and CI is green.
3. **Whole-branch review.** A fresh opus reviewer gets this plan, the spec and the diff. Ask about: the Review Focus list; the
   lab 20's Terraform-assigned custom roles and the regenerated condition; the DINE rule; the new unblock and safety-net steps; every fixture against its
   `main.tf`; prices and markers. **Done when** the review's findings are listed in the PR.
4. **One fix pass,** test-first, then repeat step 2. **Done when** step 2 passes again.
5. **Pre-flight on real Azure (read-only, no cost)**, `az` signed in as the pipeline principal: `node
   scripts/lab-release-test.mjs --check`; `az vm list-usage -l uksouth -o table` and `-l ukwest` (B-series and total, with the
   gateway's VM); `az sql list-usages -l uksouth` and `-l ukwest` (vCore 0 and 320 still); `az sql db list-editions -l uksouth
   --edition Basic --available -o table` and `-l ukwest --edition GeneralPurpose --service-objective GP_S_Gen5_1 --available`;
   `az cosmosdb locations show --location uksouth` (`isSubscriptionRegionAccessAllowedForRegular`); `az rest --url
   /subscriptions/{subscriptionId}/providers/Microsoft.ContainerInstance/locations/ukwest/usages?api-version=2023-05-01`;
   `az vm image list --publisher Canonical --offer 0001-com-ubuntu-server-jammy --sku 22_04-lts-gen2 -l uksouth --all --query
   "[-1].version"`; `az provider show -n <ns> --query registrationState` for `Microsoft.ManagedIdentity`,
   `Microsoft.ContainerInstance`, `Microsoft.OperationalInsights`, `Microsoft.Management` and the listed ones (an unregistered
   one is Steven's to register); `az keyvault list-deleted` (no lab leftovers). **Done when** each answer is in the PR and none
   blocks; a blocker is a STOP with the finding.
6. **Identity change 2 (approved by Steven 2026-10-05):** with Steven's `az login` (subscription Owner), re-apply
   `labs/setup/governance-condition.txt` (as regenerated on `feat/labs-b3-engine`) on the `wg-admin labs governance` role
   assignment (README "Labs: one-time setup", step 2, or its `az role assignment create ... --condition` form), then read it
   back and check both lab 20 GUIDs are in both lists. Must be done **before lab 20's release test**. **Done when** the
   condition in Azure equals the file.
7. **STOP (spend): ask Steven to approve the release-test spend.** One pass, in sequence on slot 31:

   | Lab | £/h | Likely (deploy + destroy) | Worst case (a full hour, plus daily or monthly minimums) |
   |---|---|---|---|
   | 20 | 0.000 | £0.00 | £0.00 |
   | 21 | 0.001 | £0.00 | £0.01 |
   | 22 | 0.011 | £0.00 | £0.02 |
   | 23 | 0.151 | £0.07 (three databases billed by the hour, serverless online throughout) | £0.52 (serverless at its 1-vCore maximum for an hour) |
   | 24 | 0.003 | £0.00 | £0.01 |
   | 25 | 0.000 | £0.00 | £0.01 |
   | 26 | 0.063 | £0.05 (ASR instance usually free for 31 days) | £0.75 (a protected instance billed for a day, plus transfer) |
   | 27 | 0.078 | £0.03 | £0.95 (Front Door's base fee billed for a day, plus an hour of both containers) |
   | **Total** | | **about £0.15** | **about £2.30; ask for up to £4.50 to allow one retry each** |

   After the deploy (step 10) a second pass of the same size, plus soaks: lab 21 (about 45 minutes, £0.01), lab 23 failover
   (about an hour, £0.15–0.52), lab 25 (pennies), lab 26 test failover (about 90 minutes, £0.10, worst a day of ASR £0.63), lab 27
   failover drill (about an hour, £0.08, worst £0.95). Ask for up to £4 more for that. **Done when** Steven approves an amount.
8. **Release tests** on Steven's go: `node scripts/lab-release-test.mjs az305-25-storage-design az305-20-landing-zone
   az305-21-monitoring-scale az305-22-keyvault-mi az305-24-cosmos az305-27-multi-region az305-23-sql-failover
   az305-26-site-recovery --ref feat/labs-b3 --confirm-cost`. Every lab must report `clean: true`. On a failure: fix test-first in
   the owning area's files, bump that lab's `version`, rerun that lab. Replace each lab's `deploy_min` and `destroy_min` with the
   measured figures rounded up (a version bump, then one more test of that lab); lab 26 becomes £££ if its deploy is 30 or more.
   Copy each recorded `shapes/<id>.json` in and make the shape tests pass (fixture fixes are a version-free change: fixtures
   are not in the lab folder). Commit `docs/labs/release-tests.md` and the shapes. **Done when** every lab has a passing,
   clean row at its final version and `npm test` passes with the shapes.
9. **Open the batch PR** (`feat/labs-b3` → `main`). **STOP (merge and deploy): ask Steven** before merging and before
   deploying. **Done when** Steven answers.
10. **On his go:** merge; `npm run deploy-worker` (bundles the catalogue; no migration); Settings → Labs → **Test** each of labs
    20–27, one at a time, to record `lab_release_tests` and mark them released; then the soaks from the dashboard:
    **lab 21** (deploy, wait 30 minutes, see the vault's diagnostic setting made by policy, tear down; a permissions refusal is
    identity change 1, a STOP); **lab 23** (peered: connect through the listener, fail over, tear down while failed over);
    **lab 25** (upload to `evidence`, add a legal hold, tear down); **lab 26** (test failover and cleanup, then an unplanned
    failover committed, tear down); **lab 27** (stop `ci-uks`, watch both front ends move, tear down). Each session must end
    clean. **Done when** every soak ends clean and the outcome is written below.

## Final review checklist

- **Labs 20–27:** each matches the table, passed a real-Azure test with `clean: true`, has measured timings and a recorded plan
  shape that its fixture matches.
- **Scope:** nothing outside `rg-lab-<id>` and `rg-lab-<id>-secondary` but Azure's `NetworkWatcherRG`; lab 20's MGs and
  definitions named `lab-<id>-*` and assigned only at its own MGs; role assignments exactly as each `lab.yaml` lists;
  `governance-condition.txt` re-applied in Azure after identity change 2 (lab 20's two custom roles), and any other
  identity change approved and re-applied the same way.
- **Teardown:** the SQL, Site Recovery, Key Vault and storage paths each proven once by a release test and once by a soak; no
  soft-deleted lab vault left (`az keyvault list-deleted`).
- **Prices:** every `retail` entry passes `labs-verify --meters` in its region; every marker matches `costMarker`.
- **No change** to the gateway, `wg.yml`, D1, Worker routes or the app; the only Worker change is secondary-region prices;
  `.env` was never read.

## Release outcome

To be written by the integrator after step 10 (labs released, any parked, measured times, soak results, answers to every (V)).
