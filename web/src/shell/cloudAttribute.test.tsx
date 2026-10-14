// cloudAttribute.test.tsx
//
// Plain English: the shell marks the page with the headend's cloud
// (data-cloud on <html>), and the AWS orange accent keys off it (#123).
import "../views/overview/testSetup";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { overview, prefsRoutes } from "../views/overview/testData";

afterEach(() => document.documentElement.removeAttribute("data-cloud"));
const mark = () => document.documentElement.getAttribute("data-cloud");

describe("data-cloud on the page", () => {
  it("is aws when the headend is in AWS", async () => {
    renderApp("/nowhere", { routes: prefsRoutes(overview("running", { snapshot: { cloud: "aws" } }), {}) });
    await waitFor(() => expect(mark()).toBe("aws"));
  });

  it("is azure for an Azure headend", async () => {
    renderApp("/nowhere", { routes: prefsRoutes(overview("running", { snapshot: { cloud: "azure" } }), {}) });
    await waitFor(() => expect(mark()).toBe("azure"));
  });

  it("is azure when no cloud was recorded", async () => {
    renderApp("/nowhere", { routes: prefsRoutes(overview("running", { snapshot: { cloud: null } }), {}) });
    await waitFor(() => expect(mark()).toBe("azure"));
  });
});
