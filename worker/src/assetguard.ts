// assetguard.ts
//
// Plain English: the app's hashed files (/assets/*.js, .css, fonts) are served
// by Cloudflare's assets layer, whose single-page-app fallback answers the
// app's index.html for ANY path it has no file for. For a page address that is
// right (deep links); for /assets/* it is not: a tab left open across a deploy
// asking for an old file would get the HTML page back, under the year-long
// "immutable" cache header. So /assets/* runs the Worker first (wrangler.toml
// run_worker_first), and this hands the request to the assets layer (the
// ASSETS binding) and turns its fallback page into a plain 404.

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function serveHashedAsset(request: Request, assets: Fetcher | undefined): Promise<Response> {
  if (!assets) return notFound();
  const res = await assets.fetch(request);
  if (res.status === 304) return res;
  if ((res.status !== 200 && res.status !== 206) ||/^text\/html/i.test(res.headers.get("Content-Type") ?? "")) return notFound();
  return res;
}
