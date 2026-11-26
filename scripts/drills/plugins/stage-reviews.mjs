// drill:plugins stage "reviews" (Phase 9 line 1): the owner installs Reviews,
// turns its three blocks Live and invite emails on; a fixture order is placed
// and fulfilled (its invite written as the order.fulfilled handler writes it,
// due now: test:reviews covers the handler itself); the job tick's sweep sends
// the invite email; the shopper opens the link from the notifications row and
// submits the plain form; the product page still shows nothing; staff approve
// in /admin/reviews; the anonymous product page then shows the stars, the
// review and AggregateRating in its JSON-LD; reusing the link refuses; support
// sees the queue with no moderation control and no email.
import { ORIGIN, api, open, rolesSql, shopper, signIn, stage } from "./lib.mjs";

const HANDLE = "fixture-product-2";
const ORDER = "ord_drillreviews01";
const EMAIL = "review.drill@shopper.test";
const TITLE = "Drill review title";
const REFUSED = "This review link has already been used or has expired.";

async function signInPatient(drill, role) {
  try {
    return await signIn(drill, role);
  } catch (e) {
    if (!/answered 429/.test(String(e?.message))) throw e;
    drill.note(`sign-in as ${role} was rate limited; waiting the minute out`);
    await new Promise((r) => setTimeout(r, 62_000));
    return signIn(drill, role);
  }
}
const tick = (page) => page.evaluate(async () => (await fetch("/api/jobs/tick", { method: "POST" })).status);
const ldRating = (page) =>
  page.evaluate(() => {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = [].concat(JSON.parse(s.textContent));
        const p = data.find((d) => d["@type"] === "Product");
        if (p) return p.aggregateRating ?? null;
      } catch {}
    }
    return undefined;
  });

