"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { SEES_NOTHING, postApp } from "@/components/admin/apps/app-words";

// Install an app: what it does, every permission it asks for in APP_PERMISSIONS
// words (or that it can see nothing), then "Approve and install", which sends
// the permissions shown here as the ones approved. Installing changes nothing
// on the storefront by itself. On success the app's own page opens.
//   app: a catalog entry (GET /api/admin/apps catalog[]); open / onOpenChange
export function InstallDialog({ app, open, onOpenChange }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const change = (v) => {
    if (!v && busy) return; // Esc and Cancel wait for the request
    if (!v) setError(null);
    onOpenChange(v);
  };
  async function install() {
    setBusy(true);
    setError(null);
    const r = await postApp("apps", { install: { pluginId: app.id, scopes: app.scopes.map((s) => s.scope) } });
    setBusy(false);
    if (r.ok) {
      change(false);
      router.push(`/admin/apps/${encodeURIComponent(r.install.id)}`);
      router.refresh();
    } else setError(r.error);
  }
  if (!app) return null;
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-apps="install-dialog">
        <DialogHeader>
          <DialogTitle>{`Install ${app.name}?`}</DialogTitle>
          <DialogDescription>{app.description}</DialogDescription>
        </DialogHeader>
        <section aria-labelledby="install-scopes" className="space-y-2">
          <h3 id="install-scopes" className="text-sm font-medium text-foreground">
            What it can see
          </h3>
          {app.scopes.length ? (
            <ul className="space-y-1 text-sm text-foreground" data-apps="install-scopes">
              {app.scopes.map((s) => (
                <li key={s.scope} className="flex gap-2" data-scope={s.scope}>
                  <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {s.words}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground" data-apps="install-no-scopes">
              {SEES_NOTHING}
            </p>
          )}
          <p className="text-sm text-muted-foreground">Installing doesn't change your storefront. You choose what it shows, and nothing appears until you turn it on.</p>
        </section>
        <AppRefusal>{error}</AppRefusal>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => change(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={install} data-apps="approve-install">
            {busy ? "Installing…" : "Approve and install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
