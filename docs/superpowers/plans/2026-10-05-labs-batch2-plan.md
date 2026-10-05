# Labs batch 2 (labs 8–19, the rest of AZ-104): implementation plan

## B0 names as built

The contract on `feat/labs-b2-engine` (B0 as built, 2026-10-05). Content areas branch from its head and use these names
exactly; a change goes through the integrator, who updates this section. Paths are from the repo root. Batch 1's L0 names
(`docs/superpowers/plans/2026-10-04-labs-batch1-plan.md`) all still hold.

**Content test suite, `scripts/test/fixtures/labs/content.mjs`** (one copy of what `labs-storage.test.mjs` and
`labs-content-identity.test.mjs` each wrote out; batch 1's tests stay as they are; proved on lab 7 by
`scripts/test/labs-content-suite.test.mjs`)
- Helpers: `lab(id)` → `{ dir, tfDir, files (.tf only, LF), yaml, readme (LF), blocks }`, `resources(l, type?)`,
  `attr(body, name)`, `outputs(l)`, `uncomment(src)`, `TERRAFORM` (bool), `estimateGbpH(items)`, `costMarker(gbpH, deployMin)`
  (both from `estimate.mjs`, kept equal to `shared/labs.ts` by a Worker test), `CHILD_TYPES`: batch 1's seven plus
  `azurerm_network_security_rule`, `_route`, `_subnet_network_security_group_association`, `_subnet_route_table_association`,
  `_network_interface_security_group_association`, `_network_interface_application_security_group_association`,
  `_lb_backend_address_pool`, `_lb_probe`, `_lb_rule`, `_network_interface_backend_address_pool_association`,
  `_virtual_machine_extension`, `_virtual_machine_data_disk_attachment`, `_virtual_network_peering`, `_dns_a_record`,
  `_dns_cname_record`, `_private_dns_a_record`, `_private_dns_cname_record`, `_monitor_data_collection_rule_association`,
  `_backup_policy_vm`, `_backup_protected_vm`, `_linux_web_app_slot` (all `azurerm_`): they need neither the lab's
  `resource_group_name` nor `var.tags`; any `resource_group_name` or `resource_group_id` still must be the lab's.
