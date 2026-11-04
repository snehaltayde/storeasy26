// P3-DRILLS cross-item matrix: phase 3 end to end, in desktop Chrome on the
// design harness, on the phase 3 seed (node scripts/seed-design-documents.js
// --p3). Each part re-seeds fresh first, so no part sees another's changes.
// Every part counts real clicks (one counter per browser context) and takes
// screenshots into docs/cms-reviews/drills/P3-DRILLS/.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/matrix.mjs [part,part…] [--headed]
//
// Parts:
//   task1         timed founder task 1: change the hero title and button text,
//                 checked live at phone width
//   task4         timed founder task 4: fix a typo on a policy page, starting
//                 from the live page, with a half-finished home draft kept back
//   task5         timed founder task 5: Undo, once from the same document and
//                 once from Publishing (another document); the next Publish
//                 doesn't re-ship it
//   closed        the closed store: Opening soon, forms and checkout refused,
//                 the RSC probe on every route P3-CLOSED lists, a COD test
//                 order with a preview session (cancelled at once; card and
//                 UPI refused), then the first open (the home page goes too)
//   publish-both  the publish checks: a page linking to an unpublished
//                 campaign gets "Publish both", with the campaign's changes
//                 shown before Confirm
//   offline       take a page offline (its linkers shown), the offline line in
//                 the preview, then "Publish it again"
//   keep-live     PUB-09: "Keep the live version" of one section, publish the rest
//   conflict      two tabs: "Keep mine", then "Use the newer version"
//   keepalive     tab closed within the pause (the keepalive save), then a
//                 save that never arrived and the backup offer on the next open
//   pv01          the preview failure matrix: revoked, expired, exit, network;
//                 See the live store then reconnect
//   session       logout ends the preview, the Designer redirect, staff
//                 Publish disabled
//   design        the design from the editor's page list: a colour, publish,
//                 the live store's look changes, Undo
//   error-chrome  a missing chrome version gives the error page
// Results: docs/cms-reviews/drills/P3-DRILLS/results-<part>.json.
import { fileURLToPath } from "node:url";
import { bodyText, docsApi, noThanks, readSeed, reseed, runDrill, settle, storeSql, storeUrl, DrillError } from "./lib.mjs";

export const TEST_ORDER_EMAIL = "snehal@mediastic.in";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- small helpers ----------

export async function waitFor(fn, ms = 30_000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(step);
  }
  return false;
}
const previewLabel = (page) => page.locator("[data-preview-pane]").first().getAttribute("data-preview-label").catch(() => null);
const saveStatus = (page) => page.locator("[data-save-status]").first().getAttribute("data-save-status").catch(() => null);
const waitLabel = (page, label, ms = 60_000) => waitFor(async () => (await previewLabel(page)) === label, ms);
const waitSaved = (page, ms = 20_000) => waitFor(async () => (await saveStatus(page)) === "saved", ms);
const frame = (page) => page.frameLocator("[data-preview-frame]");
const frameText = (page) => page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.body?.innerText || "").catch(() => "");
const phaseOf = (page) => page.locator("[data-publish][data-phase]").first().getAttribute("data-phase").catch(() => null);
const waitPhase = (page, phases, ms = 30_000) => waitFor(async () => ((p) => (phases.includes(p) ? p : false))(await phaseOf(page)), ms);
const panelText = (page) => page.locator("[data-publish]").first().innerText().catch(() => "");
const where = (page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};

async function getDoc(page, id) {
  const r = await docsApi(page, { getDocument: id });
  if (r.status !== 200) throw new DrillError(`getDocument ${id} answered ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.document;
}
async function saveAndPublish(page, id, mutate) {
  const d = await getDoc(page, id);
  const saved = await docsApi(page, { saveDraft: { id, body: mutate(structuredClone(d.body)) }, revision: d.revision });
  if (saved.status !== 200) throw new DrillError(`saveDraft ${id} answered ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
  const s = saved.body.document;
  const pub = await docsApi(page, { publish: { id, draftHash: s.draftHash }, revision: s.revision });
  if (pub.status !== 200) throw new DrillError(`publish ${id} answered ${pub.status}: ${JSON.stringify(pub.body).slice(0, 300)}`);
  return pub.body;
}
async function saveOnly(page, id, mutate) {
  const d = await getDoc(page, id);
  const saved = await docsApi(page, { saveDraft: { id, body: mutate(structuredClone(d.body)) }, revision: d.revision });
  if (saved.status !== 200) throw new DrillError(`saveDraft ${id} answered ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
  return saved.body.document;
}

async function openEditor(page, query = "") {
  await page.goto(`/admin/editor${query}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 90_000 });
}

// The seeded hero runs an experiment, so a shopper may see either title. The
// tasks pause it (local harness database only) so "live" means the document.
async function pauseTests(drill) {
  const [r] = await storeSql("tenant", ["SELECT slug FROM experiments WHERE status = 'running'"]);
  for (const { slug } of r.rows) await storeSql("tenant", [{ sql: "UPDATE experiments SET status = 'paused' WHERE slug = ?", args: [slug] }]);
  if (r.rows.length) drill.note(`hero tests paused for this part: ${r.rows.map((x) => x.slug).join(", ")}`);
}

// What a shopper sees: a fresh browser context with no cookies, reloaded
// until ok(view) or the time runs out (the storefront caches for a moment).
export async function shopper(drill, path, ok = () => true, { store = "live", width = 1440, timeoutMs = 25_000, keep = false } = {}) {
  const ctx = await drill.context({ width });
  const page = await ctx.newPage();
  const until = Date.now() + timeoutMs;
  let view = null;
  for (;;) {
    const res = await page.goto(storeUrl(drill, store, path), { waitUntil: "load", timeout: 120_000 }).catch(() => null);
    await noThanks(page);
    view = { status: res?.status() ?? 0, text: await bodyText(page), html: await page.content(), errorPage: false };
    view.errorPage = /Something went wrong|This page couldn.t load|Application error/i.test(view.text);
    if (ok(view) || Date.now() > until) break;
    await sleep(800);
  }
  view.ok = Boolean(ok(view));
  if (keep) return { ...view, page, ctx };
  await ctx.close();
  return view;
}

// Publish from the editor: Publish, wait for the review, press Publish.
async function publishFromEditor(page, clicks) {
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  await waitPhase(page, ["review", "offer", "blocked", "noHome", "republish", "refused", "conflict"], 20_000);
  if ((await phaseOf(page)) !== "review") return phaseOf(page);
  await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
  await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  return waitPhase(page, ["done", "blocked", "refused", "conflict", "checked", "failed"], 30_000);
}

async function undoFromPanel(page) {
  await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).first().click();
  await waitFor(async () => (await page.locator("[data-publish] [data-undo]").innerText()).includes("Undo this publish?"), 20_000);
  const confirm = await page.locator("[data-publish] [data-undo]").innerText().catch(() => "");
  await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).last().click();
  await waitFor(async () => (await page.locator("[data-publish] [data-undo] [role=status]").count()) > 0, 30_000);
  return { confirm, result: await page.locator("[data-publish] [data-undo] [role=status]").innerText().catch(() => "") };
}

// A task's time and clicks, from the moment it is "read out".
function timer(clicks) {
  const t0 = Date.now();
  const m = clicks.mark();
  return () => ({ seconds: Math.round((Date.now() - t0) / 100) / 10, clicks: clicks.since(m), path: clicks.clicks.slice(m).map((c) => `${c.tag}:${c.text}`.slice(0, 50)) });
}

// ---------- the parts ----------

export const parts = {};

