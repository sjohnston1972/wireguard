# Lab topology diagram: implementation plan

## T0 names (as built, T0.13)

The contract on **`feat/topo-engine`** (T0's branch as built; the plan's `feat/lab-topology-engine`). Areas (T1, T2, T3) branch
from its head and use these names exactly; a change goes through the integrator, who updates this section and the spec
together. Everything below exists and is tested on that branch.

**Graph model** (`shared/topology/`, pure TypeScript; the app, the Worker and the generator share it)
- `model.ts`: `TOPOLOGY_SCHEMA = 1`; `TopoSource`; `TOPO_GROUP_KINDS` / `TopoGroupKind` (`resourceGroup`, `vnet`, `subnet`,
  `virtualHub`, `lane`); `TOPO_ASSET_KINDS` / `TopoAssetKind` (spec §4.3's kinds **plus `gateway`**, the synthetic WireGuard
  gateway node `wg/gateway`, and `generic`); `TopoKind`, `TopoTone`, `TopoHealth`, `TopoPropValue`, `TopoFolded`
  (`{ id, label, armType }`), `TopoNode`, `TopoEdge`, `TopologyGraph` as spec §4.1; `sortGraph(g)` (a copy, nodes, edges and
  each `folded` list by id); `isGroupKind(k)`.
- `kinds.ts`: `KINDS: Record<TopoKind, KindDef>`, `KindDef = { word, plural, icon, placement, liveVisible, armTypes, tfTypes,
  cardProps, order }` (`placement: KindPlacement = "subnet" | "vnet" | "rg" | "global" | "tenant" | "root"`; `tfTypes` may end
  or start with `*`; `icon` is the sprite symbol without its `az-` prefix; `order`: groups 0-4, edge devices 10-16, compute
  20-25, data 30-35, the rest 40-70, `generic` 99); `GROUP_KINDS`; `kindOfArm(type, kind?)` (case-insensitive; a
  `virtualHubs` row of kind `RouteServer` is `routeServer`; unknown → `generic`); `kindOfTf(type)` (unknown → `generic`);
  `isAssetKind(k)`; `STACK_AT = 8`, `LIST_VIEW_AT = 300`.
- `keys.ts`: `NameCtx = { prefix, region, secondaryRegion }`; `nodeKey(armType, namePath, ctx)`; `normaliseName(name, ctx)`
  (`{p}`, `{r}`, `{r2}`, the longer region first); `MOCK_NAME` (`prefix(n) = "l" + n + "k3x9q"`, `uksouth`, `ukwest`);
  `mockNameCtx(n)`; `planLabel(name, n)` (`l06k3x9qst` → `l06…st`); `disambiguate(nodes: { id, key, group }[], primaryRg) →
  Record<id, key>` (`#<group suffix>`, then `#2`, `#3` by id); `SYNTHETIC_KEYS = { globalLane: "lane/global", tenantLane:
  "lane/tenant", gateway: "wg/gateway" }`. Planned keys of types with no ARM type are `terraform/<tf type>/<name>`.
- `props.ts`: `PROP_NAMES` (spec §4.5, unchanged); `MOCK_SECRETS = { adminPassword, sshPublicKey }` (a test keeps them equal to
  labs-tf's); `MAX_PROP_CHARS = 256`; `secretLike(value)` (props: the words password/secret/sharedkey/accountkey, `sig=`, PEM,
  JWT, a 40+ base64 run mixing digits and both cases, the mock secrets, over 256 characters); `secretValue(value)` (names,
  keys, ids, edge labels, notes: the same **without** the bare words, so "Key Vault Secrets User" is a name, not a secret);
  `isCount(s)` (`"secrets: 2"`: a word and a number, allowed in `counts`); `scrubProps(props) → { props, withheld }`;
  `tagProps(tags) → string[]` (`"lab: <v>"`, `"project: <v>"`, `"+N tags"`); `withheldNote(n)`; `denyProblems(graph) →
  string[]` (the deny check: each line names where, never the value).
- `rules/planned.ts`: `TfInst` (`{ id: "tf:<address>", address, config: "type.name", type, name, index, after, armType? }`),
  `EdgeSpec`, `PlannedHelpers` (`refs`, `referrers`, `byType`, `home`, `label`, `nodeByPrivateIp`, `subnetsOf`), `TfRule = { arm?,
  kind?, ignore?, fold?: attr[], foldToReferrer?: { types?, attrs? }, pull?: attr[], chips?, props?, edges?, namePath?,
  foldedLabel? }`, `TF_RULES: Record<tfType, TfRule>`, `TF_IGNORED_PREFIXES` (`random_`, `time_`, `terraform_data`,
  `null_resource`), `tfRule(type)`, `tfIgnored(type)`, `staticIp(ipConfigs)`, `VM_TYPES`. Core rules at T0: groups, VMs (NICs,
  disks, extensions, NSG/ASG associations folded, chips), NSG, route table and routes (next-hop edges), peering, public IP
  (folds into whatever references it), public IP prefix, NAT gateway and its associations, LB core (pools, probes, rules,
  NAT and outbound rules, pool associations), template deployment (folds into its RG), storage account and container, Key
  Vault and its secrets/keys/certificates (folded as `secret`/`key`/`certificate`, counted, never named), private endpoint
  (edge to its target), private DNS zone and its VNet links (folded, `link` edge), role assignment (folded into its scope,
  `role: <name>` dependency edge), Entra users and groups (Tenant lane), Log Analytics, flow logs.
- `rules/live.ts`: `ArgRow` (the projected columns), `LiveEdgeSpec`, `LiveHelpers` (`row`, `home`, `nodeByPrivateIp`,
  `nicsOf`), `ArmRule = { fold?, props?, edges? }`, `ARM_RULES: Record<armTypeLower, ArmRule>`, `AZURE_MADE: { test(row), why
  }[]` (managedBy set; a VM's OS disk; a private endpoint's NIC; an `-infra`/`-managed` group; `NWTA*` data collection rules
  and endpoints; `NetworkWatcher_*`), `healthOf(row)` (VM power words "Running", "Stopped (deallocated)" …; SQL database
  `status`; connection `connectionStatus`; App Gateway `operationalState`; else provisioningState: Succeeded → ok "Ready",
  Failed → bad, Updating/Creating/… → warn; none → unknown "No data"), `stateWord(s)` ("Pending" → "Pending approval"),
  `topResource(id)`, `subnetIdOf(id)`, `namePathOf(id)`, `lower(s)`, `peeringEdges(row, isGateway)`.
- `planned.ts`: `ResourceChange` (`{ address, type, name, index?, after, after_unknown? }`), `PlannedInput = { labId,
  version, number, changes, outputs, refs }` (`refs`: configuration address, or `output.<name>`, → top-level attribute →
  referenced configuration addresses `type.name`; resolved to instances by matching instance key), `plannedGraph(input)`,
  `representedIds(graph)` (nodes, folded entries and edge vias).
