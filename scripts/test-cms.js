// Session 23 — merchandising CMS + upsells tests: block storage/fallbacks,
// content-page override + contact injection, block validation, placement CRUD
// + PDP manual/auto resolution + cart-upsell slot, and two-tenant isolation.
// Throwaway file DBs.
//   node scripts/test-cms.js      (pnpm test:cms)
import { rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-cms-default.db";
process.env.PLATFORM_DB_URL = "file:.test-cms-platform.db";
process.env.PLATFORM_SECRET = "test-platform-secret";

const here = dirname(fileURLToPath(import.meta.url));
const dbs = [".test-cms-default.db", ".test-cms-platform.db", ".test-cms-t2.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { db, libsql } = await import("../lib/db.js");
const { withTenant } = await import("../lib/tenant-context.js");
const S = await import("../lib/cms/store.js");
const P = await import("../lib/cms/placements.js");
const { validateBlock } = await import("../lib/cms/validate.js");
const { PAGES } = await import("../lib/content/pages.js");

const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const migrations = await loadMigrations("tenant");
await libsql.executeMultiple(schema);
await runMigrations(libsql, migrations); // fixture rule: ledger on top of raw schema (S35 cms revisions)
const T2 = { id: "t2", name: "T2", status: "active", dbUrl: "file:.test-cms-t2.db", dbToken: null, config: { site: { name: "Acme", support_email: "help@acme.in", support_phone: "+91-1" } }, secrets: {} };
await withTenant(T2, async () => {
  await libsql.executeMultiple(schema);
  await runMigrations(libsql, migrations);
});

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
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};

// --- blocks: defaults + storage -------------------------------------------------
await t("blocks: defaults when nothing stored; merge-over-default after save", async () => {
  const hero = await S.getHero();
  ok(hero.title.includes("BeastLife") || hero.title.includes("Shop"), "default hero derives from site name");
  const ann = await S.getAnnouncement();
  eq(ann.enabled, false, "announcement off by default");
  eq(await S.getNav("header"), null, "header nav = catalog-derived by default");

  await S.setBlock("announcement", { enabled: true, text: "Diwali sale!", href: "/collections" });
  const ann2 = await S.getAnnouncement();
  eq(ann2.enabled, true);
  eq(ann2.text, "Diwali sale!");

  await S.setBlock("hero", { title: "Big title" });
  const hero2 = await S.getHero();
  eq(hero2.title, "Big title", "stored wins");
  ok(hero2.primary?.label, "missing fields heal from defaults");

  await S.deleteBlock("announcement");
  eq((await S.getAnnouncement()).enabled, false, "reset returns defaults");
  let threw = false;
  try {
    await S.setBlock("nonsense", {});
  } catch {
    threw = true;
  }
  ok(threw, "unknown block key rejected");
});

await t("home sections: default pair; disabled/unknown filtered; stored order wins", async () => {
  const def = await S.getHomeSections();
  eq(def.map((s) => s.kind).join(","), "collections,new");
  await S.setBlock("home_sections", [
    { kind: "new", title: "Latest", limit: 4, enabled: true },
    { kind: "collections", title: "Browse", limit: 3, enabled: false },
    { kind: "bogus", title: "x" }, // banner/rich_text are real kinds since S37 — "bogus" stays unknown
  ]);
  const got = await S.getHomeSections();
  eq(got.length, 1, "disabled + unknown dropped");
  eq(got[0].title, "Latest");
  await S.deleteBlock("home_sections");
});

// --- content pages ---------------------------------------------------------------
await t("pages: default fallback, tenant override wins, disable hides, delete restores", async () => {
  const about = await S.getContentPage("about");
  eq(about.title, PAGES.about.title, "default about");
  await S.upsertContentPage({ slug: "about", title: "Our story", sections: [{ heading: "Hi", body: ["We are new."] }] });
  eq((await S.getContentPage("about")).title, "Our story", "override wins");
  await S.upsertContentPage({ slug: "about", title: "Our story", sections: [{ heading: "Hi", body: ["x"] }], enabled: false });
  eq(await S.getContentPage("about"), null, "disabled page hidden (404)");
  await S.deleteContentPage("about");
  eq((await S.getContentPage("about")).title, PAGES.about.title, "delete restores default");
  eq(await S.getContentPage("no-such-page"), null, "unknown slug null");
  let threw = false;
  try {
    await S.upsertContentPage({ slug: "Bad Slug", title: "x", sections: [] });
  } catch {
    threw = true;
  }
  ok(threw, "bad slug rejected");
});

await t("pages: default contact injects the TENANT's support details (BeastLife family only, S38)", async () => {
  // S38 (SF14): the default pages carry BeastLife's real copy — they serve
  // ONLY the beastlife tenants + legacy mode, never another tenant's shoppers.
  eq(await withTenant(T2, () => S.getContentPage("contact")), null, "plain tenant gets no BeastLife default");
  const BL = { ...T2, id: "beastlife-staging", name: "BeastLife Staging" };
  const page = await withTenant(BL, () => S.getContentPage("contact"));
  const care = page.sections.find((s) => s.heading === "Customer care");
  eq(care.body[0], "Email: help@acme.in", "tenant email injected");
  eq(care.body[1], "Phone: +91-1", "tenant phone injected");
});

await t("listContentPages: defaults + custom union with source flags", async () => {
  await S.upsertContentPage({ slug: "bulk-orders", title: "Bulk orders", sections: [{ heading: "B2B", body: ["Email us."] }] });
  const list = await S.listContentPages();
  const bulk = list.find((p) => p.slug === "bulk-orders");
  eq(bulk.source, "custom");
  ok(list.find((p) => p.slug === "about")?.source === "default", "default listed");
  await S.deleteContentPage("bulk-orders");
});

// --- validation ------------------------------------------------------------------
await t("validateBlock: announcement/hero/nav rules", async () => {
  ok(!validateBlock("announcement", { enabled: true, text: "" }).ok, "enabled needs text");
  ok(!validateBlock("announcement", { text: "x", href: "javascript:alert(1)" }).ok, "js: href rejected");
  ok(validateBlock("announcement", { text: "x", href: "/sale" }).ok);
  ok(!validateBlock("hero", { title: "" }).ok, "hero needs title");
  const nav = validateBlock("nav_header", [{ label: "A", href: "/a" }, { label: "", href: "/b" }]);
  ok(!nav.ok, "nav item without label rejected");
  eq(validateBlock("nav_header", null).value, null, "null nav = derive");
  const sections = validateBlock("home_sections", [{ kind: "new", limit: "99" }]);
  eq(sections.value[0].limit, 8, "out-of-range limit falls back");
});

// --- placements -------------------------------------------------------------------
const gid = (n) => `gid://shopify/Product/${n}`;
const cgid = (n) => `gid://shopify/Collection/${n}`;
await t("placements: manual PDP pairs (ordered, available-only), auto same-collection fallback", async () => {
  const now = new Date().toISOString();
  for (let n = 1; n <= 5; n++) {
    await db.insertInto("products").values({ id: gid(n), handle: `p${n}`, title: `P${n}`, price_min: 100 + n, currency: "INR", available: n === 5 ? 0 : 1, synced_at: now }).execute();
  }
  // collections: c1 = {p1,p2,p3}, c2 = {p1,p3}
  await db.insertInto("collections").values({ id: cgid(1), handle: "c1", title: "C1", synced_at: now }).execute();
  await db.insertInto("collections").values({ id: cgid(2), handle: "c2", title: "C2", synced_at: now }).execute();
  const members = [ [1,1],[1,2],[1,3],[2,1],[2,3] ];
  for (const [c, p] of members) await db.insertInto("collection_products").values({ collection_id: cgid(c), product_id: gid(p), position: p }).execute();

  // AUTO: p1 shares 2 collections with p3, 1 with p2 → p3 first
  const auto = await P.getPdpPairs(gid(1));
  eq(auto.source, "auto");
  eq(auto.products.map((p) => p.handle).join(","), "p3,p2", "shared-count ordering");

  // MANUAL: placement for p1 → [p4, p5(unavailable), p2]
  await P.upsertPlacement({ kind: "pdp_pairs", sourceProductId: gid(1), targetProductIds: [gid(4), gid(5), gid(2)], title: "Goes great with" });
  const manual = await P.getPdpPairs(gid(1));
  eq(manual.source, "manual");
  eq(manual.title, "Goes great with");
  eq(manual.products.map((p) => p.handle).join(","), "p4,p2", "order kept, unavailable dropped");
});

await t("placements: cart upsell only when configured; excludes in-cart; disabled skipped", async () => {
  eq((await P.getCartUpsell([gid(1)])).products.length, 0, "no slot configured → empty");
  const id = await P.upsertPlacement({ kind: "cart_upsell", targetProductIds: [gid(2), gid(3)], title: "Add-ons" });
  // no variants seeded yet → nothing is one-tap addable → slot stays empty
  eq((await P.getCartUpsell([gid(2)])).products.length, 0, "productless-variant dropped");
  await db.insertInto("variants").values({ id: "gid://shopify/ProductVariant/31", product_id: gid(3), title: "d", price: 103, currency: "INR", available: 1, position: 0 }).execute();
  const slot2 = await P.getCartUpsell([gid(2)]);
  eq(slot2.title, "Add-ons");
  eq(slot2.products.map((p) => p.handle).join(","), "p3", "in-cart excluded, addable kept");
  eq(slot2.products[0].variant_id, "gid://shopify/ProductVariant/31");
  await P.upsertPlacement({ id, kind: "cart_upsell", targetProductIds: [gid(2), gid(3)], title: "Add-ons", enabled: false });
  eq((await P.getCartUpsell([])).products.length, 0, "disabled slot hidden");
});

await t("placements: validation + handle resolution", async () => {
  let threw = false;
  try {
    await P.upsertPlacement({ kind: "pdp_pairs", targetProductIds: [gid(2)] });
  } catch {
    threw = true;
  }
  ok(threw, "pdp_pairs without source rejected");
  threw = false;
  try {
    await P.upsertPlacement({ kind: "cart_upsell", targetProductIds: [] });
  } catch {
    threw = true;
  }
  ok(threw, "empty targets rejected");
  const res = await P.resolveHandles(["p1", "ghost", " p2 "]);
  eq(res.ids.join(","), `${gid(1)},${gid(2)}`, "handles → gids");
  eq(res.missing.join(","), "ghost", "missing reported");
});

// --- isolation --------------------------------------------------------------------
await t("isolation: blocks and placements are per-tenant", async () => {
  await withTenant(T2, () => S.setBlock("announcement", { enabled: true, text: "T2 only", href: "" }));
  eq((await S.getAnnouncement()).enabled, false, "default tenant unaffected");
  const t2ann = await withTenant(T2, () => S.getAnnouncement());
  eq(t2ann.text, "T2 only");
  eq((await withTenant(T2, () => P.listPlacements())).length, 0, "default tenant's placements invisible in T2");
});

// --- S52: editors get RAW lists — hidden entries must survive a round-trip ---
await t("hidden home sections and disabled PDP extras survive the editor view", async () => {
  const { storefrontView } = await import("../lib/cms/view.js");
  await withTenant(T2, async () => {
    await S.setBlock("home_sections", [
      { kind: "banner", title: "Hidden promo", text: "later", label: "", href: "/collections", enabled: false },
      { kind: "new", title: "New in", limit: 8, enabled: true },
    ]);
    await S.setBlock("pdp_extras", [
      { title: "Shipping", html: "<p>fast</p>", enabled: true },
      { title: "Seasonal", html: "<p>off-season copy</p>", enabled: false },
    ]);
    const view = await storefrontView();
    eq(view.blocks.home_sections.length, 2, "editor keeps the hidden section");
    eq(view.blocks.home_sections[0].enabled, false, "hidden flag intact");
    eq(view.blocks.pdp_extras.length, 2, "editor keeps the disabled accordion");
    eq((await S.getHomeSections()).length, 1, "renderer still filters sections");
    eq((await S.getPdpExtras()).length, 1, "renderer still filters extras");
    // the round-trip itself: saving the editor's list back changes nothing
    await S.setBlock("home_sections", view.blocks.home_sections);
    eq((await S.getHomeSectionsRaw()).length, 2, "round-trip preserves hidden");
    await S.deleteBlock("home_sections");
    await S.deleteBlock("pdp_extras");
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
