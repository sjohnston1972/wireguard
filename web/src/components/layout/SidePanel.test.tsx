import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidePanel, SplitView } from "./SidePanel";
import { Drawer } from "./Drawer";

afterEach(() => vi.unstubAllGlobals());

/** The Clients mockup: a table on the left, the client's panel beside it. */
function Harness({ onRowAction = () => {} }: { onRowAction?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <SplitView
      panel={
        <SidePanel
          open={open}
          onClose={() => setOpen(false)}
          title="phone"
          subtitle="10.13.13.3 · azure"
          tabs={[
            { value: "overview", label: "Overview", content: <button>Show QR code</button> },
            { value: "config", label: "Configuration", content: <p>Allowed IPs</p> },
          ]}
        />
      }
    >
      <button onClick={() => setOpen(true)}>open phone</button>
      <button onClick={onRowAction}>row action</button>
    </SplitView>
  );
}

describe("SidePanel (inline split view)", () => {
  it("opens beside the page as a named complementary region, not a modal dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("complementary", { name: "phone" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "open phone" }));
    const panel = await screen.findByRole("complementary", { name: "phone" });
    expect(panel).toHaveTextContent("10.13.13.3 · azure");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panel).not.toHaveAttribute("aria-modal");
  });

  it("moves focus into the panel, and leaves the page usable (no focus trap)", async () => {
    const user = userEvent.setup();
    const onRowAction = vi.fn();
    render(<Harness onRowAction={onRowAction} />);
    await user.click(screen.getByRole("button", { name: "open phone" }));
    const panel = await screen.findByRole("complementary", { name: "phone" });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await user.click(screen.getByRole("button", { name: "row action" }));
    expect(onRowAction).toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "phone" })).toBeInTheDocument();
    screen.getByRole("button", { name: "row action" }).focus();
    expect(screen.getByRole("button", { name: "row action" })).toHaveFocus();
  });

  it("closes on Escape from inside it and puts focus back where it was", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open phone" });
    await user.click(trigger);
    const panel = await screen.findByRole("complementary", { name: "phone" });
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "phone" })).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("Escape elsewhere on the page does not close it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open phone" }));
    await screen.findByRole("complementary", { name: "phone" });
    screen.getByRole("button", { name: "row action" }).focus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "phone" })).toBeInTheDocument();
  });

  it("has a close X and tabs at the top", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open phone" }));
    const panel = await screen.findByRole("complementary", { name: "phone" });
    const tabs = within(panel).getByRole("tablist", { name: "phone sections" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Configuration"]);
    expect(within(panel).getByRole("button", { name: "Show QR code" })).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "phone" })).toBeNull();
  });

  it("on the phone it is the modal bottom sheet instead", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width: 640px"), media: q, addEventListener() {}, removeEventListener() {} }));
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open phone" }));
    const sheet = await screen.findByRole("dialog", { name: "phone" });
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it('is also available as <Drawer mode="inline">', () => {
    render(
      <Drawer mode="inline" open onOpenChange={() => {}} title="Rule 3">
        body
      </Drawer>,
    );
    expect(screen.getByRole("complementary", { name: "Rule 3" })).toHaveTextContent("body");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
