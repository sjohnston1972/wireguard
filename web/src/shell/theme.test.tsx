import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applyStoredTheme, setTheme, storedTheme } from "./theme";
import { ThemeToggleSlot } from "./slots";
import { renderApp } from "@/test/render";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

describe("theme", () => {
  it("applies a stored choice to the page", () => {
    localStorage.setItem("wg-admin-theme", "light");
    applyStoredTheme();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("ignores junk in storage", () => {
    localStorage.setItem("wg-admin-theme", "purple");
    expect(storedTheme()).toBeNull();
  });

  it("still applies the theme when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setTheme("light")).not.toThrow();
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("the toggle switches theme and is reachable by keyboard", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const user = userEvent.setup();
    render(<ThemeToggleSlot />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });

  it("switching from the account menu updates the top-bar toggle (one shared theme)", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const user = userEvent.setup();
    // The theme lives in the shell: a page with nothing in it keeps the test about the shell
    // (the Overview, re-rendering as its queries land, made every click slow under load).
    renderApp("/nowhere");
    const bar = screen.getAllByRole("banner")[0];
    expect(within(bar).getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    await user.click(await within(bar).findByRole("button", { name: /Account menu/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Switch to light theme/ }));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(within(bar).getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();

    // And the other way: the top-bar toggle updates the menu's item.
    await user.click(within(bar).getByRole("button", { name: "Switch to dark theme" }));
    await user.click(within(bar).getByRole("button", { name: /Account menu/ }));
    expect(await screen.findByRole("menuitem", { name: /Switch to light theme/ })).toBeInTheDocument();
  });

  it("follows the data-theme attribute however it changes", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    render(<ThemeToggleSlot />);
    act(() => setTheme("light"));
    expect(await screen.findByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });
});