- `armTemplate.ts`: `ArmResource` (`{ type, name, dependsOn, properties, location?, kind?, sku?, refs, subnetRefs }`),
  `UnsupportedArm` (`.expression`), `ArmCtx`, `evaluateArm(value, ctx)`, `expandTemplate(template, parameters, rgLocation)`,
  `expandDeployment(inst, rgLocation)`. Supports `parameters`, `variables`, `format`, `concat`, `resourceGroup().location`,
  `resourceId` (→ `/providers/<type>/<name>`), resource and property `copy`, `copyIndex`, `length`, `cidrSubnet`, `toLower`,
  `toUpper`, `string`, `int`, `add`, `sub`, `mul`, `equals`, `not`, `and`, `or`, `if`, `true`, `false`, `empty`,
  `createArray`, nested inline deployments (inner and outer scope), symbolic-name templates; anything else throws.
- `live.ts`: `LiveCtx = { labId, version, namePrefix, region, secondaryRegion, catalogueIds, gatewayVnetId, at }`,
  `liveGraph(rows, ctx)`; re-exports `ArgRow`. Live resource groups carry no region or tags (the `resources` table has no
  group rows).
- `query.ts`: `ARG_API = "2022-10-01"`, `ARG_TOP = 1000`, `topologyQuery(labId)` (throws for anything that is not a lab id),
  `topologyRequest(subscriptionId, labId)` (`{ subscriptions, query, options: { resultFormat: "objectArray", $top } }`).
