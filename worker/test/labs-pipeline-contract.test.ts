// labs-pipeline-contract.test.ts
//
// Plain English: the integrator's end-to-end check that the Worker (L2) and
// the lab pipeline (L1, plus LG's one call from wg.yml) speak the same
// language. Each test takes what one side really produces and hands it to the
// other side's real code:
//
//   - the payload the Worker dispatches goes through infra/ci/lab-parse.sh,
//     and every address parse.sh derives (result, peer, live log, secrets) is
//     a route the Worker mounts
//   - the secrets reply carries the keys lab.yml's "Collect run secrets" reads
//   - the live log's real Shipper (infra/ci/live-log.mjs) is stored by the
//     Worker for a lab run
//   - the peer begin and end bodies lab-peer.sh sends, and the dns_link it reads
//   - the result body lab.yml's step 16 builds, for a deploy and a destroy
//   - a clean-up of a lab gone from the catalogue gets through Parse payload
//     with its Terraform steps skipped (the safety net works by name)
//   - wg.yml's "Remove lab peerings" body (LG, feat/labs-gateway)
//
// The parse.sh half needs bash and Python with PyYAML (CI's runner has both).

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "../src/index";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { saveSnapshot } from "../src/state";
import { startDestroy, issueRunSecrets } from "../src/runs";
import { handleLabCallback, handleLabPeer, handleLabPeeringsRemoved } from "../src/labs/callbacks";
import { readLiveLog, receiveLiveLog } from "../src/livelog";
import { lastGhRun } from "./harness";
import { apiEnv, base } from "./api-helpers";
import { api, freeze, labDispatches, secrets, session, labRun, NOW } from "./labs-helpers";
import type { Env } from "../src/env";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const LAB_YML = readFileSync(join(REPO, ".github", "workflows", "lab.yml"), "utf8").replace(/\r\n/g, "\n");
const PEER_SH = readFileSync(join(REPO, "infra", "ci", "lab-peer.sh"), "utf8").replace(/\r\n/g, "\n");
const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;

