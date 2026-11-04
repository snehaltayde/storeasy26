import HeroSection from "./HeroSection";
import CollectionsSection from "./CollectionsSection";
import NewProductsSection from "./NewProductsSection";
import BannerSection from "./BannerSection";
import RichTextSection from "./RichTextSection";
import ImageWithTextSection from "./ImageWithTextSection";
import ProductRailSection from "./ProductRailSection";
import TextSection from "./TextSection";
import FaqListSection from "./FaqListSection";
import ProductMainSection from "./ProductMainSection";
import FaqSection from "@/components/FaqSection";
import { cloneElement, isValidElement } from "react";
import { unfinishedMark, unfinishedTitle, unfinishedHtml } from "@/lib/content/unfinished";
import { isPreviewRequest } from "@/lib/cms/section-data";
import { sectionType, validateDocument } from "@/lib/registry/index";
import { issueClass } from "@/lib/registry/validate";
import { slog } from "@/lib/log";
import { currentTenant } from "@/lib/tenant-context";

// The renderer map (P2-SECTIONS, DOC-03; spec 8.5). One component per
// registered section kind (lib/registry/sections.js), found by kind. The home
// page (app/(storefront)/page.js and HomeSections) and content pages
// (components/ContentPage.js) render every section through SectionView.
//
// Adding a section kind takes one declaration in the registry and one entry
// here. checkSectionComponents() is the contract check: it lists a registered
// kind with no component, and a component whose kind isn't registered
// (test:sections-render runs it).
//
// Every section's root element carries data-section-id and data-section-kind
// (SectionView hands them in as `attrs`; each component spreads them on its
// root).
//
// A component may carry a static shows(section, data, ctx): false means it
// renders nothing for this data (a rail with too few products). Pages use it
// to tell "nothing rendered" apart (the DOC-03 empty-page message).
//
// P2-PREVIEW (DOC-05): in the founder's preview, a section the overlay marked
// `unfinished` ({ label, placeholder }) renders as the founder's note, a rich
// text section titled "<Label>: not finished yet" with the placeholder and
// "Only you can see this in your preview" (lib/content/unfinished.js), in
// place of its own component, so an unfinished banner is never an empty box
// and an unfinished rail never vanishes. Its root keeps the section's own id
// and kind, plus data-unfinished. The hero is the one exception: HeroSection
// shows the placeholder where its title goes, as before. Live versions never
// carry the mark.
const COMPONENTS = {
  hero: HeroSection,
  collections: CollectionsSection,
  new: NewProductsSection,
  banner: BannerSection,
  rich_text: RichTextSection,
  image_with_text: ImageWithTextSection,
  product_rail: ProductRailSection,
  text: TextSection,
  faq: FaqListSection,
  product_main: ProductMainSection,
};

// Tests only: a throwaway kind's component, and taking it out again.
export function registerSectionComponent(kind, component) {
  if (Object.hasOwn(COMPONENTS, kind)) throw new Error(`section kind "${kind}" already has a component`);
  COMPONENTS[kind] = component;
  return () => {
    delete COMPONENTS[kind];
  };
}

export const sectionComponentKinds = () => Object.keys(COMPONENTS);
export const sectionComponent = (kind) => (typeof kind === "string" && Object.hasOwn(COMPONENTS, kind) ? COMPONENTS[kind] : null);

// The contract check. kinds: the registry's sectionKinds(). [] when they match.
export function checkSectionComponents(kinds) {
  const problems = [];
  for (const kind of kinds) {
    const C = sectionComponent(kind);
    if (!C) problems.push(`section kind "${kind}" is registered but has no component in components/sections/index.js`);
    else if (typeof C !== "function") problems.push(`section kind "${kind}" maps to something that isn't a component`);
  }
  for (const kind of Object.keys(COMPONENTS)) if (!kinds.includes(kind)) problems.push(`components/sections/index.js has a component for "${kind}", which isn't a registered section kind`);
  return problems;
}

