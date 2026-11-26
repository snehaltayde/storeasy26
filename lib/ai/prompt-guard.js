// Phase 9 line 5: zero shopper data in any prompt. Pure and Edge-safe.
//
//   scrubText(s)            catalog text with email, phone and @-handle shapes
//                           replaced, before it goes into a prompt
//   findPii(s, { forbidden }) -> [label] the shapes (and forbidden values) found
//   assertOutgoingClean(prompt, { forbidden }) -> true, or throws AI_PROMPT_REFUSED
//
// The copilot's gatherers read catalog and brand data only (titles,
// descriptions, types, tags, prices, collections, store name, voice, tokens):
// never orders, customers, addresses or search terms. A founder may still have
// typed a phone or email into a product description, so the text is scrubbed,
// and then the whole outgoing prompt is checked again: an email, an Indian or
// E.164 phone, an @-handle or an order id refuses the call. `forbidden` is a
// list of exact values that must never appear (the suite passes its seeded
// customers; runtime code reads no customers to build one).

// a full address, or a bare name@domain with no dot after it ("ravi@gmail")
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*/gi;
// a link to a social or chat profile
const SOCIAL = /\b(?:instagram\.com|instagr\.am|facebook\.com|fb\.com|wa\.me|t\.me|twitter\.com|x\.com|youtube\.com|linkedin\.com)\/[^\s"',)]+/gi;
// @name on a word boundary (an email's @ is caught above, first)
const HANDLE = /(?<![\w.])@[a-z0-9_](?:[a-z0-9_.]{1,29})/gi;
// a Storeasy order number: PREFIX- and 8 or 16 upper-case hex (lib/orders.js)
const ORDER_ID = /\b[A-Z]{2,3}-[0-9A-F]{8}(?:[0-9A-F]{8})?\b/g;

// Phones, in any grouping (review fix): runs of digit groups joined only by
// separators (space, dash, dot, brackets) are read as their digits alone, and
// any run of whole groups is a phone when its digits are
//   an Indian mobile   [6-9] + 9 digits, with an optional 91 or 0 in front
//   an Indian landline 0 + STD code + number, 10 or 11 digits in all
//   an E.164 number    "+" then 8 to 15 digits
// so "987-654-3210", "98 7654 3210", "(987) 654-3210", "98765-432-10",
// "+91-9876-543-210" and "022 2345 6789" are all caught.
const MOBILE = /^(?:91|0)?[6-9]\d{9}$/;
const LANDLINE = /^0[1-9]\d{8,9}$/;
const GAP = /^[\s\-.()]{1,3}$/;

// -> [[start, end]] of every phone in s (end exclusive)
function phoneSpans(s) {
  const groups = [...s.matchAll(/\d+/g)].map((m) => ({ at: m.index, end: m.index + m[0].length, d: m[0] }));
  const spans = [];
  let i = 0;
  while (i < groups.length) {
    let best = -1;
    let digits = "";
    for (let j = i; j < groups.length; j++) {
      if (j > i && !GAP.test(s.slice(groups[j - 1].end, groups[j].at))) break;
      digits += groups[j].d;
      if (digits.length > 15) break;
      const plus = /\+\s?\(?$/.test(s.slice(Math.max(0, groups[i].at - 3), groups[i].at));
      if (MOBILE.test(digits) || LANDLINE.test(digits) || (plus && digits.length >= 8)) best = j;
    }
    if (best >= 0) {
      const lead = s.slice(0, groups[i].at).match(/(?:\+\s?)?\(?$/)?.[0] ?? "";
      const close = s.slice(groups[best].end).match(/^\)?/)?.[0] ?? "";
      spans.push([groups[i].at - lead.length, groups[best].end + close.length]);
      i = best + 1;
    } else i++;
  }
  return spans;
}

// fullwidth and other compatibility forms (＠, ０-９) read as their plain letters
const plain = (s) => String(s ?? "").normalize("NFKC");

export function scrubText(s) {
  let out = plain(s).replace(EMAIL, "[email removed]");
  for (const [a, b] of phoneSpans(out).reverse()) out = `${out.slice(0, a)}[phone removed]${out.slice(b)}`;
  return out.replace(SOCIAL, "[link removed]").replace(HANDLE, "[handle removed]");
}

const has = (re, s) => {
  re.lastIndex = 0;
  const hit = re.test(s);
  re.lastIndex = 0;
  return hit;
};

export function findPii(text, { forbidden = [] } = {}) {
  const s = plain(text);
  const out = [];
  if (has(EMAIL, s)) out.push("an email address");
  if (phoneSpans(s).length) out.push("a phone number");
  if (has(HANDLE, s.replace(EMAIL, "")) || has(SOCIAL, s)) out.push("a social handle");
  if (has(ORDER_ID, s)) out.push("an order number");
  const lower = s.toLowerCase();
  for (const v of forbidden) {
    const needle = String(v ?? "").trim().toLowerCase();
    if (needle.length >= 4 && lower.includes(needle)) {
      out.push("a customer's details");
      break;
    }
  }
  return out;
}

export class PromptRefusedError extends Error {
  constructor(found) {
    super(`We stopped before asking the AI: the request held ${found.join(" and ")}, and customer details never leave your store. Nothing was sent and no tokens were used.`);
    this.code = "AI_PROMPT_REFUSED";
    this.found = found;
  }
}

export function assertOutgoingClean(prompt, { forbidden = [] } = {}) {
  const found = findPii(typeof prompt === "string" ? prompt : JSON.stringify(prompt), { forbidden });
  if (found.length) throw new PromptRefusedError(found);
  return true;
}
