import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// WCAG contrast of the design tokens, read straight from tokens.css (dark) and
// themes.css (light), plus a scan of the component CSS for the pairs that
// matter: white on the primary fill, "no data" text, disabled controls.

// jsdom gives import.meta.url an http: scheme, so find the folder from the working directory (repo root or web/).
const here = [join(process.cwd(), "web/src/styles"), join(process.cwd(), "src/styles")].find((p) => existsSync(join(p, "tokens.css")))!;
const src = join(here, "..");
const read = (p: string) => readFileSync(join(here, p), "utf8");

function block(css: string, selector: string): string {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error(`no ${selector} block`);
  const start = css.indexOf("{", i) + 1;
  return css.slice(start, css.indexOf("}", start));
}

function vars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const dark = vars(block(read("tokens.css"), ":root"));
const themes = read("themes.css");
const light = { ...dark, ...vars(block(themes, ':root[data-theme="light"]')) };
const lightByOs = { ...dark, ...vars(block(themes, ':root:not([data-theme="dark"])')) };

function lum(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const THEMES = { dark, light } as const;
const tok = (t: Record<string, string>, name: string) => {
  const v = t[name];
  if (!v) throw new Error(`missing token ${name}`);
  return v;
};

describe("token contrast", () => {
  it("the OS light theme and the chosen light theme define the same values", () => {
    expect(lightByOs).toEqual(light);
  });

  for (const [name, t] of Object.entries(THEMES)) {
    it(`${name}: white text on the primary fill (and its hover) is at least 4.5:1`, () => {
      expect(contrast("#ffffff", tok(t, "--blue-fill"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast("#ffffff", tok(t, "--blue-fill-hover"))).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: --text-secondary (used for "no data") is at least 4.5:1 on every surface`, () => {
      for (const bg of ["--bg-app", "--bg-bar", "--bg-panel", "--bg-tile", "--bg-elevated"]) {
        expect(contrast(tok(t, "--text-secondary"), tok(t, bg)), `${name} --text-secondary on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: the six series colours (a diagram's lines, by source) are at least 3:1 on every surface and differ from each other`, () => {
      const series = [1, 2, 3, 4, 5, 6].map((i) => tok(t, `--series-${i}`));
      for (const [i, c] of series.entries())
        for (const bg of ["--bg-app", "--bg-panel", "--bg-tile", "--bg-elevated"]) expect(contrast(c, tok(t, bg)), `${name} --series-${i + 1} on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(new Set(series).size).toBe(6);
    });

    it(`${name}: a lab diagram's resource-group and Global / Tenant lane outlines (--group-outline) are at least 3:1 on every canvas surface`, () => {
      // Non-text contrast (WCAG 1.4.11): the canvas sits on the app, a panel, a tile (the mini) or an elevated surface.
      for (const bg of ["--bg-app", "--bg-panel", "--bg-tile", "--bg-elevated"]) {
        expect(contrast(tok(t, "--group-outline"), tok(t, bg)), `${name} --group-outline on ${bg}`).toBeGreaterThanOrEqual(3);
      }
      // Quieter than the VNet's Azure blue, so the hierarchy (group, then VNet, then subnet) still reads.
      expect(tok(t, "--group-outline")).not.toBe(tok(t, "--blue"));
    });

    it(`${name}: disabled controls are legible, at least 3:1 against their fill and the surfaces they sit on`, () => {
      for (const bg of ["--disabled-bg", "--bg-panel", "--bg-tile", "--bg-app", "--bg-bar"]) {
        expect(contrast(tok(t, "--disabled-fg"), tok(t, bg)), `${name} --disabled-fg on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith(".css") ? [p] : [];
  });
}
const rules = cssFiles(src).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, sel: m[1]!.trim(), body: m[2]! })));

describe("component CSS uses the checked pairs", () => {
  it('"no data" text uses --text-secondary, not --text-muted', () => {
    const nodata = rules.filter((r) => /nodata|__empty\b|__value--none\b/.test(r.sel) && /(^|;|\s)color\s*:/.test(r.body));
    expect(nodata.length).toBeGreaterThan(4);
    for (const r of nodata) expect(r.body, `${r.file} ${r.sel}`).not.toMatch(/color\s*:\s*var\(--text-muted\)/);
  });

  it("lab diagram outlines: resource groups dashed and lanes solid, both at least 1.5px in --group-outline; VNets stay Azure blue, subnets lighter", () => {
    const rule = (sel: string) => {
      const r = rules.find((x) => x.sel === sel && /topology\.css$/.test(x.file));
      if (!r) throw new Error(`no ${sel} rule in topology.css`);
      return r.body;
    };
    const width = (body: string, prop = "border") => Number(body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([\\d.]+)px`))?.[1] ?? 0);
    const rg = rule(".topo-group--resourceGroup");
    expect(rg).toMatch(/border\s*:\s*[\d.]+px dashed var\(--group-outline\)/);
    expect(width(rg)).toBeGreaterThanOrEqual(1.5);
    const lane = rule(".topo-group--lane");
    expect(lane).toMatch(/border\s*:\s*[\d.]+px solid var\(--group-outline\)/);
    expect(width(lane)).toBeGreaterThanOrEqual(1.5);
    expect(lane).toMatch(/border-top\s*:\s*3px solid var\(--group-outline\)/);
    expect(rule(".topo-group--vnet")).toMatch(/border\s*:\s*[\d.]+px solid var\(--topo-azure\)/);
    expect(rule(".topo-group--subnet")).toMatch(/border\s*:\s*1px solid var\(--topo-subnet-border\)/);
  });

  it("white text never sits on plain --blue (it uses --blue-fill)", () => {
    for (const r of rules) {
      if (/color\s*:\s*#fff\b/i.test(r.body)) expect(r.body, `${r.file} ${r.sel}`).not.toMatch(/background\s*:\s*var\(--blue(-bright)?\)/);
    }
  });

  it("disabled buttons, icon buttons, selects and switches use the disabled tokens, not a fade", () => {
    const disabled = rules.filter((r) => /:disabled/.test(r.sel) && !/:not\(:disabled\)/.test(r.sel));
    expect(disabled.length).toBeGreaterThanOrEqual(4);
    for (const r of disabled) {
      expect(r.body, `${r.file} ${r.sel}`).not.toMatch(/opacity\s*:\s*0?\.\d/);
      expect(r.body, `${r.file} ${r.sel}`).toMatch(/var\(--disabled-fg\)/);
    }
  });
});
