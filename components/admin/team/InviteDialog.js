"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, TriangleAlert } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/components/ui/utils";
import { RoleSelect } from "@/components/admin/team/RoleSelect";
import { Refusal } from "@/components/admin/team/Refusal";
import { inviteWarning, mailWords, roleWords } from "@/components/admin/team/team-words";

const TONE = { success: "text-success", warning: "text-warning-text", danger: "text-destructive", muted: "text-muted-foreground" };

// The invite link, shown once (only its hash is stored), with Copy and what
// happened to the email. Copy says how it went next to the button.
export function InviteLink({ result }) {
  const [copied, setCopied] = useState(null); // { ok, text }
  const field = useRef(null);
  const url = typeof window === "undefined" ? result.inviteUrl : new URL(result.inviteUrl, window.location.origin).href;
  const mail = mailWords(result.mail, result.email);
  async function copy() {
    const said = { ok: true, text: "Link copied. Paste it into a message to them." };
    try {
      await navigator.clipboard.writeText(url);
      return setCopied(said);
    } catch {
      // the async clipboard can be refused (a permissions policy, an embedded
      // frame): select the field and copy the old way before giving up
    }
    field.current?.focus();
    field.current?.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    setCopied(ok ? said : { ok: false, text: "Couldn't copy. The link is selected: press Ctrl+C (⌘C on a Mac)." });
  }
  // the button goes back to "Copy link" after a moment; the sentence stays
  useEffect(() => {
    if (!copied?.ok) return;
    const t = setTimeout(() => setCopied((c) => (c ? { ...c, ok: null } : c)), 2000);
    return () => clearTimeout(t);
  }, [copied?.ok]);
  const done = copied?.ok === true;
  return (
    <div data-team="invite-link" className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2 text-sm">
        <dt className="text-muted-foreground">For</dt>
        <dd className="min-w-0 truncate font-medium text-foreground" title={result.email}>
          {result.email}
        </dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd className="font-medium text-foreground">{roleWords(result.role)}</dd>
      </dl>
      <div className="space-y-1.5">
        <Label htmlFor="team-invite-url" className="flex items-center gap-1.5">
          <Link2 aria-hidden="true" className="size-4 text-muted-foreground" />
          Invite link
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input ref={field} id="team-invite-url" readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} data-team="invite-url" aria-describedby="team-invite-once" />
          <Button type="button" variant={done ? "secondary" : "outline"} onClick={copy} className="shrink-0" data-team="copy-link">
            {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {done ? "Copied" : "Copy link"}
          </Button>
        </div>
        <p id="team-invite-once" className="text-xs text-muted-foreground">
          Shown once. It works once, for 7 days.
        </p>
        <p aria-live="polite" className={cn("text-xs", copied?.ok === false ? "text-destructive" : "text-success")}>
          {copied?.text ?? ""}
        </p>
      </div>
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
      <DialogContent data-team="invite-dialog" className="sm:max-w-md">
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
              <RoleSelect id="team-invite-role" actorRole={actorRole} value={role} onChange={setRole} aria-describedby={warning ? "team-invite-warning" : undefined} />
            </div>
            <div aria-live="polite">
              {warning && (
                <div id="team-invite-warning" data-team="invite-warning" className="flex gap-2 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-text">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <p className="min-w-0">{warning}</p>
                </div>
              )}
            </div>
            <Refusal>{error}</Refusal>
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
