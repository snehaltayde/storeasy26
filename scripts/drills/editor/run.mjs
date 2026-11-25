// EDITOR: `pnpm drill:editor`, the editor in the new shell in a real browser
// (Phase 2 line 6, docs/plans/phase-2.md "Line 6"; package 6a: the frame, the
// page list and the section tree; 6c adds preview, publish and Undo). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store; never in the owner's checkout.
//   owner: the three panes at 1280, two and the preview toggle at 768, the
//     tabs at 375 (screenshots of each); adds a section from the catalogue
//     and sees "Saved"; moves it, deletes it after the confirm; makes a new
//     page (title and address) from the page list and archives it
//   staff: the tree's add, move, hide, copy and delete are there
//   support: no add, move, hide, copy, delete, New page or Archive; the
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
    if (msg.type() === "error" && !/eval\(\) is not supported/.test(msg.text())) consoleErrors.push(`${role}: ${msg.text().slice(0, 300)}`);
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
  drill.check(opened && (await page.locator("[data-document-label]").innerText()).includes("Drill page"), "New page makes the draft and opens it", page.url());
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

async function staffFlows(drill) {
  const page = await signIn(drill, "staff");
  await openEditor(page);
  const n = { add: await page.locator("[data-tree-add]").count(), ops: await page.locator("[data-section-row] [data-op]").count(), newPage: 0 };
  await page.locator("[data-switcher-toggle]").click();
  n.newPage = await page.locator("[data-new-page-open]").count();
  drill.check(n.add === 1 && n.ops > 0 && n.newPage === 1, "staff: add, the row buttons and New page are there", n);
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
  await staffFlows(drill);
  await supportView(drill);
  drill.check(consoleErrors.length === 0, "no error in the browser console (owner, staff and support)", consoleErrors);
}

runDrill({ id: DRILL_ID, part: "main", title: "EDITOR — the frame, the page list and the tree, every role and width" }, editor).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
