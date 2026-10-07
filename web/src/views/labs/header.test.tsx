// Labs redesign plan B1: the page header (spec §4 item 1).
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { labCoverageFixture } from "@/test/fixtures";
import { labs } from "./testData";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const routes = () => ({ "GET /api/v1/labs": labs(), "GET /api/v1/labs/coverage": labCoverageFixture(), "GET /api/v1/labs/sessions": { sessions: [] } });

describe("the labs header", () => {
  it("the page is titled Azure Labs with the description", async () => {
    renderApp("/labs", { routes: routes() });
    const main = within(screen.getByRole("main"));
    expect(await main.findByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    expect(main.getByText("Hands-on AZ-104, AZ-305 and AZ-700 environments: pick a lab, deploy it, learn by doing.")).toBeInTheDocument();
    // The old header's capacity text moved to the summary strip.
    expect(main.queryByText(/slots$/)).toBeNull();
  });

  it("Catalogue and Your labs are links with aria-current on the current one", async () => {
    renderApp("/labs", { routes: routes() });
    const nav = within(await screen.findByRole("navigation", { name: "Labs pages" }));
    const links = nav.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Catalogue", "Your labs"]);
    expect(nav.getByRole("link", { name: "Catalogue" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Catalogue" })).toHaveAttribute("href", "/labs");
    expect(nav.getByRole("link", { name: "Your labs" })).not.toHaveAttribute("aria-current");
    expect(nav.getByRole("link", { name: "Your labs" })).toHaveAttribute("href", "/labs/history");
  });

  it("/labs/history uses the same header", async () => {
    renderApp("/labs/history", { routes: routes() });
    const main = within(screen.getByRole("main"));
    expect(await main.findByRole("heading", { level: 1, name: "Azure Labs" })).toBeInTheDocument();
    const nav = within(main.getByRole("navigation", { name: "Labs pages" }));
    expect(nav.getByRole("link", { name: "Your labs" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Catalogue" })).not.toHaveAttribute("aria-current");
  });
});