stage("reviews", async (drill) => {
  // --- the owner installs Reviews, turns its blocks Live and invite emails on
  const owner = await signInPatient(drill, "owner");
  await open(owner, "/admin/apps");
  const inst = await api(owner, "apps", { install: { pluginId: "reviews", scopes: ["orders.read"] } });
  drill.check(inst.status === 200, "owner: Reviews installs (200)", inst.json?.error);
  const id = inst.json?.install?.id;
  for (const block of ["stars", "list", "links"]) {
    const r = await api(owner, `apps/${id}/blocks`, { block, state: "live" });
    drill.check(r.status === 200, `owner: the ${block} block goes Live`, r.json?.error);
  }
  const set = await api(owner, `apps/${id}`, { settings: { invite_emails: true, send_after_days: 1, show_replies: true } });
  drill.check(set.status === 200, "owner: invite emails on", set.json?.error);
  await owner.context().close();

  // --- a fixture order, fulfilled: its invite is due now
  const [[product]] = await rolesSql([{ sql: "SELECT id, title FROM products WHERE handle = ?", args: [HANDLE] }]);
  drill.check(!!product, `the roles store has ${HANDLE}`);
  const now = new Date();
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  await rolesSql([
    { sql: "DELETE FROM reviews WHERE order_id = ?", args: [ORDER] },
    { sql: "DELETE FROM review_invites WHERE order_id = ?", args: [ORDER] },
    { sql: "DELETE FROM order_items WHERE order_id = ?", args: [ORDER] },
    { sql: "DELETE FROM orders WHERE id = ?", args: [ORDER] },
    { sql: "DELETE FROM notifications WHERE idempotency_key = ?", args: [`review_invite:${ORDER}`] },
    { sql: "INSERT INTO orders (id, email, name, subtotal, total, currency, payment_method, status, created_at, updated_at) VALUES (?, ?, 'Priya Sharma', 400, 400, 'INR', 'cod', 'synced', ?, ?)", args: [ORDER, EMAIL, iso(-3 * 86400_000), iso(-3 * 86400_000)] },
    { sql: "INSERT INTO order_items (order_id, product_id, variant_id, title, quantity, unit_price, line_total, position) VALUES (?, ?, ?, ?, 1, 400, 400, 0)", args: [ORDER, product.id, `${product.id}-v`, product.title] },
    {
      sql: "INSERT INTO review_invites (id, order_id, product_id, customer_id, send_after, sent_at, expires_at, used_at, review_id, created_at) VALUES ('rvi_d0d0d0d0d0d0d0d0', ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?)",
      args: [ORDER, product.id, iso(-60_000), new Date(Math.floor((now.getTime() + 60 * 86400_000) / 1000) * 1000).toISOString(), iso(-86400_000)],
    },
  ]);

  // --- the sweep sends the invite email
  const shop = await shopper(drill);
  await shop.goto(`${ORIGIN}/`, { waitUntil: "load" });
  let note = null;
  for (let i = 0; i < 20 && !note; i++) {
    await tick(shop);
    [[note]] = await rolesSql([{ sql: "SELECT recipient, body FROM notifications WHERE idempotency_key = ?", args: [`review_invite:${ORDER}`] }]);
    if (!note) await shop.waitForTimeout(1500);
  }
  drill.check(!!note && note.recipient === EMAIL, "the sweep queued one invite email to the buyer", note?.recipient);
  const link = /https?:\/\/\S+(\/reviews\/write\?t=\S+)/.exec(note?.body || "")?.[1];
  drill.check(!!link && /Don't ask me for reviews: \S+\/reviews\/optout\?t=/.test(note.body), "the email has the review link and the opt-out link");

  // --- the shopper writes the review through the plain form
  const res = await shop.goto(ORIGIN + link, { waitUntil: "load" });
  drill.check(res?.status() === 200, "the invite link opens the write page (200)", res?.status());
  await shop.locator("[data-review-form]").waitFor();
  drill.check((await shop.locator("[data-review-product]").innerText()) === product.title, "the write page names the product");
  drill.check((await shop.locator('input[name="display_name"]').inputValue()) === "Priya S.", "the name is prefilled as Priya S.");
  await drill.shoot(shop, "review-write");
  await shop.locator('input[name="rating"][value="5"]').check();
  await shop.locator('input[name="title"]').fill(TITLE);
  await shop.locator('textarea[name="body"]').fill("Soft, warm and exactly as shown in the pictures.");
  await Promise.all([shop.waitForURL(/\/reviews\/write\?done=1/), shop.getByRole("button", { name: "Send review" }).click()]);
  drill.check((await shop.locator("[data-review-done]").innerText()).includes("Your review will appear once the store has read it."), "the thanks page");

  // --- pending: the product page shows nothing
  await shop.goto(`${ORIGIN}/products/${HANDLE}`, { waitUntil: "load" });
  drill.check((await shop.locator("[data-rating-summary]").count()) === 0 && (await shop.locator("[data-review-list]").count()) === 0, "pending: no stars and no list on the product page");
  drill.check((await ldRating(shop)) === null, "pending: no aggregateRating in the JSON-LD");

  // --- staff approve in the queue
  const staff = await signInPatient(drill, "staff");
  drill.check((await open(staff, "/admin/reviews")) === 200, "staff: /admin/reviews opens (200)");
  const row = staff.locator("[data-review-row]", { hasText: TITLE });
  await row.waitFor();
  drill.check((await row.locator("[data-review-email]").innerText()) === EMAIL, "staff: the row shows the buyer's email");
  await drill.shoot(staff, "reviews-queue");
  await row.locator('[data-review-action="approve"]').click();
  await staff.locator("[data-review-row]", { hasText: TITLE }).waitFor({ state: "detached" });
  await staff.context().close();

  // --- approved: the anonymous product page shows the stars, the review and the rating
  await shop.goto(`${ORIGIN}/products/${HANDLE}`, { waitUntil: "load" });
  drill.check((await shop.locator("[data-rating-summary]").count()) === 1, "approved: the stars show under the price");
  drill.check((await shop.locator("[data-review-list]").innerText()).includes(TITLE), "approved: the review shows in the list");
  const rating = await ldRating(shop);
  drill.check(rating && rating["@type"] === "AggregateRating" && rating.reviewCount >= 1 && rating.bestRating === 5 && rating.worstRating === 1 && typeof rating.ratingValue === "number", "approved: AggregateRating in the JSON-LD", rating);
  drill.check(!(await shop.content()).includes(EMAIL), "the product page never has the buyer's email");
  await drill.shoot(shop, "pdp-stars");

  // --- the link works once
  await shop.goto(ORIGIN + link, { waitUntil: "load" });
  drill.check((await shop.locator("[data-review-refused]").innerText()) === REFUSED, "reusing the link refuses with the one sentence");
  await shop.context().close();

  // --- support reads the queue with no moderation control and no email
  const support = await signInPatient(drill, "support");
  drill.check((await open(support, "/admin/reviews?status=approved")) === 200, "support: /admin/reviews opens (200)");
  await support.locator("[data-review-row]", { hasText: TITLE }).waitFor();
  drill.check((await support.locator("[data-review-action]").count()) === 0, "support: no moderation controls");
  drill.check((await support.locator("[data-review-email]").count()) === 0 && !(await support.content()).includes(EMAIL), "support: no buyer email");
  await support.context().close();
});
