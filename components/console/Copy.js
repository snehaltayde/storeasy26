"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cx } from "./cx";
import { useToast } from "./Toast";

// Clipboard pieces (S50). SecretReveal is the house pattern for one-time
// values (provisioned passwords, invite codes, approval links): a mono
// well + copy button + an explicit "shown once" note — never a
// low-contrast inline string again.

export function CopyButton({ value, label = "Copy", size = 13, className = "" }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error("Couldn't copy — select the text instead");
        }
      }}
      className={cx("inline-flex shrink-0 items-center justify-center rounded-ctl p-1.5 text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg", className)}
    >
      {done ? <Check size={size} className="text-success" aria-hidden /> : <Copy size={size} aria-hidden />}
    </button>
  );
}

export function SecretReveal({ value, label, note = "Shown once — copy it now; it can't be retrieved later." }) {
  return (
    <div className="rounded-ctl border border-warning-edge bg-warning-bg/40 p-3">
      {label && <p className="mb-1 text-xs font-medium text-fg-muted">{label}</p>}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded bg-surface px-2.5 py-1.5 font-mono text-xs text-fg">{value}</code>
        <CopyButton value={value} label={`Copy ${label || "value"}`} />
      </div>
      <p className="mt-1.5 text-[11px] text-warning">{note}</p>
    </div>
  );
}
