"use client";

import { useEffect, useRef, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
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
import { PlatformNav } from "./PlatformNav";

// The operator console shell (Phase 3 line 0), built from components/ui like
// the merchant shell: the sidebar (cookie sidebar_state on /platform, read on
// the server for defaultOpen), a 56px sticky top bar with the operator's
// account menu, a skip link, and the content capped at 1200px. Only signed-in
// operators get it (app/(console)/platform/layout.js). Old screens keep their
// own [data-legacy] region inside it (app/(console)/platform/page.js).

const initials = (text) =>
  String(text || "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("") || "?";

// The phone sheet is opened by the top bar's toggle, not a Radix trigger, so
// focus goes back to the toggle when it closes.
function SheetFocusReturn() {
  const { isMobile, openMobile } = useSidebar();
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !openMobile && isMobile) document.querySelector('[data-shell-control="toggle"]')?.focus();
    was.current = openMobile;
  }, [openMobile, isMobile]);
  return null;
}

function AccountMenu({ account }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await fetch("/api/platform/logout", { method: "POST" }).catch(() => {});
    window.location.assign("/platform");
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" data-shell-control="account" aria-label="Open account menu" className="rounded-full">
          <Avatar className="size-8">
            <AvatarFallback className="text-xs font-medium">{initials(account?.name || account?.email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2 text-sm font-normal text-foreground">
          <span data-account="name" className="truncate font-medium">{account?.name}</span>
          {account?.email && (
            <span data-account="email" title={account.email} className="truncate text-xs text-muted-foreground">
              {account.email}
            </span>
          )}
        </DropdownMenuLabel>
        {account?.note && (
          <p data-account="note" className="mx-1.5 mb-2 rounded-md bg-sidebar px-2 py-1.5 text-xs text-muted-foreground">
            {account.note}
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

// nav: PLATFORM_NAV; account: operatorAccount(operator); defaultOpen: the sidebar_state cookie.
export function PlatformShell({ nav, account, defaultOpen = true, children }) {
  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider defaultOpen={defaultOpen} cookiePath="/platform" data-shell="platform" className="bg-background text-sm text-foreground">
        <a
          href="#console-content"
          data-shell-control="skip"
          className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-overlay outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          Skip to content
        </a>
        <SheetFocusReturn />
        <PlatformNav nav={nav} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header data-shell="topbar" className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 md:px-6">
            <SidebarTrigger data-shell-control="toggle" aria-label="Show or hide navigation" aria-keyshortcuts="Meta+B Control+B" className="-ml-1" />
            <div className="flex-1" />
            {/* the setup password's standing reminder: a quiet warning pill,
                icon-only on phones (the account menu says it in full) */}
            {account?.note && (
              <p data-shell="setup-password" title={account.note} className="flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 text-xs font-medium text-warning-text">
                <KeyRound aria-hidden className="size-3.5 shrink-0" />
                <span className="sr-only truncate sm:not-sr-only">Setup password</span>
              </p>
            )}
            <AccountMenu account={account} />
          </header>
          <SidebarInset id="console-content" tabIndex={-1} className="mx-auto block w-full max-w-[1200px] flex-none px-4 py-6 outline-none md:px-6">
            {children}
          </SidebarInset>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
