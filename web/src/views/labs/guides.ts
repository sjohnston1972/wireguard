// views/labs/guides.ts
//
// Plain English: where the lab readmes' diagrams are served from. Each
// committed SVG in shared/guides (npm run labs-diagrams) is a hashed static
// asset, fetched only when its picture is shown; this module holds just the
// map from its catalogue name ("az104-16-lb-appgw/architecture.svg") to its
// URL. Eager, as URLs: one small map in the labs chunk (never the entry); lazy
// globs would make one JS chunk per diagram.

// Keys relative to shared/guides ("./az104-16-lb-appgw/architecture.svg"): short, as the map ships in the chunk.
const files = import.meta.glob<string>("./*/*.svg", { base: "../../../../shared/guides/", query: "?url", import: "default", eager: true });
const PREFIX = "./";

/** Catalogue file name → the hashed URL of the SVG. */
export const GUIDE_URLS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.slice(PREFIX.length), v]));

/** The URL of a readme diagram, or null when the build has no such file. `urls` is for tests. */
export function guideUrl(file: string, urls: Readonly<Record<string, string>> = GUIDE_URLS): string | null {
  return Object.hasOwn(urls, file) ? urls[file]! : null;
}
