// P4-DRILLS 'reverse' stage (MIG-04, MIG-03, ED-05): back to the old editor,
// the old editors working again, then the move again, in desktop Chrome at
// 1440 px. Builder-only: local sqld, no --hosted, no Shopify, no Typesense.
//
//   1. a fresh --p4 store moved to the new editor (rehearsal, dry run, move)
//   2. the founder renames a product in the new editor and publishes; a
//      shopper sees the new name
//   3. the reversal's dry run names the product and its new name; the
//      reversal with its digest; its message for the founder; --status
//   4. a shopper sees Shopify's name again; the old screens open again (no
//      redirect to the editor); an old Storefront save, an old Catalog save
//      and an old publish all go through; the shopper sees the old editor's
//      announcement
//   5. the move again (a fresh copy, rehearsal, dry run listing the edit that
//      comes back, the move): the shopper sees the renamed name again and
//      the old editor's announcement (the old editor wins for what it edits);
//      the old screens lead to the editor again
import { DrillError, copyServer, docsApi, moveStore, movedP4Store, noThanks, rowsOf, settle, shopperContext, sleep, sqlAt, consoleUrl } from "./lib.mjs";

const NEW_NAME = "Drill Renamed Bestseller";
const ANNOUNCEMENT = "Reversal drill: saved in the old editor";

const api = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body },
  );

async function shopperLook(drill, base, path, label) {
  const ctx = await shopperContext(drill, base, "p4-drills-reverse");
  const page = await ctx.newPage();
  await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await noThanks(page);
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 90_000 });
  const seen = await page.evaluate(() => ({ h1: document.querySelector("h1")?.innerText?.trim() ?? null, body: document.body.innerText }));
  await drill.screenshot(page, `${label}-1440`);
  await ctx.close();
  return seen;
}

