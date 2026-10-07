// filters.test.ts
//
// Plain English: labs redesign spec §8.3 and §9. The catalogue's filters and
// search as kept in the address, the cards they keep, which lab the details
// show at each layout (and when the address must lose a hidden ?lab), the
// link that opens a lab's dialog, and the layout from the window's width.

import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { LabCard } from "@shared/api";
import { setViewport } from "@/test/viewport";
import { card, catalogue, session } from "./testData";
import { NO_FILTERS, anyFilter, applyFilters, labHref, readFilters, readSelection, searchText, selectedLab, withSelection, writeFilters, type Filters } from "./model";
import { labReadiness, labSessionStatus } from "./status";
import { WIDE_QUERY, useLabsLayout } from "./layout";

const P = (s: string) => new URLSearchParams(s);

/** The pieces of a LabView applyFilters reads. */
const view = (c: LabCard) => ({ card: c, readiness: labReadiness(c, true), status: labSessionStatus(c.running), search: searchText(c) });
/** The ids applyFilters keeps from these cards in lab number order (the order useLabViews gives it). */
const ids = (f: Partial<Filters>, cards: LabCard[] = catalogue()) =>
  applyFilters([...cards].sort((a, b) => a.number - b.number).map(view), { ...NO_FILTERS, ...f }).map((v) => v.card.id);

describe("readFilters and writeFilters", () => {
  it("reads every parameter, and nothing for an empty address", () => {
    expect(readFilters(P(""))).toEqual(NO_FILTERS);
    expect(NO_FILTERS).toEqual({ q: "", exam: null, area: null, level: null, type: [], notRun: false, ready: false });
    expect(readFilters(P("q=blob&exam=AZ-305&area=az305.data&level=expert&type=break-fix,explore&notrun=1&ready=1"))).toEqual({
      q: "blob",
      exam: "AZ-305",
      area: "az305.data",
      level: "expert",
      type: ["break-fix", "explore"],
      notRun: true,
      ready: true,
    });
  });

  it("old ?level=a,b keeps the first valid level", () => {
    expect(readFilters(P("level=associate,expert")).level).toBe("associate");
    expect(readFilters(P("level=nonsense,expert")).level).toBe("expert");
    expect(readFilters(P("level=nonsense")).level).toBeNull();
  });

  it("an unknown exam or type is ignored", () => {
    expect(readFilters(P("exam=AZ-900&type=lecture")).exam).toBeNull();
    expect(readFilters(P("type=lecture")).type).toEqual([]);
  });

  it("writes only what is set, and keeps other parameters (lab, view)", () => {
    const next = writeFilters(P("lab=az104-05-storage&level=a,b&q=old"), { ...NO_FILTERS, q: " sas ", level: "foundation", ready: true });
    expect(next.toString()).toBe("lab=az104-05-storage&level=foundation&q=sas&ready=1");
    expect(writeFilters(P("q=x&ready=1&notrun=1&exam=AZ-104"), NO_FILTERS).toString()).toBe("");
  });

  it("anyFilter counts search and Ready to run only", () => {
    expect(anyFilter(NO_FILTERS)).toBe(false);
    expect(anyFilter({ ...NO_FILTERS, q: "x" })).toBe(true);
    expect(anyFilter({ ...NO_FILTERS, q: "   " })).toBe(false);
    expect(anyFilter({ ...NO_FILTERS, ready: true })).toBe(true);
    expect(anyFilter({ ...NO_FILTERS, level: "expert" })).toBe(true);
  });
});

describe("applyFilters", () => {
  it("combines every filter (AND) and keeps the order it is given", () => {
    expect(ids({})).toEqual(["az104-01-identity", "az104-05-storage", "az104-06-blob-security", "az104-07-file-share", "az305-20-landing-zone"]);
    expect(ids({ exam: "AZ-104", level: "foundation" })).toEqual(["az104-01-identity", "az104-05-storage"]);
    expect(ids({ type: ["break-fix"] })).toEqual(["az104-07-file-share"]);
    expect(ids({ notRun: true })).toEqual(["az104-05-storage", "az104-07-file-share", "az305-20-landing-zone"]);
    expect(ids({ area: "az104.compute" })).toEqual(["az104-07-file-share"]);
  });

  it("a tagged lab is kept by each of its exams", () => {
    const tagged = card({ id: "az104-13-vnets", number: 13, exams: ["AZ-104", "AZ-700"] });
    const cards = [...catalogue(), tagged, card({ id: "az700-31-ip-nat-outbound", number: 31, exam: "AZ-700" })];
    expect(ids({ exam: "AZ-700" }, cards)).toEqual(["az104-13-vnets", "az700-31-ip-nat-outbound"]);
    expect(ids({ exam: "AZ-104" }, cards)).toContain("az104-13-vnets");
  });

  it("ready=1 keeps ready labs with no live session", () => {
    const cards = [
      card({ id: "az104-01-identity", number: 1 }),
      card({ id: "az104-02-policy", number: 2, blockers: [{ kind: "role", message: "Needs the role." }] }),
      card({ id: "az104-03-mgmt-groups", number: 3, running: session({ state: "running" }) }),
      card({ id: "az104-04-cost", number: 4, blockers: [{ kind: "budget", message: "Budget." }] }),
      card({ id: "az104-05-storage", number: 5, prerequisites: ["az104-04-cost"] }),
    ];
    expect(ids({ ready: true }, cards)).toEqual(["az104-01-identity", "az104-05-storage"]);
  });

  it("search matches title, id, \"lab 6\", summary, objective and topic words", () => {
    const six = card({
      id: "az104-06-blob-security",
      number: 6,
      title: "Blob security: SAS, access policies, private endpoint",
      summary: "A storage account with a private container.",
      learning: { objective: "Control who reaches one blob container.", learn: ["Make a SAS from a stored access policy", "Grant blob data access to a group", "Resolve the account privately"], learningMin: 50 },
      resources: { privateDnsZone: 1, storage: 1 },
    });
    const sixty = card({ id: "az700-60-other", number: 60, title: "Other", summary: "Nothing alike.", learning: null, resources: { vm: 1 } });
    const cards = [six, sixty];
    for (const q of ["blob security", "BLOB", "az104-06", "lab 6", "  Lab 6 ", "private container", "who reaches", "dns", "Storage"]) expect(ids({ q }, cards), q).toEqual(["az104-06-blob-security"]);
    expect(ids({ q: "lab 60" }, cards)).toEqual(["az700-60-other"]);
    expect(ids({ q: "virtual machines" }, cards)).toEqual(["az700-60-other"]);
    expect(ids({ q: "nothing like this" }, cards)).toEqual([]);
    expect(ids({ q: "   " }, cards)).toEqual(["az104-06-blob-security", "az700-60-other"]);
  });
});

