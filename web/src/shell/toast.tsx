import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import "./toast.css";

// A small toast host for the data layer's mutation outcomes. Deliberately
// plain (live regions, timers, a close button) so the shell does not depend on
// the component library; it can adopt the library's Toast later behind the
// same `useToast()` interface.

export type ToastKind = "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** Second line, such as the half that did not work. */
  detail?: string;
}

interface ToastApi {
  show: (kind: ToastKind, text: string, detail?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const LIFETIME_MS: Record<ToastKind, number> = { success: 5000, warning: 9000, error: 9000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const show = useCallback((kind: ToastKind, text: string, detail?: string) => {
    const id = next.current++;
    setItems((l) => [...l.slice(-3), { id, kind, text, detail }]);
  }, []);
  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <section className="toasts" aria-label="Notifications">
        {items.map((t) => (
          <ToastView key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </section>
    </ToastContext.Provider>
  );
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), LIFETIME_MS[item.kind]);
    return () => clearTimeout(timer);
  }, [item, onDismiss]);
  const Icon = item.kind === "success" ? CheckCircle2 : item.kind === "warning" ? AlertTriangle : XCircle;
  return (
    <div className="toast" data-kind={item.kind} role={item.kind === "error" ? "alert" : "status"}>
      <Icon className="toast__icon" size={18} aria-hidden="true" />
      <div className="toast__body">
        <p className="toast__text">{item.text}</p>
        {item.detail ? <p className="toast__detail">{item.detail}</p> : null}
      </div>
      <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => onDismiss(item.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

const NOOP: ToastApi = { show: () => {} };

/** Show a toast. Outside a ToastProvider this does nothing (so hooks work in isolation). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