- `diff.ts`: `NodeDiffStatus`, `MOCK_SLOT = "10.71.192.0/18"`, `diffGraphs(planned, live, opts?) → { status: Record<key,
  NodeDiffStatus> }`, `badgeOf(status, { deploying? }) → string | null` ("Added by hand", "Made by Azure", "Not deployed or
  removed" / "Not deployed yet", "Not listed by the live view"), `mergeForView(planned, live, opts?) → { graph, status }`
  (ghosts keep their planned ids `tf:…`, their parent mapped to its live twin by key; ghost edges have ids `ghost:<planned
  edge id>`), `rebaseSlot(graph, cidr)`.
- `layout.ts` (prefs): `TopologyLayout`, `TopologyLayoutPage`, `TopologyLayoutPutBody`, `MAX_TOPOLOGY_BODY_BYTES` (20 KiB),
  `MAX_TOPOLOGY_LAYOUT_BYTES` (16 KiB), `MAX_TOPOLOGY_ENTRIES` (300), `MAX_TOPOLOGY_KEY_CHARS` (200), `MAX_TOPOLOGY_COORD`
  (100 000), `topologyPage(labId)`, `validTopologyKey(k)`, `validateTopologyLayout(raw) → PrefsProblem | null` (`PrefsProblem`
  re-exported from `shared/widgets.ts`), `normaliseTopologyLayout(raw)`, `EMPTY_LAYOUT`.
- `planned/<id>.json`: one per lab folder (40), generated, LF (`.gitattributes`), each well under 2 kB gzip at T0.

**API** (`shared/api.ts`): `LabTopologyResponse` (spec §6.6). Routes: `GET /api/v1/labs/:id/topology`; `GET` and `PUT
/api/v1/prefs/topology/:labId` (registered before `/prefs/:page`). Migration `worker/migrations/0021_ui_prefs_topology.sql`.

**Worker:** `worker/src/labs/topology.ts`: `labTopology(env, labId, now?) → LabTopologyResponse`, `TOPOLOGY_CACHE_MS =
30_000`, `resetTopologyCache()`; `worker/src/api/labs.ts` registers the route; `worker/src/prefs.ts`:
`getTopologyLayout(env, user, labId)`, `putTopologyLayout(env, user, labId, baseVersion, layout)`, `TopologyPutResult`;
`worker/src/api/prefs.ts` the two routes; `worker/src/devseed-labs.ts`: `LABS_KV.topologyDev = "labs:topology:dev"`,
`topologyDevRows()` (lab 6 in slot 0, prefix `l06k3x9q`, peered, one hand-made `nsg-handmade`), `seedTopologyDev(env)`
(called by `seedLabs`).

**Scripts:** `npm run labs-topology` (`scripts/labs-topology.mjs [--check] [id ...]`: `runLabsTopology({ labsDir, outDir,
only, check, run, hcl2json, bicep, log, build?, deny? }) → { failures, written }`, `loadBuilder()` (Vite's `runnerImport`),
`fileText(graph)`); `scripts/lib/hcl2json.mjs` (`HCL2JSON_VERSION = "0.6.9"`, `HCL2JSON_SHA256`, `hcl2jsonAsset()`,
`hcl2jsonUrl()`, `hcl2jsonMatchesPin()`, `pinnedHcl2json()`); `scripts/lib/topology-stream.mjs` (`PLAN_OUTPUTS`,
`planFromTestStream(text) → { changes, outputs }`, `scrubChanges(changes)`, `refsFromHcl(hcl, labId, hclResources)`,
`diagnostics(text)`); `scripts/topology-icons.mjs` (`PACK_VERSION = "V24"`, `PACK_URL`, `PACK_SHA256`, `ICON_FILES`,
`NEAREST`, `optimiseIcon()`, `buildSprite()`, `buildReadme()`); `scripts/topology-capture.mjs` (`CAPTURE_KEEP`,
`captureRows(rows)`, `captureRequest(subscriptionId, labId)`, `FAKE_SUBSCRIPTION`). `scripts/lib/bundle.mjs`: `LIMITS = {
entryJsGzip: 320_000, jsGzip: 450_000, cssGzip: 50_000, topologyDataGzip: 16_000, spriteGzip: 60_000 }`,
`FORBIDDEN_IN_ENTRY = ["react-flow__", "@xyflow"]` (every `assets/*.json` is a planned file; every `assets/azure*.svg` the
sprite). CI's `labs` job runs `npm run labs-topology -- --check` after `labs-tf` with `TF_PLUGIN_CACHE_DIR`, `BICEP` and
`HCL2JSON` set.

**App:** dependency `@xyflow/react` `12.12.0` (exact). **`web/src/api/topology.ts`** (not `queries.ts`/`mutations.ts`: only the
lazy chunk imports it, so the entry never carries it): `TOPOLOGY_REFRESH_MS`, `PLANNED_URLS` (eager `import.meta.glob(…, {
query: "?url", import: "default", eager: true })`), `plannedTopologyUrl(id, urls?)`, `usePlannedTopology(id, urls?)`,
`useLabTopology(id, { enabled })`, `useTopologyLayoutQuery(id, { enabled? })`, `putTopologyLayout(id, body, opts?)`.
`web/src/App.tsx`: route `labs/:id/diagram` → the labs page; dev-only `__topology/:id` → `web/src/topologyGallery.tsx` (T1
may edit; `?asset=` points it at another planned file). `web/src/views/pages.tsx`: `LabDiagramTab` (a `lazy()` of the chunk's
`DiagramTab`, so every build carries the chunk; T2 uses it or its own `lazy()`). `web/vite.config.ts` never inlines `.json`
or `.svg` assets. `web/src/views/labs/topology/` (the lazy chunk): `index.ts` (default `{ DiagramTab, FullScreen, LabMini }`,
each `({ labId })`), `contract.ts` (below), a stub `Canvas.tsx` that renders `ListView`, `ListView.tsx` (`ListView`,
`ListViewProps`: a nested `role="tree"` with kind words, health words and badges) and `ListView.css`; T2's
`DiagramTab.tsx` (`PlannedDiagram`, `PlacementProps`), `FullScreen.tsx` and `LabMini.tsx` exist as stubs; the sprite
`icons/azure.svg` (one `<symbol id="az-<icon>">` per KINDS icon plus `generic`) with `icons/README.md`.

```ts
// web/src/views/labs/topology/contract.ts
export type DiagramVariant = "tab" | "full" | "mini";
export interface CanvasProps {
  graph: TopologyGraph;                        // from mergeForView (live + ghosts) or the planned graph
  status: Record<string, NodeDiffStatus>;      // by node key; {} for planned
  saved: TopologyLayout | null;                // null: none, or failed to load
  onMove?: (key: string, at: { x: number; y: number; p: string | null }) => void;   // absent in mini
  view: "diagram" | "list";
  showDependencies: boolean;
  search: string;
  variant: DiagramVariant;
  selected: string | null;                     // node id
  onSelect: (id: string | null) => void;
}
export interface ToolbarProps { source: "live" | "planned" | null; onSource?: (s: "live" | "planned") => void; search: string;
  onSearch: (s: string) => void; showDependencies: boolean; onDependencies: (b: boolean) => void; view: "diagram" | "list";
  onView: (v: "diagram" | "list") => void; onReset?: () => void; fullScreenHref?: string; onClose?: () => void; variant: DiagramVariant }
export interface DetailsProps { graph: TopologyGraph; status: Record<string, NodeDiffStatus>; nodeId: string | null; onClose: () => void }
```

**(V) answers at T0:** Vite's `runnerImport` (Vite 8.3.2) runs the TypeScript builder from `.mjs`; hcl2json v0.6.9's Windows
asset is `hcl2json_windows_amd64.exe`, SHA-256 `be798d4c…d4f4f` (GitHub's digest, checked on download); the icon pack is
**V24** (`Azure_Public_Service_Icons_V24.zip`, SHA-256 `921594cc…c35141`), terms quoted in `icons/README.md`, six nearest
matches (Route Server → Virtual Router, DNS forwarding ruleset → DNS Private Resolver, private DNS zones → DNS Zones,
Container Apps → Worker Container App, role → Entra Identity Roles and Administrators, generic → All Resources).

**Bundle at T0** (`npm run bundle-size`): entry 311.3 kB (main 311.2), all JS 347.1 kB of 450 (main 342.1), CSS 33.3 kB; the
lazy `topology` chunk 4.9 kB gzip (no React Flow in it yet: T1's real Canvas brings it); 40 planned assets, largest 1.5 kB
gzip (`az700-40-lb-advanced`); the sprite is not emitted until T1's Canvas references it. `labs-topology` regenerated
twice locally (Windows) with no change, and CI's Linux `--check` passed on the same files.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. The integrator lands **T0** first. Then three areas run **in parallel**, each in its own git
> worktree with one implementer under superpowers:test-driven-development: **T1** canvas, nodes and layout; **T2** placements
> and persistence; **T3** coverage across the 40 labs. Steps use checkbox (`- [ ]`) syntax.

**Goal:** every lab's panel has a Diagram tab (and a full-screen view, and a mini diagram on the Overview hover) showing its
architecture: planned before deploy from a generated, secret-free graph, live while running from one Resource Graph query
scoped to the lab's groups, with hand-made and missing resources badged and the arrangement synced per lab.

**Architecture:** pure graph builders in `shared/topology/` (planned from the mock plan's values plus the HCL's references;
live from Resource Graph rows), one allow-list of props, one KQL text. `npm run labs-topology` writes
`shared/topology/planned/<id>.json` (CI checks it is fresh). The Worker adds `GET /api/v1/labs/:id/topology` (one query,
30 s isolate cache) and the topology rows of `ui_prefs` (migration 0021, two routes). The app adds a lazy diagram chunk (React
Flow + custom packing layout + Azure icon sprite) used by the lab panel's Diagram tab, `/labs/:id/diagram` and the Overview
hover.

**Tech stack:** unchanged plus `@xyflow/react` 12.12.0 (MIT). React 19, TypeScript, Vite 8, TanStack Query, Radix, Hono, D1,
Vitest (worker and web projects), node:test for scripts, Terraform 1.14.6 (azurerm 4.81.0 mocked), hcl2json 0.6.9.

**Spec:** `docs/superpowers/specs/2026-10-06-lab-topology-design.md` (binding; its §3 rulings 1–27). The labs spec
(`2026-10-04-labs-design.md`, rulings 1–61) and the widgets spec (`2026-10-03-widgets-design.md`, §6–§7: the save discipline)
still hold. **(V)** marks a fact to check during the build; each area's report records the answer.

**Facts established before planning** (2026-10-06, no Azure calls):
- `@xyflow/react` 12.12.0 (npm registry: latest, published 2026-09-24, MIT; dependencies `@xyflow/system` 0.0.83 (d3-drag,
  d3-zoom, d3-selection, d3-interpolate), `zustand` ^4.4.0, `classcat`; peers React ≥ 17); about 60 kB gzip by bundlephobia's
  estimate.
- Bundle of `main` (`web/dist` built 2026-10-06 from 8243fab): entry 311.9 kB, all JS 342.8 kB, CSS 33.3 kB gzip; the labs
  chunk 11.2 kB.
- Terraform 1.14.6 on lab 35 with labs-tf's mock file: `terraform test -verbose -json` exits 0 and prints one `test_plan`
  message (keys `plan_format_version`, `output_changes`, `resource_changes`, `relevant_attributes`,
  `provider_format_version`, `provider_schemas`; **no `configuration`**, so no references), 3.3 MB, the mock admin password
  inside; `resource_changes[].change.after` has configured values (`azurerm_route.default`: `0.0.0.0/0`, `next_hop_in_ip_address
  10.71.192.4`) and `after_unknown` marks computed ones (a NIC's `subnet_id`).
- `infra/ci/lab-scope.mjs` exports `hclResources(hcl, labId)` (refs per attribute from hcl2json). CI pins hcl2json v0.6.9
  (linux checksum in `ci.yml`); it is not on Steven's PC.
- `ui_prefs.page` has `CHECK (page IN ('overview','clients','firewall','activity','cost'))`; the latest migration is 0020;
  `npm run deploy-worker` applies migrations before deploying; the dev seeder wipes `ui_prefs`.
- The insights health feed reads Resource Health and the instance view of `vm-wg` only. `LabDetail.resources` is one ARM list
  of `rg-lab-<id>`. Nothing in the code uses Resource Graph today.
- 40 lab folders on `main` (1–9, 11–27, 31–44); plan fixtures for labs 8–44; recorded real plan shapes for 27 labs (13–44 with
  a release test); lab 12 is the only Bicep lab.

## Global Constraints

- **Inherited:** commit trailer `Claude-Session: https://claude.ai/code/session_01NfyX95eNcuuGbmVVqs8vQV` and push after every
  commit; never read `.env` (worktrees `cp .env.example .env`); kill processes by PID only; one `.css` per component, tokens,
  status colours always with a word; "no data" never 0; Vitest + RTL behaviour tests; fixtures use TEST-NET, fake GUIDs and
  `contoso.onmicrosoft.com`; Windows skips need a reason (the generator does not skip: it needs terraform, and fetches
  hcl2json).
- **Branches:** T0 `feat/lab-topology-engine` from `main`; T1 `feat/lab-topology-canvas`, T2 `feat/lab-topology-places`, T3
  `feat/lab-topology-coverage` from T0's head; integration `feat/lab-topology` from T0's head, the PR into `main`.
- **No Azure before integration step 6.** Areas never call Azure; every live fact comes from fixtures. The integration's live
  check is the only spend: **at most £2** (labs 14 and 43, an hour each). No other subscription, group or identity is touched.
- **STOPs (ask Steven) only for:** a permission or identity change (for example Resource Graph refusing the Worker's
  principal: a 403 is a STOP, never a role change); a subscription setting; spend past £2; anything unexpected (a migration
  row-count mismatch, a planned file that will not stop changing). **Pre-approved, no stop:** merge to `main`, `npm run
  deploy-worker` (which applies migration 0021), the two live labs and their hand-made NSG and deleted endpoint.
- **Frozen files** (T0 or the integrator only): `shared/**` except T3's `shared/topology/rules/**`, `shared/topology/props.ts`
  and `shared/topology/planned/**`; `worker/**` except T3's `worker/test/topology-golden.test.ts`,
  `worker/test/topology-live-*.test.ts` and `worker/test/fixtures/topology/**`; `scripts/**`; `package.json`,
  `package-lock.json`; `.github/**`; `.gitattributes`; `web/src/{api,components,shell,test,widgets}/**`; `web/src/App.tsx`;
  `web/vite.config.ts`; `web/src/views/labs/topology/{index.ts,contract.ts}`. A change an area needs (a prop name, a contract
  field) goes to the integrator, who changes the names section and the spec together. **No change to** the lab folders, the
  gateway, `wg.yml`, `lab.yml`, the widgets registry or the Overview's widget settings.
- **Secrets:** nothing outside `PROP_NAMES` ever reaches a planned file, a response, a fixture or a log. The plan stream is
  never printed, saved or committed (a recorded stream fixture is scrubbed by `scrubStream` and checked by the deny test).
- **Determinism:** planned files and layouts come from sorted input; no `Date.now()` or randomness in a builder or the
  packing; a planned file is regenerated, never hand-edited.
- **Budgets:** entry ≤ 320 kB, all JS ≤ 450 kB, CSS ≤ 50 kB gzip; each planned file ≤ 16 kB gzip; the sprite ≤ 60 kB gzip;
  no `@xyflow` in the entry.
- **One-screen rule:** at 1100×600 and larger the Labs page never scrolls with the Diagram tab open; the canvas pans.
- **Gate (every area):** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run bundle-size`; T3 and T0 also `npm run
  labs-topology -- --check` (needs terraform); T1 and T2 also their shots (spec §12).

## Review Focus

1. **Secrets leaking into topology or props.** T0: `scrubProps drops every name outside PROP_NAMES`, `a value that looks like a
   key, token, PEM, SAS or the mock password is withheld and noted`, `the generator never prints the plan stream, even on
   failure`, `no planned file contains the mock admin password, the mock SSH key or a PROP_NAMES-foreign key`; T3: `every
   committed planned file passes the deny check` and `every live fixture's derived graph passes the deny check`; Worker: `the
   response carries no raw properties and no tag but lab and project`.
2. **Resource Graph scope escaping the lab's groups.** T0: `the query names the subscription and only rg-lab-<id> and
   rg-lab-<id>-*`, `an id outside the catalogue is 404 before any query`, `a row from another lab's group is dropped`, `a row from
   a longer lab id's group (rg-lab-<id>-x where <id>-x is a catalogue id) is dropped`, `the query text is the one from
   topologyQuery (Worker and capture script share it)`, `a planned resource in NetworkWatcherRG is scope outside and never
   queried`.
3. **Layout instability.** T1: `the same graph in any order lays out identically`, `a refresh with one new node moves no saved
   node`, `a new node never overlaps a saved sibling`, `children always sit inside their parent with padding`, `a saved position
   under another parent is ignored`, `planned and live of the same lab give the same keys (T3's round trip)`.
4. **Huge labs.** T1: `9 VMs in a subnet become one stack card`, `a 300-node graph lays out under 50 ms`, `over 300 nodes opens in
   List with a note`; T0: `more than 1000 rows answers truncated with a banner message`; T3: `lab 9's VMSS is one card with its
   instance count and autoscale`.
5. **Hand-made resources of unknown types.** T3: `an unknown type in a subnet is a generic card in that subnet`, `an unknown type
   with no subnet is a generic card in its group`, `a private endpoint's NIC, an OS disk, NWTA* rules and ANM_ peerings are
   made by Azure, never added by hand`, `every lab's planned graph turned into rows and back has no added or missing node`.
6. **False "not deployed".** T0: `kinds the query cannot list are unlisted, never missing`; T2: `while deploying, missing reads
   Not deployed yet`.
7. **Mobile.** T2: `the phone sheet shows Readme and Diagram tabs`, `details open as a sheet`; shots at 390×844 exit 0 with no
   horizontal scroll.
8. **Bundle size.** T0: `bundle-size fails when an entry file mentions @xyflow`, `planned files are emitted as assets, not JS`;
   integration: `bundle-size` within 450 kB after the merge.
9. **Stale planned files.** T0: `--check exits 1 naming a lab whose graph changed, a missing file and a file with no lab`, `two
   runs give identical files`; CI runs it.
10. **Migration 0021.** T0: `0021 keeps every ui_prefs row and refuses a page that is neither a widget page nor topology:<id>`;
    integration: row count before and after deploy.

---

## T0: Engine (integrator, first)

**Branch:** `feat/lab-topology-engine`. **Owns:** every frozen file; this plan's names section. **Why it exists:** without
it there is no graph to draw, no secret-free planned data, no scoped live read, nowhere to keep a layout, and no contract for
three areas to build against in parallel.

- [ ] **T0.1 Model, kinds and keys.** Tests first (`worker/test/topology-model.test.ts`): `every TopoAssetKind has a KINDS entry
  with an icon, placement and words`; `an ARM type maps to one kind, case-insensitive, and a virtual hub of kind RouteServer is a
  routeServer`; `nodeKey lower-cases, replaces the prefix, region and secondary region, and nests a subnet under its VNet`; `two
  nodes with one key get #secondary deterministically`; `sortGraph orders nodes and edges by id`. FAIL; implement `model.ts`,
  `kinds.ts`, `keys.ts`; PASS; commit. **Done when** `npx vitest run worker/test/topology-model.test.ts` and `npm run typecheck`
  pass.
- [ ] **T0.2 Props allow-list.** Tests first (`worker/test/topology-props.test.ts`): Review Focus 1's T0 names for
  `scrubProps`; `MOCK_SECRETS equal labs-tf's mock password and key` (reads `scripts/labs-tf.mjs` as text); `tags keep lab and
  project only and count the rest`. FAIL; implement `props.ts`; PASS; commit. **Done when** the test file passes.
- [ ] **T0.3 Planned builder, core rules.** Tests first (`worker/test/topology-planned.test.ts`, fixtures
  `worker/test/fixtures/topology/plan/az700-35.json` and `az104-13.json`: `{ changes, outputs, refs }` cut from a real mock run
  and scrubbed): `lab 35 has two VNets, two subnets, two VMs in their subnets, one peering edge and a 0.0.0.0/0 next-hop edge from
  snet-app to vm-nva`; `NICs are folded into their VMs and the VM shows its private IP when it is static`; `lab 13's NSGs are
  subnet chips and ASGs fold into the VMs`; `a resource of an unruled type becomes a generic card in its group`; `random_password
  and data sources are ignored`; `every address in the input is represented (node, folded or edge via)`; `the peer target VNet
  is marked from the peer_vnet_id output`. FAIL; implement `planned.ts` and `rules/planned.ts` for groups, VM, NIC, NSG, route
  table, peering, public IP, LB (core), generic; PASS; commit. **Done when** the test file passes.
- [ ] **T0.4 Bicep expansion.** Tests first (`worker/test/topology-arm.test.ts`): `lab 12's compiled template expands to the
  storage account, the NSG, the VNet and its two subnets with names from parameters`; `a nested deployment's inline template is
  expanded`; `an unsupported expression throws UnsupportedArm naming it`. Fixture: lab 12's `main.json` built by the pinned Bicep
  (committed under `worker/test/fixtures/topology/arm/`). FAIL; implement `armTemplate.ts` and its use for
  `azurerm_resource_group_template_deployment`; PASS; commit. **Done when** the test file passes.
- [ ] **T0.5 Live builder, core rules.** Tests first (`worker/test/topology-live.test.ts`, fixture rows
  `worker/test/fixtures/topology/live/core.json`): `subnets come from the VNet row`; `a VM sits in its NIC's subnet with its
  private IP and power state word`; `a peering to vnet-wg joins the peer VNet to the gateway node`; `provisioningState Failed is
  bad, Updating warn`; `rows outside the lab's groups are dropped` (ruling 16); `an unknown type is a generic card`; `the deny
  check passes on the output`. FAIL; implement `live.ts`, `rules/live.ts` (same core types), `query.ts`; PASS; commit. **Done
  when** the test file passes.
- [ ] **T0.6 Diff and rebase.** Tests first (`worker/test/topology-diff.test.ts`): each row of spec §7's table; `ghosts keep
  their planned parent by key`; `while deploying, missing reads Not deployed yet`; `rebaseSlot moves addresses and CIDRs inside
  10.71.192.0/18 only`. FAIL; implement `diff.ts`; PASS; commit. **Done when** the test file passes.
- [ ] **T0.7 The generator.** Tests first (`scripts/test/labs-topology.test.mjs`): `planFromTestStream takes resource_changes
  and output_changes from the test_plan message and fails without one`; `on a failed run only diagnostic messages are printed`
  (a fake terraform via the injectable `run`); `--check exits 1 naming a changed lab, a missing file and an orphan file`; `files
  are compared parsed, so CRLF never counts`; `pinnedHcl2json verifies the checksum before use` (fake download). (V) Vite's
  `runnerImport` (else `ssrLoadModule`); the Windows hcl2json asset and its SHA-256. FAIL; implement `scripts/labs-topology.mjs`,
  `scripts/lib/hcl2json.mjs`, `scripts/lib/topology-stream.mjs`, the npm script, `.gitattributes`
  (`shared/topology/planned/*.json text eol=lf`), CI step `npm run labs-topology -- --check` after `labs-tf` in the `labs` job;
  run it for all 40 labs; PASS; run it twice and `git diff --exit-code shared/topology/planned`; commit the 40 files. **Done
  when** `node --test scripts/test/labs-topology.test.mjs` passes, `npm run labs-topology -- --check` exits 0, and the second run
  changed nothing.
- [ ] **T0.8 The live route.** Tests first (`worker/test/labs-topology-route.test.ts`, harness with a fake ARM): Review Focus 2's
  names; `no live session answers not_running without a query`; `Azure not configured answers no_azure`; `ARM 500 answers failed
  with a plain message`; `429 answers throttled with the cached graph`; `two requests within 30 s make one query`; `two at once
  share one query`; `a new session is a new cache entry`; `the dev fixture is read only under AUTH_DEV_BYPASS when Azure is not
  configured`; `the response holds no raw properties`. FAIL; implement `worker/src/labs/topology.ts`, the route, the dev seed (lab
  6's rows, one hand-made NSG), `scripts/topology-capture.mjs` (with a test that it keeps only rule-read paths and fakes the
  subscription id); PASS; commit. **Done when** `npm test` passes.
- [ ] **T0.9 Saved layouts.** Tests first (`worker/test/prefs-topology.test.ts`): Review Focus 10's migration name; `GET answers
  version 0 and an empty layout when never saved`; `PUT stores, bumps the version and answers the page`; `a stale baseVersion is
  409 and changes nothing`; `an id outside the catalogue is 404`; `validation refuses unknown keys, v not 1, over 300 entries, a
  non-integer or out-of-range coordinate, a key with a quote, with the field`; `a body over 20 KiB is refused before parsing`;
  `GET /api/v1/prefs still answers the five widget pages only`; `layouts are per user`; `backup export leaves ui_prefs out`
  (existing test extended). FAIL; implement the migration, `shared/topology/layout.ts`, `worker/src/prefs.ts` functions and the
  routes; PASS; commit. **Done when** `npm test` passes and `npm run migrate -- --local` applies 0021 on a copy of the dev
  database.
- [ ] **T0.10 App plumbing and the contract.** Tests first (`web/src/views/labs/topology/stub.test.tsx`,
  `web/src/api/topology.test.ts`): `usePlannedTopology fetches the lab's hashed asset once and caches it`; `useLabTopology is off
  without a live session and refetches every 30 s only while mounted and visible`; `putTopologyLayout sends baseVersion and the
  layout`; `/labs/:id/diagram renders the labs page`; `the stub Canvas renders the List view's tree with health words`; `the
  dev-only /__topology/:id route draws a lab's planned graph in the tab, full and mini variants and is absent from the build`.
  Add `@xyflow/react` 12.12.0 exactly (`npm install --save-dev --save-exact`), `contract.ts`, `index.ts`, stub `Canvas.tsx`,
  `ListView.tsx`, `import.meta.glob` for the planned assets, the `__topology` route (`web/src/topologyGallery.tsx`, which T1
  may edit). FAIL; implement; PASS; commit. **Done when** `npm test`, `npm run
  typecheck` and `npm run build:web` pass and `ls web/dist/assets | grep -c '\.json$'` is 40 (or the build manifest lists 40
  planned assets).
- [ ] **T0.11 Budgets.** Tests first (`scripts/test/bundle.test.mjs`): `the JS limit is 450 kB`; `an entry file mentioning @xyflow
  or react-flow__ fails`; `a planned asset over 16 kB gzip fails`; `a sprite over 60 kB gzip fails`. FAIL; change
  `scripts/lib/bundle.mjs` and `scripts/bundle-size.mjs`; PASS; commit. **Done when** `npm run build:web && npm run bundle-size`
  passes and prints the topology chunk as lazy.
- [ ] **T0.12 Icons.** (V) the pack's current version, URL and terms on the official page. Tests first
  (`scripts/test/topology-icons.test.mjs`): `the optimiser keeps every path and the viewBox and prefixes every id`; `every KINDS
  icon is a symbol in the sprite, plus generic`; `the README quotes the terms with the link and names the pack version`. Run
  `node scripts/topology-icons.mjs` (downloads into the scratchpad, never the repo); FAIL then PASS; commit the sprite and
  README. **Done when** the test passes and the sprite is under 60 kB gzip.
- [ ] **T0.13 Contract check.** This names section rewritten "as built"; the spec's §3 corrected to what was built (both files);
  gate plus `labs-topology -- --check`; CI green on a draft PR. Push; send the areas the commit id and this section. **Done when**
  CI's jobs are green on the draft PR and each area has the commit id.

## T1: Canvas, nodes and layout

**Branch:** `feat/lab-topology-canvas`. **Owns:** `web/src/topologyGallery.tsx`, `web/src/views/labs/topology/**` except `index.ts`, `contract.ts` and T2's
files (`data.ts`, `useTopologyLayout.ts`, `DiagramTab.tsx`, `FullScreen.tsx`, `LabMini.tsx`, `places.test.tsx`). **Consumes:**
the T0 names; `CanvasProps`, `ToolbarProps`, `DetailsProps`; the sprite; the app's tokens and `Sheet`/`SidePanel`.

Each step: tests first in `web/src/views/labs/topology/*.test.tsx` (jsdom with `ResizeObserver` and `DOMMatrixReadOnly`
stand-ins in the file's setup) or `layout.test.ts`; FAIL; implement; PASS; commit.

- [ ] **T1.1 Packing layout** (`layout.ts`): Review Focus 3's T1 names plus `subnet columns are min(3, ceil(√n))`, `VNets order
  subnets by numeric prefix`, `root order is gateway, Global, primary RG, secondary RGs, Tenant`, `an empty subnet is 232 × 72`.
  **Done when** `npx vitest run web/src/views/labs/topology/layout.test.ts` passes.
- [ ] **T1.2 Stacks and the 300 limit:** Review Focus 4's T1 names; `a stack card lists its members in the details`. **Done
  when** its tests pass.
- [ ] **T1.3 Group and asset nodes** (`nodes/*.tsx`, `topology.css`): `an RG shows region, role and tag chips`; `a subnet shows its
  prefix and NSG, route table and delegation chips`; `an asset card shows icon, name, type word, its KINDS card props and a
  health word`; `databases show status as the large chip`; `badges read Added by hand, Made by Azure, Not deployed or removed,
  Not listed by the live view`; `ghosts are dashed and faded`. **Done when** its tests pass.
- [ ] **T1.4 Edges** (`edges/*.tsx`): `traffic edges are smoothstep with their label`; `each edge meets the nearest sides of its
  nodes` (pure `floatingEnds(a, b)` tested); `dependency edges are dashed, not focusable and hidden when showDependencies is
  false`; `no edge animates by default or under reduced motion`. **Done when** its tests pass.
- [ ] **T1.5 The real Canvas** (`Canvas.tsx` replaces the stub behind `CanvasProps`): React Flow with `parentId`, `extent:
  "parent"`, `expandParent`; `colorMode` from the app theme; `base.css` only; `a drag end calls onMove with the relative position
  and parent key`; `arrow keys move a selected node and call onMove`; `fit view on first render, instant under reduced motion`;
  `the mini variant has no pan, zoom, drag or edge labels`; `the sprite is fetched once and inlined`. **Done when** its tests
  pass and `npm run build:web && npm run bundle-size` passes.
- [ ] **T1.6 Details panel** (`Details.tsx`): `it lists props with copy buttons for IPs, connections in and out, folded
  resources, the badge's meaning`; `Open in Azure portal appears for live nodes only, with the resource id link`; `Escape
  closes it and returns focus to the node`; `on the phone it is a Sheet`. **Done when** its tests pass.
- [ ] **T1.7 Toolbar, search and legend** (`Toolbar.tsx`, `Legend.tsx`): `search dims non-matches and Enter fits to matches`;
  `the legend shows only the kinds present and the badges in use`; `MiniMap and Controls appear in the full variant only, no
  MiniMap on the phone`; `Animate traffic is off by default and disabled under reduced motion`. **Done when** its tests pass.
- [ ] **T1.8 Accessibility and List view** (`ListView.tsx` finished): `every node has an accessible name with kind, name,
  parent, health and key prop`; `traffic edges have names`; `the List tree has the same words and connections`; `axe finds no
  violation in the tab and full variants` (jest-axe if present, else role and name checks). **Done when** its tests pass.
- [ ] **T1.9 Pictures.** The tab is T2's, so T1 shoots the dev-only route: the dev API on a free port (`PORT=88xx node
  scripts/dev.mjs --api`, stopped by its PID) and `npm run dev:web`, then `node scripts/shots.mjs --scenario labs --base
  http://localhost:5173 --api http://localhost:88xx --routes /__topology/az104-06-blob-security,/__topology/az700-40-lb-advanced,/__topology/az104-09-vmss,/__topology/az700-39-vwan-secured-hub,/__topology/az305-20-landing-zone
  --sizes 1600x900,1100x600,390x844` in both themes (the last one shows the Tenant lane). Look at every picture;
  fix overlaps, clipped labels and contrast. **Done when** the shots exit 0 and the report lists each picture checked.
- **Done when (area):** the gate passes.

## T2: Placements and persistence

**Branch:** `feat/lab-topology-places`. **Owns:** `web/src/views/labs/{LabModal,RunningLab,PhoneLabs,index}.tsx`,
`web/src/views/labs/labs.css`, `web/src/views/labs/{modal,running,phone}.test.tsx`,
`web/src/views/labs/topology/{data.ts,useTopologyLayout.ts,DiagramTab.tsx,FullScreen.tsx,LabMini.tsx,places.test.tsx}`,
`web/src/views/overview/{Topology.tsx,Topology.css,LabMiniHover.tsx}`, `web/src/views/overview/labs.test.tsx`. **Consumes:**
the T0 names; T1's components only through `contract.ts` (until T1 merges, T0's stub Canvas and ListView).

Same step shape as T1 (tests first, FAIL, implement, PASS, commit).

- [ ] **T2.1 Data hook** (`data.ts`): `useDiagramData(labId, session)` → `{ graph, status, source, banner, loading }`: `idle: the
  planned graph with the example-addresses note`; `running: live merged with ghosts, planned rebased to the session's slot for
  the Planned toggle`; `no_azure, failed and throttled show the planned graph with the banner's words`; `truncated adds its
  banner`; `the planned file failing to load shows an error with Try again`. **Done when** its tests pass.
- [ ] **T2.2 Saved layout** (`useTopologyLayout.ts`): the widgets' save tests, for a lab: `a drag saves once after 600 ms`;
  `moves during a save are sent after it with the new version`; `a failed save reverts and toasts`; `a 409 refetches and says
  Changed on another device`; `Reset layout saves an empty layout`; `a layout that failed to load is never saved over and the
  note says so`; `the hidden-tab flush sends the pending save`. **Done when** its tests pass.
- [ ] **T2.3 The Diagram tab** (`DiagramTab.tsx`, `LabModal.tsx`, `RunningLab.tsx`): `the idle and running panels show Readme
  and Diagram tabs`; `?view=diagram opens Diagram and switching tabs updates the URL without a new history entry`; `the diagram
  chunk loads only when the Diagram tab first opens` (lazy import observed); `the Live/Planned toggle appears only while a session
  is live`; `the dependency toggle and Diagram/List choice are remembered on this device`. **Done when** its tests pass.
- [ ] **T2.4 Full screen** (`FullScreen.tsx`, `index.tsx`): `/labs/:id/diagram shows the header, canvas, minimap and details`;
  `Close returns to /labs/:id keeping the search`; `the full-screen link from the tab opens it`; `a lab id outside the catalogue
  shows the existing could-not-open notice`. **Done when** its tests pass.
- [ ] **T2.5 Phone** (`PhoneLabs.tsx`, `labs.css`): `the lab sheet has Readme and Diagram tabs`; `the canvas is at most 60vh`;
  `details open as a Sheet`; `full screen works at 390 px`. **Done when** its tests pass.
- [ ] **T2.6 Overview hover** (`LabMiniHover.tsx`, `Topology.tsx`): `hovering a running lab's box for 400 ms opens the mini
  diagram`; `keyboard focus opens it and Escape closes it`; `the box is still a link to the lab`; `no mini on a hover-less
  device`; `the entry does not import the diagram chunk` (the hover wrapper lazy-imports `LabMini`); `failed live data shows the
  planned graph in the mini with a word`. **Done when** its tests pass and `npm run build:web && npm run bundle-size` passes.
- [ ] **T2.7 Badges end to end:** `a hand-made live node shows Added by hand in the tab, the full screen and the mini`; `a
  deleted planned node shows Not deployed or removed`; `deploying shows Not deployed yet`; `an NSG chip disappearing from a
  subnet after a refresh does not move any saved node`. **Done when** its tests pass.
- [ ] **T2.8 Pictures and the one-screen rule.** As T1.9 (labs scenario; the routes of spec §12 plus `/labs/az104-06-blob-security/diagram`),
  and `npm run shots -- --scenario labs --routes /,/labs,/labs/history` diffed against a `main` baseline (`shots:diff` zero
  pixels on `/`, `/labs/history`; `/labs` and the modal change only by the tab bar). **Done when** every shot exits 0, the diffs
  are as stated, and the report lists each picture checked.
- **Done when (area):** the gate passes.

## T3: Coverage across the 40 labs

**Branch:** `feat/lab-topology-coverage`. **Owns:** `shared/topology/rules/**`, `shared/topology/props.ts` (additions only, each
passing the deny-name test and reported for the spec table), `shared/topology/planned/**` (regenerated, never edited),
`worker/test/topology-golden.test.ts`, `worker/test/topology-live-*.test.ts`, `worker/test/fixtures/topology/**`. **Consumes:**
the T0 names; `scripts/test/fixtures/labs/plans/shapes/*.json`; the lab folders (read only).

Each family step: tests first (planned rules against each named lab's committed graph after regeneration; live rules against
realistic row fixtures per ARM type in `worker/test/fixtures/topology/live/<family>.json`, written from Learn's REST
references (V each shape's source in the report)); FAIL; extend `rules/planned.ts` and `rules/live.ts`; `npm run labs-topology
-- <labs>`; PASS; commit. Every family step also adds its labs to the **round trip** (`rowsFromPlanned(graph)` in the test
helper turns a planned graph into realistic rows with the family's templates; `liveGraph` of them diffed with the planned graph
has no `added` or `missing` node).

- [ ] **T3.1 Network core** (labs 6, 7, 8, 13, 14, 15, 17, 31, 32, 35): VNets, subnets and chips (NSG, route table, delegation,
  NAT gateway, service endpoints, default outbound), peering (one edge per pair, state), route next hops to VMs, NAT gateway and
  prefixes, public IPs folded into owners, DNS zones and private zones with links, resolver, endpoints, ruleset and the DNS
  forward edge. **Done when** the family's tests and round trips pass.
- [ ] **T3.2 Delivery** (labs 16, 27, 40, 41, 42): LB rules, NAT and outbound rules with port labels, Gateway LB chain, global
  LB in the Global lane over two regions, App Gateway listeners and backends, WAF policies, Front Door profile with origins
  (Private Link origin to the PLS), Traffic Manager endpoints. **Done when** its tests and round trips pass.
- [ ] **T3.3 Hybrid and hubs** (labs 33, 34, 36, 37, 38, 39): VPN gateways, local network gateways, connections (IPsec, BGP,
  `connectionStatus`), P2S pool prop, firewall and policies (base → child), Route Server with the BGP edge, Virtual WAN, virtual
  hub as a group with its firewall and hub connections, routing intent, AVNM manager with member dependency edges and live
  `ANM_` peerings made by Azure. **Done when** its tests and round trips pass.
- [ ] **T3.4 Private access and data** (labs 5, 6, 22, 23, 24, 25, 43): private endpoints with group id and approval state,
  Private Link service → LB, storage (counts, public access), SQL servers, databases (status prominent) and the failover group,
  Cosmos, Key Vault (counts) with access-policy and role edges, managed identities, the service endpoint policy as a subnet chip.
  **Done when** its tests and round trips pass.
- [ ] **T3.5 Compute and containers** (labs 7, 8, 9, 11, 18, 19, 26, 27): VM sizes and power words, data disks folded, VMSS as
  one card with autoscale, container groups (VNet-injected and public), container apps and environment, registry, recovery
  vaults with backup and replication edges, site-recovery children folded. **Done when** its tests and round trips pass.
- [ ] **T3.6 Governance and monitoring** (labs 1, 2, 3, 4, 18, 20, 21, 44): management groups and policy in the Tenant lane,
  RG-scoped policy assignments in their RG, role definitions and assignments, Entra users and groups (planned only), locks and
  budgets as RG chips, Log Analytics, alerts, action groups, data collection rules, diagnostic setting edges, lab 44's flow log
  as scope outside, Bastion and its subnet. **Done when** its tests and round trips pass.
- [ ] **T3.7 Hand-made and Azure-made:** Review Focus 5's T3 names; one fixture per lab family with a hand-made resource of a
  known type and one of an unknown type; `AZURE_MADE` has a test per pattern. **Done when** its tests pass.
- [ ] **T3.8 Golden suite for all 40 labs** (`worker/test/topology-golden.test.ts`): for every lab folder, `<id>: the planned
  graph exists, is fresh for its lab.yaml version and passes the deny check`; `<id>: every resource address in its Terraform is
  represented` (from the committed graph's ids, folds and vias against the lab's `.tf` resource blocks, instance counts from the
  plan fixture where there is one); `<id>: every address in its recorded real plan shape is represented` (labs with a shape);
  `<id>: the expected kinds and edges` (a short table per lab in the test, written from its readme's "What it deploys");
  `<id>: the planned file is under 16 kB gzip`. Regenerate all 40 and run `--check`. **Done when** `npm test` and `npm run
  labs-topology -- --check` pass and the report has the per-lab node and edge counts.
- **Done when (area):** the gate passes, plus `npm run labs-topology -- --check`.

---

## Integration

1. **Merge** onto `feat/lab-topology` in the order T3, T1, T2 (`--no-ff`), running the gate after each. A conflict means an
   area edited a frozen file: reject that change or fold it into T0's files. Then rewrite T0's stub tests that T1 replaced.
   **Done when** the gate passes after the third merge.
2. **Full gate:** `npm test`, `npm run typecheck`, `npm run build:web`, `npm run bundle-size` (record entry, all JS, CSS, the
   topology chunk and the largest planned asset), `npm run labs-topology -- --check`, `npm run labs-tf`, `npm run labs-check`;
   CI green on a draft PR. **Done when** all exit 0, JS is at most 450 kB and CI is green.
3. **Whole-branch review.** A fresh opus reviewer gets this plan, the spec and the diff. Ask about: the Review Focus list; the
   KQL text and the `ownsName` re-check; every `PROP_NAMES` entry; the generator's handling of the stream; migration 0021; the
   save discipline; the lazy boundaries; the round-trip tests' honesty (templates not tidier than Learn's shapes). **Done when**
   the findings are listed in the PR.
4. **One fix pass,** test-first, then step 2 again. **Done when** step 2 passes again.
5. **Screens.** The spec §12 shots at 1600×900, 1100×600 and 390×844, dark and light, from the integrated build, and
   `shots:diff` against a `main` baseline for `/`, `/clients`, `/firewall`, `/activity`, `/cost`, `/labs/history` (zero
   differing pixels). Look at every diagram picture. **Done when** every shot exits 0, the diffs are zero and the PR lists the
   pictures checked.
6. **Merge and deploy (pre-approved).** Read `SELECT COUNT(*) FROM ui_prefs` (`npx wrangler d1 execute wg-admin --remote
   --command`, read only); PR → `main`, CI green, merge; `npm run deploy-worker` (applies 0021); read the count again (equal, else
   STOP). **Done when** `GET /api/v1/labs/az104-13-vnets/topology` answers `not_running` and the Labs tab shows a planned
   Diagram for any lab in production.
7. **Live check 1 (≤ £2 in all; pre-approved).** From the dashboard, deploy `az104-14-peering-udr` for 1 hour (peered only if the
   gateway is already running). When it is Running: open its Diagram. A 403 from Resource Graph is a **STOP** (permission). Check:
   status ok; three VNets with their subnets; peerings with state; next-hop edges to the router VM; VM power words; no "added by
   hand"; Live/Planned show the same keys; a drag syncs to the phone (open the lab on the phone, see the arrangement); Reset
   layout. Capture the rows with `node scripts/topology-capture.mjs az104-14-peering-udr` (read only, free) into
   `worker/test/fixtures/topology/live/captured/`. Record each (V) of spec §6.1. Tear down from the dashboard. **Done when** the
   checks are in the PR, the session ended clean and the captured fixture's test passes.
8. **Live check 2.** Same for `az700-43-private-link`, then by hand (the signed-in `az`, inside the lab's group only): `az network
   nsg create -g rg-lab-az700-43-private-link -n nsg-handmade` (free) and `az network private-endpoint delete -g
   rg-lab-az700-43-private-link -n pe-svc`; within 30 s the diagram shows **Added by hand** on `nsg-handmade` and **Not deployed or
   removed** on `pe-svc`; the Overview hover shows the same. Capture, tear down (the group delete takes both). If the signed-in
   identity cannot write the group, skip the two hand changes and note it (no stop, no role change). **Done when** the checks
   are in the PR, the session ended clean and the spend tally (Cost tab, next day) is under £2.
9. **Live fixes.** Any difference found in steps 7–8: a failing test from the captured rows first, then the fix (T3's rules),
   regenerate if planned rules changed, gate, merge, `npm run deploy-worker`, and recheck on the captured fixtures (no new spend
   unless a fix needs a real lab: then within the £2 tally). **Done when** the captured fixtures pass and production matches.
10. **Outcome.** Write the outcome below (bundle figures, every (V) answer, the two labs' findings, the spend, anything parked).
    **Done when** it is committed and pushed.

## Final review checklist

- **Every lab** (40) has a committed, fresh, secret-free planned graph that represents every resource; CI checks it.
- **Live:** one Resource Graph query per refresh, only the lab's groups, rows re-checked, 30 s cache, no KV writes, no raw
  properties out; banners for every failure; badges right on two real labs.
- **Layout:** deterministic; saved per lab in `ui_prefs` (migration 0021, rows kept); synced; reset; new nodes never land on
  saved ones.
- **UI:** Diagram tab (idle, running, phone), full screen, Overview hover mini; legend, search, details with the portal link;
  List view; keyboard; reduced motion; light and dark; shots clean; other pages pixel-identical.
- **Budgets:** entry ≤ 320 kB, JS ≤ 450 kB, CSS ≤ 50 kB, planned files ≤ 16 kB each, sprite ≤ 60 kB; no `@xyflow` in the entry.
- **Icons:** only the official pack, terms in the README beside the sprite.
- **No change** to the lab folders, versions, gateway, `wg.yml`, `lab.yml`, permissions or subscription settings; spend under
  £2; `.env` never read.

## Outcome

To be written by the integrator after integration step 10.
