// P4-DRILLS 'routes' stage (ED-05, MIG-03): the old console addresses and
// the setup links, in desktop Chrome at 1440 px, signed in as the owner.
//
//   legacy    on the --p4 store BEFORE the move, every old address still
//             opens its old screen (no redirect to the editor)
//   moved     after the move, every old address lands in the new editor on
//             its document: the old Storefront screens, Brand and Theme, the
//             product and collection designers, Upsells (bare and for a
//             product), Catalog for a product and for a collection, an old
//             page (existing, missing, "new"); the bare Catalog page stays
//             (Bundles and Quiz live there) with a link to the editor's
//             product list; Publishing is the Recently published page
//   setup     every "Open" link of the Setup checklist opens a working
//             screen, and none points at an old editor
//   templates the saved templates page lists both old templates, and "Make
//             a page from this" opens a new draft page; the old templates
//             table is unchanged
import { DrillError, movedP4Store, rowsOf, settle, sqlAt } from "./lib.mjs";

// every saved template, as stored: its id, revision, update time and a hash of its sections
const TPL_SIG = "SELECT count(*) AS n, group_concat(id || ':' || revision || ':' || updated_at || ':' || length(sections) || ':' || hex(substr(sections, 1, 64)), ',') AS sig FROM cms_templates ORDER BY id";
const OLD_SCREENS = ["/admin/storefront", "/admin/storefront/designer", "/admin/storefront/home", "/admin/storefront/navigation", "/admin/storefront/pages", "/admin/storefront/product-pages", "/admin/brand", "/admin/theme", "/admin/storefront/designer/product", "/admin/storefront/designer/collection", "/admin/upsells"];

async function visit(page, base, path) {
  const res = await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const u = new URL(page.url());
  return { status: res?.status() ?? null, path: u.pathname, search: u.search, doc: u.searchParams.get("doc"), product: u.searchParams.get("product"), collection: u.searchParams.get("collection"), list: u.searchParams.get("list") };
}

