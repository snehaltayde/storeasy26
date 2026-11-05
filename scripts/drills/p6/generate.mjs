// P6-DRILLS stage 0 (baseline) and stage A (US-01, GEN-01): the P3-CLOSED RSC
// probe on the P3 closed store, then a fresh closed documents store made from
// its catalog with no AI key, and the same probe on it before it opens.
import { ROOT, harnessEnv, harnessPorts, readCredentials } from "../../design-harness.js";
import { reseed, storeUrl } from "../p3/lib.mjs";
import {
  AI_HOST,
  P6_STORE,
  closedPageFacts,
  cssVarsOf,
  docOf,
  docsOf,
  frameCssVars,
  frameEval,
  frameText,
  isLime,
  liveRelease,
  loginP6,
  LOGO_FACTS,
  noThanks,
  openEditor,
  p6Context,
  p6DbUrl,
  p6Sql,
  p6Url,
  reseedP6,
  rscProbe,
  settle,
  waitFor,
  watchErrors,
  watchHosts,
  writeJson,
} from "./lib.mjs";

const slimProbe = (p) => ({ base: p.base, contentStrings: p.contentStrings, sample: p.sample, droppedAsCatalogOrName: p.droppedAsCatalogOrName, requests: p.requests, withLeaks: p.withLeaks, statuses: p.statuses, leaks: p.results.filter((r) => r.leaks.length).map((r) => ({ path: r.path, kind: r.kind, cookies: r.cookies, leaks: r.leaks.slice(0, 5) })) });

