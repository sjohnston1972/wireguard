import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { applyStoredTheme, setTheme, storedTheme } from "./theme";
import { ThemeToggleSlot } from "./slots";

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
});
