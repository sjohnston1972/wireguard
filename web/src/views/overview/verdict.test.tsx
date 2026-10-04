// verdict.test.tsx
//
// Plain English: the Health summary's head line follows the verdict
// (shared/verdict.ts) while its Verdict line setting is on (the default),
// and is today's head when it is off. With no Azure data it reads exactly
// as before.
import "./testSetup";
import { beforeAll, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { azureSummaryFixture } from "@/test/fixtures";
import { NOW_MS, overview, prefsRoutes, routes, saved } from "./testData";
import { preloadLazy } from "@/test/lazy";

beforeAll(preloadLazy);

const head = async () => {
  const panel = await screen.findByRole("region", { name: "Health summary" });
  return panel.querySelector(".ov-health__head") as HTMLElement;
};
const soonReboot = () => azureSummaryFixture({ maintenance: [{ id: "ev-1", type: "Reboot", status: "Scheduled", notBefore: new Date(NOW_MS + 10 * 60_000).toISOString(), source: "Platform", description: null, durationS: 900 }] });

describe("Health summary verdict", () => {
  it("with no Azure data the head reads exactly as today", async () => {
    renderApp("/", { routes: routes(overview("running")) });
    const h = await head();
    expect(within(h).getByText("All systems healthy")).toBeInTheDocument();
    expect(within(h).getByText("Running and responding normally.")).toBeInTheDocument();
  });

  it("the verdict rewrites the head when Azure knows more", async () => {
    renderApp("/", { routes: routes(overview("running"), { "GET /api/v1/azure/summary": soonReboot() }) });
    const h = await head();
    expect(await within(h).findByText("Azure will reboot the VM at 13:10")).toBeInTheDocument();
    expect(h.querySelector(".ov-health__title--red")).not.toBeNull();
  });

  it("verdict off shows today's head", async () => {
    renderApp("/", { routes: prefsRoutes(overview("running"), saved("overview.health", { verdict: false }), { "GET /api/v1/azure/summary": soonReboot() }) });
    const h = await head();
    expect(await within(h).findByText("All systems healthy")).toBeInTheDocument();
    expect(within(h).queryByText(/Azure will reboot/)).toBeNull();
  });

  it("rule 1 sub-line has a Boot log link", async () => {
    renderApp("/", { routes: routes(overview("running", { derived: { heartbeatStale: true } }), { "GET /api/v1/azure/summary": azureSummaryFixture() }) });
    const h = await head();
    expect(await within(h).findByText(/VM reachable · Azure says: Available/)).toBeInTheDocument();
    expect(within(h).getByRole("button", { name: "Boot log" })).toBeInTheDocument();
  });
});
