// The colour pairs a storefront source draws (P1-CONTRAST), for the pair
// coverage test in scripts/test-tokens.js. Plain node, no parser dependency.
//
// A pair is a text role (text-sf-*, text-header-fg, …) drawn over a
// background role (bg-sf-*, bg-header, bg-hero). It is found two ways:
//   on one element   both classes can apply at once: in the same string, or
//                    one in a template literal's fixed text and the other in
//                    one of its ${…} branches, or one in the fixed text of a
//                    className and the other in a same-file constant it
//                    calls (const activeCls = (i) => …);
//   nested           an element that sets a text role, or holds text of its
//                    own, inside an element (in the same file) that sets a
//                    background role.
// Variants count as the state they name: hover:, focus:, active: and
// group-hover: backgrounds are backgrounds the text sits on. disabled: and
// placeholder: classes are left out (the disabled and placeholder pairs are
// listed by hand). Branches of a ternary are never paired with each other.
// What this cannot see: a component's background from the file that renders
// it, and classes built at run time from data. Those are the browser drills'
// job (scripts/drills/p1c/tokc.mjs measures every pair on the page).

const KIT_TEXT = { "header-fg": "header-fg", "header-muted": "header-muted", "hero-fg": "hero-fg", "hero-muted": "hero-muted" };
const KIT_BG = { header: "header", hero: "hero" };
const SKIP_VARIANTS = /^(disabled|placeholder|file|selection|marker|aria-disabled)$/;

// One class token → { kind: "text" | "bg", role } or null.
export function classRole(token, roleIds) {
  const parts = token.replace(/^!|!$/g, "").split(":");
  const cls = parts.pop().replace(/\/(\d+|\[[^\]]+\])$/, "");
  if (parts.some((v) => SKIP_VARIANTS.test(v))) return null;
  let m = /^text-sf-([a-z0-9-]+)$/.exec(cls);
  if (m && roleIds.includes(m[1])) return { kind: "text", role: m[1] };
  m = /^text-(header-fg|header-muted|hero-fg|hero-muted)$/.exec(cls);
  if (m) return { kind: "text", role: KIT_TEXT[m[1]] };
  m = /^bg-sf-([a-z0-9-]+)$/.exec(cls);
  if (m && roleIds.includes(m[1])) return { kind: "bg", role: m[1] };
  m = /^bg-(header|hero)$/.exec(cls);
  if (m) return { kind: "bg", role: KIT_BG[m[1]] };
  return null;
}

function rolesIn(strings, roleIds) {
  const text = new Set();
  const bg = new Set();
  for (const s of strings)
    for (const tok of s.split(/\s+/)) {
      if (!tok) continue;
      const r = classRole(tok, roleIds);
      if (r) (r.kind === "text" ? text : bg).add(r.role);
    }
  return { text, bg };
}

// Skip a string, template or comment starting at i; returns the index after it.
function skipToken(src, i) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const e = src.indexOf("\n", i);
    return e < 0 ? src.length : e;
  }
  if (c === "/" && src[i + 1] === "*") {
    const e = src.indexOf("*/", i + 2);
    return e < 0 ? src.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (j < src.length && src[j] !== "`") {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === "$" && src[j + 1] === "{") {
        j = matchBrace(src, j + 1) + 1;
        continue;
      }
      j++;
    }
    return j + 1;
  }
  return i;
}

// src[i] is "{": the index of its matching "}".
function matchBrace(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; ) {
    const k = skipToken(src, j);
    if (k !== j) {
      j = k;
      continue;
    }
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return j;
    j++;
  }
  return src.length;
}

