// insights-bootlog.test.ts
//
// Plain English: the boot log (plan X1.8, spec 11). Azure hands out a
// five-minute signed URL for the VM's serial log; the Worker reads at most
// the last 64 KB, redacts anything secret, and stores only the redacted
// text. The URL itself never reaches D1, a response, an error or the logs.
import { describe, it, expect, afterEach, vi } from "vitest";
import { redact, REDACTED } from "../src/insights/redact";
import { runInsights } from "../src/insights/runner";
import { saveSnapshot } from "../src/state";
import { api, base } from "./api-helpers";
import { azureEnv, running, allNotDue, feedRows, latest, callsTo, json, NOW, ago, MIN, NO_AZURE } from "./insights-helpers";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/auth";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SAS = /sig=|blob\.core\.windows\.net|sv=2018/i;
const routeEnv = (over = {}) => azureEnv({ AUTH_DEV_BYPASS: "1", PUBLIC_URL: base, ...over });

async function everything(env: Env): Promise<string> {
  let all = "";
  for (const t of ["az_feed", "az_latest", "az_activity", "az_service_events", "az_capacity", "az_prices", "alerts", "audit"]) all += JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results);
  return all;
}

describe("redaction", () => {
  const cases: [string, string, string, number][] = [
    ["PEM private key", "a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\nAAAAAAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5\n-----END OPENSSH PRIVATE KEY-----\nb", `a\n${REDACTED}\nb`, 1],
    ["PEM key cut off by the 64 KB tail", "x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow", `x\n${REDACTED}`, 1],
    ["WireGuard-shaped key", "PrivateKey = yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk= end", `PrivateKey = ${REDACTED} end`, 1],
    ["password", "login password: hunter2 ok", `login password: ${REDACTED} ok`, 1],
    ["passwd", "passwd=abc123", `passwd=${REDACTED}`, 1],
    ["secret", "client_secret=s3cr3t-Value", `client_secret=${REDACTED}`, 1],
    ["token", "token: abc.def", `token: ${REDACTED}`, 1],
    ["apikey", "APIKEY=k-1234", `APIKEY=${REDACTED}`, 1],
    ["authorization with a scheme", "Authorization: Bearer abc.def.ghi next", `Authorization: ${REDACTED} next`, 1],
    ["bearer", "sent bearer xyz789", `sent bearer ${REDACTED}`, 1],
    ["base64 run of 64+", `cert ${"QUJD".repeat(20)} done`, `cert ${REDACTED} done`, 1],
    ["URL with sig=", "fetch https://md-1.blob.core.windows.net/c/serial.log?sv=2018-03-28&sr=b&sig=AbC%2Bd%3D failed", `fetch ${REDACTED} failed`, 1],
    ["nothing secret", "[    1.234567] systemd[1]: Started Journal Service.", "[    1.234567] systemd[1]: Started Journal Service.", 0],
  ];
  for (const [name, input, want, count] of cases) {
    it(`each redaction pattern: ${name}`, () => {
      expect(redact(input)).toEqual({ text: want, count });
    });
  }

  it("each redaction pattern: the current run's SSH password, wherever it appears", () => {
    expect(redact("cloud-init: chpasswd set Tr0ub4dor&3 for wgadmin; Tr0ub4dor&3", ["Tr0ub4dor&3"])).toEqual({ text: `cloud-init: chpasswd set ${REDACTED} for wgadmin; ${REDACTED}`, count: 2 });
    // A short or empty extra is ignored (it would redact ordinary words).
    expect(redact("abc", ["", "ab"]).count).toBe(0);
  });
});

