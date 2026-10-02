// simulate.ts
//
// Plain English: "what would the firewall do with this?". You describe one
// flow (from where, to where, which protocol and port) and this walks the
// rule table the way the VM does: top to bottom, disabled rules and rules
// that cannot compile skipped, the first rule that matches wins, and the
// default decides when none does. It is a packet tracer for the rule table.
//
// It reads each end through the same address sets the compiled rules use
// (endAddrs, parseCidr, parsePorts, ruleLines), so "the internet" means
// everything except the private nets here exactly as it does on the VM.
// A rule that covers only part of the flow (a zone asked about, a rule for one
// client in it) does not decide the answer; it is listed as "depends on the
// exact address" and the walk goes on, as the VM would for the other addresses.
//
// IPv4 only. What it cannot see (published ports, the VM's own traffic,
// replies, traffic that never reaches the VM) is said in `limited`.

import type { Config } from "./env";
import type { Peer } from "./db";
import { endAddrs, parseCidr, parsePorts, ruleLines, liveForwards, type EndKind, type Forward, type FwRule } from "./firewall";
import type { SimResult, SimRuleRef } from "../../shared/api";

export interface SimEndInput {
  kind: EndKind;
  value: string;
}

export interface SimInput {
  from: SimEndInput;
  to: SimEndInput;
  proto: "tcp" | "udp" | "icmp";
  port: number | null;
}

export interface SimContext {
  rules: FwRule[];
  defaultAction: "allow" | "deny";
  cfg: Config;
  peers: Peer[];
  /** The VM's public address, if known; lets the simulator flag flows aimed at it. */
  publicIp?: string | null;
  /** Published ports, if known; lets the simulator flag flows that hit one. */
  forwards?: Forward[];
}

// ── IPv4 address sets as sorted, merged [first, last] ranges ──

type Ranges = [number, number][];
const MAX = 0xffffffff;

const toInt = (a: string): number => a.split(".").reduce((n, x) => n * 256 + Number(x), 0);

/** "10.0.0.5/24" -> [10.0.0.0, 10.0.0.255]; host bits are masked off, as nft does. */
function cidrRange(text: string): [number, number] {
  const [base, bits = "32"] = text.split("/");
  const size = 2 ** (32 - Number(bits));
  const lo = Math.floor(toInt(base) / size) * size;
  return [lo, lo + size - 1];
}

