"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RoleGate } from "@/components/kit/role-gate";
import { APP_PERMISSIONS } from "@/lib/platform/authz";
import { SUBSCRIBABLE, TOPICS } from "@/lib/plugins/topics";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { SecretOnce } from "@/components/admin/apps/SecretOnce";
import { NO_MANAGE, postApp } from "@/components/admin/apps/app-words";

// "Create custom app" (Phase 4 line 3): a button (admin and owner; RoleGate'd
// for staff and support) that opens a dialog with the app's name, its HTTPS
// address, the events to send and the permission they need ("See your
// orders, without customer details", required by every order event, so it is
// shown checked and fixed). On success the dialog shows the signing secret
// once (SecretOnce) and "Open the app"; the secret never leaves this dialog.
//   role: the actor's role
const EMPTY = { name: "", url: "", topics: [...SUBSCRIBABLE] };

export function CustomAppDialog({ role }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [errors, setErrors] = useState({});
  const [made, setMade] = useState(null); // { install, secret }
  const change = (v) => {
    if (!v) {
      if (made) router.refresh();
      setForm(EMPTY);
      setError(null);
      setErrors({});
      setMade(null);
    }
    setOpen(v);
  };
  const toggleTopic = (t, on) => setForm((f) => ({ ...f, topics: on ? [...new Set([...f.topics, t])] : f.topics.filter((x) => x !== t) }));
  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const r = await postApp("apps", { create_custom: { name: form.name, url: form.url, topics: form.topics, scopes: ["orders.read"] } });
    setBusy(false);
    if (r.ok) setMade({ install: r.install, secret: r.secret });
    else {
      setError(r.error);
      setErrors(r.errors || {});
    }
  }
  return (
    <>
      <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
        <Button type="button" variant="outline" onClick={() => change(true)} data-apps="create-custom">
          <Plus aria-hidden="true" />
          Create custom app
        </Button>
      </RoleGate>
      <Dialog open={open} onOpenChange={(v) => !busy && change(v)}>
        <DialogContent data-apps="custom-dialog" className="sm:max-w-lg" onInteractOutside={made ? (e) => e.preventDefault() : undefined}>
          {made ? (
            <>
              <DialogHeader>
                <DialogTitle>{`${made.install.name} is connected`}</DialogTitle>
                <DialogDescription>Store events are signed and sent to its address from now on.</DialogDescription>
              </DialogHeader>
              <SecretOnce secret={made.secret} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => change(false)}>
                  Close
                </Button>
                <Button
                  type="button"
                  data-apps="open-custom"
                  onClick={() => {
                    const id = made.install.id;
                    change(false);
                    router.push(`/admin/apps/${encodeURIComponent(id)}`);
                  }}
                >
                  Open the app
                </Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={create} className="space-y-4" noValidate>
              <DialogHeader>
                <DialogTitle>Create a custom app</DialogTitle>
                <DialogDescription>Connect your own service. Storeasy sends it the store events you choose, signed so it can tell they came from your store.</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="custom-app-name">Name</Label>
                <Input id="custom-app-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={Boolean(errors.name) || undefined} aria-describedby={errors.name ? "custom-app-name-error" : undefined} />
                {errors.name && (
                  <p id="custom-app-name-error" className="text-[13px] text-destructive">
                    {errors.name}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-app-url">Webhook address</Label>
                <Input id="custom-app-url" type="url" inputMode="url" placeholder="https://example.com/webhooks" className="font-mono" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} aria-invalid={Boolean(errors.url) || undefined} aria-describedby="custom-app-url-hint" />
                <p id="custom-app-url-hint" className={errors.url ? "text-[13px] text-destructive" : "text-[13px] text-muted-foreground"}>
                  {errors.url || "A public HTTPS address. Storeasy only ever sends to this host."}
                </p>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">Events to send</legend>
                {SUBSCRIBABLE.map((t) => (
                  <div key={t} className="flex items-start gap-2">
                    <Checkbox id={`custom-topic-${t}`} checked={form.topics.includes(t)} onCheckedChange={(v) => toggleTopic(t, v === true)} data-topic={t} />
                    <Label htmlFor={`custom-topic-${t}`} className="font-normal leading-snug">
                      <span className="font-mono text-xs">{t}</span>
                      <span className="block text-muted-foreground">{TOPICS[t].words}</span>
                    </Label>
                  </div>
                ))}
                {errors.topics && <p className="text-[13px] text-destructive">{errors.topics}</p>}
              </fieldset>
              <section aria-labelledby="custom-perms" className="space-y-2">
                <h3 id="custom-perms" className="text-sm font-medium text-foreground">
                  What it can see
                </h3>
                <div className="flex items-start gap-2">
                  <Checkbox id="custom-perm-orders" checked disabled aria-describedby="custom-perm-orders-why" data-scope="orders.read" />
                  <Label htmlFor="custom-perm-orders" className="font-normal leading-snug">
                    <span className="flex gap-1.5">
                      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      {APP_PERMISSIONS["orders.read"]}
                    </span>
                    <span id="custom-perm-orders-why" className="block text-muted-foreground">
                      Needed for order events. Names, emails, phone numbers and addresses are never sent.
                    </span>
                  </Label>
                </div>
              </section>
              <AppRefusal>{error && !errors.name && !errors.url && !errors.topics ? error : null}</AppRefusal>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => change(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy} data-apps="create-custom-go">
                  {busy ? "Creating…" : "Approve and create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
