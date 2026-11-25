// drill:studio stage "design" (Phase 6 line 2, docs/plans/phase-6.md "Line 2"
// drill stage): the Design tab draws tokens in the frame before the save
// reaches the server, then saves them as a doc_design draft.
//   1. with doc_design's saveDraft held, changing the accent changes the
//      frame's --accent-500 before the request goes out; then text size
//      (--type-scale) and section spacing (--section-pad-y)
//   2. a low-contrast text colour shows the "Use <colour>" fix and blocks a
//      publish (the documents publish answers 422); the fix makes it readable
//   3. with Aurora live: overriding the accent keeps the package's data-theme
//      styles (header surface, the header-link rule), then "Reset to the
//      theme's" brings Aurora's accent back
// Storefront frames: the consent cookie is set (the banner never covers the
// page) and /_next/image is stubbed (the fixture products' pictures don't
// exist), as drill:themes stage "render" does. Every wait is for an element,
// a value or an answer, never a fixed time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, harnessPorts } from "../../design-harness.js";
import { ROLES_PROFILE } from "../../seed-roles-store.js";
import { ORIGIN, open, signIn, stage } from "./lib.mjs";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";
import { accentShades, TYPE_SCALES, SECTION_SPACING } from "../../../lib/brand.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
const consent = (ctx) => ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);

const AURORA_TEXT = readFileSync(join(ROOT, "scripts/fixtures/themes/aurora.theme.json"), "utf8");
const AURORA = JSON.parse(AURORA_TEXT);
const PKG_ID = "thm_d2d2d2d2d2d2d2d2";
const START = { accent: "#4f46e5", background: "#ffffff", foreground: "#111111", radius: "md", type_scale: "regular", button_shape: "pill", section_spacing: "regular" };

async function rolesSql(statements) {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: `http://127.0.0.1:${harnessPorts(process.env, ROLES_PROFILE).sqld.tenant}` });
  try {
    for (const s of statements) await c.execute(s);
  } finally {
    c.close();
  }
}
const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

