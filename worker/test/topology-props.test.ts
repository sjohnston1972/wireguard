// topology-props.test.ts: the allow-list of props and the secret scrub (lab topology spec §4.5, Review Focus 1).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MOCK_SECRETS, PROP_NAMES, scrubProps, secretLike, tagProps, denyProblems } from "../../shared/topology/props";

describe("PROP_NAMES", () => {
  it("is the closed set of spec §4.5", () => {
    expect([...PROP_NAMES].sort()).toEqual(
      [
        "region", "zones", "sku", "tier", "size", "os", "instances", "autoscale", "privateIp", "publicIp", "addressSpace", "prefix",
        "dnsServers", "allocation", "ports", "asn", "bgp", "vpnType", "clientPool", "groupId", "target", "accountKind", "accessTier",
        "replication", "publicAccess", "apiKind", "consistency", "capacity", "retentionDays", "dailyCapGb", "cpu", "memoryGb", "ingress",
        "targetPort", "routing", "hostName", "effect", "enforcement", "scopeAccess", "mode", "status", "counts", "chips", "tags",
        "peerTarget", "group", "resourceId",
      ].sort(),
    );
  });

  it("no allowed name reads like a secret", () => {
    for (const n of PROP_NAMES) expect(n, n).not.toMatch(/password|secret|key|token|sas|connection|cert|custom|user_?data/i);
  });
});

describe("scrubProps", () => {
  it("scrubProps drops every name outside PROP_NAMES", () => {
    const r = scrubProps({ size: "Standard_B1s", admin_password: "x", adminPassword: "y", custom_data: "z", connectionString: "w", sku: "Standard" });
    expect(r.props).toEqual({ size: "Standard_B1s", sku: "Standard" });
    expect(r.withheld).toBe(4);
  });

  it("a value that looks like a key, token, PEM, SAS or the mock password is withheld and noted", () => {
    const samples = [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
      "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFy1A==", // a 40+ base64 run
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", // a JWT
      "https://x.blob.core.windows.net/c?sv=2024&sig=abc%3D", // SAS
      "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abc",
      "my password is hunter2",
      "SharedKey abc",
      "client secret here",
      MOCK_SECRETS.adminPassword,
      `prefix ${MOCK_SECRETS.adminPassword} suffix`,
      MOCK_SECRETS.sshPublicKey,
      "x".repeat(257),
    ];
    for (const s of samples) {
      const r = scrubProps({ hostName: s });
      expect(r.props, s).toEqual({});
      expect(r.withheld, s).toBe(1);
    }
    // A list is withheld whole when any member is secret-like.
    expect(scrubProps({ dnsServers: ["10.0.0.4", MOCK_SECRETS.adminPassword] })).toEqual({ props: {}, withheld: 1 });
  });

  it("ordinary values pass: names, sizes, CIDRs, ARM ids, booleans, numbers, lists", () => {
    const props = {
      size: "Standard_D2s_v5",
      addressSpace: ["10.71.192.0/20"],
      privateIp: "10.71.192.4",
      resourceId: "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-lab-az700-35-forced-tunnel-fix/providers/Microsoft.Network/virtualNetworks/vnet-hub",
      publicAccess: false,
      instances: 2,
      hostName: "l42k3x9q-ep-abcdefgh.z01.azurefd.net",
      group: "rg-lab-az305-27-multi-region-secondary",
      target: "/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/rg-lab-az700-43-private-link/providers/Microsoft.OperationalInsights/workspaces/law-l43k3x9q-flowlogs",
    };
    expect(scrubProps(props)).toEqual({ props, withheld: 0 });
  });

  it("values of other types (objects, null) are dropped without counting", () => {
    expect(scrubProps({ sku: null as never, size: { a: 1 } as never, zones: ["1", "2"] })).toEqual({ props: { zones: ["1", "2"] }, withheld: 0 });
  });

  it("secretLike says the same as the scrub", () => {
    expect(secretLike("Standard_B1s")).toBe(false);
    expect(secretLike(MOCK_SECRETS.adminPassword)).toBe(true);
  });
});

describe("MOCK_SECRETS", () => {
  it("MOCK_SECRETS equal labs-tf's mock password and key", () => {
    const text = readFileSync(new URL("../../scripts/labs-tf.mjs", import.meta.url), "utf8");
    expect(text).toContain(`admin_password      = "${MOCK_SECRETS.adminPassword}"`);
    expect(text).toContain(`const MOCK_SSH_KEY = "${MOCK_SECRETS.sshPublicKey}"`);
  });
});

describe("tags", () => {
  it("tags keep lab and project only and count the rest", () => {
    expect(tagProps({ project: "wg-admin-labs", lab: "az104-13-vnets", session: "ls-abc", owner: "someone@contoso.onmicrosoft.com" })).toEqual(["lab: az104-13-vnets", "project: wg-admin-labs", "+2 tags"]);
    expect(tagProps({ lab: "az104-13-vnets", session: "ls-abc" })).toEqual(["lab: az104-13-vnets", "+1 tag"]);
    expect(tagProps({ Lab: "az104-13-vnets" })).toEqual(["lab: az104-13-vnets"]);
    expect(tagProps(null)).toEqual([]);
    expect(tagProps({})).toEqual([]);
  });
});

describe("denyProblems", () => {
  it("finds a foreign prop name, the mock secrets and secret-like values anywhere in a graph", () => {
    const g = {
      schema: 1,
      labId: "az104-13-vnets",
      version: 1,
      source: "planned",
      at: null,
      nodes: [
        { id: "tf:a", key: "a", kind: "vm", label: "vm-a", props: { size: "B1s" } },
        { id: "tf:b", key: "b", kind: "vm", label: MOCK_SECRETS.adminPassword, props: { admin_password: "x" } },
      ],
      edges: [{ id: "e", from: "tf:a", to: "tf:b", kind: "traffic", label: "ok" }],
    };
    const p = denyProblems(g as never);
    expect(p.some((x) => x.includes("admin_password"))).toBe(true);
    expect(p.some((x) => x.includes("label"))).toBe(true);
    expect(denyProblems({ ...g, nodes: [g.nodes[0]!] } as never)).toEqual([]);
  });
});
