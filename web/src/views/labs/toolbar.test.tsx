// Labs redesign plan B4: the search and filter toolbar and its URL state (spec §8.3; Review Focus 4's search names).
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LabsResponse } from "@shared/api";
import { renderWithProviders } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { expectBottomSheet } from "@/test/dialogs";
import { labCoverageFixture } from "@/test/fixtures";
import { card, labs } from "./testData";
import { useLabViews } from "./contract";
import { applyFilters } from "./model";
import { LabsFilterToolbar, LabsNoMatches, useLabFilters } from "./LabsFilterToolbar";

vi.setConfig({ testTimeout: 20_000 });

/** The toolbar over a plain list of the labs it keeps, as the page composes them. */
function Harness({ data }: { data: LabsResponse }) {
  const { views } = useLabViews({ data });
  const [f] = useLabFilters();
  const visible = applyFilters(views, f);
  return (
    <>
      <LabsFilterToolbar views={views} visible={visible.length} />
      {visible.length === 0 ? (
        <LabsNoMatches views={views} />
      ) : (
        <ul aria-label="Shown">
          {visible.map((v) => (
            <li key={v.card.id}>{v.card.title}</li>
          ))}
        </ul>
      )}
    </>
  );
}

const setup = (url = "/labs", data = labs()) => {
  const r = renderWithProviders(<Harness data={data} />, { url, routes: { "GET /api/v1/labs/coverage": labCoverageFixture() } });
  const loc = () => r.router.state.location.pathname + r.router.state.location.search;
  const params = () => new URLSearchParams(r.router.state.location.search);
  return { ...r, loc, params };
};
const shown = () => within(screen.getByRole("list", { name: "Shown" }))
  .getAllByRole("listitem")
  .map((li) => li.textContent);
const toolbar = () => within(screen.getByRole("search", { name: "Filter labs" }));

