// P4-EQUIV (MIG-02): the rendered comparison. Two captures of the same shopper
// pages (before and after a move to the new editor) are normalized and
// compared element by element; every difference is named by its page and
// where on the page it is (a CSS-like selector).
//
// Pure: no database, no network, no node: APIs (only renderRoutesFor at the
// bottom reads the store, through lib/db.js, inside the tenant's context).
// scripts/migrate-render.mjs captures and compares with it; P4-CUTOVER runs
// that against the harness serving a restore-drill copy (its rehearsal).
//
//   normalize(html, { origin })      the page as one normalized string (what
//                                    the comparison sees), see below
//   normalizeTree(html, { origin })  -> { tree, experiments } the same as a tree
//   compare(before, after, { allowed, route, maxPerRoute })
//       before/after: one capture, a list of captures, or a plain HTML string.
//       A capture is { route, status, contentType, location, body, origin }.
//       -> { same, differences: [{ route, selector, before, after }],
//            allowedApplied: [{ route, id }], compared }
//       `allowed` defaults to [] (strict): pass ALLOWED_DIFFERENCES from
//       lib/migrate/allowed-differences.js to set its entries aside.
//   renderRoutesFor(mapped)          the route list for a store (the canaries
//                                    plus every product and collection with
//                                    old content), from lib/migrate/map.js's
//                                    mapping, inside withTenant
//
// What normalizing removes (things that differ between two visits to the
// same unchanged store, or that no shopper sees):
//   - scripts (the page's own code and its streamed data), comments, the
//     Next.js route announcer and dev overlay, links to /_next/ assets;
//   - streamed parts are put back where the browser puts them: React sends a
//     fallback first and the real part later in a hidden <div id="S:n"> with
//     a $RC/$RS instruction; normalizing applies those instructions, so the
//     comparison sees the finished page whatever order the parts came in;
//   - id attributes (React's generated ids change with the tree), nonce,
//     data-precedence; generated ids inside other attributes (aria-*,
//     htmlFor) become <id>;
//   - hashed asset names: any /_next/static/... address becomes
//     /_next/static/<asset>, and a dpl= deployment id is removed (build ids
//     live in scripts and those addresses);
//   - full date-times (2026-11-04T10:00:00Z) become <time>; plain dates
//     (a journal post's date) are kept;
//   - the capture's own origin (http://localhost:<port>) becomes <origin>, so
//     two captures from different ports compare;
//   - preview-only markup: [data-preview-bar], [data-preview-note] elements
//     and data-preview*, data-field*, data-doc attributes;
//   - whitespace: runs collapse to one space, text is trimmed, empty text
//     goes; attributes are sorted by name.
// Everything else a shopper could see (text, images, links, classes, order)
// is compared.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const DROP_TAGS = new Set(["script", "template", "next-route-announcer", "nextjs-portal"]);
const DROP_ATTRS = new Set(["id", "nonce", "data-precedence", "data-doc"]);
// attributes that name what an element is: they go into selectors, and a
// change in one is reported once for the whole element
export const MARKER_ATTRS = Object.freeze(["data-sec", "data-section-kind", "data-pdp-template", "data-collection-template"]);

// ---------- parsing ----------
//
// A small tolerant HTML parser, enough for what React renders: elements,
// attributes, text, comments. Nodes: { tag, attrs: [[name, value]], children }
// and { text } and { comment }. Entities are left as they are (both sides are
// rendered by the same code, so they encode the same way).

const NAME = /[^\s/>=]+/y;
const SPACE = /\s*/y;

