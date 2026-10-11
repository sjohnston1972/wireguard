import { describe, it, expect, vi, afterEach } from "vitest";
import { makeEnv } from "./harness";
import type { Env } from "../src/env";
import worker from "../src/index";

// The public showcase (showcase.ts): the product films at /showcase, open to
// anyone, read-only, from their own R2 bucket. Everything else still needs
// the login.

const ctx = { waitUntil() {}, passThroughOnCancel() {} } as unknown as ExecutionContext;
const BASE = "https://wg-admin.clydeford.net";

function call(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(BASE + path, init), env, ctx) as Promise<Response>;
}

/** An R2 bucket holding the given files: get (with optional range) and head. */
function fakeBucket(files: Record<string, string>) {
  const enc = new TextEncoder();
  const obj = (key: string) => ({ key, size: enc.encode(files[key]).byteLength, httpEtag: `"etag-${key}"` });
  return {
    async get(key: string, opts?: { range?: { offset?: number; length?: number; suffix?: number } }) {
      if (!(key in files)) return null;
      const all = enc.encode(files[key]);
      let bytes = all;
      const r = opts?.range;
      if (r?.suffix !== undefined) bytes = all.slice(all.byteLength - r.suffix);
      else if (r) bytes = all.slice(r.offset ?? 0, r.length === undefined ? undefined : (r.offset ?? 0) + r.length);
      return { ...obj(key), body: new Response(bytes).body };
    },
    async head(key: string) {
      return key in files ? obj(key) : null;
    },
  } as unknown as R2Bucket;
}

const FILES = {
  "index.html": "<!doctype html><title>wg-admin Showcase</title>",
  "showcase.js": "console.log(1)",
  "films/00-hero/manifest.json": '{"duration":91}',
  "films/00-hero/chunk-000.m4s": "0123456789",
  "films/00-hero/fallback-720p.mp4": "abcdefghij",
  "films/00-hero/poster.jpg": "jpeg",
  "secret.txt": "not for you",
};

function publicEnv(withBucket = true): Env {
  // The live settings: login configured, no dev switch-off, no Access token on the request.
  const { env } = makeEnv({ AUTH_DEV_BYPASS: undefined, CF_ACCESS_TEAM_DOMAIN: "team.example", CF_ACCESS_AUD: "aud", CF_ACCESS_ALLOWED_EMAIL: "me@example.com" });
  (env as { SHOWCASE?: R2Bucket }).SHOWCASE = withBucket ? fakeBucket(FILES) : undefined;
  return env;
}

describe("public showcase", () => {
  afterEach(() => vi.restoreAllMocks());

  it("serves the page without a login, with its own tight CSP", async () => {
    const r = await call(publicEnv(), "/showcase/");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await r.text()).toContain("wg-admin Showcase");
    const csp = r.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("font-src https://fonts.gstatic.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("/showcase without the slash goes to /showcase/ (the page's links are relative)", async () => {
    const r = await call(publicEnv(), "/showcase");
    expect(r.status).toBe(301);
    expect(r.headers.get("Location")).toBe("/showcase/");
  });

  it("serves film files with the right types and caching", async () => {
    const env = publicEnv();
    const m = await call(env, "/showcase/films/00-hero/manifest.json");
    expect(m.status).toBe(200);
    expect(m.headers.get("Content-Type")).toBe("application/json");
    const c = await call(env, "/showcase/films/00-hero/chunk-000.m4s");
    expect(c.headers.get("Content-Type")).toBe("video/mp4");
    expect(c.headers.get("Accept-Ranges")).toBe("bytes");
    expect(c.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+$/);
    expect(c.headers.get("ETag")).toBe('"etag-films/00-hero/chunk-000.m4s"');
    expect(await c.text()).toBe("0123456789");
    expect((await call(env, "/showcase/films/00-hero/poster.jpg")).headers.get("Content-Type")).toBe("image/jpeg");
    expect((await call(env, "/showcase/showcase.js")).headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
  });

  it("answers byte ranges (Safari plays the fallback film only with them)", async () => {
    const env = publicEnv();
    const a = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=2-5" } });
    expect(a.status).toBe(206);
    expect(a.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(a.headers.get("Content-Length")).toBe("4");
    expect(await a.text()).toBe("cdef");
    const b = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=7-" } });
    expect(b.status).toBe(206);
    expect(b.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await b.text()).toBe("hij");
    const s = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=-3" } });
    expect(s.status).toBe(206);
    expect(s.headers.get("Content-Range")).toBe("bytes 7-9/10");
    expect(await s.text()).toBe("hij");
    const big = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=4-99" } });
    expect(big.headers.get("Content-Range")).toBe("bytes 4-9/10");
    const bad = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=20-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe("bytes */10");
    const multi = await call(env, "/showcase/films/00-hero/fallback-720p.mp4", { headers: { Range: "bytes=0-1,4-5" } });
    expect(multi.status).toBe(200);
    expect(await multi.text()).toBe("abcdefghij");
  });

  it("HEAD gives the size and no body", async () => {
    const r = await call(publicEnv(), "/showcase/films/00-hero/fallback-720p.mp4", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Length")).toBe("10");
    expect(await r.text()).toBe("");
  });

  it("serves only the showcase's own files: anything else in the bucket is a 404", async () => {
    const env = publicEnv();
    for (const p of ["/showcase/secret.txt", "/showcase/films/00-hero/other.txt", "/showcase/films/../secret.txt", "/showcase/films/00-hero/chunk-1.m4s", "/showcase/films/missing/poster.jpg"]) {
      const r = await call(env, p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("Cache-Control"), p).toBe("no-store");
    }
  });

  it("only reads: a POST still needs the login", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(publicEnv(), "/showcase/", { method: "POST", body: "x" });
    expect(r.status).toBe(401);
  });

  it("the rest of the dashboard still needs the login", async () => {
    const r = await call(publicEnv(), "/api/v1/overview");
    expect(r.status).toBe(401);
  });

  it("no bucket bound: a plain 503, never the dashboard", async () => {
    const r = await call(publicEnv(false), "/showcase/");
    expect(r.status).toBe(503);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});
