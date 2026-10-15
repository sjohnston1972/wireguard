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
//              than 25% from Azure's is a problem. An item with `region:
//              secondary` (labs batch 3, ruling 26) is checked the same way in
//              the lab's regions.secondary (ukwest) instead.
//
//   --aws-prices   every AWS lab cost item's aws_price (lab.yaml) is one the
//              Worker's lab price feed can use, asked of AWS's Price List API
//              (aws pricing get-products, read only) in London and, for a
//              `region: secondary` item, in the lab's secondary region: it
//              must match exactly one product with an OnDemand USD price in
//              its unit ({usage} in a usagetype is EUW2 in London, EU in
//              Ireland). Each answer is printed beside the authored £/h, and
//              an authored figure more than 25% from AWS's is a problem. It
//              needs the AWS keys in .env (AWS_ACCESS_KEY_ID and
//              AWS_SECRET_ACCESS_KEY, given to the aws command only, never
//              printed), so it is NEVER part of the default run; it checks
//              only AWS labs (the other flags are Azure's).
//
// With neither --links nor --meters (and no --aws-prices), both run. With no ids, every lab. Exit 0: no problems;
// 1: problems, one line each; 2: bad arguments.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.mjs";
import { awsUsagePrefix, cloudOfId, labFolders, parseLabYaml } from "./lib/labs.mjs";

/** Units the price feed turns into £ per hour (worker/src/insights/feeds/prices.ts LAB_UNITS; a Worker test keeps them equal). */
export const LAB_UNITS = ["1 Hour", "1/Hour", "1/Day", "1/Month"];
/** Rows the price feed skips as not Linux pay-as-you-go (the same as the feed's). */
export const NOT_LINUX_PAYG = /Windows|Spot|Low Priority/i;
const REGION = "uksouth";
const PRICES_URL = "https://prices.azure.com/api/retail/prices";
const HOURS_PER_MONTH = 730;
const DRIFT = 0.25;
/** AWS labs are priced in London (the Worker's AWS_LAB_REGIONS[0]). */
const AWS_REGION = "eu-west-2";

