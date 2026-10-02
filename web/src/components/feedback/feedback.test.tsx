import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { StaleBanner } from "./StaleBanner";
import { ToastProvider, useToast } from "./Toast";

// Radix Toast uses pointer capture, which jsdom lacks.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

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
  it("throws a clear error without a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Pusher />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});
