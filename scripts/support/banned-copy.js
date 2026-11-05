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
  { label: "claim: stars", re: /\bstars\b|\b\d+(\.\d+)?[- ]?stars?\b/i },
  { label: "claim: certified", re: /\bcertified\b/i },
  { label: "claim: award", re: /\baward(s|ed|-winning)?\b/i },
  { label: "claim: clinically", re: /\bclinically\b/i },
  { label: "claim: guaranteed", re: /\bguaranteed\b/i },
  { label: "claim: best-selling", re: /\bbest[- ]?sell(ing|ers?)\b/i },
  { label: "claim: #1", re: /#\s?1(?!\d)|\bno\.\s?1\b|\bnumber one\b/i },
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
