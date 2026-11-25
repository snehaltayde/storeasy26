"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyButton } from "@/components/kit/copy-button";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { postApp } from "@/components/admin/apps/app-words";

// Create an API token for a custom app (Phase 4 line 4). Name, the
// permissions (only the ones the app was given; all checked), and how long it
// lasts (30, 90 or 365 days). On success the dialog shows the token once with
// a Copy box: Storeasy keeps only a hash of it. The token lives only in this
// component's state and is dropped when the dialog closes.
//   open, onOpenChange; installId; view: GET /api/admin/apps/[id]/tokens
//   onCreated(): re-read the card
export function CreateTokenDialog({ open, onOpenChange, installId, view, onCreated }) {
  const fresh = () => ({ name: "", scopes: view.scopes.map((s) => s.scope), days: String(view.defaultExpiryDays) });
  const [form, setForm] = useState(fresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [errors, setErrors] = useState({});
  const [made, setMade] = useState(null);

  function change(v) {
    if (!v) {
      setForm(fresh());
      setError(null);
      setErrors({});
      setMade(null);
    }
    onOpenChange(v);
  }
  const toggle = (scope, on) => setForm((f) => ({ ...f, scopes: on ? [...new Set([...f.scopes, scope])] : f.scopes.filter((s) => s !== scope) }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const r = await postApp(`apps/${encodeURIComponent(installId)}/tokens`, { create: { name: form.name, scopes: form.scopes, days: Number(form.days) } });
    setBusy(false);
    if (!r.ok) {
      setError(r.errors ? null : r.error);
      setErrors(r.errors || {});
      return;
    }
    setMade({ name: r.token.name, secret: r.secret });
    onCreated?.();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && change(v)}>
      <DialogContent data-apps="token-dialog" className="sm:max-w-lg">
        {made ? (
          <>
            <DialogHeader>
              <DialogTitle>{`${made.name} is ready`}</DialogTitle>
              <DialogDescription>Your app sends this token in the Authorization header as "Bearer" followed by the token.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2" data-apps="token-once">
              <Alert variant="warning">
                <KeyRound aria-hidden="true" />
                <AlertTitle>Copy the token now</AlertTitle>
                <AlertDescription>This is the only time it's shown. Storeasy keeps only a fingerprint of it, so it can't be shown again. If you lose it, revoke it and create a new one.</AlertDescription>
              </Alert>
              <CopyButton value={made.secret} label="the API token" id="api-token" />
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => change(false)} data-apps="token-done">
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Create an API token</DialogTitle>
              <DialogDescription>The token lets this app read your store through the Storeasy API. Every call it makes is recorded.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="token-name">Name</Label>
              <Input id="token-name" value={form.name} maxLength={60} placeholder="For example: Warehouse sync" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "token-name-error" : undefined} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              {errors.name && (
                <p id="token-name-error" className="text-[13px] text-destructive">
                  {errors.name}
                </p>
              )}
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What it can see</legend>
              {view.scopes.length ? (
                view.scopes.map((s) => (
                  <div key={s.scope} className="flex items-start gap-2">
                    <Checkbox id={`token-scope-${s.scope}`} checked={form.scopes.includes(s.scope)} onCheckedChange={(v) => toggle(s.scope, v === true)} data-scope={s.scope} />
                    <Label htmlFor={`token-scope-${s.scope}`} className="font-normal leading-snug">
                      {s.words}
                    </Label>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">This app wasn't given any permissions, so the token can only tell it its own name.</p>
              )}
              <p className="text-[13px] text-muted-foreground">Customer names, emails, phone numbers and addresses are never shared through the API.</p>
              {errors.scopes && <p className="text-[13px] text-destructive">{errors.scopes}</p>}
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="token-days">Expires after</Label>
              <Select value={form.days} onValueChange={(v) => setForm((f) => ({ ...f, days: v }))}>
                <SelectTrigger id="token-days" className="w-48" data-apps="token-days">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {view.expiryDays.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {`${d} days`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.days && <p className="text-[13px] text-destructive">{errors.days}</p>}
            </div>
            <AppRefusal>{error}</AppRefusal>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} data-apps="token-create">
                {busy ? "Creating…" : "Create token"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
