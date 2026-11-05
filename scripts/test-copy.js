// Shopper-visible copy suite (GEN-03): no wrong-brand or developer text reaches
// shoppers. Plain Node can't import JSX on its own, so:
//   1. a scan of storefront source for banned strings, per line and through a
//      real parser (comments ignored, wrapped text joined);
//   2. real pages and components compiled with Next's SWC and rendered with
//      react-dom/server, against real tenant databases;
//   3. the shipping honesty rules (display only, charges pinned);
//   4. typing and clicking through client components with a small hook driver,
//      and real API routes called directly. No browser is involved in any layer.
// The scan proves it can fail, on planted text, inside this file.
// The full inventory and its decisions: docs/storefront-copy-inventory.md.
//   pnpm test:copy
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BANNED, CLAIMS, scanText, documentTexts, scanDocumentText } from "./support/banned-copy.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-copy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-copy-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-copy-default.db", ".test-copy-platform.db", ".test-copy-t1.db", ".test-copy-t2.db", ".test-copy-t3.db", ".test-copy-t4.db", ".test-copy-bl.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// ---- layer 1: the banned-string scan -----------------------------------------

// The rules live in scripts/support/banned-copy.js (P6-FIXTURE), shared with
// phase 6's suites; this file's scan and its checks below are unchanged.

