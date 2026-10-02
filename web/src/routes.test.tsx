import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "@/test/render";

// Old dashboard addresses that bookmarks and the installed app may still open.
// The whole app renders, as in the view suites, so the limit is theirs.
describe("old page paths", { timeout: 20_000 }, () => {
  it("/peers lands on Clients", async () => {
    renderApp("/peers");
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Clients" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "location", hidden: true })).toHaveTextContent(/^\/clients$/);
  });
});
