// history.test.ts
//
// Plain English: the dashboard's own history (history.ts). Samples from
// heartbeats, the watchman filling in missed minutes, folding old samples
// into 5-minute summaries, and the run step list kept with each run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeEnv, type World } from "./harness";
import type { Env } from "../src/env";

let env: Env;
let world: World;
beforeEach(() => {
  ({ env, world } = makeEnv());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const columns = async (table: string) =>
  (await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((r) => r.name);

describe("schema", () => {
  it("has the history tables and the run step column", async () => {
    expect(await columns("hist_vm")).toEqual(["res", "t", "expected", "received", "load1", "rx_rate", "tx_rate", "rx_rate_max", "tx_rate_max", "peers_online", "dns_up"]);
    expect(await columns("hist_client")).toEqual(["res", "t", "peer_id", "online", "handshake_age", "latency_avg", "latency_max", "rx", "tx"]);
    expect(await columns("hist_drops")).toEqual(["t", "src", "dst", "proto", "dport", "in_if", "out_if", "n"]);
    expect(await columns("runs")).toContain("steps_json");
  });
});
