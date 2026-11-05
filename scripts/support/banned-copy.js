// P6-FIXTURE: the banned-copy rules, shared by scripts/test-copy.js (its source
// scan, unchanged) and phase 6's suites, plus a CLAIMS lexicon for generated or
// founder-facing text. A helper, not a suite: nothing here runs on import.
//
//   BANNED      the shopper-copy rules test-copy scans every storefront file
//               with ({ label, re, only?, literalsOnly?, visibleOnly? }).
//   SHOPPER_UI  the file test behind the rules that apply to shopper UI only.
//   CLAIMS      claims no generated text may make for a founder: reviews,
//               ratings, certifications, awards, guarantees, rankings, health or
//               lab wording ({ label, re }). Not part of test-copy's source scan.
//   scanText(text, { shopper = false, claims = true } = {}) -> [{ rule, match }]
//               one entry per rule that matches the text. Reads every BANNED
//               rule with no file limit, and every CLAIMS rule. { shopper: true }
//               adds the rules limited to shopper UI files (vendor names,
//               localhost, test mode), for text a shopper will see; founder copy
//               may name Storeasy or Shopify, so those stay off by default.
//               { claims: false } leaves CLAIMS out, for founder-facing words
//               that may say "review" as a verb ("Read it and review it").

import { sectionType, documentType } from "../../lib/registry/index.js";

