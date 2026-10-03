import type { ClientDetailResponse, ClientsResponse } from "@shared/api";
import type { ClientView } from "../../../../worker/src/clients";

// Test data for the Clients view: no personal data (TEST-NET endpoints,
// wg.example.net). Shaped like the Worker's /clients answer.

export const NOW = "2026-10-02T12:00:00.000Z";
const nowMs = Date.parse(NOW);
const ago = (ms: number) => new Date(nowMs - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

export const CONFIG = {
  subnet: "10.13.13.0/24",
  subnet6: "fd13:13::/64",
  loopbackIp: "10.13.13.1",
  vnetCidr: "10.50.0.0/16",
  homeLanCidr: "192.168.1.0/24",
  dnsName: "wg.example.net",
  port: 51820,
};

const key = (c: string) => `${c.repeat(43).slice(0, 43)}=`;

function client(over: Partial<ClientView> & Pick<ClientView, "id" | "name" | "ip">): ClientView {
  return {
    public_key: key(over.name[0]!.toUpperCase()),
    enabled: 1,
    full_tunnel: 0,
    azure_vnet: 0,
    tunnel_dns: 0,
    routes: "",
    home_lan: 0,
    created_at: ago(60 * DAY),
    note: null,
    expires_at: null,
    last_handshake_at: ago(2 * MIN),
    needs_config: 0,
    status: "offline",
    live: null,
    latency: [],
    lastLatencyMs: null,
    allowedIps: ["10.13.13.0/24", "10.13.13.1/32", "fd13:13::/64"],
    siteRoutes: [],
    ip6: null,
    expired: false,
    stale: false,
    expiresSoon: false,
    isSite: false,
    roam: null,
    ...over,
  } as ClientView;
}

const live = (pub: string, secsAgo: number, rx: number, tx: number) => ({
  public_key: pub,
  endpoint: "198.51.100.23:41641",
  allowed_ips: "",
  latest_handshake: Math.floor(nowMs / 1000) - secsAgo,
  rx,
  tx,
});

export function clientList(): ClientView[] {
  return [
    client({
      id: 1,
      name: "home-site",
      ip: "10.13.13.10",
      routes: "192.168.1.0/24",
      public_key: key("H"),
      isSite: true,
      allowedIps: [],
      siteRoutes: ["192.168.1.0/24"],
      status: "online",
      live: live(key("H"), 60, 12_400_000, 8_100_000),
      latency: [18, 19, 17, 18],
      lastLatencyMs: 18,
    }),
    client({
      id: 2,
      name: "phone",
      ip: "10.13.13.3",
      public_key: key("P"),
      full_tunnel: 1,
      tunnel_dns: 1,
      allowedIps: ["0.0.0.0/0", "::/0"],
      status: "online",
      live: live(key("P"), 300, 284_000_000, 96_000_000),
      latency: [30, 34, 31, 32],
      lastLatencyMs: 32,
      expires_at: new Date(nowMs + 5 * DAY).toISOString(),
      expiresSoon: true,
    }),
    client({
      id: 3,
      name: "laptop",
      ip: "10.13.13.4",
      public_key: key("L"),
      azure_vnet: 1,
      home_lan: 1,
      allowedIps: ["10.13.13.0/24", "10.13.13.1/32", "fd13:13::/64", "10.50.0.0/16", "192.168.1.0/24"],
      status: "offline",
      live: live(key("L"), 8 * 86400, 42_000_000, 11_000_000),
      latency: [26, 27],
      lastLatencyMs: null,
      last_handshake_at: ago(8 * DAY),
    }),
    client({ id: 4, name: "old-tablet", ip: "10.13.13.7", public_key: key("T"), enabled: 0, status: "disabled", last_handshake_at: ago(40 * DAY), stale: false }),
    client({
      id: 5,
      name: "guest-ipad",
      ip: "10.13.13.14",
      public_key: key("G"),
      status: "expired",
      expired: true,
      expires_at: ago(DAY),
      last_handshake_at: ago(12 * DAY),
    }),
    client({ id: 6, name: "build-server", ip: "10.13.13.12", public_key: key("B"), status: "loading", last_handshake_at: null, needs_config: 1 }),
    client({ id: 7, name: "backup-box", ip: "10.13.13.8", public_key: key("K"), status: "offline", last_handshake_at: ago(45 * DAY), stale: true }),
  ];
}

export function clientsResponse(over: Partial<ClientsResponse> = {}): ClientsResponse {
  const clients = clientList();
  return {
    now: NOW,
    running: true,
    heartbeatAt: ago(8_000),
    clients,
    kpis: { total: 7, online: 2, avgLatencyMs: 25, fullTunnel: 1, stale: 1, expiringSoon: 1 },
    nextIp: "10.13.13.15",
    nextIp6: null,
    serverPub: key("S"),
    config: CONFIG,
    talkers: [
      { c: "10.13.13.3", r: "203.0.113.5", name: "example.com", up: 1_000_000, down: 9_000_000, bu: 0, bd: 0, at: NOW },
      { c: "10.13.13.10", r: "203.0.113.9", name: null, up: 4_000_000, down: 2_000_000, bu: 0, bd: 0, at: NOW },
    ],
    trafficHist: [
      { t: ago(10 * MIN), rx: 1000, tx: 2000 },
      { t: ago(5 * MIN), rx: 3000, tx: 1000 },
    ],
    ...over,
  } as ClientsResponse;
}

export function detailResponse(id: number): ClientDetailResponse {
  const c = clientList().find((x) => x.id === id)!;
  return {
    client: c,
    talkers: [{ c: c.ip, r: "203.0.113.5", name: "example.com", up: 1_000_000, down: 9_000_000, bu: 0, bd: 0, at: NOW }],
    changes: [{ id: 1, at: ago(3 * DAY), user: "dev@localhost", action: "client.add", target: c.name, before_json: null, after_json: "{}" }],
  };
}

/** Routes for renderApp: the list, every client's detail, empty history. */
export function clientRoutes(over: Partial<ClientsResponse> = {}): Record<string, unknown> {
  const routes: Record<string, unknown> = { "GET /api/v1/clients": clientsResponse(over) };
  for (const c of clientList()) routes[`GET /api/v1/clients/${c.id}`] = detailResponse(c.id);
  routes["GET /api/v1/history"] = { range: "24h", step: 300, from: NOW, to: NOW, points: [], latest: null };
  return routes;
}
