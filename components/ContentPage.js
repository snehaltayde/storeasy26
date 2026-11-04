import Link from "next/link";
import { SectionView, sectionShows, inDocumentsPreview } from "@/components/sections/index";
import { EmptyPageNote } from "@/components/sections/parts";
import { LEGACY_KIND_NAMES } from "@/lib/registry/sections";
import { legacyPageSectionsToSections } from "@/lib/registry/legacy";

// Shared renderer for store content/policy pages. S38 (SF13): sections are
// typed — text (heading + paragraphs), rich (html, allowlist-sanitized at
// save) and image (library/https src). Legacy sections without a kind render
// as text. SF14: an effective date renders under the title. S39: faq sections
// (keyboard accordions + deep links) and `children` (e.g. the contact form).
//
// P2-SECTIONS (DOC-03, DOC-06): every section renders through the renderer map
// (components/sections/index.js), as registry sections. Page sections arrive
// in the page shape (text, rich, image, faq with a "heading"; a v4 page is
// turned into that shape by lib/content/documents-reader.js) and are adapted
// with lib/registry/legacy.js, so the merged names apply: rich is rich_text,
// image is image_with_text, heading is title. A section whose kind isn't one
// of the page kinds renders as text, as it always has. Each section's root
// carries data-section-id and data-section-kind; the markup is otherwise the
// old one. A page that renders no sections, and has nothing of its own below
// (the contact form), shows a neutral message and a link to collections.
export function pageSections(list) {
  const asText = (s) => (s && typeof s === "object" && !Object.hasOwn(LEGACY_KIND_NAMES, s.kind || "text") ? { ...s, kind: "text" } : s);
  return legacyPageSectionsToSections(Array.isArray(list) ? list.map(asText) : []).filter((s) => sectionShows(s, {}, { surface: "page" }));
}

// P3-FRAME (ED-04): in a documents preview the title carries data-field
// "meta.title" (validate's path for a page's title) and every section renders
// with ctx.preview, so its words carry their own data-field
// (components/sections/index.js). Live markup is unchanged.
export default function ContentPage({ page, legalName = "", children = null }) {
  const sections = pageSections(page.sections);
  const preview = inDocumentsPreview();
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      {/* P1-CONTRAST: the two links here (Home, Contact us) are subtle text,
          4.5:1 or better on every look; the words around them stay faint.
          They inherited the faint grey before (2.62:1 on white). */}
      <nav className="mb-6 text-sm text-sf-text-faint">
        <Link href="/" className="text-sf-text-subtle hover:text-sf-text-muted">
          Home
        </Link>{" "}
        / <span className="text-sf-text-muted">{page.title}</span>
      </nav>
      <h1 {...(preview ? { "data-field": "meta.title" } : {})} className="text-3xl font-extrabold tracking-tight">
        {page.title}
      </h1>
      {page.effective_at ? (
        <p className="mt-2 text-sm text-sf-text-faint">
          Effective from{" "}
          {new Date(`${page.effective_at}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}
        </p>
      ) : null}
      <div className="mt-8 space-y-8">
        {sections.map((s, idx) => (
          <SectionView key={`${s.id}-${idx}`} section={s} ctx={preview ? { surface: "page", preview: true } : { surface: "page" }} />
        ))}
      </div>
      {sections.length === 0 && !children ? <EmptyPageNote /> : null}
      {children}
      <p className="mt-12 border-t border-sf-border-soft pt-6 text-xs text-sf-text-faint">
        {legalName ? `Operated by ${legalName} · ` : ""}Questions?{" "}
        <Link href="/contact" className="text-sf-text-subtle underline hover:text-sf-text-muted">
          Contact us
        </Link>
      </p>
    </div>
  );
}
