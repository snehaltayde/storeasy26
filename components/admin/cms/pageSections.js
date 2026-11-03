// Page editor section form <-> stored shapes (AU-05). Plain JS with no JSX,
// importing only pure lib modules by relative path, so
// scripts/test-page-editor.js runs the SAME conversions the editor saves with.
// Same conversions as the old StorefrontAdmin: the stored data shapes are
// preserved byte-for-byte.
import { SECTION_ID_RE, mintSectionId } from "../../../lib/cms/registry.js";
import { issueText } from "../../../lib/cms/issues.js";

// DOC-04: every section in the form carries its durable id (`pid`) from the
// moment it exists, so a refusal can name it before the first save. A new or
// duplicated section mints one here; the server keeps any valid unique id.
export const newSectionId = () => mintSectionId();
const bodyToText = (body) => (body || []).join("\n\n");
const textToBody = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

// S54: `pid` is the DURABLE server-side instance id (sec_…) riding alongside
// the client-only list key `id` — it goes back out on save so section
// identity survives edits. DOC-04: a section with no usable id (a built-in
// template, an old history entry) gets one minted here.
export const toEdit = (s, id) => {
  const kind = s?.kind || "text";
  const pid = typeof s?.id === "string" && SECTION_ID_RE.test(s.id) ? s.id : newSectionId();
  if (kind === "rich") return { id, pid, kind, heading: s.heading || "", html: s.html || "" };
  if (kind === "image") return { id, pid, kind, src: s.src || "", alt: s.alt || "", caption: s.caption || "" };
  if (kind === "faq") return { id, pid, kind, heading: s.heading || "", items: (s.items || []).map((it) => ({ q: it?.q || "", a: it?.a || "" })) };
  return { id, pid, kind: "text", heading: s?.heading || "", text: bodyToText(s?.body) };
};
// Stored sections → the form, on every load. Ids are deterministic (`s<i>`) so
// SSR and hydration agree; sections added later get client-only ids.
export const formSections = (sections) => (sections || []).map((s, i) => toEdit(s, `s${i}`));
export const fromEdit = (s) => {
  const base = s.pid ? { id: s.pid } : {};
  if (s.kind === "rich") return { ...base, kind: "rich", heading: s.heading, html: s.html };
  if (s.kind === "image") return { ...base, kind: "image", src: s.src, alt: s.alt, caption: s.caption };
  // only a row with nothing typed in it is left out; an answer with no
  // question goes to the server, which refuses it
  if (s.kind === "faq") return { ...base, kind: "faq", heading: s.heading, items: s.items.filter((it) => it.q.trim() || it.a.trim()) };
  return { ...base, kind: "text", heading: s.heading, body: textToBody(s.text) };
};
// Empty = nothing typed in ANY field.
export const editEmpty = (s) =>
  s.kind === "rich"
    ? !s.heading.trim() && !s.html.trim()
    : s.kind === "image"
      ? !s.src.trim() && !s.alt.trim() && !s.caption.trim()
      : s.kind === "faq"
        ? !s.heading.trim() && !s.items.some((it) => it.q.trim() || it.a.trim())
        : !s.heading.trim() && !s.text.trim();

// AU-05: every section goes to the server, which saves it or refuses the whole
// save with a message (its "section N" matches the position in the form). The
// editor marks itself clean only on success, so clean always means all of it
// was stored. Never filter here: that is how paragraphs with no heading were
// dropped and reported as saved.
export const sectionsPayload = (sections) => sections.map(fromEdit);

export const blankSection = (kind, id) =>
  kind === "rich"
    ? { id, pid: newSectionId(), kind, heading: "", html: "" }
    : kind === "image"
      ? { id, pid: newSectionId(), kind, src: "", alt: "", caption: "" }
      : kind === "faq"
        ? { id, pid: newSectionId(), kind, heading: "", items: [{ q: "", a: "" }] }
        : { id, pid: newSectionId(), kind: "text", heading: "", text: "" };

// The save leaves out FAQ rows with nothing typed (fromEdit), so the server's
// item j is the j-th row that has something in it. This is its number on screen.
export const faqRowNumber = (section, j) => {
  let seen = -1;
  for (const [k, it] of (section.items || []).entries()) {
    if (it.q.trim() || it.a.trim()) seen++;
    if (seen === j) return k + 1;
  }
  return j + 1;
};

// DOC-04: a refusal from the server, in the words AU-05 made the founder see
// ("section 3: …", "section 1, question 2: …"), with the number worked out
// from the section's id against the form as it is now. The server sends no
// position.
export const pageIssueText = (issue, sections) => issueText(issue, { sections, sectionLabel: (_, i) => `section ${i + 1}`, itemNumber: faqRowNumber });
