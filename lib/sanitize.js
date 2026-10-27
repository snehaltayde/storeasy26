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
  if (tag === "a" && out.some((a) => a.startsWith("target="))) out.push('rel="noopener noreferrer"');
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
