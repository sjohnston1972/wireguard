import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { activityRoutes } from "./testkit";

vi.setConfig({ testTimeout: 20_000 });

// One-screen rule at the boundary (1100 x 600): the runs table is the list
// that matters. The bottom row (Run details, Live output) repeats what the
// run drawer shows, so on a short window it gives its height to the table.
describe("activity on a short desktop window", () => {
  it("leaves Run details and Live output to the run drawer, so the table gets the room", async () => {
    setViewport([1100, 600]);
    renderApp("/activity", { routes: activityRoutes() });
    expect(await screen.findByRole("table", { name: "Runs" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Run details/ })).toBeNull();
    expect(screen.queryByRole("region", { name: /Live output/ })).toBeNull();
  });

  it("a tall window keeps them under the table", async () => {
    setViewport([1600, 900]);
    renderApp("/activity", { routes: activityRoutes() });
    expect(await screen.findByRole("region", { name: /Run details/ })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Live output/ })).toBeInTheDocument();
  });
});

// At 641 px the right-hand KPI tile's "↑ 20 pts vs previous period" ran 6 px past the page, so the page scrolled
// sideways. A change too long for its tile is cut with an ellipsis inside its pill (screen readers still read it all).
describe("activity KPI tiles on a narrow tablet", () => {
  it("a long change is cut inside its pill, never pushing the page wider", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "activity.css"), "utf8").replace(/\r\n/g, "\n");
    const rules = (sel: string) => [...css.matchAll(new RegExp(`${sel.replace(/[.>]/g, (c) => `\\${c}`)}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(";");
    expect(rules(".act__kpis .tile__delta")).toMatch(/overflow:\s*hidden/);
    const text = rules(".act__kpis .tile__delta > span:last-child");
    expect(text).toMatch(/min-width:\s*0/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
  });
});
