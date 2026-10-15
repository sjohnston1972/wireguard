// infra/ci/lab-transient.mjs
//
// Plain English: did a terraform apply or destroy fail only because the
// cloud dropped the connection (or, on AWS, throttled)? Azure release tests
// saw it now and then, with nothing wrong in the lab:
//
//   performing CreateOrUpdate: Put "https://management.azure.com/...":
//   HTTP response was nil; connection may have been reset
//
// and AWS throttles a busy account (AWS labs spec §5, step 7):
//
//   operation error EC2: CreateVpc, https response error StatusCode: 400,
//   RequestID: ..., api error RequestLimitExceeded: Request limit exceeded.
//
// infra/ci/lab-tf-run.sh asks this before trying again:
//
//   node infra/ci/lab-transient.mjs <terraform output file>
//
// Exit 0: every error is a transport error (one "transient: <what>" line).
// Exit 1: anything else, or no error to read: never retried. Exit 2: unreadable.
//
// Each "Error:" diagnostic is judged by its message alone, the lines up to
// Terraform's "with <address>," (never the configuration it quotes below).
// It is transient when it names one of TRANSIENT and none of REFUSED: a 4xx
// other than 408 and 429, or a refusal code (quota, validation, authorization,
// policy, conflict). A resource's own timeout ("waiting for creation of ...:
// context deadline exceeded") is not transient: only the HTTP client's.
// AWS answers a throttle with a 400 ("StatusCode: 400 ... RequestLimitExceeded"),
// so a throttle code in the same diagnostic overrides that generic AWS 4xx
// refusal, and only that one (never AccessDenied, a validation error, ...).
// One diagnostic that is not transient means no retry.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** [what, pattern]: the transport errors worth one more try. */
export const TRANSIENT = [
  ["HTTP response was nil", /HTTP response was nil/],
  ["connection may have been reset", /connection may have been reset/],
  ["connection reset by peer", /connection reset by peer/],
  ["TLS handshake timeout", /TLS handshake timeout/],
  ["i/o timeout", /\bi\/o timeout\b/],
  ["unexpected EOF", /\bunexpected EOF\b/],
  ["429 TooManyRequests", /\bTooManyRequests\b|\b429 Too Many Requests\b|\bstatus(?: code)?:? 429\b|StatusCode=429\b/],
  ["RetryableError", /\bRetryableError\b/],
  // Only the HTTP client's own timeout; a resource's create timeout is not a transport error.
  ["client timeout", /context deadline exceeded \(Client\.Timeout exceeded|Client\.Timeout exceeded while awaiting headers/],
  // AWS (the SDK's "api error <Code>" and "StatusCode: <n>")
  ["Throttling", /\bThrottling(?:Exception)?\b/],
  ["RequestLimitExceeded", /\bRequestLimitExceeded\b/],
  ["SlowDown", /\bSlowDown\b/],
  ["TooManyRequestsException", /\bTooManyRequestsException\b/],
  ["StatusCode: 429", /\bStatusCode: 429\b/i],
  ["5xx", /\bStatusCode: 5\d\d\b/],
  // S3 PutBucketReplication sent with an empty body when its first try (the new role not yet propagated) was retried.
  ["MissingRequestBodyError", /\bMissingRequestBodyError\b/],
  ["send request failed", /\bsend request failed\b/],
];

/** A refusal: never retried, whatever else the message says. */
export const REFUSED = [
  // An HTTP 4xx other than 408 (request timeout) and 429 (too many requests).
  /\b(?:status(?: code)?:?|StatusCode=|Status=)\s*4(?!08|29)\d\d\b/i,
  /\(4(?!08|29)\d\d [A-Z][A-Za-z ]+\)/,
  /\b(?:QuotaExceeded|OperationNotAllowed|AuthorizationFailed|LinkedAuthorizationFailed|AuthenticationFailed|Forbidden|Unauthorized|InvalidParameter\w*|InvalidRequest\w*|InvalidTemplate\w*|BadRequest|ValidationError|SkuNotAvailable|RequestDisallowedByPolicy|Conflict|AlreadyExists|ResourceNotFound|NotFound)\b/,
  /\bquota\b/i,
  // AWS: a refusal code, whatever the status.
  /\b(AccessDenied\w*|UnauthorizedOperation|InvalidParameter\w*|ValidationException|InvalidClientTokenId|ExpiredToken)\b/,
];

/** AWS's generic 4xx (other than 408 and 429): a refusal, unless a throttle code in the same diagnostic says otherwise. */
export const AWS_4XX = /\bStatusCode: 4(?!08|29)\d\d\b/;
/** The AWS throttle codes, which come back as a 400 and override only AWS_4XX. */
export const AWS_THROTTLE = /\b(?:Throttling|ThrottlingException|RequestLimitExceeded|TooManyRequestsException|SlowDown|MissingRequestBodyError)\b/;

/** The message of each "Error:" diagnostic in Terraform's -no-color output (box drawing and CR taken off). */
export function diagnostics(text) {
  const lines = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^[│╷╵]\s?/, ""));
  const out = [];
  let cur = null;
  for (const line of lines) {
    if (/^Error: /.test(line)) {
      if (cur) out.push(cur.join("\n"));
      cur = [line];
    } else if (cur && (/^\s*with \S+,$/.test(line) || /^(Warning|Error): /.test(line) || /^\s*on \S+ line \d+/.test(line))) {
      out.push(cur.join("\n"));
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) out.push(cur.join("\n"));
  return out;
}

/** { transient, reasons }: transient only when there is an error and every one is a transport error. */
export function transientFailure(text) {
  const diags = diagnostics(text);
  const reasons = [];
  if (diags.length === 0) return { transient: false, reasons };
  for (const d of diags) {
    const hits = TRANSIENT.filter(([, re]) => re.test(d)).map(([what]) => what);
    const refused = REFUSED.some((re) => re.test(d)) || (AWS_4XX.test(d) && !AWS_THROTTLE.test(d));
    if (hits.length === 0 || refused) return { transient: false, reasons: [] };
    for (const h of hits) if (!reasons.includes(h)) reasons.push(h);
  }
  return { transient: true, reasons };
}

function main(argv) {
  let text;
  try {
    text = readFileSync(argv[0], "utf8");
  } catch {
    console.error("usage: node lab-transient.mjs <terraform output file>");
    return 2;
  }
  const r = transientFailure(text);
  if (!r.transient) return 1;
  console.log(`transient: ${r.reasons.join(", ")}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