/** Every https link in a readme's markdown, in order, each once. */
export function readmeLinks(md) {
  const out = [];
  for (const m of String(md).matchAll(/\]\((https:\/\/[^)\s]+)\)/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The rows the feed would keep: GBP, pay as you go, uksouth, not Windows/Spot/Low Priority; primary meter regions when there are any. */
function kept(rows, region = REGION) {
  const k = rows.filter((r) => r?.currencyCode === "GBP" && r.type === "Consumption" && r.armRegionName === region && !NOT_LINUX_PAYG.test([r.productName, r.skuName, r.meterName].map((x) => x ?? "").join(" ")));
  return k.some((r) => r.isPrimaryMeterRegion !== false) ? k.filter((r) => r.isPrimaryMeterRegion !== false) : k;
}

const describe = (r) => `${r.productName ?? "?"}${r.tierMinimumUnits ? ` from ${r.tierMinimumUnits} units` : ""} £${r.retailPrice}`;

/**
 * What stops the price feed using `meter` (with lab.yaml's `unit`) for a lab in
 * uksouth, from Retail Prices API rows: [] when nothing does, else one line per problem.
 */
export function meterProblems(rows, { meter, unit }, region = REGION) {
  const mine = kept(rows, region).filter((r) => r.meterName === meter);
  if (!mine.length) return [`${meter}: no ${region} row in the Retail Prices API (GBP, pay as you go, not Windows/Spot)`];
  const out = [];
  const units = [...new Set(mine.map((r) => r.unitOfMeasure))];
  for (const u of units) if (!LAB_UNITS.includes(u)) out.push(`${meter}: unit "${u}" is one the price feed cannot use (it reads ${LAB_UNITS.join(", ")}); keep this item authored`);
  if (unit && !units.includes(unit)) out.push(`${meter}: lab.yaml says "${unit}" but Azure prices it per "${units.join('", "')}"`);
  const usable = mine.filter((r) => LAB_UNITS.includes(r.unitOfMeasure) && (!unit || r.unitOfMeasure === unit));
  const prices = [...new Set(usable.map((r) => r.retailPrice))];
  if (prices.length > 1) out.push(`${meter}: ${prices.length} prices in ${region} (${usable.map(describe).join("; ")}); the feed matches on the meter name alone, so keep this item authored`);
  return out;
}

/** What stops the price feed pricing VM size `sku` in uksouth: [] or one line per problem. */
export function skuProblems(rows, sku, region = REGION) {
  const mine = kept(rows, region).filter((r) => r.armSkuName === sku && r.unitOfMeasure === "1 Hour");
  if (!mine.length) return [`${sku}: no Linux pay-as-you-go hourly price in ${region}`];
  const prices = [...new Set(mine.map((r) => r.retailPrice))];
  return prices.length > 1 ? [`${sku}: ${prices.length} Linux pay-as-you-go prices in ${region} (${mine.map(describe).join("; ")})`] : [];
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
        // An item with region: secondary is priced in the lab's secondary region (batch 3 ruling 26).
        const region = item.region === "secondary" ? lab.secondary : REGION;
        if (!region) {
          problems.push(`${lab.id}: ${item.name}: region: secondary but the lab has no regions.secondary`);
          continue;
        }
        const label = `${retail.meter ?? retail.sku}${region === REGION ? "" : ` (${region})`}`;
        let rows;
        try {
          rows = await rowsFor(retail.meter ? `armRegionName eq '${region}' and meterName eq ${odata(retail.meter)}` : `armRegionName eq '${region}' and armSkuName eq ${odata(retail.sku)} and priceType eq 'Consumption'`);
        } catch (e) {
          problems.push(`${lab.id}: ${label}: ${e.message}`);
          continue;
        }
        const found = retail.meter ? meterProblems(rows, { meter: retail.meter, unit: retail.unit }, region) : skuProblems(rows, retail.sku, region);
        for (const p of found) problems.push(`${lab.id}: ${p}`);
        if (found.length) continue;
        const row = kept(rows, region).find((r) => (retail.meter ? r.meterName === retail.meter && (!retail.unit || r.unitOfMeasure === retail.unit) : r.armSkuName === retail.sku && r.unitOfMeasure === "1 Hour"));
        const gbpH = perHour(row.retailPrice, row.unitOfMeasure);
        lines.push(`${lab.id}: ${label}: £${row.retailPrice}/${row.unitOfMeasure} = £${gbpH.toFixed(4)}/h (authored £${item.gbp_h.toFixed(4)}/h)`);
        if (gbpH > 0 && Math.abs(gbpH - item.gbp_h) / gbpH > DRIFT) problems.push(`${lab.id}: ${item.name}: authored £${item.gbp_h}/h is more than ${DRIFT * 100}% from Azure's £${gbpH.toFixed(4)}/h`);
      }
    }
  }
  return { problems, lines };
}

