// P4-HARNESS: `pnpm drill:p4`, the phase 4 drills, in desktop Chrome on the
// design harness. HARNESS ships the stages 'seed' and 'smoke'; P4-DRILLS adds
// the rest (add a function to STAGE_FNS and its name to STAGES).
//
//   DESIGN_PORT=6160 DESIGN_SQLD_PORT=7160 node scripts/drills/p4/run.mjs [seed,smoke] [--headed]
//
// Stages (all of them when none is named):
//   seed   seeds the phase 4 store twice (seed-design-documents.js --p4) and
//          checks it by SQL (check --p4): a LEGACY store live on a version 3
//          release made by createRelease, every line of the seed list counted
//          (P4_SEED_LIST), what the live release froze, the same counts on
//          the second run, no password printed, the seed files mode 600.
//          Also runs lib.mjs's selfCheck (assertLocal, p3Ports and 3017).
//   smoke  seeds again, starts the harness and, in desktop Chrome at 1440 px:
//          the chosen product shows its badge, its own pairs title, its six
//          modules and the editorial template; the first pinned collection
//          lists its pinned products first, in the sidebar template; the
//          renamed journal post's old address redirects. Shopper captures
//          (fixed unit cookie only) of the same pages; the owner and staff sign in.
//
// Results: docs/cms-reviews/drills/P4-HARNESS/results-<stage>.json and the
// screenshots there; captures go to .design-data/p4-captures/ (not committed).
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, runningHarness } from "../../design-harness.js";
import { P4_SEED_LIST } from "../../seed-design-documents.js";
import { CAPTURE_DIR, P4_SEED_PATH, captureShopperRoutes, login, noThanks, p3Ports, p4SeedState, readP4Seed, reseedP4, runDrill, selfCheck, settle, storeSql } from "./lib.mjs";

export const DRILL_ID = "P4-HARNESS";
export const STAGES = ["seed", "smoke"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function seedStage(drill) {
  for (const c of selfCheck()) drill.check(c.ok, `lib.mjs: ${c.label}`, c.detail);

  const first = await reseedP4(drill, { start: false });
  const a = await p4SeedState();
  const p = a.p4;
  const seed = readP4Seed();
  drill.check(p.counts.mode === "legacy", "cms_state.mode is legacy (no takeOver)", p.counts.mode);
  drill.check(p.counts.liveVersion === 3 && p.liveRelease === seed.liveRelease, "the live release is version 3, and it is the one --p4 published", { v: p.counts.liveVersion, live: p.liveRelease, seeded: seed.liveRelease });
  drill.check(p.liveNote === "P4-HARNESS drill store" && Boolean(p.livePublishedAt), "the live release was made by createRelease and published (its note and time)", { note: p.liveNote, publishedAt: p.livePublishedAt });
  for (const [what, want] of Object.entries(P4_SEED_LIST)) drill.check(p.counts[what] === want, `seed list: ${what} is ${want}`, { got: p.counts[what] });
  drill.check(p.mismatched.length === 0, "SQL counts match the whole seed list", p.mismatched);
  drill.check(p.photoUses.product_overrides === 1 && Object.entries(p.photoUses).every(([k, v]) => k === "product_overrides" || v === 0), "the module-only photo is used by one product's module HTML and nothing else", p.photoUses);
  const f = p.frozen || {};
  drill.check(
    f.productOverrides === 24 && f.sixModules === 1 && f.pdpPairs === 40 && f.pdpPairsDisabled === 1 && f.cartUpsell === 1 && f.pinnedCollections === 5 && f.redirects === 1,
    "the live v3 release froze the same overrides, pairs (the switched-off one too), cart upsell, pins and redirect",
    f,
  );
  drill.check(
    f.templates?.products?.[seed.chosenProduct.id] === "editorial" && f.templates?.collections?.[seed.pinnedCollection.id] === "sidebar",
    "the live release holds the per-product and per-collection template exceptions",
    f.templates,
  );

  const second = await reseedP4(drill, { start: false });
  const b = await p4SeedState();
  drill.check(same(a.p4.counts, b.p4.counts) && same(a.p4.frozen, b.p4.frozen), "the seed run twice gives the same counts", { first: a.p4.counts, second: b.p4.counts });
  drill.check(a.p4.liveRelease !== b.p4.liveRelease, "the second run started again from scratch (a new live release)", { first: a.p4.liveRelease, second: b.p4.liveRelease });
  const s2 = readP4Seed();
  const secrets = [s2.logins.owner.password, s2.logins.staff.password, seed.logins.owner.password, seed.logins.staff.password];
  drill.check(secrets.every((x) => typeof x === "string" && x.length >= 12) && !secrets.some((x) => first.out.includes(x) || second.out.includes(x)), "the seed prints neither password (they are only in the seed files)", null);
  for (const file of [P4_SEED_PATH, join(ROOT, DATA_DIR_NAME, "p3-seed.json")]) {
    const mode = statSync(file).mode & 0o777;
    drill.check(mode === 0o600, `${file.split("/").pop()} is readable by its owner only (mode 600)`, mode.toString(8));
  }
}

// true once the element is visible (within ms), false when it never is. Next
// dev may reload a page once after compiling it, so a single look can land
// on the skeleton; this waits for the real page instead.
const visibleSoon = (loc, ms = 60_000) =>
  loc
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);
const textOf = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).trim() : null);

