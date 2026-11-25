"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pencil, ShieldCheck, UserMinus } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DataTable } from "@/components/kit/data-table";
import { RoleGate } from "@/components/kit/role-gate";
import { RoleSelect } from "@/components/admin/team/RoleSelect";
import { RemoveDialog } from "@/components/admin/team/RemoveDialog";
import { Refusal } from "@/components/admin/team/Refusal";
import { RowActionBody, rowAction } from "@/components/admin/team/RowAction";
import { actionFor, dateWords, initials, roleWords } from "@/components/admin/team/team-words";

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
      <DialogContent data-team="role-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Change ${who}'s role`}</DialogTitle>
          <DialogDescription>{`Now ${roleWords(member?.role)}. The change takes effect on their next click, and any invite still waiting for them stops working.`}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="team-role">Role</Label>
            <RoleSelect id="team-role" actorRole={actorRole} value={role} onChange={setRole} />
          </div>
          <Refusal>{error}</Refusal>
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
      // takes the room that's left and truncates inside (the full name in title)
      className: "w-full max-w-0 lg:w-auto lg:max-w-none",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar size="sm" aria-hidden="true" className="max-sm:hidden">
            <AvatarFallback className="text-[0.625rem] font-medium">{initials(m.name, m.email)}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-foreground" title={m.name || m.email}>
              {m.name || m.email}
            </span>
            {/* below 1024px the email column folds in here */}
            {m.name && <span className="truncate text-xs text-muted-foreground lg:hidden">{m.email}</span>}
          </span>
          {m.id === you?.id && (
            <Badge variant="default" data-team="you" title="This is you">
              You
            </Badge>
          )}
        </span>
      ),
    },
    { key: "email", header: "Email", truncate: true, className: "hidden lg:table-cell" },
    {
      key: "role",
      header: "Role",
      cell: (m) =>
        m.role === "owner" ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck aria-hidden="true" className="size-4 text-primary" />
            {roleWords(m.role)}
          </span>
        ) : (
          roleWords(m.role)
        ),
    },
    { key: "created_at", header: "Joined", className: "hidden lg:table-cell", cell: (m) => <span className="whitespace-nowrap text-muted-foreground">{dateWords(m.created_at)}</span> },
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
              <Button {...rowAction("Change role")} onClick={() => setEditing(m)} data-team="change-role">
                <RowActionBody icon={Pencil}>Change role</RowActionBody>
              </Button>
            </RoleGate>
            {m.id !== you?.id && (
              <RoleGate role={you?.role} action={actionFor(m.role)} mode="hide" reason="Only an owner can remove an owner.">
                <Button {...rowAction("Remove", { danger: true })} onClick={() => setRemoving(m)} data-team="remove">
                  <RowActionBody icon={UserMinus}>Remove</RowActionBody>
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
