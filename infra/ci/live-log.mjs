// infra/ci/live-log.mjs
//
// Plain English: the workflow's live log. GitHub only hands out a job's log
// once the job has finished, so during a deploy the dashboard had nothing to
// show. This file lets the workflow send its own output to the Worker while
// it runs, a few seconds behind.
//
// Two jobs, one file (plain Node, no packages; the runner already has Node):
//
//   node live-log.mjs filter "<step name>" <done-file>
//     Reads a step's output on stdin (infra/ci/live-log.sh tees it here) and
//     appends it to the run's log file ($LIVE_LOG_FILE): a "##[group]" line
//     with the step name, then each line with a timestamp, then
//     "##[endgroup]", the same shape as GitHub's own log, so the dashboard
//     reads both the same way. Every secret the step can see is replaced by
//     *** BEFORE it is written. Touches <done-file> when it is finished.
//
//   node live-log.mjs ship
//     Runs in the background for the whole job. Every few seconds it sends
//     the new part of the log file to the Worker ($LIVE_LOG_URL, with the
//     run's callback token), numbered, so a resend after a network blip is
//     never stored twice. When "$LIVE_LOG_FILE.stop" appears it sends what is
//     left and exits.
//
// SECRETS: GitHub masks secrets in its own log, but this copy never passes
// through GitHub, so it must hide them itself. Both commands redact every
// value held in the env names in SECRET_ENV (the repository secrets each step
// is given, GitHub's own tokens and this run's secrets from the Worker), as
// typed and base64-encoded, by exact replacement with ***. The filter does it
// with the step's own env (where the Azure and Cloudflare keys live); the
// shipper does it again with what the whole job knows. The Worker does a
// third pass for the run secrets it holds.
//
// It must never break or slow the job: every failure here is swallowed, a
// failed send is retried next tick, and the workflow kills it at the end.

import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every env name in wg.yml that can hold a secret. Repository secrets (as the
 * steps name them), GitHub's tokens, and the per-run secrets collected from
 * the Worker. Keep in step with .github/workflows/wg.yml: a test reads
 * wg.yml and fails if a secret it hands a step is not hidden.
 */
export const SECRET_ENV = [
  // Azure service principal
  "ARM_CLIENT_ID",
  "ARM_CLIENT_SECRET",
  "ARM_TENANT_ID",
  "ARM_SUBSCRIPTION_ID",
  // Cloudflare DNS token and zone
  "CLOUDFLARE_API_TOKEN",
  "TF_VAR_cloudflare_zone_id",
  "ZONE_ID",
  // R2 state bucket (spoken to as S3)
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  // Static Terraform inputs from repository secrets
  "TF_VAR_ssh_public_key",
  "TF_VAR_wg_server_private_key",
  "TF_VAR_resource_group",
  "RG",
  // GitHub's own tokens
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  // This run's secrets, collected from the Worker
  "CALLBACK_TOKEN",
  "TF_VAR_agent_token",
  "TF_VAR_ssh_password",
  "TF_VAR_ssh_allowed_cidr",
];

/** Values shorter than this are not hidden (they would blank out ordinary words); GitHub's secrets are all far longer. */
const MIN_SECRET = 4;
/** A base64 fragment shorter than this is too likely to match by chance. */
const MIN_B64 = 8;
/** Longest line kept in the live log, in characters. */
const MAX_LINE = 16_000;
/** Most bytes sent in one request (the Worker accepts up to 64 KB). */
export const MAX_CHUNK = 48 * 1024;

/** The secret values in `env`: each named value, each line of a multi-line one, and two derived ones. */
export function secretsFromEnv(env, names = SECRET_ENV) {
  const out = new Set();
  const add = (v) => {
    for (const line of String(v ?? "").split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= MIN_SECRET) out.add(t);
    }
  };
  for (const k of names) add(env[k]);
  // The SSH allow-list is Steven's home address: hide the bare address too.
  if (env.TF_VAR_ssh_allowed_cidr) add(String(env.TF_VAR_ssh_allowed_cidr).split("/")[0]);
  // The Cloudflare account id (a repository secret) only reaches the steps
  // inside the R2 endpoint address: https://<account id>.r2.cloudflarestorage.com
  const host = /^https?:\/\/([^./]+)\./.exec(String(env.AWS_ENDPOINT_URL_S3 ?? ""));
  if (host) add(host[1]);
  return [...out];
}

