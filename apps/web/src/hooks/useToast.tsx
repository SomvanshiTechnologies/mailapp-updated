import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { errorMessage } from "../lib/api";

export type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (kind: ToastKind, message: string) => void;
  success: (message: string) => void;
  error: (err: unknown, prefix?: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let seq = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = seq++;
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);

  const value = useMemo<ToastApi>(
    () => ({
      push,
      success: (m) => push("success", m),
      info: (m) => push("info", m),
      error: (err, prefix) => push("error", prefix ? `${prefix}: ${errorMessage(err)}` : errorMessage(err)),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-md " +
              (t.kind === "success"
                ? "border-green-200 bg-green-50 text-green-900"
                : t.kind === "error"
                  ? "border-red-200 bg-red-50 text-red-900"
                  : "border-gray-200 bg-white text-gray-800")
            }
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
