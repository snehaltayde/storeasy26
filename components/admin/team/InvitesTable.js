"use client";

import { useState } from "react";
import { RotateCw, X } from "lucide-react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/kit/data-table";
import { EmptyState } from "@/components/kit/empty-state";
import { RoleGate } from "@/components/kit/role-gate";
import { actionFor, dateWords, expiryWords, roleWords } from "@/components/admin/team/team-words";
import { Refusal } from "@/components/admin/team/Refusal";
import { RowActionBody, rowAction } from "@/components/admin/team/RowAction";
import { cn } from "@/components/ui/utils";

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
    { key: "created_at", header: "Sent", className: "hidden lg:table-cell", cell: (i) => <span className="whitespace-nowrap text-muted-foreground">{dateWords(i.created_at)}</span> },
    {
      key: "expires_at",
      header: "Expires",
      // whole days, so the server's words and the browser's match; the date in the tooltip
      cell: (i) => {
        const e = expiryWords(i.expires_at);
        return (
          <span title={dateWords(i.expires_at)} data-team="expiry" className={cn("whitespace-nowrap", e.soon ? "font-medium text-warning-text" : "text-foreground")} suppressHydrationWarning>
            {e.text}
          </span>
        );
      },
    },
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
              <Button {...rowAction("Send a new link")} onClick={() => onResend(i)} data-team="resend">
                <RowActionBody icon={RotateCw}>Send a new link</RowActionBody>
              </Button>
            </RoleGate>
            <RoleGate role={actorRole} action={actionFor(i.role)} mode="hide" reason="Only an owner can revoke an owner invite.">
              <Button {...rowAction("Revoke", { danger: true })} onClick={() => setRevoking(i)} data-team="revoke">
                <RowActionBody icon={X}>Revoke</RowActionBody>
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
          <Refusal>{error}</Refusal>
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
