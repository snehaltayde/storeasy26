"use client";

// Rotate the secrets Storeasy holds for a store (Phase 3 line 2): the
// order-link signing key and, only while the store has no members, the store
// console password. Nothing is ticked by default. A new password is shown
// once, here, with Copy; closing the dialog forgets it. The merchant's own
// keys are listed by name only: the store's team changes them in Settings.
import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/kit/copy-button";
import { ROTATE_EFFECTS, storeApi } from "./lifecycleWords";

const HINTS = {
  order_link_secret: "Signs shopper sign-ins and sessions, order links, preview links and maintenance passes.",
  admin_password: "The shared password that opens the console before the store has team members.",
};

export default function RotateSecretsDialog({ store, lifecycle, open, onOpenChange, onDone }) {
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { rotated, consolePassword? }
  const resultHeading = useRef(null);
  // the result replaces the form: move focus to it so it is read out first
  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);

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
      <DialogContent data-dialog="rotate-secrets" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Rotate secrets</DialogTitle>
          <DialogDescription>Only the keys Storeasy holds for {store.name} can be rotated here. Nothing is rotated unless you tick it.</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm" data-rotate-result>
            <Alert variant="success">
              <AlertTitle ref={result.consolePassword ? undefined : resultHeading} tabIndex={result.consolePassword ? undefined : -1} className="outline-none">
                Rotated
              </AlertTitle>
              <AlertDescription>{result.rotated.map(label).join(" and ")}.</AlertDescription>
            </Alert>
            {result.consolePassword && (
              <section className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" aria-labelledby="new-password-heading" data-one-time-secret>
                <h3 id="new-password-heading" ref={resultHeading} tabIndex={-1} className="flex items-center gap-2 font-semibold outline-none">
                  <KeyRound aria-hidden className="size-4 text-warning" /> New store console password
                </h3>
                <p className="font-medium text-warning-text">You won&apos;t see this again. Copy it now: closing this dialog forgets it.</p>
                <p className="text-muted-foreground">Give it to the store&apos;s owner over a safe channel. If it is lost, rotate the password again.</p>
                <CopyButton value={result.consolePassword} label="the new console password" />
              </section>
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
                  <div
                    key={r.key}
                    className={`flex items-start gap-3 rounded-md border p-3 ${picked.includes(r.key) ? "border-destructive/50 bg-destructive/5" : "border-border"} ${blocked ? "opacity-70" : ""}`}
                  >
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
            {picked.length > 0 && (
              <Alert variant="warning" data-rotate-impact>
                <ShieldAlert aria-hidden />
                <AlertTitle>What changes when you rotate</AlertTitle>
                <AlertDescription>
                  <ul className="space-y-1">
                    {picked.flatMap((k) => ROTATE_EFFECTS[k] || [label(k)]).map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 font-medium">This can&apos;t be undone.</p>
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-1.5 border-t border-border pt-4">
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
                {busy ? "Rotating…" : picked.length > 1 ? `Rotate ${picked.length} secrets` : "Rotate secret"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
