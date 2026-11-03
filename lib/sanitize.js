// HTML sanitizer (Session 35 / BE08 — closes the BE34 threat-model residual).
// Edge-safe, dependency-free, ALLOWLIST-based: anything not explicitly allowed
// is dropped. Used on every untrusted rich-HTML render (Shopify
// description_html on the PDP) and on any CMS field that accepts HTML.
//
// Model: a small tokenizer walks tags; allowed elements keep only allowed
// attributes (per-tag), URLs must be http(s)/relative (no javascript:, data:,
// vbscript:), event handlers and style/script/iframe/object/embed/form
// elements are removed WITH their content for script/style. Unknown tags are
// stripped but their inner text kept. Text nodes pass through untouched
// (entities already encoded by the source stay encoded).

const ALLOWED = {
  a: ["href", "title", "target", "rel"],
  b: [], strong: [], i: [], em: [], u: [], s: [], small: [], sub: [], sup: [],
  p: [], br: [], hr: [], span: [], div: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ["start"], li: [],
  blockquote: [], pre: [], code: [],
  table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
  img: ["src", "alt", "width", "height", "loading"],
  figure: [], figcaption: [],
};

// Elements whose CONTENT is dangerous too — drop everything until the close tag.
const DROP_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript"]);

const SAFE_URL = /^(https?:\/\/|\/(?!\/)|#|mailto:)/i;

function safeUrl(value) {
  // decode entity-encoded tricks like java&#x73;cript: before checking
  const decoded = value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[\s\u0000-\u001f]+/g, "");
  return SAFE_URL.test(decoded) ? value : null;
}

// Parse the attribute string of one tag into sanitized name="value" pairs.
function sanitizeAttrs(tag, raw) {
  const allowed = ALLOWED[tag];
  if (!allowed?.length || !raw) return "";
  const out = [];
  const re = /([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!allowed.includes(name) || name.startsWith("on")) continue;
    let value = m[3] ?? m[4] ?? m[5] ?? "";
    if (name === "href" || name === "src") {
      value = safeUrl(value) ?? "";
      if (!value) continue;
    }
    out.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
  }
  // a with target gets the safe rel in place of any rel it came with, so
  // sanitizing what was already sanitized doesn't grow the text (AU-05)
  if (tag === "a" && out.some((a) => a.startsWith("target="))) {
    return " " + [...out.filter((a) => !a.startsWith("rel=")), 'rel="noopener noreferrer"'].join(" ");
  }
  return out.length ? " " + out.join(" ") : "";
}

export function sanitizeHtml(html) {
  if (html == null) return "";
  const input = String(html);
  let out = "";
  let i = 0;
  let dropUntil = null; // inside a DROP_CONTENT element

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      if (!dropUntil) out += input.slice(i);
      break;
    }
    if (lt > i && !dropUntil) out += input.slice(i, lt);

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // dangling "<" — encode it so it can't open a tag downstream
      if (!dropUntil) out += "&lt;" + input.slice(lt + 1);
      break;
    }
    const rawTag = input.slice(lt + 1, gt);
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(rawTag);
    if (!m) {
      // comment, doctype, or garbage — drop it entirely
      i = gt + 1;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();

    if (dropUntil) {
      if (closing && tag === dropUntil) dropUntil = null;
      i = gt + 1;
      continue;
    }
    if (DROP_CONTENT.has(tag)) {
      if (!closing && !rawTag.endsWith("/")) dropUntil = tag;
      i = gt + 1;
      continue;
    }
    if (Object.hasOwn(ALLOWED, tag)) {
      if (closing) out += `</${tag}>`;
      else {
        const selfClose = rawTag.endsWith("/") || tag === "br" || tag === "hr" || tag === "img";
        out += `<${tag}${sanitizeAttrs(tag, rawTag.slice(m[0].length))}${selfClose && (tag === "br" || tag === "hr" || tag === "img") ? " /" : ""}>`;
      }
    }
    // unknown tag: stripped, inner text keeps flowing
    i = gt + 1;
  }
  return out;
}