// ---------------------------------------------------------------------------
// stage 0: the P3 closed store, as the P3 drills leave it, probed once
// ---------------------------------------------------------------------------
export async function baselineStage(drill) {
  await reseed(drill, { start: true });
  const base = storeUrl(drill, "closed", "/");
  const { dbUrl } = await import("../../design-harness.js");
  const probe = await rscProbe({ base, db: dbUrl(harnessPorts().sqld.default), exclude: ["Closed Demo Co"] });
  writeJson("rsc-probe-baseline.json", probe);
  drill.check(probe.contentStrings > 0, `baseline: the probe found content strings in the P3 closed store's drafts (${probe.contentStrings})`, probe.sample);
  drill.check(probe.requests === 64 && probe.withLeaks === 0, "baseline (P3-CLOSED rsc-probe): 64 anonymous requests (8 routes x 4 cookie sets x HTML and RSC: 1) to the P3 closed store carry none of its content strings", slimProbe(probe));
  drill.check(probe.results.filter((r) => r.path === "/" && r.kind === "html").every((r) => r.openingSoon), "baseline: the closed store's home says 'Opening soon' to every cookie set", probe.results.filter((r) => r.path === "/").map((r) => [r.kind, r.cookies, r.openingSoon]));
  // control: the same probe on the open design store finds its content (the probe bites)
  const control = await rscProbe({ base: storeUrl(drill, "live", "/"), db: dbUrl(harnessPorts().sqld.tenant), exclude: ["Design Demo Co"] });
  writeJson("rsc-probe-open-control.json", slimProbe(control));
  drill.check(control.withLeaks > 0, `baseline control: the same probe on the OPEN design store finds its content in ${control.withLeaks} of ${control.requests} answers (so a 0 above means something)`, { withLeaks: control.withLeaks, sample: control.results.find((r) => r.leaks.length)?.leaks.slice(0, 3) });
  const ctx = await drill.context({ width: 1440 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  drill.check((await page.locator("body").innerText()).includes("Opening soon"), "baseline: in Chrome the closed store shows 'Opening soon'", null);
  await drill.screenshot(page, "baseline-p3-closed-1440");
  await ctx.close();
}

// ---------------------------------------------------------------------------
// stage A: open /admin/start, the store is made, nothing is public
// ---------------------------------------------------------------------------
export async function generateStage(drill) {
  const seed = await reseedP6(drill, "a");
  const hEnv = harnessEnv(process.env, readCredentials(ROOT), harnessPorts());
  drill.check(hEnv.ANTHROPIC_API_KEY === "" && process.env.ANTHROPIC_API_KEY === "", "the harness runs with ANTHROPIC_API_KEY blank (no AI key at all)", { harness: hEnv.ANTHROPIC_API_KEY === "" ? "blank" : "SET", here: process.env.ANTHROPIC_API_KEY === "" ? "blank" : "SET" });
  drill.check(seed.state.mode === "documents" && seed.state.documents === 0 && seed.state.liveRelease == null && seed.state.latestSync.status === "complete" && seed.state.products === 24, "the stage seed: a documents store with no documents, no live release, and a complete sync of 24 products", seed.state);

  const ctx = await p6Context(drill);
  const hosts = watchHosts(ctx);
  const errors = watchErrors(ctx);
  const page = await loginP6(drill, ctx);
  drill.note(`after sign-in the founder lands on ${new URL(page.url()).pathname}`);
  const t0 = Date.now();
  await page.goto(p6Url(drill, "/admin/start"), { waitUntil: "load", timeout: 120_000 });
  await settle(page);
  const state = await waitFor(async () => {
    const s = await page.locator("[data-first-run]").getAttribute("data-first-run").catch(() => null);
    return s && !["loading", "making"].includes(s) ? s : false;
  }, 120_000, 300);
  const card = (await page.locator("[data-first-run]").innerText()).replace(/\s+/g, " ").trim();
  drill.check(state === "ready" && card.includes("Your starting store is ready") && card.includes("the Slate colours") && card.includes("Nothing is public yet."), `/admin/start: the store is made (${((Date.now() - t0) / 1000).toFixed(1)} s from opening the page) and the page says what was made, in Slate, and that nothing is public`, card.slice(0, 400));
  await drill.screenshot(page, "a-start-ready-1440");

  const docs = await docsOf();
  const home = docs.find((d) => d.id === "doc_home");
  const design = docs.find((d) => d.id === "doc_design");
  drill.check(home && design && home.updated_by === "system:first-run" && design.updated_by === "system:first-run" && !home.published_version_id && !design.published_version_id, "the generator made doc_home and doc_design as drafts (updated_by system:first-run, nothing published)", docs.map((d) => [d.id, d.updated_by, d.published_version_id]));
  drill.check(!docs.some((d) => d.id === "doc_header" || d.id === "doc_footer"), "no header or footer document: they stay on the automatic menus from the catalog", docs.map((d) => d.id));
  drill.check((await liveRelease()) == null, "no live release: the store is still closed", null);

  await openEditor(page, "?doc=doc_home");
  const ftext = await waitFor(async () => {
    const t = await frameText(page);
    return t.includes(P6_STORE.name) && t.length > 400 ? t : false;
  }, 90_000, 500);
  const body = (await docOf("doc_home")).body;
  const kinds = body.sections.map((s) => s.kind);
  const rails = body.sections.filter((s) => s.kind === "product_rail").map((s) => s.settings?.title).filter(Boolean);
  drill.check(kinds[0] === "hero" && kinds.includes("product_rail") && kinds.length >= 3, "the home draft: a hero first, then product rows and more", kinds);
  const f = await frameEval(page, LOGO_FACTS);
  const vars = await frameCssVars(page);
  const collections = (await p6Sql(["SELECT title, handle FROM collections ORDER BY title"]))[0].rows.map((r) => ({ title: String(r.title), handle: String(r.handle) }));
  drill.check(Boolean(ftext) && rails.every((t) => ftext.includes(t)), `the preview shows the hero (the store name) and the rows (${rails.join(", ")})`, String(ftext).slice(0, 300));
  drill.check(f && collections.every((c) => f.headerLinks.some(([, h]) => h === `/collections/${c.handle}`)), "the preview's header menu is the catalog's collections", { header: f?.headerLinks, collections: collections.map((c) => c.handle) });
  drill.check(f && f.footerText.includes(P6_STORE.name) && f.footerLinks.length > 0, "the preview has a footer (store name and links)", f?.footerText);
  drill.check(vars && vars["--accent-500"].toLowerCase() === "#334155" && !(await isLime(vars["--accent-500"])), "the preview's accent is Slate (#334155), not lime", vars);
  await drill.screenshot(page, "a-editor-preview-1440");

  // the storefront, as a shopper: still the closed page, no draft words
  const sctx = await drill.browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sp = await sctx.newPage();
  const res = await sp.goto(p6Url(drill, "/"), { waitUntil: "load", timeout: 120_000 });
  await settle(sp);
  await noThanks(sp);
  const shopText = (await sp.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const hero = body.sections.find((s) => s.kind === "hero")?.settings || {};
  const draftWords = [hero.subtitle, hero.primary?.label, ...rails.map((t) => `${t}`)].filter((w) => typeof w === "string" && w.length > 3);
  drill.check(res?.status() === 200 && shopText.includes("Opening soon") && !draftWords.some((w) => shopText.includes(w)) && !shopText.includes("Add to cart"), "p6.localhost for a shopper is still the closed page ('Opening soon'), with none of the draft's words", { text: shopText.slice(0, 200), draftWords });
  const shopVars = await cssVarsOf(sp);
  drill.note(`the closed page's accent: ${shopVars["--accent-500"] || "(none set)"}`);
  await drill.screenshot(sp, "a-storefront-closed-1440");
  const raw = await closedPageFacts(p6Url(drill, "/"));
  drill.check(raw.status === 200 && raw.openingSoon && !draftWords.some((w) => raw.html.includes(w)), "the raw HTML of / carries none of the draft's words either", { status: raw.status, bytes: raw.bytes });
  await sctx.close();

  const ai = hosts.filter((h) => h.hostname === AI_HOST);
  const other = [...new Set(hosts.map((h) => h.hostname))];
  drill.check(ai.length === 0, `the browser's network log: 0 requests to ${AI_HOST} (${hosts.length} requests, hosts: ${other.join(", ")})`, ai);
  drill.check(errors.length === 0, "no page errors in the console pages", errors);
  await ctx.close();

  // the P3-CLOSED probe on the generated, unpublished store
  const probe = await rscProbe({ base: p6Url(drill, "/"), db: p6DbUrl(), exclude: [P6_STORE.name] });
  writeJson("rsc-probe-p6-generated.json", probe);
  drill.check(probe.contentStrings > 0, `probe: the generated drafts hold ${probe.contentStrings} content strings to look for`, probe.sample);
  drill.check(probe.requests === 64 && probe.withLeaks === 0, "probe (P3-CLOSED rsc-probe) on the generated, unpublished p6 store: 64 anonymous HTML and RSC: 1 answers carry none of the drafts' strings", slimProbe(probe));
}
