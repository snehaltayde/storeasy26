"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cx } from "./cx";
import { IconButton } from "./Button";

// Slide-in panel (S50) on the same native <dialog> base as Dialog.js —
// focus trap, Escape and top-layer for free. Used for the mobile nav
// drawer; available for detail panels.
export function Drawer({ open, onClose, side = "left", title, children, width = "18rem" }) {
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
        if (e.target === ref.current) onClose?.();
      }}
      style={{ width, maxWidth: "85vw" }}
      className={cx(
        "fixed inset-y-0 m-0 h-full max-h-none border-edge bg-surface p-0 text-fg shadow-overlay",
        side === "left" ? "left-0 right-auto border-r" : "left-auto right-0 border-l"
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-edge px-4 py-3">
            <p className="text-sm font-semibold">{title}</p>
            <IconButton label="Close menu" icon={<X size={15} aria-hidden />} onClick={onClose} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}
