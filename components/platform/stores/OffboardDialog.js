"use client";

// Offboard a store (Phase 3 line 2), through POST tenants/<id>/offboard: the
// stages listed in order, what is kept, and the store id typed back (the
// server checks it too).
import { useState } from "react";
import { Archive, Check } from "lucide-react";
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
      <AlertDialogContent data-dialog="offboard" className="sm:max-w-md">
        <form onSubmit={submit} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>Offboard {store.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                <p className="font-medium text-foreground">Shoppers lose the storefront and the team loses the console straight away. The key changes and the deleted jobs can&apos;t be undone.</p>
                <p>It runs, in order:</p>
                <ol className="space-y-2" data-offboard-stages>
                  {OFFBOARD_STAGES.map((s, i) => (
                    <li key={s} className="flex gap-2.5">
                      <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 font-mono text-xs font-medium text-destructive">
                        {i + 1}
                      </span>
                      <span className="text-foreground">{s}</span>
                    </li>
                  ))}
                </ol>
                <p className="flex gap-2.5 rounded-md bg-muted p-2.5">
                  <Archive aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span>{OFFBOARD_KEPT}</span>
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="offboard-confirm">
              Type the store id <span className="font-mono">{store.id}</span> to confirm
            </Label>
            <div className="relative">
              <Input id="offboard-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="pr-8 font-mono" aria-describedby="offboard-confirm-state" />
              {match && <Check aria-hidden className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-success" />}
            </div>
            <p id="offboard-confirm-state" className="sr-only" aria-live="polite">
              {match ? "The id matches." : ""}
            </p>
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
