// fwdraft.ts
//
// Plain English: the thinking behind firewall drafts, with no database in
// sight. Rule edits go into a draft first; this works out what Apply would
// change compared with the live rules (added, removed, changed field by
// field, moved, the default), reorders a rule to a given place, and turns a
// recent drop into an allow rule for exactly that flow.
//
// "Moved" is the smallest honest answer: of the rules in both lists, those
// that are not part of the longest run already in live order. Dragging rule
// 4 to the top is one move, not four rules shuffled down a place.

import type { Config } from "./env";
import type { Peer } from "./db";
import { endLabel, parseCidr, ruleLines, serviceLabel, type FwRule, type Proto } from "./firewall";
import type { DraftDiff, FirewallDraft } from "../../shared/api";

/** A draft row: a rule plus the live rule it edits (null for a rule added in the draft). */
export interface DraftRule extends FwRule {
  live_id: number | null;
}

/** A rule's contents, as the draft routes write them. */
export type RuleBody = Omit<FwRule, "id" | "position">;

const byPlace = <T extends { position: number; id: number }>(rs: T[]): T[] => [...rs].sort((a, b) => a.position - b.position || a.id - b.id);

const onOff = (n: number) => (n ? "on" : "off");

/** Field-by-field differences between a live rule and its draft copy, in the words the review shows. */
function fieldChanges(a: FwRule, b: FwRule, peers: Peer[]): { field: string; before: string; after: string }[] {
  const out: { field: string; before: string; after: string }[] = [];
  const add = (field: string, same: boolean, before: string, after: string) => {
    if (!same) out.push({ field, before, after });
  };
  const end = (kind: FwRule["src_kind"], value: string) => endLabel(kind, value, peers);
  /** Two ends that read the same (two deleted clients) still show what differs. */
  const endPair = (ak: FwRule["src_kind"], av: string, bk: FwRule["src_kind"], bv: string): [string, string] => {
    const x = end(ak, av), y = end(bk, bv);
    return x === y ? [`${ak}:${av}`, `${bk}:${bv}`] : [x, y];
  };
  add("name", a.name === b.name, a.name, b.name);
  add("from", a.src_kind === b.src_kind && a.src_value === b.src_value, ...endPair(a.src_kind, a.src_value, b.src_kind, b.src_value));
  add("to", a.dst_kind === b.dst_kind && a.dst_value === b.dst_value, ...endPair(a.dst_kind, a.dst_value, b.dst_kind, b.dst_value));
  add("service", a.proto === b.proto && a.ports === b.ports, serviceLabel(a), serviceLabel(b));
  add("action", a.action === b.action, a.action, b.action);
  add("enabled", !!a.enabled === !!b.enabled, onOff(a.enabled), onOff(b.enabled));
  add("log", !!a.log === !!b.log, onOff(a.log), onOff(b.log));
  return out;
}

/** Indices (into `xs`) of one longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): Set<number> {
  const len: number[] = [];
  const prev: number[] = [];
  let best = -1;
  for (let i = 0; i < xs.length; i++) {
    len[i] = 1;
    prev[i] = -1;
    for (let j = 0; j < i; j++) {
      if (xs[j] < xs[i] && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1;
        prev[i] = j;
      }
    }
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

/**
 * What Apply would change. Places are 1-based: a removed rule's place is in
 * the live list, everything else's in the draft's. A draft row whose live
 * rule no longer exists counts as added.
 */
export function draftDiff(live: FwRule[], liveDefault: "allow" | "deny", draft: DraftRule[], draftDefault: "allow" | "deny", peers: Peer[]): DraftDiff {
  const L = byPlace(live);
  const D = byPlace(draft);
  const livePlace = new Map(L.map((r, i) => [r.id, i]));
  const kept = new Set<number>();
  const added: DraftDiff["added"] = [];
  const changed: DraftDiff["changed"] = [];
  const pairs: { d: DraftRule; at: number; from: number }[] = [];
  D.forEach((d, i) => {
    const li = d.live_id === null ? undefined : livePlace.get(d.live_id);
    if (li === undefined || kept.has(d.live_id!)) {
      added.push({ id: d.id, name: d.name, place: i + 1 });
      return;
    }
    kept.add(d.live_id!);
    pairs.push({ d, at: i, from: li });
    const fields = fieldChanges(L[li], d, peers);
    if (fields.length) changed.push({ id: d.id, name: d.name, fields });
  });
  const removed = L.flatMap((r, i) => (kept.has(r.id) ? [] : [{ id: r.id, name: r.name, place: i + 1 }]));
  const inOrder = longestIncreasing(pairs.map((p) => p.from));
  const moved = pairs.flatMap((p, k) => (inOrder.has(k) ? [] : [{ id: p.d.id, name: p.d.name, from: p.from + 1, to: p.at + 1 }]));
  const defaultChanged = liveDefault === draftDefault ? null : { before: liveDefault, after: draftDefault };
  return { added, removed, changed, moved, defaultChanged };
}

