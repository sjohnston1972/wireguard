// lazy.test.tsx
//
// Plain English: a code-split widget shows its outline while its code loads,
// then the widget; if the code cannot be fetched (an open tab after a
// deploy), it offers a reload instead of breaking the page, and a modal says
// so in a toast.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components";
import { lazyPart, lazyWidget } from "./lazy";

const wrap = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

describe("lazyWidget and lazyPart", () => {
  it("shows a loading outline (not a region of the widget's name), then the widget", async () => {
    let resolve!: (c: React.ComponentType<{ word: string }>) => void;
    const W = lazyWidget<{ word: string }>("Thing", () => new Promise((r) => (resolve = r)));
    wrap(<W word="hello" />);
    expect(await screen.findByLabelText("Loading Thing")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Thing" })).toBeNull();
    resolve(({ word }) => <p>{word}</p>);
    expect(await screen.findByText("hello")).toBeInTheDocument();
  });

  it("a widget whose code cannot be fetched offers a reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const W = lazyWidget("Thing", () => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    wrap(<W />);
    expect(await screen.findByText("This widget needs a reload")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a modal whose code cannot be fetched says so in a toast", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const P = lazyPart(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    wrap(<P />);
    expect(await screen.findByText(/Reload to open this/)).toBeInTheDocument();
  });
});
