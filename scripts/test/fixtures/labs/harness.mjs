// scripts/test/fixtures/labs/harness.mjs
//
// Plain English: a pretend Azure CLI (and curl) for the lab pipeline's bash
// scripts. Each test writes a small scenario, "when az is called with
// arguments matching this, print that", runs a script with the fakes first
// on PATH, then reads back every call the script made, in order.
//
// The fakes are plain bash (builtins only, fast even in Git Bash on Windows),
// so they behave the same there and in bash on Linux, and need no jq.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** Git Bash on Windows (the bash.exe on PATH there is often WSL's), plain bash elsewhere. */
function findBash() {
  const cands = process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe", "bash"] : ["bash"];
  for (const c of cands) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}
export const BASH = findBash();
export const JQ = BASH ? spawnSync(BASH, ["-c", "command -v jq"], { encoding: "utf8" }).stdout.trim() || null : null;

/** Forward slashes: Git Bash takes C:/... paths, and they read the same on Linux. */
export const fwd = (p) => p.replace(/\\/g, "/");

/**
 * A fresh world: fake az and curl (and any others) on PATH. `rules` are
 * { cmd?: "az", match: RegExp source, out: string | string[], code?: number, err?: string }:
 * the first rule whose cmd and pattern match the call's arguments (joined by
 * spaces) answers it; an array `out` answers the nth matching call with its
 * nth entry (the last one repeats). Unmatched calls print nothing and exit 0.
 */
export function world(rules = []) {
  const dir = mkdtempSync(join(tmpdir(), "lab-ci-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const scenario = join(dir, "scenario.sh");
  const log = join(dir, "calls.log");
  writeFileSync(scenario, scenarioSh(rules));
  const fake = (name) => {
    writeFileSync(join(bin, name), FAKE_SH.replace("__CMD__", name));
    chmodSync(join(bin, name), 0o755);
  };
  for (const name of ["az", "curl", "terraform", "gh", "sleep", "hcl2json"]) fake(name);
  const w = {
    dir,
    bin,
    env: (extra = {}) => ({ ...process.env, FAKE_BIN: fwd(bin), FAKE_SCENARIO: fwd(scenario), FAKE_LOG: fwd(log), FAKE_STATE: fwd(state), ARM_CLIENT_ID: "", ...extra }),
    /** Every call made, as "cmd arg arg ...", in order. */
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    /** Run a repo script (path from the repo root) in bash with the fakes first on PATH. */
    run: (script, args = [], extra = {}) => {
      const r = spawnSync(BASH, ["--noprofile", "--norc", "-c", 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash --noprofile --norc "$0" "$@"', fwd(join(REPO, script)), ...args], {
        encoding: "utf8",
        env: w.env(extra),
        timeout: 240_000, // Git Bash forks slowly on a busy Windows machine
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: (r.stdout ?? "") + (r.stderr ?? "") };
    },
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* left for the OS */
      }
    },
  };
  return w;
}

/** A bash ANSI-C quoted string ($'...'). */
const bq = (s) => `$'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}'`;

/** The scenario as bash arrays, so the fakes answer with bash builtins alone (a Node per call is too slow on Windows). */
function scenarioSh(rules) {
  const lines = ["RULE_CMD=()", "RULE_RE=()", "RULE_N=()"];
  rules.forEach((r, i) => {
    const outs = Array.isArray(r.out) ? r.out : [r.out ?? ""];
    const n = Math.max(outs.length, Array.isArray(r.code) ? r.code.length : 1);
    lines.push(`RULE_CMD[${i}]=${bq(r.cmd ?? "az")}`, `RULE_RE[${i}]=${bq(r.match instanceof RegExp ? r.match.source : r.match)}`, `RULE_N[${i}]=${n}`);
    for (let k = 0; k < n; k++) {
      const pick = (v) => (Array.isArray(v) ? v[Math.min(k, v.length - 1)] : v);
      lines.push(`RULE_OUT_${i}_${k}=${bq(pick(outs) ?? "")}`, `RULE_ERR_${i}_${k}=${bq(pick(r.err) ?? "")}`, `RULE_CODE_${i}_${k}=${Number(pick(r.code) ?? 0)}`);
    }
  });
  return `${lines.join("\n")}\n`;
}

/** One fake command: log the call, answer from the first matching rule. Pure bash. */
const FAKE_SH = `#!/usr/bin/env bash
cmd=__CMD__
joined="$*"
printf '%s\\n' "$cmd \${joined//$'\\n'/\\\\n}" >> "$FAKE_LOG"
[ "$cmd" = sleep ] && exit 0
source "$FAKE_SCENARIO"
for i in "\${!RULE_CMD[@]}"; do
  [ "\${RULE_CMD[$i]}" = "$cmd" ] || continue
  re="\${RULE_RE[$i]}"
  if [[ "$joined" =~ $re ]]; then
    n=0
    f="$FAKE_STATE/$i"
    [ -f "$f" ] && read -r n < "$f"
    echo $((n + 1)) > "$f"
    last=$((RULE_N[$i] - 1))
    k=$(( n < last ? n : last ))
    v="RULE_OUT_\${i}_\${k}"; [ -n "\${!v}" ] && printf '%s\\n' "\${!v}"
    v="RULE_ERR_\${i}_\${k}"; [ -n "\${!v}" ] && printf '%s\\n' "\${!v}" >&2
    v="RULE_CODE_\${i}_\${k}"; exit "\${!v}"
  fi
done
exit 0
`;

/** The index of the first call matching `re`, or -1. */
export const firstCall = (calls, re) => calls.findIndex((c) => re.test(c));
/** The index of the last call matching `re`, or -1. */
export const lastCall = (calls, re) => calls.map((c) => re.test(c)).lastIndexOf(true);