/** How many changes a diff holds (each default change counts one). */
export function diffCount(d: DraftDiff): number {
  return d.added.length + d.removed.length + d.changed.length + d.moved.length + (d.defaultChanged ? 1 : 0);
}

/**
 * The draft as GET /firewall shows it: its rules in order with labels, the
 * compile problem of each enabled one, how each differs from live, the
 * diff and its size. `stale` when the live rules changed after it began.
 */
export function draftView(
  o: { live: FwRule[]; liveDefault: "allow" | "deny"; draft: DraftRule[]; draftDefault: "allow" | "deny"; peers: Peer[]; cfg: Config; baseVersion: number; liveVersion: number },
): FirewallDraft {
  const diff = draftDiff(o.live, o.liveDefault, o.draft, o.draftDefault, o.peers);
  const added = new Set(diff.added.map((x) => x.id));
  const changed = new Set(diff.changed.map((x) => x.id));
  const moved = new Set(diff.moved.map((x) => x.id));
  const rules = byPlace(o.draft).map((r, i) => {
    const { live_id, ...rule } = r;
    return {
      ...rule,
      liveId: added.has(r.id) ? null : live_id,
      place: i + 1,
      fromLabel: endLabel(r.src_kind, r.src_value, o.peers),
      toLabel: endLabel(r.dst_kind, r.dst_value, o.peers),
      service: serviceLabel(r),
      problem: r.enabled ? ruleLines(r, o.cfg, o.peers).problem : null,
      mark: added.has(r.id) ? ("added" as const) : changed.has(r.id) ? ("changed" as const) : moved.has(r.id) ? ("moved" as const) : null,
    };
  });
  return { baseVersion: o.baseVersion, stale: o.baseVersion !== o.liveVersion, defaultAction: o.draftDefault, rules, diff, changes: diffCount(diff) };
}

/**
 * The rules (in place order) with one moved to a 0-based index. An index
 * past either end, the rule's own place, or an unknown id leaves the order
 * as it was. A step up is `to = index - 1`, a step down `index + 1`.
 */
export function moveTo<T extends { id: number; position: number }>(rules: T[], id: number, to: number): T[] {
  const order = byPlace(rules);
  const from = order.findIndex((r) => r.id === id);
  if (from < 0 || to < 0 || to >= order.length || to === from) return order;
  const [r] = order.splice(from, 1);
  order.splice(to, 0, r);
  return order;
}

/** One recent drop, as GET /firewall lists it. */
export interface DropIn {
  src: string;
  dst: string;
  proto: string;
  dport: number | null;
}

/**
 * "Allow this" on a recent drop: an allow rule for exactly that flow. A
 * source that is a tunnel client becomes that client (so the rule follows
 * it); everything else is the address itself. Ports only for TCP and UDP.
 * Null when the drop has no usable addresses.
 */
export function ruleFromDrop(drop: DropIn, peers: Peer[]): RuleBody | null {
  const src = parseCidr(String(drop.src ?? "")), dst = parseCidr(String(drop.dst ?? ""));
  if (!src || !dst) return null;
  const client = peers.find((p) => `${p.ip}/32` === src.text);
  const proto = ({ TCP: "tcp", UDP: "udp", ICMP: "icmp", ICMPV6: "icmp" } as Record<string, Proto>)[String(drop.proto ?? "").toUpperCase()] ?? "any";
  const port = /^\d{1,5}$/.test(String(drop.dport ?? "")) && Number(drop.dport) >= 1 && Number(drop.dport) <= 65535 && (proto === "tcp" || proto === "udp") ? String(drop.dport) : "";
  const name = `Allow ${client?.name ?? src.text.replace(/\/(32|128)$/, "")} to ${dst.text.replace(/\/(32|128)$/, "")} ${proto === "any" ? "" : proto.toUpperCase()}${port ? ` ${port}` : ""}`.trim().slice(0, 60);
  return { name, src_kind: client ? "client" : "cidr", src_value: client ? String(client.id) : src.text, dst_kind: "cidr", dst_value: dst.text, proto, ports: port, action: "allow", enabled: 1, log: 0 };
}
