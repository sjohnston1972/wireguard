// scripts/lib/hcl2json.mjs
//
// Plain English: the one hcl2json the planned-diagram generator runs (lab
// topology spec ruling 3), pinned by version and by the SHA-256 of each
// release asset, fetched from the official GitHub release the way
// scripts/lib/bicep.mjs fetches Bicep: checked before it is ever made
// runnable, and again before every use, cached. CI's labs job installs the
// same version and linux checksum (a test keeps them equal); the generator
// uses $HCL2JSON only when it is the pinned asset byte for byte.
//
// To move to a new hcl2json: take the version and each asset's "digest" from
// `gh api repos/tmccombs/hcl2json/releases/tags/v<version>`, download and
// check them, then update this file and ci.yml's install step together.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HCL2JSON_VERSION = "0.6.9";
/** SHA-256 of each v0.6.9 release asset (GitHub's digests; the Windows one checked against a download on 2026-10-06). */
export const HCL2JSON_SHA256 = {
  hcl2json_linux_amd64: "b609e37094948c0b77cd8c6c0baaf8af2bd168c685c6e3334d671cc9692c34a5",
  hcl2json_linux_arm64: "cb2ccf59a830829fe122e8dfb85d6ef2500aceda5af45a7c1052a4d2c46541f9",
  hcl2json_darwin_amd64: "4e5dd67f8295d7c1d34b7c98b4d1d9d811805fc2878250e1d3771a9ade834759",
  hcl2json_darwin_arm64: "f7aa91e95bf5da5006de866aad6c757b4378f8f016387673f6425d5276e4fc11",
  "hcl2json_windows_amd64.exe": "be798d4cef34851ba09f7c430a1a61f22fbd1cfead00db55c76c84f5cd1d4f4f",
  "hcl2json_windows_arm64.exe": "5e1ea2dcc9805cceb346f4a82d35b686c8cd43167715275dda79e6b266895e34",
};

/** The release asset for a machine, or null when there is none. */
export function hcl2jsonAsset(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu) return null;
  const asset = `hcl2json_${os}_${cpu}${os === "windows" ? ".exe" : ""}`;
  return Object.hasOwn(HCL2JSON_SHA256, asset) ? asset : null;
}

export const hcl2jsonUrl = (asset) => `https://github.com/tmccombs/hcl2json/releases/download/v${HCL2JSON_VERSION}/${asset}`;

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** True when the file at `path` is the pinned asset, byte for byte. */
export function hcl2jsonMatchesPin(path, asset, sha256 = HCL2JSON_SHA256) {
  const want = asset ? sha256[asset] : undefined;
  if (!want || !path || !existsSync(path)) return false;
  try {
    return sha256Of(readFileSync(path)) === want;
  } catch {
    return false;
  }
}

/**
 * The pinned hcl2json in `cacheDir`, downloaded when missing or changed and
 * checked by SHA-256 before it is made runnable and on every use. Returns its
 * path, or null (no asset for this machine, no network, a checksum
 * mismatch: each said through `log`). Never throws.
 */
export async function pinnedHcl2json({ cacheDir, asset = hcl2jsonAsset(), sha256 = HCL2JSON_SHA256, fetch = globalThis.fetch, log = console.log }) {
  if (!asset || !sha256[asset]) {
    log(`note: hcl2json ${HCL2JSON_VERSION} has no release asset for ${process.platform}-${process.arch}`);
    return null;
  }
  const path = join(cacheDir, asset);
  if (hcl2jsonMatchesPin(path, asset, sha256)) return path;
  const part = `${path}.download`;
  try {
    mkdirSync(cacheDir, { recursive: true });
    const r = await fetch(hcl2jsonUrl(asset));
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const got = sha256Of(bytes);
    if (got !== sha256[asset]) {
      rmSync(path, { force: true });
      log(`hcl2json ${HCL2JSON_VERSION} (${asset}) failed its checksum (got ${got}); it was deleted, not run`);
      return null;
    }
    writeFileSync(part, bytes);
    renameSync(part, path);
    if (!asset.endsWith(".exe")) chmodSync(path, 0o755);
    return hcl2jsonMatchesPin(path, asset, sha256) ? path : null;
  } catch (e) {
    rmSync(part, { force: true });
    log(`note: could not download hcl2json ${HCL2JSON_VERSION} (${asset}): ${e.message}`);
    return null;
  }
}
