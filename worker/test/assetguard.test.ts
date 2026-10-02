import { describe, expect, it } from "vitest";
import { serveHashedAsset } from "../src/assetguard";

// The assets layer's single-page-app fallback answers index.html for every
// unknown path, /assets/* included (with run_worker_first as a list, it does so
// even for script requests). /assets/* runs the Worker first so a missing
// hashed file is a 404, never the app's page under a year-long cache header.
const INDEX = '<!doctype html><div id="root"></div>';

function fakeAssets(res: () => Response) {
  const seen: string[] = [];
  return {
    seen,
    fetcher: { fetch: async (req: Request) => (seen.push(new URL(req.url).pathname), res()) } as unknown as Fetcher,
  };
}

describe("serveHashedAsset", () => {
  it("an existing hashed asset is served as stored", async () => {
    const stored = new Response("export{}", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" } });
    const a = fakeAssets(() => stored);
    const res = await serveHashedAsset(new Request("https://x.example/assets/index-abc.js"), a.fetcher);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("export{}");
    expect(a.seen).toEqual(["/assets/index-abc.js"]);
  });

  it("the Worker's header middleware can add to a served asset (the binding's headers are immutable)", async () => {
    const stored = new Response("export{}", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=31536000, immutable" } });
    for (const m of ["set", "append", "delete"] as const) {
      Object.defineProperty(stored.headers, m, { value: () => { throw new TypeError("Can't modify immutable headers."); } });
    }
    const res = await serveHashedAsset(new Request("https://x.example/assets/index-abc.js"), fakeAssets(() => stored).fetcher);
    expect(() => res.headers.set("X-Content-Type-Options", "nosniff")).not.toThrow();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("export{}");
  });

  it("a revalidation (304) passes through", async () => {
    const a = fakeAssets(() => new Response(null, { status: 304 }));
    const res = await serveHashedAsset(new Request("https://x.example/assets/inter-abc.woff2"), a.fetcher);
    expect(res.status).toBe(304);
  });

  it("a missing asset is not index.html", async () => {
    const a = fakeAssets(() => new Response(INDEX, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=31536000, immutable" } }));
    const res = await serveHashedAsset(new Request("https://x.example/assets/nope.js"), a.fetcher);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toMatch(/html/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).not.toContain("root");
  });

  it("an assets 404 stays a 404 without caching", async () => {
    const a = fakeAssets(() => new Response("gone", { status: 404 }));
    const res = await serveHashedAsset(new Request("https://x.example/assets/nope.css"), a.fetcher);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("without the ASSETS binding it is a 404", async () => {
    const res = await serveHashedAsset(new Request("https://x.example/assets/index-abc.js"), undefined);
    expect(res.status).toBe(404);
  });
});
