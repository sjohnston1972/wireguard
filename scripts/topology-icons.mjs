// scripts/topology-icons.mjs   (run by hand: node scripts/topology-icons.mjs [scratch dir]; not in CI)
//
// Plain English: builds the lab diagram's icon sprite (lab topology spec §10,
// ruling 20) from Microsoft's official Azure Architecture Icons pack
// (https://learn.microsoft.com/azure/architecture/icons/). It downloads the
// pinned pack into a scratch folder (never the repo), refuses it unless its
// SHA-256 matches, extracts it with tar (bsdtar: Windows 10+ and macOS ship
// it; GNU tar on Linux reads zips through bsdtar only, so `unzip` there),
// takes only the icons the kinds registry (shared/topology/kinds.ts) names,
// optimises each (no shape is changed: the terms forbid distorting them) and
// writes:
//
//   web/src/views/labs/topology/icons/azure.svg   one <symbol id="az-<icon>"> per icon, hidden
//   web/src/views/labs/topology/icons/README.md   the pack, its terms (quoted, with the link) and the file list
//
// The optimiser strips the XML prolog, comments, <title>, <desc>,
// <metadata>, editor elements and attributes and the whitespace between
// tags, and renames every id to "<icon>-<n>" (rewriting url(#…) and href
// references), so ids from different icons can never collide once the
// sprite is inlined into the page. viewBox, path data, transforms and colours
// are kept exactly.
//
// To move to a newer pack: change PACK_VERSION, run once with PACK_SHA256
// set to "" (the script prints the download's hash and stops), check the
// page's terms still read as quoted in README_TERMS, pin the hash, run again.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACK_VERSION = "V24";
export const PACK_URL = `https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_${PACK_VERSION}.zip`;
/** SHA-256 of the V24 zip as downloaded on 2026-10-06. */
export const PACK_SHA256 = "921594ccd1bf3d9c0a1bd7b6d924e050551a59342f2b353bb74bdcf761c35141";
export const PACK_PAGE = "https://learn.microsoft.com/azure/architecture/icons/";
const DOWNLOADED = "2026-10-06";
/** Inside the zip. */
const PACK_ROOT = "Azure_Public_Service_Icons/Icons";

/**
 * Icon id (KINDS[k].icon) → file in the pack. Where the pack has no icon of
 * that exact name the closest official one is used (NEAREST says why).
 */
export const ICON_FILES = {
  "resource-groups": "general/10007-icon-service-Resource-Groups.svg",
  "management-groups": "general/10011-icon-service-Management-Groups.svg",
  generic: "general/10001-icon-service-All-Resources.svg",
  "virtual-networks": "networking/10061-icon-service-Virtual-Networks.svg",
  "kubernetes-services": "containers/10023-icon-service-Kubernetes-Services.svg",
  subnet: "networking/02742-icon-service-Subnet.svg",
  "virtual-wan-hub": "networking/00860-icon-service-Virtual-WAN-Hub.svg",
  "virtual-wans": "networking/10353-icon-service-Virtual-WANs.svg",
  firewalls: "networking/10084-icon-service-Firewalls.svg",
  "firewall-policies": "networking/00272-icon-service-Azure-Firewall-Policy.svg",
  "virtual-network-gateways": "networking/10063-icon-service-Virtual-Network-Gateways.svg",
  "local-network-gateways": "networking/10077-icon-service-Local-Network-Gateways.svg",
  "application-gateways": "networking/10076-icon-service-Application-Gateways.svg",
  "web-application-firewall-policies": "networking/10362-icon-service-Web-Application-Firewall-Policies(WAF).svg",
  "load-balancers": "networking/10062-icon-service-Load-Balancers.svg",
  bastions: "networking/02422-icon-service-Bastions.svg",
  "route-server": "networking/02496-icon-service-Virtual-Router.svg",
  nat: "networking/10310-icon-service-NAT.svg",
  "public-ip-addresses": "networking/10069-icon-service-Public-IP-Addresses.svg",
  "public-ip-prefixes": "networking/10372-icon-service-Public-IP-Prefixes.svg",
  "private-endpoints": "other/02579-icon-service-Private-Endpoints.svg",
  "private-link-services": "networking/02209-icon-service-Private-Link-Services.svg",
  "dns-private-resolver": "networking/02882-icon-service-DNS-Private-Resolver.svg",
  "dns-forwarding-ruleset": "networking/02882-icon-service-DNS-Private-Resolver.svg",
  "dns-zones": "networking/10064-icon-service-DNS-Zones.svg",
  "private-dns-zones": "networking/10064-icon-service-DNS-Zones.svg",
  "front-door": "networking/10073-icon-service-Front-Door-and-CDN-Profiles.svg",
  "traffic-manager-profiles": "networking/10065-icon-service-Traffic-Manager-Profiles.svg",
  "network-security-groups": "networking/10067-icon-service-Network-Security-Groups.svg",
  "route-tables": "networking/10082-icon-service-Route-Tables.svg",
  "network-managers": "other/02237-icon-service-Network-Managers.svg",
  "network-watcher": "networking/10066-icon-service-Network-Watcher.svg",
  "virtual-machine": "compute/10021-icon-service-Virtual-Machine.svg",
  "vm-scale-sets": "compute/10034-icon-service-VM-Scale-Sets.svg",
  "container-instances": "containers/10104-icon-service-Container-Instances.svg",
  "container-apps": "other/02884-icon-service-Worker-Container-App.svg",
  "container-apps-environments": "other/02989-icon-service-Container-Apps-Environments.svg",
  "container-registries": "containers/10105-icon-service-Container-Registries.svg",
  "service-bus": "integration/10836-icon-service-Azure-Service-Bus.svg",
  "event-grid-system-topics": "integration/02073-icon-service-System-Topic.svg",
  "app-service-plans": "app services/00046-icon-service-App-Service-Plans.svg",
  "storage-accounts": "storage/10086-icon-service-Storage-Accounts.svg",
  "sql-server": "databases/10132-icon-service-SQL-Server.svg",
  "sql-database": "databases/10130-icon-service-SQL-Database.svg",
  "azure-cosmos-db": "databases/10121-icon-service-Azure-Cosmos-DB.svg",
  "key-vaults": "security/10245-icon-service-Key-Vaults.svg",
  "log-analytics-workspaces": "monitor/00009-icon-service-Log-Analytics-Workspaces.svg",
  monitor: "monitor/00001-icon-service-Monitor.svg",
  "recovery-services-vaults": "management + governance/00017-icon-service-Recovery-Services-Vaults.svg",
  "managed-identities": "identity/10227-icon-service-Managed-Identities.svg",
  policy: "management + governance/10316-icon-service-Policy.svg",
  role: "identity/10340-icon-service-Entra-Identity-Roles-and-Administrators.svg",
  users: "identity/10230-icon-service-Users.svg",
};