function readAttrs(s, at) {
  const attrs = [];
  let i = at;
  for (;;) {
    SPACE.lastIndex = i;
    SPACE.exec(s);
    i = SPACE.lastIndex;
    if (i >= s.length) return { attrs, end: s.length, selfClose: false };
    if (s[i] === ">") return { attrs, end: i + 1, selfClose: false };
    if (s[i] === "/" && s[i + 1] === ">") return { attrs, end: i + 2, selfClose: true };
    if (s[i] === "/") {
      i++;
      continue;
    }
    NAME.lastIndex = i;
    const m = NAME.exec(s);
    if (!m) {
      i++;
      continue;
    }
    const name = m[0].toLowerCase();
    i = NAME.lastIndex;
    SPACE.lastIndex = i;
    SPACE.exec(s);
    let value = "";
    if (s[SPACE.lastIndex] === "=") {
      i = SPACE.lastIndex + 1;
      SPACE.lastIndex = i;
      SPACE.exec(s);
      i = SPACE.lastIndex;
      const q = s[i];
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, i + 1);
        const stop = close < 0 ? s.length : close;
        value = s.slice(i + 1, stop);
        i = close < 0 ? s.length : close + 1;
      } else {
        let j = i;
        while (j < s.length && !/[\s>]/.test(s[j])) j++;
        value = s.slice(i, j);
        i = j;
      }
    }
    attrs.push([name, value]);
  }
}