// Founder task 1 (section 10): change the hero title and button text; done
// when the new text is live, checked at phone width. Target: under 60 s, at
// most 4 clicks plus typing.
parts.task1 = async (drill) => {
  await reseed(drill);
  await pauseTests(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  await openEditor(page);
  await waitLabel(page, "Up to date", 90_000);
  const title = `Glow that lasts ${Date.now() % 10000}`;
  const button = "Shop the glow";
  const done = timer(clicks);
  // 1: the hero's title in the preview (selects the hero, focuses its title field)
  await frame(page).locator('[data-section-id="sec_hero"] [data-field="title"]').first().click({ timeout: 15_000 });
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.id)) === "f-sec_hero-title", 8000);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(title);
  // 2: the button text field
  await page.locator("#f-sec_hero-primary-label").click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(button);
  await waitSaved(page);
  // 3 and 4: Publish, then Publish in the review
  const phase = await publishFromEditor(page, clicks);
  await drill.screenshot(page, "task1-published-1440");
  const live = await shopper(drill, "/", (v) => v.text.includes(title) && v.text.includes(button), { width: 375, keep: true });
  const t = done();
  await drill.screenshot(live.page, "task1-live-375");
  await live.ctx.close();
  drill.check(phase === "done" && live.ok, "task 1: the new hero title and button text are live, checked at phone width (375)", { phase, title, button });
  drill.check(t.clicks <= 4, `task 1: ${t.clicks} clicks plus typing (target at most 4)`, t);
  drill.check(t.seconds < 60, `task 1: ${t.seconds} s from start to live (target under 60 s; a drill types faster than a person)`, t);
  drill.note(`task 1 timing: ${JSON.stringify(t)}`);
  await ctx.close();
};

// Founder task 4: fix a typo on a policy page, starting from the live page;
// done when the fix is live and a half-finished home draft is not.
parts.task4 = async (drill) => {
  await reseed(drill);
  await pauseTests(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const list = (await docsApi(page, { listDocuments: true })).body.documents;
  const pol = list.find((d) => d.slug === "shipping");
  if (!pol) throw new DrillError("the seed has no shipping policy page");
  const TYPO = "Orders dispatch withn 24 hours on business days.";
  const FIXED = "Orders dispatch within 24 hours on business days.";
  const HALF = "Half-finished home banner, not for shoppers";
  // the set-up: the policy is live with a typo; the home page has a half-finished draft
  await saveAndPublish(page, pol.id, (b) => {
    const s = b.sections.find((x) => x.kind === "text");
    s.settings.body = [TYPO];
    return b;
  });
  await saveOnly(page, "doc_home", (b) => {
    b.sections.splice(2, 0, { id: "sec_drillhalf", kind: "banner", v: 1, enabled: true, settings: { title: HALF, text: "", button: null } });
    return b;
  });
  const before = await shopper(drill, "/policies/shipping", (v) => v.text.includes(TYPO));
  drill.check(before.ok, "task 4 set-up: the live shipping policy shows the typo", { status: before.status });

  // start on the live page, signed in to the console (no preview)
  await page.goto("/api/preview?exit=1&to=%2Fpolicies%2Fshipping", { waitUntil: "load" });
  await settle(page);
  await noThanks(page);
  const done = timer(clicks);
  // next dev's own indicator sits in the same corner as "Edit this page" and
  // takes the click; it does not exist in a production build
  await page.addStyleTag({ content: "nextjs-portal{display:none!important;pointer-events:none!important}" });
  const editLink = page.locator("[data-edit-this-page]");
  drill.check((await editLink.count()) === 1, "task 4: the live page shows 'Edit this page' to the signed-in founder", { at: where(page) });
  await drill.screenshot(page, "task4-live-page-1440");
  // 1: Edit this page
  await editLink.click();
  await page.waitForURL(/\/admin\/editor/, { timeout: 60_000 });
  await page.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 90_000 });
  await waitLabel(page, "Up to date", 90_000);
  const opened = await page.locator("[data-document-editor]").getAttribute("data-doc");
  // 2: the typo in the preview (selects the text section, focuses the paragraph)
  const sec = (await getDoc(page, pol.id)).body.sections.find((x) => x.kind === "text");
  await frame(page).locator(`[data-section-id="${sec.id}"] [data-field="body.0"]`).first().click({ timeout: 15_000 });
  const focused = await waitFor(async () => ((id) => (id && id.startsWith(`f-${sec.id}-body`) ? id : false))(await page.evaluate(() => document.activeElement?.id)), 8000);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(FIXED);
  await waitSaved(page);
  // 3 and 4: Publish, Publish
  const phase = await publishFromEditor(page, clicks);
  const review = await panelText(page);
  await drill.screenshot(page, "task4-published-1440");
  const live = await shopper(drill, "/policies/shipping", (v) => v.text.includes(FIXED), { width: 375, keep: true });
  const t = done();
  await drill.screenshot(live.page, "task4-live-375");
  await live.ctx.close();
  const home = await shopper(drill, "/", () => true);
  const homeDoc = await getDoc(page, "doc_home");
  drill.check(opened === pol.id && Boolean(focused), "task 4: 'Edit this page' opens the policy in the editor, and a click on the typo focuses its paragraph", { opened, want: pol.id, focused });
  drill.check(phase === "done" && live.ok && !live.text.includes(TYPO), "task 4: the fix is live", { phase });
  drill.check(!home.text.includes(HALF) && homeDoc.body.sections.some((s) => s.id === "sec_drillhalf") && homeDoc.draftHash !== homeDoc.publishedHash, "task 4: the half-finished home draft is not live (it stays a draft)", { homeLive: !home.text.includes(HALF) });
  drill.check(t.clicks <= 4, `task 4: ${t.clicks} clicks plus typing (target at most 4)`, t);
  drill.check(t.seconds < 60, `task 4: ${t.seconds} s from the live page to the fix live (target under 60 s)`, t);
  drill.note(`task 4 timing: ${JSON.stringify(t)}; panel: ${review.slice(0, 200)}`);
  await ctx.close();
};

