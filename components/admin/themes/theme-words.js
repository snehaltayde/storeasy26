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

// Phase 5 line 3: switching themes
export const NO_WRITE = "Only an owner, admin or staff member can change the design draft.";
export const NO_PUBLISH = "Ask an admin to publish.";
export const PREVIEW_NOTE = "The preview shows your draft. It isn't live until you publish.";
// the look a { kit, package } state names, for the badges
export const sameLook = (a, b) => Boolean(a && b) && a.kit === b.kit && (a.package ?? null) === (b.package ?? null);

// a documents PUT (the existing editor API): publishSet goes through the
// documents publish (release, publish_log and audit in one batch)
export async function putDocuments(body) {
  try {
    const res = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok !== false) return { ok: true, ...json };
    return { ok: false, error: json.error || "That didn't work. Nothing was published. Try again.", code: json.code || null };
  } catch {
    return { ok: false, error: "We couldn't reach Storeasy. Check your connection and try again." };
  }
}
// the name of a { kit, package } look: a built-in label or the package's name
export function lookName(look, builtins, packages) {
  if (!look) return "Pulse";
  if (look.package) return packages.find((p) => p.id === look.package)?.name ?? "an uploaded theme";
  return builtins.find((k) => k.id === look.kit)?.label ?? "Pulse";
}
export const LIVE_ARCHIVED = "Your live theme was archived. Choose another before you publish design changes.";