- `labContentSuite(id, { marker })` (`marker`: `"£"` or `"££"`) registers seven tests, named exactly:
  1. `${id}: lab.yaml and readme pass the catalogue rules, and the readme is no longer a stub` (also: `## What it deploys` has a
     ` ```text ` diagram; every `## Learn more` link is `https://learn.microsoft.com/...`);
  2. `${id}: Terraform passes the text lint and declares only contract variables` (`lintDir` of the whole `terraform/`
     folder: `.tf`, `.bicep` and file rules; the four files exist; every declared variable is used);
  3. `${id}: one resource group, named by the pipeline, and everything else inside it with the tags` (`azurerm_resource_group.lab`);
  4. `${id}: lab.yaml agrees with the Terraform on peering, VM sizes, subnets and identity`: `peer_vnet_id` iff peering is not
     `"off"`; `private_ips` and `connect` always; `capacity.vm_sizes` has one entry per VM (`count` must be a number literal), a
     scale set counted at the `maximum` of the `azurerm_monitor_autoscale_setting` whose `target_resource_id` is
     `<vmss address>.id` (else its `instances`); `subnets_used` = distinct `cidrsubnet(var.address_space, 2, n)`;
     `var.address_space` used iff `subnets_used > 0`; no `azuread_*`, no role assignment, `identity` exactly
     `{ creates: [], roles: [], governance: false }`;
  5. `${id}: VMs have no public IP and use the sizes and disks lab.yaml prices`: no `public_ip_address_id` on any NIC, no
     `public_ip_address {}` in a scale set, an `azurerm_public_ip` only when an `azurerm_application_gateway` references its
     `.id`; per VM size, the `retail: { sku }` items' `qty` sum = the default count (VMs' `count`, scale sets' `instances`);
     every OS disk `"Standard_LRS"` and the `retail.meter: "S4 LRS Disk"` items' `qty` = the VMs' default count; every
     `azurerm_managed_disk` `"StandardSSD_LRS"` of at most 4 GiB and the `"E1 LRS Disk"` items' `qty` = the number of disks;
  6. `${id}: costs what its marker says` (`costMarker(estimateGbpH(cost.items), timing.deploy_min)`);
  7. `${id}: terraform fmt -check` (skips without terraform).

**Plan fixtures, `scripts/test/fixtures/labs/plans/`**
- `common.mjs`: `SUB`, `TENANT`, `UPN`, `REGION` (`uksouth`), `SLOT` (`10.64.64.0/18`), `SSH_KEY`, `ctx(id, n)` (`n` two digits:
  `{ id, rg, prefix: l<n>k3x9q, tags, variables }`), `rgResource(c)`, `RG_REFS`, `IN_RG`, `ref(address, attr)`, and
  `linuxVm(c, { name, key, subnet, size = "Standard_B1s", zone, customData, identity })` → `[nic, vm]` shaped like lab 7's
  (lab 7 now uses it; its plan is byte-identical): addresses `azurerm_network_interface.<key>` and
  `azurerm_linux_virtual_machine.<key>`, `key` defaulting to `name` without `vm-` and with `-` as `_`; `subnet` is the
  subnet's address; NIC name `nic-<name>`; `zone` a string; `customData` a string (known at plan) or an array of references
  (unknown at plan); `identity` `"SystemAssigned"`.
- `labs/<id>.mjs`, one per batch 2 lab, named by the lab id (a mismatch throws, naming the file):
  `export default () => ({ lab, variables, resources, data? })`, built with `common.mjs`. `labs.mjs` keeps labs 1–7 and
  exports `LAB_PLANS` (labs 1–7 plus `await loadLabPlans(new URL("./labs/", import.meta.url))`) and `loadLabPlans(dir)`.
  `labs/.gitkeep` holds the folder. Addresses may carry `[0]` or `["key"]`: each instance is its own planned resource and change
  (with `index`), the configuration has one entry per block, and the attribute test merges instances per block.
- `computed.json`: 68 types, regenerated from azurerm 4.81.0 and azuread 3.10.0 (batch 1's types unchanged); the list is
  `extract-computed.mjs` `TYPES` (exported), whose header has the pinned recipe. A type missing from it throws in
  `realisticPlan`: ask the integrator, never edit it in an area.
- `lab-plans.test.mjs` runs, per lab, `${id}: the plan fixture has main.tf's resources and attributes` and
  `${id}: lab-scope passes its realistic first-deploy plan`, plus `there is a realistic plan for every lab in the catalogue`.

**Scope** (`infra/ci/lab-scope.mjs`): `templateProblems(template)` (an object or JSON text) → `[{ rule, message }]`;
`scopeProblems(input, labId, { mode = "plan" })`; `checkPlan` passes `mode: "plan"`, `checkHcl` `mode: "hcl"`. No new rule names:
- `role`: in a template, `Microsoft.Authorization/*`, `Microsoft.Management/*`, `Microsoft.Graph/*`, any resource with
  `extension`/`import`, a template with `extensions`/`imports`, an old-style `…/providers/…` extension type.
- Template keys are read case-insensitively, as ARM reads them (`"Type"`, `"ResourceGroup"`); two keys that differ only in
  case are refused. `metadata` is skipped only in ARM's description slots (the template, a parameter, output or definition
  and their type schemas, a resource), never a variable, parameter or symbolic resource called `metadata`.
- **Template resource types are an allow-list** (`TEMPLATE_TYPES` in `lab-scope.mjs`, fix pass after review): only
  `Microsoft.Storage/storageAccounts`, `Microsoft.Network/virtualNetworks` (+ `/subnets`),
  `Microsoft.Network/networkSecurityGroups` (+ `/securityRules`) and `Microsoft.Resources/deployments` as Bicep emits a module
  (inline template object, `expressionEvaluationOptions.scope` `inner`, `Incremental`, no `resourceGroup`/`subscriptionId`/
  `scope`). Anything else is `outside-scope` with a message that says to add the type to `TEMPLATE_TYPES` with the reason
  it can only land inside the lab's group (AKS without `nodeResourceGroup`, Container Apps environments in a subnet,
  `Microsoft.Solutions/applications` and `Microsoft.Resources/deploymentStacks` are refused this way). Also refused: any
  `subscription()`, `tenant()`, `managementGroup()` or `extensionResourceId()`, and a literal `/subscriptions/` or
  `/resourceGroups/` anywhere in a value (or spread across an expression's literals). `resourceGroup()` is fine.
- `outside-scope`: a template schema other than `…/deploymentTemplate.json#` (or none, or not a template, or not JSON);
  `Microsoft.Resources/deploymentScripts`, `resourceGroups`, `templateSpecs`; `resourceGroup`/`subscriptionId`/`scope`/
  `managementGroup` keys; a nested deployment with `templateLink` (URL or template spec), `parametersLink` or no template;
  a literal `/subscriptions/…` or management-group id anywhere in the template (built-in definition ids aside),
  `resourceId()` whose first argument is not a literal type, `subscriptionResourceId()`/`tenantResourceId()`/
  `managementGroupResourceId()`; nested templates checked as templates. In Terraform: `azurerm_subscription_`/
  `management_group_`/`tenant_template_deployment`, `azurerm_resource_deployment_script_*`, `template_spec_version_id`, a
  `parameters_content` id outside the lab, and (plan mode only) an unknown `template_content`.
- `gateway`: the gateway's names anywhere in a template.
- `azure-made-group`: a Container Apps environment with `infrastructure_subnet_id` whose `infrastructure_resource_group_name`
  is not `rg-lab-<id>-*`.

**Lint** (`infra/ci/lab-lint.mjs`): `lintDir(dir)` now = `fileProblems(names)` + `lintTfText(.tf)` + `lintBicepText(.bicep)`
(lab.yml step 5, `labs-check`, the content suite). `lintBicepText(files)` → `[{ file, line, rule, message }]` with
`literal-cidr`, `gateway`, `module` (`module x 'br:…'`, `'br/…'`, `'ts:…'`, `'ts/…'`; local modules are fine) and `provider`
(`extension`, `import` or `provider` statements); `stripBicepComments(src)`. `fileProblems` adds `file` for an `x.json` beside
`x.bicep` (any case). Built JSON is git-ignored (`labs/*/terraform/*.json`).

**Bicep** (`scripts/lib/bicep.mjs`): `BICEP_VERSION` `0.47.16`; `BICEP_SHA256` per release asset (`bicep-linux-x64`
`64c345a5…aa5a`, `-linux-arm64`, `-osx-arm64`, `-osx-x64`, `-win-x64.exe`; GitHub's digests, checked against downloads);
`bicepAsset(platform?, arch?)`, `bicepUrl(asset)`, `bicepMatchesPin(path, asset, sha256?)`,
`pinnedBicep({ cacheDir, asset?, sha256?, fetch?, log? })` → verified path or `null` (never throws; a mismatch is deleted before
it is ever made runnable). `.bicep` files live in `labs/<id>/terraform/`; every one is built to `<name>.json` beside it (modules
too); Terraform reads `template_content = file("${path.module}/main.json")`. `lab.yml` step 5 (env `BICEP_VERSION`,
`BICEP_SHA256` = linux-x64), only when `.bicep` files exist: `curl` from `github.com/Azure/bicep/releases/download/v…`,
`sha256sum -c`, `chmod +x`, then `env -i PATH=/usr/bin:/bin HOME TMPDIR DOTNET_CLI_TELEMETRY_OPTOUT=1
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 bicep build` (no keys in its environment), before `terraform init` (destroy too).
CI's labs job: step `install bicep` → `$RUNNER_TEMP/bin/bicep`; `labs-tf` env `LABS_TF_REQUIRE_BICEP=1`, `BICEP=<that path>`.
`npm run labs-tf` builds each `.bicep` into its throw-away copy before init/validate and fails a lab whose built template has
`templateProblems` (`template main.json: rule: message`); it runs `$BICEP` only if it matches the pin, else the pinned download
cached in `<tmp>/labs-bicep/0.47.16/`; never a `bicep` from PATH, never `az bicep`. Without one: the lab's build, init and
validate are skipped with a note (fmt and the HCL scope check still run); `LABS_TF_REQUIRE_BICEP=1` makes it a failure. A
content test that needs the built template (lab 12) gets the binary with `pinnedBicep({ cacheDir: join(tmpdir(),
"labs-bicep", BICEP_VERSION), fetch: async () => { throw new Error("no download in npm test"); }, log: () => {} })` and skips on
`null`, or reads the template `labs-tf` built. The fixture `scripts/test/fixtures/labs/bicep/storage-vnet.json` (from
`storage-vnet.bicep` + `vnet.bicep`: languageVersion 2.0 and a module) is byte-identical from the Windows and Linux binaries.

**Prices and labs-verify:** the price feed exports `LAB_UNITS` `["1 Hour", "1/Hour", "1/Day", "1/Month"]` and
`NOT_LINUX_PAYG`; `labs/prices.ts` reads `1/Hour` as £ per hour. `npm run labs-verify -- [--links] [--meters] [id…]`
(`scripts/labs-verify.mjs`; neither flag = both; no ids = every lab; exit 1 on problems, 2 on bad arguments; network, no
credentials, never in `npm test`): `readmeLinks(md)` (markdown `https` links, each once), `meterProblems(rows, { meter, unit })`
and `skuProblems(rows, sku)` → strings, `verifyLabs(labs, { links, meters, fetch })` → `{ problems, lines }`, `LAB_UNITS`,
`NOT_LINUX_PAYG` (equal to the feed's: a Worker test). Links: HEAD then GET, redirects followed, final 200 required. Meters:
one uksouth GBP pay-as-you-go row set (not Windows/Spot/Low Priority, primary region), in a feed unit, equal to lab.yaml's
`unit`, at one price; VM sizes: one Linux hourly price. Each price is printed beside the authored £/h; more than 25% apart is
a problem.

**Unblock** (`infra/ci/lab-unblock.sh` step 4, per vault): `az backup vault show … --query
properties.securitySettings.immutabilitySettings.state`; `Unlocked` → `az backup vault update --immutability-state Disabled`;
`Locked` → `::warning::… immutability is LOCKED …`, never an update; then soft delete off, soft-deleted items undeleted; one
`az backup item list` (no type filter: every type) of `[id, backupManagementType, workloadType]`, and
`az backup protection disable --ids <id> --delete-backup-data true --yes --backup-management-type <t> --workload-type <w>` for
`AzureIaasVM`/`AzureStorage`/`AzureWorkload` (a `MAB` item is a warning); then it polls `az backup item list --query [].id`
every 15 s until empty, at most `LAB_UNBLOCK_VAULT_WAIT_SECONDS` (default 300), else a warning. Never fails the run.

**B0 rulings** (copied into the spec as §17 with rulings 1–12 below): 13. no unpinned Bicep anywhere: `labs-tf` drops the
planned `az bicep build` fallback (it downloads an unverified newest Bicep); 14. a template may not name any literal
subscription-level id, nor use `resourceId()` with a group or subscription argument, even the lab's own (Bicep never needs to);
15. Terraform deployment scripts and template deployments at other scopes are refused outright (`outside-scope`); 16. the Bicep
lint also refuses registry/template-spec modules (`module`) and extension/import/provider statements (`provider`);
17. `labs-pr0.test.mjs`'s comparison with PR 0 is skipped from batch 2 on (ruling 11); 18. the content suite's price checks
(S4 per VM, E1 per data disk, `retail.sku` qty = default count) and "a public IP only for an App Gateway" bind every lab;
19. `labs-verify` treats an authored price more than 25% from Azure's as a problem; lab 6's `Standard Private Endpoint` meter
has no uksouth row (Azure prices it under region `Global` only); the integration authors it (no `retail`, lab 6 v2); 20. the vault wait is
bounded by tries (`ceil(wait / 15)` polls), so a fake or slow `sleep` can never stretch it.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands **B0** first. Then three content areas run **in parallel**, each in its own
> git worktree with one implementer under superpowers:test-driven-development: **B1** compute (labs 8–12), **B2** networking
> (13–17), **B3** monitor and backup (18–19). Steps use checkbox (`- [ ]`) syntax.

**Goal:** labs 8–19 deployable from the Labs tab, each priced honestly, scope-checked before apply, and passing a real-Azure
release test with `clean: true`, so the whole AZ-104 outline is covered.

**Architecture:** content only, on the batch 1 engine: a folder per lab (`lab.yaml`, `readme.md`, `terraform/`), a realistic
plan fixture per lab, and a content test file per area. B0 closes the engine gaps these labs expose (Bicep, templates,
vaults, fixtures, prices). No Worker route, D1, or app change; the Worker deploy only bundles the new catalogue.

**Tech stack:** unchanged. Terraform 1.14.6, azurerm `~> 4.0` (4.81.0 in the lock), node:test for scripts, Vitest for the
Worker; Bicep CLI pinned (V: the current release and its sha256 from github.com/Azure/bicep/releases).

**Spec:** `docs/superpowers/specs/2026-10-04-labs-design.md` is binding, with Steven's decisions A and B (§14) and §16. **(V)**
items are checked live or on the official page during the build; each area's report records the answers.

**Rulings on points the spec leaves open** (B0 copies them into the spec as §17):
1. **Bicep is the §3.4 hybrid, pinned.** `az bicep build` downloads whatever Bicep is newest; B0 replaces it with a
   checksum-pinned `bicep build`. `lab-scope` reads the built template from the plan (`template_content` is known at plan) and
   refuses Graph extension resources, deployment scripts, linked templates (`templateLink`), template specs, extension imports,
   non-resource-group schemas and any template it cannot read. `labs-tf` checks the built JSON with `templateProblems`.
2. **A `retail.meter` must be unique in uksouth.** The feed matches on meter name alone, and four names batch 2 wants are
   shared: `P0v3 App` (Linux £0.0653, Windows £0.1257), `Standard Fixed Cost` and `Standard Capacity Units` (App Gateway v2, WAF
   v2, AGC), `Standard vCPU Duration` (ACI, Logic Apps). Those items, the load balancer (no regional row), DNS zones (tiered,
   region "Zone 1"), ACI memory (`1 GB Hour`) and Log Analytics stay authored. `labs-verify --meters` proves the rest.
3. **`capacity.vm_sizes` lists one entry per VM at its maximum** (the capacity warning counts each entry as one VM); cost
   `qty` is the default count. Lab 9 lists three `Standard_B1s` and prices two.
4. **Markers come from `costMarker`,** not §12.2's planning column: lab 10 is ££ (P0v3 Linux, the cheapest plan with slots and
   autoscale: B1 has neither, S1 Linux is £0.0755/h); lab 16 is ££ on App Gateway **Basic** (in azurerm 4.81; Standard_v2 only
   if Basic is refused in uksouth, then about £0.24/h); lab 19 is £ by estimate (§12.2 said ££).
5. **No public IP on any VM.** VMs serve with `python3 -m http.server` from a cloud-init systemd unit: no packages, so no
   dependency on outbound access (kept on, as lab 7). Public by nature and accepted: lab 10's app and slot, lab 11's
   Container App ingress, lab 15's public zone. Lab 16's App Gateway must own a public IP; its only listener is private.
6. **Lab 9 uses a Uniform scale set** (`azurerm_linux_virtual_machine_scale_set`); Flexible is a Things-to-try item.
7. **Lab 11's Container Apps environment is consumption-only with no infrastructure subnet,** so Azure makes no `MC_`/`ME_`
   group outside `rg-lab-<id>`; the scope check refuses an environment with a subnet unless its infrastructure group is
   `rg-lab-<id>-*`. ACI runs in a delegated subnet. The registry is empty: `AcrPull` is not on the allow-list, so images come
   from MCR.
8. **Lab 17 makes no Network Watcher resource.** Azure's own lives in `NetworkWatcherRG` (outside the lab; ignored by the sweep);
   the VMs get the `NetworkWatcherAgentLinux` extension only.
9. **Lab 18 never writes subscription diagnostic settings** (outside scope); the workspace is capped and permanently deleted on
   destroy. **Lab 19's vault** is Standard, LRS, `soft_delete_enabled = false` (deprecated in 4.81 but honoured, V),
   `immutability = "Disabled"`; instant restore goes to `rg-lab-<id>-irp`.
10. **Lab 15's private zone is `lab15.internal`**: the gateway's dnsmasq already forwards `internal` to Azure DNS (§6), so
    tunnel clients resolve it once `dns_link` links it to `vnet-wg`.
11. **`labs-pr0-check` is not needed:** `lab.yml` is on `main`, and `--ref feat/labs-b2` runs that branch's `lab.yml` and
    `infra/ci/`. B0's workflow changes reach `main` in the batch PR itself.
12. **No UI change.** If an area finds one is needed, it stops and asks the integrator.

## Global Constraints

- **Inherited** from batch 1 (its Global Constraints apply unchanged): commit trailer `Claude-Session:
  https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV` and push after every commit; never read `.env` (worktrees `cp
  .env.example .env`); Windows skips with a reason for missing bash, terraform, hcl2json or bicep; fixtures use TEST-NET,
  `contoso.onmicrosoft.com` and fake GUIDs; the gateway is never touched; £0 always.
- **Branches:** B0 `feat/labs-b2-engine` from `main`; B1 `feat/labs-b2-compute`, B2 `feat/labs-b2-network`, B3
  `feat/labs-b2-ops` from B0's head; integration `feat/labs-b2` from B0's head, which becomes the batch PR.
- **STOP: ask Steven** before any real-Azure run, any merge to `main`, and any deploy.
- **Frozen files** (B0 or the integrator only): batch 1's list, plus `infra/ci/**`, `.github/workflows/**`,
  `scripts/test/fixtures/labs/{content.mjs,plans/common.mjs,plans/labs.mjs,plans/realistic.mjs,plans/computed.json,
  plans/extract-computed.mjs}`, `scripts/labs-*.mjs`, `labs/setup/**`, `labs/skill-areas.yaml`, `labs/_template/**`.
- **Every resource inside `rg-lab-<id>`.** Named exceptions only: Azure-made `rg-lab-<id>-irp1` (lab 19, via
  `instant_restore_resource_group` prefix `rg-lab-<id>-irp`; V: Azure appends `1`), and Azure's own `NetworkWatcherRG`. No Entra objects, no role assignments
  (`identity: { creates: [], roles: [], governance: false }` for all twelve).
- **Cheapest SKUs:** `Standard_B1s` VMs, Ubuntu 24.04 (`ubuntu-24_04-lts`/`server`), `Standard_LRS` OS disks (S4), StandardSSD
  E1 data disks, App Gateway Standard_v2 autoscaling 0–2 (Steven's choice over Basic, after review), P0v3 Linux, ACR Basic, ACI 0.5 vCPU / 0.5 GB, internal Standard LB, RSV LRS.
- **Addresses:** every one from `cidrsubnet(var.address_space, 2, n)` (a /20) and smaller cuts of it, in `.tf` and `.bicep`.
- **`lab.yaml`:** as batch 1 (YAML 1.1, `"off"` quoted, whole minutes); a header comment naming the AZ-104 study-guide skills
  (V: the current outline) and where each price came from, with the `labs-verify --meters` answer.
- **Readmes, identical in shape to labs 1–7:** an introduction (no `#` title) that says which part of the "AZ-104 outline" it
  covers; `## What it deploys` (bullets, then a ` ```text ` diagram); `## Things to try` (3–6 bullets); `## Learn more`
  (learn.microsoft.com only, each answering 200 via `labs-verify --links`); the `readmeFooter(id)` footer verbatim; lab 17 adds
  `## Symptom` and a closed `<details><summary>What was broken</summary>`. How to reach VMs: peering, serial console, Run command.
- **Skill areas** from `labs/skill-areas.yaml` only. **Gate (every area):** `npm test`, `npm run typecheck`, `npm run
  build:web`, `npm run labs-check`, `npm run labs-tf -- <own ids>`, `npm run labs-verify -- --links --meters <own ids>`.

## The twelve labs

Planning figures; release tests replace the times. £/h is the authored estimate (uksouth, Retail Prices API, 2026-10-05).

| # | Id | Builds | £/h | Peer | /20s | Deploy/destroy | Sess/max | Prereq | vm_sizes |
|---|---|---|---|---|---|---|---|---|---|
| 8 | az104-08-vms | 2 VMs in zones 1 and 2, E1 data disk, Custom Script extension | 0.022 £ | opt | 1 | 6/5 | 2/6 | — | B1s ×2 |
| 9 | az104-09-vmss | Uniform scale set (2, autoscale 1–3 on CPU) | 0.021 £ | opt | 1 | 6/5 | 2/6 | 8 | B1s ×3 |
| 10 | az104-10-app-service | P0v3 Linux plan, web app, staging slot, autoscale 1–2 | 0.065 ££ | off | 0 | 4/3 | 2/6 | — | — |
| 11 | az104-11-containers | ACI in a delegated subnet, Container Apps env + app (scale to 0), ACR Basic | 0.025 £ | opt | 1 | 5/6 | 2/6 | — | — |
| 12 | az104-12-bicep | Bicep (storage account, VNet, NSG) deployed by Terraform | 0.0002 £ | off | 1 | 3/3 | 2/6 | — | — |
| 13 | az104-13-vnets | VNet, web/app subnets, NSGs, ASGs, 2 VMs | 0.021 £ | opt | 1 | 5/4 | 2/6 | — | B1s ×2 |
| 14 | az104-14-peering-udr | hub + 2 spokes, peerings, router VM, UDRs, 2 spoke VMs | 0.032 £ | opt | 3 | 6/5 | 2/6 | 13 | B1s ×3 |
| 15 | az104-15-dns | public zone, private `lab15.internal` (auto-registration), 1 VM | 0.012 £ | opt | 1 | 4/4 | 2/6 | 13 | B1s |
| 16 | az104-16-lb-appgw | internal Standard LB, App Gateway Standard_v2 (autoscale 0–2), 2 VMs | 0.240 ££ | opt | 1 | 12/10 | 2/4 | 13 | B1s ×2 |
| 17 | az104-17-netwatcher-fix | break-fix: NSG deny + UDR to a dead hop, 2 VMs, NW agent | 0.021 £ | opt | 1 | 6/5 | 2/4 | 13 | B1s ×2 |
| 18 | az104-18-monitor | workspace (capped), VM with AMA + DCR, metric and activity log alerts | 0.012 £ | opt | 1 | 6/5 | 2/6 | 8 | B1s |
| 19 | az104-19-backup | RSV, daily policy, protected VM (restore by hand) | 0.021 £ | opt | 1 | 8/10 | 3/8 | 8 | B1s |

Skill areas: 8–12 `az104.compute`; 13–16 `az104.networking`; 17 `az104.networking, az104.monitor`; 18–19 `az104.monitor`.
Levels: 13 foundation, the rest associate. Lab 17 `type: break-fix`, the rest explore. `dns_link: true` only for 15.
Retail entries: `{ sku: Standard_B1s }`; `S4 LRS Disk` and `E1 LRS Disk` (`1/Month`); `Basic Registry Unit` (`1/Day`);
`Standard IPv4 Static Public IP` (`1 Hour`); (lab 16 as built on Standard_v2: `Standard Fixed Cost` £0.1887/h and
`Standard Capacity Units` £0.006/h are shared names, so authored with no `retail`, ruling 2); `Azure VM Protected Instance`
(`1/Month`; billed at half for a VM under 50 GB, so it overestimates). Everything else authored (ruling 2).

## Review Focus

1. **A lab that cannot get back to £0.** B0: `unblock turns an unlocked vault's immutability off before soft delete, and warns
   on a locked one`; `unblock waits until a vault has no backup items, at most five minutes`. B3: `az104-18-monitor: versions.tf
   deletes the workspace permanently on destroy` (a soft-deleted workspace would come back on the next deploy);
   `az104-19-backup: the VM is protected and versions.tf stops protection and deletes data on destroy`. B1: `az104-12-bicep:
   template deletion removes what the template made` (`delete_nested_items_during_deletion` left true). ACI's subnet service
   association link can hold the subnet for minutes: lab 11's `destroy_min` is 6, and the release test is the proof.
2. **Escaping the scope through a template or an Azure-made group.** B0: `a template deployment refuses Graph extension
   resources, deployment scripts, linked templates and template specs`; `in a plan, a template deployment whose template_content
   is unknown is refused; in HCL it is left to labs-tf`; `a container app environment with an infrastructure subnet must name its
   infrastructure group rg-lab-<id>-*`; `.bicep files are linted for literal CIDRs and the gateway's names`.
3. **Fixtures tidier than real plans** (batch 1's lesson). Every new lab's plan goes through `realisticPlan` with azurerm
   4.81.0's computed attributes; the plan-attribute test keeps each fixture equal to its `main.tf`. B0: `computed.json has every
   type batch 2 labs use`; `a realistic plan with for_each instances has one configuration entry per resource block`.
4. **Azure says no in uksouth.** Zonal B1s in zones 1–2, P0v3 quota, App Gateway Standard_v2, the resource providers
   (`Microsoft.App`, `ContainerInstance`, `ContainerRegistry`, `RecoveryServices`, `OperationalInsights`, `Insights`), and the
   B-series vCPU quota with the gateway's VM: Integration step 5 checks each before any spend. A resource type
   whose `provisioningState` is empty fails the ready check ("no state"); if a release test shows one, B0's owner adds it to
   `lab-ready.sh` test-first: `ready check accepts an empty state only for types Azure never gives one`.
5. **Prices that drift or match the wrong product.** B0: `meterProblems flags a meter two products share at different prices, a
   unit the feed cannot use, and a meter with no uksouth row`; `a lab meter priced per "1/Hour" is kept by the feed and read as £
   per hour`. Areas: `${id}: costs what its marker says`.
6. **Peering-optional networking.** Suite: subnets, `peer_vnet_id`, `dns_link`; B2: `az104-14-peering-udr: peer_vnet_id is the
   hub, and the readme says the spokes are not reachable over the tunnel`; `az104-15-dns: dns_link is true and Terraform never
   links the zone to the gateway`.
7. **Timeouts.** Job timeout is `min(150, 2 × (deploy + destroy) + 20)`: lab 16 gets 64, lab 19 56. A destroy slower than that
   loses the safety net to a cancelled job, so `destroy_min` is generous, and the release test records the real figures.

---

## B0: Engine gaps (integrator, first)

**Branch:** `feat/labs-b2-engine`. **Owns:** every frozen file above; `worker/src/insights/feeds/prices.ts`,
`worker/src/labs/prices.ts`, `worker/test/labs-read.test.ts`; `package.json` (`labs-verify`); the spec's new §17. **Why it exists:** without it lab 12 fails
`terraform validate` (verified: `file()` of a missing JSON is an error), templates can carry Entra writes past the scope check,
content areas would collide on `labs.mjs` and `computed.json`, and lab 19's vault has unhandled teardown states.

- [ ] **B0.1 Fixtures.** `scripts/test/lab-plans.test.mjs` adds: `computed.json has every type batch 2 labs use` (the table's
  types: VMSS, autoscale, service plan, linux web app and slot, container group/app/environment/registry, ASG and its NIC
  association, subnet NSG and route-table associations, route table, VNet peering, public and private DNS zones and records,
  public IP, LB and its pool/probe/rule/NIC association, application gateway, VM extension, managed disk and attachment,
  Log Analytics workspace, DCR and its association, metric and activity-log alerts, RSV, backup policy and protected VM,
  template deployment); `a realistic plan with for_each instances has one configuration entry per resource block`; `LAB_PLANS
  merges labs 1–7 with every file in plans/labs/`. `scripts/test/labs-content-suite.test.mjs` runs `labContentSuite` on
  `az104-07-files` (`marker: "£"`). FAIL; regenerate `computed.json` (`extract-computed.mjs` header recipe, in the scratchpad);
  write `common.mjs`, `content.mjs`, the merge and index stripping; PASS; commit.
- [ ] **B0.2 Templates and Azure-made groups.** `lab-scope.test.mjs` adds the Review Focus 2 tests plus `templateProblems passes a
  Bicep-built storage and VNet template` (fixture `scripts/test/fixtures/labs/bicep/storage-vnet.json`, built with the pinned
  Bicep, languageVersion 2.0 symbolic resources) and `templateProblems refuses a subscription deployment schema`. FAIL;
  implement in `lab-scope.mjs` (types `Microsoft.Graph/*`, `Microsoft.Resources/deploymentScripts`, `Microsoft.Authorization/*`,
  `Microsoft.Management/*`, `Microsoft.Resources/resourceGroups`; keys `templateLink`, `extensions`, `imports`; the
  attribute `template_spec_version_id`; unknown `template_content` in plan mode); PASS; commit.
- [ ] **B0.3 Lint.** `lab-lint.test.mjs`: `.bicep files are linted for literal CIDRs and the gateway's names`; `a committed x.json
  beside x.bicep is refused` (rule `file`). FAIL, implement, PASS, commit.
- [ ] **B0.4 Bicep in the pipeline.** `lab-workflow.test.mjs`: `bicep is installed pinned by version and checksum before Terraform
  init` (replaces the `az bicep build` assertion in `bicep files are built before init`). `lab-tf.test.mjs`: `labs-tf builds
  .bicep into its copy before validate and checks each template`; `without bicep a Bicep lab is skipped with a note locally and
  fails when CI requires it` (`LABS_TF_REQUIRE_BICEP=1`); `ci labs job installs bicep pinned by checksum and requires it`. FAIL,
  implement in `lab.yml` step 5, `ci.yml`, `labs-tf.mjs`; PASS; commit.
- [ ] **B0.5 Vault unblock.** `lab-cleanup.test.mjs` (fake `az`): the two Review Focus 1 B0 tests, `unblock stops protection for
  backup items of every management type`, and the existing `unblock removes locks, legal holds, unlocked immutability, backup
  protection and replication in that order` still passes. (V) `az backup vault update --immutability-state` and
  whether `az backup item list` without `--backup-management-type` lists only IaaS VMs. FAIL, implement, PASS, commit.
- [ ] **B0.6 Prices and verify.** `worker/test/labs-read.test.ts`: `a lab meter priced per "1/Hour" is kept by the feed and read as
  £ per hour`; `labs-verify's units and Windows filter equal the price feed's`. `scripts/test/labs-verify.test.mjs`: `readmeLinks
  takes every https link from a readme`; the `meterProblems` test above; `labs-verify is an npm script and never runs in npm
  test`. FAIL, implement, PASS. Run `npm run labs-verify -- --links --meters` on labs 1–7 and put the result in the report
  (a batch 1 problem is reported, not fixed here). Commit.
- [ ] **B0.7 Contract check.** Spec §17 gets the rulings; this plan's first section is updated to what was built. Gate plus
  `labs-tf`; CI green on a draft PR. Push, then send the areas the commit and the names section.

## B1: Compute, labs 8–12

**Branch:** `feat/labs-b2-compute`. **Owns:** `labs/az104-0{8,9}-*/**`, `labs/az104-1{0,1,2}-*/**`,
`scripts/test/fixtures/labs/plans/labs/az104-{08,09,10,11,12}-*.mjs`, `scripts/test/labs-compute.test.mjs`.
**Consumes:** the B0 names; lab 7 as the model for VMs, `versions.tf` and the readme.

Each step: write `labContentSuite(id, { marker })` and the lab's own tests (below) in `labs-compute.test.mjs`, plus the plan
fixture; run them (FAIL: no folder); write `lab.yaml`, `readme.md`, `terraform/`; run `node --test
scripts/test/labs-compute.test.mjs scripts/test/lab-plans.test.mjs`, `npm run labs-tf -- <id>`, `npm run labs-verify -- --links
--meters <id>`, `npm run labs-check` (PASS); commit.

- [ ] **B1.1 Lab 8:** `az104-08-vms: two Standard_B1s Ubuntu VMs in zones 1 and 2 with no public IP`; `az104-08-vms: a 4 GiB
  Standard SSD data disk in the first VM's zone, attached at LUN 0`; `az104-08-vms: a Custom Script extension serves the VM's
  name on port 80 with python3 and installs nothing`. (V) B1s offers zones 1 and 2 in uksouth (`az vm list-skus -l uksouth
  --size Standard_B1s --query "[].locationInfo[].zones"`). Things to try: resize, snapshot and grow the disk, an availability
  set by hand, reading the extension's status.
- [ ] **B1.2 Lab 9:** `az104-09-vmss: a Uniform scale set of Standard_B1s, 2 instances, no public IP, upgrade mode Manual`;
  `az104-09-vmss: autoscale 1 to 3 on average CPU, out above 70% and in below 25%`; `az104-09-vmss: vm_sizes lists three
  Standard_B1s, the autoscale maximum, and the cost two`. Things to try: load one instance with `yes > /dev/null` via Run
  command and watch scale-out; manual scale; a Flexible scale set by hand.
- [ ] **B1.3 Lab 10:** `az104-10-app-service: a P0v3 Linux plan, a web app and a staging slot, both https only`;
  `az104-10-app-service: autoscale on the plan from 1 to 2 instances`; `az104-10-app-service: peering off, no VNet, connect lists
  both default hostnames`. Web app name `${var.name_prefix}-web`; built-in runtime, no code deploy. (V) P0v3 Linux offered and
  in quota (`az appservice list-locations --sku P0V3 --linux-workers-enabled`). Things to try: swap slots, deployment-slot
  settings, scale up to S1 and back, custom autoscale rule.
- [ ] **B1.4 Lab 11:** `az104-11-containers: an ACI group of 0.5 vCPU and 0.5 GB with a private IP in a delegated subnet`;
  `az104-11-containers: a consumption-only Container Apps environment with no infrastructure subnet and an app that scales to
  zero`; `az104-11-containers: an empty Basic registry with the admin user off, named from name_prefix`. Images
  `mcr.microsoft.com/azuredocs/aci-helloworld` and `mcr.microsoft.com/k8se/quickstart` (V: still published). (V) no Dedicated
  workload profile is created, and no `MC_`/`ME_` group appears (release test leftovers would show it).
- [ ] **B1.5 Lab 12:** `az104-12-bicep: Terraform deploys main.json, built from main.bicep, into the lab's group in Incremental
  mode`; `az104-12-bicep: the template's addresses come from a parameter set from cidrsubnet(var.address_space, 2, 0)`;
  `az104-12-bicep: template deletion removes what the template made`; `az104-12-bicep: the built template passes
  templateProblems` (skips without Bicep). `main.bicep` uses one module (`vnet.bicep`), parameters and outputs. Things to try:
  `az deployment group what-if`, export a template from the portal, redeploy with a changed parameter.
- **Done when:** the gate passes for labs 8–12 and the report lists every (V) answer.

## B2: Networking, labs 13–17

**Branch:** `feat/labs-b2-network`. **Owns:** `labs/az104-1{3,4,5,6,7}-*/**`, their `plans/labs/*.mjs`,
`scripts/test/labs-network.test.mjs`. Same step shape as B1.

- [ ] **B2.1 Lab 13:** `az104-13-vnets: one /20 VNet with web and app subnets and an NSG on each`; `az104-13-vnets: asg-web may
  reach asg-app on 8080 and nothing else from the VNet reaches app`; `az104-13-vnets: ssh to web only from VirtualNetwork, which
  includes the gateway when peered`. Things to try: IP flow verify, effective security rules, move a NIC between ASGs.
- [ ] **B2.2 Lab 14:** `az104-14-peering-udr: hub and two spokes from /20s 0, 1 and 2, each spoke peered with the hub both ways,
  forwarded traffic allowed`; `az104-14-peering-udr: a router VM in the hub with IP forwarding on its NIC and in the kernel`;
  `az104-14-peering-udr: each spoke routes the other spoke's prefix to the router, and nothing routes 0.0.0.0/0`;
  `az104-14-peering-udr: peer_vnet_id is the hub, and the readme says the spokes are not reachable over the tunnel`.
- [ ] **B2.3 Lab 15:** `az104-15-dns: a public zone named from name_prefix under example.com, with an A and a CNAME record`;
  `az104-15-dns: private zone lab15.internal linked to the lab VNet with auto-registration`; `az104-15-dns: dns_link is true and
  Terraform never links the zone to the gateway`. (V) Azure accepts a zone under `example.com`; else `<prefix>.contoso-lab.com`.
- [ ] **B2.4 Lab 16:** `az104-16-lb-appgw: an internal Standard load balancer with a TCP 80 probe and rule over both VMs`;
  `az104-16-lb-appgw: an Application Gateway in its own /24 with the public IP it must have and its only listener on the
  private frontend`; `az104-16-lb-appgw: the gateway subnet allows GatewayManager on 65200-65535`. As built after review
  (Steven chose Standard_v2 over Basic): `az104-16-lb-appgw: the gateway is Standard_v2 autoscaling from 0 to 2, priced by hand
  (its meters are shared, ruling 2)`; autoscale 0–2, not 0–1, because azurerm 4.81 takes `max_capacity` 2 to 125 (checked with
  `terraform validate`); £0.240/h, still ££; lab version 2. (V) live: a private-only listener (with the public IP v2 must own)
  on Standard_v2 in uksouth, and the deploy time.
- [ ] **B2.5 Lab 17:** `az104-17-netwatcher-fix: type break-fix, with Symptom and a closed What was broken`;
  `az104-17-netwatcher-fix: an NSG deny on 8080 outranks the allow`; `az104-17-netwatcher-fix: the app subnet routes the db
  subnet to an address nothing holds`; `az104-17-netwatcher-fix: both VMs carry the Network Watcher agent and Terraform makes no
  Network Watcher of its own`; `az104-17-netwatcher-fix: the Symptom names neither fault`. The deny rule has a misleading name
  (`allow-monitoring`); the Symptom: "`curl http://vm-db:8080` from `vm-app` times out". (V) Network Watcher is enabled in uksouth.
- **Done when:** the gate passes for labs 13–17 and the report lists every (V) answer.

## B3: Monitor and backup, labs 18–19

**Branch:** `feat/labs-b2-ops`. **Owns:** `labs/az104-1{8,9}-*/**`, their `plans/labs/*.mjs`, `scripts/test/labs-ops.test.mjs`.
Same step shape as B1.

- [ ] **B3.1 Lab 18:** `az104-18-monitor: a PerGB2018 workspace with a daily cap of at most 0.05 GB and 30 days' retention`;
  `az104-18-monitor: the VM sends perf counters every 60 s and syslog warnings and above through AMA and one DCR`;
  `az104-18-monitor: a CPU metric alert and a VM-restart activity log alert, both scoped inside the lab, to an action group with
  no receivers`; `az104-18-monitor: versions.tf deletes the workspace permanently on destroy`. (V) the lowest daily cap the
  workspace takes, and AMA's need for a system-assigned identity only. Things to try: KQL on `Perf` and `Syslog`, an email
  receiver by hand, VM insights.
- [ ] **B3.2 Lab 19:** `az104-19-backup: a Standard Recovery Services vault, LRS, soft delete off, immutability Disabled`;
  `az104-19-backup: a daily Enhanced (V2) policy keeping 7 days, instant restore 1 day in rg-lab-<id>-irp` (as built: Enhanced,
  `policy_type = "V2"`, because a V1 policy refuses Trusted Launch VMs, and Enhanced backs up both kinds); `az104-19-backup: the VM is
  protected and versions.tf stops protection and deletes data on destroy`; `az104-19-backup: the readme says to restore only into
  rg-lab-<id> and never to lock immutability or make soft delete always-on`. Things to try: Backup now, file recovery, restore
  to a new VM in the lab's group, stop protection. (V) `soft_delete_enabled = false` is honoured on a new vault.
- **Done when:** the gate passes for labs 18–19 and the report lists every (V) answer.

---

## Integration

1. **Merge** onto `feat/labs-b2` in the order B3, B1, B2, running the gate after each. Any conflict means an area edited a frozen
   file: reject that change, or fold it into B0.
2. **Full gate:** `labs-check -- --base origin/main`, `labs-tf` (all labs), `labs-verify -- --links --meters`, `bundle-size`
   unchanged (the app never imports the catalogue). CI's `labs` job green on a draft PR (with hcl2json and Bicep required).
3. **Whole-branch review.** A fresh opus reviewer gets this plan, the spec and the diff. Ask about: the Review Focus list;
   `templateProblems` and the Bicep pin; the vault unblock; every fixture against its `main.tf`; prices and markers.
4. **One fix pass,** test-first, then repeat step 2.
5. **Pre-flight on real Azure (read-only, no cost):** with `az` signed in as the pipeline principal, `node
   scripts/lab-release-test.mjs --check`; `az vm list-usage -l uksouth -o table` (B-series and total vCPUs, with the gateway's);
   the zones, P0v3 and App Gateway Standard_v2 answers above; `az provider show -n <ns> --query registrationState` for each namespace in
   Review Focus 4 (an unregistered one is Steven's to register).
6. **STOP A: ask Steven to approve the release-test spend.** One pass, run in sequence on slot 31:

   | Lab | £/h | Likely (deploy + destroy minutes) | Worst case (a full hour, plus daily minimums) |
   |---|---|---|---|
   | 8, 9, 13, 17 | 0.021–0.022 each | under £0.01 each | £0.022 each |
   | 10 | 0.065 | £0.01 | £0.07 |
   | 11 | 0.025 | £0.01 | £0.15 (registry billed by the day) |
   | 12 | 0.0002 | £0.00 | £0.01 |
   | 14 | 0.032 | £0.01 | £0.03 |
   | 15 | 0.012 | £0.01 | £0.04 (two zones, monthly fees by the day) |
   | 16 | 0.070 | £0.03 | £0.07 (£0.24 if Standard_v2) |
   | 18 | 0.012 | £0.01 | £0.02 |
   | 19 | 0.021 | £0.01 | £0.27 (protected instance by the day) |
   | **Total** | | **about £0.10** | **about £0.75; ask for up to £1.50 to allow one retry each** |

   A second pass of the same size follows the deploy (step 9), and a lab 19 soak adds about £0.05 plus a day of protection.
7. **Release tests** on Steven's go: `node scripts/lab-release-test.mjs az104-12-bicep az104-10-app-service az104-08-vms
   az104-09-vmss az104-13-vnets az104-15-dns az104-14-peering-udr az104-17-netwatcher-fix az104-11-containers az104-18-monitor
   az104-16-lb-appgw az104-19-backup --ref feat/labs-b2 --confirm-cost`. Every lab must report `clean: true`. On a failure: fix
   test-first in the owning area's files, bump that lab's `version`, rerun that lab. Replace each lab's `deploy_min` and
   `destroy_min` with the measured figures rounded up (a version bump, then one more test of that lab). Commit
   `docs/labs/release-tests.md`.
8. **Open the batch PR** (`feat/labs-b2` → `main`). **STOP B: ask Steven** before merging and before deploying.
9. **On his go:** merge; `npm run deploy-worker` (bundles the catalogue; no migration); Settings → Labs → **Test** each of labs
   8–19, one at a time, to record `lab_release_tests` and mark them released; then the **lab 19 soak** from the dashboard:
   deploy, Backup now, restore to a new VM in `rg-lab-az104-19-backup`, stop protection keeping data, then Tear down, and confirm
   the session ends clean (proving the unblock path on real backup data).

## Final review checklist

- **Labs 8–19:** each matches the table, passed a real-Azure test with `clean: true`, and has measured timings.
- **Scope:** nothing outside `rg-lab-<id>` but `rg-lab-<id>-irp1`; no Entra, no role assignment; every template and Bicep file
  passes `templateProblems` and the lint; every address comes from the slot.
- **Teardown:** the vault path is proven twice (release test, soak); no workspace or vault survives a destroy.
- **Prices:** every `retail` entry passes `labs-verify --meters`; every marker matches `costMarker`.
- **No change** to the gateway, `wg.yml`, D1, Worker routes or the app; `.env` was never read.