function findBash(): string | null {
  const cands = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash"] : ["bash"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
const BASH = findBash();
const PY = (() => {
  if (!BASH) return null;
  const r = spawnSync(BASH, ["-c", "for p in python3 python; do if $p -c 'import yaml' >/dev/null 2>&1; then echo $p; exit 0; fi; done; exit 1"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
})();
const noParse = !BASH || !PY;
const fwd = (p: string) => p.replace(/\\/g, "/");

/** Run lab-parse.sh on the real repository for `action` and `payload`; returns its exit code and the values it saved. */
function runParse(action: string, raw: Record<string, unknown>): { status: number | null; out: string; env: Record<string, string> } {
  // The test Worker lives on http://localhost; a real one on https. Keep the Worker's paths, swap the origin.
  const https = (u: unknown) => (typeof u === "string" && u ? u.replace(/^http:\/\/localhost:\d+/, "https://wg.example.net") : u);
  const payload = { ...raw, callback_url: https(raw.callback_url), secrets_url: https(raw.secrets_url) };
  const dir = mkdtempSync(join(tmpdir(), "lab-contract-"));
  const event = join(dir, "event.json");
  const envFile = join(dir, "env");
  writeFileSync(event, JSON.stringify({ inputs: { action, payload: JSON.stringify(payload) } }));
  writeFileSync(envFile, "");
  const r = spawnSync(BASH!, ["-eo", "pipefail", fwd(join(REPO, "infra", "ci", "lab-parse.sh"))], {
    encoding: "utf8",
    env: { ...process.env, LAB_PYTHON: PY ?? "", LAB_ACTION_INPUT: action, GITHUB_EVENT_PATH: fwd(event), GITHUB_ENV: fwd(envFile), GITHUB_WORKSPACE: fwd(REPO) },
    timeout: 120_000,
  });
  const env: Record<string, string> = {};
  for (const m of readFileSync(envFile, "utf8").matchAll(/^(\w+)<<(EOV_\w+)\r?\n([^\r\n]*)\r?\n\2\r?$/gm)) env[m[1]] = m[3];
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), env };
}

/** POST to the Worker's front door, as GitHub's runner would (no session, a bearer token). */
async function post(env: Env, url: string, body: unknown, token = "not-a-real-token") {
  const path = new URL(url).pathname;
  const r = await worker.fetch(new Request(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, ctx);
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}

/** The real catalogue (built from labs/ by labs-build), signed in, permission check passed, gateway running. */
async function realEnv() {
  setCatalogueForTest(null);
  const r = apiEnv();
  await r.env.STATUS.put("labs:permissions", JSON.stringify({ checkedAt: NOW, role: true, users: true, groups: true, message: null }));
  await saveSnapshot(r.env, { state: "running", running_since: NOW });
  return r;
}

afterEach(() => {
  setCatalogueForTest(null);
  vi.useRealTimers();
});

describe("Worker and lab pipeline agree (integration)", () => {
  it.skipIf(noParse)("a deploy payload passes Parse payload, and every address it derives is a route the Worker mounts", async () => {
    freeze();
    const { env, world } = await realEnv();
    const r = await api(env, "POST", "/labs/az104-06-blob-security/deploy", { hours: 2, peer: true });
    expect(r.status, r.text).toBe(200);
    const d = labDispatches(world).at(-1)!;
    expect(d.action).toBe("deploy");
    // The Worker's callback_url form is …/api/callback/lab; parse.sh also takes …/api/callback.
    expect(new URL(String(d.payload.callback_url)).pathname).toBe("/api/callback/lab");
    for (const callback of [d.payload.callback_url, `${base}/api/callback`, `${base}/api/callback/`, `${base}/api/callback/lab/`]) {
      const p = runParse("deploy", { ...d.payload, callback_url: callback });
      expect(p.status, p.out).toBe(0);
      expect(new URL(p.env.CALLBACK_URL).pathname, String(callback)).toBe("/api/callback/lab");
      expect(new URL(p.env.LAB_PEER_URL).pathname).toBe("/api/callback/lab-peer");
      expect(new URL(p.env.LIVE_LOG_URL).pathname).toBe("/api/callback/log");
      expect(new URL(p.env.SECRETS_URL).pathname).toBe("/api/callback/lab-secrets");
      expect(p.env.LAB_PEERING).toBe("true");
      expect(p.env.LAB_DNS_LINK).toBe("true");
      expect(p.env.TF_VAR_address_space).toBe(d.payload.slot_cidr);
    }
    // Each is mounted: a wrong token is refused (401), never "no such route" (404).
    const p = runParse("deploy", d.payload);
    for (const k of ["CALLBACK_URL", "LAB_PEER_URL", "LIVE_LOG_URL", "SECRETS_URL"]) {
      const res = await post(env, p.env[k], { run_id: r.json.runId });
      expect([400, 401], `${k} ${p.env[k]} answered ${res.status}`).toContain(res.status);
    }
  }, 180_000);

  it("the secrets reply has the keys lab.yml reads, and the live log's Shipper is stored for a lab run", async () => {
    freeze();
    const { env, world } = await realEnv();
    const r = await api(env, "POST", "/labs/az104-05-storage/deploy", { hours: 1, peer: false });
    expect(r.status, r.text).toBe(200);
    const runId = r.json.runId as string;
    const s = await secrets(env, world, runId);
    // lab.yml: for k in callback_token admin_password; do v="$(jq -r --arg k "$k" '.[$k] // empty' …)"
    const keys = LAB_YML.match(/for k in ([a-z_ ]+); do\n\s+v="\$\(jq -r --arg k "\$k" '\.\[\$k\] \/\/ empty'/)?.[1].trim().split(/\s+/);
    expect(keys).toEqual(["callback_token", "admin_password"]);
    for (const k of keys!) expect(typeof (s as Record<string, unknown>)[k] === "string" && (s as Record<string, string>)[k].length > 0, k).toBe(true);

    // The real shipper from infra/ci/live-log.mjs, posting straight into the Worker's handler.
    const mod = (await import(/* @vite-ignore */ pathToFileURL(join(REPO, "infra", "ci", "live-log.mjs")).href)) as any;
    const file = join(mkdtempSync(join(tmpdir(), "lab-livelog-")), "log.txt");
    writeFileSync(file, "");
    const answers: number[] = [];
    const shipper = new mod.Shipper({
      file,
      runId,
      redact: mod.makeRedactor(mod.secretsFromEnv({ CALLBACK_TOKEN: s.callback_token, TF_VAR_admin_password: s.admin_password })),
      post: async (body: unknown) => {
        const res = await receiveLiveLog(env, s.callback_token, body);
        answers.push(res.status);
        return { status: res.status };
      },
    });
    appendFileSync(file, `[Terraform init] Initializing the backend...\n[Apply] password is ${s.admin_password}\n`);
    expect(await shipper.pump(false)).toBe("ok");
    expect(answers).toEqual([200]);
    const stored = await readLiveLog(env, runId);
    expect(stored?.text).toMatch(/Initializing the backend/);
    expect(stored?.text).not.toContain(s.admin_password);
  });

  it("peer begin and end bodies from lab-peer.sh are accepted, and begin answers go with a boolean dns_link", async () => {
    freeze();
    const { env, world } = await realEnv();
    const r = await api(env, "POST", "/labs/az104-06-blob-security/deploy", { hours: 2, peer: true });
    const runId = r.json.runId as string;
    const s = await secrets(env, world, runId);
    // The exact bodies the script sends (bash-escaped in the script).
    expect(PEER_SH).toContain(`tell "{\\"run_id\\":\\"$RUN_ID\\",\\"phase\\":\\"begin\\"}"`);
    expect(PEER_SH).toContain(`tell "{\\"run_id\\":\\"$RUN_ID\\",\\"phase\\":\\"end\\",\\"ok\\":$OK}"`);
    expect(PEER_SH).toMatch(/"dns_link"\[\[:space:\]\]\*:\[\[:space:\]\]\*true/);
    const begin = await post(env, `${base}/api/callback/lab-peer`, JSON.parse(`{"run_id":"${runId}","phase":"begin"}`), s.callback_token);
    expect(begin.status).toBe(200);
    expect(begin.json).toEqual({ go: true, dns_link: true });
    // The script's grep for go, as it would see this answer.
    expect(JSON.stringify(begin.json)).toMatch(/"go"\s*:\s*true/);
    for (const ok of [true, false]) {
      const end = await post(env, `${base}/api/callback/lab-peer`, JSON.parse(`{"run_id":"${runId}","phase":"end","ok":${ok}}`), s.callback_token);
      expect(end.status).toBe(200);
    }
  });

  it("step 16's result body settles a deploy and a destroy", async () => {
    freeze();
    const { env, world } = await realEnv();
    // The keys lab.yml's jq builds (top level and outputs) are the ones the Worker takes.
    const tpl = LAB_YML.match(/'\{run_id:\$r\.run_id,[\s\S]*?\}\}'\)"/)![0];
    const top = [...tpl.matchAll(/[{,]\s*([a-z_]+):/g)].map((m) => m[1]);
    expect(top).toEqual(["run_id", "action", "status", "github_run_id", "github_run_url", "outputs", "private_ips", "connect", "users", "peer_vnet_id", "clean", "leftovers", "deploy_seconds", "destroy_seconds"]);
    const r = await api(env, "POST", "/labs/az104-06-blob-security/deploy", { hours: 2, peer: false });
    const runId = r.json.runId as string;
    const sid = r.json.sessionId as string;
    const s = await secrets(env, world, runId);
    // As jq writes it: github_run_id is a string (--arg), absent outputs are {} / [] / null.
    const body = (action: string, status: string, id: string, extra: Record<string, unknown>) => ({
      run_id: id,
      action,
      status,
      github_run_id: "123456",
      github_run_url: "https://github.com/o/r/actions/runs/123456",
      outputs: { private_ips: {}, connect: [], users: {}, peer_vnet_id: null, clean: null, leftovers: null, deploy_seconds: 300, destroy_seconds: null, ...extra },
    });
    const dep = await post(env, `${base}/api/callback/lab`, body("deploy", "success", runId, { peer_vnet_id: "/subscriptions/0/resourceGroups/rg-lab-az104-06-blob-security/providers/Microsoft.Network/virtualNetworks/vnet-lab" }), s.callback_token);
    expect(dep.status, JSON.stringify(dep.json)).toBe(200);
    expect((await session(env, sid))!.state).toBe("running");

    const down = await api(env, "POST", "/labs/az104-06-blob-security/destroy", { confirm: true });
    expect(down.status, down.text).toBe(200);
    const did = down.json.runId as string;
    const ds = await secrets(env, world, did);
    const fin = await post(env, `${base}/api/callback/lab`, body("destroy", "success-with-fallback", did, { clean: true, leftovers: [], deploy_seconds: null, destroy_seconds: 240 }), ds.callback_token);
    expect(fin.status, JSON.stringify(fin.json)).toBe(200);
    expect((await session(env, sid))!.state).toBe("ended");
    expect((await labRun(env, did))!.finished_at).toBeTruthy();
  });

  it.skipIf(noParse)("a clean-up of a lab gone from the catalogue gets through Parse payload with Terraform skipped", async () => {
    freeze();
    const { env, world } = await realEnv();
    const gone = "az104-09-retired";
    await env.STATUS.put("labs:orphans", JSON.stringify([{ labId: gone, title: gone, names: [`rg-lab-${gone}`], kinds: ["group"], firstSeen: NOW }]));
    const r = await api(env, "POST", "/labs/orphans/cleanup", { lab_id: gone });
    expect(r.status, r.text).toBe(200);
    const d = labDispatches(world).at(-1)!;
    expect(d.action).toBe("destroy");
    expect(d.payload.lab_id).toBe(gone);
    const p = runParse("destroy", d.payload);
    expect(p.status, p.out).toBe(0);
    expect(p.out).toMatch(/left the catalogue/);
    expect(p.env).toMatchObject({ LAB_ID: gone, LAB_FOLDER: "false", LAB_HAS_TF: "false", LAB_ENTRA: "true" });
    expect(new URL(p.env.CALLBACK_URL).pathname).toBe("/api/callback/lab");
    // In lab.yml, Terraform needs LAB_HAS_TF (init) or init's success (destroy); the clean-up steps need neither.
    const stepIf = (name: string) => LAB_YML.match(new RegExp(`- name: ${name}\\n(?:\\s+id: \\w+\\n)?\\s+if: (.*)`))?.[1] ?? "";
    expect(stepIf("Terraform init")).toMatch(/env\.LAB_HAS_TF == 'true'/);
    expect(stepIf("Destroy")).toMatch(/steps\.init\.outcome == 'success'/);
    for (const n of ["Unpeer", "Unblock", "Safety net", "Verify clean"]) {
      const cond = stepIf(n);
      expect(cond, n).toMatch(/always\(\)/);
      expect(cond, n).not.toMatch(/LAB_HAS_TF|LAB_FOLDER|steps\.init/);
    }
  }, 180_000);

  it("wg.yml's Remove lab peerings body (LG) is accepted with the gateway destroy's token", async () => {
    freeze();
    const { env, world } = await realEnv();
    const gw = await startDestroy(env, "t");
    const sec = await issueRunSecrets(env, gw.id, lastGhRun(world));
    // feat/labs-gateway wg.yml: jq '{run_id:$r, peerings_removed:$p, dns_links_removed:$l, complete:$c}' to ${CALLBACK_URL%/}/lab-peerings-removed,
    // where wg.yml's CALLBACK_URL is the gateway's …/api/callback.
    const url = `${String(base)}/api/callback`.replace(/\/$/, "") + "/lab-peerings-removed";
    const res = await post(env, url, { run_id: gw.id, peerings_removed: 0, dns_links_removed: 0, complete: true }, sec.body.callback_token as string);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ disconnected: 0 });
    // Direct handler calls agree with the front door.
    expect((await handleLabPeeringsRemoved(env, sec.body.callback_token as string, { run_id: gw.id, peerings_removed: 0, dns_links_removed: 0, complete: true })).status).toBe(200);
    expect(typeof handleLabCallback).toBe("function");
    expect(typeof handleLabPeer).toBe("function");
  });
});
