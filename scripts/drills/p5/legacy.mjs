// P5-DRILLS: legacy stores are untouched by phase 5 (plan section 0.4).
//
//   baseline  a fresh --p4 store (the P4 legacy store, live on a version 3
//             release, with the perf seed's bundles) is seeded once on this
//             tree and its harness data copied aside (the snapshot). A
//             throwaway, read-only git worktree at afd7881 (phase 5's base),
//             outside the repo's .claude/worktrees, gets its own
//             pnpm install and that snapshot, runs its own harness, and the
//             shopper captures are taken: the home page, a product, a
//             collection, /bundles/<slug>, the cart JSON after adding that
//             bundle the way its button does, and the old home Designer's
//             section list; plus afd7881's own a6d028e-style home render
//             (scripts/support/home-render-outputs.js). Saved in
//             docs/cms-reviews/drills/P5-DRILLS/baseline-legacy/. The worktree
//             is removed after.
//   legacy    the same snapshot, served by THIS tree's harness; the same
//             captures, compared byte for byte with baseline-legacy after the
//             P4 comparison's own mask (lib/migrate/render-compare.js
//             normalize: scripts, generated ids, hashed asset names,
//             date-times and the origin; next dev writes a per-request id and
//             timings into every page's scripts, so raw bytes never repeat);
//             the cart JSON with only its random cart id and date-times masked.
//             The home render is compared raw. The old Designer offers no
//             bundle kinds.
//
// Only local databases (the harness's own sqld, the snapshot's copies) and
// local addresses (assertLocal); no Shopify, no Typesense.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR_NAME, ENV_FILE_NAME, ROOT, dbUrl, harnessPorts } from "../../design-harness.js";
import { connectHarness } from "../../drill.js";
import { DrillError, OUT, assertLocal, captureShopperRoutes, noThanks, readP4Seed, reseedP4, settle, sleep, sqlAt } from "./lib.mjs";

export const BASE_SHA = "afd7881";
const BASE_DIR = join(OUT, "baseline-legacy");
const SNAP_FILE = join(BASE_DIR, "snapshot.json");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const DATE_TIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;

function scratchRoot() {
  const root = process.env.P5_DRILL_SCRATCH;
  if (!root) return mkdtempSync(join(tmpdir(), "p5-drills-"));
  mkdirSync(root, { recursive: true });
  return root;
}

function copyData(fromRoot, toRoot) {
  rmSync(join(toRoot, DATA_DIR_NAME), { recursive: true, force: true });
  cpSync(join(fromRoot, DATA_DIR_NAME), join(toRoot, DATA_DIR_NAME), { recursive: true });
  cpSync(join(fromRoot, ENV_FILE_NAME), join(toRoot, ENV_FILE_NAME));
  rmSync(join(toRoot, DATA_DIR_NAME, "harness.pid.json"), { force: true });
}

const git = (args, cwd = ROOT) => spawnSync("git", args, { cwd, encoding: "utf8" });

// What the legacy store holds that the captures use.
async function legacyFacts() {
  const seed = readP4Seed();
  // the running harness's store database (both trees use this run's ports)
  const [b, mode] = await sqlAt(dbUrl(harnessPorts().sqld.tenant), ["SELECT id, slug, title, items FROM bundles WHERE enabled = 1 ORDER BY slug LIMIT 1", "SELECT mode FROM cms_state WHERE id = 1"]);
  const bundle = b.rows[0] ? { ...b.rows[0], items: JSON.parse(b.rows[0].items) } : null;
  return { mode: mode.rows[0]?.mode ?? null, product: seed.chosenProduct.path, collection: seed.pinnedCollection.path, bundle };
}

const routesOf = (f) => [
  { path: "/", name: "home" },
  { path: f.product, name: "product" },
  { path: f.collection, name: "collection" },
  { path: `/bundles/${f.bundle.slug}`, name: "bundle-page" },
];

// The cart a shopper gets after adding the bundle the way BundleAddButton
// does (each component through POST /api/cart, in order), as JSON, with only
// its random cart id and date-times masked.
async function cartCapture(base, bundle) {
  assertLocal(base);
  let cookie = `_unit=p5-legacy`;
  const posts = [];
  for (const it of bundle.items) {
    const r = await fetch(`${base}/api/cart`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "add", variantId: it.variantId, quantity: it.quantity ?? 1 }) });
    posts.push(r.status);
    const set = r.headers.get("set-cookie");
    const m = set && /(?:^|,\s*)([A-Za-z_][\w-]*)=([^;]+);/.exec(set);
    if (m && !cookie.includes(`${m[1]}=`)) cookie += `; ${m[1]}=${m[2]}`;
    await r.text();
  }
  const g = await fetch(`${base}/api/cart`, { headers: { cookie } });
  const json = await g.json();
  const id = json?.id ?? null;
  let text = JSON.stringify(json, null, 2);
  if (id) text = text.split(String(id)).join("<cart>");
  text = text.replace(DATE_TIME, "<time>");
  return { posts, status: g.status, text, items: (json.items || []).length, discountTotal: json.discountTotal ?? null };
}

