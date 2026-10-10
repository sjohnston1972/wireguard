// Labs redesign spec ruling 8, updated 2026-10-10 (Steven: "labs page should be a single page with no scrolling,
// scrolling only within the lab tiles area"). On a desktop or tablet (641 px and up) /labs is one screen: the header,
// summary, notices, running labs and toolbar take their natural height, the workspace fills the rest of #main, and only
// the tile grid scrolls (the wide details panel scrolls inside itself). The phone keeps ordinary page scrolling.
// jsdom does no layout, so these pin the stylesheet and the DOM it relies on; the shots harness (scripts/shots.mjs, the
// one-screen rule for /labs at every non-phone size) is the real check in a browser.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { labCoverageFixture } from "@/test/fixtures";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detailIdle, labs, session } from "./testData";

// Read from disk: with `css: false` (web/vitest.config.ts) a `?raw` CSS import comes back empty.
const HERE = dirname(fileURLToPath(import.meta.url));
const pageCss = readFileSync(join(HERE, "LabsPage.css"), "utf8").replace(/\r\n/g, "\n");
const panelCss = readFileSync(join(HERE, "LabDetailsPanel.css"), "utf8").replace(/\r\n/g, "\n");

vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

/** The body of the first `@media <query> { … }` block (to its closing brace at the start of a line). */
function media(css: string, query: string): string {
  const at = css.indexOf(`@media ${query} {`);
  if (at < 0) return "";
  const end = css.indexOf("\n}", at);
  return css.slice(at, end < 0 ? undefined : end);
}
/** The declarations of the first rule in `css` whose selector list includes `selector` (exact selector text). */
function rule(css: string, selector: string): string {
  const body = css.startsWith("@media") ? css.slice(css.indexOf("{") + 1) : css; // inside an @media block from media()
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((s) => s.trim());
    if (list.includes(selector)) return m[2];
  }
  return "";
}

const routes = (over: Record<string, unknown> = {}) => ({
  "GET /api/v1/labs": labs(),
  "GET /api/v1/labs/coverage": labCoverageFixture(),
  "GET /api/v1/labs/az104-06-blob-security": detailIdle(),
  ...over,
});

describe("the catalogue's stylesheet: one screen from 641 px, only the tiles scroll", () => {
  const desk = media(pageCss, "(min-width: 641px)");
  const wide = media(pageCss, "(min-width: 1200px)");

  it("tablet and wide: the page fills #main (the window less the app bar and shell banners), never a fixed height", () => {
    expect(desk).not.toBe("");
    const page = rule(desk, ".labs-page");
    expect(page).toMatch(/height:\s*100%/);
    expect(page).toMatch(/min-height:\s*0/);
    // No magic heights and no sticky columns: the page is a flex column inside #main.
    const code = pageCss.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/100dvh|100vh|var\(--bar-height\)/);
    expect(code).not.toMatch(/position:\s*sticky/);
    expect(code).not.toMatch(/(?:^|[;{\s])(?:max-)?height:\s*\d+px/m);
  });

  it("the header, summary, notices and toolbar keep their natural height; the workspace takes the rest", () => {
    expect(rule(desk, ".labs-page > *")).toMatch(/flex:\s*none/);
    const ws = rule(desk, ".labs-page > .labs-workspace");
    expect(ws).toMatch(/flex:\s*1 1 0/);
    expect(ws).toMatch(/min-height:\s*0/);
    expect(ws).toMatch(/grid-template-rows:\s*minmax\(0, 1fr\)/);
  });

  it("the tile grid is the scroll container, with room for a focused card's whole ring (2 px outline + 2 px offset)", () => {
    const main = rule(desk, ".labs-workspace > .labs-workspace__main");
    expect(main).toMatch(/overflow-y:\s*auto/);
    expect(main).toMatch(/min-height:\s*0/);
    const pad = Number(main.match(/padding:\s*(\d+)px/)?.[1]);
    expect(pad).toBeGreaterThanOrEqual(4);
    expect(main).toMatch(new RegExp(`margin:\\s*-${pad}px`));
  });

  it("tall notices or several running labs become one small scroll region instead of pushing the grid off screen", () => {
    const r = rule(desk, ".labs-page > .labs-page__alerts");
    expect(r).toMatch(/max-height:\s*\d+%/);
    expect(r).toMatch(/overflow-y:\s*auto/);
    expect(r).toMatch(/display:\s*flex/);
    // Room for a focused control's ring inside the scroller.
    const pad = Number(r.match(/padding:\s*(\d+)px/)?.[1]);
    expect(pad).toBeGreaterThanOrEqual(4);
    expect(r).toMatch(new RegExp(`margin:\\s*-${pad}px`));
    // Nothing to show: no box, so no extra gap.
    expect(rule(pageCss, ".labs-page__alerts:empty")).toMatch(/display:\s*none/);
  });

  it("each scroller is the containing block of the hidden text inside it, so that text never stretches #main", () => {
    // The cards' live region and skip link are absolutely positioned; #main is positioned (AppShell.css), so without
    // this they would sit at the bottom of the whole grid and make #main scroll.
    expect(rule(desk, ".labs-workspace > .labs-workspace__main")).toMatch(/position:\s*relative/);
    expect(rule(desk, ".labs-page > .labs-page__alerts")).toMatch(/position:\s*relative/);
    expect(rule(wide, ".labs-workspace > .labs-details")).toMatch(/position:\s*relative/);
  });

  it("wide: the details panel scrolls inside its own column, never the page", () => {
    const d = rule(wide, ".labs-workspace > .labs-details");
    expect(rule(wide, ".labs-workspace > .labs-details-skeleton")).toBe(d);
    expect(d).toMatch(/max-height:\s*100%/);
    expect(d).toMatch(/overflow-y:\s*auto/);
    // The panel's own stylesheet no longer sizes it from the window.
    const panel = rule(panelCss, ".labs-details.lab-details");
    expect(panel).not.toMatch(/100dvh|position:\s*sticky/);
  });

  it("the phone (640 px and below) is untouched: the one-screen rules start at 641 px", () => {
    expect(pageCss).not.toMatch(/@media \(max-width: 640px\)/);
    const base = pageCss.slice(0, pageCss.indexOf("@media"));
    expect(base).not.toMatch(/height:\s*100%|overflow-y/);
    // The alerts block is no box at all on the phone: its notices are the page's own rows, as before.
    expect(rule(base, ".labs-page__alerts")).toMatch(/display:\s*contents/);
  });
});

