// The merchant console's navigation (Phase 0 line 8), as plain data: no JSX,
// no imports beyond the role map, so the server layout, the unit suite and the
// browser drill read the same list. Icons are mapped by id in
// components/admin/shell/AdminNav.js.
//
// Each item: { id, label, href, page, action, badgeKey? }
//   page     its row in the page→data-action table (scripts/support/admin-pages.js)
//   action   what the role must hold to SEE the item. Always a read.
// Hidden, not disabled: navFor(role) drops what the role cannot use, on the
// server, so a hidden item never reaches the browser.
import { roleAllows } from "../platform/authz.js";

export const NAV = Object.freeze([
  {
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/admin/dashboard", page: "dashboard", action: "storefront.read" },
      { id: "analytics", label: "Analytics", href: "/admin/analytics", page: "analytics", action: "orders.read" },
      { id: "onboarding", label: "Onboarding", href: "/admin/onboarding", page: "onboarding", action: "storefront.read", badgeKey: "onboarding" },
    ],
  },
  {
    label: "Orders",
    items: [{ id: "orders", label: "Orders", href: "/admin/orders", page: "orders", action: "orders.read", badgeKey: "returns" }],
  },
  {
    label: "Catalog",
    items: [
      { id: "catalog", label: "Catalog", href: "/admin/catalog", page: "catalog", action: "storefront.read" },
      { id: "quizzes", label: "Quizzes", href: "/admin/quizzes", page: "quizzes", action: "storefront.read" }, // Phase 2 line 10
    ],
  },
  {
    label: "Storefront",
    items: [
      { id: "editor", label: "Studio", href: "/admin/studio", page: "studio", action: "storefront.read" }, // Phase 6: the studio (product and collection content still open /admin/editor)
      { id: "media", label: "Media", href: "/admin/media", page: "media", action: "storefront.read" },
      { id: "releases", label: "Publishing", href: "/admin/releases", page: "releases", action: "storefront.read", badgeKey: "publish" },
    ],
  },
  {
    label: "Growth",
    items: [
      { id: "offers", label: "Offers", href: "/admin/offers", page: "offers", action: "offers.read" },
      { id: "bundles", label: "Bundles", href: "/admin/bundles", page: "bundles", action: "offers.read" },
      { id: "experiments", label: "Experiments", href: "/admin/experiments", page: "experiments", action: "storefront.read" },
      { id: "insights", label: "Insights", href: "/admin/insights", page: "insights", action: "storefront.read" },
      { id: "automations", label: "Automations", href: "/admin/automations", page: "automations", action: "settings.read" },
    ],
  },
  {
    label: "Store",
    items: [
      { id: "apps", label: "Apps", href: "/admin/apps", page: "apps", action: "apps.read" }, // Phase 4 line 1
      { id: "themes", label: "Themes", href: "/admin/themes", page: "themes", action: "storefront.read" }, // Phase 5 line 1
      { id: "integrations", label: "Integrations", href: "/admin/integrations", page: "integrations", action: "settings.read" },
      { id: "billing", label: "Billing", href: "/admin/billing", page: "billing", action: "settings.read" },
      { id: "settings", label: "Settings", href: "/admin/settings", page: "settings", action: "settings.read" },
    ],
  },
].map((g) => Object.freeze({ label: g.label, items: Object.freeze(g.items.map((i) => Object.freeze(i))) })));

// The groups a role can use, empty groups dropped. An unknown role gets nothing.
export function navFor(role) {
  return NAV.map((g) => ({ label: g.label, items: g.items.filter((i) => roleAllows(role, i.action)) })).filter((g) => g.items.length);
}

export const navItems = (groups) => groups.flatMap((g) => g.items);

// The item a path belongs to: the longest href that is the path or a prefix
// of it at a "/" (/admin/orders/ord_1 → Orders, /admin/studio/x →
// Studio; /admin/settingsx matches nothing). → the item or null.
export function activeItem(pathname, items) {
  if (typeof pathname !== "string") return null;
  let best = null;
  for (const it of items) {
    if (pathname !== it.href && !pathname.startsWith(`${it.href}/`)) continue;
    if (!best || it.href.length > best.href.length) best = it;
  }
  return best;
}

// Role names in plain words, for the account menu.
export const ROLE_WORDS = Object.freeze({ owner: "Owner", admin: "Admin", staff: "Staff", support: "Support" });

// The read-only label the top bar shows, or null.
export function readOnlyLabel(actor) {
  if (actor?.kind === "operator-support") return "Platform support access · read-only";
  if (actor?.role === "support") return "Read-only access";
  return null;
}

// What the account menu shows, as rows: { kind: "text" | "note" | "sign-out", id, text }.
// The only action is signing out (POST /api/admin/logout, as before line 8);
// nothing here changes the store. account: { name, email } for a member, else null.
export function accountItems(actor, account = null) {
  const rows = [];
  if (actor?.kind === "operator-support") {
    rows.push({ kind: "text", id: "who", text: `Operator ${actor.id}` });
  } else if (actor?.kind === "bootstrap") {
    rows.push({ kind: "text", id: "who", text: "Store setup login" });
  } else {
    if (account?.name) rows.push({ kind: "text", id: "name", text: account.name });
    if (account?.email) rows.push({ kind: "text", id: "email", text: account.email });
  }
  if (actor?.kind !== "operator-support" && actor?.kind !== "bootstrap") rows.push({ kind: "text", id: "role", text: ROLE_WORDS[actor?.role] || "Member" });
  const note = readOnlyLabel(actor);
  if (note) rows.push({ kind: "note", id: "read-only", text: actor.kind === "operator-support" ? "You can look around this store; nothing can be changed." : "Your role can look at everything here but not change it." });
  rows.push({ kind: "sign-out", id: "sign-out", text: "Sign out" });
  return rows;
}

// What the store switcher shows: the caller's stores (listMyStores), the
// current one checked; with none (bootstrap, operator support) only the
// current store; when no row is the current store, the current store is
// added as the checked row (never the first store ticked by default); then a
// link to the storefront.
//   → [{ kind: "store", id, name, role, url, current } | { kind: "link", id, text, href }]
export function switcherItems(stores, current) {
  const here = { id: current?.id || "current", name: current?.name || "Store", role: null, url: null, current: true };
  let list = (stores || []).map((s) => (current?.id && s.id === current.id ? { ...s, current: true } : s));
  if (!list.some((s) => s.current)) list = [here, ...list];
  return [
    ...list.map((s) => ({ kind: "store", id: s.id, name: s.name, role: s.role ? ROLE_WORDS[s.role] || s.role : null, url: s.url, current: Boolean(s.current) })),
    { kind: "link", id: "storefront", text: "Open storefront", href: "/" },
  ];
}
