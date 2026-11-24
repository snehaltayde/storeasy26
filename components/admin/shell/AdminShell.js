"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Eye, Menu } from "lucide-react";
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IconButton } from "@/components/console/Button";
import { isEditorRoute } from "@/components/admin/shared/editorLayout";
import { readOnlyLabel } from "@/lib/admin/nav";
import { AdminNav, NavGroups, StoreasyMark } from "./AdminNav";
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
// Editor routes (isEditorRoute): the shell steps aside. No sidebar, no top
// bar and no cap; the navigation opens in a sheet from the editor's own top
// bar through useConsoleNav(). ConsolePageFrame gives anything else shown on
// such a route (the error page, the loading skeleton) the menu button and
// the usual padded page.

const ConsoleNavContext = createContext(null);

// → { openNav, editor: true, storeName } on an editor route, or null.
export function useConsoleNav() {
  return useContext(ConsoleNavContext);
}

export function ConsolePageFrame({ children }) {
  const nav = useConsoleNav();
  if (!nav?.editor) return children;
  return (
    <div data-console-page-frame>
      <div className="flex items-center gap-2 border-b border-edge bg-surface px-3 py-2">
        <IconButton data-console-menu label="Open menu" icon={<Menu size={17} aria-hidden />} onClick={nav.openNav} />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{nav.storeName}</p>
      </div>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">{children}</div>
    </div>
  );
}

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

function TopBar({ actor, account, stores, storeName, storeId }) {
  const label = readOnlyLabel(actor);
  return (
    <header data-shell="topbar" className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4 md:px-6">
      <SidebarTrigger data-shell-control="toggle" aria-label="Show or hide navigation" aria-keyshortcuts="Meta+B Control+B" className="-ml-1" />
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
  const editor = isEditorRoute(pathname);
  const [sheet, setSheet] = useState(false);
  // the editor's sheet returns focus to whatever opened it (the editor's own menu button)
  const opener = useRef(null);
  const openNav = () => {
    opener.current = document.activeElement;
    setSheet(true);
  };
  const content = (
    <div data-legacy className="contents">
      {notices && <div className="mb-6">{notices}</div>}
      {children}
    </div>
  );

  if (editor) {
    return (
      <ConsoleNavContext.Provider value={{ openNav, editor: true, storeName }}>
        <TooltipProvider delayDuration={0}>
          <SidebarProvider defaultOpen={defaultOpen} cookiePath="/admin" className="bg-background text-sm text-foreground">
            <SkipLink />
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent
                side="left"
                className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground"
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  opener.current?.focus?.();
                }}
              >
                <SheetHeader className="h-14 flex-row items-center gap-2 border-b border-sidebar-border px-3 py-0">
                  <StoreasyMark />
                  <SheetTitle className="text-base">Storeasy</SheetTitle>
                  <SheetDescription className="sr-only">Every area of the console.</SheetDescription>
                </SheetHeader>
                <div className="overflow-y-auto py-2">
                  <NavGroups nav={nav} badges={badges} onNavigate={() => setSheet(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <main id="console-content" className="min-w-0 flex-1">
              {content}
            </main>
          </SidebarProvider>
        </TooltipProvider>
      </ConsoleNavContext.Provider>
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
