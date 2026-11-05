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
  // S52: the one overloaded Storefront screen became a CMS with dedicated
  // areas. Media moved here from Catalog (it's content, and the pickers live
  // in these editors); Releases reads as "Publishing".
  {
    label: "Storefront",
    items: [
      { id: "storefront", label: "Overview", href: "/admin/storefront", exact: true },
      { id: "cms-home", label: "Home page", href: "/admin/storefront/home" },
      { id: "cms-designer", label: "Designer", href: "/admin/storefront/designer" },
      { id: "cms-pages", label: "Pages", href: "/admin/storefront/pages" },
      { id: "cms-nav", label: "Navigation", href: "/admin/storefront/navigation" },
      { id: "cms-pdp", label: "Product pages", href: "/admin/storefront/product-pages" },
      { id: "theme", label: "Theme", href: "/admin/theme" },
      { id: "brand", label: "Brand", href: "/admin/brand" },
      { id: "media", label: "Media", href: "/admin/media" },
      { id: "releases", label: "Publishing", href: "/admin/releases", badgeKey: "publish" },
    ],
  },
  {
    label: "Growth",
    items: [
      { id: "offers", label: "Offers", href: "/admin/offers" },
      { id: "upsells", label: "Upsells", href: "/admin/upsells" },
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

// P3-ROUTES (ED-02, US-38): on a documents store one "Editor" link replaces
// the old content, theme and brand screens (each of them redirects to the
// editor there anyway); Media and Publishing stay. Every other mode gets
// NAV_GROUPS exactly as it is.
// P6-NAV (GEN-04, US-01): after Editor, "Logo and colours" (the brand step at
// /admin/start), so the logo and palette can be found again after the store
// opens. For everyone who sees the Editor link (not admin-only).
const DOCUMENTS_STOREFRONT = new Set(["media", "releases"]);
export function navGroups(cmsMode) {
  if (cmsMode !== "documents") return NAV_GROUPS;
  return NAV_GROUPS.map((group) =>
    group.label !== "Storefront"
      ? group
      : { ...group, items: [{ id: "editor", label: "Editor", href: "/admin/editor" }, { id: "start", label: "Logo and colours", href: "/admin/start" }, ...group.items.filter((it) => DOCUMENTS_STOREFRONT.has(it.id))] }
  );
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
