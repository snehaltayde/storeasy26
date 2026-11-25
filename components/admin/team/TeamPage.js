"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/kit/page-header";
import { RoleGate } from "@/components/kit/role-gate";
import { MembersTable } from "@/components/admin/team/MembersTable";
import { InvitesTable } from "@/components/admin/team/InvitesTable";
import { InviteDialog } from "@/components/admin/team/InviteDialog";
import { TransferDialog } from "@/components/admin/team/TransferDialog";
import { TEAM_WORDS, refusalWords } from "@/components/admin/team/team-words";
import { Refusal } from "@/components/admin/team/Refusal";

const TITLE = "Team";
const DESCRIPTION = "Who can open this store's console, and what each person can do.";
export const BREADCRUMB = [{ label: "Settings", href: "/admin/settings" }, { label: "Team" }];

async function send(body) {
  try {
    const res = await fetch("/api/admin/team", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return res.ok && json.ok ? { ok: true, json } : { ok: false, error: refusalWords(json) };
  } catch {
    return { ok: false, error: TEAM_WORDS.failed };
  }
}

// Staff and support (no team.manage): the page shows no member data at all.
export function TeamNoAccess() {
  return (
    <>
      <PageHeader title={TITLE} breadcrumb={BREADCRUMB} />
      <Card data-team="no-access">
        <CardContent>
          <p className="text-sm text-muted-foreground">{TEAM_WORDS.noAccess}</p>
        </CardContent>
      </Card>
    </>
  );
}

export function TeamSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your team" className="space-y-6">
      {[5, 2].map((n, i) => (
        <div key={i} className="space-y-2 rounded-card border border-border p-4">
          <Skeleton className="h-5 w-40" />
          {Array.from({ length: n }, (_, j) => (
            <Skeleton key={j} className="h-10 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}

// The team screen (Phase 2 line 8, docs/UI.md "Team"). The first view comes
// from the server; every write answers with the fresh view, so the lists
// always show what the database holds. A transfer reloads the page from the
// server, which then renders it for the caller's new role (admin).
//   initial: teamView() or null (a failed read); supported: false without the
//   control plane; role: the caller's role; storeName: for the transfer check
export function TeamPage({ initial, supported = true, role, storeName }) {
  const [view, setView] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [notice, setNotice] = useState(null);
  const you = view?.you ?? { id: null, role };

  async function reload() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/team", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      setView(res.ok && json?.supported ? json : null);
    } catch {
      setView(null);
    } finally {
      setLoading(false);
    }
  }
  // a write: on success the answer's view replaces the lists
  async function write(body) {
    const r = await send(body);
    if (r.ok) setView(r.json);
    return r;
  }
  async function invite(email, inviteRole) {
    const r = await write({ action: "invite", email, role: inviteRole });
    if (r.ok) setInviteResult({ email: email.toLowerCase(), role: inviteRole, inviteUrl: r.json.inviteUrl, mail: r.json.mail });
    return r;
  }
  async function resend(i) {
    setNotice(null);
    const revoked = await write({ action: "revoke-invite", inviteId: i.id });
    if (!revoked.ok) return setNotice(revoked.error);
    const r = await write({ action: "invite", email: i.email, role: i.role });
    if (!r.ok) return setNotice(`The old link was revoked, but a new one wasn't made: ${r.error}`);
    setInviteResult({ email: i.email, role: i.role, inviteUrl: r.json.inviteUrl, mail: r.json.mail });
    setInviteOpen(true);
  }
  async function transfer(userId, confirm) {
    const r = await send({ action: "transfer", userId, confirm });
    if (r.ok) window.location.reload(); // the server renders the page for your new role
    return r;
  }

  const header = (
    <PageHeader
      title={TITLE}
      description={DESCRIPTION}
      breadcrumb={BREADCRUMB}
      actions={
        supported && view ? (
          <>
            <RoleGate role={you.role} action="team.owner" mode="hide" reason="Only an owner can transfer ownership.">
              <Button type="button" variant="outline" onClick={() => setTransferOpen(true)} data-team="transfer">
                Transfer ownership
              </Button>
            </RoleGate>
            <RoleGate role={you.role} action="team.manage" mode="hide" reason="Only owners and admins can invite.">
              <Button
                type="button"
                onClick={() => {
                  setInviteResult(null);
                  setInviteOpen(true);
                }}
                data-team="invite"
              >
                Invite someone
              </Button>
            </RoleGate>
          </>
        ) : null
      }
    />
  );

  if (!supported) {
    return (
      <>
        {header}
        <Card data-team="unsupported">
          <CardContent>
            <p className="text-sm text-muted-foreground">{TEAM_WORDS.unsupported}</p>
          </CardContent>
        </Card>
      </>
    );
  }
  if (!view) {
    return (
      <>
        {header}
        {loading ? (
          <TeamSkeleton />
        ) : (
          <div role="alert" data-team="error" className="flex flex-col items-center gap-2 rounded-card border border-border bg-card px-6 py-10 text-center">
            <p className="text-sm text-foreground">{TEAM_WORDS.loadFailed}</p>
            <Button type="button" variant="outline" onClick={reload} data-read-control>
              Try again
            </Button>
          </div>
        )}
      </>
    );
  }

  const others = view.members.filter((m) => m.id !== you.id);
  return (
    <>
      {header}
      <Refusal className="mb-4">{notice}</Refusal>
      <div className="space-y-6">
        <Card data-team="members">
          <CardHeader>
            <CardTitle>{`Members (${view.members.length})`}</CardTitle>
            <CardDescription>A store always keeps at least one owner. Only an owner can make, change or remove an owner.</CardDescription>
          </CardHeader>
          <CardContent>
            <MembersTable
              members={view.members}
              you={you}
              onRole={(m, r) => write({ action: "role", userId: m.id, role: r })}
              onRemove={(m) => write({ action: "remove", userId: m.id })}
            />
          </CardContent>
        </Card>
        <Card data-team="invites">
          <CardHeader>
            <CardTitle>{`Pending invites (${view.invites.length})`}</CardTitle>
            <CardDescription>An invite can only add someone or raise their role. Changing or removing a member cancels their pending invites.</CardDescription>
          </CardHeader>
          <CardContent>
            <InvitesTable invites={view.invites} actorRole={you.role} onRevoke={(i) => write({ action: "revoke-invite", inviteId: i.id })} onResend={resend} />
          </CardContent>
        </Card>
      </div>
      <InviteDialog actorRole={you.role} members={view.members} open={inviteOpen} onOpenChange={setInviteOpen} result={inviteResult} onInvite={invite} />
      <TransferDialog members={others} storeName={storeName} open={transferOpen} onOpenChange={setTransferOpen} onTransfer={transfer} />
    </>
  );
}