export const sectionAttrs = (section) => ({ "data-section-id": section?.id ?? "", "data-section-kind": section?.kind ?? "" });

// P3-VALIDATE (PV-02): since a draft may now hold a broken value inside a
// section (a link that isn't a page of the store, an image link that isn't
// secure, a title over its limit: "incomplete" in a draft), the hero's
// exception holds only while everything the hero lacks is missing words. A
// hero holding a broken value previews as its note too, so a stored draft's
// bad link or image never renders in the preview.
function heroOnlyMissingWords(section) {
  const { unfinished, ...stored } = section;
  const { issues } = validateDocument({ schema: 1, type: "home", meta: {}, sections: [stored] }, { mode: "draft" });
  return issues.every((i) => i.severity === "warning" || issueClass(i) === "incomplete");
}

// An unfinished section's note (see above), or null.
function unfinishedNote(section) {
  const u = unfinishedMark(section);
  if (!u || (section.kind === "hero" && heroOnlyMissingWords(section))) return null;
  return { id: section.id, kind: "rich_text", settings: { title: unfinishedTitle(u), html: unfinishedHtml(u) } };
}

// ---- one failing section never takes the page down (PV-02) ---------------------
//
// SectionView calls a section's own component as a plain function inside a
// try (and awaits it when it is async), so a throw in that section's own
// render, or a failed catalog read for it (lib/cms/section-data.js marks the
// section's data with bindingFailed), is caught here:
//   preview   the section renders as a note, "This section couldn't be
//             shown", in the founder's preview only;
//   live      the section is left out, the other sections render exactly as
//             before, and a log line (section_render_failed) says which one.
// What this can't catch (React server rendering gives no error boundary): a
// throw inside a child component the section renders (ProductGrid,
// ProductCard, StoreImage, next/image, ExperimentNote, ctx.productMain), or
// inside a "use client" component. Those still fail the page as before.
//
// Whether this is a preview: ctx.preview when the caller says so; otherwise
// the request's content source, read only when a section has failed
// (isPreviewRequest in lib/cms/section-data.js).
export const FAILED_TITLE = "This section couldn't be shown";
export const failedText = (label) => `Something went wrong while showing this ${label ? `${label.toLowerCase()} ` : ""}section. Only you can see this note in your preview: shoppers don't see the section until it works again. Reload the preview to try again.`;
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function failedNote(section, ctx) {
  const label = sectionType(section?.kind)?.label || "";
  const note = { id: section.id, kind: "rich_text", settings: { title: FAILED_TITLE, html: `<p>${escapeHtml(failedText(label))}</p>` } };
  return <RichTextSection section={note} ctx={ctx} attrs={{ ...sectionAttrs(section), "data-unfinished": "", "data-section-failed": "" }} />;
}

// P3-FRAME (after the P3-VALIDATE review): the line names the real store.
// A section renders outside tfetch, so the tenant context is empty there and
// slog would say "_default". The store's id comes from the request scope
// lib/content/resolve.js notes (requestScope below); a render inside a
// tenant context (scripts, tests) keeps slog's own.
function logFailed(section, error, cause) {
  const store = currentTenant() ? null : requestScope()?.storeId;
  slog("section_render_failed", { ...(store ? { tenant: store } : {}), sectionId: section?.id ?? null, kind: section?.kind ?? null, cause, error: String(error?.message ?? error ?? "").slice(0, 200) });
}

async function FailedSectionAsync({ section, ctx }) {
  return (await isPreviewRequest()) ? failedNote(section, ctx) : null;
}

function failed(section, ctx, error, cause) {
  logFailed(section, error, cause);
  if (typeof ctx?.preview === "boolean") return ctx.preview ? failedNote(section, ctx) : null;
  return <FailedSectionAsync section={section} ctx={ctx} />;
}

