// capacity.test.tsx
//
// Plain English: the deploy form warns when Azure says the next deploy may
// not get its VM (spec 2026-10-04 section 10.2): only when the check says
// ok: false, never blocking: the button reads "Deploy anyway". The warning
// follows the chosen target.
import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CapacityCheck } from "@shared/api";
import { renderApp } from "@/test/render";
import { overview, routes } from "./testData";

const cap = (over: Partial<CapacityCheck> = {}): CapacityCheck => ({
  region: "uksouth",
  size: "Standard_B1s",
  available: false,
  reason: "NotAvailableForSubscription",
  vcpusNeeded: 1,
  family: null,
  total: null,
  ok: false,
  message: "Standard_B1s isn't offered to this subscription in UK South (NotAvailableForSubscription).",
  fetchedAt: "2026-10-02T10:00:00.000Z",
  ...over,
});
const form = () => screen.findByRole("form", { name: "Deploy" });

describe("deploy form capacity warning", () => {
  it("the deploy form shows the capacity warning only when ok is false, and the button reads Deploy anyway", async () => {
    const r = renderApp("/", { routes: routes({ ...overview("destroyed"), capacity: cap() }) });
    let f = await form();
    expect(within(f).getByText(cap().message!)).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Deploy anyway" })).toBeInTheDocument();
    r.unmount();

    for (const c of [null, cap({ ok: true, available: true, reason: null, message: "Available · vCPU quota 1 of 10 used" }), cap({ ok: null, message: null })]) {
      const again = renderApp("/", { routes: routes({ ...overview("destroyed"), capacity: c }) });
      f = await form();
      expect(within(f).getByRole("button", { name: "Deploy" })).toBeInTheDocument();
      expect(within(f).queryByText(/isn't offered|Available ·/)).toBeNull();
      again.unmount();
    }
  });

  it("the warning follows the chosen target", async () => {
    const user = userEvent.setup();
    const r = renderApp("/", {
      routes: routes({ ...overview("destroyed"), capacity: cap({ ok: true, available: true, reason: null, message: null }) }, {
        "GET /api/v1/azure/capacity": ({ url }: { url: string }) => {
          const q = new URL(url, "http://x").searchParams;
          return cap({ region: q.get("region")!, size: q.get("size")!, message: "Needs 1 B-series vCPUs; 10 of 10 used in East US." });
        },
      }),
    });
    const f = await form();
    expect(within(f).getByRole("button", { name: "Deploy" })).toBeInTheDocument();
    await user.click(within(f).getByRole("button", { name: "US exit" }));
    expect(await within(f).findByText("Needs 1 B-series vCPUs; 10 of 10 used in East US.")).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Deploy anyway" })).toBeInTheDocument();
    expect(r.fetchMock!.calls.some((c) => c.url.includes("/api/v1/azure/capacity?region=eastus&size=Standard_B1s"))).toBe(true);
  });
});
