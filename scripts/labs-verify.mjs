// scripts/labs-verify.mjs   (npm run labs-verify -- [--links] [--meters] [id ...])
//
// Plain English: the lab checks that need the internet, so they never run in
// npm test or CI's labs job. No credentials: both sources are public.
//
//   --links    every https link in each lab's readme answers 200 (HEAD, then
//              GET if HEAD is refused), following redirects
//   --meters   every cost item's Azure list price (lab.yaml `retail`) is one
//              the Worker's price feed can use, from the public Retail Prices
//              API for uksouth: a meter must have a uksouth row, in a unit the
//              feed reads, at one price (the feed matches on the meter name
//              alone, so a name two products share at different prices would
//              price the wrong one: keep that item authored, ruling 2); a VM
//              size must have a Linux pay-as-you-go hourly price. Each answer
//              is printed beside the authored £/h, and an authored figure more
//              than 25% from Azure's is a problem.
//
// With neither flag, both run. With no ids, every lab. Exit 0: no problems;
// 1: problems, one line each; 2: bad arguments.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labFolders, parseLabYaml } from "./lib/labs.mjs";

/** Units the price feed turns into £ per hour (worker/src/insights/feeds/prices.ts LAB_UNITS; a Worker test keeps them equal). */
export const LAB_UNITS = ["1 Hour", "1/Hour", "1/Day", "1/Month"];
/** Rows the price feed skips as not Linux pay-as-you-go (the same as the feed's). */
export const NOT_LINUX_PAYG = /Windows|Spot|Low Priority/i;
const REGION = "uksouth";
const PRICES_URL = "https://prices.azure.com/api/retail/prices";
const HOURS_PER_MONTH = 730;
const DRIFT = 0.25;

