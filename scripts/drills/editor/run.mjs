// EDITOR: `pnpm drill:editor`, the editor in the new shell in a real browser
// (Phase 2 line 6, docs/plans/phase-2.md "Line 6"; package 6a: the frame, the
// page list and the section tree; 6c adds preview, publish and Undo). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store; never in the owner's checkout.
//   owner: the three panes at 1280, two and the preview toggle at 768, the
//     tabs at 375 (screenshots of each); adds a section from the catalogue
//     and sees "Saved"; moves it, deletes it after the confirm; makes a new
//     page (title and address) from the page list and archives it
//   owner (6c): the preview's widths (375, 768, 1280), Show design changes
//     (a preview-session POST), Reload and Open in a new tab; Publish opens
//     the store through "Before you open your store" (start both policy
//     pages, I've read it, Open my store); a second edit is published from
//     the review and undone (the dry run's confirm, then Undo); Publishing
//     lists the waiting pages and the publish with its Undo
//   staff: the tree's add, move, hide, copy and delete are there; the bar
//     and Publishing show the reason and no Publish or Undo
//   support: every inspector field disabled; no add, move, hide, copy,
//     delete, New page or Archive; the
//     page list and the tree still read; every non-GET request is a document
//     read (its single top-level key in the READ_POSTS row's ops) or the
//     preview session, never saveDraft, including on pagehide
// Evidence: docs/cms-reviews/drills/EDITOR/ (results-main.json, screenshots).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { runDrill, settle } from "../p3/lib.mjs";
import { READ_POSTS } from "../../support/read-controls.js";

const DRILL_ID = "EDITOR";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));
const consoleErrors = [];

async function signIn(drill, role, width = 1280) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(30_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    // the roles store's catalog fixture images are not on Shopify's CDN: the
    // preview's next/image requests for them answer 404 (the server logs
    // "upstream image response failed"); nothing else is let through
    const fixtureImage = /status of 404/.test(msg.text()) && /\/_next\/image\?url=https%3A%2F%2Fcdn\.shopify\.com%2Ffixture%2F/.test(msg.location()?.url || "");
    if (msg.type() === "error" && !fixtureImage && !/eval\(\) is not supported/.test(msg.text())) consoleErrors.push(`${role}: ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${role}: ${String(e?.message || e).slice(0, 300)}`));
  return page;
}
const waitFor = (page, fn, arg, ms = 30_000) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
async function openEditor(page, query = "") {
  await page.goto(`${ORIGIN}/admin/editor${query}`, { waitUntil: "load" });
  await settle(page);
  await page.locator("[data-section-tree], [data-inspector]").first().waitFor({ timeout: 30_000 }).catch(() => {});
}
const visiblePanes = (page) => page.evaluate(() => [...document.querySelectorAll("[data-pane]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-pane")));
const saved = (page) => waitFor(page, () => document.querySelector("[data-save-status]")?.getAttribute("data-save-status") === "saved");
const sectionIds = (page) => page.locator("[data-section-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section-row")));

