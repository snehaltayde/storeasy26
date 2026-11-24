// P6-DRILLS stage G (PUB-12, GEN-06 partly; owner answer OQ-P6-2; Phase 1
// line 3): step 4 of onboarding ("Open your store") and its policy starters,
// on a fresh closed p6 store, at /admin/onboarding?step=open.
// "Start a privacy page" makes a starter draft that still blocks opening; the
// item then offers "Read it" and "I've read it"; the same start again is
// refused; the founder saves the privacy page in the editor; "Start a returns
// page" and the step's own "I've read it" (no edit) for it; only then do the
// policies stop blocking. The storefront stays the closed page throughout.
import { changeOneSentence } from "./open.mjs";
import { closedPageFacts, docsOf, loginP6, p6Context, p6Url, settle, sleep, waitFor, watchErrors, reseedP6 } from "./lib.mjs";

const SENTENCE = "We keep your details only for your orders and never sell them.";
export const OPEN_STEP_PATH = "/admin/onboarding?step=open";

// GET /api/admin/onboarding, as the page reads it: the open step and its items
export async function readOnboarding(page) {
  return page.evaluate(async () => {
    const res = await fetch("/api/admin/onboarding", { headers: { Accept: "application/json" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
}
async function readOpenStep(page) {
  const r = await readOnboarding(page);
  const step = (r.body?.steps || []).find((x) => x.id === "open") || null;
  const item = (id) => (step?.facts?.items || []).find((i) => i.id === id) || null;
  return { status: r.status, step, privacy: item("privacy"), returns: item("returns"), blocking: (step?.facts?.blocking || []).map((b) => b.id) };
}
const itemLi = (page, id) => page.locator(`[data-onboarding="panel"] [data-opening-item="${id}"]`);
async function openStep(drill, page) {
  await page.goto(p6Url(drill, OPEN_STEP_PATH), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await page.locator('[data-onboarding="panel"][data-step="open"]').waitFor({ timeout: 60_000 });
}
async function stillClosed(drill, tag) {
  const f = await closedPageFacts(p6Url(drill, "/"));
  drill.check(f.status === 200 && f.openingSoon, `the storefront is still the closed page (${tag})`, { status: f.status, openingSoon: f.openingSoon });
}
const actionsOf = (item) => (item?.actions || []).map((a) => `${a.type}:${a.label}`);
const textOf = async (loc) => (await loc.innerText().catch(() => "")).replace(/\s+/g, " ");

export async function setupStage(drill) {
  await reseedP6(drill, "g");
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  await openStep(drill, page);
  await stillClosed(drill, "at the start");
  let s = await readOpenStep(page);
  let priv = await textOf(itemLi(page, "privacy"));
  const ret = await textOf(itemLi(page, "returns"));
  drill.check(s.step?.state === "blocked" && s.blocking.includes("privacy") && s.blocking.includes("returns") && priv.includes("Start a privacy page") && ret.includes("Start a returns page") && priv.includes("These are starting points, not legal advice."), "step 4 is Blocked by both policy pages and offers 'Start a privacy page' and 'Start a returns page'", { state: s.step?.state, blocking: s.blocking, ui: priv.slice(0, 300) });
  await drill.screenshot(page, "g-open-step-start-1440");

  // ---- Start a privacy page ----
  await itemLi(page, "privacy").getByRole("button", { name: "Start a privacy page", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readOpenStep(page);
    return actionsOf(r.privacy).includes("markPolicyRead:I've read it") ? r : false;
  }, 30_000, 400);
  await sleep(800);
  priv = await textOf(itemLi(page, "privacy"));
  const privDoc = (await docsOf()).find((d) => d.type === "page" && /privacy/.test(d.slug || ""));
  drill.check(privDoc && privDoc.updated_by === "system:policy-starter" && !privDoc.published_version_id, "'Start a privacy page' makes a starter draft (marked as the starter's, not published)", privDoc);
  drill.check(s && s.blocking.includes("privacy") && priv.includes("Read it") && priv.includes("I've read it"), "the privacy page still blocks opening and the step now shows 'Read it' and 'I've read it'", { blocking: s?.blocking, ui: priv.slice(0, 300) });
  await drill.screenshot(page, "g-open-step-privacy-started-1440");
  await stillClosed(drill, "after starting the privacy page");

  // ---- the same start again is refused ----
  const again = await page.evaluate(async () => {
    const r = await fetch("/api/admin/policy-start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "privacy" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  drill.check(again.status === 409 && again.body?.code === "POLICY_PAGE_EXISTS" && String(again.body?.error).includes("You already have a privacy page"), "replaying the same POST is refused: 'You already have a privacy page…'", { status: again.status, code: again.body?.code, error: again.body?.error });
  drill.check((await docsOf()).filter((d) => d.type === "page" && /privacy/.test(d.slug || "")).length === 1, "still exactly one privacy page", null);

  // ---- the founder saves the privacy page in the editor ----
  const ed = await ctx.newPage();
  const saved = await changeOneSentence(ed, privDoc.id, SENTENCE);
  drill.check(Boolean(saved.saved) && saved.saved.updated_by !== "system:policy-starter", "the founder changes one sentence of the privacy page and the editor saves it", { updated_by: saved.saved?.updated_by });
  await ed.close();
  await openStep(drill, page);
  s = await readOpenStep(page);
  drill.check(!s.blocking.includes("privacy") && s.blocking.includes("returns") && actionsOf(s.returns).includes("startPolicy:Start a returns page"), "with only the privacy page saved, the returns page still blocks and 'Start a returns page' is offered", { blocking: s.blocking, returns: actionsOf(s.returns) });

  // ---- Start a returns page, then the step's own "I've read it" (no edit) ----
  await itemLi(page, "returns").getByRole("button", { name: "Start a returns page", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readOpenStep(page);
    return actionsOf(r.returns).includes("markPolicyRead:I've read it") ? r : false;
  }, 30_000, 400);
  await sleep(800);
  const terms = (await docsOf()).find((d) => d.type === "page" && /terms|refund|return/.test(d.slug || ""));
  drill.check(s && s.blocking.includes("returns") && terms?.updated_by === "system:policy-starter", "the returns starter is made; it still blocks opening (an unread starter never counts)", { blocking: s?.blocking, terms });
  const retText = await textOf(itemLi(page, "returns"));
  drill.check(retText.includes("Read it") && retText.includes("I've read it"), "the returns item shows 'Read it' and 'I've read it'", retText.slice(0, 300));
  await drill.screenshot(page, "g-open-step-returns-started-1440");
  await itemLi(page, "returns").getByRole("button", { name: "I've read it", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readOpenStep(page);
    return !r.blocking.includes("returns") ? r : false;
  }, 30_000, 400);
  await sleep(800);
  const terms2 = (await docsOf()).find((d) => d.id === terms.id);
  drill.check(Boolean(s) && terms2.updated_by !== "system:policy-starter" && !terms2.published_version_id, "after \"I've read it\" (no edit) the returns page no longer blocks opening; it counts as the founder's and is still a draft", { blocking: s?.blocking, terms: terms2 });
  const ui = await textOf(page.locator('[data-onboarding="panel"]'));
  drill.check(!(await itemLi(page, "returns").count()) || !(await textOf(itemLi(page, "returns"))).includes("Needed"), "the page shows the returns page as no longer needed", ui.slice(0, 300));
  await drill.screenshot(page, "g-open-step-done-1440");
  drill.check(!(await docsOf()).some((d) => d.published_version_id), "nothing was published by any of it", null);
  await stillClosed(drill, "at the end");
  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
