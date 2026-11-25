"use client";

import { useEffect, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

// "Asks first" for the offers and bundles screens (docs/UI.md: AlertDialog for
// every destructive action): stays open while onConfirm runs, closes when it
// resolves, and shows its error in plain words when it throws (nothing on the
// page is lost). Esc and Cancel close it; focus returns to the opener.
export function ConfirmAction({ open, onOpenChange, title, body, confirmLabel, destructive = false, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const change = (v) => {
    if (busy) return;
    setError(null);
    onOpenChange(v);
  };
  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{body}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? "destructive" : "default"} disabled={busy} onClick={confirm}>
            {busy ? "Working…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// fetch JSON; a refusal throws its plain words (the server's, or a fallback)
export async function sendJson(url, method, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error("That didn't go through. Check your connection and try again."), { body: {} });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "That didn't work. Try again."), { status: res.status, body: data });
  return data;
}

// Leaving with unsaved changes asks first: a reload or closing the tab
// (beforeunload), and a link inside the console (a capture listener, before
// Next's Link sees the click). Returns a ref: set .current = true before a
// navigation the page makes itself (after a save).
export function useLeaveGuard(dirty) {
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (e) => {
      if (leaving.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e) => {
      const a = e.target?.closest?.("a[href]");
      if (!a || leaving.current || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (window.confirm("Leave without saving? The changes you made here will be lost.")) leaving.current = true;
      else {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);
  return leaving;
}
