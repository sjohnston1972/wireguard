import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { SettingsValues } from "@shared/api";
import { useSaveSettings } from "@/api/mutations";

// The page's unsaved edits. Settings are saved in one PUT per section, so the
// edits are kept here by the API's own key names (snake_case, as the Worker's
// PUT /settings wants them) and compared with what the server holds. A key
// whose edit equals the server's value is not an edit at all, so typing a
// value back is "clean" again, and Save sends only keys that really differ.

type Val = string | boolean;

interface FieldDef {
  read: (v: SettingsValues) => Val;
}

const num = (n: number): string => String(n);

export const FIELDS: Record<string, FieldDef> = {
  region: { read: (v) => v.region },
  vm_size: { read: (v) => v.vmSize },
  test_vm: { read: (v) => v.testVm },
  auto_destroy_default_hours: { read: (v) => num(v.autoDestroyDefaultHours) },
  expiry_action: { read: (v) => v.expiryAction },
  standby_max_days: { read: (v) => num(v.standbyMaxDays) },
  idle_destroy_minutes: { read: (v) => num(v.idleDestroyMinutes) },
  monthly_budget_gbp: { read: (v) => num(v.monthlyBudgetGbp) },
  ssh_allowed_cidr: { read: (v) => v.sshAllowedCidr },
};

/** Which settings belong to which section (a section with none has no form). */
export const SECTION_KEYS: Record<string, string[]> = {
  deployment: ["region", "vm_size", "test_vm"],
  automation: ["auto_destroy_default_hours", "expiry_action", "standby_max_days", "idle_destroy_minutes", "monthly_budget_gbp"],
  security: ["ssh_allowed_cidr"],
};

export interface Edits {
  /** The value to show: the edit if there is one, else the server's. */
  value: <T extends Val>(key: string) => T;
  set: (key: string, v: Val) => void;
  isDirty: (section: string) => boolean;
  discard: (section: string) => void;
  save: (section: string) => void;
  saving: boolean;
  fieldError: (key: string) => string | undefined;
}

const Ctx = createContext<Edits | null>(null);
export const useEdits = (): Edits => {
  const e = useContext(Ctx);
  if (!e) throw new Error("useEdits outside EditsProvider");
  return e;
};

export function EditsProvider({ values, children }: { values: SettingsValues; children: ReactNode }) {
  const [edits, setEdits] = useState<Record<string, Val>>({});
  const mut = useSaveSettings();
  const server = useCallback((key: string): Val => FIELDS[key]!.read(values), [values]);

  const value = useCallback(<T extends Val>(key: string): T => (key in edits ? edits[key] : server(key)) as T, [edits, server]);
  const set = useCallback(
    (key: string, v: Val) =>
      setEdits((cur) => {
        const next = { ...cur };
        if (v === server(key)) delete next[key];
        else next[key] = v;
        return next;
      }),
    [server],
  );
  const dirtyKeys = useCallback((section: string) => (SECTION_KEYS[section] ?? []).filter((k) => k in edits), [edits]);
  const isDirty = useCallback((section: string) => dirtyKeys(section).length > 0, [dirtyKeys]);
  const discard = useCallback(
    (section: string) => {
      mut.reset();
      setEdits((cur) => {
        const next = { ...cur };
        for (const k of SECTION_KEYS[section] ?? []) delete next[k];
        return next;
      });
    },
    [mut],
  );
  const save = useCallback(
    (section: string) => {
      const keys = dirtyKeys(section);
      if (!keys.length || mut.isPending) return;
      const body = Object.fromEntries(keys.map((k) => [k, edits[k]!]));
      // The input is kept on failure (nothing is removed until the server says yes).
      mut.mutate(body, {
        onSuccess: () =>
          setEdits((cur) => {
            const next = { ...cur };
            for (const k of keys) if (next[k] === body[k]) delete next[k];
            return next;
          }),
      });
    },
    [dirtyKeys, edits, mut],
  );

  const api = useMemo<Edits>(
    () => ({ value, set, isDirty, discard, save, saving: mut.isPending, fieldError: (k) => mut.fieldError(k) }),
    [value, set, isDirty, discard, save, mut],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