// The class "groups" of one className expression: each group is a list of
// strings that can apply together.
function classGroups(expr, consts) {
  const t = expr.trim();
  if (/^["']/.test(t)) return [[t.slice(1, -1)]];
  if (!t.startsWith("{")) return [];
  const inner = t.slice(1, -1).trim();
  // one alternative's strings; a same-file constant it names adds one more
  // alternative per string the constant holds (its keys are exclusive)
  const alternativesOf = (code) => {
    const refs = [];
    const lits = literalsOf(code, refs);
    const constLits = refs.flatMap((id) => consts.get(id));
    return constLits.length ? constLits.map((c) => lits.concat([c])) : [lits];
  };
  const literalsOf = (code, refs = []) => {
    const out = [];
    for (let j = 0; j < code.length; ) {
      const c = code[j];
      if (c === '"' || c === "'" || c === "`") {
        const e = skipToken(code, j);
        out.push(...(c === "`" ? templateParts(code.slice(j, e)).fixed.concat(templateParts(code.slice(j, e)).branches.flatMap((b) => literalsOf(b, refs))) : [code.slice(j + 1, e - 1)]));
        j = e;
        continue;
      }
      const k = skipToken(code, j);
      if (k !== j) {
        j = k;
        continue;
      }
      const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(j));
      if (id) {
        if (consts.has(id[0]) && (j === 0 || !/[\w$.]/.test(code[j - 1]))) refs.push(id[0]);
        j += id[0].length;
        continue;
      }
      j++;
    }
    return out;
  };
  if (inner.startsWith("`") && skipToken(inner, 0) === inner.length) {
    const { fixed, branches } = templateParts(inner);
    const options = branches.flatMap((b) => splitOptions(b).flatMap(alternativesOf));
    return options.length ? options.map((o) => fixed.concat(o)).concat([fixed]) : [fixed];
  }
  return splitOptions(inner).flatMap(alternativesOf);
}

// A template literal's fixed text and its ${…} expressions.
function templateParts(tpl) {
  const fixed = [];
  const branches = [];
  let s = "";
  for (let j = 1; j < tpl.length - 1; ) {
    if (tpl[j] === "\\") {
      s += tpl[j + 1];
      j += 2;
      continue;
    }
    if (tpl[j] === "$" && tpl[j + 1] === "{") {
      const e = matchBrace(tpl, j + 1);
      branches.push(tpl.slice(j + 2, e));
      fixed.push(s);
      s = "";
      j = e + 1;
      continue;
    }
    s += tpl[j++];
  }
  fixed.push(s);
  return { fixed, branches };
}

// The alternatives of an expression: the branches of top-level ternaries and
// of && / || (each literal is its own alternative). Everything else is one.
function splitOptions(code) {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let j = 0; j < code.length; ) {
    const k = skipToken(code, j);
    if (k !== j) {
      j = k;
      continue;
    }
    const c = code[j];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && (c === "?" || c === ":") && code[j + 1] !== "." && code[j + 1] !== "?") {
      parts.push(code.slice(last, j));
      last = j + 1;
    } else if (depth === 0 && ((c === "&" && code[j + 1] === "&") || (c === "|" && code[j + 1] === "|"))) {
      parts.push(code.slice(last, j));
      last = j + 2;
      j += 2;
      continue;
    }
    j++;
  }
  parts.push(code.slice(last));
  return parts.filter((p) => p.trim());
}

// Same-file constants holding class strings: `const name = …;` up to the end
// of its statement. Their literals join a className that names them.
function constantsOf(src, roleIds) {
  const out = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    let j = m.index + m[0].length;
    let depth = 0;
    const start = j;
    for (; j < src.length; ) {
      const k = skipToken(src, j);
      if (k !== j) {
        j = k;
        continue;
      }
      const c = src[j];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if ((c === ";" || c === "\n") && depth === 0) break;
      j++;
    }
    const body = src.slice(start, j);
    const lits = [];
    for (let i = 0; i < body.length; ) {
      const c = body[i];
      if (c === '"' || c === "'" || c === "`") {
        const e = skipToken(body, i);
        lits.push(c === "`" ? templateParts(body.slice(i, e)).fixed.join(" ") : body.slice(i + 1, e - 1));
        i = e;
        continue;
      }
      i++;
    }
    const { text, bg } = rolesIn(lits, roleIds);
    if (text.size || bg.size) out.set(m[1], lits);
  }
  return out;
}

