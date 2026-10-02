// Test data for the Firewall view's tests: a whole GET /firewall answer (the
// shared fixture is deliberately partial) and a draft built from it. No
// personal data: tunnel addresses, TEST-NET ranges and dev@localhost only.
import type { DraftDiff, DraftRuleRow, FirewallDraft, FirewallResponse, FirewallRuleRow } from "@shared/api";

const hourly = (scale: number): (number | null)[] => Array.from({ length: 24 }, (_, h) => (h >= 2 && h < 5 ? null : ((h * 7) % 11) * scale));

type RuleSeed = Pick<FirewallRuleRow, "id" | "name" | "src_kind" | "src_value" | "dst_kind" | "dst_value" | "fromLabel" | "toLabel"> & Partial<FirewallRuleRow>;

function rule(place: number, r: RuleSeed): FirewallRuleRow {
  return {
    position: place * 10,
    enabled: 1,
    proto: "any",
    ports: "",
    action: "allow",
    log: 0,
    place,
    service: "Any",
    hits: [100, 1000],
    lastHit: "2026-10-02T11:59:00.000Z",
    problem: null,
    hits24h: 1000 - place * 100,
    trend24h: hourly(place),
    starter: true,
    ...r,
  };
}

export function liveRules(): FirewallRuleRow[] {
  return [
    rule(1, { id: 1, name: "Clients to the Azure VNet", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "azure", fromLabel: "Tunnel clients", toLabel: "Azure VNet" }),
    rule(2, { id: 2, name: "Clients to the internet (full tunnel)", src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet", fromLabel: "Tunnel clients", toLabel: "Internet" }),
    rule(3, { id: 3, name: "Web to the test server", src_kind: "zone", src_value: "clients", dst_kind: "cidr", dst_value: "198.51.100.0/24", fromLabel: "Tunnel clients", toLabel: "198.51.100.0/24", proto: "tcp", ports: "443", service: "TCP 443", starter: false }),
    rule(4, { id: 4, name: "Block old printer", src_kind: "zone", src_value: "clients", dst_kind: "cidr", dst_value: "192.0.2.50/32", fromLabel: "Tunnel clients", toLabel: "192.0.2.50/32", action: "deny", enabled: 0, starter: false, hits24h: null, trend24h: [] }),
    rule(5, { id: 5, name: "Workloads to the internet (updates)", src_kind: "zone", src_value: "workloads", dst_kind: "zone", dst_value: "internet", fromLabel: "Workloads subnet", toLabel: "Internet" }),
  ];
}

export function firewallData(over: Partial<FirewallResponse> = {}): FirewallResponse {
  const rules = liveRules();
  return {
    now: "2026-10-02T12:00:00.000Z",
    running: true,
    defaultAction: "deny",
    policy: { hash: "abcdef0123456789", state: "applied", text: "Applied on the VM (rule set abcdef01)." },
    rules,
    defaultHits: [42, 4200],
    defaultLastHit: null,
    countersClearedAt: "2026-09-30T08:00:00.000Z",
    defaultHits24h: 342,
    defaultTrend24h: hourly(2),
    drops: {
      recent: [
        { at: "2026-10-02T11:58:00.000Z", src: "10.13.13.4", dst: "192.168.1.10", proto: "tcp", dport: 8080, fromName: "dev-laptop", toName: "192.168.1.10" },
        { at: "2026-10-02T11:57:00.000Z", src: "10.13.13.5", dst: "203.0.113.44", proto: "udp", dport: 53, fromName: "test-phone", toName: "203.0.113.44" },
      ],
      last24h: 342,
      uniqueSources24h: 18,
      previous24h: 305,
      hourly24h: hourly(3),
    },
    zones: [
      { zone: "clients", label: "Tunnel clients", v4: ["10.13.13.0/24"], v6: [], negate: false },
      { zone: "home", label: "Home LAN", v4: ["192.168.1.0/24"], v6: [], negate: false },
      { zone: "azure", label: "Azure VNet", v4: ["10.50.0.0/16"], v6: [], negate: false },
      { zone: "workloads", label: "Workloads subnet", v4: ["10.50.2.0/24"], v6: [], negate: false },
      { zone: "internet", label: "Internet", v4: ["0.0.0.0/0"], v6: [], negate: true },
    ],
    testVm: { ip: "10.50.2.4", enabled: true },
    forwards: [
      { id: 1, enabled: 1, name: "Test VM web page", proto: "tcp", public_port: 8080, target_ip: "10.50.2.4", target_port: 80, allow_from: "", connections: [3, 900], lastHit: null },
    ],
    captures: [
      { id: "cap1", requested_at: "2026-10-02T11:00:00.000Z", requested_by: "dev@localhost", iface: "wg0", filter: "", seconds: 30, status: "done", bytes: 20480, finished_at: "2026-10-02T11:00:40.000Z", error: null },
    ],
    capture: { busy: false, ifaces: { wg0: "Inside the tunnel (decrypted client traffic)", eth0: "Azure side (the VNet and the internet)", any: "Both" } },
    publicIp: "203.0.113.10",
    dnsName: "wg.example.net",
    kpis: { rules: 5, enabled: 4, defaultAction: "deny", drops24h: 342, published: 1, captureBusy: false },
    version: 4,
    draft: null,
    ...over,
  };
}

const EMPTY_DIFF: DraftDiff = { added: [], removed: [], changed: [], moved: [], defaultChanged: null };

/** A draft over firewallData's rules: rule 3 disabled (changed), a new rule added last. */
export function draftData(over: Partial<FirewallDraft> = {}): FirewallDraft {
  const rows: DraftRuleRow[] = liveRules().map((r) => {
    const { hits: _h, lastHit: _l, hits24h: _h24, trend24h: _t, starter: _s, ...base } = r;
    return { ...base, liveId: r.id, mark: null };
  });
  rows[2] = { ...rows[2], enabled: 0, mark: "changed" };
  rows.push({
    id: 9,
    liveId: null,
    position: 60,
    enabled: 1,
    name: "SSH to workloads",
    src_kind: "zone",
    src_value: "clients",
    dst_kind: "zone",
    dst_value: "workloads",
    proto: "tcp",
    ports: "22",
    action: "allow",
    log: 0,
    place: 6,
    fromLabel: "Tunnel clients",
    toLabel: "Workloads subnet",
    service: "TCP 22",
    problem: null,
    mark: "added",
  });
  return {
    baseVersion: 4,
    stale: false,
    defaultAction: "deny",
    rules: rows,
    diff: {
      ...EMPTY_DIFF,
      added: [{ id: 9, name: "SSH to workloads", place: 6 }],
      changed: [{ id: 3, name: "Web to the test server", fields: [{ field: "enabled", before: "on", after: "off" }] }],
    },
    changes: 2,
    ...over,
  };
}

export const OK = { ok: true, message: "Saved to the draft." };
