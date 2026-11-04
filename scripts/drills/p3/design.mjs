// P3-DESIGN drill (TOK-03): the design document on a documents store, in
// desktop Chrome on the design harness (the phase 3 seed).
//
//   DESIGN_PORT=6120 DESIGN_SQLD_PORT=7120 node scripts/drills/p3/design.mjs [--headed]
//
// Signed in as the owner, through the console's own API from the signed-in
// page (the editor's Design form is P3-EDITOR's; this drill drives the same
// calls it makes):
//   1. the look: POST /api/admin/theme apply "glow" (no starter brand, no hero
//      words): a doc_design draft only; shoppers still see the old look
//   2. change a colour: saveDraft doc_design with a new accent; shoppers still
//      see the old accent
//   3. the change list: listChanges names the colour and the look, each with
//      the live sections that use it
//   4. preview: a preview session shows the old colours until "show my new
//      colours" is on, then the new accent and the glow look
//   5. publish: shoppers see the new accent and look; the store's theme_pin
//      (control plane) is glow
//   6. Undo: shoppers see the old accent and look again; theme_pin is back
// The old Brand and Theme screens send the owner to the editor at the design
// document (P3-ROUTES), and the brand API refuses a save with the editor's
// address. Results: docs/cms-reviews/drills/P3-DESIGN/results-design.json,
// with screenshots.
import { fileURLToPath } from "node:url";
import { DrillError, docsApi, noThanks, readSeed, reseed, runDrill, settle, storeSql, storeUrl } from "./lib.mjs";

const NEW_ACCENT = "#dc2626";

const look = (page) =>
  page.evaluate(() => ({
    kit: document.documentElement.getAttribute("data-kit"),
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent-500").trim().toLowerCase(),
  }));

const consoleApi = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body },
  );

// What a shopper sees on /: a fresh context with no cookies, reloaded until it
// matches `want` (the storefront's own caches) or the time runs out.
async function shopperLook(drill, want = null, { timeoutMs = 20_000 } = {}) {
  const ctx = await drill.context();
  const page = await ctx.newPage();
  const until = Date.now() + timeoutMs;
  let seen = null;
  try {
    for (;;) {
      await page.goto(storeUrl(drill, "live", "/"), { waitUntil: "load", timeout: 120_000 });
      await noThanks(page);
      seen = await look(page);
      if (!want || (seen.kit === want.kit && seen.accent === want.accent) || Date.now() > until) break;
      await page.waitForTimeout(1000);
    }
    return { seen, page, ctx };
  } catch (e) {
    await ctx.close();
    throw e;
  }
}

async function pinOf(tenantId) {
  const [r] = await storeSql("platform", [{ sql: "SELECT config FROM tenants WHERE id = ?", args: [tenantId] }]);
  const cfg = JSON.parse(String(r.rows[0]?.config || "{}"));
  return { has: Object.hasOwn(cfg, "theme_pin"), pin: cfg.theme_pin ?? null, theme: cfg.theme ?? null };
}

