// P1-DRILLS · GEN-02 drills D1–D12 (docs/cms-reviews/P1-GEN-02.md "Browser drills still needed").
// States are set by writing sync_runs rows to the harness's local tenant
// database only (scripts/drills/p1/db.mjs). Parts:
//   main     D1–D6, D8 on the freshly seeded harness
//   support  D9
//   empty    D7, D10 (deletes the harness products: re-seed afterwards)
//   refresh  D11, D12 (run right after a re-seed)
import { sql, rows } from "./db.mjs";
import { text, seen, watch, supportContext, revokeGrant, bannerTone, scrollWidth, sleep, settle } from "./util.mjs";

export const id = "GEN-02";
export const title = "P1-DRILLS GEN-02: first sync progress, failures and retry";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const D1_ROW = `INSERT INTO sync_runs (id,status,phase,started_at,updated_at,products_fetched,products_total,lease_owner,lease_until,source,started_by) VALUES ('sync_drill','running','products',${NOW},${NOW},240,600,'drill',strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes'),'admin','connect')`;
const COMPLETE = `UPDATE sync_runs SET status='complete', phase='done', products=600, collections=120, finished_at=${NOW} WHERE id='sync_drill'`;

async function resetD1() {
  await sql("tenant", ["DELETE FROM sync_runs", D1_ROW]);
}

// The sync card: the section that holds the "Your products from Shopify" heading.
async function card(page) {
  return page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((x) => x.textContent.trim().startsWith("Your products from Shopify"));
    const sec = h?.closest("section");
    if (!sec) return null;
    const bar = sec.querySelector('[role="progressbar"]');
    const live = sec.querySelector('[aria-live="polite"]');
    const main = sec.closest("main") || document.body;
    const blocks = [...main.querySelectorAll("section, .grid")].filter((e) => e.getBoundingClientRect().height > 0);
    const r = sec.getBoundingClientRect();
    const above = blocks.filter((b) => b !== sec && !sec.contains(b) && !b.contains(sec) && b.getBoundingClientRect().top < r.top - 1).map((b) => (b.innerText || "").slice(0, 60));
    return {
      text: sec.innerText,
      buttons: [...sec.querySelectorAll("button")].map((b) => b.innerText.trim()),
      bar: bar ? { label: bar.getAttribute("aria-label"), now: bar.getAttribute("aria-valuenow"), min: bar.getAttribute("aria-valuemin"), max: bar.getAttribute("aria-valuemax"), fill: bar.firstElementChild?.style.width } : null,
      liveHasHeadline: Boolean(live && live.innerText.length > 0),
      liveText: live?.innerText || null,
      blocksAbove: above,
      top: r.top,
    };
  });
}

async function openDash(drill, page, width = 1440) {
  await drill.open(page, "/admin/dashboard", { width });
  await seen(page, "Your products from Shopify", 15_000);
  return card(page);
}

