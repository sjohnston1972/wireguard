import { useSyncExternalStore } from "react";

// What the browser last learned about its link to the dashboard. The API
// client updates it on every request; the shell reads it to show the
// disconnected banner and the session-expired screen.

export interface ConnectionState {
  /** The last request could not reach the dashboard at all. */
  disconnected: boolean;
  /** Cloudflare Access (or the API) said the sign-in has lapsed. */
  sessionExpired: boolean;
}

const INITIAL: ConnectionState = { disconnected: false, sessionExpired: false };
let state: ConnectionState = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<ConnectionState>) {
  const merged = { ...state, ...next };
  if (merged.disconnected === state.disconnected && merged.sessionExpired === state.sessionExpired) return;
  state = merged;
  listeners.forEach((l) => l());
}

export const connection = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** A request got an answer from the dashboard. */
  reached: () => set({ disconnected: false }),
  /** A request got an ordinary answer: the link and the session are both fine. */
  ok: () => set({ disconnected: false, sessionExpired: false }),
  unreachable: () => set({ disconnected: true }),
  expired: () => set({ sessionExpired: true, disconnected: false }),
};

export function resetConnection() {
  state = INITIAL;
  listeners.forEach((l) => l());
}

export function useConnection(): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.get, connection.get);
}
