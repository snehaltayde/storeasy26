// P4-DRILLS 'media' stage (MED-03): the media library after a move, in
// desktop Chrome at 1440 px, signed in as the owner.
//
//   before the move, on the old editor (the old Catalog API and Publishing):
//     a fresh photo is put into a product's module and published (an old,
//     version 3 release), then the module is taken out and published again.
//     The photo is now used only by that older release, which the move keeps
//     for rollback.
//   after the move:
//     rollback  "Where it's used" lists the release the move kept; Delete is
//               refused in plain words, and a forced delete is refused too;
//               the file stays
//     used      Delete on the photo a product's module uses (the seed's
//               module-only photo, now in the new editor) is refused in
//               plain words naming the product, with "Archive it instead"
//               and no "Delete anyway"
//     archive   a fresh, unused file: "Not used anywhere", Archive hides it,
//               "Show archived files" shows it marked, Unarchive brings it back
import { DrillError, movedP4Store, rowsOf, settle, sqlAt, waitFor, consoleUrl } from "./lib.mjs";

// a 2x2 PNG made in the page, uploaded through the real route
const UPLOAD_JS = async (name) => {
  const c = document.createElement("canvas");
  c.width = 2;
  c.height = 2;
  const g = c.getContext("2d");
  g.fillStyle = name.includes("rollback") ? "#a35" : "#3a7";
  g.fillRect(0, 0, 2, 2);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const fd = new FormData();
  fd.append("file", new File([blob], name, { type: "image/png" }));
  fd.append("width", "2");
  fd.append("height", "2");
  const res = await fetch("/api/admin/media", { method: "POST", body: fd });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const api = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body },
  );

