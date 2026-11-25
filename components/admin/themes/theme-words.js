// Shared words and helpers for /admin/themes (Phase 5 line 1).
export const NO_MANAGE = "Only an owner or admin can upload or archive themes.";
export const TEMPLATE_WORDS = Object.freeze({ pdp: "Product page", collection: "Collection page", header: "Header", footer: "Footer" });

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
  if (look.package) return packages.find((p) => p.id === look.package)?.name ?? "a theme";
  return builtins.find((k) => k.id === look.kit)?.label ?? "Pulse";
}
// The design draft in a preview tab (a preview session with the design shown,
// reused while the page stays open): { ok, session, error }. Opened from a
// click, so the new tab is allowed.
export async function openDesignPreview(session = null) {
  const tab = window.open("", "_blank");
  let s = session;
  if (!s) {
    const r = await postTheme("preview-session", { create: true });
    if (!r.ok) {
      tab?.close();
      return { ok: false, session: null, error: r.error };
    }
    s = { sid: r.sid, url: r.previewUrl };
  }
  const on = await postTheme("preview-session", { showDesign: { sid: s.sid, on: true } });
  if (!on.ok) {
    tab?.close();
    return { ok: false, session: null, error: on.error };
  }
  if (tab) tab.location.href = s.url;
  else window.open(s.url, "_blank", "noopener");
  return { ok: true, session: s, error: null };
}

// Phase 7 line 1: Storeasy's flagship themes
export const FLAGSHIP_WORDS = Object.freeze({
  title: "Storeasy themes",
  lead: "Five complete looks made by Storeasy, each with its own colours, fonts and layouts. Choosing one puts it in your draft; shoppers see it after you publish.",
  details: "Details",
  preview: "Preview",
  author: "Storeasy",
  serif: "Serif headings",
  sans: "Sans headings",
});
// the heading face a card's sample is drawn in (the console loads both)
export const headingFamily = (font) => (font === "serif" ? "var(--font-fraunces), Georgia, serif" : "var(--font-geist-sans), system-ui, sans-serif");
export const LIVE_ARCHIVED = "Your live theme was archived. Choose another before you publish design changes.";
