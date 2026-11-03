"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, Store } from "lucide-react";
import { cx } from "../cx";
import { Drawer } from "../Drawer";
import { IconButton } from "../Button";
import { SidebarNav } from "./SidebarNav";
import StoreSwitcher from "@/components/admin/StoreSwitcher";
import { isEditorRoute } from "@/components/admin/cms/editorLayout";

// Merchant console shell (S50): fixed role-aware sidebar (collapsible,
// persisted), store context pinned at top, role + sign-out pinned at
// bottom, and a mobile top bar + drawer under 768px. Mounted ONCE by the
// (authed) layout — the old per-page AdminNav re-mount (and StoreSwitcher
// flicker) is gone.
//
// ED-01: on editor routes (isEditorRoute) the shell steps aside. No sidebar,
// no 1024px cap and no page padding: the editor lays out the full window
// itself (components/admin/cms/EditorShell.js). The navigation folds into
// the same drawer the phone layout uses, opened from the editor's own top
// bar through useConsoleNav(). The founder's saved sidebar preference is
// left as it was. Anything else shown on an editor route (the error page,
// the loading skeleton) wraps itself in ConsolePageFrame, which gives it the
// menu button and the console's usual page padding, so a page that fails to
// load never leaves the founder without navigation or sign-out.

const ConsoleNavContext = createContext(null);

// → { openNav, editor: true, storeName } inside the console shell on an editor
// route, or null anywhere else.
export function useConsoleNav() {
  return useContext(ConsoleNavContext);
}

// On an editor route, lays out something that is not the editor: a small top
// bar with the menu button and the store's name, then the content in the
// console's usual padded, capped page. Anywhere else it renders its children
// untouched (the normal shell already has the sidebar and the padding).
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

function SignOut({ collapsed }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
        router.push("/admin/login");
        router.refresh();
      }}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-ctl px-2 py-1.5 text-sm text-fg-muted focus-ring hover:bg-surface-sunken hover:text-fg disabled:opacity-50",
        collapsed && "justify-center px-0"
      )}
      title={collapsed ? "Sign out" : undefined}
    >
      <LogOut size={16} aria-hidden className="shrink-0 text-fg-subtle" />
      {!collapsed && <span>{busy ? "Signing out…" : "Sign out"}</span>}
    </button>
  );
}

function SidebarBody({ storeName, host, role, actorKind, badges, collapsed, onNavigate }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cx("flex items-center gap-2.5 border-b border-edge px-3 py-3", collapsed && "justify-center px-0")}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-ctl bg-primary text-primary-fg">
          <Store size={15} aria-hidden />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-fg">{storeName}</p>
            {host && <p className="truncate text-[11px] text-fg-subtle">{host}</p>}
          </div>
        )}
      </div>
      {!collapsed && (
        <div className="border-b border-edge px-3 py-2 empty:hidden">
          <StoreSwitcher />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <SidebarNav role={role} badges={badges} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className="border-t border-edge px-2 py-2">
        {!collapsed && (
          <p className="mb-1 flex items-center gap-1.5 px-2 text-[11px] text-fg-subtle">
            <span className="rounded bg-surface-sunken px-1.5 py-0.5 font-medium text-fg-muted">{role}</span>
            {actorKind === "operator-support" && <span className="text-warning">support access · read-only</span>}
          </p>
        )}
        <SignOut collapsed={collapsed} />
      </div>
    </div>
  );
}

export function ConsoleShell({ storeName, host, role, actorKind, badges, children }) {
  const pathname = usePathname();
  const editor = isEditorRoute(pathname);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("console.nav") === "collapsed");
    } catch {}
    setReady(true);
  }, []);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("console.nav", next ? "collapsed" : "open");
    } catch {}
  };
  const navDrawer = (
    <Drawer open={drawer} onClose={() => setDrawer(false)} side="left" title={storeName}>
      <SidebarBody storeName={storeName} host={host} role={role} actorKind={actorKind} badges={badges} collapsed={false} onNavigate={() => setDrawer(false)} />
    </Drawer>
  );

  if (editor) {
    return (
      <ConsoleNavContext.Provider value={{ openNav: () => setDrawer(true), editor: true, storeName }}>
        {navDrawer}
        <main className="min-w-0">{children}</main>
      </ConsoleNavContext.Provider>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* desktop sidebar */}
      <aside
        className={cx(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-edge bg-surface md:flex",
          collapsed ? "w-16" : "w-60",
          ready && "motion-safe:transition-[width]"
        )}
      >
        <SidebarBody storeName={storeName} host={host} role={role} actorKind={actorKind} badges={badges} collapsed={collapsed} />
        <div className="border-t border-edge p-2">
          <IconButton
            label={collapsed ? "Expand navigation" : "Collapse navigation"}
            icon={collapsed ? <PanelLeftOpen size={15} aria-hidden /> : <PanelLeftClose size={15} aria-hidden />}
            onClick={toggle}
            className="w-full"
          />
        </div>
      </aside>

      {/* mobile top bar + drawer */}
      {navDrawer}

      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-edge bg-surface px-4 py-2.5 md:hidden">
          <IconButton label="Open menu" icon={<Menu size={17} aria-hidden />} onClick={() => setDrawer(true)} />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">{storeName}</p>
        </div>
        <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
