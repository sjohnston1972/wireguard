# wg-admin Labs: topology diagram (design)

Date: 2026-10-06. Status: design **approved by Steven end to end in conversation on 2026-10-06**; the details below are
decided here under his pre-approval (§3 lists every decision made while writing, as rulings). Builds on
`docs/superpowers/specs/2026-10-04-labs-design.md` (the labs spec, binding, with its §16–§17 rulings 1–61) and
`docs/superpowers/specs/2026-10-03-widgets-design.md` (the `ui_prefs` mechanism), as on `main` at 8243fab (40 lab folders:
1–9, 11–27, 31–44; lab 10 is parked and not on `main`). The plan is `docs/superpowers/plans/2026-10-06-lab-topology-plan.md`.
**(V)** marks a fact to check during the build (the official page, the npm registry, or one live call at integration); the area
reports record the answer.

## 1. Intent

Every lab gets a **read-only, explorable architecture diagram**: resource groups, VNets, subnets and the resources in them, with
the traffic paths and dependencies between them, drawn with Microsoft's own Azure icons. It is there **before deploy** (the
*planned* diagram, made offline from the lab's Terraform) and **while the lab runs** (the *live* diagram, read from Azure every
30 seconds, including anything the learner added by hand). It answers "what does this lab build?" before spending a penny, and
"what is actually there now?" during the session.

Where: a **Diagram** tab beside the readme in the lab panel (idle and running, desktop and phone), a **full-screen** view, and a
**mini diagram** when hovering a running lab's box on the Overview topology.

Non-goals: it is **not an editor** (nothing is created, changed or deleted from it; dragging only tidies the picture); no
cost per node; no traffic metrics or flow animation from real data; no diagram export. No new Azure permission, no change to the
gateway, `wg.yml`, `lab.yml`, the lab Terraform or the lab versions.

## 2. Decisions (approved by Steven, 2026-10-06)

| Topic | Decision |
|---|---|
| Purpose | Read-only explorable diagram per lab; planned before deploy, live while running (hand-made resources included). |
| Placement | "Diagram" tab beside the readme (idle and running); full-screen view; mini diagram on hover of a running lab's Overview box. |
| Layout | Automatic; the user drags to tidy; the arrangement is remembered **per lab, synced** through `ui_prefs` (positions keyed by a stable node key, so they carry between planned and live); **Reset layout**; new nodes placed automatically. |
| Library | **React Flow** (`@xyflow/react`, MIT) with a **custom nested tree layout** (no ELK): strict tree RG → VNet → subnet → asset; deterministic, unit-tested packing. Lazy-loaded, never in the entry; total JS budget **400 → 450 kB** gzip (entry 320 kB unchanged). |
| Model | `TopologyGraph { labId, version, source: "planned" \| "live", at, nodes: [{ id, key, kind, parent?, label, props }], edges: [{ id, from, to, kind: "traffic" \| "dependency", label? }] }` in `shared/` (extended in §4.1). |
| Kinds | Groups: resource group (region, tags, secondary badge), VNet (address space), subnet (prefix; NSG, route table, delegation as chips), virtual hub. About 35 asset kinds (§4.3), plus unknown/generic: **never drop a resource**. Subnet-attached resources inside their subnet; regional non-subnet resources in their RG; global ones (Front Door, Traffic Manager) in a "Global" lane; the WireGuard gateway VNet as a fixed greyed node only when the lab is peered. |
| Edges | Traffic (solid, port labels where known): LB frontend → backends and NAT rules, App Gateway / Front Door / Traffic Manager → backends, VPN connections, VNet peering, route-table next hops (subnet → appliance "0.0.0.0/0"), private endpoint → target. Dependency (dashed, non-interactive, can be hidden): managed identity role → resource, diagnostic setting → Log Analytics, vault → protected VM, and so on. |
| Planned data | Generated **offline from a mock-provider Terraform plan** (the labs-tf mechanism): configured values are real; references give edges. Written by `npm run labs-topology` to a folder **outside** `labs/<id>/` (no version bumps), keeping only an **allow-list of non-secret attributes**; a CI test regenerates and fails if stale; the app loads one lab's file on demand. All 40 lab folders. |
| Live data | `GET …/labs/:id/topology` in the Worker: **one Azure Resource Graph query**, scoped strictly to `rg-lab-<id>` and `rg-lab-<id>-*`; edges derived from properties; the same allow-list; health from provisioning state, VM power state and Resource Health where the insights feeds have it; 30 s cache; refetch while the panel is open; Azure subrequest conventions; falls back to the planned graph with a banner; "added by hand" and "not deployed / removed" badges. |
| UI | RG dashed with translucent fill; VNet Azure-blue border; subnet a lighter nested container that grows to fit; asset cards ~200×84 (icon, name, type, 1–2 key props, health chip; databases prominent); four-sided handles with nearest-side edges; smoothstep traffic edges with labels; dashed dependency edges with a hide toggle; details side panel (props, copy IP, "Open in Azure portal"); legend; search/highlight; minimap and controls in full screen; planned/live toggle while running; `prefers-reduced-motion` respected (no animated edges by default); keyboard-focusable nodes and a "List" view; phone pan/zoom/touch; light and dark through the CSS tokens. |
| Icons | Official **Microsoft Azure Architecture Icons** (their terms permit architecture diagrams), downloaded in the build area, only the ~40 needed, optimised into one sprite in the repo with the terms in a README beside it; a generic fallback icon. |
| Spend | At most **£2** of Azure for the live check on a couple of running labs; nothing else. Merge and deploy pre-approved. STOP only for a permission or identity change, a subscription setting, or anything unexpected. |

## 3. Decisions made while writing this spec (rulings)

