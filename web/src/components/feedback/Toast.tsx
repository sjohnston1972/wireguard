import * as RadixToast from "@radix-ui/react-toast";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import "./Toast.css";

export type ToastTone = "success" | "warning" | "error" | "info";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** ms; 0 keeps it until dismissed. Defaults: 4 s success/info, 8 s warning, 10 s error. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const WORDS: Record<ToastTone, string> = { success: "Success", warning: "Warning", error: "Error", info: "Info" };
const ICONS = { success: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };
const DEFAULT_MS: Record<ToastTone, number> = { success: 4000, info: 4000, warning: 8000, error: 10000 };

const Ctx = createContext<{ toast: (t: ToastInput) => void } | null>(null);

/** Toasts summarise outcomes; long tasks keep in-page progress (spec 10). Mount once near the root. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const toast = useCallback((t: ToastInput) => {
    setItems((cur) => [...cur.slice(-4), { ...t, id: nextId.current++ }]);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  const remove = (id: number) => setItems((cur) => cur.filter((x) => x.id !== id));

  return (
    <Ctx.Provider value={value}>
      <RadixToast.Provider swipeDirection="right" label="Notifications">
        {children}
        {items.map((t) => {
          const tone = t.tone ?? "info";
          const Icon = ICONS[tone];
          const ms = t.duration ?? DEFAULT_MS[tone];
          return (
            <RadixToast.Root
              key={t.id}
              className={`toast toast--${tone}`}
              data-tone={tone}
              duration={ms === 0 ? Infinity : ms}
              onOpenChange={(open) => {
                if (!open) remove(t.id);
              }}
            >
              <Icon size={18} aria-hidden className="toast__icon" />
              <div className="toast__text">
                <span className="visually-hidden">{WORDS[tone]}</span>
                <RadixToast.Title className="toast__title">{t.title}</RadixToast.Title>
                {t.description && <RadixToast.Description className="toast__desc">{t.description}</RadixToast.Description>}
              </div>
              <RadixToast.Close className="toast__close" aria-label="Dismiss">
                <X size={15} aria-hidden />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        <RadixToast.Viewport className="toast__viewport" />
      </RadixToast.Provider>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