export function parseHtml(html) {
  const s = String(html ?? "");
  const root = { tag: "#root", attrs: [], children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const text = (t) => {
    if (t) top().children.push({ text: t });
  };
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      text(s.slice(i));
      break;
    }
    if (lt > i) text(s.slice(i, lt));
    if (s.startsWith("<!--", lt)) {
      const end = s.indexOf("-->", lt + 4);
      top().children.push({ comment: s.slice(lt + 4, end < 0 ? s.length : end) });
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    const next = s[lt + 1];
    if (next === "!" || next === "?") {
      const end = s.indexOf(">", lt);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (next === "/") {
      const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(s.slice(lt, lt + 120));
      if (!m) {
        text("<");
        i = lt + 1;
        continue;
      }
      const tag = m[1].toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) {
          stack.length = k;
          break;
        }
      }
      i = lt + m[0].length;
      continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(s.slice(lt, lt + 120));
    if (!m) {
      text("<");
      i = lt + 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    const { attrs, end, selfClose } = readAttrs(s, lt + m[0].length);
    const node = { tag, attrs, children: [] };
    top().children.push(node);
    i = end;
    if (VOID.has(tag) || selfClose) continue;
    if (RAW_TEXT.has(tag)) {
      const close = s.toLowerCase().indexOf(`</${tag}`, i);
      const stop = close < 0 ? s.length : close;
      if (stop > i) node.children.push({ text: s.slice(i, stop) });
      const gt = close < 0 ? s.length : s.indexOf(">", close);
      i = gt < 0 ? s.length : gt + 1;
      continue;
    }
    stack.push(node);
  }
  return root;
}

const attr = (node, name) => {
  const a = node.attrs?.find(([k]) => k === name);
  return a ? a[1] : undefined;
};
const isEl = (n) => n && typeof n.tag === "string";

// ---------- streamed parts ----------

// The $RC("B:n","S:n") and $RS("S:n","P:n") instructions, in page order.
// $RR is $RC with styles. $RX (a part that failed on the server) is left out:
// its fallback stays, as in a browser before the client renders it.
export function streamInstructions(html) {
  const out = [];
  const re = /\$R([CRS])\("([^"\\]+)","([^"\\]+)"/g;
  let m;
  while ((m = re.exec(String(html ?? "")))) out.push(m[1] === "S" ? { kind: "segment", from: m[2], to: m[3] } : { kind: "boundary", boundary: m[2], from: m[3] });
  return out;
}

function indexById(root) {
  const map = new Map();
  const walk = (node, parent) => {
    if (!isEl(node)) return;
    const id = attr(node, "id");
    if (id !== undefined && !map.has(id)) map.set(id, { node, parent });
    for (const c of node.children) walk(c, node);
  };
  walk(root, null);
  return map;
}

function detach(entry) {
  const list = entry.parent?.children;
  const at = list ? list.indexOf(entry.node) : -1;
  if (at >= 0) list.splice(at, 1);
}

function applyStreaming(root, html) {
  for (const ins of streamInstructions(html)) {
    const ids = indexById(root);
    const hidden = ids.get(ins.from);
    if (!hidden) continue;
    if (ins.kind === "segment") {
      const ph = ids.get(ins.to);
      if (!ph || ph.node.tag !== "template") continue;
      const list = ph.parent.children;
      const at = list.indexOf(ph.node);
      detach(hidden);
      list.splice(at, 1, ...hidden.node.children);
      continue;
    }
    const tpl = ids.get(ins.boundary);
    if (!tpl || tpl.node.tag !== "template") continue;
    detach(hidden);
    const list = tpl.parent.children;
    const at = list.indexOf(tpl.node);
    // the fallback runs from the template to the boundary's closing <!--/$-->
    // (the comments themselves are dropped later)
    let depth = 0;
    let end = list.length - 1;
    for (let k = at + 1; k < list.length; k++) {
      const c = list[k].comment;
      if (c === undefined) continue;
      if (c === "/$") {
        if (depth === 0) {
          end = k - 1;
          break;
        }
        depth--;
      } else if (c.startsWith("$")) depth++;
    }
    list.splice(at, end - at + 1, ...hidden.node.children);
  }
}

// ---------- normalizing ----------

const USE_ID = /_R_[A-Za-z0-9_]*_|«[rR][0-9a-zA-Z]*»|:[rR][0-9a-zA-Z]+:/g;
const DATE_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const NEXT_ASSET = /\/_next\/static\/[^\s"',)]+/g;
// a deployment id query parameter (?dpl=…, &dpl=… or &amp;dpl=… in HTML)
const DPL = /(\?|&amp;|&)dpl=[^&"'\s]*(&amp;|&)?/g;
const stripDpl = (v) => v.replace(DPL, (_, sep, after) => (sep === "?" ? (after ? "?" : "") : (after ?? "")));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cleanValue(v, origin) {
  let out = String(v);
  if (origin) out = out.replace(new RegExp(escapeRe(origin), "g"), "<origin>");
  return stripDpl(out)
    .replace(NEXT_ASSET, "/_next/static/<asset>")
    .replace(USE_ID, "<id>")
    .replace(DATE_TIME, "<time>")
    .replace(/\s+/g, " ")
    .trim();
}

function dropElement(node) {
  if (DROP_TAGS.has(node.tag)) return true;
  if (node.tag === "link" && /^\/_next\//.test(attr(node, "href") ?? "")) return true;
  if (attr(node, "data-preview-bar") !== undefined || attr(node, "data-preview-note") !== undefined) return true;
  // a streamed part no instruction placed
  if (node.tag === "div" && attr(node, "hidden") !== undefined && /^S:/.test(attr(node, "id") ?? "")) return true;
  return false;
}

function dropAttr(name) {
  return DROP_ATTRS.has(name) || name.startsWith("data-preview") || name.startsWith("data-field");
}

function cleanNode(node, origin) {
  const attrs = [];
  for (const [k, v] of node.attrs) if (!dropAttr(k)) attrs.push([k, cleanValue(v, origin)]);
  attrs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const children = [];
  let pending = "";
  const flush = () => {
    const t = cleanValue(pending, origin);
    if (t) children.push({ text: t });
    pending = "";
  };
  for (const c of node.children) {
    if (c.comment !== undefined) continue;
    if (c.text !== undefined) {
      pending += c.text;
      continue;
    }
    if (dropElement(c)) continue;
    // adjacent text across a dropped element or comment joins up
    flush();
    children.push(cleanNode(c, origin));
  }
  flush();
  return { tag: node.tag, attrs, children };
}

// Running experiments named in the page's streamed data (the ExperimentPing
// props, { slug, unit }), before scripts are dropped.
export function experimentsIn(html) {
  const out = new Set();
  const re = /slug\\?"\s*:\s*\\?"([A-Za-z0-9_-]+)\\?"\s*,\s*\\?"unit\\?"\s*:\s*\\?"[0-9a-fA-F-]{8,}/g;
  let m;
  while ((m = re.exec(String(html ?? "")))) out.add(m[1]);
  return [...out].sort();
}

// The page's metadata (<title>, <meta>, <link>) may stream in after the body
// (Next sends late metadata at the end); the browser moves it into <head>.
// Every one of them (outside an <svg>, where <title> is a tooltip) is moved
// into <head>, sorted, so where it arrived doesn't matter.
const HEAD_TAGS = new Set(["title", "meta", "link", "base"]);
function hoistHead(tree) {
  const found = [];
  const walk = (n) => {
    if (!isEl(n) || n.tag === "svg") return;
    n.children = n.children.filter((c) => {
      if (isEl(c) && HEAD_TAGS.has(c.tag)) {
        found.push(c);
        return false;
      }
      walk(c);
      return true;
    });
  };
  walk(tree);
  const html = tree.children.find((c) => isEl(c) && c.tag === "html") ?? tree;
  let head = html.children.find((c) => isEl(c) && c.tag === "head");
  if (!head) {
    head = { tag: "head", attrs: [], children: [] };
    html.children.unshift(head);
  }
  const keyed = found.map((n) => {
    const lines = [];
    serialize(n, 0, lines);
    return [lines.join("\n"), n];
  });
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  head.children = [...keyed.map(([, n]) => n), ...head.children];
  return tree;
}

export function normalizeTree(html, { origin = null } = {}) {
  const root = parseHtml(html);
  applyStreaming(root, html);
  return { tree: hoistHead(cleanNode(root, origin)), experiments: experimentsIn(html) };
}

function serialize(node, depth, lines) {
  const pad = "  ".repeat(depth);
  if (node.text !== undefined) {
    lines.push(pad + node.text);
    return;
  }
  const open = `<${node.tag}${node.attrs.map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${v}"`)).join("")}>`;
  if (!node.children.length) {
    lines.push(pad + open + (VOID.has(node.tag) ? "" : `</${node.tag}>`));
    return;
  }
  lines.push(pad + open);
  for (const c of node.children) serialize(c, depth + 1, lines);
  lines.push(`${pad}</${node.tag}>`);
}

const serializeChildren = (tree) => {
  const lines = [];
  for (const c of tree.children) serialize(c, 0, lines);
  return lines.join("\n");
};

/** The page as the comparison sees it: one element or text per line. */
export function normalize(html, opts = {}) {
  return serializeChildren(normalizeTree(html, opts).tree);
}

// ---------- comparing ----------

// cyrb53: a fast 53-bit string hash, for subtree signatures
function hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// subtree signatures, cached per node (cleared when an allowed difference
// rewrites a tree)
const SIGS = new WeakMap();
function sig(node) {
  const cached = SIGS.get(node);
  if (cached) return cached;
  const s = node.text !== undefined ? `t:${node.text}` : `e:${node.tag}|${node.attrs.map(([k, v]) => `${k}=${v}`).join("\u0001")}|${node.children.map(sig).join(",")}`;
  const h = hash53(s);
  SIGS.set(node, h);
  return h;
}
function clearSigs(node) {
  SIGS.delete(node);
  if (node.children) for (const c of node.children) clearSigs(c);
}

const MAX_SHOWN = 300;
function shown(node) {
  if (node == null) return null;
  const lines = [];
  serialize(node, 0, lines);
  const s = lines.map((l) => l.trim()).join(" ");
  return s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}…` : s;
}

function segment(node, siblings) {
  if (node.text !== undefined) return "text()";
  for (const name of MARKER_ATTRS) {
    const v = attr(node, name);
    if (v !== undefined && v !== "") {
      const same = siblings.filter((s) => isEl(s) && s.tag === node.tag && attr(s, name) === v);
      if (same.length === 1) return `${node.tag}[${name}="${v}"]`;
    }
  }
  const sameTag = siblings.filter((s) => isEl(s) && s.tag === node.tag);
  if (sameTag.length <= 1) return node.tag;
  return `${node.tag}:nth-of-type(${sameTag.indexOf(node) + 1})`;
}

const join = (path, seg) => (path ? `${path} > ${seg}` : seg);
const markersOf = (node) => MARKER_ATTRS.map((n) => attr(node, n) ?? null).join("\u0001");
const attrText = (attrs) => attrs.map(([k, v]) => (v === "" ? k : `${k}="${v}"`)).join(" ");

// Longest common subsequence of two signature lists -> matched index pairs.
function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function diffNode(a, b, path, aSibs, bSibs, out) {
  if (sig(a) === sig(b)) return;
  const where = join(path, segment(a, aSibs));
  if (a.text !== undefined || b.text !== undefined) {
    out.push({ selector: a.text !== undefined && b.text !== undefined ? join(path, "text()") : where, before: shown(a), after: shown(b) });
    return;
  }
  if (a.tag !== b.tag || markersOf(a) !== markersOf(b)) {
    // a different element, or the same element marked as something else (a
    // different template or section): one difference for the whole of it
    out.push({ selector: where, before: shown(a), after: shown(b) });
    return;
  }
  const aAttrs = new Map(a.attrs);
  const bAttrs = new Map(b.attrs);
  const changed = [...new Set([...aAttrs.keys(), ...bAttrs.keys()])].filter((k) => aAttrs.get(k) !== bAttrs.get(k)).sort();
  if (changed.length) {
    out.push({
      selector: where,
      before: attrText(changed.filter((k) => aAttrs.has(k)).map((k) => [k, aAttrs.get(k)])) || "(no such attribute)",
      after: attrText(changed.filter((k) => bAttrs.has(k)).map((k) => [k, bAttrs.get(k)])) || "(no such attribute)",
    });
  }
  diffChildren(a, b, where, out);
}

function diffChildren(a, b, where, out) {
  const ac = a.children;
  const bc = b.children;
  const ka = ac.map(sig);
  const kb = bc.map(sig);
  if (ka.length === kb.length && ka.every((k, i) => k === kb[i])) return;
  // the same children in another order: one difference, the order
  if (ka.length === kb.length && [...ka].sort().join() === [...kb].sort().join()) {
    out.push({ selector: where, before: `in this order: ${ac.map(shownShort).join(" | ")}`, after: `in this order: ${bc.map(shownShort).join(" | ")}` });
    return;
  }
  // common start and end, then the longest common run in between
  let s = 0;
  while (s < ka.length && s < kb.length && ka[s] === kb[s]) s++;
  let e = 0;
  while (e < ka.length - s && e < kb.length - s && ka[ka.length - 1 - e] === kb[kb.length - 1 - e]) e++;
  const midA = ka.slice(s, ka.length - e);
  const midB = kb.slice(s, kb.length - e);
  const pairs = lcsPairs(midA, midB).map(([i, j]) => [i + s, j + s]);
  pairs.push([ka.length - e, kb.length - e]);
  let i = s;
  let j = s;
  for (const [pi, pj] of pairs) {
    const gapA = ac.slice(i, pi);
    const gapB = bc.slice(j, pj);
    // pair up what changed in place (same kind of node), report the rest as
    // missing or extra
    // first the same element (tag and markers), then the same tag (a block
    // whose template or kind changed is one difference, not a removal and an
    // addition)
    const usedB = new Set();
    const partner = new Map();
    const sameKind = (x, y) => (x.text !== undefined ? y.text !== undefined : y.tag === x.tag);
    for (const strict of [true, false]) {
      for (const [n, x] of gapA.entries()) {
        if (partner.has(n)) continue;
        const k = gapB.findIndex((y, m) => !usedB.has(m) && sameKind(x, y) && (!strict || x.text !== undefined || markersOf(y) === markersOf(x)));
        if (k >= 0) {
          usedB.add(k);
          partner.set(n, k);
        }
      }
    }
    for (const [n, x] of gapA.entries()) {
      if (partner.has(n)) diffNode(x, gapB[partner.get(n)], where, ac, bc, out);
      else out.push({ selector: join(where, segment(x, ac)), before: shown(x), after: null });
    }
    gapB.forEach((y, n) => {
      if (!usedB.has(n)) out.push({ selector: join(where, segment(y, bc)), before: null, after: shown(y) });
    });
    i = pi + 1;
    j = pj + 1;
  }
}

// A child as a shopper would name it in an order list: its words (or, for a
// picture alone, its alt text), else its markup.
function shownShort(node) {
  const words = [];
  const alts = [];
  const walk = (n) => {
    if (n.text !== undefined) words.push(n.text);
    else {
      const alt = attr(n, "alt");
      if (alt) alts.push(alt);
      for (const c of n.children) walk(c);
    }
  };
  walk(node);
  const v = words.join(" ").trim() || alts.join(" ").trim() || shown(node) || "";
  return v.length > 60 ? `${v.slice(0, 60)}…` : v;
}

// JSON bodies (the cart offer): compared by path.
function diffJson(a, b, path, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObj = (v) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    const ka = a.map((v) => JSON.stringify(v));
    const kb = b.map((v) => JSON.stringify(v));
    if (ka.length === kb.length && [...ka].sort().join() === [...kb].sort().join()) {
      out.push({ selector: path, before: `in this order: ${ka.join(" | ")}`.slice(0, MAX_SHOWN), after: `in this order: ${kb.join(" | ")}`.slice(0, MAX_SHOWN) });
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) diffJson(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) diffJson(a[k], b[k], `${path}.${k}`, out);
    return;
  }
  const show = (v) => (v === undefined ? null : JSON.stringify(v).slice(0, MAX_SHOWN));
  out.push({ selector: path, before: show(a), after: show(b) });
}

const asList = (x, route) => {
  if (x == null) return [];
  if (typeof x === "string") return [{ route: route ?? "/", status: 200, contentType: "text/html", body: x }];
  if (Array.isArray(x)) return x;
  return [x];
};

const isJson = (c) => /json/i.test(String(c?.contentType ?? ""));
const parseJsonBody = (body) => {
  try {
    return { ok: true, value: JSON.parse(String(body ?? "")) };
  } catch {
    return { ok: false, value: String(body ?? "") };
  }
};

function prepared(cap) {
  if (isJson(cap)) return { json: parseJsonBody(cap.body) };
  const { tree, experiments } = normalizeTree(cap.body, { origin: cap.origin ?? null });
  return { tree, experiments };
}

/**
 * Compare two captures (or lists of them, matched by route).
 * Returns { same, differences: [{ route, selector, before, after }], allowedApplied, compared }.
 */
export function compare(before, after, { allowed = [], route = null, maxPerRoute = 40 } = {}) {
  const A = asList(before, route);
  const B = asList(after, route);
  const byRoute = (list) => new Map(list.map((c) => [String(c.route ?? route ?? "/"), c]));
  const mapA = byRoute(A);
  const mapB = byRoute(B);
  const routes = [...new Set([...mapA.keys(), ...mapB.keys()])];
  const differences = [];
  const allowedApplied = [];
  let compared = 0;
  for (const r of routes) {
    const a = mapA.get(r);
    const b = mapB.get(r);
    if (!a || !b) {
      differences.push({ route: r, selector: "(page)", before: a ? "captured" : "not captured", after: b ? "captured" : "not captured" });
      continue;
    }
    compared++;
    const out = [];
    if (Number(a.status) !== Number(b.status)) out.push({ selector: "(status)", before: String(a.status), after: String(b.status) });
    const la = a.location ?? null;
    const lb = b.location ?? null;
    if (la !== lb) out.push({ selector: "(redirect)", before: la, after: lb });
    if (isJson(a) !== isJson(b)) out.push({ selector: "(content type)", before: String(a.contentType ?? ""), after: String(b.contentType ?? "") });
    else if (isJson(a)) {
      const ja = prepared(a).json;
      const jb = prepared(b).json;
      if (!ja.ok || !jb.ok) {
        if (ja.value !== jb.value || ja.ok !== jb.ok) out.push({ selector: "$", before: String(ja.ok ? JSON.stringify(ja.value) : ja.value).slice(0, MAX_SHOWN), after: String(jb.ok ? JSON.stringify(jb.value) : jb.value).slice(0, MAX_SHOWN) });
      } else diffJson(ja.value, jb.value, "$", out);
    } else {
      const pa = prepared(a);
      const pb = prepared(b);
      const ctx = { route: r, before: { experiments: pa.experiments }, after: { experiments: pb.experiments } };
      // an entry is reported as used on this page only when it removed a
      // difference (fewer differences with it than without it)
      const count = () => {
        const o = [];
        diffChildren(pa.tree, pb.tree, "", o);
        return o.length;
      };
      for (const entry of allowed) {
        if (typeof entry?.apply !== "function") continue;
        const differed = serializeChildren(pa.tree) !== serializeChildren(pb.tree);
        const was = differed ? count() : 0;
        pa.tree = entry.apply(pa.tree, { ...ctx, side: "before" }) ?? pa.tree;
        pb.tree = entry.apply(pb.tree, { ...ctx, side: "after" }) ?? pb.tree;
        clearSigs(pa.tree);
        clearSigs(pb.tree);
        if (differed && count() < was) allowedApplied.push({ route: r, id: entry.id });
      }
      diffChildren(pa.tree, pb.tree, "", out);
    }
    const shownOut = out.slice(0, maxPerRoute);
    for (const d of shownOut) differences.push({ route: r, selector: d.selector || "(page)", before: d.before ?? null, after: d.after ?? null });
    if (out.length > maxPerRoute) differences.push({ route: r, selector: "(more)", before: null, after: `${out.length - maxPerRoute} more differences on this page` });
  }
  return { same: differences.length === 0, differences, allowedApplied, compared };
}

// ---------- tree helpers for allowed differences ----------

/** Walk every element (depth first); fn(node) may change it in place. */
export function eachElement(tree, fn) {
  const walk = (n) => {
    if (!isEl(n)) return;
    fn(n);
    for (const c of n.children) walk(c);
  };
  walk(tree);
  return tree;
}
export const attrOf = attr;

// ---------- the route list ----------
//
// The canaries (the spec's fixed route list) plus every product and
// collection with old content (lib/migrate/check.js entityIdsOf: the old
// tables, the live release's frozen arrays, the template exceptions). Read
// inside the tenant's context; SELECTs only.

const PREFIX = { page: "/policies/", campaign: "/campaigns/", journal: "/journal/" };

function pageName(path) {
  return (
    path
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 120) || "home"
  );
}

