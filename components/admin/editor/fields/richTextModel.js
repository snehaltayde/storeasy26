// P3-RTE (AU-01, ED-04): the pure logic of the rich text field
// (RichTextField.js). No React, no DOM globals and no imports, so it is
// edge-safe and node tests drive it directly. Functions that walk a tree take
// the nodes as parameters (anything with nodeType, childNodes and nodeValue).
//
// The rule this file keeps: the server is the only place HTML is cleaned.
// Nothing here removes tags or attributes from what the founder typed or
// pasted. The field sends what was typed or pasted, the documents service's
// saveDraft cleans it (lib/registry validate, draft mode), and the field then
// shows the stored value it gets back.
//
//   TAGS                    what the editor can edit (marks, blocks) and what
//                           it can only show (NOT_EDITABLE). Together they are
//                           exactly the tags the server keeps (the suite
//                           checks this against lib/sanitize.js).
//   TOOLBAR                 the buttons, each with the tag it makes
//   uneditableTags(html)    the NOT_EDITABLE tags in a value, in order
//   readOnlyWords(tags)     the plain words for why a value opens read-only
//   pastedPart(html)        the copied part of clipboard HTML (between Word's
//                           and the browsers' StartFragment/EndFragment
//                           comments, or the body), unchanged otherwise
//   plainToHtml(text)       pasted plain text as paragraphs (characters encoded)
//   hasBlocks(html)         true when HTML holds a block (p, list, table…)
//   splicePaste(html, marker, part, split)
//                           the field's HTML with `part` where `marker` is,
//                           closing and reopening the blocks around the caret
//                           when the part holds blocks of its own
//   linkHtml(href, text)    a link for a caret with no selected text
//   blockChildAt(root, offset)
//                           focusRequest's offset: the element child number
//                           `offset` of the field's root (offset 2 is the
//                           third block). The preview bridge counts the same
//                           way (components/preview/bridge-core.js pickOf).
//   textOffset(root, node, offset), pointAt(root, n)
//                           the caret as a count of characters, and back, so a
//                           stored value can replace the shown one without
//                           losing the founder's place
//   syncAction({ value, emitted, shown, normalized })
//                           "keep" or "replace": what to do when a value
//                           arrives. An echo of what the field sent, or a value
//                           the field already shows, is kept, so an untouched
//                           value is never rewritten.
//   frameDocument(html, opts)
//                           the editing surface's document (an iframe srcdoc):
//                           the value in <body class="rte"> exactly as given

// ---- tags --------------------------------------------------------------------

// Inline marks the editor edits.
export const MARKS = Object.freeze(["a", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "span", "code", "br"]);
// Blocks the editor edits.
export const BLOCKS = Object.freeze(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr"]);
// Tags the server keeps but this editor can't edit safely in place (a table's
// cells, a picture, a caption, preformatted text). A value holding any of them
// opens read-only, with "Edit as HTML".
export const NOT_EDITABLE = Object.freeze(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "pre", "img"]);
export const TAGS = Object.freeze({ marks: MARKS, blocks: BLOCKS, notEditable: NOT_EDITABLE });

// The buttons. `tag` is what the browser's editing command makes, so the suite
// can prove the server keeps every one of them.
export const TOOLBAR = Object.freeze([
  { id: "bold", label: "Bold", command: "bold", tag: "b", key: "b", group: "mark" },
  { id: "italic", label: "Italic", command: "italic", tag: "i", key: "i", group: "mark" },
  { id: "underline", label: "Underline", command: "underline", tag: "u", key: "u", group: "mark" },
  { id: "p", label: "Paragraph", command: "formatBlock", value: "p", tag: "p", group: "block" },
  { id: "h2", label: "Heading", command: "formatBlock", value: "h2", tag: "h2", group: "block" },
  { id: "h3", label: "Subheading", command: "formatBlock", value: "h3", tag: "h3", group: "block" },
  { id: "ul", label: "Bulleted list", command: "insertUnorderedList", tag: "ul", group: "list" },
  { id: "ol", label: "Numbered list", command: "insertOrderedList", tag: "ol", group: "list" },
  { id: "quote", label: "Quote", command: "formatBlock", value: "blockquote", tag: "blockquote", group: "block" },
  { id: "link", label: "Link", tag: "a", key: "k", group: "link" },
  { id: "unlink", label: "Remove link", command: "unlink", tag: null, group: "link" },
]);

