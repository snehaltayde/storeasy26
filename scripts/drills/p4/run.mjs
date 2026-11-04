// P4-HARNESS and P4-DRILLS: `pnpm drill:p4`, the phase 4 drills, in desktop
// Chrome on the design harness. HARNESS shipped 'seed' and 'smoke'; P4-DRILLS
// adds the founder tasks, the runbook drill and the item drills.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 [COPY_SQLD_PORT=7103] [P4_DRILL_SCRATCH=<dir>] \
//     node scripts/drills/p4/run.mjs [stage,stage…] [--headed]
//
// Ports: the harness takes DESIGN_PORT and three database ports from
// DESIGN_SQLD_PORT; the restore-drill copy takes COPY_SQLD_PORT (default
// DESIGN_SQLD_PORT + 3). 3017 (the owner's harness) is refused.
//
// Stages (all of them when none is named), each on a fresh seed:
//   seed           (P4-HARNESS) the --p4 store, checked by SQL
//   smoke          (P4-HARNESS) its badge, pairs title, modules, templates,
//                  pins and redirect in Chrome; the owner and staff sign in
//   cutover        cutover.mjs: the rehearsal on a copy, then the move of the
//                  --p4 store; the canaries in Chrome before and after
//   product        product.mjs: on the moved store, the founder renames a
//                  product, gives it a description, a library photo, a badge,
//                  a module, pairs and a template, publishes, and a shopper
//                  sees them on the card, product page, cart, checkout,
//                  confirmation and order page (a COD test order, cancelled);
//                  the order page's "Shopify title" line; Reset puts
//                  Shopify's back
//   collection     product.mjs: a collection's pinned products and template
//   routes         routes.mjs: every old console address leads to the editor;
//                  the setup links open working screens
//   media          media.mjs: archive, a refused delete of a used file, and a
//                  file used only by a version 3 release kept for rollback
//                  reported as used after the move
//   reverse        reverse.mjs: the move back, the old editors work again,
//                  the move again
//   search-rename  product.mjs: a rename found by storefront search, its
//                  search row done; a second rename drained to a spy search
//                  client in this process; Undo
//   runbook        runbook.mjs: P4-CUTOVER-RUNBOOK.md followed literally, a
//                  stop in 'migrating' recovered with --status and --abort
//   picker, editor, fix3, reverse-drill
//                  the item drills (P4-PICKER, P4-EDITOR, P4-FIX3,
//                  P4-REVERSE), each its own process, results in its own folder
//   p3             the phase 3 item drills (scripts/drills/p3/run.mjs items),
//                  each reseeding --p3
//
// Results: docs/cms-reviews/drills/P4-HARNESS/results-{seed,smoke}.json,
// docs/cms-reviews/drills/P4-DRILLS/results-<stage>.json with the screenshots,
// and the summary docs/cms-reviews/drills/P4-DRILLS/results-run[-<stages>].json.
// Captures go to .design-data/p4-captures/ (not committed).
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_NAME, ROOT, runningHarness } from "../../design-harness.js";
import { P4_SEED_LIST } from "../../seed-design-documents.js";
import { CAPTURE_DIR, P4_SEED_PATH, captureShopperRoutes, login, noThanks, p3Ports, p4SeedState, readP4Seed, reseedP4, runDrill, selfCheck, settle, storeSql } from "./lib.mjs";

export const DRILL_ID = "P4-HARNESS";
export const DRILLS_ID = "P4-DRILLS";
// in-process stages: [file, export] (run.mjs's own for seed and smoke)
const OWN = {
  cutover: ["./cutover.mjs", "cutoverStage"],
  product: ["./product.mjs", "productStage"],
  collection: ["./product.mjs", "collectionStage"],
  routes: ["./routes.mjs", "routesStage"],
  media: ["./media.mjs", "mediaStage"],
  reverse: ["./reverse.mjs", "reverseStage"],
  "search-rename": ["./product.mjs", "searchRenameStage"],
  runbook: ["./runbook.mjs", "runbookStage"],
};
// the item drills, each its own process (runDrill refuses a second harness)
export const CHILDREN = {
  picker: { file: "scripts/drills/p4/picker.mjs", id: "P4-PICKER", part: "picker" },
  editor: { file: "scripts/drills/p4/editor.mjs", id: "P4-EDITOR", part: "editor" },
  fix3: { file: "docs/cms-reviews/drills/P4-FIX3/fix3.mjs", id: "P4-FIX3", part: "fix3" },
  "reverse-drill": { file: "docs/cms-reviews/drills/P4-REVERSE/drill.mjs", id: "P4-REVERSE", part: "reverse" },
  p3: { file: "scripts/drills/p3/run.mjs", args: ["items"], id: "P3-DRILLS", part: "run-items", summary: "docs/cms-reviews/drills/P3-DRILLS/results-run-items.json" },
};
export const STAGES = ["seed", "smoke", ...Object.keys(OWN), ...Object.keys(CHILDREN)];

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
const OUT = join(ROOT, "docs", "cms-reviews", "drills", DRILLS_ID);

