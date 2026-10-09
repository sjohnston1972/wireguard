// labs-guide.test.ts: "Download PDF" lab guides (GET /api/v1/labs/:id/guide.pdf).
// The HTML builder (labs/guide.ts) on its own; the route and its R2 cache (labs/guidepdf.ts) with a fake
// Browser Rendering (a stand-in BROWSER binding and a renderer that records what it was asked to print);
// and demo mode, which refuses the guide without touching the real bucket or the browser.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { api, base } from "./api-helpers";
import { labEnv, TEST_CATALOGUE, TEST_LABS } from "./labs-helpers";
import { setCatalogueForTest } from "../src/labs/catalogue";
import { setGuideDiagramsForTest } from "../src/labs/guidediagrams";
import { buildGuideHtml, costWords, esc, figure, guideDate, guideFooterTemplate, type GuideInput } from "../src/labs/guide";
import { GUIDE_LOCK_MS, GUIDE_LOCK_PREFIX, GUIDE_PREFIX, GuideError, guideInput, guideKey, labGuidePdf, resetGuideInflight, setGuideRendererForTest, type GuideRenderer } from "../src/labs/guidepdf";
import { GUIDE_DEMO_MESSAGE } from "../src/api/labs";
import type { Env } from "../src/env";
import type { LabCatalogue, LabDef, ReadmeBlock } from "../../shared/labs";
import type { GuideDiagrams } from "../../shared/guides";

const LAB = "az104-06-blob-security";
const GEN = "2026-10-09T08:30:00.000Z";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const FAKE_PDF = new TextEncoder().encode("%PDF-1.7\n% a fake guide\n%%EOF\n");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#08f"/><text x="1" y="8">vnet-lab</text></svg>`;

/** Lab 6 as a break-fix lab with a readme that has every block kind, a hostile title and a link that is not https. */
const README: ReadmeBlock[] = [
  { t: "p", inlines: [{ t: "text", text: "A storage account behind a private endpoint. " }, { t: "b", text: "Bold" }, { t: "text", text: " and " }, { t: "code", text: "<code>" }] },
  { t: "h", level: 2, text: "What it deploys" },
  { t: "ul", items: [[{ t: "text", text: "A storage account, " }, { t: "code", text: "stlab" }]] },
  { t: "code", lang: "text", text: "rg-lab-<id>\n  vnet-lab -> pe-blob" },
  { t: "h", level: 2, text: "Symptom" },
  { t: "p", inlines: [{ t: "text", text: "The blob cannot be read." }] },
  { t: "details", summary: "What was broken", blocks: [{ t: "p", inlines: [{ t: "text", text: "THE-ANSWER: the private DNS zone is not linked." }] }] },
  { t: "h", level: 2, text: "Things to try" },
  { t: "ul", items: [[{ t: "text", text: "Resolve the account name from the VM." }], [{ t: "a", text: "A bad link", href: "javascript:alert(1)" }]] },
  { t: "h", level: 2, text: "Learn more" },
  { t: "ul", items: [[{ t: "a", text: "Private endpoints", href: "https://learn.microsoft.com/azure/private-link/private-endpoint-overview" }]] },
  { t: "p", inlines: [{ t: "text", text: "Anything you build by hand inside rg-lab-az104-06-blob-security is removed at tear-down." }] },
];
const DEF: LabDef = { ...TEST_LABS[2]!, type: "break-fix", title: `Blob <script>alert("x")</script> & security` };
const CATALOGUE: LabCatalogue = {
  ...TEST_CATALOGUE,
  labs: TEST_LABS.map((l) => (l.id === LAB ? DEF : l)),
  readmes: { ...TEST_CATALOGUE.readmes, [LAB]: README },
};
const DIAGRAMS: GuideDiagrams = {
  schema: 1,
  labs: {
    [LAB]: [
      { file: "architecture.svg", title: "Architecture: blob behind a private endpoint", kind: "architecture", svg: SVG },
      { file: "1.svg", title: "How private DNS resolves the account", kind: "concept", svg: SVG },
      { file: "2.svg", title: "SAS token scopes", kind: "concept", svg: null },
    ],
  },
};