async function ownerFlows(drill) {
  const page = await signIn(drill, "owner");
  await openEditor(page);
  drill.check(JSON.stringify(await visiblePanes(page)) === JSON.stringify(["sections", "edit", "preview"]), "owner at 1280: the sections, settings and preview panes side by side", await visiblePanes(page));
  await drill.shoot(page, "owner-1280");

  // add a section from the catalogue: it is selected and saves
  const before = await sectionIds(page);
  await page.locator("[data-tree-add]").click();
  const kind = await page.locator("[data-tree-picker] button[data-kind]:not([disabled])").first().getAttribute("data-kind");
  await page.locator(`[data-tree-picker] button[data-kind="${kind}"]`).click();
  const added = await waitFor(page, (n) => document.querySelectorAll("[data-section-row]").length === n + 1, before.length);
  const after = await sectionIds(page);
  const newId = after.find((id) => !before.includes(id));
  drill.check(added && newId && (await page.locator(`[data-section-row="${newId}"][data-selected]`).count()) === 1, `owner adds a ${kind} section; it is selected`, { before, after });
  drill.check(await saved(page), "the status line says Saved after the add");

  // move it up, then delete it after the confirm
  const at = (await sectionIds(page)).indexOf(newId);
  const up = page.locator(`[data-section-row="${newId}"] [data-op="moveUp"]`);
  if (at > 0 && (await up.isEnabled())) {
    await up.click();
    drill.check(await waitFor(page, ([id, i]) => [...document.querySelectorAll("[data-section-row]")].map((e) => e.getAttribute("data-section-row")).indexOf(id) === i - 1, [newId, at]), "Move up moves it one place");
    await saved(page);
  }
  await page.locator(`[data-section-row="${newId}"] [data-op="remove"]`).click();
  drill.check((await page.getByText("Delete this section?").count()) === 1 && (await sectionIds(page)).includes(newId), "Delete asks first and removes nothing yet");
  await page.locator(`[data-section-row="${newId}"]`).getByRole("button", { name: "Delete", exact: true }).click();
  drill.check(await waitFor(page, (id) => !document.querySelector(`[data-section-row="${id}"]`), newId), "Delete removes it");
  drill.check(await saved(page), "and saves");

  // keyboard: ArrowDown moves focus to the next row
  await page.locator("[data-tree-select]").first().focus();
  await page.keyboard.press("ArrowDown");
  drill.check(await page.evaluate(() => document.activeElement === document.querySelectorAll("[data-tree-select]")[1]), "ArrowDown moves focus to the next row");

  // a new page from the page list, then archive it
  await page.locator("[data-switcher-toggle]").click();
  drill.check((await page.locator("[data-page-group]").count()) >= 2, "the page list is grouped", await page.locator("[data-page-group]").evaluateAll((e) => e.map((x) => x.getAttribute("data-page-group"))));
  await page.locator("[data-new-page-open]").click();
  await page.locator("#new-page-title").fill("Drill page");
  await page.locator('[data-new-page] button[type="submit"]').click();
  const opened = await page.waitForURL(/\/admin\/editor\?doc=doc_/, { timeout: 30_000 }).then(() => true, () => false);
  const named = opened && (await waitFor(page, () => /Drill page/.test(document.querySelector("[data-document-label]")?.textContent || "")));
  drill.check(named, "New page makes the draft and opens it", { url: page.url(), label: await page.locator("[data-document-label]").innerText().catch(() => null) });
  await settle(page);
  await page.locator("[data-switcher-toggle]").click();
  const id = new URL(page.url()).searchParams.get("doc");
  await page.locator(`[data-archive="${id}"]`).click();
  await page.locator(`[data-page-row="${id}"]`).getByRole("button", { name: "Archive", exact: true }).click();
  drill.check(await page.waitForURL(/doc=doc_home/, { timeout: 30_000 }).then(() => true, () => false), "Archive takes the open page off the list and opens the home page", page.url());
  await page.context().close();

  // the widths
  for (const width of [768, 375]) {
    const p = await signIn(drill, "owner", width);
    await openEditor(p);
    const panes = await visiblePanes(p);
    if (width === 768) {
      drill.check(JSON.stringify(panes) === JSON.stringify(["sections", "edit"]) && (await p.locator("[data-tablet-preview]").isVisible()), "owner at 768: sections and settings, the preview behind a toggle", panes);
      await p.locator("[data-tablet-preview]").click();
      drill.check(JSON.stringify(await visiblePanes(p)) === JSON.stringify(["sections", "preview"]), "the toggle shows the preview in place of the settings", await visiblePanes(p));
    } else {
      drill.check(JSON.stringify(panes) === JSON.stringify(["edit"]) && (await p.locator("[data-editor-tabs]").isVisible()), "owner at 375: one pane and the Sections, Edit, Preview tabs", panes);
      await p.locator('[data-pane-tab="sections"]').click();
      drill.check(JSON.stringify(await visiblePanes(p)) === JSON.stringify(["sections"]), "the Sections tab shows the tree", await visiblePanes(p));
    }
    await drill.shoot(p, `owner-${width}`);
    await p.context().close();
  }
}

