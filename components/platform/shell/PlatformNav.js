"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Store, ListChecks, Plus } from "lucide-react";
import { Wrench } from "lucide-react"; // line 6: Operations
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
import { StoreasyMark } from "@/components/kit/storeasy-mark";
import { activePlatformItem } from "@/lib/platform/nav";

// The operator navigation (Phase 3 line 0). Icons by item id; later lines add theirs.
const ICONS = {
  stores: Store,
  onboarding: ListChecks,
  "new-store": Plus,
  operations: Wrench,
};

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
