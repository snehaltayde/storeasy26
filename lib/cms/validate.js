// CMS block validation (Session 23; S37 adds banner/rich_text home sections,
// rich text allowlist-sanitized at save) — pure, console-facing. Returns
// { ok, errors, value } with value normalized for storage.
import { sanitizeHtml } from "../sanitize.js";
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const href = (v) => {
  const h = String(v ?? "").trim();
  return h === "" || h.startsWith("/") || h.startsWith("#") || /^https?:\/\//.test(h) ? h : null;
};

export function validateBlock(key, input) {
  const errors = [];

  if (key === "announcement") {
    const text = str(input?.text, 200);
    const link = href(input?.href);
    if (link == null) errors.push("Announcement link must be a path (/…) or full URL");
    if (input?.enabled && !text) errors.push("An enabled announcement needs text");
    return { ok: !errors.length, errors, value: { enabled: !!input?.enabled, text, href: link || "" } };
  }

  if (key === "hero") {
    const title = str(input?.title, 120);
    if (!title) errors.push("Hero title is required");
    const cta = (c, label) => {
      const l = str(c?.label, 40);
      const h = href(c?.href);
      if (h == null) errors.push(`${label} link must be a path or URL`);
      return l ? { label: l, href: h || "/" } : null;
    };
    const value = {
      title,
      highlight: str(input?.highlight, 60),
      subtitle: str(input?.subtitle, 300),
      primary: cta(input?.primary, "Primary CTA"),
      secondary: cta(input?.secondary, "Secondary CTA"),
      ...(str(input?.badge, 80) ? { badge: str(input?.badge, 80) } : {}),
    };
    return { ok: !errors.length, errors, value };
  }

  if (key === "home_sections") {
    if (!Array.isArray(input)) return { ok: false, errors: ["home_sections must be a list"], value: [] };
    const value = [];
    for (const [i, s] of input.entries()) {
      // S37 (MC08): merchant-composable kinds joined the two catalog ones
      if (s?.kind === "banner") {
        const link = href(s.href);
        if (link == null) errors.push(`Section ${i + 1} (banner): link must be a path or URL`);
        if (!str(s.title, 80) && !str(s.text, 300)) errors.push(`Section ${i + 1} (banner): needs a title or text`);
        value.push({ kind: "banner", title: str(s.title, 80), text: str(s.text, 300), label: str(s.label, 40), href: link || "", enabled: s.enabled !== false });
        continue;
      }
      if (s?.kind === "rich_text") {
        const html = sanitizeHtml(String(s.html ?? "")).slice(0, 20000); // allowlist-sanitized AT SAVE
        if (!html.trim()) errors.push(`Section ${i + 1} (rich text): content is empty`);
        value.push({ kind: "rich_text", title: str(s.title, 80), html, enabled: s.enabled !== false });
        continue;
      }
      if (!["collections", "new"].includes(s?.kind)) {
        errors.push(`Section ${i + 1}: unknown kind "${s?.kind}"`);
        continue;
      }
      const limit = Number(s.limit);
      value.push({
        kind: s.kind,
        title: str(s.title, 80) || (s.kind === "collections" ? "Shop by collection" : "Fresh drops"),
        limit: Number.isFinite(limit) && limit >= 1 && limit <= 24 ? Math.floor(limit) : s.kind === "collections" ? 6 : 8,
        enabled: s.enabled !== false,
      });
    }
    return { ok: !errors.length, errors, value };
  }

  if (key === "collections_index") {
    // S38 (SF02): null = catalog-derived. Otherwise lists of collection handles.
    if (input == null) return { ok: true, errors: [], value: null };
    const handleList = (list, label, max) => {
      const out = [];
      for (const h of Array.isArray(list) ? list.slice(0, max) : []) {
        const v = String(h ?? "").trim().toLowerCase();
        if (!v) continue;
        if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(v)) errors.push(`${label}: "${v}" isn't a collection handle`);
        else if (!out.includes(v)) out.push(v);
      }
      return out;
    };
    const value = {
      featured: handleList(input.featured, "Featured", 6),
      order: handleList(input.order, "Order", 50),
      hide: handleList(input.hide, "Hidden", 50),
    };
    const shown = new Set([...value.featured, ...value.order]);
    for (const h of value.hide) if (shown.has(h)) errors.push(`"${h}" is both shown (featured/order) and hidden`);
    return { ok: !errors.length, errors, value };
  }

  if (key === "pdp_extras") {
    // S38 (SF04): accordions under every PDP description. null = none.
    if (input == null) return { ok: true, errors: [], value: null };
    if (!Array.isArray(input)) return { ok: false, errors: ["pdp_extras must be a list or null"], value: null };
    if (input.length > 8) errors.push("At most 8 PDP accordions");
    const value = [];
    for (const [i, item] of input.slice(0, 8).entries()) {
      const title = str(item?.title, 80);
      const html = sanitizeHtml(String(item?.html ?? "")).slice(0, 10000); // allowlist-sanitized AT SAVE
      if (!title) errors.push(`Accordion ${i + 1}: needs a title`);
      if (!html.trim()) errors.push(`Accordion ${i + 1}: content is empty`);
      value.push({ title, html, enabled: item?.enabled !== false });
    }
    return { ok: !errors.length, errors, value };
  }

  if (key === "nav_header" || key === "nav_footer") {
    if (input == null) return { ok: true, errors: [], value: null }; // null = derive from catalog
    if (!Array.isArray(input)) return { ok: false, errors: ["nav must be a list or null"], value: null };
    if (input.length > 12) errors.push("At most 12 nav items");
    const value = [];
    for (const [i, item] of input.slice(0, 12).entries()) {
      const label = str(item?.label, 40);
      const link = href(item?.href);
      if (!label || !link) {
        errors.push(`Nav item ${i + 1}: needs a label and a path/URL`);
        continue;
      }
      // S39 (MC11): one level of nesting — an item may carry up to 8 children
      // (header renders them as a keyboard-reachable dropdown).
      const children = [];
      if (Array.isArray(item.children)) {
        if (item.children.length > 8) errors.push(`Nav item ${i + 1}: at most 8 sub-items`);
        for (const [j, c] of item.children.slice(0, 8).entries()) {
          const cl = str(c?.label, 40);
          const ch = href(c?.href);
          if (!cl || !ch) {
            errors.push(`Nav item ${i + 1}.${j + 1}: needs a label and a path/URL`);
            continue;
          }
          if (Array.isArray(c.children) && c.children.length) errors.push(`Nav item ${i + 1}.${j + 1}: only one level of nesting`);
          children.push({ label: cl, href: ch });
        }
      }
      value.push({ label, href: link, ...(children.length ? { children } : {}) });
    }
    return { ok: !errors.length, errors, value };
  }

  return { ok: false, errors: [`unknown block "${key}"`], value: null };
}
