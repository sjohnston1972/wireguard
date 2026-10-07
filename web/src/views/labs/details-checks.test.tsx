// Labs redesign plan C5: the deploy checks in the details (spec §8.5 item 9).
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderDetails } from "./details.harness";
import { catalogue, detailIdle, labs, session } from "./testData";

const ID = "az104-06-blob-security";
const DETAIL = `GET /api/v1/labs/${ID}`;
const panel = () => within(screen.getByRole("complementary", { name: /Blob security/ }));
const fact = (label: string) => panel().getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
const open = (detail: unknown, data = labs({ labs: catalogue() })) => renderDetails(data, { url: `/labs?lab=${ID}`, routes: { [DETAIL]: detail } });

describe("deploy checks in the details", () => {
  it("the destination region and warnings appear when the lab loads", async () => {
    open(
      detailIdle({
        defaults: { region: "westeurope", peer: true, hours: 2 },
        warnings: [
          { kind: "budget", message: "This session would take the month to £31.20 of £30.00.", overridable: true },
          { kind: "slow", message: "Takes about 35 minutes to deploy and 20 to tear down.", overridable: false },
        ],
      }),
    );
    await waitFor(() => expect(fact("Destination")).toHaveTextContent("westeurope"));
    const checks = within(panel().getByRole("region", { name: "Deploy checks" }));
    expect(checks.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["BudgetThis session would take the month to £31.20 of £30.00.", "SlowTakes about 35 minutes to deploy and 20 to tear down."]);
  });

  it("no warnings: the checks say nothing stands in the way", async () => {
    open(detailIdle());
    await waitFor(() => expect(fact("Destination")).toHaveTextContent("uksouth"));
    expect(within(panel().getByRole("region", { name: "Deploy checks" })).getByText("No warnings for a deploy now.")).toBeInTheDocument();
  });

  it("a live session's destination is its own region", async () => {
    const data = labs({ labs: catalogue().map((c) => (c.id === ID ? { ...c, running: session({ region: "northeurope" }) } : c)) });
    open(detailIdle(), data);
    expect(fact("Destination")).toHaveTextContent("northeurope");
  });

  it("Skeleton lines while loading", () => {
    open(() => new Promise(() => {}));
    expect(fact("Destination").querySelector(".skeleton")).not.toBeNull();
    const checks = panel().getByRole("region", { name: "Deploy checks" });
    expect(checks).toHaveAttribute("aria-busy", "true");
    expect(checks.querySelector(".skeleton")).not.toBeNull();
    expect(fact("Destination")).not.toHaveTextContent(/no data|uksouth/);
  });

  it("an inline Retry when it fails while the card content stays", async () => {
    let fail = true;
    const user = userEvent.setup();
    open(() => (fail ? { status: 503, json: { error: { code: "unavailable", message: "D1 is down." } } } : detailIdle()));
    const checks = within(panel().getByRole("region", { name: "Deploy checks" }));
    expect(await checks.findByText("Couldn't load the deploy checks.")).toBeInTheDocument();
    // The card's own content stays.
    expect(panel().getByText(/Control who reaches one blob container/)).toBeInTheDocument();
    expect(panel().getByRole("link", { name: "Start lab" })).toBeInTheDocument();
    fail = false;
    await user.click(checks.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fact("Destination")).toHaveTextContent("uksouth"));
  });
});
