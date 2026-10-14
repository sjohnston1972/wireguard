import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The AWS orange accent (#123): the override blocks set the five accent tokens and the dark-text
// token in all three theme cases, and filled controls take their text from --on-fill.
const src = [join(process.cwd(), "web/src"), join(process.cwd(), "src")].find((p) => existsSync(join(p, "styles/tokens.css")))!;
const read = (p: string) => readFileSync(join(src, p), "utf8");
const body = (css: string, selector: string) => {
  const i = css.indexOf(selector + " {");
  if (i < 0) throw new Error(`no ${selector} block`);
  const start = css.indexOf("{", i) + 1;
  return css.slice(start, css.indexOf("}", start));
};
const want = (b: string, pairs: Record<string, string>) => {
  for (const [k, v] of Object.entries(pairs)) expect(b).toMatch(new RegExp(String.raw`(^|\s)${k}:\s*${v};`, "i"));
};
const dark = { "--blue": "#ff9900", "--blue-bright": "#ffac31", "--blue-fill": "#ff9900", "--blue-fill-hover": "#ffac31", "--amber": "#facc15", "--on-fill": "#16191f" };
const light = { "--blue": "#c45500", "--blue-bright": "#a84700", "--blue-fill": "#ff9900", "--blue-fill-hover": "#ec7211", "--amber": "#a16207", "--on-fill": "#16191f" };

describe("AWS accent tokens", () => {
  const themes = read("styles/themes.css");
  it("dark AWS", () => want(body(read("styles/tokens.css"), ':root[data-cloud="aws"]'), dark));
  it("light chosen", () => want(body(themes, ':root[data-theme="light"][data-cloud="aws"]'), light));
  it("light by OS", () => want(body(themes, ':root[data-cloud="aws"]:not([data-theme="dark"])'), light));
  it("--on-fill is white by default", () => expect(body(read("styles/tokens.css"), ":root")).toMatch(/--on-fill:\s*#fff;/));
});

describe("text on filled controls", () => {
  it("the primary button uses --on-fill", () => expect(read("components/forms/Button.css")).toMatch(/\.btn--primary\s*\{[^}]*color:\s*var\(--on-fill\)/));
});