/** Every https link in a readme's markdown, in order, each once. */
export function readmeLinks(md) {
  const out = [];
  for (const m of String(md).matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The rows the feed would keep: GBP, pay as you go, uksouth, not Windows/Spot/Low Priority; primary meter regions when there are any. */
function kept(rows) {
  const k = rows.filter((r) => r?.currencyCode === "GBP" && r.type === "Consumption" && r.armRegionName === REGION && !NOT_LINUX_PAYG.test([r.productName, r.skuName, r.meterName].map((x) => x ?? "").join(" ")));
  return k.some((r) => r.isPrimaryMeterRegion !== false) ? k.filter((r) => r.isPrimaryMeterRegion !== false) : k;
}

const describe = (r) => `${r.productName ?? "?"}${r.tierMinimumUnits ? ` from ${r.tierMinimumUnits} units` : ""} £${r.retailPrice}`;

/**
 * What stops the price feed using `meter` (with lab.yaml's `unit`) for a lab in
 * uksouth, from Retail Prices API rows: [] when nothing does, else one line per problem.
 */
export function meterProblems(rows, { meter, unit }) {
  const mine = kept(rows).filter((r) => r.meterName === meter);
  if (!mine.length) return [`${meter}: no uksouth row in the Retail Prices API (GBP, pay as you go, not Windows/Spot)`];
  const out = [];
  const units = [...new Set(mine.map((r) => r.unitOfMeasure))];
  for (const u of units) if (!LAB_UNITS.includes(u)) out.push(`${meter}: unit "${u}" is one the price feed cannot use (it reads ${LAB_UNITS.join(", ")}); keep this item authored`);
  if (unit && !units.includes(unit)) out.push(`${meter}: lab.yaml says "${unit}" but Azure prices it per "${units.join('", "')}"`);
  const usable = mine.filter((r) => LAB_UNITS.includes(r.unitOfMeasure) && (!unit || r.unitOfMeasure === unit));
  const prices = [...new Set(usable.map((r) => r.retailPrice))];
  if (prices.length > 1) out.push(`${meter}: ${prices.length} prices in uksouth (${usable.map(describe).join("; ")}); the feed matches on the meter name alone, so keep this item authored`);
  return out;
}

/** What stops the price feed pricing VM size `sku` in uksouth: [] or one line per problem. */
export function skuProblems(rows, sku) {
  const mine = kept(rows).filter((r) => r.armSkuName === sku && r.unitOfMeasure === "1 Hour");
  if (!mine.length) return [`${sku}: no Linux pay-as-you-go hourly price in uksouth`];
  const prices = [...new Set(mine.map((r) => r.retailPrice))];
  return prices.length > 1 ? [`${sku}: ${prices.length} Linux pay-as-you-go prices in uksouth (${mine.map(describe).join("; ")})`] : [];
}

/** £ per hour for a price in one of the feed's units (labs/prices.ts perHour). */
function perHour(price, unit) {
  if (unit === "1 Hour" || unit === "1/Hour") return price;
  if (unit === "1/Day") return price / 24;
  if (unit === "1/Month") return price / HOURS_PER_MONTH;
  return null;
}

const odata = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Every Retail Prices API row for a filter (following next pages on prices.azure.com, at most 10). */
async function priceRows(fetch, filter) {
  let next = `${PRICES_URL}?currencyCode=${encodeURIComponent("'GBP'")}&$filter=${encodeURIComponent(filter)}`;
  const rows = [];
  for (let page = 0; next && page < 10; page++) {
    const r = await fetch(next);
    if (!r.ok) throw new Error(`the Retail Prices API answered ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j.Items)) rows.push(...j.Items);
    next = typeof j.NextPageLink === "string" && j.NextPageLink.startsWith(`${PRICES_URL}?`) ? j.NextPageLink : null;
  }
  return rows;
}

/** A link's final HTTP status: HEAD, then GET when HEAD is refused or not 200; one retry after a 429. */
async function linkStatus(fetch, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (r.status !== 200) r = await fetch(url, { method: "GET", redirect: "follow" });
    if (r.status !== 429) return r;
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { status: 429 };
}

/**
 * Check labs ([{ id, readme, items }]) with `fetch`. Returns { problems, lines }:
 * problems as "id: what", lines as everything learnt (prices beside the authored figures).
 */
export async function verifyLabs(labs, { links = true, meters = true, fetch = globalThis.fetch } = {}) {
  const problems = [];
  const lines = [];
  const linkCache = new Map();
  const rowCache = new Map();
  const rowsFor = (filter) => {
    if (!rowCache.has(filter)) rowCache.set(filter, priceRows(fetch, filter));
    return rowCache.get(filter);
  };
  for (const lab of labs) {
    if (links) {
      for (const url of readmeLinks(lab.readme)) {
        if (!linkCache.has(url)) linkCache.set(url, linkStatus(fetch, url).catch((e) => ({ status: null, error: e })));
        const r = await linkCache.get(url);
        if (r.status === 200) lines.push(`${lab.id}: ${url} 200${r.redirected && r.url && r.url !== url ? ` (redirects to ${r.url})` : ""}`);
        else problems.push(`${lab.id}: ${url} ${r.status === null ? `failed (${r.error?.message ?? "no answer"})` : `answered ${r.status}`}`);
      }
    }
    if (meters) {
      for (const item of lab.items ?? []) {
        const retail = item.retail;
        if (!retail?.meter && !retail?.sku) continue;
        let rows;
        try {
          rows = await rowsFor(retail.meter ? `armRegionName eq '${REGION}' and meterName eq ${odata(retail.meter)}` : `armRegionName eq '${REGION}' and armSkuName eq ${odata(retail.sku)} and priceType eq 'Consumption'`);
        } catch (e) {
          problems.push(`${lab.id}: ${retail.meter ?? retail.sku}: ${e.message}`);
          continue;
        }
        const found = retail.meter ? meterProblems(rows, { meter: retail.meter, unit: retail.unit }) : skuProblems(rows, retail.sku);
        for (const p of found) problems.push(`${lab.id}: ${p}`);
        if (found.length) continue;
        const row = kept(rows).find((r) => (retail.meter ? r.meterName === retail.meter && (!retail.unit || r.unitOfMeasure === retail.unit) : r.armSkuName === retail.sku && r.unitOfMeasure === "1 Hour"));
        const gbpH = perHour(row.retailPrice, row.unitOfMeasure);
        lines.push(`${lab.id}: ${retail.meter ?? retail.sku}: £${row.retailPrice}/${row.unitOfMeasure} = £${gbpH.toFixed(4)}/h (authored £${item.gbp_h.toFixed(4)}/h)`);
        if (gbpH > 0 && Math.abs(gbpH - item.gbp_h) / gbpH > DRIFT) problems.push(`${lab.id}: ${item.name}: authored £${item.gbp_h}/h is more than ${DRIFT * 100}% from Azure's £${gbpH.toFixed(4)}/h`);
      }
    }
  }
  return { problems, lines };
}

/** A lab folder as verifyLabs reads it. */
function readLab(root, id) {
  const raw = parseLabYaml(readFileSync(join(root, id, "lab.yaml"), "utf8")).raw;
  return { id, readme: readFileSync(join(root, id, "readme.md"), "utf8"), items: raw?.cost?.items ?? [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../labs/", import.meta.url));
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const ids = args.filter((a) => !a.startsWith("--"));
  const all = labFolders(root);
  const unknown = [...ids.filter((i) => !all.includes(i)), ...[...flags].filter((f) => f !== "--links" && f !== "--meters")];
  if (unknown.length) {
    console.error(`Usage: npm run labs-verify -- [--links] [--meters] [lab id ...]   (not known: ${unknown.join(", ")})`);
    process.exit(2);
  }
  const both = !flags.has("--links") && !flags.has("--meters");
  const { problems, lines } = await verifyLabs((ids.length ? ids : all).map((id) => readLab(root, id)), { links: both || flags.has("--links"), meters: both || flags.has("--meters") });
  for (const l of lines) console.log(l);
  if (problems.length) {
    console.error(`labs-verify: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`labs-verify: ${(ids.length ? ids : all).length} lab(s), every link and price checked`);
}
