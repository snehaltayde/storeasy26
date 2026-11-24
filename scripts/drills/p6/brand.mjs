// P6-DRILLS stage B (GEN-04; owner answer OQ-P6-8): the brand step. Forest,
// a PNG logo uploaded through the MediaPicker with its alt left empty, and a
// description; the preview shows the logo (alt = the store name) in the
// header and footer and the Forest colours. Then the editor's design settings:
// change the accent, "Go back to your starting colours (Forest)", and the
// draft is Forest again. A re-seed, Skip: slate and the text wordmark, and
// the same reset gives Slate. No step shows or stores the platform's lime.
// Phase 1 line 6: the step's live preview. At 1280px picking Forest puts the
// Forest variables in the frame within 1 s, and the chosen logo is in the
// frame's header, both before Save; Skip resets the preview; at 390px the
// Preview sheet opens and shows the frame. The editor stays open in a second
// tab while onboarding mints its own preview (one cookie per browser).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIME,
  LOGO_FACTS,
  P6_STORE,
  docOf,
  frameCssVars,
  frameEval,
  isLime,
  loginP6,
  logoPng,
  openEditor,
  p6Context,
  p6Url,
  reseedP6,
  settle,
  sleep,
  tenantConfig,
  waitFor,
  watchErrors,
} from "./lib.mjs";

const DESCRIPTION = "Everyday nutrition, snacks and gym kit, packed with care.";

function scratch() {
  const root = process.env.P6_DRILL_SCRATCH;
  if (!root) return mkdtempSync(join(tmpdir(), "p6-drills-"));
  mkdirSync(root, { recursive: true });
  return root;
}

async function palette(id) {
  const P = await import("../../../lib/themes/palettes.js");
  return P.paletteById(id);
}
const sameBrand = (a, b) => {
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase());
};

// /admin/onboarding?step=brand, waited until the first run has settled
export const CHECKED_PALETTE = "[data-brand-step] [data-palette][aria-checked=true]";
const frameAccent = async (page) => (await frameCssVars(page))?.["--accent-500"]?.toLowerCase() ?? null;
// the onboarding preview frame is working (a v2 ready ok came back)
const previewShown = (page) => waitFor(async () => (await page.locator("[data-brand-preview]").getAttribute("data-preview-phase").catch(() => null)) === "shown", 60_000, 200);

