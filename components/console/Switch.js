"use client";

import { Loader2 } from "lucide-react";
import { cx } from "./cx";

// Accessible switch (S50): role=switch + aria-checked + a real pending
// state (re-toggle blocked while a request is in flight). Replaces the two
// hand-built lime toggles.
export function Switch({ checked, onChange, pending = false, disabled = false, label, className = "" }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      onClick={() => onChange?.(!checked)}
      className={cx(
        "relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full focus-ring motion-safe:transition-colors disabled:cursor-not-allowed",
        checked ? "bg-primary" : "bg-edge-strong",
        pending && "opacity-70",
        className
      )}
    >
      <span
        className={cx(
          "flex size-4 items-center justify-center rounded-full bg-surface shadow-card motion-safe:transition-transform",
          checked ? "translate-x-[1.375rem]" : "translate-x-0.5"
        )}
      >
        {pending && <Loader2 size={10} className="motion-safe:animate-spin text-fg-subtle" aria-hidden />}
      </span>
    </button>
  );
}
