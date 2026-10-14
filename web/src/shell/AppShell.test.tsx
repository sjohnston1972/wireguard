import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";

// Renders the whole app (shell and a real view), which can take a few seconds while every test file
// runs at once: room beyond Vitest's default 5 s, as the view folders' own suites have.
vi.setConfig({ testTimeout: 20_000 });

const TABS = ["Overview", "Clients", "Firewall", "Activity", "Cost", "Labs", "Settings"];

describe("AppShell", () => {
  it("shows the seven tabs in order in the main navigation", () => {
    renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(TABS);
  });

  it("shows the wordmark and a banner landmark", () => {
    renderApp("/");
    expect(screen.getByRole("banner")).toHaveTextContent("cloudlabs");
  });

  it.each([
    ["/", "Overview"],
    ["/clients", "Clients"],
    ["/clients/abc", "Clients"],
    ["/firewall", "Firewall"],
    ["/firewall/rules/7", "Firewall"],
    ["/activity", "Activity"],
    ["/activity/runs/run-42", "Activity"],
    ["/settings", "Settings"],
    ["/settings/profiles", "Settings"],
  ])("marks exactly the right tab as current at %s", (url, current) => {
    renderApp(url);
    // hidden: the run route opens a modal drawer, which hides the shell from the accessibility tree.
    const nav = screen.getByRole("navigation", { name: "Main", hidden: true });
    const marked = within(nav).getAllByRole("link", { current: "page", hidden: true });
    expect(marked.map((l) => l.textContent)).toEqual([current]);
  });

  it("marks the same tab in the phone tab bar", () => {
    renderApp("/firewall");
    const bar = screen.getByRole("navigation", { name: "Phone" });
    const marked = within(bar).getAllByRole("link", { current: "page" });
    expect(marked.map((l) => l.textContent)).toEqual(["Firewall"]);
  });

  it("renders the not-found placeholder with its title inside the shell", () => {
    renderApp("/nowhere");
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(main).toHaveTextContent("Built in plan 4");
  });

  it.each([
    ["/clients/1", "Clients"],
    ["/settings/profiles", "Settings"],
  ])("renders the detail route %s as its view inside the shell", async (url, title) => {
    renderApp(url);
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
  });

  it.each([
    ["/activity/runs/run-42", /Run/],
    ["/firewall/rules/7", /Allow DNS to resolver/],
  ])("renders %s as a modal drawer over the shell", async (url, drawer) => {
    renderApp(url);
    expect(await screen.findByRole("dialog", { name: drawer })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main", hidden: true })).toBeInTheDocument();
  });

  it("lets a keyboard user tab through every tab and activate one with Enter", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");

    await user.tab();
    // Skip link first, then the wordmark link, then the tabs.
    let guard = 0;
    while (document.activeElement !== links[0] && guard++ < 10) await user.tab();
    expect(links[0]).toHaveFocus();
    for (const link of links.slice(1)) {
      await user.tab();
      expect(link).toHaveFocus();
    }

    await user.keyboard("{Enter}");
    expect(within(nav).getByRole("link", { current: "page" })).toHaveTextContent("Settings");
  });

  it("offers a skip link that targets the main region", () => {
    renderApp("/");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });
});

// Between the phone (640 px and below) and the desktop the top bar once held seven tabs beside the search, state chip,
// pill, bell, theme toggle and account: at 700 px it ran 132 px past the window, at 800 px 32 px, at 900 px 86 px (the
// account and theme toggle cut off, every page scrolling sideways). Now, from 1100 px down, the search and the state
// chip are icon buttons, and from 960 px down the seven tabs move to the tab bar along the bottom, as on the phone.
describe("the top bar between the phone and the desktop", () => {
  async function css(file: string) {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8").replace(/\r\n/g, "\n");
  }
  /** The body of the first `@media (max-width: <px>px)` block in `text`. */
  function media(text: string, px: number) {
    const at = text.indexOf(`@media (max-width: ${px}px) {`);
    expect(at, `@media (max-width: ${px}px)`).toBeGreaterThan(-1);
    return text.slice(at, text.indexOf("\n}", at));
  }

  it("from 960 px down the tabs move from the top bar to the bottom tab bar", async () => {
    const shell = await css("AppShell.css");
    const block = media(shell, 960);
    expect(block).toMatch(/\.topbar__tabs\s*\{[^}]*display:\s*none/);
    expect(block).toMatch(/\.tabbar\s*\{[^}]*display:\s*flex/);
    // The phone keeps its own block for the narrower gutters, and no longer has to switch the tabs itself.
    expect(media(shell, 640)).not.toMatch(/\.topbar__tabs/);
  });

  it("toasts sit above the bottom tab bar wherever it shows", async () => {
    const toast = await css("../components/feedback/Toast.css");
    expect(media(toast, 960)).toMatch(/\.toast__viewport\s*\{[^}]*bottom:\s*calc\(var\(--tabbar-height\)/);
  });

  it("from 1100 px down the search and the state chip are icon buttons; the chip is no longer hidden on a tablet", async () => {
    const shell = await css("AppShell.css");
    const block = media(shell, 1100);
    expect(block).toMatch(/\.topbar__search-text[\s\S]*?\{[^}]*display:\s*none/);
    expect(block).toMatch(/\.topbar__search\s*\{[^}]*width:\s*32px/);
    expect(block).toMatch(/\.topbar__chip-text\s*\{[^}]*display:\s*none/);
    expect(block).toMatch(/\.topbar__chip\s*\{[^}]*width:\s*32px/);
    expect(shell).not.toContain("@media (max-width: 880px)");
    // The phone's top bar is unchanged: no chip there.
    expect(media(shell, 640)).toMatch(/\.topbar__chip\s*\{[^}]*display:\s*none/);
  });

  it("the icon-only search still says what it is and opens the command palette; Ctrl K still does", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const search = screen.getByRole("button", { name: "Search" });
    expect(search).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    await user.click(search);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("the icon-only state chip keeps its full accessible name", async () => {
    renderApp("/");
    const chip = document.querySelector(".topbar__chip");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".topbar__chip-text")).toHaveAttribute("aria-hidden", "true");
    await vi.waitFor(() => expect(chip!.textContent).toMatch(/State: .+\. Connection: .+\./));
  });

  it("the bottom tab bar carries all seven tabs and marks the current one", () => {
    renderApp("/labs");
    const bar = screen.getByRole("navigation", { name: "Phone" });
    expect(within(bar).getAllByRole("link").map((l) => l.textContent)).toEqual(TABS);
    expect(within(bar).getByRole("link", { current: "page" })).toHaveTextContent("Labs");
  });
});