describe("the filter toolbar", () => {
  it("each control writes its parameter with replace and keeps the others", async () => {
    const user = userEvent.setup();
    const { router, params } = setup("/labs?lab=az104-05-storage&view=x");
    const t = toolbar();
    const navs: string[] = [];
    router.subscribe((s) => navs.push(s.historyAction));

    await user.click(t.getByRole("radio", { name: "AZ-104" }));
    expect(params().get("exam")).toBe("AZ-104");
    await user.click(t.getByRole("combobox", { name: "Skill area" }));
    await user.click(await screen.findByRole("option", { name: "Implement and manage storage" }));
    expect(params().get("area")).toBe("az104.storage");
    await user.click(t.getByRole("combobox", { name: "Difficulty" }));
    await user.click(await screen.findByRole("option", { name: "Foundation" }));
    expect(params().get("level")).toBe("foundation");
    await user.click(t.getByRole("switch", { name: "Ready to run only" }));
    expect(params().get("ready")).toBe("1");
    // The other parameters are kept, and every write replaces (Back leaves the page, not each filter).
    expect(params().get("lab")).toBe("az104-05-storage");
    expect(params().get("view")).toBe("x");
    expect(navs.length).toBe(4);
    expect(navs.every((a) => a === "REPLACE")).toBe(true);
    expect(shown()).toEqual(["Storage accounts: redundancy, access tiers, lifecycle"]);
  });

  it("More filters holds Type and Not run yet and shows its count", async () => {
    const user = userEvent.setup();
    const { params } = setup();
    const t = toolbar();
    // Type and Not run yet are not on the bar itself.
    expect(t.queryByRole("group", { name: "Type" })).toBeNull();
    expect(t.queryByRole("switch", { name: "Not run yet" })).toBeNull();
    await user.click(t.getByRole("button", { name: "More filters" }));
    const pop = within(await screen.findByRole("dialog", { name: "More filters" }));
    await user.click(pop.getByRole("button", { name: "Break-fix" }));
    expect(params().get("type")).toBe("break-fix");
    await user.click(pop.getByRole("switch", { name: "Not run yet" }));
    expect(params().get("notrun")).toBe("1");
    expect(shown()).toEqual(["Azure Files: SMB share mounted on a VM"]);
    await user.keyboard("{Escape}");
    const trigger = t.getByRole("button", { name: "More filters, 2 active" });
    expect(trigger).toHaveTextContent("2");
  });

  it("Showing N of M labs and Clear filters when active", async () => {
    const user = userEvent.setup();
    const { params } = setup("/labs?exam=AZ-305&lab=az305-20-landing-zone");
    const t = toolbar();
    const count = t.getByText("Showing 1 of 5 labs");
    expect(count).toHaveAttribute("aria-live", "polite");
    await user.click(t.getByRole("button", { name: "Clear filters" }));
    expect(params().get("exam")).toBeNull();
    expect(params().get("lab")).toBe("az305-20-landing-zone");
    expect(t.getByText("Showing 5 of 5 labs")).toBeInTheDocument();
    expect(t.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("the skill areas offered are those of the labs the exam keeps, by official name", async () => {
    const user = userEvent.setup();
    setup("/labs?exam=AZ-305");
    await user.click(toolbar().getByRole("combobox", { name: "Skill area" }));
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["All skill areas", "az305.governance"]);
  });

  it("old ?level=a,b keeps the first valid level in the Difficulty control", () => {
    setup("/labs?level=bogus,expert,foundation");
    expect(toolbar().getByRole("combobox", { name: "Difficulty" })).toHaveTextContent("Expert");
  });
});

describe("search", () => {
  it("search writes once after 250 ms and keeps the caret", async () => {
    const user = userEvent.setup();
    const { router, params } = setup("/labs?exam=AZ-104");
    const input = toolbar().getByRole("searchbox", { name: "Find a lab" });
    const navs: string[] = [];
    router.subscribe((s) => navs.push(s.location.search));
    await user.type(input, "blob ");
    // Nothing written while typing.
    expect(navs).toHaveLength(0);
    await waitFor(() => expect(params().get("q")).toBe("blob"));
    expect(navs).toHaveLength(1);
    // The text as typed stays (the trailing space too) and focus never left the field.
    expect(input).toHaveValue("blob ");
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(5);
    await user.type(input, "s");
    expect(input).toHaveValue("blob s");
    await waitFor(() => expect(params().get("q")).toBe("blob s"));
    expect(params().get("exam")).toBe("AZ-104");
  });

  it("search matches title, id, lab N, summary, objective and topic words", async () => {
    const user = userEvent.setup();
    setup();
    const input = toolbar().getByRole("searchbox", { name: "Find a lab" });
    const find = async (q: string) => {
      await user.clear(input);
      await user.type(input, q);
      await act(() => new Promise((r) => setTimeout(r, 300)));
      return screen.queryByRole("list", { name: "Shown" }) ? shown() : [];
    };
    expect(await find("Landing")).toEqual(["Landing zone: management groups and policy"]);
    expect(await find("az104-07")).toEqual(["Azure Files: SMB share mounted on a VM"]);
    expect(await find("lab 6")).toEqual(["Blob security: SAS, access policies, private endpoint"]);
    expect(await find("LRS hot")).toEqual(["Storage accounts: redundancy, access tiers, lifecycle"]);
    // Every test card has the fixture's objective and topics (Private Link from privateEndpoint).
    expect(await find("private link")).toHaveLength(5);
    expect(await find("SAS tokens")).toHaveLength(5);
  });

  it("a URL change it did not write (Back, Clear filters) re-syncs the field", async () => {
    const user = userEvent.setup();
    const { router } = setup("/labs?q=blob");
    const input = toolbar().getByRole("searchbox", { name: "Find a lab" });
    expect(input).toHaveValue("blob");
    await user.click(toolbar().getByRole("button", { name: "Clear filters" }));
    expect(input).toHaveValue("");
    await act(() => router.navigate("/labs?q=files"));
    expect(input).toHaveValue("files");
  });
});

describe("no matches", () => {
  it("the empty result says how many labs Ready to run only hides", async () => {
    const user = userEvent.setup();
    const data = labs({ labs: labs().labs.map((c) => (c.number === 20 ? card({ ...c, blockers: [{ kind: "role", message: "Needs the role." }] }) : c)) });
    const { params } = setup("/labs?exam=AZ-305&ready=1", data);
    expect(screen.getByText("No labs match these filters")).toBeInTheDocument();
    expect(screen.getByText("1 lab is hidden because it isn't ready to run.")).toBeInTheDocument();
    await user.click(within(screen.getByText("No labs match these filters").closest(".empty") as HTMLElement).getByRole("button", { name: "Clear filters" }));
    expect(params().toString()).toBe("");
  });
});

describe("on the phone", () => {
  it("the phone shows search and a Filters sheet with Show N labs", async () => {
    const user = userEvent.setup();
    setViewport("phone");
    const { params } = setup("/labs?type=explore");
    const t = toolbar();
    expect(t.getByRole("searchbox", { name: "Find a lab" })).toBeInTheDocument();
    // The other controls live in the sheet.
    expect(t.queryByRole("radiogroup", { name: "Exam" })).toBeNull();
    await user.click(t.getByRole("button", { name: "Filters (1)" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expectBottomSheet(sheet);
    const s = within(sheet);
    expect(s.getByRole("radiogroup", { name: "Exam" })).toBeInTheDocument();
    expect(s.getByRole("combobox", { name: "Skill area" })).toBeInTheDocument();
    expect(s.getByRole("combobox", { name: "Difficulty" })).toBeInTheDocument();
    expect(s.getByRole("group", { name: "Type" })).toBeInTheDocument();
    expect(s.getByRole("switch", { name: "Not run yet" })).toBeInTheDocument();
    await user.click(s.getByRole("radio", { name: "AZ-104" }));
    expect(params().get("exam")).toBe("AZ-104");
    expect(s.getByRole("button", { name: "Show 3 labs" })).toBeInTheDocument();
    await user.click(s.getByRole("switch", { name: "Ready to run only" }));
    await user.click(s.getByRole("button", { name: "Clear" }));
    expect(params().toString()).toBe("");
    await user.click(s.getByRole("button", { name: "Show 5 labs" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull());
    expect(t.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });
});
