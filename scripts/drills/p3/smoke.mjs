// P3-HARNESS smoke drill: the phase 3 seed and the shared helpers work end to end.
//
//   DESIGN_PORT=3880 DESIGN_SQLD_PORT=4880 node scripts/drills/p3/smoke.mjs [--headed]
//
// 1. Seeds twice (node scripts/seed-design-documents.js --p3) and compares the
//    row counts; checks document_refs against every published version, the
//    closed store's state, and that the seed never prints a password.
// 2. Starts the harness, signs in as the owner and as staff through the real
//    form, and reads what each may do with the home page.
// 3. Opens / on the closed store ("Opening soon", no draft) and / on the live
//    store (the hero, the banner to the live campaign, the product rail), plus
//    the live and the unpublished campaign and the page whose draft links to it.
// Results: docs/cms-reviews/drills/P3-HARNESS/results-smoke.json, with screenshots.
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DrillError, SEED_FILE, bodyText, docsApi, noThanks, readSeed, reseed, runDrill, seedState, settle, startOwned, storeSql, storeUrl } from "./lib.mjs";

const counts = (s) => ({ rows: s.p3.rows, refs: { publishedVersions: s.p3.refs.publishedVersions, versionsWithRefs: s.p3.refs.versionsWithRefs }, members: s.p3.members, platform: s.p3.platform, closed: s.p3.closed, documents: s.documents, published: s.published, dirty: s.dirty });

