// live-log.test.mjs
//
// Plain English: the workflow's live log (infra/ci/live-log.mjs and
// infra/ci/live-log.sh). GitHub hides secrets in its own log, but this copy
// goes to the Worker without passing through GitHub, so it must hide them
// itself: every secret the job knows, as typed and base64-encoded. And it
// must never change how a step ends: same exit code, same console output,
// even when the copy itself breaks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_ENV, secretForms, secretsFromEnv, makeRedactor, formatLine, nextChunk, Shipper } from "../../infra/ci/live-log.mjs";

const HELPER = fileURLToPath(new URL("../../infra/ci/live-log.sh", import.meta.url)).replace(/\\/g, "/");
const SCRIPT = fileURLToPath(new URL("../../infra/ci/live-log.mjs", import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "live-log-")).replace(/\\/g, "/");

// Every secret the workflow can hold, by the env name it lives under.
const SECRETS = {
  ARM_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  ARM_CLIENT_SECRET: "armSecret~Value.With-Odd_Chars+/=",
  ARM_TENANT_ID: "66666666-7777-8888-9999-000000000000",
  ARM_SUBSCRIPTION_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  CLOUDFLARE_API_TOKEN: "cfDnsTokenAbcdefghijklmnopqrstuvwxyz0123",
  AWS_ACCESS_KEY_ID: "r2AccessKeyId0123456789abcdef",
  AWS_SECRET_ACCESS_KEY: "r2SecretAccessKey0123456789abcdef0123456789abcdef",
  R2_BUCKET: "wg-admin-tfstate-bucket",
  TF_VAR_cloudflare_zone_id: "zoneid0123456789abcdef0123456789",
  ZONE_ID: "zoneid0123456789abcdef0123456789",
  TF_VAR_ssh_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPubKeyMaterial steven@laptop",
  TF_VAR_wg_server_private_key: "SERVERPRIVATEKEYaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
  TF_VAR_resource_group: "rg-secret-group",
  RG: "rg-secret-group",
  GH_TOKEN: "ghs_githubTokenAbcdefghijklmnopqrstuvwx",
  GITHUB_TOKEN: "ghs_otherGithubTokenAbcdefghijklmnopqr",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidcRequestTokenAbcdefghijklmnop",
  ACTIONS_RUNTIME_TOKEN: "runtimeTokenAbcdefghijklmnopqrstu",
  CALLBACK_TOKEN: "callbackTokenAbcdefghijklmnopqrstuvwxyz012345",
  TF_VAR_agent_token: "agentTokenAbcdefghijklmnopqrstuvwxyz0123456",
  TF_VAR_ssh_password: "Correct-Horse-Battery-77",
  TF_VAR_ssh_allowed_cidr: "203.0.113.45/32",
  AWS_ENDPOINT_URL_S3: "https://cfaccountid0123456789abcdef.r2.cloudflarestorage.com",
};
/** Values that must never reach the Worker, including ones derived from the env (the account id, the bare home address). */
const MUST_HIDE = [...new Set(Object.entries(SECRETS).filter(([k]) => k !== "AWS_ENDPOINT_URL_S3").map(([, v]) => v)), "cfaccountid0123456789abcdef", "203.0.113.45"];

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
/** A secret embedded at each byte offset inside a larger base64 blob, the way cloud-init carries files. */
const embedded = (s) => [0, 1, 2].map((k) => b64("#!/bin/sh\nX".slice(0, 3 + k) + `PASSWORD=${s}\nmore config follows here\n`));

function sample() {
  const lines = ["Initializing the backend..."];
  for (const [k, v] of Object.entries(SECRETS)) {
    lines.push(`${k}=${v} (plain)`);
    lines.push(`encoded: ${b64(v)}`);
    for (const e of embedded(v)) lines.push(`custom_data = "${e}"`);
  }
  lines.push(`::add-mask::${SECRETS.TF_VAR_ssh_password}`);
  lines.push("Apply complete! Resources: 9 added, 0 changed, 0 destroyed.");
  return lines.join("\n") + "\n";
}

/** True if any form of any secret (typed, base64, base64 at any offset) is still in `text`. */
function leaks(text) {
  const found = [];
  for (const v of MUST_HIDE) {
    if (text.includes(v)) found.push(`plain ${v}`);
    for (const skip of [0, 1, 2]) {
      const bytes = Buffer.from(v, "utf8").subarray(skip);
      const n = Math.floor(bytes.length / 3) * 3;
      if (n >= 6 && text.includes(bytes.subarray(0, n).toString("base64"))) found.push(`base64(+${skip}) of ${v}`);
    }
  }
  return found;
}

