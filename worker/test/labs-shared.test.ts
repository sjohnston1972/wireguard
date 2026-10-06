// labs-shared.test.ts
//
// Plain English: the lab contract's own arithmetic (shared/labs.ts): which
// addresses a slot gets, which names a lab owns, what a lab costs an hour and
// how long its workflow may run. The scripts keep their own copy of the few
// constants they need (scripts/lib/labs.mjs); the last test keeps the two equal.

import { describe, expect, it } from "vitest";
import {
  ALLOWED_ROLES,
  GATEWAY_RANGES,
  GOVERNANCE_LABS,
  LAB_EXAMS,
  LAB_ID_MAX,
  LAB_ID_RE,
  LAB_POOL,
  LAB_SLOTS,
  LAB_STEPS,
  LAB_TF_VARS,
  cidrOverlaps,
  costMarker,
  estimateGbpH,
  examOfId,
  isGovernanceLab,
  labIdFromName,
  labLockName,
  labNeeds,
  labRg,
  labsSettingsFrom,
  ownsName,
  sessionTimeoutMin,
  slotCidr,
  type LabDef,
} from "../../shared/labs";
import * as scripts from "../../scripts/lib/labs.mjs";

const def = (over: Partial<LabDef> = {}): LabDef => ({
  id: "az104-06-blob-security",
  number: 6,
  version: 1,
  title: "Blob security",
  summary: "A storage account.",
  exam: "AZ-104",
  exams: ["AZ-104"],
  skill_areas: ["az104.storage"],
  level: "associate",
  type: "explore",
  prerequisites: [],
  cost: { items: [{ name: "Private endpoint", gbp_h: 0.0076 }], pricey: null },
  timing: { deploy_min: 4, destroy_min: 3, session_h: 2, max_h: 6 },
  capacity: { vm_sizes: [] },
  regions: { secondary: null },
  connectivity: { peering: "optional", dns_link: true, subnets_used: 1 },
  identity: { creates: [], roles: [], governance: false },
  ...over,
});

describe("lab slots and the address pool", () => {
  it("slotCidr gives 10.64.0.0/18 for 0, 10.64.64.0/18 for 1 and 10.71.192.0/18 for 31", () => {
    expect(slotCidr(0)).toBe("10.64.0.0/18");
    expect(slotCidr(1)).toBe("10.64.64.0/18");
    expect(slotCidr(4)).toBe("10.65.0.0/18");
    expect(slotCidr(31)).toBe("10.71.192.0/18");
    expect(LAB_SLOTS).toBe(32);
    expect(() => slotCidr(32)).toThrow();
    expect(() => slotCidr(-1)).toThrow();
    expect(() => slotCidr(1.5)).toThrow();
  });

  it("the pool overlaps no gateway range, Docker or 168.63.129.16", () => {
    expect(LAB_POOL).toBe("10.64.0.0/13");
    for (const r of ["10.13.13.0/24", "10.13.255.1/32", "10.50.0.0/16", "192.168.1.0/24", "172.17.0.0/16", "168.63.129.16/32"]) {
      expect(GATEWAY_RANGES).toContain(r);
    }
    for (const r of GATEWAY_RANGES) expect(cidrOverlaps(LAB_POOL, r), r).toBe(false);
    // Every slot is inside the pool and no two slots overlap.
    for (let n = 0; n < LAB_SLOTS; n++) {
      expect(cidrOverlaps(slotCidr(n), LAB_POOL)).toBe(true);
      for (let m = n + 1; m < LAB_SLOTS; m++) expect(cidrOverlaps(slotCidr(n), slotCidr(m))).toBe(false);
    }
    expect(cidrOverlaps("10.71.255.255/32", LAB_POOL)).toBe(true);
    expect(cidrOverlaps("10.72.0.0/32", LAB_POOL)).toBe(false);
  });
});

