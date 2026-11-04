// P4-FIX3 drill (OVL-04, OVL-01): the product editor's description and
// product switching, in desktop Chrome on the design harness (phase 3 seed, a
// documents store made by the harness's local takeOver), owner, 1440 px.
//
//   DESIGN_PORT=6140 DESIGN_SQLD_PORT=7140 node docs/cms-reviews/drills/P4-FIX3/fix3.mjs [--headed]
//
//   description  the founder's own description saved; Shopify's shows beside
//                it as plain text; Shopify's description then changes (a
//                local write to the harness's catalog row, as a sync would):
//                the "Changed in Shopify" notice reads in plain words, no
//                raw HTML
//   switching    from product A (with an edited name) to product B through
//                the switcher: while B opens, the page never shows A's draft
//                name with B's "Shopify title: …"
// Nothing writes to Shopify; no test order. Results: results-fix3.json here.
import { DrillError, reseed, runDrill, settle, storeSql } from "../../../../scripts/drills/p4/lib.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 30_000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(step);
  }
  return false;
}
const rowsOf = (r) => r.rows.map((x) => ({ ...x }));
const put = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

async function fix3(drill) {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const page = await drill.login("owner", { context: ctx });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message || e)));
  const [prodRows] = await storeSql("live", ["SELECT id, handle, title FROM products ORDER BY title, id LIMIT 2"]);
  const [a, b] = rowsOf(prodRows);
  if (!a || !b) throw new DrillError("the seeded store has fewer than two products");

  // ---- description ----
  await storeSql("live", [{ sql: "UPDATE products SET description_html = ? WHERE id = ?", args: ["<p>Shopify's <b>soft</b> cotton &amp; linen.</p>", a.id] }]);
  await page.goto(`/admin/editor?product=${encodeURIComponent(a.id)}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const docId = await page.locator("[data-document-editor]").getAttribute("data-doc");
  let d = (await put(page, { getDocument: docId })).body?.document;
  if (!d) throw new DrillError(`getDocument ${docId} answered nothing`);
  const settings = { ...d.body.settings, description_html: { value: "<p>My own <em>words</em> for this.</p>" }, title: { value: "Drill own name" } };
  const saved = await put(page, { saveDraft: { id: docId, body: { ...d.body, settings } }, revision: d.revision });
  drill.check(saved.status === 200, "description: the founder's own description and name save", { status: saved.status });
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const beside = (await page.locator('[data-shopify-value="description_html"]').first().innerText().catch(() => "")).trim();
  drill.check(beside.startsWith("Shopify's description: Shopify's soft cotton & linen.") && !/[<>]/.test(beside), "description: Shopify's description shows beside the founder's, as plain text", { beside });
  await drill.screenshot(page, "description-beside-1440");
  // Shopify's description changes (as the next catalog sync would write it)
  await storeSql("live", [{ sql: "UPDATE products SET description_html = ? WHERE id = ?", args: ['<h2>New</h2><p>Organic <em>cotton</em>, now <a href="#">softer</a>.</p>', a.id] }]);
  await page.reload({ waitUntil: "load" });
  await page.locator("[data-product-form]").waitFor({ timeout: 90_000 });
  const notice = page.locator('[data-shopify-changed="description_html"]');
  await notice.waitFor({ timeout: 30_000 });
  const words = (await notice.locator("[data-notice-words]").innerText()).trim();
  drill.check(words === "Shopify changed the description after you edited it. Shopify's description now reads: New Organic cotton, now softer." && !/[<>]/.test(words), "description: the 'Changed in Shopify' notice reads in plain words, no raw HTML", { words });
  await notice.scrollIntoViewIfNeeded();
  await drill.screenshot(page, "description-notice-1440");

  // ---- switching ----
  // record every (heading, Shopify title) pair the page shows while B opens
  await page.evaluate(() => {
    window.__pairs = [];
    const take = () => {
      const h = document.querySelector("[data-product-heading]")?.textContent?.trim() ?? null;
      const s = document.querySelector("[data-shopify-title]")?.textContent?.trim() ?? null;
      const last = window.__pairs.at(-1);
      if (!last || last.h !== h || last.s !== s) window.__pairs.push({ h, s, url: location.search });
    };
    take();
    new MutationObserver(take).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.locator("[data-switcher-toggle]").click();
  await page.locator("[data-switcher-search]").fill(b.title.slice(0, 12));
  const row = page.locator(`[data-switcher-product="${b.id}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await page.waitForURL((u) => u.searchParams.get("product") === b.id, { timeout: 60_000 });
  const opened = await waitFor(async () => (await page.locator("[data-shopify-title]").innerText().catch(() => "")).trim() === `Shopify title: ${b.title}` && (await page.locator("[data-product-heading]").innerText()).trim() === b.title, 60_000);
  const pairs = await page.evaluate(() => window.__pairs);
  const mixed = pairs.filter((p) => p.h === "Drill own name" && p.s === `Shopify title: ${b.title}`);
  drill.check(Boolean(opened) && mixed.length === 0, "switching: from A (edited name) to B, A's draft is never shown with B's Shopify title; B opens with its own", { pairs: pairs.slice(0, 12), mixed });
  await drill.screenshot(page, "switched-to-b-1440");
  drill.check(errors.length === 0, "no page errors in the console", { errors: errors.slice(0, 5) });
}

process.exitCode = await runDrill({ id: "P4-FIX3", part: "fix3", title: "P4-FIX3 — description beside and notice, switching products" }, fix3);
