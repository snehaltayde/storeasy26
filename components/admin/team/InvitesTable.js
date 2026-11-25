"use client";

import { useState } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { actionFor, dateWords, roleWords } from "@/components/admin/team/team-words";

// Pending invites (Phase 2 line 8 §1.2): email, role, sent, expires. Revoke
// (asks first) and "Send a new link" (revoke, then invite again, showing the
// new link once). An owner invite needs team.owner for both; hidden otherwise.
//   invites; actorRole; onRevoke(invite), onResend(invite) -> { ok } | { error }
export function InvitesTable({ invites, actorRole, onRevoke, onResend }) {
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const close = () => {
    setRevoking(null);
    setError(null);
  };
  async function revoke() {
    setBusy(true);
    const r = await onRevoke(revoking);
    setBusy(false);
    if (r.ok) close();
    else setError(r.error);
  }
  const columns = [
    { key: "email", header: "Email", truncate: true },
    { key: "role", header: "Role", cell: (i) => roleWords(i.role) },
    { key: "created_at", header: "Sent", cell: (i) => dateWords(i.created_at) },
    { key: "expires_at", header: "Expires", cell: (i) => dateWords(i.expires_at) },
  ];
  return (
    <>
      <DataTable
        label="Pending invites"
        columns={columns}
        rows={invites}
        empty={<EmptyState title="No invites waiting" description="Invites you send show here until they're accepted, revoked or expire after 7 days." />}
        rowActions={(i) => (
          <>
            <RoleGate role={actorRole} action={actionFor(i.role)} mode="hide" reason="Only an owner can resend an owner invite.">
              <Button type="button" variant="ghost" size="sm" onClick={() => onResend(i)} data-team="resend">
                Send a new link
              </Button>
            </RoleGate>
            <RoleGate role={actorRole} action={actionFor(i.role)} mode="hide" reason="Only an owner can revoke an owner invite.">
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRevoking(i)} data-team="revoke">
                Revoke
              </Button>
            </RoleGate>
          </>
        )}
      />
      <AlertDialog open={Boolean(revoking)} onOpenChange={(v) => !v && close()}>
        <AlertDialogContent data-team="revoke-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{`Revoke the invite for ${revoking?.email ?? ""}?`}</AlertDialogTitle>
            <AlertDialogDescription>The link stops working at once. You can send a new invite later.</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button type="button" variant="destructive" disabled={busy} onClick={revoke}>
              {busy ? "Revoking…" : "Revoke invite"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