export async function openStart(drill, page) {
  await page.goto(p6Url(drill, "/admin/onboarding?step=brand"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const state = await waitFor(async () => {
    const s = await page.locator("[data-first-run]").getAttribute("data-first-run").catch(() => null);
    return s && !["loading", "making"].includes(s) ? s : false;
  }, 120_000, 300);
  await page.locator("[data-brand-step] [data-palette]").first().waitFor({ timeout: 60_000 });
  return state;
}

// The editor's preview of the home page, once it shows the store
export async function previewHome(page) {
  await openEditor(page, "?doc=doc_home");
  await waitFor(async () => {
    const f = await frameEval(page, LOGO_FACTS);
    return f && f.footerText.length > 0;
  }, 90_000, 500);
  await sleep(800);
  return { facts: await frameEval(page, LOGO_FACTS), vars: await frameCssVars(page) };
}

// The design settings in the editor: { accent input, reset button }
async function openDesign(page) {
  await openEditor(page, "?doc=doc_design").catch(() => {});
  await page.locator('[data-form="design"]').first().waitFor({ timeout: 90_000 });
  return page.locator('[data-form="design"]').first();
}
const colourInputs = (form) =>
  form.evaluate((f) =>
    [...f.querySelectorAll("input")]
      .filter((i) => i.type === "color" || i.classList.contains("font-mono") || /^#/.test(i.value) || /^#/.test(i.placeholder))
      .map((i) => ({ id: i.id, type: i.type, value: i.value, placeholder: i.placeholder, label: i.getAttribute("aria-label") || (i.id ? document.querySelector(`label[for="${i.id}"]`)?.innerText : null) })),
  );

// Change the accent, then press Reset; the draft brand must equal the
// starting palette. Returns what was seen.
async function resetDrill(drill, page, { start, tag }) {
  const want = await palette(start);
  const form = await openDesign(page);
  const accent = page.getByLabel("Accent colour", { exact: true });
  await accent.fill("#7c3aed");
  const changed = await waitFor(async () => (await docOf("doc_design"))?.body?.settings?.brand?.accent === "#7c3aed", 30_000, 300);
  drill.check(Boolean(changed), `${tag}: changing the accent in the editor's design settings saves the draft (#7c3aed)`, (await docOf("doc_design"))?.body?.settings?.brand);
  const reset = form.locator("[data-design-reset]");
  await reset.waitFor({ timeout: 30_000 });
  const label = (await reset.innerText()).trim();
  drill.check(label === `Go back to your starting colours (${want.label})`, `${tag}: the reset button says 'Go back to your starting colours (${want.label})'`, label);
  await drill.screenshot(page, `b-${tag}-design-changed-1440`);
  await reset.click();
  const draft = await waitFor(async () => {
    const d = await docOf("doc_design");
    return sameBrand(d?.body?.settings?.brand, want.brand) ? d : false;
  }, 30_000, 300);
  const now = await docOf("doc_design");
  drill.check(Boolean(draft), `${tag}: after Reset the draft brand equals the ${want.label} palette, key for key`, { draft: now?.body?.settings?.brand, palette: want.brand });
  const inputs = await colourInputs(form);
  const limeIn = [];
  for (const i of inputs) if ((await isLime(i.value)) || (await isLime(i.placeholder))) limeIn.push(i);
  const accentNow = inputs.find((i) => i.type !== "color" && /accent/i.test(String(i.label)))?.value;
  drill.check(limeIn.length === 0 && String(accentNow).toLowerCase() === want.brand.accent, `${tag}: the design form's colour inputs and placeholders hold no lime; the accent input says ${want.brand.accent}`, { inputs, limeIn });
  const stored = JSON.stringify(now?.body || {}).toLowerCase();
  drill.check(!stored.includes(LIME.slice(1)), `${tag}: the stored design draft holds no #84cc16`, null);
  const vars = await waitFor(async () => {
    const v = await frameCssVars(page);
    return v && v["--accent-500"]?.toLowerCase() === want.brand.accent ? v : false;
  }, 60_000, 500);
  const v = vars || (await frameCssVars(page));
  drill.check(Boolean(vars) && !(await isLime(v?.["--accent-500"])), `${tag}: the preview's computed --accent-500 is ${want.brand.accent} (${want.label}), not lime`, v);
  await drill.screenshot(page, `b-${tag}-design-reset-1440`);
  return { draft: now?.body?.settings?.brand, vars: v, inputs };
}

export async function brandStage(drill) {
  const dir = scratch();
  const logoFile = join(dir, "fernway-logo.png");
  writeFileSync(logoFile, await logoPng());
  const forest = await palette("forest");
  const slate = await palette("slate");

  // ---- Forest, a logo, a description ----
  await reseedP6(drill, "b");
  let ctx = await p6Context(drill, { width: 1280 });
  let errors = watchErrors(ctx);
  let page = await loginP6(drill, ctx);
  // the editor open in a second tab of the same browser (one preview cookie)
  const editorTab = await ctx.newPage();
  await openEditor(editorTab, "?doc=doc_home");
  await waitFor(async () => (await editorTab.locator("[data-preview-pane]").getAttribute("data-preview-phase").catch(() => null)) === "shown", 90_000, 300);
  const state = await openStart(drill, page);
  drill.check(state === "ready", "the store is made when the founder opens /admin/onboarding?step=brand", state);
  const pre = await page.locator(CHECKED_PALETTE).getAttribute("data-palette").catch(() => null);
  drill.check(pre === "slate", "the brand step preselects Slate (the generated store's palette)", pre);
  drill.check(await previewShown(page), "at 1280 the live preview of the home page shows beside the form", await page.locator("[data-brand-preview]").getAttribute("data-preview-phase").catch(() => null));
  const before = await frameAccent(page);
  await page.locator('[data-brand-step] [data-palette="forest"]').click();
  const t0 = Date.now();
  const forestIn = await waitFor(async () => ((await frameAccent(page)) === forest.brand.accent ? Date.now() - t0 : false), 1_000, 25);
  drill.check(forestIn !== false && before === slate.brand.accent && (await page.locator(CHECKED_PALETTE).getAttribute("data-palette")) === "forest", "picking Forest puts the Forest --accent-500 in the preview frame within 1 s, before Save", { before, after: await frameAccent(page), ms: forestIn });
  drill.check(sameBrand((await docOf("doc_design"))?.body?.settings?.brand, slate.brand), "and nothing is written: the design draft is still Slate", (await docOf("doc_design"))?.body?.settings?.brand);
  await page.getByRole("button", { name: "Choose from your library", exact: true }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.waitFor({ timeout: 30_000 });
  await dlg.locator('input[type="file"]').setInputFiles(logoFile);
  await page.locator("#brand-logo-alt").waitFor({ timeout: 60_000 });
  const altBefore = await page.locator("#brand-logo-alt").inputValue();
  await page.locator("#brand-logo-alt").fill("");
  await page.locator("#brand-description").fill(DESCRIPTION);
  const logoSrc = await page.locator("[data-brand-step] img").first().getAttribute("src");
  drill.check(/^\/api\/media\/[A-Za-z0-9_-]+$/.test(String(logoSrc)), "the PNG uploaded through the MediaPicker becomes the logo (a library address)", { logoSrc, altFromUpload: altBefore });
  const unsaved = await waitFor(async () => {
    const f = await frameEval(page, () => [...document.querySelectorAll("header [data-store-logo-img]")].map((i) => ({ src: i.getAttribute("src"), alt: i.getAttribute("alt"), shown: !i.hidden && i.offsetWidth > 0 })));
    return f && f.length && f.every((i) => i.src === logoSrc && i.shown) ? f : false;
  }, 5_000, 100);
  drill.check(Boolean(unsaved) && unsaved[0].alt === P6_STORE.name && !(await docOf("doc_design"))?.body?.settings?.logo, `the chosen logo is in the preview frame's header before Save (alt = the store name), and not in the design draft`, unsaved || (await frameEval(page, LOGO_FACTS)));
  const tagline = await waitFor(async () => ((await frameEval(page, () => document.querySelector("[data-store-tagline]")?.textContent)) === DESCRIPTION ? true : false), 5_000, 100);
  drill.check(tagline, "the description shows in the preview's footer before Save", await frameEval(page, () => document.querySelector("[data-store-tagline]")?.outerHTML));
  drill.check((await page.locator("[data-brand-dirty]").count()) === 1, "the form says it has unsaved changes", null);
  await drill.screenshot(page, "b-brand-step-filled-1280");
  await page.locator("[data-brand-step]").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator('[data-brand-done="saved"]').waitFor({ timeout: 60_000 });
  const done = (await page.locator('[data-brand-done="saved"]').innerText()).replace(/\s+/g, " ");
  drill.check(done.includes("Saved.") && done.includes("Your colours and logo are saved. They show after you publish.") && done.includes("Shoppers see it once you open your store."), "Save: 'Saved.', the colours and logo show after publish, the description once the store opens", done);
  await drill.screenshot(page, "b-brand-step-saved-1280");
  // after Save the frame reloads and shows the saved draft (no overlay)
  await previewShown(page);
  const savedFrame = await waitFor(async () => {
    const f = await frameEval(page, LOGO_FACTS);
    return (await frameAccent(page)) === forest.brand.accent && f?.header?.some((i) => i.src === logoSrc && i.ok) && !(await frameEval(page, () => document.getElementById("brand-vars-draft"))) ? f : false;
  }, 30_000, 300);
  drill.check(Boolean(savedFrame) && (await page.locator("[data-brand-dirty]").count()) === 0, "after Save the preview reloads on the saved draft: Forest and the logo with no overlay, nothing unsaved", savedFrame);
  const ePhase = await editorTab.locator("[data-preview-pane]").getAttribute("data-preview-phase").catch(() => null);
  drill.check(["shown", "loading", "minting"].includes(ePhase), "the editor tab's preview is still working after onboarding minted its own session", ePhase);
  await editorTab.close();

  const design = await docOf("doc_design");
  const cfg = await tenantConfig();
  const logo = design?.body?.settings?.logo;
  drill.check(sameBrand(design?.body?.settings?.brand, forest.brand), "the design draft holds the Forest palette", design?.body?.settings?.brand);
  drill.check(logo?.media === logoSrc && !logo?.alt, "the design draft holds the logo with no alt (empty alt is left out)", logo);
  drill.check(cfg?.onboarding?.brand_step?.paletteId === "forest" && cfg?.site?.tagline === DESCRIPTION, "the brand step is recorded (Forest) and the description saved as the store's tagline", { brandStep: cfg?.onboarding?.brand_step, tagline: cfg?.site?.tagline });

  const pv = await previewHome(page);
  drill.check(pv.facts.header.length >= 1 && pv.facts.header.every((i) => i.src === logoSrc && i.alt === P6_STORE.name && i.ok), `the preview's header shows the logo, alt = the store name ("${P6_STORE.name}")`, pv.facts.header);
  drill.check(pv.facts.footer.length >= 1 && pv.facts.footer.every((i) => i.src === logoSrc && i.alt === P6_STORE.name && i.ok), "the preview's footer shows the logo, alt = the store name", pv.facts.footer);
  drill.check(pv.vars?.["--accent-500"]?.toLowerCase() === forest.brand.accent && !(await isLime(pv.vars?.["--accent-500"])), `the preview's accent is Forest (${forest.brand.accent})`, pv.vars);
  await drill.screenshot(page, "b-preview-forest-logo-1440");

  await resetDrill(drill, page, { start: "forest", tag: "forest" });
  drill.check(errors.length === 0, "no page errors (Forest run)", errors);
  await ctx.close();

  // ---- Skip on a fresh store ----
  await reseedP6(drill, "b");
  ctx = await p6Context(drill);
  errors = watchErrors(ctx);
  page = await loginP6(drill, ctx);
  await openStart(drill, page);
  await previewShown(page);
  await page.locator('[data-brand-step] [data-palette="clay"]').click();
  const clay = await palette("clay");
  drill.check(Boolean(await waitFor(async () => (await frameAccent(page)) === clay.brand.accent, 2_000, 50)), "before Skip: Clay shows in the preview (unsaved)", await frameAccent(page));
  await page.locator("[data-brand-step]").getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.locator('[data-brand-done="skipped"]').waitFor({ timeout: 60_000 });
  drill.check((await page.locator('[data-brand-done="skipped"]').innerText()).includes("Skipped. You can come back to this any time."), "Skip: 'Skipped. You can come back to this any time.'", null);
  const cfg2 = await tenantConfig();
  const d2 = await docOf("doc_design");
  const reset = await waitFor(async () => ((await frameAccent(page)) === slate.brand.accent && !(await frameEval(page, () => document.getElementById("brand-vars-draft"))) ? true : false), 30_000, 200);
  drill.check(Boolean(reset) && (await page.locator(CHECKED_PALETTE).getAttribute("data-palette")) === "slate", "Skip discards the unsaved Clay: the form is back on Slate and the preview is reset (no overlay, Slate)", await frameAccent(page));
  drill.check(cfg2?.onboarding?.brand_step?.skipped === true && sameBrand(d2?.body?.settings?.brand, slate.brand) && !d2?.body?.settings?.logo, "Skip records the step and leaves the design draft on Slate with no logo", { brandStep: cfg2?.onboarding?.brand_step, brand: d2?.body?.settings?.brand, logo: d2?.body?.settings?.logo ?? null });
  const pv2 = await previewHome(page);
  drill.check(pv2.facts.header.length === 0 && pv2.facts.footer.length === 0 && pv2.facts.headerText.startsWith(P6_STORE.name), "after Skip the preview shows the text wordmark (no logo picture) in the header and footer", { header: pv2.facts.headerText.slice(0, 60), imgs: [pv2.facts.header.length, pv2.facts.footer.length] });
  drill.check(pv2.vars?.["--accent-500"]?.toLowerCase() === slate.brand.accent, `after Skip the preview's accent is Slate (${slate.brand.accent})`, pv2.vars);
  await drill.screenshot(page, "b-skip-preview-slate-1440");
  await resetDrill(drill, page, { start: "slate", tag: "skip" });
  drill.check(errors.length === 0, "no page errors (Skip run)", errors);
  await ctx.close();

  // ---- crossing 1024px: one preview, one session (review fix) ----
  ctx = await p6Context(drill, { width: 1280 });
  errors = watchErrors(ctx);
  page = await loginP6(drill, ctx);
  const mints = [];
  const t0r = Date.now();
  const stepAt = [];
  page.on("request", (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/admin/preview-session" && mints.push({ ms: Date.now() - t0r, after: stepAt.at(-1) || "start" }));
  await openStart(drill, page);
  await previewShown(page);
  stepAt.push("shown at 1280");
  await page.setViewportSize({ width: 390, height: 812 });
  stepAt.push("390");
  await page.locator("[data-brand-preview-open]").click();
  await page.locator("[data-brand-sheet]").waitFor({ state: "visible", timeout: 30_000 });
  const narrowShown = await previewShown(page);
  stepAt.push("sheet shown");
  await page.setViewportSize({ width: 1280, height: 900 });
  stepAt.push("1280 again");
  const wideAgain = await previewShown(page);
  await sleep(1500); // a late re-mint would show here
  drill.check(narrowShown && wideAgain && mints.length === 1 && (await page.locator("[data-preview-frame]").count()) === 1, "resizing 1280 → 390 → 1280 keeps one frame and one preview session (one POST /api/admin/preview-session)", { mints, log: await page.locator("[data-brand-preview]").getAttribute("data-preview-log").catch(() => null) });
  drill.check(errors.length === 0, "no page errors (resize run)", errors);
  await ctx.close();

  // ---- 390px: the Preview sheet ----
  ctx = await p6Context(drill, { width: 390 });
  errors = watchErrors(ctx);
  page = await loginP6(drill, ctx);
  await openStart(drill, page);
  const opener = page.locator("[data-brand-preview-open]");
  drill.check((await opener.isVisible()) && (await page.locator("[data-preview-frame]").count()) === 0, "at 390 a sticky Preview button shows and no frame is made before it is opened", null);
  await opener.click();
  await page.locator("[data-brand-sheet]").waitFor({ state: "visible", timeout: 30_000 });
  drill.check(await previewShown(page), "the Preview sheet opens and the frame shows the home page", await page.locator("[data-brand-preview]").getAttribute("data-preview-phase").catch(() => null));
  const f390 = await frameEval(page, LOGO_FACTS);
  drill.check(Boolean(f390?.headerText), "the frame inside the sheet shows the store's header", f390?.headerText?.slice(0, 80));
  await drill.screenshot(page, "b-brand-sheet-390");
  await page.keyboard.press("Escape");
  await page.locator("[data-brand-sheet]").waitFor({ state: "hidden", timeout: 10_000 });
  drill.check((await page.locator("[data-preview-frame]").count()) === 1, "Esc closes the sheet and the frame stays mounted (minted once)", null);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  drill.check(!overflow, "at 390 nothing scrolls sideways", null);
  drill.check(errors.length === 0, "no page errors (390 run)", errors);
  await ctx.close();
}
