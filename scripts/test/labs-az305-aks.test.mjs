// labs-az305-aks.test.mjs
//
// Plain English: lab 29, az305-29-aks (AZ-305 batch 4, rulings 40-41), the
// AKS small cluster, checked without touching Azure. It runs the shared
// content suite (fixtures/labs/content.mjs; with identity "match", lab.yaml's
// role list against the Terraform's one role assignment), then its own
// tests: the cheapest cluster AKS accepts (Free tier, one Standard_B2s
// node), Azure CNI Overlay in a subnet of the slot with pod and service
// ranges left to AKS's defaults, which sit outside the lab pool and every
// gateway range, the node resource group named inside the lab's prefix (so
// the safety net, Verify clean and the orphan sweep find it), the control
// plane's user-assigned identity with Network Contributor on its subnet only,
// and no AcrPull (not on the allow-list: attaching the registry is a Things
// to try step the learner does with their own rights). init, validate and
// the mock plan are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";
import { ALLOWED_ROLES, cidrOverlaps, GATEWAY_RANGES, LAB_POOL } from "../lib/labs.mjs";
import { attr, lab, labContentSuite, resources, roleAssignments } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";

const AKS = "az305-29-aks";

labContentSuite(AKS, { marker: "££", identity: "match" });

/** The body of the first nested block `name { ... }` in `body` (any depth), or undefined. */
function nested(body, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*\\{`).exec(body ?? "");
  if (!m) return undefined;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) break;
  }
  return body.slice(m.index + m[0].length, i);
}

const one = (l, type) => {
  const rs = resources(l, type);
  assert.equal(rs.length, 1, `exactly one ${type}`);
  return rs[0];
};

/** AKS's documented defaults when network_profile leaves them unset (Learn, Azure CNI Overlay and "Configure Azure CNI"). */
const AKS_DEFAULT_POD_CIDR = "10.244.0.0/16";
const AKS_DEFAULT_SERVICE_CIDR = "10.0.0.0/16";

test(`${AKS}: one Free-tier cluster with a single Standard_B2s system node, autoscale off`, () => {
  const c = one(lab(AKS), "azurerm_kubernetes_cluster").body;
  assert.equal(attr(c, "name"), '"aks-lab"');
  assert.equal(attr(c, "sku_tier"), '"Free"', "Free tier: no control-plane charge");
  assert.equal(attr(c, "dns_prefix"), "var.name_prefix");
  const pool = nested(c, "default_node_pool");
  assert.ok(pool, "a default (system) node pool");
  assert.equal(attr(pool, "name"), '"system"');
  assert.equal(attr(pool, "vm_size"), '"Standard_B2s"', "2 vCPU, 4 GiB: the smallest that runs the system pods; standardBSFamily quota is 10 vCPUs");
  assert.equal(attr(pool, "node_count"), "1");
  assert.equal(attr(pool, "auto_scaling_enabled"), undefined, "no cluster autoscaler (a Things to try step)");
  assert.equal(attr(pool, "os_disk_size_gb"), "64", "a 64 GiB managed OS disk: Premium SSD P6 on a B2s, priced in lab.yaml");
  assert.equal(attr(pool, "vnet_subnet_id"), "azurerm_subnet.aks.id");
  assert.equal(attr(pool, "tags"), "var.tags", "the node scale set carries the session's tags");
  assert.equal(attr(c, "node_os_upgrade_channel"), '"None"', "no node image upgrade (and node reboot) in the middle of a session");
});

test(`${AKS}: Azure CNI Overlay in a slot subnet, Standard LB outbound, pod and service ranges left to AKS outside the pool and every gateway range`, () => {
  const l = lab(AKS);
  const net = nested(one(l, "azurerm_kubernetes_cluster").body, "network_profile");
  assert.equal(attr(net, "network_plugin"), '"azure"');
  assert.equal(attr(net, "network_plugin_mode"), '"overlay"', "pods get addresses from an overlay range, not the subnet; kubenet is being retired");
  assert.equal(attr(net, "load_balancer_sku"), '"standard"');
  assert.equal(attr(net, "outbound_type"), '"loadBalancer"');
  for (const a of ["pod_cidr", "pod_cidrs", "service_cidr", "service_cidrs", "dns_service_ip"]) assert.equal(attr(net, a), undefined, `${a} is left to AKS's default (a literal CIDR would fail the lint, and the defaults are clear of every range below)`);
  for (const cidr of [AKS_DEFAULT_POD_CIDR, AKS_DEFAULT_SERVICE_CIDR]) {
    assert.equal(cidrOverlaps(cidr, LAB_POOL), false, `${cidr} is outside the lab pool ${LAB_POOL}`);
    for (const r of GATEWAY_RANGES) assert.equal(cidrOverlaps(cidr, r), false, `${cidr} is clear of the gateway's ${r} (tunnel, loopback, vnet-wg, home LAN, Docker, Azure DNS)`);
  }
  assert.equal(cidrOverlaps(AKS_DEFAULT_POD_CIDR, AKS_DEFAULT_SERVICE_CIDR), false);
  // The node subnet: a /24 of the slot's first /20.
  const subnet = one(l, "azurerm_subnet").body;
  assert.equal(attr(subnet, "name"), '"snet-aks"');
  assert.equal(attr(subnet, "address_prefixes"), "[local.aks_cidr]");
  assert.equal(attr(subnet, "default_outbound_access_enabled"), "true", "ruling 37: said explicitly (the nodes leave through the load balancer's outbound rule, which takes precedence)");
  // The readme says where the ranges are.
  const readme = lab(AKS).readme;
  for (const cidr of [AKS_DEFAULT_POD_CIDR, AKS_DEFAULT_SERVICE_CIDR]) assert.ok(readme.includes(cidr), `the readme names ${cidr}`);
});

