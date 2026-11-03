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

// A whole comment, including the short forms browsers end at once: <!--> <!--->
const COMMENT = /<!--(?:-?>|[\s\S]*?--!?>)/y;

const SAFE_URL = /^(https?:\/\/|\/(?!\/)|#|mailto:)/i;
// Addresses that only run code. Every other unsafe address is somebody's real
// link or picture, which addressesLostBySanitizing reports (AU-05).
const SCRIPT_URL = /^(javascript|vbscript):/i;

// decode entity-encoded tricks like java&#x73;cript: before checking
const decodedUrl = (value) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[\s\u0000-\u001f]+/g, "");

function safeUrl(value) {
  return SAFE_URL.test(decodedUrl(value)) ? value : null;
}

// Parse the attribute string of one tag into sanitized name="value" pairs.
function sanitizeAttrs(tag, raw, lostAddresses) {
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
      const typed = value;
      value = safeUrl(value) ?? "";
      if (!value) {
        if (lostAddresses && typed.trim() && !SCRIPT_URL.test(decodedUrl(typed))) lostAddresses.push(typed);
        continue;
      }
    }
    out.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
  }
  // a with target keeps the rel words it came with (nofollow, sponsored), never
  // "opener", and has the safe ones once, so sanitizing what was already
  // sanitized doesn't grow the text (AU-05)
  if (tag === "a" && out.some((a) => a.startsWith("target="))) {
    const incoming = out.filter((a) => a.startsWith("rel=")).flatMap((a) => a.slice(5, -1).toLowerCase().split(/\s+/));
    const rel = new Set([...incoming.filter((word) => word && word !== "opener"), "noopener", "noreferrer"]);
    return " " + [...out.filter((a) => !a.startsWith("rel=")), `rel="${[...rel].join(" ")}"`].join(" ");
  }
  return out.length ? " " + out.join(" ") : "";
}

export function sanitizeHtml(html) {
  return sanitize(html, null);
}

function sanitize(html, lostAddresses) {
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

    // A comment ends at its own end, not at the first ">" inside it, so the
    // rest of a private note isn't published. Never closed: it hides the rest
    // of the input, as it would in a browser.
    if (!dropUntil && input.startsWith("<!--", lt)) {
      COMMENT.lastIndex = lt;
      if (!COMMENT.test(input)) break;
      i = COMMENT.lastIndex;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // No ">" left, so nothing from here on is a whole tag. Encode EVERY "<" in
      // the rest: one left raw would open a tag that the next ">" on the page
      // closes, with its event handlers still on it.
      if (!dropUntil) out += input.slice(lt).replace(/</g, "&lt;");
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
        out += `<${tag}${sanitizeAttrs(tag, rawTag.slice(m[0].length), lostAddresses)}${selfClose && (tag === "br" || tag === "hr" || tag === "img") ? " /" : ""}>`;
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
// "Priya <priya@store.com>", "<tel:9876543210>", "the <link> below". visibleText
// reads the same input more strictly: only real HTML counts as markup,
// everything else is somebody's words. A save path compares input and output
// with wordsLostBySanitizing and can refuse instead of storing less than was
// typed.
const OTHER_HTML_TAGS = "abbr acronym address applet area article aside audio base basefont bdi bdo big body button canvas caption center cite col colgroup data datalist dd del details dfn dialog dir dl dt fieldset font footer form frame frameset head header hgroup html ins input kbd label legend link main map mark marquee menu meta meter nav nobr noframes optgroup option output param picture progress q rp rt ruby samp section select slot source strike summary textarea time title track tt var video wbr";
const HTML_TAGS = new Set([...Object.keys(ALLOWED), ...DROP_CONTENT, ...OTHER_HTML_TAGS.split(" ")]);
// Dropped elements whose content a browser never shows anyway. The rest of
// DROP_CONTENT (noscript, svg, math, object) can hold words a reader sees.
const NEVER_SHOWN = new Set(["script", "style", "iframe", "template"]);
const COMMENT_LIKE = /^(!--|!doctype\b|!\[|\?)/i; // comments, doctype, Word's <![if …]>
const ATTR = /(?:\s+|(?<=["']))([a-zA-Z_:][-\w:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/y;
const VALUELESS_ATTR = /^(data|aria)-|^(allowfullscreen|async|autofocus|autoplay|checked|controls|default|defer|disabled|download|hidden|ismap|itemscope|loop|multiple|muted|nomodule|noshade|novalidate|nowrap|open|playsinline|readonly|required|reversed|selected)$/i;
const WORD_PASTE_TAG = /^(o|w|v|m|st1|x):[a-z]+(-[a-z]+)*$/; // <o:p> and <st1:country-region> are pasted from Word; <tel:98765> is somebody's words
const NEVER_CLOSED = new Set(["col", "wbr"]); // real tables and pasted text hold these bare, and nobody types them as words

// "<b and c>" parses as a tag, but "and c" are words, not attributes.
function isMarkup(name, attrs) {
  if (!HTML_TAGS.has(name) && !WORD_PASTE_TAG.test(name)) return false; // <founder> is a word
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
  const lastClose = new Map();
  for (const c of input.matchAll(/<\/([a-zA-Z][a-zA-Z0-9:-]*)/g)) lastClose.set(c[1].toLowerCase(), c.index);
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
    const attrs = m ? raw.slice(m[0].length) : "";
    // "the <link> below": a tag the sanitizer strips, with no attributes and
    // nothing closing it, does nothing as HTML, so it's somebody's word
    const loneName = !m?.[1] && !attrs.trim() && !Object.hasOwn(ALLOWED, tag) && !NEVER_CLOSED.has(tag) && !(lastClose.get(tag) > lt);
    if (!m || loneName || !isMarkup(tag, attrs)) {
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

// The link and image addresses in `input` that sanitizing would remove. An
// address that only runs code is left to AU-06's notice: nobody loses a link.
export function addressesLostBySanitizing(input) {
  const lost = [];
  sanitize(input, lost);
  return lost;
}
