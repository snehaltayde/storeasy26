"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Store, ListChecks, Plus } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { activePlatformItem } from "@/lib/platform/nav";

// The operator navigation (Phase 3 line 0). Icons by item id; later lines add theirs.
const ICONS = {
  stores: Store,
  onboarding: ListChecks,
  "new-store": Plus,
};

// The Storeasy mark: the platform lime is the logo's colour only (docs/UI.md).
function StoreasyMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-6 shrink-0 rounded-md">
      <rect width="24" height="24" rx="6" fill="#84cc16" />
      <path d="M15.5 8.2c-.8-.9-2-1.4-3.4-1.4-2 0-3.4 1.1-3.4 2.6 0 3.4 6.8 1.9 6.8 5.2 0 1.6-1.5 2.6-3.5 2.6-1.5 0-2.8-.6-3.6-1.6" fill="none" stroke="#1a2e05" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// 240px from 1024px, icons with tooltips at 768-1023px, a sheet below 768px
// (components/ui/sidebar.js). A link tapped in the phone sheet closes it.
export function PlatformNav({ nav }) {
  const pathname = usePathname();
  const current = activePlatformItem(pathname, nav);
  const { isMobile, setOpenMobile } = useSidebar();
  const onNavigate = isMobile ? () => setOpenMobile(false) : undefined;
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex-row items-center gap-2 border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-3">
        <StoreasyMark />
        <span className="truncate text-base font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">Storeasy platform</span>
      </SidebarHeader>
      <SidebarContent className="py-2">
        <nav aria-label="Operator console">
          <SidebarGroup className="py-1">
            <SidebarGroupContent>
              <SidebarMenu>
                {nav.map((item) => {
                  const Icon = ICONS[item.id];
                  const active = current?.id === item.id;
                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="data-[active=true]:[&_svg]:text-primary">
                        <Link href={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate} data-nav-item={item.id}>
                          {Icon && <Icon aria-hidden />}
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
