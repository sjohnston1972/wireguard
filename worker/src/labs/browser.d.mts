// labs/browser.d.mts: the types of browser.mjs (kept apart so @cloudflare/puppeteer's @types/node never reaches the Worker's type checking).

/** Print `html` as an A4 PDF through Browser Rendering, `footer` on every page. */
export function renderPdf(binding: { fetch: typeof fetch }, html: string, footer: string, timeoutMs: number): Promise<Uint8Array>;
