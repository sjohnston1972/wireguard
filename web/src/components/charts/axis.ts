// Shared x-axis tick choice for the SVG bar charts.

/**
 * Which bucket indexes get an axis label. A label is placed only where it
 * changes (the first bucket of each day when several buckets share a day), so
 * the same text never appears twice; when there are more of those than fit,
 * every Nth one is kept, evenly.
 */
export function axisTicks(labels: string[], maxTicks: number): number[] {
  const starts: number[] = [];
  labels.forEach((l, i) => {
    if (i === 0 || l !== labels[i - 1]) starts.push(i);
  });
  const fit = Math.max(1, Math.floor(maxTicks));
  if (starts.length <= fit) return starts;
  const stride = Math.ceil(starts.length / fit);
  return starts.filter((_, k) => k % stride === 0);
}
