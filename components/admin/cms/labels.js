// Shared CMS vocabulary (S52): one humanized name + editor destination per
// content item, used by the Overview, the Publishing diff, and breadcrumbs.
// Pure data — safe for client and server imports.

export const BLOCK_INFO = {
  announcement: { label: "Announcement bar", href: "/admin/storefront/navigation#announcement" },
  hero: { label: "Homepage hero", href: "/admin/storefront/home#hero" },
  home_sections: { label: "Homepage sections", href: "/admin/storefront/home#sections" },
  nav_header: { label: "Header menu", href: "/admin/storefront/navigation#header" },
  nav_footer: { label: "Footer links", href: "/admin/storefront/navigation#footer" },
  collections_index: { label: "Collections page", href: "/admin/storefront/home#collections" },
  pdp_extras: { label: "Product page accordions", href: "/admin/storefront/product-pages" },
  surface_templates: { label: "Page templates", href: "/admin/theme#page-templates" },
};

export const CHANGE_LABELS = {
  customized: "customized",
  edited: "edited",
  reset: "reset to default",
  added: "new",
  removed: "removed",
  upgrade: "publishing upgrade",
};

export const CHANGE_TONES = {
  customized: "info",
  edited: "info",
  reset: "warning",
  added: "success",
  removed: "danger",
};

// A releaseDiff item → {label, href, changeLabel, tone}
export function diffItemInfo(item) {
  if (item.type === "block") {
    const b = BLOCK_INFO[item.key] || { label: item.key, href: "/admin/storefront" };
    return { ...b, changeLabel: CHANGE_LABELS[item.change] || item.change, tone: CHANGE_TONES[item.change] || "info" };
  }
  if (item.type === "page")
    return {
      label: `Page: ${item.key}`,
      href: item.change === "removed" ? "/admin/storefront/pages" : `/admin/storefront/pages/${item.key}`,
      changeLabel: CHANGE_LABELS[item.change] || item.change,
      tone: CHANGE_TONES[item.change] || "info",
    };
  if (item.type === "brand") return { label: "Brand", href: "/admin/brand", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: CHANGE_TONES[item.change] || "info" };
  if (item.type === "theme") return { label: "Theme kit", href: "/admin/theme", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: CHANGE_TONES[item.change] || "info" };
  // S53 (0B-2): the presentation sets that joined the release snapshot
  if (item.type === "overrides")
    return { label: "Product modules & badges", href: "/admin/catalog", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: "info" };
  if (item.type === "pins")
    return { label: "Collection pins", href: "/admin/catalog", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: "info" };
  if (item.type === "placements")
    return { label: "Upsell placements", href: "/admin/upsells", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: "info" };
  if (item.type === "redirects")
    return { label: "Page redirects", href: "/admin/storefront/pages", changeLabel: CHANGE_LABELS[item.change] || item.change, tone: "info" };
  if (item.type === "envelope")
    return {
      label: "Publishing upgrade — pins, modules, placements & redirects now publish with releases",
      href: "/admin/releases",
      changeLabel: "one-time",
      tone: "info",
    };
  return { label: item.key, href: "/admin/storefront", changeLabel: item.change, tone: "info" };
}

// Storefront URL a page is served at, by family.
export function pageUrl(page) {
  const { slug, family } = page;
  if (family === "campaign") return `/campaigns/${slug}`;
  if (family === "journal") return `/journal/${slug}`;
  if (slug === "about") return "/about";
  if (slug === "contact") return "/contact";
  return `/policies/${slug}`;
}

export const FAMILY_LABELS = { page: "Page", campaign: "Campaign", journal: "Journal" };