export const parts = {
  async main(drill) {
    await resetD1();
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);

    // ---- D1 ----
    let c = await openDash(drill, page);
    drill.check(Boolean(c), "D1 dashboard: the sync card shows");
    drill.check(c && !c.blocksAbove.length, "D1 dashboard: the card is first on the page (no stats or other card above it)", c?.blocksAbove);
    drill.check(c?.text.includes("Bringing in your products from Shopify"), 'D1: headline "Bringing in your products from Shopify"', c?.text);
    drill.check(c?.text.includes("240 of 600 products so far. Big stores can take a while. You can keep using the console."), 'D1: "240 of 600 products so far. Big stores can take a while. You can keep using the console." (full stop after "so far")', c?.text);
    drill.check(c?.bar?.now === "40", "D1: the bar is at 40% (aria-valuenow 40)", c?.bar);
    drill.check(c && c.buttons.length === 0, "D1: no button on the card", c?.buttons);
    // D8 (part): progress bar label, aria-valuenow, headline aria-live
    drill.check(c?.bar?.label === "Products brought in" && c?.bar?.now != null, 'D8: the progress bar has a label ("Products brought in") and aria-valuenow', c?.bar);
    drill.check(c?.liveHasHeadline && c.liveText.includes("Bringing in your products"), 'D8: the headline area is aria-live="polite"', c?.liveText);
    await drill.shoot(page, "D1-dashboard-1440");
    await page.setViewportSize({ width: 375, height: 812 });
    await settle(page);
    const sw = await scrollWidth(page);
    drill.check(sw.sw <= sw.vw + 1, "D1 at 375: no sideways scroll", sw);
    await drill.shoot(page, "D1-dashboard-375");
    await page.setViewportSize({ width: 1440, height: 900 });

    // ---- D2 ----
    await sql("tenant", "UPDATE sync_runs SET status='failed', error='Admin GraphQL HTTP 502: Bad Gateway', lease_owner=NULL, lease_until=NULL WHERE id='sync_drill'");
    c = await openDash(drill, page);
    drill.check(c?.text.includes("Your products didn't finish coming in"), `D2: headline "Your products didn't finish coming in"`, c?.text);
    const t2 = await bannerTone(page, "Shopify didn't answer");
    drill.check(t2?.tone === "danger", "D2: the message is in a red (danger) banner", t2);
    drill.check(c?.text.includes("Shopify didn't answer. This usually clears up on its own. Try again in a few minutes."), "D2: the plain message", c?.text);
    drill.check(c?.text.includes("240 of 600 products so far. Your store keeps everything already brought in."), 'D2: "240 of 600 products so far. Your store keeps everything already brought in."', c?.text);
    drill.check(c?.buttons.includes("Try again"), "D2: a Try again button", c?.buttons);
    drill.check(!/502|GraphQL|Bad Gateway/i.test(c?.text || ""), "D2: nothing raw on the sync card (no 502, GraphQL, Bad Gateway)", c?.text);
    const page2 = await text(page);
    const raw = page2.split("\n").filter((l) => /502|GraphQL|Bad Gateway/i.test(l));
    if (raw.length) drill.note(`D2: elsewhere on the dashboard (not the sync card) the seeded order-push failures show raw text: ${JSON.stringify(raw)}`);
    await drill.shoot(page, "D2-failed");

    // ---- D8 (keyboard): Tab reaches Try again, Enter presses it ----
    const posts = watch(page, "/api/admin/sync");
    await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.evaluate(() => document.activeElement?.blur());
    let reached = false;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.innerText?.trim() }));
      if (f.tag === "BUTTON" && f.text === "Try again") {
        reached = i + 1;
        break;
      }
    }
    drill.check(Boolean(reached), "D8: Tab reaches Try again", reached ? `after ${reached} Tab presses` : "not reached in 80 presses");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const s = getComputedStyle(el);
      return { outline: s.outlineStyle + " " + s.outlineWidth, shadow: s.boxShadow };
    });
    drill.note(`D8: focus style on Try again: outline ${ring.outline}, box-shadow ${ring.shadow}`);
    if (reached) {
      await page.keyboard.press("Enter");
      const got = await seen(page, "Couldn't start", 15_000);
      const post = posts.find((r) => r.method === "POST");
      drill.check(Boolean(post), "D8: Enter pressed Try again (a POST /api/admin/sync went out)", posts);
      const after = await card(page);
      // ---- D2 (second half) ----
      drill.check(got && after?.text.includes("Storeasy isn't linked to your Shopify store. Contact support to link it, then try again."), `D2: Try again gives a "Couldn't start" banner: "Storeasy isn't linked to your Shopify store. Contact support to link it, then try again."`, after?.text);
      drill.check(!/\b\d{3}\b.*(HTTP|GraphQL)|NOT_LINKED|409/.test(after?.text || ""), "D2: no raw text in the Couldn't start banner", after?.text);
      drill.note(`D2: POST /api/admin/sync answered ${post?.status}`);
      await drill.shoot(page, "D2-try-again-couldnt-start");
    }

    // ---- D3 ----
    await sql("tenant", `UPDATE sync_runs SET status='running', error='fetch failed', lease_owner=NULL, lease_until=NULL, updated_at=${NOW} WHERE id='sync_drill'`);
    c = await openDash(drill, page);
    const t3 = await bannerTone(page, c?.text.includes("Shopify didn't answer") ? "Shopify didn't answer" : "snag");
    drill.check(t3?.tone === "warning", "D3: an amber (warning) banner", { tone: t3, text: c?.text });
    drill.check(c?.buttons.includes("Try again now"), "D3: a Try again now button", c?.buttons);
    drill.check(!/fetch failed/i.test(c?.text || ""), "D3: the message is plain (no 'fetch failed')", c?.text);
    drill.note(`D3 card text: ${JSON.stringify(c?.text)}`);
    await drill.shoot(page, "D3-retrying");

    // ---- D4 ----
    await sql("tenant", "UPDATE sync_runs SET error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id='sync_drill'");
    // D3's open page may have polled and changed the row; read it back
    const r4 = await rows("tenant", "SELECT status, error, lease_owner, updated_at, products_fetched FROM sync_runs WHERE id='sync_drill'");
    drill.note(`D4 row before reload: ${JSON.stringify(r4[0])}`);
    const gets = watch(page, "/api/admin/sync");
    c = await openDash(drill, page);
    drill.check(c?.text.includes("Bringing in your products stopped partway"), 'D4: "Bringing in your products stopped partway"', c?.text);
    drill.check(c?.text.includes("It stopped before finishing. Try again to pick up where it left off."), 'D4: "It stopped before finishing. Try again to pick up where it left off."', c?.text);
    drill.check(c?.buttons.includes("Try again"), "D4: Try again", c?.buttons);
    const before = gets.length;
    await page.waitForTimeout(10_000);
    const polls = gets.slice(before).filter((g) => g.method === "GET");
    drill.check(polls.length === 0, "D4: no repeating GET /api/admin/sync over 10 s (a stalled card doesn't poll)", polls);
    await drill.shoot(page, "D4-stalled");

    // ---- D5 ----
    await resetD1();
    await drill.open(page, "/admin/settings", { width: 1440 });
    const navLink = page.getByRole("link", { name: "Products from Shopify" }).first();
    const hasNav = (await navLink.count()) > 0;
    drill.check(hasNav, 'D5: the settings section nav says "Products from Shopify"');
    if (hasNav) {
      await navLink.click();
      await page.waitForTimeout(1200);
      const pos = await page.evaluate(() => {
        const el = document.getElementById("catalog-sync");
        const r = el?.getBoundingClientRect();
        return { hash: location.hash, top: r?.top, bottom: r?.bottom, vh: window.innerHeight };
      });
      drill.check(pos.hash === "#catalog-sync" && pos.top >= -5 && pos.top < pos.vh / 2, "D5: the nav jumps to the card (#catalog-sync, card at the top of the window)", pos);
    }
    let sc = await card(page);
    drill.check(sc?.text.includes("240 of 600 products so far") && sc?.bar?.now === "40", "D5: with the D1 row the settings card shows progress", sc?.text);
    await drill.shoot(page, "D5-settings-progress");
    await sql("tenant", COMPLETE);
    await drill.open(page, "/admin/settings", { width: 1440 });
    await page.evaluate(() => document.getElementById("catalog-sync")?.scrollIntoView());
    sc = await card(page);
    drill.check(sc?.text.includes("Your products are in"), 'D5: "Your products are in"', sc?.text);
    drill.check(sc?.text.includes("600 products and 120 collections, brought in just now."), 'D5: "600 products and 120 collections, brought in just now."', sc?.text);
    drill.check(!sc?.buttons.includes("Refresh from Shopify"), 'D5: no "Refresh from Shopify" button (the harness has no Shopify link)', sc?.buttons);
    await drill.shoot(page, "D5-settings-complete");

    // ---- D6 ----
    await resetD1();
    const polls6 = watch(page, "/api/admin/sync");
    c = await openDash(drill, page);
    const t0 = Date.now();
    await page.waitForTimeout(10_000);
    const during = polls6.filter((p) => p.method === "GET" && p.at >= t0);
    const gaps = during.slice(1).map((p, i) => p.at - during[i].at);
    drill.check(during.length >= 2 && gaps.every((g) => g > 2000 && g < 5000), "D6: GET /api/admin/sync fires about every 3 s while it runs", { count: during.length, gapsMs: gaps });
    await sql("tenant", COMPLETE);
    const tDone = Date.now();
    const turned = await seen(page, "Your products are in", 15_000);
    drill.check(turned, "D6: without a reload the card turns into \"Your products are in\" within a few seconds", `${Math.round((Date.now() - tDone) / 100) / 10} s`);
    await page.waitForTimeout(1000);
    const tStop = Date.now();
    await page.waitForTimeout(10_000);
    const afterDone = polls6.filter((p) => p.method === "GET" && p.at >= tStop);
    drill.check(afterDone.length === 0, "D6: the requests stop once it is done (none in the next 10 s)", afterDone);
    await drill.shoot(page, "D6-done-without-reload");
    await ctx.close();
  },

  async support(drill) {
    // ---- D9 ----
    await resetD1();
    const { ctx, page, grant } = await supportContext(drill);
    drill.check(grant.status === 200 && grant.body.id, "D9: the operator console created a support grant for the design store", grant.status);
    const gets = watch(page, "/api/admin/sync");
    await drill.open(page, "/admin/dashboard", { width: 1440 });
    const role = await text(page);
    drill.note(`D9: support view banner: ${JSON.stringify((role.match(/[^\n]*support[^\n]*/i) || [""])[0].slice(0, 160))}`);
    await seen(page, "Your products from Shopify", 15_000);
    const before = await rows("tenant", "SELECT products_fetched, updated_at, lease_owner FROM sync_runs WHERE id='sync_drill'");
    const c = await card(page);
    drill.check(c?.text.includes("240 of 600 products so far"), "D9: as support, the card shows progress", c?.text);
    drill.check(c && c.buttons.length === 0, "D9: no buttons on the card for support", c?.buttons);
    await page.waitForTimeout(10_000);
    const after = await rows("tenant", "SELECT products_fetched, updated_at, lease_owner FROM sync_runs WHERE id='sync_drill'");
    const polled = gets.filter((g) => g.method === "GET");
    drill.check(polled.length >= 2, "D9: the support login's card polls (GET /api/admin/sync)", polled.map((p) => p.status));
    drill.check(before[0]?.products_fetched === after[0]?.products_fetched && before[0]?.updated_at === after[0]?.updated_at, "D9: sync_runs.products_fetched (and updated_at) unchanged while support's card polls", { before: before[0], after: after[0] });
    await drill.shoot(page, "D9-support");
    // A second check with the lease lapsed: a support poll must not take the run either.
    await sql("tenant", "UPDATE sync_runs SET lease_owner=NULL, lease_until=NULL WHERE id='sync_drill'");
    const b2 = await rows("tenant", "SELECT products_fetched, updated_at, lease_owner, status, error FROM sync_runs WHERE id='sync_drill'");
    await drill.open(page, "/admin/dashboard", { width: 1440 });
    await page.waitForTimeout(8_000);
    const a2 = await rows("tenant", "SELECT products_fetched, updated_at, lease_owner, status, error FROM sync_runs WHERE id='sync_drill'");
    drill.check(JSON.stringify(b2[0]) === JSON.stringify(a2[0]), "D9 (extra): with no lease held, support's polls still don't touch the run", { before: b2[0], after: a2[0] });
    await revokeGrant(page, grant.body.id);
    await ctx.close();
  },

  async empty(drill) {
    // ---- D7 ----
    await sql("tenant", ["DELETE FROM variants", "DELETE FROM product_images", "DELETE FROM collection_products", "DELETE FROM products", "DELETE FROM sync_runs", D1_ROW]);
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    await drill.open(page, "/admin/setup", { width: 1440 });
    const step = await page.evaluate(() => {
      const el = [...document.querySelectorAll("li, section, div")].filter((e) => e.innerText?.includes("Bring in your products")).sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!el) return null;
      const li = el.closest("li") || el;
      const a = li.querySelector("a");
      return { text: li.innerText, link: a?.getAttribute("href"), linkText: a?.innerText, done: /done|complete|✓/i.test(li.getAttribute("aria-label") || "") || Boolean(li.querySelector('[aria-label*="Done" i], [data-done="true"]')) };
    });
    drill.check(step?.text.includes("Bring in your products"), 'D7: the setup step "Bring in your products"', step);
    drill.check(step?.text.includes("Bringing in your products from Shopify: 240 products so far"), 'D7: it reads "Bringing in your products from Shopify: 240 products so far"', step?.text);
    drill.check(step && !step.done, "D7: the step is not done", step);
    await drill.shoot(page, "D7-setup");
    if (step?.link) {
      await page.locator(`a[href="${step.link}"]`).first().click();
      await page.waitForURL(/\/admin\/settings/, { timeout: 30_000 }).catch(() => {});
      await settle(page);
      await page.waitForTimeout(1500);
      const pos = await page.evaluate(() => {
        const el = document.getElementById("catalog-sync");
        const r = el?.getBoundingClientRect();
        return { url: location.pathname + location.hash, top: r?.top, vh: window.innerHeight };
      });
      drill.check(pos.url === "/admin/settings#catalog-sync", "D7: its link opens /admin/settings#catalog-sync", pos);
      drill.check(pos.top != null && pos.top >= -5 && pos.top < pos.vh / 2, "D7: and lands on the card", pos);
      await drill.shoot(page, "D7-link-lands-on-card");
    } else drill.check(false, "D7: the step has a link", step);

    // ---- D10 ----
    await sql("tenant", "DELETE FROM sync_runs");
    const c = await openDash(drill, page);
    drill.check(c?.text.includes("Your products aren't in yet"), `D10: "Your products aren't in yet"`, c?.text);
    drill.check(c?.text.includes("Storeasy isn't linked to your Shopify store yet. Contact support to link it."), `D10: "Storeasy isn't linked to your Shopify store yet. Contact support to link it."`, c?.text);
    drill.check(c && c.buttons.length === 0, "D10: no button", c?.buttons);
    await drill.shoot(page, "D10-no-link-no-products");
    await ctx.close();
  },

  async refresh(drill) {
    // ---- D11 ----
    const n = await rows("tenant", "SELECT count(*) AS n FROM products");
    drill.check(Number(n[0].n) === 8, "D11 setup: freshly re-seeded harness (8 products)", n[0].n);
    await sql("tenant", [
      "DELETE FROM sync_runs",
      "INSERT INTO sync_runs (id,status,phase,started_at,finished_at,products,collections) VALUES ('sync_old','complete','done',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),8,3)",
      `INSERT INTO sync_runs (id,status,phase,started_at,updated_at,products_fetched,error,source,started_by) VALUES ('sync_new','failed','collections',${NOW},${NOW},8,'Admin GraphQL HTTP 503','admin','scheduled')`,
    ]);
    const ctx = await drill.context({ width: 1440 });
    const page = await drill.signIn(ctx);
    let c = await openDash(drill, page);
    drill.check(c?.text.includes("The latest refresh from Shopify didn't finish"), `D11: "The latest refresh from Shopify didn't finish"`, c?.text);
    const tone = await bannerTone(page, "Shopify didn't answer");
    drill.check(tone?.tone === "warning", "D11: an AMBER banner (warning), not red", tone);
    drill.check(c?.text.includes("Your store keeps everything it had, plus what came in."), 'D11: "Your store keeps everything it had, plus what came in."', c?.text);
    drill.check(c?.buttons.includes("Try again"), "D11: Try again", c?.buttons);
    drill.check(!/503|GraphQL/.test(c?.text || ""), "D11: nothing raw (no 503, GraphQL)", c?.text);
    await drill.shoot(page, "D11-refresh-failed-amber");

    // ---- D12 ----
    await sql("tenant", "UPDATE sync_runs SET status='running', error=NULL, phase='products', products_total=8, lease_owner='drill', lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 minutes') WHERE id='sync_new'");
    await drill.open(page, "/admin/dashboard", { width: 1440 });
    await page.waitForTimeout(1500);
    c = await card(page);
    drill.check(!c, "D12: /admin/dashboard shows no sync card while a refresh runs", c?.text);
    await drill.shoot(page, "D12-dashboard-no-card");
    await drill.open(page, "/admin/settings", { width: 1440 });
    await page.evaluate(() => document.getElementById("catalog-sync")?.scrollIntoView());
    c = await card(page);
    drill.check(c?.text.includes("Refreshing your products from Shopify"), 'D12: /admin/settings shows "Refreshing your products from Shopify"', c?.text);
    await drill.shoot(page, "D12-settings-refreshing");
    await sql("tenant", "DELETE FROM sync_runs");
    await ctx.close();
  },
};
