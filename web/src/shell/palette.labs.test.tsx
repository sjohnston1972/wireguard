// palette.labs.test.tsx
//
// Plain English: the command palette's lab entries (Labs spec section 10):
// "Deploy lab..." and "Tear down lab..." each ask which lab, every lab's title
// is a jump, and nothing is fetched until the palette opens. Nothing here
// writes: a lab is opened on its own page, where the reviewed forms live.
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { labDetailFixture, labsFixture } from "@/test/fixtures";

vi.setConfig({ testTimeout: 20_000 });

const loc = () => screen.getByLabelText("location");
const base = labDetailFixture().card;
const running = base.running!;
const labs = () =>
  labsFixture({
    labs: [
      { ...base, id: "az104-05-storage", number: 5, title: "Storage tiers", running: null },
      { ...base, id: "az104-06-blob-security", number: 6, title: "Blob security", running },
      { ...base, id: "az104-07-files", number: 7, title: "Files", running: null },
    ],
    running: [running],
  });

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Command palette" });
}

describe("command palette: labs", () => {
  it("lab entries come from useLabs only while the palette is open", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderApp("/", { routes: { "GET /api/v1/labs": labs() } });
    await screen.findByRole("region", { name: "Status" });
    expect(fetchMock!.callsTo("GET", "/api/v1/labs")).toHaveLength(0);
    const dialog = await openPalette(user);
    await waitFor(() => expect(fetchMock!.callsTo("GET", "/api/v1/labs")).not.toHaveLength(0));
    expect(await within(dialog).findByRole("option", { name: /Blob security/ })).toBeInTheDocument();
  });

  it("each lab title is a jump", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { "GET /api/v1/labs": labs() } });
    const dialog = await openPalette(user);
    await user.click(await within(dialog).findByRole("option", { name: /Lab 7: Files/ }));
    expect(loc()).toHaveTextContent("/labs/az104-07-files");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  });

  it("Deploy lab... opens a lab's modal", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { "GET /api/v1/labs": labs() } });
    const dialog = await openPalette(user);
    await user.click(await within(dialog).findByRole("option", { name: "Deploy lab…" }));
    const heading = await within(dialog).findByText("Deploy which lab?");
    expect(heading).toBeInTheDocument();
    const options = within(dialog).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Storage tiers"), expect.stringContaining("Blob security"), expect.stringContaining("Files")]));
    await user.click(within(dialog).getByRole("option", { name: /Storage tiers/ }));
    expect(loc()).toHaveTextContent("/labs/az104-05-storage");
  });

  it("Tear down lab... lists only running labs", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { "GET /api/v1/labs": labs() } });
    const dialog = await openPalette(user);
    await user.click(await within(dialog).findByRole("option", { name: "Tear down lab…" }));
    await within(dialog).findByText("Tear down which lab?");
    const options = within(dialog).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("Blob security"))).toBe(true);
    expect(options.some((t) => t.includes("Storage tiers") || t.includes("Files"))).toBe(false);
    await user.click(within(dialog).getByRole("option", { name: /Blob security/ }));
    expect(loc()).toHaveTextContent("/labs/az104-06-blob-security");
  });

  it("Tear down lab... is not offered when no lab runs", async () => {
    const user = userEvent.setup();
    renderApp("/", { routes: { "GET /api/v1/labs": labsFixture({ labs: labs().labs.map((l) => ({ ...l, running: null })), running: [] }) } });
    const dialog = await openPalette(user);
    await within(dialog).findByRole("option", { name: "Deploy lab…" });
    expect(within(dialog).queryByRole("option", { name: "Tear down lab…" })).toBeNull();
  });

  it("with no labs in the catalogue there is nothing to deploy and no lab entries", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openPalette(user);
    await within(dialog).findByRole("option", { name: "Go to Overview" });
    expect(within(dialog).queryByRole("option", { name: "Deploy lab…" })).toBeNull();
    expect(within(dialog).queryByRole("option", { name: "Tear down lab…" })).toBeNull();
  });
});
