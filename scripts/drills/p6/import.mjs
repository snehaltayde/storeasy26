// P6-DRILLS stage I (Phase 1 line 5): onboarding step 2's live import, on the
// stage h store (a complete sync of 24 products, a support member). The runs
// below are planted in sync_runs with a live lease held by "drill", so the
// console's GET nudge finds the run busy and nothing reaches Shopify:
//   1. running   120 of 480 products, the stage, a progressbar at 25%; bumped
//                to 300 the count updates without a reload; then the
//                collections stage with 2 of 6
//   2. retrying  a 429: "Shopify is busy", "Next try at about …", "Try now"
//   3. failed    a 401: "Reconnect Shopify" selects step 1
//   4. complete  with 3 skipped: the list shows; no /api/admin/sync request
//                for 10 s after complete
//   5. hidden    while running and hidden: no polling; visible again: a read
//   6. support   the step read-only: Try again disabled with the reason
// Screenshots at 1440 and 390.
import { loginP6, p6Context, p6Sql, p6Url, platformSql, reseedP6, settle, sleep, waitFor, watchErrors } from "./lib.mjs";

const ONBOARDING = "/admin/onboarding";
const RUN = "sync_drill_i";
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const LEASE = () => ({ owner: "drill", until: iso(3600_000) });

async function plant(fields) {
  await p6Sql([{ sql: "DELETE FROM sync_runs WHERE id = ?", args: [RUN] }]);
  const row = { id: RUN, kind: "full", status: "running", phase: "products", source: "injected", started_by: "p6-drill", started_at: iso(-4 * 60_000), updated_at: iso(0), products_fetched: 120, products_total: 480, pages_done: 4, lease_owner: LEASE().owner, lease_until: LEASE().until, ...fields };
  const cols = Object.keys(row);
  await p6Sql([{ sql: `INSERT INTO sync_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => row[c]) }]);
}
const update = (sets, args) => p6Sql([{ sql: `UPDATE sync_runs SET ${sets}, updated_at = ? WHERE id = ?`, args: [...args, iso(0), RUN] }]);

async function goImport(drill, page) {
  await page.goto(p6Url(drill, `${ONBOARDING}?step=import`), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator('[data-onboarding="panel"][data-step="import"]').waitFor({ timeout: 60_000 });
}
async function readStep(page) {
  return page.evaluate(() => {
    const clean = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const panel = document.querySelector('[data-onboarding="panel"]');
    const body = panel?.querySelector('[data-import="body"]');
    const bar = panel?.querySelector('[role="progressbar"]');
    return {
      step: panel?.getAttribute("data-step") || null,
      state: body?.getAttribute("data-import-state") || null,
      text: clean(panel?.innerText),
      current: panel?.querySelector('[data-stage-state="current"]')?.getAttribute("data-stage") || null,
      valuenow: bar?.getAttribute("aria-valuenow") ?? null,
      buttons: [...(panel?.querySelectorAll("button") || [])].map((b) => ({ text: clean(b.innerText), disabled: b.disabled, reason: b.getAttribute("aria-describedby") ? clean(document.getElementById(b.getAttribute("aria-describedby"))?.innerText) : null })),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}
const until = (page, fn, ms = 20_000) => waitFor(async () => fn(await readStep(page)), ms, 300);

// /api/admin/sync requests a page makes, by time
function syncRequests(page) {
  const seen = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/admin/sync") seen.push({ at: Date.now(), method: r.method() });
  });
  return { since: (t) => seen.filter((x) => x.at >= t).length };
}

export async function importStage(drill) {
  await reseedP6(drill, "h");
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  const reqs = syncRequests(page);

  // ---- 1. running ----
  await plant({});
  await goImport(drill, page);
  let v = await until(page, (s) => s.state === "running" && s.text.includes("120 of 480 products") && s);
  drill.check(Boolean(v) && v.current === "products" && v.valuenow === "25" && v.text.includes("Bringing in products") && /Started \d+ minutes ago/.test(v.text), "running: 120 of 480 products (25%), the products stage current, a progressbar at 25, 'Started 4 minutes ago'", v || (await readStep(page)));
  await drill.screenshot(page, "i-import-running-1440", { fullPage: true });
  await update("products_fetched = ?, pages_done = 6", [300]);
  v = await until(page, (s) => s.text.includes("300 of 480 products") && s, 15_000);
  drill.check(Boolean(v) && v.valuenow === "63", "the count updates to 300 of 480 (63%) without a reload", v || (await readStep(page)));
  await update("phase = 'collections', products_fetched = 480, collections_fetched = 2, collections_total = 6", []);
  v = await until(page, (s) => s.current === "collections" && s, 15_000);
  drill.check(Boolean(v) && v.text.includes("2 of 6 collections") && v.text.includes("480 products, all in") && v.valuenow === "33", "then the collections stage: 2 of 6 collections, products all in", v || (await readStep(page)));

  // ---- 2. retrying (429) ----
  await update("phase = 'products', products_fetched = 300, error = ?", ["Admin GraphQL HTTP 429: Throttled"]);
  // the queue's next try, when the platform queued one for this run
  const job = await platformSql([{ sql: "UPDATE jobs SET status = 'pending', run_after = ? WHERE type = 'catalog_sync' AND idempotency_key LIKE ?", args: [iso(5 * 60_000), `%:${RUN}`] }]).catch(() => null);
  const queued = Number(job?.[0]?.rowsAffected || 0) > 0;
  v = await until(page, (s) => s.state === "retrying" && s, 15_000);
  drill.check(Boolean(v) && v.text.includes("Shopify is busy. We'll try again by itself.") && v.buttons.some((b) => b.text === "Try now" && !b.disabled), "retrying (429): 'Shopify is busy. We'll try again by itself.' and an enabled 'Try now'", v || (await readStep(page)));
  if (queued) {
    const at = await until(page, (s) => /Next try at about \d/.test(s.text) && s, 15_000);
    drill.check(Boolean(at), "retrying: 'Next try at about …' from the queued job", (at || (await readStep(page))).text.slice(0, 300));
  } else drill.note("no catalog_sync job row for the planted run, so 'Next try at about …' is not checked");
  await drill.screenshot(page, "i-import-retrying-1440", { fullPage: true });

  // ---- 3. failed (401): Reconnect Shopify selects step 1 ----
  await update("status = 'failed', finished_at = ?, lease_owner = NULL, lease_until = NULL, error = ?", [iso(0), 'Admin GraphQL HTTP 401: {"errors":"[API] Invalid API key or access token"}']);
  v = await until(page, (s) => s.state === "failed" && s, 15_000);
  drill.check(Boolean(v) && v.text.includes("Reconnect Shopify, then try again.") && !/HTTP|GraphQL|Invalid API key/.test(v.text), "failed (401): the plain words, never the raw error", v || (await readStep(page)));
  const names = (v?.buttons || []).map((b) => b.text);
  drill.check(names.indexOf("Reconnect Shopify") >= 0 && names.indexOf("Reconnect Shopify") < names.indexOf("Try again"), "failed (401): 'Reconnect Shopify' first, then 'Try again'", names);
  await drill.screenshot(page, "i-import-failed-1440", { fullPage: true });
  await page.getByRole("button", { name: "Reconnect Shopify", exact: true }).click();
  const moved = await waitFor(async () => (await page.locator('[data-onboarding="panel"]').getAttribute("data-step")) === "connect" && new URL(page.url()).search === "?step=connect", 10_000, 200);
  drill.check(moved, "'Reconnect Shopify' selects step 1 (?step=connect)", page.url());

  // ---- 4. complete with 3 skipped; no polling after ----
  const skipped = [
    { type: "product", id: "gid://shopify/Product/990001", handle: "no-title-tee", title: null, reason: "no_title" },
    { type: "product", id: "gid://shopify/Product/990002", handle: "", title: "Linen shirt", reason: "no_handle" },
    { type: "product", id: "gid://shopify/Product/990003", handle: "cap", title: "Cap", reason: "duplicate_handle", kept: true },
  ];
  await plant({ status: "complete", phase: "done", products: 24, collections: 3, products_fetched: 24, collections_fetched: 3, started_at: iso(-7 * 60_000), finished_at: iso(-60_000), lease_owner: null, lease_until: null, skipped_count: 3, skipped: JSON.stringify(skipped) });
  await goImport(drill, page);
  v = await until(page, (s) => s.state === "complete" && s);
  drill.check(Boolean(v) && v.text.includes("3 products couldn't come in") && ["no-title-tee", "Linen shirt", "Cap"].every((n) => v.text.includes(n)) && v.text.includes("Took 6 minutes."), "complete: '24 products and 3 collections, brought in …. Took 6 minutes.' and the 3 skipped listed with why", v || (await readStep(page)));
  drill.check(v && !v.text.includes("gid://"), "the list shows no Shopify ids", null);
  await drill.screenshot(page, "i-import-complete-skipped-1440", { fullPage: true });
  const quiet = Date.now();
  await sleep(10_000);
  drill.check(reqs.since(quiet) === 0, "no /api/admin/sync request for 10 s after complete", reqs.since(quiet));

  // ---- 5. hidden: no polling; visible again: one read ----
  await plant({ products_fetched: 200 });
  await goImport(drill, page);
  await until(page, (s) => s.state === "running" && s);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sleep(3_500); // a poll already armed may land once
  const hidden = Date.now();
  await sleep(10_000);
  drill.check(reqs.since(hidden) === 0, "while the tab is hidden: no /api/admin/sync request for 10 s", reqs.since(hidden));
  await update("products_fetched = 360", []);
  const back = Date.now();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  v = await until(page, (s) => s.text.includes("360 of 480 products") && s, 3_000);
  drill.check(Boolean(v) && reqs.since(back) >= 1, "visible again: read at once, 360 of 480", { requests: reqs.since(back) });

  // the same running step at 390: nothing scrolls sideways
  const narrow = await p6Context(drill, { width: 390 });
  const np = await loginP6(drill, narrow);
  await goImport(drill, np);
  v = await until(np, (s) => s.state === "running" && s);
  drill.check(Boolean(v) && !v.overflow, "at 390 the running step fits (no sideways scroll)", v && { overflow: v.overflow });
  await drill.screenshot(np, "i-import-running-390", { fullPage: true });
  await update("status = 'failed', finished_at = ?, lease_owner = NULL, lease_until = NULL, error = ?", [iso(0), "Admin GraphQL HTTP 401: x"]);
  await goImport(drill, np);
  await until(np, (s) => s.state === "failed" && s);
  await drill.screenshot(np, "i-import-failed-390", { fullPage: true });
  await narrow.close();

  // ---- 6. support: reads it, changes nothing ----
  const sctx = await p6Context(drill);
  const sp = await loginP6(drill, sctx, { as: "support" });
  await goImport(drill, sp);
  v = await until(sp, (s) => s.state === "failed" && s);
  const tryAgain = v?.buttons.find((b) => b.text === "Try again");
  drill.check(Boolean(tryAgain?.disabled) && tryAgain.reason === "Your role can look at this but not change it.", "support: 'Try again' disabled with 'Your role can look at this but not change it.'", v?.buttons);
  drill.check(v?.buttons.some((b) => b.text === "Reconnect Shopify"), "support: 'Reconnect Shopify' is shown (step 1 gates its own action)", v?.buttons);
  const post = await sp.evaluate(async () => (await fetch("/api/admin/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retry: true }) })).status);
  const row = (await p6Sql([{ sql: "SELECT status FROM sync_runs WHERE id = ?", args: [RUN] }]))[0].rows[0];
  drill.check(post === 403 && String(row?.status) === "failed", "support: a direct POST is refused (403) and the run stays failed", { post, status: row?.status });
  await drill.screenshot(sp, "i-import-support-1440", { fullPage: true });
  await sctx.close();

  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
