"use client";

// Rotate the secrets Storeasy holds for a store (Phase 3 line 2): the
// order-link signing key and, only while the store has no members, the store
// console password. Nothing is ticked by default. A new password is shown
// once, here, with Copy; closing the dialog forgets it. The merchant's own
// keys are listed by name only: the store's team changes them in Settings.
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/kit/copy-button";
import { storeApi } from "./lifecycleWords";

const HINTS = {
  order_link_secret: "Order-status links already in customers' emails stop working. New emails get working links.",
  admin_password: "The shared password that opens the console before the store has team members.",
};

export default function RotateSecretsDialog({ store, lifecycle, open, onOpenChange, onDone }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { rotated, consolePassword? }

  const reset = () => {
    setPicked([]);
    setError(null);
    setResult(null);
  };
  const toggle = (key, on) => setPicked((p) => (on ? [...new Set([...p, key])] : p.filter((k) => k !== key)));

  async function submit(e) {
    e.preventDefault();
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await storeApi(store.id, { body: { rotate: { keys: picked } } });
      setResult({ rotated: r.rotated || [], consolePassword: r.consolePassword || null });
      setPicked([]);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const label = (key) => lifecycle.rotatable.find((r) => r.key === key)?.label || key;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        reset();
        onOpenChange(o);
      }}
    >
      <DialogContent data-dialog="rotate-secrets">
        <DialogHeader>
          <DialogTitle>Rotate secrets</DialogTitle>
          <DialogDescription>Only the keys Storeasy holds for {store.name} can be rotated here. Nothing is rotated unless you tick it.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm" data-rotate-result>
            <Alert variant="success">
              <AlertTitle>Rotated</AlertTitle>
              <AlertDescription>{result.rotated.map(label).join(" and ")}.</AlertDescription>
            </Alert>
            {result.consolePassword && (
              <div className="space-y-1.5">
                <p className="font-medium">New store console password</p>
                <p className="text-muted-foreground">It is shown only this once. Copy it now and give it to the store&apos;s owner over a safe channel.</p>
                <CopyButton value={result.consolePassword} label="the new console password" />
              </div>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4 text-sm">
            <fieldset className="space-y-3">
              <legend className="sr-only">Keys to rotate</legend>
              {lifecycle.rotatable.map((r) => {
                const blocked = r.key === "admin_password" && lifecycle.hasMembers;
                return (
                  <div key={r.key} className="flex items-start gap-3">
                    <Checkbox id={`rotate-${r.key}`} checked={picked.includes(r.key)} onCheckedChange={(v) => toggle(r.key, v === true)} disabled={blocked} aria-describedby={`rotate-${r.key}-hint`} className="mt-0.5" />
                    <div className="space-y-0.5">
                      <Label htmlFor={`rotate-${r.key}`}>{r.label}</Label>
                      <p id={`rotate-${r.key}-hint`} className="text-xs text-muted-foreground">
                        {blocked ? "The store has team members, so this password isn't used. Members change their own passwords." : HINTS[r.key]}
                        {!r.present && !blocked ? " None is set yet; this creates one." : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
            </fieldset>
            {picked.includes("order_link_secret") && (
              <Alert variant="warning">
                <AlertDescription>Customers who open an order link from an earlier email will see it fail. They can still sign in to see their orders.</AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5">
              <p className="font-medium">The store&apos;s own keys</p>
              <p className="text-xs text-muted-foreground">The store&apos;s team changes these in Settings.</p>
              <ul className="flex flex-wrap gap-1.5" data-merchant-keys>
                {lifecycle.merchantKeys.map((k) => (
                  <li key={k.name}>
                    <Badge variant="outline">
                      {k.name}
                      {k.present ? "" : " (not set)"}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">Shopify tokens can&apos;t be rotated here: they come from the store&apos;s Shopify app install.</p>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={!picked.length || busy} data-action="confirm-rotate">
                {busy ? "Rotating…" : "Rotate"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
