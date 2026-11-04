// P3-EDITOR drill (ED-02, ED-03, ED-04, PV-01, PV-02, PUB-02, PUB-04,
// PUB-06, PUB-11): the new editor, in desktop Chrome on the design harness.
//
//   DESIGN_PORT=6100 DESIGN_SQLD_PORT=7100 node scripts/drills/p3/editor.mjs [--headed]
//
// On the phase 3 seed (a documents store), signed in as the owner:
//   preview      the preview opens through the confirm fetch (no fetch of /),
//                says Up to date; a spoilt token says it didn't open
//   edit         select the hero, type its title: autosave, then the frame
//                shows the draft
//   pick         click a section's text in the frame: it is selected and its
//                field focused; click the header: the editor opens the header
//                with a note, and nothing is written to the home page
//   add          add a section: "Adding to preview…", then it is outlined
//   cart         on the product layout, a click on Add to cart selects the
//                section and adds nothing to the cart
//   conflict     two tabs on the home page: the 409 choice, Keep mine, then
//                Earlier versions has "Kept from another tab"
//   link         type, then click a console link within the pause: nothing lost
//   live         See the live store, back to the editor: Reconnecting, then Up to date
//   publish      Publish with its review, then Undo with its confirm
//   releases     /admin/releases shows Recently published
//   policy       a page that is all rich text opens as a writing view
//   closed       a store that never published says how it opens
//   staff        staff see Publish disabled with the reason
//   phone        at 375 the nav drawer links storefront items to the editor
// Results: docs/cms-reviews/drills/P3-EDITOR/results-editor.json, with screenshots.
import { fileURLToPath } from "node:url";
import { DrillError, docsApi, reseed, runDrill, settle, storeUrl } from "./lib.mjs";

const OLD_LINKS = ["/admin/storefront", "/admin/storefront/home", "/admin/storefront/designer", "/admin/storefront/pages", "/admin/storefront/navigation", "/admin/storefront/product-pages", "/admin/theme", "/admin/brand"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const previewLabel = (page) => page.locator("[data-preview-pane]").first().getAttribute("data-preview-label").catch(() => null);
const saveStatus = (page) => page.locator("[data-save-status]").first().getAttribute("data-save-status").catch(() => null);
async function waitFor(fn, ms = 30_000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn().catch(() => undefined);
    if (last) return last;
    await sleep(step);
  }
  return false;
}
const waitLabel = (page, label, ms = 45_000) => waitFor(async () => (await previewLabel(page)) === label, ms);
const waitSaved = (page, ms = 20_000) => waitFor(async () => (await saveStatus(page)) === "saved", ms);
const frame = (page) => page.frameLocator("[data-preview-frame]");
const frameText = (page) => page.locator("[data-preview-frame]").evaluate((f) => f.contentDocument?.body?.innerText || "").catch(() => "");
async function getDoc(page, id) {
  const r = await docsApi(page, { getDocument: id });
  if (r.status !== 200) throw new DrillError(`getDocument ${id} answered ${r.status}`);
  return r.body.document;
}
const where = (page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};

async function openEditor(page, query = "") {
  await page.goto(`/admin/editor${query}`, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 60_000 });
}