async function SettledSection({ pending, section, ctx }) {
  try {
    return await pending;
  } catch (e) {
    logFailed(section, e, "render");
    if (typeof ctx?.preview === "boolean") return ctx.preview ? failedNote(section, ctx) : null;
    return (await isPreviewRequest()) ? failedNote(section, ctx) : null;
  }
}

const isThenable = (v) => v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";

// ---- P3-FRAME: what this request renders (lib/content/resolve.js) -----------------
//
// contentSource notes, per request, the store's id and whether this is a
// founder's documents preview, under a global symbol (this module can't
// import resolve.js: next/headers would reach every suite that renders the
// map). Outside a request the answer is "unknown" and "not a preview".
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

// ---- P3-FRAME (ED-04): preview-only data-field ---------------------------------
//
// In a documents preview (ctx.preview true) the words a founder can edit carry
// data-field, with exactly the field path lib/registry/validate.js reports
// for that value (title, subtitle, primary.label, button.label, body.N,
// items.N.q, items.N.a, html, …), so a click in the editor's frame lands on
// the same field an issue names. The hero marks its own (HeroSection). For
// the other kinds the section's own render is walked: the element whose only
// child is that exact text (or whose inner HTML is that exact html) gets the
// attribute; rich text also gets data-field-type="rich_text", so the bridge
// can tell which block was clicked. FAQs render through a client component
// the walk can't see into; in a preview they render through PreviewFaq below
// (the same markup, with the attributes). Live renders never come here.
const textFields = {
  text: (s) => [["title", s.title], ...(Array.isArray(s.body) ? s.body.map((p, i) => [`body.${i}`, p]) : [])],
  banner: (s) => [["title", s.title], ["text", s.text], ["button.label", s.button?.label]],
  image_with_text: (s) => [["title", s.title], ["text", s.text], ["caption", s.caption], ["button.label", s.button?.label]],
  rich_text: (s) => [["title", s.title]],
  collections: (s) => [["title", s.title]],
  new: (s) => [["title", s.title]],
  product_rail: (s) => [["title", s.title]],
  faq: (s) => [["title", s.title]],
};
const htmlFields = { rich_text: (s) => [["html", s.html]] };

function soleText(children) {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") return children[0];
  return null;
}

export function annotateFields(node, section) {
  const s = section?.settings && typeof section.settings === "object" ? section.settings : {};
  const texts = (textFields[section?.kind]?.(s) || []).filter(([, v]) => typeof v === "string" && v.trim());
  const htmls = (htmlFields[section?.kind]?.(s) || []).filter(([, v]) => typeof v === "string" && v);
  const used = new Set();
  const visit = (el) => {
    if (Array.isArray(el)) {
      let changed = false;
      const out = el.map((c) => {
        const n = visit(c);
        if (n !== c) changed = true;
        return n;
      });
      return changed ? out : el;
    }
    if (!isValidElement(el)) return el;
    if (el.type === FaqSection) return <PreviewFaq {...el.props} />;
    const props = el.props || {};
    const html = props.dangerouslySetInnerHTML?.__html;
    if (typeof html === "string") {
      const hit = htmls.find(([f, v]) => !used.has(f) && v === html);
      if (hit) {
        used.add(hit[0]);
        return cloneElement(el, { "data-field": hit[0], "data-field-type": "rich_text" });
      }
      return el;
    }
    const text = soleText(props.children);
    if (text !== null) {
      const hit = texts.find(([f, v]) => !used.has(f) && v === text);
      if (hit) {
        used.add(hit[0]);
        return cloneElement(el, { "data-field": hit[0] });
      }
      return el;
    }
    if (props.children === undefined || typeof props.children === "function") return el;
    const kids = visit(props.children);
    return kids === props.children ? el : cloneElement(el, undefined, ...(Array.isArray(kids) ? kids : [kids]));
  };
  return visit(node);
}

// FaqSection's anchor for a question (components/FaqSection.js faqAnchor). A
// copy: that module is a client one, so the server can't call its helpers.
const faqAnchor = (q) =>
  "q-" +
  String(q)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// The FAQ accordion (components/FaqSection.js) as server markup, for the
