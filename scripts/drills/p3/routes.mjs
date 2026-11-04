// P3-ROUTES drill (ED-02, PUB-11, PV-01): the new editor's address, the old
// screens that send a documents store to it, the console nav, and the legacy
// store left as it was, in desktop Chrome on the design harness.
//
//   DESIGN_PORT=6180 DESIGN_SQLD_PORT=7180 node scripts/drills/p3/routes.mjs [--headed]
//
// 1. documents: the phase 3 seed (a documents store). Signed in as the owner,
//    each old screen lands on /admin/editor at its document, the Designer
//    included; the sidebar has one Editor link and none of the old ones;
//    ?path= opens the document at a store address, an unknown one opens home
//    with a note.
// 2. migrating: the same store with cms_state set to migrating (the local
//    harness database only). No redirects, and /admin/editor is a read-only note.
// 3. legacy: the fresh perf seed (a legacy store, its setup password). Every
//    old screen stays where it is, the sidebar is the old one, /admin/editor
//    points at the Designer, and the Designer says so when a preview push fails.
// Results: docs/cms-reviews/drills/P3-ROUTES/results-routes.json, with screenshots.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ROOT, readCredentials } from "../../design-harness.js";
import { DrillError, reseed, runDrill, runNode, settle, startOwned, stopOwned, storeSql } from "./lib.mjs";

const ROUTES = {
  "/admin/storefront": "doc_home",
  "/admin/storefront/designer": "doc_home",
  "/admin/storefront/home": "doc_home",
  "/admin/storefront/navigation": "doc_header",
  "/admin/storefront/pages": "doc_home",
  "/admin/storefront/product-pages": "doc_product_layout",
  "/admin/brand": "doc_design",
  "/admin/theme": "doc_design",
};
const OLD_LINKS = ["/admin/storefront", "/admin/storefront/home", "/admin/storefront/designer", "/admin/storefront/pages", "/admin/storefront/navigation", "/admin/storefront/product-pages", "/admin/theme", "/admin/brand"];

const sidebarLinks = (page) =>
  page.evaluate(() => [...document.querySelectorAll('aside nav[aria-label="Console"] a')].map((a) => new URL(a.href).pathname + new URL(a.href).search));
const where = (page) => {
  const u = new URL(page.url());
  return u.pathname + u.search;
};
const editorFacts = (page) =>
  page.evaluate(() => ({
    editor: !!document.querySelector("[data-document-editor]"),
    doc: document.querySelector("[data-document-editor]")?.getAttribute("data-doc") ?? null,
    label: document.querySelector("[data-document-label]")?.textContent?.trim() ?? null,
    note: document.querySelector("[data-editor-note]")?.getAttribute("data-editor-note") ?? null,
    designerLink: !!document.querySelector('[data-editor-note] a[href="/admin/storefront/designer"]'),
    text: document.body.innerText.slice(0, 1500),
  }));