async function openMedia(page, base, id) {
  await page.goto(consoleUrl(base, `/admin/media`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const card = page.locator(`[data-media-file="${id}"]`);
  await card.waitFor({ timeout: 60_000 });
  await card.scrollIntoViewIfNeeded();
  return card;
}

export async function mediaStage(drill) {
  const { seed, ctx, before } = await movedP4Store(drill, "media", {
    beforeMove: async ({ ctx }) => {
      const bctx = await drill.context({ width: 1440 });
      const page = await drill.login("owner", { context: bctx });
      const [product] = rowsOf((await sqlAt(ctx.urls.tenant, ["SELECT p.id, p.handle, p.title FROM products p WHERE NOT EXISTS (SELECT 1 FROM product_overrides o WHERE o.product_id = p.id) ORDER BY p.title LIMIT 1"]))[0]);
      const up = await page.evaluate(UPLOAD_JS, `p4-drill-rollback-${Date.now() % 100000}.png`);
      if (up.status !== 200) throw new DrillError(`uploading the photo answered ${up.status}`);
      const photo = up.body.media;
      const put = await api(page, "POST", "/api/admin/catalog", { product: { handle: product.handle, modules: [{ title: "Lab photo", html: `<p>Our old lab photo.</p><p><img src="/api/media/${photo.id}" alt="An old lab photo"></p>` }] } });
      const r1 = await api(page, "POST", "/api/admin/releases", { action: "publish", note: "P4-DRILLS: the old lab photo" });
      const off = await api(page, "POST", "/api/admin/catalog", { product: { handle: product.handle, modules: [], badge: null } });
      const r2 = await api(page, "POST", "/api/admin/releases", { action: "publish", note: "P4-DRILLS: the lab photo taken out" });
      const rel1 = r1.body?.published?.id ?? null;
      const rel2 = r2.body?.published?.id ?? null;
      drill.check(put.status === 200 && off.status === 200 && r1.status === 200 && r2.status === 200 && rel1 && rel2, "on the old editor: a product's module shows a fresh photo, published; then the module is taken out, published again", { product: product.title, photo: photo.id, put: put.status, r1: r1.status, off: off.status, r2: r2.status, rel1, rel2 });
      const relRows = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT id, instr(content, ?) > 0 AS uses FROM releases WHERE id IN (?, ?)", args: [`/api/media/${photo.id}`, rel1 || "", rel2 || ""] }]))[0]);
      drill.check(relRows.find((r) => r.id === rel1)?.uses === 1 && relRows.find((r) => r.id === rel2)?.uses === 0, "the photo is in the older release only, not in the live one", relRows);
      await bctx.close();
      return { photo, rel1, rel2, product };
    },
  });
  const base = ctx.base;
  const { photo, rel1 } = before;
  const bctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: bctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));

  // ---- a file used only by the release kept for rollback ----
  const refs = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT version_id, ref_id FROM document_refs WHERE ref_type = 'media' AND (ref_id = ? OR instr(ref_id, ?) > 0)", args: [photo.id, `/api/media/${photo.id}`] }]))[0]);
  drill.check(refs.length >= 1 && refs.every((r) => r.version_id === `release:${rel1}`), "after the move: the store's reference index holds the photo for the release the move kept, and nothing else", refs);
  await openMedia(page, base, photo.id);
  await page.locator(`[data-media-usage="${photo.id}"]`).click();
  const usedBy = page.locator(`[data-media-used-by="${photo.id}"]`);
  await usedBy.waitFor({ timeout: 20_000 });
  const usedWords = await usedBy.innerText();
  drill.check(!usedWords.includes("Not used anywhere") && /An earlier published version of your store/.test(usedWords) && !/rel_|release:/.test(usedWords), "'Where it's used' lists the release kept for rollback, in plain words ('An earlier published version of your store')", { said: usedWords });
  await drill.screenshot(page, "media-rollback-used-1440");
  await page.getByRole("button", { name: `Delete ${photo.filename}`, exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Delete", exact: true }).click();
  const refused = page.locator("[data-delete-refused]");
  await refused.waitFor({ timeout: 20_000 });
  const words = await refused.innerText();
  const forced = await api(page, "DELETE", "/api/admin/media", { id: photo.id, force: true });
  const still = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT count(*) AS n FROM media WHERE id = ?", args: [photo.id] }]))[0])[0];
  drill.check(words.includes("wasn't deleted") && !/doc_|med_|ver_|rel_/.test(words) && (await page.getByRole("button", { name: "Delete anyway" }).count()) === 0 && forced.status === 409 && Number(still.n) === 1, "Delete of that photo is refused in plain words (no 'Delete anyway'); a forced delete is refused too; the file stays", { words, forced: forced.status, code: forced.body?.code });
  await drill.screenshot(page, "media-rollback-delete-refused-1440");

  // ---- a file a product's module uses (now in the new editor) ----
  const used = seed.moduleOnlyPhoto;
  const usedRow = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT filename FROM media WHERE id = ?", args: [used] }]))[0])[0];
  await openMedia(page, base, used);
  await page.getByRole("button", { name: `Delete ${usedRow.filename}`, exact: true }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "Delete", exact: true }).click();
  const refused2 = page.locator("[data-delete-refused]");
  await refused2.waitFor({ timeout: 20_000 });
  const words2 = await refused2.innerText();
  const still2 = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT count(*) AS n FROM media WHERE id = ?", args: [used] }]))[0])[0];
  drill.check(words2.includes("wasn't deleted") && /\(live\)/.test(words2) && !/doc_|med_|ver_|gid:/.test(words2) && (await page.getByRole("button", { name: "Archive it instead" }).count()) === 1 && (await page.getByRole("button", { name: "Delete anyway" }).count()) === 0 && Number(still2.n) === 1, `Delete of the photo ${seed.chosenProduct.title}'s module uses (live in the new editor) is refused in plain words, with 'Archive it instead' and no 'Delete anyway'; the file stays`, { words: words2 });
  // P4-DRILLS finding F1: the move labels every product and collection
  // content document with the type's name ("Product content"), and a label is
  // never renamed afterwards, so the refusal can't say which product
  drill.check(words2.includes(seed.chosenProduct.title), `the refusal names the product (${seed.chosenProduct.title})`, { words: words2 }, { known: "P4-DRILLS finding F1: documents made by the move are labelled 'Product content'" });
  await drill.screenshot(page, "media-used-delete-refused-1440");

  // ---- archive an unused file ----
  const up = await page.evaluate(UPLOAD_JS, `p4-drill-unused-${Date.now() % 100000}.png`);
  if (up.status !== 200) throw new DrillError(`uploading the unused file answered ${up.status}`);
  const fresh = up.body.media;
  const card = await openMedia(page, base, fresh.id);
  await page.locator(`[data-media-usage="${fresh.id}"]`).click();
  const usage = page.locator(`[data-media-used-by="${fresh.id}"]`);
  await usage.waitFor({ timeout: 20_000 });
  drill.check((await usage.innerText()).includes("Not used anywhere."), "archive: 'Where it's used' says the fresh file is not used anywhere", { said: await usage.innerText() });
  await page.locator(`[data-media-archive="${fresh.id}"]`).click();
  const gone = await waitFor(async () => (await card.count()) === 0, 20_000);
  const arch = rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT archived_at FROM media WHERE id = ?", args: [fresh.id] }]))[0])[0];
  drill.check(Boolean(gone) && arch?.archived_at != null, "archive: Archive hides the file from the library, and the store holds it as archived", arch);
  await page.locator("#media-show-archived").check();
  const back = await waitFor(async () => (await page.locator(`[data-media-file="${fresh.id}"][data-archived]`).count()) === 1, 20_000);
  drill.check(Boolean(back), "archive: 'Show archived files' shows it, marked", null);
  await page.locator(`[data-media-file="${fresh.id}"]`).scrollIntoViewIfNeeded();
  await drill.screenshot(page, "media-archived-1440");
  await page.locator(`[data-media-unarchive="${fresh.id}"]`).click();
  const un = await waitFor(async () => rowsOf((await sqlAt(ctx.urls.tenant, [{ sql: "SELECT archived_at FROM media WHERE id = ?", args: [fresh.id] }]))[0])[0]?.archived_at == null, 20_000);
  drill.check(Boolean(un), "archive: Unarchive brings it back to the library", null);
  drill.check(errors.length === 0, "no page errors in the console", { errors: errors.slice(0, 5) });
  await bctx.close();
}
