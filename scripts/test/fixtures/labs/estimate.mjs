// scripts/test/fixtures/labs/estimate.mjs
//
// Plain English: a lab's £ per hour from its authored cost items, and the
// card's marker, exactly as shared/labs.ts estimateGbpH and costMarker work
// (that file is TypeScript the node tests cannot import). A Worker test
// (worker/test/labs-read.test.ts) keeps the two equal; content.mjs uses these.

/** £ per hour from the authored figures: Σ gbp_h × qty, rounded to 6 places. */
export function estimateGbpH(items) {
  const sum = items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  return Math.round(sum * 1e6) / 1e6;
}

/** £ under £0.05/h, ££ under £0.50/h, £££ from £0.50/h or a deploy of 30 minutes or more. */
export function costMarker(gbpH, deployMin) {
  if (gbpH >= 0.5 || deployMin >= 30) return "£££";
  return gbpH >= 0.05 ? "££" : "£";
}
