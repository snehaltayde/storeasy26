// P6-DRILLS stage B (GEN-04; owner answer OQ-P6-8): the brand step. Forest,
// a PNG logo uploaded through the MediaPicker with its alt left empty, and a
// description; the preview shows the logo (alt = the store name) in the
// header and footer and the Forest colours. Then the editor's design settings:
// change the accent, "Go back to your starting colours (Forest)", and the
// draft is Forest again. A re-seed, Skip: slate and the text wordmark, and
// the same reset gives Slate. No step shows or stores the platform's lime.
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

// /admin/start, waited until the first run has settled
export async function openStart(drill, page) {
  await page.goto(p6Url(drill, "/admin/start"), { waitUntil: "load", timeout: 120_000 });
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
  let ctx = await p6Context(drill);
  let errors = watchErrors(ctx);
  let page = await loginP6(drill, ctx);
  const state = await openStart(drill, page);
  drill.check(state === "ready", "the store is made when the founder opens /admin/start", state);
  const pre = await page.locator('[data-brand-step] input[name="palette"]:checked').getAttribute("value").catch(() => null);
  drill.check(pre === "slate", "the brand step preselects Slate (the generated store's palette)", pre);
  await page.locator('[data-brand-step] [data-palette="forest"]').click();
  await page.getByRole("button", { name: "Choose a logo", exact: true }).click();
  const dlg = page.locator("dialog[open]").last();
  await dlg.waitFor({ timeout: 30_000 });
  await dlg.locator('input[type="file"]').setInputFiles(logoFile);
  await page.locator("#brand-logo-alt").waitFor({ timeout: 60_000 });
  const altBefore = await page.locator("#brand-logo-alt").inputValue();
  await page.locator("#brand-logo-alt").fill("");
  await page.locator("#brand-description").fill(DESCRIPTION);
  const logoSrc = await page.locator("[data-brand-step] img").first().getAttribute("src");
  drill.check(/^\/api\/media\/[A-Za-z0-9_-]+$/.test(String(logoSrc)), "the PNG uploaded through the MediaPicker becomes the logo (a library address)", { logoSrc, altFromUpload: altBefore });
  await drill.screenshot(page, "b-brand-step-filled-1440");
  await page.locator("[data-brand-step]").getByRole("button", { name: "Save", exact: true }).click();
  await page.locator('[data-brand-done="saved"]').waitFor({ timeout: 60_000 });
  const done = (await page.locator('[data-brand-done="saved"]').innerText()).replace(/\s+/g, " ");
  drill.check(done.includes("Saved.") && done.includes("Your colours and logo are saved. They show after you publish.") && done.includes("Shoppers see it once you open your store."), "Save: 'Saved.', the colours and logo show after publish, the description once the store opens", done);
  await drill.screenshot(page, "b-brand-step-saved-1440");

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
  await page.locator("[data-brand-step]").getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.locator('[data-brand-done="skipped"]').waitFor({ timeout: 60_000 });
  drill.check((await page.locator('[data-brand-done="skipped"]').innerText()).includes("Skipped. You can come back to this any time."), "Skip: 'Skipped. You can come back to this any time.'", null);
  const cfg2 = await tenantConfig();
  const d2 = await docOf("doc_design");
  drill.check(cfg2?.onboarding?.brand_step?.skipped === true && sameBrand(d2?.body?.settings?.brand, slate.brand) && !d2?.body?.settings?.logo, "Skip records the step and leaves the design draft on Slate with no logo", { brandStep: cfg2?.onboarding?.brand_step, brand: d2?.body?.settings?.brand, logo: d2?.body?.settings?.logo ?? null });
  const pv2 = await previewHome(page);
  drill.check(pv2.facts.header.length === 0 && pv2.facts.footer.length === 0 && pv2.facts.headerText.startsWith(P6_STORE.name), "after Skip the preview shows the text wordmark (no logo picture) in the header and footer", { header: pv2.facts.headerText.slice(0, 60), imgs: [pv2.facts.header.length, pv2.facts.footer.length] });
  drill.check(pv2.vars?.["--accent-500"]?.toLowerCase() === slate.brand.accent, `after Skip the preview's accent is Slate (${slate.brand.accent})`, pv2.vars);
  await drill.screenshot(page, "b-skip-preview-slate-1440");
  await resetDrill(drill, page, { start: "slate", tag: "skip" });
  drill.check(errors.length === 0, "no page errors (Skip run)", errors);
  await ctx.close();
}