// Every JSX element in a source, in order: { tag, close, selfClosing,
// className, hasOwnText, at }.
function jsxTags(src) {
  const out = [];
  // the source with comments blanked, to read what comes before a "<"
  let bare = "";
  for (let i = 0; i < src.length; ) {
    const k = skipToken(src, i);
    if (k !== i && src[i] === "/") bare += src.slice(i, k).replace(/[^\n]/g, " ");
    else if (k !== i) bare += src.slice(i, k);
    else bare += src[i];
    i = k !== i ? k : i + 1;
  }
  for (let i = 0; i < src.length; ) {
    const k = skipToken(src, i);
    if (k !== i) {
      i = k;
      continue;
    }
    if (src[i] !== "<") {
      i++;
      continue;
    }
    const before = bare.slice(0, i).replace(/\s+$/, "").slice(-12);
    const m = /^<(\/?)([A-Za-z][\w.]*)?/.exec(src.slice(i, i + 80));
    const opener = /(^|[(,?:{}>&|=;]|return|\?\?)$/.test(before) || before === "";
    if (!m || (!m[1] && !opener && !/>$/.test(before)) || (!m[2] && src[i + 1] !== ">" && !m[1])) {
      i++;
      continue;
    }
    // walk the attributes to the tag's end
    let j = i + m[0].length;
    let className = null;
    for (; j < src.length && src[j] !== ">"; ) {
      if (src.startsWith("className=", j)) {
        const v = j + "className=".length;
        const e = src[v] === "{" ? matchBrace(src, v) + 1 : skipToken(src, v);
        className = src.slice(v, e);
        j = e;
        continue;
      }
      if (src[j] === "{") {
        j = matchBrace(src, j) + 1;
        continue;
      }
      const k2 = skipToken(src, j);
      if (k2 !== j && (src[j] === '"' || src[j] === "'")) {
        j = k2;
        continue;
      }
      j++;
    }
    const selfClosing = src[j - 1] === "/";
    const after = src.slice(j + 1, j + 400);
    // words before its first child tag, or a {value} child that holds no JSX
    const ownText = /^[^<{]*[A-Za-z0-9?×+→←·/&—–-]/.test(after) || /^\s*\{\s*(?!\/\*)[^}<]*\}/.test(after);
    out.push({ tag: m[2] || "", close: m[1] === "/", selfClosing, className, hasOwnText: !selfClosing && ownText, at: i });
    i = j + 1;
  }
  return out;
}

const lineOf = (src, at) => src.slice(0, at).split("\n").length;

// Every pair drawn in one source: [{ fg, bg, line, how }].
export function drawnPairs(src, roleIds) {
  const consts = constantsOf(src, roleIds);
  const pairs = [];
  const stack = []; // { tag, bg: Set, text: Set }
  for (const el of jsxTags(src)) {
    if (el.close) {
      const idx = stack.map((s) => s.tag).lastIndexOf(el.tag);
      if (idx >= 0) stack.length = idx;
      continue;
    }
    const groups = el.className ? classGroups(el.className, consts) : [];
    const own = groups.map((g) => rolesIn(g, roleIds));
    const ownBg = new Set(own.flatMap((g) => [...g.bg]));
    const parentBg = [...stack].reverse().find((s) => s.bg.size)?.bg || new Set();
    const parentText = [...stack].reverse().find((s) => s.text.size)?.text || new Set();
    const line = lineOf(src, el.at);
    for (const g of own) {
      // on one element
      for (const fg of g.text) for (const bg of g.bg) pairs.push({ fg, bg, line, how: "same element" });
      // its text on the nearest background around it (when it sets none)
      if (!g.bg.size) for (const fg of g.text) for (const bg of parentBg) pairs.push({ fg, bg, line, how: "nested" });
      // its own background under the text colour it inherits (when it sets none)
      if (g.bg.size && !g.text.size && el.hasOwnText) for (const fg of parentText.size ? parentText : ["foreground"]) for (const bg of g.bg) pairs.push({ fg, bg, line, how: "inherited text" });
    }
    if (!el.selfClosing) stack.push({ tag: el.tag, bg: ownBg, text: new Set(own.flatMap((g) => [...g.text])) });
  }
  const seen = new Set();
  return pairs.filter((p) => {
    const k = `${p.fg}|${p.bg}|${p.line}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}
