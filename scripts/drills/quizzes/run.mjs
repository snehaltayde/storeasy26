// QUIZZES: `pnpm drill:quizzes`, product-finder quizzes on the new UI in a
// real browser (Phase 2 line 10, docs/plans/phase-2.md "Line 10"). Run by
// scripts/drills/run-isolated.mjs in a throwaway worktree on its own roles
// store (4 fixture products tagged "fixture", one seeded quiz that is Off;
// the store is closed). Never in the owner's checkout (runDrill refuses).
//
// Staff: makes a quiz (Off), its address from the title; tries it ("Show the
// picks" lists fixture products); Turn on is RoleGate's, and the API refuses
// {enabled:true} with 403.
// Admin: turns it On; the store shows it (through a preview session, as the
// store is closed); the home draft links to it (documents API), so Delete
// says "This quiz can't be deleted" with Home page by name and "Turn it off
// instead", and the quiz stays.
// Support (read-only): the list and the editor with no Save, Delete or
// On/Off, every control a read, disabled or gated; Try it works; no non-GET
// request at all; no sideways scroll at 375px.
// Results and screenshots: docs/cms-reviews/drills/QUIZZES/.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../design-harness.js";
import { docsApi, runDrill, settle } from "../p3/lib.mjs";

const DRILL_ID = "QUIZZES";
const port = String(process.env.ROLES_PORT || "").trim();
const ORIGIN = `http://roles.localhost:${port}`;
const LIST = "/admin/quizzes";
const SLUG = "drill-quiz";
const EDIT = `${LIST}/${SLUG}`;
const DEV_EVAL = /eval\(\) is not supported in this environment/;
const ERROR_TEXT = /This page hit an error|Something went wrong|Application error|Unhandled Runtime Error/;
const seed = () => JSON.parse(readFileSync(join(ROOT, ".design-data-roles", "roles-seed.json"), "utf8"));

async function signIn(drill, role) {
  const m = seed().members.find((x) => x.role === role);
  const ctx = await drill.browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  ctx.setDefaultTimeout(60_000);
  const res = await ctx.request.post(`${ORIGIN}/api/admin/login`, { data: { email: m.email, password: m.password }, headers: { origin: ORIGIN }, maxRedirects: 0 });
  if (res.status() !== 200) throw new Error(`sign-in as ${role} answered ${res.status()}`);
  const page = await ctx.newPage();
  // the shell drill's rule: every non-GET request counts, except Next's dev
  // error overlay (POST /__nextjs_*) only when the server is a dev server
  const run = { ctx, page, writes: [], raw: [], devServer: false };
  page.on("websocket", (ws) => {
    if (/\/_next\/webpack-hmr/.test(ws.url())) run.devServer = true;
  });
  page.on("request", (req) => {
    if (["GET", "HEAD"].includes(req.method())) return;
    const path = new URL(req.url()).pathname;
    if (run.devServer && path.startsWith("/__nextjs")) return;
    run.writes.push(`${req.method()} ${path}`);
  });
  page.on("console", (x) => x.type() === "error" && run.raw.push(x.text().slice(0, 300)));
  page.on("pageerror", (e) => run.raw.push(String(e.message || e).slice(0, 300)));
  Object.defineProperty(run, "errors", { get: () => run.raw.filter((e) => !(run.devServer && DEV_EVAL.test(e))) });
  return run;
}

async function open(page, path) {
  const res = await page.goto(ORIGIN + path, { waitUntil: "load" });
  await settle(page);
  return res;
}

// interactive elements in main and open dialogs or popovers that are not a
// marked read, natively disabled or RoleGate's (the shell's own are left out)
function strays() {
  const q = 'a[href], button, input, select, textarea, [role="menuitem"], [role="link"], [tabindex]:not([tabindex="-1"])';
  const scopes = [document.querySelector("main"), ...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]')].filter(Boolean);
  const ok = (el) => el.hasAttribute("data-read-control") || el.disabled === true || (el.getAttribute("aria-disabled") === "true" && el.getAttribute("data-role-gate") === "disabled") || el.closest("[data-nav-item],[data-shell-control]") || (el.getAttribute("aria-hidden") === "true" && el.tabIndex === -1);
  return scopes.flatMap((s) => [...s.querySelectorAll(q)]).filter((el) => !ok(el) && el.getClientRects().length).map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
}

async function tryIt(drill, page, role) {
  const card = page.locator("[data-quiz-try]");
  await card.getByRole("radio").first().click();
  await card.locator("[data-quiz-try-run]").click();
  const shown = await card.locator("[data-quiz-try-products] li").first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const text = shown ? await card.locator("[data-quiz-try-result]").innerText() : await card.innerText();
  drill.check(shown && /fixture/.test(text) && /Fixture product/.test(text), `${role}: Try it scores the answers and lists fixture products for the tag "fixture"`, text.slice(0, 300));
}

const state = (page) => page.locator("main [data-quiz-state]").first().getAttribute("data-quiz-state").catch(() => null);

