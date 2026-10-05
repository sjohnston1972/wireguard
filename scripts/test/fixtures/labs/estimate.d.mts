// Types for estimate.mjs, so worker/test can import it.
export function estimateGbpH(items: readonly { gbp_h: number; qty?: number }[]): number;
export function costMarker(gbpH: number, deployMin: number): "£" | "££" | "£££";
