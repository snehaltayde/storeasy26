"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RoleGate } from "@/components/kit/role-gate";
import { useToast } from "@/components/kit/toast";
import { NO_MANAGE, postTheme } from "@/components/admin/themes/theme-words";

// Archive (themes.manage; hidden for other roles): the theme leaves the
// library but is kept, so an old release that used it still renders on
// rollback. The server refuses it while the theme is live or in the draft.
export function ArchiveThemeDialog({ pkg, role }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (pkg.status !== "installed") return null;
  const label = `${pkg.name} ${pkg.version}`;
  async function go() {
    setBusy(true);
    const r = await postTheme(`themes/${encodeURIComponent(pkg.id)}`, { archive: true });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast.success(`${label} was archived.`);
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <RoleGate role={role} action="themes.manage" reason={NO_MANAGE} mode="hide">
        <Button
          type="button"
          variant="outline"
          data-themes-action="archive"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          Archive
        </Button>
      </RoleGate>
      <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <AlertDialogContent data-themes="archive-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {label}?</AlertDialogTitle>
            <AlertDialogDescription>It leaves your themes list and can't be chosen again. It is kept, so a past release that used it still shows correctly if you roll back.</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy} aria-busy={busy} onClick={go} data-themes-action="archive-confirm">
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
