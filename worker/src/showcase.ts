// showcase.ts
//
// Plain English: the shop window. /showcase is the one page on this address
// anyone may open without logging in: the product films, recorded from the
// dashboard with made-up demo data. The page and the films live in their own
// R2 bucket (SHOWCASE, filled by "npm run showcase-upload"), never the
// Terraform state bucket. Only reading, and only the showcase's own files:
// the page, its script, and each film's manifest, poster, chunks and 720p
// fallback. Any other name is a 404 even if it is in the bucket. Cloudflare
// Access lets /showcase through with its own bypass app; everything else on
// the address still needs the login, here and at the edge.

/** The page's own rules: scripts only from here, Google Fonts for type, films from here or a MediaSource blob. */
export const SHOWCASE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self'",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PREFIX = "/showcase/";
const FILE = /^(?:index\.html|showcase\.js|films\/\d{2}-[a-z0-9-]+\/(?:manifest\.json|init\.mp4|chunk-\d{3}\.m4s|fallback-720p\.mp4|poster\.jpg))$/;
const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mp4: "video/mp4",
  m4s: "video/mp4",
  jpg: "image/jpeg",
};

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": SHOWCASE_CSP, ...extra } });
}

/** One "bytes=" range against a file of `size` bytes: [start, end] inclusive, "bad" (416), or null (send it all). */
export function parseRange(header: string | null, size: number): [number, number] | "bad" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null; // absent, several ranges or not bytes: the whole file is a valid answer
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "bad";
    return [Math.max(0, size - n), size - 1];
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "bad";
  return [start, end];
}

/** GET/HEAD for /showcase and everything under it. */
export async function serveShowcase(req: Request, bucket: R2Bucket | undefined): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/showcase") return new Response(null, { status: 301, headers: { Location: PREFIX, "Cache-Control": "public, max-age=3600" } });
  const name = path === PREFIX ? "index.html" : path.slice(PREFIX.length);
  if (!FILE.test(name)) return plain(404, "Not found.");
  if (!bucket) return plain(503, "The showcase is not set up on this Worker.");

  const ext = name.slice(name.lastIndexOf(".") + 1);
  const headers: Record<string, string> = {
    "Content-Type": TYPES[ext],
    "Cache-Control": `public, max-age=${ext === "html" || ext === "js" || ext === "json" ? 300 : 3600}`,
    "Accept-Ranges": "bytes",
    "Content-Security-Policy": SHOWCASE_CSP,
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };

  const head = await bucket.head(name);
  if (!head) return plain(404, "Not found.");
  headers.ETag = head.httpEtag;
  if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(head.size) } });

  const range = parseRange(req.headers.get("Range"), head.size);
  if (range === "bad") return plain(416, "Range not satisfiable.", { "Content-Range": `bytes */${head.size}` });
  if (!range) {
    const obj = await bucket.get(name);
    if (!obj) return plain(404, "Not found.");
    return new Response(obj.body, { status: 200, headers: { ...headers, "Content-Length": String(obj.size) } });
  }
  const [start, end] = range;
  const obj = await bucket.get(name, { range: { offset: start, length: end - start + 1 } });
  if (!obj) return plain(404, "Not found.");
  return new Response(obj.body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${head.size}`, "Content-Length": String(end - start + 1) } });
}
