// aws.test.tsx
//
// Plain English: AWS labs on the Labs tab (AWS labs spec §10): the header
// names both clouds, a Cloud filter narrows the cards and the exam list,
// AWS cards wear an AWS badge and read "AWS 3", the coverage map has an
// Azure and an AWS heading, and an AWS lab's modal deploys to London with
// console links and the same-cloud connect note.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp, renderWithProviders } from "@/test/render";
import { LabsHeader, LABS_SUBTITLE } from "./LabsHeader";
import { applyFilters, examsFor, labNumberWord, NO_FILTERS, readFilters } from "./model";
import { LabCard } from "./LabCard";
import { CoverageMap, ExamCoverage } from "./CoverageMap";
import { LabsFilterToolbar } from "./LabsFilterToolbar";
import { labView } from "./contract";
import { labTopics } from "./topics";
import { awsCard, card, labs, session } from "./testData";
import { awsLabDetailFixture, labCoverageFixture, labDetailFixture } from "@/test/fixtures";
import { DeployFormView } from "./DeployForm";
import { RunningLabView } from "./RunningLab";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const aws = awsCard;

describe("header and filters", () => {
  it("the page is titled Labs and names both clouds' exams", () => {
    renderWithProviders(<LabsHeader />);
    expect(screen.getByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();
    expect(LABS_SUBTITLE).toBe("Hands-on Azure (AZ-104, AZ-305, AZ-700) and AWS (SOA-C03, SAA-C03, ANS-C01) environments: pick a lab, deploy it, learn by doing.");
  });

  it("the cloud filter keeps one cloud's cards, lists that cloud's exams, and drops the other cloud's exam", () => {
    const views = [labView(aws(), true), labView(card(), true)];
    expect(applyFilters(views, { ...NO_FILTERS, cloud: "aws" }).map((v) => v.card.id)).toEqual(["soa-03-auto-scaling"]);
    expect([...examsFor("aws")]).toEqual(["SOA-C03", "SAA-C03", "ANS-C01"]);
    expect([...examsFor(null)]).toHaveLength(6);
    expect(readFilters(new URLSearchParams("cloud=azure&exam=SOA-C03"))).toMatchObject({ cloud: "azure", exam: null });
    expect(readFilters(new URLSearchParams("cloud=aws&exam=SOA-C03"))).toMatchObject({ cloud: "aws", exam: "SOA-C03" });
  });

  it("searching 'aws 3' finds the AWS lab 3 only, 'lab 3' only an Azure lab 3", () => {
    const views = [labView(aws(), true), labView(card({ id: "az104-03-x", number: 3 }), true)];
    expect(applyFilters(views, { ...NO_FILTERS, q: "aws 3" }).map((v) => v.card.id)).toEqual(["soa-03-auto-scaling"]);
    expect(applyFilters(views, { ...NO_FILTERS, q: "lab 3" }).map((v) => v.card.id)).toEqual(["az104-03-x"]);
  });
});

describe("cards and coverage", () => {
  it("an AWS card wears an AWS badge and reads AWS 3; an Azure card is unchanged", () => {
    expect(labNumberWord({ number: 3, cloud: "aws" })).toBe("AWS 3");
    expect(labNumberWord({ number: 7, cloud: "azure" })).toBe("Lab 7");
    renderWithProviders(<LabCard view={labView(aws(), true)} selected={false} onSelect={() => {}} search="" layout="wide" />);
    expect(screen.getByText("AWS", { selector: ".pill *, .pill" })).toBeInTheDocument();
    expect(screen.getByText(/AWS 3 · SOA-C03/)).toBeInTheDocument();
  });

  it("an Azure card has no AWS badge", () => {
    renderWithProviders(<LabCard view={labView(card(), true)} selected={false} onSelect={() => {}} search="" layout="wide" />);
    expect(screen.queryByText("AWS", { selector: ".pill *, .pill" })).toBeNull();
    expect(screen.getByText(/Lab 6 · AZ-104/)).toBeInTheDocument();
  });

  it("coverage boxes say AWS 3", () => {
    renderWithProviders(<ExamCoverage e={{ exam: "SOA-C03", areas: [{ key: "soa.reliability", name: "Reliability and Business Continuity", labs: [{ id: "soa-03-auto-scaling", number: 3, title: "Auto Scaling", run: false }], run: 0, available: 1 }] }} />);
    expect(screen.getByRole("img", { name: "AWS 3, Auto Scaling: not run yet" })).toBeInTheDocument();
  });

  it("AWS labs' topics use AWS words", () => {
    expect(labTopics({ vm: 2, nsg: 1, vnet: 1, bastion: 1 }, "aws")).toEqual(["Instance Connect", "Security groups", "EC2", "VPCs"]);
    expect(labTopics({ vm: 2, nsg: 1, vnet: 1, bastion: 1 })).toEqual(["Bastion", "NSGs", "Virtual machines", "Virtual networks"]);
  });
});

describe("the AWS lab modal", () => {
  it("deploys to London with no region box, and shows the connect note in place of the peer tick", async () => {
    const d = awsLabDetailFixture();
    renderWithProviders(<DeployFormView d={d} />);
    expect(screen.queryByLabelText(/region/i, { selector: "input" })).toBeNull();
    expect(screen.getByText("Region: London (eu-west-2)")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /peer/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /peer/i })).toBeNull();
    expect(screen.getByText(/AWS labs connect only to an AWS server/)).toBeInTheDocument();
  });

  it("names the second region when the lab has one", () => {
    const d = awsLabDetailFixture({ secondaryRegion: "eu-west-1" });
    renderWithProviders(<DeployFormView d={d} />);
    expect(screen.getByText("Region: London (eu-west-2), and Ireland (eu-west-1) for the second region")).toBeInTheDocument();
  });

  it("a running AWS lab links to its console group per region and explains the connect lines", () => {
    const d = awsLabDetailFixture({
      card: aws({ running: session({ labId: "soa-03-auto-scaling", state: "running" }) }),
      session: session({ labId: "soa-03-auto-scaling", state: "running", outputs: { privateIps: { "vm-web": "10.64.64.10" }, connect: ["aws ec2-instance-connect ssh --instance-id i-0abc --os-user labadmin --connection-type eice", "ssh labadmin@10.64.64.10"], users: {} } }),
    });
    renderWithProviders(<RunningLabView d={d} />);
    const link = screen.getByRole("link", { name: "Open in AWS console (London)" });
    expect(link).toHaveAttribute("href", "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-03-auto-scaling?region=eu-west-2");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /portal/i })).toBeNull();
    expect(screen.getByText(/the aws ec2-instance-connect line works anywhere/)).toBeInTheDocument();
    // This lab runs unconnected, so the "once peered" hint would mislead.
    expect(screen.queryByText(/once the lab is peered/)).toBeNull();
  });
});

