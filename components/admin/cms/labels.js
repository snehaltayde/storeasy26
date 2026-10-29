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
};

export const CHANGE_LABELS = {
  customized: "customized",
  edited: "edited",
  reset: "reset to default",
  added: "new",
  removed: "removed",
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
