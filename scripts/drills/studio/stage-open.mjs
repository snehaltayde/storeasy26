// drill:studio stage "open" (Phase 6 line 1, docs/plans/phase-6.md "Line 1"
// drill stages): the owner opens /admin/studio and the frame reaches
// "Up to date". Seeding (documents API, as the owner): a home page of four
// rich text sections ("Drill one" … "Drill four") published with the design
// so the store is open, and an older About page draft that this session
// never touches (stage publish checks it stays a draft).
// Helpers the later line 1 stages share are exported from here.
// Selectors are data-* hooks and exact names; every wait is for an element
// or an answer, never a fixed time (the save delay is a route's).
import { ORIGIN, open, signIn, stage, state } from "./lib.mjs";
import { CONSENT_COOKIE, serializeConsent } from "../../../lib/track/names.js";

// The roles store's fixture products point at pictures that don't exist (Next's image route
// would 404 into the console check); a 1x1 gif stands in, as drill:themes does.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
export const stubImages = (ctx) => ctx.route("**/_next/image**", (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
// the shopper has answered the cookie banner (declined)
export const consent = (ctx) => ctx.addCookies([{ name: CONSENT_COOKIE, value: encodeURIComponent(serializeConsent({ analytics: false, marketing: false })), url: ORIGIN }]);

export const docsApi = (page, body) =>
  page.evaluate(async (b) => {
    const r = await fetch("/api/admin/documents", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, body);

export const HOME_IDS = ["sec_drillone1", "sec_drilltwo2", "sec_drillthree3", "sec_drillfour4"];
const TITLES = ["Drill one", "Drill two", "Drill three", "Drill four"];
const homeBody = () => ({ schema: 1, type: "home", meta: {}, sections: HOME_IDS.map((id, i) => ({ id, kind: "rich_text", v: 1, enabled: true, settings: { title: TITLES[i], html: `<p>${TITLES[i]} words.</p>` }, blocks: [] })) });

// the frame's section order inside [data-doc=doc], as drawn: style.order (the
// instant message's) first, then the DOM's own order; hidden ones left out
export const frameOrder = (page, doc = "doc_home") =>
  page.locator("[data-preview-frame]").evaluate((f, d) => {
    const root = f.contentDocument?.querySelector(`[data-doc="${d}"]`);
    if (!root) return [];
    const els = [...root.querySelectorAll("[data-section-id]")].filter((el) => !el.parentElement.closest(`[data-section-id]`));
    return els
      .map((el, i) => ({ id: el.getAttribute("data-section-id"), o: Number(el.style.order || 0), i, hidden: el.hasAttribute("data-studio-hidden") }))
      .filter((x) => !x.hidden)
      .sort((a, b) => a.o - b.o || a.i - b.i)
      .map((x) => x.id);
  }, doc);

// the frame's order once it matches `want` (the instant message is a
// postMessage, handled on the frame's next task), or the last order seen
export async function frameOrderOnce(page, want, { doc = "doc_home", ms = 3000 } = {}) {
  const end = Date.now() + ms;
  let got = [];
  do {
    got = await frameOrder(page, doc);
    if (JSON.stringify(got) === JSON.stringify(want)) return got;
    await page.waitForTimeout(50);
  } while (Date.now() < end);
  return got;
}

export const upToDate = (page) => page.locator('[data-preview-status="Up to date"]').waitFor();
export const railOrder = (page) => page.locator("[data-studio-sections] [data-section-row]").evaluateAll((els) => els.map((el) => el.getAttribute("data-section-row")));

export async function openStudio(drill, role, path = "/admin/studio") {
  const page = await signIn(drill, role);
  await stubImages(page.context());
  await consent(page.context()); // the frame is the storefront: no cookie banner over it
  const status = await open(page, path);
  drill.check(status === 200, `${role}: /admin/studio answers 200`, status);
  await page.locator("[data-studio]").waitFor();
  await page.locator("[data-studio-sections] [data-section-row]").first().waitFor();
  return page;
}

stage("open", async (drill) => {
  // --- seed, as the owner, through the documents API ---
  const owner = await signIn(drill, "owner");
  await stubImages(owner.context());
  await open(owner, "/admin");
  let home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document ?? null;
  if (!home) {
    const made = await docsApi(owner, { createDocument: { type: "home", body: homeBody() } });
    drill.check(made.status === 200, "seed: a home page is made", made.body?.error);
  } else {
    const saved = await docsApi(owner, { saveDraft: { id: "doc_home", body: homeBody() }, revision: home.revision });
    drill.check(saved.status === 200, "seed: the home page holds the four drill sections", saved.body?.error);
  }
  home = (await docsApi(owner, { getDocument: "doc_home" })).body?.document;
  let design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  if (!design) {
    await docsApi(owner, { createDocument: { type: "design", body: { schema: 1, type: "design", meta: {}, settings: { brand: null, theme: null, logo: null } } } });
    design = (await docsApi(owner, { getDocument: "doc_design" })).body?.document ?? null;
  }
  const set = [{ id: "doc_home", revision: home.revision, draftHash: home.draftHash }];
  if (design && design.draftHash !== design.publishedHash) set.push({ id: "doc_design", revision: design.revision, draftHash: design.draftHash });
  const pub = await docsApi(owner, { publishSet: set });
  drill.check(pub.status === 200, "seed: the home page (and the design) are live", pub.body?.error || pub.body?.code);
  // an older About draft nobody touches in the studio
  const about = await docsApi(owner, { createDocument: { type: "page", meta: { slug: "drill-about", title: "Drill about" }, body: null, entityId: null } });
  drill.check(about.status === 200, "seed: an About page draft", about.body?.error);
  state.aboutId = about.body?.document?.id ?? null;
  await owner.context().close();

  // --- the owner opens the studio ---
  const page = await openStudio(drill, "owner");
  drill.check((await page.locator("[data-studio]").evaluate((el) => getComputedStyle(el).position)) === "fixed", "the studio fills the viewport (fixed, no console shell)");
  await upToDate(page);
  drill.check(true, "the frame reaches \"Up to date\"");
  drill.check(JSON.stringify(await railOrder(page)) === JSON.stringify(HOME_IDS), "the rail lists the four sections in order", await railOrder(page));
  drill.check(JSON.stringify(await frameOrder(page)) === JSON.stringify(HOME_IDS), "the frame draws them in the same order", await frameOrder(page));
  for (const words of ["Exit studio", "Publish"]) drill.check((await page.getByText(words, { exact: true }).count()) > 0, `top bar: ${words}`);
  drill.check((await page.locator("[data-studio-fullscreen]").count()) === 1 && (await page.locator("[data-studio-switcher]").count()) === 1, "top bar: full screen and the document switcher");
  await drill.shoot(page, "open");
  await page.context().close();
});
