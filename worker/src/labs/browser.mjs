// labs/browser.mjs
//
// Plain English: the one place the Worker drives Cloudflare Browser Rendering
// (binding BROWSER, wrangler.toml [browser]) through @cloudflare/puppeteer: it
// opens a browser, puts the lab guide's HTML in a page and prints it as an
// A4 PDF with a footer on every page. labs/guidepdf.ts imports it only when a
// PDF is really made (tests swap the renderer, so they never load puppeteer).
//
// Plain JavaScript with its types in browser.d.mts: @cloudflare/puppeteer's own
// type file pulls in @types/node, whose globals would leak into the Worker's
// type checking (see node-async-hooks.d.ts).

import puppeteer from "@cloudflare/puppeteer";

/**
 * @param {{ fetch: typeof fetch }} binding  env.BROWSER
 * @param {string} html     a self-contained page (no scripts, nothing to fetch)
 * @param {string} footer   puppeteer's footerTemplate
 * @param {number} timeoutMs  for loading the page and for printing it
 * @returns {Promise<Uint8Array>}
 */
export async function renderPdf(binding, html, footer, timeoutMs) {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: footer,
      margin: { top: "16mm", right: "16mm", bottom: "18mm", left: "16mm" },
      timeout: timeoutMs,
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
