import { Skeleton } from "@/components";

/** Loading: the page's shape (header, five tiles, the rules table, the right column) in grey. */
export function FirewallSkeleton() {
  return (
    <div className="fw fw--loading" role="status" aria-label="Loading the firewall" aria-busy="true">
      <div className="fw-sk__head">
        <Skeleton variant="block" width={56} height={56} />
        <span className="fw-sk__titles">
          <Skeleton variant="line" width={160} height={26} />
          <Skeleton variant="line" width={320} />
        </span>
      </div>
      <div className="fw__kpis">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} variant="tile" />
        ))}
      </div>
      <div className="fw-sk__body">
        <div className="fw-sk__table" data-testid="rules-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} variant="row" />
          ))}
        </div>
        <Skeleton variant="block" height="100%" />
      </div>
    </div>
  );
}