1. **Values from the mock plan, references from the HCL source.** `terraform test -verbose -json` (Terraform 1.14.6) emits one
   `test_plan` message whose plan has `resource_changes` (each instance's `change.after` and `after_unknown`), `output_changes`
   and `provider_schemas` but **no `configuration` block**, so it carries no references (checked 2026-10-06 on lab 35: the
   NIC's `subnet_id` is only `after_unknown: true`). The generator therefore takes **values** from the mock plan and
   **references** from the lab's HCL through hcl2json and `infra/ci/lab-scope.mjs`'s existing `hclResources(hcl, labId)` (the
   per-attribute `refs` the HCL scope check already uses), joined on the configuration address (`type.name`, instance keys
   stripped). The brief's "references give edges" holds; their source is the HCL, not the plan JSON.
2. **The plan stream holds the mock admin password and the provider schemas (3.3 MB for lab 35).** The generator reads it in
   memory only, never prints it or writes it anywhere (on failure it prints only the stream's `diagnostic` messages), and keeps
   only the allow-listed props (§4.5).
3. **hcl2json is pinned** (v0.6.9, the version and checksum CI already installs) and fetched by a new `scripts/lib/hcl2json.mjs`
   the way `scripts/lib/bicep.mjs` fetches Bicep (official release, per-OS SHA-256 checked before every use, cached), so the
   generator runs on Windows as well as CI. (V) the Windows asset name and its checksum.
4. **Files:** code in `shared/topology/*.ts`; generated graphs in `shared/topology/planned/<id>.json` (one per lab folder,
   committed, LF line endings via `.gitattributes`). The app loads them as **hashed static assets** (`import.meta.glob(…, {
   query: "?url", import: "default" })` then `fetch`), not as JS chunks: 40 dynamic-import chunks would count against the JS
   budget, a JSON asset does not. A new bundle check caps each at 16 kB gzip.
5. **The generator runs the TypeScript builder through Vite's module runner** (`runnerImport` from `vite`, else
   `createServer().ssrLoadModule`; (V) which), because scripts are `.mjs` and `shared/` is TypeScript imported without
   extensions. No new dependency, and the builder stays one pure function shared with the tests.
6. **Node key** (positions and planned/live matching): `<arm type>/<name path>`, lower case, with the session's name prefix
   replaced by `{p}`, its region by `{r}` and its secondary region by `{r2}` (the mock plan uses `l<NN>k3x9q`, `uksouth`,
   `ukwest`). A child's name path includes its parent's (`microsoft.network/virtualnetworks/subnets/vnet-hub/snet-app`). Two
   nodes with the same key in one graph get `#<group suffix>` (`#secondary`), deterministically. Synthetic nodes: `lane/global`,
   `lane/tenant`, `wg/gateway`.
7. **Model additions** beyond the approved shape (all optional on nodes, so the approved fields are unchanged): `schema` (1)
   on the graph; on a node `armType`, `scope` (`"lab"` or `"outside"`: planned resources outside the lab's groups), `health`,
   `folded` (the resources drawn inside this card) and `madeBy: "azure"`; on an edge `via` (the resource that makes it: a
   peering, a connection, a role assignment) and `state`. `version` is the lab version (planned: `lab.yaml`'s at generation;
   live: the session's `labVersion`); `at` is null for planned and the fetch time for live.
8. **Folding and edge resources.** A card stands for its resource and the sub-resources that only make sense inside it (§4.4):
   a VM's NICs, disks and extensions; an LB's pools, rules, probes and NAT/outbound rules; and so on. Resources that *connect*
   things (peerings, VPN and hub connections, zone links, BGP connections, role assignments, diagnostic settings, access
   policies, associations) are drawn as edges with `via`. A resource is "represented" when it is a node, in a `folded` list, or
   an edge's `via`; tests prove every planned address and every live row is represented (ruling "never drop").
9. **Public IPs attached to an owner fold into the owner's card** (an LB frontend, App Gateway, VPN gateway, Bastion, firewall,
   Route Server, NAT gateway); the card shows the address. An unattached public IP and every public IP prefix are cards.
10. **VNet-attached placement:** a resource bound to a VNet but no subnet (DNS Private Resolver, Bastion Developer) sits inside
    the VNet container below its subnets. The tree stays strict.
11. **Lanes.** The **Global** lane holds resources whose location is `global` (Front Door, Traffic Manager, public DNS zones,
    Front Door WAF policies) and global-tier load balancers; each card names its RG. Private DNS zones (also `global`) stay in
    their RG. A **Tenant** lane holds what lives above the subscription's groups: management groups, policy and role
    definitions, management-group policy assignments and Entra users and groups (planned only).
12. **What one query cannot see is never "not deployed".** Each kind says whether the live query lists it (`liveVisible`):
    policy and role objects, management groups, Entra principals, locks, budgets, diagnostic settings and resources outside the
    lab's groups (lab 44's flow log in `NetworkWatcherRG`) are planned-only and say "Not listed by the live view".
13. **"Made by Azure", never "added by hand",** for a live resource Terraform does not declare when Azure made it: `managedBy`
    set, an Azure-named child (a private endpoint's NIC, a VM's OS disk), a lab group Azure created, everything in such a
    group, or a known pattern (traffic analytics' `NWTA*` data collection rule and endpoint, AVNM's `ANM_` peerings). A group
    is Azure's only when a row of the same graph says so, never by its name: an AKS cluster's `nodeResourceGroup` (lab 29's
    `rg-lab-<id>-nodes`), a Container Apps environment's `infrastructureResourceGroup` (lab 28's `rg-lab-<id>-infra`), or
    the group's own row with `managedBy` set (the query projects it for groups too). A learner's hand-made
    `rg-lab-<id>-managed`, and what is in it, is "Added by hand". The patterns are one list in
    `shared/topology/rules/live.ts` (`AZURE_MADE`, with `azureMadeGroups`), each with a test.
14. **Health without new calls.** The insights feeds read Resource Health for `vm-wg` only, so no lab resource has a Resource
    Health record and none is fetched. Health = `provisioningState`, plus the VM power state from Resource Graph's
    `properties.extended.instanceView.powerState` (V), plus per-type status already in the properties: SQL database `status`,
    VPN connection `connectionStatus`, peering `peeringState`, private endpoint connection status (lab 42's "Pending" approval
    shows on its edge), App Gateway `operationalState`.
15. **Route and cache.** `GET /api/v1/labs/:id/topology` (the house prefix). It always answers 200 with a status (§6.6). Cache:
    isolate memory, 30 s per lab and session, with in-flight requests coalesced; **no KV writes** (a panel open for an hour
    would spend 120 of KV's daily writes). The app refetches every 30 s only while a diagram is visible.
16. **Scope, belt and braces.** The query names the subscription (`subscriptions: [AZURE_SUBSCRIPTION_ID]`) and filters
    `resourceGroup =~ 'rg-lab-<id>' or resourceGroup startswith 'rg-lab-<id>-'` with `<id>` a catalogue id (so `LAB_ID_RE`
    holds and nothing can be injected); the Worker then drops every row whose group fails `ownsName(id, resourceGroup,
    catalogueIds)`, so a longer lab id that shares the prefix can never leak in. No other filter form is allowed.
17. **Layout prefs live in `ui_prefs`** as one row per lab, `page = 'topology:<labId>'`. The table's CHECK allows only the five
    widget pages, so migration `0021_ui_prefs_topology.sql` rebuilds it with a widened CHECK, every existing row kept (tested).
    The rows inherit `ui_prefs`' handling for free: per identity, optimistic `version`, never in the backup export, audit or
    change log, wiped by the dev seeder. Own routes (§8.3), since `GET /api/v1/prefs` answers the widget pages only.
18. **Per-device, not synced:** the dependency-edge toggle and the Diagram/List choice (`localStorage` `wg.topology.v1`, every
    access in try/catch). Only the arrangement syncs.
19. **Big labs.** More than 8 assets of one kind in one container become one stack card ("12 × VM") whose members are listed in
    the details panel; a VMSS is one card with its instance count (flexible-orchestration VMs fold into it). A graph over 300
    nodes opens in the List view with a note, the diagram one click away.
20. **Icons** come as one optimised sprite (`web/src/views/labs/topology/icons/azure.svg`), a hashed asset fetched once and
    inlined into the page hidden, because the icons' gradients only render reliably through same-document `<use>` references;
    each icon's ids are prefixed with its name. A small built-in optimiser (no new dependency) keeps shapes untouched (the
    terms forbid distortion).
21. **Chunks:** the diagram is its own lazy chunk (`@xyflow/react` and the topology code), loaded by the labs tab's Diagram tab,
    the full-screen route and the Overview hover; never in the entry, never in the labs chunk itself. The bundle check fails if
    an entry file contains `react-flow__` or `@xyflow`.
22. **Tags:** an RG chip shows the `lab` and `project` tag values only; other tags are counted ("+2 tags"), never shown (a
    learner's tag could hold anything). Child collections (Key Vault secrets and certificates, storage containers and shares,
    Cosmos containers, firewall rules) are **counts**, never names.
23. **Addresses:** planned graphs carry slot 31's addresses (`10.71.192.0/18`, the mock plan's). `rebaseSlot(graph, cidr)` moves
    every IPv4 address and CIDR inside that /18 into a session's /18, so the planned view of a running lab shows its real
    numbers; an idle lab's planned view says "Example addresses (slot 31); each session gets its own /18."
