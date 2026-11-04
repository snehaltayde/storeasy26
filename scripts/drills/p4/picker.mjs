// P4-PICKER drill (MED-03, OVL-04, ED-12): the editor's library picker and
// the media screen's archive, in desktop Chrome on the design harness.
//
//   DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node scripts/drills/p4/picker.mjs [--headed]
//
// On the phase 3 seed (a documents store, the perf library photos), signed in
// as the owner, at 1440 px:
//   gallery   open a product's content in the editor, press "Add from your
//             library" in its Images control, choose a photo in the media
//             picker: it autosaves as { media: "/api/media/<id>", alt } in
//             the draft's gallery overlay, and the image shows in the list
//   archive   upload a fresh file (used nowhere), then on Media press
//             "Where it's used" (not used anywhere) and Archive: it leaves the
//             list, the store holds it as archived, "Show archived files"
//             shows it marked, and the editor's picker no longer offers it
//   refuse    Delete on the photo now in the gallery draft: refused in plain
//             words naming the product, with "Archive it instead" and no
//             "Delete anyway"; the file is kept
// Results: docs/cms-reviews/drills/P4-PICKER/results-picker.json, with screenshots.
import { DrillError, docsApi, reseed, runDrill, settle, storeSql } from "./lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30_000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(step);
  }
  return false;
}
const saveStatus = (page) => page.locator("[data-save-status]").first().getAttribute("data-save-status").catch(() => null);
const rowsOf = (r) => r.rows.map((x) => ({ ...x }));
// a 2x2 PNG, made in the page so the upload goes through the real route
const UPLOAD_JS = async (name) => {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const g = c.getContext("2d");
  g.fillStyle = "#3a7";
  g.fillRect(0, 0, 2, 2);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const fd = new FormData();
  fd.append("file", new File([blob], name, { type: "image/png" }));
  fd.append("width", "2");
  fd.append("height", "2");
  const res = await fetch("/api/admin/media", { method: "POST", body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function picker(drill) {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));

  // ---- a product's content, opened the way the API opens it ----
  const [prodRows] = await storeSql("live", ["SELECT id, title FROM products ORDER BY title, id LIMIT 1"]);
  const product = rowsOf(prodRows)[0];
  if (!product) throw new DrillError("the seeded store has no products");
  const opened = await docsApi(page, { openEntityContent: { type: "product_content", entityId: product.id } });
  if (opened.status !== 200) throw new DrillError(`openEntityContent answered ${opened.status}: ${JSON.stringify(opened.body)}`);
  const docId = opened.body.document.id;
  drill.check(Array.isArray(opened.body.shopify?.gallery), "gallery: the product's content opens, with what Shopify sends now", { docId, product: product.title, shopifyImages: opened.body.shopify?.gallery?.length });

  await page.goto(`/admin/editor?doc=${encodeURIComponent(docId)}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const gallery = page.locator("[data-gallery-control]");
  await gallery.waitFor({ timeout: 90_000 });
  const shopifyShown = await waitFor(async () => (await page.locator("[data-gallery-shopify] [data-shopify-image]").count()) > 0 || (await page.locator("[data-gallery-shopify]").innerText()).includes("Shopify has no images"), 30_000);
  drill.check(Boolean(shopifyShown) && (await gallery.getAttribute("data-following")) === "", "gallery: the Images control shows, following Shopify, with Shopify's images beside it", { shopifyImages: await page.locator("[data-gallery-shopify] [data-shopify-image]").count() });
  await drill.screenshot(page, "editor-gallery-following-1440");

  // keyboard: the library button is reached and pressed with the keyboard
  const lib = page.locator("[data-gallery-library]");
  await lib.focus();
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Enter");
  const dialog = page.locator("dialog[open]").filter({ hasText: "Choose an image" });
  await dialog.waitFor({ timeout: 30_000 });
  const firstPick = dialog.locator('ul[aria-label="Media library"] button').first();
  await firstPick.waitFor({ timeout: 30_000 });
  const title = await firstPick.getAttribute("title");
  const filename = String(title || "").split(" — ")[0];
  const [mediaRows] = await storeSql("live", [{ sql: "SELECT id, alt FROM media WHERE filename = ? AND parent_id IS NULL", args: [filename] }]);
  const chosen = rowsOf(mediaRows)[0];
  if (!chosen) throw new DrillError(`the picker offered "${filename}", which the store doesn't hold`);
  drill.check(focused === "Add from your library", "gallery: 'Add from your library' takes the keyboard focus and Enter opens the media picker", { focused });
  await drill.screenshot(page, "editor-media-picker-1440");
  await firstPick.click();
  await dialog.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  const saved = await waitFor(async () => (await saveStatus(page)) === "saved" && (await page.locator("[data-gallery-item]").count()) === 1, 30_000);
  const doc = (await docsApi(page, { getDocument: docId })).body?.document;
  const g = doc?.body?.settings?.gallery;
  drill.check(Boolean(saved) && g?.value?.length === 1 && g.value[0].media === `/api/media/${chosen.id}` && g.value[0].alt === (chosen.alt || ""), "gallery: choosing a library photo autosaves { media: '/api/media/<id>', alt } in the product's gallery", { stored: g?.value, chosen: chosen.id, base: g ? Boolean(g.base_hash) : null });
  drill.check((await page.locator("[data-gallery-item] img").getAttribute("src")) === `/api/media/${chosen.id}` && (await page.locator("[data-gallery-use-shopify]").count()) === 1, "gallery: the photo shows in the list, and 'Use Shopify's images' is offered", null);
  await drill.screenshot(page, "editor-gallery-library-image-1440");

  // ---- archive an unused file ----
  const up = await page.evaluate(UPLOAD_JS, `drill-unused-${Date.now() % 100000}.png`);
  if (up.status !== 200) throw new DrillError(`uploading the unused file answered ${up.status}`);
  const fresh = up.body.media;
  await page.goto("/admin/media", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const card = page.locator(`[data-media-file="${fresh.id}"]`);
  await card.waitFor({ timeout: 60_000 });
  await page.locator(`[data-media-usage="${fresh.id}"]`).click();
  const usage = page.locator(`[data-media-used-by="${fresh.id}"]`);
  await usage.waitFor({ timeout: 20_000 });
  drill.check((await usage.innerText()).includes("Not used anywhere."), "archive: 'Where it's used' says the fresh file is not used anywhere", { said: await usage.innerText() });
  await page.locator(`[data-media-archive="${fresh.id}"]`).click();
  const gone = await waitFor(async () => (await card.count()) === 0, 20_000);
  const [arch] = await storeSql("live", [{ sql: "SELECT archived_at FROM media WHERE id = ?", args: [fresh.id] }]);
  drill.check(Boolean(gone) && rowsOf(arch)[0]?.archived_at != null, "archive: Archive hides the file from the library and the store holds it as archived", { archivedAt: rowsOf(arch)[0]?.archived_at });
  await page.locator("#media-show-archived").check();
  const back = await waitFor(async () => (await page.locator(`[data-media-file="${fresh.id}"][data-archived]`).count()) === 1, 20_000);
  drill.check(Boolean(back) && (await page.locator(`[data-media-unarchive="${fresh.id}"]`).count()) === 1, "archive: 'Show archived files' shows it, marked, with Unarchive", null);
  await page.locator(`[data-media-file="${fresh.id}"]`).scrollIntoViewIfNeeded();
  await drill.screenshot(page, "media-archived-shown-1440");

  // the editor's picker no longer offers it
  await page.goto(`/admin/editor?doc=${encodeURIComponent(docId)}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-gallery-library]").waitFor({ timeout: 90_000 });
  await page.locator("[data-gallery-library]").click();
  const dlg = page.locator("dialog[open]").filter({ hasText: "Choose an image" });
  await dlg.locator('ul[aria-label="Media library"] button').first().waitFor({ timeout: 30_000 });
  const offered = await dlg.locator('ul[aria-label="Media library"] button').evaluateAll((bs) => bs.map((b) => (b.getAttribute("title") || "").split(" — ")[0]));
  drill.check(!offered.includes(fresh.filename) && offered.length > 0, "archive: the editor's media picker no longer offers the archived file", { offered: offered.length, archived: fresh.filename });
  await page.keyboard.press("Escape");

  // ---- a used file: delete refused, archive offered ----
  await page.goto("/admin/media", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const usedCard = page.locator(`[data-media-file="${chosen.id}"]`);
  await usedCard.waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: `Delete ${filename}`, exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Delete", exact: true }).click();
  const refused = page.locator("[data-delete-refused]");
  await refused.waitFor({ timeout: 20_000 });
  const words = await refused.innerText();
  const [still] = await storeSql("live", [{ sql: "SELECT count(*) AS n FROM media WHERE id = ?", args: [chosen.id] }]);
  drill.check(
    words.includes("so it wasn't deleted") && words.includes(product.title) && !/doc_|med_|ver_/.test(words) && (await page.getByRole("button", { name: "Archive it instead" }).count()) === 1 && (await page.getByRole("button", { name: "Delete anyway" }).count()) === 0 && Number(rowsOf(still)[0].n) === 1,
    "refuse: deleting the photo the product's draft uses is refused in plain words naming the product, with Archive it instead and no Delete anyway; the file is kept",
    { words },
  );
  await drill.screenshot(page, "media-delete-refused-1440");
  drill.check(errors.length === 0, "no page errors in the console", { errors: errors.slice(0, 5) });
}

process.exitCode = await runDrill({ id: "P4-PICKER", part: "picker", title: "P4-PICKER — library picker, gallery and archive" }, picker);
