"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { accountItems } from "@/lib/admin/nav";

const initials = (text) =>
  String(text || "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";

// The account menu (Phase 0 line 8): who is signed in, in plain words, and
// Sign out, which posts to /api/admin/logout and goes to the sign-in page.
export function AccountMenu({ actor, account }) {
  const rows = accountItems(actor, account);
  const [busy, setBusy] = useState(false);
  const text = rows.filter((r) => r.kind === "text");
  const note = rows.find((r) => r.kind === "note");
  const signOut = async () => {
    setBusy(true);
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/admin/login");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" data-shell-control="account" aria-label="Open account menu" className="rounded-full">
          <Avatar className="size-8">
            <AvatarFallback className="text-xs font-medium">{initials(account?.name || account?.email || text[0]?.text)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2 text-sm font-normal text-foreground">
          {text.map((r, i) => (
            <span key={r.id} data-account={r.id} title={r.id === "email" ? r.text : undefined} className={i === 0 ? "truncate font-medium" : "truncate text-xs text-muted-foreground"}>
              {r.id === "role" ? `Role: ${r.text}` : r.text}
            </span>
          ))}
        </DropdownMenuLabel>
        {note && (
          <p data-account="read-only" className="mx-1.5 mb-2 rounded-md bg-sidebar px-2 py-1.5 text-xs text-muted-foreground">
            {note.text}
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem data-account="sign-out" disabled={busy} onSelect={signOut}>
            <LogOut aria-hidden />
            {busy ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
