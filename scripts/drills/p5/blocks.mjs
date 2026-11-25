// P5-DRILLS: the bundle card and grid stages (US-28, US-33, the bundle half
// of US-34; COM-01, COM-02, TREE-01), in desktop Chrome on the design
// harness. Each stage starts from a fresh documents-mode store (lib.mjs
// docStore: the --p3 seed). Bundles are seeded in this process through
// lib/bundles.js (createBundle, setBundleEnabled, deleteBundle); stock and
// prices change through the sync writer (lib/sync.js writeProduct). Nothing
// reaches Shopify or Typesense: the harness env blanks both.
//
//   pick      US-28 (benchmark row 2): editor to live Bundle card, timed
//   create    COM-02: inline create, a failing price, one bundle, picked
//   states    US-33: a component sold out through the sync writer
//   nosaving  OQ-B: a bundle whose price no longer saves anything is hidden
//   disabled  US-34 (bundle half): turned off in Bundles
//   grid      a grid of 4: available, sold out, turned off, deleted
//   cart      the card's add equals the bundle page's; a COD test order,
//             cancelled at once
//   console   Bundles: no slug or GID inputs; a price edit keeps a
//             live bundle on and the card shows the new price
//   unknown   TREE-01: a draft with an unknown body source is refused 422
import { stateLine } from "../../../lib/commerce/bundle-words.js";
import { formatMoney } from "../../../lib/format.js";
import {
  DrillError,
  TEST_ORDER_EMAIL,
  UNIT,
  actOn,
  addSection,
  afterHero,
  bundleEnabled,
  bundleGone,
  bundleRows,
  bundleSection,
  closePanel,
  consoleUrl,
  docStore,
  docsApi,
  frameText,
  getDoc,
  harnessContext,
  inStore,
  inspectorOf,
  liveHome,
  liveHomeHtml,
  makeBundle,
  noShopifyOrPayment,
  noThanks,
  offerRows,
  openEditor,
  pickBundleIn,
  pickVariants,
  priced,
  publishAndRead,
  readBundles,
  readPanel,
  saveHome,
  selectSection,
  settle,
  shopper,
  sleep,
  soldOut,
  sqlAt,
  syncProduct,
  waitFor,
  waitPreview,
  waitSaved,
} from "./lib.mjs";

const INR = (n) => formatMoney(n, "INR");
const words = (state, reasons) => stateLine(state, reasons, { currency: "INR" });

// Every publish answer the editor gets, with its issue codes.
function watchPublishes(page) {
  const seen = [];
  page.on("response", async (r) => {
    try {
      if (!r.url().endsWith("/api/admin/documents") || r.request().method() !== "PUT") return;
      const sent = JSON.parse(r.request().postData() || "{}");
      if (!sent.publish) return;
      const body = await r.json().catch(() => null);
      seen.push({ status: r.status(), published: (body?.published || []).map((p) => p.id || p), issues: (body?.issues || []).map((i) => ({ code: i.code, level: i.level, sectionId: i.sectionId ?? null, field: i.field ?? null, actions: (i.actions || []).map((a) => a.type + (a.index != null ? `:${a.index}` : "")), message: i.message })) });
    } catch {}
  });
  return seen;
}

// Signed in as the owner in a fresh browser, on the editor.
async function ownerEditor(drill, query = "") {
  const ctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  const publishes = watchPublishes(page);
  await openEditor(page, query);
  return { ctx, page, errors, publishes };
}

// A bundle card (and grid) put on the live home: saved through the documents
// writer, published in the editor's own panel.
async function publishCard(drill, page, sections) {
  await saveHome(page, (b) => afterHero(b, sections));
  await openEditor(page);
  const r = await publishAndRead(page);
  await closePanel(page);
  return r;
}

const inspectorLines = async (page) => (await inspectorOf(page).locator("[data-bundle-status]").allInnerTexts()).map((t) => t.trim());
const issueWith = (panel, text) => panel.issues.find((i) => i.text.includes(text));

// change the card's heading, so the draft differs from live and publish runs
async function touchHeading(page, sectionId, title) {
  await saveHome(page, (b) => {
    const s = b.sections.find((x) => x.id === sectionId);
    s.settings = { ...s.settings, title };
    return b;
  });
  await openEditor(page);
}

