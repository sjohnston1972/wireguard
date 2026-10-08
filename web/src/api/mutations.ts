import { useMutation, useQueryClient, type QueryClient, type QueryKey, type UseMutationResult } from "@tanstack/react-query";
import type {
  ApiOk,
  BootLogResponse,
  ClientConfigResponse,
  ClientEditResponse,
  DraftApplyBody,
  DraftDefaultBody,
  DraftFromDropBody,
  DraftMoveBody,
  DraftRuleBody,
  HealthCheckResponse,
  LabDeployBody,
  LabDestroyBody,
  LabExtendBody,
  LabNoteBody,
  LabOrphanCleanupBody,
  LabPermissionsCheckResponse,
  LabSecretResponse,
  RestorePreviewResponse,
  SimRequest,
  SimResult,
} from "@shared/api";
import { ApiError, NetworkError, SessionExpiredError, apiGet, apiSend } from "./client";
import { BOOTLOG_KEY } from "./queries";
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
  /** Put the answer into the cache yourself (for example the boot log), after a success and before the invalidations. */
  store?: (qc: QueryClient, res: R, v: V) => void;
  /** Query keys to refresh after a failure that says the shown data is out of date (for example a 409). */
  invalidateOnError?: (err: Error) => QueryKey[];
}

export function useApiMutation<V = void, R = ApiOk>(cfg: Config<V, R>): ApiMutation<V, R> {
  const qc = useQueryClient();
  const { toast } = useToast();
  const m = useMutation<R, Error, V>({
    mutationFn: (v) => apiSend<R>(cfg.method, typeof cfg.path === "function" ? cfg.path(v) : cfg.path, cfg.body ? cfg.body(v) : undefined),
    onSuccess: (res, v) => {
      cfg.store?.(qc, res, v);
      const text = cfg.message ? cfg.message(res, v) : (res as Partial<ApiOk>).message ?? null;
      const warning = (res as Partial<ApiOk>).warning;
      if (warning) toast({ tone: "warning", title: text ?? "Saved, with a warning.", description: warning });
      else if (text) toast({ tone: "success", title: text });
      for (const key of cfg.invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      for (const key of cfg.invalidateOnError?.(err) ?? []) void qc.invalidateQueries({ queryKey: key });
      // The sign-in screen already says so; a field error is shown by its form.
      if (err instanceof SessionExpiredError) return;
      // Writes are never re-sent by themselves, so say plainly that this one was not sent.
      if (err instanceof NetworkError) {
        toast({ tone: "error", title: NOT_SENT });
        return;
      }
      if (err instanceof ApiError && err.field) return;
      // Demo mode (the client guard, or the Worker's 409): not a failure, the actions are off by design.
      if (err instanceof ApiError && err.code === "demo_mode") {
        toast({ tone: "warning", title: err.message });
        return;
      }
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
/** Ask the VM for an on-demand self-test. Its result arrives in /overview's snapshot (selftest_req, then selftest). */
export const useHealthCheck = () => useApiMutation<void, HealthCheckResponse>({ method: "POST", path: "/health-check", invalidate: [["overview"]] });
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
/** What the firewall would do with one flow, against the live rules or (`policy: "draft"`) the draft. Changes nothing: no toast, nothing refreshed; the result is the caller's to show. */
export const useSimulate = () => useApiMutation<SimRequest, SimResult>({ method: "POST", path: "/firewall/simulate", body: (v) => v, invalidate: [], message: () => null });

// ── Firewall: the draft (spec §6) ──
// Rule edits change only the draft, so they show no success toast: the draft
// bar's change count and the row marks say what happened. Errors still toast
// (a field error is left to its form). Apply, discard and "Allow" on a drop
// show the server's message.
const DRAFT: QueryKey[] = [["firewall"]];
const quiet = () => null;
export const useDraftAddRule = () => useApiMutation<DraftRuleBody>({ method: "POST", path: "/firewall/draft/rules", body: (v) => v, invalidate: DRAFT, message: quiet });
export const useDraftEditRule = () =>
  useApiMutation<{ id: number } & Partial<DraftRuleBody>>({ method: "PUT", path: (v) => `/firewall/draft/rules/${v.id}`, body: ({ id: _id, ...rest }) => rest, invalidate: DRAFT, message: quiet });
/** `{id, dir: "up"|"down"}` or `{id, to}` (0-based index in the draft list). */
export const useDraftMoveRule = () =>
  useApiMutation<{ id: number } & DraftMoveBody>({ method: "POST", path: (v) => `/firewall/draft/rules/${v.id}/move`, body: ({ id: _id, ...rest }) => rest, invalidate: DRAFT, message: quiet });
export const useDraftDeleteRule = () => useApiMutation<number>({ method: "DELETE", path: (id) => `/firewall/draft/rules/${id}`, invalidate: DRAFT, message: quiet });
export const useDraftDefault = () => useApiMutation<DraftDefaultBody>({ method: "PUT", path: "/firewall/draft/default", body: (v) => v, invalidate: DRAFT, message: quiet });
export const useDraftFromDrop = () => useApiMutation<DraftFromDropBody>({ method: "POST", path: "/firewall/draft/from-drop", body: (v) => v, invalidate: DRAFT });
/** 409 (ApiError.status) when the live rules changed since the draft began; 422 field "rules" for a broken rule. */
export const useDraftApply = () =>
  useApiMutation<DraftApplyBody>({
    method: "POST",
    path: "/firewall/draft/apply",
    body: (v) => v,
    invalidate: [["firewall"], ["overview"], ["activity"]],
    // A stale draft: fetch the firewall at once, so the page shows the draft as out of date.
    invalidateOnError: (err) => (err instanceof ApiError && err.status === 409 ? [["firewall"]] : []),
  });
export const useDraftDiscard = () => useApiMutation({ method: "DELETE", path: "/firewall/draft", invalidate: DRAFT });

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

// ── Azure insights ──
/**
 * POST /azure/bootlog: fetch the VM's boot log from Azure now (the Worker
 * allows one a minute; a 429 slow_down shows its message as a toast). The
 * answer replaces the cached GET /azure/bootlog, so useBootLog shows it at once.
 */
export const useFetchBootLog = () =>
  useApiMutation<void, BootLogResponse>({ method: "POST", path: "/azure/bootlog", invalidate: [], message: () => null, store: (qc, res) => qc.setQueryData(BOOTLOG_KEY, res) });

// ── Labs (labs spec §7.2, plan L0) ──
// Each refreshes every "labs" query, the Overview (banner, topology, the
// runningLabs widget) and Activity (lab runs). A lab id is the route's :id.
const LABS: QueryKey[] = [["labs"], ["overview"], ["activity"]];
const labPost = <V,>(path: (v: V) => string, body?: (v: V) => unknown) => ({ method: "POST" as const, path, body, invalidate: LABS });
const labPath = (id: string, action: string) => `/labs/${encodeURIComponent(id)}/${action}`;

/** Deploy: `{ id, hours, peer, region?, overBudgetOk?, capacityOk? }`; 422 confirm_required asks for an override. */
export const useDeployLab = () =>
  useApiMutation<{ id: string } & LabDeployBody>({
    ...labPost<{ id: string } & LabDeployBody>(({ id }) => labPath(id, "deploy"), ({ id: _id, ...rest }) => rest),
    // A refusal (409 unavailable, 422 confirm_required) means the cards' blockers and warnings are out of date (labs redesign spec §13.4).
    invalidateOnError: () => [["labs"]],
  });
/** Extend: `{ id, hours }` or `{ id, toMax: true }`; refused past max_until, saying until when. */
export const useExtendLab = () => useApiMutation<{ id: string } & LabExtendBody>(labPost(({ id }) => labPath(id, "extend"), ({ id: _id, ...rest }) => rest));
/** Tear down (after the confirm dialog); also cancels a deploy in progress. */
export const useDestroyLab = () => useApiMutation<string>(labPost((id) => labPath(id, "destroy"), (): LabDestroyBody => ({ confirm: true })));
export const usePeerLab = () => useApiMutation<string>(labPost((id) => labPath(id, "peer")));
export const useUnpeerLab = () => useApiMutation<string>(labPost((id) => labPath(id, "unpeer")));
/** A real-Azure release test (Settings → Labs → Test, after a confirm). */
export const useTestLab = () => useApiMutation<string>(labPost((id) => labPath(id, "test")));
/** Cancel the active run, then destroy. */
export const useCancelLab = () => useApiMutation<string>(labPost((id) => labPath(id, "cancel")));
/** One peer run per waiting or disconnected session. */
export const useRePeerLabs = () => useApiMutation<void>(labPost(() => "/labs/repeer"));
export const useSaveLabNote = () =>
  useApiMutation<{ sid: string } & LabNoteBody>({ method: "PUT", path: (v) => `/labs/sessions/${encodeURIComponent(v.sid)}/note`, body: ({ sid: _sid, ...rest }) => rest, invalidate: LABS });
export const useCleanupLabOrphans = () => useApiMutation<LabOrphanCleanupBody>(labPost(() => "/labs/orphans/cleanup", (v) => v));
/** Settings → Labs → Check permissions; refreshes Settings too. */
export const useCheckLabPermissions = () =>
  useApiMutation<void, LabPermissionsCheckResponse>({ method: "POST", path: "/labs/permissions/check", invalidate: [...LABS, ["settings"]] });
/**
 * A running lab's admin password and user names, fetched when Show is pressed: no toast, nothing
 * refreshed, and not kept: gcTime 0 drops the answer from the mutation cache as soon as nothing
 * shows it (call reset() on Hide; unmounting lets it go too).
 */
export const useLabSecret = () => useMutation<LabSecretResponse, Error, string>({ mutationFn: (id) => apiGet<LabSecretResponse>(`/labs/${encodeURIComponent(id)}/secret`), gcTime: 0 });

/** The SSH password is fetched only when pressed; no toast, no cache. */
export const fetchSshPassword = () => apiGet<{ password: string }>("/ssh-password");