function input(over: Partial<GuideInput> = {}): GuideInput {
  return {
    def: DEF,
    readme: README,
    learning: CATALOGUE.learning[LAB]!,
    diagrams: DIAGRAMS.labs[LAB]!,
    skillAreaNames: { "az104.storage": "Implement and manage storage" },
    gbpH: 0.0077,
    ...over,
  };
}

/** The text between two markers of the HTML (the end marker optional). */
const between = (html: string, from: string, to?: string) => {
  const a = html.indexOf(from);
  const b = to ? html.indexOf(to, a + from.length) : html.length;
  return a === -1 ? "" : html.slice(a, b === -1 ? html.length : b);
};

// ── The HTML ─────────────────────────────────────────────────────────────

describe("buildGuideHtml: what the guide holds", () => {
  const html = buildGuideHtml(input(), GEN);

  it("has the title, id, exams, level, type, cost per hour, learning, deploy and session times", () => {
    expect(html).toContain("<h1>Blob &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; security</h1>");
    expect(html).toContain(`<code>${LAB}</code>`);
    expect(html).toMatch(/Lab 6 · AZ-104 · Associate · Break-fix/);
    expect(html).toContain("£0.0077 per hour");
    expect(html).toContain("about £0.02 for a 2 h session");
    expect(html).toContain("Learning time</span><span class=\"v\">50 min");
    expect(html).toContain("Deploy time</span><span class=\"v\">about 4 min");
    expect(html).toContain("Session</span><span class=\"v\">2 h</span><span class=\"s\">extendable to 6 h");
    expect(html).toContain("Skill areas: Implement and manage storage");
  });

  it("has the objective and what you will learn (from labs/_learning)", () => {
    const l = CATALOGUE.learning[LAB]!;
    expect(html).toContain(esc(l.objective));
    for (const item of l.learn) expect(html).toContain(`<li>${esc(item)}</li>`);
    expect(html).toContain("<h2>What you will learn</h2>");
  });

  it("without learning content it shows the summary instead", () => {
    const h = buildGuideHtml(input({ learning: null }), GEN);
    expect(h).toContain("About this lab");
    expect(h).not.toContain("What you will learn");
    expect(h).toContain("Learning time</span><span class=\"v\">Not set");
  });

  it("has the readme's sections in order, with its code block", () => {
    const order = ["What it deploys", "Symptom", "Things to try", "Learn more"].map((h) => html.indexOf(`<h2>${h}</h2>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The readme's opening words sit under their own heading, after What you will learn.
    const overview = html.indexOf("<h2>Overview</h2>");
    expect(overview).toBeGreaterThan(html.indexOf("<h2>What you will learn</h2>"));
    expect(overview).toBeLessThan(html.indexOf("A storage account behind a private endpoint."));
    expect(html.match(/<h2>Overview<\/h2>/g)).toHaveLength(1);
    expect(html).toContain("<pre><code>rg-lab-&lt;id&gt;\n  vnet-lab -&gt; pe-blob</code></pre>");
    expect(html).toContain("<code>&lt;code&gt;</code>");
  });

  it("escapes everything: no markup from the catalogue ever reaches the page", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("javascript:");
    expect(esc(`<a href="x" onclick='y'>&`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
  });

  it("makes https links clickable and shows Learn more addresses; a link that is not https is plain text", () => {
    const href = "https://learn.microsoft.com/azure/private-link/private-endpoint-overview";
    expect(html).toContain(`<a href="${href}">Private endpoints</a><span class="url">${href}</span>`);
    expect(html).toContain("<li>A bad link</li>");
    // Only <a> carries an address: nothing for the browser to fetch.
    expect(html.match(/\s(src|href)="(?!data:|https:\/\/learn\.microsoft\.com)/g)).toBeNull();
  });

  it("keeps the break-fix answer out of the body and puts it on a final Answers page", () => {
    const body = between(html, "<main>", "</main>");
    expect(body).not.toContain("THE-ANSWER");
    expect(body).toContain("The answer is on the last page");
    const answers = between(html, '<section class="answers">', "</section>");
    expect(answers).toContain("<h2>Answers</h2>");
    expect(answers).toContain("gives the break-fix fault away");
    expect(answers).toContain("THE-ANSWER: the private DNS zone is not linked.");
    expect(html).toMatch(/\.answers \{ break-before: page;/);
    expect(html.indexOf('<section class="answers">')).toBeGreaterThan(html.indexOf("</main>"));
  });

  it("an explore lab has no Answers page", () => {
    const h = buildGuideHtml(input({ readme: README.filter((b) => b.t !== "details"), def: { ...DEF, type: "explore" } }), GEN);
    expect(h).not.toContain('class="answers"');
    expect(h).not.toContain("The answer is on the last page");
  });

  it("places the architecture diagram after What it deploys and concepts before Learn more, as images", () => {
    const deploys = between(html, "<h2>What it deploys</h2>", "<h2>Symptom</h2>");
    expect(deploys).toContain("Architecture: blob behind a private endpoint");
    const beforeLearn = between(html, "<h2>Things to try</h2>", "<h2>Learn more</h2>");
    expect(beforeLearn).toContain("<h2>Concepts</h2>");
    expect(beforeLearn).toContain("How private DNS resolves the account");
    // Embedded as data: images, never inline SVG (an SVG can then neither run nor fetch anything).
    expect(html).not.toContain("<svg");
    expect(html).toContain(`src="data:image/svg+xml;base64,${Buffer.from(SVG, "utf8").toString("base64")}"`);
  });

  it("a diagram whose file is missing shows 'Diagram unavailable' with its title", () => {
    expect(html).toContain("Diagram unavailable</div><figcaption>SAS token scopes</figcaption>");
    expect(figure({ file: "1.svg", title: "<x>", kind: "concept", svg: null })).toContain("<figcaption>&lt;x&gt;</figcaption>");
  });

  it("with no diagrams yet there are no figures at all", () => {
    const h = buildGuideHtml(input({ diagrams: [] }), GEN);
    expect(h).not.toContain("<figure");
    expect(h).not.toContain("<h2>Concepts</h2>");
  });

  it("diagrams still appear when the readme has neither What it deploys nor Learn more", () => {
    const h = buildGuideHtml(input({ readme: [{ t: "p", inlines: [{ t: "text", text: "Only words." }] }] }), GEN);
    expect(h.match(/<figure/g)).toHaveLength(3);
  });

  it("ends with the lab version and the date it was made; the page footer has them and the page numbers", () => {
    expect(html).toContain(`${LAB} · lab version 1 · guide generated 9 October 2026`);
    const f = guideFooterTemplate(DEF, GEN);
    expect(f).toContain(`${LAB} · v1 · generated 9 October 2026`);
    expect(f).toContain('<span class="pageNumber"></span> of <span class="totalPages"></span>');
    expect(guideDate("not a date")).toBe("");
  });

  it("cost words: none, zero, a sliver and pounds", () => {
    expect(costWords(null, 2)).toEqual({ main: "Estimate unavailable", sub: null });
    expect(costWords(0, 2)).toEqual({ main: "No hourly charge at list price", sub: null });
    expect(costWords(0.00001, 2).main).toBe("under £0.0001 per hour");
    expect(costWords(0.42, 3)).toEqual({ main: "£0.42 per hour", sub: "about £1.26 for a 3 h session" });
  });

  it("is a print page: A4, no app chrome, nothing fetched", () => {
    expect(html).toContain("@page { size: A4;");
    expect(html).not.toMatch(/<link|<iframe|@import|url\(/i);
  });
});

describe("guideKey: the cache key", () => {
  it("is lab-guides/<id>/v<version>-<hash>.pdf and ignores the date", async () => {
    const k = await guideKey(input());
    expect(k).toMatch(new RegExp(`^lab-guides/${LAB}/v1-[0-9a-f]{16}\\.pdf$`));
    expect(await guideKey(input())).toBe(k);
  });

  it("changes with the version, the readme, a diagram and the cost words; not with a price change too small to show", async () => {
    const k = await guideKey(input());
    expect(await guideKey(input({ def: { ...DEF, version: 2 } }))).toMatch(/\/v2-/);
    expect(await guideKey(input({ readme: README.slice(1) }))).not.toBe(k);
    expect(await guideKey(input({ diagrams: [] }))).not.toBe(k);
    expect(await guideKey(input({ gbpH: 0.5 }))).not.toBe(k);
    expect(await guideKey(input({ gbpH: 0.00771 }))).toBe(k);
  });
});

// ── The route ────────────────────────────────────────────────────────────

const fakeBrowser = { fetch: async () => new Response("not a real browser", { status: 500 }) } as unknown as Fetcher;
const SECRETS = { AZURE_CLIENT_SECRET: "SECRET-azure-client-9f3", GITHUB_TOKEN: "SECRET-github-7c1", CF_ACCESS_AUD: "SECRET-aud-55", VAPID_PRIVATE_KEY: "SECRET-vapid-2b" };

interface Fake {
  calls: { browser: Fetcher; html: string; footer: string; timeoutMs: number }[];
  next: () => Promise<Uint8Array>;
}
function fakeRenderer(): Fake {
  const f: Fake = { calls: [], next: async () => FAKE_PDF };
  const r: GuideRenderer = (browser, html, footer, timeoutMs) => {
    f.calls.push({ browser, html, footer, timeoutMs });
    return f.next();
  };
  setGuideRendererForTest(r);
  return f;
}

async function guideEnv(over: Partial<Env> = {}) {
  const r = await labEnv({ BROWSER: fakeBrowser, ...SECRETS, ...over });
  setCatalogueForTest(CATALOGUE);
  setGuideDiagramsForTest(DIAGRAMS);
  return r;
}

async function getPdf(env: Env, id = LAB, method = "GET") {
  const res = await worker.fetch(new Request(`${base}/api/v1/labs/${id}/guide.pdf`, { method, headers: { "Sec-Fetch-Site": "same-origin" } }), env, ctx);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

const guideKeys = async (env: Env) => (await env.STATE.list({ prefix: GUIDE_PREFIX })).objects.map((o) => o.key);

beforeEach(() => {
  resetGuideInflight();
});
afterEach(() => {
  setGuideRendererForTest(null);
  setGuideDiagramsForTest(null);
  setCatalogueForTest(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GET /labs/:id/guide.pdf", () => {
  it("404 for a lab outside the catalogue, before anything is drawn", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    const r = await api(env, "GET", "/labs/az104-99-nope/guide.pdf");
    expect(r.status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });

  it("first time: draws it once with Browser Rendering, stores it in R2 and answers it as a download", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    const { res, bytes } = await getPdf(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="${LAB} guide.pdf"; filename*=UTF-8''${encodeURIComponent(`${LAB} guide.pdf`)}`);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-WG-Guide")).toBe("made");
    expect(res.headers.get("X-WG-Data")).toBe("real");
    expect(bytes).toEqual(FAKE_PDF);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.browser).toBe(fakeBrowser);
    expect(f.calls[0]!.html).toContain("<h1>Blob &lt;script&gt;");
    expect(f.calls[0]!.footer).toContain("pageNumber");
    const keys = await guideKeys(env);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^lab-guides/${LAB}/v1-[0-9a-f]{16}\\.pdf$`));
    const stored = await env.STATE.get(keys[0]!);
    expect((stored as unknown as { customMetadata: Record<string, string> }).customMetadata).toMatchObject({ labId: LAB, version: "1" });
  });

  it("the guide holds no secret, setting or session: only the catalogue's words", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    await getPdf(env);
    const all = f.calls[0]!.html + f.calls[0]!.footer;
    for (const v of Object.values(SECRETS)) expect(all).not.toContain(v);
    for (const v of ["localhost", "wg.clydeford.net", "rg-wg-ondemand", "10.13.13.0", "sub"]) expect(all.includes(v), v).toBe(v === "sub" ? all.includes("sub") : false);
    expect(all).not.toMatch(/subscriptions\//);
  });

  it("second time: from R2, never drawn again", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    await getPdf(env);
    const { res, bytes } = await getPdf(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-WG-Guide")).toBe("cached");
    expect(bytes).toEqual(FAKE_PDF);
    expect(f.calls).toHaveLength(1);
  });

  it("a new lab version makes a new PDF and the old one is deleted", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    const first = await labGuidePdf(env, DEF);
    const later: Promise<unknown>[] = [];
    const v2 = await labGuidePdf(env, { ...DEF, version: 2 }, { waitUntil: (p) => later.push(p) });
    await Promise.all(later);
    expect(f.calls).toHaveLength(2);
    expect(v2.key).toMatch(/\/v2-/);
    expect(await guideKeys(env)).toEqual([v2.key]);
    expect(first.key).not.toBe(v2.key);
  });

  it("many at once: one render, everyone gets the same PDF (no stampede)", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    let release!: () => void;
    f.next = () => new Promise((r) => (release = () => r(FAKE_PDF)));
    const all = Promise.all([getPdf(env), getPdf(env), getPdf(env)]);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    release();
    const answers = await all;
    expect(answers.map((a) => a.res.status)).toEqual([200, 200, 200]);
    expect(f.calls).toHaveLength(1);
    for (const a of answers) expect(a.bytes).toEqual(FAKE_PDF);
    // The lock is gone once the PDF is stored.
    expect((await env.STATE.list({ prefix: GUIDE_LOCK_PREFIX })).objects).toEqual([]);
  });

  it("another isolate's render (a fresh lock): waits for its PDF instead of drawing a second", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    const g = await guideInput(env, DEF, Date.now());
    const key = await guideKey(g);
    await env.STATE.put(`${GUIDE_LOCK_PREFIX}${LAB}.json`, JSON.stringify({ token: "other", at: Date.now() }));
    let polls = 0;
    const sleep = async () => {
      polls++;
      if (polls === 2) await env.STATE.put(key, FAKE_PDF.buffer.slice(0) as ArrayBuffer, { customMetadata: { generatedAt: GEN } });
    };
    const pdf = await labGuidePdf(env, DEF, { sleep });
    expect(pdf.cached).toBe(true);
    expect(pdf.generatedAt).toBe(GEN);
    expect(f.calls).toHaveLength(0);
  });

  it("another isolate still drawing after the wait: 503 guide_busy with Retry-After", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    let t = Date.now();
    await env.STATE.put(`${GUIDE_LOCK_PREFIX}${LAB}.json`, JSON.stringify({ token: "other", at: t }));
    const err = await labGuidePdf(env, DEF, { now: () => t, sleep: async (ms) => void (t += ms) }).catch((e) => e);
    expect(err).toBeInstanceOf(GuideError);
    expect(err.code).toBe("guide_busy");
    expect(err.retryAfter).toBe(10);
    expect(f.calls).toHaveLength(0);
  });

  it("a stale lock (a render that died) is ignored", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    await env.STATE.put(`${GUIDE_LOCK_PREFIX}${LAB}.json`, JSON.stringify({ token: "dead", at: Date.now() - GUIDE_LOCK_MS - 1 }));
    const { res } = await getPdf(env);
    expect(res.status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("no BROWSER binding: 503 guide_unavailable that names Browser Rendering; nothing stored", async () => {
    const { env } = await guideEnv({ BROWSER: undefined });
    const f = fakeRenderer();
    const r = await api(env, "GET", `/labs/${LAB}/guide.pdf`);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("guide_unavailable");
    expect(r.json.error.message).toMatch(/Browser Rendering/);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(f.calls).toHaveLength(0);
    expect(await guideKeys(env)).toEqual([]);
  });

  it("Browser Rendering refuses (not enabled): 503 guide_unavailable saying what to check; the lock is released", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    f.next = async () => {
      throw new Error("Unable to create new browser: code: 403: message: Browser Rendering is not enabled for this account");
    };
    const r = await api(env, "GET", `/labs/${LAB}/guide.pdf`);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("guide_unavailable");
    expect(r.json.error.message).toMatch(/not enabled for this account.*Check that Browser Rendering is enabled/);
    expect(await guideKeys(env)).toEqual([]);
    // Next time it tries again (nothing cached, no lock left).
    f.next = async () => FAKE_PDF;
    expect((await getPdf(env)).res.status).toBe(200);
  });

  it("Browser Rendering over its limits (429): 503 guide_busy with Retry-After", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    f.next = async () => {
      throw new Error("Unable to create new browser: code: 429: message: Too many browsers already running");
    };
    const r = await api(env, "GET", `/labs/${LAB}/guide.pdf`);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("guide_busy");
    expect(r.headers.get("Retry-After")).toBe("60");
  });

  it("a render that hangs: 504 guide_timeout after the time limit", async () => {
    const { env } = await guideEnv();
    const f = fakeRenderer();
    f.next = () => new Promise(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = labGuidePdf(env, DEF).catch((e) => e);
    // Until the render has started (its time limit is set then); setImmediate is not faked.
    while (f.calls.length === 0) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(46_000);
    const err = await p;
    expect(err).toBeInstanceOf(GuideError);
    expect(err.status).toBe(504);
    expect(err.code).toBe("guide_timeout");
    expect(f.calls[0]!.timeoutMs).toBeLessThan(45_000);
  });
});

describe("wiring", () => {
  it("wrangler.toml binds Browser Rendering as BROWSER", async () => {
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/^\[browser\]\r?\nbinding = "BROWSER"$/m);
  });
});

// ── Demo mode ────────────────────────────────────────────────────────────

describe("GET /labs/:id/guide.pdf in demo mode", () => {
  it("409 not_in_demo from the demo store: no browser, no real R2 read or write", async () => {
    const { env } = await guideEnv();
    setCatalogueForTest(null);
    const id = "az104-13-vnets";
    // A real guide already cached: demo mode still does not serve it (the demo never reaches the real bucket).
    setGuideRendererForTest(async () => FAKE_PDF);
    expect((await getPdf(env, id)).res.status).toBe(200);
    const before = await guideKeys(env);
    expect(before).toHaveLength(1);
    const f = fakeRenderer();
    const get = vi.spyOn(env.STATE, "get");
    expect((await api(env, "PUT", "/demo", { on: true })).status).toBe(200);
    for (const method of ["GET", "HEAD"]) {
      const { res } = await getPdf(env, id, method);
      expect(res.status, method).toBe(409);
      expect(res.headers.get("X-WG-Data")).toBe("demo");
      expect(res.headers.get("Content-Type")).not.toMatch(/pdf/);
    }
    const r = await api(env, "GET", `/labs/${id}/guide.pdf`);
    expect(r.json.error).toEqual({ code: "not_in_demo", message: GUIDE_DEMO_MESSAGE });
    expect(f.calls).toHaveLength(0);
    expect(get.mock.calls.filter(([k]) => String(k).startsWith(GUIDE_PREFIX))).toEqual([]);
    expect(await guideKeys(env)).toEqual(before);
  });
});
