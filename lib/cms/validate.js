// CMS block validation (Session 23) — pure, console-facing. Returns
// { ok, errors, value } with value normalized for storage.
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
      value.push({ label, href: link });
    }
    return { ok: !errors.length, errors, value };
  }

  return { ok: false, errors: [`unknown block "${key}"`], value: null };
}
