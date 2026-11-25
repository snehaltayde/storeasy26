"use client";

// The store page's lifecycle card (Phase 3 line 2): suspend or resume (with a
// reason), maintenance on or off (with the shoppers' message and a preview),
// rotate secrets, edit details, Sync catalog now, Export and Offboard. Each
// action goes through /api/platform/tenants/<id>, which audits it; after one,
// the page is read again (router.refresh), so the card, the status badge and
// Recent activity show the new state at once.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download, KeyRound, Pause, Pencil, Play, RefreshCw, Trash2, Wrench } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/kit/copy-button";
import { useToast } from "@/components/kit/toast";
import EditStoreDialog from "./EditStoreDialog";
import OffboardDialog from "./OffboardDialog";
import RotateSecretsDialog from "./RotateSecretsDialog";
import { DEFAULT_MAINTENANCE_MESSAGE, REASON_MIN, SUSPEND_EFFECTS, mailWords, storeApi } from "./lifecycleWords";

function StatusDialog({ store, lifecycle, open, onOpenChange, onDone }) {
  const suspending = lifecycle.status === "active";
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const short = reason.trim().length < REASON_MIN;

  async function submit(e) {
    e.preventDefault();
    if (short || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await storeApi(store.id, { body: { status: suspending ? "suspended" : "active", reason: reason.trim() } });
      setReason("");
      onOpenChange(false);
      onDone(`${store.name} is ${suspending ? "suspended" : "active again"}. ${mailWords(r.mail)}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent data-dialog="store-status">
        <form onSubmit={submit} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>{suspending ? `Suspend ${store.name}?` : `Resume ${store.name}?`}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                {suspending ? (
                  <ul className="list-disc space-y-1 pl-5">
                    {SUSPEND_EFFECTS.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                ) : (
                  <p>The storefront and the console open again, and waiting jobs run. Other servers can take up to 30 seconds to apply it.</p>
                )}
                <p>{lifecycle.mailReady ? "The owner is emailed." : "Email isn't set up on this server, so the owner won't be told."}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="status-reason">Reason (for the audit log, not sent to the owner)</Label>
            <Textarea id="status-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} aria-describedby="status-reason-hint" required />
            <p id="status-reason-hint" className="text-xs text-muted-foreground">
              At least {REASON_MIN} characters.
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
            {/* a plain submit: AlertDialogAction would close before the answer */}
            <Button type="submit" variant={suspending ? "destructive" : "default"} disabled={short || busy} data-action={suspending ? "confirm-suspend" : "confirm-resume"}>
              {busy ? "Working…" : suspending ? "Suspend store" : "Resume store"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MaintenanceDialog({ store, lifecycle, open, onOpenChange, onDone }) {
  const on = lifecycle.maintenance.enabled;
  const [enabled, setEnabled] = useState(on);
  const [message, setMessage] = useState(lifecycle.maintenance.message || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await storeApi(store.id, { body: { maintenance: enabled ? { enabled: true, message: message.trim() } : { enabled: false } } });
      onOpenChange(false);
      onDone(enabled ? `Maintenance is on. Shoppers see the maintenance page.` : "Maintenance is off. Shoppers see the store again.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        if (o) {
          setEnabled(on);
          setMessage(lifecycle.maintenance.message || "");
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent data-dialog="store-maintenance">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Maintenance</DialogTitle>
            <DialogDescription>Shoppers see a maintenance page and checkout closes. The store&apos;s team can still sign in and work.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="maintenance-on">Maintenance on</Label>
            <Switch id="maintenance-on" checked={enabled} onCheckedChange={setEnabled} />
          </div>
          {enabled && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="maintenance-message">Message for shoppers</Label>
                <Textarea id="maintenance-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} rows={3} placeholder={DEFAULT_MAINTENANCE_MESSAGE} />
                <p className="text-xs text-muted-foreground">Leave it empty for the default message. Up to 300 characters.</p>
              </div>
              <figure className="space-y-1.5" data-maintenance-preview>
                <figcaption className="text-xs font-medium text-muted-foreground">Preview</figcaption>
                <div className="rounded-md border border-border bg-muted px-4 py-6 text-center">
                  <p className="text-xs font-medium text-muted-foreground">{store.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Scheduled maintenance</p>
                  <p className="mt-2 text-sm whitespace-pre-wrap">{message.trim() || DEFAULT_MAINTENANCE_MESSAGE}</p>
                </div>
              </figure>
            </>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (enabled === on && (!on || message.trim() === (lifecycle.maintenance.message || "")))} data-action="save-maintenance">
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function LifecycleCard({ store, lifecycle }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(null); // "status" | "maintenance" | "rotate" | "edit" | "offboard"
  const [busy, setBusy] = useState(null); // "sync" | "export"
  const [sync, setSync] = useState(null);
  const [exportLink, setExportLink] = useState(null);
  const [error, setError] = useState(null);
  const active = lifecycle.status === "active";
  const done = (message) => {
    toast.success(message);
    router.refresh();
  };
  const dialog = (name) => ({ open: open === name, onOpenChange: (o) => setOpen(o ? name : null) });

  async function runSync() {
    setBusy("sync");
    setError(null);
    try {
      const r = await storeApi(store.id, { method: "POST" });
      setSync(r);
      router.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function makeExport() {
    setBusy("export");
    setError(null);
    try {
      const r = await storeApi(store.id, { path: "/export", method: "POST" });
      setExportLink({ url: new URL(r.url, window.location.origin).href, expires: r.expires_in });
      router.refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-card="lifecycle">
      <CardHeader>
        <CardTitle>Store controls</CardTitle>
        <CardDescription>Every action here is recorded under Recent activity with your name.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="space-y-2">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-muted-foreground sm:w-36">Status</dt>
            <dd data-lifecycle-status={lifecycle.status}>{active ? <Badge variant="success">Active</Badge> : <Badge variant="danger">Suspended</Badge>}</dd>
          </div>
          <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
            <dt className="shrink-0 text-muted-foreground sm:w-36">Maintenance</dt>
            <dd className="min-w-0 break-words" data-lifecycle-maintenance={lifecycle.maintenance.enabled ? "on" : "off"}>
              {lifecycle.maintenance.enabled ? (
                <span className="space-y-1">
                  <Badge variant="warning">On</Badge> <span className="text-muted-foreground">{lifecycle.maintenance.message || DEFAULT_MAINTENANCE_MESSAGE}</span>
                </span>
              ) : (
                "Off"
              )}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button variant={active ? "destructive" : "default"} onClick={() => setOpen("status")} data-action={active ? "suspend" : "resume"}>
            {active ? <Pause aria-hidden /> : <Play aria-hidden />} {active ? "Suspend" : "Resume"}
          </Button>
          <Button variant="outline" onClick={() => setOpen("maintenance")} data-action="maintenance">
            <Wrench aria-hidden /> {lifecycle.maintenance.enabled ? "Maintenance settings" : "Maintenance"}
          </Button>
          <Button variant="outline" onClick={() => setOpen("rotate")} data-action="rotate">
            <KeyRound aria-hidden /> Rotate secrets
          </Button>
          <Button variant="outline" onClick={() => setOpen("edit")} data-action="edit">
            <Pencil aria-hidden /> Edit details
          </Button>
          <Button variant="outline" onClick={runSync} disabled={!active || busy === "sync"} data-action="sync" title={active ? undefined : "A suspended store can't sync."}>
            <RefreshCw aria-hidden className={busy === "sync" ? "animate-spin" : undefined} /> {busy === "sync" ? "Starting…" : "Sync catalog now"}
          </Button>
          <Button variant="outline" onClick={makeExport} disabled={busy === "export"} data-action="export">
            <Download aria-hidden /> {busy === "export" ? "Preparing…" : "Export"}
          </Button>
          <Button variant="destructive" onClick={() => setOpen("offboard")} data-action="offboard">
            <Trash2 aria-hidden /> Offboard
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {sync && (
          <Alert variant="info" data-sync-result>
            <AlertDescription>
              {sync.action === "joined" ? "A sync was already running; this joins it." : sync.action === "resumed" ? "The last sync picks up where it stopped." : "Catalog sync started."} So far: {sync.products} products, {sync.collections} collections. The queue finishes it in the background.
            </AlertDescription>
          </Alert>
        )}
        {exportLink && (
          <div className="space-y-1.5" data-export-link>
            <p>
              Export link ready. It expires in {exportLink.expires} and only works for this store. Anyone with the link can download the store&apos;s data, so share it with care.
            </p>
            <CopyButton value={exportLink.url} label="the export link" />
          </div>
        )}
      </CardContent>

      <StatusDialog key={`status-${lifecycle.status}`} store={store} lifecycle={lifecycle} onDone={done} {...dialog("status")} />
      <MaintenanceDialog store={store} lifecycle={lifecycle} onDone={done} {...dialog("maintenance")} />
      <RotateSecretsDialog store={store} lifecycle={lifecycle} onDone={() => router.refresh()} {...dialog("rotate")} />
      <EditStoreDialog store={store} details={lifecycle.details} onDone={done} {...dialog("edit")} />
      <OffboardDialog store={store} onDone={done} {...dialog("offboard")} />
    </Card>
  );
}
