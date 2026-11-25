"use client";

import { cn } from "@/components/ui/utils";
import { ROLE_WORDS, ROLE_HELP, assignableRoles } from "@/components/admin/team/team-words";

const SELECT = "h-8 w-full rounded-md border border-input bg-muted dark:bg-input/30 px-2.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:opacity-50";

// The role picker (a native select: the phone's own picker, no portal). Owner
// is offered only to an owner; the server refuses it to anyone else anyway.
//   actorRole: the caller's role; value / onChange(role); id for the label;
//   anything else (aria-describedby) goes on the select
export function RoleSelect({ actorRole, value, onChange, id, disabled = false, className, ...rest }) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={cn(SELECT, className)} data-team="role-select" {...rest}>
      {assignableRoles(actorRole).map((r) => (
        <option key={r} value={r}>
          {`${ROLE_WORDS[r]}: ${ROLE_HELP[r]}`}
        </option>
      ))}
    </select>
  );
}
