"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cx } from "./cx";

// Console toasts (S50): transient action results ONLY (saved, synced,
// copied, adopted). Anything the user must act on — validation, conflicts,
// permission, degraded states — is a persistent Banner instead. One
// provider, mounted in the console root layout.

const ToastCtx = createContext(null);

export function useToast() {
  const ctx = useContext(ToastCtx);
  // a missing provider should never crash a page — degrade to console.warn
  return ctx || { success: (m) => console.warn("toast:", m), error: (m) => console.warn("toast:", m), info: (m) => console.warn("toast:", m) };
}

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info };
const TONES = {
  success: "border-success-edge bg-surface text-fg",
  error: "border-danger-edge bg-surface text-fg",
  info: "border-edge bg-surface text-fg",
};
const ICON_TONES = { success: "text-success", error: "text-danger", info: "text-info" };

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
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === "error" ? 8000 : 5000)
      );
    },
    [dismiss]
  );

  const api = useMemo(() => ({ success: (m) => push("success", m), error: (m) => push("error", m), info: (m) => push("info", m) }), [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      {/* Phase 0 line 8: an old component, so an old-token region */}
      <div data-legacy className="contents">
        <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {toasts.map((t) => {
            const Icon = ICONS[t.kind] || Info;
            return (
              <div key={t.id} className={cx("pointer-events-auto flex items-start gap-2.5 rounded-card border p-3 text-sm shadow-overlay", TONES[t.kind] || TONES.info)}>
                <Icon size={15} className={cx("mt-0.5 shrink-0", ICON_TONES[t.kind])} aria-hidden />
                <p className="min-w-0 flex-1 break-words leading-snug">{t.message}</p>
                <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="shrink-0 rounded p-0.5 text-fg-subtle focus-ring hover:text-fg">
                  <X size={13} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}
