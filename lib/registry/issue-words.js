// P3-VALIDATE (AU-02): where an issue is, in plain words and as a field
// anchor. Pure and edge-safe: it reads only the registry's declarations.
//
//   where(issue, body?)          "Banner · Button", "Text · Paragraphs ·
//                                paragraph 3", "FAQ · Questions · question 2
//                                · answer", "Page · Title". Plain words from
//                                the registry's labels. `body` is the document
//                                body the issue came from: it says which kind
//                                each section is. Without it a section's kind
//                                can't be known, so a section issue reads
//                                "Section" (plus nothing more).
//   fieldAnchor(issue, { known? }) "f-<sectionId|doc>-<field path, . as ->",
//                                for example f-sec_hero-title,
//                                f-sec_text1-body-2, f-doc-meta-title. The
//                                editor gives each field this id, and the
//                                publish panel links to it. `known` (a Set of
//                                anchors, or a function anchor -> boolean) is
//                                what the open form actually renders: the
//                                anchor then falls back, one path step at a
//                                time, to the closest rendered field, down to
//                                the top-level setting key (f-sec_hero-primary
//                                for primary.link.href). Without `known` the
//                                full path is returned.
//
// The field paths are exactly lib/registry/validate.js's, so they name the
// stored keys: title, primary.label, primary.link.href, body.2 (a text
// section's paragraphs live under "body"), items.1.q and items.1.a (an FAQ's
// question and answer), items.0.children.2.link.href (a menu sub-item),
// meta.title, meta.slug.
import { sectionType, documentType } from "./index.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The noun one item of a list setting is called by.
const ITEM_NOUN = { paragraphs: "paragraph", qa_list: "question", nav_items: "item", collection_list: "collection", product_list: "product" };
// Where a page's own details live (meta), in the words the editor uses.
const META_WORDS = {
  slug: "Web address",
  title: "Title",
  description: "Description",
  enabled: "Shown",
  effective_at: "Start date",
  window_start: "Start date",
  window_end: "End date",
  redirect_from: "Old addresses",
};
const pathOf = (issue) => (typeof issue?.field === "string" && issue.field ? issue.field.split(".") : []);

function sectionOf(body, sectionId) {
  if (!isObj(body) || !Array.isArray(body.sections) || !sectionId) return null;
  return body.sections.find((s) => isObj(s) && s.id === sectionId) || null;
}

function typeOf(issue, body) {
  if (isObj(body) && typeof body.type === "string") return documentType(body.type);
  const m = typeof issue?.documentId === "string" ? /^doc_([a-z][a-z0-9_]*)$/.exec(issue.documentId) : null;
  const t = m ? documentType(m[1]) : null;
  return t?.singleton ? t : null;
}

// The words for a field path below a declared setting: its label, plus which
// item of a list ("paragraph 3", "question 2 · answer", "item 1 · sub-item
// 2"). The parts of one button or image (its text, its link, its alt text)
// aren't named: the message says which part it is.
function settingWords(setting, rest) {
  const words = [setting.label];
  const noun = ITEM_NOUN[setting.kind];
  if (!noun || !/^\d+$/.test(rest[0] ?? "")) return words;
  words.push(`${noun} ${Number(rest[0]) + 1}`);
  if (setting.kind === "qa_list" && rest[1] === "a") words.push("answer");
  if (setting.kind === "nav_items" && rest[1] === "children" && /^\d+$/.test(rest[2] ?? "")) words.push(`sub-item ${Number(rest[2]) + 1}`);
  return words;
}

export function where(issue, body = null) {
  const path = pathOf(issue);
  const sectionId = typeof issue?.sectionId === "string" ? issue.sectionId : null;
  if (sectionId) {
    const decl = sectionType(sectionOf(body, sectionId)?.kind);
    if (!decl) return "Section";
    const setting = decl.settings.find((s) => s.key === path[0]);
    return (setting ? [decl.label, ...settingWords(setting, path.slice(1))] : [decl.label]).join(" · ");
  }
  const type = typeOf(issue, body);
  const head = type ? type.label : "This page";
  if (path[0] === "meta" && Object.hasOwn(META_WORDS, path[1] ?? "")) return [head, META_WORDS[path[1]]].join(" · ");
  const setting = type?.settings.find((s) => s.key === path[0]);
  if (setting) return [head, ...settingWords(setting, path.slice(1))].join(" · ");
  return head;
}

const anchorOf = (owner, parts) => `f-${owner}${parts.length ? `-${parts.join("-")}` : ""}`;

export function fieldAnchor(issue, { known = null } = {}) {
  const owner = typeof issue?.sectionId === "string" && issue.sectionId ? issue.sectionId : "doc";
  const parts = pathOf(issue);
  const full = anchorOf(owner, parts);
  if (!known) return full;
  const has = typeof known === "function" ? known : (a) => known.has(a);
  // a page's meta fields keep two steps (meta.title), every other setting one
  const floor = parts[0] === "meta" ? Math.min(2, parts.length) : Math.min(1, parts.length);
  for (let n = parts.length; n > floor; n--) {
    const a = anchorOf(owner, parts.slice(0, n));
    if (has(a)) return a;
  }
  return anchorOf(owner, parts.slice(0, floor));
}

// For the label lists of a form: the anchor of one setting (or one part of
// it) by path, without an issue.
export const anchorFor = (sectionId, field) => fieldAnchor({ sectionId, field });
