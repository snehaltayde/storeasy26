"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/components/ui/utils";
import { RoleSelect } from "@/components/admin/team/RoleSelect";
import { inviteWarning, mailWords, roleWords } from "@/components/admin/team/team-words";

const TONE = { success: "text-success", warning: "text-warning-text", danger: "text-destructive", muted: "text-muted-foreground" };

// The invite link, shown once (only its hash is stored), with Copy and what
// happened to the email. Copy says how it went next to the button.
export function InviteLink({ result }) {
  const [copied, setCopied] = useState(null);
  const url = typeof window === "undefined" ? result.inviteUrl : new URL(result.inviteUrl, window.location.origin).href;
  const mail = mailWords(result.mail, result.email);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("Copied.");
    } catch {
      setCopied("Couldn't copy. Select the link and copy it yourself.");
    }
  }
  return (
    <div data-team="invite-link" className="space-y-3">
      <p className="text-sm text-foreground">{`Invite for ${result.email} as ${roleWords(result.role)}. This link is shown once and works once, for 7 days.`}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input readOnly value={url} aria-label="Invite link" className="font-mono text-xs" onFocus={(e) => e.target.select()} data-team="invite-url" />
        <Button type="button" variant="outline" onClick={copy}>
          Copy link
        </Button>
      </div>
      {copied && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {copied}
        </p>
      )}
      <p data-team="invite-mail" data-mail={result.mail?.status ?? "not-configured"} className={cn("text-sm", TONE[mail.tone])}>
        {mail.text}
      </p>
    </div>
  );
}

// Invite someone (Phase 2 line 8 §1.3): email and role, then the link once.
//   actorRole; members (for the "already on the team" warning)
//   open / onOpenChange; result: the last invite's answer (also set by
//   "Send a new link"); onInvite(email, role) -> { ok } | { error }
export function InviteDialog({ actorRole, members, open, onOpenChange, result, onInvite }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const warning = inviteWarning(members, email, role);
  const change = (v) => {
    if (!v) {
      setEmail("");
      setRole("staff");
      setError(null);
    }
    onOpenChange(v);
  };
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onInvite(email.trim(), role);
    setBusy(false);
    if (!r.ok) setError(r.error); // nothing typed is lost
  }
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-team="invite-dialog">
        <DialogHeader>
          <DialogTitle>{result ? "Invite ready" : "Invite someone"}</DialogTitle>
          <DialogDescription>{result ? "Send them this link. When they accept, they join with this role." : "They get a link to join this store's console with the role you pick."}</DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <InviteLink result={result} />
            <DialogFooter>
              <Button type="button" onClick={() => change(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="team-invite-email">Email</Label>
              <Input id="team-invite-email" type="email" autoComplete="off" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@yourstore.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-invite-role">Role</Label>
              <RoleSelect id="team-invite-role" actorRole={actorRole} value={role} onChange={setRole} />
            </div>
            {warning && (
              <p data-team="invite-warning" className="text-sm text-warning-text">
                {warning}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !email.trim() || Boolean(warning)}>
                {busy ? "Sending…" : "Send invite"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
