import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { StaleBanner } from "./StaleBanner";
import { ToastProvider, useToast } from "./Toast";
import { useState } from "react";
import { Modal } from "../layout/Modal";
import { Drawer } from "../layout/Drawer";

describe("Skeleton", () => {
  it("is hidden from assistive tech", () => {
    const { container } = render(<Skeleton variant="row" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("EmptyState", () => {
  it("says what is empty and offers the next action", async () => {
    const onClick = vi.fn();
    render(<EmptyState title="No clients" description="for this range" action={{ label: "Add client", onClick }} />);
    expect(screen.getByText("No clients")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add client" }));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("ErrorState", () => {
  it("shows the message as an alert with a working Retry", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="API unreachable" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("API unreachable");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("omits Retry without a handler", () => {
    render(<ErrorState message="boom" />);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
});

describe("StaleBanner", () => {
  it("states the data age", () => {
    render(<StaleBanner at={1_000_000 - 300_000} now={1_000_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(/out of date/i);
    expect(screen.getByRole("status")).toHaveTextContent("5 m ago");
  });
});

function Pusher() {
  const { toast } = useToast();
  return (
    <>
      <button onClick={() => toast({ title: "Saved", description: "Rule applied", tone: "success" })}>ok</button>
      <button onClick={() => toast({ title: "Heads up", tone: "warning" })}>warn</button>
    </>
  );
}

describe("Toast", () => {
  it("shows a toast with title and description, and can be dismissed", async () => {
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "ok" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("Rule applied")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
  it("labels the tone in words for warnings", async () => {
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "warn" }));
    expect(await screen.findByText("Warning")).toBeInTheDocument();
  });
  it("announces each toast once to screen readers (one live region carries its text)", async () => {
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "ok" }));
    await screen.findByText("Saved");
    const live = () =>
      Array.from(document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]')).filter((el) =>
        el.textContent?.includes("Saved"),
      );
    // Radix renders the announcement a frame after the toast mounts.
    await waitFor(() => expect(live()).toHaveLength(1));
    // The visible toast is not itself a live region, so the text is not read twice.
    const visible = screen.getByText("Saved").closest("[data-tone]")!;
    expect(visible).not.toHaveAttribute("aria-live");
    expect(visible).not.toHaveAttribute("role", "status");
    expect(live()[0].contains(visible)).toBe(false);
  });
  it("throws a clear error without a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Pusher />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe("Toast and an open dialog", () => {
  // A toast is the newest Radix layer, so it used to take Escape first: the
  // dialog the user is working in stayed open and only the toast went away.
  function DialogWithToast({ kind }: { kind: "modal" | "drawer" | "sheet" }) {
    const [open, setOpen] = useState(true);
    const { toast } = useToast();
    const body = <button onClick={() => toast({ title: "Saved", tone: "success", duration: 0 })}>save</button>;
    if (kind === "modal")
      return (
        <Modal open={open} onOpenChange={setOpen} title="Edit">
          {body}
        </Modal>
      );
    return (
      <Drawer open={open} onOpenChange={setOpen} title="Edit" side={kind === "sheet" ? "bottom" : "auto"}>
        {body}
      </Drawer>
    );
  }

  it.each(["modal", "drawer", "sheet"] as const)("Escape closes the %s first and leaves the toast", async (kind) => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <DialogWithToast kind={kind} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Edit" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit" })).toBeNull());
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("Escape with no dialog open still dismisses the toast", async () => {
    const user = userEvent.setup();
    function Plain() {
      const { toast } = useToast();
      return <button onClick={() => toast({ title: "Saved", tone: "success", duration: 0 })}>save</button>;
    }
    render(
      <ToastProvider>
        <Plain />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
  });
});
