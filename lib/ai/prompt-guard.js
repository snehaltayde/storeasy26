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

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// +<country><number>, 8 to 15 digits, spaces or dashes allowed between digits
const E164 = /\+\d(?:[\s-]?\d){7,14}/g;
// an Indian mobile: optional +91 / 91 / 0, then 6-9 and nine more digits
const INDIAN = /(?<!\d)(?:(?:\+?91)[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
// @name on a word boundary (an email's @ is caught above, first)
const HANDLE = /(?<![\w.])@[a-z0-9_](?:[a-z0-9_.]{1,29})/gi;
// a Storeasy order number: PREFIX- and 8 or 16 upper-case hex (lib/orders.js)
const ORDER_ID = /\b[A-Z]{2,3}-[0-9A-F]{8}(?:[0-9A-F]{8})?\b/g;

export function scrubText(s) {
  return String(s ?? "")
    .replace(EMAIL, "[email removed]")
    .replace(E164, "[phone removed]")
    .replace(INDIAN, "[phone removed]")
    .replace(HANDLE, "[handle removed]");
}

const has = (re, s) => {
  re.lastIndex = 0;
  const hit = re.test(s);
  re.lastIndex = 0;
  return hit;
};

export function findPii(text, { forbidden = [] } = {}) {
  const s = String(text ?? "");
  const out = [];
  if (has(EMAIL, s)) out.push("an email address");
  if (has(E164, s) || has(INDIAN, s)) out.push("a phone number");
  if (has(HANDLE, s.replace(EMAIL, ""))) out.push("a social handle");
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
