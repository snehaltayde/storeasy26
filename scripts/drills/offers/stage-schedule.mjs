// drill:offers stage "schedule" (Phase 8 line 5, docs/plans/phase-8.md "Line 5"):
//   - staff schedule a bundle (Fixture products 1 + 2) to start about two
//     minutes from now, in the store's time, turned on; the list says Scheduled;
//   - the owner opens the store (its first publish, drill:mobile-cart's openStore);
//   - an anonymous shopper gets the not-found page for the bundle, then, once
//     the start passes, the bundle page;
//   - the owner adds a "Buy more, save more" offer for "Fixture collection 1"
//     (products 1 and 2) in the offer editor;
//   - the collection page shows the offer's title (and nothing of its rules
//     or targets), and the shopper's cart of two collection products gets it.
// Runs on the roles store after run.mjs's staff and support passes.
import { openStore, rolesSql } from "../mobile-cart/lib.mjs";
import { ORIGIN, open as openPath, signIn } from "../apps/lib.mjs";
import { settle } from "../p3/lib.mjs";

const BUNDLE = "Scheduled pair";
const COLLECTION = { handle: "fixture-collection-1", title: "Fixture collection 1" };
const waitFor = (page, fn, arg, ms = 15_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// "YYYY-MM-DDTHH:MM" wall time in `tz` for the instant `ms` (what the
// datetime-local field takes; ScheduleField converts it back to UTC)
function zoned(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

async function pick(page, trigger, text) {
  await trigger.click();
  await page.keyboard.type(text);
  await waitFor(page, (n) => !document.querySelector('[data-ref-combobox="list"][data-stale]') && [...document.querySelectorAll('[data-ref-combobox="list"] [role=option]')].some((o) => o.innerText.includes(n)), text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
}

export async function scheduleStage(drill, staff) {
  const check = (v, label, detail) => drill.check(v, `schedule: ${label}`, detail);
  // ---- staff: a bundle that starts in about two minutes ----
  await openPath(staff, "/admin/bundles/new");
  await staff.locator("#bundle-name").fill(BUNDLE);
  for (const name of ["Fixture product 1", "Fixture product 2"]) await pick(staff, staff.getByRole("button", { name: /Add a product/ }), name);
  await staff.locator("#bundle-price").fill("250");
  const hint = await staff.locator("[data-bundle-window]").innerText();
  const tz = /store.s \(([^)]+)\)/.exec(hint)?.[1] || "Asia/Kolkata"; // "Times are your store’s (Asia/Kolkata)."
  const startMs = Math.ceil((Date.now() + 120_000) / 60_000) * 60_000; // the next whole minute two minutes out
  await staff.locator("#offer-starts").fill(zoned(startMs, tz));
  await staff.getByText("Turn on after saving", { exact: true }).click();
  await waitFor(staff, () => /Shoppers save/.test(document.body.innerText));
  await drill.screenshot(staff, "schedule-staff-bundle");
  await staff.locator("[data-bundle-save]").click();
  await staff.waitForURL(/\/admin\/bundles$/, { timeout: 60_000 }).catch(() => {});
  await settle(staff);
  const listed = await staff.evaluate(async (title) => {
    const r = await fetch("/api/admin/bundles", { cache: "no-store" });
    return ((await r.json()).bundles || []).find((b) => b.title === title) || null;
  }, BUNDLE);
  check(listed && listed.enabled && listed.starts_at === new Date(startMs).toISOString(), "staff saved the bundle on, starting at the chosen minute in the store's time (UTC on the server)", { tz, starts_at: listed?.starts_at, want: new Date(startMs).toISOString() });
  const [[offerRow]] = listed ? await rolesSql([{ sql: "SELECT starts_at, ends_at, enabled FROM offers WHERE id = ?", args: [`bundle-${listed.id}`] }]) : [[null]];
  check(offerRow && offerRow.starts_at === listed.starts_at && offerRow.ends_at === listed.ends_at, "the window is mirrored onto the bundle's offer row", offerRow);
  check((await staff.locator('[data-bundle-schedule="scheduled"]').count()) === 1, "the bundles list shows the Scheduled chip", null);
  await drill.screenshot(staff, "schedule-bundles-list");
  if (!listed) return;

  // ---- the store opens; the anonymous shopper ----
  await openStore(drill);
  const shopperCtx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const shopper = await shopperCtx.newPage();
  const bundlePage = `${ORIGIN}/bundles/${listed.slug}`;
  await shopper.goto(bundlePage, { waitUntil: "load" });
  const early = await shopper.locator("body").innerText();
  check(Date.now() < startMs && !early.includes(BUNDLE) && /\b404\b|isn.t on .*shelves/i.test(early), "before its start the shopper gets the not-found page", early.slice(0, 200));
  await drill.screenshot(shopper, "schedule-shopper-before");
  let seen = false;
  while (!seen && Date.now() < startMs + 90_000) {
    await shopper.waitForTimeout(Math.max(1000, Math.min(10_000, startMs - Date.now() + 1000)));
    await shopper.goto(bundlePage, { waitUntil: "load" });
    seen = (await shopper.locator("h1").innerText().catch(() => "")) === BUNDLE;
  }
  check(seen && Date.now() >= startMs, "once the start passes the shopper sees the bundle page", { now: new Date().toISOString(), start: new Date(startMs).toISOString() });
  await drill.screenshot(shopper, "schedule-shopper-after");

  // ---- the owner: an offer for a collection ----
  const owner = await signIn(drill, "owner");
  await openPath(owner, "/admin/offers/new");
  await owner.getByText("Buy more, save more", { exact: true }).click();
  await owner.locator('label[for="target-collection"]').click();
  await pick(owner, owner.locator('[data-ref-combobox="trigger"]').first(), COLLECTION.title);
  const picked = await owner.locator('[data-picked="target"]').innerText().catch(() => "");
  check(picked === COLLECTION.title, "the collection picker picks the collection by its title", picked);
  const sentence = await owner.locator("main").innerText();
  check(sentence.includes(`Buy 2+ from ${COLLECTION.title}, get 10% off`), "the editor says it in plain words", null);
  await owner.getByRole("button", { name: /^Try it/ }).click();
  const tried = await waitFor(owner, () => document.querySelector("[data-simulator=result] [data-example]")?.innerText);
  const example = await owner.locator("[data-simulator=result] [data-example]").first().innerText().catch(() => "");
  check(tried && /Fixture product [12]\b/.test(example), "Try it builds its example cart from the collection's products", example.slice(0, 200));
  await drill.screenshot(owner, "schedule-owner-collection-offer");
  await owner.locator("[data-offer-save]").click();
  await owner.waitForURL(/\/admin\/offers$/, { timeout: 60_000 }).catch(() => {});
  await settle(owner);
  const offer = await owner.evaluate(async () => {
    const r = await fetch("/api/admin/offers", { cache: "no-store" });
    return ((await r.json()).offers || []).find((o) => o.config?.target?.kind === "collection") || null;
  });
  check(offer && offer.enabled && offer.config.target.value === COLLECTION.handle, "the collection offer is live", offer?.config?.target);
  await owner.context().close();

  // ---- the shopper: the collection page and the cart ----
  await shopper.goto(`${ORIGIN}/collections/${COLLECTION.handle}`, { waitUntil: "load" });
  const note = await shopper.locator("[data-collection-offer-note]").innerText().catch(() => "");
  check(offer && note.trim() === offer.label, "the collection page shows the offer's title, and only that", { note, label: offer?.label });
  check(!/fixture-collection|collection:|tiers|minQty/i.test(note), "the note names no target or rule", note);
  await drill.screenshot(shopper, "schedule-collection-note");
  const [[v1]] = await rolesSql(["SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.handle = 'fixture-product-1' ORDER BY v.position LIMIT 1"]);
  const cart = await shopper.evaluate(async (variantId) => {
    const r = await fetch("/api/cart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", variantId, quantity: 2 }) });
    return r.json();
  }, v1.id);
  check(offer && (cart.appliedOffers || []).some((a) => a.id === offer.id) && cart.discountTotal === 20, "two collection products in the cart get the offer (10% of ₹200)", { applied: cart.appliedOffers, discountTotal: cart.discountTotal });
  await shopperCtx.close();
}
