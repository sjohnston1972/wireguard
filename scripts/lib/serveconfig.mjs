// scripts/lib/serveconfig.mjs
//
// Plain English: reads the two files that decide how the app is served, so the
// tests can check them: wrangler.toml's [assets] table (where the built app
// lives, which paths go to the Worker first) and web/public/_headers (the
// security and cache headers Cloudflare adds to every static file).

/**
 * The [assets] table of wrangler.toml as a plain object, or null if there is
 * none. Only what this project uses: strings, booleans and arrays of strings.
 */
export function readAssetsConfig(tomlText) {
  const lines = tomlText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "[assets]");
  if (start === -1) return null;
  const out = {};
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line.startsWith("[")) break;
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (!m) continue;
    out[m[1]] = JSON.parse(m[2].replace(/\s+#.*$/, ""));
  }
  return out;
}

/**
 * Cloudflare's _headers format: a URL pattern on its own line, then indented
 * "Name: value" lines. Returns { pattern: { Name: value } }.
 */
export function parseHeaders(text) {
  const out = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = raw.trim();
      out[current] ??= {};
      continue;
    }
    if (!current) continue;
    const i = raw.indexOf(":");
    if (i === -1) continue;
    out[current][raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
  }
  return out;
}

/** A Content-Security-Policy value as { directive: [sources] }. */
export function parseCsp(value) {
  const out = {};
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}
