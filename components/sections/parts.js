import Link from "next/link";
import { linkHref } from "@/lib/registry/settings";

// Small pieces the section components share (P2-SECTIONS).

// DOC-03 state table: "Any image missing → a token-coloured fallback, never a
// broken image". The same brand gradient a collection card with no photo
// shows. role="img" with the alt text (or hidden when there is none), so a
// screen reader hears the same thing it would for the photo.
export function MediaFallback({ alt = "", className = "" }) {
  const label = typeof alt === "string" && alt.trim() ? alt : null;
  return (
    <div
      data-media-fallback=""
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" })}
      className={`${className} bg-gradient-to-br from-sf-media-from to-sf-media-to`}
    />
  );
}

// DOC-03 state table: "A page that renders no sections → a neutral message
// and a link to collections". Plain words a shopper can read on any store.
export const EMPTY_PAGE_MESSAGE = "There’s nothing on this page yet.";
export const EMPTY_PAGE_LINK = "Browse our collections";
export function EmptyPageNote() {
  return (
    <div data-empty-page="" className="py-sf-section text-center">
      <p className="text-sf-text-muted">{EMPTY_PAGE_MESSAGE}</p>
      <Link href="/collections" className="mt-4 inline-block text-sm font-medium text-sf-accent-text hover:underline">
        {EMPTY_PAGE_LINK}
      </Link>
    </div>
  );
}

// A registry image setting ({ media, alt }) as { src, alt }, or null when it
// holds no usable picture. A legacy string (an old image_with_text) still works.
export function imageOf(value) {
  if (typeof value === "string") return value.trim() ? { src: value, alt: "" } : null;
  if (!value || typeof value !== "object") return null;
  const src = typeof value.media === "string" ? value.media : "";
  return src.trim() ? { src, alt: typeof value.alt === "string" ? value.alt : "" } : null;
}
export const altOf = (value) => (value && typeof value === "object" && typeof value.alt === "string" ? value.alt : "");

// A registry button ({ label, link }) as { label, href }; href null when the
// link can't be followed. A legacy flat button ({ label, href }) still works.
export function buttonOf(button) {
  if (!button || typeof button !== "object") return { label: "", href: null };
  const label = typeof button.label === "string" ? button.label : "";
  if (Object.hasOwn(button, "link")) return { label, href: linkHref(button.link) };
  return { label, href: typeof button.href === "string" ? button.href : null };
}

export const settingsOf = (section) => (section?.settings && typeof section.settings === "object" && !Array.isArray(section.settings) ? section.settings : {});

// ---- P3-FRAME: what this request renders (lib/content/resolve.js) -----------------
//
// contentSource notes, per request, the store's id and whether this is a
// founder's documents preview, under a global symbol (no section module can
// import resolve.js: next/headers would reach every suite that renders the
// map). Outside a request the answer is "unknown" and "not a preview".
// P5-HIDDEN: moved here from index.js (which re-exports both) so a section
// component can ask without importing the renderer map that imports it.
const REQUEST_SCOPE_KEY = Symbol.for("storeasy.requestScope");
export function requestScope() {
  try {
    const read = globalThis[REQUEST_SCOPE_KEY];
    const scope = typeof read === "function" ? read() : null;
    return scope && typeof scope === "object" ? scope : null;
  } catch {
    return null;
  }
}
export const inDocumentsPreview = () => requestScope()?.documentsPreview === true;

// P5-HIDDEN (COM-01): whether this render is a founder's documents preview.
// ctx.preview when the caller says so (true or false); otherwise the request
// scope above, which only a documents preview sets (resolve.js: a valid
// preview session on a documents store). A legacy preview, a live page and a
// render outside a request all answer false.
export const isFounderPreview = (ctx) => (typeof ctx?.preview === "boolean" ? ctx.preview : inDocumentsPreview());

// P5-HIDDEN (COM-01): a small founder note, for a part of a section that
// shoppers don't see (a grid cell the section drops). The caller renders it
// only when isFounderPreview(ctx) is true; the note checks again and renders
// nothing otherwise, so a shopper never gets it. `attrs` go on its root (a
// data-* marker, an id the editor can select by). Plain text, escaped by React.
export const FOUNDER_ONLY = "Only you can see this note in your preview.";
export function FounderNote({ ctx, title = "", text = "", attrs = {}, className = "" }) {
  if (!isFounderPreview(ctx) || typeof text !== "string" || !text.trim()) return null;
  return (
    <div data-founder-note="" {...attrs} className={`rounded-sf-card border border-dashed border-sf-border-strong bg-sf-surface-muted p-4 text-sm text-sf-text-muted ${className}`.trim()}>
      {title ? <p className="font-semibold text-sf-text">{title}</p> : null}
      <p className={title ? "mt-1" : undefined}>
        {text} {FOUNDER_ONLY}
      </p>
    </div>
  );
}
