"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { roleWords } from "@/components/admin/team/team-words";

// Remove a member (an AlertDialog first). The last owner and your own row are
// refused by the route; its words show here and nothing changes.
//   member; open / onOpenChange; onRemove() -> { ok } | { error }
export function RemoveDialog({ member, open, onOpenChange, onRemove }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const change = (v) => {
    if (!v) setError(null);
    onOpenChange(v);
  };
  async function go() {
    setBusy(true);
    const r = await onRemove();
    setBusy(false);
    if (r.ok) change(false);
    else setError(r.error);
  }
  const who = member?.name || member?.email || "this member";
  return (
    <AlertDialog open={open} onOpenChange={change}>
      <AlertDialogContent data-team="remove-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{`Remove ${who}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {`${who} (${roleWords(member?.role)}) loses access to this store at once, in every open tab. Any invite still waiting for them stops working. You can invite them again later.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep them</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={busy} onClick={go}>
            {busy ? "Removing…" : "Remove from team"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