describe("lab names", () => {
  it("labRg and labLockName follow the spec", () => {
    expect(labRg("az104-05-storage")).toBe("rg-lab-az104-05-storage");
    expect(labLockName("az104-05-storage")).toBe("lab:az104-05-storage");
  });

  it("ownsName refuses another lab's names even when ids share a prefix", () => {
    const ids = ["az104-08-vms", "az104-08-vms-zones", "az104-01-identity"];
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vms", ids)).toBe(true);
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vms-nodes", ids)).toBe(true);
    expect(ownsName("az104-08-vms", "lab-az104-08-vms-ann", ids)).toBe(true);
    expect(ownsName("az104-08-vms", "lab-az104-08-vms-ann@contoso.onmicrosoft.com", ids)).toBe(true);
    expect(ownsName("az104-08-vms", "RG-LAB-AZ104-08-VMS", ids)).toBe(true);
    // Another lab whose id starts with this one's.
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vms-zones", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vms-zones-nodes", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "lab-az104-08-vms-zones-ann", ids)).toBe(false);
    expect(ownsName("az104-08-vms-zones", "rg-lab-az104-08-vms-zones", ids)).toBe(true);
    // Not the lab's at all.
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vmsx", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vm", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "lab-az104-08-vms", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "rg-wg-ondemand", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "NetworkWatcherRG", ids)).toBe(false);
    expect(ownsName("az104-08-vms", "xrg-lab-az104-08-vms", ids)).toBe(false);
    // Without a catalogue, only the structural rule applies.
    expect(ownsName("az104-08-vms", "rg-lab-az104-08-vms-x")).toBe(true);
  });

  it("labIdFromName takes the longest catalogue id", () => {
    const ids = ["az104-08-vms", "az104-08-vms-zones", "az104-01-identity"];
    expect(labIdFromName("rg-lab-az104-08-vms-zones-nodes", ids)).toBe("az104-08-vms-zones");
    expect(labIdFromName("rg-lab-az104-08-vms-nodes", ids)).toBe("az104-08-vms");
    expect(labIdFromName("rg-lab-az104-08-vms", ids)).toBe("az104-08-vms");
    expect(labIdFromName("lab-az104-01-identity-ann", ids)).toBe("az104-01-identity");
    expect(labIdFromName("lab-AZ104-01-IDENTITY-helpdesk", ids)).toBe("az104-01-identity");
    expect(labIdFromName("rg-lab-az104-09-vmss", ids)).toBeNull();
    expect(labIdFromName("NetworkWatcherRG", ids)).toBeNull();
    expect(labIdFromName("rg-wg-ondemand", ids)).toBeNull();
  });

  it("LAB_ID_RE takes the spec's ids and refuses the rest", () => {
    for (const ok of ["az104-06-blob-security", "az305-34-forced-tunnel-fix", "az104-01-identity", "az700-31-ip-nat-outbound"]) expect(LAB_ID_RE.test(ok), ok).toBe(true);
    for (const bad of ["az900-01-x", "az701-31-x", "az104-6-x", "az104-06-", "AZ104-06-x", "az104-06-x_y", "az104-06-x y", " az104-06-x"]) expect(LAB_ID_RE.test(bad), bad).toBe(false);
    expect(LAB_ID_MAX).toBe(40);
  });

  it("AZ-700 is the third exam, and a lab's primary exam is its id's prefix (ruling 38)", () => {
    expect([...LAB_EXAMS]).toEqual(["AZ-104", "AZ-305", "AZ-700"]);
    expect(examOfId("az700-31-ip-nat-outbound")).toBe("AZ-700");
    expect(examOfId("az305-20-landing-zone")).toBe("AZ-305");
    expect(examOfId("az104-06-blob-security")).toBe("AZ-104");
  });
});

