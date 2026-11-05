// P6-DRILLS stage G (PUB-12, GEN-06 partly; owner answer OQ-P6-2): the
// onboarding checklist's policy starters, on a fresh closed p6 store.
// "Start a privacy page" makes a starter draft that does not tick the step;
// the checklist then offers "Read your privacy page"; the same start again is
// refused; the founder saves the privacy page in the editor; "Start a returns
// page" and the checklist's own "I've read it" (no edit) for it; only then is
// the step done. The storefront stays the closed page throughout.
import { changeOneSentence } from "./open.mjs";
import { closedPageFacts, docsOf, loginP6, p6Context, p6Url, settle, sleep, waitFor, watchErrors, reseedP6 } from "./lib.mjs";

const SENTENCE = "We keep your details only for your orders and never sell them.";
const LABEL = "Add your legal pages";

async function readSetup(page) {
  const r = await page.evaluate(async () => {
    const res = await fetch("/api/admin/setup", { headers: { Accept: "application/json" } });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  const step = (r.body?.items || []).find((i) => i.id === "policies") || null;
  return { status: r.status, step, all: r.body };
}
const stepLi = (page) => page.locator("ol > li").filter({ hasText: LABEL }).first();
async function openSetup(drill, page) {
  await page.goto(p6Url(drill, "/admin/setup"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  await stepLi(page).waitFor({ timeout: 60_000 });
}
async function stillClosed(drill, tag) {
  const f = await closedPageFacts(p6Url(drill, "/"));
  drill.check(f.status === 200 && f.openingSoon, `the storefront is still the closed page (${tag})`, { status: f.status, openingSoon: f.openingSoon });
}
const actionsOf = (step) => (step?.actions || []).map((a) => `${a.type}:${a.label}`);

export async function setupStage(drill) {
  await reseedP6(drill, "g");
  const ctx = await p6Context(drill);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  await openSetup(drill, page);
  await stillClosed(drill, "at the start");
  let s = await readSetup(page);
  let li = stepLi(page);
  let liText = (await li.innerText()).replace(/\s+/g, " ");
  drill.check(s.step?.label === LABEL && !s.step.done && liText.includes("Start a privacy page") && liText.includes("Start a returns page") && liText.includes("These are starting points, not legal advice."), "/admin/setup shows 'Add your legal pages' with 'Start a privacy page' and 'Start a returns page'", { step: s.step, ui: liText.slice(0, 300) });
  await drill.screenshot(page, "g-setup-start-1440");

  // ---- Start a privacy page ----
  await li.getByRole("button", { name: "Start a privacy page", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readSetup(page);
    return actionsOf(r.step).some((a) => a === "link:Read your privacy page") ? r : false;
  }, 30_000, 400);
  await sleep(800);
  li = stepLi(page);
  liText = (await li.innerText()).replace(/\s+/g, " ");
  const priv = (await docsOf()).find((d) => d.type === "page" && /privacy/.test(d.slug || ""));
  drill.check(priv && priv.updated_by === "system:policy-starter" && !priv.published_version_id, "'Start a privacy page' makes a starter draft (marked as the starter's, not published)", priv);
  drill.check(s && !s.step.done && liText.includes("Read your privacy page"), "the step stays not done and now shows 'Read your privacy page'", { done: s?.step?.done, actions: actionsOf(s?.step), ui: liText.slice(0, 300) });
  await drill.screenshot(page, "g-setup-privacy-started-1440");
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
  const saved = await changeOneSentence(ed, priv.id, SENTENCE);
  drill.check(Boolean(saved.saved) && saved.saved.updated_by !== "system:policy-starter", "the founder changes one sentence of the privacy page and the editor saves it", { updated_by: saved.saved?.updated_by });
  await ed.close();
  await openSetup(drill, page);
  s = await readSetup(page);
  drill.check(!s.step.done && actionsOf(s.step).includes("startPolicy:Start a returns page") && !actionsOf(s.step).some((a) => /privacy/i.test(a)), "with only the privacy page saved, the step is still not done and offers 'Start a returns page'", actionsOf(s.step));

  // ---- Start a returns page, then the checklist's "I've read it" (no edit) ----
  await stepLi(page).getByRole("button", { name: "Start a returns page", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readSetup(page);
    return actionsOf(r.step).some((a) => a === "markPolicyRead:I've read it") ? r : false;
  }, 30_000, 400);
  await sleep(800);
  const terms = (await docsOf()).find((d) => d.type === "page" && /terms|refund|return/.test(d.slug || ""));
  drill.check(s && !s.step.done && terms?.updated_by === "system:policy-starter", "the returns starter is made; the step is still not done (an unread starter never counts)", { done: s?.step?.done, terms });
  li = stepLi(page);
  liText = (await li.innerText()).replace(/\s+/g, " ");
  drill.check(liText.includes("Read your returns page") && liText.includes("I've read it"), "the checklist shows 'Read your returns page' and 'I've read it'", liText.slice(0, 300));
  await drill.screenshot(page, "g-setup-returns-started-1440");
  await li.getByRole("button", { name: "I've read it", exact: true }).click();
  s = await waitFor(async () => {
    const r = await readSetup(page);
    return r.step?.done ? r : false;
  }, 30_000, 400);
  await sleep(800);
  const terms2 = (await docsOf()).find((d) => d.id === terms.id);
  drill.check(Boolean(s) && s.step.done === true && terms2.updated_by !== "system:policy-starter" && !terms2.published_version_id, "after \"I've read it\" (no edit) the step is done; the returns page counts as the founder's and is still a draft", { done: s?.step?.done, terms: terms2 });
  await drill.screenshot(page, "g-setup-done-1440");
  drill.check(!(await docsOf()).some((d) => d.published_version_id), "nothing was published by any of it", null);
  await stillClosed(drill, "at the end");
  drill.check(errors.length === 0, "no page errors", errors);
  await ctx.close();
}
