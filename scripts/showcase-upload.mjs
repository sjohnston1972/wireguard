// scripts/showcase-upload.mjs   (npm run showcase-upload [-- --films <dir>] [--dry-run])
//
// Plain English: puts the public showcase on the shelf. Copies the page
// (showcase/index.html and showcase.js, from this repo) and the films the
// page lists (manifest, poster, init, chunks and 720p fallback of each, from
// the showcase pipeline's web/ folder, outside the repo because films are
// big) into the R2 bucket the Worker serves /showcase from. Creates the
// bucket the first time. Uses the broad CLOUDFLARE_API_TOKEN from .env for
// wrangler only (it never leaves this machine). Stops at the first upload
// that fails; running it again is safe (each file is simply replaced).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUCKET = "wg-showcase";
export const DEFAULT_FILMS = "C:/cloudflare_projects/wg-showcase/web";
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json", mp4: "video/mp4", m4s: "video/mp4", jpg: "image/jpeg" };
const FILM_FILE = /^(?:manifest\.json|init\.mp4|chunk-\d{3}\.m4s|fallback-720p\.mp4|poster\.jpg)$/;

/** The film ids the page lists, in order (FILMS in showcase.js). */
export function filmIds(js) {
  return [...js.matchAll(/\bid:\s*"(\d{2}-[a-z0-9-]+)"/g)].map((m) => m[1]);
}

/** Every upload as { key, file, type }: the page first, then each film's files. Throws if a listed film is missing. */
export function uploads(pageDir, filmsDir, listDir = readdirSync) {
  const out = [
    { key: "index.html", file: join(pageDir, "index.html"), type: TYPES.html },
    { key: "showcase.js", file: join(pageDir, "showcase.js"), type: TYPES.js },
  ];
  for (const id of filmIds(readFileSync(join(pageDir, "showcase.js"), "utf8"))) {
    const dir = join(filmsDir, id);
    const names = listDir(dir).filter((n) => FILM_FILE.test(n)).sort();
    for (const need of ["manifest.json", "init.mp4", "poster.jpg", "fallback-720p.mp4"]) {
      if (!names.includes(need)) throw new Error(`${id}: ${need} is missing from ${dir}`);
    }
    for (const n of names) out.push({ key: `films/${id}/${n}`, file: join(dir, n), type: TYPES[n.slice(n.lastIndexOf(".") + 1)] });
  }
  return out;
}

/** The wrangler steps: make sure the bucket exists, then one put per file. */
export function uploadSteps(list) {
  return list.map((u) => ["wrangler", "r2", "object", "put", `${BUCKET}/${u.key}`, "--file", u.file, "--content-type", u.type, "--remote"]);
}

async function main() {
  const { loadEnv } = await import("./lib/env.mjs");
  const { runSteps, spawnRunner, dryRunner } = await import("./lib/deploy.mjs");
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const fi = args.indexOf("--films");
  const filmsDir = resolve(fi >= 0 ? args[fi + 1] : DEFAULT_FILMS);
  const pageDir = fileURLToPath(new URL("../showcase/", import.meta.url));
  if (!existsSync(filmsDir)) {
    console.error(`No films at ${filmsDir}. Render them first (wg-showcase/tools: node render-all.mjs) or pass --films <dir>.`);
    process.exit(1);
  }
  const list = uploads(pageDir, filmsDir);
  console.log(`${list.length} files for ${BUCKET}`);
  const run = dry ? dryRunner : spawnRunner(loadEnv());
  // "bucket info" fails when the bucket is not there yet; then create it.
  if (!dry && run(["wrangler", "r2", "bucket", "info", BUCKET]) !== 0) {
    const s = run(["wrangler", "r2", "bucket", "create", BUCKET]);
    if (s !== 0) process.exit(s);
  }
  const status = runSteps(uploadSteps(list), run);
  if (status !== 0) process.exit(status);
  console.log(dry ? "\nDry run: nothing was changed." : "\nUploaded. Open https://wg-admin.clydeford.net/showcase/");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
