// UTM retention for campaign pages (S39 / SF17). Pure + edge-safe.
//
// A visitor lands on /campaigns/launch?utm_source=ig&utm_campaign=drop — the
// campaign's internal links (to /collections, /products/…) carry those utm_*
// params forward, so attribution survives the click-through. External links
// and anchors are untouched; only utm_* keys ever propagate.
export function pickUtmParams(searchParams) {
  const out = {};
  for (const [k, v] of Object.entries(searchParams || {})) {
    if (/^utm_[a-z_]{1,30}$/.test(k) && typeof v === "string" && v) out[k] = v.slice(0, 200);
  }
  return out;
}

export function appendUtm(href, utm) {
  const keys = Object.keys(utm || {});
  if (!keys.length || !href.startsWith("/") || href.startsWith("//")) return href;
  const [path, hash = ""] = href.split("#");
  const sep = path.includes("?") ? "&" : "?";
  const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(utm[k])}`).join("&");
  return `${path}${sep}${qs}${hash ? `#${hash}` : ""}`;
}

// Rewrite internal hrefs inside already-SANITIZED html (href values are
// sanitizer-vetted, so a simple attribute pass is safe here).
export function appendUtmToHtml(html, utm) {
  if (!Object.keys(utm || {}).length) return html;
  return String(html).replace(/href="(\/[^"]*)"/g, (_, href) => `href="${appendUtm(href, utm).replace(/"/g, "&quot;")}"`);
}
