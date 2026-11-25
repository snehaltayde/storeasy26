"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "@/components/ui/utils";

// docs/UI.md "Feedback": toasts are transient action results only (saved,
// synced, copied). Anything the user must act on (validation, conflicts,
// permission, degraded states) is a persistent Alert instead. One provider,
// mounted in the console root layout (app/(console)/layout.js); errors stay
// 8 seconds, the rest 5, and at most four show at once.

const ToastCtx = createContext(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  // a missing provider never crashes a page: it degrades to console.warn
  return ctx || { success: (m) => console.warn("toast:", m), error: (m) => console.warn("toast:", m), info: (m) => console.warn("toast:", m) };
}

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info };
const ICON_TONES = { success: "text-success", error: "text-destructive", info: "text-info" };
const EDGE_TONES = { success: "border-success/30", error: "border-destructive/30", info: "border-border" };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const push = useCallback(
    (kind, message) => {
      const id = crypto.randomUUID();
      setToasts((t) => [...t.slice(-3), { id, kind, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), kind === "error" ? 8000 : 5000));
    },
    [dismiss]
  );

  const api = useMemo(() => ({ success: (m) => push("success", m), error: (m) => push("error", m), info: (m) => push("info", m) }), [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div data-kit="toasts" aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = ICONS[t.kind] || Info;
          return (
            <div key={t.id} data-toast={t.kind} className={cn("pointer-events-auto flex items-start gap-2.5 rounded-card border bg-popover p-3 text-sm text-popover-foreground shadow-overlay", EDGE_TONES[t.kind] || EDGE_TONES.info)}>
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", ICON_TONES[t.kind])} />
              <p className="min-w-0 flex-1 leading-snug break-words">{t.message}</p>
              <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