// ── Redaction ────────────────────────────────────────────────────────────

const WORKFLOW = fileURLToPath(new URL("../../.github/workflows/wg.yml", import.meta.url));
/** wg.yml with plain line ends (a Windows checkout has CRLF). */
const readWorkflow = () => readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
/** A secret-bearing expression in wg.yml: a repository secret or GitHub's own token. */
const SECRET_EXPR = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/g;
/** Run secrets the Worker hands out that are masked only because they map the network, not because they are secret (wg.yml says so). */
const RUN_VALUES_NOT_SECRET = new Set(["firewall_nft_b64"]);

/** Every `env:` entry in a workflow, at any level, as [name, raw value]. Plain line reading, so it never needs a YAML library. */
function envEntries(yml) {
  const out = [];
  let block = null; // indent of the current "env:" key
  let child = null; // indent of its entries
  for (const line of yml.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (block !== null && indent <= block) block = child = null;
    if (block !== null) {
      child ??= indent;
      const m = indent === child && /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) out.push([m[1], m[2].replace(/\s+#.*$/, "")]);
      continue;
    }
    if (/^\s*env:\s*$/.test(line)) block = indent;
  }
  return out;
}

/**
 * Every way wg.yml puts a secret where a step (and so the live log) can see
 * it, checked against what the redactor actually hides. Returns the problems:
 * each env fed from `${{ secrets.* }}` or `${{ github.token }}` whose secret
 * is not hidden, each such expression outside an env entry (a step's
 * script would print it and nothing could hide it), and each run secret
 * collected from the Worker that is not on SECRET_ENV.
 */
function secretCoverage(yml) {
  const problems = [];
  const entries = envEntries(yml);
  let n = 0;
  for (const [name, raw] of entries) {
    const exprs = raw.match(SECRET_EXPR) ?? [];
    if (!exprs.length) continue;
    const fakes = exprs.map((_, i) => `fakeSecret${n++}x${i}Value0123456789`);
    let value = raw.replace(/^(["'])(.*)\1$/, "$2");
    exprs.forEach((e, i) => (value = value.replace(e, fakes[i])));
    const redact = makeRedactor(secretsFromEnv({ [name]: value }));
    const out = redact(`printed: ${value} | alone: ${fakes.join(" ")}`);
    for (const [i, f] of fakes.entries()) if (out.includes(f)) problems.push(`${name} (fed from ${exprs[i]}) is not hidden: add it to SECRET_ENV`);
  }
  const code = yml
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const inEnv = entries.reduce((t, [, raw]) => t + (raw.match(SECRET_EXPR) ?? []).length, 0);
  const everywhere = (code.match(SECRET_EXPR) ?? []).length;
  if (everywhere !== inEnv) problems.push(`${everywhere - inEnv} secret expression(s) outside an env entry, where the live log cannot hide them`);

  // The run's own secrets: the Worker's answer in "Collect run secrets", saved to the env by put_env.
  const step = /- name: Collect run secrets[\s\S]*?(?=\n {6}- name: )/.exec(yml)?.[0] ?? "";
  const loop = /for k in ([^;]+); do/.exec(step);
  if (!loop) problems.push('"Collect run secrets" no longer has its "for k in ...; do" loop: update this test');
  else {
    if (!/put_env CALLBACK_TOKEN "\$v"/.test(step) || !/put_env "TF_VAR_\$k" "\$v"/.test(step)) problems.push('"Collect run secrets" saves its values differently now: update this test');
    for (const k of loop[1].trim().split(/\s+/)) {
      if (RUN_VALUES_NOT_SECRET.has(k)) continue;
      const name = k === "callback_token" ? "CALLBACK_TOKEN" : `TF_VAR_${k}`;
      if (!SECRET_ENV.includes(name)) problems.push(`run secret ${k} (env ${name}) is not on SECRET_ENV`);
    }
  }
  return problems;
}

test("every secret wg.yml hands a step, and every run secret from the Worker, is hidden by the live log", () => {
  const yml = readWorkflow();
  assert.ok(envEntries(yml).filter(([, v]) => (v.match(SECRET_EXPR) ?? []).length > 0).length >= 20, "the env entries were found");
  assert.deepEqual(secretCoverage(yml), []);
});

test("the wg.yml secret check is not circular: a new secret added to wg.yml alone fails it", () => {
  const yml = readWorkflow();
  const anchor = "          ARM_CLIENT_SECRET: ${{ secrets.ARM_CLIENT_SECRET }}\n";
  assert.ok(yml.includes(anchor));
  const withEnv = yml.replace(anchor, `${anchor}          NEW_API_KEY: \${{ secrets.NEW_API_KEY }}\n`);
  assert.deepEqual(secretCoverage(withEnv), ["NEW_API_KEY (fed from ${{ secrets.NEW_API_KEY }}) is not hidden: add it to SECRET_ENV"]);
  const inScript = yml.replace("terraform apply -no-color -auto-approve", 'terraform apply -no-color -auto-approve -var "x=${{ secrets.INLINE }}"');
  assert.match(secretCoverage(inScript).join("\n"), /1 secret expression\(s\) outside an env entry/);
  const runSecret = yml.replace("for k in callback_token agent_token", "for k in callback_token new_token agent_token");
  assert.deepEqual(secretCoverage(runSecret), ["run secret new_token (env TF_VAR_new_token) is not on SECRET_ENV"]);
});

test("the wg.yml env reader agrees with a real YAML parser", { skip: (() => spawnSync("python", ["-c", "import yaml"]).status !== 0 && "no Python with PyYAML here")() }, () => {
  const r = spawnSync("python", ["-c", "import sys, json, yaml; d = yaml.safe_load(open(sys.argv[1], encoding='utf-8')); envs = [d.get('env') or {}] + [j.get('env') or {} for j in d['jobs'].values()] + [s.get('env') or {} for j in d['jobs'].values() for s in j['steps']]; print(json.dumps([[k, str(v)] for e in envs for k, v in e.items()]))", WORKFLOW], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const real = JSON.parse(r.stdout).map(([k, v]) => `${k}=${v}`);
  const mine = envEntries(readWorkflow()).map(([k, v]) => `${k}=${v.replace(/^(["'])(.*)\1$/, "$2")}`);
  assert.deepEqual(mine, real);
});

test("secretsFromEnv picks up every secret, plus the account id in the R2 endpoint and the bare home address", () => {
  const got = secretsFromEnv({ ...SECRETS, PATH: "/usr/bin", HOME: "/home/runner" });
  for (const v of MUST_HIDE) assert.ok(got.includes(v), `missing ${v}`);
  assert.ok(!got.includes("/usr/bin"));
});

test("secretForms covers the value and its base64 at all three byte alignments; tiny values are skipped", () => {
  const forms = secretForms("Correct-Horse-Battery-77");
  assert.ok(forms.includes("Correct-Horse-Battery-77"));
  assert.ok(forms.includes(b64("Correct-Horse-Battery-77")));
  for (const e of embedded("Correct-Horse-Battery-77")) assert.ok(forms.some((f) => f !== "Correct-Horse-Battery-77" && e.includes(f)), `no form inside ${e}`);
  assert.deepEqual(secretForms("abc"), []);
  assert.deepEqual(secretForms(""), []);
});

test("the redactor leaves no secret in any form, and keeps the rest of the text", () => {
  const text = sample();
  assert.ok(leaks(text).length > 0, "the sample must contain the secrets to begin with");
  const out = makeRedactor(secretsFromEnv(SECRETS))(text);
  assert.deepEqual(leaks(out), []);
  assert.match(out, /Apply complete! Resources: 9 added/);
  assert.match(out, /ARM_CLIENT_SECRET=\*\*\* \(plain\)/);
});

test("a multi-line secret is hidden line by line", () => {
  const key = "-----BEGIN KEY-----\nAAAAsecretline1AAAA\nBBBBsecretline2BBBB\n-----END KEY-----";
  const out = makeRedactor(secretsFromEnv({ TF_VAR_wg_server_private_key: key }))("got BBBBsecretline2BBBB here");
  assert.equal(out, "got *** here");
});

test("formatLine stamps each line, turns workflow commands into log markers and drops add-mask lines", () => {
  const at = "2026-10-03T08:00:00.000Z";
  assert.equal(formatLine("hello", at), `${at} hello`);
  assert.equal(formatLine("::warning::slow disk", at), `${at} ##[warning]slow disk`);
  assert.equal(formatLine("::error file=main.tf,line=3::bad thing", at), `${at} ##[error]bad thing`);
  assert.equal(formatLine("::add-mask::whatever", at), null);
  assert.equal(formatLine("line with cr\r", at), `${at} line with cr`);
  const long = formatLine("x".repeat(20_000), at);
  assert.ok(long.length < 17_000 && long.endsWith("[line cut short]"));
});

// ── Chunking and shipping ────────────────────────────────────────────────

test("nextChunk sends whole lines, waits for a line to finish, and cuts an endless line on a character boundary", () => {
  const B = (s) => Buffer.from(s, "utf8");
  assert.equal(nextChunk(B(""), 100, false), 0);
  assert.equal(nextChunk(B("abc\ndef"), 100, false), 4);
  assert.equal(nextChunk(B("abc\ndef"), 100, true), 7);
  assert.equal(nextChunk(B("partial"), 100, false), 0);
  assert.equal(nextChunk(B("aaaa\nbbbb\ncccc\n"), 12, false), 10);
  // "é" is two bytes; a cut at 5 would split it.
  const n = nextChunk(B("abcdéééé"), 5, false);
  assert.equal(n, 4);
});

function fakePost(script) {
  const calls = [];
  const post = async (body) => {
    calls.push(body);
    const next = script.length ? script.shift() : 200;
    if (next instanceof Error) throw next;
    return { status: next };
  };
  return { calls, post };
}

test("Shipper: sends new text with rising sequence numbers, retries the same chunk after a failure, and redacts", async () => {
  const dir = tmp();
  const file = join(dir, "log.txt");
  writeFileSync(file, "line one\nline two secretvalue1\n");
  const { calls, post } = fakePost([200, 500, new Error("network down"), 200]);
  const s = new Shipper({ file, runId: "run-1", post, redact: makeRedactor(["secretvalue1"]), maxBytes: 1000 });
  assert.equal(await s.pump(false), "ok");
  assert.deepEqual(calls.map((c) => c.seq), [1]);
  assert.equal(calls[0].text, "line one\nline two ***\n");
  assert.equal(calls[0].run_id, "run-1");

  appendFileSync(file, "line three\nhalf a li");
  assert.equal(await s.pump(false), "retry"); // 500
  assert.equal(await s.pump(false), "retry"); // network error
  assert.equal(await s.pump(false), "ok");
  assert.deepEqual(calls.map((c) => c.seq), [1, 2, 2, 2]);
  assert.equal(calls[3].text, "line three\n");

  // The final flush sends the unfinished line too.
  assert.equal(await s.pump(true), "ok");
  assert.equal(calls.at(-1).seq, 3);
  assert.equal(calls.at(-1).text, "half a li");
  assert.equal(await s.pump(true), "ok");
  assert.equal(calls.length, 5, "nothing new, nothing sent");
});

test("Shipper: when a piece was stored but the answer was lost, the retry resends exactly that piece, and lines written meanwhile go under the next number", async () => {
  const dir = tmp();
  const file = join(dir, "log.txt");
  writeFileSync(file, "line one\n");
  // A stand-in Worker: the first copy of a number wins (INSERT OR IGNORE), a resend is a duplicate.
  const stored = new Map();
  const sent = [];
  let loseReply = true;
  const post = async (body) => {
    sent.push(body);
    const dup = stored.has(body.seq);
    if (!dup) stored.set(body.seq, body.text);
    if (loseReply) {
      loseReply = false;
      throw new Error("timed out after the Worker stored it");
    }
    return { status: 200 };
  };
  const s = new Shipper({ file, runId: "r", post, redact: (t) => t, maxBytes: 1000 });
  assert.equal(await s.pump(false), "retry");
  appendFileSync(file, "line two\nline three\n");
  assert.equal(await s.pump(false), "ok");
  appendFileSync(file, "tail");
  assert.equal(await s.pump(true), "ok");

  const bySeq = new Map();
  for (const b of sent) {
    if (bySeq.has(b.seq)) assert.equal(b.text, bySeq.get(b.seq), `seq ${b.seq} was resent with different text`);
    bySeq.set(b.seq, b.text);
  }
  const all = [...stored.keys()].sort((a, b) => a - b).map((k) => stored.get(k)).join("");
  assert.equal(all, "line one\nline two\nline three\ntail", "no line lost");
  assert.deepEqual(sent.map((b) => b.seq), [1, 1, 2, 3]);
});

test("Shipper: stops for good when the Worker says the run is over or the token is wrong; skips a chunk the Worker calls too big", async () => {
  const dir = tmp();
  const file = join(dir, "log.txt");
  writeFileSync(file, "a\n");
  for (const code of [401, 404, 409, 301, 302, 307]) {
    const { post } = fakePost([code]);
    const s = new Shipper({ file, runId: "r", post, redact: (t) => t, maxBytes: 1000 });
    assert.equal(await s.pump(false), "gone", `status ${code}`);
  }
  writeFileSync(file, "a\nb\n");
  const { calls, post } = fakePost([413, 200]);
  const s = new Shipper({ file, runId: "r", post, redact: (t) => t, maxBytes: 2 });
  assert.equal(await s.pump(false), "ok");
  assert.deepEqual(calls.map((c) => [c.seq, c.text]), [[1, "a\n"], [2, "b\n"]]);
});

test("the ship command posts to the Worker with the callback token and flushes everything when told to stop", async () => {
  const dir = tmp();
  const file = join(dir, "live.txt");
  writeFileSync(file, "");
  const got = [];
  let failOnce = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body);
      got.push({ auth: req.headers.authorization, path: req.url, ...j });
      if (failOnce && j.seq === 2) {
        failOnce = false;
        res.writeHead(502).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/callback/log`;
  const child = spawn(process.execPath, [SCRIPT, "ship"], {
    env: { ...process.env, LIVE_LOG_FILE: file, LIVE_LOG_URL: url, CALLBACK_TOKEN: "cbtoken-abcdefgh", WORKER_RUN_ID: "run-9", LIVE_LOG_INTERVAL_MS: "100", TF_VAR_ssh_password: "pw-secret-123" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((r) => child.on("exit", r));
  try {
    appendFileSync(file, "first line\n");
    await waitFor(() => got.length >= 1);
    appendFileSync(file, "second pw-secret-123 line\n");
    await waitFor(() => got.filter((g) => g.seq === 2).length >= 2); // failed once, then resent
    appendFileSync(file, "no newline yet");
    writeFileSync(`${file}.stop`, "");
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
    assert.equal(code, 0);
  } finally {
    child.kill();
    server.close();
  }
  assert.ok(got.every((g) => g.auth === "Bearer cbtoken-abcdefgh" && g.path === "/api/callback/log" && g.run_id === "run-9"));
  const ok = new Map();
  for (const g of got) ok.set(g.seq, g.text);
  assert.deepEqual([...ok.keys()], [1, 2, 3]);
  assert.equal([...ok.values()].join(""), "first line\nsecond *** line\nno newline yet");
});

test("the ship command treats a redirect (Cloudflare Access sending it to a login page) as the end: it is not followed, and the shipper says so once and stops", async () => {
  const dir = tmp();
  const file = join(dir, "live.txt");
  writeFileSync(file, "");
  const posts = [];
  let loginHits = 0;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/cdn-cgi/access/login")) {
      loginHits++;
      res.writeHead(200, { "Content-Type": "text/html" }).end("<html>Sign in</html>");
      return;
    }
    req.resume();
    req.on("end", () => {
      posts.push(req.url);
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/cdn-cgi/access/login?redirect_url=/api/callback/log` }).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // Access answers 302 to its login page, which answers 200: followed, that looked like success.
  const url = `http://127.0.0.1:${server.address().port}/api/callback/log`;
  const child = spawn(process.execPath, [SCRIPT, "ship"], {
    env: { ...process.env, LIVE_LOG_FILE: file, LIVE_LOG_URL: url, CALLBACK_TOKEN: "cbtoken-abcdefgh", WORKER_RUN_ID: "run-9", LIVE_LOG_INTERVAL_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", r));
  try {
    appendFileSync(file, "first line\n");
    // No stop file: a redirect alone must end the shipper.
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    appendFileSync(file, "second line\n");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(code, 0, `shipper still running; stderr: ${stderr}`);
  } finally {
    child.kill();
    server.close();
  }
  assert.equal(posts.length, 1, "nothing more is sent after a redirect");
  assert.equal(loginHits, 0, "the redirect is never followed");
  const notes = stderr.split("\n").filter((l) => /\b302\b/.test(l));
  assert.equal(notes.length, 1, `one line about the redirect; got: ${stderr}`);
  assert.match(notes[0], /127\.0\.0\.1/);
  assert.ok(!notes[0].includes("redirect_url"), "only the host of the Location, not the whole address");
  assert.ok(!stderr.includes("first line") && !stderr.includes("cbtoken"), "the text and the token are never logged");
});

test("the ship command writes down every answer that is not a success, by status only", async () => {
  const dir = tmp();
  const file = join(dir, "live.txt");
  writeFileSync(file, "");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(404).end());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/callback/log`;
  const child = spawn(process.execPath, [SCRIPT, "ship"], {
    env: { ...process.env, LIVE_LOG_FILE: file, LIVE_LOG_URL: url, CALLBACK_TOKEN: "cbtoken-abcdefgh", WORKER_RUN_ID: "run-9", LIVE_LOG_INTERVAL_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((r) => child.on("exit", r));
  try {
    appendFileSync(file, "a line\n");
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]), 0);
  } finally {
    child.kill();
    server.close();
  }
  assert.match(stderr, /piece 1 answered 404/);
});

async function waitFor(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── The step helper (bash) ───────────────────────────────────────────────

/** Git Bash on Windows (the bash.exe on PATH there is often WSL's), plain bash elsewhere. */
function findBash() {
  const cands = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash"] : ["bash"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
const BASH = findBash();
const NODE = process.execPath.replace(/\\/g, "/");

/** Run a step body the way GitHub does (bash -eo pipefail), with the helper sourced first. */
function runStep(body, env = {}) {
  const dir = tmp();
  const file = `${dir}/live.txt`;
  const script = `source "${HELPER}" "My step"\n${body}\n`;
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, LIVE_LOG_FILE: file, LIVE_LOG_NODE: NODE, ...env },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log: existsSync(file) ? readFileSync(file, "utf8") : "", dir };
}

const skipBash = BASH ? false : "no bash found";

test("helper: a step's exit code and console output are unchanged, and its output lands in the live log", { skip: skipBash }, () => {
  const r = runStep('echo "to stdout"\necho "to stderr" >&2\nexit 3');
  assert.equal(r.status, 3);
  assert.match(r.stdout, /to stdout/);
  assert.match(r.stdout + r.stderr, /to stderr/);
  assert.match(r.log, /^\S+Z ##\[group\]My step$/m);
  assert.match(r.log, /^\d{4}-\d\d-\d\dT[\d:.]+Z to stdout$/m);
  assert.match(r.log, /Z to stderr$/m);
  assert.match(r.log, /##\[endgroup\]\s*$/);
  assert.deepEqual(readdirSync(r.dir).filter((f) => f.includes(".done")), [], "the hand-off marker is tidied away");
});

test("helper: a failing command under set -e keeps its own exit code; success stays 0", { skip: skipBash }, () => {
  assert.equal(runStep("echo before\nsh -c 'exit 7'\necho never").status, 7);
  const ok = runStep("echo fine");
  assert.equal(ok.status, 0);
  assert.match(ok.log, /Z fine$/m);
});

test("helper: secrets in the step's env never reach the live log, but the console is untouched", { skip: skipBash }, () => {
  const text = sample();
  const dir = tmp();
  writeFileSync(`${dir}/sample.txt`, text);
  const r = runStep(`cat "${dir}/sample.txt"`, SECRETS);
  assert.equal(r.status, 0);
  assert.ok(r.log.includes("Apply complete!"), "the log was written");
  assert.deepEqual(leaks(r.log), []);
  assert.ok(!r.log.includes("add-mask"));
  // GitHub masks its own console; the helper must not change what reaches it.
  assert.ok(r.stdout.includes(SECRETS.ARM_CLIENT_SECRET));
});

test("helper: if the copy breaks, the step still runs to the end with its own exit code", { skip: skipBash }, () => {
  const r = runStep('for i in $(seq 1 2000); do echo "line $i"; done\nexit 4', { LIVE_LOG_NODE: "false" });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /line 2000/);
});

test("helper: does nothing at all when there is no live log", { skip: skipBash }, () => {
  const r = spawnSync(BASH, ["--noprofile", "--norc", "-eo", "pipefail", "-c", `source "${HELPER}" "x"\necho plain\nexit 5`], { encoding: "utf8", env: { ...process.env, LIVE_LOG_FILE: "" } });
  assert.equal(r.status, 5);
  assert.equal(r.stdout, "plain\n");
});