function runChild(args, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const take = (c) => process.stdout.write(c);
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("exit", (code) => resolve({ code, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

async function main() {
  p3Ports();
  // the move's rehearsal points the store's row at a copy and back: the
  // harness must see the row change within a second or two
  if (!process.env.PLATFORM_CACHE_MS) process.env.PLATFORM_CACHE_MS = "1000";
  const ours = runningHarness(join(ROOT, DATA_DIR_NAME));
  if (ours) throw new Error(`A design harness is already running in this checkout (pid ${ours.launcher.pid}). The phase 4 drills seed the store fresh and start their own: stop it first.`);
  const [only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const wanted = only ? only.split(",") : STAGES;
  for (const w of wanted) if (!STAGES.includes(w)) throw new Error(`There is no stage "${w}". Stages: ${STAGES.join(", ")}.`);
  const rows = [];
  const started = new Date().toISOString();
  mkdirSync(join(OUT, "items"), { recursive: true });
  for (const stage of wanted) {
    console.log(`\n=== ${stage}`);
    const t0 = Date.now();
    if (STAGE_FNS[stage]) {
      const code = await runDrill({ id: DRILL_ID, part: stage, title: `${DRILL_ID} — ${stage}` }, STAGE_FNS[stage]);
      const res = readJson(join(ROOT, "docs", "cms-reviews", "drills", DRILL_ID, `results-${stage}.json`));
      rows.push({ stage, exit: code, seconds: Math.round((Date.now() - t0) / 1000), passed: res?.passed, failed: res?.failed, results: `../${DRILL_ID}/results-${stage}.json` });
    } else if (OWN[stage]) {
      const [file, name] = OWN[stage];
      const mod = await import(file);
      const code = await runDrill({ id: DRILLS_ID, part: stage, title: `${DRILLS_ID} — ${stage}` }, mod[name]);
      const res = readJson(join(OUT, `results-${stage}.json`));
      rows.push({ stage, exit: code, seconds: Math.round((Date.now() - t0) / 1000), passed: res?.passed, failed: res?.failed, results: `results-${stage}.json` });
    } else {
      const c = CHILDREN[stage];
      const r = await runChild([join(ROOT, c.file), ...(c.args || []), ...process.argv.filter((a) => a === "--headed")], process.env);
      const file = c.summary ? join(ROOT, c.summary) : join(ROOT, "docs", "cms-reviews", "drills", c.id, `results-${c.part}.json`);
      const res = readJson(file);
      if (res) copyFileSync(file, join(OUT, "items", `${c.id}-results-${c.part}.json`));
      const counts = res && !c.summary ? { passed: res.passed, failed: res.failed } : res ? { passed: res.rows?.reduce((n, x) => n + (x.passed || 0), 0), failed: res.rows?.reduce((n, x) => n + (x.failed || 0), 0) } : {};
      rows.push({ stage, exit: r.code, seconds: r.seconds, ...counts, results: res ? `items/${c.id}-results-${c.part}.json` : null });
    }
  }
  const summary = { ranAt: started, finishedAt: new Date().toISOString(), stages: wanted, rows, failed: rows.filter((r) => r.exit !== 0 || r.failed).length };
  const file = join(OUT, only ? `results-run-${wanted.join("-").slice(0, 60)}.json` : "results-run.json");
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log("\n=== summary");
  for (const r of rows) console.log(`${r.exit === 0 && !r.failed ? "ok  " : "FAIL"} ${r.stage}: ${r.passed ?? "?"} passed, ${r.failed ?? "?"} failed (${r.seconds} s)`);
  return summary.failed ? 1 : 0;
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
