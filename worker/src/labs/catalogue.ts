// labs/catalogue.ts
//
// Plain English: the list of labs this Worker knows. It is built from the
// labs/ folders by `npm run labs-build` (shared/labs.generated.json) and
// bundled with the Worker, so a new lab or version needs a Worker deploy
// (labs spec §7.1, §15 item 9). Tests swap in their own with
// setCatalogueForTest. Frozen: only the contract (plan L0) changes this file.

import generated from "../../../shared/labs.generated.json";
import type { LabCatalogue, LabDef, ReadmeBlock } from "../../../shared/labs";

let override: LabCatalogue | null = null;

/** The catalogue: labs sorted by primary exam (AZ-104, AZ-305, AZ-700) then number, the skill areas and each lab's readme blocks. */
export function catalogue(): LabCatalogue {
  return override ?? (generated as unknown as LabCatalogue);
}

/** One lab's definition, or null when the catalogue has no such id. */
export function labDef(id: string): LabDef | null {
  return catalogue().labs.find((l) => l.id === id) ?? null;
}

/** One lab's readme blocks ([] when the lab is unknown). */
export function labReadme(id: string): ReadmeBlock[] {
  return catalogue().readmes[id] ?? [];
}

/** Every catalogue id (for ownsName and labIdFromName in shared/labs.ts). */
export function labIds(): string[] {
  return catalogue().labs.map((l) => l.id);
}

/** Tests only: use this catalogue until called again with null. */
export function setCatalogueForTest(cat: LabCatalogue | null): void {
  override = cat;
}