const jsonList = (v) => {
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(v ?? "null");
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
};

/**
 * -> { routes: [{ name, path, kind, why }] } for the store in context.
 * `mapped` is mapTenant()'s answer (lib/migrate/map.js).
 */
export async function renderRoutesFor(mapped, { db = null } = {}) {
  const { entityIdsOf } = await import("./check.js");
  const client = db ?? (await import("../db.js")).libsql;
  const select = async (sql, args) => {
    try {
      return (await client.execute({ sql, args })).rows;
    } catch {
      return [];
    }
  };
  const lookup = async (table, ids) => {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      if (!part.length) continue;
      for (const row of await select(`SELECT id, handle, title FROM ${table} WHERE id IN (${part.map(() => "?").join(", ")})`, part)) out.set(String(row.id), { handle: String(row.handle), title: row.title == null ? "" : String(row.title) });
    }
    return out;
  };

  const { products, collections } = entityIdsOf(mapped);
  const productInfo = await lookup("products", products);
  const collectionInfo = await lookup("collections", collections);

  const routes = [];
  const seen = new Set();
  const add = (path, kind, why) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    let name = pageName(path);
    while (routes.some((r) => r.name === name)) name += "_";
    routes.push({ name, path, kind, why });
  };

  // the canaries
  add("/", "canary", "home");
  const source = mapped?.source ?? {};
  const live = source?.state?.live?.state === "live" ? source.state.live.release?.content : null;
  const pages = Array.isArray(live?.pages) ? live.pages : Array.isArray(source?.raw?.cms_pages) ? source.raw.cms_pages : [];
  const shown = pages.filter((p) => p && typeof p.slug === "string" && p.enabled !== false && p.enabled !== 0 && p.enabled !== "0");
  const first = (family) => shown.filter((p) => (p.family ?? "page") === family).map((p) => p.slug).sort()[0];
  if (first("page")) add(`${PREFIX.page}${first("page")}`, "canary", "a page");
  if (first("journal")) add(`${PREFIX.journal}${first("journal")}`, "canary", "a journal post");
  add("/journal", "canary", "the journal list");
  if (first("campaign")) add(`${PREFIX.campaign}${first("campaign")}`, "canary", "a campaign");
  const redirects = Array.isArray(live?.redirects) ? live.redirects : Array.isArray(source?.raw?.page_redirects) ? source.raw.page_redirects : [];
  const familyOf = new Map(pages.filter((p) => p && typeof p.slug === "string").map((p) => [p.slug, p.family ?? "page"]));
  const r0 = [...redirects].filter((r) => r && typeof r.from_slug === "string").sort((x, y) => (x.from_slug < y.from_slug ? -1 : 1))[0];
  if (r0) add(`${PREFIX[familyOf.get(String(r0.to_slug)) ?? "page"] ?? "/policies/"}${r0.from_slug}`, "canary", "an old address that moved");

  // the product with the most kinds of content (modules, pairs, template)
  const rows = Array.isArray(mapped?.liveRows?.product) ? mapped.liveRows.product : [];
  const score = (r) => (jsonList(r.modules).length ? 1 : 0) + (jsonList(r.pairs).length ? 1 : 0) + (r.layout_template ? 1 : 0) + (r.badge ? 0.5 : 0);
  const bestProduct = rows
    .filter((r) => productInfo.has(r.product_id))
    .sort((x, y) => score(y) - score(x) || (x.product_id < y.product_id ? -1 : 1))[0];
  if (bestProduct) add(`/products/${productInfo.get(bestProduct.product_id).handle}`, "canary", "a product with modules, pairs or a template");
  const crow = Array.isArray(mapped?.liveRows?.collection) ? mapped.liveRows.collection : [];
  const bestCollection = crow
    .filter((r) => collectionInfo.has(r.collection_id))
    .sort((x, y) => jsonList(y.pinned).length - jsonList(x.pinned).length || (x.collection_id < y.collection_id ? -1 : 1))[0];
  if (bestCollection) add(`/collections/${collectionInfo.get(bestCollection.collection_id).handle}`, "canary", "a collection with pinned products");
  add("/collections", "canary", "the collections list");
  add("/checkout", "canary", "the cart (empty: no cart cookie is sent)");
  add("/api/upsell", "canary", "the cart offer the cart drawer shows");
  const word = (bestProduct ? productInfo.get(bestProduct.product_id).title : "").split(/\s+/).find((w) => /^[A-Za-z]{3,}$/.test(w));
  add(`/search?q=${encodeURIComponent((word || "a").toLowerCase())}`, "canary", "search");

  // every product and collection with old content
  for (const id of products) if (productInfo.has(id)) add(`/products/${productInfo.get(id).handle}`, "product", "has old content");
  for (const id of collections) if (collectionInfo.has(id)) add(`/collections/${collectionInfo.get(id).handle}`, "collection", "has old content");
  return { routes };
}