// --- words the sanitizer would lose (AU-05) ---------------------------------
// sanitizeHtml drops whatever sits between "<" and ">" if it doesn't parse, and
// strips unknown tags, so ordinary typing can vanish: "orders <500 and >100",
// "Priya <priya@store.com>". visibleText reads the same input more strictly:
// only real HTML counts as markup, everything else is somebody's words. A save
// path compares input and output with wordsLostBySanitizing and can refuse
// instead of storing less than was typed.
const OTHER_HTML_TAGS = "abbr acronym address applet area article aside audio base basefont bdi bdo big body button canvas caption center cite col colgroup data datalist dd del details dfn dialog dir dl dt fieldset font footer form frame frameset head header hgroup html ins input kbd label legend link main map mark marquee menu meta meter nav nobr noframes optgroup option output param picture progress q rp rt ruby samp section select slot source strike summary textarea time title track tt var video wbr";
const HTML_TAGS = new Set([...Object.keys(ALLOWED), ...DROP_CONTENT, ...OTHER_HTML_TAGS.split(" ")]);
// Dropped elements whose content a browser never shows anyway. The rest of
// DROP_CONTENT (noscript, svg, math, object) can hold words a reader sees.
const NEVER_SHOWN = new Set(["script", "style", "iframe", "template"]);
const COMMENT_LIKE = /^(!--|!doctype\b|!\[|\?)/i; // comments, doctype, Word's <![if …]>
const ATTR = /(?:\s+|(?<=["']))([a-zA-Z_:][-\w:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/y;
const VALUELESS_ATTR = /-|^(allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|download|hidden|ismap|itemscope|loop|multiple|muted|nomodule|noshade|novalidate|nowrap|open|playsinline|readonly|required|reversed|selected)$/i;

// "<b and c>" parses as a tag, but "and c" are words, not attributes.
function isMarkup(name, attrs) {
  if (!HTML_TAGS.has(name) && !name.includes(":")) return false; // <o:p> is pasted from Word; <founder> is a word
  let at = 0;
  for (;;) {
    ATTR.lastIndex = at;
    const m = ATTR.exec(attrs);
    if (!m) break;
    if (!m[2] && !VALUELESS_ATTR.test(m[1])) return false;
    at = ATTR.lastIndex;
  }
  return /^\s*\/?\s*$/.test(attrs.slice(at));
}

function visibleText(html) {
  const input = String(html ?? "");
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) return out + input.slice(i);
    out += input.slice(i, lt);
    const gt = input.indexOf(">", lt);
    if (gt === -1) return out + input.slice(lt);
    const raw = input.slice(lt + 1, gt);
    i = gt + 1;
    if (COMMENT_LIKE.test(raw)) continue;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z0-9-]+)?)/.exec(raw);
    const tag = m?.[2].toLowerCase();
    if (!m || !isMarkup(tag, raw.slice(m[0].length))) {
      out += `<${raw}>`;
      continue;
    }
    if (!m[1] && !raw.endsWith("/") && DROP_CONTENT.has(tag) && tag !== "embed") {
      const close = new RegExp(`</${tag}`, "gi");
      close.lastIndex = i;
      const closed = close.exec(input);
      const end = closed?.index ?? input.length;
      // never closed: the sanitizer drops the rest of the input with it
      if (!closed || !NEVER_SHOWN.has(tag)) out += input.slice(i, end).replace(/<[^<>]*>/g, "");
      i = end;
    }
  }
  return out;
}

// The words in `input` missing from its sanitized `output` (first to last
// difference), or null when none are. Removing unsafe tags, attributes and
// comments loses no words, so it returns null. Spacing doesn't count.
export function wordsLostBySanitizing(input, output) {
  const comparable = (html) => visibleText(html).replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
  const a = comparable(input);
  const b = comparable(output);
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return a.slice(start, a.length - end).trim() || null;
}
