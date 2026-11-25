"use client";

// Phase 3 line 6: what the Operations tabs share. opsGet/opsPost call
// /api/platform/<path>, send a signed-out operator back to the sign-in, and
// throw a plain sentence on failure. LoadError and Notice are the tabs' error
// and result lines; ConfirmDialog is the one confirmation for a write that
// can't be taken back (typed: the text the operator must type first). It stays
// open while the write runs and shows a failure inside it.
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";

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
  const idLike = typed && /^[a-z0-9_-]+$/.test(typed); // a run id reads in mono; a store's name doesn't

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
      <AlertDialogContent
        data-ops-confirm-dialog
        onOpenAutoFocus={(e) => {
          // A typed confirmation opens on its field; otherwise Radix focuses Cancel.
          if (!typed) return;
          e.preventDefault();
          document.getElementById("ops-confirm-text")?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <TriangleAlert aria-hidden />
          </AlertDialogMedia>
          <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {typed && (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <Label htmlFor="ops-confirm-text" className="block text-[0.8125rem] leading-snug font-normal">
              {typedLabel || "Type"} <span className={`font-semibold break-words text-foreground select-all ${idLike ? "font-mono" : ""}`}>{typed}</span> to confirm
            </Label>
            <Input
              id="ops-confirm-text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className={`bg-background ${idLike ? "font-mono" : ""}`}
              aria-invalid={typed && text.trim().length >= typed.length && !ready ? true : undefined}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && confirm()}
            />
          </div>
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
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
