// The settings section nav (docs/plans/phase-2.md "Line 7"): one row per tab
// under /admin/settings, as plain data. settings/layout.js draws the nav from
// it; HashRedirect sends an old /admin/settings#<anchor> link (the one-page
// settings before Phase 2 line 7) to the tab that now holds that part.
//   id      the tab's key (and its folder under settings/, "" for Details)
//   label   the nav's words
//   href    the tab's page
//   hashes  the old page's anchors this tab replaces
//   action  the authz string the tab's data needs (lib/platform/authz.js);
//           settings.read unless said
// Team is Phase 2 line 8's page; this list only links to it.
export const SETTINGS_HOME = "/admin/settings";

export const SETTINGS_SECTIONS = Object.freeze(
  [
    { id: "details", label: "Details", href: SETTINGS_HOME, hashes: ["store-profile", "password"] },
    { id: "checkout", label: "Checkout and payments", href: `${SETTINGS_HOME}/checkout`, hashes: ["commerce", "payments"] },
    { id: "shipping", label: "Shipping", href: `${SETTINGS_HOME}/shipping`, hashes: ["shipping"] },
    // Phase 8 line 4: markets change what shoppers are charged, so admin and owner only
    { id: "markets", label: "Markets", href: `${SETTINGS_HOME}/markets`, hashes: ["markets"], action: "settings.write" },
    { id: "domains", label: "Domains and SEO", href: `${SETTINGS_HOME}/domains`, hashes: ["domains-seo"] },
    { id: "tracking", label: "Tracking", href: `${SETTINGS_HOME}/tracking`, hashes: ["tracking"] },
    { id: "sync", label: "Products from Shopify", href: `${SETTINGS_HOME}/sync`, hashes: ["catalog-sync"] },
    { id: "privacy", label: "Privacy", href: `${SETTINGS_HOME}/privacy`, hashes: ["privacy"] },
    { id: "audit", label: "Audit log", href: `${SETTINGS_HOME}/audit`, hashes: ["audit-log"], action: "audit.read" },
    { id: "help", label: "Help", href: `${SETTINGS_HOME}/help`, hashes: ["help"] },
    { id: "team", label: "Team", href: `${SETTINGS_HOME}/team`, hashes: ["team"], action: "team.manage" },
  ].map((s) => Object.freeze({ action: "settings.read", ...s })),
);

// The tab a path belongs to: the longest href that is the path or a parent of
// it at a "/" (Details only for /admin/settings itself). → the section or null.
export function sectionFor(pathname) {
  if (typeof pathname !== "string") return null;
  const path = pathname.replace(/\/+$/, "") || "/";
  let best = null;
  for (const s of SETTINGS_SECTIONS) {
    const hit = s.href === SETTINGS_HOME ? path === SETTINGS_HOME : path === s.href || path.startsWith(`${s.href}/`);
    if (hit && (!best || s.href.length > best.href.length)) best = s;
  }
  return best;
}

// An old anchor ("#payments" or "payments") → the tab's href, or null.
export function hashTarget(hash) {
  const id = String(hash ?? "").replace(/^#/, "");
  if (!id) return null;
  return SETTINGS_SECTIONS.find((s) => s.hashes.includes(id))?.href ?? null;
}

// The page a role without settings.read gets on any settings, integrations or
// billing URL: words only, no settings data.
export const NO_ACCESS_WORDS = Object.freeze({
  title: "Your role can't open settings",
  // the role's own name in it, as the console's other refusals say it
  body: (role) => `Your role (${role || "this one"}) can't open settings, integrations or billing; ask an owner or admin if something here needs changing.`,
  back: "Go to your dashboard",
});
// P2-F: the same refusal on any other console page a role's action doesn't allow
export const PAGE_NO_ACCESS_WORDS = Object.freeze({
  title: "Your role can't open this page",
  body: (role) => `Your role (${role || "this one"}) can't open this page; ask an owner or admin if you need what's on it.`,
  back: NO_ACCESS_WORDS.back,
});
