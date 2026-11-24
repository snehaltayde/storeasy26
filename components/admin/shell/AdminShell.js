"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { Eye } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readOnlyLabel } from "@/lib/admin/nav";
import { AdminNav } from "./AdminNav";
import { StoreSwitcher } from "./StoreSwitcher";
import { AccountMenu } from "./AccountMenu";

// The merchant console shell (Phase 0 line 8, docs/UI.md "Shell"), built from
// components/ui: the sidebar (cookie sidebar_state on /admin, read on the
// server for defaultOpen), a 56px sticky top bar, a skip link, and the
// content capped at 1200px with 24px side padding (16px below 768px).
//
// The old screens render inside `main > [data-legacy]` (display: contents):
// app/console.css gives that region the old tokens, so they keep their old
// look until Phase 2 rebuilds them. Everything outside it is the new shell.
//
// Onboarding (/admin/onboarding, docs/UI.md "Onboarding"): new UI, so no
// [data-legacy] region; no sidebar, the top bar without its toggle, and one
// centred column of at most 640px (data-onboarding="column"); from 1024px the
// main grows to 1200px so the step list sits to the column's left (the
// column stays 640px; a wide step, Brand, uses the full width).

// The phone sheet is opened by the top bar's toggle, not a Radix trigger, so
// Radix has nowhere to return focus when it closes (Esc, a link): back to the toggle.
function SheetFocusReturn() {
  const { isMobile, openMobile } = useSidebar();
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !openMobile && isMobile) document.querySelector('[data-shell-control="toggle"]')?.focus();
    was.current = openMobile;
  }, [openMobile, isMobile]);
  return null;
}

function SkipLink() {
  return (
    <a
      href="#console-content"
      data-shell-control="skip"
      className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-overlay outline-none focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      Skip to content
    </a>
  );
}

export const isOnboardingRoute = (pathname) => typeof pathname === "string" && (pathname === "/admin/onboarding" || pathname.startsWith("/admin/onboarding/"));

function TopBar({ actor, account, stores, storeName, storeId, toggle = true }) {
  const label = readOnlyLabel(actor);
  return (
    <header data-shell="topbar" className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 md:px-6">
      {toggle && <SidebarTrigger data-shell-control="toggle" aria-label="Show or hide navigation" aria-keyshortcuts="Meta+B Control+B" className="-ml-1" />}
      <StoreSwitcher stores={stores} current={{ id: storeId, name: storeName }} />
      <div className="flex-1" />
      {/* support's standing reminder: a quiet pill, icon-only on phones (the account menu says it in full) */}
      {label && (
        <p data-shell="read-only" className="flex h-6 min-w-0 shrink items-center gap-1 rounded-full border border-border bg-sidebar px-2 text-xs font-medium text-muted-foreground">
          <Eye aria-hidden className="size-3.5 shrink-0" />
          <span className="sr-only truncate sm:not-sr-only">{label}</span>
        </p>
      )}
      <AccountMenu actor={actor} account={account} />
    </header>
  );
}

// nav: navFor(role); badges: for visible items only; actor: { kind, role, id? };
// account: { name, email } | null; stores: listMyStores(); notices: a rendered
// <ConsoleNotices/>; defaultOpen: the sidebar_state cookie.
export function AdminShell({ nav, badges = {}, actor, account = null, stores = [], storeName, storeId = null, notices = null, defaultOpen = true, children }) {
  const pathname = usePathname();
  const content = (
    <div data-legacy className="contents">
      {notices && <div className="mb-6">{notices}</div>}
      {children}
    </div>
  );

  if (isOnboardingRoute(pathname)) {
    return (
      <TooltipProvider delayDuration={0}>
        <SidebarProvider defaultOpen={false} cookiePath="/admin" className="flex-col bg-background text-sm text-foreground">
          <SkipLink />
          <TopBar actor={actor} account={account} stores={stores} storeName={storeName} storeId={storeId} toggle={false} />
          <main id="console-content" tabIndex={-1} data-shell="onboarding" className="mx-auto w-full max-w-[640px] px-4 py-8 outline-none md:px-6 lg:max-w-[1200px]">
            {notices && <div className="mb-6">{notices}</div>}
            {children}
          </main>
        </SidebarProvider>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider defaultOpen={defaultOpen} cookiePath="/admin" className="bg-background text-sm text-foreground">
        <SkipLink />
        <SheetFocusReturn />
        <AdminNav nav={nav} badges={badges} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar actor={actor} account={account} stores={stores} storeName={storeName} storeId={storeId} />
          <SidebarInset id="console-content" tabIndex={-1} className="mx-auto block w-full max-w-[1200px] flex-none px-4 py-6 outline-none md:px-6">
            {content}
          </SidebarInset>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
