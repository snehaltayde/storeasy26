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
  eq(before.find((p) => p.id === "starter").price, 99900);
  await B.createPlanVersion("starter", { name: "Starter", price: 119900, features: { orders_per_month: 600, staff_seats: 5 } });
  const after = await B.listPlans();
  const starter = after.find((p) => p.id === "starter");
  eq(starter.price, 119900, "new version serves:");
  eq(starter.version, 2);
  eq(after.filter((p) => p.id === "starter").length, 1, "one ACTIVE version listed:");
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
  for (const f of ["components/site/MarketingHome.js", "components/site/StackCalculator.js", "components/site/MotionRoot.js"]) {
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

await t("no social proof and no prices on the page: no testimonials, counts or app prices; Storeasy's price only from the plan catalog", async () => {
  const all = L.visibleStrings().join(" ");
  ok(!/₹\s?\d|\$\s?\d|\b\d[\d,]* (merchants|stores|founders|brands|customers)\b|testimonial|trusted by/i.test(all), "a price or count in copy");
  const home = await readFile(join(ROOT, "components/site/MarketingHome.js"), "utf8");
  ok(/B\.listPlans\(\)/.test(home) && /B\.ensureDefaultPlans\(\)/.test(home), "the home doesn't read the plan catalog as /pricing does");
  for (const f of ["components/site/MarketingHome.js", "components/site/StackCalculator.js", "components/site/landing-copy.js"]) {
    const src = (await readFile(join(ROOT, f), "utf8")).replace(/\/\/.*$/gm, "");
    ok(!/\b(99900|299900|999|2999)\b/.test(src), `${f} holds a plan price`);
  }
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
  const css = await readFile(join(ROOT, "app/marketing.css"), "utf8");
  // every rule that sets a token or draws is under .mk or an mk- class; no store token is set
  ok(!/(^|[\s{;])--(sf-|accent-|background|foreground|header-|hero-)[\w-]*\s*:/m.test(css), "marketing.css sets a store brand token");
  ok(!/^\s*(:root|html|body)\b/m.test(css), "marketing.css styles the root, which stores share");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  ok(reduced.length > 100 && /animation: none !important/.test(reduced) && /transition: none !important/.test(reduced) && /\[data-reveal\][\s\S]*opacity: 1 !important/.test(reduced), "reduced motion does not stop the animations and show the content");
  const motion = await readFile(join(ROOT, "components/site/MotionRoot.js"), "utf8");
  ok(/prefers-reduced-motion: reduce\)"\)\.matches\) return/.test(motion), "the motion island runs under reduced motion");
  ok(/prefers-reduced-motion: reduce/.test(await readFile(join(ROOT, "components/site/StackCalculator.js"), "utf8")), "the calculator's count-up ignores reduced motion");
  // no animation library came in with the redesign
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  for (const dep of ["framer-motion", "motion", "gsap", "lottie-web", "animejs", "three"]) ok(!pkg.dependencies?.[dep] && !pkg.devDependencies?.[dep], `${dep} was added`);
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
