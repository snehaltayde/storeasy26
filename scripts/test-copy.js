// Shopper-visible copy suite (GEN-03): no wrong-brand or developer text reaches
// shoppers. Three layers, because plain Node can't import JSX on its own:
//   1. a scan of storefront source for banned strings (comments ignored);
//   2. real pages and components compiled with Next's SWC and rendered with
//      react-dom/server, against an empty tenant database;
//   3. the shipping honesty rules (display only, charges pinned).
// Every layer proves it can fail, on planted text, inside this file.
// The full inventory and its decisions: docs/storefront-copy-inventory.md.
//   pnpm test:copy
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-copy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-copy-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-copy-default.db", ".test-copy-platform.db", ".test-copy-t1.db", ".test-copy-t2.db", ".test-copy-bl.db"];
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

const BANNED = [
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
  { label: "developer: env file", re: /\.env\.local/i },
  { label: "developer: env instruction", re: /set NEXT_PUBLIC_/i },
  { label: "developer: test mode", re: /\(test mode\)/i },
  { label: "developer: HTTP status in copy", re: /\(HTTP \$\{/ },
  { label: "developer: automation rule name", re: /automated rule/i },
  { label: "platform: by the platform", re: /by the platform/i },
  { label: "platform: Razorpay in copy", re: /(via Razorpay|load Razorpay|Razorpay is not configured|"Razorpay"\})/ },
  { label: "wrong brand: BeastLife", re: /beastlife/i },
  { label: "wrong brand: Beast", re: /\bbeast\b/i },
  { label: "wrong brand: coupon code", re: /\b(BEAST10|FLAT200|SOLO25)\b/ },
  { label: "wrong voice: fresh drops", re: /fresh drops/i },
  { label: "wrong vertical: nutrition word", re: /\b(whey|pre-workouts?|proteins?|creatine)\b/i },
  { label: "unset promise: delivery or refund days", re: /\d+\s*[–-]\s*\d+ (business|working) days/i },
  { label: "unset promise: tax claim", re: /incl\. GST/i },
];

// Each entry names one file and the exact text allowed there, with the reason.
// An entry that stops matching fails the suite, so this list can't go stale.
const ALLOWED = [
  { file: "lib/site.js", re: /\|\| "BeastLife"/, why: "reached only with no tenant context: the legacy env store IS BeastLife" },
  { file: "lib/content/pages.js", re: /./, why: "BeastLife's own pages; brandDefaultsApply() gates them (tested below)" },
  { file: "lib/offers/config.js", re: /./, why: "BeastLife's own offers; seeded only by its bootstrap (test-platform-sync)" },
  { file: "lib/themes/kits.js", re: /Proteins, pre-workouts/, why: "Pulse kit preset: applied only when a founder picks that nutrition kit and accepts its copy" },
  { file: "lib/offers/simulate.js", re: /./, why: "console offer simulator fixtures, never rendered to shoppers" },
  { file: "lib/content/templates.js", re: /\d–\d working days/, why: "console prefill a founder edits and saves; GEN-06 binds it to real settings" },
  { file: "lib/cms/store.js", re: /\["_default", "beastlife", "beastlife-staging"\]/, why: "tenant ids in the check that keeps BeastLife's pages on BeastLife" },
  { file: "lib/env-file.js", re: /\.env\.local/, why: "local CLI helper, not imported by any route" },
  { file: "lib/integrations.js", re: /pnpm webhooks:register/, why: "connect hint for the operator console" },
  { file: "lib/shopify-push.js", re: /paid via Razorpay/, why: "order note in Shopify admin, read by store staff; never content for shoppers" },
  { file: "lib/shopify.js", re: /\.env\.local/, why: "sync-only errors (lib/sync.js is its only importer), for operators" },
  { file: "lib/automations.js", re: /automated rule "/, why: "notify_merchant only; the email_customer branch omits it (test-w6)" },
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

// Blank comments, keeping line numbers. A "/*" or "//" only opens a comment after
// whitespace or a bracket, so "image/*" and "https://" stay code. If this ever
// misreads, it errs towards scanning more.
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/(^|[\s{(;,])\/\*[\s\S]*?\*\//g, (m, lead) => lead + blank(m.slice(lead.length)))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead) => lead + blank(m.slice(lead.length)));
}

function scanSource(file, src) {
  const findings = [];
  const allowed = ALLOWED.filter((a) => a.file === file);
  stripComments(src)
    .split("\n")
    .forEach((text, i) => {
      for (const { label, re } of BANNED) {
        if (!re.test(text)) continue;
        if (allowed.some((a) => a.re.test(text))) continue;
        findings.push({ file, line: i + 1, label, text: text.trim().slice(0, 120) });
      }
    });
  return findings;
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

await t(`banned strings: none in ${sources.size} storefront source files`, () => {
  const findings = [...sources].flatMap(([f, src]) => scanSource(f, src));
  ok(findings.length === 0, `\n    ${report(findings)}`);
});

await t("the scan covers the surfaces it claims to", () => {
  for (const f of ["app/(storefront)/page.js", "app/(storefront)/error.js", "components/Footer.js", "components/cart/CartDrawer.js", "components/checkout/CheckoutFlow.js", "lib/site.js", "lib/cms/defaults.js", "app/api/checkout/route.js", "app/api/account/route.js"]) {
    ok(sources.has(f), `${f} is not scanned`);
  }
  ok(![...sources.keys()].some((f) => f.startsWith("components/admin/")), "console files must stay out of the shopper scan");
});

await t("the scan fails: each banned rule catches planted text", () => {
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
    "developer: env file": "see .env.local",
    "developer: env instruction": "Set NEXT_PUBLIC_RAZORPAY_KEY_ID to enable.",
    "developer: test mode": "card (test mode)",
    "developer: HTTP status in copy": "failed (HTTP ${status})",
    "developer: automation rule name": 'automated rule "x"',
    "platform: by the platform": "paused by the platform",
    "platform: Razorpay in copy": "Secure payment via Razorpay.",
    "wrong brand: BeastLife": "About BeastLife",
    "wrong brand: Beast": "Go Beast mode",
    "wrong brand: coupon code": "try BEAST10",
    "wrong voice: fresh drops": "Fresh drops",
    "wrong vertical: nutrition word": "Whey for you",
    "unset promise: delivery or refund days": "in 5–7 business days",
    "unset promise: tax claim": "prices incl. GST",
  };
  eq(Object.keys(samples).length, BANNED.length, "one sample per rule:");
  for (const { label } of BANNED) {
    const found = scanSource("components/Footer.js", `export const x = "${samples[label]}";`);
    ok(found.some((f) => f.label === label), `rule "${label}" missed its sample`);
  }
});

await t("the scan fails: planted text in a real file, outside any comment", () => {
  const planted = sources.get("app/(storefront)/collections/page.js").replace("please check back soon.", "run pnpm sync.");
  ok(scanSource("app/(storefront)/collections/page.js", planted).some((f) => f.label.includes("pnpm")), "planted pnpm not caught");
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

await t("checkout shows only errors written for shoppers", () => {
  const src = sources.get("components/checkout/CheckoutFlow.js");
  ok(!/return data\.error \|\|/.test(src), "friendlyCheckoutError forwards raw server errors again");
  ok(!/setError\(v\.error/.test(src), "the payment-verify handler forwards a raw server error again");
});

// ---- layer 2: real pages, rendered -------------------------------------------

const C = await import("../lib/platform/control.js");
const { withTenant, tenantShippingConfig } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const repo = await import("../lib/repo.js");
const sectionData = await import("../lib/cms/section-data.js");
const experiments = await import("../lib/experiments.js");
const platformSite = await import("../lib/platform-site.js");
const format = await import("../lib/format.js");
const shippingLib = await import("../lib/shipping.js");
const site = await import("../lib/site.js");
const { createCart, getCart } = await import("../lib/cart.js");

const OWN_RATES = { currency: "INR", basis: "net", freeThreshold: 5000, flatRate: 50, codFee: 0, codFeeWaivedAt: null, zones: [] };
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "shop", name: "Acme Candles", domains: ["shop.test"], dbUrl: "file:.test-copy-t1.db", config: {}, secrets: {} });
await C.upsertTenant({ id: "own-rates", name: "Own Rates", domains: ["own.test"], dbUrl: "file:.test-copy-t2.db", config: { shipping_config: OWN_RATES }, secrets: {} });
await C.upsertTenant({ id: "beastlife", name: "BeastLife", domains: ["bl.test"], dbUrl: "file:.test-copy-bl.db", config: { site: { name: "BeastLife", tagline: "Train harder." } }, secrets: {} });
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const id of ["shop", "own-rates", "beastlife"]) {
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inShop = async (fn) => withTenant(await C.getTenant("shop"), fn);
const inOwn = async (fn) => withTenant(await C.getTenant("own-rates"), fn);
const inBl = async (fn) => withTenant(await C.getTenant("beastlife"), fn);

// Compile a JSX .js file with the SWC build Next itself uses, then evaluate it
// with explicit stubs for its imports. An unstubbed import throws, so a new
// dependency can't quietly skip the render.
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
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
    if (id === "react/jsx-runtime") return JSX_RUNTIME;
    if (id === "react") return React;
    if (id in stubs) return stubs[id];
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

const realEmptyCatalog = await readFile(join(ROOT, "components/EmptyCatalog.js"), "utf8");
async function renderEmptyHome(emptyCatalogSrc = realEmptyCatalog) {
  const page = await loadComponent(await readFile(join(ROOT, "app/(storefront)/page.js"), "utf8"), {
    "next/link": passthrough,
    "next/headers": { headers: async () => ({ get: () => "shop.test" }), cookies: async () => ({ get: () => undefined }) },
    "@/components/EmptyCatalog": await loadComponent(emptyCatalogSrc),
    "@/components/ExperimentPing": nothing,
    "@/components/site/MarketingHome": nothing,
    "@/components/sections/HomeSections": nothing,
    "@/lib/experiments": experiments,
    "@/lib/platform-site": platformSite,
    "@/lib/repo": repo,
    "@/lib/cms/section-data": sectionData,
    // resolve.js needs a request; a store with no release reads drafts, which is these getters
    "@/lib/content/resolve": { resolvedHero: S.getHero, resolvedHomeSections: S.getHomeSections, resolvedCollectionsIndex: S.getCollectionsIndex },
    "@/lib/tenant-request": { tfetch: inShop },
  });
  return renderToStaticMarkup(await page.default());
}

await t("empty catalog (rendered): home shows a shopper message and no developer command", async () => {
  eq((await inShop(repo.getCatalogStats)).products, 0, "the fixture store really is empty:");
  const html = await renderEmptyHome();
  assertClean(html, "empty home");
  ok(html.includes("New products are on the way"), "the shopper message is missing");
  ok(html.includes("Coming soon"), "the empty badge is missing");
  ok(html.includes("Acme Candles"), "the hero should still carry the store's own name");
});

await t("empty catalog can fail: the old developer block is caught when rendered", async () => {
  const old = 'export default function E() { return <section><h2>Catalog not synced yet</h2><pre><code>pnpm migrate{"\\n"}pnpm sync</code></pre></section>; }';
  let caught = null;
  try {
    assertClean(await renderEmptyHome(old), "empty home");
  } catch (e) {
    caught = e.message;
  }
  ok(caught && /pnpm/.test(caught), `the regression passed unnoticed: ${caught}`);
});

await t("empty catalog (rendered): collections index shows no developer command", async () => {
  const page = await loadComponent(await readFile(join(ROOT, "app/(storefront)/collections/page.js"), "utf8"), {
    "next/link": passthrough,
    "@/components/CollectionCard": nothing,
    "@/lib/repo": repo,
    "@/lib/content/resolve": { resolvedCollectionsIndex: S.getCollectionsIndex },
    "@/lib/tenant-request": { tfetch: inShop },
  });
  const html = renderToStaticMarkup(await page.default());
  assertClean(html, "empty collections");
  ok(html.includes("No collections to show yet"), "the shopper message is missing");
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
async function renderCheckout(props, src = sources.get("components/checkout/CheckoutFlow.js")) {
  const { default: CheckoutFlow } = await loadComponent(src, {
    "next/image": nothing,
    "next/link": passthrough,
    "@/lib/format": format,
    "@/lib/shipping": shippingLib,
    "@/lib/track/client": { track() {} },
  });
  return renderToStaticMarkup(React.createElement(CheckoutFlow, { cart: checkoutFixture, razorpayEnabled: true, storeName: "Acme", ...props }));
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

await t("checkout preview (rendered) shows the store's own rates, the same the server charges", async () => {
  const config = await inOwn(async () => tenantShippingConfig());
  eq(config.flatRate, 50, "the fixture store has its own rates:");
  const server = shippingLib.computeShipping({ subtotal: 500, discountTotal: 0, paymentMethod: "prepaid", pincode: null, config });
  eq(server.total, 50, "server charge:");
  const html = await renderCheckout({ shippingConfig: config });
  // The form opens on Cash on Delivery: this store has no COD fee, the code default does.
  ok(html.includes("₹50"), "the store's ₹50 rate is not shown");
  ok(html.includes("₹550"), "the total does not use the store's rate");
  ok(!html.includes("₹128") && !html.includes("₹628"), "the code default is shown on a store with its own rates");
});

await t("checkout preview can fail: dropping the store's rates is caught", async () => {
  const broken = sources.get("components/checkout/CheckoutFlow.js").replace(", config: shippingConfig }", " }");
  ok(broken !== sources.get("components/checkout/CheckoutFlow.js"), "the wiring this test targets has moved");
  const html = await renderCheckout({ shippingConfig: OWN_RATES }, broken);
  ok(html.includes("₹128") && !html.includes("₹550"), "the broken wiring rendered correct numbers");
});

await t("checkout preview: a store with no rates sees the starter charge it will really pay", async () => {
  eq(await inShop(async () => tenantShippingConfig()), undefined, "no rates set:");
  const html = await renderCheckout({ shippingConfig: undefined });
  eq(shippingLib.computeShipping({ subtotal: 500, paymentMethod: "cod" }).total, 128, "what the server charges for COD:");
  ok(html.includes("₹128") && html.includes("₹628"), "the real charge must stay visible");
});

await t("cart says whether the store chose its rates", async () => {
  const flag = async (inTenant) =>
    inTenant(async () => {
      const id = `cart-${Math.random()}`;
      await createCart(id);
      return (await getCart(id)).shippingRatesSet;
    });
  eq(await flag(inShop), false, "no shipping_config:");
  eq(await flag(inOwn), true, "own shipping_config:");
  eq(await flag(inBl), true, "BeastLife publishes these figures as its own policy:");
});

async function renderDrawer(ratesSet) {
  const shipping = shippingLib.computeShipping({ subtotal: 500 });
  const { default: CartDrawer } = await loadComponent(sources.get("components/cart/CartDrawer.js"), {
    "next/image": nothing,
    "next/link": passthrough,
    "@/lib/format": format,
    "./CartContext": {
      useCart: () => ({ ...checkoutFixture, count: 1, changes: [], shipping, shippingRatesSet: ratesSet, grandTotal: 579, open: true, setOpen() {}, addItem() {}, removeItem() {}, setQty() {}, setCoupon() {}, pending: false }),
    },
  });
  return renderToStaticMarkup(React.createElement(CartDrawer));
}

await t("cart drawer (rendered): the charge always shows, the free-shipping promise needs chosen rates", async () => {
  const starter = await renderDrawer(false);
  ok(starter.includes("₹79"), "the real charge must stay visible");
  ok(!/free shipping/i.test(starter), "a promise the store never made is shown");
  assertClean(starter, "cart drawer");
  const own = await renderDrawer(true);
  ok(own.includes("₹79") && /free shipping/i.test(own), "a store that chose its rates keeps the nudge");
});

await t("cart drawer (rendered): the empty state is neutral", async () => {
  const { default: CartDrawer } = await loadComponent(sources.get("components/cart/CartDrawer.js"), {
    "next/image": nothing,
    "next/link": passthrough,
    "@/lib/format": format,
    "./CartContext": { useCart: () => ({ items: [], gifts: [], appliedOffers: [], changes: [], count: 0, subtotal: 0, discountTotal: 0, total: 0, currency: "INR", open: true, setOpen() {}, pending: false }) },
  });
  const html = renderToStaticMarkup(React.createElement(CartDrawer));
  assertClean(html, "empty cart");
  ok(html.includes("Your cart is empty"), "the empty message is missing");
});

await t("the founder is told, and an unrelated save can't adopt starter rates", async () => {
  const { settingsView, buildSettingsPatch } = await import("../lib/admin/settings.js");
  eq(settingsView({ id: "t", config: {}, secrets: {} }).shipping_is_default, true, "no rates:");
  eq(settingsView({ id: "t", config: { shipping_config: OWN_RATES }, secrets: {} }).shipping_is_default, false, "own rates:");
  const patch = buildSettingsPatch({ identity: { name: "Acme" } }, {}).patch;
  ok(!("shipping_config" in patch.config), "a save without shipping must not write shipping_config");
  const admin = await readFile(join(ROOT, "components/admin/SettingsAdmin.js"), "utf8");
  ok(/s\.shipping_is_default && JSON\.stringify\(shipping\) === JSON\.stringify\(buildState\(s\)\.shipping\) \? \{\} : \{ shipping \}/.test(admin), "the console form sends starter rates back on every save again");
});

await t("account errors: our own messages show, internals don't", async () => {
  const { shopperErrorMessage } = await import("../lib/shopper-errors.js");
  const fallback = "Something went wrong — please try again.";
  eq(shopperErrorMessage(new Error("That code expired — request a new one."), fallback), "That code expired — request a new one.", "own copy:");
  const dbError = Object.assign(new Error("SQLITE_ERROR: no such table: customers"), { name: "LibsqlError", code: "SQLITE_ERROR" });
  eq(shopperErrorMessage(dbError, fallback), fallback, "database error:");
  eq(shopperErrorMessage(new TypeError("fetch failed"), fallback), fallback, "network error:");
  eq(shopperErrorMessage(Object.assign(new Error("boom"), { code: "X" }), fallback), fallback, "coded error:");
  eq(shopperErrorMessage(null, fallback), fallback, "nothing:");
});

await t("search API: no raw error text in its public response", () => {
  ok(!/error: String\(/.test(sources.get("app/api/search/route.js")), "the search route returns a raw error message again");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