describe("the DOM the stylesheet relies on", () => {
  it("wide: the cards are inside the scrolling column, the details panel beside it, the notices and strip on the page", async () => {
    renderApp("/labs", { routes: routes({ "GET /api/v1/labs": labs({ running: [session()], orphans: [{ labId: "az104-07-file-share", names: ["rg-lab-az104-07-files"], since: "2026-10-02T10:00:00.000Z" }] }) }) });
    const panel = await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    const grid = screen.getByRole("list", { name: "Labs" });
    const scroller = grid.closest(".labs-workspace__main");
    expect(scroller).not.toBeNull();
    expect(scroller!.parentElement).toHaveClass("labs-workspace");
    expect(scroller!.parentElement!.parentElement).toHaveClass("labs-page");
    expect(scroller!.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(scroller!.parentElement);
    // The running strip and the notices are in the page's alerts block (so its cap applies).
    const alerts = screen.getByRole("region", { name: "Running labs" }).parentElement!;
    expect(alerts).toHaveClass("labs-page__alerts");
    expect(alerts.parentElement).toHaveClass("labs-page");
    expect(alerts.querySelector(".labs-notices__orphans")).not.toBeNull();
    // Keyboard: the scroller holds the focusable cards, so tabbing into it and arrowing scrolls it.
    expect(scroller!.querySelectorAll("button.lab-card__select").length).toBeGreaterThan(0);
  });

  it("selecting a lab and then scrolling the grid keeps the selection (and writes nothing)", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/labs", { routes: routes() });
    await screen.findByRole("complementary", { name: "Users, groups and a custom role" });
    await user.click(screen.getByRole("button", { name: /^Blob security/ }));
    expect(await screen.findByRole("complementary", { name: /^Blob security/ })).toBeInTheDocument();
    const navs: string[] = [];
    router.subscribe((s) => navs.push(`${s.historyAction} ${s.location.pathname}${s.location.search}`));
    const scroller = screen.getByRole("list", { name: "Labs" }).closest<HTMLElement>(".labs-workspace__main")!;
    scroller.scrollTop = 600;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: /^Blob security/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("complementary", { name: /^Blob security/ })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?lab=az104-06-blob-security");
    expect(navs).toEqual([]);
  });

  it("tablet: the grid is still the page's scrolling column (no details panel beside it)", async () => {
    setViewport(1024);
    renderApp("/labs", { routes: routes() });
    const grid = await screen.findByRole("list", { name: "Labs" });
    await screen.findByRole("button", { name: /^Blob security/ });
    expect(grid.closest(".labs-workspace__main")?.parentElement).toHaveClass("labs-workspace");
    expect(document.querySelector(".labs-workspace > .labs-details")).toBeNull();
  });
});