24. **Bicep labs** (lab 12 today): the plan has the template deployment with its compiled template (known at plan). The
    generator expands its resources with a minimal ARM evaluator (`parameters()`, `variables()`, `format()`, `concat()`,
    `resourceGroup().location`, `resourceId()`, copy loops over array parameters, nested `Microsoft.Resources/deployments`
    with inline templates); anything else fails the generator with the expression named, so a new Bicep lab cannot silently
    lose resources. The template deployment itself is folded into its RG.
25. **URLs:** the tab is `?view=diagram` on `/labs/:id` (shareable, shot-able); the full-screen view is `/labs/:id/diagram`.
26. **Dev and shots:** scenario `labs` seeds Resource Graph rows for the running lab 6 (one of them "hand-made") into KV
    `labs:topology:dev`, read only when `AUTH_DEV_BYPASS = "1"` and Azure is not configured, so the shots show a live diagram
    with no Azure. A dev-only route `/__topology/:id` (like `/__gallery`, absent from the built app) draws any lab's planned
    graph in each variant, so the canvas can be seen and shot before it is placed in the lab panel.
27. **Live check labs:** `az104-14-peering-udr` (three VNets, peerings, route tables: next-hop edges; £0.033/h) and
    `az700-43-private-link` (Private Link service, two private endpoints, internal LB, storage, zone, policy; £0.056/h), one hour
    each from the dashboard, unpeered unless the gateway is already running. A free NSG made by hand in lab 43's group checks
    "added by hand"; deleting `pe-svc` by hand checks "not deployed / removed". Likely £0.10, worst £0.50 with a retry.