// founder's preview only: the same elements and classes, plus data-field on
// each question (items.N.q) and answer (items.N.a, rich text). The deep-link
// copy button does nothing here (no client script); the editor's frame
// selects instead of browsing.
function PreviewFaq({ heading, items = [], ...rootProps }) {
  return (
    <section {...rootProps}>
      {heading ? (
        <h2 className="text-lg font-bold text-sf-text" data-field="title">
          {heading}
        </h2>
      ) : null}
      <div className="mt-2 divide-y divide-sf-border-soft rounded-sf-card border border-sf-border">
        {items.map((it, i) => {
          const anchor = faqAnchor(it.q);
          return (
            <details key={anchor} id={anchor} className="group scroll-mt-24 px-4 py-3">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-sf-text-soft [&::-webkit-details-marker]:hidden">
                <span data-field={`items.${i}.q`}>{it.q}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <button type="button" aria-label={`Copy link to "${it.q}"`} className="rounded-sf-2xs px-1 text-sf-mark hover:text-sf-text-muted">
                    ¶
                  </button>
                  <span aria-hidden="true" className="text-sf-text-faint transition group-open:rotate-45">
                    +
                  </span>
                </span>
              </summary>
              <div className="rte mt-2 text-sm text-sf-text-muted" data-field={`items.${i}.a`} data-field-type="rich_text" dangerouslySetInnerHTML={{ __html: it.a }} />
            </details>
          );
        })}
      </div>
    </section>
  );
}

// Whether a section renders anything for this data. A shows() that throws
// counts as showing: SectionView then catches the failure and decides.
export function sectionShows(section, data = {}, ctx = {}) {
  const C = sectionComponent(section?.kind);
  if (!C) return false;
  if (unfinishedNote(section)) return true;
  if (Array.isArray(data?.bindingFailed) && data.bindingFailed.length) return true;
  try {
    return typeof C.shows === "function" ? Boolean(C.shows(section, data, ctx)) : true;
  } catch {
    return true;
  }
}

// One section, through the map. Unknown kinds render nothing.
export function SectionView({ section, data = {}, ctx: given = {} }) {
  const C = sectionComponent(section?.kind);
  if (!C) return null;
  // P3-FRAME: a documents preview the caller didn't name (the home page's
  // hero) is read from the request scope. Legacy previews and live pages
  // keep the caller's ctx as it is.
  const ctx = given?.preview === undefined && inDocumentsPreview() ? { ...given, preview: true } : given;
  const note = unfinishedNote(section);
  if (note) return <RichTextSection section={note} ctx={ctx} attrs={{ ...sectionAttrs(section), "data-unfinished": "" }} />;
  if (Array.isArray(data?.bindingFailed) && data.bindingFailed.length) return failed(section, ctx, `catalog data: ${data.bindingFailed.join(", ")}`, "data");
  // a "use client" section (a client reference) or a memo/forwardRef wrapper
  // can't be called: it renders as an element, as before, uncaught
  if (typeof C !== "function" || C.$$typeof) return <C section={section} data={data} ctx={ctx} attrs={sectionAttrs(section)} />;
  let out;
  try {
    out = C({ section, data, ctx, attrs: sectionAttrs(section) });
  } catch (e) {
    return failed(section, ctx, e, "render");
  }
  if (isThenable(out)) {
    // handled here at once, so a quick rejection is never reported as
    // unhandled; SettledSection awaits the same promise and catches it
    Promise.resolve(out).catch(() => {});
    return <SettledSection pending={out} section={section} ctx={ctx} />;
  }
  // P3-FRAME: preview-only field marks (the hero marks its own)
  if (ctx?.preview === true && section.kind !== "hero" && !section.unfinished) {
    try {
      return annotateFields(out, section);
    } catch {
      return out;
    }
  }
  return out;
}