// the editor shows a document (or its lists) and no error page
async function editorOpen(page) {
  const ok = await page
    .locator("[data-document-editor]")
    .first()
    .waitFor({ timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  const text = await page.locator("body").innerText();
  return ok && !/Something went wrong|Application error|This page could not be found/i.test(text);
}

export async function routesStage(drill) {
  const legacyAddresses = [];
  const { seed, ctx, before } = await movedP4Store(drill, "routes", {
    beforeMove: async ({ ctx }) => {
      const page0 = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT slug, title FROM cms_pages WHERE coalesce(family, 'page') = 'page' AND enabled = 1 ORDER BY slug LIMIT 1"]))[0])[0];
      const tpl = rowsOf((await sqlAt(ctx.urls.tenant, [TPL_SIG]))[0])[0];
      const bctx = await drill.context({ width: 1440 });
      const page = await drill.login("owner", { context: bctx });
      const seen = [];
      for (const path of [...OLD_SCREENS, "/admin/catalog", page0 ? `/admin/storefront/pages/${page0.slug}` : null].filter(Boolean)) {
        const v = await visit(page, ctx.base, path);
        seen.push({ from: path, ...v });
        legacyAddresses.push(path);
      }
      await bctx.close();
      return { page0, tpl, seen };
    },
  });
  const legacyOk = before.seen.filter((v) => v.status === 200 && v.path === v.from);
  drill.check(legacyOk.length === before.seen.length, `before the move (old editor): all ${before.seen.length} old addresses still open their old screens, with no redirect`, before.seen.filter((v) => !(v.status === 200 && v.path === v.from)));

  const base = ctx.base;
  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));
  const [prod] = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT id, title FROM products ORDER BY title LIMIT 1"]))[0]);
  const [colRow] = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT id, title FROM collections ORDER BY title LIMIT 1"]))[0]);

  // ---- the old screens with a fixed document ----
  const want = {
    "/admin/storefront": "doc_home",
    "/admin/storefront/designer": "doc_home",
    "/admin/storefront/home": "doc_home",
    "/admin/storefront/navigation": "doc_header",
    "/admin/storefront/pages": "doc_home",
    "/admin/storefront/product-pages": "doc_product_layout",
    "/admin/brand": "doc_design",
    "/admin/theme": "doc_design",
    "/admin/storefront/designer/product": "doc_product_layout",
    "/admin/storefront/designer/collection": "doc_collection_layout",
    "/admin/upsells": "doc_cart",
  };
  const wrong = [];
  for (const [from, doc] of Object.entries(want)) {
    const v = await visit(page, base, from);
    const open = v.path === "/admin/editor" && v.doc === doc && (await editorOpen(page));
    const shown = await page.locator("[data-document-editor]").first().getAttribute("data-doc").catch(() => null);
    if (!open || (shown && shown !== doc)) wrong.push({ from, to: v.path + v.search, shown });
  }
  drill.check(wrong.length === 0, `after the move: the ${Object.keys(want).length} old Storefront, Brand, Theme, designer and Upsells addresses open the new editor on their own document`, wrong);
  await drill.screenshot(page, "upsells-to-cart-offer-1440");

  // ---- addresses that name a product, a collection or a page ----
  const ent = [];
  let v = await visit(page, base, `/admin/catalog?product=${encodeURIComponent(prod.id)}`);
  ent.push({ from: "catalog ?product=", ok: v.path === "/admin/editor" && v.product === prod.id && (await page.locator("[data-product-form]").first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false)), at: v.path + v.search });
  v = await visit(page, base, `/admin/catalog?collection=${encodeURIComponent(colRow.id)}`);
  ent.push({ from: "catalog ?collection=", ok: v.path === "/admin/editor" && v.collection === colRow.id && (await page.locator("[data-collection-form]").first().waitFor({ timeout: 90_000 }).then(() => true).catch(() => false)), at: v.path + v.search });
  v = await visit(page, base, `/admin/upsells?product=${encodeURIComponent(prod.id)}`);
  ent.push({ from: "upsells ?product=", ok: v.path === "/admin/editor" && v.product === prod.id && (await editorOpen(page)), at: v.path + v.search });
  if (before.page0) {
    v = await visit(page, base, `/admin/storefront/pages/${before.page0.slug}`);
    const heading = (await editorOpen(page)) ? await page.locator("body").innerText() : "";
    ent.push({ from: `pages/${before.page0.slug}`, ok: v.path === "/admin/editor" && Boolean(v.doc) && v.doc !== "doc_home" && heading.includes(before.page0.title), at: v.path + v.search });
    await drill.screenshot(page, "old-page-address-1440");
  }
  v = await visit(page, base, "/admin/storefront/pages/no-such-page-p4-drill");
  ent.push({ from: "pages/<missing>", ok: v.path === "/admin/editor" && (await editorOpen(page)), at: v.path + v.search });
  v = await visit(page, base, "/admin/storefront/pages/new");
  ent.push({ from: "pages/new", ok: v.path === "/admin/editor" && (await editorOpen(page)), at: v.path + v.search });
  drill.check(ent.every((e) => e.ok), "after the move: Catalog for a product and for a collection, Upsells for a product, an old page, a missing page and 'new' each open the editor where that thing is edited", ent);

  // ---- the bare Catalog page and Publishing ----
  v = await visit(page, base, "/admin/catalog");
  const catText = await page.locator("main").innerText();
  const productsLink = page.locator('main a[href="/admin/editor?list=products"]');
  drill.check(v.path === "/admin/catalog" && v.status === 200 && (await productsLink.count()) >= 1 && /Bundles/i.test(catText) && /Quiz/i.test(catText), "the bare Catalog page stays (Bundles and Quiz live there) and links to the editor's product list", { at: v.path, links: await productsLink.count() });
  await drill.screenshot(page, "catalog-bare-1440");
  await productsLink.first().click();
  await page.waitForURL(/\/admin\/editor/, { timeout: 60_000 });
  drill.check(await editorOpen(page), "its product-list link opens the editor", page.url());
  v = await visit(page, base, "/admin/releases");
  drill.check(v.path === "/admin/releases" && (await page.locator("[data-recently-published]").count()) === 1, "Publishing is the Recently published page", v);

  // ---- the setup checklist ----
  v = await visit(page, base, "/admin/setup");
  const links = await page.locator("main a", { hasText: /^Open$/ }).evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  const old = links.filter((h) => /^\/admin\/(catalog|home|upsells)(\b|\/|\?|$)|^\/admin\/storefront\/?$/.test(h || ""));
  drill.check(links.length > 0 && old.length === 0, "the Setup checklist's links point at the editor, never at an old editor", { links, old });
  await drill.screenshot(page, "setup-checklist-1440");
  const broken = [];
  for (const h of [...new Set(links)]) {
    const r = await visit(page, base, h);
    const text = await page.locator("body").innerText();
    const fine = r.status === 200 && !/Something went wrong|Application error|This page could not be found/i.test(text) && (!r.path.startsWith("/admin/editor") || (await editorOpen(page)));
    if (!fine) broken.push({ href: h, ...r });
  }
  drill.check(broken.length === 0, `every Setup link (${new Set(links).size}) opens a working screen`, broken);

  // ---- saved templates ----
  v = await visit(page, base, "/admin/editor/templates");
  const listed = await page.locator("[data-saved-template]").evaluateAll((ls) => ls.map((l) => l.getAttribute("data-saved-template")));
  drill.check(seed.templates.every((t) => listed.includes(t)), "the Saved templates page lists both old saved templates", { listed, seeded: seed.templates });
  await drill.screenshot(page, "saved-templates-1440");
  const docsBefore = Number(rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT count(*) AS n FROM documents"]))[0])[0].n);
  await page.locator(`[data-saved-template="${seed.templates[0]}"] [data-make-page]`).click();
  await page.waitForURL((u) => u.pathname === "/admin/editor" && Boolean(u.searchParams.get("doc")), { timeout: 60_000 });
  const made = new URL(page.url()).searchParams.get("doc");
  const madeRow = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT id, type, published_version_id FROM documents WHERE id = ?", args: [made] }]))[0])[0];
  const docsAfter = Number(rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT count(*) AS n FROM documents"]))[0])[0].n);
  drill.check(Boolean(madeRow) && madeRow.published_version_id == null && docsAfter === docsBefore + 1 && (await editorOpen(page)), "'Make a page from this' opens a new, unpublished draft in the editor", { made: madeRow, docsBefore, docsAfter });
  await drill.screenshot(page, "page-from-template-1440");
  const tplAfter = rowsOf((await sqlAt(ctx.urls.tenant, [TPL_SIG]))[0])[0];
  drill.check(JSON.stringify(tplAfter) === JSON.stringify(before.tpl), "the old saved templates are unchanged", { before: before.tpl, after: tplAfter });
  drill.check(errors.length === 0, "no page errors in the console", { errors: errors.slice(0, 5) });
  void legacyAddresses;
  void DrillError;
  await bctx.close();
}
