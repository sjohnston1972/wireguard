import { QueryClient } from "@tanstack/react-query";
import { ApiError, SessionExpiredError } from "./client";

/** Try again with backoff for a flaky link or a 5xx; never for a 4xx (the answer will not change) or an expired session. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof SessionExpiredError) return false;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 3;
}

/** 1 s, 2 s, 4 s ... capped at 30 s. */
export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay,
        // Polling pauses while the tab is hidden and a refetch happens on return.
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: true,
        staleTime: 5_000,
      },
      mutations: { retry: false },
    },
  });
}
