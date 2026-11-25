"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { roleWords } from "@/components/admin/team/team-words";
import { Refusal } from "@/components/admin/team/Refusal";

const SELECT = "h-8 w-full rounded-md border border-input bg-muted dark:bg-input/30 px-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none";

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
  const picked = members.find((m) => m.id === to);
  const pickedName = picked ? picked.name || picked.email : "The member you pick";
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
      <DialogContent data-team="transfer-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer ownership</DialogTitle>
          <DialogDescription>Hand this store to another member. You stay on the team, and only an owner can give ownership back.</DialogDescription>
        </DialogHeader>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Invite someone first: ownership can only go to a member of this store.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <ul aria-label="What changes" data-team="transfer-summary" className="space-y-1.5 rounded-md border border-border bg-muted px-3 py-2.5 text-sm">
              <li className="flex items-center gap-2">
                <span className="min-w-0 truncate font-medium text-foreground" title={pickedName}>
                  {pickedName}
                </span>
                <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="sr-only">becomes</span>
                <span className="shrink-0 text-foreground">Owner</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="font-medium text-foreground">You</span>
                <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="sr-only">become</span>
                <span className="text-foreground">Admin</span>
              </li>
            </ul>
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
              <Label htmlFor="team-transfer-confirm" className="block leading-normal">
                {"Type "}
                <span className="rounded-sm bg-muted px-1 py-0.5 font-mono text-[0.8125rem] text-foreground">{storeName}</span>
                {" to confirm"}
              </Label>
              <Input id="team-transfer-confirm" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-describedby="team-transfer-check" />
              <p id="team-transfer-check" aria-live="polite" className={matches ? "flex items-center gap-1 text-xs text-success" : "text-xs text-muted-foreground"}>
                {matches ? (
                  <>
                    <Check aria-hidden="true" className="size-3.5" />
                    The name matches.
                  </>
                ) : confirm.trim() ? (
                  "Not a match yet. Capital letters don't matter."
                ) : (
                  "This makes sure you meant to do it."
                )}
              </p>
            </div>
            <Refusal>{error}</Refusal>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !to || !matches}>
                {busy ? "Transferring…" : "Transfer ownership"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