**As built at T0** (`feat/topo-engine`; the plan's names section lists every name). The rulings hold, with these
corrections and (V) answers:

- Ruling 1: references are per **top-level** attribute (lab-scope's `hclResources`), stripped to `type.name` and resolved to
  instances by matching instance key; outputs' references come from hcl2json's `output` blocks (`output.<name>`).
- Ruling 2: the stream reader keeps only managed resources' `address`, `type`, `name`, `index`, `after` (sensitive paths,
  secret-named attributes, nulls and the mock secrets removed) and `after_unknown`, and the outputs in `PLAN_OUTPUTS`
  (`peer_vnet_id`); a failed run prints only the stream's diagnostics, redacted.
- Ruling 3 (V): the Windows asset is `hcl2json_windows_amd64.exe`, SHA-256 `be798d4c…d4f4f`. CI passes `HCL2JSON` (its
  installed copy), used only when it matches the pin.
- Ruling 5 (V): `runnerImport` from Vite 8.3.2.
- Ruling 7: one more asset kind, **`gateway`** (the synthetic `wg/gateway` node); `TopoFolded` is a named type.
- Ruling 22 and §4.5: Key Vault secrets, keys and certificates fold into the vault labelled `secret`, `key`, `certificate`
  (never their names) and are counted (`secrets: 2`). The deny check applies `secretLike` to props and a narrower
  `secretValue` (no bare "password"/"secret" words) to names, ids, edge labels and notes, so a role named "Key Vault
  Secrets User" or a resource named `kv-password-policy` is a name, not a withheld secret; a `counts` entry of the form
  "word: number" is allowed.
- §6.2 / ruling 14: live resource groups carry no region or tags (the `resources` table has no group rows); a succeeded
  provisioning state reads "Ready".
- §9.1 and ruling 21: the app's topology hooks live in `web/src/api/topology.ts`, imported only by the lazy chunk, so the
  entry never carries them; `views/pages.tsx` declares `LabDiagramTab` so every build carries the chunk and its planned
  assets.
- §10 (V): pack **V24** (`https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V24.zip`); six icons are the
  nearest official match (listed in `icons/README.md`).

## 4. The graph model (`shared/topology/`)

### 4.1 Types (`model.ts`)

```ts
export const TOPOLOGY_SCHEMA = 1;
export type TopoSource = "planned" | "live";
export type TopoGroupKind = "resourceGroup" | "vnet" | "subnet" | "virtualHub" | "lane";
export type TopoKind = TopoGroupKind | TopoAssetKind;                 // TopoAssetKind: §4.3
export type TopoTone = "ok" | "warn" | "bad" | "unknown";
export interface TopoHealth { tone: TopoTone; word: string }          // "Running", "Stopped", "Failed", "Pending approval", "No data"
export type TopoPropValue = string | number | boolean | string[];
export interface TopoNode {
  id: string;                    // unique in the graph: planned "tf:<address>", live the ARM id in lower case
  key: string;                   // stable across planned and live (ruling 6)
  kind: TopoKind;
  parent?: string;               // a group node's id; absent at the root
  label: string;                 // the resource name as shown (planned: prefix shown as "l06…")
  props: Record<string, TopoPropValue>;   // only PROP_NAMES (§4.5)
  armType?: string | null;
  scope?: "lab" | "outside";
  health?: TopoHealth;           // live only
  folded?: { id: string; label: string; armType: string | null }[];
  madeBy?: "azure";
}
export interface TopoEdge {
  id: string; from: string; to: string;
  kind: "traffic" | "dependency";
  label?: string;                // "TCP 80→80", "0.0.0.0/0", "peering", "blob", "role: Reader"
  via?: string;                  // the resource that makes the edge
  state?: TopoHealth;            // live: peering, connection, private endpoint approval
}
export interface TopologyGraph {
  schema: 1; labId: string; version: number; source: TopoSource; at: string | null;
  nodes: TopoNode[]; edges: TopoEdge[];
  notes?: string[];              // generator or derivation notes shown under the diagram ("2 resources of unknown type")
}
```

Graphs are sorted (nodes by `id`, edges by `id`) and contain no timestamps but live `at`, so a planned file is byte-stable.

### 4.2 Groups

| Kind | From | Parent | Card shows |
|---|---|---|---|
| `resourceGroup` | `azurerm_resource_group`; live: each row's `resourceGroup` | root | name, region, role chip (`secondary`, `infra`), `lab`/`project` tag chips, lock and budget chips |
| `vnet` | `azurerm_virtual_network`; `Microsoft.Network/virtualNetworks` | RG | name, address space, DNS servers, "peered to gateway" target marker |
| `subnet` | `azurerm_subnet` (or inline `subnet` blocks); `properties.subnets[]` | VNet | name, prefix; chips: NSG, route table, delegation, NAT gateway, service endpoints, "no default outbound" |
| `virtualHub` | `azurerm_virtual_hub` (not `kind = RouteServer`); `Microsoft.Network/virtualHubs` | RG | name, address prefix, SKU, routing intent |
| `lane` | synthetic `global`, `tenant` | root | "Global", "Tenant and Entra ID" |

The WireGuard gateway is one synthetic asset node `wg/gateway` ("WireGuard gateway VNet", greyed, fixed) at the root, present
only when the session's peering is `on`, `waiting` or `disconnected`, joined to the lab's peer target VNet (the `peer_vnet_id`
output's VNet planned; live, the peering whose remote VNet is `vnet-wg`).

### 4.3 Asset kinds (`kinds.ts`, the `KINDS` registry)

Each kind declares: words (singular, plural), icon id (§10), placement, `liveVisible`, the ARM and Terraform types it covers,
and the 1–2 props its card shows. Placement **subnet** means the subnet its NIC or IP configuration names.

| Kind | ARM type(s) | Terraform type(s) | Placement | Card props |
|---|---|---|---|---|
| `vm` | `Microsoft.Compute/virtualMachines` | `azurerm_linux_virtual_machine`, `_windows_virtual_machine` | subnet (first NIC) | size, private IP |
| `vmss` | `…/virtualMachineScaleSets` | `azurerm_linux_virtual_machine_scale_set`, `_orchestrated_…` | subnet | size, instances (autoscale min–max) |
| `publicIp` | `Microsoft.Network/publicIPAddresses` (unattached) | `azurerm_public_ip` | RG | SKU, address (live) |
| `publicIpPrefix` | `…/publicIPPrefixes` | `azurerm_public_ip_prefix` | RG | prefix length, prefix (live) |
| `natGateway` | `…/natGateways` | `azurerm_nat_gateway` | RG | SKU, idle timeout |
| `loadBalancer` | `…/loadBalancers` | `azurerm_lb` | internal: frontend subnet; public: RG; Global tier: Global lane | SKU/tier, frontend IP |
| `appGateway` | `…/applicationGateways` | `azurerm_application_gateway` | subnet | SKU, capacity |
| `wafPolicy` | `…/ApplicationGatewayWebApplicationFirewallPolicies`, `…/FrontDoorWebApplicationFirewallPolicies` | `azurerm_web_application_firewall_policy`, `azurerm_cdn_frontdoor_firewall_policy` | RG (Front Door's: Global lane) | mode |
| `firewall` | `…/azureFirewalls` | `azurerm_firewall` | `AzureFirewallSubnet`, or the virtual hub | tier, private IP |
| `firewallPolicy` | `…/firewallPolicies` | `azurerm_firewall_policy` | RG | tier, rule count |
| `vpnGateway` | `…/virtualNetworkGateways` | `azurerm_virtual_network_gateway` | `GatewaySubnet` | SKU, BGP ASN |
| `localNetworkGateway` | `…/localNetworkGateways` | `azurerm_local_network_gateway` | RG | address prefixes, ASN |
| `bastion` | `…/bastionHosts` | `azurerm_bastion_host` | `AzureBastionSubnet` (Developer: VNet) | SKU |
| `routeServer` | `…/virtualHubs` with `kind: RouteServer` | `azurerm_route_server` | `RouteServerSubnet` | ASN, peer IPs |
| `dnsResolver` | `…/dnsResolvers` (+ endpoints folded) | `azurerm_private_dns_resolver` (+ endpoints) | VNet | inbound IP |
| `dnsRuleset` | `…/dnsForwardingRulesets` | `azurerm_private_dns_resolver_dns_forwarding_ruleset` | RG | rule count |
| `dnsZone` | `…/dnszones` | `azurerm_dns_zone` | Global lane | record count |
| `privateDnsZone` | `…/privateDnsZones` | `azurerm_private_dns_zone` | RG | record count, links |
| `privateEndpoint` | `…/privateEndpoints` | `azurerm_private_endpoint` | subnet | group id, private IP |
| `privateLinkService` | `…/privateLinkServices` | `azurerm_private_link_service` | subnet (NAT IP) | visibility |
| `storage` | `Microsoft.Storage/storageAccounts` | `azurerm_storage_account` | RG | kind/SKU, public access |
| `sqlServer` | `Microsoft.Sql/servers` | `azurerm_mssql_server` | RG | version, public access |
| `sqlDatabase` | `Microsoft.Sql/servers/databases` | `azurerm_mssql_database` | RG | SKU, **status** (prominent) |
| `cosmos` | `Microsoft.DocumentDB/databaseAccounts` | `azurerm_cosmosdb_account` | RG | API, consistency (**status** prominent) |
| `keyVault` | `Microsoft.KeyVault/vaults` | `azurerm_key_vault` | RG | SKU, RBAC |
| `containerGroup` | `Microsoft.ContainerInstance/containerGroups` | `azurerm_container_group` | subnet if VNet-injected, else RG | CPU/memory, IP type |
| `containerApp` | `Microsoft.App/containerApps` | `azurerm_container_app` | RG | ingress, target port |
| `containerAppEnv` | `Microsoft.App/managedEnvironments` | `azurerm_container_app_environment` | its infrastructure subnet, else RG | workload profiles; chip `infra group <name>` (the group Azure makes for an environment in a subnet) |
| `aks` | `Microsoft.ContainerService/managedClusters` | `azurerm_kubernetes_cluster` (+ `azurerm_kubernetes_cluster_node_pool` folded) | its first pool's subnet (`vnetSubnetID`), else RG | node size, node count (autoscale range); chips: network (`Azure CNI Overlay`, …), `node group <name>`; tier; icon `kubernetes-services` |
| `registry` | `Microsoft.ContainerRegistry/registries` | `azurerm_container_registry` | RG | SKU |
| `containerAppJob` | `Microsoft.App/jobs` | `azurerm_container_app_job` | RG | CPU, trigger chip (`event-driven`, `scheduled`, `manual`); icon `container-apps` (the pack has no job icon) |
| `serviceBus` | `Microsoft.ServiceBus/namespaces` | `azurerm_servicebus_namespace` (+ queues, topics, subscriptions, rules, access policies folded) | RG | SKU, counts (queues, topics, subscriptions) |
| `eventGrid` | `Microsoft.EventGrid/systemTopics`, `…/topics` | `azurerm_eventgrid_system_topic`, `azurerm_eventgrid_topic` (+ event subscriptions folded) | RG | subscription count |
| `logAnalytics` | `Microsoft.OperationalInsights/workspaces` | `azurerm_log_analytics_workspace` | RG | daily cap, retention |
| `monitor` | `microsoft.insights/metricalerts`, `activitylogalerts`, `actiongroups`, `datacollectionrules` | `azurerm_monitor_*` (but autoscale and diagnostic settings) | RG | type, severity |
| `frontDoor` | `Microsoft.Cdn/profiles` (+ children folded) | `azurerm_cdn_frontdoor_profile` (+ children) | Global lane | SKU, endpoint host |
| `trafficManager` | `Microsoft.Network/trafficManagerProfiles` | `azurerm_traffic_manager_profile` | Global lane | routing method |
| `recoveryVault` | `Microsoft.RecoveryServices/vaults` | `azurerm_recovery_services_vault` | RG | SKU, protected items |
| `networkManager` | `Microsoft.Network/networkManagers` | `azurerm_network_manager` (+ AVNM children folded) | RG | scope accesses |
| `virtualWan` | `Microsoft.Network/virtualWans` | `azurerm_virtual_wan` | RG | type |
| `managedIdentity` | `Microsoft.ManagedIdentity/userAssignedIdentities` | `azurerm_user_assigned_identity` | RG | — |
| `appServicePlan` | `Microsoft.Web/serverFarms` | `azurerm_service_plan` | RG | SKU (lab 10, parked) |
| `nsg` | `…/networkSecurityGroups` (unattached only) | `azurerm_network_security_group` | RG | rule count |
| `routeTable` | `…/routeTables` (unattached only) | `azurerm_route_table` | RG | route count |
| `managementGroup` | (not listed live) | `azurerm_management_group` | Tenant lane | parent |
| `policy` | (not listed live) | `azurerm_policy_definition`, `_policy_set_definition`, `*_policy_assignment` | RG (RG-scoped assignment) or Tenant lane | effect, enforcement |
| `role` | (not listed live) | `azurerm_role_definition` | Tenant lane | — |
| `entraPrincipal` | (not listed live) | `azuread_user`, `azuread_group` | Tenant lane | type |
| `generic` | anything else | anything else | subnet if a subnet id is found in its properties, else RG | short type |

`liveVisible` is false for `managementGroup`, `policy`, `role` and `entraPrincipal`. Kind order inside a container (for the
packing, §8.1): edge devices first (firewall, VPN gateway, App Gateway, LB, Bastion, Route Server, NAT gateway), then compute
(VM 20, scale set, container group, container app, environment, App Service plan, Container Apps job 26, AKS 27), then data,
then everything else, then `generic`. No two kinds share an order (a test), so packing never depends on input order.

### 4.4 Folded and edge resources (`rules/planned.ts`, `rules/live.ts`)

- **Folded into a card** (listed in `folded`): NICs, OS and data disks, disk attachments, VM extensions, NIC–ASG and NIC–NSG
  associations (NSG name as a card chip) into the VM; NICs of a private endpoint into it; LB pools, rules, probes, NAT and
  outbound rules, pool addresses into the LB; App Gateway children (inline); firewall policy rule collection groups into the
  policy; Front Door endpoints, origin groups, origins, routes, rule sets, rules and security policies into the profile;
  resolver endpoints into the resolver; forwarding rules into the ruleset; DNS records into the zone; storage containers,
  shares, blobs, management and immutability policies into the account; Cosmos databases and containers into the account; Service Bus queues, topics, subscriptions, rules and access
  policies into the namespace (counts); Event Grid event subscriptions into their topic; Key
  Vault secrets, certificates and keys into the vault (counts); AVNM groups, static members, configurations, rule collections,
  rules and deployments into the manager; site-recovery fabrics, containers, mappings, policies and backup policies into the
  vault; autoscale settings into the VMSS; an AKS cluster's extra node pools into the cluster (planned), and live, every
  scale set in the group a cluster's `nodeResourceGroup` names (its node pools) into that cluster, so the node group shows
  the load balancer, public IP, NSG and kubelet identity Azure made, never a scale set card; routing intent into the hub; virtual hub connections' route config into the edge;
  `azurerm_resource_group_template_deployment` into its RG; NSG rules into the NSG; routes into the route table; subnet
  associations into the subnet's chips.
- **Drawn as edges** (`via`): §4.6.
- **Ignored** (not Azure resources): `random_*`, `time_*`, data sources, `terraform_data`, `null_resource`.

### 4.5 Props: the allow-list (`props.ts`)

`PROP_NAMES` is a closed set; nothing else can reach a node. It is: `region`, `zones`, `sku`, `tier`, `size`, `os`,
`instances`, `autoscale`, `privateIp`, `publicIp`, `addressSpace`, `prefix`, `dnsServers`, `allocation`, `ports`, `asn`, `bgp`,
`vpnType`, `clientPool`, `groupId`, `target`, `accountKind`, `accessTier`, `replication`, `publicAccess`, `apiKind`,
`consistency`, `capacity`, `retentionDays`, `dailyCapGb`, `cpu`, `memoryGb`, `ingress`, `targetPort`, `routing`, `hostName`,
`effect`, `enforcement`, `scopeAccess`, `mode`, `status`, `counts` (child collections as `"rules: 5"` strings), `chips`, `tags`,
`peerTarget`, `group`, `resourceId` (live only: the ARM id, for the portal link). Every rule maps a Terraform attribute path
or an ARM property path to one of these; T3 may add a name only with the deny-name test passing and the integrator adding it
here.

`scrubProps` (both builders' last step) drops any key not in `PROP_NAMES`, any value over 256 characters, any string matching
`-----BEGIN`, a 40+ character base64 run, a JWT shape, `password`, `secret`, `sharedkey`, `accountkey`, `sig=`, or the mock
plan's admin password and SSH key, and records a note ("1 value withheld"). Never read: `admin_password`, `admin_ssh_key`,
`custom_data`, `user_data`, `shared_key`, `*_key`, `*connection_string*`, `*secret*`, `*password*`, certificate data,
`identity.principal_id` values (an edge uses the reference, not the GUID). Tests (§12) run the deny check over every planned
file and every live fixture's output. The mock plan's `value` attributes are never read, with one exception
(`scripts/lib/topology-stream.mjs`): a container's `env[].value` that is only a URL to a bare host name
(`^https?://<name>(:port)?/?$`, no dots, credentials, path or query), as lab 28's web tier calls `http://ca-app`. It can
hold no secret, and it is what draws the planned "next tier" edge.

### 4.6 Edges

| Edge | Kind | From → to | Label | Planned from | Live from |
|---|---|---|---|---|---|
| LB rule | traffic | LB → each backend VM/VMSS | `TCP 80→80` | rule + pool association refs | `loadBalancingRules`, pool `backendIPConfigurations` |
| LB NAT rule | traffic | LB → backend | `TCP 8081-8090→80` | `azurerm_lb_nat_rule` | `inboundNatRules` |
| LB outbound | traffic | backend → LB | `outbound` | `azurerm_lb_outbound_rule` | `outboundRules` |
| Global LB / chain | traffic | global LB → regional LB; LB frontend → gateway LB | `TCP 80`, `chain` | pool addresses, `gateway_load_balancer_frontend_ip_configuration_id` | same properties |
| App Gateway | traffic | App GW → backend (VM by NIC or IP, else a hostname chip) | listener port → backend port | pools, rules | `backendAddressPools`, `requestRoutingRules` |
| Front Door | traffic | Front Door → origin (PLS, LB, container group, hostname) | `HTTPS`, `Private Link` | origins | origin properties (V: child rows listed) |
| Traffic Manager | traffic | TM → endpoint target | routing method | endpoints | `endpoints[]` |
| VPN connection | traffic | VPN gateway → local network gateway / other gateway | `IPsec`, `BGP` | connections | `Microsoft.Network/connections` (state `connectionStatus`) |
| Hub connection | traffic | virtual hub → spoke VNet | `hub connection` | `azurerm_virtual_hub_connection` | hub connection rows (V) |
| Peering | traffic | VNet ↔ VNet (one edge per pair) | `peering` (`gateway transit`) | `azurerm_virtual_network_peering` | `virtualNetworkPeerings[]` (state) |
| Next hop | traffic | subnet → appliance (VM by NIC IP, firewall by private IP) | route prefix, `0.0.0.0/0` | route `next_hop_in_ip_address` value or ref | route table `routes[]` + subnet `routeTable` |
| NAT gateway | traffic | subnet → NAT gateway | `outbound` | association | subnet `natGateway` |
| Private endpoint | traffic | PE → target | group id (`blob`, `sqlServer`) | `private_service_connection` ref | `privateLinkServiceConnections[]` (state) |
| PLS | traffic | PLS → LB | `frontend` | `load_balancer_frontend_ip_configuration_ids` | same |
| BGP peer | traffic | Route Server → NVA VM | `BGP 65010` | `azurerm_route_server_bgp_connection` | BGP connection rows (V) |
| DNS forward | traffic | ruleset → target VM | `DNS 53` | forwarding rule target IP | same |
| Role | dependency | identity / principal → scope resource | `role: <name>` | `azurerm_role_assignment` | not listed live (planned only) |
| Access policy | dependency | identity → Key Vault | `get secrets` | `azurerm_key_vault_access_policy` | vault `accessPolicies` (object id matched to an identity's principal id in the same graph) |
| Diagnostics | dependency | resource → workspace | `diagnostics` | `azurerm_monitor_diagnostic_setting` | not listed live (planned only) |
| Backup / replication | dependency | vault → VM | `backup`, `replication` | protected VM, replicated VM | vault rows (V) |
| Zone link | dependency | private DNS zone → VNet | `link` (`auto-registration`) | zone links | zone link rows (V) |
| Event subscription | traffic | Event Grid topic → destination (a queue or topic is drawn as its namespace) | the destination's name (`blob-events`) | the subscription's endpoint refs; also topic → dead-letter account (dependency, `dead-letter`) | not listed live (planned only) |
| KEDA consumer | traffic | Container Apps job → Service Bus namespace | the queues its rules watch (`orders, blob-events`) | `event_trigger_config` queue refs | `configuration.eventTriggerConfig.scale.rules[].metadata` (`namespace`, `queueName`) |
| Next tier | traffic | container app → container app; container app → SQL server (lab 28) | the URL's scheme (`HTTP`, `HTTPS`; a reference with no known value is `HTTPS`); `SQL 1433` | a reference in the app's `template` to the other app or the server, or a known env value that is a URL to another app of the same environment (`http://ca-app`) | `template.containers[].env[].value` naming another app (by name in the same environment, its ingress FQDN or latest revision FQDN) or a server's `fullyQualifiedDomainName` |
| Others | dependency | data collection rule association, alert → target, App GW → Key Vault, SQL DB → server, failover group, container app or job → environment, Container Apps environment → workspace (`logs`), Event Grid topic → source (`source`), AVNM → member VNets, policy base → child, WAF policy → App GW/endpoint | as named | refs | properties |

Edges are deduplicated (a peering pair is one edge) and sorted. An edge to a node outside the graph is dropped with a note,
except the WireGuard gateway (§4.2).

## 5. Planned graphs (`npm run labs-topology`)

1. For each lab folder (and only those; the template is skipped): copy `terraform/` to a scratch folder, build Bicep as
   labs-tf does, `terraform init -backend=false` (shared `TF_PLUGIN_CACHE_DIR`), write labs-tf's `mockPlanFile` as
   `tests/labs-mock.tftest.hcl`, run `terraform test -verbose -json -no-color`, take the `test_plan` message's
   `resource_changes` and `output_changes`.
2. `hcl2json` of the lab's `.tf` files → `hclResources(hcl, labId)` → refs per configuration address.
3. `plannedGraph({ labId, version, changes, outputs, refs })` (pure, `shared/topology/planned.ts`): instance values with
   `after_unknown` paths as unknown, joined to refs; rules (§4.4, §4.6) build nodes, folds and edges; Bicep expansion
   (ruling 24); keys (ruling 6); `scrubProps`; sort.
4. Write `shared/topology/planned/<id>.json` (`JSON.stringify(graph, null, 1) + "\n"`). `--check` writes nothing and exits 1
   naming each lab whose fresh graph differs from the committed one (compared parsed, so line endings never matter), or whose
   file is missing, or a file with no lab folder. `node scripts/labs-topology.mjs [id ...]` limits the run.
5. CI's `labs` job runs `npm run labs-topology -- --check` after `labs-tf` (same plugin cache; hcl2json already installed).
   The generator needs terraform and hcl2json: without terraform it fails with a reason (it never "skips": a stale diagram is
   a failure).
6. Because the folder is outside `labs/<id>/`, `labs-check --base` never asks for a version bump for it. A lab change that
   alters the graph fails CI until the file is regenerated; `version` in the file follows `lab.yaml`, so a bump also
   regenerates.

## 6. Live graphs (`GET /api/v1/labs/:id/topology`)

### 6.1 The query

`POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01` (V the version) through
`worker/src/labs/net.ts`'s `arm` with `directNet()` (the dashboard's convention: counted, not budgeted; one sign-in at most
when the token has expired), body:

```json
{ "subscriptions": ["<AZURE_SUBSCRIPTION_ID>"],
  "query": "resources | where resourceGroup =~ 'rg-lab-<id>' or resourceGroup startswith 'rg-lab-<id>-' | project id, name, type, kind, location, resourceGroup, sku, tags, zones, identity, managedBy, properties | union (resourcecontainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' and (name =~ 'rg-lab-<id>' or name startswith 'rg-lab-<id>-') | project id, name, type, location, resourceGroup = name, tags, managedBy) | order by id asc",
  "options": { "resultFormat": "objectArray", "$top": 1000 } }
```

At most two subrequests per refresh (token + query). A reply with `$skipToken` (more than 1000 rows) is used as is with
`truncated: true` and a banner. (V) at integration: one query on a running lab returns the VM's
`properties.extended.instanceView.powerState`, the subnets inside the VNet row, and which child types (Front Door origins, hub
connections, zone links, BGP connections, vault items) appear as rows.

### 6.2 Derivation (`liveGraph(rows, ctx)`, `shared/topology/live.ts`)

Pure: `ctx = { labId, version, namePrefix, region, secondaryRegion, catalogueIds, gatewayVnetId, at }`. Rows whose group fails
`ownsName` are dropped first (ruling 16). Each row goes through the ARM rules of its type (case-insensitive) → node, fold or
edge; subnets come from the VNet row's `properties.subnets[]`; placement follows NIC/IP-configuration subnet ids; edges as
§4.6; health (ruling 14); "made by Azure" (ruling 13); unknown types become `generic` cards; `scrubProps`; sort.

### 6.3 Cache and refresh

`worker/src/labs/topology.ts`: a module-level `Map<"<labId>:<sessionId>", { at, response }>` with a 30 s life and a
`Map` of in-flight promises (one query per lab at a time per isolate). The app's `useLabTopology(id)` query has `staleTime`
30 s, `refetchInterval` 30 s while the diagram is mounted and the document visible, and is not enabled with no live session.

### 6.4 When it cannot

`not_running` (no live session: the app never asks), `no_azure` (Azure not configured), `failed` (ARM refused or did not
answer: message from `armRefusal` style, no body echoed), `throttled` (429: the last cached graph if any, else none). In every
case but `ok` the app shows the planned graph with a banner naming the reason.

### 6.5 Never

The endpoint never queries another group, another subscription or a management-group scope; never writes to Azure; never
returns a row's raw `properties`, tags beyond ruling 22, or any value outside `PROP_NAMES`; never stores rows (the cache holds
the derived response only).

### 6.6 Contract (`shared/api.ts`)

```ts
export interface LabTopologyResponse {
  status: "ok" | "not_running" | "no_azure" | "failed" | "throttled";
  message: string | null;          // plain words for the banner
  live: TopologyGraph | null;
  fetchedAt: string | null;
  truncated: boolean;
}
```

404 `not_found` for an id outside the catalogue. Behind `requireAccess` and `sameOriginOnly` as every `/api/v1` route.

## 7. Planned and live together (`diff.ts`)

`diffGraphs(planned, live)` → per node `{ status: "both" | "added" | "missing" | "azure" | "unlisted" }`, matched on `key`:

| Status | When | Shown |
|---|---|---|
| both | key in both | live card, live props, live health |
| added | live only, not made by Azure | badge **Added by hand** |
| azure | live only, `madeBy: "azure"` | badge **Made by Azure** (muted) |
| missing | planned only, `liveVisible`, `scope: "lab"` | ghost card (dashed, faded) **Not deployed or removed**, placed by its planned parent's key |
| unlisted | planned only, not `liveVisible` or `scope: "outside"` | ghost card **Not listed by the live view** |

While the session is deploying, missing nodes are expected: their badge reads **Not deployed yet**. Edges follow their nodes
(a ghost's edges are ghost edges). A planned edge between two live nodes that the live view draws nothing between (a child
or link Resource Graph does not return: Front Door origins, hub and BGP connections, forwarding rules, failover groups, DNS
zone groups, AVNM members, backup items, DCR associations, diagnostic settings) is a ghost edge marked **Not listed by the
live view**, never "not deployed". The live query also returns the lab's groups' own rows (`resourcecontainers`, same
request), so an empty group is drawn. The **Live / Planned** toggle shows the live view (default) or the planned graph rebased to
the session's slot (ruling 23).

## 8. Layout and saved arrangements

### 8.1 Packing (`web/src/views/labs/topology/layout.ts`, pure)

Sizes: card 200 × 84; gap 16; container padding 16; group header 36 (subnet 28). Order inside a container: kind order (§4.3),
then label, then id. Subnet: assets in `min(3, ceil(√n))` columns (an empty subnet is 232 × 72). VNet: subnets by numeric
prefix, then VNet-attached assets, shelf-packed to `max(widest child, 760)`. RG and lanes: VNets and hubs by address space,
then loose assets, shelf-packed to `max(widest child, 1000)`. Root, left to right with gap 48, tops aligned: the gateway node
(if any), the Global lane (if any), the primary RG, secondary RGs, other lab RGs by name, the Tenant lane (if any).
Positions are relative to the parent (React Flow `parentId`, children `extent: "parent"`, `expandParent: true`).

`layoutTopology(graph, saved)` → `{ nodes: { id, x, y, w, h, parent }[] }` is deterministic: the same graph in any input order
gives the same answer.

### 8.2 Saved positions

A saved entry is `{ x, y, p }` (relative position and the parent key it was saved under), applied only when the node's
current parent key equals `p`. Unsaved siblings are packed below the saved siblings' bounding box, so a new node never lands on
a moved one. Containers then grow bottom-up to hold every child plus padding. Moving a container moves its children. A drag
end saves; **Reset layout** saves an empty arrangement.

### 8.3 Storage and API

Migration `worker/migrations/0021_ui_prefs_topology.sql`: rebuild `ui_prefs` (new table with the CHECK widened to `page IN
('overview','clients','firewall','activity','cost') OR (page GLOB 'topology:az[0-9][0-9][0-9]-[0-9][0-9]-*' AND length(page)
<= 60)`, copy every row, drop, rename). `shared/topology/layout.ts`:

```ts
export interface TopologyLayout { v: 1; nodes: Record<string, { x: number; y: number; p: string | null }> }
export interface TopologyLayoutPage { version: number; updatedAt: string | null; layout: TopologyLayout }   // version 0 = never saved
export interface TopologyLayoutPutBody { baseVersion: number; layout: TopologyLayout }
export const MAX_TOPOLOGY_BODY_BYTES = 20 * 1024, MAX_TOPOLOGY_LAYOUT_BYTES = 16 * 1024, MAX_TOPOLOGY_ENTRIES = 300;
```

`validateTopologyLayout` refuses (400 with the field): unknown keys; `v` not 1; more than 300 entries; a key over 200
characters or with control characters or quotes; a coordinate not an integer within ±100 000; `p` not null or a string of the
same form. Routes: `GET /api/v1/prefs/topology/:labId` → `TopologyLayoutPage`; `PUT /api/v1/prefs/topology/:labId` with
`TopologyLayoutPutBody` → `TopologyLayoutPage`; 404 for an id not in the catalogue; 409 `stale` as the widgets (atomic
`INSERT OR IGNORE` / `UPDATE … WHERE version = ?`); body over 20 KiB refused before parsing; stored page over 16 KiB 400. The
owner is always `c.get("user")`.

App (`useTopologyLayout(labId)`): the widgets' save discipline (spec 2026-10-03 §7): apply at once, save after 600 ms quiet,
one save in flight, later changes sent after it with the new version, flush on hide, revert and toast "Couldn't save the
diagram layout: ‹message›. Put back as it was." on failure, refetch on 409 with "Changed on another device. Showing the
latest." A layout that failed to load is never saved over: dragging still works for the visit and a note says it will not
be kept.

## 9. The interface

### 9.1 Placements

- **Lab panel (desktop):** the readme column becomes two tabs, **Readme** and **Diagram** (`Tabs` underline), in the idle and
  running panels; `?view=diagram` selects Diagram. The diagram fills the column (the one-screen rule holds: it scrolls never;
  it pans).
- **Phone:** the same tabs in the lab sheet; the canvas is `min(60vh, 480px)` tall; details open as a `Sheet`.
- **Full screen** (`/labs/:id/diagram`): the content area holds a header (lab title, Live/Planned, search, dependency toggle,
  Diagram/List, Reset layout, Close back to `/labs/:id`), the canvas with MiniMap and Controls, the details panel and the legend.
  Works on the phone too (no MiniMap there).
- **Overview hover:** hovering (or focusing) a running lab's box for 400 ms opens a popover with a 320 × 200 mini diagram
  (no pan, zoom or drag; icons and names only; the saved arrangement; live data, planned on failure) and a caption ("Live · 14
  resources · Open the lab"). `@media (hover: hover)` only for pointer hover; keyboard focus opens it everywhere; Escape
  closes; the box stays a link.

### 9.2 Canvas

- **Groups:** RG dashed border, translucent fill, label top-left with region, role and tag chips. VNet: Azure-blue border,
  address space in the header. Subnet: lighter nested container, prefix and chips. Virtual hub: like a VNet with a hub chip.
  Lanes: plain titled bands.
- **Asset cards** (200 × 84, bento): icon (32 px), name (truncated, full in the title), type word, 1–2 key props, health chip
  (word + colour, never colour alone). Databases (`sqlDatabase`, `cosmos`) show their status as a larger chip. Badges (§7) on
  the top edge. Stack cards show "12 × VM".
- **Handles** on all four sides; every edge leaves and enters at the nearest sides of its two nodes (floating edges, computed
  from node bounds). Traffic edges: smoothstep, solid, label pill. Dependency edges: dashed, thinner, not focusable or
  clickable, hidden by the toggle. No edge animates unless "Animate traffic" is on in full screen, which is off by default
  and disabled under `prefers-reduced-motion` (fit-view transitions are instant there too).
- **Details panel** (`SidePanel`, `Sheet` on the phone): name, kind word, ARM type, group, health, props (IPs with copy
  buttons), connections in and out with labels, folded resources, the badge's meaning, planned-versus-live note, and **Open in
  Azure portal** (`https://portal.azure.com/#resource<resourceId>`, live only).
- **Search** highlights matches by label, kind word and prop values (others dimmed), Enter fits the view to them.
- **Legend:** the kinds present, edge styles, badges.
- **Theme:** React Flow `colorMode` follows the app theme; its `--xy-*` variables map to the app's CSS tokens; `base.css` only.

### 9.3 Accessibility

Every node is keyboard-focusable with an accessible name ("VM vm-app in snet-app, Running, private IP 10.64.0.4"); Enter opens
details, Escape closes them; arrow keys move a selected node (and save, as a drag). Traffic edges are focusable with a name
("lb-svc to vm-svc: TCP 80→80"). The **List** view is a nested `tree` (groups → assets) with the same words, health and
connections, and is the default when the graph has over 300 nodes. Status words always accompany colours.

## 10. Icons

- Source: the official Microsoft Azure Architecture Icons pack from
  `https://learn.microsoft.com/azure/architecture/icons/` (V the current version and zip URL). The page's terms: Microsoft
  permits the use of these icons in architectural diagrams, training materials or documentation; they may be copied,
  distributed and displayed only for that use; do not crop, flip, rotate, distort or otherwise change them; do not use them to
  represent another product. This feature is an architecture diagram of Azure resources: permitted.
- `scripts/topology-icons.mjs` (run by hand, not in CI): downloads the pinned zip into a scratch folder (SHA-256 recorded in the
  script on first run, checked after), extracts with `tar -xf` (bsdtar on Windows 10+ and macOS, `unzip` on Linux), takes the
  files named in `ICON_FILES` (kind → path in the pack, about 40 plus `generic`), optimises them (strip comments, metadata,
  editor attributes and whitespace; prefix every id with the icon name; keep `viewBox` and every shape), and writes
  `web/src/views/labs/topology/icons/azure.svg` (one `<symbol id="az-<icon>">` each) and `icons/README.md` (pack version,
  download date, the terms quoted with the link, the file list).
- A test proves every kind's icon exists in the sprite, every id inside a symbol starts with its icon's prefix, and the sprite
  is under 60 kB gzip.

## 11. Bundle and performance

- `scripts/lib/bundle.mjs`: `jsGzip` 400 000 → **450 000**; new `topologyDataGzip` 16 000 per planned file; a sprite limit of
  60 000; a FAIL when an entry file contains `react-flow__` or `@xyflow`. Before: entry 311.9 kB, all JS 342.8 kB, CSS 33.3 kB
  (`web/dist` of 8243fab). `@xyflow/react` 12.12.0 (MIT, 2026-09-24; dependencies `@xyflow/system` 0.0.83, `zustand`,
  `classcat`; about 60 kB gzip with its d3 parts, an estimate) plus about 25 kB of topology code: about 430 kB of 450.
  The real figure is measured by `bundle-size` at T0 and integration; over 450 means cutting, not raising.
- `layoutTopology` for a 300-node graph runs under 50 ms in Node; the live derivation for 1000 rows under 50 ms of Worker CPU.

## 12. Testing

- **Pure (Vitest worker project):** model and keys; `scrubProps` and the deny check; each planned rule and live rule; Bicep
  expansion; `diffGraphs`; `rebaseSlot`; layout validation. **Golden (T3):** every lab's committed planned graph passes the deny
  check, represents every resource address in its terraform (and, for labs 13–44, every address in the recorded real plan
  shape `scripts/test/fixtures/labs/plans/shapes/<id>.json`), and has the lab's expected kinds and edges; live derivation from
  realistic Resource Graph row fixtures per ARM type covers every type the 40 labs make, plus hand-made unknown types.
- **Scripts (node:test):** the generator's stream parsing (a recorded, scrubbed stream fixture), `--check`, determinism (two runs
  identical), hcl2json pinning, icon pipeline, bundle limits.
- **Worker:** the route's statuses, scope (a row from another lab's group or a longer id's group is dropped; the query text names
  only the lab's groups), cache and coalescing, no raw properties in the response, the dev fixture only under
  `AUTH_DEV_BYPASS`; prefs routes and migration 0021 (rows kept, CHECK refuses other pages).
- **App (Vitest jsdom + RTL):** tab and URL, full-screen route, mini on hover and focus, planned fallback banners, badges,
  live/planned toggle, saves (debounce, revert, 409), reset, list view, keyboard, reduced motion, phone sheet; no `@xyflow` in
  the entry (bundle test).
- **Screens:** `npm run shots` on the labs scenario: `/labs/az104-06-blob-security?view=diagram` (live, from the dev fixture),
  `/labs/az104-06-blob-security/diagram`, `/labs/az700-40-lb-advanced?view=diagram` (planned, two regions, global LB),
  `/labs/az104-09-vmss?view=diagram`, at 1600×900, 1100×600 and 390×844, dark and light; every other route pixel-identical
  to `main`'s (`shots:diff`).
- **Live (integration):** ruling 27.

## 13. Delivery

Engine first (**T0**), then three parallel areas (**T1** canvas, nodes and layout; **T2** placements and persistence; **T3**
coverage across the 40 labs), then integration (merge, gate, a fresh review, one fix pass, shots, the live check, merge and
deploy). The plan has the steps.

## 14. Risks

| Item | Answer |
|---|---|
| A secret in a planned file or a live response | Closed `PROP_NAMES`, `scrubProps` with patterns and the mock secrets, a deny test over every committed file and every live fixture; the plan stream is never printed or stored. |
| The query escaping the lab's groups | One query form, catalogue id only, subscription named, rows re-checked with `ownsName`; tests with a neighbour lab and a longer id. |
| Layout jumping between refreshes | Deterministic packing from sorted input; saved positions win; new nodes go below saved ones; a test that a refresh with one new node moves no saved node. |
| Huge labs (VMSS, many NICs) | VMSS as one card; stacks over 8; List view over 300 nodes; 1000-row cap with a banner. |
| Hand-made resources of unknown types | `generic` cards, never dropped; a test with an unknown type in a subnet and in a group. |
| Mobile | Sheet-sized canvas, touch pan and pinch, details as a sheet, shots at 390×844. |
| Bundle size | Own lazy chunk; entry check; 450 kB measured at T0 and integration; planned files as assets. |
| Mock plan drift (Terraform or azurerm upgrade changes the stream) | `--check` in CI catches the change; the parser fails loudly on a stream without `test_plan`. |
| Resource Graph shapes not as documented | (V) items checked at integration on two real labs; fixtures replaced with the captured, scrubbed rows. |
| Migration 0021 | Rebuild tested on the harness with existing rows; deploy-worker applies it; row count read before and after (a mismatch is a STOP). |
