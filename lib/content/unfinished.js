// P2-PREVIEW (DOC-05, spec 8.8): the founder's note for an unfinished section.
// A draft section the preview overlay marked `unfinished` ({ label,
// placeholder }: it has an incomplete or invalid field) renders as this plain
// note, in the founder's preview only. Live versions never carry the mark.
//
// One wording for every surface: lib/content/documents-reader.js uses it for
// the legacy-shaped home, page and product readers, and the renderer map
// (components/sections/index.js) for the home page's registry sections.
//
// Pure, no imports: edge-safe, and importable from components.
const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const unfinishedTitle = (u) => `${u.label}: not finished yet`;
export const unfinishedText = (u) => `${u.placeholder ? `${u.placeholder}. ` : ""}Only you can see this in your preview. Finish this section to publish this page.`;
export const unfinishedHtml = (u) => `<p>${escapeHtml(unfinishedText(u))}</p>`;

// The overlay's mark ({ label, ... }), or null. A legacy-shaped note already
// turned into text carries `unfinished: true`, which is not a mark.
export const unfinishedMark = (section) => {
  const u = section?.unfinished;
  return u && typeof u === "object" && typeof u.label === "string" ? u : null;
};
