// result.ts
//
// Plain English: the answer shape shared by the dashboard's commands (add a
// client, publish a port, subscribe a phone...): either done, with a value,
// or refused, with a reason fit for the screen and the status the data API
// answers with. The old pages show the reason; the API sends it as JSON.

/** A refusal fit for the screen, with the status the API answers. */
export type Refusal = { ok: false; status: 400 | 404 | 409 | 422 | 502 | 503; code: string; message: string; field?: string };
export type Done<T> = { ok: true; value: T } | Refusal;

/** Build a refusal. */
export function no(status: Refusal["status"], code: string, message: string, field?: string): Refusal {
  return { ok: false, status, code, message, ...(field ? { field } : {}) };
}
