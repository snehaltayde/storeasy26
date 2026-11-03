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
