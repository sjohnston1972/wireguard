// scripts/lib/bicep.mjs
//
// Plain English: the one Bicep compiler the labs use, pinned by version and
// by the SHA-256 of each release asset (labs batch 2 plan, ruling 1). `az
// bicep build` would download whatever Bicep is newest and run it unchecked;
// instead lab.yml step 5, CI's labs job and npm run labs-tf all download this
// version from the official GitHub release and refuse it unless its checksum
// matches, before it is ever made runnable. Tests keep lab.yml's and ci.yml's
// copies of the version and the linux-x64 checksum equal to these.
//
// To move to a new Bicep: take the version and each asset's "digest" from
// `gh api repos/Azure/bicep/releases/latest` (GitHub's SHA-256 of the
// upload), download the assets and check them with sha256sum, then update
// this file, lab.yml (Terraform init's env) and ci.yml (install bicep), and
// rebuild scripts/test/fixtures/labs/bicep/storage-vnet.json with it.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BICEP_VERSION = "0.47.16";
/** SHA-256 of each v0.47.16 release asset (GitHub's digests, checked against downloads on 2026-10-05). */
export const BICEP_SHA256 = {
  "bicep-linux-x64": "64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a",
  "bicep-linux-arm64": "4406214cc274cfac7c821552aec2178b80aec637d91ed8b244282964c1cf24e3",
  "bicep-osx-arm64": "68046a084c88503cf6bd11dacf2a1c4ffcb7e3ac9c6b310d295e024af21bbea4",
  "bicep-osx-x64": "8ba5771b5261413d88583829f2ea24509eb65b06d899620c17283ecb60d5ca73",
  "bicep-win-x64.exe": "3f343ab1ce41feac156464adee3dc499cb6c197366fc731aed276192011d867c",
};

/** The release asset for a machine, or null when Bicep publishes none for it. */
export function bicepAsset(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "osx", win32: "win" }[platform];
  if (!os || !["x64", "arm64"].includes(arch)) return null;
  const asset = `bicep-${os}-${arch}${os === "win" ? ".exe" : ""}`;
  return Object.hasOwn(BICEP_SHA256, asset) ? asset : null;
}

/** The official download for an asset of the pinned version. */
export const bicepUrl = (asset) => `https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/${asset}`;

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** True when the file at `path` is the pinned asset, byte for byte (by SHA-256). */
export function bicepMatchesPin(path, asset, sha256 = BICEP_SHA256) {
  const want = asset ? sha256[asset] : undefined;
  if (!want || !existsSync(path)) return false;
  try {
    return sha256Of(readFileSync(path)) === want;
  } catch {
    return false;
  }
}

/**
 * The pinned Bicep for this machine in `cacheDir`, downloaded from the
 * official release when missing or changed. Every use checks the SHA-256 first;
 * a download that does not match is deleted before it is ever made runnable.
 * Returns the binary's path, or null (no asset for this machine, no network,
 * or a checksum mismatch, each said through `log`). Never throws.
 */
export async function pinnedBicep({ cacheDir, asset = bicepAsset(), sha256 = BICEP_SHA256, fetch = globalThis.fetch, log = console.log }) {
  if (!asset || !sha256[asset]) {
    log(`note: Bicep ${BICEP_VERSION} has no release asset for ${process.platform}-${process.arch}`);
    return null;
  }
  const path = join(cacheDir, asset);
  if (bicepMatchesPin(path, asset, sha256)) return path;
  const part = `${path}.download`;
  try {
    mkdirSync(cacheDir, { recursive: true });
    const r = await fetch(bicepUrl(asset));
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const got = sha256Of(bytes);
    if (got !== sha256[asset]) {
      log(`Bicep ${BICEP_VERSION} (${asset}) failed its checksum (got ${got}); it was deleted, not run`);
      return null;
    }
    writeFileSync(part, bytes);
    renameSync(part, path);
    if (!asset.endsWith(".exe")) chmodSync(path, 0o755);
    return bicepMatchesPin(path, asset, sha256) ? path : null;
  } catch (e) {
    rmSync(part, { force: true });
    log(`note: could not download Bicep ${BICEP_VERSION} (${asset}): ${e.message}`);
    return null;
  }
}