/**
 * The forms a secret can be printed in: as typed, base64-encoded on its own,
 * and the part of its base64 that is the same wherever it sits inside a
 * longer base64 blob (one form for each of the three byte alignments), which
 * is how cloud-init carries files.
 */
export function secretForms(value) {
  const v = String(value ?? "");
  if (v.length < MIN_SECRET) return [];
  const forms = new Set([v]);
  const bytes = Buffer.from(v, "utf8");
  forms.add(bytes.toString("base64"));
  for (const skip of [0, 1, 2]) {
    const rest = bytes.subarray(skip);
    const n = Math.floor(rest.length / 3) * 3;
    const enc = rest.subarray(0, n).toString("base64");
    if (enc.length >= MIN_B64) forms.add(enc);
  }
  return [...forms];
}

/** A function that replaces every form of every secret with ***. Longest first, so no part of a longer form is left behind. */
export function makeRedactor(secrets) {
  const forms = [...new Set(secrets.flatMap(secretForms))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join("***");
    return out;
  };
}

const COMMAND = /^::(warning|error|notice|debug|group|endgroup)(?: [^:]*)?::(.*)$/;

/**
 * One line of a step's output as it goes into the live log: a timestamp in
 * GitHub's style, workflow commands ("::warning::") turned into the markers
 * GitHub writes in its own log ("##[warning]"), "::add-mask::" lines dropped.
 * Null means "leave this line out".
 */
export function formatLine(line, at) {
  let t = line.replace(/\r$/, "");
  if (t.startsWith("::add-mask::")) return null;
  const cmd = COMMAND.exec(t);
  if (cmd) t = `##[${cmd[1]}]${cmd[2]}`;
  if (t.length > MAX_LINE) t = `${t.slice(0, MAX_LINE)} …[line cut short]`;
  return `${at} ${t}`;
}

/**
 * How many bytes of `buf` (the unsent part of the log) to send now: whole
 * lines only, unless this is the final flush or a single line is longer than
 * `max`, in which case it is cut where no character is split.
 */
export function nextChunk(buf, max, final) {
  if (!buf.length) return 0;
  if (final && buf.length <= max) return buf.length;
  const nl = buf.subarray(0, max).lastIndexOf(0x0a);
  if (nl >= 0) return nl + 1;
  if (buf.length < max) return final ? buf.length : 0;
  let cut = max;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return cut;
}

/** Statuses that mean "stop sending": wrong token, unknown run, or the run is over. */
const GONE = new Set([401, 403, 404, 409, 410]);

/** Sends the log file to the Worker in numbered pieces. `post` does the request; it is passed in so tests can stand in for the network. */
export class Shipper {
  constructor({ file, runId, post, redact, maxBytes = MAX_CHUNK }) {
    Object.assign(this, { file, runId, post, redact, maxBytes });
    this.offset = 0;
    this.seq = 1;
    /**
     * The piece sent under `seq` whose answer has not come back yet: its
     * exact text and how many bytes of the file it covers. If the Worker
     * stored it and only the answer was lost, a resend is a duplicate, so it
     * must be the same text; anything written since goes in the next piece.
     */
    this.pending = null;
  }

