// api/clients.ts
//
// Plain English: the Clients screen's data (this task) and its changes
// (next task): every client with what the VM reports, the counts across
// the top, and one client's detail.

import type { Hono } from "hono";
import { fail, type ApiEnv } from "./app";
import * as db from "../db";
import { getSnapshot } from "../state";
import { effectiveConfig } from "../settings";
import { serverPublicKey, nextFreeIp, peerIp6 } from "../peers";
import { clientView, clientKpis } from "../clients";
import type { ClientsResponse, ClientDetailResponse } from "../../../shared/api";

/** A client id from the address, or null when it is not one. */
export function idParam(v: string): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerClients(api: Hono<ApiEnv>): void {
  api.get("/clients", async (c) => {
    const [peers, snap, cfg, serverPub] = await Promise.all([db.listPeers(c.env), getSnapshot(c.env), effectiveConfig(c.env), serverPublicKey(c.env)]);
    const now = Date.now();
    const clients = peers.map((p) => clientView(p, snap, cfg, now));
    const nextIp = nextFreeIp(cfg.subnet, peers.map((p) => p.ip));
    const out: ClientsResponse = {
      now: new Date(now).toISOString(),
      running: snap.state === "running",
      heartbeatAt: snap.last_agent_at,
      clients,
      kpis: clientKpis(clients),
      nextIp,
      nextIp6: nextIp && cfg.subnet6 ? peerIp6(cfg.subnet6, nextIp) : null,
      serverPub,
      config: { subnet: cfg.subnet, subnet6: cfg.subnet6, loopbackIp: cfg.loopbackIp, vnetCidr: cfg.vnetCidr, homeLanCidr: cfg.homeLanCidr, dnsName: cfg.dnsName, port: cfg.port },
      talkers: Object.values(snap.talkers ?? {}),
      trafficHist: snap.traffic_hist ?? [],
    };
    return c.json(out);
  });

  api.get("/clients/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    if (id === null) return fail(c, 400, "bad_input", "id must be a client's number.", "id");
    const [p, snap, cfg] = await Promise.all([db.getPeer(c.env, id), getSnapshot(c.env), effectiveConfig(c.env)]);
    if (!p) return fail(c, 404, "not_found", "No such client.");
    const out: ClientDetailResponse = {
      client: clientView(p, snap, cfg),
      talkers: Object.values(snap.talkers ?? {}).filter((t) => t.c === p.ip),
      changes: await db.auditFor(c.env, p.name),
    };
    return c.json(out);
  });
}
