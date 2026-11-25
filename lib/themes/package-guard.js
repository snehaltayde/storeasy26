// Phase 5 line 1: the refusal scanner for uploaded theme packages
// (docs/plans/phase-5.md "Refusals"). Pure and Edge-safe. It runs before any
// other check: a deep walk over every key and every string of the parsed
// package, each normalised first (HTML entities decoded, NFKC, whitespace,
// control and zero-width characters stripped, case folded), then matched
// against REFUSALS. Refusal, not sanitising: nothing is rewritten here.
//   scanPackage(value) -> [{ code, path, message }]  (at most LIMITS.issues)
import { EVENT_KEY_MESSAGE, EVENT_KEY_RE, FORBIDDEN_KEYS, LIMITS, MESSAGES, REFUSALS, dataOnlyMessage } from "./package-format.js";

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", bsol: "\\", lpar: "(", rpar: ")", period: ".", comma: ",", semi: ";",
  equals: "=", num: "#", commat: "@", excl: "!", tab: "\t", newline: "\n", nbsp: " ", lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", lcub: "{", rcub: "}",
  lbrace: "{", rbrace: "}", ast: "*", plus: "+", dollar: "$", percnt: "%", hyphen: "-", dash: "-", grave: "`", quest: "?", verbar: "|", vert: "|", shy: "", zwj: "", zwnj: "",
};
const ENTITY_RE = /&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z][a-z0-9]{1,31}));?/gi;
const codePoint = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "");

/** Decode named, decimal and hex entities until nothing changes (double encoding, &amp;#106;). */
export function decodeEntities(s) {
  let out = String(s);
  for (let i = 0; i < 5; i++) {
    const next = out.replace(ENTITY_RE, (m, hex, dec, name) => {
      if (hex) return codePoint(parseInt(hex, 16));
      if (dec) return codePoint(parseInt(dec, 10));
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED, key) ? NAMED[key] : m;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

// C0/C1 controls, soft hyphen, zero-width and bidi marks, BOM (escapes kept as text, so the source stays readable); whitespace on its own
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const SPACE = /\s+/g;

/** The forms a string is matched in: everything invisible stripped, and (so
 *  "<p onclick=" still shows its attribute boundary) whitespace as one space. */
export function normalisedForms(s) {
  const decoded = decodeEntities(s).normalize("NFKC").toLowerCase();
  const stripped = decoded.replace(SPACE, "").replace(HIDDEN, "");
  const spaced = decoded.replace(SPACE, " ").replace(HIDDEN, "");
  return stripped === spaced ? [stripped] : [stripped, spaced];
}

const FORBIDDEN = new Set(FORBIDDEN_KEYS);
const isContainer = (v) => v !== null && typeof v === "object";
const keyPath = (path, key) => (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key.slice(0, 40))}]`);

// A registry link field inside a home section (…settings.<x>.link.href or a
// link-kind setting's href): the only place an outside address may appear.
const LINK_HREF_RE = /^templates\.home\.sections\[\d+\]\.settings\.(?:[A-Za-z0-9_]+(?:\[\d+\])?\.)*(?:link\.)?href$/;

function stringIssue(value, path, { key = false } = {}) {
  const forms = normalisedForms(value);
  for (const r of REFUSALS) {
    if (r.id === "external" && !key && LINK_HREF_RE.test(path)) continue;
    if (forms.some((f) => r.re.test(f))) return { code: r.id, path, message: r.message };
  }
  return null;
}

function keyIssue(key, path, declared) {
  const forms = normalisedForms(key);
  if ((forms.some((f) => FORBIDDEN.has(f)) || FORBIDDEN.has(key.toLowerCase())) && !declared) return { code: "data-only", path, message: dataOnlyMessage(key.slice(0, 40)) };
  if (EVENT_KEY_RE.test(key) || forms.some((f) => EVENT_KEY_RE.test(f))) return { code: "handler", path, message: EVENT_KEY_MESSAGE };
  return stringIssue(key, path, { key: true });
}

/** Every refusal in a parsed package, each with its place; [] when it is clean.
 *  declaredKey(path, key): true for a registry setting a home section's kind
 *  declares (rich_text's "html"): its name is the registry's, not the
 *  package's, so only a data-only key name is let through; its value is still
 *  scanned like every other string, and an event-handler key never passes. */
export function scanPackage(root, { declaredKey = () => false } = {}) {
  const issues = [];
  let nodes = 0;
  let deep = false;
  let tooMany = false;
  const add = (issue) => {
    if (issue && issues.length < LIMITS.issues) issues.push(issue);
  };
  const walk = (value, path, depth) => {
    if (tooMany) return;
    if (++nodes > LIMITS.nodes) {
      tooMany = true;
      return;
    }
    if (typeof value === "string") return add(stringIssue(value, path));
    if (!isContainer(value)) return;
    if (depth > LIMITS.depth) {
      deep = true;
      return;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(value)) {
      if (++nodes > LIMITS.nodes) {
        tooMany = true;
        return;
      }
      const at = keyPath(path, key);
      const bad = keyIssue(key, at, declaredKey(path, key));
      add(bad);
      if (!bad) walk(value[key], at, depth + 1);
    }
  };
  walk(root, "", 1);
  if (deep) issues.unshift({ code: "depth", path: "", message: MESSAGES.tooDeep });
  if (tooMany) issues.unshift({ code: "nodes", path: "", message: MESSAGES.tooManyNodes });
  return issues.slice(0, LIMITS.issues);
}

/** "<plain words> (at <path>)", as the upload answer and the console show it. */
export const issueText = (issue) => (issue.path ? `${issue.message} (at ${issue.path})` : issue.message);