// doc_design with this theme and brand as its draft (made if missing), and a home page
async function designDraft(drill, page, settings) {
  let d = (await docsApi(page, { getDocument: "doc_design" })).body?.document ?? null;
  if (!d) {
    const made = await docsApi(page, { createDocument: { type: "design", body: { schema: 1, type: "design", meta: {}, settings: { brand: null, theme: null, logo: null, ...settings } } } });
    drill.check(made.status === 200, "design: doc_design is made", made.body?.error);
  } else {
    const saved = await docsApi(page, { saveDraft: { id: "doc_design", body: { ...d.body, settings: { ...d.body.settings, ...settings } } }, revision: d.revision });
    drill.check(saved.status === 200, "design: the draft is set for the stage", saved.body?.error);
  }
  return (await docsApi(page, { getDocument: "doc_design" })).body?.document;
}
// the design's publish set: a store's first publish must include its home page
async function designSet(page) {
  let home = (await docsApi(page, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    await docsApi(page, { createDocument: { type: "home", body: { schema: 1, type: "home", meta: {}, sections: [{ id: "sec_stdesign01", kind: "new", v: 1, enabled: true, settings: { title: "New arrivals", limit: 8 }, blocks: [] }] } } });
    home = (await docsApi(page, { getDocument: "doc_home" })).body?.document ?? null;
  }
  const d = (await docsApi(page, { getDocument: "doc_design" })).body.document;
  const set = [{ id: "doc_design", revision: d.revision, draftHash: d.draftHash }];
  if (home && !home.live) set.push({ id: "doc_home", revision: home.revision, draftHash: home.draftHash });
  return set;
}
async function publishDesign(drill, page) {
  const r = await docsApi(page, { publishSet: await designSet(page) });
  drill.check(r.status === 200, "design: published for the stage", r.body?.error || r.body?.code);
}

// the frame's document root, once the bridge is in editing mode
async function frameOf(page) {
  const handle = await page.locator("[data-preview-frame]").elementHandle();
  const f = await handle.contentFrame();
  await f.waitForSelector("body.storeasy-editing", { state: "attached" });
  return f;
}
const cssVar = (f, name) => f.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const waitVar = (f, name, want) => f.waitForFunction(([n, w]) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() === w, [name, want]);

async function openStudio(page) {
  await open(page, "/admin/studio");
  await page.locator('[data-studio-tab="design"]').click();
  await page.locator("[data-studio-design][data-design-load]").waitFor({ state: "detached" }).catch(() => {});
  await page.locator("#studio-design-accent").waitFor();
  return frameOf(page);
}

stage("design", async (drill) => {
  const owner = await signIn(drill, "owner");
  const ctx = owner.context();
  await stubImages(ctx);
  await consent(ctx);
  await open(owner, "/admin");
  await designDraft(drill, owner, { theme: { kit: "pulse", version: 1 }, brand: START });
  // its own starting state: START is live too, whatever an earlier stage published
  await publishDesign(drill, owner);

  // --- 1. instant: the frame changes before the held save goes out ---
  let held = [];
  let sent = 0;
  await owner.route("**/api/admin/documents", async (route) => {
    const req = route.request();
    if (req.method() === "PUT" && /"saveDraft":\{"id":"doc_design"/.test(req.postData() || "")) {
      held.push(route);
      return;
    }
    return route.continue();
  });
  owner.on("request", (r) => r.url().endsWith("/api/admin/documents") && /"saveDraft":\{"id":"doc_design"/.test(r.postData() || "") && sent++);
  const f = await openStudio(owner);
  drill.check((await cssVar(f, "--accent-500")) === accentShades(START.accent)[500], "design: the frame starts on the saved accent", await cssVar(f, "--accent-500"));
  await owner.locator("#studio-design-accent").fill("#e11d48");
  await waitVar(f, "--accent-500", accentShades("#e11d48")[500]);
  drill.check(held.length === 0, "design: --accent-500 changed before the save left (the 700 ms pause)", { held: held.length });
  await owner.locator("#studio-design-type_scale").selectOption("large");
  await waitVar(f, "--type-scale", TYPE_SCALES.large);
  await owner.locator("#studio-design-section_spacing").selectOption("airy");
  await waitVar(f, "--section-pad-y", SECTION_SPACING.airy);
  drill.check(true, "design: text size and section spacing draw at once (--type-scale, --section-pad-y)");
  await owner.waitForFunction(() => document.querySelector('[data-show-design]')?.getAttribute("aria-checked") === "true" || document.querySelector('[data-show-design]')?.getAttribute("data-state") === "checked");
  drill.check(true, "design: Show design changes is on for the session");
  await drill.shoot(owner, "design-instant");
  const release = async () => {
    const list = held;
    held = [];
    for (const r of list) await r.continue();
  };
  await owner.unroute("**/api/admin/documents");
  await release();
  await owner.waitForResponse((r) => r.url().endsWith("/api/admin/documents") && r.request().method() === "PUT" && /"saveDraft":\{"id":"doc_design"/.test(r.request().postData() || ""), { timeout: 15_000 }).catch(() => null);
  await owner.locator('[data-studio-tab="design"]').waitFor();
  let d = (await docsApi(owner, { getDocument: "doc_design" })).body.document;
  for (let i = 0; i < 40 && d.body.settings.brand?.section_spacing !== "airy"; i++) {
    await owner.waitForResponse((r) => r.url().endsWith("/api/admin/documents"), { timeout: 2000 }).catch(() => null);
    d = (await docsApi(owner, { getDocument: "doc_design" })).body.document;
  }
  const b = d.body.settings.brand || {};
  drill.check(b.accent === "#e11d48" && b.type_scale === "large" && b.section_spacing === "airy", "design: the draft saved accent, text size and spacing", b);
  drill.check(sent > 0, "design: the save went out after the change", { sent });

  // --- 2. a low-contrast text colour: the fix, and publish is refused ---
  await owner.locator("#studio-design-foreground").fill("#eeeeee");
  await owner.locator('[data-design-check="blocking"]').waitFor();
  const fix = owner.locator('[data-design-fix="foreground"]');
  await fix.waitFor();
  drill.check(/^Use #[0-9a-f]{6}$/.test((await fix.innerText()).trim()), "design: a \"Use <colour>\" fix shows", await fix.innerText());
  await drill.shoot(owner, "design-blocked");
  let low = (await docsApi(owner, { getDocument: "doc_design" })).body.document;
  for (let i = 0; i < 40 && low.body.settings.brand?.foreground !== "#eeeeee"; i++) {
    await owner.waitForResponse((r) => r.url().endsWith("/api/admin/documents"), { timeout: 2000 }).catch(() => null);
    low = (await docsApi(owner, { getDocument: "doc_design" })).body.document;
  }
  const refused = await docsApi(owner, { publishSet: await designSet(owner) });
  drill.check(refused.status === 422 && JSON.stringify(refused.body).includes("BRAND_UNREADABLE"), "design: publishing the unreadable text colour is refused", { status: refused.status, code: refused.body?.code });
  await fix.click();
  await owner.locator('[data-design-check="blocking"]').waitFor({ state: "detached" });
  drill.check(true, "design: the fix makes every pair readable");
  await ctx.close();

  // --- 3. Aurora live: override the accent, the package's styles stay, Reset to the theme's ---
  await rolesSql([
    {
      sql: "INSERT OR IGNORE INTO theme_packages (id, slug, version, name, author, description, base_kit, package, sha256, size_bytes, status, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', 'drill', ?)",
      args: [PKG_ID, AURORA.id, `${AURORA.version}-sd`, AURORA.name, AURORA.author.name, AURORA.description, AURORA.base, AURORA_TEXT, "0".repeat(64), AURORA_TEXT.length, new Date().toISOString()],
    },
  ]);
  const o2 = await signIn(drill, "owner");
  await stubImages(o2.context());
  await consent(o2.context());
  await open(o2, "/admin");
  await designDraft(drill, o2, { theme: { kit: AURORA.base, version: 1, package: PKG_ID }, brand: { ...AURORA.tokens } });
  await publishDesign(drill, o2);
  const g = await openStudio(o2);
  await o2.locator(`[data-design-theme="${PKG_ID}"]`).waitFor();
  drill.check((await o2.locator(`[data-design-theme="${PKG_ID}"]`).innerText()).startsWith(`Theme: ${AURORA.name} `), "design: the rail names the uploaded theme", await o2.locator(`[data-design-theme="${PKG_ID}"]`).innerText());
  await o2.locator("#studio-design-accent").fill("#16a34a");
  await waitVar(g, "--accent-500", accentShades("#16a34a")[500]);
  const look = await g.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    headerBg: (() => {
      const h = document.querySelector('header[data-part="header"]');
      return h ? getComputedStyle(h).backgroundColor : null;
    })(),
    link: (() => {
      const a = document.querySelector('[data-part="header-link"]');
      return a ? getComputedStyle(a).textTransform : null;
    })(),
  }));
  drill.check(look.theme === AURORA.id && look.headerBg === "rgb(15, 23, 42)", "design: the accent override keeps Aurora's data-theme and header surface", look);
  drill.check(look.link === null || look.link === "uppercase", "design: Aurora's compiled style rules still apply", look);
  await drill.shoot(o2, "design-aurora-override");
  const reset = o2.locator('[data-design-reset="theme"]');
  await reset.waitFor();
  drill.check((await reset.innerText()).trim() === "Reset to the theme's", "design: Reset to the theme's", await reset.innerText());
  await reset.click();
  await waitVar(g, "--accent-500", accentShades(AURORA.tokens.accent)[500]);
  await reset.waitFor({ state: "detached" });
  drill.check(true, "design: Reset brings Aurora's accent back and the button goes");
  await o2.context().close();
});