const NOT_EDITABLE_RE = new RegExp(`<(${NOT_EDITABLE.join("|")})(?=[\\s/>])`, "gi");
const COMMENTS = /<!--[\s\S]*?(?:-->|$)/g;

// The NOT_EDITABLE tags a value holds (start tags, outside comments), each once,
// in the order they first appear.
export function uneditableTags(html) {
  const s = String(html ?? "").replace(COMMENTS, "");
  const out = [];
  for (const m of s.matchAll(NOT_EDITABLE_RE)) {
    const t = m[1].toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

const THING = {
  table: "a table", thead: "a table", tbody: "a table", tfoot: "a table", tr: "a table", th: "a table", td: "a table",
  figure: "a picture with a caption", figcaption: "a picture with a caption",
  pre: "preformatted text",
  img: "a picture",
};
const listWords = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// Why a value opens read-only, in plain words, or null when it doesn't.
export function readOnlyWords(tags) {
  const things = [];
  for (const t of tags || []) {
    const w = THING[t];
    if (w && !things.includes(w)) things.push(w);
  }
  if (!things.length) return null;
  return `This text has ${listWords(things)}, which this editor can't change. Use Edit as HTML to change it.`;
}

// ---- paste ---------------------------------------------------------------------

// The part of clipboard HTML that was copied. Word and the browsers wrap it in
// <!--StartFragment--> … <!--EndFragment-->, inside a whole document whose head
// holds Word's style sheet. Without the comments, the body's content; without
// a body, all of it. Nothing inside the part is changed.
export function pastedPart(html) {
  const s = String(html ?? "");
  const start = s.indexOf("<!--StartFragment-->");
  const end = s.indexOf("<!--EndFragment-->");
  if (start !== -1 && end > start) return s.slice(start + "<!--StartFragment-->".length, end);
  const body = /<body\b[^>]*>/i.exec(s);
  if (body) {
    const close = s.search(/<\/body\s*>/i);
    return s.slice(body.index + body[0].length, close > body.index ? close : s.length);
  }
  return s;
}

const encodeText = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const encodeAttr = (t) => encodeText(t).replace(/"/g, "&quot;");

// Pasted plain text: each blank-line-separated run is a paragraph, single line
// breaks are <br>. The characters are encoded, so "<500" stays words.
export function plainToHtml(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!s.trim()) return "";
  const paras = s.split(/\n{2,}/).filter((p) => p.length);
  if (paras.length === 1 && !s.includes("\n")) return encodeText(s);
  return paras.map((p) => `<p>${encodeText(p).replace(/\n/g, "<br>")}</p>`).join("");
}

const BLOCK_RE = /<(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|figure|hr)(?=[\s/>])/i;
export const hasBlocks = (html) => BLOCK_RE.test(String(html ?? "").replace(COMMENTS, ""));

// `html` is the field's content with `marker` where the caret was. The result
// has `part` there instead. `split.close` closes, and `split.open` reopens, the
// elements around the caret (innermost first for close), so a pasted paragraph
// never lands inside another paragraph. A half left empty by the split is
// dropped. With no split, `part` goes in as it is.
export function splicePaste(html, marker, part, split = {}) {
  const s = String(html ?? "");
  const at = s.indexOf(marker);
  const p = String(part ?? "");
  if (at === -1) return s + p;
  let before = s.slice(0, at);
  let after = s.slice(at + marker.length);
  const open = split.open || "";
  const close = split.close || "";
  if (!open && !close) return before + p + after;
  if (open && before.endsWith(open)) before = before.slice(0, before.length - open.length);
  else before += close;
  if (close && after.startsWith(close)) after = after.slice(close.length);
  else after = open + after;
  return before + p + after;
}

// A link typed at a caret with nothing selected: the address is its text.
export function linkHtml(href, text) {
  const h = String(href ?? "").trim();
  return `<a href="${encodeAttr(h)}">${encodeText(String(text ?? "") || h)}</a>`;
}

// A marker no founder types: invisible separators around a random word.
export const newMarker = (rand = Math.random) => `⁣rte${Math.floor(rand() * 1e12).toString(36)}⁣`;

// ---- caret and focus ---------------------------------------------------------------

const ELEMENT = 1;
const TEXT = 3;
const kids = (n) => Array.from(n?.childNodes || []);

// focusRequest's offset: element child number `offset` of the root. Past the
// end, the last block, with atEnd true. No offset (or no blocks): null.
export function blockChildAt(root, offset) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  const blocks = kids(root).filter((n) => n.nodeType === ELEMENT);
  if (!blocks.length) return null;
  if (offset < blocks.length) return { node: blocks[offset], index: offset, atEnd: false };
  return { node: blocks[blocks.length - 1], index: blocks.length - 1, atEnd: true };
}

function textNodes(root, out = []) {
  for (const n of kids(root)) {
    if (n.nodeType === TEXT) out.push(n);
    else if (n.nodeType === ELEMENT) textNodes(n, out);
  }
  return out;
}

// The caret (node, offset) as a number of characters from the root's start:
// the text before that point, in document order.
export function textOffset(root, node, offset) {
  if (!root || !node) return 0;
  let count = 0;
  let done = false;
  const walk = (n) => {
    const list = kids(n);
    for (let i = 0; i < list.length && !done; i++) {
      if (n === node && i === offset) {
        done = true;
        return;
      }
      const c = list[i];
      const len = c.nodeType === TEXT ? (c.nodeValue || "").length : 0;
      if (c === node && c.nodeType === TEXT) {
        count += Math.max(0, Math.min(offset || 0, len));
        done = true;
        return;
      }
      if (c.nodeType === TEXT) count += len;
      else if (c.nodeType === ELEMENT) walk(c);
    }
    if (n === node) done = true;
  };
  walk(root);
  return count;
}

// The (node, offset) `n` characters from the root's start, in a text node when
// there is one; past the end, the end of the last text (or of the root).
export function pointAt(root, n) {
  const all = textNodes(root);
  let left = Math.max(0, Number(n) || 0);
  for (const t of all) {
    const len = (t.nodeValue || "").length;
    if (left <= len) return { node: t, offset: left };
    left -= len;
  }
  const last = all[all.length - 1];
  if (last) return { node: last, offset: (last.nodeValue || "").length };
  return { node: root, offset: kids(root).length };
}

// ---- values in and out -------------------------------------------------------------

// What to do with a value that arrived. `emitted` is the last string the field
// sent, `shown` what the surface holds now, `normalized` the value as the
// surface's own parser would write it (so "<br />" and "<br>" are the same).
export function syncAction({ value, emitted = null, shown = null, normalized = null } = {}) {
  const v = typeof value === "string" ? value : "";
  if (emitted != null && v === emitted) return "keep";
  if (shown != null && (v === shown || (normalized != null && normalized === shown))) return "keep";
  return "replace";
}

// The editing surface's own look: the space around the text, the empty hint,
// and links that don't navigate. The text itself is styled by the store's
// shared .rte rules (app/globals.css), which the field copies in from the page.
export const SURFACE_CSS = [
  "html{background:#fff}",
  "body{margin:0;padding:10px 12px;min-height:7rem;outline:none;overflow-wrap:anywhere;font-family:var(--font-sans,ui-sans-serif,system-ui,sans-serif);font-size:15px}",
  "body[data-empty]::before{content:attr(data-placeholder);position:absolute;color:#a1a1aa;pointer-events:none}",
  "body[data-readonly]{background:#fafafa}",
  "a{cursor:text}",
].join("");

// The surface document. The value goes into the body exactly as given: the
// frame is sandboxed without scripts, so nothing in the value can run.
export function frameDocument(html, { label = "", placeholder = "", editable = true } = {}) {
  const v = typeof html === "string" ? html : "";
  const attrs = [`class="rte"`, `role="textbox"`, `aria-multiline="true"`, `aria-label="${encodeAttr(label)}"`, `data-placeholder="${encodeAttr(placeholder)}"`];
  if (!editable) attrs.push(`aria-readonly="true"`, "data-readonly");
  return `<!doctype html><html><head><meta charset="utf-8"><style data-rte-surface>${SURFACE_CSS}</style></head><body ${attrs.join(" ")}>${v}</body></html>`;
}

// True when the shown content has nothing a reader sees (for the empty hint).
export const looksEmpty = (text, html) => !String(text ?? "").replace(/[\s​⁣]/g, "") && !/<(img|hr)\b/i.test(String(html ?? ""));
