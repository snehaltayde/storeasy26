// P6-DRILLS stage C (US-41, PUB-12; owner answers OQ-P6-1 and OQ-P6-2) and
// stage D (PUB-12, the payment block). Desktop Chrome, the editor's own
// "Before you open your store" panel, as the founder uses it.
//
// C: opening stays blocked until both policy pages exist and are read or
//    saved; the returns starter says the seeded window (10 days); a cash on
//    delivery test order in the preview (snehal@mediastic.in), its Shopify
//    push failing harmlessly with the blank keys, cancelled at once; then
//    "Open my store anyway": the store is live with its colours, logo and both
//    policy pages.
// D: checkout off is the only block (the founder's privacy and terms pages
//    are seeded); the panel links to Settings; checkout turned on there; Check
//    again; open.
import { livePath } from "../../../lib/documents/paths.js";
import { openStart, previewHome } from "./brand.mjs";
import {
  LOGO_FACTS,
  P6_LOGO_MEDIA,
  P6_RETURNS_DAYS,
  P6_STORE,
  TEST_ORDER_EMAIL,
  cancelOrder,
  cssVarsOf,
  docOf,
  docsApi,
  docsOf,
  frameText,
  isLime,
  liveRelease,
  loginP6,
  noRealKeys,
  noThanks,
  openEditor,
  orderRow,
  p6Context,
  p6Sql,
  p6Url,
  panelButton,
  placeTestOrder,
  pressPublish,
  readOpening,
  reseedP6,
  settle,
  sleep,
  tenantConfig,
  waitFor,
  watchErrors,
} from "./lib.mjs";

const NEW_SENTENCE = "We only ask for what we need to send your order, and we keep it safe.";
const lv = (p, id) => p.items.find((i) => i.id === id) || {};
const levels = (p) => Object.fromEntries(p.items.map((i) => [i.id, i.level]));

// The policy pages in the store: { privacy: row|null, returns: row|null }
async function policyDocs() {
  const docs = await docsOf();
  return { privacy: docs.find((d) => d.type === "page" && /privacy/.test(d.slug || "")) || null, returns: docs.find((d) => d.type === "page" && /terms|refund|return/.test(d.slug || "")) || null, all: docs };
}

// A product whose every variant is in stock (the default pick adds one).
async function inStockHandle() {
  const r = await p6Sql(["SELECT p.handle FROM products p WHERE p.available = 1 AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.available = 0) ORDER BY p.handle LIMIT 1"]);
  return String(r[0].rows[0]?.handle || "");
}

// Edit one sentence of a page in the editor (its first text section's first
// paragraph) and wait for the save.
export async function changeOneSentence(page, id, sentence) {
  await openEditor(page, `?doc=${encodeURIComponent(id)}`);
  await page.locator("[data-section-row] button").first().click();
  const ta = page.locator('[data-inspector] textarea, [data-form="settings"] textarea').first();
  await ta.waitFor({ timeout: 30_000 });
  const before = await ta.inputValue();
  await ta.fill(sentence);
  const saved = await waitFor(async () => {
    const d = await docOf(id);
    return d && JSON.stringify(d.body).includes(sentence) && d.updated_by !== "system:policy-starter" ? d : false;
  }, 30_000, 300);
  return { before, saved };
}

