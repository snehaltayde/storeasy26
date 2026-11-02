// Page editor section form <-> stored shapes (AU-05). Plain JS with no JSX and
// no imports, so scripts/test-page-editor.js runs the SAME conversions the
// editor saves with. Same conversions as the old StorefrontAdmin: the stored
// data shapes are preserved byte-for-byte.
const bodyToText = (body) => (body || []).join("\n\n");
const textToBody = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

// S54: `pid` is the DURABLE server-side instance id (sec_…) riding alongside
// the client-only list key `id` — it goes back out on save so section
// identity survives edits; new/duplicated sections send none (server mints).
export const toEdit = (s, id) => {
  const kind = s?.kind || "text";
  const pid = typeof s?.id === "string" ? s.id : undefined;
  if (kind === "rich") return { id, pid, kind, heading: s.heading || "", html: s.html || "" };
  if (kind === "image") return { id, pid, kind, src: s.src || "", alt: s.alt || "", caption: s.caption || "" };
  if (kind === "faq") return { id, pid, kind, heading: s.heading || "", items: (s.items || []).map((it) => ({ q: it?.q || "", a: it?.a || "" })) };
  return { id, pid, kind: "text", heading: s?.heading || "", text: bodyToText(s?.body) };
};
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
    ? { id, kind, heading: "", html: "" }
    : kind === "image"
      ? { id, kind, src: "", alt: "", caption: "" }
      : kind === "faq"
        ? { id, kind, heading: "", items: [{ q: "", a: "" }] }
        : { id, kind: "text", heading: "", text: "" };
