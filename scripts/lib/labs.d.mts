// Types for scripts/lib/labs.mjs, so TypeScript tests (worker/test) can import it.
// The shapes it builds are the ones in shared/labs.ts.

import type { LabCatalogue, LabDef, LabExam, ReadmeBlock, SkillArea } from "../../shared/labs";

export interface LabProblem {
  lab: string | null;
  file: string;
  field: string | null;
  message: string;
}
export interface TfProblem {
  file: string;
  line: number;
  rule: "literal-cidr" | "provisioner" | "provider" | "gateway";
  message: string;
}

export const LAB_ID_RE: RegExp;
export const LAB_ID_MAX: number;
export const LAB_EXAMS: readonly LabExam[];
export function examOfId(id: string): LabExam;
export function computeExams(def: Pick<LabDef, "exam" | "skill_areas">, skillAreas: SkillArea[]): LabExam[];
export const LAB_POOL: string;
export const LAB_SLOTS: number;
export const GATEWAY_RANGES: readonly string[];
export const GOVERNANCE_LABS: readonly string[];
export const AVNM_LABS: readonly string[];
export const FLOW_LOG_LABS: readonly string[];
export const LAB_TF_VARS: readonly string[];
export const ALLOWED_ROLES: { builtIn: { name: string; id: string }[]; custom: { lab: string; name: string; id: string }[]; principalTypes: string[] };

export function readmeFooter(id: string): string;
export function cidrOverlaps(a: string, b: string): boolean;
export function slotCidr(n: number): string;
export function checkPool(ranges?: readonly string[]): string[];
export function parseLabYaml(text: string): { raw: Record<string, unknown> | null; problems: { field: string | null; message: string }[] };
export function validateLab(raw: unknown, ctx: { folder?: string; skillAreas: SkillArea[] }): { def: LabDef | null; problems: { field: string | null; message: string }[] };
export function parseReadme(md: string, type: LabDef["type"], id: string | null): { blocks: ReadmeBlock[]; problems: string[] };
export function lintTfText(files: Record<string, string>): TfProblem[];
export function variablesProblems(tf: string): string[];
export function labFolders(root: string): string[];
export function buildCatalogue(root: string): { catalogue: LabCatalogue; problems: LabProblem[] };
export function versionProblems(labsDir: string, base: string): LabProblem[];