describe("governance and permissions", () => {
  it("governance labs are labs 1, 2, 3, 20 and 21, named in code", () => {
    expect([...GOVERNANCE_LABS]).toEqual(["az104-01-identity", "az104-02-policy", "az104-03-mgmt-groups", "az305-20-landing-zone", "az305-21-monitoring-scale"]);
    expect(isGovernanceLab("az104-02-policy")).toBe(true);
    expect(isGovernanceLab("az104-04-cost")).toBe(false);
  });

  it("labNeeds says when a lab needs the governance role or Graph", () => {
    expect(labNeeds(def())).toEqual({ role: false, graph: false });
    expect(labNeeds(def({ identity: { creates: ["group"], roles: [{ role: "Storage Blob Data Reader", scope: "resource_group" }], governance: false } }))).toEqual({ role: true, graph: true });
    expect(labNeeds(def({ id: "az104-02-policy", identity: { creates: [], roles: [], governance: true } }))).toEqual({ role: true, graph: false });
    expect(labNeeds(def({ identity: { creates: ["user"], roles: [], governance: false } }))).toEqual({ role: false, graph: true });
  });

  it("ALLOWED_ROLES lists the §8.1 built-ins by GUID and never Owner or User Access Administrator", () => {
    const names = ALLOWED_ROLES.builtIn.map((r) => r.name);
    for (const n of ["Reader", "Contributor", "Storage Blob Data Reader", "Storage Blob Data Contributor", "Virtual Machine Contributor", "Key Vault Secrets User", "Key Vault Secrets Officer", "Monitoring Reader", "Monitoring Contributor", "Network Contributor", "Backup Operator"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("Owner");
    expect(names).not.toContain("User Access Administrator");
    expect(names).not.toContain("Role Based Access Control Administrator");
    const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const ids = [...ALLOWED_ROLES.builtIn, ...ALLOWED_ROLES.custom].map((r) => r.id);
    for (const id of ids) expect(id).toMatch(guid);
    expect(new Set(ids).size).toBe(ids.length);
    // Owner, User Access Administrator, RBAC Administrator: never on the list.
    for (const banned of ["8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9", "f58310d9-a9f6-439a-9e8d-f62e7b41a168"]) expect(ids).not.toContain(banned);
    for (const c of ALLOWED_ROLES.custom) expect(c.name.startsWith(`lab-${c.lab}-`)).toBe(true);
    expect(ALLOWED_ROLES.principalTypes).toEqual(["User", "Group", "ServicePrincipal"]);
  });
});

describe("cost and time", () => {
  it("estimateGbpH sums gbp_h times qty and uses a fresh retail price when given", () => {
    const items = [
      { name: "VM", gbp_h: 0.0083, qty: 2, retail: { sku: "Standard_B1s" } },
      { name: "Disk", gbp_h: 0.0034 },
      { name: "Endpoint", gbp_h: 0.0076, retail: { meter: "Standard Private Endpoint", unit: "1 Hour" } },
    ];
    expect(estimateGbpH(items)).toBeCloseTo(0.0083 * 2 + 0.0034 + 0.0076, 10);
    // A fresh retail price replaces the authored one; null keeps the authored one.
    const priceOf = (i: { name: string }) => (i.name === "VM" ? 0.01 : null);
    expect(estimateGbpH(items, priceOf)).toBeCloseTo(0.01 * 2 + 0.0034 + 0.0076, 10);
    expect(estimateGbpH([])).toBe(0);
    // No floating dust: six decimal places at most.
    expect(String(estimateGbpH([{ name: "a", gbp_h: 0.1 }, { name: "b", gbp_h: 0.2 }]))).toBe("0.3");
  });

  it("sessionTimeoutMin caps at 150", () => {
    expect(sessionTimeoutMin({ deploy_min: 4, destroy_min: 3 })).toBe(34);
    expect(sessionTimeoutMin({ deploy_min: 35, destroy_min: 20 })).toBe(130);
    expect(sessionTimeoutMin({ deploy_min: 60, destroy_min: 30 })).toBe(150);
  });

  it("costMarker: £ pennies, ££ up to about 50p, £££ about £1 or a long deploy", () => {
    expect(costMarker(0.004, 4)).toBe("£");
    expect(costMarker(0.18, 12)).toBe("££");
    expect(costMarker(0.95, 15)).toBe("£££");
    expect(costMarker(0.05, 35)).toBe("£££");
  });
});

describe("contract lists", () => {
  it("LAB_STEPS are the 16 §5 steps in order, each with the actions it runs on", () => {
    expect(LAB_STEPS).toHaveLength(16);
    expect(LAB_STEPS[0]).toEqual({ n: 1, name: "Check out, Parse payload", on: ["deploy", "destroy", "peer", "unpeer", "test"] });
    expect(LAB_STEPS[12].name).toBe("Safety net");
    expect(LAB_STEPS[12].on).toEqual(["destroy", "test"]);
    expect(LAB_STEPS.map((s) => s.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("LAB_TF_VARS are the §3.4 variables", () => {
    expect([...LAB_TF_VARS]).toEqual(["lab_id", "name_prefix", "resource_group_name", "region", "secondary_region", "address_space", "peered", "gateway_vnet_id", "admin_password", "ssh_public_key", "upn_domain", "tags"]);
  });

  it("labsSettingsFrom reads labs_max_running and labs_default_peering with their defaults", () => {
    expect(labsSettingsFrom({})).toEqual({ labsMaxRunning: 3, labsDefaultPeering: true });
    expect(labsSettingsFrom({ labs_max_running: "5", labs_default_peering: "0" })).toEqual({ labsMaxRunning: 5, labsDefaultPeering: false });
    expect(labsSettingsFrom({ labs_max_running: "9" })).toEqual({ labsMaxRunning: 3, labsDefaultPeering: true });
    expect(labsSettingsFrom({ labs_max_running: "x" }).labsMaxRunning).toBe(3);
  });

  it("LAB_ID_RE, LAB_POOL and GOVERNANCE_LABS equal the scripts' copies", () => {
    expect(scripts.LAB_ID_RE.source).toBe(LAB_ID_RE.source);
    expect(scripts.LAB_ID_RE.flags).toBe(LAB_ID_RE.flags);
    expect(scripts.LAB_ID_MAX).toBe(LAB_ID_MAX);
    expect([...scripts.LAB_EXAMS]).toEqual([...LAB_EXAMS]);
    for (const id of ["az104-01-identity", "az305-20-landing-zone", "az700-44-flow-logs-bastion"]) expect(scripts.examOfId(id)).toBe(examOfId(id));
    expect(scripts.LAB_POOL).toBe(LAB_POOL);
    expect(scripts.LAB_SLOTS).toBe(LAB_SLOTS);
    expect([...scripts.GOVERNANCE_LABS]).toEqual([...GOVERNANCE_LABS]);
    expect([...scripts.GATEWAY_RANGES]).toEqual([...GATEWAY_RANGES]);
    expect([...scripts.LAB_TF_VARS]).toEqual([...LAB_TF_VARS]);
    expect(scripts.slotCidr(31)).toBe(slotCidr(31));
  });
});
