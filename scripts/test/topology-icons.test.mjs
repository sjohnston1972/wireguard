// topology-icons.test.mjs
//
// Plain English: the Azure icon sprite the lab diagram draws with (lab
// topology spec §10). scripts/topology-icons.mjs (run by hand) takes the
// official Microsoft Azure Architecture Icons pack, keeps only the icons the
// kinds registry names, and writes one optimised sprite with the terms in a
// README beside it. These tests check the optimiser keeps every shape, that
// every kind has its symbol, that ids cannot collide between icons, the size
// budget, and the README.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { runnerImport } from "vite";
import { optimiseIcon, ICON_FILES, PACK_VERSION, PACK_URL } from "../topology-icons.mjs";

const SPRITE = fileURLToPath(new URL("../../web/src/views/labs/topology/icons/azure.svg", import.meta.url));
const README = fileURLToPath(new URL("../../web/src/views/labs/topology/icons/README.md", import.meta.url));

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: an editor -->
<svg id="root-1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="18" height="18" viewBox="0 0 18 18">
  <metadata>stuff</metadata>
  <sodipodi:namedview pagecolor="#fff" />
  <defs>
    <linearGradient id="g1" x1="9" y1="0" x2="9" y2="18" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#5ea0ef" /><stop offset="1" stop-color="#0078d4" /></linearGradient>
    <linearGradient id="g2" xlink:href="#g1" x1="1" />
    <clipPath id="c1"><rect x="0" y="0" width="18" height="18" /></clipPath>
  </defs>
  <title>Icon-networking-61</title>
  <desc>a description</desc>
  <g clip-path="url(#c1)" sodipodi:role="layer"><path d="M2.61,7.28h.94a.3.3,0,0,1,.3.3Z" fill="url(#g1)" transform="rotate(45)" /><circle cx="9" cy="9" r="1.16" fill="url('#g2')" /></g>
</svg>`;

const idsIn = (s) => [...s.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

test("the optimiser keeps every path and the viewBox and prefixes every id", () => {
  const out = optimiseIcon(SAMPLE, "virtual-networks");
  assert.equal(out.viewBox, "0 0 18 18");
  const body = out.body;
  // Every shape kept exactly (path data, transform, attributes).
  assert.ok(body.includes('<path d="M2.61,7.28h.94a.3.3,0,0,1,.3.3Z"'), body);
  assert.ok(body.includes('transform="rotate(45)"'));
  assert.ok(body.includes('<circle cx="9" cy="9" r="1.16"'));
  assert.ok(body.includes('<rect x="0" y="0" width="18" height="18"'));
  assert.equal((body.match(/<stop /g) ?? []).length, 2);
  // Editor leftovers, comments, prolog, title, desc and metadata gone.
  assert.doesNotMatch(body, /<\?xml|<!--|<title|<desc|<metadata|sodipodi|data-name|Layer 1/);
  // Every id prefixed, and every reference follows it.
  const ids = idsIn(body);
  assert.equal(ids.length, 3);
  for (const id of ids) assert.ok(id.startsWith("virtual-networks-"), id);
  const refs = [...body.matchAll(/url\(['"]?#([^'")]+)['"]?\)|href="#([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  assert.equal(refs.length, 4);
  for (const r of refs) assert.ok(ids.includes(r), `${r} points at an id in the icon`);
  // No whitespace between tags.
  assert.doesNotMatch(body, />\s+</);
});

test("the pack is pinned by version and URL", () => {
  assert.match(PACK_VERSION, /^V\d+$/);
  assert.equal(PACK_URL, `https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_${PACK_VERSION}.zip`);
});

const sprite = () => readFileSync(SPRITE, "utf8");
const symbols = (s) => [...s.matchAll(/<symbol id="az-([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)].map((m) => ({ icon: m[1], body: m[2], open: m[0].slice(0, m[0].indexOf(">") + 1) }));

test("every KINDS icon is a symbol in the sprite, plus generic", async () => {
  const { module } = await runnerImport(fileURLToPath(new URL("../../shared/topology/kinds.ts", import.meta.url)), { configFile: false, logLevel: "error" });
  const icons = new Set(Object.values(module.KINDS).map((k) => k.icon));
  icons.add("generic");
  const have = new Set(symbols(sprite()).map((s) => s.icon));
  for (const i of icons) {
    assert.ok(have.has(i), `the sprite has az-${i}`);
    assert.ok(Object.hasOwn(ICON_FILES, i), `ICON_FILES names a pack file for ${i}`);
  }
  // Only what is needed.
  for (const i of have) assert.ok(icons.has(i), `az-${i} is used by a kind`);
});

test("every id inside a symbol starts with its icon's prefix, and every symbol keeps a viewBox", () => {
  const all = [];
  for (const s of symbols(sprite())) {
    assert.match(s.open, /viewBox="[\d. -]+"/, s.icon);
    for (const id of idsIn(s.body)) {
      assert.ok(id.startsWith(`${s.icon}-`), `${id} in az-${s.icon}`);
      all.push(id);
    }
    for (const m of s.body.matchAll(/url\(['"]?#([^'")]+)['"]?\)|href="#([^"]+)"/g)) {
      const r = m[1] ?? m[2];
      assert.ok(r.startsWith(`${s.icon}-`), `${r} referenced in az-${s.icon}`);
    }
  }
  assert.equal(new Set(all).size, all.length, "no id is used twice in the sprite");
});

test("the sprite is under 60 kB gzip and hidden", () => {
  const s = sprite();
  assert.match(s, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*style="display:none"/);
  const gz = gzipSync(Buffer.from(s), { level: 9 }).length;
  assert.ok(gz < 60_000, `sprite is ${gz} bytes gzip`);
});

test("the README quotes the terms with the link and names the pack version", () => {
  const r = readFileSync(README, "utf8");
  assert.ok(r.includes("https://learn.microsoft.com/azure/architecture/icons/"));
  assert.ok(r.includes(PACK_VERSION));
  assert.ok(r.includes(PACK_URL));
  assert.match(r, /Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation\./);
  assert.match(r, /You can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft\./);
  assert.match(r, /Don't crop, flip, or rotate icons\./);
  assert.match(r, /Don't distort or change icon shape in any way\./);
  assert.match(r, /Don't use Microsoft product icons to represent your product or service\./);
  for (const [icon, path] of Object.entries(ICON_FILES)) assert.ok(r.includes(`\`${icon}\``) && r.includes(path), `README lists ${icon}`);
});
