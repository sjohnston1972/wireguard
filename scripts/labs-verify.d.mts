// Types for scripts/labs-verify.mjs, so TypeScript tests (worker/test) can import it.

export const LAB_UNITS: readonly string[];
export const NOT_LINUX_PAYG: RegExp;
export function readmeLinks(md: string): string[];
export function meterProblems(rows: readonly Record<string, unknown>[], item: { meter: string; unit?: string }, region?: string): string[];
export function skuProblems(rows: readonly Record<string, unknown>[], sku: string, region?: string): string[];
export function verifyLabs(
  labs: readonly { id: string; readme: string; secondary?: string | null; items: readonly { name: string; gbp_h: number; region?: "secondary"; retail?: { meter?: string; unit?: string; sku?: string } }[] }[],
  opts?: { links?: boolean; meters?: boolean; fetch?: typeof fetch },
): Promise<{ problems: string[]; lines: string[] }>;
