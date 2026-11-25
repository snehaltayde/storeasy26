// The operator console's navigation (Phase 3 line 0), as plain data: no JSX,
// so the server layout, the unit suite and the browser drill read one list.
// Icons are mapped by id in components/platform/shell/PlatformNav.js.
// Operators have no roles (docs/plans/phase-3.md), so every signed-in operator
// sees every item. Later lines append their items at the end
// (3 Billing; 4 Flags, Incidents; 5 Support access; 6 Operations).
//
// Each item: { id, label, href }
export const PLATFORM_NAV = Object.freeze([
  { id: "stores", label: "Stores", href: "/platform" },
  { id: "onboarding", label: "Signups & onboarding", href: "/platform/onboarding" },
  { id: "new-store", label: "New store", href: "/platform/stores/new" },
  { id: "flags", label: "Flags", href: "/platform/flags" },
  { id: "incidents", label: "Incidents", href: "/platform/incidents" },
  { id: "billing", label: "Billing", href: "/platform/billing" },
  // line 1: the old console, moved from /platform (removed by Phase 3 line 7)
  { id: "old-console", label: "Old console", href: "/platform/legacy" },
  { id: "operations", label: "Operations", href: "/platform/operations" },
]);

// The item a path is under: the longest href that is the path or a parent of
// it ("/platform/stores/new" is New store, not Stores).
export function activePlatformItem(pathname, items = PLATFORM_NAV) {
  if (typeof pathname !== "string") return null;
  let best = null;
  for (const it of items) {
    if (pathname !== it.href && !pathname.startsWith(`${it.href}/`)) continue;
    if (!best || it.href.length > best.href.length) best = it;
  }
  return best;
}

// Who is signed in, in plain words, for the account menu.
export function operatorAccount(operator) {
  if (!operator) return null;
  if (operator.kind === "bootstrap") return { name: operator.name, email: null, note: "Signed in with the setup password. Create an operator account to switch it off." };
  return { name: operator.name, email: operator.email, note: null };
}