// ---------------------------------------------------------------------------
// pick (US-28, benchmark row 2)
// ---------------------------------------------------------------------------
export async function pickStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(4);
  const duo = await makeBundle({ title: "Gym duo", variants: vs.slice(0, 2), price: Math.floor(vs[0].price + vs[1].price) - 100 });
  const other = await makeBundle({ title: "Morning stack", variants: vs.slice(2, 4), price: Math.floor(vs[2].price + vs[3].price) - 60 });
  drill.check(Number(duo.enabled) === 1 && Number(other.enabled) === 1 && duo.compat.state === "available", "seed: two turned-on bundles that pass ('Gym duo' and 'Morning stack', createBundle in this process)", { duo: [duo.slug, duo.enabled, duo.compat.state], other: [other.slug, other.enabled] });

  // a fresh browser, the owner signed in through the real form
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  const m0 = clicks.mark();
  const t0 = Date.now();
  const stamp = {};
  const lap = (k) => (stamp[k] = Math.round((Date.now() - t0) / 100) / 10);

  await openEditor(page);
  lap("editor open");
  const secId = await addSection(page, "bundle_card");
  lap("Bundle card added");
  await inspectorOf(page).locator('input[type="search"]').first().waitFor({ timeout: 30_000 });
  await pickBundleIn(page, "gym", duo.id);
  const saved = await waitSaved(page, 30_000);
  lap("bundle picked and saved");
  const inFrame = await waitPreview(page, (t) => t.includes("Gym duo"), 90_000);
  lap("preview shows the card");
  const line = (await inspectorLines(page))[0];
  drill.check(Boolean(saved) && Boolean(inFrame) && line === "Showing to shoppers.", "pick: Add a section > Bundle card, search 'gym', pick 'Gym duo': saved, the preview shows it, the inspector says 'Showing to shoppers.'", { secId, line });
  const draft = await getDoc(page);
  const picked = draft.body.sections.find((s) => s.id === secId)?.settings?.bundle;
  drill.check(JSON.stringify(picked) === JSON.stringify({ id: duo.id }), "pick: the draft holds the bundle as { id } only (no price, title or stock)", picked);
  await drill.screenshot(page, "pick-editor-1440");

  // the Mobile preview: the editor has no device switch (finding P5D-1); the
  // founder's own preview, in the same signed-in browser, at 375 wide
  const mob = await ctx.newPage();
  await mob.setViewportSize({ width: 375, height: 812 });
  await mob.goto(`${base}/`, { waitUntil: "load", timeout: 120_000 });
  await settle(mob);
  await noThanks(mob);
  const card = mob.locator(`[data-section-id="${secId}"]`);
  await card.waitFor({ timeout: 60_000 });
  await card.scrollIntoViewIfNeeded();
  const mobFacts = await mob.evaluate((id) => ({ bar: !!document.querySelector("[data-preview-bar]"), card: document.querySelector(`[data-section-id="${id}"]`)?.innerText.replace(/\s+/g, " ").trim().slice(0, 200), overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 }), secId);
  drill.check(mobFacts.bar && /Gym duo/.test(mobFacts.card || "") && !mobFacts.overflowX, "pick: the founder's preview at 375 wide (the phone width) shows the Bundle card, with no sideways scroll", mobFacts);
  await drill.screenshot(mob, "pick-mobile-preview-375");
  lap("phone preview checked");
  await mob.close();

  const pub = await publishAndRead(page);
  lap("published");
  drill.check(pub.phase === "done", "pick: Publish, review, Publish: published", { phase: pub.phase, issues: pub.issues });
  await closePanel(page);

  // the live home, in a fresh browser
  const fresh = await shopper(drill);
  const sp = await fresh.newPage();
  let live = false;
  for (let i = 0; i < 20 && !live; i++) {
    await sp.goto(`${base}/`, { waitUntil: "load", timeout: 120_000 });
    live = (await sp.locator(`[data-section-kind="bundle_card"] [data-bundle="${duo.id}"]`).count()) > 0;
    if (!live) await sleep(1000);
  }
  const elapsed = Math.round((Date.now() - t0) / 100) / 10;
  lap("live home shows the card");
  await settle(sp);
  await noThanks(sp);
  await sp.locator(`[data-section-id="${secId}"]`).scrollIntoViewIfNeeded().catch(() => {});
  await drill.screenshot(sp, "pick-live-home-1440");
  const liveText = await sp.locator(`[data-section-id="${secId}"]`).innerText().catch(() => "");
  await fresh.close();
  drill.check(live && /Gym duo/.test(liveText) && /Add the set to cart/.test(liveText), "pick: a fresh browser sees the Bundle card on the live home (title, add button)", { liveText: liveText.replace(/\s+/g, " ").slice(0, 200) });
  drill.check(live && elapsed < 120, `pick: from opening the editor to the live home showing the card took ${elapsed} s (target under 2 minutes)`, { seconds: elapsed, laps: stamp, clicks: clicks.since(m0), typedWords: "gym" });
  drill.note(`pick timing (seconds from opening the editor): ${JSON.stringify(stamp)}; clicks after sign-in: ${clicks.since(m0)} (${clicks.clicks.slice(m0).map((c) => (c.text || c.tag || "").replace(/\s+/g, " ").slice(0, 40)).join(" | ")}); typed: "gym". The time includes this machine's next dev compiles and the drill's own waits; the phone preview check is a second tab, as the new editor has no device switch (finding P5D-1).`);
  drill.check(errors.length === 0, "pick: no page errors in the editor", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// create (COM-02: inline create)
// ---------------------------------------------------------------------------
export async function createStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const before = await bundleRows();
  const { ctx, page, errors } = await ownerEditor(drill);
  const secId = await addSection(page, "bundle_card");
  const ins = inspectorOf(page);
  await ins.getByRole("button", { name: "Create a bundle" }).click();
  const dlg = page.locator('[role="dialog"][data-state="open"]').filter({ has: page.locator("[data-bundle-create]") }).first();
  await dlg.locator("[data-bundle-create]").waitFor({ timeout: 30_000 });
  await dlg.locator("#bundle-name-compact").fill("Drill trio");
  const liveNow = (await dlg.locator("[data-bundle-live-now]").innerText()).trim();
  drill.check(
    liveNow === "The bundle is saved and turned on now: its discount works in the cart and its page /bundles/drill-trio opens right away, even if you don't publish. It shows on your home page after you publish.",
    "create: the Dialog says the bundle goes live at once, its page /bundles/drill-trio too, before publishing (the live-now sentence)",
    liveNow,
  );
  drill.check((await dlg.locator("input").count()) === 2 && (await dlg.locator("textarea").count()) === 0, "create: the Dialog asks only for a name, products and a price (two inputs, no description, no slug)", { inputs: await dlg.locator("input").count() });
  const pickProduct = async (n) => {
    await dlg.getByRole("button", { name: "Add product" }).click();
    const vp = page.locator('[role="dialog"][data-state="open"]').last();
    await vp.locator('input[aria-label="Search products"]').fill("PF-");
    await sleep(1500);
    await settle(page);
    await vp.locator('ul[aria-label="Synced products"] li button').nth(n).click();
    await sleep(800);
    await settle(page);
    await vp.locator('ul[aria-label="Synced variants"] li button').first().click();
    await sleep(600);
  };
  await pickProduct(0);
  await pickProduct(2);
  await dlg.locator("#bundle-price-compact").fill("99999999");
  const reason = await waitFor(async () => (await dlg.locator("[data-bundle-price-reason]").innerText().catch(() => "")).trim() || false, 15_000);
  const createBtn = dlg.getByRole("button", { name: "Create bundle" });
  const off = await createBtn.isDisabled();
  drill.check(off && /^Price must be lower than ₹[\d,]+(\.\d+)?$/.test(String(reason)), "create: a price above the products' sum keeps 'Create bundle' off, with the plain reason under the price", { disabled: off, reason });
  await drill.screenshot(page, "create-failing-price-1440");
  const sum = Number(String(reason).replace(/[^0-9.]/g, ""));
  await dlg.locator("#bundle-price-compact").fill(String(Math.max(1, Math.floor(sum) - 40)));
  const on = await waitFor(async () => !(await createBtn.isDisabled()), 15_000);
  const saving = (await dlg.locator("[data-bundle-saving]").innerText().catch(() => "")).trim();
  drill.check(Boolean(on) && /^The products add up to ₹[\d,]+\. Shoppers save ₹[\d,]+(\.\d+)?\./.test(saving), "create: a passing price turns 'Create bundle' on and says what shoppers save", { saving });
  await drill.screenshot(page, "create-passing-price-1440");
  await createBtn.click();
  await waitFor(async () => (await page.locator('[role="dialog"][data-state="open"]').count()) === 0, 30_000);
  const after = await bundleRows();
  const added = after.filter((b) => !before.some((x) => x.id === b.id));
  drill.check(added.length === 1 && added[0].slug === "drill-trio" && Number(added[0].enabled) === 1 && !after.some((b) => /-2$/.test(b.slug)), "create: exactly one new bundles row, turned on, at /bundles/drill-trio (no drill-trio-2)", { before: before.length, after: after.map((b) => [b.slug, b.enabled]) });
  const offers = await offerRows();
  drill.check(added[0] && offers.some((o) => o.id === `bundle-${added[0].id}` && Number(o.enabled) === 1), "create: its cart offer is written and on (the discount works now)", offers.map((o) => [o.id, o.enabled]));
  let pickedNow = null;
  await waitFor(async () => {
    pickedNow = (await getDoc(page)).body.sections.find((s) => s.id === secId)?.settings?.bundle ?? null;
    return pickedNow?.id === added[0]?.id;
  }, 30_000, 500);
  drill.check(JSON.stringify(pickedNow) === JSON.stringify({ id: added[0]?.id }), "create: the new bundle is picked in the section, saved as { id } only", { pickedNow });
  await waitFor(async () => (await inspectorLines(page))[0] === "Showing to shoppers.", 20_000, 300);
  drill.check((await inspectorLines(page))[0] === "Showing to shoppers.", "create: the inspector reads it again: 'Showing to shoppers.'", await inspectorLines(page));
  await drill.screenshot(page, "create-picked-1440");
  // before any publish: its page opens, and the live home doesn't show it yet
  const sp = await (await shopper(drill)).newPage();
  const res = await sp.goto(`${base}/bundles/drill-trio`, { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  const pageText = await sp.locator("main").innerText().catch(() => "");
  drill.check(res?.status() === 200 && /Drill trio/.test(pageText) && /Add the set to cart/.test(pageText), "create: /bundles/drill-trio opens for a shopper before publish (OQ-C), and can be added", { status: res?.status() });
  await drill.screenshot(sp, "create-bundle-page-before-publish-1440");
  const home = await liveHome(drill, base);
  drill.check(home.cards.length === 0, "create: the live home has no card yet (it shows after publish)", home.cards);
  await sp.context().close();
  drill.check(errors.length === 0, "create: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// states (US-33): a component sold out through the sync writer
// ---------------------------------------------------------------------------
export async function statesStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(2);
  const b = await makeBundle({ title: "Recovery pair", variants: vs, price: Math.floor(vs[0].price + vs[1].price) - 100 });
  const { ctx, page, errors, publishes } = await ownerEditor(drill);
  const card = await bundleSection("bundle_card", "sec_p5state", { title: "Our recovery pick", bundle: { id: b.id } });
  await saveHome(page, (body) => afterHero(body, [card]));
  const so = await syncProduct(vs[1].product_id, soldOut);
  drill.check(so.roundTrip && so.after.variants.every((v) => Number(v.available) === 0) && so.after.product[0].available === 0, `states: '${vs[1].product_title}' goes sold out through the sync writer (lib/sync.js writeProduct; writing its unchanged shape first changed nothing)`, { roundTrip: so.roundTrip, product: so.after.product[0]?.available });
  const [entry] = [...(await readBundles([b.id])).values()];
  drill.check(entry?.state === "sold_out", "states: the bundle read says sold_out", { state: entry?.state, reasons: entry?.reasons });

  await openEditor(page);
  await selectSection(page, "sec_p5state");
  const html = await waitFor(async () => {
    const h = await page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.querySelector('[data-section-id="sec_p5state"]')?.innerText || "");
    return /Currently unavailable/.test(h) ? h : false;
  }, 90_000, 500);
  const marked = await page.locator("[data-preview-frame]").evaluate((f) => [...(f.contentDocument?.querySelectorAll('[data-section-id="sec_p5state"] [data-bundle-item]') || [])].map((i) => [i.getAttribute("data-bundle-item"), i.innerText.replace(/\s+/g, " ").trim()]));
  drill.check(Boolean(html) && marked.some(([s, t]) => s === "sold_out" && t.includes(vs[1].product_title) && /Sold out/i.test(t)) && marked.some(([s]) => s === "ok"), "states: the preview card says 'Currently unavailable' and marks the sold-out product 'Sold out'", { marked });
  const line = (await inspectorLines(page))[0];
  drill.check(line === words("sold_out", []), "states: the inspector's status line says so", line);
  await drill.screenshot(page, "states-preview-inspector-1440");

  const pub = await publishAndRead(page);
  const api = publishes[publishes.length - 1];
  const issue = issueWith(pub, "Recovery pair");
  drill.check(pub.phase === "done" && api?.issues.some((i) => i.code === "BUNDLE_UNAVAILABLE" && i.sectionId === "sec_p5state" && i.level === "warns") && issue?.text.includes(words("sold_out", [])) && issue?.buttons.includes("Remove this section and publish"), "states: publish shows BUNDLE_UNAVAILABLE (Check: the sold-out sentence, 'Remove this section and publish') and still publishes", { phase: pub.phase, codes: api?.issues.map((i) => i.code), issue });
  await drill.screenshot(page, "states-publish-warning-1440");
  await closePanel(page);
  const live = await liveHome(drill, base, { shot: "states-live-card-1440" });
  const c = live.cards.find((x) => x.id === b.id);
  drill.check(c && c.state === "sold_out" && c.button?.disabled === true && c.button?.text === "Currently unavailable" && c.items.some(([s]) => s === "sold_out"), "states: the live card shows with add disabled ('Currently unavailable') and the product marked", c);

  // P5-FIX1's browser check: a bundle that lost a product (deleted from the
  // catalog by the sync writer's own delete, lib/sync.js deleteProductByGid)
  const more = await pickVariants(2);
  const L = await makeBundle({ title: "Lost pair", variants: more, price: Math.floor(more[0].price + more[1].price) - 90 });
  const lost = await bundleSection("bundle_card", "sec_p5lost", { title: "Our lost pick", bundle: { id: L.id } });
  await saveHome(page, (body) => afterHero(body, [lost]));
  await inStore(async () => (await import("../../../lib/sync.js")).deleteProductByGid(more[1].product_id));
  const [le] = [...(await readBundles([L.id])).values()];
  drill.check(le?.state === "sold_out" && (le.reasons || []).some((r) => r.kind === "missing") && !(le.reasons || []).some((r) => r.kind === "no_saving"), "states (lost product): after the sync writer deletes one of its products the bundle reads sold_out with a missing product, never no_saving (P5-FIX1 ruling 1)", { state: le?.state, reasons: le?.reasons });
  await openEditor(page);
  await selectSection(page, "sec_p5lost");
  const lostWords = words("sold_out", [{ kind: "missing" }]);
  const lostPrev = await waitFor(async () => {
    const r = await page.locator("[data-preview-frame]").evaluate((f) => {
      const sec = f.contentDocument?.querySelector('[data-section-id="sec_p5lost"]');
      return sec ? { text: sec.innerText.replace(/\s+/g, " "), note: sec.querySelector('[data-bundle-note="missing-product"]')?.innerText.replace(/\s+/g, " ") || null, items: [...sec.querySelectorAll("[data-bundle-item]")].map((i) => [i.getAttribute("data-bundle-item"), i.innerText.replace(/\s+/g, " ").trim()]) } : null;
    });
    return r?.note ? r : false;
  }, 90_000, 500);
  drill.check(lostPrev && lostPrev.note.includes(lostWords) && /Currently unavailable/.test(lostPrev.text) && lostPrev.items.some(([st, t]) => st === "missing" && /No longer available/i.test(t)), "states (lost product): the preview card says 'Currently unavailable', marks the product 'No longer available', and its founder note says to replace it", lostPrev);
  drill.check((await inspectorLines(page))[0] === lostWords, "states (lost product): the inspector says the same (replace it in Bundles)", (await inspectorLines(page))[0]);
  await drill.screenshot(page, "states-lost-product-preview-1440");
  const pub2 = await publishAndRead(page);
  await closePanel(page);
  const live2 = await liveHome(drill, base, { shot: "states-lost-product-live-1440" });
  const c2 = live2.cards.find((x) => x.id === L.id);
  drill.check(pub2.phase === "done" && c2 && c2.button?.disabled === true && c2.items.some(([st, t]) => st === "missing" && /No longer available/i.test(t)) && live2.notes === 0 && !live2.text.includes(lostWords), "states (lost product): live, the card shows 'Currently unavailable' with the product marked 'No longer available', and no founder note", { phase: pub2.phase, card: c2 });
  drill.check(errors.length === 0, "states: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// nosaving (OQ-B, the owner's answer): the price no longer saves anything
// ---------------------------------------------------------------------------
export async function nosavingStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(2);
  const sum0 = vs[0].price + vs[1].price;
  const price = Math.floor(sum0) - 100;
  const b = await makeBundle({ title: "Value pair", variants: vs, price });
  const { ctx, page, errors, publishes } = await ownerEditor(drill);
  const card = await bundleSection("bundle_card", "sec_p5save", { title: "Value pick", bundle: { id: b.id } });
  const first = await publishCard(drill, page, [card]);
  const live0 = await liveHome(drill, base);
  drill.check(first.phase === "done" && live0.cards.some((x) => x.id === b.id && x.state === "available"), "nosaving: the card is live and available first", { phase: first.phase, cards: live0.cards.map((x) => [x.id, x.state]) });

  // the founder raises the price above the products' sum on the bundle's page (/admin/bundles/<id>)
  await page.goto(`/admin/bundles/${encodeURIComponent(b.id)}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const form = page.locator("main");
  await form.locator("#bundle-price").waitFor({ timeout: 30_000 });
  await form.locator("#bundle-price").fill(String(Math.ceil(sum0) + 200));
  await waitFor(async () => (await form.locator("[data-bundle-price-reason]").count()) > 0, 15_000);
  const priceReason = (await form.locator("[data-bundle-price-reason]").first().innerText().catch(() => "")).trim();
  await form.locator("[data-bundle-save]").click();
  await sleep(2000);
  const refused = (await form.innerText()).replace(/\s+/g, " ");
  const stored = (await bundleRows()).find((x) => x.id === b.id);
  drill.check(Number(stored.bundle_price) === price && Number(stored.enabled) === 1 && /Price must be lower than/.test(priceReason), "nosaving: raising a live bundle's price above its products' sum in Bundles is refused with the reason, and nothing is saved (an edit that breaks a live bundle is refused: deviation 3.10)", { priceReason, stored: [stored.bundle_price, stored.enabled], said: refused.slice(0, 300) });
  await drill.screenshot(page, "nosaving-console-raise-refused-1440");
  drill.note("nosaving: a live bundle's price can't be raised above its sum through any writer (refused, deviation 3.10). So the drill makes the price stop saving the way it happens in a real store: the products get cheaper in a sync (lib/sync.js writeProduct), until they add up to less than the bundle's price.");

  // the products get cheaper through the sync writer
  const s1 = await syncProduct(vs[0].product_id, (p) => priced(p, 0.4));
  const s2 = await syncProduct(vs[1].product_id, (p) => priced(p, 0.4));
  const [entry] = [...(await readBundles([b.id])).values()];
  const sum1 = entry?.componentsSum;
  drill.check(s1.roundTrip && s2.roundTrip && entry?.state === "no_saving" && sum1 < price, `nosaving: both products' prices drop through the sync writer; the products now add up to ${INR(sum1)}, under the bundle's ${INR(price)}: state no_saving`, { state: entry?.state, sum: sum1, price, reasons: entry?.reasons });
  const sentence = words("no_saving", entry?.reasons || []);
  drill.check(sentence === `The price no longer saves anything (the products add up to ${INR(sum1)}), so shoppers don't see it. Lower the price in Bundles.`, "nosaving: the founder's words are the owner's OQ-B sentence, naming the sum", sentence);

  const live1 = await liveHome(drill, base, { shot: "nosaving-live-home-1440" });
  drill.check(!live1.cards.length && !live1.text.includes("Value pair"), "nosaving: the live home has no card (hidden for shoppers, at once: bundles are not versioned)", { cards: live1.cards });

  await touchHeading(page, "sec_p5save", "Value pick, updated");
  await selectSection(page, "sec_p5save");
  const note = await waitFor(async () => {
    const t = await page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.querySelector('[data-section-id="sec_p5save"]')?.innerText || "");
    return t.includes(sentence) ? t : false;
  }, 90_000, 500);
  drill.check(Boolean(note) && /hidden from shoppers/.test(note) && !/Currently unavailable/.test(note), "nosaving: the preview shows the founder note 'Bundle card: hidden from shoppers' with the reason (no card)", { note: String(note).replace(/\s+/g, " ").slice(0, 300) });
  const line = (await inspectorLines(page))[0];
  drill.check(line === sentence, "nosaving: the inspector's status line gives the same reason", line);
  await drill.screenshot(page, "nosaving-preview-note-1440");
  const pub = await publishAndRead(page);
  const api = publishes[publishes.length - 1];
  const issue = issueWith(pub, "Value pair");
  drill.check(pub.phase === "done" && api?.issues.some((i) => i.code === "BUNDLE_UNAVAILABLE" && i.level === "warns" && i.message.includes(INR(sum1))) && issue?.text.includes(sentence), "nosaving: publish warns BUNDLE_UNAVAILABLE naming the sum, and still publishes", { phase: pub.phase, issues: api?.issues });
  await drill.screenshot(page, "nosaving-publish-warning-1440");
  await closePanel(page);
  const live2 = await liveHome(drill, base);
  drill.check(!live2.cards.length && !live2.text.includes("Value pick, updated"), "nosaving: after publish the live home still has no card (and no heading for it)", { cards: live2.cards });
  drill.check(errors.length === 0, "nosaving: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// disabled (US-34, the bundle half)
// ---------------------------------------------------------------------------
export async function disabledStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(2);
  const b = await makeBundle({ title: "Weekend set", variants: vs, price: Math.floor(vs[0].price + vs[1].price) - 80 });
  const { ctx, page, errors, publishes } = await ownerEditor(drill);
  const card = await bundleSection("bundle_card", "sec_p5off", { title: "This weekend", bundle: { id: b.id } });
  const first = await publishCard(drill, page, [card]);
  const live0 = await liveHome(drill, base);
  drill.check(first.phase === "done" && live0.cards.some((x) => x.id === b.id), "disabled: the card is live first", { cards: live0.cards.map((x) => x.id) });

  await page.goto("/admin/bundles", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const row = page.locator("tr", { has: page.locator(`[data-bundle-switch="${b.id}"]`) });
  await row.waitFor({ timeout: 30_000 });
  const rowText = (await row.innerText()).replace(/\s+/g, " ");
  drill.check(/On your home page/.test(rowText), "disabled: Bundles says the bundle is on the live home ('On your home page')", rowText.slice(0, 200));
  await row.locator(`[data-bundle-switch="${b.id}"]`).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.waitFor({ timeout: 15_000 });
  const confirmText = (await confirm.innerText()).replace(/\s+/g, " ");
  drill.check(/Shoppers will stop seeing this bundle on your home page right away\./.test(confirmText), "disabled: Disable asks first, saying shoppers stop seeing it on the home page right away", confirmText.slice(0, 300));
  await drill.screenshot(page, "disabled-confirm-1440");
  await confirm.getByRole("button", { name: "Turn off", exact: true }).click();
  const t0 = Date.now();
  await waitFor(async () => Number((await bundleRows()).find((x) => x.id === b.id)?.enabled) === 0, 15_000);
  let gone = false;
  let tries = 0;
  while (!gone && tries < 20) {
    tries++;
    const l = await liveHome(drill, base);
    gone = !l.cards.length;
    if (!gone) await sleep(1000);
  }
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  drill.check(gone && tries === 1, `disabled: the live home hides the card at once (first look, ${secs} s after the click; no publish)`, { tries, secs });
  await liveHome(drill, base, { shot: "disabled-live-home-1440" });

  await touchHeading(page, "sec_p5off", "This weekend, updated");
  await selectSection(page, "sec_p5off");
  const sentence = words("disabled");
  const note = await waitFor(async () => {
    const t = await page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.querySelector('[data-section-id="sec_p5off"]')?.innerText || "");
    return t.includes(sentence) ? t : false;
  }, 90_000, 500);
  drill.check(Boolean(note) && /hidden from shoppers/.test(note), "disabled: the preview shows the turned-off reason in the founder note", String(note).replace(/\s+/g, " ").slice(0, 300));
  drill.check((await inspectorLines(page))[0] === sentence, "disabled: the inspector says the same", (await inspectorLines(page))[0]);
  // a click on the note selects its section (P5-HIDDEN's browser check): pick
  // another section first, then click the note in the frame
  await selectSection(page, "sec_hero");
  await page.frameLocator("[data-preview-frame]").locator('[data-section-id="sec_p5off"] [data-founder-note], [data-section-id="sec_p5off"]').first().click({ timeout: 15_000 });
  const picked = await waitFor(async () => (await page.locator('[data-section-row="sec_p5off"][data-selected]').count()) === 1, 15_000, 200);
  drill.check(Boolean(picked), "disabled: a click on the founder note in the preview selects that section in the editor", { selected: await page.locator("[data-section-row][data-selected]").getAttribute("data-section-row").catch(() => null) });
  await drill.screenshot(page, "disabled-preview-note-1440");
  const pub = await publishAndRead(page);
  const api = publishes[publishes.length - 1];
  const issue = issueWith(pub, "Weekend set");
  drill.check(pub.phase === "done" && api?.issues.some((i) => i.code === "BUNDLE_DISABLED" && i.actions.includes("removeSection")) && issue?.buttons.includes("Remove this section and publish") && issue?.text.includes(sentence), "disabled: publish shows BUNDLE_DISABLED with 'Remove this section and publish'", { codes: api?.issues.map((i) => [i.code, i.actions]), issue });
  await drill.screenshot(page, "disabled-publish-warning-1440");
  const after = await actOn(page, "Weekend set", "Remove this section and publish");
  const docAfter = await getDoc(page);
  const liveDoc = await docsApi(page, { getDocument: "doc_home" });
  drill.check(after.phase === "done" && !docAfter.body.sections.some((s) => s.id === "sec_p5off") && docAfter.body.sections.length > 5, "disabled: 'Remove this section and publish' takes only that section out and publishes again", { phase: after.phase, sections: docAfter.body.sections.map((s) => s.id), live: liveDoc.body?.document?.publishedVersionId ?? null });
  drill.check(errors.length === 0, "disabled: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// grid: available, sold out, turned off, deleted
// ---------------------------------------------------------------------------
export async function gridStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(8);
  const mk = (title, a, cut) => makeBundle({ title, variants: [vs[a], vs[a + 1]], price: Math.floor(vs[a].price + vs[a + 1].price) - cut });
  const A = await mk("Grid avail", 0, 90);
  const S = await mk("Grid sold", 2, 70);
  const D = await mk("Grid off", 4, 60);
  const X = await mk("Grid gone", 6, 50);
  const ids = [A.id, S.id, D.id, X.id];
  const { ctx, page, errors, publishes } = await ownerEditor(drill);

  // the founder adds a Bundle grid and picks the four in order
  const secId = await addSection(page, "bundle_grid");
  for (const [w, id] of [["avail", A.id], ["sold", S.id], ["off", D.id], ["gone", X.id]]) await pickBundleIn(page, `Grid ${w}`, id);
  await waitSaved(page, 30_000);
  const picked = (await getDoc(page)).body.sections.find((s) => s.id === secId)?.settings?.bundles;
  drill.check(JSON.stringify(picked) === JSON.stringify(ids.map((id) => ({ id }))), "grid: Add a section > Bundle grid, four bundles picked in order, saved as [{ id }] only", picked);

  // then: one sells out (sync writer), one is turned off, one is deleted
  const so = await syncProduct(vs[3].product_id, soldOut);
  await bundleEnabled(D.id, false);
  await bundleGone(X.id);
  const states = [...(await readBundles(ids)).values()].map((e) => e.state);
  drill.check(so.roundTrip && JSON.stringify(states) === JSON.stringify(["available", "sold_out", "disabled", "missing"]), "grid: the four now read available, sold_out, disabled, missing", states);

  await openEditor(page);
  await selectSection(page, secId);
  const notes = await waitFor(async () => {
    const n = await page.locator("[data-preview-frame]").evaluate((f, sid) => [...(f.contentDocument?.querySelectorAll(`[data-section-id="${sid}"] [data-bundle-cell]`) || [])].map((e) => [e.getAttribute("data-bundle-cell"), e.innerText.replace(/\s+/g, " ").trim()]), secId);
    return n.length === 2 ? n : false;
  }, 90_000, 500);
  const pcells = await page.locator("[data-preview-frame]").evaluate((f, sid) => [...(f.contentDocument?.querySelectorAll(`[data-section-id="${sid}"] [data-bundle]`) || [])].map((e) => e.getAttribute("data-bundle")), secId);
  drill.check(
    notes && notes[0][0] === "2" && notes[0][1].startsWith("Grid off: hidden from shoppers") && notes[0][1].includes(words("disabled")) && notes[1][0] === "3" && notes[1][1].startsWith("Bundle 4: hidden from shoppers") && notes[1][1].includes(words("missing")) && JSON.stringify(pcells) === JSON.stringify([A.id, S.id]),
    "grid: the preview shows the available and sold-out cells, and a note for each dropped cell (turned off, deleted) with its reason",
    { notes, cells: pcells },
  );
  const lines = await inspectorLines(page);
  drill.check(lines[0] === words("available") && lines[1] === words("sold_out", []) && lines[2] === words("disabled") && lines[3] === words("missing"), "grid: the inspector gives each row its own line", lines);
  await drill.screenshot(page, "grid-preview-notes-1440");

  const pub = await publishAndRead(page);
  const api = publishes[publishes.length - 1];
  const codes = (api?.issues || []).filter((i) => i.sectionId === secId).map((i) => [i.code, i.actions.join(",")]);
  drill.note(`grid publish issues: ${JSON.stringify((api?.issues || []).map((i) => [i.code, i.message]))}`);
  drill.check(
    pub.phase === "done" && JSON.stringify(codes) === JSON.stringify([["BUNDLE_UNAVAILABLE", "removeItem:1"], ["BUNDLE_DISABLED", "removeItem:2"], ["BUNDLE_MISSING", "removeItem:3"]]),
    "grid: publish gives one warning per dropped or unavailable entry (UNAVAILABLE 1, DISABLED 2, MISSING 3), each with removeItem for its own index, and publishes",
    { phase: pub.phase, codes },
  );
  const rowsShown = pub.issues.filter((i) => /Remove this bundle from the grid/.test(i.text));
  drill.check(rowsShown.length === 3 && rowsShown.every((i) => i.buttons.includes("Remove it and publish")), "grid: each of the three shows 'Remove it and publish'", rowsShown.map((i) => i.text.slice(0, 120)));
  await drill.screenshot(page, "grid-publish-warnings-1440");

  const live = await liveHome(drill, base, { shot: "grid-live-home-1440" });
  const g = live.grids.find((x) => x.section === secId);
  drill.check(g && JSON.stringify(g.cells.map((c) => c.id)) === JSON.stringify([A.id, S.id]) && g.cells[1].button?.disabled === true && g.cells[0].button?.disabled === false && live.notes === 0, "grid: the live grid shows 2 cells in order (available, then sold out with add off), and no founder note", g);

  // Remove it and publish on the turned-off one: only that bundle goes
  const after = await actOn(page, "Grid off", "Remove it and publish");
  const nowList = (await getDoc(page)).body.sections.find((s) => s.id === secId)?.settings?.bundles;
  drill.check(after.phase === "done" && JSON.stringify(nowList) === JSON.stringify([{ id: A.id }, { id: S.id }, { id: X.id }]), "grid: 'Remove it and publish' on the turned-off bundle removes only it from the grid, and publishes", { phase: after.phase, nowList });
  const left = after.issues.filter((i) => /Remove this bundle from the grid/.test(i.text)).map((i) => i.text.replace(/\s+/g, " "));
  drill.check(left.length === 2 && left.some((t) => t.includes("Grid sold")) && left.some((t) => t.includes("A deleted bundle")), "grid: the republish still warns about the sold-out and the deleted one", left);
  await drill.screenshot(page, "grid-after-remove-1440");
  const after2 = await actOn(page, "A deleted bundle", "Remove it and publish");
  const nowList2 = (await getDoc(page)).body.sections.find((s) => s.id === secId)?.settings?.bundles;
  drill.check(after2.phase === "done" && JSON.stringify(nowList2) === JSON.stringify([{ id: A.id }, { id: S.id }]), "grid: then 'Remove it and publish' on the deleted one removes only it", nowList2);
  const live2 = await liveHome(drill, base);
  const g2 = live2.grids.find((x) => x.section === secId);
  drill.check(g2 && JSON.stringify(g2.cells.map((c) => c.id)) === JSON.stringify([A.id, S.id]), "grid: the live grid still shows the same 2 cells", g2?.cells.map((c) => c.id));
  drill.check(errors.length === 0, "grid: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// cart: the card's add equals the bundle page's; a COD test order, cancelled
// ---------------------------------------------------------------------------
const cartView = (c) => ({
  items: (c.items || []).map((i) => ({ variantId: i.variantId, quantity: i.quantity, price: i.price ?? i.unitPrice ?? null, title: i.title })).sort((a, b) => (a.variantId < b.variantId ? -1 : 1)),
  subtotal: c.subtotal ?? null,
  discountTotal: c.discountTotal ?? null,
  total: c.total ?? null,
  offers: (c.appliedOffers || c.offers || []).map((o) => ({ id: o.id ?? o.offerId ?? null, amount: o.amount ?? o.discount ?? null, kind: o.kind ?? o.type ?? null })),
});

async function addFrom(page, scope) {
  const posted = [];
  const onRes = (r) => r.url().endsWith("/api/cart") && r.request().method() === "POST" && posted.push(r.status());
  page.on("response", onRes);
  await scope.getByRole("button", { name: "Add the set to cart", exact: true }).click();
  await waitFor(async () => (await scope.getByRole("button", { name: /Added ✓/ }).count()) > 0, 30_000);
  page.off("response", onRes);
  await sleep(500);
  return { posts: posted, cart: await page.evaluate(async () => (await fetch("/api/cart")).json()) };
}

export async function cartStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const ctxH = await harnessContext();
  const vs = await pickVariants(2);
  const b = await makeBundle({ title: "Cart pair", variants: vs, price: Math.floor(vs[0].price + vs[1].price) - 150 });
  const { ctx, page, errors } = await ownerEditor(drill);
  await publishCard(drill, page, [await bundleSection("bundle_card", "sec_p5cart", { title: "Add the pair", bundle: { id: b.id } })]);

  // A: from the live card
  const ca = await shopper(drill);
  const pa = await ca.newPage();
  await pa.goto(`${base}/`, { waitUntil: "load", timeout: 120_000 });
  await settle(pa);
  await noThanks(pa);
  const cardScope = pa.locator('[data-section-id="sec_p5cart"]');
  await cardScope.scrollIntoViewIfNeeded();
  const fromCard = await addFrom(pa, cardScope);
  await drill.screenshot(pa, "cart-drawer-from-card-1440");
  // B: from /bundles/<slug>
  const cb = await shopper(drill);
  const pb = await cb.newPage();
  await pb.goto(`${base}/bundles/${b.slug}`, { waitUntil: "load", timeout: 120_000 });
  await settle(pb);
  await noThanks(pb);
  const fromPage = await addFrom(pb, pb.locator("main"));
  await drill.screenshot(pb, "cart-drawer-from-bundle-page-1440");
  await cb.close();
  const A = cartView(fromCard.cart);
  const B = cartView(fromPage.cart);
  drill.check(JSON.stringify(A) === JSON.stringify(B) && A.items.length === 2, "cart: the cart from the live card equals the cart from /bundles/<slug> (lines, discount, totals, offers)", { fromCard: A, fromPage: B });
  const saving = Math.round(Math.max(0, vs[0].price + vs[1].price - b.bundle_price));
  drill.check(Number(A.discountTotal) === saving, `cart: the cart takes off the saving the card shows (${INR(saving)})`, { discountTotal: A.discountTotal, saving });
  drill.note(`cart JSON keys: ${Object.keys(fromCard.cart).join(", ")}`);

  // checkout: the review shows the saving; a COD order to snehal@mediastic.in, cancelled at once
  await noShopifyOrPayment(drill, ctxH);
  await pa.goto(`${base}/checkout`, { waitUntil: "load", timeout: 120_000 });
  await settle(pa);
  await noThanks(pa);
  await pa.locator('input[name="email"]').waitFor({ timeout: 60_000 });
  const fill = { email: TEST_ORDER_EMAIL, phone: "9999999999", name: "P5 Drill Test Order", line1: "1 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
  for (const [k, v] of Object.entries(fill)) await pa.locator(`input[name="${k}"]`).fill(v);
  await pa.getByRole("button", { name: "Continue to review" }).click();
  await pa.getByRole("button", { name: "Continue to payment" }).waitFor({ timeout: 30_000 });
  const review = (await pa.locator("main").innerText()).replace(/\s+/g, " ");
  drill.check(review.includes(`You save ${INR(saving)}`), `cart: the checkout's review shows the saving ('You save ${INR(saving)}')`, review.slice(0, 500));
  await drill.screenshot(pa, "cart-checkout-review-1440");
  await pa.getByRole("button", { name: "Continue to payment" }).click();
  const cod = pa.locator('input[type="radio"][name="method"][value="cod"], input[type="radio"][name="method"]').first();
  await cod.waitFor({ timeout: 30_000 });
  if (!(await cod.isChecked())) await cod.check();
  const codValue = await cod.getAttribute("value");
  drill.check(codValue == null || codValue === "cod", "cart: cash on delivery is chosen (no card details are ever entered)", { codValue });
  await pa.getByRole("button", { name: /^Place order/ }).click();
  await pa.waitForURL(/\/checkout\/confirmation/, { timeout: 60_000 }).catch(() => {});
  await settle(pa);
  const orderId = decodeURIComponent((/\/checkout\/confirmation\/([^/?#]+)/.exec(pa.url()) || [])[1] || "");
  let cancelled = null;
  try {
    const order = orderId ? (await sqlAt(ctxH.urls.tenant, [{ sql: "SELECT id, status, email, payment_method, discount_total, total FROM orders WHERE id = ?", args: [orderId] }]))[0].rows[0] : null;
    drill.check(Boolean(order) && order.email === TEST_ORDER_EMAIL && order.payment_method === "cod", "cart: one cash on delivery test order to snehal@mediastic.in goes through", { order: order ? { ...order } : null });
    drill.check(order && Number(order.discount_total) === saving, "cart: the order carries the bundle's saving as its discount", { discount: order?.discount_total, saving });
    await drill.screenshot(pa, "cart-confirmation-1440");
  } finally {
    if (orderId) {
      cancelled = await page.evaluate(async (id) => {
        const r = await fetch(`/api/admin/orders/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reason: "P5-DRILLS test order" }) });
        return { status: r.status };
      }, orderId);
    }
  }
  const after = orderId ? (await sqlAt(ctxH.urls.tenant, [{ sql: "SELECT status FROM orders WHERE id = ?", args: [orderId] }]))[0].rows[0] : null;
  drill.check(cancelled?.status === 200 && after?.status === "cancelled", "cart: the test order is cancelled at once", { cancel: cancelled, status: after?.status });
  drill.note(`test order ${orderId} (${TEST_ORDER_EMAIL}, cash on delivery) placed and cancelled: ${after?.status}`);
  await ca.close();
  drill.check(errors.length === 0, "cart: no page errors in the editor", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// console: Bundles
// ---------------------------------------------------------------------------
export async function consoleStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(2);
  const b = await makeBundle({ title: "Console pair", variants: vs, price: Math.floor(vs[0].price + vs[1].price) - 100 });
  const { ctx, page, errors } = await ownerEditor(drill);
  await publishCard(drill, page, [await bundleSection("bundle_card", "sec_p5con", { title: "Console pick", bundle: { id: b.id } })]);
  const live0 = await liveHome(drill, base);
  drill.check(live0.cards.some((c) => c.id === b.id && c.text.includes(INR(b.bundle_price))), `console: the live card shows ${INR(b.bundle_price)} first`, live0.cards.map((c) => c.text.slice(0, 160)));

  await page.goto("/admin/bundles", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const card = page.locator("main");
  await card.locator(`[data-bundle-switch="${b.id}"]`).waitFor({ timeout: 30_000 });
  const scan = async () =>
    card.evaluate((el) =>
      [...el.querySelectorAll("input, textarea, select")].map((i) => ({ id: i.id, name: i.name, type: i.type, placeholder: i.placeholder || "", label: (i.id && el.querySelector(`label[for="${i.id}"]`)?.innerText) || i.getAttribute("aria-label") || "" })),
    );
  await card.getByRole("link", { name: "New bundle" }).first().click();
  await page.waitForURL(/\/admin\/bundles\/new$/, { timeout: 60_000 });
  await card.locator("#bundle-price").waitFor({ timeout: 30_000 });
  const newInputs = await scan();
  await card.locator("[data-bundle-actions]").getByRole("link", { name: "Cancel" }).click();
  await page.waitForURL(/\/admin\/bundles$/, { timeout: 60_000 });
  await card.getByRole("link", { name: "Console pair" }).click();
  await page.waitForURL(new RegExp(`/admin/bundles/${b.id}$`), { timeout: 60_000 });
  const form = card;
  await form.locator("#bundle-price").waitFor({ timeout: 30_000 });
  await waitFor(async () => (await form.locator("[data-bundle-saving]").count()) > 0, 15_000);
  const editInputs = await scan();
  const bad = [...newInputs, ...editInputs].filter((i) => /slug|gid|handle/i.test(`${i.id} ${i.name} ${i.placeholder} ${i.label}`));
  const text = await card.innerText();
  drill.check(bad.length === 0 && !/gid:\/\//.test(text) && !/product-handle/.test(text), "console: Bundles has no slug or GID inputs (New bundle and Edit)", { newInputs, editInputs, bad });
  await drill.screenshot(page, "console-edit-form-1440");

  const newPrice = Number(b.bundle_price) - 25;
  await form.locator("#bundle-price").fill(String(newPrice));
  await waitFor(async () => /Shoppers save/.test(await form.locator("[data-bundle-saving]").innerText().catch(() => "")), 15_000);
  await form.locator("[data-bundle-save]").click();
  await waitFor(async () => Number((await bundleRows()).find((x) => x.id === b.id)?.bundle_price) === newPrice, 20_000);
  const row = (await bundleRows()).find((x) => x.id === b.id);
  drill.check(Number(row.bundle_price) === newPrice && Number(row.enabled) === 1, "console: editing the live bundle's price saves it and keeps it turned on", { price: row.bundle_price, enabled: row.enabled });
  await drill.screenshot(page, "console-saved-1440");
  const live1 = await liveHome(drill, base, { shot: "console-live-new-price-1440" });
  const c1 = live1.cards.find((c) => c.id === b.id);
  drill.check(c1 && c1.text.includes(INR(newPrice)) && !c1.text.includes(INR(b.bundle_price)) && c1.button?.disabled === false, `console: the live card shows the new price ${INR(newPrice)} at once, with add on (no publish)`, c1?.text.slice(0, 200));
  drill.check(errors.length === 0, "console: no page errors", errors);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// unknown (TREE-01, a validator regression)
// ---------------------------------------------------------------------------
export async function unknownStage(drill) {
  await docStore(drill);
  const base = drill.baseUrl;
  const vs = await pickVariants(2);
  const b = await makeBundle({ title: "Unknown pair", variants: vs, price: Math.floor(vs[0].price + vs[1].price) - 100 });
  const { ctx, page, errors } = await ownerEditor(drill);
  await publishCard(drill, page, [await bundleSection("bundle_card", "sec_p5unk", { title: "A real card", bundle: { id: b.id } })]);
  // next dev writes a per-request id and timings into the page's scripts, so
  // the raw bytes of two fetches never match: the page's visible text is
  // compared instead (scripts, styles, comments and tags dropped, spaces
  // collapsed). The P4 render-compare mask went with the legacy CMS.
  const norm = (h) =>
    String(h.html)
      .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const h1 = await liveHomeHtml(base);
  const h2 = await liveHomeHtml(base);
  drill.check(h1.status === 200 && norm(h1) === norm(h2) && norm(h1).includes("A real card"), "unknown: two shopper fetches of the live home (fixed unit) show the same visible text, so the comparison means something", { rawSame: h1.html === h2.html, maskedBytes: norm(h1).length });
  const before = await getDoc(page);
  const planted = structuredClone(before.body);
  const s = await bundleSection("bundle_card", "sec_p5bad", { title: "Planted", bundle: { id: b.id } });
  s.bindings = { bundle: { source: "no_such_source", args: { bundle: { id: b.id } } } };
  planted.sections.push(s);
  const r = await docsApi(page, { saveDraft: { id: before.id, body: planted }, revision: before.revision });
  const issues = r.body?.issues || r.body?.error?.issues || [];
  const msg = JSON.stringify(r.body);
  drill.check(r.status === 422 && msg.includes("This bundle card section is set up in a way the editor can't fix. Remove it and add it again.") && /BINDING_INVALID/.test(msg), "unknown: a draft save carrying a binding with source 'no_such_source' is refused 422 (BINDING_INVALID) with the plain message", { status: r.status, body: msg.slice(0, 600) });
  const after = await getDoc(page);
  const stored = await sqlAt((await harnessContext()).urls.tenant, ["SELECT count(*) AS n FROM document_versions WHERE body LIKE '%no_such_source%'", { sql: "SELECT draft_hash, revision FROM documents WHERE id = ?", args: [before.id] }]);
  drill.check(after.revision === before.revision && after.draftHash === before.draftHash && !after.body.sections.some((x) => x.id === "sec_p5bad") && Number(stored[0].rows[0].n) === 0, "unknown: nothing is stored (same revision and draft, no version holds the source)", { revision: [before.revision, after.revision], draft: stored[1].rows[0] ? { ...stored[1].rows[0] } : null, versions: stored[0].rows[0].n, issues: issues.length });
  const h3 = await liveHomeHtml(base);
  drill.check(h3.status === 200 && norm(h3) === norm(h1), "unknown: the live home shows the same visible text after the refused save", { maskedBytes: [norm(h1).length, norm(h3).length] });
  drill.note("unknown: a draft can't hold an unknown body source (the writer refuses it), so the runtime source_unknown path (bindingFailed, the 'Remove it and add it again' preview note, the section_binding_failed log) is proved only in test-sections and test-sections-render, as the plan says.");
  drill.check(errors.length === 0, "unknown: no page errors", errors);
  await ctx.close();
}