// Each entry names one file and the exact text allowed there, with the reason.
// An entry that stops matching fails the suite, so this list can't go stale.
const ALLOWED = [
  { file: "lib/site.js", re: /\|\| "BeastLife"/, why: "reached only with no tenant context: the legacy env store IS BeastLife" },
  { file: "lib/content/pages.js", re: /./, why: "BeastLife's own pages; brandDefaultsApply() gates them (tested below)" },
  { file: "lib/offers/config.js", re: /./, why: "BeastLife's own offers; seeded only by its bootstrap (test-platform-sync)" },
  { file: "lib/themes/kits.js", re: /Proteins, pre-workouts/, why: "Pulse kit preset: applied only when a founder picks that nutrition kit and accepts its copy" },
  { file: "lib/content/templates.js", re: /\d–\d working days/, why: "console prefill a founder edits and saves; GEN-06 binds it to real settings" },
  { file: "lib/brand-tenants.js", re: /\["_default", "beastlife", "beastlife-staging"\]/, why: "tenant ids in the check that keeps BeastLife's pages on BeastLife" },
  { file: "app/(storefront)/layout.js", re: /Storeasy — fast, branded|on your existing Shopify catalog|%s · Storeasy|>Storeasy<|^Storeasy$/, why: "the platform-host branch only; a store's own address never reaches it" },
  { file: "app/(storefront)/layout.js", re: /tenantOwnCfg\("(ga4_measurement_id|meta_pixel_id)", "NEXT_PUBLIC_/, why: "the name of a setting, passed to the config lookup; never shown" },
  { file: "app/(storefront)/checkout/page.js", re: /tenantOwnCfg\("razorpay_key_id", "NEXT_PUBLIC_RAZORPAY_KEY_ID"\)/, why: "the name of a setting, passed to the config lookup; never shown" },
  { file: "components/preview/PreviewBridge.js", re: /\.storeasy-(selected|designing)/, why: "CSS class names in the founder's draft preview, not text" },
  { file: "lib/env-file.js", re: /\.env\.local/, why: "local CLI helper, not imported by any route" },
  { file: "lib/integrations.js", re: /pnpm webhooks:register/, why: "connect hint for the operator console" },
  { file: "lib/shopify-push.js", re: /paid via Razorpay/, why: "order note in Shopify admin, read by store staff; never content for shoppers" },
  { file: "lib/shopify.js", re: /\.env\.local/, why: "sync-only errors (lib/sync.js is its only importer), for operators" },
  { file: "lib/automations.js", re: /automated rule "/, why: "notify_merchant only; the email_customer branch omits it (tested below, and in test-w6)" },
];

// Marketing routes only render on the platform's own host; a tenant host gets a
// 404 (asserted below), so they may name Storeasy's vendors.
const MARKETING_ROUTES = ["customers", "integrations", "legal", "pricing", "templates", "trust", "verticals"];

const SKIP_DIRS = new Set([
  // Not shopper surfaces: consoles, operator tools, the marketing site
  "components/admin",
  "components/console",
  "components/platform",
  "components/partners",
  "components/site",
  "lib/admin",
  "lib/platform",
  "lib/ai",
  ...MARKETING_ROUTES.map((r) => `app/(storefront)/${r}`),
  // Console and machine-to-machine APIs
  ...["admin", "platform", "partners", "connect", "jobs", "shopify", "razorpay", "approve", "preview", "health", "leads"].map((d) => `app/api/${d}`),
]);

async function walk(dir, out = []) {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(rel)) await walk(rel, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

// Blank comments, keeping line numbers, for the per-line scan. A "/*" or "//" only
// opens a comment after whitespace or a bracket, so "image/*" and "https://" stay
// code. This is a guess, not a parser: it also blanks visible text that follows
// " // ", so it can scan less than the file holds. scanParsed covers that case.
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/(^|[\s{(;,])\/\*[\s\S]*?\*\//g, (m, lead) => lead + blank(m.slice(lead.length)))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + blank(m.slice(lead.length)));
}

const applies = (rule, file) => !rule.only || rule.only(file);

// Per line: gives a line number to report, and sees template and code shapes.
function scanSource(file, src) {
  const findings = [];
  const allowed = ALLOWED.filter((a) => a.file === file);
  stripComments(src)
    .split("\n")
    .forEach((text, i) => {
      for (const rule of BANNED) {
        if (rule.literalsOnly || !applies(rule, file) || !rule.re.test(text)) continue;
        if (allowed.some((a) => a.re.test(text))) continue;
        findings.push({ file, line: i + 1, label: rule.label, text: text.trim().slice(0, 120) });
      }
    });
  return findings;
}

// Every literal in the file, from the real parser, so comments are truly gone and
// text that only looks like a comment stays. JSX attributes go last, so they can't
// split a sentence.
function literalText(ast) {
  const text = [];
  const attrs = [];
  const visit = (node, out) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, out));
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportDeclaration") return;
    if (node.type === "StringLiteral" || node.type === "JSXText") return void out.push(node.value);
    if (node.type === "TemplateElement") return void out.push(node.cooked ?? node.raw);
    if (node.type === "JSXAttribute") return visit(node.value, attrs);
    for (const [k, v] of Object.entries(node)) if (k !== "span") visit(v, out);
  };
  visit(ast, text);
  return [...text, ...attrs].join(" ").replace(/\s+/g, " ");
}

// Strings a person can read, one by one: JSX text, what a JSX child or a visible
// attribute prints, and any string with a space in it (a sentence, such as one
// handed to setError). A single word outside JSX counts as code, so
// method: "razorpay", window.Razorpay and a script URL stay allowed.
const VISIBLE_ATTR = /^(alt|title|placeholder|label|aria-[\w-]+)$/;
function visibleStrings(ast) {
  const out = [];
  const printed = (n) => {
    if (!n) return;
    if (n.type === "StringLiteral") out.push(n.value);
    else if (n.type === "TemplateLiteral") n.quasis.forEach((q) => out.push(q.cooked ?? q.raw));
    else if (n.type === "JSXExpressionContainer" || n.type === "ParenthesisExpression") printed(n.expression);
    else if (n.type === "ConditionalExpression") [n.consequent, n.alternate].forEach(printed);
    else if (n.type === "BinaryExpression" && ["||", "??", "&&", "+"].includes(n.operator)) [n.left, n.right].forEach(printed);
  };
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object" || node.type === "ImportDeclaration") return;
    if (node.type === "JSXText") out.push(node.value);
    if (node.type === "JSXElement" || node.type === "JSXFragment") node.children.filter((c) => c.type === "JSXExpressionContainer").forEach(printed);
    if (node.type === "JSXAttribute" && VISIBLE_ATTR.test(node.name?.value || "")) printed(node.value);
    if (node.type === "StringLiteral" && /\s/.test(node.value.trim())) out.push(node.value);
    if (node.type === "TemplateElement" && /\s/.test((node.cooked ?? node.raw).trim())) out.push(node.cooked ?? node.raw);
    for (const [k, v] of Object.entries(node)) if (k !== "span") visit(v);
  };
  visit(ast);
  return out;
}

// Whole file, whitespace collapsed: finds text the per-line scan can't, such as a
// phrase wrapped across JSX lines. An allowance is per line, so it excuses only as
// many hits as its own lines hold.
async function scanParsed(file, src, already = []) {
  const ast = await swc.parse(src, { filename: file, isModule: true });
  const text = literalText(ast);
  const visible = visibleStrings(ast);
  const allowed = ALLOWED.filter((a) => a.file === file);
  const lines = stripComments(src).split("\n");
  const findings = [];
  for (const rule of BANNED) {
    if (!applies(rule, file) || already.some((f) => f.label === rule.label)) continue;
    if (rule.visibleOnly) {
      const hit = visible.find((s) => rule.re.test(s) && !allowed.some((a) => a.re.test(s.trim())));
      if (hit) findings.push({ file, line: "parsed", label: rule.label, text: hit.trim().slice(0, 120) });
      continue;
    }
    const all = new RegExp(rule.re.source, `${rule.re.flags}g`);
    const hits = [...text.matchAll(all)];
    if (!hits.length) continue;
    const excused = lines.filter((l) => allowed.some((a) => a.re.test(l))).reduce((n, l) => n + (l.match(all) || []).length, 0);
    if (hits.length <= excused) continue;
    const at = hits[0].index;
    findings.push({ file, line: "parsed", label: rule.label, text: text.slice(Math.max(0, at - 40), at + 80) });
  }
  return findings;
}

async function scanFile(file, src) {
  const lineFindings = scanSource(file, src);
  return [...lineFindings, ...(await scanParsed(file, src, lineFindings))];
}

const SHOPPER_SOURCES = [
  ...(await walk("app/(storefront)")),
  ...(await walk("components")),
  ...(await walk("lib")),
  ...(await walk("app/api")),
  "app/manifest.webmanifest/route.js",
  "public/sw.js",
];
const sources = new Map();
for (const f of SHOPPER_SOURCES) sources.set(f, await readFile(join(ROOT, f), "utf8"));
const report = (findings) => findings.map((x) => `${x.file}:${x.line} [${x.label}] ${x.text}`).join("\n    ");

await t(`banned strings: none in ${sources.size} storefront source files`, async () => {
  const findings = (await Promise.all([...sources].map(([f, src]) => scanFile(f, src)))).flat();
  ok(findings.length === 0, `\n    ${report(findings)}`);
});

await t("the scan covers the surfaces it claims to", () => {
  for (const f of ["app/(storefront)/page.js", "app/(storefront)/error.js", "components/Footer.js", "components/cart/CartDrawer.js", "components/checkout/CheckoutFlow.js", "lib/site.js", "lib/cms/defaults.js", "app/api/checkout/route.js", "app/api/account/route.js"]) {
    ok(sources.has(f), `${f} is not scanned`);
  }
  ok(![...sources.keys()].some((f) => f.startsWith("components/admin/")), "console files must stay out of the shopper scan");
});

await t("the scan fails: each banned rule catches planted text", async () => {
  const samples = {
    "gym voice: dropped the weights": "Something dropped the weights",
    "developer: catalog sync footer": "Catalog synced from somewhere",
    "developer: live Shopify store": "over the live Shopify store",
    "gym voice: ludicrous speed": "at ludicrous speed",
    "developer: pnpm command": "run pnpm sync",
    "gym voice: gains": "Add some gains",
    "developer: catalog not synced": "Catalog not synced yet",
    "developer: connect Shopify account": "Connect the store's Shopify account",
    "developer: storefront ready": "Storefront ready",
    "developer: npm command": "npm run build",
    "developer: yarn command": "Then run: yarn sync",
    "developer: npx command": "npx prisma migrate",
    "developer: bun command": "Run bun sync first.",
    "developer: localhost": "See localhost:3000 for setup",
    "developer: node script": "node scripts/sync.js",
    "developer: sync script": "run the sync script",
    "developer: connect Shopify": "connect Shopify first",
    "developer: setup note": "pages light up automatically",
    "developer: no store configured": "No store is configured for this address.",
    "developer: env file": "see .env.local",
    "developer: env instruction": "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable.",
    "developer: test mode": "card (test mode)",
    "developer: HTTP status in copy": "failed (HTTP ${status})",
    "developer: status code in copy": "Couldn't check this order (${res.status}).",
    "developer: automation rule name": 'automated rule "x"',
    "platform: by the platform": "paused by the platform",
    "platform: Razorpay in copy": "Secure payment via Razorpay.",
    "platform: vendor name in visible text": "Powered by Shopify",
    "platform: hosting vendor in visible text": "Hosted on Vercel, data in Turso",
    "platform: vendor name, any case, in visible text": "Couldn't reach shopify",
    "developer: env or key name in text": "Add NEXT_PUBLIC_RAZORPAY_KEY_ID to enable.",
    "developer: test mode, any wording": "Payments are in test mode",
    "wrong brand: BeastLife": "About BeastLife",
    "wrong brand: Beast": "Go Beast mode",
    "wrong brand: coupon code": "try BEAST10",
    "wrong voice: fresh drops": "Fresh drops",
    "wrong voice: old hero promise": "live offers and fast checkout",
    "wrong vertical: nutrition word": "Whey for you",
    "unset promise: delivery or refund days": "in 5–7 business days",
    "unset promise: tax claim": "prices incl. GST",
    "unset promise: review time": "We review requests within a working day.",
    "unset promise: returns": "each piece stays returnable on its own",
  };
  eq(Object.keys(samples).length, BANNED.length, "one sample per rule:");
  for (const { label } of BANNED) {
    const found = await scanFile("components/Footer.js", `export const x = "${samples[label].replace(/"/g, "'")}";`);
    ok(found.some((f) => f.label === label), `rule "${label}" missed its sample`);
  }
});

// P6-FIXTURE: scanText reads plain text (generated or founder-facing copy) with
// the same BANNED rules plus the CLAIMS lexicon.
await t("scanText: each CLAIMS rule catches its sample, 'Rated 5 stars by customers' is a claim, and plain shop copy is clean", () => {
  const samples = {
    "claim: reviews": "Read the reviews",
    "claim: rated": "Top rated",
    "claim: stars": "Rated 4.5-star",
    "claim: certified": "Certified safe",
    "claim: award": "Award-winning blend",
    "claim: clinically": "Clinically proven",
    "claim: guaranteed": "Results guaranteed",
    "claim: best-selling": "Our best-selling mug",
    "claim: #1": "The #1 choice",
    "claim: organic": "Organic cotton",
    "claim: dermatologist": "Dermatologist approved",
    "claim: lab-tested": "Lab-tested every batch",
    "claim: money-back": "Money-back promise",
  };
  eq(Object.keys(samples).length, CLAIMS.length, "one sample per claim rule:");
  for (const { label } of CLAIMS) ok(scanText(samples[label]).some((h) => h.rule === label), `claim rule "${label}" missed its sample`);
  const hits = scanText("Rated 5 stars by customers");
  ok(hits.some((h) => CLAIMS.some((c) => c.label === h.rule)), `no CLAIMS hit: ${JSON.stringify(hits)}`);
  eq(JSON.stringify(hits), JSON.stringify([{ rule: "claim: rated", match: "Rated" }, { rule: "claim: stars", match: "5 stars" }]), "hits:");
  // the BANNED rules too, file-limited ones only on request
  eq(JSON.stringify(scanText("run pnpm sync")), JSON.stringify([{ rule: "developer: pnpm command", match: "pnpm" }]), "a BANNED rule:");
  eq(scanText("Ask Storeasy support").length, 0, "founder copy may name Storeasy:");
  eq(scanText("Review your privacy page", { claims: false }).length, 0, "claims: false leaves CLAIMS out:");
  eq(scanText("Review your privacy page")[0]?.rule, "claim: reviews", "and CLAIMS is on by default:");
  ok(scanText("Powered by Shopify", { shopper: true }).some((h) => h.rule === "platform: vendor name in visible text"), "shopper text naming Shopify is clean");
  for (const clean of ["Fixture product 1", "Shop the collection", "Free delivery over ₹999", "Starter kit in navy", "Organise your desk", "", null]) eq(scanText(clean).length, 0, `${JSON.stringify(clean)} flagged:`);
  ok(BANNED.length > 40, "BANNED lost its rules");
});

// P6-GEN (from the P6-FIXTURE review): a hex colour is not a "#1" claim, a
// product's own name is not a "stars" claim, and a generated document is
// scanned on its shown words only, with the founder's catalog words left out.
await t("CLAIMS: '#1a2b3c' and 'Night stars candle' are not claims; scanDocumentText reads only shown text props, never tokens or ids, and skips the catalog's own words", () => {
  for (const clean of ["#1a2b3c", "Accent colour #1a2b3c", "#1e3a8a", "Night stars candle", "Stars and stripes mug", "#10 pack"]) eq(JSON.stringify(scanText(clean)), "[]", `${clean} flagged:`);
  for (const [claim, rule] of [["The #1 choice", "claim: #1"], ["#1 in India", "claim: #1"], ["A five-star blend", "claim: stars"], ["4/5 stars", "claim: stars"], ["Star rating 4", "claim: stars"]]) ok(scanText(claim).some((h) => h.rule === rule), `${claim} missed`);
  const design = { type: "design", v: 1, settings: { brand: { accent: "#1a2b3c", background: "#ffffff", foreground: "#111111" }, theme: { kit: "pulse", version: 1 }, logo: null }, sections: [] };
  eq(JSON.stringify(documentTexts(design)), "[]", "a design has no shown words:");
  eq(JSON.stringify(scanDocumentText(design)), "[]", "tokens are never scanned:");
  const home = {
    type: "home",
    v: 1,
    settings: {},
    sections: [
      { id: "sec_1a2b3c", kind: "hero", v: 1, enabled: true, settings: { title: "Night stars candle co", subtitle: "Shop Night stars candle and more.", primary: { label: "Shop all collections", link: { type: "url", href: "/collections" } }, image: { media: "https://cdn.shopify.com/a.jpg", alt: "Night stars candle" } }, blocks: [] },
      { id: "sec_rail01", kind: "product_rail", v: 1, enabled: true, settings: { title: "Best-selling picks", collection: { handle: "stars-1", id: "gid://shopify/Collection/1" }, limit: 8 }, blocks: [] },
    ],
  };
  eq(
    JSON.stringify(documentTexts(home).map((x) => x.path)),
    JSON.stringify(["sections.0.settings.title", "sections.0.settings.subtitle", "sections.0.settings.primary.label", "sections.0.settings.image.alt", "sections.1.settings.title"]),
    "the shown text props:",
  );
  const hits = scanDocumentText(home, { catalogWords: ["Night stars candle"] });
  eq(JSON.stringify(hits.map((h) => [h.path, h.rule])), JSON.stringify([["sections.1.settings.title", "claim: best-selling"]]), "only the generator's own claim:");
});

// P6-FIX1 (from the P6-GEN review): each of these inputs WOULD hit without the
// rule it pins, so taking the rule out fails the test.
await t("CLAIMS '#1': '#1Best', '#1Brand' and '#1 brand' are claims; hex colours of 3, 4, 6 and 8 digits and '#10 pack' are not", () => {
  for (const claim of ["#1Best", "Our #1Brand candle", "#1 brand", "#1", "(#1)", "#1f", "#1abcdefgh"]) ok(scanText(claim).some((h) => h.rule === "claim: #1"), `${claim} missed`);
  for (const clean of ["#1a2b3c", "#1e3a8a", "#1ab", "#1a2b", "#1a2b3c4d", "#123456", "#10 pack", "#12 pack", "colour #1E3A8A;"]) eq(JSON.stringify(scanText(clean).filter((h) => h.rule === "claim: #1")), "[]", `${clean} flagged:`);
});

await t("scanDocumentText (B3): the founder's catalog words are blanked before the scan, so a product called 'Organic cotton tee' makes no claim, while the same body without the catalog words is a hit", () => {
  const body = {
    type: "home",
    v: 1,
    settings: {},
    sections: [
      { id: "sec_b3hero", kind: "hero", v: 1, enabled: true, settings: { title: "Award winners candle co", subtitle: "Shop Organic cotton tee.", image: { media: "https://cdn.shopify.com/a.jpg", alt: "Organic cotton tee" } }, blocks: [] },
    ],
  };
  const raw = scanDocumentText(body).map((h) => [h.path, h.rule]);
  ok(raw.some(([p, r]) => p === "sections.0.settings.subtitle" && r === "claim: organic") && raw.some(([p, r]) => p === "sections.0.settings.title" && r === "claim: award"), `without catalog words: ${JSON.stringify(raw)}`);
  eq(JSON.stringify(scanDocumentText(body, { catalogWords: ["Organic cotton tee", "Award winners candle co"] })), "[]", "with the founder's words left out:");
  // blanking is whole words of the catalog, any case, and leaves the generator's own words
  const own = scanDocumentText({ ...body, sections: [{ ...body.sections[0], settings: { ...body.sections[0].settings, subtitle: "Shop organic COTTON TEE. Certified." } }] }, { catalogWords: ["Organic cotton tee", "Award winners candle co"] });
  eq(JSON.stringify(own.map((h) => h.rule)), JSON.stringify(["claim: certified"]), "the generator's own claim stays:");
});

await t("documentTexts (B4): only shown text props are read; claim words in handles, links, ids, numbers, undeclared keys and tokens are never scanned (each would hit if read)", () => {
  const body = {
    type: "home",
    v: 1,
    settings: { note: "Award-winning" },
    sections: [
      { id: "sec_organic1", kind: "hero", v: 1, enabled: true, settings: { title: "Hello", primary: { label: "Shop now", link: { type: "url", href: "/collections/organic-certified" } }, image: { media: "https://cdn.shopify.com/best-sellers.jpg", alt: "A candle" }, note: "Clinically proven", style: "guaranteed" }, blocks: [] },
      { id: "sec_rail01", kind: "product_rail", v: 1, enabled: true, settings: { title: "Picks", collection: { handle: "best-sellers", id: "gid://shopify/Collection/award" }, limit: 8 }, blocks: [] },
    ],
  };
  eq(JSON.stringify(documentTexts(body).map((x) => x.text)), JSON.stringify(["Hello", "Shop now", "A candle", "Picks"]), "the shown words:");
  eq(JSON.stringify(scanDocumentText(body)), "[]", "nothing else is scanned:");
  // the same words in a shown prop are hits (so the inputs above are real claims)
  for (const w of ["Award-winning", "Clinically proven", "guaranteed", "organic-certified", "best-sellers"]) ok(scanText(w).length > 0, `${w} is not a claim on its own`);
});

// Plant into a real file. A plant whose target has moved fails loudly here, so it
// can't turn into a test of nothing.
const plant = (file, from, to) => {
  const src = sources.get(file);
  ok(src.includes(from), `the plant target has moved in ${file}: ${from}`);
  return src.replace(from, to);
};
const plant2 = (src, from, to) => {
  ok(from.test(src), `the plant target has moved: ${from}`);
  return src.replace(from, to);
};

await t("the scan fails: planted text in a real file, outside any comment", async () => {
  const f = "app/(storefront)/collections/page.js";
  ok((await scanFile(f, plant(f, "please check back soon.", "run pnpm sync."))).some((x) => x.label.includes("pnpm")), "planted pnpm not caught");
  const other = await scanFile(f, plant(f, "please check back soon.", "connect Shopify and run the sync script."));
  ok(other.some((x) => x.label.includes("connect Shopify")) && other.some((x) => x.label.includes("sync script")), "other developer wording not caught");
});

await t("the scan fails: a phrase wrapped across JSX lines", async () => {
  const f = "components/account/ReturnRequest.js";
  const wrapped = plant(f, "The store reviews each request and will reply here.", "Catalog synced\n from the live\n Shopify store.");
  eq(scanSource(f, wrapped).length, 0, "the per-line scan alone misses this, which is why the parsed scan exists:");
  const found = await scanFile(f, wrapped);
  ok(found.some((x) => x.label.includes("catalog sync footer")), "wrapped footer note not caught");
  ok(found.some((x) => x.label.includes("live Shopify store")), "wrapped Shopify note not caught");
  const split = 'export default () => <p>Catalog synced{" "}\n  from <b className="x">the live</b> Shopify store</p>;';
  ok((await scanFile("components/Footer.js", split)).some((x) => x.label.includes("live Shopify store")), "text split by {\" \"} and a tag not caught");
});

await t("the scan fails: visible text that follows //", async () => {
  const f = "app/(storefront)/not-found.js";
  const planted = plant(f, "There is no store at this address.", "There is no store at this address. // run pnpm sync");
  eq(scanSource(f, planted).length, 0, "the per-line stripper blanks this, which is why the parsed scan exists:");
  ok((await scanFile(f, planted)).some((x) => x.label.includes("pnpm")), "visible text after // not caught");
});

await t("the scan fails: reworded developer text and vendor names in any case", async () => {
  const f = "components/account/ReorderPanel.js";
  const from = "Nothing from this order is available right now.";
  for (const words of ["Couldn't reach shopify", "Add NEXT_PUBLIC_RAZORPAY_KEY_ID to enable.", "TURSO_DB_URL is missing", "Missing the RESEND_API_KEY value", "Check your .env file", "Payments are in test mode", "TEST MODE"]) {
    ok((await scanFile(f, plant(f, from, words))).length, `passes the scan: ${words}`);
  }
  const shown = [
    "<p>razorpay</p>",
    "<p>{`shopify`}</p>",
    '<p>{paid ? "storeasy" : "x"}</p>',
    '<p>{name || "SHOPIFY"}</p>',
    '<img alt="shopify" />',
    '<input placeholder="razorpay" />',
    '<button aria-label="razorpay" />',
    '<a title={"storeasy"} />',
  ];
  for (const jsx of shown) ok((await scanFile("components/Footer.js", `export default ({ paid, name }) => ${jsx};`)).length, `passes the scan: ${jsx}`);
});

await t("the scan leaves code alone: vendor names that no one reads", async () => {
  const code = [
    'const go = () => new window.Razorpay({ method: "razorpay" });',
    'const on = (m) => m === "razorpay";',
    'export default ({ m }) => <p className={m === "razorpay" ? "a" : "b"}>{m === "razorpay" ? "Pay" : "Cash"}</p>;',
    'export const f = () => <input type="radio" value="razorpay" onChange={() => pick("razorpay")} />;',
    'const s = "https://checkout.razorpay.com/v1/checkout.js";',
    "const k = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;",
    'const key = "storeasy_recent_searches";',
  ];
  for (const src of code) eq(report(await scanFile("components/Footer.js", src)), "", `${src}:`);
});

await t("the parsed scan ignores real comments, wrapped or not", async () => {
  const src = 'const a = 1; // pnpm sync\n/* Catalog synced\n   from the live Shopify store */\nexport default () => <p>{/* run\n pnpm sync */}Hello</p>;\n';
  eq((await scanFile("components/Footer.js", src)).length, 0, "comments:");
});

await t("every neutralized row's old wording fails the scan (inventory section 1)", async () => {
  const rows = [
    ["app/(storefront)/error.js", "<h1>Something dropped the weights</h1>"],
    ["components/cart/CartDrawer.js", "<p>Add some gains and they'll show up here.</p>"],
    ["lib/cms/defaults.js", '"Browse the full catalog at ludicrous speed — fresh drops, live offers and fast checkout."'],
    ["lib/cms/defaults.js", '"Fresh drops"'],
    ["app/(storefront)/page.js", "<h2>Catalog not synced yet</h2>"],
    ["app/(storefront)/page.js", "<p>Connect the store's Shopify account, then pull the catalog:</p>"],
    ["app/(storefront)/page.js", "<code>pnpm migrate</code>"],
    ["app/(storefront)/page.js", "<p>Home, collections, product pages and search all light up automatically once products land.</p>"],
    ["app/(storefront)/page.js", '<p>{empty ? "Storefront ready" : ""}</p>'],
    ["app/(storefront)/collections/page.js", "<p>No collections yet — run <code>pnpm sync</code>.</p>"],
    ["components/Footer.js", "<p>© {name} · Catalog synced from the live Shopify store</p>"],
    ["lib/site.js", "`Browse the ${n} catalog — a fast storefront over the live Shopify store.`"],
    ["components/checkout/CheckoutFlow.js", '<p>Razorpay <span>· card / UPI / netbanking (test mode)</span></p>'],
    ["components/checkout/CheckoutFlow.js", '<p>Pay with Razorpay <span>· card</span></p>'],
    ["components/checkout/CheckoutFlow.js", "<p>Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable.</p>"],
    ["components/checkout/CheckoutFlow.js", "<p>Secure payment via Razorpay.</p>"],
    ["components/checkout/CheckoutFlow.js", '"Could not load Razorpay"'],
    ["components/checkout/CheckoutFlow.js", "`Could not continue (HTTP ${res.status}) — your cart is untouched, please retry.`"],
    ["app/(storefront)/checkout/confirmation/[orderId]/page.js", "<p>{cod ? 'Cash on Delivery' : 'Razorpay'}</p>"],
    ["app/(storefront)/not-found.js", "<p>No store is configured for this address.</p>"],
    ["components/account/ReorderPanel.js", "`Couldn't check this order (${res.status}).`"],
    ["app/api/checkout/route.js", '"Razorpay is not configured"'],
    ["app/api/checkout/route.js", '"Checkout is briefly paused by the platform — nothing was charged."'],
    // Allowed in lib/automations.js for store emails; "automation emails" below guards the shopper branch.
    ["lib/notifications.js", '`— automated rule "${rule.name}"`'],
    ["components/cart/CartDrawer.js", "<p>COD fee (if any) added at checkout · prices incl. GST</p>"],
    ["app/(storefront)/orders/[orderId]/page.js", "<p>Refunds reach the original payment method in 5–7 business days.</p>"],
    ["components/account/ReturnRequest.js", "<p>We review requests within a working day.</p>"],
    ["app/(storefront)/bundles/[slug]/page.js", "<p>and each piece\n  stays returnable on its own.</p>"],
  ];
  for (const [file, text] of rows) {
    const found = await scanFile(file, `export default function X({ name, empty, cod, res, n, rule }) { return ${text}; }`);
    ok(found.length > 0, `old wording passes the scan: ${file}: ${text}`);
  }
  ok((await scanFile("components/cart/CartDrawer.js", "export default () => <p>Powered by Shopify</p>;")).length, "new vendor text passes");
  ok((await scanFile("app/(storefront)/error.js", "export default () => <p>Hosted on Storeasy</p>;")).length, "platform name passes");
  eq((await scanFile("components/checkout/CheckoutFlow.js", 'const go = () => new window.Razorpay({ method: "razorpay" });')).length, 0, "window.Razorpay is code, not copy:");
});

await t("the scanner ignores comments but not strings that look like comments", () => {
  eq(scanSource("components/Footer.js", '// S55 fix: hardcoded BEASTLIFE\n/* pnpm sync */\n{/* pnpm sync */}\n').length, 0, "comments:");
  eq(scanSource("components/Footer.js", 'const a = "https://x.test/pnpm";').length, 1, "URL stays code:");
  eq(scanSource("components/Footer.js", 'const a = "image/*"; const b = "pnpm sync"; /* c */').length, 1, "image/* opens no comment:");
});

await t("allowances are narrow: same file, other text still fails", () => {
  ok(scanSource("lib/site.js", 'const x = "BeastLife rocks";').length > 0, "lib/site.js is not a free pass");
  ok(scanSource("lib/themes/kits.js", 'const x = "Whey for everyone";').length > 0, "lib/themes/kits.js is not a free pass");
  ok(scanSource("components/Header.js", 'const x = || "BeastLife"').length > 0, "the allowance doesn't travel to other files");
});

await t("every allowance still matches something (no stale exceptions)", () => {
  for (const a of ALLOWED) {
    const src = sources.get(a.file);
    ok(src != null, `${a.file} is not scanned`);
    ok(stripComments(src).split("\n").some((l) => a.re.test(l)), `stale allowance: ${a.file} ${a.re}`);
  }
});

await t("marketing-only routes stay 404 on a store's own address", async () => {
  const files = {
    customers: ["page.js", "[slug]/page.js"],
    integrations: ["page.js"],
    legal: ["[doc]/page.js"],
    pricing: ["page.js"],
    templates: ["page.js"],
    trust: ["page.js"],
    verticals: ["[vertical]/page.js"],
  };
  eq(Object.keys(files).sort().join(), [...MARKETING_ROUTES].sort().join(), "every skipped route is checked:");
  for (const [route, list] of Object.entries(files)) {
    for (const f of list) {
      const src = await readFile(join(ROOT, "app/(storefront)", route, f), "utf8");
      ok(/if \(!isPlatformSiteHost\([^\n]*\)\) notFound\(\);/.test(src), `${route}/${f} has lost its host gate`);
    }
  }
});

// ---- layer 2: real pages, rendered -------------------------------------------

const C = await import("../lib/platform/control.js");
const { withTenant, tenantShippingConfig } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const repo = await import("../lib/repo.js");
const sectionData = await import("../lib/cms/section-data.js");
const experiments = await import("../lib/experiments.js");
const platformSite = await import("../lib/platform-site.js");
const format = await import("../lib/format.js");
const shippingLib = await import("../lib/shipping.js");
const site = await import("../lib/site.js");
const cartLib = await import("../lib/cart.js");
const { createCart, getCart, addItem } = cartLib;
const tenantContext = await import("../lib/tenant-context.js");
const commerceAdapter = await import("../lib/commerce/adapter.js");
const settingsLib = await import("../lib/admin/settings.js");
const shopperErrors = await import("../lib/shopper-errors.js");
const checkoutPrice = await import("../lib/checkout-price.js");
const cmsDefaults = await import("../lib/cms/defaults.js");

const OWN_RATES = { currency: "INR", basis: "net", freeThreshold: 5000, flatRate: 50, codFee: 0, codFeeWaivedAt: null, zones: [] };
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "shop", name: "Acme Candles", domains: ["shop.test"], dbUrl: "file:.test-copy-t1.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "own-rates", name: "Own Rates", domains: ["own.test"], dbUrl: "file:.test-copy-t2.db", config: { shipping_config: OWN_RATES }, secrets: {} });
await C.upsertTenant({ id: "stocked", name: "Stocked", domains: ["stocked.test"], dbUrl: "file:.test-copy-t3.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "beastlife", name: "BeastLife", domains: ["bl.test"], dbUrl: "file:.test-copy-bl.db", config: { site: { name: "BeastLife", tagline: "Train harder." } }, secrets: {} });
// No schema at all: every query is a real database error.
await C.upsertTenant({ id: "broken", name: "Broken", domains: ["broken.test"], dbUrl: "file:.test-copy-t4.db", config: {}, secrets: {} });
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const id of ["shop", "own-rates", "stocked", "beastlife"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inShop = async (fn) => withTenant(await C.getTenant("shop"), fn);
const inOwn = async (fn) => withTenant(await C.getTenant("own-rates"), fn);
const inStocked = async (fn) => withTenant(await C.getTenant("stocked"), fn);
const inBl = async (fn) => withTenant(await C.getTenant("beastlife"), fn);

// A real cart holding one ₹500 product, on a store that has a catalog.
async function cartWithCandle(inTenant) {
  return inTenant(async () => {
    await db.insertInto("products").values({ id: "gid://t/P1", handle: "candle", title: "Candle", price_min: 500, price_max: 500, currency: "INR", available: 1, tags: "[]" }).onConflict((oc) => oc.doNothing()).execute();
    await db.insertInto("variants").values({ id: "gid://t/V1", product_id: "gid://t/P1", title: "One size", price: 500, currency: "INR", available: 1 }).onConflict((oc) => oc.doNothing()).execute();
    const id = `cart-${Math.random()}`;
    await createCart(id);
    await addItem(id, "gid://t/V1", 1);
    return id;
  });
}

// Compile a JSX .js file with the SWC build Next itself uses, then evaluate it
// with explicit stubs for its imports. An unstubbed import throws, so a new
// dependency can't quietly skip the render.
const compile = async (src) =>
  (
    await swc.transform(src, {
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const JSX_RUNTIME = require("react/jsx-runtime");
const passthrough = { __esModule: true, default: ({ href, children }) => React.createElement("a", { href }, children) };
const nothing = { __esModule: true, default: () => null };
async function loadComponent(src, stubs = {}) {
  const code = await compile(src);
  const mod = { exports: {} };
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react/jsx-runtime") return JSX_RUNTIME;
    if (id === "react") return React;
    throw new Error(`unstubbed import "${id}"`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}

// Banned text in what a shopper actually receives.
function assertClean(html, where) {
  const hits = BANNED.filter(({ re }) => re.test(html)).map((b) => b.label);
  ok(hits.length === 0, `${where} shows: ${hits.join(", ")}`);
  ok(!/<(pre|code)\b/i.test(html), `${where} shows a code block`);
}

// What a shopper reads, with tags gone, for exact comparison.
const shopperText = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const realEmptyCatalog = await readFile(join(ROOT, "components/EmptyCatalog.js"), "utf8");
// P2-SECTIONS: the hero renders through the renderer map. The real hero
// component, with the same stubs; the other sections are HomeSections' (stubbed).
const registryLegacy = await import("../lib/registry/legacy.js");
const { default: HeroSection } = await loadComponent(await readFile(join(ROOT, "components/sections/HeroSection.js"), "utf8"), {
  "next/link": passthrough,
  "@/components/StoreImage": nothing,
  "@/components/preview/ExperimentNote": nothing,
  "@/lib/cms/defaults": cmsDefaults,
  "@/lib/registry/legacy": registryLegacy,
  "@/lib/image-src": await import("../lib/image-src.js"),
});
const sectionMap = { SectionView: ({ section, ctx }) => (section.kind === "hero" ? React.createElement(HeroSection, { section, ctx, attrs: {} }) : null) };
async function renderHome({ emptyCatalogSrc = realEmptyCatalog, stats = null, hero = null } = {}) {
  const page = await loadComponent(await readFile(join(ROOT, "app/(storefront)/page.js"), "utf8"), {
    "@/components/sections/index": sectionMap,
    "@/lib/releases": { DOCUMENTS_RELEASE_VERSION: 4 },
    "@/lib/registry/legacy": registryLegacy,
    "@/lib/site": site,
    "next/link": passthrough,
    "next/headers": { headers: async () => ({ get: () => "shop.test" }), cookies: async () => ({ get: () => undefined }) },
    "@/components/EmptyCatalog": await loadComponent(emptyCatalogSrc),
    "@/components/ExperimentPing": nothing,
    "@/components/preview/ExperimentNote": nothing, // PV-08: preview-only; scanned as source above
    "@/components/site/MarketingHome": nothing,
    "@/components/sections/HomeSections": nothing,
    "@/lib/experiments": experiments,
    "@/lib/platform-site": platformSite,
    "@/lib/repo": stats ? { ...repo, getCatalogStats: async () => stats } : repo,
    "@/lib/cms/section-data": sectionData,
    "@/lib/cms/defaults": cmsDefaults,
    // resolve.js needs a request; a store with no release reads drafts, which is these getters
    "@/lib/content/resolve": {
      resolvedHero: async () => ({ ...(await S.getHero()), ...hero }),
      resolvedHomeSections: S.getHomeSections,
      resolvedHomePage: async () => [registryLegacy.legacyHeroToSection({ ...(await S.getHero()), ...hero }), ...registryLegacy.legacyHomeSectionsToSections(await S.getHomeSections())],
      resolvedCollectionsIndex: S.getCollectionsIndex,
      contentSource: async () => ({ mode: "draft", content: null, preview: false }), // a shopper, not a preview (PV-08)
    },
    "@/lib/tenant-request": { tfetch: inShop },
  });
  return renderToStaticMarkup(await page.default());
}

await t("empty catalog (rendered): home shows exactly the shopper message, no developer command", async () => {
  eq((await inShop(repo.getCatalogStats)).products, 0, "the fixture store really is empty:");
  const html = await renderHome();
  assertClean(html, "empty home");
  eq(shopperText(html), "Coming soon Shop Acme Candles . Our shop is opening soon. Shop all collections New products are on the way We’re getting things ready. Please check back soon.", "the whole page:");
  ok(!/shopify|\bsync\b/i.test(html), "the empty home talks about setup");
});

await t("empty catalog (rendered): no button to a section that isn't there", async () => {
  ok(!(await renderHome()).includes("#new"), "the default #new button is shown with nothing to jump to");
  const stocked = await renderHome({ stats: { products: 3, collections: 1 } });
  ok(stocked.includes("#new") && stocked.includes(cmsDefaults.DEFAULT_HERO_SUBTITLE), "a store with products keeps the default button and words");
  const own = await renderHome({ hero: { subtitle: "Poured by hand.", secondary: { label: "Our story", href: "/pages/about" } } });
  ok(own.includes("Poured by hand.") && own.includes("/pages/about"), "a founder's own hero stays as written on an empty store");
});

await t("empty catalog can fail: the old developer block is caught when rendered", async () => {
  const old = 'export default function E() { return <section><h2>Catalog not synced yet</h2><pre><code>pnpm migrate{"\\n"}pnpm sync</code></pre></section>; }';
  let caught = null;
  try {
    assertClean(await renderHome({ emptyCatalogSrc: old }), "empty home");
  } catch (e) {
    caught = e.message;
  }
  ok(caught && /pnpm/.test(caught), `the regression passed unnoticed: ${caught}`);
});

await t("empty catalog (rendered): collections index shows exactly the shopper message", async () => {
  const page = await loadComponent(await readFile(join(ROOT, "app/(storefront)/collections/page.js"), "utf8"), {
    "next/link": passthrough,
    "@/components/CollectionCard": nothing,
    "@/lib/repo": repo,
    "@/lib/content/resolve": { resolvedCollectionsIndex: S.getCollectionsIndex },
    "@/lib/tenant-request": { tfetch: inShop },
  });
  const html = renderToStaticMarkup(await page.default());
  assertClean(html, "empty collections");
  eq(shopperText(html), "Collections 0 collections No collections to show yet — please check back soon. ← Back home", "the whole page:");
  ok(!/shopify|\bsync\b/i.test(html), "the empty collections page talks about setup");
});

await t("footer (rendered): both variants carry the store's name and no catalog note", async () => {
  const { default: Footer } = await loadComponent(sources.get("components/Footer.js"), { "next/link": passthrough });
  for (const variant of ["columns", "minimal"]) {
    const html = renderToStaticMarkup(React.createElement(Footer, { variant, legalName: "Acme Candles Pvt Ltd", logo: { text1: "Acme", text2: "" } }));
    assertClean(html, `footer ${variant}`);
    ok(html.includes("© Acme Candles Pvt Ltd"), `footer ${variant} lost the legal line`);
    ok(!/shopify/i.test(html), `footer ${variant} names Shopify`);
  }
});

await t("error page (rendered): plain words, no status code, no gym voice", async () => {
  const { default: ErrorPage } = await loadComponent(sources.get("app/(storefront)/error.js"), {
    "next/link": passthrough,
    "@/components/analytics/ErrorReporter": { reportClientError() {} },
  });
  const html = renderToStaticMarkup(React.createElement(ErrorPage, { error: { digest: "abc123" }, reset() {} }));
  assertClean(html, "error page");
  ok(html.includes("Something went wrong"), "the heading is missing");
  ok(html.includes("Ref: abc123"), "the support reference is missing");
  ok(!html.includes(">500<"), "the page shows a raw status code");
});

await t("code defaults: a store with nothing set reads neutral", async () => {
  const seen = await inShop(async () => ({
    hero: await S.getHero(),
    sections: await S.getHomeSections(),
    tagline: site.siteTagline(),
    footer: site.siteFooterTagline(),
    title: site.siteTitle(),
    name: site.siteName(),
  }));
  assertClean(JSON.stringify(seen), "default content");
  eq(seen.name, "Acme Candles", "own name, never another store's:");
  ok(!/shopify|storefront/i.test(seen.tagline), `tagline talks about the platform: ${seen.tagline}`);
  const { COMPONENTS } = await import("../lib/cms/registry.js");
  assertClean(JSON.stringify(COMPONENTS), "section registry");
});

// The Home editor isn't scanned (it is a console file), but what its "add section"
// buttons start with can reach shoppers. Read from the real source; a move fails loudly.
await t("home editor: a new section starts with nothing a shopper could be shown unedited", async () => {
  const block = (await readFile(join(ROOT, "components/admin/cms/HomeEditor.js"), "utf8")).match(/const NEW_SECTION = (\{[\s\S]*?\n\});/);
  ok(block, "NEW_SECTION has moved in the Home editor");
  const NEW_SECTION = new Function(`return ${block[1]}`)();
  eq(NEW_SECTION.new.title, "New arrivals", "newest products:");
  eq(NEW_SECTION.collections.title, "Shop by collection", "collections:");
  assertClean(JSON.stringify(NEW_SECTION), "new sections");
  eq(`${NEW_SECTION.banner.title}${NEW_SECTION.banner.text}${NEW_SECTION.banner.label}`, "", "a new banner has no words of its own:");
  eq(`${NEW_SECTION.rich_text.title}${NEW_SECTION.rich_text.html}`, "", "a new rich text section has no words of its own:");
  const { validateBlock } = await import("../lib/cms/validate.js");
  eq(validateBlock("home_sections", [NEW_SECTION.banner]).ok, false, "an unedited banner can't be saved:");
  eq(validateBlock("home_sections", [NEW_SECTION.rich_text]).ok, false, "an unedited rich text section can't be saved:");
  ok(validateBlock("home_sections", [{ ...NEW_SECTION.banner, title: "Hello" }]).ok, "a banner the founder typed saves");
});

await t("automation emails: the rule's name stays out of a shopper's email", async () => {
  const M = await import("../lib/automations.js");
  await inStocked(async () => {
    await M.setAutomationsDisabled(false);
    await libsql.execute({
      sql: "INSERT INTO orders (id, email, total, currency, status, payment_method, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES (?,?,?,?,'paid',?,?,datetime('now'),datetime('now'),0,0)",
      args: ["GEN03-1", "shopper@x.test", 1000, "INR", "cod", JSON.stringify({ consent: JSON.stringify({ v: 2, a: 1, m: 1, at: "2026-10-28T00:00:00Z" }), items: [] })],
    });
    const order = await db.selectFrom("orders").selectAll().where("id", "=", "GEN03-1").executeTakeFirst();
    const rule = await M.upsertAutomation({ name: "Secret rule", trigger: "order_placed", action: { kind: "email_customer", subject: "Thanks", text: "Thanks for ordering!" }, cap_per_day: 10 }, { enabled: true });
    eq((await M.runOne(rule, { key: "order_placed:GEN03-1", order })).status, "done", "sent:");
    const email = await db.selectFrom("notifications").selectAll().where("type", "=", "automation_email_customer").executeTakeFirst();
    eq(email.body, "Thanks for ordering!\n\nOrder GEN03-1", "the whole email:");
  });
});

await t("BeastLife keeps its stored voice: only code defaults changed", async () => {
  const stored = "Science-backed protein, creatine and pre-workout — browse the full catalog at ludicrous speed.";
  await inBl(() => S.setBlock("hero", { title: "Go Beast Mode.", highlight: "Beast", subtitle: stored, primary: { label: "Shop", href: "/collections" }, secondary: { label: "New", href: "#new" } }));
  const bl = await inBl(async () => ({ hero: await S.getHero(), tagline: site.siteTagline(), about: S.defaultPage("about"), shipping: await S.getContentPage("shipping") }));
  eq(bl.hero.subtitle, stored, "stored hero wins:");
  eq(bl.tagline, "Train harder.", "stored tagline wins:");
  ok(bl.about?.title.includes("BeastLife"), "BeastLife keeps its about page");
  ok(bl.shipping?.title, "BeastLife keeps its shipping policy");
});

await t("BeastLife's pages never reach another store", async () => {
  eq(await inShop(() => S.defaultPage("about")), null, "about:");
  eq(await inShop(() => S.getContentPage("shipping")), null, "shipping:");
  eq(await inShop(() => S.getContentPage("terms")), null, "terms:");
});

// ---- layer 3: default shipping values ---------------------------------------

const checkoutFixture = {
  items: [{ variantId: "v1", title: "Candle", quantity: 1, price: 500, lineTotal: 500, currency: "INR", image: null }],
  gifts: [],
  appliedOffers: [],
  subtotal: 500,
  discountTotal: 0,
  total: 500,
  currency: "INR",
  couponStatus: null,
};
const flowStubs = {
  "@/components/StoreImage": nothing,
  "next/link": passthrough,
  "@/lib/format": format,
  "@/lib/shipping": shippingLib,
  "@/lib/shopper-errors": shopperErrors,
  "@/lib/checkout-price": checkoutPrice,
  "@/lib/track/client": { track() {} },
};
const realFlow = () => loadComponent(sources.get("components/checkout/CheckoutFlow.js"), flowStubs);

// The real checkout page, on a real store and cart, into `flow`.
async function renderCheckoutPage(inTenant, cartId, flow) {
  const page = await loadComponent(await readFile(join(ROOT, "app/(storefront)/checkout/page.js"), "utf8"), {
    "next/link": passthrough,
    "next/headers": { cookies: async () => ({ get: () => ({ value: cartId }) }) },
    "@/lib/cart": cartLib,
    "@/lib/tenant-context": tenantContext,
    "@/lib/commerce/adapter": commerceAdapter,
    "@/lib/site": site,
    "@/lib/content/resolve": { resolvedContentPageList: async () => [] },
    "@/components/checkout/CheckoutFlow": flow,
    "@/lib/tenant-request": { tfetch: inTenant },
  });
  return renderToStaticMarkup(await page.default());
}

await t("charges are pinned: the code default still charges exactly what it did", () => {
  const { computeShipping, SHIPPING_CONFIG } = shippingLib;
  eq(SHIPPING_CONFIG.flatRate, 79, "flat:");
  eq(SHIPPING_CONFIG.freeThreshold, 999, "free over:");
  eq(SHIPPING_CONFIG.codFee, 49, "COD fee:");
  eq(computeShipping({ subtotal: 500 }).total, 79, "below threshold:");
  eq(computeShipping({ subtotal: 999 }).total, 0, "at threshold:");
  eq(computeShipping({ subtotal: 500, paymentMethod: "cod" }).total, 128, "COD:");
});

await t("checkout page (rendered): a store's own rates reach the preview, the same the server charges", async () => {
  const config = await inOwn(async () => tenantShippingConfig());
  eq(config.flatRate, 50, "the fixture store has its own rates:");
  const server = shippingLib.computeShipping({ subtotal: 500, discountTotal: 0, paymentMethod: "prepaid", pincode: null, config });
  eq(server.total, 50, "server charge:");
  const cartId = await cartWithCandle(inOwn);
  let props = null;
  await renderCheckoutPage(inOwn, cartId, { __esModule: true, default: (p) => ((props = p), null) });
  ok(props, "the page did not reach CheckoutFlow");
  eq(JSON.stringify(props.shippingConfig), JSON.stringify(OWN_RATES), "the prop the page passes:");
  const html = await renderCheckoutPage(inOwn, cartId, await realFlow());
  // The form opens on Cash on Delivery: this store has no COD fee, the code default does.
  ok(html.includes("₹50"), "the store's ₹50 rate is not shown");
  ok(html.includes("₹550"), "the total does not use the store's rate");
  ok(!html.includes("₹128") && !html.includes("₹628"), "the code default is shown on a store with its own rates");
});

await t("checkout page (rendered): a store with no rates sees the starter charge it will really pay", async () => {
  eq(await inStocked(async () => tenantShippingConfig()), undefined, "no rates set:");
  const html = await renderCheckoutPage(inStocked, await cartWithCandle(inStocked), await realFlow());
  eq(shippingLib.computeShipping({ subtotal: 500, paymentMethod: "cod" }).total, 128, "what the server charges for COD:");
  ok(html.includes("₹128") && html.includes("₹628"), "the real charge must stay visible");
});

await t("checkout page (rendered): a closed checkout shows fixed text, never the capability's reason", async () => {
  const shop = await C.getTenant("shop");
  for (const config of [{ checkout_mode: "shopify" }, { checkout_mode: "disabled" }, { maintenance: { enabled: true } }]) {
    const inClosed = (fn) => withTenant({ ...shop, config: { ...shop.config, ...config } }, fn);
    const { available, reason } = await inClosed(async () => commerceAdapter.checkoutCapability());
    eq(available, false, "the fixture really closes checkout:");
    ok(reason, "the capability carries a reason this page must not show");
    if (config.checkout_mode === "shopify") ok(reason.includes("not implemented"), `the reason this guards against: ${reason}`);
    const html = await renderCheckoutPage(inClosed, "no-cart", { __esModule: true, default: () => "the checkout form" });
    eq(shopperText(html), "Checkout is temporarily unavailable Your cart is saved — nothing was charged. Please try again a little later. Keep browsing", "the whole page:");
  }
});

await t("checkout preview can fail: dropping the store's rates is caught", async () => {
  const broken = plant("components/checkout/CheckoutFlow.js", ", config: shippingConfig }", " }");
  const { default: CheckoutFlow } = await loadComponent(broken, flowStubs);
  const html = renderToStaticMarkup(React.createElement(CheckoutFlow, { cart: checkoutFixture, razorpayEnabled: true, storeName: "Acme", shippingConfig: OWN_RATES }));
  ok(html.includes("₹128") && !html.includes("₹550"), "the broken wiring rendered correct numbers");
});

// The real CartProvider, seeded the way the layout seeds it, into the real drawer.
// Only `open` is forced, since nothing can click the cart button here.
async function renderRealDrawer(initialCart) {
  const ctx = await loadComponent(sources.get("components/cart/CartContext.js"), {
    "@/lib/ids": await import("../lib/ids.js"),
    "@/lib/track/client": { track() {} },
  });
  const { default: CartDrawer } = await loadComponent(sources.get("components/cart/CartDrawer.js"), {
    "@/components/StoreImage": nothing,
    "next/link": passthrough,
    "@/lib/format": format,
    "./CartContext": { useCart: () => ({ ...ctx.useCart(), open: true }) },
  });
  return renderToStaticMarkup(React.createElement(ctx.CartProvider, { initialCart }, React.createElement(CartDrawer)));
}

await t("cart and console use one definition of chosen rates", async () => {
  const { settingsView } = settingsLib;
  const expected = { shop: false, "own-rates": true, beastlife: true };
  for (const [id, chosen] of Object.entries(expected)) {
    const tenant = await C.getTenant(id);
    const cart = await withTenant(tenant, async () => {
      const cartId = `cart-${Math.random()}`;
      await createCart(cartId);
      return getCart(cartId);
    });
    eq(cart.shippingRatesSet, chosen, `${id} cart:`);
    eq(settingsView(tenant).shipping_is_default, !chosen, `${id} console:`);
  }
});

await t("cart drawer (real provider): the charge always shows, the free-shipping promise needs chosen rates", async () => {
  const starter = await renderRealDrawer(await inStocked(async () => getCart(await cartWithCandle(inStocked))));
  ok(starter.includes("₹79"), "the real charge must stay visible");
  ok(!/free shipping/i.test(starter), "a promise the store never made is shown");
  assertClean(starter, "cart drawer");
  const own = await renderRealDrawer(await inOwn(async () => getCart(await cartWithCandle(inOwn))));
  ok(own.includes("₹50") && /free shipping/i.test(own), "a store that chose its rates keeps the nudge");
  assertClean(own, "cart drawer");
});

await t("cart drawer (real provider): the empty state is neutral", async () => {
  const html = await renderRealDrawer(await inShop(async () => cartLib.emptyCart()));
  assertClean(html, "empty cart");
  ok(html.includes("Your cart is empty"), "the empty message is missing");
});

// ---- layer 4: typing and clicking, and real API routes -----------------------

// A small stand-in for a browser: runs a client component as a plain function with
// its own hooks, so a test can type and click, then read the next render. No effects
// run and nothing is laid out, so this proves logic and copy, not how a page looks.
async function mount(src, stubs, props) {
  const slots = [];
  let cursor = 0;
  const hooks = {
    useState(init) {
      const k = cursor++;
      if (!(k in slots)) slots[k] = init;
      return [slots[k], (v) => void (slots[k] = typeof v === "function" ? v(slots[k]) : v)];
    },
    useRef(init) {
      const k = cursor++;
      if (!(k in slots)) slots[k] = { current: init };
      return slots[k];
    },
    useEffect() {},
  };
  const { default: Component } = await loadComponent(src, { ...stubs, react: hooks });
  const render = () => {
    cursor = 0;
    return Component(props);
  };
  const elements = () => {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!React.isValidElement(n)) return;
      out.push(n);
      Object.values(n.props).forEach(walk);
    };
    walk(render());
    return out;
  };
  const textOf = (n) => {
    if (Array.isArray(n)) return n.map(textOf).join("");
    if (typeof n === "string" || typeof n === "number") return String(n);
    if (!React.isValidElement(n)) return "";
    return [n.props.title, n.props.children, n.props.actions].map(textOf).join("");
  };
  const find = (pred, what) => {
    const el = elements().find(pred);
    ok(el, `not on screen: ${what}`);
    return el;
  };
  return {
    find,
    has: (pred) => elements().some(pred),
    text: () => textOf(render()),
    textOf,
    click(label) {
      const el = find((e) => e.props.onClick && textOf(e).includes(label), `button "${label}"`);
      ok(!el.props.disabled, `button "${label}" is disabled`);
      return el.props.onClick();
    },
    type: (pred, value, what) => find(pred, what).props.onChange({ target: { value } }),
  };
}

// fetch and window for one test. `replies` answer in order; an Error is thrown.
async function withBrowser(replies, extra, fn) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return typeof r === "string" ? new Response(r) : new Response(JSON.stringify(r), { status: r.status || 200 });
  };
  globalThis.window = { location: {}, ...extra };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved;
    delete globalThis.window;
  }
}

const ADDRESS = { email: "a@b.test", phone: "9999999999", name: "A Shopper", line1: "1 Road", city: "Pune", state: "MH", pincode: "411001" };
async function checkoutAtPayment(props = {}) {
  const app = await mount(sources.get("components/checkout/CheckoutFlow.js"), flowStubs, { cart: checkoutFixture, razorpayEnabled: true, storeName: "Acme", policies: [], ...props });
  for (const [name, value] of Object.entries(ADDRESS)) app.type((e) => e.type === "input" && e.props.name === name, value, `field ${name}`);
  app.click("Continue to review");
  app.click("Continue to payment");
  return app;
}
const payOnline = (app) => app.find((e) => e.type === "input" && e.props.type === "radio" && e.props.disabled !== undefined, "online payment option").props.onChange();
const shownError = (app) => app.textOf(app.find((e) => e.type === "p" && /bg-sf-danger-surface/.test(e.props.className || ""), "the error message"));

const PLAIN_CHECKOUT = "Could not continue — your cart is untouched, please retry.";
const RAW_CHECKOUT_ERRORS = [
  { error: "Razorpay order create failed (500): {\"error\":{\"code\":\"BAD_REQUEST_ERROR\"}}" },
  { error: "Razorpay order create failed (500)" },
  { error: "Razorpay order create failed (429): Too many requests" },
  // Allowed words first, raw text after
  { error: "Too many requests to turso db acme-prod: quota exceeded" },
  { error: "Please fill all required fields: SQLITE_CONSTRAINT orders.email" },
  { error: "This checkout attempt no longer matches your cart. Please retry. SQLITE_BUSY" },
  { error: "Online payment isn't available for this store right now. (Razorpay 401)" },
  { error: "SQLITE_ERROR: no such table: orders" },
  { error: "fetch failed" },
  { error: "Cannot read properties of undefined (reading 'id')", code: "X" },
  {},
];

await t("checkout errors: raw provider and database text never passes", () => {
  const { friendlyCheckoutError } = shopperErrors;
  for (const data of RAW_CHECKOUT_ERRORS) eq(friendlyCheckoutError(data), PLAIN_CHECKOUT, `${data.error}:`);
  eq(friendlyCheckoutError(), PLAIN_CHECKOUT, "nothing:");
  for (const own of ["Please fill all required fields", "This checkout attempt no longer matches your cart. Please retry.", "Online payment isn't available for this store right now.", "Too many requests"]) {
    eq(friendlyCheckoutError({ error: own }), own, "written for shoppers:");
    // The match is exact, so a reworded server message would quietly become the plain line.
    ok(sources.get("app/api/checkout/route.js").includes(own) || sources.get("lib/rate-limit.js").includes(own), `no server sends this any more: ${own}`);
  }
  ok(/temporarily unavailable/.test(friendlyCheckoutError({ error: "x", code: "CHECKOUT_DISABLED" })), "paused checkout");
  ok(/session expired/.test(friendlyCheckoutError({ error: "Cart is empty" })), "expired cart");
});

await t("checkout (clicked): a failed order shows the shopper's line, never the server's text", async () => {
  for (const reply of RAW_CHECKOUT_ERRORS) {
    for (const online of [false, true]) {
      const app = await checkoutAtPayment();
      if (online) payOnline(app);
      await withBrowser([{ ...reply, status: 400 }], {}, () => app.click(online ? "Pay " : "Place order"));
      eq(shownError(app), PLAIN_CHECKOUT, `${reply.error}:`);
    }
  }
  for (const online of [false, true]) {
    const app = await checkoutAtPayment();
    if (online) payOnline(app);
    await withBrowser([{ error: "Please fill all required fields", status: 400 }], {}, () => app.click(online ? "Pay " : "Place order"));
    eq(shownError(app), "Please fill all required fields", `our own line (${online ? "online" : "cash"}):`);
  }
});

await t("checkout (clicked): browser failures read as the connection, not as browser wording", async () => {
  const expected = "Could not reach the store — your cart is untouched. Check your connection and try again.";
  for (const reply of [new TypeError("Failed to fetch"), "<html>not json</html>"]) {
    const app = await checkoutAtPayment();
    await withBrowser([reply], {}, () => app.click("Place order"));
    eq(shownError(app), expected, "failed fetch:");
  }
});

await t("checkout (clicked): a failed payment check says what to do, not the server's reason", async () => {
  const app = await checkoutAtPayment();
  payOnline(app);
  let options = null;
  class Razorpay {
    constructor(o) {
      options = o;
    }
    on() {}
    open() {}
  }
  const replies = [
    { ok: true, orderId: "ORD-1", keyId: "k", razorpayOrderId: "r", amount: 100, currency: "INR" },
    { ok: false, error: "Payment signature verification failed" },
  ];
  await withBrowser(replies, { Razorpay }, async () => {
    await app.click("Pay ");
    ok(options, "the payment window did not open");
    await options.handler({ razorpay_order_id: "r", razorpay_payment_id: "p", razorpay_signature: "s" });
  });
  eq(shownError(app), "We couldn't confirm your payment for order ORD-1. If money left your account, please don't pay again — contact the store with this order number.", "shown:");
});

await t("checkout (clicked): the payment step names no vendor or setup step", async () => {
  const on = await checkoutAtPayment();
  const live = on.text();
  ok(live.includes("Pay online · card / UPI / netbanking"), "the option label");
  ok(live.includes("You'll finish paying in a secure payment window."), "the option note");
  const off = (await checkoutAtPayment({ razorpayEnabled: false })).text();
  ok(off.includes("Online payment isn't available for this store right now."), "the disabled note");
  for (const text of [live, off]) ok(!/razorpay|test mode|NEXT_PUBLIC|shopify|storeasy/i.test(text), `the payment step says: ${text}`);
});

// P1-RATES: the clicked checkout. The button's own amount goes to the server; a
// refusal redraws the summary and the button from the server's cart and rates,
// says the new total, never retries on its own, and the next press sends the
// redrawn amount.
await t("checkout (clicked, P1-RATES): a refused total redraws the page, and the next press sends the redrawn amount", async () => {
  const OLD = { ...OWN_RATES, flatRate: 79, freeThreshold: 999, codFee: 49 };
  const NEW = { ...OWN_RATES, flatRate: 149, freeThreshold: 4999, codFee: 59 };
  const button = (app, online) => app.textOf(app.find((e) => e.type === "button" && /^(Place order|Pay) ₹?·?/.test(app.textOf(e)) && e.props.className?.includes("bg-sf-accent"), "the pay button"));
  for (const online of [false, true]) {
    const app = await checkoutAtPayment({ shippingConfig: OLD });
    if (online) payOnline(app);
    // ₹500 of goods: cash ₹500 + ₹79 + ₹49, online ₹500 + ₹79; then ₹149 and ₹59
    const [was, now, shipWas, shipNow] = online ? [579, 649, 79, 149] : [628, 708, 128, 208];
    eq(button(app, online), online ? `Pay ₹${was}` : `Place order · ₹${was}`, "before:");
    const message = `Shipping changed — your new total is ₹${now}. Review and place order.`;
    const refusal = { status: 409, ok: false, code: "PRICE_CHANGED", error: message, total: now, shippingTotal: shipNow, currency: "INR", cart: checkoutFixture, shippingConfig: NEW };
    const first = await withBrowser([refusal], {}, async (calls) => {
      await app.click(online ? "Pay " : "Place order");
      return calls;
    });
    eq(first.length, 1, `requests on one press (${online ? "online" : "cash"}), no silent retry:`);
    eq(first[0].body.expectedTotal, was, "total sent with the press:");
    eq(first[0].body.expectedShipping, shipWas, "shipping sent with the press:");
    eq(shownError(app), message, "said:");
    eq(button(app, online), online ? `Pay ₹${now}` : `Place order · ₹${now}`, "redrawn button:");
    ok(app.text().includes(`₹${shipNow}`), `the summary's shipping is not redrawn to ₹${shipNow}`);
    if (online) continue;
    const second = await withBrowser([{ ok: true, orderId: "ORD-2", confirmationPath: "/checkout/confirmation/ORD-2?t=x" }], {}, async (calls) => {
      await app.click("Place order");
      return calls;
    });
    eq(second[0].body.expectedTotal, now, "total sent with the second press:");
    eq(second[0].body.expectedShipping, shipNow, "shipping sent with the second press:");
    ok(second[0].body.idempotencyKey !== first[0].body.idempotencyKey, "the second press reuses the refused attempt's key");
  }
});

// ---- the founder's Settings form

const settingsStubs = {
  "lucide-react": { Plus: nothing.default, X: nothing.default },
  "@/components/console/Card": { Card: ({ children }) => React.createElement("section", null, children), CardHeader: ({ title }) => React.createElement("h2", null, title) },
  "@/components/console/Banner": { Banner: ({ title, actions, children }) => React.createElement("div", { role: "note" }, title, " ", children, actions) },
  "@/components/console/Button": { Button: ({ children }) => React.createElement("button", null, children), IconButton: nothing.default },
  "@/components/console/fields": { Field: ({ children }) => React.createElement("label", null, children), Input: () => null, Select: () => null },
  "@/components/console/Toast": { useToast: () => ({ success() {}, error() {} }) },
  "@/lib/admin/settings": settingsLib,
  // GEN-02's sync card; scripts/test-first-sync.js renders it
  "@/components/admin/SyncProgress": nothing,
};
const settingsSrc = await readFile(join(ROOT, "components/admin/SettingsAdmin.js"), "utf8");
const NOTICE = "You haven't set your own shipping rates yet";
const shopView = async () => settingsLib.settingsView(await C.getTenant("shop"));
const byId = (id) => (e) => e.props.id === id;

await t("settings (rendered): the notice shows only when the rates aren't chosen", async () => {
  const { default: SettingsAdmin } = await loadComponent(settingsSrc, settingsStubs);
  const render = (initial) => renderToStaticMarkup(React.createElement(SettingsAdmin, { initial }));
  const starter = render(await shopView());
  ok(shopperText(starter).includes(`${NOTICE} Shoppers are charged the starter rates below.`), "the notice is missing on starter rates");
  ok(starter.includes("Keep these rates"), "the Keep button is missing");
  const own = render(settingsLib.settingsView(await C.getTenant("own-rates")));
  ok(!shopperText(own).includes(NOTICE), "the notice shows on a store with its own rates");
  ok(!render(settingsLib.settingsView(await C.getTenant("beastlife"))).includes("Keep these rates"), "BeastLife's cart treats the rates as chosen, so the console must too");
});

await t("settings (clicked): Keep these rates saves them, and the notice goes", async () => {
  const view = await shopView();
  const app = await mount(settingsSrc, settingsStubs, { initial: view });
  ok(app.text().includes(NOTICE), "notice before");
  const saved = settingsLib.settingsView({ id: "shop", config: { shipping_config: OWN_RATES }, secrets: {} });
  await withBrowser([{ ok: true, settings: saved }], {}, async (calls) => {
    await app.click("Keep these rates");
    eq(calls.length, 1, "one save:");
    eq(Object.keys(calls[0].body).join(), "shipping", "only shipping is sent:");
    eq(calls[0].body.shipping.flatRate, 79, "the rates shown:");
    eq(calls[0].body.shipping.freeThreshold, 999, "the rates shown:");
  });
  ok(!app.text().includes(NOTICE), "notice after");
});

await t("settings (clicked): an unrelated save can't adopt starter rates", async () => {
  const patch = settingsLib.buildSettingsPatch({ identity: { name: "Acme" } }, {}).patch;
  ok(!("shipping_config" in patch.config), "a save without shipping must not write shipping_config");
  const save = async (app) =>
    withBrowser([{ ok: true, settings: await shopView() }], {}, async (calls) => {
      await app.find((e) => e.type === "form", "the form").props.onSubmit({ preventDefault() {} });
      return calls[0].body;
    });
  const app = await mount(settingsSrc, settingsStubs, { initial: await shopView() });
  app.type(byId("sa-support-email"), "help@acme.test", "support email");
  const unrelated = await save(app);
  eq(unrelated.identity.support_email, "help@acme.test", "the change is sent:");
  ok(!("shipping" in unrelated), "starter rates sent with an unrelated change");

  const retyped = await mount(settingsSrc, settingsStubs, { initial: await shopView() });
  retyped.type(byId("sa-flat-rate"), "79", "flat rate");
  ok(!("shipping" in (await save(retyped))), "retyping the same number counts as choosing the rates");

  const changed = await mount(settingsSrc, settingsStubs, { initial: await shopView() });
  changed.type(byId("sa-flat-rate"), "60", "flat rate");
  eq((await save(changed)).shipping?.flatRate, "60", "a real change is sent:");

  const own = await mount(settingsSrc, settingsStubs, { initial: settingsLib.settingsView(await C.getTenant("own-rates")) });
  ok("shipping" in (await save(own)), "a store with its own rates keeps sending them");
});

await t("settings: only a real change counts, and a bad value still reaches validation", () => {
  const { shippingFormChanged } = settingsLib;
  const starter = shippingLib.SHIPPING_CONFIG;
  eq(shippingFormChanged(starter, starter), false, "same:");
  eq(shippingFormChanged({ ...starter, flatRate: "79", freeThreshold: "999.0" }, starter), false, "same numbers, typed:");
  eq(shippingFormChanged({ ...starter, flatRate: "60" }, starter), true, "new number:");
  eq(shippingFormChanged({ ...starter, freeThreshold: "" }, starter), true, "blank = never free:");
  eq(shippingFormChanged({ ...starter, flatRate: "abc" }, starter), true, "invalid:");
});

// ---- public API routes, called directly

const { NextRequest } = require("next/server");
const ROUTE_ENV = {
  "next/server": require("next/server"),
  "@/lib/rate-limit": await import("../lib/rate-limit.js"),
  "@/lib/log": await import("../lib/log.js"),
  "@/lib/tenant-request": await loadComponent(await readFile(join(ROOT, "lib/tenant-request.js"), "utf8"), {
    react: React,
    "next/headers": {},
    "next/navigation": {},
    "next/server": require("next/server"),
    "./platform/control.js": C,
    "./tenant-context.js": tenantContext,
    "./tenant-gate.js": await import("../lib/tenant-gate.js"),
  }),
};
const loadRoute = async (route, stubs) => loadComponent(await readFile(join(ROOT, "app/api", route, "route.js"), "utf8"), { ...ROUTE_ENV, ...stubs });
const jsonPost = (host, path, body, cookie) =>
  new NextRequest(`http://${host}${path}`, { method: "POST", headers: { host, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

await t("account API: a real database error reaches the shopper as plain words", async () => {
  const route = await loadRoute("account", {
    "@/lib/customers": await import("../lib/customers.js"),
    "@/lib/returns": await import("../lib/returns.js"),
    "@/lib/wishlist": await import("../lib/wishlist.js"),
    "@/lib/shopper-errors": shopperErrors,
  });
  const res = await route.POST(jsonPost("broken.test", "/api/account", { action: "verify", email: "a@b.test", code: "123456" }));
  eq(res.status, 422, "status:");
  eq(JSON.stringify(await res.json()), JSON.stringify({ error: "Something went wrong — please try again." }), "body:");
  const own = await route.POST(jsonPost("own.test", "/api/account", { action: "verify", email: "a@b.test", code: "123456" }));
  eq((await own.json()).error, "No active code — request a new one.", "our own message:");
});

await t("account API: a plain error with internal text never reaches the shopper", async () => {
  const customers = await import("../lib/customers.js");
  const route = await loadRoute("account", {
    "@/lib/customers": { ...customers, verifyOtp: async () => { throw new Error("SQLITE_BUSY: database is locked"); } },
    "@/lib/returns": await import("../lib/returns.js"),
    "@/lib/wishlist": await import("../lib/wishlist.js"),
    "@/lib/shopper-errors": shopperErrors,
  });
  const res = await route.POST(jsonPost("own.test", "/api/account", { action: "verify", email: "a@b.test", code: "123456" }));
  eq(JSON.stringify(await res.json()), JSON.stringify({ error: "Something went wrong — please try again." }), "body:");
});

await t("account errors: only messages marked for shoppers show", () => {
  const { shopperErrorMessage, ShopperError } = shopperErrors;
  const fallback = "Something went wrong — please try again.";
  eq(shopperErrorMessage(new ShopperError("That code expired — request a new one."), fallback), "That code expired — request a new one.", "own copy:");
  for (const raw of [
    new Error("SQLITE_BUSY: database is locked"),
    new Error("That code expired — request a new one."),
    Object.assign(new Error("SQLITE_ERROR: no such table: customers"), { name: "LibsqlError", code: "SQLITE_ERROR" }),
    new TypeError("fetch failed"),
    Object.assign(new Error("boom"), { code: "X" }),
    { name: "ShopperError", message: "looks the part" },
    null,
  ]) {
    eq(shopperErrorMessage(raw, fallback), fallback, `${raw?.message}:`);
  }
});

await t("account errors: what the sign-in, profile and returns code throws still shows", async () => {
  const customers = await import("../lib/customers.js");
  const { requestReturn, returnEligibility } = await import("../lib/returns.js");
  const { shopperErrorMessage, ShopperError } = shopperErrors;
  const shown = async (fn) => {
    const e = await fn().then(() => null, (err) => err);
    ok(e instanceof ShopperError, `not marked for shoppers: ${e?.message}`);
    return shopperErrorMessage(e, "FALLBACK");
  };
  await inOwn(async () => {
    eq(await shown(() => customers.requestOtp("not-an-email")), "That email doesn't look right.", "bad email:");
    eq(await shown(() => customers.verifyOtp("nobody@b.test", "123456")), "No active code — request a new one.", "no code:");
    eq(await shown(() => customers.updateCustomerProfile("nobody", { address: { line1: "" } })), "An address needs at least line 1, city and pincode.", "bad address:");
    eq(await shown(() => requestReturn({ customerId: "nobody", orderId: "nope", reason: "x" })), returnEligibility(null).reason, "no such order:");
  });
  // Every throw in the shopper's account code is one a shopper may read.
  ok(!/throw new Error\(/.test(sources.get("lib/customers.js")), "lib/customers.js throws a plain Error, which shoppers now can't read");
  const asked = sources.get("lib/returns.js").match(/export async function requestReturn[\s\S]*?\n}\n/);
  ok(asked && !/throw new Error\(/.test(asked[0]), "requestReturn throws a plain Error, which shoppers now can't read");
});

// ---- the shopper's order list

const ACCOUNT_BADGES = [
  // [fulfillment_status, status, what the badge must say]
  ["fulfilled", "synced", "shipped"],
  ["partially_fulfilled", "synced", "partly shipped"],
  ["unfulfilled", "paid", "paid"],
  ["unfulfilled", "cod_pending", "placed (COD)"],
  ["in_progress", "synced", "processing"],
  ["on_hold", "synced", "processing"],
  ["open", "syncing_shopify", "processing"],
  ["pending_fulfillment", "synced", "processing"],
  ["request_declined", "synced", "processing"],
  ["restocked", "cancelled", "cancelled"],
  ["scheduled", "sync_failed", "processing"],
  [null, "pending_payment", "payment pending"],
  ["some_new_shopify_value", "another_new_status", "processing"],
];
const accountSrc = await readFile(join(ROOT, "app/(storefront)/account/page.js"), "utf8");
let accountCustomer = null;
async function accountBadges(src = accountSrc) {
  const customers = await import("../lib/customers.js");
  if (!accountCustomer) {
    accountCustomer = { id: "cus_badges", email: "badges@b.test", name: "Asha", phone: "", address: null };
    await inOwn(async () => {
      await db.insertInto("customers").values({ id: accountCustomer.id, email: accountCustomer.email, name: "Asha", created_at: new Date().toISOString() }).execute();
      for (const [i, [fulfillment_status, status]] of ACCOUNT_BADGES.entries()) {
        await db.insertInto("orders").values({ id: `B-${i}`, idempotency_key: `badge-${i}`, customer_id: accountCustomer.id, status, fulfillment_status, total: 100, currency: "INR", snapshot: JSON.stringify({ items: [{ title: "Candle", quantity: 1 }] }), created_at: new Date().toISOString() }).execute();
      }
    });
  }
  const page = await loadComponent(src, {
    "next/link": passthrough,
    "next/headers": { cookies: async () => ({ get: () => ({ value: "token" }) }) },
    // The session is the only stub: the orders come from the real query on a real database.
    "@/lib/customers": { ...customers, customerFromToken: async () => accountCustomer },
    "@/lib/format": format,
    "@/components/account/AccountAuth": nothing,
    "@/components/account/ProfileForm": nothing,
    "@/lib/tenant-request": { tfetch: inOwn },
  });
  const html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  return Object.fromEntries([...html.matchAll(/font-mono[^>]*>(B-\d+)<.*?rounded-sf-2xs bg-sf-surface-sunken[^>]*>([^<]*)</g)].map((m) => [m[1], m[2]]));
}
const badgeProblems = (badges) =>
  ACCOUNT_BADGES.flatMap(([raw, status, want], i) => {
    const got = badges[`B-${i}`];
    if (got === want && !got.includes("_") && got !== raw) return [];
    return [`${raw}/${status} shows "${got}", wanted "${want}"`];
  });

await t("account orders (rendered): the badge is plain words, never a raw value", async () => {
  const problems = badgeProblems(await accountBadges());
  ok(problems.length === 0, problems.join("; "));
});

await t("account orders can fail: the old badge is caught when rendered", async () => {
  const old = plant2(accountSrc, /\{orderBadge\(o\)\}/, "{o.fulfillment || STATUS_LABEL[o.status] || o.status}");
  const problems = badgeProblems(await accountBadges(old)).join("; ");
  ok(/partially_fulfilled\/synced shows "partially_fulfilled"/.test(problems), `the old badge passed: ${problems}`);
  ok(/some_new_shopify_value/.test(problems), `the raw fallback passed: ${problems}`);
});

await t("no other shopper screen or email prints the fulfillment value", () => {
  for (const f of ["app/(storefront)/orders/[orderId]/page.js", "app/(storefront)/account/orders/[orderId]/page.js", "lib/automations.js", "lib/notifications.js"]) {
    const src = stripComments(sources.get(f));
    ok(!/\{\s*(o|order)\.fulfillment(_status)?\b/.test(src) && !/\$\{[^}]*fulfillment_status/.test(src), `${f} prints the fulfillment value`);
  }
});

await t("search API: a real database error leaves no error text in the response", async () => {
  const route = await loadRoute("search", { "@/lib/typesense-search": { typesenseSearch: async () => null }, "@/lib/repo": repo });
  const req = new NextRequest("http://broken.test/api/search?q=candle", { headers: { host: "broken.test" } });
  eq(JSON.stringify(await (await route.GET(req)).json()), JSON.stringify({ q: "candle", hits: [], source: "error" }), "body:");
});

await t("cart API: a failed change leaves no error text in the response", async () => {
  const route = await loadRoute("cart", { "@/lib/cart": cartLib });
  const cartId = await inOwn(async () => {
    const id = `cart-${Math.random()}`;
    await createCart(id);
    return id;
  });
  const res = await route.POST(jsonPost("own.test", "/api/cart", { action: "add", variantId: "gid://nope/secret-id", quantity: 1 }, `${cartLib.CART_COOKIE}=${cartId}`));
  eq(res.status, 400, "status:");
  const body = await res.json();
  ok(Array.isArray(body.items), "the cart still comes back");
  ok(!("error" in body), `raw error returned: ${body.error}`);
  ok(!JSON.stringify(body).includes("secret-id"), "the failing input is echoed back");
});

// ---- who shopper emails come from

await t("shopper emails carry the store's name and keep the verified address", async () => {
  const { notify, deliverNotification } = await import("../lib/notifications.js");
  const { sendMail, storeSender } = await import("../lib/mail.js");
  const env = { key: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM };
  process.env.RESEND_API_KEY = "test-not-a-real-key";
  const senderOf = async (inTenant) =>
    withBrowser([{ id: "m1" }], {}, async (calls) => {
      await inTenant(async () => {
        const row = await notify({ type: "test", to: "shopper@x.test", subject: "Your code", text: "123456", idempotencyKey: `k-${Math.random()}` });
        await deliverNotification(row.id);
      });
      return calls.find((c) => /resend/.test(c.url)).body.from;
    });
  try {
    delete process.env.MAIL_FROM;
    eq(await senderOf(inShop), "Acme Candles <onboarding@resend.dev>", "no MAIL_FROM:");
    process.env.MAIL_FROM = "Storeasy <hello@mail.example.test>";
    eq(await senderOf(inShop), "Acme Candles <hello@mail.example.test>", "a set MAIL_FROM keeps its address:");
    eq(await senderOf(inBl), "BeastLife <hello@mail.example.test>", "each store its own name:");
    process.env.MAIL_FROM = "hello@mail.example.test";
    eq(await senderOf(inOwn), "Own Rates <hello@mail.example.test>", "a bare address:");

    eq(storeSender('Acme, "Candles" Inc'), '"Acme, Candles Inc" <hello@mail.example.test>', "a name with punctuation:");
    eq(storeSender("Evil <a@b.test>\r\nBcc: c@d.test"), '"Evil a@b.test Bcc: c@d.test" <hello@mail.example.test>', "a name can't add an address or a header:");
    eq(storeSender(""), "hello@mail.example.test", "no name:");
    eq(storeSender("   "), "hello@mail.example.test", "only spaces:");
    // Only letters, digits and spaces go unquoted (RFC 5322): every other character is quoted.
    eq(storeSender("Acme Candles 24"), "Acme Candles 24 <hello@mail.example.test>", "plain name:");
    for (const name of ["St. Mark's", "A.B. Foods", "Acme & Co", "Rock_n-Roll", "Tea: Leaf", "Ann@Home", "Café Noir", "दुकान"]) {
      eq(storeSender(name), `"${name}" <hello@mail.example.test>`, `${name}:`);
    }
    eq(storeSender('St. back\\'), '"St. back" <hello@mail.example.test>', "a backslash can't escape the quote:");
    eq(storeSender("Tab\tNull\u0000Bell\u0007Del\u007f"), "Tab Null Bell Del <hello@mail.example.test>", "control characters:");
    // The cap: long names are cut, whole characters only, and stay valid.
    eq(storeSender("x".repeat(300)), `${"x".repeat(64)} <hello@mail.example.test>`, "a long name:");
    eq(storeSender(`${"x".repeat(63)} y`), `${"x".repeat(63)} <hello@mail.example.test>`, "no space left at the cut:");
    eq(storeSender(`${"x".repeat(63)}😀😀`), `"${"x".repeat(63)}😀" <hello@mail.example.test>`, "a cut never splits a character:");
    eq(storeSender(`${"x".repeat(60)}. ${"y".repeat(50)}`), `"${"x".repeat(60)}. yy" <hello@mail.example.test>`, "still quoted after the cut:");

    process.env.MAIL_FROM = "Storeasy <hello@mail.example.test>";
    const platformMail = await withBrowser([{ id: "m2" }], {}, async (calls) => {
      await sendMail({ to: "founder@x.test", subject: "Invite", text: "hi" });
      return calls[0].body.from;
    });
    eq(platformMail, "Storeasy <hello@mail.example.test>", "invitations and password resets stay the platform's:");
  } finally {
    for (const [k, v] of [["RESEND_API_KEY", env.key], ["MAIL_FROM", env.from]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