test(`${AKS}: the node resource group is rg-lab-<id>-nodes, inside the lab's prefix, and the scope check refuses any other`, () => {
  const c = one(lab(AKS), "azurerm_kubernetes_cluster").body;
  assert.equal(attr(c, "node_resource_group"), '"${var.resource_group_name}-nodes"', "never MC_...: the safety net, Verify clean and the orphan sweep only see rg-lab-<id>*");
  const d = LAB_PLANS[AKS];
  const cluster = d.resources.find((r) => r.address === "azurerm_kubernetes_cluster.aks");
  assert.equal(cluster.values.node_resource_group, "rg-lab-az305-29-aks-nodes");
  const withNodeGroup = (name) => realisticPlan({ ...d, resources: d.resources.map((r) => (r === cluster ? { ...r, values: { ...r.values, node_resource_group: name } } : r)) });
  assert.deepEqual(checkPlan(withNodeGroup("rg-lab-az305-29-aks-nodes"), AKS), []);
  for (const bad of ["MC_rg-lab-az305-29-aks_aks-lab_uksouth", "rg-lab-az305-29-aksnodes", "rg-lab-az305-30-messaging-nodes"]) {
    assert.deepEqual(checkPlan(withNodeGroup(bad), AKS).map((p) => `${p.rule}: ${p.address}`), ["azure-made-group: azurerm_kubernetes_cluster.aks"], bad);
  }
  // Left unset, AKS would make MC_<group>_<cluster>_<region>: the plan has it unknown, and that is refused too.
  const unset = realisticPlan({ ...d, resources: d.resources.map((r) => (r === cluster ? { ...r, values: Object.fromEntries(Object.entries(r.values).filter(([k]) => k !== "node_resource_group")), refs: Object.fromEntries(Object.entries(r.refs).filter(([k]) => k !== "node_resource_group")) } : r)) });
  assert.deepEqual(checkPlan(unset, AKS).map((p) => p.rule), ["azure-made-group"]);
});