/** The icons that are the nearest official icon rather than one of that exact name. */
export const NEAREST = {
  "route-server": "the pack has no Route Server icon; Virtual Router is the portal's icon for it",
  "dns-forwarding-ruleset": "no ruleset icon; the DNS Private Resolver it belongs to",
  "private-dns-zones": "no private DNS zone icon; DNS Zones",
  "container-apps": "the pack's Container App icon is named Worker Container App",
  role: "no role definition icon; Entra Identity Roles and Administrators",
  generic: "a resource of a kind the diagram does not know: All Resources",
};

/**
 * One pack SVG as a symbol's parts: { viewBox, body }, with every id renamed
 * "<icon>-<n>" and every reference to it rewritten. Shapes are untouched.
 */
export function optimiseIcon(svg, icon) {
  let s = String(svg)
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["title", "desc", "metadata"]) s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), "").replace(new RegExp(`<${tag}\\b[^>]*/>`, "g"), "");
  s = s.replace(/<(sodipodi|inkscape):[\w-]+\b[^>]*\/>/g, "").replace(/<(sodipodi|inkscape):([\w-]+)\b[^>]*>[\s\S]*?<\/\1:\2>/g, "");
  const open = /<svg\b[^>]*>/.exec(s);
  if (!open) throw new Error(`${icon}: not an SVG`);
  const viewBox = /\bviewBox="([^"]+)"/.exec(open[0])?.[1];
  if (!viewBox) throw new Error(`${icon}: no viewBox`);
  let body = s.slice(open.index + open[0].length, s.lastIndexOf("</svg>"));
  // Editor attributes.
  body = body.replace(/\s(?:data-name|xml:space|(?:sodipodi|inkscape):[\w-]+)="[^"]*"/g, "");
  body = body.replace(/>\s+</g, "><").trim();
  // Ids: renamed in order of appearance.
  const map = new Map();
  for (const m of body.matchAll(/\sid="([^"]+)"/g)) if (!map.has(m[1])) map.set(m[1], `${icon}-${map.size + 1}`);
  const to = (id) => map.get(id) ?? id;
  body = body
    .replace(/(\s)id="([^"]+)"/g, (_, sp, id) => `${sp}id="${to(id)}"`)
    .replace(/url\((['"]?)#([^'")]+)\1\)/g, (_, q, id) => `url(${q}#${to(id)}${q})`)
    .replace(/((?:xlink:)?href)="#([^"]+)"/g, (_, a, id) => `${a}="#${to(id)}"`);
  // Class names in an embedded stylesheet, so two icons' .cls-1 never meet.
  if (/<style\b/.test(body)) {
    body = body
      .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/g, (_, a, css) => `<style${a}>${css.replace(/\.([A-Za-z_][\w-]*)/g, (m, c) => (/^\d/.test(c) ? m : `.${icon}-${c}`))}</style>`)
      .replace(/\sclass="([^"]+)"/g, (_, c) => ` class="${c.split(/\s+/).filter(Boolean).map((x) => `${icon}-${x}`).join(" ")}"`);
  }
  return { viewBox, body };
}