export async function editor(drill) {
  const { seed } = await reseed(drill);
  const ctx = await drill.context({ width: 1440 });
  const clicks = await drill.clickCounter(ctx);
  const page = await drill.login("owner", { context: ctx });
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), type: r.resourceType(), method: r.method(), frame: r.frame() === page.mainFrame() ? "main" : "frame", headers: r.headers() }));

  // ---- preview: the confirm fetch (P3-FIX1) ----
  await openEditor(page);
  const up = await waitLabel(page, "Up to date", 90_000);
  const confirm = requests.filter((r) => /\/api\/preview\?/.test(r.url) && r.type === "fetch");
  const fetchedRoot = requests.filter((r) => r.type === "fetch" && new URL(r.url).pathname === "/");
  drill.check(up && confirm.length >= 1 && confirm.every((r) => r.headers["x-storeasy-preview-confirm"] === "1") && fetchedRoot.length === 0, "preview: the cookie is set through the confirm fetch (header sent), no fetch of / in the network log, and the label says Up to date", { up: !!up, confirms: confirm.length, rootFetches: fetchedRoot.length });
  await drill.screenshot(page, "editor-home-1440");

  // ---- edit + autosave, and the frame shows the draft ----
  const home = await getDoc(page, "doc_home");
  const hero = home.body.sections.find((s) => s.kind === "hero");
  if (!hero) throw new DrillError("the seeded home page has no hero");
  let m = clicks.mark();
  await page.locator(`[data-section-row="${hero.id}"] button`).first().click();
  const title = page.locator(`#f-${hero.id}-title`);
  await title.waitFor({ timeout: 10_000 });
  const typed = `Drill title ${Date.now() % 100000}`;
  await title.fill(typed);
  const sawSaving = await waitFor(async () => ["saving", "pending"].includes(await saveStatus(page)), 3000, 20);
  const saved = await waitSaved(page);
  const after = await getDoc(page, "doc_home");
  const stored = after.body.sections.find((s) => s.id === hero.id)?.settings?.title;
  drill.check(Boolean(sawSaving) && saved && stored === typed && after.revision === home.revision + 1, "edit: select the hero, type its title: Saving, then Saved; the draft holds the text (one autosave)", { clicks: clicks.since(m), stored, revisions: [home.revision, after.revision] });
  const shows = await waitFor(async () => (await previewLabel(page)) === "Up to date" && (await frameText(page)).includes(typed), 45_000);
  drill.check(Boolean(shows), "edit: the frame shows the draft, and the label says Up to date", { label: await previewLabel(page) });
  await drill.screenshot(page, "editor-edited-1440");

  // ---- click to select (ED-04) ----
  const textSec = after.body.sections.find((s) => s.kind !== "hero" && s.enabled !== false && (s.kind === "text" || s.kind === "banner" || s.kind === "faq" || s.kind === "rich_text"));
  if (textSec) {
    const target = frame(page).locator(`[data-section-id="${textSec.id}"] [data-field]`).first();
    const field = await target.getAttribute("data-field").catch(() => null);
    m = clicks.mark();
    await target.click({ timeout: 10_000 });
    const focused = await waitFor(async () => {
      const id = await page.evaluate(() => document.activeElement?.id || "");
      return id.startsWith(`f-${textSec.id}-`) ? id : false;
    }, 8000);
    const selected = await page.locator(`[data-section-row="${textSec.id}"][data-selected]`).count();
    drill.check(Boolean(focused) && selected === 1 && clicks.since(m) === 1, `pick: one click on the ${textSec.kind} section's ${field} in the frame selects it and focuses its field`, { field, focused, clicks: clicks.since(m) });
  } else drill.check(false, "pick: the seeded home page has a text-like section to click", null);

  // a pick in another document: the header
  const homeBefore = await getDoc(page, "doc_home");
  m = clicks.mark();
  // a header link that belongs to the header itself (not its announcement bar)
  await page.locator("[data-preview-frame]").evaluate((f) => {
    const a = [...f.contentDocument.querySelectorAll('header[data-doc="doc_header"] a')].find((el) => el.closest("[data-doc]")?.getAttribute("data-doc") === "doc_header" && el.offsetParent !== null);
    a?.setAttribute("data-drill-pick", "");
  });
  await frame(page).locator("[data-drill-pick]").first().click({ timeout: 10_000 });
  await page.waitForURL(/doc=doc_header/, { timeout: 30_000 });
  await page.waitForSelector("[data-switch-note]", { timeout: 30_000 }).catch(() => {});
  const note = await page.locator("[data-switch-note]").innerText().catch(() => "");
  const homeAfter = await getDoc(page, "doc_home");
  drill.check(/You picked .* in the preview, so the editor opened it\. Nothing changed on “Home page”\./.test(note) && homeAfter.revision === homeBefore.revision && homeAfter.draftHash === homeBefore.draftHash && clicks.since(m) === 1, "pick: one click on the header in the frame opens the header with a visible note, and nothing is written to the home page", { note, revisions: [homeBefore.revision, homeAfter.revision], clicks: clicks.since(m) });
  await drill.screenshot(page, "editor-other-document-pick-1440");

  // back to home through the switcher
  m = clicks.mark();
  await page.locator("[data-switcher-toggle]").click();
  await page.locator('[data-switcher-doc="doc_home"]').click();
  await page.waitForURL(/doc=doc_home/, { timeout: 30_000 });
  await page.waitForSelector("[data-section-tree]", { timeout: 30_000 });
  drill.check(clicks.since(m) === 2, "switcher: two clicks (All pages, Home page) open the home page", { clicks: clicks.since(m) });
  await waitLabel(page, "Up to date", 45_000);

  // ---- add a section ----
  const beforeAdd = await getDoc(page, "doc_home");
  m = clicks.mark();
  await page.locator("[data-tree-add]").click();
  await page.locator('[data-tree-picker] button[data-kind="text"]').click();
  const sawAdding = await waitFor(async () => (await page.locator("[data-adding-note]").count()) > 0, 3000, 20);
  const addedDoc = await waitFor(async () => {
    const d = await getDoc(page, "doc_home");
    return d.body.sections.length === beforeAdd.body.sections.length + 1 ? d : false;
  }, 20_000);
  const newId = addedDoc ? addedDoc.body.sections.find((s) => !beforeAdd.body.sections.some((b) => b.id === s.id))?.id : null;
  const outlined = newId
    ? await waitFor(async () => (await page.locator("[data-adding-note]").count()) === 0 && (await frame(page).locator(`[data-section-id="${newId}"].storeasy-selected`).count()) === 1, 45_000)
    : false;
  drill.check(Boolean(sawAdding) && Boolean(newId) && Boolean(outlined), "add: a new section shows 'Adding to preview…' until the refresh holds it, then it is outlined in the frame", { sawAdding: !!sawAdding, newId, clicks: clicks.since(m) });
  await drill.screenshot(page, "editor-added-section-1440");

  // ---- add to cart in the frame (P3-FRAME review) ----
  await openEditor(page, "?doc=doc_product_layout");
  await waitLabel(page, "Up to date", 60_000);
  const cartPosts = () => requests.filter((r) => /\/api\/cart/.test(r.url) && r.method !== "GET").length;
  const posts0 = cartPosts();
  const add = frame(page).getByRole("button", { name: "Add to cart" }).first();
  const hasAdd = (await add.count()) > 0;
  if (hasAdd) {
    m = clicks.mark();
    await add.click({ timeout: 10_000 });
    await sleep(1500);
    const cart = await page.evaluate(async () => {
      const r = await fetch("/api/cart");
      return r.ok ? r.json() : null;
    });
    const lines = Array.isArray(cart?.cart?.lines) ? cart.cart.lines.length : Array.isArray(cart?.lines) ? cart.lines.length : (cart?.cart?.totalQuantity ?? cart?.totalQuantity ?? 0);
    const selectedRow = await page.locator("[data-section-row][data-selected]").count();
    drill.check(cartPosts() === posts0 && !lines && selectedRow === 1 && clicks.since(m) === 1, "cart: in the editor frame, one click on Add to cart selects the product section and adds nothing to the cart", { cartWrites: cartPosts() - posts0, lines, selectedRow, path: await page.locator("[data-preview-frame]").evaluate((f) => f.contentWindow.location.pathname) });
    await drill.screenshot(page, "editor-add-to-cart-picks-1440");
  } else drill.check(false, "cart: the product page in the frame has an Add to cart button", { path: await page.locator("[data-preview-frame]").evaluate((f) => f.contentWindow?.location?.pathname).catch(() => null) });

  // ---- conflict in two tabs ----
  await openEditor(page, "?doc=doc_home");
  await waitLabel(page, "Up to date", 45_000);
  const tabB = await ctx.newPage();
  await openEditor(tabB, "?doc=doc_home");
  const heroB = tabB.locator(`[data-section-row="${hero.id}"] button`).first();
  await heroB.click();
  await tabB.locator(`#f-${hero.id}-title`).fill("Tab B's title");
  await waitSaved(tabB);
  await page.locator(`[data-section-row="${hero.id}"] button`).first().click();
  await page.locator(`#f-${hero.id}-title`).fill("Tab A's title");
  const conflict = await waitFor(async () => (await page.locator("[data-conflict]").count()) > 0, 20_000);
  drill.check(Boolean(conflict) && (await saveStatus(page)) === "conflict", "conflict: tab A's save after tab B's gets the choice (Use the newer version / Keep mine), with the text still on screen", { status: await saveStatus(page), value: await page.locator(`#f-${hero.id}-title`).inputValue() });
  await drill.screenshot(page, "editor-conflict-1440");
  m = clicks.mark();
  await page.getByRole("button", { name: "Keep mine", exact: true }).click();
  await waitSaved(page);
  const kept = await getDoc(page, "doc_home");
  await page.locator("[data-versions-toggle]").click();
  const keptRow = await waitFor(async () => (await page.locator("[data-earlier-versions]").first().innerText()).includes("Kept from another tab"), 15_000);
  const hist = await docsApi(page, { listHistory: "doc_home" });
  drill.check(kept.body.sections.find((s) => s.id === hero.id)?.settings?.title === "Tab A's title" && Boolean(keptRow), "conflict: Keep mine saves tab A's text, and Earlier versions lists tab B's as 'Kept from another tab'", { title: kept.body.sections.find((s) => s.id === hero.id)?.settings?.title, clicks: clicks.since(m), panel: (await page.locator("[data-earlier-versions]").first().innerText().catch(() => "")).slice(0, 300), notes: (hist.body?.versions || []).slice(0, 5).map((v) => [v.kind, v.note]) });
  await drill.screenshot(page, "editor-kept-from-another-tab-1440");
  await page.locator("[data-versions-toggle]").click();
  await tabB.close();

  // ---- link click within the pause ----
  const pausedText = `Typed then left ${Date.now() % 100000}`;
  await page.locator(`#f-${hero.id}-title`).fill(pausedText);
  const statusAtClick = await saveStatus(page);
  m = clicks.mark();
  await page.locator('aside nav[aria-label="Console"] a[href="/admin/media"]').click();
  await page.waitForURL(/\/admin\/media/, { timeout: 30_000 });
  const leftDoc = await getDoc(page, "doc_home");
  drill.check(statusAtClick === "pending" && leftDoc.body.sections.find((s) => s.id === hero.id)?.settings?.title === pausedText && clicks.since(m) === 1, "link: typed then clicked a console link within the pause, nothing lost (the page waited for the save, then went)", { statusAtClick, stored: leftDoc.body.sections.find((s) => s.id === hero.id)?.settings?.title, clicks: clicks.since(m) });

  // ---- See the live store, then reconnect ----
  await openEditor(page, "?doc=doc_home");
  await waitLabel(page, "Up to date", 45_000);
  const labels = [];
  let watching = true;
  // the label and the reconnecting mark are read in one go, so a change
  // between two reads can't make up a label the pane never showed
  const paneTag = () =>
    page
      .locator("[data-preview-pane]")
      .first()
      .evaluate((el) => `${el.getAttribute("data-preview-label")}${el.hasAttribute("data-preview-reconnecting") ? " (Reconnecting)" : ""}`)
      .catch(() => null);
  const record = (tag) => {
    if (tag && labels.at(-1) !== tag) labels.push(tag);
  };
  const watch = (async () => {
    while (watching) {
      record(await paneTag());
      await sleep(25);
    }
  })();
  m = clicks.mark();
  await frame(page).locator("[data-preview-bar] a", { hasText: "See the live store" }).first().click({ timeout: 10_000 });
  const back = await waitFor(async () => labels.some((l) => /Reconnecting/.test(l)) && (await previewLabel(page)) === "Up to date", 60_000);
  watching = false;
  await watch;
  record(await paneTag()); // the label the pane ended on
  // once reconnecting, it says Reconnecting until Up to date (never a plain Updating meanwhile)
  const afterRc = labels.slice(labels.findIndex((l) => /Reconnecting/.test(l)));
  const steady = afterRc.every((l) => l === "Updating (Reconnecting)" || l === "Up to date");
  drill.check(Boolean(back) && labels.some((l) => /Updating \(Reconnecting\)/.test(l)) && steady && labels.at(-1) === "Up to date", "live: See the live store, back to the editor, Reconnecting then Up to date", { labels, clicks: clicks.since(m), log: await page.locator("[data-preview-pane]").getAttribute("data-preview-log").catch(() => null) });
  await drill.screenshot(page, "editor-reconnected-1440");

  // ---- publish, then Undo ----
  m = clicks.mark();
  await page.locator("[data-publish] button", { hasText: "Publish" }).first().click();
  await page.waitForSelector('[data-publish][data-phase="review"]', { timeout: 20_000 });
  await waitFor(async () => (await page.locator('[data-publish][data-phase="review"] button:not([disabled])', { hasText: /^Publish$/ }).count()) > 0, 20_000);
  await drill.screenshot(page, "editor-publish-review-1440");
  await page.locator('[data-publish][data-phase="review"] button', { hasText: /^Publish$/ }).click();
  const settled = () => waitFor(async () => (await page.locator('[data-publish][data-phase="done"]').count()) > 0 || (await page.locator('[data-publish][data-phase="blocked"]').count()) > 0, 30_000);
  await settled();
  let phase = await page.locator("[data-publish][data-phase]").getAttribute("data-phase").catch(() => null);
  // the empty Text section added above can't go live: the panel offers a fix
  // ("Hide this section and publish"), which saves through the store first
  const blocked = phase === "blocked";
  const blockedText = blocked ? await page.locator("[data-publish][data-phase]").innerText() : "";
  drill.check(blocked && /Hide this section and publish/.test(blockedText), "publish: the unfinished new section blocks the publish, in words, with 'Hide this section and publish'", { phase, words: blockedText.slice(0, 300) });
  await drill.screenshot(page, "editor-publish-blocked-1440");
  if (blocked) {
    await page.locator("[data-publish] button", { hasText: "Hide this section and publish" }).first().click();
    await waitFor(async () => (await page.locator('[data-publish][data-phase="done"]').count()) > 0, 30_000);
    phase = await page.locator("[data-publish][data-phase]").getAttribute("data-phase").catch(() => null);
  }
  const live = await page.evaluate(async () => (await fetch("/")).text());
  const afterFix = await getDoc(page, "doc_home");
  drill.check(phase === "done" && live.includes(pausedText) && afterFix.body.sections.find((s) => s.id === newId)?.enabled === false, "publish: Publish, review, Publish, then the fix: published with the new section hidden, and the live store shows the text", { phase, clicks: clicks.since(m), newSectionEnabled: afterFix.body.sections.find((s) => s.id === newId)?.enabled });
  await drill.screenshot(page, "editor-published-1440");
  if (phase === "done") {
    m = clicks.mark();
    await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).first().click();
    await page.waitForSelector("[data-publish] [data-undo] >> text=Undo this publish?", { timeout: 20_000 }).catch(() => {});
    const confirmText = await page.locator("[data-publish] [data-undo]").innerText().catch(() => "");
    await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).last().click();
    const undone = await waitFor(async () => (await page.locator("[data-publish] [data-undo] [role=status]").count()) > 0, 30_000);
    const liveAfter = await page.evaluate(async () => (await fetch("/")).text());
    const status = await page.locator("[data-publish] [data-undo] [role=status]").innerText().catch(() => "");
    drill.check(Boolean(undone) && !liveAfter.includes(pausedText) && /title changed/i.test(confirmText), "undo: Undo shows what will change, then the live store is back to before", { confirmText: confirmText.slice(0, 200), status, clicks: clicks.since(m) });
    await drill.screenshot(page, "editor-undone-1440");
  }

  // ---- /admin/releases ----
  await page.goto("/admin/releases", { waitUntil: "load" });
  await settle(page);
  const rp = await page.locator("[data-recently-published]").count();
  const rpText = await page.locator("[data-recently-published-page]").innerText().catch(() => "");
  drill.check(rp === 1 && /Published|Undid/.test(rpText), "releases: /admin/releases shows Recently published on a documents store", { text: rpText.slice(0, 200) });
  await drill.screenshot(page, "releases-recently-published-1440");

  // ---- a policy opens in the full-width writing view ----
  const list = await docsApi(page, { listDocuments: true });
  let policy = null;
  for (const d of (list.body?.documents || []).filter((x) => x.type === "page")) {
    const full = await getDoc(page, d.id);
    if (full.body.sections.length && full.body.sections.every((x) => x.kind === "rich_text")) {
      policy = full;
      break;
    }
  }
  if (!policy) {
    const made = await docsApi(page, { createDocument: { type: "page", meta: { slug: "drill-returns", title: "Returns" }, body: { schema: 1, type: "page", meta: { slug: "drill-returns", title: "Returns", description: "", enabled: true, effective_at: null, window_start: null, window_end: null, redirect_from: [] }, sections: [{ id: "sec_drillrt1", kind: "rich_text", v: 1, enabled: true, blocks: [], settings: { title: "Returns", html: "<p>Thirty days to send it back.</p><p>Unworn, with tags.</p>" } }] }, entityId: null } });
    policy = made.body?.document || null;
    drill.note(`no seeded page is all rich text, so the drill made one through createDocument (${made.status}${made.status === 200 ? "" : `: ${made.body?.error}`})`);
  }
  if (policy) {
    await openEditor(page, `?doc=${policy.id}`);
    const writing = await page.locator("[data-writing-view]").count();
    const hiddenPane = await page.locator("[data-preview-pane].hidden").count();
    await drill.screenshot(page, "editor-policy-writing-view-1440");
    m = clicks.mark();
    await page.locator("[data-preview-toggle]").click();
    const shown = await waitFor(async () => (await page.locator("[data-preview-pane].hidden").count()) === 0 && (await previewLabel(page)) === "Up to date", 45_000);
    drill.check(writing === 1 && hiddenPane === 1 && Boolean(shown) && (await page.locator("[data-section-tree]").count()) === 0, "policy: a page that is all rich text opens in the full-width writing view, the preview behind a toggle (one click shows it, Up to date)", { label: policy.label, writing, hiddenPane, clicks: clicks.since(m) });
    await drill.screenshot(page, "editor-policy-preview-shown-1440");
  }

  // ---- a closed store (PUB-06) ----
  const ctxC = await drill.context({ width: 1440 });
  await drill.clickCounter(ctxC);
  const closed = await drill.login("owner", { context: ctxC, store: "closed" });
  await closed.goto(storeUrl(drill, "closed", "/admin/editor"), { waitUntil: "load", timeout: 120_000 });
  await settle(closed);
  await waitFor(async () => (await closed.locator("[data-closed-store]").count()) > 0, 45_000);
  const closedText = await closed.locator("[data-status-line]").innerText().catch(async () => (await closed.evaluate(() => document.body.innerText)).slice(0, 400));
  drill.check(/Your store isn.t open yet\. Publishing your home page opens it\./.test(closedText), "closed store: the editor says 'Your store isn't open yet. Publishing your home page opens it.'", { text: closedText.slice(0, 200) });
  await drill.screenshot(closed, "closed-store-editor-1440");
  await ctxC.close();

  // ---- a spoilt preview token says it didn't open (P3-FIX1) ----
  const ctx2 = await drill.context({ width: 1440 });
  await drill.clickCounter(ctx2);
  const spoilt = await drill.login("owner", { context: ctx2 });
  await spoilt.route("**/api/admin/preview-session", async (route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (body && typeof body.previewUrl === "string") body.previewUrl = body.previewUrl.replace(/(token=)([^&]+)/, (_, a, t) => `${a}${t.slice(0, -4)}xxxx`);
    await route.fulfill({ response: res, body: JSON.stringify(body) });
  });
  await openEditor(spoilt);
  const failed = await waitLabel(spoilt, "Could not update", 45_000);
  const words = await spoilt.locator("[data-status-line]").innerText().catch(() => "");
  drill.check(Boolean(failed) && /didn.t open/.test(words), "preview: a spoilt token says the preview didn't open", { words: words.slice(0, 300) });
  await drill.screenshot(spoilt, "editor-spoilt-token-1440");
  await ctx2.close();

  // ---- staff ----
  const ctx3 = await drill.context({ width: 1440 });
  await drill.clickCounter(ctx3);
  const staff = await drill.login("staff", { context: ctx3 });
  await openEditor(staff);
  const btn = staff.locator("[data-publish] button", { hasText: /^Publish$/ }).first();
  const disabled = await btn.isDisabled().catch(() => false);
  const reason = await staff.locator("[data-publish]").first().innerText().catch(() => "");
  drill.check(disabled && /Only the store owner or an admin can publish/.test(reason), "staff: Publish is disabled with the reason", { disabled, reason: reason.slice(0, 200) });
  await drill.screenshot(staff, "editor-staff-1440");
  await ctx3.close();

  // ---- phone: the documents-mode nav drawer (P3-ROUTES review) ----
  const ctx4 = await drill.context({ width: 375 });
  const c4 = await drill.clickCounter(ctx4);
  const phone = await drill.login("owner", { context: ctx4 });
  await phone.setViewportSize({ width: 375, height: 812 });
  await phone.goto("/admin/dashboard", { waitUntil: "load" });
  await settle(phone);
  m = c4.mark();
  await phone.getByRole("button", { name: "Open menu" }).first().click();
  const dialog = phone.getByRole("dialog");
  await dialog.waitFor({ timeout: 10_000 });
  const drawerLinks = await dialog.locator("a").evaluateAll((as) => as.map((a) => new URL(a.href).pathname));
  await drill.screenshot(phone, "phone-nav-drawer-375");
  await dialog.locator('a[href="/admin/editor"]').click();
  await phone.waitForURL(/\/admin\/editor/, { timeout: 30_000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  drill.check(drawerLinks.includes("/admin/editor") && OLD_LINKS.every((l) => !drawerLinks.includes(l)) && where(phone).startsWith("/admin/editor") && c4.since(m) === 2, "phone: at 375 the documents-mode nav drawer links storefront items to the editor (two clicks: menu, Editor)", { drawerLinks, clicks: c4.since(m) });
  drill.check(overflow <= 1, "phone: the editor has no sideways scroll at 375", { overflow });
  await phone.waitForSelector("[data-inspector], [data-writing-view]", { timeout: 60_000 }).catch(() => {});
  await drill.screenshot(phone, "phone-editor-375");
  await ctx4.close();

  drill.note(`click totals: owner context ${clicks.count}`);
  await ctx.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await runDrill({ id: "P3-EDITOR", part: "editor", title: "P3-EDITOR — the editor: edit, pick, add, cart, conflict, leave, reconnect, publish, Undo" }, editor);
  process.exit(code);
}
