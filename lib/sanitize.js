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

// "/\host" is read by browsers as "//host" (another site), so a backslash after the slash is not a store path
const SAFE_URL = /^(https?:\/\/|\/(?![\/\\])|#|mailto:)/i;
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

// [name, value] for each attribute with a value in one tag's attribute string.
const attrValues = (raw) => [...raw.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [m[1].toLowerCase(), m[3] ?? m[4] ?? m[5] ?? ""]);
const worthReporting = (address) => address.trim() && !SCRIPT_URL.test(decodedUrl(address));

// Parse the attribute string of one tag into sanitized name="value" pairs.
function sanitizeAttrs(tag, raw, lost) {
  const allowed = ALLOWED[tag];
  if (!allowed?.length || !raw) return "";
  const out = [];
  for (const [name, typed] of attrValues(raw)) {
    if (!allowed.includes(name) || name.startsWith("on")) continue;
    let value = typed;
    if (name === "href" || name === "src") {
      value = safeUrl(value) ?? "";
      if (!value) {
        if (lost && worthReporting(typed)) lost.push({ kind: "link", address: typed });
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

// Founder media the sanitizer removes (AU-05): a video, a sound, or a picture
// whose only address is one the sanitizer doesn't keep. The address is what
// they would lose, so a save refuses it instead of reporting success.
const MEDIA_ADDRESS = new Map([["iframe", ["src"]], ["embed", ["src"]], ["object", ["data", "src"]], ["video", ["src"]], ["audio", ["src"]], ["source", ["src"]]]);
const PICTURE_ADDRESS = ["srcset", "data-src"];

function noteLostMedia(tag, raw, lost) {
  const attrs = attrValues(raw);
  const typedIn = (names) => attrs.filter(([name, value]) => names.includes(name) && worthReporting(value)).map(([, value]) => value);
  if (MEDIA_ADDRESS.has(tag)) {
    for (const address of typedIn(MEDIA_ADDRESS.get(tag))) lost.push({ kind: "media", address });
  } else if (tag === "img" && !attrs.some(([name, value]) => name === "src" && safeUrl(value))) {
    for (const address of typedIn(PICTURE_ADDRESS)) lost.push({ kind: "picture", address });
  }
}

export function sanitizeHtml(html) {
  return sanitize(html, null);
}

function sanitize(html, lost) {
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
    if (lost && !closing) noteLostMedia(tag, rawTag.slice(m[0].length), lost);
    if (DROP_CONTENT.has(tag)) {
      if (!closing && !rawTag.endsWith("/")) dropUntil = tag;
      i = gt + 1;
      continue;
    }
    if (Object.hasOwn(ALLOWED, tag)) {
      if (closing) out += `</${tag}>`;
      else {
        const selfClose = rawTag.endsWith("/") || tag === "br" || tag === "hr" || tag === "img";
        out += `<${tag}${sanitizeAttrs(tag, rawTag.slice(m[0].length), lost)}${selfClose && (tag === "br" || tag === "hr" || tag === "img") ? " /" : ""}>`;
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
// Real markup with no words in it. Anything else after "<!" or "<?" is words:
// "<?500>", "<![sale]>", "<!doctype sale>". Comments are read whole, before this.
const COMMENT_LIKE = /^(!doctype\s+html\b|!\[if\b|!\[endif\b|!\[cdata\b|\?xml\b)/i;
const ATTR = /(?:\s+|(?<=["']))([a-zA-Z_:][-\w:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/y;
// An attribute with no value means something on any tag, or only on the tags
// listed. On any other tag it's somebody's word: "Keep <b required> here".
const VALUELESS_ANYWHERE = /^(data|aria)-|^(autofocus|hidden|itemscope)$/i;
const VALUELESS_ON = {
  allowfullscreen: "iframe",
  async: "script", defer: "script", nomodule: "script",
  autoplay: "audio video", controls: "audio video", loop: "audio video", muted: "audio video", playsinline: "video",
  checked: "input",
  default: "track",
  disabled: "button fieldset input link optgroup option select textarea",
  download: "a area",
  ismap: "img",
  multiple: "input select",
  noshade: "hr",
  novalidate: "form",
  nowrap: "td th",
  open: "details dialog",
  readonly: "input textarea",
  required: "input select textarea",
  reversed: "ol",
  selected: "option",
};
const valuelessFits = (attr, tag) => VALUELESS_ANYWHERE.test(attr) || (Object.hasOwn(VALUELESS_ON, attr.toLowerCase()) && VALUELESS_ON[attr.toLowerCase()].split(" ").includes(tag));
const WORD_PASTE_TAG = /^(o|w|v|m|st1|x):[a-z]+(-[a-z]+)*$/; // <o:p> and <st1:country-region> are pasted from Word; <tel:98765> is somebody's words
const NEVER_CLOSED = new Set(["col", "wbr"]); // real tables and pasted text hold these bare, and nobody types them as words

// A web page's own element (P3-FIX4, web pastes only): a name with a hyphen,
// such as <product-info> or <relative-time>, the way a browser's custom
// elements are named. Every Shopify theme has them. The sanitizer unwraps them
// and keeps their children, so they are markup, not words.
const CUSTOM_ELEMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
// On such an element, an attribute with no value counts only when it reads as
// one (defer-hydration, hidden): "<sale-ends soon>" is somebody's words.
const customValuelessFits = (attr, tag) => valuelessFits(attr, tag) || attr.includes("-") || Object.hasOwn(VALUELESS_ON, attr.toLowerCase());

// Every attribute in `attrs` is a real one: name="value", or a valueless one
// that means something on this tag. { real, valued } (valued: at least one
// attribute has a value).
function attributesOf(name, attrs, custom) {
  let at = 0;
  let valued = false;
  for (;;) {
    ATTR.lastIndex = at;
    const m = ATTR.exec(attrs);
    if (!m) break;
    if (!m[2] && !(custom ? customValuelessFits : valuelessFits)(m[1], name)) return { real: false, valued };
    if (m[2]) valued = true;
    at = ATTR.lastIndex;
  }
  return { real: /^\s*\/?\s*$/.test(attrs.slice(at)), valued };
}

// "<b and c>" parses as a tag, but "and c" are words, not attributes.
function isMarkup(name, attrs, webPaste = false) {
  const custom = webPaste && CUSTOM_ELEMENT.test(name);
  if (!custom && !HTML_TAGS.has(name) && !WORD_PASTE_TAG.test(name)) return false; // <founder> is a word
  return attributesOf(name, attrs, custom).real;
}

// P3-FIX5: the tag the refusal words may name (lib/registry/text.js), or null when the lost words hold none. A tag is named only
// when it reads as markup: a known element, a web page's own element (a name
// with a hyphen) or a Word tag, or any name carrying an attribute with a value
// (<shop class="x">), and in every case only real attributes. Anything else is
// somebody's < or > signs: "<b and c>", "Size <XL or bigger>", "Ask for the
// <founder> today". "<priya@store.com>" and "<tel:98765>" are never tags.
const TAG_LIKE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z][a-zA-Z0-9-]*)?)(?=[\s/>])([^<>]*)/g;
export function markupTagIn(words) {
  for (const m of String(words ?? "").matchAll(TAG_LIKE)) {
    const name = m[2].toLowerCase();
    const attrs = m[1] ? "" : m[3];
    const custom = CUSTOM_ELEMENT.test(name);
    const known = custom || HTML_TAGS.has(name) || WORD_PASTE_TAG.test(name);
    const { real, valued } = attributesOf(name, attrs, custom);
    if (real && (known || valued)) return name;
  }
  return null;
}

// `webPaste` (the documents editor's cleaner, P3-FIX4) reads a web page's
// paste the way a browser shows it: its own elements (<product-info …>) are
// markup, and a <noscript>'s content is never shown, since every browser that
// opens the store runs scripts. The legacy editors keep the strict reading.
function visibleText(html, webPaste = false) {
  const input = String(html ?? "");
  const lastClose = new Map();
  for (const c of input.matchAll(/<\/([a-zA-Z][a-zA-Z0-9:-]*)/g)) lastClose.set(c[1].toLowerCase(), c.index);
  let out = "";
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) return out + input.slice(i);
    out += input.slice(i, lt);
    if (input.startsWith("<!--", lt)) {
      COMMENT.lastIndex = lt;
      // never closed: the sanitizer drops the rest of the input with it
      if (!COMMENT.test(input)) return out + input.slice(lt);
      i = COMMENT.lastIndex;
      continue;
    }
    const gt = input.indexOf(">", lt);
    if (gt === -1) return out + input.slice(lt);
    const raw = input.slice(lt + 1, gt);
    i = gt + 1;
    if (COMMENT_LIKE.test(raw)) continue;
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z0-9-]+)?)/.exec(raw);
    const tag = m?.[2].toLowerCase();
    const attrs = m ? raw.slice(m[0].length) : "";
    // "the <link> below": a tag the sanitizer strips, with no attributes and
    // nothing closing it, does nothing as HTML, so it's somebody's word. "/"
    // alone is no attribute ("<link/>"), though Word really writes <o:p/>.
    const selfClosed = /^\s*\/\s*$/.test(attrs);
    const loneName = !m?.[1] && (!attrs.trim() || (selfClosed && !WORD_PASTE_TAG.test(tag))) && !Object.hasOwn(ALLOWED, tag) && !NEVER_CLOSED.has(tag) && !(lastClose.get(tag) > lt);
    if (!m || loneName || !isMarkup(tag, attrs, webPaste)) {
      out += `<${raw}>`;
      continue;
    }
    if (!m[1] && !raw.endsWith("/") && DROP_CONTENT.has(tag) && tag !== "embed") {
      const close = new RegExp(`</${tag}`, "gi");
      close.lastIndex = i;
      const closed = close.exec(input);
      const end = closed?.index ?? input.length;
      // never closed: the sanitizer drops the rest of the input with it
      if (!closed || !(NEVER_SHOWN.has(tag) || (webPaste && tag === "noscript"))) out += input.slice(i, end).replace(/<[^<>]*>/g, "");
      i = end;
    }
  }
  return out;
}

// The words in `input` missing from its sanitized `output` (first to last
// difference), or null when none are. Removing unsafe tags, attributes and
// comments loses no words, so it returns null. Spacing doesn't count.
// `{ webPaste: true }` (documents only) cleans a web page's own elements and a
// <noscript> instead of refusing them; see visibleText.
export function wordsLostBySanitizing(input, output, { webPaste = false } = {}) {
  const comparable = (html) => visibleText(html, webPaste).replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
  const a = comparable(input);
  const b = comparable(output);
  if (a === b) return null;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return a.slice(start, a.length - end).trim() || null;
}

// What sanitizing would remove from `input` that the founder would miss, as
// { kind, address }: "link" (a link or image address the sanitizer refuses),
// "media" (a video or sound) or "picture" (an image with its only address
// somewhere the sanitizer doesn't keep). An address that only runs code is left
// to AU-06's notice: nobody loses anything they wanted.
export function addressesLostBySanitizing(input) {
  const lost = [];
  sanitize(input, lost);
  return lost;
}
