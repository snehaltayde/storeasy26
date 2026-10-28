"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";
import { Button, IconButton } from "./Button";
import { Input } from "./fields";

// Console dialogs (S50) on the NATIVE <dialog>: showModal() gives the focus
// trap, Escape handling and top-layer for free — no Radix, no portal code.
// These replace every window.confirm/prompt in the consoles, and add
// confirmation where destructive actions had none.

export function Dialog({ open, onClose, title, size = "md", children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e) => {
      e.preventDefault();
      onClose?.();
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [onClose]);
  // scroll lock while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClick={(e) => {
        if (e.target === ref.current) onClose?.(); // backdrop click
      }}
      className={cx(
        "m-auto w-full rounded-card border border-edge bg-surface p-0 text-fg shadow-overlay backdrop:bg-transparent",
        size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md"
      )}
    >
      {open && (
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <IconButton label="Close" icon={<X size={15} aria-hidden />} onClick={onClose} />
          </div>
          <div className="mt-3 text-sm text-fg-muted">{children}</div>
          {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// Confirmation with the dialog owning its in-flight state: onConfirm may be
// async; the confirm button shows busy and the dialog closes on success.
export function ConfirmDialog({ open, onClose, title, body, confirmLabel = "Confirm", tone = "primary", onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (open) {
      setBusy(false);
      setErr(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                onClose?.();
              } catch (e) {
                setErr(String(e?.message || e));
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </Dialog>
  );
}

// Destructive confirmation that requires typing a known string (tenant id,
// rule name) before the button enables — replaces prompt()-as-guard.
export function DangerDialog({ open, onClose, title, body, confirmLabel = "Delete", typedConfirmation, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
      setErr(null);
    }
  }, [open]);
  const armed = !typedConfirmation || typed.trim() === typedConfirmation;
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!armed}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await onConfirm();
                onClose?.();
              } catch (e) {
                setErr(String(e?.message || e));
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
      {typedConfirmation && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-fg-muted">
            Type <code className="rounded bg-surface-sunken px-1 font-mono text-[11px] text-fg">{typedConfirmation}</code> to confirm:
          </p>
          <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      )}
      {err && <p className="mt-2 text-xs text-danger">{err}</p>}
    </Dialog>
  );
}
