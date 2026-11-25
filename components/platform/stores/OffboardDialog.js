"use client";

// Offboard a store (Phase 3 line 2), through POST tenants/<id>/offboard: the
// stages listed in order, what is kept, and the store id typed back (the
// server checks it too).
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OFFBOARD_KEPT, OFFBOARD_STAGES, storeApi } from "./lifecycleWords";

export default function OffboardDialog({ store, open, onOpenChange, onDone }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const match = typed.trim() === store.id;

  async function submit(e) {
    e.preventDefault();
    if (!match || busy) return;
    setBusy(true);
    setError(null);
    try {
      await storeApi(store.id, { path: "/offboard", method: "POST", body: { confirm: store.id } });
      setTyped("");
      onOpenChange(false);
      onDone(`${store.name} is offboarded.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setTyped("");
        setError(null);
        onOpenChange(o);
      }}
    >
      <AlertDialogContent data-dialog="offboard">
        <form onSubmit={submit} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>Offboard {store.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                <p>This runs, in order:</p>
                <ol className="list-decimal space-y-1 pl-5" data-offboard-stages>
                  {OFFBOARD_STAGES.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <p>{OFFBOARD_KEPT}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="offboard-confirm">
              Type the store id <span className="font-mono">{store.id}</span> to confirm
            </Label>
            <Input id="offboard-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={busy}>
              Cancel
            </AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={!match || busy} data-action="confirm-offboard">
              {busy ? "Offboarding…" : "Offboard store"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