  /** The unsent part of the file, at most a little over one chunk. */
  unread() {
    let size;
    try {
      size = statSync(this.file).size;
    } catch {
      return Buffer.alloc(0);
    }
    const want = Math.min(size - this.offset, this.maxBytes + 1);
    if (want <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(want);
    const fd = openSync(this.file, "r");
    try {
      const n = readSync(fd, buf, 0, want, this.offset);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  /** Has everything in the file been sent? */
  caughtUp() {
    return this.unread().length === 0;
  }

  /**
   * Send what is ready. "ok": all sent that can be; "retry": a send failed,
   * the same piece goes again next time; "gone": the Worker will not take
   * any more for this run, so stop.
   */
  async pump(final) {
    for (let i = 0; i < 50; i++) {
      if (!this.pending) {
        const buf = this.unread();
        const n = nextChunk(buf, this.maxBytes, final);
        if (!n) return "ok";
        this.pending = { n, text: this.redact(buf.subarray(0, n).toString("utf8")) };
      }
      const { n, text } = this.pending;
      let status;
      try {
        status = (await this.post({ run_id: this.runId, seq: this.seq, text })).status;
      } catch {
        return "retry";
      }
      // A redirect is never the Worker taking the piece: it is Cloudflare
      // Access (or a wrong address) sending us to a login page. Stop.
      if (GONE.has(status) || (status >= 300 && status < 400)) return "gone";
      // 413: the Worker will never take this piece; skip it rather than stall.
      if ((status >= 200 && status < 300) || status === 413) {
        this.offset += n;
        this.seq++;
        this.pending = null;
        continue;
      }
      return "retry";
    }
    return "ok";
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Copy stdin into the log file, redacted and stamped, between group markers. */
async function filter(name, doneFile) {
  const file = process.env.LIVE_LOG_FILE;
  const redact = makeRedactor(secretsFromEnv(process.env));
  const write = (lines) => {
    if (!lines.length) return;
    try {
      appendFileSync(file, lines.join("\n") + "\n");
    } catch {
      /* never let the copy hurt the step */
    }
  };
  write([`${now()} ##[group]${redact(name)}`]);
  let partial = "";
  process.stdin.setEncoding("utf8");
  for await (const data of process.stdin) {
    const parts = (partial + data).split(/\r?\n|\r/);
    partial = parts.pop() ?? "";
    const at = now();
    write(parts.map((l) => formatLine(redact(l), at)).filter((l) => l !== null));
  }
  if (partial) write([formatLine(redact(partial), now())].filter((l) => l !== null));
  write([`${now()} ##[endgroup]`]);
  if (doneFile) {
    try {
      writeFileSync(doneFile, "");
    } catch {
      /* the helper gives up waiting after a few seconds anyway */
    }
  }
}

/** Send the log file to the Worker every few seconds until told to stop. */
async function ship() {
  const env = process.env;
  const file = env.LIVE_LOG_FILE;
  const url = env.LIVE_LOG_URL;
  const stopFile = env.LIVE_LOG_STOP || `${file}.stop`;
  const interval = Number(env.LIVE_LOG_INTERVAL_MS) || 3000;
  if (!file || !url || !env.CALLBACK_TOKEN) {
    console.error("live log: missing LIVE_LOG_FILE, LIVE_LOG_URL or CALLBACK_TOKEN; not sending");
    return;
  }
  const post = async (body) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CALLBACK_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      // Never follow a redirect: Access answers 302 to its login page, which
      // answers 200, and that would look like the piece was stored.
      redirect: "manual",
    });
    await r.arrayBuffer().catch(() => null);
    // Only the status (and a redirect's host) is ever written down: never the text sent.
    if (r.status >= 300 && r.status < 400) {
      let host = "nowhere";
      try {
        host = new URL(r.headers.get("location") ?? "", url).host || host;
      } catch {
        /* no usable Location */
      }
      console.error(`live log: piece ${body.seq} answered ${r.status}, a redirect to ${host}; sending no more`);
    } else if (r.status < 200 || r.status >= 300) console.error(`live log: piece ${body.seq} answered ${r.status}`);
    return { status: r.status };
  };
  const shipper = new Shipper({ file, runId: env.WORKER_RUN_ID || "manual", post, redact: makeRedactor(secretsFromEnv(env)) });

  let stopBy = null;
  for (;;) {
    const stopping = existsSync(stopFile);
    if (stopping && stopBy === null) stopBy = Date.now() + 10_000;
    const r = await shipper.pump(stopping);
    if (r === "gone") {
      console.error("live log: the Worker will take no more for this run; stopping");
      return;
    }
    if (stopping && ((r === "ok" && shipper.caughtUp()) || Date.now() > stopBy)) return;
    const wake = Date.now() + (stopping ? 1000 : interval);
    while (Date.now() < wake && (stopping || !existsSync(stopFile))) await sleep(100);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = cmd === "filter" ? filter(args[0] ?? "step", args[1]) : cmd === "ship" ? ship() : Promise.reject(new Error(`unknown command ${cmd}`));
  // No process.exit(): forcing an exit while fetch's sockets are still open
  // can crash Node on Windows. Every handle left is idle and unref'd, so the
  // process ends by itself (and wg.yml kills the shipper anyway).
  run.then(
    () => {
      process.exitCode = 0;
    },
    (e) => {
      console.error(`live log: ${e?.message ?? e}`);
      // A broken filter still drains its input, so the step is never blocked.
      if (cmd === "filter") process.stdin.resume();
      process.exitCode = cmd === "filter" ? 1 : 0;
    }
  );
}
