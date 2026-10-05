// views/labs/testData.ts
//
// Plain English: lab cards, sessions and details for the Labs tab's tests,
// built on the shared fixtures (web/src/test/fixtures.ts). Times are around
// the fixtures' NOW (2026-10-02 12:00 UTC); GET /labs answers `now` = NOW, and
// the tab's clock follows the server's, so "time left" is the same on any day.

import type { LabCard, LabDetail, LabRunRow, LabSession, LabsResponse } from "@shared/api";
import { labDetailFixture, labSessionFixture, labsFixture } from "@/test/fixtures";

export const NOW = "2026-10-02T12:00:00.000Z";
export const NOW_MS = Date.parse(NOW);
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const at = (msFromNow: number) => new Date(NOW_MS + msFromNow).toISOString();

/** A catalogue card: lab 6 by default, not running, never run. */
export const card = (over: Partial<LabCard> = {}): LabCard => ({ ...labDetailFixture().card, running: null, lastSession: null, runs: 0, ...over });

export const session = (over: Partial<LabSession> = {}): LabSession => labSessionFixture(over);

/** A run of a session; a deploy at step 3 of 16 by default. */
export const run = (over: Partial<LabRunRow> = {}): LabRunRow => ({
  id: "lab-deploy-20261002115500-a5d1",
  sessionId: "ls-20261002115500-a5r1",
  labId: "az104-05-storage",
  action: "deploy",
  status: "running",
  requestedAt: at(-5 * MIN),
  requestedBy: "dev@localhost",
  reason: null,
  startedAt: at(-4 * MIN),
  finishedAt: null,
  githubRunUrl: null,
  error: null,
  step: { done: 3, of: 16, name: "Start live log" },
  ...over,
});

/** Five labs over both exams, out of order, as a catalogue might list them. */
export const catalogue = (): LabCard[] => [
  card({ id: "az305-20-landing-zone", number: 20, exam: "AZ-305", title: "Landing zone: management groups and policy", skillAreas: ["az305.governance"], level: "expert", type: "explore", estGbpH: 0.42, marker: "££", pricey: null, prerequisites: [], released: true, version: 1 }),
  card({ id: "az104-06-blob-security", number: 6, released: false, version: 2, runs: 2, prerequisites: ["az104-05-storage"] }),
  card({
    id: "az104-05-storage",
    number: 5,
    title: "Storage accounts: redundancy, access tiers, lifecycle",
    summary: "Two storage accounts, LRS hot and GRS cool, and a lifecycle policy.",
    skillAreas: ["az104.storage"],
    level: "foundation",
    prerequisites: [],
    peering: "off",
    estGbpH: 0.0004,
    released: true,
  }),
  card({
    id: "az104-07-file-share",
    number: 7,
    title: "Azure Files: SMB share mounted on a VM",
    skillAreas: ["az104.storage", "az104.compute"],
    type: "break-fix",
    estGbpH: 1.1,
    marker: "£££",
    pricey: { item: "Azure Firewall", gbpH: 0.95 },
    timing: { deployMin: 35, destroyMin: 20, sessionH: 2, maxH: 4 },
    prerequisites: [],
    released: true,
  }),
  card({ id: "az104-01-identity", number: 1, title: "Users, groups and a custom role", skillAreas: ["az104.identity"], level: "foundation", prerequisites: [], released: true, runs: 1 }),
];

export const labs = (over: Partial<LabsResponse> = {}): LabsResponse => labsFixture({ labs: catalogue(), ...over });

/** GET /labs/:id for a lab with no live session (lab 6). */
export const detailIdle = (over: Partial<LabDetail> = {}): LabDetail =>
  labDetailFixture({ card: card({ runs: 2 }), session: null, runs: [], resources: null, portalUrl: null, ...over });

export const detailRunning = (over: Partial<LabDetail> = {}): LabDetail => labDetailFixture(over);
