// Deploy form edge cases: AWS switched off while the form is open, and a config with no aws block.
import "./testSetup";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OverviewResponse } from "@shared/api";
import { renderWithProviders } from "@/test/render";
import { overview, routes } from "./testData";
import { DeployForm } from "./actions";

const ok = { ok: true, message: "Done." };

/** Holds the overview in state so a test can change the config under a mounted form. */
function Harness({ start, off }: { start: OverviewResponse; off: OverviewResponse }) {
  const [o, setO] = useState(start);
  return (
    <>
      <button onClick={() => setO(off)}>switch AWS off</button>
      <DeployForm o={o} />
    </>
  );
}

describe("Deploy form and the AWS picker", () => {
  it("picker turned off while mounted after choosing AWS: deploys Azure", async () => {
    const user = userEvent.setup();
    const on = overview("destroyed");
    on.config.aws.enabled = true;
    const off = overview("destroyed");
    off.config.aws.enabled = false;
    const r = renderWithProviders(<Harness start={on} off={off} />, { routes: routes(on, { "POST /api/v1/deploy": ok }) });
    const form = await screen.findByRole("form", { name: "Deploy" });
    await user.click(within(form).getByRole("button", { name: "AWS" }));
    await user.click(screen.getByRole("button", { name: "switch AWS off" }));
    expect(within(form).queryByRole("group", { name: "Cloud" })).toBeNull();
    await user.click(within(form).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(r.fetchMock!.callsTo("POST", "/api/v1/deploy")).toHaveLength(1));
    const body = r.fetchMock!.callsTo("POST", "/api/v1/deploy")[0].body as Record<string, unknown>;
    expect(body.cloud).toBeUndefined();
    expect(body.profileId).toBe(1);
  });

  it("a config with no aws block does not crash the form", async () => {
    const o = overview("destroyed");
    delete (o.config as { aws?: unknown }).aws;
    renderWithProviders(<DeployForm o={o} />, { routes: routes(o) });
    const form = await screen.findByRole("form", { name: "Deploy" });
    expect(within(form).queryByRole("group", { name: "Cloud" })).toBeNull();
    expect(within(form).getByRole("button", { name: "Deploy" })).toBeEnabled();
  });
});
