"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { CopyButton } from "@/components/kit/copy-button";
import { AppRefusal } from "@/components/admin/apps/AppRefusal";
import { CardLoading } from "@/components/admin/apps/CardLoading";
import { NO_MANAGE, postApp, shortDate } from "@/components/admin/apps/app-words";

// Phase 9 line 4: Shiprocket's tracking webhook, read from
// GET /api/admin/apps/[id]/parcel-key. The address to paste into Shiprocket
// (Settings → API → Webhooks) and the key that goes in its "x-api-key" box:
// made here, shown once, never read back; Rotate (admin and owner) makes a new
// one and the old one keeps working for 24 hours.
//   install: the install view; role: the actor's role
export function ShiprocketCard({ install, role }) {
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const path = `apps/${install.id}/parcel-key`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/${path}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error();
      setView(json);
    } catch {
      setFailed(true);
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);

  async function rotate() {
    setBusy(true);
    setError(null);
    const r = await postApp(path, { rotate: true });
    setBusy(false);
    setConfirm(false);
    if (!r.ok) return setError(r.error);
    setKey(r.key);
    setView((v) => ({ ...(v || {}), set: true, rotatedAt: r.rotatedAt }));
  }

  return (
    <Card data-apps="shiprocket-webhook">
      <CardHeader>
        <CardTitle className="text-[1.125rem]">Tracking updates</CardTitle>
        <CardDescription>Shiprocket tells your store when a parcel moves. Storeasy then asks Shiprocket for the parcel&apos;s latest status, so only Shiprocket&apos;s own answer is shown to shoppers.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {failed ? (
          <p className="text-sm text-muted-foreground">This couldn&apos;t be loaded. Reload the page to try again.</p>
        ) : !view ? (
          <CardLoading />
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm font-medium">Webhook address</p>
              <CopyButton value={view.address} label="the webhook address" id="parcel-address" />
              {view.addressWarning && (
                <Alert variant="warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>Shiprocket may refuse this address</AlertTitle>
                  <AlertDescription>Shiprocket doesn&apos;t accept addresses containing &quot;sr&quot; or &quot;kr&quot;. If it says no, contact Storeasy support for another address for your store.</AlertDescription>
                </Alert>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Key</span>
              <Badge variant={view.set ? "success" : "muted"} data-parcel-key={view.set ? "set" : "none"}>
                {view.set ? `Made ${shortDate(view.rotatedAt)}` : "Not made yet"}
              </Badge>
            </div>
            {key && (
              <div className="space-y-2" data-apps="parcel-key-once">
                <Alert variant="warning">
                  <KeyRound aria-hidden="true" />
                  <AlertTitle>Copy the key now</AlertTitle>
                  <AlertDescription>Paste it into Shiprocket&apos;s &quot;x-api-key&quot; box. You won&apos;t see it again after you leave this page. {view.set ? "An earlier key keeps working for 24 hours." : ""}</AlertDescription>
                </Alert>
                <CopyButton value={key} label="the webhook key" id="parcel-key" />
              </div>
            )}
            <AppRefusal>{error}</AppRefusal>
            <RoleGate role={role} action="apps.manage" reason={NO_MANAGE}>
              <Button type="button" variant="outline" disabled={busy} onClick={() => (view.set ? setConfirm(true) : rotate())} data-parcel-rotate>
                {view.set ? "Rotate key" : "Make a key"}
              </Button>
            </RoleGate>
            <AlertDialog open={confirm} onOpenChange={setConfirm}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Make a new key?</AlertDialogTitle>
                  <AlertDialogDescription>The current key keeps working for 24 hours. Paste the new one into Shiprocket before then, or tracking updates stop.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                  <Button type="button" disabled={busy} onClick={rotate}>
                    Make a new key
                  </Button>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}
      </CardContent>
    </Card>
  );
}
