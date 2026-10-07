// Labs redesign plan C3: the tablet drawer and the phone view (spec §9, §10; Review Focus 7).
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setViewport } from "@/test/viewport";
import { renderDetails } from "./details.harness";
import { catalogue, detailIdle, labs } from "./testData";

vi.setConfig({ testTimeout: 20_000 });

const ID = "az104-06-blob-security";
const TITLE = "Blob security: SAS, access policies, private endpoint";
const routes = { [`GET /api/v1/labs/${ID}`]: detailIdle() };
const cardButton = () => within(document.querySelector<HTMLElement>(`[data-lab-card="${ID}"]`)!).getByRole("button");
const data = () => labs({ labs: catalogue() });

describe("the tablet drawer", () => {
  const openDrawer = async () => {
    setViewport("tablet");
    const user = userEvent.setup();
    const r = renderDetails(data(), { layout: "tablet", url: "/labs?exam=AZ-104", routes });
    cardButton().focus();
    await user.click(cardButton());
    const dialog = await screen.findByRole("dialog", { name: TITLE });
    return { user, r, dialog };
  };

  it("opens on ?lab with the lab's details, and traps focus", async () => {
    const { user, dialog } = await openDrawer();
    expect(dialog).toHaveAttribute("data-side", "right");
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs?exam=AZ-104&lab=${ID}`);
    expect(within(dialog).getByText("Lab 6 · AZ-104")).toBeInTheDocument();
    expect(within(dialog).getByText(ID)).toBeInTheDocument();
    expect(within(dialog).getByText("Ready to run")).toBeInTheDocument();
    // The footer holds the launch action.
    expect(dialog.querySelector(".drawer__foot")).toContainElement(within(dialog).getByRole("link", { name: "Start lab" }));
    // Focus stays inside: tab round the whole drawer and never leave it.
    for (let i = 0; i < 15; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("Escape closes it and focus returns to the card", async () => {
    const { user } = await openDrawer();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/labs\?exam=AZ-104$/);
    expect(cardButton()).toHaveFocus();
  });

  it("the X closes it and focus returns to the card", async () => {
    const { user, dialog } = await openDrawer();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardButton()).toHaveFocus();
  });

  it("Back (the URL losing ?lab) closes it and focus returns to the card", async () => {
    const { r } = await openDrawer();
    await act(async () => {
      await r.router.navigate(-1);
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/labs\?exam=AZ-104$/);
    expect(cardButton()).toHaveFocus();
  });

  it("a deep link opens the drawer, and closing it focuses the lab's card", async () => {
    setViewport("tablet");
    const user = userEvent.setup();
    renderDetails(data(), { layout: "tablet", url: `/labs?lab=${ID}`, routes });
    await screen.findByRole("dialog", { name: TITLE });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardButton()).toHaveFocus();
  });

  it("Start lab from the drawer goes to the lab's dialog, without ?lab, and posts nothing", async () => {
    const { user, dialog, r } = await openDrawer();
    await user.click(within(dialog).getByRole("link", { name: "Start lab" }));
    expect(screen.getByLabelText("location")).toHaveTextContent(new RegExp(`^/labs/${ID}\\?exam=AZ-104$`));
    expect(r.fetchMock!.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("the phone view", () => {
  it("replaces the list, focuses its heading, and Back returns to /labs with the filters and focuses the card", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderDetails(data(), { layout: "phone", url: "/labs?exam=AZ-104", routes });
    await user.click(cardButton());
    const heading = await screen.findByRole("heading", { level: 2, name: TITLE });
    expect(screen.queryByRole("list", { name: "Labs" })).toBeNull();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("region", { name: TITLE })).toHaveTextContent("Ready to run");
    await user.click(screen.getByRole("button", { name: "Back to labs" }));
    await waitFor(() => expect(screen.getByLabelText("location")).toHaveTextContent(/^\/labs\?exam=AZ-104$/));
    await waitFor(() => expect(cardButton()).toHaveFocus());
  });
});