// The old home Designer's "Add section" list, as the owner sees it.
async function designerKinds(drill) {
  const ctx = await drill.context({ width: 1440 });
  try {
    const page = await drill.login("owner", { context: ctx });
    // the home page editor (S52): its add buttons are a fixed list
    await page.goto("/admin/storefront/home", { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    await page.locator("main").first().waitFor({ timeout: 90_000 });
    await sleep(1500);
    const homeText = (await page.locator("main").innerText()).replace(/\s+/g, " ");
    const homeBundle = /Bundle card|Bundle grid/.test(homeText);
    const homeAdds = (await page.locator("main button").allInnerTexts()).map((t) => t.trim()).filter((t) => ["Collections grid", "Newest products", "Banner / CTA", "Rich text"].includes(t) || /bundle/i.test(t));
    // the home Designer: its section list comes from the legacy registry
    await page.goto("/admin/storefront/designer", { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    const add = page.getByRole("button", { name: "Add section", exact: true });
    await add.first().waitFor({ timeout: 90_000 });
    await add.first().click();
    const list = page.locator('ul[aria-label="Section types"]');
    await list.waitFor({ timeout: 30_000 });
    const kinds = (await list.locator("li").allInnerTexts()).map((t) => t.trim());
    await drill.screenshot(page, `legacy-designer-add-section-${drill.part}-1440`);
    return { path: new URL(page.url()).pathname, kinds, homeEditor: { adds: homeAdds, mentionsBundleKinds: homeBundle } };
  } finally {
    await ctx.close();
  }
}

// Every capture of the running legacy harness at `base`, written to `dir`.
async function captureAll(drill, base, rawDir, facts) {
  const routes = routesOf(facts);
  const index = await captureShopperRoutes(base, routes, rawDir, { unit: "p5-legacy" });
  const { normalize } = await import("../../../lib/migrate/render-compare.js");
  const out = {};
  for (const r of index) {
    const html = readFileSync(join(rawDir, r.file), "utf8");
    const masked = normalize(html, { origin: base });
    out[r.name] = { path: r.path, status: r.status, rawBytes: r.bytes, rawSha256: r.sha256, masked, maskedSha256: sha(masked) };
  }
  const cart = await cartCapture(base, facts.bundle);
  const designer = await designerKinds(drill);
  // a look in Chrome too (screenshots)
  const ctx = await drill.context({ width: 1440 });
  await ctx.addCookies([{ name: "_unit", value: "p5-legacy", url: base }]);
  const page = await ctx.newPage();
  for (const r of routes) {
    await page.goto(`${base}${r.path}`, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    await noThanks(page);
    await drill.screenshot(page, `legacy-${r.name}-${drill.part}-1440`);
  }
  await ctx.close();
  return { routes: out, cart, designer };
}

function homeRender(root, outFile) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "support", "home-render-outputs.js"), outFile], { cwd: root, env: { ...process.env, HOME_RENDER_DB_PREFIX: ".test-p5-home-render" }, encoding: "utf8", timeout: 600_000 });
  return { code: r.status, tail: `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-3).join(" | ") };
}

function writeCaptures(dir, caps, extra) {
  mkdirSync(dir, { recursive: true });
  const index = { ...extra, routes: {}, cart: { posts: caps.cart.posts, status: caps.cart.status, sha256: sha(caps.cart.text), items: caps.cart.items, discountTotal: caps.cart.discountTotal }, designer: caps.designer };
  for (const [name, c] of Object.entries(caps.routes)) {
    writeFileSync(join(dir, `${name}.masked.html.txt`), c.masked);
    index.routes[name] = { path: c.path, status: c.status, rawBytes: c.rawBytes, rawSha256: c.rawSha256, maskedSha256: c.maskedSha256 };
  }
  writeFileSync(join(dir, "cart.json"), `${caps.cart.text}\n`);
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

// ---------------------------------------------------------------------------
// baseline: afd7881
// ---------------------------------------------------------------------------
export async function baselineStage(drill) {
  const scratch = scratchRoot();
  // the legacy store, seeded once on this tree, then copied aside
  await reseedP4(drill, { start: false });
  const snapshot = join(scratch, "legacy-snapshot");
  mkdirSync(snapshot, { recursive: true });
  copyData(ROOT, snapshot);
  drill.note(`legacy store: a fresh --p4 seed (the P4 legacy store, live on a version 3 release; the perf seed's bundles), snapshot in ${snapshot}`);

  // the throwaway worktree at afd7881
  const wt = join(scratch, "baseline-wt");
  if (existsSync(wt)) {
    git(["worktree", "remove", "--force", wt]);
    rmSync(wt, { recursive: true, force: true });
  }
  if (wt.includes(`${join(".claude", "worktrees")}`)) throw new DrillError("the baseline worktree must be outside .claude/worktrees");
  const add = git(["worktree", "add", "--detach", wt, BASE_SHA]);
  drill.check(add.status === 0, `baseline: a throwaway detached worktree at ${BASE_SHA} (${wt})`, add.stderr.trim().split("\n").pop());
  let harness = null;
  try {
    const head = git(["rev-parse", "--short", "HEAD"], wt).stdout.trim();
    drill.check(head === BASE_SHA, "baseline: its HEAD is afd7881 (phase 5's base)", head);
    const inst = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: wt, encoding: "utf8", timeout: 600_000 });
    drill.check(inst.status === 0, "baseline: its own pnpm install --frozen-lockfile --prefer-offline (no symlinked node_modules)", `${inst.stdout || ""}${inst.stderr || ""}`.trim().split("\n").slice(-2).join(" | "));
    copyData(snapshot, wt);

    harness = await connectHarness({ start: true, root: wt, log: () => {} });
    await fetch(`${harness.baseUrl}/`).catch(() => {});
    const facts = await legacyFacts();
    drill.check(facts.mode === "legacy" && facts.bundle, "baseline: the store is a legacy store, with a turned-on bundle for /bundles/<slug>", { mode: facts.mode, bundle: facts.bundle?.slug });
    const caps = await captureAll(drill, harness.baseUrl, join(scratch, "baseline-raw"), facts);
    for (const [name, c] of Object.entries(caps.routes)) drill.check(c.status === 200 && c.masked.length > 1000, `baseline: ${c.path} answers 200 on afd7881 (${name})`, { status: c.status, rawBytes: c.rawBytes });
    drill.check(caps.cart.posts.every((s) => s === 200) && caps.cart.items === facts.bundle.items.length && caps.cart.discountTotal > 0, "baseline: the cart after adding the bundle holds its products with the bundle discount", { posts: caps.cart.posts, items: caps.cart.items, discountTotal: caps.cart.discountTotal });
    drill.check(caps.designer.kinds.length > 0 && !caps.designer.kinds.some((k) => /bundle/i.test(k)) && caps.designer.homeEditor.adds.length > 0 && !caps.designer.homeEditor.mentionsBundleKinds, "baseline: the old home Designer and Home page editor list their section types, none of them bundles", caps.designer);
    const render = homeRender(wt, join(scratch, "home-render-afd7881.json"));
    drill.check(render.code === 0, "baseline: afd7881's own a6d028e-style home render (scripts/support/home-render-outputs.js) runs", render.tail);
    if (render.code === 0) cpSync(join(scratch, "home-render-afd7881.json"), join(BASE_DIR, "home-render.json"));
    const index = writeCaptures(BASE_DIR, caps, { tree: BASE_SHA, capturedAt: new Date().toISOString(), facts: { ...facts, bundle: { slug: facts.bundle.slug, title: facts.bundle.title, items: facts.bundle.items.length } }, homeRenderSha256: render.code === 0 ? sha(readFileSync(join(BASE_DIR, "home-render.json"))) : null });
    writeFileSync(SNAP_FILE, `${JSON.stringify({ snapshot, note: "scratch path, not committed; the legacy stage restores it" }, null, 2)}\n`);
    drill.note(`baseline captures: ${JSON.stringify(Object.fromEntries(Object.entries(index.routes).map(([k, v]) => [k, v.maskedSha256.slice(0, 12)])))}`);
  } finally {
    if (harness?.started) await harness.stop();
    await sleep(500);
    const rm = git(["worktree", "remove", "--force", wt]);
    git(["worktree", "prune"]);
    drill.check(rm.status === 0 && !existsSync(wt), "baseline: the throwaway worktree is removed", rm.stderr.trim());
  }
}

// ---------------------------------------------------------------------------
// legacy: this tree
// ---------------------------------------------------------------------------
export async function legacyStage(drill) {
  if (!existsSync(SNAP_FILE)) throw new DrillError("Run the baseline stage first (it seeds the legacy store and records the afd7881 captures).");
  const { snapshot } = JSON.parse(readFileSync(SNAP_FILE, "utf8"));
  if (!existsSync(join(snapshot, DATA_DIR_NAME))) throw new DrillError(`The legacy snapshot ${snapshot} is gone. Run the baseline stage again.`);
  const base = JSON.parse(readFileSync(join(BASE_DIR, "index.json"), "utf8"));
  const scratch = scratchRoot();
  copyData(snapshot, ROOT);
  drill.note(`the same legacy store (snapshot ${snapshot}) served by this tree's harness`);
  const harness = await connectHarness({ start: true, root: ROOT, log: () => {} });
  try {
    await fetch(`${harness.baseUrl}/`).catch(() => {});
    const facts = await legacyFacts();
    drill.check(facts.mode === "legacy" && facts.bundle?.slug === base.facts.bundle.slug, "legacy: the same legacy store, the same bundle", { mode: facts.mode, bundle: facts.bundle?.slug });
    const caps = await captureAll(drill, harness.baseUrl, join(scratch, "legacy-raw"), facts);
    const dir = join(OUT, "phase5-legacy");
    const index = writeCaptures(dir, caps, { tree: "phase 5", capturedAt: new Date().toISOString() });
    for (const [name, c] of Object.entries(index.routes)) {
      const b = base.routes[name];
      const same = c.maskedSha256 === b.maskedSha256 && readFileSync(join(dir, `${name}.masked.html.txt`), "utf8") === readFileSync(join(BASE_DIR, `${name}.masked.html.txt`), "utf8");
      drill.check(same && c.status === b.status, `legacy: ${c.path} is byte-identical to afd7881's after the P4 mask (${name})`, { status: [b.status, c.status], masked: [b.maskedSha256.slice(0, 16), c.maskedSha256.slice(0, 16)], rawSame: c.rawSha256 === b.rawSha256 });
    }
    const cartSame = readFileSync(join(dir, "cart.json"), "utf8") === readFileSync(join(BASE_DIR, "cart.json"), "utf8");
    drill.check(cartSame, "legacy: the cart JSON after adding the bundle is byte-identical to afd7881's (only the random cart id and date-times masked)", { base: base.cart, now: index.cart });
    drill.check(JSON.stringify(caps.designer) === JSON.stringify(base.designer) && !caps.designer.kinds.some((k) => /bundle/i.test(k)) && !caps.designer.homeEditor.adds.some((k) => /bundle/i.test(k)) && !caps.designer.homeEditor.mentionsBundleKinds, "legacy: the old home Designer and Home page editor offer the same section types as afd7881, and no bundle kinds", { now: caps.designer });
    // The recorder mints fresh section ids for its content pages on every run
    // (two runs of one tree differ there), so those ids alone are masked; the
    // existing comparison (test-legacy-fixtures) takes out every
    // data-section-* attribute, which is wider. Home renders are compared raw.
    const render = homeRender(ROOT, join(scratch, "home-render-phase5.json"));
    const again = homeRender(ROOT, join(scratch, "home-render-phase5-again.json"));
    const MINTED = / data-section-id="sec_[0-9a-f]{8}"/g;
    const cmp = (x, y) => {
      const out = { homes: 0, homesSame: 0, pages: 0, pagesRawSame: 0, pagesMaskedSame: 0 };
      for (const st of Object.keys(x.states)) {
        out.homes++;
        if (x.states[st].home === y.states[st]?.home) out.homesSame++;
        for (const pg of Object.keys(x.states[st].pages || {})) {
          out.pages++;
          const a = x.states[st].pages[pg];
          const b = y.states[st]?.pages?.[pg];
          if (a === b) out.pagesRawSame++;
          if (typeof b === "string" && a.replace(MINTED, ' data-section-id="<id>"') === b.replace(MINTED, ' data-section-id="<id>"')) out.pagesMaskedSame++;
        }
      }
      out.sameStates = JSON.stringify(Object.keys(x.states)) === JSON.stringify(Object.keys(y.states));
      return out;
    };
    const rd = (f) => JSON.parse(readFileSync(f, "utf8"));
    const vsBase = render.code === 0 ? cmp(rd(join(BASE_DIR, "home-render.json")), rd(join(scratch, "home-render-phase5.json"))) : null;
    const noise = render.code === 0 && again.code === 0 ? cmp(rd(join(scratch, "home-render-phase5.json")), rd(join(scratch, "home-render-phase5-again.json"))) : null;
    drill.check(
      vsBase && vsBase.sameStates && vsBase.homesSame === vsBase.homes && vsBase.pagesMaskedSame === vsBase.pages,
      "legacy: this tree's a6d028e-style home render equals afd7881's: every state's home page byte for byte, every content page byte for byte once the recorder's freshly minted section ids are masked",
      { vsBase, tail: render.tail },
    );
    drill.check(noise && noise.homesSame === noise.homes && noise.pagesRawSame < noise.pages && noise.pagesMaskedSame === noise.pages, "legacy: two runs of the recorder on this same tree differ only in those minted page section ids (so the mask hides run-to-run noise, not a change)", noise);
    for (const f of ["home-render-phase5.json", "home-render-phase5-again.json"]) rmSync(join(scratch, f), { force: true });
  } finally {
    if (harness.started) await harness.stop();
  }
}
