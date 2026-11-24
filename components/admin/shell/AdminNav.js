"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgePercent,
  Brush,
  ChartNoAxesColumn,
  CreditCard,
  FlaskConical,
  Image as ImageIcon,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Package,
  Plug,
  Rocket,
  Settings,
  ShoppingCart,
  Workflow,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { activeItem, navItems } from "@/lib/admin/nav";

// The console navigation (Phase 0 line 8). `nav` is navFor(role) from the
// server: what the role cannot use never reaches here. Icons by item id.
const ICONS = {
  dashboard: LayoutDashboard,
  analytics: ChartNoAxesColumn,
  onboarding: ListChecks,
  orders: ShoppingCart,
  catalog: Package,
  editor: Brush,
  media: ImageIcon,
  releases: Rocket,
  offers: BadgePercent,
  experiments: FlaskConical,
  insights: Lightbulb,
  automations: Workflow,
  integrations: Plug,
  billing: CreditCard,
  settings: Settings,
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

function Badge({ item, value }) {
  if (value == null || value === "") return null;
  if (item.badgeKey === "publish") {
    return (
      <SidebarMenuBadge data-badge="publish" aria-hidden>
        <span className="size-2 rounded-full bg-warning" />
      </SidebarMenuBadge>
    );
  }
  return (
    <SidebarMenuBadge data-badge={item.badgeKey} aria-hidden className="font-mono text-muted-foreground">
      {value}
    </SidebarMenuBadge>
  );
}

// Plain words for a badge, read by screen readers with the link.
const badgeWords = (item, value) => {
  if (value == null || value === "") return "";
  if (item.badgeKey === "publish") return ", unpublished changes";
  if (item.badgeKey === "returns") return `, ${value} open return${Number(value) === 1 ? "" : "s"}`;
  if (item.badgeKey === "onboarding") return `, ${value} steps done`;
  return "";
};

// The groups as sidebar menus; used by the sidebar and by the editor's sheet.
function NavGroups({ nav, badges = {}, onNavigate }) {
  const pathname = usePathname();
  const current = activeItem(pathname, navItems(nav));
  return (
    <nav aria-label="Console">
      {nav.map((group) => (
        <SidebarGroup key={group.label} className="py-1">
          {/* a one-item group named like its item (Orders, Catalog) shows no label: "Orders / Orders" is noise */}
          {!(group.items.length === 1 && group.items[0].label === group.label) && (
            <SidebarGroupLabel className="text-xs font-medium text-muted-foreground">{group.label}</SidebarGroupLabel>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const Icon = ICONS[item.id];
                const active = current?.id === item.id;
                const value = item.badgeKey ? badges[item.badgeKey] : null;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="data-[active=true]:[&_svg]:text-primary">
                      <Link href={item.href} aria-current={active ? "page" : undefined} onClick={onNavigate} data-nav-item={item.id}>
                        {Icon && <Icon aria-hidden />}
                        <span>{item.label}</span>
                        {badgeWords(item, value) && <span className="sr-only">{badgeWords(item, value)}</span>}
                      </Link>
                    </SidebarMenuButton>
                    <Badge item={item} value={value} />
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  );
}

// The sidebar: 240px from 1024px, icons with tooltips at 768-1023px, a sheet
// below 768px (components/ui/sidebar.js). A link tapped in the phone sheet closes it.
export function AdminNav({ nav, badges }) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 flex-row items-center gap-2 border-b border-sidebar-border px-3 group-data-[collapsible=icon]:px-3">
        <StoreasyMark />
        <span className="truncate text-base font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden">Storeasy</span>
      </SidebarHeader>
      <SidebarContent className="py-2">
        <NavGroups nav={nav} badges={badges} onNavigate={isMobile ? () => setOpenMobile(false) : undefined} />
      </SidebarContent>
    </Sidebar>
  );
}