function merge(xs: Ranges): Ranges {
  const out: Ranges = [];
  for (const [lo, hi] of [...xs].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function complement(xs: Ranges): Ranges {
  const out: Ranges = [];
  let next = 0;
  for (const [lo, hi] of merge(xs)) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX) out.push([next, MAX]);
  return out;
}

function intersect(a: Ranges, b: Ranges): Ranges {
  const out: Ranges = [];
  for (const [alo, ahi] of a) for (const [blo, bhi] of b) {
    const lo = Math.max(alo, blo), hi = Math.min(ahi, bhi);
    if (lo <= hi) out.push([lo, hi]);
  }
  return merge(out);
}

/** The IPv4 addresses one end stands for; empty when it has none (a deleted client, an unset home LAN, an IPv6-only end). */
function v4Set(kind: EndKind, value: string, cfg: Config, peers: Peer[]): Ranges {
  const a = endAddrs(kind, value, cfg, peers);
  if (a === "any") return [[0, MAX]];
  if (a === null) return [];
  const set = merge(a.v4.map(cidrRange));
  return a.negate ? complement(set) : set;
}

type Rel = "none" | "partial" | "full";

/** How much of the flow's addresses a rule's addresses cover. */
function relation(flow: Ranges, rule: Ranges): Rel {
  if (!flow.length) return "none";
  const both = intersect(flow, rule);
  if (!both.length) return "none";
  return intersect(flow, complement(rule)).length === 0 ? "full" : "partial";
}

/** How much of the flow's port a rule's port list covers. A flow with no port named could be any port. */
function portRelation(ports: string, port: number | null): Rel {
  if (!ports.trim()) return "full";
  if (port === null) return "partial";
  const hit = ports.replace(/\s+/g, "").split(",").some((p) => {
    const [lo, hi = lo] = p.split("-").map(Number);
    return port >= lo && port <= hi;
  });
  return hit ? "full" : "none";
}

const meet = (...rels: Rel[]): Rel => (rels.includes("none") ? "none" : rels.every((r) => r === "full") ? "full" : "partial");

const contains = (set: Ranges, ip: string): boolean => relation([[toInt(ip), toInt(ip)]], set) === "full";

/** The notes on what this simulation leaves out, for this flow. */
function limits(input: SimInput, ctx: SimContext, from: Ranges, to: Ranges): string | null {
  const notes: string[] = [];
  const { cfg } = ctx;
  if (!from.length || !to.length) notes.push("One end has no IPv4 addresses (it is not set up, or it is IPv6 only), so no rule can match it.");
  if (input.proto === "icmp") notes.push("The VM answers ping (ICMP echo) to itself whatever the rules say; ping through it follows them. Replies to allowed connections are not simulated.");
  const vmOwn = [cfg.loopbackIp, `${cfg.subnet.split("/")[0].replace(/\.\d+$/, ".1")}`];
  const touchesVm = (e: SimEndInput, set: Ranges) => e.kind === "cidr" && vmOwn.some((ip) => ip && contains(set, ip));
  if (touchesVm(input.from, from) || touchesVm(input.to, to)) notes.push("Traffic to or from the VM itself is not filtered by these rules.");
  if (ctx.publicIp && input.to.kind === "cidr" && contains(to, ctx.publicIp)) {
    const hit = input.proto !== "icmp" && liveForwards(ctx.forwards ?? [], cfg).some((f) => f.proto === input.proto && (input.port === null || f.public_port === input.port));
    notes.push(`That includes the VM's public address. Published ports and replies to allowed connections are not simulated${hit ? "; this flow matches a published port" : ""}.`);
  }
  const vnet: Ranges = [cidrRange(cfg.vnetCidr)];
  if (from.length && to.length && relation(from, vnet) === "full" && relation(to, vnet) === "full") notes.push("Traffic inside the Azure VNet does not pass through the VM, so these rules do not govern it.");
  return notes.length ? notes.join(" ") : null;
}

/**
 * Run one flow past the rules. Rules are tried in the order the VM tries them
 * (position, then id), skipping disabled rules and rules whose compile
 * produced a problem. `place` is the rule's row number on the Firewall screen
 * (its place among all rules, disabled ones included).
 */
export function simulate(input: SimInput, ctx: SimContext): SimResult {
  const { cfg, peers } = ctx;
  const from = v4Set(input.from.kind, input.from.value, cfg, peers);
  const to = v4Set(input.to.kind, input.to.value, cfg, peers);
  const ordered = [...ctx.rules].sort((a, b) => a.position - b.position || a.id - b.id);
  const partial: SimRuleRef[] = [];
  const limited = limits(input, ctx, from, to);

  for (const [i, r] of ordered.entries()) {
    if (!r.enabled || ruleLines(r, cfg, peers).problem) continue;
    const ref = { id: r.id, name: r.name, place: i + 1 };
    const protoRel: Rel = r.proto === "any" || r.proto === input.proto ? "full" : "none";
    // The VM only reads a port list on a tcp or udp rule.
    const ports = r.proto === "tcp" || r.proto === "udp" ? r.ports : "";
    const rel = meet(
      relation(from, v4Set(r.src_kind, r.src_value, cfg, peers)),
      relation(to, v4Set(r.dst_kind, r.dst_value, cfg, peers)),
      protoRel,
      input.proto === "icmp" ? "full" : portRelation(parsePorts(ports) === null ? "" : ports, input.port),
    );
    if (rel === "none") continue;
    if (rel === "partial") {
      partial.push(ref);
      continue;
    }
    const verb = r.action === "allow" ? "Allowed" : "Denied";
    return { verdict: r.action, matched: ref, reason: `${verb} by rule ${ref.place}, ${r.name}.`, partial, limited };
  }
  const allow = ctx.defaultAction === "allow";
  return { verdict: allow ? "allow" : "deny", matched: null, reason: `No rule matched; the default ${allow ? "allows" : "denies"} it.`, partial, limited };
}
