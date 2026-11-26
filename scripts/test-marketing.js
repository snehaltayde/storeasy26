// Marketing-site suite (Session 44 / MK01–08): host detection (never leaks a
// tenant), pricing-from-the-live-plan-catalog (no drift by construction),
// honest kit gallery data, lead capture (consent flags, durable store).
//   pnpm test:marketing
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.DATABASE_URL = "file:.test-mkt-default.db";
process.env.PLATFORM_DB_URL = "file:.test-mkt-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_SITE_HOSTS = "www.storeasy.test, Site.Localhost:3007";

const dbs = [".test-mkt-default.db", ".test-mkt-platform.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { isPlatformSiteHost, platformSiteHosts } = await import("../lib/platform-site.js");
const B = await import("../lib/platform/billing.js");
const { KITS } = await import("../lib/themes/kits.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

console.log("— host detection (MK gate)");

await t("marketing hosts match case-insensitively, with and without port; everything else is NOT marketing", async () => {
  eq(platformSiteHosts().join(","), "www.storeasy.test,site.localhost:3007", "normalized:");
  eq(isPlatformSiteHost("WWW.Storeasy.TEST"), true);
  eq(isPlatformSiteHost("www.storeasy.test:443"), true, "bare-host fallback:");
  eq(isPlatformSiteHost("site.localhost:3007"), true);
  eq(isPlatformSiteHost("beastlife.in"), false, "tenant host:");
  eq(isPlatformSiteHost("localhost:3007"), false, "env-default host:");
  eq(isPlatformSiteHost(""), false);
  eq(isPlatformSiteHost(null), false);
});

console.log("— pricing (MK02: live catalog, no drift)");

await t("pricing reads the SAME rows billing charges from — a version bump shows immediately", async () => {
  await B.ensureDefaultPlans();
  const before = await B.listPlans();
  eq(before.find((p) => p.id === "starter").price, 999900);
  await B.createPlanVersion("starter", { name: "Launch", price: 1199900, features: { orders_per_month: 1200, staff_seats: 5 } });
  const after = await B.listPlans();
  const starter = after.find((p) => p.id === "starter");
  eq(starter.price, 1199900, "new version serves:");
  eq(starter.version, 2);
  eq(after.filter((p) => p.id === "starter").length, 1, "one ACTIVE version listed:");
});

await t("public tiers: Launch, Growth, Scale from the catalog, cheapest first, the internal free plan never listed; Enterprise has no price and both pages read it", async () => {
  eq(B.DEFAULT_PLANS.map((p) => `${p.id}:${p.name}:${p.price}`).join(" "), "free:Free:0 starter:Launch:999900 growth:Growth:2499900 scale:Scale:6000000", "the catalog's defaults (whole paise):");
  const listed = await B.listPublicPlans();
  eq(listed.map((p) => p.name).join(","), "Launch,Growth,Scale", "listed, cheapest first:");
  ok(listed.every((p) => p.price > 0 && Number.isInteger(p.price)), "a listed plan with no price");
  ok((await B.listPlans()).some((p) => p.id === "free" && p.price === 0), "the internal free plan is gone: stores with no subscription are entitled to it");
  eq(B.ENTERPRISE_PLAN.price, null, "Enterprise is priced:");
  for (const f of ["components/site/MarketingHome.js", "app/(storefront)/pricing/page.js"]) {
    const src = await readFile(join(here, "..", f), "utf8");
    ok(/B\.listPublicPlans\(\)/.test(src) && /B\.ensureDefaultPlans\(\)/.test(src) && /B\.ENTERPRISE_PLAN/.test(src), `${f} does not read the public tiers and Enterprise from the catalog`);
    ok(!/B\.listPlans\(\)/.test(src), `${f} lists every plan, the internal free one included`);
  }
  ok(/import LeadForm from "@\/components\/site\/LeadForm"/.test(await readFile(join(here, "../app/(storefront)/pricing/page.js"), "utf8")), "/pricing's Enterprise does not lead to the lead form");
});

console.log("— template gallery (MK03: honest)");

await t("gallery data = the live kit registry (2 available kits, versioned)", async () => {
  const kits = Object.values(KITS);
  eq(kits.length, 2);
  for (const k of kits) {
    ok(k.version >= 1 && k.label && k.vertical && k.swatch.length >= 2, `${k.id} complete`);
  }
});

console.log("— lead capture (MK08: durable + consent-aware)");

await t("leads store with the SEPARATE marketing opt-in defaulting to 0", async () => {
  const db = C.platformDb();
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO leads (id, name, email, store_url, message, marketing_consent, source, created_at) VALUES ('ld1','Pat','pat@brand.in','brand.myshopify.com','hello', 0, '/contact', ?)",
    args: [now],
  });
  await db.execute({
    sql: "INSERT INTO leads (id, name, email, marketing_consent, source, created_at) VALUES ('ld2','Sam','sam@brand.in', 1, '/pricing', ?)",
    args: [now],
  });
  const rows = (await db.execute("SELECT id, marketing_consent FROM leads ORDER BY id")).rows;
  eq(rows.length, 2);
  eq(Number(rows[0].marketing_consent), 0, "contact-only default:");
  eq(Number(rows[1].marketing_consent), 1, "explicit opt-in stored:");
});

