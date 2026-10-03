// fwdraft.test.ts
//
// Plain English: the pure logic behind firewall drafts: what changed between
// the live rules and the draft (added, removed, changed field by field,
// moved, default), reordering a rule to a place, and turning a recent drop
// into an allow rule.
import { describe, it, expect } from "vitest";
import { draftDiff, moveTo, ruleFromDrop, type DraftRule } from "../src/fwdraft";
import type { FwRule } from "../src/firewall";
import type { Peer } from "../src/db";

const PEERS = [{ id: 3, name: "Phone", ip: "10.13.13.2" }] as unknown as Peer[];

function rule(id: number, position: number, over: Partial<FwRule> = {}): FwRule {
  return { id, position, enabled: 1, name: `Rule ${id}`, src_kind: "zone", src_value: "clients", dst_kind: "zone", dst_value: "internet", proto: "any", ports: "", action: "allow", log: 0, ...over };
}
/** The draft's copy of a live rule: same id, live_id pointing at it. */
const copy = (r: FwRule, over: Partial<DraftRule> = {}): DraftRule => ({ ...r, live_id: r.id, ...over });

const LIVE = [1, 2, 3, 4, 5].map((i) => rule(i, i * 10));

describe("draftDiff", () => {
  it("diff: an untouched copy has no changes", () => {
    const d = draftDiff(LIVE, "deny", LIVE.map((r) => copy(r)), "deny", PEERS);
    expect(d).toEqual({ added: [], removed: [], changed: [], moved: [], defaultChanged: null });
  });

  it("diff: added, removed, changed field by field, default changed", () => {
    const draft: DraftRule[] = [
      copy(LIVE[0]),
      copy(LIVE[1], { name: "Renamed", proto: "tcp", ports: "443", src_kind: "client", src_value: "3", enabled: 0 }),
      // LIVE[2] removed
      copy(LIVE[3]),
      copy(LIVE[4]),
      { ...rule(9, 60, { name: "New one", action: "deny" }), live_id: null },
    ];
    const d = draftDiff(LIVE, "deny", draft, "allow", PEERS);
    expect(d.added).toEqual([{ id: 9, name: "New one", place: 5 }]);
    expect(d.removed).toEqual([{ id: 3, name: "Rule 3", place: 3 }]);
    expect(d.changed).toEqual([
      {
        id: 2,
        name: "Renamed",
        fields: [
          { field: "name", before: "Rule 2", after: "Renamed" },
          { field: "from", before: "Tunnel clients", after: "Phone" },
          { field: "service", before: "Any", after: "TCP 443" },
          { field: "enabled", before: "on", after: "off" },
        ],
      },
    ]);
    expect(d.moved).toEqual([]);
    expect(d.defaultChanged).toEqual({ before: "deny", after: "allow" });
  });

  it("diff: moving rule 4 to the top reports one moved rule, not four", () => {
    const order = [LIVE[3], LIVE[0], LIVE[1], LIVE[2], LIVE[4]];
    const draft = order.map((r, i) => copy(r, { position: (i + 1) * 10 }));
    const d = draftDiff(LIVE, "deny", draft, "deny", PEERS);
    expect(d.moved).toEqual([{ id: 4, name: "Rule 4", from: 4, to: 1 }]);
    expect(d.changed).toEqual([]);
  });
});

describe("moveTo", () => {
  it("moveTo: index rules and dir rules give the same order", () => {
    const ids = (rs: { id: number }[]) => rs.map((r) => r.id);
    expect(ids(moveTo(LIVE, 4, 0))).toEqual([4, 1, 2, 3, 5]);
    expect(ids(moveTo(LIVE, 1, 4))).toEqual([2, 3, 4, 5, 1]);
    expect(ids(moveTo(LIVE, 3, 2))).toEqual([1, 2, 3, 4, 5]);
    // "up" is to = index - 1, "down" is index + 1; past either end is no move.
    expect(ids(moveTo(LIVE, 3, 1))).toEqual([1, 3, 2, 4, 5]);
    expect(ids(moveTo(LIVE, 3, 3))).toEqual([1, 2, 4, 3, 5]);
    expect(ids(moveTo(LIVE, 1, -1))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(moveTo(LIVE, 5, 5))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(moveTo(LIVE, 99, 0))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("ruleFromDrop", () => {
  it("ruleFromDrop: a client source becomes a client end and ICMP gets no port", () => {
    expect(ruleFromDrop({ src: "10.13.13.2", dst: "10.50.2.9", proto: "ICMP", dport: 8 }, PEERS)).toEqual({
      name: "Allow Phone to 10.50.2.9 ICMP",
      src_kind: "client",
      src_value: "3",
      dst_kind: "cidr",
      dst_value: "10.50.2.9/32",
      proto: "icmp",
      ports: "",
      action: "allow",
      enabled: 1,
      log: 0,
    });
    expect(ruleFromDrop({ src: "198.51.100.7", dst: "10.50.2.9", proto: "tcp", dport: 443 }, PEERS)).toMatchObject({
      name: "Allow 198.51.100.7 to 10.50.2.9 TCP 443",
      src_kind: "cidr",
      src_value: "198.51.100.7/32",
      proto: "tcp",
      ports: "443",
    });
    expect(ruleFromDrop({ src: "nope", dst: "10.50.2.9", proto: "tcp", dport: 1 }, PEERS)).toBeNull();
  });
});
