"use client";

import { useCallback, useEffect, useState } from "react";
import { CirclePause, CirclePlay, KeyRound, Pencil, Send, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { roleAllows } from "@/lib/platform/authz";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { SecretOnce } from "@/components/admin/apps/SecretOnce";
import { DeliveriesTable } from "@/components/admin/apps/DeliveriesTable";
import { CardLoading } from "@/components/admin/apps/CardLoading";
import { NO_MANAGE, postApp, shortDate } from "@/components/admin/apps/app-words";

// An app's Webhooks card (Phase 4 line 3), read from
// GET /api/admin/apps/[id]/webhooks. A custom app shows its address (mono),
// Active / Paused with the reason, its events, and Edit address, Rotate
// secret (behind an AlertDialog; the new secret shows once), Send test event
// and Pause (behind an AlertDialog) / Resume (admin and owner; RoleGate'd for staff and support). A
// first-party app shows only its deliveries, and nothing at all until it has
// some. Then the Deliveries table. The signing secret is never read back.
//   install: the install view; role: the actor's role
export function WebhooksCard({ install, role }) {
  const toast = useToast();
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: null, topic: null });
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [secret, setSecret] = useState(null);
  const base = `apps/${encodeURIComponent(install.id)}/webhooks`;

  const load = useCallback(
    async (f = filters) => {
      setLoading(true);
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
      try {
        const res = await fetch(`/api/admin/${base}${q.size ? `?${q}` : ""}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.ok) throw new Error(json.error);
        setView(json);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [base, filters],
  );
  useEffect(() => {
    load(filters);
    // re-read only when the install changes (filters re-read through onFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [install.id, install.status]);

  async function act(what, body, done) {
    setBusy(what);
    setError(null);
    const r = await postApp(base, body);
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return null;
    }
    if (done) toast.success(done);
    await load();
    return r;
  }
  const filter = (f) => {
    setFilters(f);
    load(f);
  };

  if (!view) {
    return failed ? (
      <Card data-apps="webhooks">
        <CardHeader>
          <CardTitle>Webhooks</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>We couldn't load the webhooks. Nothing was changed.</p>
          <Button type="button" variant="outline" size="sm" data-read-control onClick={() => load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    ) : install.kind === "custom" ? (
      <CardLoading title="Webhooks" />
    ) : null;
  }
  const ep = view.endpoint;
  if (!ep && !view.deliveries.length && !filters.status && !filters.topic) return null;
  const paused = ep?.status === "paused";
  const testWhy = roleAllows(role, "apps.manage") && (paused || install.status !== "enabled");

  return (
    <Card data-apps="webhooks">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Webhooks</CardTitle>
          {ep && (
            <Badge variant={paused ? "warning" : "success"} data-webhook-status={ep.status}>
              {paused ? "Paused" : "Active"}
            </Badge>
          )}
        </div>
        <CardDescription>{ep ? "Store events are signed and sent to this address. Failed deliveries are retried for about two days." : "Store events this app has handled."}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {ep && (
          <div className="space-y-4">
            {paused && (
              <Alert variant="warning" data-apps="webhook-paused">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>Sending is paused</AlertTitle>
                <AlertDescription>{`${ep.pausedReason || "Paused"}${ep.pausedAt ? ` (${shortDate(ep.pausedAt)})` : ""}. New events are recorded as Skipped; you can resend them after you resume.`}</AlertDescription>
              </Alert>
            )}
            {editing ? (
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await act("endpoint", { endpoint: { url } }, "The webhook address was saved.")) setEditing(false);
                }}
              >
                <Label htmlFor="webhook-url">Webhook address</Label>
                <Input id="webhook-url" type="url" className="font-mono" value={url} onChange={(e) => setUrl(e.target.value)} />
                <p className="text-[13px] text-muted-foreground">Storeasy only sends to the host you save here. Changing the host is recorded in the app's activity.</p>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={busy === "endpoint"} data-webhooks-action="save-endpoint">
                    {busy === "endpoint" ? "Saving…" : "Save"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy === "endpoint"} onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Address</dt>
                <dd className="min-w-0 break-all font-mono text-xs" data-webhook-url>
                  {ep.url}
                </dd>
                <dt className="text-muted-foreground">Events</dt>
                <dd className="flex flex-wrap gap-1.5">
                  {ep.topics.map((t) => (
                    <Badge key={t} variant="outline" className="font-mono" data-webhook-topic={t}>
                      {t}
                    </Badge>
                  ))}
                </dd>
                {ep.oldSecretSignsUntil && (
                  <>
                    <dt className="text-muted-foreground">Old secret</dt>
                    <dd>{`Still signs until ${new Date(ep.oldSecretSignsUntil).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`}</dd>
                  </>
                )}
              </dl>
            )}
            <SecretOnce secret={secret} rotatedUntil={ep.oldSecretSignsUntil} />
            <AppRefusal>{error}</AppRefusal>
            <div className="flex flex-wrap gap-2">
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-webhooks-action="edit"
                  onClick={() => {
                    setUrl(ep.url);
                    setError(null);
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden="true" />
                  Edit address
                </Button>
              </RoleGate>
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button type="button" variant="outline" size="sm" disabled={paused || install.status !== "enabled" || busy === "test"} aria-describedby={testWhy ? "webhook-test-why" : undefined} data-webhooks-action="test" onClick={() => act("test", { test: true }, "A test event is on its way.")}>
                  <Send aria-hidden="true" />
                  {busy === "test" ? "Sending…" : "Send test event"}
                </Button>
              </RoleGate>
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button type="button" variant="outline" size="sm" data-webhooks-action="rotate" onClick={() => setRotateOpen(true)}>
                  <KeyRound aria-hidden="true" />
                  Rotate secret
                </Button>
              </RoleGate>
              <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
                <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} data-webhooks-action={paused ? "resume" : "pause"} onClick={() => (paused ? act("resume", { resume: true }, "Webhooks are on again.") : setPauseOpen(true))}>
                  {paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
                  {paused ? "Resume" : "Pause"}
                </Button>
              </RoleGate>
            </div>
            {testWhy && (
              <p id="webhook-test-why" className="text-[13px] text-muted-foreground">
                {paused ? "Resume sending to send a test event." : "Turn the app on to send a test event."}
              </p>
            )}
          </div>
        )}
        <DeliveriesTable view={view} installId={install.id} role={role} filters={filters} onFilter={filter} onChanged={() => load()} loading={loading} />
      </CardContent>
      <AlertDialog open={pauseOpen} onOpenChange={(v) => !v && busy !== "pause" && setPauseOpen(false)}>
        <AlertDialogContent data-apps="pause-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{`Pause webhooks for ${install.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>Nothing is sent to its address until you resume. Events while paused are recorded as Skipped, and you can resend them afterwards.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "pause"}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy === "pause"}
              data-apps="pause-go"
              onClick={async () => {
                await act("pause", { pause: true }, "Webhooks are paused.");
                setPauseOpen(false);
              }}
            >
              {busy === "pause" ? "Pausing…" : "Pause webhooks"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rotateOpen} onOpenChange={(v) => !v && busy !== "rotate" && setRotateOpen(false)}>
        <AlertDialogContent data-apps="rotate-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the signing secret?</AlertDialogTitle>
            <AlertDialogDescription>You get a new secret, shown once. For 24 hours each webhook is signed with both the new and the old secret, so you have time to update your app. After that only the new one works.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "rotate"}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              disabled={busy === "rotate"}
              data-apps="rotate-go"
              onClick={async () => {
                const r = await act("rotate", { rotate_secret: true }, null);
                setRotateOpen(false);
                if (r) setSecret(r.secret);
              }}
            >
              {busy === "rotate" ? "Rotating…" : "Rotate secret"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
