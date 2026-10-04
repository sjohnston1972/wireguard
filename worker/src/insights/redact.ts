// insights/redact.ts
//
// Plain English: take anything secret out of the VM's boot log before it is
// stored or shown (spec 11). Each match becomes ‹redacted› and is counted.
// It errs on the side of hiding too much: a word after "token" in an
// ordinary sentence is hidden too.
//
//   - PEM private keys (including one cut off by the 64 KB tail),
//   - URLs with a signature (sig=), such as a storage SAS link,
//   - the current run's SSH password, agent token and callback token
//     (literals passed in by the boot log feed), wherever they appear,
//   - the value after password, passwd, secret, token, apikey,
//     authorization or bearer (and ":", "=" or a space),
//   - WireGuard-shaped keys (43 base64 characters and "="),
//   - base64 runs of 64 characters or more.
//
// Pure: no I/O.

export const REDACTED = "‹redacted›";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g,
  /(?:^[A-Za-z0-9+/=]+\r?\n)*-----END [A-Z0-9 ]*PRIVATE KEY-----/gm,
  /https?:\/\/[^\s"'<>]*[?&]sig=[^\s"'<>]*/gi,
];
const KEY_VALUE = /(?<![A-Za-z0-9])(password|passwd|secret|token|apikey|api_key|authorization|bearer)(["']?\s*[:=\s]\s*["']?)(?!‹)((?:(?:bearer|basic)\s+)?[^\s"',;]+)/gi;
const WIREGUARD_KEY = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42,43}=(?![A-Za-z0-9+/=])/g;
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{64,}={0,2}/g;

/** The text with every secret replaced, and how many were replaced. `extra` is literal secrets (the SSH password); under 6 characters they are ignored. */
export function redact(text: string, extra: (string | null | undefined)[] = []): { text: string; count: number } {
  let count = 0;
  let out = text;
  const swap = (re: RegExp) => {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  };
  for (const re of PATTERNS) swap(re);
  for (const s of extra) if (typeof s === "string" && s.length >= 6) swap(new RegExp(escapeRe(s), "g"));
  out = out.replace(KEY_VALUE, (_m, key: string, sep: string) => {
    count++;
    return `${key}${sep}${REDACTED}`;
  });
  swap(WIREGUARD_KEY);
  swap(BASE64_RUN);
  return { text: out, count };
}
