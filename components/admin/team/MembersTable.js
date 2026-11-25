"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { RoleGate } from "@/components/kit/role-gate";
import { RoleSelect } from "@/components/admin/team/RoleSelect";
import { RemoveDialog } from "@/components/admin/team/RemoveDialog";
import { actionFor, dateWords, roleWords } from "@/components/admin/team/team-words";

// Change one member's role (a dialog: the role select and Save). The route
// refuses the last owner in plain words, shown here; nothing changes.
function RoleDialog({ member, actorRole, open, onOpenChange, onSave }) {
  const [role, setRole] = useState(member?.role ?? "staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const change = (v) => {
    if (!v) setError(null);
    onOpenChange(v);
  };
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    const r = await onSave(role);
    setBusy(false);
    if (r.ok) change(false);
    else setError(r.error);
  }
  const who = member?.name || member?.email;
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent data-team="role-dialog">
        <DialogHeader>
          <DialogTitle>{`Change ${who}'s role`}</DialogTitle>
          <DialogDescription>{`Now ${roleWords(member?.role)}. The change takes effect on their next click, and any invite still waiting for them stops working.`}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-role">Role</Label>
            <RoleSelect id="team-role" actorRole={actorRole} value={role} onChange={setRole} />
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
            <Button type="submit" disabled={busy || role === member?.role}>
              {busy ? "Saving…" : "Save role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The members (Phase 2 line 8 §1.1, 1.4, 1.5): name, email, role, joined, a
// "You" marker, owners first (the server's order). Change role and Remove go
// through RoleGate: an owner's row needs team.owner, any other team.manage,
// hidden when the role lacks it. No Remove on your own row.
//   members; you: { id, role }; onRole(member, role), onRemove(member) -> { ok } | { error }
export function MembersTable({ members, you, onRole, onRemove }) {
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const columns = [
    {
      key: "name",
      header: "Name",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={m.name || m.email}>
            {m.name || m.email}
          </span>
          {m.id === you?.id && (
            <Badge variant="muted" data-team="you">
              You
            </Badge>
          )}
        </span>
      ),
    },
    { key: "email", header: "Email", truncate: true },
    { key: "role", header: "Role", cell: (m) => roleWords(m.role) },
    { key: "created_at", header: "Joined", cell: (m) => dateWords(m.created_at) },
  ];
  return (
    <>
      <DataTable
        label="Team members"
        columns={columns}
        rows={members}
        rowActions={(m) => (
          <>
            <RoleGate role={you?.role} action={actionFor(m.role)} mode="hide" reason="Only an owner can change an owner.">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(m)} data-team="change-role">
                Change role
              </Button>
            </RoleGate>
            {m.id !== you?.id && (
              <RoleGate role={you?.role} action={actionFor(m.role)} mode="hide" reason="Only an owner can remove an owner.">
                <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoving(m)} data-team="remove">
                  Remove
                </Button>
              </RoleGate>
            )}
          </>
        )}
      />
      {editing && <RoleDialog key={editing.id} member={editing} actorRole={you?.role} open onOpenChange={(v) => !v && setEditing(null)} onSave={(role) => onRole(editing, role)} />}
      <RemoveDialog member={removing} open={Boolean(removing)} onOpenChange={(v) => !v && setRemoving(null)} onRemove={() => onRemove(removing)} />
    </>
  );
}
