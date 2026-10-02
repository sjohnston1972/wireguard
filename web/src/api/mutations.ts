import { useMutation, useQueryClient, type QueryKey, type UseMutationResult } from "@tanstack/react-query";
import type { ApiOk, ClientConfigResponse, ClientEditResponse, RestorePreviewResponse } from "@shared/api";
import { ApiError, NetworkError, SessionExpiredError, apiGet, apiSend } from "./client";
// The app's one toast system (mounted once in App.tsx). Imported directly, not
// through the @/components barrel, so the data layer does not pull in charts.
import { useToast } from "@/components/feedback/Toast";

// One hook per write endpoint. Each one: sends the request, shows the server's
// message as a toast (a `warning` as a warning toast), refreshes the queries
// the change touches, exposes `isPending` (disable submit on it) and
// `fieldError(name)` (the server's message for the input at fault).

export type Body = Record<string, unknown>;

/** The toast for a write that could not reach the server (writes are never retried). */
export const NOT_SENT = "Not sent — couldn't reach wg-admin. Try again.";

/** The server's complaint about one input, for a form to show beside it. */
export function fieldErrorOf(error: unknown, field: string): string | undefined {
  return error instanceof ApiError && error.field === field ? error.message : undefined;
}

export type ApiMutation<V, R> = UseMutationResult<R, Error, V> & { fieldError: (field: string) => string | undefined };

interface Config<V, R> {
  method: "POST" | "PUT" | "DELETE";
  path: string | ((v: V) => string);
  /** The request body from the variables; leave out to send no body. */
  body?: (v: V) => unknown;
  /** Query keys (prefixes) to refresh after a success. */
  invalidate: QueryKey[];
  /** The success toast text; defaults to the response's `message`. Return null for none. */
  message?: (res: R, v: V) => string | null;
}

export function useApiMutation<V = void, R = ApiOk>(cfg: Config<V, R>): ApiMutation<V, R> {
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = useMutation<R, Error, V>({
    mutationFn: (v) => apiSend<R>(cfg.method, typeof cfg.path === "function" ? cfg.path(v) : cfg.path, cfg.body ? cfg.body(v) : undefined),
    onSuccess: (res, v) => {
      const text = cfg.message ? cfg.message(res, v) : (res as Partial<ApiOk>).message ?? null;
      const warning = (res as Partial<ApiOk>).warning;
      if (warning) toast({ tone: "warning", title: text ?? "Saved, with a warning.", description: warning });
      else if (text) toast({ tone: "success", title: text });
      for (const key of cfg.invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      // The sign-in screen already says so; a field error is shown by its form.
      if (err instanceof SessionExpiredError) return;
      // Writes are never re-sent by themselves, so say plainly that this one was not sent.
      if (err instanceof NetworkError) {
        toast({ tone: "error", title: NOT_SENT });
        return;
      }
      if (err instanceof ApiError && err.field) return;
      toast({ tone: "error", title: err.message });
    },
  });
  return Object.assign(m, { fieldError: (field: string) => fieldErrorOf(m.error, field) });
}

const RUN = [["overview"], ["activity"], ["session"]] as const satisfies QueryKey[];
const run = <V = void>(path: string, body?: (v: V) => unknown) => ({ method: "POST" as const, path, body, invalidate: [...RUN] });

// ── Lifecycle ──
export interface DeployVars {
  hours?: number | null;
  profileId?: number | null;
  region?: string | null;
  overBudgetOk?: boolean;
}
export const useDeploy = () => useApiMutation<DeployVars>(run<DeployVars>("/deploy", (v) => v));
export const useMove = () => useApiMutation<{ profileId: number }>(run<{ profileId: number }>("/move", (v) => v));
export const useHibernate = () => useApiMutation(run("/hibernate"));
export const useResume = () => useApiMutation<{ hours?: number | null } | void>(run<{ hours?: number | null } | void>("/resume", (v) => v ?? undefined));
export const useDestroy = () => useApiMutation<{ confirm: string }>(run<{ confirm: string }>("/destroy", (v) => v));
export const useCleanup = () => useApiMutation(run("/cleanup"));
export const useCancel = () => useApiMutation(run("/cancel"));
export const useReconcile = () => useApiMutation(run("/reconcile"));
export const useExtend = () => useApiMutation<{ hours: number | null }>(run<{ hours: number | null }>("/extend", (v) => v));
export const useSpeedTest = () => useApiMutation(run("/speedtest"));
export const useAllowSsh = () => useApiMutation(run("/allow-ssh"));
/** `quiet` skips the toast, for when opening the notes marks them read as a matter of course. */
export const useAckNotes = (opts: { quiet?: boolean } = {}) =>
  useApiMutation<void>({ method: "POST", path: "/notes/ack", invalidate: [["session"], ["activity"]], message: () => (opts.quiet ? null : "Notes marked as read.") });

// ── Clients ──
const CLIENTS: QueryKey[] = [["clients"], ["overview"], ["firewall"]];
export const useAddClient = () =>
  useApiMutation<Body, ClientConfigResponse>({ method: "POST", path: "/clients", body: (v) => v, invalidate: CLIENTS, message: (r) => `Added ${r.peer.name}.` });
export const useRekeyClient = () =>
  useApiMutation<{ id: number; public_key: string }, ClientConfigResponse>({
    method: "POST",
    path: (v) => `/clients/${v.id}/rekey`,
    body: (v) => ({ public_key: v.public_key }),
    invalidate: CLIENTS,
    message: (r) => `Re-keyed ${r.peer.name}.`,
  });
export const useEditClient = () =>
  useApiMutation<{ id: number } & Body, ClientEditResponse>({
    method: "PUT",
    path: (v) => `/clients/${v.id}`,
    body: ({ id: _id, ...rest }) => rest,
    invalidate: CLIENTS,
    message: (r) => `Saved ${r.peer.name}.`,
  });
export const useDeleteClient = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/clients/${id}`, invalidate: CLIENTS });

// ── Firewall: published ports and captures (instant) ──
const FIREWALL: QueryKey[] = [["firewall"], ["overview"]];
export const useForwardAdd = () => useApiMutation<Body>({ method: "POST", path: "/firewall/forwards", body: (v) => v, invalidate: FIREWALL });
export const useForwardEdit = () =>
  useApiMutation<{ id: number } & Body>({ method: "PUT", path: (v) => `/firewall/forwards/${v.id}`, body: ({ id: _id, ...rest }) => rest, invalidate: FIREWALL });
export const useForwardDelete = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/firewall/forwards/${id}`, invalidate: FIREWALL });
export const useStartCapture = () => useApiMutation<Body>({ method: "POST", path: "/firewall/captures", body: (v) => v, invalidate: FIREWALL });
export const useClearCounters = () => useApiMutation({ method: "POST", path: "/firewall/counters/clear", invalidate: FIREWALL });