console.log("— landing page (platform home: claims, copy, calculator)");

const L = await import("../components/site/landing-copy.js");
const { scanText, BANNED } = await import("../lib/copy/banned-copy.js");
const ROOT = join(here, "..");

await t("every visible string on the landing page passes the banned-copy and claims scan", async () => {
  const texts = L.visibleStrings();
  ok(texts.length > 80, `only ${texts.length} strings read`);
  const hits = texts.flatMap((s) => scanText(s).map((h) => `${h.rule} (${h.match}) in "${s.slice(0, 60)}"`));
  eq(hits.join("\n"), "", "findings:");
  // the scan bites: a planted claim is found
  ok(scanText("Rated #1, guaranteed").length >= 2, "the scan found nothing in a planted claim");
  ok(BANNED.length > 10);
});

await t("the landing page's components hold no visible text outside landing-copy.js (so the scan above covers it)", async () => {
  for (const f of ["components/site/MarketingHome.js", "components/site/StackCalculator.js", "components/site/MotionRoot.js", "components/site/LandingArt.js", "components/site/SiteNavBar.js"]) {
    const src = await readFile(join(ROOT, f), "utf8");
    const jsxText = [...src.replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").matchAll(/>\s*([A-Za-z][^<>{}();=]*?)\s*</g)].map((m) => m[1]).filter((s) => /[a-z]{3}/i.test(s));
    eq(JSON.stringify(jsxText), "[]", `${f} JSX text:`);
    for (const h of scanText(src.replace(/\/\/.*$/gm, ""), { claims: true })) ok(!/claim:/.test(h.rule), `${f}: ${h.rule} (${h.match})`);
  }
});

await t("every feature claim is a ticked line of docs/FEATURES.md or names a file that exists", async () => {
  const features = await readFile(join(ROOT, "docs/FEATURES.md"), "utf8");
  const ticked = features.split("\n").filter((l) => l.startsWith("- [x]"));
  const { existsSync } = await import("node:fs");
  const list = L.claims();
  ok(list.length >= 24, `only ${list.length} claims`);
  for (const c of list) {
    ok(c.ticked || c.file, `"${c.title}" names no source`);
    if (c.ticked) ok(ticked.some((l) => l.includes(c.ticked)), `"${c.title}": no ticked line holds "${c.ticked}"`);
    if (c.file) ok(existsSync(join(ROOT, c.file)), `"${c.title}": ${c.file} is missing`);
  }
  // the 16 things the page sells are all there
  const all = L.visibleStrings().join(" \n ");
  for (const w of ["verified buyers", "pause, skip, swap or cancel", "WhatsApp", "Shiprocket", "AI copilot", "buy X get Y", "free gifts", "coupons", "collection", "Cart nudges", "quizzes", "filters", "drag-and-drop", "five flagship themes", "upload a theme package", "one-time code", "PIN code", "saved address", "currency", "API tokens", "Webhooks"]) ok(all.toLowerCase().includes(w.toLowerCase()), `missing "${w}"`);
});

await t("speed claims: the Edge runtime is real, the measured numbers name their suites, no invented scores", async () => {
  const layout = await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  ok(/export const runtime = "edge"/.test(layout), "storefront layout is not edge");
  ok(/localFont/.test(await readFile(join(ROOT, "app/fonts/fonts.js"), "utf8")), "fonts are not self-hosted");
  const theme = await readFile(join(ROOT, "scripts/test-theme-render.js"), "utf8");
  ok(/median of 15/.test(theme) && /median of 15/.test(L.SPEED.measured[0].body), "theme timing context differs");
  const slots = await readFile(join(ROOT, "scripts/test-plugin-slots.js"), "utf8");
  ok(/n = 25/.test(slots) && /median of 25/.test(L.SPEED.measured[1].body), "slot timing context differs");
  ok(/not field data/.test(L.SPEED.measuredNote));
  const all = L.visibleStrings().join(" ");
  ok(!/lighthouse|\b\d+% (faster|more|higher)|conversion|load(s)? in \d/i.test(all), "an invented speed or uplift claim");
});

await t("no social proof; another app's price appears only from the sourced list (vendor, plan, page, day read); Storeasy's price only from the plan catalog", async () => {
  const all = L.visibleStrings().join(" ");
  ok(!/\b\d[\d,]* (merchants|stores|founders|brands|customers)\b|testimonial|trusted by/i.test(all), "a count or a testimonial in copy");
  // no figure is written in the copy: every price a visitor sees is formatted from data
  const money = /[₹$€£]\s?\d|\b(Rs\.?|INR|USD)\s?\d/i;
  ok(!money.test(all), "a price written into the copy");
  // the sourced list: every line has one app's public price, where it was read and when
  eq(L.STACK.length, 12, "kinds of app (the copy says twelve):");
  ok(/Twelve kinds of app/.test(L.CALC.stackCaption) && /Twelve kinds of app/.test(L.NAV.feature.body), "the copy's count of apps");
  eq(new Set(L.STACK.map((r) => r.id)).size, L.STACK.length, "ids repeat:");
  ok(/^\d{4}-\d{2}-\d{2}$/.test(L.PRICES_CHECKED) && !Number.isNaN(Date.parse(L.PRICES_CHECKED)), "PRICES_CHECKED is not a date");
  for (const row of L.STACK) {
    const p = row.price;
    ok(p && typeof p === "object", `${row.id}: no price, so it must not be a line at all`);
    ok(typeof p.vendor === "string" && p.vendor.trim() && typeof p.plan === "string" && p.plan.trim(), `${row.id}: no vendor or plan named`);
    ok(typeof p.amount === "number" && Number.isFinite(p.amount) && p.amount > 0, `${row.id}: amount ${p.amount}`);
    eq(p.currency, "INR", `${row.id} currency:`);
    ok(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//.test(p.url || ""), `${row.id}: no source url`);
    eq(p.checkedAt, L.PRICES_CHECKED, `${row.id} checkedAt:`);
    ok(p.basis === "listing" ? p.url.startsWith("https://apps.shopify.com/") : p.basis === "vendor", `${row.id}: basis "${p.basis}" does not match its url`);
    eq(JSON.stringify(Object.keys(p).sort()), JSON.stringify(["amount", "basis", "checkedAt", "currency", "plan", "url", "vendor"]), `${row.id} price fields:`);
  }
  eq(new Set(L.STACK.map((r) => r.price.url)).size, L.STACK.length, "two lines share one source:");
  // what the page shows is that list and nothing else
  eq(JSON.stringify(L.typicalValues()), JSON.stringify(Object.fromEntries(L.STACK.map((r) => [r.id, String(Math.round(r.price.amount))]))), "the calculator's defaults:");
  eq(L.typicalTotal(), L.STACK.reduce((n, r) => n + Math.round(r.price.amount), 0), "the bill's total:");
  const copySrc = (await readFile(join(ROOT, "components/site/landing-copy.js"), "utf8")).replace(/\/\/.*$/gm, "");
  eq((copySrc.match(/\bamount:/g) || []).length, L.STACK.length, "amounts written outside the sourced list:");
  ok(!money.test(copySrc), "landing-copy.js writes a price as text");
  const calc = await readFile(join(ROOT, "components/site/StackCalculator.js"), "utf8");
  ok(/useState\(typicalValues\)/.test(calc) && /row\.price\.vendor/.test(calc), "the calculator does not start from the sourced list, or hides whose price it is");
  const home = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  ok(/href=\{row\.price\.url\}/.test(home) && /row\.price\.checkedAt/.test(home) && /row\.price\.vendor/.test(home) && /row\.price\.plan/.test(home), "the page does not show each price's vendor, plan, source and day");
  for (const f of ["components/site/MarketingHome.js", "components/site/StackCalculator.js", "components/site/landing-copy.js", "components/site/LandingArt.js", "components/site/SiteNavBar.js", "components/site/SiteNav.js", "app/(storefront)/pricing/page.js"]) {
    const src = (await readFile(join(ROOT, f), "utf8")).replace(/\/\/.*$/gm, "");
    ok(!money.test(src), `${f} writes a price as text`);
    ok(!/\b(999900|2499900|6000000|9,?999|24,?999|60,?000)\b/.test(src), `${f} holds a plan price`);
  }
});

await t("header: a floating pill with a Product menu and a small-screen sheet, both disclosures that close on Escape and are inert when shut; its words pass the copy scan", async () => {
  const nav = await readFile(join(ROOT, "components/site/SiteNav.js"), "utf8");
  ok(/import SiteNavBar from "\.\/SiteNavBar"/.test(nav) && /<SiteNavBar>/.test(nav), "the header is not the nav island");
  const bar = await readFile(join(ROOT, "components/site/SiteNavBar.js"), "utf8");
  ok(/^"use client";/.test(bar), "the nav island is not a client component");
  eq((bar.match(/aria-expanded=\{/g) || []).length, 2, "disclosure buttons:");
  eq((bar.match(/aria-controls=\{/g) || []).length, 2, "buttons that name their panel:");
  eq((bar.match(/inert=\{!/g) || []).length, 2, "panels inert when shut:");
  ok(/e\.key !== "Escape"/.test(bar) && /\.current\?\.focus\(\)/.test(bar), "Escape does not close and return focus");
  ok(/aria-label=\{sheetOpen \? NAV\.close : NAV\.menu\}/.test(bar), "the sheet's button has no name");
  ok(/data-scrolled=/.test(bar) && /group-data-\[scrolled\]\/nav:max-w-/.test(bar), "the pill does not draw in on scroll");
  ok(/aria-current=\{pathname === l\.href \? "page" : undefined\}/.test(bar), "the current page is not marked");
  ok(!/["'](gsap|lenis)/.test(bar), "the header loads a motion library on every marketing page");
  eq(L.NAV.items.length, 6);
  for (const item of [...L.NAV.items, L.NAV.feature]) ok(/^\/#[a-z]+$/.test(item.href), `${item.href} is not a section of the home`);
  const homeSrc = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  for (const item of L.NAV.items) ok(homeSrc.includes(`id="${item.href.slice(2)}"`), `the home has no section ${item.href}`);
});

await t("hero (v4b): one sans headline, a glass deck in place of the receipt, the whole bill still read out, and no pointer disc", async () => {
  const home = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  const css = await readFile(join(ROOT, "components/site/landing.css"), "utf8");
  const motion = await readFile(join(ROOT, "components/site/MotionRoot.js"), "utf8");
  ok(/\.mk \.mk-hero-title \{\s*font-family: var\(--font-geist-sans\)/.test(css), "the hero headline is not in the page's sans");
  for (const gone of ["mk-receipt", "mk-paper", "mk-stamp", "mk-strike", "mk-cursor", 'data-pin~="bill"']) ok(!css.includes(gone) && !home.includes(gone) && !motion.includes(gone), `${gone} is still here`);
  ok(/return null;/.test(motion) && !/<div/.test(motion), "the motion island draws something (the pointer disc is gone)");
  const deck = home.slice(home.indexOf("function Deck("), home.indexOf("function Heading("));
  ok(/data-deck=""/.test(deck) && /data-deck-queue=""/.test(deck) && /data-deck-built=""/.test(deck), "the deck has nothing for the motion island to turn");
  ok(/<ul className="sr-only">\s*\{STACK\.map/.test(deck) && /<div aria-hidden="true">/.test(deck), "a screen reader does not get the whole bill once, in order");
  ok(/typicalTotal\(\)/.test(deck) && /inr\(from\.price\)/.test(deck) && /href="#calculator"/.test(deck), "the deck's two figures are not the sourced total and the catalog's plan, or it does not lead to the sources");
  ok(/function deck\(/.test(motion) && /pointerenter/.test(motion) && /cloneNode\(true\)/.test(motion) && /row\.remove\(\)/.test(motion), "the deck's loop cannot be held, or leaves its copies behind");
  // at rest the panel shows the first features and the queue the apps after them
  ok(/const QUEUE = \[\.\.\.STACK\.slice\(0, SHOWN\)\.reverse\(\), \.\.\.STACK\.slice\(SHOWN\)\.reverse\(\)\];/.test(home) && /const BUILT = \[\.\.\.STACK\]\.reverse\(\);/.test(home), "the deck's lists are not in the order its loop needs");
  ok(/--n: 4;/.test(css.slice(css.indexOf(".mk-deck-built {"))) && /const SHOWN = 4;/.test(home), "the panel's window and SHOWN differ");
});

await t("artwork: every section has a picture, drawn in markup (no image file, no request), hidden from screen readers, its words from the scanned copy", async () => {
  const art = await readFile(join(ROOT, "components/site/LandingArt.js"), "utf8");
  const home = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  for (const name of ["ArtStudio", "ArtThemes", "ArtFilters", "ArtCopilot", "ArtApps", "ArtSell", "ArtCheckout", "ArtGlobe", "ArtControl", "ArtStack", "ArtShop", "TierBars"]) {
    ok(new RegExp(`export function ${name}\\(`).test(art), `${name} is not drawn`);
    ok(new RegExp(`\\b${name}\\b`).test(home.slice(home.indexOf("export default"))) || new RegExp(`${name}[,\\s}]`).test(home.slice(home.indexOf("const BENTO"), home.indexOf("export default"))), `${name} is not on the page`);
  }
  ok(!/<img|next\/image|StoreImage|url\(["']?https?:|href=["']https?:/.test(art), "the artwork fetches a file");
  const pictures = art.split(/^export function /m).slice(1).filter((f) => /^Art(?!Defs)/.test(f));
  for (const f of pictures) ok(/aria-hidden="true"/.test(f), `${f.slice(0, 12)} is read out by a screen reader`);
  ok(/data-art/.test(art) && /data-pop/.test(art) && /data-stroke/.test(art) && /data-grow/.test(art), "the artwork has nothing for the motion island to play");
  const motion = await readFile(join(ROOT, "components/site/MotionRoot.js"), "utf8");
  for (const a of ["data-art", "data-pop", "data-stroke", "data-grow"]) ok(motion.includes(`"${a}"`) || motion.includes(`[${a}]`), `MotionRoot does not play ${a}`);
  // each rail panel and each small list names a picture that exists
  for (const f of L.SELL.items) ok(new RegExp(`^  ${f.id}: \\(`, "m").test(art), `no picture for "${f.title}"`);
  for (const f of [...L.YOURS.items, ...L.SELL.items, ...L.INDIA.items, ...L.SPEED.items, ...L.SAFETY.items, ...L.STACK]) ok(new RegExp(`\\b${f.id}: [A-Z]`).test(art), `no glyph for ${f.id}`);
});

await t("brand and motion: the logo is on the shared header and footer with an alt, the scheme is scoped to .mk, and reduced motion turns every animation off", async () => {
  const { existsSync } = await import("node:fs");
  ok(existsSync(join(ROOT, "public/brand/storeasy-by-mediastic.png")), "the logo file is missing");
  const nav = await readFile(join(ROOT, "components/site/SiteNav.js"), "utf8");
  ok(/import StoreImage from "@\/components\/StoreImage"/.test(nav) && /<StoreImage src="\/brand\/storeasy-by-mediastic\.png" alt="Storeasy by mediaStic" width=\{[^}]+\} height=\{height\}/.test(nav), "the logo is not a sized next/image (through StoreImage) with its alt");
  ok(/export default function SiteNav/.test(nav) && /export function SiteFooter/.test(nav) && (nav.match(/<Logo /g) || []).length === 2, "the logo is not on both the header and the footer");
  const layout = await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8");
  ok(/<body className="mk /.test(layout) && /<SiteFooter \/>/.test(layout), "the marketing body does not carry .mk or the shared footer");
  eq((layout.match(/className="mk /g) || []).length, 1, "only the marketing body carries .mk:");
  // the shared sheet rides in globals.css; the landing page's own sheet is loaded by the landing page only
  const shared = await readFile(join(ROOT, "app/marketing.css"), "utf8");
  const landing = await readFile(join(ROOT, "components/site/landing.css"), "utf8");
  const home = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  ok(/^import "\.\/landing\.css";$/m.test(home), "the landing page does not load its own stylesheet");
  ok(!/landing\.css/.test(await readFile(join(ROOT, "app/globals.css"), "utf8")), "landing.css rides in globals.css, so every store page downloads it");
  ok(shared.split("\n").length < 200, "app/marketing.css has grown: landing-only rules belong in components/site/landing.css");
  for (const [name, css] of [["app/marketing.css", shared], ["components/site/landing.css", landing]]) {
    // every rule that sets a token or draws is under .mk or an mk- class; no store token is set
    ok(!/(^|[\s{;])--(sf-|accent-|background|foreground|header-|hero-)[\w-]*\s*:/m.test(css), `${name} sets a store brand token`);
    ok(!/^\s*(:root|html|body)\b/m.test(css), `${name} styles the root, which stores share`);
  }
  const reduced = shared.slice(shared.indexOf("@media (prefers-reduced-motion: reduce)"));
  ok(reduced.length > 100 && /\.mk \*,[\s\S]*animation: none !important/.test(reduced) && /transition: none !important/.test(reduced), "reduced motion does not stop the animations");
  // the stylesheet draws the finished page: outside keyframes nothing but the pointer's disc starts hidden
  const atRest = landing.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  eq((atRest.match(/opacity: 0;|visibility: hidden|display: none/g) || []).length - (atRest.match(/\.mk-cursor \{[^}]*opacity: 0;/g) || []).length, (atRest.match(/display: none/g) || []).length, "landing.css hides content at rest:");
  for (const m of atRest.matchAll(/([^{}]+)\{[^{}]*display: none[^{}]*\}/g)) ok(/mk-cursor|mk-path-track|mk-rail-bar|mk-cols/.test(m[1]), `landing.css hides ${m[1].trim()}`);
  const motion = await readFile(join(ROOT, "components/site/MotionRoot.js"), "utf8");
  ok(/prefers-reduced-motion: reduce\)"\)\.matches\) return/.test(motion), "the motion island runs under reduced motion");
  ok(motion.indexOf('prefers-reduced-motion: reduce)").matches) return') < motion.indexOf('import("gsap")'), "the motion libraries are fetched before reduced motion is checked");
  ok(/prefers-reduced-motion: reduce/.test(await readFile(join(ROOT, "components/site/StackCalculator.js"), "utf8")), "the calculator's count-up ignores reduced motion");
  // GSAP and Lenis (docs/DECISIONS.md) are fetched by the landing page's motion island and nowhere else: no store page carries them
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  ok(pkg.dependencies?.gsap && pkg.dependencies?.lenis, "gsap and lenis are not dependencies");
  for (const dep of ["framer-motion", "motion", "lottie-web", "animejs", "three"]) ok(!pkg.dependencies?.[dep] && !pkg.devDependencies?.[dep], `${dep} was added`);
  ok(!/^import [^;]*["'](gsap|lenis)/m.test(motion) && /import\("gsap"\)/.test(motion) && /import\("lenis"\)/.test(motion), "the motion island must fetch gsap and lenis lazily, not import them at the top");
  const { readdir } = await import("node:fs/promises");
  const users = [];
  for (const dir of ["app", "components", "lib"]) {
    for (const f of await readdir(join(ROOT, dir), { recursive: true })) {
      if (!/\.(js|jsx|ts|tsx|mjs)$/.test(f)) continue;
      if (/["'](gsap|lenis)(\/[^"']*)?["']/.test(await readFile(join(ROOT, dir, f), "utf8"))) users.push(`${dir}/${f}`);
    }
  }
  eq(JSON.stringify(users), JSON.stringify(["components/site/MotionRoot.js"]), "files that load gsap or lenis:");
});

await t("calculator: blanks count as nothing, bad input is named, monthly and yearly add up, the plan is compared in rupees", async () => {
  const e = L.stackTotals({});
  eq(e.entered, 0);
  eq(e.monthly, 0);
  const r = L.stackTotals({ ratings: "1,500", whatsapp: " 2000 ", quiz: "", search: "abc", builder: "-5" }, 99900);
  eq(r.entered, 2);
  eq(r.monthly, 3500);
  eq(r.yearly, 42000);
  eq(r.invalid.join(","), "search,builder");
  eq(r.plan, 999);
  eq(r.difference, 2501);
  eq(L.stackTotals({ a: "100" }, 99900).difference, -899, "a plan dearer than the apps:");
  eq(L.stackTotals({ a: "₹49.50" }, null).plan, null, "no plan read:");
  eq(L.stackTotals({ a: "₹49.50" }).monthly, 49.5);
  // the standard estimate against the cheapest listed plan, in rupees
  const launch = B.DEFAULT_PLANS.find((p) => p.id === "starter").price;
  const std = L.stackTotals(L.typicalValues(), launch);
  eq(std.entered, L.STACK.length);
  eq(std.monthly, L.typicalTotal());
  eq(std.difference, L.typicalTotal() - launch / 100);
});

await t("the landing page reaches no node: module from the edge home (billing's imports included)", async () => {
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const { existsSync } = await import("node:fs");
  const local = (from, spec) => {
    const p = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : join(dirname(join(ROOT, from)), spec);
    for (const c of [p, `${p}.js`, join(p, "index.js")]) if (/\.js$/.test(c) && existsSync(c)) return c.slice(ROOT.length + 1);
    return null;
  };
  const queue = ["components/site/MarketingHome.js"];
  const seen = new Set();
  const hits = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = await readFile(join(ROOT, f), "utf8");
    for (const m of src.matchAll(nodeImport)) hits.add(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']((?:\.|@\/)[^"']+)["']/gm)) {
      const r = local(f, m[1]);
      if (r) queue.push(r);
    }
  }
  ok(seen.has("lib/platform/billing.js"), "billing.js not reached");
  eq(JSON.stringify([...hits]), JSON.stringify(["lib/tenant-context.js: node:async_hooks"]), "node imports reached:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