// ---- 6c: preview, publish and Undo ----
const phaseOf = (page) => page.locator("[data-editor-actions] [data-publish][data-phase]").first().getAttribute("data-phase").catch(() => null);
async function panelSettled(page, ms = 60_000) {
  await page.waitForTimeout(400);
  await waitFor(page, () => {
    const p = document.querySelector("[data-editor-actions] [data-publish][data-phase]");
    const ph = p?.getAttribute("data-phase");
    return Boolean(p && ph && ph !== "checking" && !p.querySelector("button[aria-busy='true']"));
  }, undefined, ms);
  await page.waitForTimeout(400);
}
const previewShown = (page) => waitFor(page, () => document.querySelector("[data-preview-pane]")?.getAttribute("data-preview-phase") === "shown", undefined, 90_000);
async function addSection(page) {
  const before = await sectionIds(page);
  await page.locator("[data-tree-add]").click();
  const kind = await page.locator("[data-tree-picker] button[data-kind]:not([disabled])").first().getAttribute("data-kind");
  await page.locator(`[data-tree-picker] button[data-kind="${kind}"]`).click();
  await waitFor(page, (n) => document.querySelectorAll("[data-section-row]").length === n + 1, before.length);
  return saved(page);
}

async function ownerPreview(drill, page) {
  drill.check(await previewShown(page), "owner: the preview shows the page", await page.locator("[data-preview-pane]").getAttribute("data-preview-log"));
  const frameWidth = () => page.locator("[data-preview-frame]").evaluate((f) => Math.round(f.getBoundingClientRect().width));
  const widths = {};
  for (const d of ["phone", "tablet", "desktop"]) {
    await page.locator(`[data-preview-bar] [data-device="${d}"]`).click();
    await page.waitForTimeout(200);
    widths[d] = await frameWidth();
  }
  drill.check(widths.phone === 375 && widths.tablet === 768 && widths.desktop > 375, "the widths: the frame is 375 and 768 wide, then the pane's width on desktop", widths);
  await page.locator('[data-preview-bar] [data-device="phone"]').click();
  await drill.shoot(page, "owner-preview-phone-1280");
  await page.locator('[data-preview-bar] [data-device="desktop"]').click();
  // the frame keeps the storefront's own styles (its stylesheet, not the console's)
  const styled = await page.locator("[data-preview-frame]").evaluate((f) => {
    const d = f.contentDocument;
    return d ? { sheets: d.styleSheets.length, console: Boolean(d.querySelector("[data-console-notices], [data-slot='sidebar']")) } : null;
  });
  drill.check(styled && styled.sheets > 0 && !styled.console, "the frame is the store's own page, with its stylesheets", styled);
  const design = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/admin/preview-session" && /showDesign/.test(r.postData() || ""), { timeout: 15_000 }).then(() => true, () => false);
  await page.locator("[data-preview-bar] [data-show-design]").click();
  drill.check(await design, "Show design changes asks the preview session to show the design draft");
  drill.check(await previewShown(page), "and the preview shows again");
  await page.locator("[data-preview-bar] [data-show-design]").click();
  const reloaded = page.waitForEvent("framenavigated", { predicate: (f) => f !== page.mainFrame(), timeout: 15_000 }).then(() => true, () => false);
  await page.locator("[data-preview-reload]").click();
  drill.check(await reloaded, "Reload loads the frame again");
  await previewShown(page);
  const [tab] = await Promise.all([page.context().waitForEvent("page", { timeout: 15_000 }).catch(() => null), page.locator("[data-preview-open]").click()]);
  if (tab) await tab.waitForLoadState("load").catch(() => {});
  drill.check(Boolean(tab) && new URL(tab.url()).origin === ORIGIN && !/\/admin\//.test(tab.url()), "Open in a new tab opens the store page in a tab of its own", tab?.url());
  await tab?.close();
}

async function ownerPublish(drill, page) {
  // the store is closed: the first Publish is "Before you open your store"
  await page.locator("[data-editor-actions] [data-publish] button", { hasText: /^Publish$/ }).click();
  await panelSettled(page);
  let phase = await phaseOf(page);
  for (let i = 0; i < 8 && phase === "opening"; i++) {
    const open = page.locator("[data-publish] button[data-open-store]");
    if ((await open.count()) && (await open.isEnabled())) break;
    const step = page.locator("[data-publish] [data-opening-item] button", { hasText: /^(Start a (returns|privacy) page|I've read it)$/ }).first();
    if (!(await step.count())) break;
    await step.click();
    await panelSettled(page);
    phase = await phaseOf(page);
  }
  await drill.shoot(page, "owner-opening-1280");
  if (phase === "opening") {
    await page.locator("[data-publish] button[data-open-store]").click();
    await panelSettled(page, 90_000);
  } else if (phase === "review") {
    await page.locator("[data-publish] button", { hasText: /^Publish$/ }).last().click();
    await panelSettled(page, 90_000);
  }
  const first = await phaseOf(page);
  drill.check(first === "done", "owner: Publish opens the store (the policy pages started and read, then Open my store)", { first, text: (await page.locator("[data-editor-actions] [data-publish]").first().innerText().catch(() => "")).slice(0, 400) });
  await page.locator("[data-publish] button", { hasText: /^Close$/ }).first().click().catch(() => {});

  // a second change, published from the review, then undone
  drill.check(await addSection(page), "owner adds a section after the store opened; it saves");
  await page.locator("[data-editor-actions] [data-publish] button", { hasText: /^Publish$/ }).click();
  await panelSettled(page);
  drill.check((await phaseOf(page)) === "review", "Publish shows what will go live", await phaseOf(page));
  await drill.shoot(page, "owner-review-1280");
  await page.locator("[data-publish] button", { hasText: /^Publish$/ }).last().click();
  await panelSettled(page, 90_000);
  drill.check((await phaseOf(page)) === "done" && (await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).count()) === 1, "it goes live, and the answer offers Undo", await phaseOf(page));
  await page.locator("[data-publish] [data-undo] button", { hasText: /^Undo$/ }).click();
  const confirm = await waitFor(page, () => [...document.querySelectorAll("[data-publish] [data-undo] button")].some((b) => b.innerText.trim() === "Undo" && b.closest("[data-undo-confirm], [data-take-offline-confirm]")));
  drill.check(confirm, "Undo asks first, with what will change");
  await drill.shoot(page, "owner-undo-confirm-1280");
  await page.locator("[data-publish] [data-undo] [data-undo-confirm] button, [data-publish] [data-undo] [data-take-offline-confirm] button").filter({ hasText: /^Undo$/ }).first().click();
  const undone = await waitFor(page, () => Boolean(document.querySelector("[data-publish] [data-undo] [role='status']")) && !document.querySelector("[data-publish] [data-undo] button[aria-busy='true']"), undefined, 60_000);
  drill.check(undone, "Undo puts the page back and says so", (await page.locator("[data-publish] [data-undo]").first().innerText().catch(() => "")).slice(0, 300));
  await page.locator("[data-publish] button", { hasText: /^Close$/ }).first().click().catch(() => {});
}

async function ownerPublishing(drill) {
  const page = await signIn(drill, "owner");
  await page.goto(`${ORIGIN}/admin/releases`, { waitUntil: "load" });
  await settle(page);
  await page.locator("[data-recently-published], [data-history-loading]").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await waitFor(page, () => !document.querySelector("[data-history-loading]"));
  const rows = await page.locator("[data-recently-published] [data-row]").count();
  drill.check(rows >= 2 && (await page.locator("[data-publishing-page] h2", { hasText: "Waiting to publish" }).count()) === 1, "Publishing: Waiting to publish, and what was published (the opening, the publish and its Undo)", { rows });
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await drill.shoot(page, `owner-publishing-${width}`);
  }
  await page.context().close();
}

async function staffFlows(drill) {
  const page = await signIn(drill, "staff");
  await openEditor(page);
  const n = { add: await page.locator("[data-tree-add]").count(), ops: await page.locator("[data-section-row] [data-op]").count(), newPage: 0 };
  await page.locator("[data-switcher-toggle]").click();
  n.newPage = await page.locator("[data-new-page-open]").count();
  drill.check(n.add === 1 && n.ops > 0 && n.newPage === 1, "staff: add, the row buttons and New page are there", n);
  await page.locator("[data-switcher-toggle]").click();
  const bar = { publish: await page.locator("[data-editor-actions] button", { hasText: /^(Publish|Take this page offline|Undo)$/ }).count(), reason: (await page.locator("[data-publish-reason]").innerText().catch(() => "")).trim() };
  drill.check(bar.publish === 0 && /owner or an admin/.test(bar.reason), "staff: the bar shows the reason, and no Publish, Take offline or Undo", bar);
  await drill.shoot(page, "staff-1280");
  await page.goto(`${ORIGIN}/admin/releases`, { waitUntil: "load" });
  await settle(page);
  await waitFor(page, () => !document.querySelector("[data-history-loading]"));
  const pub = { buttons: await page.locator("main [data-publishing-page] button", { hasText: /^(Publish selected|Undo|Undo all \d+)/ }).count(), boxes: await page.locator("[data-waiting-select]").count(), reasons: await page.locator("[data-publish-reason], [data-undo-reason]").count() };
  drill.check(pub.buttons === 0 && pub.boxes === 0 && pub.reasons > 0, "staff on Publishing: the reason, no Publish selected, no boxes, no Undo", pub);
  await page.context().close();
}

const READ_OPS = new Set(READ_POSTS.filter((r) => r.page === "/admin/editor" && Array.isArray(r.ops)).flatMap((r) => r.ops));
async function supportView(drill) {
  const page = await signIn(drill, "support");
  const writes = [];
  page.context().on("request", (req) => {
    const m = req.method();
    const path = new URL(req.url()).pathname;
    if (m === "GET" || m === "HEAD" || path.startsWith("/__nextjs")) return;
    let op = null;
    try {
      const keys = Object.keys(JSON.parse(req.postData() || ""));
      op = keys.length === 1 ? keys[0] : `several: ${keys.join(",")}`;
    } catch {
      op = "unreadable";
    }
    if (path === "/api/admin/documents" && m === "PUT" && READ_OPS.has(op)) return;
    if (path === "/api/admin/preview-session" && m === "POST") return;
    writes.push(`${m} ${path} ${op}`);
  });
  await openEditor(page);
  const sees = {
    add: await page.locator("[data-tree-add]").count(),
    ops: await page.locator("[data-section-row] [data-op]").count(),
    rows: await page.locator("[data-section-row]").count(),
  };
  await page.locator("[data-switcher-toggle]").click();
  Object.assign(sees, { newPage: await page.locator("[data-new-page-open]").count(), archive: await page.locator("[data-archive]").count(), groups: await page.locator("[data-page-group]").count() });
  drill.check(sees.add === 0 && sees.ops === 0 && sees.newPage === 0 && sees.archive === 0 && sees.rows > 0 && sees.groups > 0, "support: no add, move, hide, copy, delete, New page or Archive; the tree and the page list read", sees);
  await drill.shoot(page, "support-1280");
  // the reads still work: open the page list's first other page, select a row
  await page.locator("[data-switcher-toggle]").click();
  const row = page.locator("[data-tree-select]").first();
  if (await row.count()) await row.click();
  const enabledFields = await page.locator("[data-inspector] input:not([disabled]), [data-inspector] textarea:not([disabled]), [data-inspector] select:not([disabled])").count();
  drill.check(enabledFields === 0 && (await page.locator("[data-inspector] input, [data-inspector] textarea, [data-inspector] select").count()) > 0, "support's inspector: every field is disabled (6b)", { enabledFields });
  // try to type into the first enabled field, then leave (pagehide)
  const field = page.locator("[data-inspector] input:not([disabled]), [data-inspector] textarea:not([disabled])").first();
  if (await field.count()) await field.fill("support typed this").catch(() => {});
  await page.waitForTimeout(1500);
  await page.goto(`${ORIGIN}/admin/dashboard`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  drill.check(writes.length === 0, "support never sends saveDraft or any other write (pagehide included); only document reads and the preview session", writes);
  await page.context().close();
}

async function editor(drill) {
  if (!port) throw new Error("drill:editor needs ROLES_PORT (run it as pnpm drill:editor).");
  await ownerFlows(drill);
  {
    const page = await signIn(drill, "owner");
    await openEditor(page);
    await ownerPreview(drill, page);
    await ownerPublish(drill, page);
    await page.context().close();
  }
  await ownerPublishing(drill);
  await staffFlows(drill);
  await supportView(drill);
  drill.check(consoleErrors.length === 0, "no error in the browser console (owner, staff and support)", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "EDITOR — the frame, the page list, the tree, preview, publish and Undo, every role and width" }, editor).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
