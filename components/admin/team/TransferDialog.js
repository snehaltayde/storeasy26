"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roleWords } from "@/components/admin/team/team-words";

const SELECT = "h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none";

// Transfer ownership (owner only, Phase 2 line 8 §1.6): pick a member, type the
// store name. In one batch they become owner and you become admin; the page
// then reloads from the server as admin.
//   members (everyone but you); storeName; open / onOpenChange
//   onTransfer(userId, confirm) -> { ok } | { error }
export function TransferDialog({ members, storeName, open, onOpenChange, onTransfer }) {
  const [to, setTo] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const matches = confirm.trim().toLowerCase() === String(storeName || "").trim().toLowerCase();
  const change = (v) => {
    if (!v) {
      setTo("");
      setConfirm("");
      setError(null);
    }
    onOpenChange(v);
  };
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onTransfer(to, confirm);
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
    }
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-team="transfer-dialog">
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>The member you pick becomes an owner and you become an admin. Only an owner can give ownership back.</DialogDescription>
        </DialogHeader>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Invite someone first: ownership can only go to a member of this store.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="team-transfer-to">New owner</Label>
              <select id="team-transfer-to" value={to} onChange={(e) => setTo(e.target.value)} className={SELECT} data-team="transfer-to">
                <option value="">Pick a member</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.name || m.email} (${roleWords(m.role)})`}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-transfer-confirm">{`Type ${storeName} to confirm`}</Label>
              <Input id="team-transfer-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || !to || !matches}>
                {busy ? "Transferring…" : "Transfer ownership"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