/** The sprite: one hidden <svg> with a <symbol> per icon, sorted by icon id. */
export function buildSprite(icons) {
  const parts = Object.keys(icons)
    .sort()
    .map((icon) => `<symbol id="az-${icon}" viewBox="${icons[icon].viewBox}">${icons[icon].body}</symbol>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="display:none">${parts.join("")}</svg>\n`;
}

export const README_TERMS = [
  "Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation. You can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft. Microsoft reserves all other rights.",
];
export const README_DONTS = ["Don't crop, flip, or rotate icons.", "Don't distort or change icon shape in any way.", "Don't use Microsoft product icons to represent your product or service."];

export function buildReadme() {
  const rows = Object.keys(ICON_FILES)
    .sort()
    .map((icon) => `| \`${icon}\` | \`${ICON_FILES[icon]}\` | ${NEAREST[icon] ?? ""} |`);
  return [
    "# Azure icons for the lab diagram",
    "",
    "`azure.svg` is generated by `node scripts/topology-icons.mjs` (run by hand; never edit it). It holds one",
    "`<symbol id=\"az-<icon>\">` per icon the kinds registry (`shared/topology/kinds.ts`) names, and nothing else.",
    "",
    `- **Source:** Microsoft Azure Architecture Icons, pack **${PACK_VERSION}** (Azure_Public_Service_Icons_${PACK_VERSION}.zip),`,
    `  from the official page ${PACK_PAGE}`,
    `- **Download:** ${PACK_URL}, SHA-256 \`${PACK_SHA256}\`, downloaded ${DOWNLOADED}.`,
    "- **Changes:** only what the terms allow. Comments, titles, editor attributes and whitespace are removed and ids",
    "  are renamed so icons cannot clash in one page; no shape, path, viewBox, transform or colour is changed.",
    "",
    "## Terms",
    "",
    `From ${PACK_PAGE} ("Icon terms"):`,
    "",
    ...README_TERMS.map((t) => `> ${t}`),
    "",
    "And its general guidelines:",
    "",
    ...README_DONTS.map((t) => `> - ${t}`),
    "",
    "The lab diagram is an architecture diagram of the Azure resources a lab makes, a permitted use. Each icon",
    "stands for the Azure product it names, shown next to the resource's name.",
    "",
    "## Files",
    "",
    `Paths are inside the pack's \`${PACK_ROOT}/\` folder. A note marks the nearest official icon where the pack has none of`,
    "that exact name.",
    "",
    "| Icon | Pack file | Note |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Extract a zip with bsdtar (Windows' own tar.exe; macOS tar), or unzip on Linux. */
function extract(zip, dir) {
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const r = process.platform === "linux" ? spawnSync("unzip", ["-q", zip, "-d", dir], { encoding: "utf8" }) : spawnSync(tar, ["-xf", zip, "-C", dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`could not extract the pack: ${(r.stderr || r.error?.message || "").trim()}`);
}

async function main() {
  const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "topology-icons-"));
  mkdirSync(scratch, { recursive: true });
  const zip = join(scratch, `Azure_Public_Service_Icons_${PACK_VERSION}.zip`);
  let bytes = existsSync(zip) ? readFileSync(zip) : null;
  if (!bytes || sha256(bytes) !== PACK_SHA256) {
    const r = await fetch(PACK_URL);
    if (!r.ok) throw new Error(`the icon pack download answered ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
    const got = sha256(bytes);
    if (got !== PACK_SHA256) {
      console.error(`the icon pack's SHA-256 is ${got}, not the pinned ${PACK_SHA256 || "(none pinned)"}: not used`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(zip, bytes);
  }
  const out = join(scratch, "extracted");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  try {
    extract(zip, out);
    const icons = {};
    for (const [icon, file] of Object.entries(ICON_FILES)) icons[icon] = optimiseIcon(readFileSync(join(out, PACK_ROOT, file), "utf8"), icon);
    const dir = fileURLToPath(new URL("../web/src/views/labs/topology/icons/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    const sprite = buildSprite(icons);
    writeFileSync(join(dir, "azure.svg"), sprite);
    writeFileSync(join(dir, "README.md"), buildReadme());
    console.log(`wrote ${Object.keys(icons).length} icons, ${(sprite.length / 1000).toFixed(1)} kB raw`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