/** AWS Price List entries (each a JSON string, or already parsed) as objects; unreadable ones dropped. */
function parseProducts(products) {
  const out = [];
  for (const e of products ?? []) {
    try {
      const p = typeof e === "string" ? JSON.parse(e) : e;
      if (p && typeof p === "object") out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The OnDemand USD prices a parsed Price List entry has in `unit`. */
function onDemandUsd(p, unit) {
  const usd = [];
  for (const term of Object.values(p?.terms?.OnDemand ?? {})) {
    for (const dim of Object.values(term?.priceDimensions ?? {})) {
      const raw = dim?.pricePerUnit?.USD;
      const v = Number(raw);
      if (dim?.unit === unit && raw != null && raw !== "" && Number.isFinite(v) && v >= 0) usd.push(v);
    }
  }
  return usd;
}

/**
 * What stops the Worker's lab price feed using aws_price `ref` in `region`, from parsed Price List
 * entries: [] when exactly one product has an OnDemand USD price in ref.unit, else one line.
 */
export function awsPriceProblems(products, ref, region) {
  const priced = parseProducts(products).filter((p) => onDemandUsd(p, ref.unit).length);
  if (priced.length === 1) return [];
  if (!priced.length) return [`no product matches in ${region}`];
  return [`${priced.length} products match in ${region} (${priced.map((p) => p?.product?.attributes?.usagetype ?? "?").join(", ")})`];
}

/** The aws pricing get-products arguments for a reference in a region (the Worker's labPriceBody, as CLI arguments). */
function awsPriceArgs(ref, region) {
  const filters = Object.entries(ref.filters).map(([k, v]) => `Type=TERM_MATCH,Field=${k},Value=${k === "usagetype" ? String(v).replace(/\{usage\}/g, awsUsagePrefix(region)) : v}`);
  filters.push(`Type=TERM_MATCH,Field=regionCode,Value=${region}`);
  return ["pricing", "get-products", "--region", "us-east-1", "--service-code", ref.service, "--format-version", "aws_v1", "--max-results", "100", "--output", "json", "--filters", ...filters];
}

/**
 * Check AWS labs ([{ id, items, secondary }]) against the Price List API. run(args) -> { status, stdout, stderr }
 * runs `aws <args>`. Returns { problems, lines } as verifyLabs does.
 */
export async function verifyAwsPrices(labs, { run, usdToGbp = 0.75 }) {
  const problems = [];
  const lines = [];
  for (const lab of labs) {
    for (const item of lab.items ?? []) {
      const ref = item.aws_price;
      if (!ref) continue;
      const region = item.region === "secondary" ? lab.secondary : AWS_REGION;
      if (!region) {
        problems.push(`${lab.id}: ${item.name}: region: secondary but the lab has no regions.secondary`);
        continue;
      }
      let list;
      try {
        const r = await run(awsPriceArgs(ref, region));
        if (r.status !== 0) throw new Error(`aws pricing get-products failed (${String(r.stderr ?? "").trim().split("\n")[0].slice(0, 200) || `exit ${r.status}`})`);
        list = JSON.parse(r.stdout)?.PriceList ?? [];
      } catch (e) {
        problems.push(`${lab.id}: ${item.name}: ${e.message}`);
        continue;
      }
      const found = awsPriceProblems(list, ref, region);
      for (const p of found) problems.push(`${lab.id}: ${item.name}: ${p}`);
      if (found.length) continue;
      // The Worker stores the highest OnDemand price of the one product (past any free tier).
      const usd = Math.max(...onDemandUsd(parseProducts(list).find((p) => onDemandUsd(p, ref.unit).length), ref.unit));
      const gbpH = ref.unit === "GB-Mo" ? ((usd * (ref.gb ?? 0)) / HOURS_PER_MONTH) * usdToGbp : usd * usdToGbp;
      lines.push(`${lab.id}: ${item.name} (${region}): $${usd}/${ref.unit} = £${gbpH.toFixed(4)}/h (authored £${item.gbp_h.toFixed(4)}/h)`);
      if (gbpH > 0 && Math.abs(gbpH - item.gbp_h) / gbpH > DRIFT) problems.push(`${lab.id}: ${item.name}: authored £${item.gbp_h}/h is more than ${DRIFT * 100}% from AWS's £${gbpH.toFixed(4)}/h`);
    }
  }
  return { problems, lines };
}

/** A lab folder as verifyLabs reads it. */
function readLab(root, id) {
  const raw = parseLabYaml(readFileSync(join(root, id, "lab.yaml"), "utf8")).raw;
  return { id, readme: readFileSync(join(root, id, "readme.md"), "utf8"), items: raw?.cost?.items ?? [], secondary: raw?.regions?.secondary ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL("../labs/", import.meta.url));
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const ids = args.filter((a) => !a.startsWith("--"));
  const all = labFolders(root);
  const unknown = [...ids.filter((i) => !all.includes(i)), ...[...flags].filter((f) => !["--links", "--meters", "--aws-prices"].includes(f))];
  if (unknown.length) {
    console.error(`Usage: npm run labs-verify -- [--links] [--meters] [--aws-prices] [lab id ...]   (not known: ${unknown.join(", ")})`);
    process.exit(2);
  }
  if (flags.has("--aws-prices")) {
    // Only AWS labs, only with this flag: it needs the AWS keys, given to the aws command and nothing else.
    const env = loadEnv();
    if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      console.error("labs-verify --aws-prices: .env needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (read-only pricing:GetProducts is enough)");
      process.exit(2);
    }
    const awsIds = (ids.length ? ids : all).filter((id) => cloudOfId(id) === "aws");
    const run = (args) => spawnSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY, AWS_PAGER: "" } });
    const r = await verifyAwsPrices(awsIds.map((id) => readLab(root, id)), { run });
    for (const l of r.lines) console.log(l);
    if (r.problems.length) {
      console.error(`labs-verify --aws-prices: ${r.problems.length} problem(s)`);
      for (const p of r.problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log(`labs-verify --aws-prices: ${awsIds.length} AWS lab(s), every price reference checked`);
    process.exit(0);
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