export async function design(drill) {
  await reseed(drill);
  const seed = readSeed();
  const tenantId = seed.stores.live.id;
  const [mode] = await storeSql("tenant", ["SELECT mode FROM cms_state WHERE id = 1"]);
  drill.check(mode.rows[0]?.mode === "documents", "the phase 3 seed's store is in documents mode", mode.rows[0]?.mode);

  // ---- before ----
  const before = await shopperLook(drill);
  const old = before.seen;
  drill.check(/^#[0-9a-f]{6}$/.test(old.accent) && /^[a-z]+-\d+$/.test(old.kit) && old.accent !== NEW_ACCENT && old.kit !== "glow-1", "shoppers: the store's live look before the drill", old);
  await drill.screenshot(before.page, "1-live-before-1440");
  await before.ctx.close();
  const pin0 = await pinOf(tenantId);
  drill.note(`theme_pin before the drill: ${JSON.stringify(pin0)}`);

  const ctx = await drill.context();
  const page = await drill.login("owner", { context: ctx });

  // the old screens lead to the design document in the editor
  for (const route of ["/admin/brand", "/admin/theme"]) {
    await page.goto(route, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    const u = new URL(page.url());
    drill.check(u.pathname + u.search === "/admin/editor?doc=doc_design", `${route} opens the editor at the design document`, u.pathname + u.search);
  }
  const refused = await consoleApi(page, "PUT", "/api/admin/brand", { brand: { accent: NEW_ACCENT } });
  drill.check(refused.status === 409 && refused.body?.code === "STORE_USES_DOCUMENTS" && refused.body?.editor === "/admin/editor?doc=doc_design" && /editor/.test(refused.body?.error || ""), "the brand API refuses a save and names the editor", { status: refused.status, body: refused.body });

  // ---- 1. the look ----
  const g = await consoleApi(page, "GET", "/api/admin/theme");
  drill.check(g.status === 200 && g.body?.design?.id === "doc_design" && g.body?.design?.editor === "/admin/editor?doc=doc_design", "the theme API reads the design document on a documents store", { status: g.status, design: g.body?.design, theme: g.body?.theme });
  const applied = await consoleApi(page, "POST", "/api/admin/theme", { action: "apply", kit: "glow", withPresets: false, withBrand: false, ...(Number.isInteger(g.body?.design?.revision) ? { revision: g.body.design.revision } : {}) });
  drill.check(applied.status === 200 && applied.body?.applied?.theme?.kit === "glow" && applied.body?.applied?.document?.id === "doc_design", "apply the glow look: saved as a doc_design draft", { status: applied.status, applied: applied.body?.applied, error: applied.body?.error });
  const pinAfterApply = await pinOf(tenantId);
  drill.check(JSON.stringify(pinAfterApply) === JSON.stringify(pin0), "applying a look writes nothing to the store's control-plane config", pinAfterApply);

  // ---- 2. change a colour ----
  const cur = await docsApi(page, { getDocument: "doc_design" });
  if (cur.status !== 200) throw new DrillError(`The design document couldn't be read after the apply (${cur.status}).`);
  const next = structuredClone(cur.body.document.body);
  next.settings = { ...(next.settings || {}), brand: { ...(next.settings?.brand || {}), accent: NEW_ACCENT } };
  const saved = await docsApi(page, { saveDraft: { id: "doc_design", body: next }, revision: cur.body.document.revision });
  drill.check(saved.status === 200 && saved.body?.document?.body?.settings?.brand?.accent === NEW_ACCENT, `change the accent to ${NEW_ACCENT}: saved as a draft`, { status: saved.status, error: saved.body?.error });
  const still = await shopperLook(drill);
  drill.check(still.seen.accent === old.accent && still.seen.kit === old.kit, "shoppers still see the old accent and look (nothing is published)", still.seen);
  await still.ctx.close();

  // ---- 3. the change list ----
  const ch = await docsApi(page, { listChanges: "doc_design" });
  const rows = ch.body?.rows || [];
  const colours = rows.find((r) => /^Colours: .*accent/.test(r.words));
  const lookRow = rows.find((r) => /^Look: /.test(r.words));
  drill.check(ch.status === 200 && ch.body?.firstPublish === false && !!colours && !!lookRow, "the change list names the colour and the look", rows.map((r) => r.words));
  drill.check(
    !!colours && colours.affects.some((a) => /^Every page: header/.test(a.words)) && colours.affects.some((a) => /^Home page: .*Hero/.test(a.words)),
    "the colour row lists the live parts that use it (every page's header and footer, the home page's sections)",
    colours?.affects,
  );
  drill.check(
    !!lookRow && lookRow.affects.some((a) => a.words === "Every page: header") && lookRow.affects.some((a) => a.words === "Home page: Hero") && lookRow.affects.length === 2,
    "the look row lists only what the look styles: the header and the home page's hero",
    lookRow?.affects,
  );
  drill.check(rows.every((r) => (r.affects || []).every((a) => !/sec_|doc_|ver_/.test(a.words))), "the rows are plain words (no ids)", null);

  // ---- 4. preview ----
  const ps = await consoleApi(page, "POST", "/api/admin/preview-session", { create: true });
  if (ps.status !== 200) throw new DrillError(`A preview session couldn't be made (${ps.status}): ${JSON.stringify(ps.body).slice(0, 200)}`);
  await page.goto(ps.body.previewUrl, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await noThanks(page);
  const pv0 = await look(page);
  drill.check(pv0.accent === old.accent && pv0.kit === old.kit, "preview: the new colours are not shown until asked (show design is off)", pv0);
  const on = await consoleApi(page, "POST", "/api/admin/preview-session", { showDesign: { sid: ps.body.sid, on: true } });
  drill.check(on.status === 200 && on.body?.showDesign === true, "preview: show my new colours", on.status);
  await page.reload({ waitUntil: "load" });
  await settle(page);
  const pv1 = await look(page);
  drill.check(pv1.accent === NEW_ACCENT && pv1.kit === "glow-1", "preview: the new accent and the glow look", pv1);
  await drill.screenshot(page, "2-preview-new-colours-1440");
  const shopperDuring = await shopperLook(drill);
  drill.check(shopperDuring.seen.accent === old.accent && shopperDuring.seen.kit === old.kit, "shoppers, during the preview: the old look", shopperDuring.seen);
  await shopperDuring.ctx.close();
  await page.goto("/api/preview?exit=1&to=/admin/dashboard", { waitUntil: "load" }).catch(() => {});
  await page.goto(storeUrl(drill, "live", "/admin/dashboard"), { waitUntil: "load" });

  // ---- 5. publish ----
  const d = await docsApi(page, { getDocument: "doc_design" });
  const pub = await docsApi(page, { publish: { id: "doc_design", draftHash: d.body.document.draftHash }, revision: d.body.document.revision });
  const item = (pub.body?.items || pub.body?.published || [])[0];
  drill.check(pub.status === 200 && item?.id === "doc_design" && !!item?.undo?.logId, "publish the design", { status: pub.status, error: pub.body?.error, code: pub.body?.code, item });
  const after = await shopperLook(drill, { accent: NEW_ACCENT, kit: "glow-1" });
  drill.check(after.seen.accent === NEW_ACCENT && after.seen.kit === "glow-1", "shoppers: the new accent and the glow look are live", after.seen);
  await drill.screenshot(after.page, "3-live-after-publish-1440");
  await after.ctx.close();
  const pin1 = await pinOf(tenantId);
  drill.check(pin1.has && pin1.pin?.kit === "glow" && pin1.pin?.version === 1 && typeof pin1.pin?.release === "string", "the store's theme_pin is the live look (glow)", pin1);
  drill.check(JSON.stringify(pin1.theme) === JSON.stringify(pin0.theme), "the legacy config.theme is not written", { before: pin0.theme, after: pin1.theme });
  const nothing = await docsApi(page, { listChanges: "doc_design" });
  drill.check(nothing.status === 200 && (nothing.body?.rows || []).length === 0, "after publish: nothing left to publish in the design", nothing.body?.rows);

  // ---- 6. Undo ----
  const d2 = await docsApi(page, { getDocument: "doc_design" });
  const un = await docsApi(page, { undo: { id: "doc_design", logId: item?.undo?.logId }, revision: d2.body?.document?.revision });
  drill.check(un.status === 200 && un.body?.ok === true, "Undo the design publish", { status: un.status, message: un.body?.message, error: un.body?.error, code: un.body?.code });
  const back = await shopperLook(drill, old);
  drill.check(back.seen.accent === old.accent && back.seen.kit === old.kit, "shoppers: the old accent and look are back", back.seen);
  await drill.screenshot(back.page, "4-live-after-undo-1440");
  await back.ctx.close();
  const pin2 = await pinOf(tenantId);
  const oldKit = old.kit.split("-")[0];
  drill.check(pin2.has && (pin2.pin === null ? oldKit === "pulse" : pin2.pin.kit === oldKit) && pin2.pin?.release !== pin1.pin?.release, "after Undo the theme_pin is the live look again", { pin: pin2.pin, liveKit: old.kit });

  await consoleApi(page, "POST", "/api/admin/preview-session", { revoke: ps.body.sid }).catch(() => null);
  await ctx.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await runDrill({ id: "P3-DESIGN", part: "design", title: "P3-DESIGN — change a colour, preview, publish, Undo" }, design);
  process.exit(code);
}