// Founder task 5: Undo the last change, once from the same document and once
// starting from a different one; done when the previous version is live and
// the next Publish does not re-ship it.
parts.task5 = async (drill) => {
  await reseed(drill);
  await pauseTests(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const OLD = "Skin first. Makeup second.";
  const NEW = `Undo me ${Date.now() % 10000}`;

  // (a) the same document: publish a hero change in the editor, then Undo it there
  await openEditor(page);
  await waitLabel(page, "Up to date", 90_000);
  await page.locator('[data-section-row="sec_hero"] button').first().click();
  await page.locator("#f-sec_hero-title").fill(NEW);
  await waitSaved(page);
  const phase = await publishFromEditor(page, clicks);
  const pub = await shopper(drill, "/", (v) => v.text.includes(NEW));
  drill.check(phase === "done" && pub.ok, "task 5 set-up: a hero change is live", { phase });
  const doneA = timer(clicks);
  const u = await undoFromPanel(page);
  const backA = await shopper(drill, "/", (v) => v.text.includes(OLD) && !v.text.includes(NEW));
  const tA = doneA();
  await drill.screenshot(page, "task5-undone-same-document-1440");
  const afterA = await getDoc(page, "doc_home");
  const heroA = afterA.body.sections.find((s) => s.id === "sec_hero")?.settings?.title;
  drill.check(backA.ok && /title changed/i.test(u.confirm), "task 5 (same document): Undo says what will change, and the previous hero is live again", { confirm: u.confirm.slice(0, 200), result: u.result.slice(0, 200) });
  // the next Publish doesn't re-ship it: the draft is the restored version
  await page.locator("[data-publish] button", { hasText: /^Close$/ }).first().click().catch(() => {});
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  await waitPhase(page, ["review"], 20_000);
  await waitFor(async () => !(await panelText(page)).includes("Finding what changed"), 20_000);
  const nextReview = await panelText(page);
  drill.check(heroA === OLD && /Nothing has changed since the last publish/.test(nextReview), "task 5 (same document): the next Publish has nothing to ship (the undone title is not in the draft)", { heroDraft: heroA, review: nextReview.slice(0, 200) });
  await page.locator("[data-publish] button", { hasText: /^Cancel$/ }).first().click().catch(() => {});
  drill.check(tA.clicks <= 2 && tA.seconds < 60, `task 5 (same document): ${tA.clicks} clicks, ${tA.seconds} s (target under 60 s)`, tA);

  // (b) a different document: the size guide's title is published elsewhere;
  // the founder is on the home page and doesn't remember what changed
  const size = readSeed().publishSet.members.find((m) => m.slug === "size-guide");
  const SIZE_NEW = "Size guide, changed last";
  const sizeBefore = await getDoc(page, size.id);
  const oldTitle = sizeBefore.body.sections[0]?.settings?.title;
  await saveAndPublish(page, size.id, (b) => {
    b.sections[0].settings.title = SIZE_NEW;
    return b;
  });
  const sizeLive = await shopper(drill, size.path, (v) => v.text.includes(SIZE_NEW));
  drill.check(sizeLive.ok, "task 5 set-up: a change to another page (the size guide) is live", null);
  await openEditor(page);
  const doneB = timer(clicks);
  // 1: Publishing in the console nav
  await page.locator('aside nav[aria-label="Console"] a[href="/admin/releases"]').click();
  await page.waitForURL(/\/admin\/releases/, { timeout: 30_000 });
  await page.waitForSelector("[data-recently-published] [data-row]", { timeout: 60_000 });
  const firstRow = page.locator("[data-recently-published] [data-row]").first();
  const rowText = await firstRow.innerText();
  // 2: its Undo, 3: the confirm's Undo
  await firstRow.locator("[data-undo] button", { hasText: /^Undo$/ }).first().click();
  await waitFor(async () => (await firstRow.innerText()).includes("Undo this publish?"), 20_000);
  const confirmB = await firstRow.innerText();
  await drill.screenshot(page, "task5-recently-published-confirm-1440");
  await firstRow.locator("[data-undo] button", { hasText: /^Undo$/ }).last().click();
  await waitFor(async () => (await firstRow.locator("[data-undo] [role=status]").count()) > 0, 30_000);
  const backB = await shopper(drill, size.path, (v) => !v.text.includes(SIZE_NEW) && (!oldTitle || v.text.includes(oldTitle)));
  const tB = doneB();
  await drill.screenshot(page, "task5-undone-from-publishing-1440");
  const ch = await docsApi(page, { listChanges: size.id });
  const sizeAfter = await getDoc(page, size.id);
  drill.check(/Size Guide/.test(rowText) && /title/i.test(confirmB) && backB.ok, "task 5 (another document): the top row of Recently published names the page; Undo says what changes, and the previous version is live", { row: rowText.slice(0, 200), confirm: confirmB.slice(0, 300) });
  drill.check(ch.status === 200 && (ch.body?.rows || []).length === 0 && sizeAfter.body.sections[0]?.settings?.title !== SIZE_NEW, "task 5 (another document): the next Publish of that page has nothing to ship", { rows: ch.body?.rows });
  drill.check(tB.clicks <= 3 && tB.seconds < 60, `task 5 (another document): ${tB.clicks} clicks, ${tB.seconds} s (target under 60 s)`, tB);
  drill.note(`task 5 timing: same document ${JSON.stringify(tA)}; another document ${JSON.stringify(tB)}`);
  await ctx.close();
};

// The closed store (PUB-06).
const CLOSED_STRINGS = ["Closed draft: not for shoppers yet", "Drafts never reach shoppers before the first publish.", "About the closed store", "This page is a draft."];
const RSC_ROUTES = ["/", "/contact", "/about", "/policies/about", "/campaigns/spring", "/journal", "/journal/first-post", "/collections"];

parts.closed = async (drill) => {
  const { seed } = await reseed(drill);
  const closed = seed.stores.closed;
  // the closed store has no catalog: copy one product (and its variants) from
  // the design store, local harness databases only, so a test order can be placed
  const [prod] = await storeSql("tenant", ["SELECT * FROM products WHERE available = 1 AND handle NOT LIKE 'worst-case-%' ORDER BY handle LIMIT 1"]);
  const p = prod.rows[0];
  const [vars] = await storeSql("tenant", [{ sql: "SELECT * FROM variants WHERE product_id = ? AND available = 1", args: [p.id] }]);
  const ins = (table, row) => ({ sql: `INSERT OR REPLACE INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`, args: Object.values(row) });
  await storeSql("closed", [ins("products", { ...p }), ...vars.rows.map((v) => ins("variants", { ...v }))]);
  drill.note(`copied product ${p.handle} (${vars.rows.length} variants) into the closed store's database for the test order`);

  // ---- a shopper ----
  const anon = await drill.context({ width: 1440 });
  await drill.clickCounter(anon);
  const ap = await anon.newPage();
  const home = await ap.goto(storeUrl(drill, "closed", "/"), { waitUntil: "load", timeout: 120_000 });
  const homeText = await bodyText(ap);
  drill.check(home?.status() === 200 && /Opening soon/.test(homeText) && !CLOSED_STRINGS.some((s) => homeText.includes(s)), "closed: a shopper sees 'Opening soon' and no draft", { status: home?.status(), text: homeText.slice(0, 160) });
  await drill.screenshot(ap, "closed-opening-soon-1440");
  const post = (path, body) => ap.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { path, body });
  const contact = await post("/api/contact", { name: "Drill", email: TEST_ORDER_EMAIL, message: "hello" });
  const cod = await post("/api/checkout", { action: "cod", idempotencyKey: `drill-${Date.now()}` });
  drill.check(contact.status === 403 && contact.body?.code === "STORE_CLOSED" && cod.status === 403 && cod.body?.code === "STORE_CLOSED", "closed: a shopper's contact form and checkout are refused (403 STORE_CLOSED)", { contact: contact.status, checkout: cod.status, words: cod.body?.error });

  // ---- the RSC probe (P3-CLOSED's routes, with and without forged console cookies) ----
  const tree = (seg) => JSON.stringify(["", { children: ["(storefront)", { children: [seg, { children: ["__PAGE__", {}] }] }] }]);
  const results = [];
  for (const cookie of [null, "_admin", "_platform", "_mx"]) {
    await anon.clearCookies();
    if (cookie) await anon.addCookies([{ name: cookie, value: "x", domain: closed.host, path: "/" }]);
    for (const path of RSC_ROUTES) {
      for (const kind of ["html", "rsc"]) {
        const r = await ap.evaluate(
          async ({ path, kind, tree }) => {
            const headers = kind === "rsc" ? { RSC: "1", "Next-Router-State-Tree": encodeURIComponent(tree), "Next-Url": "/collections" } : {};
            const res = await fetch(path, { headers, credentials: "include", redirect: "manual" });
            return { status: res.status, type: res.headers.get("content-type"), text: await res.text() };
          },
          { path, kind, tree: tree("collections") },
        );
        results.push({ path, kind, cookie: cookie || "none", status: r.status, type: (r.type || "").split(";")[0], leaks: CLOSED_STRINGS.filter((s) => r.text.includes(s)) });
      }
    }
  }
  await anon.clearCookies();
  const leaked = results.filter((r) => r.leaks.length);
  drill.check(results.length === 64 && leaked.length === 0 && results.filter((r) => r.kind === "rsc").every((r) => r.type === "text/x-component"), `closed: the RSC probe, ${results.length} requests (8 routes × 4 cookie sets × page and RSC), finds no draft text`, { leaked, statuses: [...new Set(results.map((r) => r.status))] });
  drill.note(`RSC probe: ${JSON.stringify(results.map((r) => `${r.kind} ${r.path} [${r.cookie}] ${r.status}`))}`);

  // ---- the founder: a preview session, then a COD test order ----
  const fctx = await drill.context({ width: 1440 });
  const fclicks = await drill.clickCounter(fctx);
  const fp = await drill.login("owner", { context: fctx, store: "closed" });
  const ps = await fp.evaluate(async () => {
    const r = await fetch("/api/admin/preview-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ create: true }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  if (ps.status !== 200) throw new DrillError(`no preview session on the closed store (${ps.status})`);
  // the context's base address is the live store's: give the closed store's host
  await fp.goto(new URL(ps.body.previewUrl, storeUrl(drill, "closed", "/")).href, { waitUntil: "load" });
  await settle(fp);
  await noThanks(fp);
  drill.check((await bodyText(fp)).includes(closed.draftTitle) && fp.url().startsWith(storeUrl(drill, "closed", "/")), "closed: the founder's preview shows the home draft", { at: fp.url() });
  await drill.screenshot(fp, "closed-founder-preview-1440");
  const m = fclicks.mark();
  await fp.goto(storeUrl(drill, "closed", `/products/${p.handle}`), { waitUntil: "load", timeout: 120_000 });
  await settle(fp);
  await noThanks(fp);
  await fp.getByRole("button", { name: "Add to cart" }).first().click({ timeout: 15_000 });
  await waitFor(async () => {
    const c = await fp.evaluate(async () => (await fetch("/api/cart")).json());
    return (c?.items || c?.cart?.items || []).length > 0;
  }, 15_000);
  await fp.goto(storeUrl(drill, "closed", "/checkout"), { waitUntil: "load", timeout: 120_000 });
  await settle(fp);
  const fill = { email: TEST_ORDER_EMAIL, phone: "9999999999", name: "P3 Drill Test Order", line1: "1 Test Street", city: "Mumbai", state: "Maharashtra", pincode: "400001" };
  for (const [k, v] of Object.entries(fill)) await fp.locator(`input[name="${k}"]`).fill(v);
  await fp.getByRole("button", { name: "Continue to review" }).click();
  await fp.getByRole("button", { name: "Continue to payment" }).click();
  const codRadio = fp.locator('input[type="radio"][name="method"]').first();
  if (!(await codRadio.isChecked())) await codRadio.check();
  await drill.screenshot(fp, "closed-preview-checkout-cod-1440");
  // card and UPI: refused before anything reaches a payment provider
  const card = await fp.evaluate(async (fill) => {
    const r = await fetch("/api/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "razorpay_create", contact: { email: fill.email, phone: fill.phone, name: fill.name }, address: { line1: fill.line1, city: fill.city, state: fill.state, pincode: fill.pincode }, idempotencyKey: `drill-card-${Date.now()}` }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, fill);
  drill.check(card.status === 403 && card.body?.code === "STORE_CLOSED" && /cash on delivery/i.test(card.body?.error || ""), "closed: in the preview, a card or UPI payment is refused with the COD-only words", { status: card.status, words: card.body?.error });
  await fp.getByRole("button", { name: /^Place order/ }).click();
  await fp.waitForURL(/\/checkout\/confirmation/, { timeout: 60_000 }).catch(() => {});
  await settle(fp);
  const confirmText = await bodyText(fp);
  await drill.screenshot(fp, "closed-preview-order-confirmation-1440");
  const [orders] = await storeSql("closed", [{ sql: "SELECT id, status, payment_status, email FROM orders ORDER BY created_at DESC", args: [] }]).catch(async () => storeSql("closed", ["SELECT id, status, payment_status FROM orders"]));
  const order = orders.rows[0];
  drill.check(Boolean(order) && orders.rows.length === 1 && /\/checkout\/confirmation/.test(fp.url()), "closed: the founder places a cash on delivery test order through the real checkout, in the preview", { order, clicks: fclicks.since(m), at: where(fp), confirm: confirmText.slice(0, 120) });
  // cancelled at once (the test-order rule)
  let cancelled = null;
  if (order) {
    const adm = await fctx.newPage();
    await adm.goto(storeUrl(drill, "closed", "/admin/dashboard"), { waitUntil: "load" });
    cancelled = await adm.evaluate(async (id) => {
      const r = await fetch(`/api/admin/orders/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel", reason: "P3-DRILLS test order on the closed store" }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, order.id);
    await adm.close();
  }
  const [after] = await storeSql("closed", [{ sql: "SELECT id, status FROM orders WHERE id = ?", args: [order?.id ?? ""] }]);
  drill.check(cancelled?.status === 200 && after.rows[0]?.status === "cancelled", "closed: the test order is cancelled at once", { cancel: cancelled, row: after.rows[0] });
  drill.note(`test order ${order?.id} (${TEST_ORDER_EMAIL}) placed and cancelled: ${JSON.stringify(after.rows[0])}`);

  // ---- the first open: a page alone needs the home page too ----
  const about = closed.drafts.find((id) => id !== "doc_home");
  await fp.goto(storeUrl(drill, "closed", `/admin/editor?doc=${about}`), { waitUntil: "load", timeout: 120_000 });
  await fp.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 90_000 });
  const closedLine = await fp.locator("[data-closed-store]").innerText().catch(() => "");
  const m2 = fclicks.mark();
  await fp.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  let ph = await waitPhase(fp, ["offer", "noHome", "review", "blocked"], 30_000);
  let firstReview = "";
  if (ph === "review") {
    await waitFor(async () => (await fp.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
    firstReview = await panelText(fp);
    await fp.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
    ph = await waitPhase(fp, ["offer", "noHome", "blocked", "done", "refused"], 30_000);
  }
  // "Publish with the home page" waits until both lists have loaded
  const sawWaiting = await fp.locator("[data-publish]").innerText().then((t) => t.includes("You can publish once every list below has loaded")).catch(() => false);
  await waitFor(async () => (await fp.locator('[data-publish][data-phase="offer"] button:not([disabled])', { hasText: "Publish with the home page" }).count()) > 0, 20_000);
  const offer = await panelText(fp);
  const lists = await fp.locator("[data-publish] [data-change-list]").count();
  await drill.screenshot(fp, "closed-first-open-offer-1440");
  drill.check(/Your store isn.t open yet/.test(closedLine) && ph === "offer" && /Your store opens with its home page/.test(offer) && /Home page/.test(offer) && lists === 2, "closed: publishing a page first (FIRST_PUBLISH_NEEDS_HOME) offers to publish it with the home page, both lists shown before Confirm", { phase: ph, lists, sawWaiting, review: firstReview.slice(0, 200), offer: offer.slice(0, 400) });
  await fp.locator("[data-publish] button", { hasText: "Publish with the home page" }).click();
  const ph2 = await waitPhase(fp, ["done", "blocked", "refused"], 30_000);
  await drill.screenshot(fp, "closed-first-open-done-1440");
  const opened = await shopper(drill, "/", (v) => v.text.includes(closed.draftTitle), { store: "closed", keep: true });
  await drill.screenshot(opened.page, "closed-store-open-1440");
  await opened.ctx.close();
  drill.check(ph2 === "done" && opened.ok && !/Opening soon/.test(opened.text), "closed: after that publish the store is open: a shopper sees the home page", { phase: ph2, clicks: fclicks.since(m2) });
  // the probe's control: the same RSC request now finds the (published) hero
  const control = await ap.evaluate(async (tree) => (await fetch("/", { headers: { RSC: "1", "Next-Router-State-Tree": encodeURIComponent(tree), "Next-Url": "/collections" } })).text(), tree("collections"));
  drill.check(control.includes(closed.draftTitle), "closed: control: once the store is open, the same RSC request does carry the home page's words (the probe can see content)", null);
  await fctx.close();
  await anon.close();
};

// PUB-03, PUB-05: a page whose draft links to an unpublished campaign.
parts["publish-both"] = async (drill) => {
  const { seed } = await reseed(drill);
  const guide = seed.documents.guide;
  const camp = seed.documents.unpublishedCampaign;
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  await openEditor(page, `?doc=${guide.id}`);
  await waitLabel(page, "Up to date", 90_000);
  const m = clicks.mark();
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  const ph = await waitPhase(page, ["review", "offer", "blocked"], 20_000);
  if (ph === "review") {
    await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
    await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  }
  const offerPhase = await waitPhase(page, ["offer", "blocked", "done"], 30_000);
  // Confirm stays off until every list (the campaign's too) has loaded
  const early = await page.evaluate(() => {
    const p = document.querySelector('[data-publish][data-phase="offer"]');
    const b = p && [...p.querySelectorAll("button")].find((x) => /^Publish both$/.test(x.textContent.trim()));
    return { waiting: p ? p.innerText.includes("You can publish once every list below has loaded") : null, disabled: b ? b.disabled : null };
  });
  await waitFor(async () => (await page.locator('[data-publish][data-phase="offer"] button:not([disabled])', { hasText: /^Publish both$/ }).count()) > 0, 20_000);
  const offer = await panelText(page);
  const lists = await page.locator("[data-publish] [data-change-list]").allInnerTexts();
  await drill.screenshot(page, "publish-both-offer-1440");
  drill.check(offerPhase === "offer" && /Shoppers would reach a page that isn.t live/.test(offer) && offer.includes(camp.label) && offer.includes(guide.label), "checks: the link to the unpublished campaign is caught, and Publish offers to publish both", { phase: offerPhase, offer: offer.slice(0, 500) });
  drill.check(lists.length === 2 && lists.some((t) => t.includes(camp.label) && /goes live for the first time/.test(t)) && lists.every((t) => !/Finding what changed/.test(t)), "publish both: the campaign's own changes are shown before Confirm", { lists, early });
  if (early.waiting) drill.check(early.disabled === true, "publish both: while a list is still loading, Confirm is off", early);
  await page.locator("[data-publish] button", { hasText: /^Publish both$/ }).click();
  const ph2 = await waitPhase(page, ["done", "blocked", "refused"], 30_000);
  const done = await panelText(page);
  await drill.screenshot(page, "publish-both-done-1440");
  // the guide's live version now holds the banner and its link to the campaign
  // (document_refs names the campaign). A page route still renders only text,
  // rich text, image and FAQ sections (P2-SECTIONS known limit), so the
  // banner itself doesn't show on /policies/<slug>; the campaign's own page does.
  const [gv] = await storeSql("tenant", [{ sql: "SELECT v.id, v.body FROM documents d JOIN document_versions v ON v.id = d.published_version_id WHERE d.id = ?", args: [guide.id] }]);
  const liveBody = JSON.parse(String(gv.rows[0]?.body || "null"));
  const liveBanner = liveBody?.sections?.find((x) => x.kind === "banner") || null;
  const [refs] = await storeSql("tenant", [{ sql: "SELECT ref_id FROM document_refs WHERE version_id = ? AND ref_type = 'document'", args: [gv.rows[0]?.id ?? ""] }]);
  const liveCamp = await shopper(drill, camp.path, (v) => v.status === 200 && /spring edit/i.test(v.text), { keep: true });
  await drill.screenshot(liveCamp.page, "publish-both-live-campaign-1440");
  await liveCamp.ctx.close();
  drill.check(ph2 === "done" && liveBanner?.settings?.button?.link?.slug === camp.slug && refs.rows.some((r) => r.ref_id === camp.id) && liveCamp.ok, "publish both: both are live: the guide's live version links to the campaign (its refs name it), and the campaign's page answers", { phase: ph2, campaign: liveCamp.status, refs: refs.rows.map((r) => r.ref_id), clicks: clicks.since(m), done: done.slice(0, 200) });
  await ctx.close();
};

// PUB-04: take offline, the offline line, publish again.
parts.offline = async (drill) => {
  const { seed } = await reseed(drill);
  const camp = seed.documents.liveCampaign;
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  await openEditor(page, `?doc=${camp.id}`);
  await waitLabel(page, "Up to date", 90_000);
  const m = clicks.mark();
  await page.getByRole("button", { name: "Take this page offline" }).click();
  const dialog = page.locator("[data-take-offline]");
  await dialog.waitFor({ timeout: 20_000 });
  const words = await page.getByRole("dialog").innerText();
  await drill.screenshot(page, "offline-confirm-linkers-1440");
  drill.check(/These live pages link to it/.test(words) && /Home page/.test(words), "offline: the confirm lists the live pages that link to it (the home page)", { words: words.slice(0, 400) });
  await page.getByRole("dialog").getByRole("button", { name: "Take it offline" }).click();
  await waitFor(async () => (await page.locator("[data-undo] [role=status]").count()) > 0, 30_000);
  const result = await page.locator("[data-undo] [role=status]").first().innerText().catch(() => "");
  const gone = await shopper(drill, camp.path, (v) => v.status === 404);
  drill.check(gone.ok && !gone.text.includes("This weekend only"), "offline: shoppers get 404 at the campaign's address", { status: gone.status, result: result.slice(0, 200), clicks: clicks.since(m) });
  // the preview of an offline page says so
  await openEditor(page, `?doc=${camp.id}`);
  const line = await waitFor(async () => {
    const t = await page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.querySelector('[data-preview-note="offline"]')?.innerText || "");
    return t || false;
  }, 60_000);
  drill.check(line === "This page is offline. Publishing it brings it back.", "offline: the preview's bar says 'This page is offline. Publishing it brings it back.'", { line });
  await drill.screenshot(page, "offline-preview-line-1440");
  // publish again
  const m2 = clicks.mark();
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  const ph = await waitPhase(page, ["review", "republish"], 20_000);
  if (ph === "review") {
    await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
    await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  }
  const ph2 = await waitPhase(page, ["republish", "done"], 30_000);
  const again = await panelText(page);
  await drill.screenshot(page, "offline-publish-again-confirm-1440");
  if (ph2 === "republish") await page.locator("[data-publish] button", { hasText: "Publish it again" }).click();
  const ph3 = await waitPhase(page, ["done"], 30_000);
  const back = await shopper(drill, camp.path, (v) => v.status === 200 && v.text.includes("This weekend only"));
  drill.check(ph2 === "republish" && /Publish it again\?/.test(again) && ph3 === "done" && back.ok, "offline: Publish asks 'Publish it again?', and after it the campaign is live again", { phases: [ph, ph2, ph3], words: again.slice(0, 200), clicks: clicks.since(m2) });
  await ctx.close();
};

// PUB-09: keep the live version of one section, publish the rest.
parts["keep-live"] = async (drill) => {
  await reseed(drill);
  await pauseTests(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const HERO = `Hero ships ${Date.now() % 10000}`;
  const HALF = "Half-done banner title";
  await openEditor(page);
  await waitLabel(page, "Up to date", 90_000);
  const bannerBefore = (await getDoc(page, "doc_home")).body.sections.find((s) => s.id === "sec_p3camp").settings.title;
  await page.locator('[data-section-row="sec_hero"] button').first().click();
  await page.locator("#f-sec_hero-title").fill(HERO);
  await waitSaved(page);
  await page.locator('[data-section-row="sec_p3camp"] button').first().click();
  await page.locator("#f-sec_p3camp-title").fill(HALF);
  await waitSaved(page);
  const m = clicks.mark();
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).first().click();
  await waitPhase(page, ["review"], 20_000);
  await waitFor(async () => !(await panelText(page)).includes("Finding what changed"), 20_000);
  const review = await panelText(page);
  await drill.screenshot(page, "keep-live-review-1440");
  const rows = page.locator('[data-publish][data-phase="review"] [data-change-list] li');
  const bannerRow = rows.filter({ hasText: /banner|This weekend/i }).first();
  const hasKeep = (await bannerRow.getByRole("button", { name: "Keep the live version" }).count()) === 1;
  drill.check(/Hero/.test(review) && hasKeep, "keep live: the review lists the hero and the banner changes, each with 'Keep the live version'", { review: review.slice(0, 500) });
  if (hasKeep) await bannerRow.getByRole("button", { name: "Keep the live version" }).click();
  await waitFor(async () => (await panelText(page)).includes("that section is back to how it is on your live store"), 20_000);
  const after = await panelText(page);
  drill.check(/that section is back to how it is on your live store/.test(after) && !/banner/i.test(after.replace(/that section.*store\./, "")) , "keep live: the banner is back to its live version and out of the list", { after: after.slice(0, 400) });
  await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
  await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  const ph = await waitPhase(page, ["done", "blocked"], 30_000);
  const live = await shopper(drill, "/", (v) => v.text.includes(HERO));
  const doc = await getDoc(page, "doc_home");
  drill.check(ph === "done" && live.ok && !live.text.includes(HALF) && live.text.includes(bannerBefore) && doc.body.sections.find((s) => s.id === "sec_p3camp").settings.title === bannerBefore, "keep live: the hero edit is live, the half-done banner is not (its draft is the live version again)", { phase: ph, clicks: clicks.since(m) });
  await drill.screenshot(page, "keep-live-published-1440");
  await ctx.close();
};

// ED-03: two tabs on one document, both choices.
parts.conflict = async (drill) => {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const a = await drill.login("owner", { context: ctx });
  await openEditor(a);
  const b = await ctx.newPage();
  await openEditor(b);
  const type = async (page, text) => {
    await page.locator('[data-section-row="sec_hero"] button').first().click();
    await page.locator("#f-sec_hero-title").fill(text);
  };
  for (const [choice, button] of [
    ["mine", "Keep mine"],
    ["newer", "Use the newer version"],
  ]) {
    const B = `Tab B ${choice} ${Date.now() % 10000}`;
    const A = `Tab A ${choice} ${Date.now() % 10000}`;
    await type(b, B);
    await waitSaved(b);
    await type(a, A);
    const c = await waitFor(async () => (await a.locator("[data-conflict]").count()) > 0, 20_000);
    const words = await a.locator("[data-status-line]").innerText().catch(() => "");
    drill.check(Boolean(c) && (await a.locator("#f-sec_hero-title").inputValue()) === A, `conflict (${button}): tab A's save after tab B's asks which to keep, with A's text still on screen`, { words: words.slice(0, 300) });
    await drill.screenshot(a, `conflict-${choice}-choice-1440`);
    const m = clicks.mark();
    await a.locator("[data-conflict]").getByRole("button", { name: button }).click();
    await waitSaved(a);
    await sleep(500);
    const d = await getDoc(a, "doc_home");
    const title = d.body.sections.find((s) => s.id === "sec_hero").settings.title;
    const shown = await a.locator("#f-sec_hero-title").inputValue();
    const want = choice === "mine" ? A : B;
    const hist = await docsApi(a, { listHistory: "doc_home" });
    const kept = (hist.body?.versions || []).slice(0, 6).map((v) => v.note || v.kind);
    drill.check(title === want && shown === want && clicks.since(m) === 1, `conflict (${button}): one click; the draft and the field hold ${choice === "mine" ? "tab A's" : "tab B's"} text`, { title, shown, kept });
    drill.note(`conflict (${button}): earlier versions now ${JSON.stringify(kept)}`);
    await b.reload({ waitUntil: "load" });
    await b.waitForSelector("[data-inspector]", { timeout: 60_000 });
  }
  await a.locator("[data-versions-toggle]").click();
  await waitFor(async () => ((t) => t.length > 20 && !/Loading earlier versions/.test(t))(await a.locator("[data-earlier-versions-panel]").innerText()), 15_000);
  const panel = await a.locator("[data-earlier-versions-panel]").innerText();
  drill.check(/Kept from another tab/.test(panel), "conflict: Earlier versions lists the text that wasn't chosen ('Kept from another tab')", { panel: panel.slice(0, 400) });
  await drill.screenshot(a, "conflict-earlier-versions-1440");
  await ctx.close();
};

// ED-03: a tab closed within the pause; a save that never arrived.
parts.keepalive = async (drill) => {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  ctx.on("page", (p) => p.on("dialog", (d) => d.accept().catch(() => {})));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  // 1. type, then close the tab at once (inside the 700 ms pause)
  const tab = await ctx.newPage();
  tab.on("dialog", (d) => d.accept().catch(() => {}));
  await openEditor(tab);
  await tab.locator('[data-section-row="sec_hero"] button').first().click();
  const KEEP = `Closed in the pause ${Date.now() % 10000}`;
  const sent = [];
  tab.on("request", (r) => {
    if (/\/api\/admin\/documents/.test(r.url()) && (r.postData() || "").includes("saveDraft")) sent.push(r.postData()?.includes(KEEP));
  });
  await tab.locator("#f-sec_hero-title").fill(KEEP);
  const status = await saveStatus(tab);
  await tab.close({ runBeforeUnload: true });
  const arrived = await waitFor(async () => (await getDoc(page, "doc_home")).body.sections.find((s) => s.id === "sec_hero").settings.title === KEEP, 10_000);
  drill.check(status === "pending" && Boolean(arrived), "keepalive: text typed and the tab closed within the pause is saved (the keepalive save on close)", { statusAtClose: status, requests: sent });

  // 2. the save never arrives: the backup is offered on the next open
  const BACK = `Never reached the server ${Date.now() % 10000}`;
  await ctx.route("**/api/admin/documents", (route) => {
    const body = route.request().postData() || "";
    if (body.includes("saveDraft") && body.includes(BACK)) return route.abort("internetdisconnected");
    return route.continue();
  });
  const t2 = await ctx.newPage();
  t2.on("dialog", (d) => d.accept().catch(() => {}));
  await openEditor(t2);
  await t2.locator('[data-section-row="sec_hero"] button').first().click();
  await t2.locator("#f-sec_hero-title").fill(BACK);
  const failed = await waitFor(async () => ["error", "pending", "saving"].includes(await saveStatus(t2)) && (await saveStatus(t2)) === "error", 20_000);
  const words = await t2.locator("[data-status-line]").innerText().catch(() => "");
  await drill.screenshot(t2, "keepalive-save-failed-1440");
  // the tab then goes away without its keepalive arriving (a crash, or the
  // network still down): closed without running beforeunload
  await t2.close();
  await sleep(1000);
  const server = (await getDoc(page, "doc_home")).body.sections.find((s) => s.id === "sec_hero").settings.title;
  drill.check(Boolean(failed) && /Could not save: We couldn.t reach Storeasy, so nothing was saved/.test(words) && server !== BACK, "backup: with the network down the save fails in plain words, and nothing reaches the server", { words: words.slice(0, 200), server });
  await ctx.unroute("**/api/admin/documents");
  const t3 = await ctx.newPage();
  await openEditor(t3);
  const offer = await waitFor(async () => (await t3.locator("[data-backup-offer]").count()) > 0, 15_000);
  const offerWords = await t3.locator("[data-status-line]").innerText().catch(() => "");
  await drill.screenshot(t3, "keepalive-backup-offer-1440");
  drill.check(Boolean(offer) && /We found edits that weren.t saved/.test(offerWords), "backup: the next open offers the edits that weren't saved", { words: offerWords.slice(0, 300) });
  if (offer) {
    await t3.locator("[data-backup-offer]").getByRole("button", { name: "Keep them as an earlier draft" }).click();
    await waitFor(async () => /Your edits were kept as an earlier draft/.test(await t3.locator("[data-status-line]").innerText()), 15_000);
    await t3.locator("[data-versions-toggle]").click();
    await waitFor(async () => ((t) => t.length > 20 && !/Loading earlier versions/.test(t))(await t3.locator("[data-earlier-versions-panel]").innerText()), 15_000);
    const panel = await t3.locator("[data-earlier-versions-panel]").innerText();
    const hist = await docsApi(t3, { listHistory: "doc_home" });
    drill.check(/Your edits were kept as an earlier draft/.test(await t3.locator("[data-status-line]").innerText()) && (hist.body?.versions || []).length > 0, "backup: 'Keep them as an earlier draft' keeps them in Earlier versions", { panel: panel.slice(0, 300) });
    // P3-FIX5: the text that never reached the server is in the stored version,
    // and that version says it came from this browser, not from another tab
    const [kept] = await storeSql("tenant", ["SELECT id, kind, note, body FROM document_versions WHERE document_id = 'doc_home' AND kind = 'undo_saved' ORDER BY created_at DESC, rowid DESC LIMIT 1"]);
    const row = kept.rows[0] || {};
    const listed = (hist.body?.versions || []).find((v) => v.id === String(row.id));
    drill.check(String(row.body || "").includes(BACK) && row.note === "Edits this browser kept" && listed?.note === "Edits this browser kept" && /Edits this browser kept/.test(panel) && !/Kept from another tab/.test(panel), "backup: the stored version holds the text that never reached the server, and Earlier versions says 'Edits this browser kept', not 'Kept from another tab'", { note: row.note, listed: listed?.note, hasText: String(row.body || "").includes(BACK), panel: panel.slice(0, 300) });
    await drill.screenshot(t3, "keepalive-backup-kept-1440");
  }
  await ctx.close();
};

// PV-01: the preview failure matrix, and See the live store.
parts.pv01 = async (drill) => {
  await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const sids = [];
  page.on("response", async (r) => {
    if (/\/api\/admin\/preview-session$/.test(new URL(r.url()).pathname) && r.request().method() === "POST" && (r.request().postData() || "").includes('"create"')) {
      const b = await r.json().catch(() => null);
      if (b?.sid) sids.push(b.sid);
    }
  });
  await openEditor(page);
  await waitLabel(page, "Up to date", 90_000);
  await page.locator('[data-section-row="sec_hero"] button').first().click();
  // record every label the pane shows, with the reconnecting mark
  const labels = [];
  let watching = true;
  const tag = () => page.locator("[data-preview-pane]").first().evaluate((el) => `${el.getAttribute("data-preview-label")}${el.hasAttribute("data-preview-reconnecting") ? " (Reconnecting)" : ""}`).catch(() => null);
  const watch = (async () => {
    while (watching) {
      const t = await tag();
      if (t && labels.at(-1) !== t) labels.push(t);
      await sleep(25);
    }
  })();
  const step = async (name, act) => {
    labels.length = 0;
    const before = sids.length;
    const text = `${name} ${Date.now() % 10000}`;
    await act();
    await page.locator("#f-sec_hero-title").fill(text);
    const ok = await waitFor(async () => (await previewLabel(page)) === "Up to date" && (await frameText(page)).includes(text) && labels.some((l) => /Reconnecting/.test(l)), 60_000);
    return { ok: Boolean(ok), labels: [...labels], reminted: sids.length > before };
  };
  const api = (body) => page.evaluate(async (b) => (await fetch("/api/admin/preview-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).status, body);
  // the session the frame is really using: the browser's preview cookie
  // (p.<exp>.<sid>.<hmac>). next dev can make two sessions for one editor
  // (finding D1), so "the last one minted" isn't always the frame's.
  const frameSid = async () => {
    const c = (await ctx.cookies()).find((x) => x.name === "_preview");
    return c ? decodeURIComponent(c.value).split(".")[2] : null;
  };

  // revoked
  const revoked = await step("revoked", async () => {
    await api({ revoke: await frameSid() });
  });
  drill.check(revoked.ok && revoked.reminted, "PV-01 revoked: the session ends, the preview says Reconnecting, opens a new session, and is Up to date with the edit", revoked);
  // expired (the session row's time moved into the past, local harness database only)
  const expired = await step("expired", async () => {
    await storeSql("tenant", [{ sql: "UPDATE preview_sessions SET expires_at = ? WHERE id = ?", args: [new Date(Date.now() - 60_000).toISOString(), await frameSid()] }]);
  });
  drill.check(expired.ok && expired.reminted, "PV-01 expired: an expired session is noticed, Reconnecting, then Up to date", expired);
  // exit: the frame leaves the preview (the preview switch's exit link)
  const exit = await step("exit", async () => {
    await page.locator("[data-preview-frame]").evaluate((f) => (f.contentWindow.location.href = "/api/preview?exit=1&to=%2F"));
    await sleep(1500);
  });
  drill.check(exit.ok, "PV-01 exit: the frame left the preview for the live store, then Reconnecting, then Up to date", exit);
  // See the live store, from the frame's own preview bar
  labels.length = 0;
  const m = clicks.mark();
  await frame(page).locator("[data-preview-bar] a", { hasText: "See the live store" }).first().click({ timeout: 15_000 });
  const back = await waitFor(async () => labels.some((l) => /Reconnecting/.test(l)) && (await previewLabel(page)) === "Up to date", 60_000);
  drill.check(Boolean(back) && clicks.since(m) === 1, "See the live store, then back: Reconnecting, then Up to date", { labels: [...labels] });
  await drill.screenshot(page, "pv01-reconnected-1440");
  // network: a new session can't be started
  labels.length = 0;
  await page.route("**/api/admin/preview-session", (r) => (r.request().method() === "POST" && (r.request().postData() || "").includes('"create"') ? r.abort("internetdisconnected") : r.continue()));
  await api({ revoke: await frameSid() });
  await page.locator("#f-sec_hero-title").fill(`network ${Date.now() % 10000}`);
  const failed = await waitLabel(page, "Could not update", 60_000);
  const words = await page.locator("[data-status-line]").innerText().catch(() => "");
  await drill.screenshot(page, "pv01-network-failed-1440");
  drill.check(Boolean(failed) && /Check your internet connection/.test(words) && (await page.locator("[data-preview-retry]").count()) === 1, "PV-01 network: the preview says Could not update, why in plain words, with 'Try the preview again'", { words: words.slice(0, 300), labels: [...labels] });
  await page.unroute("**/api/admin/preview-session");
  await page.locator("[data-preview-retry]").click();
  const retried = await waitLabel(page, "Up to date", 60_000);
  drill.check(Boolean(retried), "PV-01 network: Try the preview again, back online: Up to date", { labels: [...labels] });
  watching = false;
  await watch;
  // the label never claimed Up to date while the frame held older text (checked at each step above)
  await ctx.close();
};

// PV-01 and AU: logout ends the preview; the Designer redirect; staff.
parts.session = async (drill) => {
  await reseed(drill);
  await pauseTests(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  // the Designer redirect
  await page.goto("/admin/storefront/designer", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const d = await page.evaluate(() => ({ shell: !!document.querySelector("[data-editor-shell]"), editor: !!document.querySelector("[data-document-editor]") }));
  drill.check(where(page) === "/admin/editor?doc=doc_home" && !d.shell && d.editor, "the Designer redirect: /admin/storefront/designer opens the editor at the home page, never the Designer", { at: where(page), ...d });
  // logout ends the preview
  const DRAFT = "A draft only the founder sees";
  await saveOnly(page, "doc_home", (b) => {
    b.sections.find((s) => s.id === "sec_hero").settings.title = DRAFT;
    return b;
  });
  await page.waitForSelector("[data-inspector]", { timeout: 90_000 });
  await waitLabel(page, "Up to date", 90_000);
  const shop = await ctx.newPage();
  await shop.goto("/", { waitUntil: "load" });
  await noThanks(shop);
  const sawDraft = (await bodyText(shop)).includes(DRAFT);
  const m = clicks.mark();
  await page.goto("/admin/dashboard", { waitUntil: "load" });
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await page.waitForURL(/\/admin\/login/, { timeout: 30_000 }).catch(() => {});
  await shop.reload({ waitUntil: "load" });
  await noThanks(shop);
  const afterText = await bodyText(shop);
  const cookies = (await ctx.cookies()).map((c) => c.name);
  const [rows] = await storeSql("tenant", ["SELECT count(*) AS live FROM preview_sessions WHERE revoked_at IS NULL"]);
  drill.check(sawDraft && !afterText.includes(DRAFT) && !cookies.includes("_preview") && Number(rows.rows[0].live) === 0 && clicks.since(m) === 1, "logout ends the preview: after one click on Sign out, the same browser sees the live store, the preview cookie is gone and no preview session is left open", { sawDraft, cookies, openSessions: rows.rows[0].live });
  await drill.screenshot(shop, "session-after-sign-out-1440");
  // staff: Publish disabled with the reason; Undo too
  const sctx = await drill.context({ width: 1440 });
  await drill.clickCounter(sctx);
  const staff = await drill.login("staff", { context: sctx });
  await openEditor(staff);
  const btn = staff.locator("[data-publish] button", { hasText: /^Publish$/ }).first();
  const reason = await staff.locator("[data-publish]").first().innerText();
  drill.check((await btn.isDisabled()) && /Only the store owner or an admin can publish/.test(reason), "staff: Publish is disabled, with the reason", { reason: reason.slice(0, 200) });
  await drill.screenshot(staff, "session-staff-publish-disabled-1440");
  await staff.goto("/admin/releases", { waitUntil: "load" });
  await staff.waitForSelector("[data-recently-published]", { timeout: 60_000 }).catch(() => {});
  const undo = staff.locator("[data-recently-published] [data-undo] button", { hasText: /^Undo/ }).first();
  const undoReason = await staff.locator("[data-recently-published] [data-undo-reason]").first().innerText().catch(() => "");
  drill.check((await undo.count()) > 0 && (await undo.isDisabled()) && /Only the store owner or an admin can (publish or )?undo/.test(undoReason), "staff: Undo in Recently published is disabled, with the reason", { undoReason });
  await drill.screenshot(staff, "session-staff-undo-disabled-1440");
  await sctx.close();
  await ctx.close();
};

// TOK-03: the design from the editor's page list, publish, Undo.
const look = (page) => page.evaluate(() => ({ kit: document.documentElement.getAttribute("data-kit"), accent: getComputedStyle(document.documentElement).getPropertyValue("--accent-500").trim().toLowerCase() }));
parts.design = async (drill) => {
  await reseed(drill);
  const NEW = "#dc2626";
  const before = await shopper(drill, "/", () => true, { keep: true });
  const old = await look(before.page);
  await before.ctx.close();
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  await openEditor(page);
  const m = clicks.mark();
  // the page list: All pages, Brand (the design document)
  await page.locator("[data-switcher-toggle]").click();
  const brandRow = page.locator('[data-switcher-doc="doc_design"]');
  const brandLabel = await brandRow.innerText();
  await brandRow.click();
  await page.waitForURL(/doc=doc_design/, { timeout: 30_000 });
  await page.waitForSelector("#f-doc-brand-accent", { timeout: 60_000 });
  drill.check(clicks.since(m) === 2 && /Brand/.test(brandLabel), "design: a documents-mode founder reaches the design from the editor's page list (All pages, Brand: two clicks)", { clicks: clicks.since(m), row: brandLabel });
  await page.locator("#f-doc-brand-accent").fill(NEW);
  await waitSaved(page);
  const frameFacts = (p) =>
    p.locator("[data-preview-frame]").evaluate((f) => ({
      accent: getComputedStyle(f.contentDocument.documentElement).getPropertyValue("--accent-500").trim().toLowerCase(),
      bar: (f.contentDocument.querySelector("[data-preview-bar]")?.innerText || "").replace(/\s+/g, " ").slice(0, 240),
    }));
  const shown = await waitFor(async () => (await page.locator("[data-preview-pane]").getAttribute("data-preview-design")) === "true" && (await previewLabel(page)) === "Up to date" && (await frameFacts(page)).accent === NEW, 30_000);
  const [sess] = await storeSql("tenant", ["SELECT id, show_design FROM preview_sessions WHERE revoked_at IS NULL ORDER BY created_at"]);
  const pv = { ...(await frameFacts(page).catch(() => ({}))), design: await page.locator("[data-preview-pane]").getAttribute("data-preview-design"), label: await previewLabel(page), sessions: sess.rows, log: await page.locator("[data-preview-pane]").getAttribute("data-preview-log") };
  // P3-FIX5 (finding D1 fixed): a plain check, no escape
  drill.check(Boolean(shown), "design: the editor's preview shows the new accent (the design's draft is shown while it is open)", pv);
  // one editor mount mints one session, even with next dev's double effect
  // (a re-mint the preview asked for itself, after a timeout, is allowed)
  const remints = (String(pv.log || "").match(/readyTimeout|ready:(revoked|expired|not_found|live)|fixDesign/g) || []).length;
  drill.check(sess.rows.length >= 1 && sess.rows.length <= 1 + remints, "design: one editor tab holds one preview session (React strict mode's double effect mints once)", { sessions: sess.rows.length, remints, log: pv.log });
  await drill.screenshot(page, "design-editor-preview-1440");

  // finding D1 with two editor tabs: tab B opens a newer preview (the
  // browser's cookie is now B's); tab A's design change must still show in
  // A's frame, and A's label never says Up to date while its frame shows the
  // old colours
  const b = await ctx.newPage();
  await openEditor(b);
  await waitLabel(b, "Up to date", 90_000);
  const SECOND = "#2563eb";
  await page.locator("#f-doc-brand-accent").fill(SECOND);
  await waitSaved(page);
  const samples = [];
  const twoTabShown = await waitFor(async () => {
    const f = await frameFacts(page).catch(() => ({}));
    const label = await previewLabel(page);
    samples.push(`${label}|${f.accent}`);
    return label === "Up to date" && f.accent === SECOND;
  }, 30_000);
  // once Up to date, it stays right (no late flip back to the old colours)
  let stale = null;
  for (let i = 0; i < 15 && !stale; i++) {
    await sleep(200);
    const f = await frameFacts(page).catch(() => ({}));
    const label = await previewLabel(page);
    if (label === "Up to date" && f.accent !== SECOND) stale = { label, accent: f.accent };
  }
  const [sess2] = await storeSql("tenant", ["SELECT id, show_design FROM preview_sessions WHERE revoked_at IS NULL ORDER BY created_at"]);
  const twoTab = { ...(await frameFacts(page).catch(() => ({}))), label: await previewLabel(page), stale, sessions: sess2.rows, samples: [...new Set(samples)].slice(-8), log: await page.locator("[data-preview-pane]").getAttribute("data-preview-log") };
  drill.check(Boolean(twoTabShown) && !stale, "design, two editor tabs: the design tab's preview shows the new colours and never says Up to date while it shows the old ones", twoTab);
  await drill.screenshot(page, "design-two-tabs-1440");
  await b.close();
  await page.locator("#f-doc-brand-accent").fill(NEW);
  await waitSaved(page);
  const phase = await publishFromEditor(page, clicks);
  const after = await shopper(drill, "/", () => true, { keep: true, timeoutMs: 1 });
  let seen = await look(after.page);
  for (let i = 0; i < 20 && seen.accent !== NEW; i++) {
    await sleep(1000);
    await after.page.reload({ waitUntil: "load" });
    seen = await look(after.page);
  }
  await drill.screenshot(after.page, "design-live-after-publish-1440");
  await after.ctx.close();
  drill.check(phase === "done" && seen.accent === NEW && old.accent !== NEW, "design: after Publish the live store's look changes (the new accent)", { phase, before: old, after: seen });
  const u = await undoFromPanel(page);
  const back = await shopper(drill, "/", () => true, { keep: true, timeoutMs: 1 });
  let seen2 = await look(back.page);
  for (let i = 0; i < 20 && seen2.accent !== old.accent; i++) {
    await sleep(1000);
    await back.page.reload({ waitUntil: "load" });
    seen2 = await look(back.page);
  }
  await drill.screenshot(back.page, "design-live-after-undo-1440");
  await back.ctx.close();
  drill.check(seen2.accent === old.accent && /Undo this publish\?/.test(u.confirm), "design: Undo puts the old look back on the live store", { confirm: u.confirm.slice(0, 200), after: seen2 });
  await ctx.close();
};

// PUB-01, finding 3: a missing chrome version gives the error page.
parts["error-chrome"] = async (drill) => {
  await reseed(drill);
  const [live] = await storeSql("tenant", ["SELECT r.id, r.content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1"]);
  const { id, content } = live.rows[0];
  const list = JSON.parse(String(content));
  const bad = structuredClone(list);
  bad.documents.doc_header = { ...bad.documents.doc_header, version: "ver_0000000000000000" };
  await storeSql("tenant", [{ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [JSON.stringify(bad), id] }]);
  try {
    for (const path of ["/", "/policies/shipping", readSeed().documents.liveCampaign.path]) {
      const v = await shopper(drill, path, (x) => x.errorPage, { keep: true });
      drill.check(v.errorPage && v.status >= 500 && !v.text.includes("This weekend only") && !v.text.includes("Orders dispatch"), `error chrome: ${path} with only the header's version missing gives the error page`, { status: v.status, text: v.text.slice(0, 160) });
      await drill.screenshot(v.page, `error-chrome${path === "/" ? "-home" : path.replace(/\//g, "-")}-1440`);
      await v.ctx.close();
    }
  } finally {
    await storeSql("tenant", [{ sql: "UPDATE releases SET content = ? WHERE id = ?", args: [content, id] }]);
  }
  const ok = await shopper(drill, "/", (v) => !v.errorPage && v.status === 200);
  drill.check(ok.ok, "error chrome: with the list put back, the store shows again", { status: ok.status });
};

export const PART_NAMES = Object.keys(parts);

export async function runParts(names = PART_NAMES) {
  let failed = 0;
  for (const part of names) {
    if (!parts[part]) throw new DrillError(`There is no matrix part "${part}". Parts: ${PART_NAMES.join(", ")}.`);
    failed += await runDrill({ id: "P3-DRILLS", part, title: `P3-DRILLS — ${part}` }, parts[part]);
  }
  return failed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [only] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  runParts(only ? only.split(",") : PART_NAMES).then(
    (f) => process.exit(f ? 1 : 0),
    (e) => {
      console.error(`✗ ${e.message || e}`);
      process.exit(1);
    },
  );
}
