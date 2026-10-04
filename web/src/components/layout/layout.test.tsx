import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Panel } from "./Panel";
import { PageHeader } from "./PageHeader";
import { Grid, Col } from "./Grid";
import { Drawer } from "./Drawer";
import { Modal } from "./Modal";
import { Tabs } from "./Tabs";
import { setViewport } from "@/test/viewport";

describe("Panel", () => {
  it("is a named region with title, status and actions", () => {
    render(
      <Panel title="Live topology" status={<span>Healthy</span>} actions={<button>View all</button>}>
        body
      </Panel>,
    );
    const region = screen.getByRole("region", { name: "Live topology" });
    expect(region).toHaveTextContent("Healthy");
    expect(region).toHaveTextContent("body");
    expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
  });
  it("renders without a title as a plain section", () => {
    render(<Panel flush>x</Panel>);
    expect(screen.getByText("x")).toBeInTheDocument();
  });
});

describe("PageHeader", () => {
  it("renders the page title as h1 with subtitle and right-hand context", () => {
    render(<PageHeader title="Clients" subtitle="Manage clients" right={<button>Add client</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("Manage clients")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add client" })).toBeInTheDocument();
  });
});

describe("Grid", () => {
  it("places columns by span", () => {
    render(
      <Grid>
        <Col span={8}>a</Col>
        <Col span={4}>b</Col>
      </Grid>,
    );
    expect(screen.getByText("a").style.getPropertyValue("--span")).toBe("8");
  });
});

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>open it</button>
      <Drawer open={open} onOpenChange={setOpen} title="phone" subtitle="10.13.13.3">
        <button>inside one</button>
        <button>inside two</button>
      </Drawer>
    </>
  );
}

describe("Drawer", () => {
  it("opens as a named dialog, traps focus, closes on Escape and restores focus", async () => {
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "open it" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "phone" });
    expect(dialog).toBeInTheDocument();
    // Tab around: focus never leaves the dialog.
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("has a close button", async () => {
    const onOpenChange = vi.fn();
    render(
      <Drawer open onOpenChange={onOpenChange} title="T">
        x
      </Drawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("on the desktop is a centred modal dialog, md by default", () => {
    render(
      <Drawer open onOpenChange={() => {}} title="T" subtitle="sub" footer={<button>act</button>}>
        x
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog", { name: "T" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-side", "center");
    expect(dialog).toHaveAttribute("data-size", "md");
    expect(dialog).toHaveClass("drawer", "drawer--modal");
    expect(dialog).toHaveTextContent("sub");
    expect(dialog.querySelector(".drawer__foot")).toHaveTextContent("act");
    expect(document.querySelector(".drawer__overlay")).toHaveAttribute("data-side", "center");
  });
  it("takes a size: lg is the wide modal", () => {
    render(
      <Drawer open onOpenChange={() => {}} title="T" size="lg">
        x
      </Drawer>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-size", "lg");
  });
  it("on a tablet is still a centred modal", () => {
    setViewport("tablet");
    render(
      <Drawer open onOpenChange={() => {}} title="T">
        x
      </Drawer>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "center");
  });
  it("on the phone is a bottom sheet, whatever its size", () => {
    setViewport("phone");
    render(
      <Drawer open onOpenChange={() => {}} title="T" size="lg">
        x
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-side", "bottom");
    expect(dialog).not.toHaveClass("drawer--modal");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
  it("a click on the dimmed backdrop closes it and restores focus", async () => {
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "open it" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "phone" });
    await userEvent.click(document.querySelector(".drawer__overlay")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("renders as a bottom sheet when asked", () => {
    render(
      <Drawer open onOpenChange={() => {}} title="T" side="bottom">
        x
      </Drawer>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("data-side", "bottom");
  });
});

function ModalHarness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>danger</button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Tear down"
        description="This destroys the VM."
        footer={<button onClick={onConfirm}>Confirm</button>}
      >
        <input aria-label="phrase" />
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("has title and description, traps focus, restores focus on close", async () => {
    const onConfirm = vi.fn();
    render(<ModalHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "danger" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Tear down" });
    expect(dialog).toHaveAccessibleDescription("This destroys the VM.");
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Tabs", () => {
  const items = [
    { value: "overview", label: "Overview", content: <p>overview body</p> },
    { value: "config", label: "Configuration", content: <p>config body</p> },
    { value: "traffic", label: "Traffic", content: <p>traffic body</p> },
  ];
  it("underline tabs: arrow keys move between tabs and show the panel", async () => {
    render(<Tabs aria-label="Client" items={items} defaultValue="overview" />);
    const first = screen.getByRole("tab", { name: "Overview" });
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("overview body")).toBeVisible();
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Configuration" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("config body")).toBeVisible();
  });
  it("pill tabs report changes when controlled and show counts", async () => {
    const onValueChange = vi.fn();
    render(
      <Tabs
        variant="pill"
        aria-label="Filter"
        value="all"
        onValueChange={onValueChange}
        items={[
          { value: "all", label: "All", count: 12 },
          { value: "online", label: "Online", count: 3 },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("tab", { name: /Online/ }));
    expect(onValueChange).toHaveBeenCalledWith("online");
    expect(screen.getByRole("tab", { name: "Online (3)" })).toBeInTheDocument();
  });
});