export async function reverseStage(drill) {
  const { seed, ctx, scratch, routesFile } = await movedP4Store(drill, "reverse");
  const base = ctx.base;
  const productPath = seed.chosenProduct.path;
  const prod = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT id, title FROM products WHERE handle = ?", args: [productPath.split("/").pop()] }]))[0])[0];
  const shopifyName = String(prod.title);

  // ---- 2. the founder renames it in the new editor ----
  const bctx = await drill.context({ width: 1440 });
  const admin = await drill.login("owner", { context: bctx });
  await admin.goto(consoleUrl(base, `/admin/editor?product=${encodeURIComponent(prod.id)}`), { waitUntil: "load", timeout: 120_000 });
  await settle(admin);
  await admin.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const opened = await docsApi(admin, { openEntityContent: { type: "product_content", entityId: prod.id } });
  const doc = opened.body?.document;
  const saved = await docsApi(admin, { saveDraft: { id: doc.id, body: { ...doc.body, settings: { ...doc.body.settings, title: { value: NEW_NAME } } } }, revision: doc.revision });
  const sd = saved.body?.document;
  const pub = await docsApi(admin, { publish: { id: sd?.id, draftHash: sd?.draftHash }, revision: sd?.revision });
  drill.check(opened.status === 200 && saved.status === 200 && pub.status === 200, "the founder renames the product in the new editor and publishes", { open: opened.status, save: saved.status, publish: pub.status });
  await sleep(1500);
  const renamed = await shopperLook(drill, base, productPath, "reverse-product-renamed");
  drill.check(renamed.h1 === NEW_NAME, "a shopper sees the new name", { h1: renamed.h1 });

  // ---- 3. the reversal ----
  const rdry = await ctx.reverse(["--tenant", ctx.store, "--dry-run"]);
  const rdigest = /Reversal dry-run digest: ([0-9a-f]{64})/.exec(rdry.out)?.[1];
  drill.check(rdry.code === 0 && /^Ready to move back to the old editor/.test(rdry.out) && Boolean(rdigest), "the reversal's dry run says Ready to move back to the old editor", rdry.out.split("\n")[0]);
  drill.check(rdry.out.includes(`“${shopifyName}”: new name (“${NEW_NAME}”)`), "the reversal's dry run names the product and its new name", rdry.out.split("\nDetails")[0].slice(0, 1500));
  const rv = await ctx.reverse(["--tenant", ctx.store, "--dry-run-digest", String(rdigest)]);
  drill.check(rv.code === 0 && rv.out.startsWith("Your store is back on the old editor.") && rv.out.includes("A message you can pass on"), "the reversal finishes, with a message for the founder", rv.out.split("\nDetails")[0].slice(0, 1500));
  const back = (await sqlAt(ctx.urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1", "SELECT live_release_id AS id FROM release_state WHERE id = 1", "SELECT count(*) AS n FROM product_content_live"])).map((r) => r.rows[0]);
  drill.check(back[0].mode === "legacy" && back[1].id === seed.liveRelease && Number(back[2].n) === 0, "the store is on the old editor, live on the release from before the move, with no live product rows", back);
  const st = await ctx.reverse(["--tenant", ctx.store, "--status"]);
  drill.check(st.code === 0 && /Your store uses the old editor\. No reversal is under way\./.test(st.out), "the reversal's --status says the store uses the old editor", st.out.trim().split("\n")[0]);
  await sleep(1500);

  // ---- 4. the old editors work again ----
  const reversed = await shopperLook(drill, base, productPath, "reverse-product-after-reversal");
  drill.check(reversed.h1 === shopifyName, "a shopper sees Shopify's name again", { h1: reversed.h1 });
  const screens = [];
  for (const path of ["/admin/storefront", "/admin/catalog", "/admin/upsells", "/admin/brand"]) {
    const res = await admin.goto(`${base}${path}`, { waitUntil: "load", timeout: 120_000 });
    await settle(admin);
    screens.push({ path, status: res?.status(), at: new URL(admin.url()).pathname });
  }
  drill.check(screens.every((s) => s.status === 200 && s.at === s.path), "the old screens open again (no redirect to the new editor)", screens);
  await admin.goto(consoleUrl(base, `/admin/storefront`), { waitUntil: "load", timeout: 120_000 });
  await settle(admin);
  await drill.screenshot(admin, "reverse-old-storefront-screen-1440");
  // the old Storefront screen's own save: the revision it loaded, then the block
  const view = await api(admin, "GET", "/api/admin/storefront");
  const ann = await api(admin, "PUT", "/api/admin/storefront", { block: "announcement", value: { enabled: true, text: ANNOUNCEMENT, href: "" }, revision: view.body?.revisions?.announcement ?? null });
  const ov = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT modules FROM product_overrides WHERE product_id = ?", args: [prod.id] }]))[0])[0];
  const cat = await api(admin, "POST", "/api/admin/catalog", { product: { handle: productPath.split("/").pop(), modules: JSON.parse(ov?.modules || "[]"), badge: "Back on the old editor" } });
  const rel = await api(admin, "POST", "/api/admin/releases", { action: "publish", note: "P4-DRILLS: after the reversal" });
  drill.check(ann.status === 200 && cat.status === 200 && rel.status === 200, "the old editors save again (an announcement in Storefront, a badge in Catalog) and Publishing publishes", { announcement: ann.status, announcementError: ann.body?.error, catalog: cat.status, catalogError: cat.body?.error, publish: rel.status, publishError: rel.body?.error });
  await sleep(1500);
  const legacyLook = await shopperLook(drill, base, productPath, "reverse-old-editor-edit-live");
  drill.check(legacyLook.body.includes(ANNOUNCEMENT) && legacyLook.body.includes("Back on the old editor"), "a shopper sees the old editor's announcement and badge", null);

  // ---- 5. the move again ----
  const copy = await copyServer(scratch);
  let again;
  try {
    again = await moveStore(drill, ctx, { label: "the move again", copy, routesFile, scratch });
  } finally {
    await copy.stop();
  }
  drill.check(again.dry.out.includes("Edits that come back at the move") && again.dry.out.includes(`“${shopifyName}”: new name (“${NEW_NAME}”).`), "the second move's dry run lists, by name, the edit that comes back", again.dry.out.split("\nDetails")[0].slice(-1500));
  const moved = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT mode FROM cms_state WHERE id = 1"]))[0])[0];
  if (moved.mode !== "documents") throw new DrillError(`the second move didn't finish (${moved.mode})`);
  const final = await shopperLook(drill, base, productPath, "reverse-product-after-second-move");
  drill.check(final.h1 === NEW_NAME, "after the second move, a shopper sees the renamed name again", { h1: final.h1 });
  drill.check(final.body.includes(ANNOUNCEMENT) && final.body.includes("Back on the old editor"), "and the old editor's announcement and badge (the old editor wins for what it edits)", null);
  const res = await admin.goto(consoleUrl(base, `/admin/storefront`), { waitUntil: "load", timeout: 120_000 });
  await settle(admin);
  drill.check(res?.status() === 200 && new URL(admin.url()).pathname === "/admin/editor", "the old Storefront screen leads to the new editor again", admin.url());
  await bctx.close();
}
