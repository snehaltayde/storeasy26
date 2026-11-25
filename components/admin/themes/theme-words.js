// Shared words and helpers for /admin/themes (Phase 5 line 1).
export const NO_MANAGE = "Only an owner or admin can upload or archive themes.";
export const TEMPLATE_WORDS = Object.freeze({ pdp: "Product page", collection: "Collection page", header: "Header", footer: "Footer" });
export const USE_WORDS = Object.freeze({ live: "Live", draft: "In your draft" });

const DATE = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
export const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE.format(d);
};

// POST to /api/admin/<path>; body is sent as is when it is a string (the theme file)
export async function postTheme(path, body) {
  try {
    const res = await fetch(`/api/admin/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) return json;
    return { ok: false, error: json.error || "That didn't work. Nothing was changed. Try again.", issues: json.issues || null, code: json.code || null };
  } catch {
    return { ok: false, error: "We couldn't reach Storeasy. Check your connection and try again." };
  }
}