describe("selection (spec §9)", () => {
  const visible = ["az104-01-identity", "az104-05-storage"];
  const known = ["az104-01-identity", "az104-05-storage", "az104-06-blob-security"];

  it("wide shows the URL lab when visible, else the first visible, and asks to drop a hidden known lab", () => {
    expect(selectedLab(visible, "az104-05-storage", "wide", known)).toEqual({ shown: "az104-05-storage", drop: false });
    expect(selectedLab(visible, null, "wide", known)).toEqual({ shown: "az104-01-identity", drop: false });
    expect(selectedLab(visible, "az104-06-blob-security", "wide", known)).toEqual({ shown: "az104-01-identity", drop: true });
    expect(selectedLab([], null, "wide", known)).toEqual({ shown: null, drop: false });
    expect(selectedLab([], "az104-06-blob-security", "wide", known)).toEqual({ shown: null, drop: true });
  });

  it("an unknown ?lab is dropped at every layout, but only once the catalogue is known", () => {
    for (const layout of ["wide", "tablet", "phone"] as const) expect(selectedLab(visible, "az104-99-gone", layout, known).drop, layout).toBe(true);
    // Still loading: nothing is known yet, so nothing is dropped.
    expect(selectedLab([], "az104-99-gone", "wide", [])).toEqual({ shown: "az104-99-gone", drop: false });
    expect(selectedLab([], "az104-99-gone", "tablet", [])).toEqual({ shown: "az104-99-gone", drop: false });
  });

  it("tablet and phone never select implicitly, and show ?lab whatever the filters hide", () => {
    for (const layout of ["tablet", "phone"] as const) {
      expect(selectedLab(visible, null, layout, known), layout).toEqual({ shown: null, drop: false });
      expect(selectedLab(visible, "az104-06-blob-security", layout, known), layout).toEqual({ shown: "az104-06-blob-security", drop: false });
    }
  });

  it("readSelection and withSelection keep the other parameters", () => {
    expect(readSelection(P("exam=AZ-104&lab=az104-05-storage"))).toBe("az104-05-storage");
    expect(readSelection(P("lab="))).toBeNull();
    expect(withSelection(P("exam=AZ-104"), "az104-05-storage").toString()).toBe("exam=AZ-104&lab=az104-05-storage");
    expect(withSelection(P("exam=AZ-104&lab=az104-05-storage"), null).toString()).toBe("exam=AZ-104");
  });

  it("labHref keeps lab on wide and drops it otherwise", () => {
    expect(labHref("az104-05-storage", "?exam=AZ-104&lab=az104-05-storage", "wide")).toBe("/labs/az104-05-storage?exam=AZ-104&lab=az104-05-storage");
    // The dialog's lab is the selection on wide (an implicit first-visible lab, or another lab's session link).
    expect(labHref("az104-05-storage", "?exam=AZ-104", "wide")).toBe("/labs/az104-05-storage?exam=AZ-104&lab=az104-05-storage");
    expect(labHref("az104-05-storage", "?exam=AZ-104&lab=az104-05-storage", "tablet")).toBe("/labs/az104-05-storage?exam=AZ-104");
    expect(labHref("az104-05-storage", "lab=az104-05-storage", "phone")).toBe("/labs/az104-05-storage");
    expect(labHref("az104-05-storage", "?q=blob&view=readme", "tablet", "diagram")).toBe("/labs/az104-05-storage?q=blob&view=diagram");
    expect(labHref("az104-05-storage", "", "tablet")).toBe("/labs/az104-05-storage");
  });
});

describe("useLabsLayout (spec §9)", () => {
  it("wide from 1200 px, phone up to 640 px, tablet between; it follows a resize", () => {
    expect(WIDE_QUERY).toBe("(min-width: 1200px)");
    setViewport("desktop");
    const { result } = renderHook(() => useLabsLayout());
    expect(result.current).toBe("wide");
    act(() => setViewport(1199));
    expect(result.current).toBe("tablet");
    act(() => setViewport(641));
    expect(result.current).toBe("tablet");
    act(() => setViewport(640));
    expect(result.current).toBe("phone");
    act(() => setViewport(1200));
    expect(result.current).toBe("wide");
  });
});