async function quizzes(drill) {
  if (!port) throw new Error("drill:quizzes needs ROLES_PORT (run it as pnpm drill:quizzes).");
  const out = {};

  // --- staff: makes a quiz that is Off, and tries it ---
  const st = await signIn(drill, "staff");
  let res = await open(st.page, LIST);
  let body = await st.page.locator("main").innerText();
  drill.check(res?.status() === 200 && !ERROR_TEXT.test(body) && body.includes("Find your fixture") && body.includes("/quiz/find-your-fixture"), "staff: /admin/quizzes lists the seeded quiz with its address", body.slice(0, 300));
  await st.page.getByRole("link", { name: /New quiz/ }).first().click();
  await st.page.waitForURL(`${ORIGIN}${LIST}/new`);
  await st.page.locator("#quiz-title").fill("Drill quiz");
  drill.check((await st.page.locator("#quiz-slug").inputValue()) === SLUG, "staff: the address follows the title", await st.page.locator("#quiz-slug").inputValue());
  const q1 = st.page.locator('[data-quiz-question="1"]');
  await q1.locator("input").first().fill("What brings you here?");
  await q1.locator('[data-quiz-option="q1o1"] input').fill("I want to try one");
  await q1.locator('[data-quiz-option="q1o2"] input').fill("Just browsing");
  await q1.getByRole("button", { name: "Add a tag to answer 1 of question 1" }).click();
  await st.page.locator('[data-slot="popover-content"]').getByRole("button", { name: /fixture/ }).click();
  await st.page.keyboard.press("Escape");
  drill.check((await q1.locator('[data-quiz-option="q1o1"] [data-quiz-tags]').innerText()).includes("fixture"), "staff: the tag picker adds the catalog tag with its count");
  drill.check((await st.page.locator("main").innerText()).includes("An owner or admin can turn it on"), "staff: a new quiz says it is saved Off");
  await st.page.locator("[data-quiz-save]").click();
  await st.page.waitForURL(`${ORIGIN}${EDIT}`, { timeout: 30_000 }).catch(() => {});
  await settle(st.page);
  drill.check(new URL(st.page.url()).pathname === EDIT && (await state(st.page)) === "off", "staff: Save makes the quiz, Off, and opens its page", { url: st.page.url(), state: await state(st.page) });
  await tryIt(drill, st.page, "staff");
  const toggle = await st.page.locator("[data-quiz-toggle]").evaluate((el) => ({ gated: el.getAttribute("data-role-gate"), text: el.innerText })).catch(() => null);
  drill.check(toggle?.gated === "disabled" && /Turn on/.test(toggle.text), "staff: Turn on is RoleGate's (disabled, with the reason)", toggle);
  const forced = await st.ctx.request.post(`${ORIGIN}/api/admin/quiz`, { data: { quiz: { slug: SLUG, title: "Drill quiz", questions: [{ prompt: "x", options: [{ label: "a" }, { label: "b" }] }] }, enabled: true }, headers: { origin: ORIGIN } });
  const forcedBody = await forced.json().catch(() => ({}));
  drill.check(forced.status() === 403 && forcedBody.code === "QUIZ_NEEDS_PUBLISH", "staff: the API refuses {enabled:true} with 403", { status: forced.status(), body: forcedBody });
  await drill.shoot(st.page, "staff-editor");
  drill.check(st.errors.length === 0, "staff: no error in the browser console", st.errors);

  // --- admin: turns it on; the store shows it; a page uses it ---
  const ad = await signIn(drill, "admin");
  await open(ad.page, EDIT);
  await ad.page.locator('[data-quiz-toggle="on"]').click();
  const on = await ad.page.waitForFunction(() => document.querySelector("main [data-quiz-state]")?.getAttribute("data-quiz-state") === "on", null, { timeout: 30_000 }).then(() => true, () => false);
  drill.check(on, "admin: Turn on turns the quiz On", await state(ad.page));
  const storeLink = await ad.page.getByRole("link", { name: /Open on the store/ }).getAttribute("href").catch(() => null);
  drill.check(storeLink === `/quiz/${SLUG}`, "admin: Open on the store links to /quiz/<slug>", storeLink);
  const mint = await ad.ctx.request.post(`${ORIGIN}/api/admin/preview-session`, { data: { create: true }, headers: { origin: ORIGIN } });
  const preview = (await mint.json().catch(() => ({}))).previewUrl || null;
  if (drill.check(mint.status() === 200 && preview, "admin: a preview session (the store is closed)", { status: mint.status() })) {
    const sf = await ad.ctx.newPage();
    await sf.goto(ORIGIN + preview.replace(/to=[^&]*/, `to=${encodeURIComponent(`/quiz/${SLUG}`)}`), { waitUntil: "load" });
    await settle(sf);
    const h1 = await sf.locator("h1").first().innerText().catch(() => "");
    drill.check(h1.includes("Drill quiz") && (await sf.getByText("What brings you here?").count()) > 0, "admin: the store shows the quiz once it is On", { url: sf.url(), h1 });
    await drill.shoot(sf, "store-quiz");
    await sf.close();
  }
  // the home draft links to the quiz (a banner button), through the documents API
  const listed = await docsApi(ad.page, { listDocuments: { type: "home" } });
  const homeId = (listed.body?.documents || []).find((d) => d.type === "home")?.id || null;
  const home = homeId ? await docsApi(ad.page, { getDocument: homeId }) : { body: null };
  const doc = home.body?.document;
  let linked = false;
  if (doc) {
    const Reg = await import("../../../lib/registry/index.js");
    const draft = structuredClone(doc.body || { sections: [] });
    draft.sections = [...(draft.sections || []), { ...Reg.newSection("banner", { id: "sec_drillquiz" }), settings: { ...Reg.newSection("banner").settings, title: "Find yours", button: { label: "Take the quiz", link: { type: "url", href: `/quiz/${SLUG}` } } } }];
    linked = (await docsApi(ad.page, { saveDraft: { id: doc.id, body: draft }, revision: doc.revision })).status === 200;
  }
  drill.check(linked, "admin: the home draft links to /quiz/<slug> (documents API)", { homeId });
  await open(ad.page, EDIT);
  const usedOn = await ad.page.locator("[data-quiz-pages]").innerText().catch(() => "");
  drill.check(/Home page \(draft\)/i.test(usedOn) || /\(draft\)/.test(usedOn), "admin: Where it's used names the home page", usedOn);
  await ad.page.locator("[data-quiz-delete-open]").click();
  const dlg = ad.page.getByRole("alertdialog");
  await dlg.waitFor({ timeout: 10_000 });
  const words = await dlg.innerText();
  const buttons = await dlg.getByRole("button").allInnerTexts();
  drill.check(words.includes("This quiz can't be deleted") && /\(draft\)/.test(words), "admin: deleting a quiz a page uses says it can't be deleted, with the page by name", words);
  drill.check(buttons.includes("Turn it off instead") && !buttons.some((b) => /anyway|force|Delete quiz/i.test(b)), "admin: it offers Turn it off instead and no way to force", buttons);
  await drill.shoot(ad.page, "admin-delete-refused");
  await dlg.getByRole("button", { name: "Close" }).click();
  const still = await ad.ctx.request.get(`${ORIGIN}/api/admin/quiz?slug=${SLUG}`);
  drill.check(still.status() === 200, "admin: the quiz is still there", still.status());
  drill.check(ad.errors.length === 0, "admin: no error in the browser console", ad.errors);
  out.admin = { storeLink, usedOn };

  // --- support: the read pass ---
  const sup = await signIn(drill, "support");
  res = await open(sup.page, LIST);
  body = await sup.page.locator("main").innerText();
  drill.check(res?.status() === 200 && body.includes("Drill quiz") && /Used on 1 page/.test(body), "support: the list shows the quizzes, On or Off, and the pages count", body.slice(0, 400));
  const newGate = await sup.page.getByText("New quiz").first().evaluate((el) => el.closest("[data-role-gate]")?.getAttribute("data-role-gate") || null).catch(() => null);
  drill.check(newGate === "disabled", "support: New quiz is RoleGate's", newGate);
  drill.check((await sup.page.evaluate(strays)).length === 0, "support: every control on the list is a read, disabled or gated", await sup.page.evaluate(strays));
  await sup.page.locator('input[type="search"]').fill("drill");
  drill.check((await sup.page.locator("main tbody tr").count()) === 1, "support: the search narrows the list");
  await drill.shoot(sup.page, "support-list");
  await open(sup.page, EDIT);
  const missing = await sup.page.evaluate(() => ["[data-quiz-save]", "[data-quiz-toggle]", "[data-quiz-delete-open]"].filter((s) => document.querySelector(s)));
  drill.check(missing.length === 0, "support: no Save, Delete or On/Off on the editor", missing);
  drill.check((await sup.page.evaluate(strays)).length === 0, "support: every control on the editor is a read, disabled or gated", await sup.page.evaluate(strays));
  await tryIt(drill, sup.page, "support");
  drill.check((await sup.page.evaluate(strays)).length === 0, "support: no stray control after Try it", await sup.page.evaluate(strays));
  await drill.shoot(sup.page, "support-editor");
  drill.check(sup.writes.length === 0, "support: no non-GET request in the whole pass", sup.writes);
  drill.check(sup.errors.length === 0, "support: no error in the browser console", sup.errors);
  await sup.page.setViewportSize({ width: 375, height: 812 });
  for (const p of [LIST, EDIT]) {
    await open(sup.page, p);
    const overflow = await sup.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    drill.check(overflow <= 1, `support at 375px: ${p} has no sideways page scroll`, overflow);
  }
  await drill.shoot(sup.page, "support-375");
  out.support = { writes: sup.writes };

  writeFileSync(join(drill.dir, "result.json"), `${JSON.stringify({ id: DRILL_ID, ranAt: new Date().toISOString(), passed: drill.checks.filter((c) => c.ok).length, failed: drill.checks.filter((c) => !c.ok).length, out, notes: drill.notes, failures: drill.checks.filter((c) => !c.ok) }, null, 2)}\n`);
}

runDrill({ id: DRILL_ID, part: "main", title: "QUIZZES — product-finder quizzes, staff, admin and support" }, quizzes).then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  },
);