// ── Settings, profiles, schedules, lock ──
const SETTINGS: QueryKey[] = [["settings"], ["overview"]];
export const useSaveSettings = () => useApiMutation<Body>({ method: "PUT", path: "/settings", body: (v) => v, invalidate: SETTINGS });
export const useAddProfile = () => useApiMutation<Body>({ method: "POST", path: "/profiles", body: (v) => v, invalidate: SETTINGS });
export const useEditProfile = () =>
  useApiMutation<{ id: number } & Body>({ method: "PUT", path: (v) => `/profiles/${v.id}`, body: ({ id: _id, ...rest }) => rest, invalidate: SETTINGS });
export const useDeleteProfile = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/profiles/${id}`, invalidate: SETTINGS });
export const useAddSchedule = () => useApiMutation<Body>({ method: "POST", path: "/schedules", body: (v) => v, invalidate: SETTINGS });
export const useEditSchedule = () =>
  useApiMutation<{ id: number } & Body>({ method: "PUT", path: (v) => `/schedules/${v.id}`, body: ({ id: _id, ...rest }) => rest, invalidate: SETTINGS });
export const useDeleteSchedule = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/schedules/${id}`, invalidate: SETTINGS });
export const useReleaseLock = () => useApiMutation({ method: "POST", path: "/lock/release", invalidate: [["settings"], ["overview"]] });

// ── Backup restore (the preview changes nothing, so it does not toast) ──
export const useRestorePreview = () =>
  useApiMutation<Body, RestorePreviewResponse>({ method: "POST", path: "/backup/restore/preview", body: (v) => v, invalidate: [], message: () => null });
export const useRestoreConfirm = () =>
  useApiMutation<{ token: string; confirm: string }>({ method: "POST", path: "/backup/restore/confirm", body: (v) => v, invalidate: [["settings"], ["clients"], ["firewall"], ["overview"], ["activity"]] });

// ── Phone alerts ──
const PUSH: QueryKey[] = [["push"], ["settings"]];
export const usePushSubscribe = () => useApiMutation<Body>({ method: "POST", path: "/push/subscribe", body: (v) => v, invalidate: PUSH });
export const usePushUnsubscribe = () => useApiMutation<{ endpoint: string }>({ method: "POST", path: "/push/unsubscribe", body: (v) => v, invalidate: PUSH });
export const usePushTest = () => useApiMutation({ method: "POST", path: "/push/test", invalidate: [] });
export const usePushRemove = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/push/${id}`, invalidate: PUSH });

/** The SSH password is fetched only when pressed; no toast, no cache. */
export const fetchSshPassword = () => apiGet<{ password: string }>("/ssh-password");