async function documentsPart(drill) {
  const { seed } = await reseed(drill);
  const [mode] = await storeSql("tenant", ["SELECT mode FROM cms_state WHERE id = 1"]);
  drill.check(mode.rows[0]?.mode === "documents", "the phase 3 seed's store is in documents mode", mode.rows[0]?.mode);
  const ctx = await drill.context();
  const clicks = await drill.clickCounter(ctx); // one counter per context
  const page = await drill.login("owner", { context: ctx });

  for (const [route, doc] of Object.entries(ROUTES)) {
    const res = await page.goto(route, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    const f = await editorFacts(page);
    drill.check(res?.status() === 200 && where(page) === `/admin/editor?doc=${doc}` && f.editor && f.doc === doc && !!f.label, `documents: ${route} lands on the editor at ${doc}`, { status: res?.status(), at: where(page), doc: f.doc, label: f.label });
  }
  await page.goto("/admin/storefront/designer", { waitUntil: "load" });
  await settle(page);
  // P3-DRILLS (P3-EDITOR review): the new editor has its own preview frame
  // ([data-preview-frame]); the check is about the Designer's frame only, the
  // one outside the new editor (the Designer's has no data-preview-frame)
  const d = await page.evaluate(() => ({
    legacyFrames: [...document.querySelectorAll("iframe")].filter((f) => !f.hasAttribute("data-preview-frame") && !f.closest("[data-document-editor]")).length,
    editorFrames: document.querySelectorAll("[data-document-editor] iframe[data-preview-frame]").length,
    shell: !!document.querySelector("[data-editor-shell]"),
    editor: !!document.querySelector("[data-document-editor]"),
  }));
  drill.check(where(page) === "/admin/editor?doc=doc_home" && d.legacyFrames === 0 && !d.shell && d.editor, "documents: the Designer is never reached (finding 2): no Designer shell, no legacy preview frame (the new editor's own frame aside)", { at: where(page), ...d });
  await drill.screenshot(page, "documents-designer-redirect-1440");

  // the nav, then a real click on it
  await page.goto("/admin/dashboard", { waitUntil: "load" });
  await settle(page);
  const links = await sidebarLinks(page);
  drill.check(links.includes("/admin/editor") && OLD_LINKS.every((l) => !links.includes(l)) && links.includes("/admin/media") && links.includes("/admin/releases"), "documents: the sidebar has one Editor link, Media and Publishing, and none of the old screens", links);
  const m = clicks.mark();
  await page.locator('aside nav[aria-label="Console"] a[href="/admin/editor"]').click();
  await page.waitForURL(/\/admin\/editor/, { timeout: 30_000 });
  await settle(page);
  const home = await editorFacts(page);
  const current = await page.locator('aside nav[aria-label="Console"] a[href="/admin/editor"]').getAttribute("aria-current");
  drill.check(clicks.since(m) === 1 && home.editor && home.doc === "doc_home" && current === "page", "documents: one click on Editor opens the home page, and Editor is the current item", { clicks: clicks.since(m), doc: home.doc, current });
  await drill.screenshot(page, "documents-editor-home-1440");

  // ?path= (PUB-11's "Edit this page")
  const camp = seed.documents.liveCampaign;
  await page.goto(`/admin/editor?path=${encodeURIComponent(camp.path)}`, { waitUntil: "load" });
  await settle(page);
  const c = await editorFacts(page);
  drill.check(c.doc === camp.id && c.label === camp.label && !/Nothing on your store lives/.test(c.text), `documents: ?path=${camp.path} opens that campaign`, { doc: c.doc, label: c.label, want: camp.id });
  await page.goto("/admin/editor?path=/campaigns/no-such-page", { waitUntil: "load" });
  await settle(page);
  const lost = await editorFacts(page);
  drill.check(lost.doc === "doc_home" && /Nothing on your store lives at \/campaigns\/no-such-page yet, so the editor opened your home page/.test(lost.text), "documents: an unknown address opens home with a note that says so", { doc: lost.doc, text: lost.text.slice(0, 300) });
  await drill.screenshot(page, "documents-unknown-path-1440");

  // migrating: the same store, the local harness database only
  await storeSql("tenant", ["UPDATE cms_state SET mode = 'migrating' WHERE id = 1"]);
  try {
    for (const route of ["/admin/storefront/designer", "/admin/brand"]) {
      const res = await page.goto(route, { waitUntil: "load", timeout: 120_000 });
      await settle(page);
      drill.check(res?.status() === 200 && where(page) === route, `migrating: ${route} stays where it is (no redirect)`, { status: res?.status(), at: where(page) });
    }
    await page.goto("/admin/editor", { waitUntil: "load" });
    await settle(page);
    const mig = await editorFacts(page);
    drill.check(mig.note === "migrating" && !mig.editor && /nothing can be changed/.test(mig.text), "migrating: /admin/editor is a read-only note", { note: mig.note, editor: mig.editor });
    const links2 = await sidebarLinks(page);
    drill.check(!links2.includes("/admin/editor") && OLD_LINKS.every((l) => links2.includes(l)), "migrating: the sidebar is the old one", links2);
    await drill.screenshot(page, "migrating-editor-note-1440");
  } finally {
    await storeSql("tenant", ["UPDATE cms_state SET mode = 'documents' WHERE id = 1"]);
  }
  await ctx.close();
}

async function legacyPart(drill) {
  await stopOwned();
  const r = await runNode([join(ROOT, "scripts", "dev-design.js"), "seed", "--fixture", "perf"]);
  if (r.code !== 0) throw new DrillError(`the legacy seed failed: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
  drill.note("re-seeded fresh: the perf seed alone (a legacy store)");
  await startOwned();
  const [mode] = await storeSql("tenant", ["SELECT mode FROM cms_state WHERE id = 1"]).catch(() => [{ rows: [] }]);
  drill.check((mode.rows[0]?.mode ?? "legacy") === "legacy", "the perf seed's store is legacy", mode.rows[0]?.mode ?? "(no row)");

  const ctx = await drill.context();
  await drill.clickCounter(ctx); // one counter per context
  // a legacy store has no members: the setup password, as smoke.mjs and drill.js sign in
  const page = await ctx.newPage();
  await page.goto("/admin/login");
  await page.locator("#login-password").fill(readCredentials(ROOT).DESIGN_ADMIN_PASSWORD || "");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/admin\/dashboard/, { timeout: 30_000 }).catch(() => {
    throw new DrillError("Signing in to the legacy store didn't reach the dashboard.");
  });

  for (const route of Object.keys(ROUTES)) {
    const res = await page.goto(route, { waitUntil: "load", timeout: 120_000 });
    await settle(page);
    const f = await editorFacts(page);
    drill.check(res?.status() === 200 && where(page) === route && !f.editor && !/This page hit an error/.test(f.text), `legacy: ${route} renders where it is, as before`, { status: res?.status(), at: where(page) });
  }
  const links = await sidebarLinks(page);
  drill.check(OLD_LINKS.every((l) => links.includes(l)) && !links.includes("/admin/editor"), "legacy: the sidebar is the old one, with no Editor link", links);

  await page.goto("/admin/editor", { waitUntil: "load" });
  await settle(page);
  const e = await editorFacts(page);
  drill.check(e.note === "legacy" && e.designerLink && !e.editor, "legacy: /admin/editor is a note that links to the Designer", { note: e.note, link: e.designerLink });
  await drill.screenshot(page, "legacy-editor-note-1440");

  // PV-01: the Designer says when a preview push fails
  await page.goto("/admin/storefront/designer", { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.waitForFunction(() => /Preview shows your last save/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
  let failing = true;
  let pushes = 0;
  await page.route("**/api/admin/storefront", async (route) => {
    const req = route.request();
    if (req.method() !== "PUT" || !String(req.postData() || "").includes('"previewCandidate"')) return route.continue();
    pushes++;
    if (!failing) return route.continue();
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "We couldn't reach the database, so nothing was saved.", code: "DB_UNAVAILABLE" }) });
  });
  await page.locator('button[data-tree-pick]', { hasText: "Hero" }).first().click();
  const title = page.locator("#ins-hero-title");
  await title.fill(`${await title.inputValue()} (drill)`);
  const shown = await page
    // P3-DRILLS: since P3-FIX3 a 5xx keeps the server's own plain words,
    // worded for a preview ("We couldn't reach the database, so the preview
    // didn't update."), instead of "Something went wrong on our side (error 503)"
    .waitForFunction(() => /The preview didn.t update/.test(document.body.innerText) && /We couldn.t reach the database, so the preview didn.t update\. The preview still shows an earlier version/.test(document.body.innerText), null, { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const status = await page.locator('[data-editor-pane="preview"] [role="status"]').first().innerText().catch(() => "");
  drill.check(shown && pushes > 0 && !/UNSAVED edits/.test(status), "legacy: a failed preview push shows a plain message, and the label no longer says it shows the edits", { pushes, status });
  await drill.screenshot(page, "legacy-designer-push-failed-1440");
  failing = false;
  await title.fill(`${await title.inputValue()}!`);
  const cleared = await page
    .waitForFunction(() => !/The preview didn.t update/.test(document.body.innerText) && /UNSAVED edits/.test(document.body.innerText), null, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  drill.check(cleared, "legacy: the next push that works clears the message", null);
  await page.unroute("**/api/admin/storefront");
  await ctx.close();
}

export async function routes(drill) {
  await documentsPart(drill);
  await legacyPart(drill);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = await runDrill({ id: "P3-ROUTES", part: "routes", title: "P3-ROUTES — the editor's address, the redirects, the nav, legacy unchanged" }, routes);
  process.exit(code);
}
