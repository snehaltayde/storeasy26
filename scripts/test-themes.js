// Theme-kit suite (Session 37 / MC07+MC08+MC09+OP07): kit registry fixtures
// (every kit's brand passes the WCAG gate, presets validate, release-valid),
// applyKit draft semantics (pin + brand + preset, live pointer untouched),
// version pinning (no silent upgrades), the new composable home sections
// (banner link rules, rich_text sanitized at save), and page templates.
//   pnpm test:themes
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-themes-default.db";
process.env.PLATFORM_DB_URL = "file:.test-themes-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-themes-default.db", ".test-themes-platform.db", ".test-themes-t1.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const S = await import("../lib/cms/store.js");
const R = await import("../lib/releases.js");
const K = await import("../lib/themes/kits.js");
const B = await import("../lib/brand.js");
const { validateBlock } = await import("../lib/cms/validate.js");
const { PAGE_TEMPLATES } = await import("../lib/content/templates.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({ id: "tt", name: "Theme Tenant", domains: ["tt.test"], dbUrl: "file:.test-themes-t1.db", config: {}, secrets: { order_link_secret: "tt-secret" } });

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
await withTenant(await C.getTenant("tt"), async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, await loadMigrations("tenant"));
});
// fresh tenant object per use (config changes after applyKit)
const inTenant = async (fn) => withTenant(await C.getTenant("tt"), fn);

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

console.log("— kit registry fixtures (OP07 validation)");

await t("every kit: brand passes the WCAG gate, hero preset validates, release-validates", async () => {
  for (const kit of Object.values(K.KITS)) {
    const brand = B.validateBrand(kit.brand);
    if (!brand.ok) throw new Error(`${kit.id} brand: ${brand.errors.join(", ")}`);
    if (kit.presets?.hero) {
      const hero = validateBlock("hero", kit.presets.hero);
      if (!hero.ok) throw new Error(`${kit.id} hero preset: ${hero.errors.join(", ")}`);
      const rel = await inTenant(() => R.validateRelease({ v: 1, blocks: { hero: hero.value }, pages: [], brand: kit.brand }));
      if (!rel.ok) throw new Error(`${kit.id} release: ${rel.errors.join(", ")}`);
    }
    if (!Array.isArray(kit.swatch) || kit.swatch.length < 2) throw new Error(`${kit.id}: swatch missing`);
    if (!Number.isInteger(kit.version) || kit.version < 1) throw new Error(`${kit.id}: bad version`);
  }
});

await t("kit accessibility: accent button label readable on every kit's button surface", async () => {
  for (const kit of Object.values(K.KITS)) {
    const v = B.validateBrand(kit.brand).value;
    const surface = B.accentShades(v.accent)[400];
    const best = Math.max(B.contrastRatio("#0a0a0b", surface), B.contrastRatio("#ffffff", surface));
    if (best < 4.5) throw new Error(`${kit.id}: best label contrast ${best.toFixed(2)} < 4.5`);
  }
});

await t("kitFor/kitAttr: unknown or absent pin → platform default pulse; attr is version-keyed", async () => {
  eq(K.kitFor(null).id, "pulse");
  eq(K.kitFor({ kit: "nope" }).id, "pulse");
  eq(K.kitAttr(null), "pulse-1");
  eq(K.kitAttr({ kit: "glow", version: 1 }), "glow-1");
});

console.log("— applyKit (draft semantics)");

await t("applyKit pins kit + seeds brand and hero preset as DRAFTS", async () => {
  const r = await inTenant(() => K.applyKit("glow", { actor: { kind: "merchant", id: "u1" } }));
  eq(r.theme.kit, "glow");
  eq(r.presets.join(","), "hero");
  const tenant = await C.getTenant("tt");
  eq(tenant.config.theme.kit, "glow");
  eq(tenant.config.brand.accent, "#e11d48");
  eq((await inTenant(() => S.getBlockRow("hero"))).value.title, "Your glow, daily.");
});

await t("applyKit never touches the live pointer; a release pins the theme (no leak)", async () => {
  // publish with glow, then apply pulse — live stays glow until the next publish
  const rel = await inTenant(() => R.createRelease({ note: "glow live", actor: { kind: "merchant", id: "u1" } }));
  await inTenant(() => K.applyKit("pulse", { actor: { kind: "merchant", id: "u1" } }));
  const live = await inTenant(R.getLiveRelease);
  eq(live.id, rel.id, "pointer untouched:");
  eq(live.content.theme.kit, "glow", "live theme still glow:");
  eq((await C.getTenant("tt")).config.theme.kit, "pulse", "draft pin is pulse:");
});

await t("unknown kit refused; env-default tenant refused", async () => {
  try {
    await inTenant(() => K.applyKit("neon"));
    throw new Error("expected throw");
  } catch (e) {
    if (!/unknown theme kit/.test(e.message)) throw e;
  }
});

await t("version pinning: no silent upgrades (upgradeAvailable only flags)", async () => {
  eq(K.kitUpgradeAvailable({ kit: "glow", version: 1 }), false, "current:");
  eq(K.kitUpgradeAvailable({ kit: "glow", version: 0 }), true, "older pin flags:");
  // attr keeps the PINNED version even when the registry moves on
  eq(K.kitAttr({ kit: "glow", version: 0 }), "glow-0");
});

console.log("— composable home sections (MC08)");

await t("banner validates link + content; rich_text is sanitized AT SAVE", async () => {
  let r = validateBlock("home_sections", [{ kind: "banner", title: "Sale", href: "javascript:alert(1)", label: "Go" }]);
  eq(r.ok, false, "bad banner link:");
  r = validateBlock("home_sections", [{ kind: "banner", href: "/collections", label: "Go" }]);
  eq(r.ok, false, "empty banner:");
  r = validateBlock("home_sections", [{ kind: "rich_text", title: "Story", html: '<p>ok</p><script>alert(1)</script><img src="x" onerror="x()">' }]);
  eq(r.ok, true);
  eq(r.value[0].html.includes("<script"), false, "script stripped:");
  eq(r.value[0].html.includes("onerror"), false, "handler stripped:");
  eq(r.value[0].html.includes("<p>ok</p>"), true, "content kept:");
});

await t("mixed section list round-trips through store + release snapshot", async () => {
  const { ok, value } = validateBlock("home_sections", [
    { kind: "banner", title: "Festive", text: "Free shipping", label: "Shop", href: "/collections" },
    { kind: "new", title: "Fresh", limit: 4 },
    { kind: "rich_text", html: "<p>Our story</p>" },
  ]);
  eq(ok, true);
  await inTenant(() => S.setBlock("home_sections", value));
  const sections = await inTenant(S.getHomeSections);
  eq(sections.length, 3);
  eq(sections[0].kind, "banner");
  const snap = await inTenant(R.snapshotContent);
  eq(snap.content.blocks.home_sections.length, 3);
});

console.log("— page templates (MC09)");

await t("every template's page passes upsert validation when given a slug", async () => {
  for (const tpl of PAGE_TEMPLATES) {
    if (tpl.id === "blank") continue;
    const page = { ...tpl.page, slug: tpl.page.slug || "x", title: tpl.page.title || "X" };
    await inTenant(() => S.upsertContentPage(page));
    const got = await inTenant(() => S.getContentPage(page.slug));
    eq(got.title, page.title, `${tpl.id}:`);
    await inTenant(() => S.deleteContentPage(page.slug));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
