// Types for scripts/topology-capture.mjs, so TypeScript tests (worker/test) can import it.

export const FAKE_SUBSCRIPTION: string;
/** The Resource Graph columns a capture keeps as they are. */
export const CAPTURE_COLUMNS: readonly string[];
/** Property paths the live rules read ("[]" = every member of a list). */
export const CAPTURE_KEEP: readonly string[];
export function captureRows(
  rows: readonly Record<string, unknown>[],
  opts: { labId: string; ids: readonly string[]; owns: (labId: string, group: string, ids: readonly string[]) => boolean; keep?: readonly string[] },
): Record<string, unknown>[];