test(`${AKS}: a user-assigned control-plane identity with Network Contributor on the node subnet only, and the cluster waits for it`, () => {
  const l = lab(AKS);
  const uai = one(l, "azurerm_user_assigned_identity");
  assert.equal(attr(uai.body, "name"), '"id-${var.name_prefix}-aks"');
  const c = one(l, "azurerm_kubernetes_cluster").body;
  const id = nested(c, "identity");
  assert.equal(attr(id, "type"), '"UserAssigned"', "a user-assigned identity can be given its role before the cluster exists (Learn: the recommendation outside the Azure CLI)");
  assert.equal(attr(id, "identity_ids"), `[azurerm_user_assigned_identity.${uai.labels[1]}.id]`);
  assert.equal(nested(c, "kubelet_identity"), undefined, "AKS makes the kubelet identity in the node group (deleted with it); bringing one would need Managed Identity Operator, not on the allow-list");
  const ra = one(l, "azurerm_role_assignment");
  assert.equal(attr(ra.body, "role_definition_name"), '"Network Contributor"');
  assert.equal(attr(ra.body, "scope"), "azurerm_subnet.aks.id", "the node subnet, nothing wider");
  assert.equal(attr(ra.body, "principal_id"), `azurerm_user_assigned_identity.${uai.labels[1]}.principal_id`);
  assert.equal(attr(ra.body, "principal_type"), '"ServicePrincipal"');
  const wait = one(l, "time_sleep");
  assert.match(wait.body, new RegExp(`depends_on\\s*=\\s*\\[azurerm_role_assignment\\.${ra.labels[1]}\\]`));
  assert.match(c, new RegExp(`depends_on\\s*=\\s*\\[time_sleep\\.${wait.labels[1]}\\]`), "the cluster is created after the role has had time to reach Azure Resource Manager");
  // Every role the lab assigns is on the allow-list. AcrPull is not (labs/setup/allowed-roles.json): adding it is an
  // identity change for Steven, so the registry is attached by the learner (Things to try), never by Terraform.
  const allowed = ALLOWED_ROLES.builtIn.map((r) => r.name);
  for (const r of roleAssignments(l)) assert.ok(allowed.includes(r.role), `${r.role} is on the allow-list`);
  assert.equal(roleAssignments(l).some((r) => r.role === "AcrPull"), false);
  assert.match(lab(AKS).readme, /--attach-acr/, "the readme has the learner attach the registry");
});

test(`${AKS}: a Basic registry with the admin user off`, () => {
  const acr = one(lab(AKS), "azurerm_container_registry").body;
  assert.equal(attr(acr, "name"), '"${var.name_prefix}acr"');
  assert.equal(attr(acr, "sku"), '"Basic"');
  assert.equal(attr(acr, "admin_enabled"), "false");
});

test(`${AKS}: no Kubernetes, Helm or other provider: azurerm and time only, and nothing written inside the cluster`, () => {
  const l = lab(AKS);
  const versions = l.files["versions.tf"];
  const sources = [...versions.matchAll(/source\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(sources, ["hashicorp/azurerm", "hashicorp/time"]);
  assert.equal(resources(l).filter((r) => /^(kubernetes|helm)_/.test(r.labels[0])).length, 0);
});

test(`${AKS}: lab.yaml prices the node, its disk, the load balancer and outbound IP AKS makes, and the registry`, () => {
  const y = lab(AKS).yaml;
  const items = Object.fromEntries(y.cost.items.map((i) => [i.retail?.sku ?? i.retail?.meter ?? i.name, i]));
  assert.equal(items.Standard_B2s?.qty ?? 1, 1, "one node, priced from the VM size");
  assert.deepEqual(items["P6 LRS Disk"]?.retail, { meter: "P6 LRS Disk", unit: "1/Month" });
  assert.deepEqual(items["Standard IPv4 Static Public IP"]?.retail, { meter: "Standard IPv4 Static Public IP", unit: "1 Hour" });
  assert.deepEqual(items["Basic Registry Unit"]?.retail, { meter: "Basic Registry Unit", unit: "1/Day" });
  assert.ok(y.cost.items.some((i) => /load balancer/i.test(i.name) && i.gbp_h === 0.0189), "the Standard load balancer AKS makes: authored (ruling 54, a Global row)");
  assert.ok(y.cost.items.some((i) => /Free tier/i.test(i.name) && i.gbp_h === 0), "the Free tier control plane, at £0");
  assert.deepEqual(y.capacity.vm_sizes, ["Standard_B2s"]);
  assert.equal(y.connectivity.peering, "optional");
});
