// serviceHealthMount.test.tsx
//
// Plain English: the shell mounts the Azure Service Health pill in the top
// bar, just before the notes bell (insights spec 10.2). Area X4 draws the
// pill itself; here a stand-in proves where it sits, and the real pill is tested in ServiceHealthIndicator.test.tsx.
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { sessionFixture } from "@/test/fixtures";

vi.mock("./ServiceHealthIndicator", () => ({ ServiceHealthIndicator: () => <span data-testid="service-health-pill">pill</span> }));

describe("ServiceHealthIndicator in the shell", () => {
  it("is mounted in the top bar, right before the notes bell", async () => {
    const note = { id: 1, at: "2026-10-02T10:00:00.000Z", kind: "warn", message: "n1", run_id: null, acknowledged: 0 };
    renderApp("/settings", { routes: { "GET /api/v1/session": sessionFixture({ notes: [note] }) } });
    const bell = await screen.findByRole("link", { name: "1 unread watchman note" });
    const pill = within(document.querySelector<HTMLElement>("header.topbar")!).getByTestId("service-health-pill");
    expect(pill.nextElementSibling).toBe(bell);
  });
});