// What a shopper sees on the open store, in a fresh browser.
async function shopperLook(drill, { tag }) {
  const ctx = await drill.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(p6Url(drill, "/"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await noThanks(page);
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const vars = await cssVarsOf(page);
  const logo = await page.evaluate(LOGO_FACTS);
  await drill.screenshot(page, `${tag}-live-home-1440`);
  return { ctx, page, text, vars, logo };
}

// ---------------------------------------------------------------------------
// stage C
// ---------------------------------------------------------------------------
export async function openStage(drill) {
  const seed = await reseedP6(drill, "c");
  const cfg0 = await tenantConfig();
  drill.check(cfg0?.returns_window_days === P6_RETURNS_DAYS && !cfg0?.site?.support_email, `the stage seed sets returns_window_days ${P6_RETURNS_DAYS} and no support email`, { returns_window_days: cfg0?.returns_window_days, support: cfg0?.site?.support_email ?? null });
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  drill.check((await openStart(drill, page)) === "ready", "the store is made on /admin/start", null);

  // the brand step: Slate kept, the library logo chosen, saved
  await page.getByRole("button", { name: "Choose a logo", exact: true }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.locator(`button:has(img[src*="${P6_LOGO_MEDIA.id}"])`).first().click();
  await page.locator("#brand-logo-alt").waitFor({ timeout: 30_000 });
  await page.locator("#brand-logo-alt").fill("");
  await page.locator("[data-brand-step]").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator('[data-brand-done="saved"]').waitFor({ timeout: 60_000 });
  const logoSrc = `/api/media/${P6_LOGO_MEDIA.id}`;
  drill.check((await docOf("doc_design"))?.body?.settings?.logo?.media === logoSrc, "the brand step: Slate kept, the library logo saved into the design draft", (await docOf("doc_design"))?.body?.settings?.logo);
  const designLabel = (await docOf("doc_design"))?.label;

  // ---- 1. Publish: the panel, before anything opens ----
  await openEditor(page, "?doc=doc_home");
  let p = await pressPublish(page);
  drill.check(p.phase === "opening" && p.text.includes("Before you open your store"), "Publish shows 'Before you open your store' first", { phase: p.phase, text: p.text.slice(0, 120) });
  drill.check((await liveRelease()) == null, "nothing went live by opening the panel", null);
  drill.check(p.goesLive.length === 2 && p.goesLive.some((t) => t.startsWith(designLabel)), `doc_design ("${designLabel}") is in the set beside the home page`, p.goesLive.map((t) => t.slice(0, 60)));
  drill.check(lv(p, "privacy").level === "block" && lv(p, "privacy").buttons.includes("Start a privacy page") && lv(p, "returns").level === "block" && lv(p, "returns").buttons.includes("Start a returns page"), "privacy and returns are 'Must fix', with 'Start a privacy page' and 'Start a returns page'", { privacy: lv(p, "privacy"), returns: lv(p, "returns") });
  drill.check(p.open && p.open.disabled === true, "with no policy page, Open is disabled", p.open);
  drill.check(lv(p, "test_order").level === "warn" && lv(p, "contact").level === "warn", "the test order and contact details are warnings ('Check')", levels(p));
  drill.check(p.text.includes("These are starting points, not legal advice."), "the panel says the starters are not legal advice", null);
  await drill.screenshot(page, "c-panel-first-1440");

  // ---- 2. Start a returns page ----
  p = await panelButton(page, "Start a returns page", { within: "returns" });
  const pol1 = await policyDocs();
  const terms = pol1.returns;
  drill.check(terms && terms.slug === "terms" && /Terms of service/i.test(terms.label) && terms.updated_by === "system:policy-starter" && !terms.published_version_id, "'Start a returns page' makes a 'Terms of service' draft at slug terms, marked as the starter's (not the founder's)", terms);
  drill.check((await liveRelease()) == null && !(await docsOf()).some((d) => d.published_version_id), "nothing went live", null);
  drill.check(lv(p, "returns").level === "block" && lv(p, "returns").linkText === "Read it" && lv(p, "returns").link === `/admin/editor?doc=${terms?.id}` && lv(p, "returns").buttons.includes("I've read it"), "the returns item is still 'Must fix', now with 'Read it' and 'I've read it'", lv(p, "returns"));
  drill.check(p.open?.disabled === true, "with only the returns starter, Open is disabled", p.open);
  await drill.screenshot(page, "c-panel-returns-started-1440");

  // 'Read it' (in a second tab, so the panel stays where it is)
  const reader = await ctx.newPage();
  await reader.goto(p6Url(drill, lv(p, "returns").link), { waitUntil: "load", timeout: 120_000 });
  await settle(reader);
  await reader.waitForSelector("[data-preview-frame]", { timeout: 90_000 });
  const termsText = await waitFor(async () => {
    const t = await frameText(reader);
    return /within \d+ days/.test(t) ? t : false;
  }, 90_000, 500);
  const days = [...String(termsText).matchAll(/(\d+)[ -]day/g)].map((m) => m[1]).concat([...String(termsText).matchAll(/within (\d+) days/g)].map((m) => m[1]));
  drill.check(String(termsText).includes(`within ${P6_RETURNS_DAYS} days of your order`) && !days.some((d) => d === "7" || d === "14"), `'Read it': the returns starter says 'within ${P6_RETURNS_DAYS} days of your order' (the seeded window), never 7 or 14`, { days, line: String(termsText).split("\n").find((l) => /days/.test(l)) });
  const termsBody = JSON.stringify((await docOf(terms.id)).body);
  drill.check(termsBody.includes(`within ${P6_RETURNS_DAYS} days of your order`) && !/\b(7|14) days\b/.test(termsBody), "the stored starter draft holds the same sentence, and no 7 or 14 days", null);
  await drill.screenshot(reader, "c-returns-starter-read-1440");

  // ---- 3. Back in the panel: Check again ----
  await page.bringToFront();
  p = await panelButton(page, "Check again");
  drill.check(lv(p, "returns").level === "block" && !p.goesLive.some((t) => /Terms of service/i.test(t)) && p.goesLive.length === 2, "Check again: an untouched starter still blocks, and it is not in the set", { returns: lv(p, "returns").level, goesLive: p.goesLive.map((t) => t.slice(0, 40)) });
  drill.check(p.open?.disabled === true && lv(p, "privacy").level === "block", "Check again: Open still disabled (privacy is missing too)", { open: p.open, privacy: lv(p, "privacy").level });

  // ---- 4. I've read it (returns) ----
  p = await panelButton(page, "I've read it", { within: "returns" });
  const t2 = await docOf(terms.id);
  drill.check(lv(p, "returns").level === "info" && /goes live too/.test(lv(p, "returns").text) && t2.updated_by !== "system:policy-starter", "\"I've read it\": returns turns to 'goes live too' (the founder's now)", { returns: lv(p, "returns"), updated_by: t2.updated_by });
  drill.check(p.goesLive.some((t) => /Terms of service/i.test(t)), "the read returns page is now in the set", p.goesLive.map((t) => t.slice(0, 40)));
  drill.check(p.open?.disabled === true && lv(p, "privacy").level === "block", "returns read but privacy missing: Open still disabled", { open: p.open, privacy: lv(p, "privacy").level });
  drill.check((await liveRelease()) == null, "still nothing live", null);
  await drill.screenshot(page, "c-panel-returns-read-1440");

  // ---- 5. Start a privacy page, change one sentence, save ----
  p = await panelButton(page, "Start a privacy page", { within: "privacy" });
  const priv = (await policyDocs()).privacy;
  drill.check(priv && priv.updated_by === "system:policy-starter" && !priv.published_version_id && lv(p, "privacy").level === "block" && p.open?.disabled === true, "'Start a privacy page' makes a starter draft; privacy still blocks until it is read or saved; Open disabled", { priv, privacy: lv(p, "privacy"), open: p.open });
  const edited = await changeOneSentence(reader, priv.id, NEW_SENTENCE);
  drill.check(Boolean(edited.saved), "the founder opens the privacy page, changes one sentence and the editor saves it", { before: edited.before, after: NEW_SENTENCE, updated_by: edited.saved?.updated_by });
  await drill.screenshot(reader, "c-privacy-edited-1440");

  // ---- 6. Check again: both in, Open only now ----
  await page.bringToFront();
  p = await panelButton(page, "Check again");
  drill.check(lv(p, "privacy").level === "info" && /goes live too/.test(lv(p, "privacy").text), "Check again: privacy is 'goes live too'", lv(p, "privacy"));
  drill.check(p.goesLive.some((t) => /Terms of service/i.test(t)) && p.goesLive.some((t) => /Privacy/i.test(t)) && p.goesLive.length === 4, "both policy pages are in the set (home, design, privacy, terms)", p.goesLive.map((t) => t.slice(0, 40)));
  drill.check(p.open && p.open.disabled === false && p.open.text === "Open my store anyway", "only now is Open enabled ('Open my store anyway': the test order and contact still warn)", p.open);
  await drill.screenshot(page, "c-panel-both-ready-1440");

  // ---- 7. A cash on delivery test order in the preview, cancelled at once ----
  await noRealKeys(drill);
  const handle = await inStockHandle();
  const ord = await placeTestOrder(drill, ctx, { handle, shotPrefix: "c-test-order" });
  drill.check(Boolean(ord.orderId) && (ord.codValue == null || ord.codValue === "cod"), `a cash on delivery order placed in the founder's preview (${handle}); no card details entered`, { orderId: ord.orderId, cod: ord.codValue });
  let order = ord.orderId ? await orderRow(ord.orderId) : null;
  drill.check(order && order.email === TEST_ORDER_EMAIL && order.payment_method === "cod", `the order is to ${TEST_ORDER_EMAIL}, cash on delivery`, order);
  // its Shopify push runs right after the order (after()); the blank keys stop it before any request
  const pushed = await waitFor(async () => {
    const o = await orderRow(ord.orderId);
    return o && Number(o.sync_attempts) >= 1 ? o : false;
  }, 30_000, 500);
  const cancel = await cancelOrder(page, ord.orderId);
  order = await orderRow(ord.orderId);
  drill.check(Boolean(pushed) && /not configured|No SHOPIFY_ADMIN_TOKEN/i.test(String(pushed.sync_error)) && !pushed.shopify_order_id, "the order's Shopify push (draftOrderCreate) failed harmlessly: the blank keys stop it before any request, no Shopify order id", pushed ? { status: pushed.status, sync_attempts: pushed.sync_attempts, sync_error: String(pushed.sync_error).slice(0, 160), shopify_order_id: pushed.shopify_order_id } : null);
  drill.check(cancel.status === 200 && order?.status === "cancelled", "the test order is cancelled at once", { cancel: cancel.status, status: order?.status });
  drill.note(`test order ${ord.orderId} (${TEST_ORDER_EMAIL}, cash on delivery) placed in the preview and cancelled: ${order?.status}`);
  await ord.page.close();
  await page.bringToFront();
  p = await panelButton(page, "Check again");
  drill.check(lv(p, "test_order").level === "ok", "Check again: the test order is done", lv(p, "test_order"));
  await drill.screenshot(page, "c-panel-before-open-1440");

  // ---- 8. Open my store anyway ----
  const openText = p.open?.text;
  await page.locator("[data-publish] button[data-open-store]").click();
  await waitFor(async () => ["done", "refused", "error", "blocked", "conflict"].includes(await page.locator("[data-publish][data-phase]").first().getAttribute("data-phase").catch(() => "")), 90_000, 400);
  await sleep(800);
  const done = await page.locator("[data-publish][data-phase]").first().getAttribute("data-phase");
  const rel = await liveRelease();
  const docs = await docsOf();
  const live = Object.fromEntries(docs.map((d) => [d.id, Boolean(d.published_version_id)]));
  drill.check(done === "done" && Boolean(rel), `'${openText}': the store is live (a release)`, { phase: done, release: rel });
  const pol = await policyDocs();
  drill.check(live.doc_home && live.doc_design && live[pol.privacy.id] && live[pol.returns.id], "home, design, privacy and terms all went live together", live);
  await drill.screenshot(page, "c-panel-opened-1440");

  const look = await shopperLook(drill, { tag: "c" });
  drill.check(!look.text.includes("Opening soon") && look.text.includes(P6_STORE.name), "a shopper now sees the store, not the closed page", look.text.slice(0, 160));
  drill.check(look.vars["--accent-500"].toLowerCase() === "#334155" && !(await isLime(look.vars["--accent-500"])), "the live accent is Slate (#334155) in the computed CSS variables, not lime", look.vars);
  drill.check(look.logo.header.length >= 1 && look.logo.header.every((i) => i.src === logoSrc && i.alt === P6_STORE.name && i.ok) && look.logo.footer.length >= 1 && look.logo.footer.every((i) => i.src === logoSrc && i.alt === P6_STORE.name && i.ok), "the logo shows in the live header and footer (alt = the store name)", { header: look.logo.header, footer: look.logo.footer });
  for (const d of [pol.privacy, pol.returns]) {
    const path = livePath("page", { slug: d.slug });
    const r = await look.page.goto(p6Url(drill, path), { waitUntil: "load", timeout: 120_000 });
    await settle(look.page);
    const t = (await look.page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
    const want = d === pol.privacy ? NEW_SENTENCE : `within ${P6_RETURNS_DAYS} days of your order`;
    drill.check(r?.status() === 200 && t.includes(want), `${d.label} is live at ${path} with the founder's text`, { status: r?.status(), has: t.includes(want) });
    await drill.screenshot(look.page, `c-live-${d.slug}-1440`);
  }
  // linked from checkout (a shopper with something in the cart)
  await look.page.goto(p6Url(drill, `/products/${handle}`), { waitUntil: "load", timeout: 120_000 });
  await settle(look.page);
  await noThanks(look.page);
  await look.page.getByRole("button", { name: /^Add to cart/ }).first().click();
  await waitFor(async () => ((await look.page.evaluate(async () => (await fetch("/api/cart")).json()).catch(() => null))?.items || []).length > 0, 30_000);
  await look.page.goto(p6Url(drill, "/checkout"), { waitUntil: "load", timeout: 120_000 });
  await settle(look.page);
  const links = await look.page.evaluate(() => [...document.querySelectorAll("a")].map((a) => [a.innerText.trim(), a.getAttribute("href")]).filter(([, h]) => /^\/policies\//.test(h || "")));
  const hrefs = links.map(([, h]) => h);
  drill.check(hrefs.includes(`/policies/${pol.privacy.slug}`) && hrefs.includes(`/policies/${pol.returns.slug}`), "checkout links both live policy pages", links);
  await drill.screenshot(look.page, "c-live-checkout-links-1440");
  await look.ctx.close();
  drill.check(errors.length === 0, "no page errors in the console pages", errors);
  drill.note(`seed: ${JSON.stringify(seed.state)}`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// stage D: checkout off
// ---------------------------------------------------------------------------
export async function paymentStage(drill) {
  const seed = await reseedP6(drill, "d");
  const cfg0 = await tenantConfig();
  const pol0 = await policyDocs();
  drill.check(cfg0?.checkout_mode === "disabled" && pol0.privacy && pol0.returns && pol0.privacy.updated_by !== "system:policy-starter" && pol0.returns.updated_by !== "system:policy-starter", "the stage seed: checkout off, and a privacy page and a terms page the founder has saved", { checkout: cfg0?.checkout_mode, privacy: pol0.privacy?.updated_by, returns: pol0.returns?.updated_by, policies: seed.policies });
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  await openStart(drill, page);
  await openEditor(page, "?doc=doc_home");
  let p = await pressPublish(page);
  const pay = lv(p, "payment");
  const blocks = p.items.filter((i) => i.level === "block").map((i) => i.id);
  drill.check(p.phase === "opening" && pay.level === "block" && /Checkout is turned off/.test(pay.text) && pay.link === "/admin/settings#commerce" && pay.linkText === "Open Settings", "checkout off: the panel shows the payment block with 'Open Settings' to /admin/settings#commerce", pay);
  drill.check(blocks.length === 1 && blocks[0] === "payment" && lv(p, "privacy").level === "info" && lv(p, "returns").level === "info", "payment is the only block (the saved policy pages go live too)", levels(p));
  drill.check(p.open?.disabled === true, "Open can't be pressed while checkout is off", p.open);
  await drill.screenshot(page, "d-panel-checkout-off-1440");
  // the server refuses too, whatever the button: a direct open with confirmOpen
  const home = await docOf("doc_home");
  const direct = await docsApi(page, { publish: { id: "doc_home", draftHash: home.draft_hash }, revision: home.revision, checkOpening: true, confirmOpen: true });
  drill.check(direct.status === 409 && direct.body?.code === "STORE_CANNOT_TAKE_PAYMENT" && (await liveRelease()) == null, "a direct open (checkOpening and confirmOpen) is refused: 409 STORE_CANNOT_TAKE_PAYMENT, nothing live", { status: direct.status, code: direct.body?.code, message: direct.body?.error || direct.body?.message });

  // turn checkout on in Settings (a second tab: the panel stays)
  const s = await ctx.newPage();
  await s.goto(p6Url(drill, pay.link), { waitUntil: "load", timeout: 120_000 });
  await settle(s);
  await s.locator("#sa-checkout-mode").selectOption("direct");
  await s.getByRole("button", { name: "Save settings" }).first().click();
  const on = await waitFor(async () => (await tenantConfig())?.checkout_mode === "direct", 30_000, 300);
  drill.check(Boolean(on), "Settings > Commerce: checkout mode set to direct and saved", (await tenantConfig())?.checkout_mode);
  await drill.screenshot(s, "d-settings-checkout-on-1440");
  await s.close();
  await sleep(2500); // the store's settings cache (PLATFORM_CACHE_MS)

  await page.bringToFront();
  p = await waitFor(async () => {
    const r = await panelButton(page, "Check again");
    return lv(r, "payment").level !== "block" ? r : false;
  }, 40_000, 2000);
  p = p || (await readOpening(page));
  drill.check(lv(p, "payment").level === "info" && /cash on delivery/i.test(lv(p, "payment").text) && p.open?.disabled === false, "Check again: payment is 'Cash on delivery only' (no Razorpay keys), and Open is enabled", { payment: lv(p, "payment"), open: p.open });
  await drill.screenshot(page, "d-panel-checkout-on-1440");
  await page.locator("[data-publish] button[data-open-store]").click();
  await waitFor(async () => ["done", "refused", "error", "blocked", "conflict"].includes(await page.locator("[data-publish][data-phase]").first().getAttribute("data-phase").catch(() => "")), 90_000, 400);
  const phase = await page.locator("[data-publish][data-phase]").first().getAttribute("data-phase");
  drill.check(phase === "done" && Boolean(await liveRelease()), "open: the store is live", { phase });
  const look = await shopperLook(drill, { tag: "d" });
  drill.check(!look.text.includes("Opening soon") && !(await isLime(look.vars["--accent-500"])), "a shopper sees the open store, not lime", look.vars);
  await look.ctx.close();
  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