describe("Cloud control, coverage headings and running chips", () => {
  it("choosing AWS limits the Exam options to AWS's three and drops a non-fitting exam", async () => {
    const user = userEvent.setup();
    const data = labs({ labs: [card(), aws()] });
    const Bar = () => <LabsFilterToolbar views={data.labs.map((c) => labView(c, true))} visible={2} />;
    const { router } = renderWithProviders(<Bar />, { url: "/labs?exam=AZ-104", routes: { "GET /api/v1/labs/coverage": labCoverageFixture() } });
    const bar = within(screen.getByRole("search", { name: "Filter labs" }));
    await user.click(bar.getByRole("combobox", { name: "Exam" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["All", "AZ-104", "AZ-305", "AZ-700", "SOA-C03", "SAA-C03", "ANS-C01"]);
    await user.keyboard("{Escape}");
    await user.click(bar.getByRole("radio", { name: "AWS" }));
    expect(new URLSearchParams(router.state.location.search).get("cloud")).toBe("aws");
    expect(new URLSearchParams(router.state.location.search).get("exam")).toBeNull();
    await user.click(bar.getByRole("combobox", { name: "Exam" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["All", "SOA-C03", "SAA-C03", "ANS-C01"]);
  });

  it("the coverage map has an Azure and an AWS heading, each over its own exams", async () => {
    const cov = labCoverageFixture();
    const aws3 = { exam: "SOA-C03" as const, areas: [{ key: "soa.reliability", name: "Reliability", labs: [{ id: "soa-03-auto-scaling", number: 3, title: "Auto Scaling", run: false }], run: 0, available: 1 }] };
    renderWithProviders(<CoverageMap bare />, { routes: { "GET /api/v1/labs/coverage": { exams: [...cov.exams, aws3] } } });
    const azure = within(await screen.findByRole("region", { name: "Azure" }));
    const awsSec = within(screen.getByRole("region", { name: "AWS" }));
    expect(azure.queryByRole("heading", { name: "SOA-C03" })).toBeNull();
    expect(azure.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(1);
    expect(awsSec.getByRole("heading", { name: "SOA-C03" })).toBeInTheDocument();
  });

  it("a running AWS lab's chip wears the AWS badge; an Azure lab's does not", async () => {
    const s = session({ labId: "soa-03-auto-scaling", title: "Auto Scaling behind an Application Load Balancer" });
    renderApp("/labs", { routes: { "GET /api/v1/labs": labs({ labs: [aws({ running: s }), card()], running: [s, session({ id: "ls-az", labId: "az104-06-blob-security", title: "Blob security" })] }) } });
    const strip = within(await screen.findByRole("region", { name: "Running labs" }));
    const awsChip = within(strip.getByRole("link", { name: /Auto Scaling/ }).closest("li")!);
    expect(awsChip.getByText("AWS")).toBeInTheDocument();
    const azChip = within(strip.getByRole("link", { name: /Blob security/ }).closest("li")!);
    expect(azChip.queryByText("AWS")).toBeNull();
  });
});
