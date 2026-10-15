// aws.test.tsx
//
// Plain English: AWS labs on the Labs tab (AWS labs spec §10): the header
// names both clouds, a Cloud filter narrows the cards and the exam list,
// AWS cards wear an AWS badge and read "AWS 3", the coverage map has an
// Azure and an AWS heading, and an AWS lab's modal deploys to London with
// console links and the same-cloud connect note.

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { LabsHeader, LABS_SUBTITLE } from "./LabsHeader";
import { applyFilters, examsFor, labNumberWord, NO_FILTERS, readFilters } from "./model";
import { LabCard } from "./LabCard";
import { ExamCoverage } from "./CoverageMap";
import { labView } from "./contract";
import { labTopics } from "./topics";
import { card, session } from "./testData";
import { labDetailFixture } from "@/test/fixtures";
import { DeployFormView } from "./DeployForm";
import { RunningLabView } from "./RunningLab";

const aws = (over = {}) => card({ id: "soa-03-auto-scaling", number: 3, title: "Auto Scaling behind an Application Load Balancer", cloud: "aws", exam: "SOA-C03", exams: ["SOA-C03", "SAA-C03"], ...over });

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
    const d = labDetailFixture({ card: aws(), cloud: "aws", secondaryRegion: null, defaults: { region: "eu-west-2", peer: true, hours: 2 }, connect: { possible: false, note: "AWS labs connect only to an AWS server (the server is in Azure). This lab runs unconnected." } });
    renderWithProviders(<DeployFormView d={d} />);
    expect(screen.queryByLabelText(/region/i, { selector: "input" })).toBeNull();
    expect(screen.getByText("Region: London (eu-west-2)")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /peer/i })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /peer/i })).toBeNull();
    expect(screen.getByText(/AWS labs connect only to an AWS server/)).toBeInTheDocument();
  });

  it("names the second region when the lab has one", () => {
    const d = labDetailFixture({ card: aws(), cloud: "aws", secondaryRegion: "eu-west-1", defaults: { region: "eu-west-2", peer: true, hours: 2 } });
    renderWithProviders(<DeployFormView d={d} />);
    expect(screen.getByText("Region: London (eu-west-2), and Ireland (eu-west-1) for the second region")).toBeInTheDocument();
  });

  it("a running AWS lab links to its console group per region and explains the connect lines", () => {
    const d = labDetailFixture({
      card: aws({ running: session({ labId: "soa-03-auto-scaling", state: "running" }) }),
      cloud: "aws",
      portalUrl: null,
      consoleUrls: [{ region: "eu-west-2", label: "London", url: "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-03-auto-scaling?region=eu-west-2" }],
      session: session({ labId: "soa-03-auto-scaling", state: "running", outputs: { privateIps: { "vm-web": "10.64.64.10" }, connect: ["aws ec2-instance-connect ssh --instance-id i-0abc --os-user labadmin --connection-type eice", "ssh labadmin@10.64.64.10"], users: {} } }),
    });
    renderWithProviders(<RunningLabView d={d} />);
    const link = screen.getByRole("link", { name: "Open in AWS console (London)" });
    expect(link).toHaveAttribute("href", "https://eu-west-2.console.aws.amazon.com/resource-groups/group/lab-soa-03-auto-scaling?region=eu-west-2");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /portal/i })).toBeNull();
    expect(screen.getByText(/the aws ec2-instance-connect line works anywhere/)).toBeInTheDocument();
  });
});
