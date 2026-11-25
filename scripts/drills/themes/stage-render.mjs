// drill:themes stage "render" (Phase 5 line 2, docs/plans/phase-5.md "Line 2"
// drill stage): a seeded live Aurora package is what the anonymous shopper
// sees on the home page and a product page, and add to cart and checkout
// still work (they are Storeasy's own: data-protected, with no theme hook).
// Seeding: the aurora fixture is written straight into the roles store's own
// theme_packages table (this worktree's sqld; line 1's upload is its own
// stage), then the owner names it in doc_design and publishes it through the
// documents API, with a home page (a store's first publish takes one). The
// roles store is closed until then, so this stage OPENS it; the switch stage
// (line 3) runs after it and starts from an open store with Aurora live.
// Selectors are data-* hooks and exact names; every wait is for an element
// or an answer, never a fixed time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { ORIGIN, open, signIn, stage, state } from "./lib.mjs";

const AURORA_TEXT = readFileSync(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8");
const AURORA = JSON.parse(AURORA_TEXT);
const PKG_ID = "thm_d1d1d1d1d1d1d1d1";

async function rolesSql(statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.tenant}` });
  try {
    const out = [];
    for (const s of statements) out.push((await c.execute(s)).rows);
    return out;
  } finally {
    c.close();
  }
}

const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

stage("render", async (drill) => {
  // --- seed: the package row, then the published design (and a home) ---
  const text = JSON.stringify(AURORA);
  const [, rows] = await rolesSql([
    {
      sql: "INSERT OR IGNORE INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', 'drill', ?)",
      args: [PKG_ID, AURORA.id, `${AURORA.version}-drill`.slice(0, 20), AURORA.name, AURORA.author.name, AURORA.description, AURORA.base, text, "0".repeat(64), text.length, new Date().toISOString()],
    },
    "SELECT handle FROM products ORDER BY handle LIMIT 1",
  ]);
  const handle = rows[0]?.handle;
  drill.check(typeof handle === "string" && handle.length > 0, "the roles store has a product to open", rows);

  const owner = await signIn(drill, "owner");
  await open(owner, "/admin");
  let home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    const made = await docsApi(owner, { createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_thmdrill01", kind: "new", v: 1, enabled: true, settings: { title: "New arrivals", limit: 8 }, blocks: [] }] } } });
    drill.check(made.status === 200, "owner: a home page is made for the first publish", made.body?.error);
    home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  }
  let design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  const theme = { kit: AURORA.base, version: 1, package: PKG_ID };
  if (!design) {
    const made = await docsApi(owner, { createDocument: { type: "design", body: { schema: 1, type: "design", meta: {}, settings: { brand: null, theme, logo: null } } } });
    drill.check(made.status === 200, "owner: the design names the Aurora package", made.body?.error);
  } else {
    const saved = await docsApi(owner, { saveDraft: { id: "doc_design", body: { ...design.body, settings: { ...design.body.settings, theme } } }, revision: design.revision });
    drill.check(saved.status === 200, "owner: the design names the Aurora package", saved.body?.error);
  }
  design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document;
  const set = [{ id: "doc_design", revision: design.revision, draftHash: design.draftHash }];
  if (home && !home.live) set.push({ id: "doc_home", revision: home.revision, draftHash: home.draftHash });
  const published = await docsApi(owner, { publishSet: set });
  drill.check(published.status === 200, "owner: the design (and the home page) are published", published.body?.error || published.body?.code);
  await owner.context().close();
  state.themePackage = PKG_ID;

  // --- the anonymous shopper: a fresh context with no cookies ---
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 } });
  ctx.setDefaultTimeout(30_000);
  const anon = await ctx.newPage();
  anon.on("pageerror", (e) => drill.check(false, "no page error for the shopper", String(e?.message || e).slice(0, 300)));
  const themed = async (path) => {
    const r = await anon.goto(ORIGIN + path, { waitUntil: "load" });
    return {
      status: r?.status(),
      theme: await anon.locator("html").getAttribute("data-theme"),
      kit: await anon.locator("html").getAttribute("data-kit"),
      headerBg: await anon.locator('header[data-part="header"]').first().evaluate((el) => getComputedStyle(el).backgroundColor),
    };
  };
  const homeSeen = await themed("/");
  drill.check(homeSeen.status === 200 && homeSeen.theme === AURORA.id && homeSeen.kit === `${AURORA.base}-1`, "home: the shopper's page renders data-theme=aurora on its base kit", homeSeen);
  drill.check(homeSeen.headerBg === "rgb(15, 23, 42)", "home: the header shows Aurora's header surface (#0f172a)", homeSeen.headerBg);
  drill.check((await anon.locator("[data-part]").count()) > 0 && (await anon.locator("[data-protected] [data-part]").count()) === 0, "home: theme hooks render, none inside a protected part");
  await drill.shoot(anon, "render-home");

  const pdp = await themed(`/products/${handle}`);
  drill.check(pdp.status === 200 && pdp.theme === AURORA.id, "product page: data-theme=aurora", pdp);
  await anon.locator('[data-pdp-template="editorial"]').waitFor();
  drill.check(true, "product page: Aurora's editorial template is the default");
  const buyBox = anon.locator('[data-protected="buy-box"]');
  drill.check((await buyBox.count()) === 1 && (await buyBox.locator("[data-part]").count()) === 0, "product page: one protected buy box with no theme hook inside");
  await drill.shoot(anon, "render-pdp");

  // add to cart: the drawer (protected) opens with the line
  await buyBox.getByRole("button", { name: "Add to cart" }).first().click();
  const drawer = anon.locator('[data-protected="cart"]');
  await drawer.getByRole("link", { name: /Checkout/ }).waitFor({ state: "visible" });
  drill.check((await drawer.locator("[data-part]").count()) === 0, "cart drawer: protected, no theme hook inside");
  await drill.shoot(anon, "render-cart");

  // checkout: the flow (protected) renders with the line in it
  await drawer.getByRole("link", { name: /Checkout/ }).click();
  await anon.waitForURL(/\/checkout/);
  const flow = anon.locator('[data-protected="checkout"]');
  await flow.first().waitFor();
  drill.check((await anon.locator("html").getAttribute("data-theme")) === AURORA.id, "checkout: the theme is still the page's");
  drill.check((await flow.locator("[data-part]").count()) === 0, "checkout: protected, no theme hook inside");
  drill.check((await flow.locator("input").count()) > 0, "checkout: the flow shows its form, so the cart reached it");
  await drill.shoot(anon, "render-checkout");
  await ctx.close();
});