export async function smoke(drill) {
  // ---- 1. the seed, twice ----
  const first = await reseed(drill, { start: false });
  const a = await seedState();
  const second = await reseed(drill, { start: false });
  const b = await seedState();
  drill.check(JSON.stringify(counts(a)) === JSON.stringify(counts(b)), "the seed run twice gives the same row counts", { first: counts(a), second: counts(b) });
  drill.check(readSeed().seededAt !== null && a.liveRelease !== b.liveRelease, "the second run started again from scratch (a new live release, new ids)", { first: a.liveRelease, second: b.liveRelease });
  const refs = b.p3.refs;
  drill.check(refs.publishedVersions > 0 && refs.versionsWithRefs > 0 && refs.mismatched.length === 0 && refs.orphanRefs === 0, "document_refs holds exactly the refs of every seeded published version (none missing, none extra)", refs);
  const c = b.p3.closed;
  drill.check(c && c.mode === "documents" && c.liveRelease === null && c.releases === 0 && c.published === 0 && c.publishLog === 0 && c.documents > 0, "the closed store is in documents mode with no release (state none), drafts only", c);
  drill.check(b.p3.members.owner === 1 && b.p3.members.staff === 1, "the design store has one owner and one staff login", b.p3.members);
  const seed = readSeed();
  const secret = [seed.logins.owner.password, seed.logins.staff.password];
  drill.check(secret.every((p) => typeof p === "string" && p.length >= 12) && !secret.some((p) => first.out.includes(p) || second.out.includes(p)), "the seed prints neither password (they are only in the seed config)", null);
  const mode = statSync(SEED_FILE).mode & 0o777;
  drill.check(mode === 0o600, "the seed config is readable by its owner only (mode 600)", mode.toString(8));

  // ---- 2. sign in as owner and as staff ----
  await startOwned();
  const [homeRefs] = await storeSql("tenant", [{ sql: "SELECT ref_id FROM document_refs WHERE version_id = ? AND ref_type = 'document'", args: [seed.documents.home.publishedVersionId] }]);
  drill.check(homeRefs.rows.some((r) => r.ref_id === seed.documents.liveCampaign.id), "the live home page's refs name the live campaign (who links to it, for take offline)", homeRefs.rows.map((r) => r.ref_id));
  const [setRows] = await storeSql("tenant", [{ sql: "SELECT document_id, id FROM publish_log WHERE set_id = ?", args: [seed.publishSet.setId] }]);
  drill.check(setRows.rows.length === 3 && seed.publishSet.members.every((m) => setRows.rows.some((r) => r.id === m.logId && r.document_id === m.id)), "the last publish set holds three documents, one publish_log row each", setRows.rows);

  const ownerCtx = await drill.context();
  const clicks = await drill.clickCounter(ownerCtx);
  const owner = await drill.login("owner", { context: ownerCtx });
  drill.check(clicks.count === 1 && clicks.clicks[0].text === "Sign in", "the click counter saw the one click of the owner's sign-in", clicks.clicks);
  const ownHome = await docsApi(owner, { getDocument: "doc_home" });
  drill.check(ownHome.status === 200 && ownHome.body?.document?.access?.canPublish === true, "owner: signed in, and may publish the home page", { status: ownHome.status, access: ownHome.body?.document?.access });
  await settle(owner);
  await drill.screenshot(owner, "owner-dashboard");

  const staffCtx = await drill.context();
  const staff = await drill.login("staff", { context: staffCtx });
  const staffHome = await docsApi(staff, { getDocument: "doc_home" });
  drill.check(staffHome.status === 200 && staffHome.body?.document?.access?.canPublish === false && /can edit and preview/.test(staffHome.body?.document?.access?.reason || ""), "staff: signed in, may read the home page, may not publish it", { status: staffHome.status, access: staffHome.body?.document?.access });
  const g = (await docsApi(staff, { getDocument: seed.documents.guide.id })).body?.document;
  const staffPub = g ? await docsApi(staff, { publish: { id: g.id, draftHash: g.draftHash }, revision: g.revision }) : null;
  drill.check(staffPub?.status === 403, "staff: a publish is refused (403), nothing changes", { status: staffPub?.status, body: staffPub?.body });
  await settle(staff);
  await drill.screenshot(staff, "staff-dashboard");
  await ownerCtx.close();
  await staffCtx.close();

  // ---- 3. the two stores, as a shopper ----
  const shopper = await drill.context();
  const page = await shopper.newPage();

  const closedRes = await page.goto(storeUrl(drill, "closed", "/"), { waitUntil: "load", timeout: 120_000 });
  await page.waitForTimeout(500);
  const closedText = await bodyText(page);
  drill.check(closedRes?.status() === 200 && /Opening soon/.test(closedText), "closed store: / shows 'Opening soon'", { status: closedRes?.status(), text: closedText.slice(0, 200) });
  drill.check(!closedText.includes(seed.stores.closed.draftTitle), "closed store: no draft reaches the shopper", null);
  await drill.screenshot(page, "closed-home-1440");

  // the hero runs the seeded experiment, so a new visitor sees either title
  const res = await drill.open(page, storeUrl(drill, "live", "/"));
  await noThanks(page);
  const facts = await drill.facts(page);
  const banner = await page.evaluate((slug) => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === `/campaigns/${slug}`), seed.documents.liveCampaign.slug);
  const railLinks = await page.evaluate((id) => document.querySelector(`[data-section-id="${id}"]`)?.querySelectorAll('a[href^="/products/"]').length ?? null, seed.documents.home.productRail.sectionId);
  drill.check(res.status === 200 && !facts.errorPage && /Skin first|Visibly brighter in 14 days/.test(facts.text) && /This weekend only/.test(facts.text), "live store: / shows the live home page (hero and the campaign banner)", { status: res.status, errorPage: facts.errorPage, h1: facts.h1 });
  drill.check(banner, "live store: the home page links to the live campaign", { slug: seed.documents.liveCampaign.slug });
  drill.check(railLinks === null ? /Top rated/.test(facts.text) : railLinks > 0, "live store: the product rail shows products from its collection", { railLinks, collection: seed.documents.home.productRail.collection });
  if (railLinks === null) drill.note("the product rail section carries no data-section-id outside preview, so the rail was found by its title");
  await drill.screenshot(page, "live-home-1440");

  const camp = await drill.open(page, storeUrl(drill, "live", seed.documents.liveCampaign.path));
  drill.check(camp.status === 200 && /This weekend only/.test(await bodyText(page)), "live store: the live campaign answers", { status: camp.status, path: seed.documents.liveCampaign.path });
  const soon = await drill.open(page, storeUrl(drill, "live", seed.documents.unpublishedCampaign.path));
  const soonText = await bodyText(page);
  drill.check(soon.status === 404 && !soonText.includes("still a draft"), "live store: the unpublished campaign is not there (404, no draft text)", { status: soon.status });
  const guide = await drill.open(page, storeUrl(drill, "live", seed.documents.guide.path));
  const guideText = await bodyText(page);
  drill.check(guide.status === 200 && /Changing your routine for spring/.test(guideText) && !/Take a look/.test(guideText), "live store: the guide page is live, without its draft's link to the unpublished campaign", { status: guide.status });
  const post = await drill.open(page, storeUrl(drill, "live", seed.documents.journalPost.path));
  drill.check(post.status === 200, "live store: the journal post answers", { status: post.status, path: seed.documents.journalPost.path });
  await shopper.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDrill({ id: "P3-HARNESS", part: "smoke", title: "P3-HARNESS — seed and helpers smoke" }, smoke).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`✗ ${e instanceof DrillError ? e.message : e.stack || e}`);
      process.exit(1);
    },
  );
}