describe("boot log", () => {
  it("POST fetches the serial log through a short-lived signed URL, redacted", async () => {
    const { env, az } = routeEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await running(env);
    az.serialLog = "boot line 1\npassword=hunter2\nwg-admin ready\n";
    const r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ fetchedAt: NOW.toISOString(), bytes: az.serialLog.length, truncated: false, redactions: 1, text: `boot line 1\npassword=${REDACTED}\nwg-admin ready\n`, reason: null });
    const retrieve = callsTo(az, "retrieveBootDiagnosticsData")[0]!;
    expect(retrieve.method).toBe("POST");
    expect(retrieve.u.searchParams.get("sasUriExpirationTimeInMinutes")).toBe("5");
    expect(retrieve.u.searchParams.get("api-version")).toBe("2024-07-01");
    // Only the serial log blob, never the screenshot.
    expect(az.calls.filter((c) => c.u.hostname.endsWith("blob.core.windows.net")).every((c) => c.u.pathname.endsWith("serialconsole.log"))).toBe(true);
    expect((await api(env, "GET", "/azure/bootlog")).json).toEqual(r.json);
    expect((await feedRows(env)).bootLog.status).toBe("ok");
  });

  it("the run's agent token, callback token and SSH password are redacted from the boot log", async () => {
    const { env, az } = routeEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await running(env);
    // The Worker keeps only the tokens' SHA-256 hashes; it finds the literals in the log by hashing what looks like a token.
    const agentToken = "a1".repeat(32);
    const callbackToken = "c3".repeat(32);
    const otherHex = "0f".repeat(32); // a 64-hex value that is not one of the run's tokens
    await env.DB.prepare(
      "INSERT INTO runs (id, action, status, requested_at, finished_at, callback_token_hash, agent_token_hash, ssh_password) VALUES ('run-1', 'apply', 'success', ?1, ?1, ?2, ?3, 'Tr0ub4dor&3')",
    )
      .bind(ago(120), await sha256Hex(callbackToken), await sha256Hex(agentToken))
      .run();
    az.serialLog = `cloud-init: AGENT/${agentToken}\ncloud-init: CB/${callbackToken}\nchpasswd Tr0ub4dor&3\nhex ${otherHex}\nwg-admin ready\n`;
    const r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    // Exactly the literals go (the prefixes stay); the unrelated hex is caught by the base64 rule, as before.
    expect(r.json.text).toBe(`cloud-init: AGENT/${REDACTED}\ncloud-init: CB/${REDACTED}\nchpasswd ${REDACTED}\nhex ${REDACTED}\nwg-admin ready\n`);
    expect(r.json.redactions).toBe(4);
    const stored = await everything(env);
    for (const s of [agentToken, callbackToken, "Tr0ub4dor&3"]) expect(stored).not.toContain(s);
  });

  it("no SAS URL in any stored row, response or error message", async () => {
    const { env, az } = routeEnv();
    const logged: string[] = [];
    for (const m of ["log", "error", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await running(env);
    // The log itself quotes a signed URL: redacted.
    az.serialLog = "agent: GET https://md-0abc.blob.core.windows.net/x/y?sv=2018-03-28&sig=LEAKED%2B1 200\n";
    let r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(SAS);
    // The blob call fails with an error that quotes the URL: the error is rewritten.
    az.handlers.push((c) => {
      if (c.u.hostname.endsWith("blob.core.windows.net")) throw new TypeError(`fetch failed: ${c.url}`);
      return undefined;
    });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * MIN));
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe("upstream");
    expect(r.text).not.toMatch(SAS);
    // And the automatic fetch on a silent heartbeat.
    await saveSnapshot(env, { last_agent_at: ago(10, new Date()) });
    await allNotDue(env);
    await env.DB.prepare("UPDATE az_feed SET last_try_at = NULL WHERE feed = 'bootLog'").run();
    await runInsights(env, new Date());
    expect((await feedRows(env)).bootLog.status).toBe("error");
    expect(await everything(env)).not.toMatch(SAS);
    expect(logged.join("\n")).not.toMatch(SAS);
    expect(JSON.stringify((await api(env, "GET", "/azure/diagnostics")).json)).not.toMatch(SAS);
  });

  it("fetches at most the last 64 KB and sets truncated", async () => {
    const { env, az } = routeEnv();
    await running(env);
    const lines = Array.from({ length: 4000 }, (_, i) => `[${String(i).padStart(6, "0")}] kernel: some boot message number ${i}`);
    az.serialLog = lines.join("\n") + "\n";
    const size = new TextEncoder().encode(az.serialLog).length;
    expect(size).toBeGreaterThan(150_000);
    let r = await api(env, "POST", "/azure/bootlog");
    const get = az.calls.find((c) => c.u.hostname.endsWith("blob.core.windows.net") && c.method === "GET")!;
    expect(get.headers.range).toBe(`bytes=${size - 65536}-${size - 1}`);
    expect(r.json.truncated).toBe(true);
    expect(r.json.bytes).toBeLessThanOrEqual(65536);
    expect(r.json.text.length).toBeLessThanOrEqual(65536);
    expect(r.json.text.startsWith("[")).toBe(true); // the cut-off first line is dropped
    expect(r.json.text.endsWith(`${lines.at(-1)}\n`)).toBe(true);
    // A blob that ignores Range: still at most 64 KB, the end of the log.
    az.ranged = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.json.truncated).toBe(true);
    expect(r.json.bytes).toBeLessThanOrEqual(65536);
    expect(r.json.text.endsWith(`${lines.at(-1)}\n`)).toBe(true);
  });

  it("POST is limited to one per 60 s with 429 slow_down", async () => {
    const { env, az } = routeEnv();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await running(env);
    expect((await api(env, "POST", "/azure/bootlog")).status).toBe(200);
    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    const again = await api(env, "POST", "/azure/bootlog");
    expect(again.status).toBe(429);
    expect(again.json.error.code).toBe("slow_down");
    expect(callsTo(az, "retrieveBootDiagnosticsData")).toHaveLength(1);
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect((await api(env, "POST", "/azure/bootlog")).status).toBe(200);
    expect(callsTo(az, "retrieveBootDiagnosticsData")).toHaveLength(2);
    // Without credentials: the contract's not-connected answer, never a fetch or a 429.
    const { env: off } = routeEnv(NO_AZURE);
    for (let i = 0; i < 2; i++) expect((await api(off, "POST", "/azure/bootlog")).json.reason).toMatch(/isn't connected/);
  });

  it("fetched automatically once per stale-heartbeat episode", async () => {
    const { env, az } = azureEnv();
    const fetches = () => callsTo(az, "retrieveBootDiagnosticsData").length;
    await running(env, { last_agent_at: ago(1) });
    await allNotDue(env, new Date(NOW.getTime() + 600 * MIN).toISOString());
    await env.DB.prepare("UPDATE az_feed SET last_try_at = NULL, next_due_at = NULL WHERE feed = 'bootLog'").run();
    await runInsights(env, NOW);
    expect(fetches()).toBe(0); // heartbeat fresh
    await saveSnapshot(env, { last_agent_at: ago(10) });
    await runInsights(env, NOW);
    expect(fetches()).toBe(1); // went silent
    expect(await latest(env, "bootlog")).toMatchObject({ reason: null, truncated: false });
    await runInsights(env, new Date(NOW.getTime() + 5 * MIN));
    expect(fetches()).toBe(1); // the same episode
    const later = new Date(NOW.getTime() + 20 * MIN);
    await saveSnapshot(env, { last_agent_at: ago(1, later) });
    await runInsights(env, later);
    expect(fetches()).toBe(1); // back
    const after = new Date(NOW.getTime() + 30 * MIN);
    await runInsights(env, after);
    expect(fetches()).toBe(2); // silent again: a new episode
    // The boot problem (no heartbeat since the VM started) counts too.
    const { env: env2, az: az2 } = azureEnv();
    await running(env2, { running_since: ago(8), since: ago(8), last_agent_at: null });
    await allNotDue(env2, new Date(NOW.getTime() + 600 * MIN).toISOString());
    await env2.DB.prepare("UPDATE az_feed SET last_try_at = NULL WHERE feed = 'bootLog'").run();
    await runInsights(env2, NOW);
    expect(callsTo(az2, "retrieveBootDiagnosticsData")).toHaveLength(1);
  });

  it("boot diagnostics off gives the next-deploy reason", async () => {
    const { env, az } = routeEnv();
    await running(env);
    await env.DB.prepare("INSERT INTO az_latest (key, json, updated_at) VALUES ('health', ?1, ?2)").bind(JSON.stringify({ state: "Available", bootDiagnostics: false }), ago(1)).run();
    let r = await api(env, "POST", "/azure/bootlog");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ text: null, reason: "Boot diagnostics turn on with the next deploy" });
    expect(callsTo(az, "retrieveBootDiagnosticsData")).toHaveLength(0);
    expect((await api(env, "GET", "/azure/bootlog")).json.reason).toBe("Boot diagnostics turn on with the next deploy");
    // Azure itself says so (a VM built before boot diagnostics, health not read yet).
    await env.DB.prepare("DELETE FROM az_latest").run();
    az.handlers.push((c) => (c.url.includes("retrieveBootDiagnosticsData") ? json({ error: { code: "OperationNotAllowed", message: "Boot diagnostics is not enabled for this VM." } }, 409) : undefined));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.json).toMatchObject({ text: null, reason: "Boot diagnostics turn on with the next deploy" });
    // No VM.
    await saveSnapshot(env, { state: "destroyed", since: ago(1) });
    await env.DB.prepare("DELETE FROM az_latest").run();
    vi.setSystemTime(new Date(Date.now() + 2 * MIN));
    r = await api(env, "POST", "/azure/bootlog");
    expect(r.json).toMatchObject({ text: null, reason: "No VM" });
    expect((await api(env, "GET", "/azure/bootlog")).json.reason).toBe("No VM");
  });
});