export async function smokeStage(drill) {
  for (const c of selfCheck()) drill.check(c.ok, `lib.mjs: ${c.label}`, c.detail);
  const { seed } = await reseedP4(drill, { start: true });
  const base = drill.baseUrl;
  const prod = seed.chosenProduct;
  const col = seed.pinnedCollection;

  // ---- what a shopper gets, with no cookies ----
  const [heroRow, expRow, handles] = await storeSql("tenant", [
    "SELECT value FROM cms_blocks WHERE key = 'hero'",
    { sql: "SELECT variants FROM experiments WHERE slug = ? AND status = 'running'", args: [seed.experiment] },
    { sql: `SELECT id, handle FROM products WHERE id IN (${col.first.map(() => "?").join(",")})`, args: col.first },
  ]);
  const controlTitle = JSON.parse(heroRow.rows[0]?.value || "{}").title;
  const variantTitles = JSON.parse(expRow.rows[0]?.variants || "[]")
    .map((v) => v.payload?.title)
    .filter(Boolean);
  const routes = [
    { path: "/", name: "home-1" },
    { path: "/", name: "home-2" },
    { path: prod.path, name: "chosen-product" },
    { path: col.path, name: "pinned-collection" },
    { path: `/journal/${seed.redirect.from}`, name: "journal-old-address" },
    { path: `/journal/${seed.redirect.to}`, name: "journal-new-address" },
  ];
  const cap = await captureShopperRoutes(base, routes, CAPTURE_DIR);
  const by = Object.fromEntries(cap.map((c) => [c.name, c]));
  drill.check(["home-1", "home-2", "chosen-product", "pinned-collection", "journal-new-address"].every((n) => by[n].status === 200), "shopper captures: the home page, the chosen product, the pinned collection and the renamed post answer 200", cap.map((c) => [c.name, c.status]));
  const old = by["journal-old-address"];
  drill.check([301, 302, 307, 308].includes(old.status) && String(old.location || "").endsWith(`/journal/${seed.redirect.to}`), "the renamed post's old address redirects to the new one (the page redirect)", { status: old.status, location: old.location });
  const { readFileSync } = await import("node:fs");
  const homes = ["home-1", "home-2"].map((n) => readFileSync(join(CAPTURE_DIR, by[n].file), "utf8"));
  // the hero's words as the page writes them (the highlight is its own span)
  const heroOf = (html) => (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, "") ?? null;
  const heroes = homes.map(heroOf);
  drill.check(Boolean(heroes[0]) && heroes[0] === heroes[1] && expRow.rows.length === 1, "with a hero experiment running, two captures with the fixed unit show the same hero (captures are deterministic)", { heroes, control: controlTitle, variants: variantTitles });
  // without any cookie the page picks a random unit each time (app/(storefront)/page.js)
  const bare = await captureShopperRoutes(base, Array.from({ length: 8 }, (_, i) => ({ path: "/", name: `home-nocookie-${i + 1}` })), CAPTURE_DIR, { unit: null });
  const bareHeroes = [...new Set(bare.map((c) => heroOf(readFileSync(join(CAPTURE_DIR, c.file), "utf8"))))];
  drill.note(`with no cookie at all, 8 captures of / showed ${bareHeroes.length} different hero${bareHeroes.length === 1 ? "" : "es"}: ${JSON.stringify(bareHeroes)} (a random unit per request; that is why captures send a fixed unit)`);
  drill.note(`shopper captures in ${CAPTURE_DIR} (index.json)`);

  // ---- the storefront in desktop Chrome ----
  const ctx = await drill.context({ width: 1440 });
  const page = await ctx.newPage();
  // the product page streams (a skeleton first), and Next dev may reload a
  // page once after compiling it: wait for the load, settle, then for the
  // template itself to be visible before reading anything
  await page.goto(`${base}${prod.path}`, { waitUntil: "load" });
  await settle(page);
  await page.locator("[data-pdp-template]").first().waitFor({ state: "visible", timeout: 90_000 });
  await noThanks(page);
  const tpl = (await visibleSoon(page.locator('[data-pdp-template="editorial"]'))) ? "editorial" : await page.locator("[data-pdp-template]").first().getAttribute("data-pdp-template").catch(() => null);
  drill.check(tpl === "editorial" && (await page.locator("[data-pdp-template]").count()) === 1, `the chosen product (${prod.title}) renders the editorial template (its per-product exception)`, tpl);
  drill.check(await visibleSoon(page.getByText(prod.badge, { exact: true }), 15_000), `the chosen product shows its badge "${prod.badge}"`, null);
  const pairsTitle = await textOf(page.locator('[data-sec="pdp-pairs"] h2'));
  drill.check(pairsTitle === prod.pairsTitle, `the chosen product shows its own pairs title "${prod.pairsTitle}"`, pairsTitle);
  const modules = await page.locator('[data-sec="pdp-modules"] details').count();
  drill.check(modules === 6, "the chosen product shows its six modules", modules);
  const photo = await page.locator(`[data-sec="pdp-modules"] img[src*="${seed.moduleOnlyPhoto}"]`).count();
  drill.check(photo === 1, "the module-only photo is inside the chosen product's module", photo);
  await drill.screenshot(page, "chosen-product-1440");

  await page.goto(`${base}${col.path}`, { waitUntil: "load" });
  await settle(page);
  await page.locator("[data-collection-template]").first().waitFor({ state: "visible", timeout: 90_000 });
  drill.check((await visibleSoon(page.locator('[data-collection-template="sidebar"]'))) && (await page.locator("[data-collection-template]").count()) === 1, `the pinned collection (${col.title}) renders the sidebar template (its per-collection exception)`, null);
  const hrefs = await page.locator('[data-sec="collection-products"] a[href^="/products/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const shown = [...new Set(hrefs.map((h) => h.split("?")[0].replace(/^\/products\//, "")))];
  const handleOf = Object.fromEntries(handles.rows.map((r) => [r.id, r.handle]));
  const pinnedHandles = col.first.map((id) => handleOf[id]);
  drill.check(pinnedHandles.length === col.first.length && same(shown.slice(0, pinnedHandles.length), pinnedHandles), "the pinned collection lists its pinned products first, in the pinned order", { pinned: pinnedHandles, firstShown: shown.slice(0, pinnedHandles.length + 2) });
  await drill.screenshot(page, "pinned-collection-1440");

  await page.goto(`${base}/journal/${seed.redirect.from}`, { waitUntil: "domcontentloaded" });
  drill.check(new URL(page.url()).pathname === `/journal/${seed.redirect.to}`, "in Chrome, the old post address lands on the renamed post", page.url());
  await ctx.close();

  // ---- the P3 logins work on the phase 4 store ----
  for (const role of ["owner", "staff"]) {
    const c = await drill.context();
    const p = await login(drill, role, { context: c });
    drill.check(/\/admin\/dashboard/.test(new URL(p.url()).pathname), `the ${role} signs in through the real form and reaches the console`, p.url());
    await c.close();
  }
}

const STAGE_FNS = { seed: seedStage, smoke: smokeStage };

async function main() {
  p3Ports();
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new Error(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The phase 4 drills seed the store fresh and start their own: stop it first.`);
  const [only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const wanted = only ? only.split(",") : STAGES;
  for (const w of wanted) if (!STAGES.includes(w)) throw new Error(`There is no stage "${w}". Stages: ${STAGES.join(", ")}.`);
  let failed = 0;
  for (const stage of wanted) {
    console.log(`\n=== ${stage}`);
    failed += await runDrill({ id: DRILL_ID, part: stage, title: `${DRILL_ID} — ${stage}` }, STAGE_FNS[stage]);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
