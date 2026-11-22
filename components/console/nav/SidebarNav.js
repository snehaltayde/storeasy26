"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  BadgePercent,
  Brush,
  ChartNoAxesColumn,
  CreditCard,
  FileText,
  FlaskConical,
  Home,
  Image as ImageIcon,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  ListTree,
  Package,
  PackageOpen,
  Paintbrush,
  Palette,
  PanelsTopLeft,
  Plug,
  Rocket,
  Settings,
  ShoppingCart,
  Workflow,
} from "lucide-react";
import { cx } from "../cx";

// Merchant nav (S50): 18 flat tabs become 6 role-aware groups. Items the
// role cannot USE are not shown (URLs stay reachable; server-side denials
// unchanged — this is honesty, not security).

const ICONS = {
  dashboard: LayoutDashboard,
  analytics: ChartNoAxesColumn,
  setup: ListChecks,
  orders: ShoppingCart,
  catalog: Package,
  media: ImageIcon,
  storefront: PanelsTopLeft,
  editor: Brush,
  start: Palette, // P6-NAV: "Logo and colours" (documents stores)
  "cms-home": Home,
  "cms-designer": Brush,
  "cms-pages": FileText,
  "cms-nav": ListTree,
  "cms-pdp": PackageOpen,
  theme: Palette,
  brand: Paintbrush,
  releases: Rocket,
  offers: BadgePercent,
  upsells: ArrowUpRight,
  experiments: FlaskConical,
  insights: Lightbulb,
  automations: Workflow,
  integrations: Plug,
  billing: CreditCard,
  settings: Settings,
};

// adminOnly = needs settings.*/sync.* — hidden from support & staff.
export const NAV_GROUPS = [
  {
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/admin/dashboard" },
      { id: "analytics", label: "Analytics", href: "/admin/analytics" },
      { id: "setup", label: "Setup", href: "/admin/setup", adminOnly: true, badgeKey: "setup" },
    ],
  },
  {
    label: "Orders",
    items: [{ id: "orders", label: "Orders", href: "/admin/orders", badgeKey: "returns" }],
  },
  {
    label: "Catalog",
    items: [{ id: "catalog", label: "Catalog", href: "/admin/catalog" }],
  },
  {
    label: "Storefront",
    items: [
      { id: "editor", label: "Editor", href: "/admin/editor" },
      { id: "start", label: "Logo and colours", href: "/admin/start" },
      { id: "media", label: "Media", href: "/admin/media" },
      { id: "releases", label: "Publishing", href: "/admin/releases", badgeKey: "publish" },
    ],
  },
  {
    label: "Growth",
    items: [
      { id: "offers", label: "Offers", href: "/admin/offers" },
      { id: "experiments", label: "Experiments", href: "/admin/experiments" },
      { id: "insights", label: "Insights", href: "/admin/insights" },
      { id: "automations", label: "Automations", href: "/admin/automations", adminOnly: true },
    ],
  },
  {
    label: "Store",
    items: [
      { id: "integrations", label: "Integrations", href: "/admin/integrations", adminOnly: true },
      { id: "billing", label: "Billing", href: "/admin/billing", adminOnly: true },
      { id: "settings", label: "Settings", href: "/admin/settings", adminOnly: true },
    ],
  },
];

// Documents is the sole CMS mode; keep navGroups(cmsMode) export for compatibility.
export function navGroups() {
  return NAV_GROUPS;
}

const ADMIN_ROLES = new Set(["admin", "owner"]);

export function SidebarNav({ role, badges = {}, cmsMode = null, collapsed = false, onNavigate }) {
  const pathname = usePathname();
  const isAdmin = ADMIN_ROLES.has(role);
  return (
    <nav aria-label="Console" className="flex flex-col gap-4">
      {navGroups(cmsMode).map((group) => {
        const items = group.items.filter((it) => !it.adminOnly || isAdmin);
        if (!items.length) return null;
        return (
          <div key={group.label}>
            {!collapsed && <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{group.label}</p>}
            <ul className="space-y-0.5">
              {items.map((it) => {
                const Icon = ICONS[it.id];
                // exact: an index item (e.g. Storefront overview) must not
                // stay lit while a sibling child route is open
                const active = it.exact ? pathname === it.href : pathname.startsWith(it.href);
                const badge = badges[it.badgeKey];
                return (
                  <li key={it.id}>
                    <Link
                      href={it.href}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? it.label : undefined}
                      onClick={onNavigate}
                      className={cx(
                        "relative flex items-center gap-2.5 rounded-ctl px-2 py-1.5 text-sm focus-ring motion-safe:transition-colors",
                        collapsed && "justify-center px-0 py-2",
                        active ? "bg-surface-sunken font-medium text-fg" : "text-fg-muted hover:bg-surface-sunken/60 hover:text-fg"
                      )}
                    >
                      {active && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />}
                      <Icon size={16} aria-hidden className={cx("shrink-0", active ? "text-fg" : "text-fg-subtle")} />
                      {!collapsed && <span className="min-w-0 flex-1 truncate">{it.label}</span>}
                      {!collapsed && badge != null && badge !== "" && (
                        <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums", it.badgeKey === "returns" ? "bg-warning-bg text-warning" : "bg-surface-sunken text-fg-muted")}>
                          {badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
