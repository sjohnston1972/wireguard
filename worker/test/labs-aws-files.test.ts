// worker/test/labs-aws-files.test.ts
//
// Plain English: lab 31's files (plan ruling P2): stored on the run, handed
// out only by the secret route while the session runs, cleared at its end,
// and refused for any other lab, run or size.
import { describe, expect, it } from "vitest";
import { handleLabCallback, readFiles, FILES_MAX } from "../src/labs/callbacks";
import { api, deployLab, freeze, labDispatches, labEnv, rows, secrets, withAwsLabs } from "./labs-helpers";

const FILES = { "ans-31.ovpn": "client\ndev tun\n<ca>\n-----BEGIN CERTIFICATE-----\n</ca>\n", "client.crt": "-----BEGIN CERTIFICATE-----\nx\n", "client.key": "-----BEGIN PRIVATE KEY-----\ny\n" };
const OUT = { private_ips: { "vm-target": "10.64.0.10" }, connect: [], clean: null, leftovers: [], deploy_seconds: 300, destroy_seconds: null };

describe("lab files (ruling P2)", () => {
  it("Review Focus 5 / P2: files are stored on the run, returned only by secret while running, and cleared at session end", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "ans-31-client-vpn");
    const s = await secrets(env, world, r.json.runId);
    expect((await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", outputs: OUT, files: FILES })).status).toBe(200);
    const got = await api(env, "GET", "/labs/ans-31-client-vpn/secret");
    expect(got.json.files).toEqual(FILES);
    expect(got.headers.get("Cache-Control")).toBe("no-store");
    const session = await api(env, "GET", "/labs/ans-31-client-vpn");
    expect(JSON.stringify(session.json)).not.toContain("BEGIN PRIVATE KEY");
    expect(await rows(env, "SELECT outputs_json FROM lab_sessions")).not.toContainEqual(expect.objectContaining({ outputs_json: expect.stringContaining("client.key") }));
    await api(env, "POST", "/labs/ans-31-client-vpn/destroy", { confirm: true });
    const d = labDispatches(world).at(-1)!.payload.run_id as string;
    const ds = await secrets(env, world, d);
    await handleLabCallback(env, ds.callback_token, { run_id: d, action: "destroy", status: "success", outputs: { ...OUT, clean: true } });
    expect(await rows(env, "SELECT id FROM lab_runs WHERE files_json IS NOT NULL")).toEqual([]);
    expect((await api(env, "GET", "/labs/ans-31-client-vpn/secret")).status).toBe(409);
  });

  it("P2: files for another lab, a destroy, a failed deploy, too many or too large are refused", async () => {
    freeze();
    const { env, world } = await labEnv();
    withAwsLabs();
    const r = await deployLab(env, "soa-03-auto-scaling");
    const s = await secrets(env, world, r.json.runId);
    const res = await handleLabCallback(env, s.callback_token, { run_id: r.json.runId, action: "deploy", status: "success", outputs: OUT, files: { "a.txt": "x" } });
    expect(res.status).toBe(400);
    expect((res.body as { field: string }).field).toBe("files");
    const v = await deployLab(env, "ans-31-client-vpn");
    const vs = await secrets(env, world, v.json.runId);
    const failed = await handleLabCallback(env, vs.callback_token, { run_id: v.json.runId, action: "deploy", status: "failure", outputs: OUT, files: FILES });
    expect([failed.status, (failed.body as { field: string }).field]).toEqual([400, "files"]);
    expect((await handleLabCallback(env, vs.callback_token, { run_id: v.json.runId, action: "deploy", status: "success", outputs: OUT })).status).toBe(200);
    await api(env, "POST", "/labs/ans-31-client-vpn/destroy", { confirm: true });
    const d = labDispatches(world).at(-1)!.payload.run_id as string;
    const ds = await secrets(env, world, d);
    const destroy = await handleLabCallback(env, ds.callback_token, { run_id: d, action: "destroy", status: "success", outputs: { ...OUT, clean: true }, files: FILES });
    expect([destroy.status, (destroy.body as { field: string }).field]).toEqual([400, "files"]);
    expect(await rows(env, "SELECT id FROM lab_runs WHERE files_json IS NOT NULL")).toEqual([]);
    expect(readFiles(Object.fromEntries(Array.from({ length: FILES_MAX + 1 }, (_, i) => [`f${i}.txt`, "x"]))).ok).toBe(false);
    expect(readFiles({ "big.txt": "x".repeat(17 * 1024) }).ok).toBe(false);
    expect(readFiles({ "../etc/passwd": "x" }).ok).toBe(false);
    expect(readFiles({ "ok.txt": 5 }).ok).toBe(false);
    expect(readFiles(undefined)).toEqual({ ok: true, files: {} });
  });
});
