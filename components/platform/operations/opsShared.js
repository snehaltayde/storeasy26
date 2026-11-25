"use client";

// Phase 3 line 6: what the Operations tabs share. opsGet/opsPost call
// /api/platform/<path>, send a signed-out operator back to the sign-in, and
// throw a plain sentence on failure. LoadError and Notice are the tabs' error
// and result lines; ConfirmDialog is the one confirmation for a write that
// can't be taken back (typed: the text the operator must type first). It stays
// open while the write runs and shows a failure inside it.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const OFFLINE = "The console couldn't reach the server. Check your connection and try again.";

async function call(path, init) {
  let res;
  try {
    res = await fetch(`/api/platform/${path}`, { cache: "no-store", ...init });
  } catch {
    throw new Error(OFFLINE);
  }
  if (res.status === 401) {
    window.location.assign("/platform");
    throw new Error("Your operator session has ended. Sign in again.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error && res.status !== 500 ? body.error : "Something went wrong on the server. Try again in a moment.");
    err.body = body;
    throw err;
  }
  return body;
}

export const opsGet = (path) => call(path);
export const opsPost = (path, body) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export function LoadError({ what, error, onRetry }) {
  return (
    <Alert variant="destructive" data-ops-error>
      <AlertTitle>We couldn&apos;t load {what}.</AlertTitle>
      <AlertDescription>
        <p>{error}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

// notice: { tone: "success" | "error", text } or null
export function Notice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <Alert variant={notice.tone === "error" ? "destructive" : "default"} role={notice.tone === "error" ? "alert" : "status"} data-ops-notice={notice.tone}>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{notice.text}</span>
        {onClose && (
          <Button size="xs" variant="ghost" onClick={onClose}>
            Dismiss
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, typed = null, typedLabel = null, onConfirm }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ready = !typed || text.trim() === typed;

  function change(next) {
    if (busy) return;
    if (!next) {
      setText("");
      setError(null);
    }
    onOpenChange(next);
  }

  async function confirm() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      setText("");
      onOpenChange(false);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {typed && (
          <div className="space-y-1.5">
            <Label htmlFor="ops-confirm-text" className="text-[0.8125rem]">
              {typedLabel || "Type"} <span className="font-mono font-semibold text-foreground">{typed}</span> to confirm
            </Label>
            <Input id="ops-confirm-text" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirm()} />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!ready || busy} onClick={confirm} data-ops-confirm>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const when = (iso) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