// `only` limits a rule to some files. `literalsOnly` reads just the parser's
// literal text, so window.Razorpay and comments can't trip it. `visibleOnly` reads
// less than that (see visibleStrings), so method: "razorpay" can't trip it either.
export const SHOPPER_UI = (file) => /^(app\/\(storefront\)|components)\//.test(file);
export const BANNED = [
  // Known leaks named by the spec
  { label: "gym voice: dropped the weights", re: /dropped the weights/i },
  { label: "developer: catalog sync footer", re: /catalog synced from/i },
  { label: "developer: live Shopify store", re: /live shopify store/i },
  { label: "gym voice: ludicrous speed", re: /ludicrous/i },
  { label: "developer: pnpm command", re: /\bpnpm\b/i },
  { label: "gym voice: gains", re: /\bgains\b/i },
  // Found by the GEN-03 sweep
  { label: "developer: catalog not synced", re: /catalog not synced/i },
  { label: "developer: connect Shopify account", re: /shopify account/i },
  { label: "developer: storefront ready", re: /storefront ready/i },
  { label: "developer: npm command", re: /\bnpm (run|install)\b/i },
  { label: "developer: yarn command", re: /\byarn (run|install|add|sync|migrate|build|dev)\b/i },
  { label: "developer: npx command", re: /\bnpx \S/i },
  { label: "developer: bun command", re: /\bbun (run|install|add|sync|migrate|build|dev)\b/i },
  { label: "developer: localhost", re: /\blocalhost\b/i, only: SHOPPER_UI, literalsOnly: true },
  { label: "developer: node script", re: /\bnode scripts\//i },
  { label: "developer: sync script", re: /\bsync script\b/i },
  { label: "developer: connect Shopify", re: /\bconnect shopify\b/i },
  { label: "developer: setup note", re: /light up automatically/i },
  { label: "developer: no store configured", re: /no store is configured/i },
  { label: "developer: env file", re: /\.env\.local/i },
  { label: "developer: env instruction", re: /set NEXT_PUBLIC_/i },
  { label: "developer: test mode", re: /\(test mode\)/i },
  { label: "developer: HTTP status in copy", re: /\(HTTP \$\{/ },
  { label: "developer: status code in copy", re: /\(\$\{[\w.]*status\}\)/, only: SHOPPER_UI },
  { label: "developer: automation rule name", re: /automated rule/i },
  { label: "platform: by the platform", re: /by the platform/i },
  { label: "platform: Razorpay in copy", re: /(via Razorpay|load Razorpay|Razorpay is not configured|"Razorpay"\})/ },
  { label: "platform: vendor name in visible text", re: /\b(Razorpay|Shopify|Storeasy)\b/, only: SHOPPER_UI, literalsOnly: true },
  { label: "platform: hosting vendor in visible text", re: /\b(Vercel|Turso)\b/i, only: SHOPPER_UI, literalsOnly: true },
  { label: "platform: vendor name, any case, in visible text", re: /\b(razorpay|shopify|storeasy)\b/i, only: SHOPPER_UI, literalsOnly: true, visibleOnly: true },
  { label: "developer: env or key name in text", re: /NEXT_PUBLIC_|[A-Z]+_DB_URL|_API_KEY|\.env\b/, only: SHOPPER_UI, literalsOnly: true },
  { label: "developer: test mode, any wording", re: /test mode/i, only: SHOPPER_UI, literalsOnly: true },
  { label: "wrong brand: BeastLife", re: /beastlife/i },
  { label: "wrong brand: Beast", re: /\bbeast\b/i },
  { label: "wrong brand: coupon code", re: /\b(BEAST10|FLAT200|SOLO25)\b/ },
  { label: "wrong voice: fresh drops", re: /fresh drops/i },
  { label: "wrong voice: old hero promise", re: /live offers and fast checkout/i },
  { label: "wrong vertical: nutrition word", re: /\b(whey|pre-workouts?|proteins?|creatine)\b/i },
  { label: "unset promise: delivery or refund days", re: /\d+\s*[–-]\s*\d+ (business|working) days/i },
  { label: "unset promise: tax claim", re: /incl\. GST/i },
  { label: "unset promise: review time", re: /within a working day/i },
  { label: "unset promise: returns", re: /stays returnable/i },
];

// Each label starts with "claim:", so a hit says which list it came from.
export const CLAIMS = [
  { label: "claim: reviews", re: /\breviews?\b/i },
  { label: "claim: rated", re: /\brated\b/i },
  // P6-GEN: a rating, not the word: "5 stars", "4.5-star", "five-star", "star
  // rating". A lone "stars" is often a product's own name ("Night stars candle").
  { label: "claim: stars", re: /\b\d+(\.\d+)?\s?(\/\s?\d+\s?)?[- ]?stars?\b|\b(one|two|three|four|five)[- ]stars?\b|\bstar[- ]?rat(ed|ings?)\b/i },
  { label: "claim: certified", re: /\bcertified\b/i },
  { label: "claim: award", re: /\baward(s|ed|-winning)?\b/i },
  { label: "claim: clinically", re: /\bclinically\b/i },
  { label: "claim: guaranteed", re: /\bguaranteed\b/i },
  { label: "claim: best-selling", re: /\bbest[- ]?sell(ing|ers?)\b/i },
  // P6-GEN, P6-FIX1: never a hex colour ("#1a2b3c", "#1e3a8a", "#1ab", "#1a2b3c4d":
  // a 3, 4, 6 or 8 digit token), but "#1Best", "#1Brand" and "#1 brand" are
  // claims: after "#1", only a digit ("#10 pack") or a whole hex colour token
  // is let through
  { label: "claim: #1", re: /#1(?![0-9])(?!(?:[0-9a-f]{7}|[0-9a-f]{5}|[0-9a-f]{2,3})(?![0-9a-z_]))|#\s1\b|\bno\.\s?1\b|\bnumber one\b/i },
  { label: "claim: organic", re: /\borganic\b/i },
  { label: "claim: dermatologist", re: /\bdermatologi(st|sts|cally|cal)\b/i },
  { label: "claim: lab-tested", re: /\blab[- ]tested\b/i },
  { label: "claim: money-back", re: /\bmoney[- ]back\b/i },
];

export function scanText(text, { shopper = false, claims = true } = {}) {
  const s = String(text ?? "");
  const out = [];
  for (const rule of [...BANNED.filter((r) => !r.only || shopper), ...(claims ? CLAIMS : [])]) {
    const m = rule.re.exec(s);
    if (m) out.push({ rule: rule.label, match: m[0] });
  }
  return out;
}

// ---- P6-GEN: the words a generated document shows -----------------------------------------
//
// documentTexts(body) -> [{ path, text }]
//   Only the text a shopper reads: settings whose registry kind is text,
//   rich_text or paragraphs, a button's label, an image's alt. Never tokens
//   (a brand's colours, a theme), ids, handles, links or numbers, so a hex
//   colour or a section id can't trip a rule.
// scanDocumentText(body, { catalogWords = [], shopper = true }) -> [{ path, rule, match }]
//   scanText over documentTexts(body), with the founder's own catalog words
//   (product and collection titles, image alt text from Shopify) blanked out
//   first: the store's catalog is the founder's, and a product called "Night
//   stars candle" makes no claim. What is left is the generator's own words.

const TEXT_KINDS = new Set(["text", "rich_text", "paragraphs"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function settingTexts(decls, settings, at, out) {
  if (!isObj(settings)) return;
  for (const d of decls || []) {
    const v = settings[d.key];
    const path = `${at}.${d.key}`;
    if (v == null) continue;
    if (TEXT_KINDS.has(d.kind)) {
      if (typeof v === "string") out.push({ path, text: v });
      else if (Array.isArray(v)) v.forEach((p, i) => typeof p === "string" && out.push({ path: `${path}.${i}`, text: p }));
    } else if (d.kind === "cta" && isObj(v) && typeof v.label === "string") out.push({ path: `${path}.label`, text: v.label });
    else if ((d.kind === "image" || d.kind === "logo") && isObj(v) && typeof v.alt === "string") out.push({ path: `${path}.alt`, text: v.alt });
  }
}

export function documentTexts(body) {
  const out = [];
  if (!isObj(body)) return out;
  const t = documentType(body.type);
  if (t) settingTexts(t.settings, body.settings, "settings", out);
  if (Array.isArray(body.sections)) {
    body.sections.forEach((sec, i) => {
      const d = isObj(sec) ? sectionType(sec.kind) : null;
      if (d) settingTexts(d.settings, sec.settings, `sections.${i}.settings`, out);
    });
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scanDocumentText(body, { catalogWords = [], shopper = true } = {}) {
  const words = [...new Set(catalogWords.filter((w) => typeof w === "string" && w.trim()))].sort((a, b) => b.length - a.length);
  const blank = words.length ? new RegExp(words.map(escapeRe).join("|"), "gi") : null;
  const hits = [];
  for (const { path, text } of documentTexts(body)) {
    const own = blank ? text.replace(blank, " ") : text;
    for (const h of scanText(own, { shopper })) hits.push({ path, ...h });
  }
  return hits;
}
