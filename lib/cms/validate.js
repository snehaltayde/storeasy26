// CMS block validation (Session 23; S37 adds banner/rich_text home sections,
// rich text allowlist-sanitized at save) — pure, console-facing. Returns
// { ok, issues, errors, value } with value normalized for storage.
// DOC-04: every problem is a structured issue (lib/cms/issues.js) naming its
// document, section id and field, and ALL of them are collected. `errors` is
// the messages alone, for older callers. No message carries a position: the
// editor works out "section 2" from the section id.
import { sanitizeHtml } from "../sanitize.js";
import { HOME_SECTION_KINDS, componentFor, ensureSectionIds } from "./registry.js";
import { SURFACE_TEMPLATE_CHOICES, SURFACE_ENTITY_KEYS } from "./defaults.js";
import { issue, BLOCK_DOCUMENTS, HERO_SECTION_ID, errorIssues, messagesOf } from "./issues.js";
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const href = (v) => {
  const h = String(v ?? "").trim();
  return h === "" || h.startsWith("/") || h.startsWith("#") || /^https?:\/\//.test(h) ? h : null;
};

export function validateBlock(key, input) {
  const issues = [];
  const documentId = BLOCK_DOCUMENTS[key] ?? null;
  const sectionOf = key === "hero" ? HERO_SECTION_ID : null;
  // problem("field", code, message) or problem({ sectionId, field }, code, message)
  const problem = (where, code, message) =>
    issues.push(issue({ documentId, sectionId: sectionOf, ...(where && typeof where === "object" ? where : { field: where }), code, message }));
  const result = (value) => {
    const errs = errorIssues(issues);
    return { ok: !errs.length, issues, errors: messagesOf(errs), value };
  };

  if (key === "announcement") {
    const text = str(input?.text, 200);
    const link = href(input?.href);
    if (link == null) problem("href", "LINK_INVALID", "Announcement link must be a path (/…) or full URL");
    if (input?.enabled && !text) problem("text", "REQUIRED", "An enabled announcement needs text");
    return result({ enabled: !!input?.enabled, text, href: link || "" });
  }

  if (key === "hero") {
    const title = str(input?.title, 120);
    if (!title) problem("title", "REQUIRED", "Hero title is required");
    const cta = (c, label, field) => {
      const l = str(c?.label, 40);
      const h = href(c?.href);
      if (h == null) problem(`${field}.href`, "LINK_INVALID", `${label} link must be a path or URL`);
      return l ? { label: l, href: h || "/" } : null;
    };
    const value = {
      title,
      highlight: str(input?.highlight, 60),
      subtitle: str(input?.subtitle, 300),
      primary: cta(input?.primary, "Primary CTA", "primary"),
      secondary: cta(input?.secondary, "Secondary CTA", "secondary"),
      ...(str(input?.badge, 80) ? { badge: str(input?.badge, 80) } : {}),
    };
    return result(value);
  }

  if (key === "home_sections") {
    if (!Array.isArray(input)) {
      problem(null, "INVALID_SHAPE", "The homepage sections couldn't be read. Reload the page and try again.");
      return result([]);
    }
    const value = [];
    // S54: durable instance ids ride through validation. DOC-04: they are
    // stamped FIRST (valid unique ids kept, the rest minted), so an issue
    // names the same id the saved section would carry.
    const stamped = ensureSectionIds(input.map((s) => (s && typeof s === "object" ? s : {})));
    for (const s of stamped) {
      const id = s.id;
      const at = (field) => ({ sectionId: id, field });
      // S37 (MC08): merchant-composable kinds joined the two catalog ones
      if (s.kind === "banner") {
        const link = href(s.href);
        if (link == null) problem(at("href"), "LINK_INVALID", "link must be a path or URL");
        if (!str(s.title, 80) && !str(s.text, 300)) problem(at("title"), "REQUIRED", "needs a title or text");
        value.push({ id, kind: "banner", title: str(s.title, 80), text: str(s.text, 300), label: str(s.label, 40), href: link || "", enabled: s.enabled !== false });
        continue;
      }
      if (s.kind === "rich_text") {
        const html = sanitizeHtml(String(s.html ?? "")).slice(0, 20000); // allowlist-sanitized AT SAVE
        if (!html.trim()) problem(at("html"), "REQUIRED", "content is empty");
        value.push({ id, kind: "rich_text", title: str(s.title, 80), html, enabled: s.enabled !== false });
        continue;
      }
      // S55 (audit slice 4): the broader library
      if (s.kind === "image_with_text") {
        const src = String(s.image ?? "").trim();
        if (!/^(https:\/\/|\/(?!\/))/.test(src)) problem(at("image"), "IMAGE_INVALID", "image must be https:// or a library path (/api/media/…)");
        if (!str(s.image_alt, 300)) problem(at("image_alt"), "REQUIRED", "image alt text is required");
        const link = s.href ? href(s.href) : "";
        if (s.href && link == null) problem(at("href"), "LINK_INVALID", "link must be a path or URL");
        value.push({
          id,
          kind: "image_with_text",
          image: src.slice(0, 500),
          image_alt: str(s.image_alt, 300),
          image_side: s.image_side === "right" ? "right" : "left",
          title: str(s.title, 80),
          text: str(s.text, 600),
          label: str(s.label, 40),
          href: link || "",
          enabled: s.enabled !== false,
        });
        continue;
      }
      if (s.kind === "product_rail") {
        const collection = String(s.collection ?? "").trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(collection)) problem(at("collection"), "REQUIRED", "pick a collection");
        // S57 (ref migration): the picker also records the catalog ID, so a
        // Shopify handle rename can't orphan the rail — render heals the
        // handle from the id. A hand-typed handle has no id (and clears one).
        const collectionId = String(s.collection_id ?? "").trim().slice(0, 80);
        const limit = Number(s.limit);
        value.push({
          id,
          kind: "product_rail",
          title: str(s.title, 80) || componentFor("product_rail").defaults.title,
          collection,
          ...(collectionId ? { collection_id: collectionId } : {}),
          limit: Number.isFinite(limit) && limit >= 1 && limit <= 12 ? Math.floor(limit) : 8,
          enabled: s.enabled !== false,
        });
        continue;
      }
      if (!HOME_SECTION_KINDS.filter((k) => !["banner", "rich_text", "image_with_text", "product_rail"].includes(k)).includes(s.kind)) {
        problem(at("kind"), "UNKNOWN_KIND", `unknown kind "${s.kind}"`);
        continue;
      }
      const limit = Number(s.limit);
      value.push({
        id,
        kind: s.kind,
        title: str(s.title, 80) || componentFor(s.kind)?.defaults?.title || "",
        limit: Number.isFinite(limit) && limit >= 1 && limit <= 24 ? Math.floor(limit) : componentFor(s.kind)?.defaults?.limit || 8,
        enabled: s.enabled !== false,
      });
    }
    return result(ensureSectionIds(value));
  }

  if (key === "collections_index") {
    // S38 (SF02): null = catalog-derived. Otherwise lists of collection handles.
    if (input == null) return result(null);
    const handleList = (list, label, max, field) => {
      const out = [];
      for (const h of Array.isArray(list) ? list.slice(0, max) : []) {
        const v = String(h ?? "").trim().toLowerCase();
        if (!v) continue;
        if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(v)) problem(field, "HANDLE_INVALID", `${label}: "${v}" isn't a collection handle`);
        else if (!out.includes(v)) out.push(v);
      }
      return out;
    };
    const value = {
      featured: handleList(input.featured, "Featured", 6, "featured"),
      order: handleList(input.order, "Order", 50, "order"),
      hide: handleList(input.hide, "Hidden", 50, "hide"),
    };
    const shown = new Set([...value.featured, ...value.order]);
    for (const h of value.hide) if (shown.has(h)) problem("hide", "SHOWN_AND_HIDDEN", `"${h}" is both shown (featured/order) and hidden`);
    // S57 (ref migration): optional handle → catalog-id map, recorded by the
    // picker. Only handles actually present in a list keep an id; render
    // heals renamed handles from these ids. Hand-typed handles have no id.
    if (input.ids && typeof input.ids === "object" && !Array.isArray(input.ids)) {
      const present = new Set([...value.featured, ...value.order, ...value.hide]);
      const ids = {};
      for (const [h, idv] of Object.entries(input.ids)) {
        const handle = String(h ?? "").trim().toLowerCase();
        const cid = String(idv ?? "").trim().slice(0, 80);
        if (present.has(handle) && cid) ids[handle] = cid;
      }
      if (Object.keys(ids).length) value.ids = ids;
    }
    return result(value);
  }

  if (key === "surface_templates") {
    // S56: family-default template per surface; null = platform defaults.
    if (input == null) return result(null);
    if (typeof input !== "object" || Array.isArray(input)) {
      problem(null, "INVALID_SHAPE", "The page templates couldn't be read. Reload the page and try again.");
      return result(null);
    }
    const value = {};
    for (const [surface, choices] of Object.entries(SURFACE_TEMPLATE_CHOICES)) {
      const pick = input[surface];
      if (pick == null) continue; // unset surface keeps the platform default
      if (!choices.includes(pick)) problem(surface, "TEMPLATE_INVALID", `${surface} template must be one of ${choices.join("/")}`);
      else value[surface] = pick;
    }
    // S57: explicit per-entity exceptions (id → template). An entry equal to
    // the family default is KEPT — an explicit pin survives a later default
    // change, which is the point of pinning.
    for (const [surface, mapKey] of Object.entries(SURFACE_ENTITY_KEYS)) {
      const raw = input[mapKey];
      if (raw == null) continue;
      if (typeof raw !== "object" || Array.isArray(raw)) {
        problem(mapKey, "INVALID_SHAPE", `${mapKey} must be a map of id → template`);
        continue;
      }
      const entries = Object.entries(raw);
      if (entries.length > 200) problem(mapKey, "TOO_MANY", `At most 200 ${mapKey} exceptions`);
      const map = {};
      for (const [id, pick] of entries.slice(0, 200)) {
        const key = String(id).trim().slice(0, 80);
        if (!key) continue;
        if (!SURFACE_TEMPLATE_CHOICES[surface].includes(pick)) problem(`${mapKey}.${key}`, "TEMPLATE_INVALID", `${mapKey} entry ${key}: template must be one of ${SURFACE_TEMPLATE_CHOICES[surface].join("/")}`);
        else map[key] = pick;
      }
      if (Object.keys(map).length) value[mapKey] = map;
    }
    return result(Object.keys(value).length ? value : null);
  }

  if (key === "pdp_extras") {
    // S38 (SF04): accordions under every PDP description. null = none.
    if (input == null) return result(null);
    if (!Array.isArray(input)) {
      problem(null, "INVALID_SHAPE", "The product page accordions couldn't be read. Reload the page and try again.");
      return result(null);
    }
    if (input.length > 8) problem("items", "TOO_MANY", "At most 8 PDP accordions");
    const value = [];
    for (const [i, item] of input.slice(0, 8).entries()) {
      const title = str(item?.title, 80);
      const html = sanitizeHtml(String(item?.html ?? "")).slice(0, 10000); // allowlist-sanitized AT SAVE
      if (!title) problem(`items.${i}.title`, "REQUIRED", "needs a title");
      if (!html.trim()) problem(`items.${i}.html`, "REQUIRED", "content is empty");
      value.push({ title, html, enabled: item?.enabled !== false });
    }
    return result(value);
  }

  if (key === "nav_header" || key === "nav_footer") {
    if (input == null) return result(null); // null = derive from catalog
    if (!Array.isArray(input)) {
      problem(null, "INVALID_SHAPE", "The menu couldn't be read. Reload the page and try again.");
      return result(null);
    }
    if (input.length > 12) problem("items", "TOO_MANY", "At most 12 nav items");
    const value = [];
    for (const [i, item] of input.slice(0, 12).entries()) {
      const label = str(item?.label, 40);
      const link = href(item?.href);
      if (!label || !link) {
        problem(`items.${i}`, "REQUIRED", "needs a label and a path/URL");
        continue;
      }
      // S39 (MC11): one level of nesting — an item may carry up to 8 children
      // (header renders them as a keyboard-reachable dropdown).
      const children = [];
      if (Array.isArray(item.children)) {
        if (item.children.length > 8) problem(`items.${i}.children`, "TOO_MANY", "at most 8 sub-items");
        for (const [j, c] of item.children.slice(0, 8).entries()) {
          const cl = str(c?.label, 40);
          const ch = href(c?.href);
          if (!cl || !ch) {
            problem(`items.${i}.children.${j}`, "REQUIRED", "needs a label and a path/URL");
            continue;
          }
          if (Array.isArray(c.children) && c.children.length) problem(`items.${i}.children.${j}`, "TOO_DEEP", "only one level of nesting");
          children.push({ label: cl, href: ch });
        }
      }
      value.push({ label, href: link, ...(children.length ? { children } : {}) });
    }
    return result(value);
  }

  problem(null, "UNKNOWN_BLOCK", `unknown block "${key}"`);
  return result(null);
}
