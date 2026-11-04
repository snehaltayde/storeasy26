// P4-MAPPER suite (MIG-01, MIG-02, DOC-03): the legacy store as documents, and
// the read-only dry run. File databases only (.test-mmap-*.db at the checkout's
// root, removed at the end); no network, no sqld, no Typesense, no Shopify.
//   1. every 8.11 state row maps as the spec says; "no release" needs the flag
//   2. every mapping trap maps as the spec says
//   3. the same store maps to the same output twice; any legacy edit changes
//      the source hash
//   4. a draft that differs from what is live stays a draft; an unchanged
//      store has no dirty document
//   5. the candidate list parses, and the data check equals the legacy
//      outputs on every fixture state, in-process, with no write
//   6. a running hero experiment serves the same hero on the migrated home
//   7. the reconcile report; values over a limit are carried as stored
//   8. the dry-run command: read-only, the digest, the facts, the refusals
//   9. the plain report: verdict first, sections in order, no codes above
//      Details, --json holds everything, one digest
//  10. team access for the cart offer, from the role table
//  11. DOC-03: every section of every body is a merged, registered kind
//  12. editability: typeHasEditor's system check, and cartEditable() refusals
//   pnpm test:migrate-map
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  COL,
  ENTITY_FIXTURES,
  HERO_EXPERIMENT,
  MAPPING_TRAPS,
  P,
  STATE_ROWS,
  ROOT,
  allGetterRoutes,
  buildLegacyTenant,
  buildPhase3Leftovers,
  buildStaleBackfill,
  installHooks,
  makeLegacyTenant,
  openWorld,
} from "./support/legacy-tenants.js";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, msg = "") => {
  const x = JSON.stringify(canon(a));
  const y = JSON.stringify(canon(b));
  if (x !== y) throw new Error(`${msg}\n      expected ${y?.slice(0, 600)}\n      got      ${x?.slice(0, 600)}`);
};

// The plain part of the ready journal store's report (part 9), word for word.
const READY_SNAPSHOT = [
  "Ready to move",
  "",
  "What shoppers will see change",
  "  Nothing.",
  "",
  "Unpublished changes that will carry over as drafts",
  "  - The campaign page “Spring sale” (/campaigns/spring)",
  "  - The journal post “First post” (/journal/first-post)",
  "  - The journal post “Gone” (/journal/ended-post)",
  "  - The journal post “Live only” (/journal/live-only-post): you deleted it in your drafts, but it is still live. After the move it stays live until you take it offline in the new editor.",
  "  - The journal post “Not yet” (/journal/future-post)",
  "  - The journal post “Second post” (/journal/second-post)",
  "  - The journal post “Switched off” (/journal/off-post)",
  "  - The journal post “Undated” (/journal/undated-post)",
  "  - The page “About” (/about)",
  "  - The page “Hidden” (/policies/hidden-policy)",
  "  - The page “Shipping” (/policies/shipping)",
  "",
  "Drafts kept as older versions",
  "  None.",
  "",
  "Things the new editor will flag",
  "  None.",
  "",
  "Old addresses that couldn't be matched",
  "  None.",
  "",
  "Saved templates",
  "  None.",
  "",
  "Team access that changes",
  "  None.",
  "",
].join("\n");

installHooks({ headers: "real" });
const world = await openWorld({ prefix: ".test-mmap" });
const Res = await import("../lib/content/resolve.js");
const Docs = await import("../lib/content/documents-reader.js");
const Reg = await import("../lib/registry/index.js");
const Ed = await import("../lib/registry/editability.js");
const M = await import("../lib/migrate/map.js");
const C = await import("../lib/migrate/check.js");
const S = await import("../lib/migrate/state.js");
const Ids = await import("../lib/migrate/ids.js");
const Rep = await import("../lib/migrate/report.js");
const { roleAllows } = await import("../lib/platform/authz.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { heroVariantFor, heroVariantSettings } = await import("../lib/experiments.js");
const { defaultHero } = await import("../lib/cms/defaults.js");
const { libsql } = await import("../lib/db.js");

let seq = 0;
const built = []; // every mapping the suite made, for the DOC-03 walk
async function tenant({ id, state = "live_v3", traps = [], entities = [], set = "vgate", drafts, config } = {}) {
  const file = `t${++seq}`;
  const { db, manifest } = await makeLegacyTenant(world, { id, file, state, traps, entities, set, drafts, config });
  return { db, manifest };
}
const flagOf = (state) => {
  const f = STATE_ROWS[state]?.flag;
  return f === "--store-open" ? true : f === "--not-launched" ? false : undefined;
};
async function mapIt(db, { storeOpen, editability, record = true } = {}) {
  const out = await db.run(() => M.mapTenant({ storeOpen, platform: world.control.platformDb(), ...(editability ? { editability } : {}) }));
  if (record) built.push(out);
  return out;
}
const doc = (out, id) => out.documents.find((d) => d.id === id);
const exec = (db, sql, args = []) => db.run(() => libsql.execute({ sql, args }));
const fileHash = async (db) => createHash("sha256").update(await readFile(join(ROOT, db.file))).digest("hex");
const routes = await allGetterRoutes();
async function checkOf(db, out) {
  return db.run(() => C.dataCheck(out, { routes: C.routesFor(out.source, routes) }));
}
// the differences a check may show: an old address whose page isn't stored
// (reported unresolved by the mapper, a real change for shoppers)
function onlyUnresolved(out, check, msg) {
  const allowed = new Set(out.report.unresolvedRedirects.filter((r) => r.side === "published").map((r) => r.from_slug));
  for (const d of check.differences) ok(d.fn === "resolvedSlugRedirect" && allowed.has(d.args[0]), `${msg}: unexpected difference ${JSON.stringify(d).slice(0, 500)}`);
  eq(check.differences.length, allowed.size, `${msg}: one difference per unresolved live address:`);
}

try {
  // ====================================================================================
  console.log("— 1. the 8.11 state rows");
  // ====================================================================================
  await t("classifyState: every row of the table, and the refusals the operator flag can't override", async () => {
    const live = (v) => ({ state: "live", release: { id: `rel_${v}`, v } });
    eq(S.classifyState({ live: live(1) }).published, "release+tables", "v1:");
    eq(S.classifyState({ live: live(2) }).published, "release", "v2:");
    eq(S.classifyState({ live: live(3) }).state, "live_v3", "v3:");
    eq(S.classifyState({ live: { state: "none" }, storeOpen: true }).published, "drafts", "open:");
    eq(S.classifyState({ live: { state: "none" }, storeOpen: false }).published, "none", "not launched:");
    const unconfirmed = S.classifyState({ live: { state: "none" } });
    eq(unconfirmed.published, null, "no flag: published");
    eq(unconfirmed.refusals[0].code, "NEEDS_FLAG", "no flag:");
    eq(unconfirmed.refusals[0].message, "needs --store-open or --not-launched", "no flag message:");
    eq(S.classifyState({ live: live(3), pendingSchedules: [{ id: "rel_x", scheduled_for: "2099-01-01" }] }).refusals[0].code, "PENDING_SCHEDULE", "schedule:");
    eq(S.classifyState({ live: { state: "error", error: "x" }, storeOpen: true }).refusals[0].code, "LIVE_READ_ERROR", "error (flag ignored):");
    eq(S.classifyState({ mode: "documents", live: live(3) }).refusals[0].code, "ALREADY_DOCUMENTS", "documents:");
    eq(S.classifyState({ mode: "migrating", live: live(3) }).refusals[0].code, "MIGRATING", "migrating:");
    eq(S.classifyState({ live: live(3), storeOpen: true }).notes[0].code, "FLAG_IGNORED", "a flag on a live store is noted:");
  });

  await t("live_v1: published from the v1 release plus the live tables (cart offer, redirects); drafts from the tables", async () => {
    const { db } = await tenant({ state: "live_v1" });
    const out = await mapIt(db);
    eq(out.state.name, "live_v1", "state:");
    eq(out.state.published, "release+tables", "published:");
    const home = doc(out, "doc_home");
    eq(home.published.body.sections[0].settings.title, "Live hero v1", "live hero:");
    eq(home.draft.sections[0].settings.title, "Draft hero", "draft hero:");
    const cart = doc(out, "doc_cart").published.body.settings;
    eq(cart.title, "Table upsell", "cart title from the live table:");
    same(cart.products.map((p) => p.id), [P(2)], "cart products from the live table:");
    same(out.report.unresolvedRedirects.find((r) => r.side === "published"), { from_slug: "old-post", to_slug: "table-post", side: "published" }, "v1 redirect from the table:");
    ok(Docs.parseList(out.list), "the list parses");
  });

  await t("live_v2 and live_v3: published from the release's own frozen sets; v3 templates land on the header and footer", async () => {
    const v2 = await mapIt((await tenant({ state: "live_v2" })).db);
    eq(v2.state.published, "release", "v2 published:");
    eq(doc(v2, "doc_home").published.body.sections[0].settings.title, "Live hero v2", "v2 hero:");
    eq(doc(v2, "doc_cart").published.body.settings.title, "Frozen upsell", "v2 cart from the frozen placements:");
    same(doc(v2, "doc_cart").published.body.settings.products.map((p) => p.id), [P(3)], "v2 cart products:");
    eq(v2.report.unresolvedRedirects.find((r) => r.side === "published").to_slug, "frozen-post", "v2 frozen redirect:");
    const v3 = await mapIt((await tenant({ state: "live_v3" })).db);
    eq(doc(v3, "doc_home").published.body.sections[0].settings.title, "Live hero v3", "v3 hero:");
    eq(doc(v3, "doc_header").published.body.settings.template, "centered", "v3 header template:");
    eq(doc(v3, "doc_footer").published.body.settings.template, "minimal", "v3 footer template:");
    eq(v3.list.documents.doc_cart, null, "v3 froze no cart offer: the code default");
    eq(v3.list.documents.doc_collection_layout, null, "no collection template: the code default");
  });

  await t("no release, --store-open: the published versions are the drafts (nothing new is published); --not-launched: none", async () => {
    const open = await mapIt((await tenant({ state: "no_release_open" })).db, { storeOpen: true });
    eq(open.state.name, "no_release_open", "state:");
    eq(open.state.published, "drafts", "published:");
    for (const d of open.documents) {
      ok(d.published, `${d.id} has a published version`);
      eq(d.publishedHash, d.draftHash, `${d.id}: published equals the draft:`);
    }
    eq(doc(open, "doc_home").published.body.sections[0].settings.title, "Draft hero", "the drafts are what shoppers see today:");
    const closed = await mapIt((await tenant({ state: "no_release_not_launched" })).db, { storeOpen: false });
    eq(closed.state.published, "none", "not launched:");
    eq(closed.list, null, "no list");
    eq(closed.bodies.size, 0, "no version");
    ok(closed.documents.length > 0 && closed.documents.every((d) => !d.published && d.dirty), "every document is a never-published draft");
    const check = await checkOf((await tenant({ state: "no_release_not_launched" })).db, closed);
    eq(check.ran, false, "nothing to compare:");
    eq(check.reason, "NOTHING_PUBLISHED", "reason:");
  });

  await t("no release and no flag: a refusal that says 'needs --store-open or --not-launched', never a guess", async () => {
    const { db } = await tenant({ state: "no_release_open" });
    const out = await mapIt(db);
    eq(out.state.name, "no_release_unconfirmed", "state:");
    eq(out.list, null, "no list");
    ok(out.documents.every((d) => !d.published), "no published version");
    const r = out.report.refusals.find((x) => x.code === "NEEDS_FLAG");
    ok(r, "refused");
    eq(r.message, S.NEEDS_FLAG, "message:");
    eq(S.NEEDS_FLAG, "needs --store-open or --not-launched", "words:");
  });

  await t("pending schedule and live read error: refused, with no published versions", async () => {
    const p = await mapIt((await tenant({ state: "pending_schedule" })).db);
    eq(p.state.name, "pending_schedule", "schedule state:");
    eq(p.report.refusals[0].code, "PENDING_SCHEDULE", "schedule refusal:");
    eq(p.list, null, "schedule: no list");
    const e = await mapIt((await tenant({ state: "live_read_error" })).db, { storeOpen: true });
    eq(e.state.name, "live_read_error", "error state:");
    eq(e.report.refusals[0].code, "LIVE_READ_ERROR", "error refusal:");
    eq(e.list, null, "error: no list");
  });

  // ====================================================================================
  console.log("— 2. the mapping traps");
  // ====================================================================================
  await t("header and footer: null is automatic, [] is an empty custom menu, absent is the code default", async () => {
    const a = await mapIt((await tenant({ traps: ["nav_header_null", "nav_footer_empty"] })).db);
    same(doc(a, "doc_header").published.body.settings, { mode: "auto", items: [], template: "centered" }, "null:");
    same(doc(a, "doc_footer").published.body.settings, { mode: "custom", items: [], template: "minimal" }, "[]:");
    const b = await mapIt((await tenant({ state: "live_v1", traps: ["nav_header_absent", "nav_footer_absent"] })).db);
    eq(b.list.documents.doc_header, null, "absent header: code default");
    eq(b.list.documents.doc_footer, null, "absent footer: code default");
    ok(!doc(b, "doc_header") && !doc(b, "doc_footer"), "no document for an absent menu");
    const c = await mapIt((await tenant({ state: "live_v1" })).db);
    const items = doc(c, "doc_header").published.body.settings.items;
    same(items[0], { label: "Serums", link: { type: "url", href: "/collections/serums" } }, "an item's href becomes a typed link:");
    same(items[2].children, [{ label: "Contact", link: { type: "url", href: "/contact" } }], "children too:");
    eq(items[1].label, "", "an item the old menu hid is carried, not dropped:");
  });

  await t("announcement: a set bar, and a stored empty bar (not the same as no row)", async () => {
    const a = await mapIt((await tenant({ traps: ["announcement_set"] })).db);
    same(doc(a, "doc_announcement").published.body.settings, { enabled: true, text: "Free shipping over ₹999", link: { type: "url", href: "/collections" } }, "set:");
    const b = await mapIt((await tenant({ traps: ["announcement_empty"] })).db);
    same(doc(b, "doc_announcement").published.body.settings, { enabled: false, text: "", link: null }, "empty:");
    ok(b.list.documents.doc_announcement, "a stored empty bar is listed, not the code default");
  });

  await t("home sections: [] materializes the default sections; id-less ones get sec_l<n> (the i-<n> place shoppers see); agency v2 ones too", async () => {
    const a = await mapIt((await tenant({ traps: ["home_sections_empty"] })).db);
    same(doc(a, "doc_home").published.body.sections.map((s) => s.id), ["sec_hero", "sec_defcollect", "sec_defnew"], "defaults:");
    const { db } = await tenant({ state: "live_v1", traps: ["home_sections_no_ids"] });
    const b = await mapIt(db);
    const ids = doc(b, "doc_home").published.body.sections.map((s) => s.id);
    same(ids, ["sec_hero", "sec_l0", "sec_l1", "sec_l2"], "sec_l<i>:");
    const legacy = await db.run(() => Res.resolvedHomePage());
    same(legacy.map((s) => s.id), ids, "the ids the old home page gives today:");
    same(legacy.slice(1).map((s) => s.legacyKey), ["i-0", "i-1", "i-2"], "its old keys i-<n>, the same places:");
    const c = await mapIt((await tenant({ state: "live_v2", traps: ["agency_home_sections_v2"] })).db);
    same(doc(c, "doc_home").published.body.sections.map((s) => s.id), ["sec_hero", "sec_l0", "sec_l1"], "agency sections:");
    // vgate v1's hidden and unknown-kind sections
    const v1 = await mapIt((await tenant({ state: "live_v1" })).db);
    const home = doc(v1, "doc_home").published.body.sections;
    same(home.map((s) => [s.id, s.kind, s.enabled]), [["sec_hero", "hero", true], ["sec_l0", "new", true], ["sec_l1", "product_rail", true], ["sec_lh3", "new", false]], "a hidden one keeps its stored place:");
    ok(v1.report.leftOut.some((l) => l.what === "home_sections" && l.reason === "unknown_kind" && l.value.kind === "not-a-kind"), "the never-shown unknown kind is listed with its value");
  });

  await t("page sections: no ids get sec_l<i>, no kind becomes text, old kinds take the merged names", async () => {
    const a = await mapIt((await tenant({ traps: ["page_sections_no_ids"] })).db);
    const id = await (await import("../lib/documents/ids.js")).backfillRouteId("page", "no-ids");
    const p = doc(a, id).published.body;
    same(p.sections.map((s) => [s.id, s.kind]), [["sec_l0", "text"], ["sec_l1", "rich_text"]], "ids and kinds:");
    same(p.sections[1].settings, { title: "Two", html: "<p>Second.</p>" }, "heading becomes title:");
    const b = await mapIt((await tenant({ traps: ["page_sections_no_kind"] })).db);
    const q = b.documents.find((d) => d.slug === "no-kind").published.body;
    same(q.sections.map((s) => s.kind), ["text", "text"], "no kind:");
  });

  await t("code-default pages on _default and BeastLife: no document, still served from code; an overriding row is a document", async () => {
    const env = await world.defaultStore();
    await buildLegacyTenant(env, { state: "live_v3", traps: ["code_default_pages_default"] });
    const a = await mapIt(env);
    ok(a.source.codeDefaultPages.includes("terms"), "the env store has code-default pages");
    ok(!a.documents.some((d) => d.slug === "terms" || d.slug === "contact"), "none of them is mapped");
    eq(a.documents.find((d) => d.slug === "about").published.body.meta.title, "About (our own words)", "the overriding row:");
    const check = await checkOf(env, a);
    ok(check.differences.every((d) => d.fn === "resolvedSlugRedirect"), "terms, contact and the rest answer the same from the candidate");
    const { db } = await tenant({ id: "beastlife", traps: ["code_default_pages_beastlife"] });
    const b = await mapIt(db);
    ok(!b.documents.some((d) => d.slug === "terms"), "BeastLife: terms stays code");
    const legacyTerms = await db.run(() => Res.resolvedContentPage("terms"));
    const candTerms = await db.run(() => Res.contentGettersFor(Res.candidateSource({ list: b.list, bodies: b.bodies })).resolvedContentPage("terms"));
    same(candTerms, legacyTerms, "BeastLife terms:");
  });

  await t("policies and journal posts map by family; posts are listed through a journal index version", async () => {
    const a = await mapIt((await tenant({ traps: ["policies_as_cms_pages", "journal_family"] })).db);
    const policies = a.documents.filter((d) => ["shipping", "returns", "terms", "privacy"].includes(d.slug));
    eq(policies.length, 4, "four policies:");
    ok(policies.every((d) => d.type === "page" && d.published.body.meta.effective_at === "2026-01-01"), "policies are pages with their dates");
    const posts = a.documents.filter((d) => d.type === "journal");
    eq(posts.length, 5, "five posts:");
    ok(posts.every((d) => !Object.hasOwn(a.list.documents, d.id)), "posts are not in list.documents");
    const index = a.bodies.get(a.list.indexes.journal.version);
    eq(index.document_id, "doc_journal_index", "index document:");
    same(index.body.settings.entries.map((e) => [e.slug, e.enabled]), [["journal-ended", true], ["journal-first", true], ["journal-future", true], ["journal-off", false], ["journal-undated", true]], "index entries:");
  });

  await t("old addresses: each one onto its page's or post's redirect_from (listed as before); one with no page is reported, never invented", async () => {
    const { db } = await tenant({ state: "live_v3", entities: ["redirect_to_page", "redirect_to_journal_post", "redirect_to_nothing"] });
    const out = await mapIt(db);
    same(out.documents.find((d) => d.slug === "redirect-page").published.body.meta.redirect_from, ["old-about"], "to a page:");
    same(out.documents.find((d) => d.slug === "redirect-post").published.body.meta.redirect_from, ["old-post-address"], "to a journal post:");
    same(out.list.redirects.map((r) => [r.from_slug, r.to_slug]).sort(), [["old-about", "redirect-page"], ["old-post-address", "redirect-post"]], "the list's redirects:");
    ok(out.report.unresolvedRedirects.some((r) => r.from_slug === "old-gone" && r.side === "published"), "the one with no page is reported");
    onlyUnresolved(out, await checkOf(db, out), "redirects");
  });

  await t("a store open with no release whose brand would not pass a publish: shoppers see the default look today, so the published design holds no brand", async () => {
    const brand = { background: "#ffffff", foreground: "#fafafa" };
    const { db } = await tenant({ state: "no_release_open", config: { site: { name: "Legacy Outputs" }, brand } });
    const out = await mapIt(db, { storeOpen: true });
    const design = doc(out, "doc_design");
    eq(design.published, null, "nothing published for the design (no brand, no theme):");
    eq(out.list.documents.doc_design, null, "the list holds the code default:");
    same(design.draft.settings.brand, brand, "the founder's brand stays a draft:");
    ok(design.dirty, "an unpublished change");
    const check = await checkOf(db, out);
    ok(!check.differences.some((d) => d.fn === "resolvedBrand"), "the brand answers as today");
  });

  await t("the hero: an unmatched highlight is carried; a stored hero keeps exactly its fields; half-customized homes materialize the other half", async () => {
    const a = await mapIt((await tenant({ traps: ["highlight_unmatched"] })).db);
    const hero = doc(a, "doc_home").published.body.sections[0];
    eq(hero.settings.highlight, "Sparkle", "carried:");
    const issues = Reg.validateDocument(doc(a, "doc_home").published.body, { mode: "publish" }).issues.filter((i) => i.code === "HIGHLIGHT_NOT_IN_TITLE");
    eq(issues[0]?.severity, "warning", "a warning, never a block:");
    // v1's hero has no highlight or second button: not filled in, so they keep following the store
    const v1 = await mapIt((await tenant({ state: "live_v1" })).db);
    same(Object.keys(doc(v1, "doc_home").published.body.sections[0].settings).sort(), ["primary", "subtitle", "title"], "only the stored fields:");

    const ho = await mapIt((await tenant({ traps: ["home_hero_only"] })).db);
    same(doc(ho, "doc_home").published.body.sections.map((s) => s.id), ["sec_hero", "sec_defcollect", "sec_defnew"], "hero only: default sections materialized:");
    eq(doc(ho, "doc_home").published.body.sections[0].settings.title, "Made for the morning", "hero only: the hero:");

    const { db } = await tenant({ traps: ["home_sections_only"] });
    const so = await mapIt(db);
    const body = doc(so, "doc_home").published.body;
    same(body.sections.map((s) => s.id), ["sec_hero", "sec_cust01", "sec_cust02"], "sections only: ids:");
    ok(!Object.hasOwn(body.sections[0].settings, "title") && !Object.hasOwn(body.sections[0].settings, "highlight"), "the default hero's title and highlight are bound to the store name (not stored)");
    same(body.sections[0].settings, M.boundDefaultHeroSettings(), "the rest of the default hero is materialized:");
    const cand = (tenantObj) => withTenant(tenantObj, () => Res.contentGettersFor(Res.candidateSource({ list: so.list, bodies: so.bodies })).resolvedHero());
    eq((await cand(db.tenant)).title, "Shop Legacy Outputs.", "the title shoppers see today:");
    const renamed = { ...db.tenant, config: { ...db.tenant.config, site: { name: "Renamed Shop" } } };
    eq((await cand(renamed)).title, "Shop Renamed Shop.", "{store_name}: it follows a rename:");
    eq((await cand(renamed)).highlight, "Renamed Shop", "and so does the highlight:");

    const both = await mapIt((await tenant({ traps: ["home_both_custom"] })).db);
    same(doc(both, "doc_home").published.body.sections.map((s) => s.id), ["sec_hero", "sec_cust01", "sec_cust02"], "both:");
    const none = await mapIt((await tenant({ traps: ["home_both_default"] })).db);
    eq(none.list.documents.doc_home, null, "neither: the code default (null)");
    ok(!doc(none, "doc_home"), "neither: no document");
  });

  await t("stored payloads keep their old shape: experiment variants, AI proposals and agency kits are read by nobody here and left as stored", async () => {
    const { db } = await tenant({ traps: ["hero_experiment_running", "ai_proposal_payload", "agency_kit_payload"] });
    const before = (await exec(db, "SELECT variants FROM experiments")).rows[0].variants;
    const ai = (await exec(db, "SELECT proposals FROM ai_insights")).rows[0].proposals;
    const kit = (await world.control.platformDb().execute("SELECT payload FROM agency_kits WHERE id = 'akit_fixture01'")).rows[0].payload;
    await mapIt(db);
    eq((await exec(db, "SELECT variants FROM experiments")).rows[0].variants, before, "variants:");
    eq((await exec(db, "SELECT proposals FROM ai_insights")).rows[0].proposals, ai, "AI proposals:");
    eq((await world.control.platformDb().execute("SELECT payload FROM agency_kits WHERE id = 'akit_fixture01'")).rows[0].payload, kit, "agency kit:");
  });

  // ====================================================================================
  console.log("— 3. determinism and the source hash");
  // ====================================================================================
  await t("mapping the same store twice gives deep-equal output (ids, hashes, list, bodies, refs, report, source hash); any legacy edit changes the source hash", async () => {
    const { db } = await tenant({ state: "live_v3", traps: ["journal_family", "announcement_set"], entities: ["cart_upsell", "redirect_to_page"] });
    const a = await mapIt(db);
    const b = await mapIt(db);
    const plain = (o) => ({ ...o, source: undefined, bodies: [...o.bodies.entries()] });
    same(plain(b), plain(a), "twice:");
    ok(/^[0-9a-f]{64}$/.test(a.sourceHash), "a sha256");
    ok(a.documents.every((d) => !d.published || /^ver_[0-9a-f]{16}$/.test(d.published.versionId)), "version ids are ver_<16 hex>");
    ok(/^rel_mig_[0-9a-f]{16}$/.test(a.releaseId), "release id:");
    eq(a.releaseId, await Ids.migratedReleaseId(a.list), "the release id is the list's hash");
    for (const d of a.documents.filter((x) => x.published)) eq(d.published.versionId, await Ids.migratedVersionId(d.id, d.published.body), `${d.id}: content-addressed:`);
    const edits = [
      ["UPDATE cms_blocks SET value = ? WHERE key = 'announcement'", [JSON.stringify({ enabled: true, text: "Changed", href: "" })]],
      ["UPDATE cms_pages SET title = 'Changed title' WHERE slug = 'about'", []],
      ["UPDATE page_redirects SET to_slug = 'elsewhere' WHERE from_slug = 'old-post'", []],
      ["UPDATE placements SET title = 'Changed offer' WHERE kind = 'cart_upsell'", []],
      ["UPDATE product_overrides SET badge = 'Changed'", []],
      ["INSERT INTO cms_templates (id, name, family, sections, version, revision, created_at, updated_at) VALUES ('tpl_x', 'X', 'page', '[]', 1, 1, 'x', 'x')", []],
    ];
    let last = a.sourceHash;
    for (const [sql, args] of edits) {
      await exec(db, sql, args);
      const next = (await mapIt(db, { record: false })).sourceHash;
      ok(next !== last, `the source hash changed after: ${sql.slice(0, 50)}`);
      last = next;
    }
  });

  // ====================================================================================
  console.log("— 4. drafts stay drafts");
  // ====================================================================================
  await t("a draft that differs from what is live stays a draft (dirty), and the list holds only what is live", async () => {
    const out = await mapIt((await tenant({ state: "live_v3" })).db);
    const home = doc(out, "doc_home");
    ok(home.dirty, "the home draft differs from the live one");
    eq(out.list.documents.doc_home.version, home.published.versionId, "the list names the live version");
    eq(out.bodies.get(home.published.versionId).body.sections[0].settings.title, "Live hero v3", "and it holds the live hero");
    ok(![...out.bodies.values()].some((v) => JSON.stringify(v.body).includes("Draft hero")), "no listed version holds the draft");
    const about = out.documents.find((d) => d.slug === "about");
    ok(about.dirty && about.draft.meta.title === "About us (draft)" && about.published.body.meta.title === "About", "the page draft stays a draft");
  });

  await t("a page deleted in the drafts but still live stays live, and the report says so in plain words (never dropped quietly)", async () => {
    const { db } = await tenant({ state: "live_v3" });
    await exec(db, "DELETE FROM cms_pages WHERE slug = 'shipping'");
    const out = await mapIt(db);
    const page = out.documents.find((d) => d.slug === "shipping");
    ok(page.published && !page.dirty, "still live, its draft is the live page");
    ok(out.report.notes.some((n) => n.code === "PAGE_DELETED_IN_DRAFTS" && n.document === page.id), "noted");
    const text = Rep.renderText(Rep.buildReport(out, null), "0".repeat(64));
    ok(/The page “Shipping” \(\/policies\/shipping\): you deleted it in your drafts, but it is still live\./.test(text), "said in plain words");
  });

  await t("an unchanged store maps to 0 dirty documents (live on v3 with drafts equal to the release, and open with no release)", async () => {
    const { db, manifest } = await tenant({ state: "live_v3", drafts: false, config: { site: { name: "Legacy Outputs" }, theme: { kit: "glow", version: 1 } } });
    const rel = manifest.release;
    await exec(db, "DELETE FROM cms_blocks");
    await exec(db, "DELETE FROM cms_pages");
    await exec(db, "DELETE FROM page_redirects");
    await exec(db, "DELETE FROM placements WHERE kind = 'cart_upsell'");
    // P4-OVL07: the entity part is mapped now, so the product and collection
    // extras in the live tables (which the v3 release froze as empty) are
    // unpublished drafts too; an unchanged store holds none
    await exec(db, "DELETE FROM placements");
    await exec(db, "DELETE FROM product_overrides");
    await exec(db, "DELETE FROM collection_overrides");
    for (const [k, v] of Object.entries(rel.blocks)) await exec(db, "INSERT INTO cms_blocks (key, value, updated_at) VALUES (?, ?, 'x')", [k, JSON.stringify(v)]);
    for (const p of rel.pages)
      await exec(db, "INSERT INTO cms_pages (slug, title, description, sections, enabled, effective_at, family, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        p.slug,
        p.title,
        p.description ?? "",
        JSON.stringify(p.sections ?? []),
        p.enabled ? 1 : 0,
        p.effective_at ?? null,
        p.family ?? "page",
        p.window_start ?? null,
        p.window_end ?? null,
      ]);
    const out = await mapIt(db);
    same(out.documents.filter((d) => d.dirty).map((d) => d.id), [], "dirty documents:");
    const open = await mapIt((await tenant({ state: "no_release_open" })).db, { storeOpen: true });
    eq(open.documents.filter((d) => d.dirty).length, 0, "open, no release:");
  });

  // ====================================================================================
  console.log("— 5. the candidate list and the data check");
  // ====================================================================================
  const STATES = [
    ["vgate", "live_v1"],
    ["vgate", "live_v2"],
    ["vgate", "live_v3"],
    ["vgate", "no_release_open"],
    ["home", "live_v1"],
    ["home", "live_v2"],
    ["home", "live_v3"],
    ["home", "no_release_open"],
    ["journal", "live_v3"],
    ["journal", "no_release_open"],
    ["empty", "no_release_open"],
  ];
  for (const [set, state] of STATES) {
    await t(`${set} ${state}: the list parses (parseList), and every non-entity getter answers as today, in-process, with no write`, async () => {
      const { db } = await tenant({ set, state, id: set === "vgate" ? "vgl" : undefined });
      const before = await fileHash(db);
      const out = await mapIt(db, { storeOpen: flagOf(state) });
      const parsed = Docs.parseList(out.list, { releaseId: out.releaseId });
      eq(parsed.v, 4, "v4:");
      const check = await checkOf(db, out);
      eq(check.ran, true, "ran:");
      ok(check.compared >= 25, `compared ${check.compared} calls`);
      for (const r of routes.filter((x) => !C.isEntityRoute(x))) ok(C.routesFor(out.source, routes).some(([fn, args]) => fn === r[0] && JSON.stringify(args) === JSON.stringify(r[1])), `route ${r[0]} is checked`);
      if (set === "vgate") onlyUnresolved(out, check, `${set} ${state}`);
      else eq(check.differences.length, 0, `${set} ${state}: ${JSON.stringify(check.differences).slice(0, 600)}`);
      eq(await fileHash(db), before, "the database file is unchanged:");
    });
  }
  await t("every mapping trap: the data check answers as today (apart from old addresses with no page)", async () => {
    for (const trap of Object.keys(MAPPING_TRAPS)) {
      if (MAPPING_TRAPS[trap].requires || trap === "agency_home_sections_v2") continue; // the code-default ones are checked in part 2
      const { db } = await tenant({ traps: [trap] });
      const out = await mapIt(db);
      onlyUnresolved(out, await checkOf(db, out), trap);
    }
    const { db } = await tenant({ state: "live_v2", traps: ["agency_home_sections_v2"] });
    const out = await mapIt(db);
    onlyUnresolved(out, await checkOf(db, out), "agency_home_sections_v2");
  });
  await t("the check's comparison: section ids and old keys, empty against left out, and a real change is a difference", async () => {
    ok(C.sameForShoppers({ kind: "new", id: "sec_l0", legacyKey: "i-0", title: "A" }, { kind: "new", id: "sec_x", title: "A", enabled: true }), "ids and enabled:");
    ok(C.sameForShoppers({ featured: ["a"], order: [] }, { featured: ["a"], order: [], hide: [] }), "a list left out reads as empty:");
    ok(!C.sameForShoppers({ kind: "new", title: "A" }, { kind: "new", title: "B" }), "a changed title is a difference");
    ok(!C.sameForShoppers({ title: "A" }, { title: "A", label: "Shop" }), "an added word is a difference");
    ok(!C.sameForShoppers(["a"], ["a", "b"]), "an added item is a difference");
    ok(!C.sameForShoppers({ id: "p1" }, { id: "p2" }), "an id outside a section (a product) still counts");
  });
  await t("a changed candidate is caught: the check is not blind", async () => {
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "jl" });
    const out = await mapIt(db, { record: false });
    const home = out.list.documents.doc_announcement;
    const body = structuredClone(out.bodies.get(out.list.documents.doc_header?.version ?? home?.version)?.body ?? null);
    // put a different announcement live in the candidate
    const ann = { schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "Not what shoppers see", link: null } };
    const v = await Ids.migratedVersion("doc_announcement", ann);
    const bodies = new Map(out.bodies);
    bodies.set(v.id, { document_id: "doc_announcement", body: ann });
    const list = { ...out.list, documents: { ...out.list.documents, doc_announcement: { version: v.id, hash: v.bodyHash } } };
    const check = await db.run(() => C.dataCheck({ ...out, list, bodies, releaseId: null }, { routes: C.routesFor(out.source, routes) }));
    ok(body !== undefined, "setup");
    ok(check.differences.some((d) => d.fn === "resolvedAnnouncement"), "the announcement difference is listed");
  });

  // ====================================================================================
  console.log("— 6. a running hero experiment on the migrated home");
  // ====================================================================================
  await t("the experiment's variant serves the same hero settings on the migrated home (heroVariantSettings), with no payload rewrite", async () => {
    for (const traps of [["hero_experiment_running"], ["hero_experiment_running", "home_sections_only"]]) {
      const { db } = await tenant({ traps });
      const stored = String((await exec(db, "SELECT variants FROM experiments")).rows[0].variants);
      const out = await mapIt(db);
      const variants = JSON.parse(stored);
      const exp = { ...HERO_EXPERIMENT, variants, salt: "fixture-salt" };
      const payload = variants.find((x) => x.key === "b").payload; // as served: the stored payload
      let unit = null;
      for (let i = 0; i < 200 && !unit; i++) if (heroVariantFor(exp, {}, `unit-${i}`).assignment?.variant === "b") unit = `unit-${i}`;
      ok(unit, "a unit in variant b");
      const served = async (getters) =>
        db.run(async () => {
          const page = await getters.resolvedHomePage();
          const hero = page.find((s) => s.kind === "hero");
          const settings = { ...Reg.legacyHeroToSettings(defaultHero((await import("../lib/site.js")).siteName())), ...hero.settings }; // heroWithDefaults
          const picked = heroVariantFor(exp, settings, unit);
          eq(picked.assignment.variant, "b", "assigned:");
          return Reg.settingsToLegacyHero(heroVariantSettings(settings, payload));
        });
      const legacy = await served(Res);
      const migrated = await served(Res.contentGettersFor(Res.candidateSource({ list: out.list, bodies: out.bodies })));
      // the same hero for shoppers: a badge the old hero filled in as "" is left out (rule 2 of check.js)
      ok(C.sameForShoppers(migrated, legacy), `${traps.join("+")}: the variant hero: ${JSON.stringify(migrated)} vs ${JSON.stringify(legacy)}`);
      for (const k of ["title", "highlight", "subtitle", "primary", "secondary"]) same(migrated[k], legacy[k], `${traps.join("+")}: ${k}:`);
      eq(migrated.title, "Glow, simply", "the variant's title:");
      eq(String((await exec(db, "SELECT variants FROM experiments")).rows[0].variants), stored, "the stored payload is untouched:");
      eq(payload.title, HERO_EXPERIMENT.variants[1].payload.title, "the old flat shape:");
    }
  });

  // ====================================================================================
  console.log("— 7. the reconcile report, and values over a limit");
  // ====================================================================================
  await t("a phase-3 random-id product row is found (its id reused), and a page row holding a mapped slug is a refusal", async () => {
    const { db } = await tenant({ state: "live_v3" });
    const left = await buildPhase3Leftovers(db);
    const out = await mapIt(db);
    const ent = out.report.reconcile.entity.find((e) => e.entityId === left.productId);
    ok(ent, "the product row is listed");
    eq(ent.id, left.productDocumentId, "its id:");
    eq(ent.reused, true, "reused, not duplicated:");
    eq(ent.deterministicId, await (await import("../lib/documents/ids.js")).productDocumentId(left.productId), "the id it stands in for:");
    const col = out.report.reconcile.collisions.find((c) => c.slug === "about");
    eq(col.existing.id, left.collidingDocumentId, "collision:");
    ok(out.report.refusals.some((r) => r.code === "SLUG_COLLISION" && r.slug === "about"), "a refusal");
  });

  await t("rows from an earlier aborted run: drafts that differ are kept as versions; the live rows are listed", async () => {
    const { db } = await tenant({ state: "live_v3" });
    const stale = await buildStaleBackfill(db);
    const out = await mapIt(db);
    const kept = out.report.reconcile.kept.map((k) => k.id).sort();
    ok(kept.includes("doc_home") && kept.includes(stale.ids.about), `kept: ${kept}`);
    eq(out.report.reconcile.liveRows.product.length, 1, "product live rows:");
    eq(out.report.reconcile.liveRows.collection.length, 1, "collection live rows:");
    eq(doc(out, "doc_home").draft.sections[0].settings.title, "Newer hero", "the newer legacy content wins:");
  });

  await t("values over a limit or failing strict checks are carried exactly as stored, with warnings per document", async () => {
    const { db } = await tenant({ state: "no_release_open" });
    const longText = "A".repeat(250);
    const longTitle = "T".repeat(130);
    await exec(db, "UPDATE cms_blocks SET value = ? WHERE key = 'announcement'", [JSON.stringify({ enabled: true, text: longText, href: "https://elsewhere.example/x", extra: "kept" })]);
    await exec(db, "UPDATE cms_pages SET title = ? WHERE slug = 'shipping'", [longTitle]);
    const out = await mapIt(db, { storeOpen: true });
    const ann = doc(out, "doc_announcement");
    eq(ann.published.body.settings.text, longText, "the long text, uncut:");
    eq(ann.published.body.settings.extra, "kept", "an unknown field, kept:");
    eq(ann.published.body.settings.link.href, "https://elsewhere.example/x", "an off-store link, kept:");
    const v = out.report.validation.find((x) => x.id === "doc_announcement");
    ok(v.published.codes.includes("TOO_LONG") && v.published.codes.includes("LINK_NOT_STOREFRONT") && v.published.codes.includes("UNKNOWN_FIELD"), `codes: ${v.published.codes}`);
    const page = out.documents.find((d) => d.slug === "shipping");
    eq(page.published.body.meta.title, longTitle, "the long title, uncut:");
    ok(out.report.validation.find((x) => x.id === page.id).published.codes.includes("TOO_LONG"), "the page is flagged");
    const report = Rep.buildReport(out, null);
    ok(report.editorFlags.some((f) => f.name === "The announcement bar" && f.count >= 3), "the founder sees it under the editor's flags");
  });

  // ====================================================================================
  console.log("— 8. the dry-run command");
  // ====================================================================================
  const cli = (args, env = {}) => spawnSync(process.execPath, ["scripts/migrate-documents.js", ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
  const digestOf = (text) => /Dry-run digest: ([0-9a-f]{64})\s*$/.exec(text)?.[1] ?? null;

  await t("the dry run leaves the database file byte-identical, prints the digest, and reports templates, addresses, refusals and strict validation", async () => {
    const { db } = await tenant({ id: "mmapcli", state: "live_v3", entities: ["cms_templates_two_families", "redirect_to_nothing", "cms_approvals", "cart_upsell"] });
    const before = await fileHash(db);
    const text = cli(["--tenant", "mmapcli", "--dry-run"]);
    eq(text.status, 0, `exit (stderr ${text.stderr.slice(0, 300)}):`);
    ok(digestOf(text.stdout), "the digest line ends the output");
    const json = cli(["--tenant", "mmapcli", "--dry-run", "--json"]);
    eq(json.status, 0, "json exit:");
    const r = JSON.parse(json.stdout);
    eq(r.digest, digestOf(text.stdout), "the same digest with and without --json:");
    eq(r.savedTemplates.count, 2, "templates:");
    same(r.details.cmsTemplates.byFamily, { journal: 1, page: 1 }, "templates per family:");
    ok(r.unmatchedAddresses.some((a) => a.from === "old-gone" && a.to === "gone-forever"), "the unresolved address");
    ok(r.details.refusals.some((x) => x.code === "APPROVALS_IN_USE"), "the approvals refusal");
    ok(r.details.strictValidation.some((x) => x.id === "doc_header" && x.published.errors > 0), "strict validation per document");
    eq(await fileHash(db), before, "the database file is byte-identical:");
    // a schedule refusal, through the command
    await tenant({ id: "mmapsched", state: "pending_schedule" });
    const s = JSON.parse(cli(["--tenant", "mmapsched", "--dry-run", "--json"]).stdout);
    ok(s.details.refusals.some((x) => x.code === "PENDING_SCHEDULE"), "the schedule refusal");
    ok(s.verdict.fixes.some((f) => /scheduled/.test(f.what)), "in founder words");
  });

  await t("the env store (_default): the command reads it from the env (no control plane row), with its code-default pages", async () => {
    const env = await world.defaultStore({ stage: "latest" }).catch(() => null);
    ok(env, "the env store");
    const before = await fileHash(env);
    const r = cli(["--tenant", "_default", "--dry-run", "--json"]);
    eq(r.status, 0, `exit (stderr ${r.stderr.slice(0, 300)}):`);
    const j = JSON.parse(r.stdout);
    eq(j.details.tenant, "_default", "the store:");
    ok(j.details.codeDefaultPages.includes("terms"), "its code-default pages are served from code");
    eq(await fileHash(env), before, "unchanged:");
  });

  await t("the command refuses a libsql:// store (no --hosted --confirm), a missing --dry-run, and both flags at once", async () => {
    await world.control.upsertTenant({ id: "mmaphosted", name: "Hosted", dbUrl: "libsql://mmaphosted-example.turso.io", config: {} });
    const r = cli(["--tenant", "mmaphosted", "--dry-run"]);
    eq(r.status, 1, "exit:");
    ok(/refusing/.test(r.stderr) && /--hosted --confirm mmaphosted/.test(r.stderr), r.stderr);
    eq(r.stdout, "", "nothing printed, nothing read");
    const w = cli(["--tenant", "mmaphosted", "--dry-run", "--confirm", "mmaphosted"]);
    eq(w.status, 1, "--confirm alone is not enough:");
    const nd = cli(["--tenant", "mmapcli"]);
    eq(nd.status, 1, "no --dry-run:");
    ok(/--dry-run/.test(nd.stderr), nd.stderr);
    const both = cli(["--tenant", "mmapcli", "--dry-run", "--store-open", "--not-launched"]);
    eq(both.status, 1, "both flags:");
  });

  // ====================================================================================
  console.log("— 9. the plain report");
  // ====================================================================================
  const FORBIDDEN = [
    /\b(cms_blocks|cms_pages|cms_templates|cms_approvals|cms_state|page_redirects|placements|product_overrides|collection_overrides|surface_templates|release_state|releases|documents|document_versions|document_refs|agency_grants|product_content_live|collection_content_live|nav_header|nav_footer|home_sections|pdp_extras|collections_index)\b/,
    /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/, // error codes
    /\b(doc|ver|rel|sec|tpl|pl|mrun|agc|agr)_[a-z0-9_]+/, // ids
    /gid:\/\//,
    /\bresolved[A-Z]/,
    /\bstatements?\b/i,
    /[0-9a-f]{16,}/, // hashes
  ];
  const checkPlain = (text) => {
    const at = text.indexOf("\nDetails\n");
    ok(at > 0, "a Details line");
    const plain = text.slice(0, at);
    for (const re of FORBIDDEN) ok(!re.test(plain), `above Details: ${re} matched "${plain.match(re)?.[0]}"`);
    let from = 0;
    for (const title of Rep.SECTION_TITLES) {
      const i = plain.indexOf(`\n${title}\n`, from);
      ok(i >= 0, `section "${title}" in order`);
      from = i + 1;
    }
    return plain;
  };

  await t("snapshot: a ready store's plain report, word for word (verdict first, sections in order)", async () => {
    await tenant({ id: "mmapready", set: "journal", state: "live_v3" });
    const r = cli(["--tenant", "mmapready", "--dry-run"]);
    eq(r.status, 0, "exit:");
    const plain = checkPlain(r.stdout);
    if (process.env.MMAP_PRINT_SNAPSHOT) console.log(JSON.stringify(plain));
    eq(plain, READY_SNAPSHOT, "snapshot:");
  });

  await t("a store that isn't ready: the verdict counts the fixes; nothing above Details names a table, code, id or statement", async () => {
    const { db } = await tenant({ id: "mmapnot", state: "live_v1", traps: ["policies_as_cms_pages", "highlight_unmatched"], entities: ["cart_upsell", "cms_templates_two_families", "redirect_to_nothing", "agency_grant", "cms_approvals"] });
    await buildPhase3Leftovers(db);
    const r = cli(["--tenant", "mmapnot", "--dry-run"]);
    eq(r.status, 0, "exit:");
    const plain = checkPlain(r.stdout);
    const m = /^Not ready: (\d+) things to fix\n/.exec(plain);
    ok(m, `the first line is the verdict: ${plain.split("\n")[0]}`);
    const json = JSON.parse(cli(["--tenant", "mmapnot", "--dry-run", "--json"]).stdout);
    eq(json.verdict.fixes.length, Number(m[1]), "the count:");
    ok(json.verdict.fixes.every((f) => f.what && f.where), "every fix says where");
    for (const k of ["mapping", "list", "dataCheck", "reconcile", "strictValidation", "typesWithoutEditor", "refusals", "estimates", "sourceHash", "unresolvedRedirects", "cmsTemplates"]) ok(Object.hasOwn(json.details, k), `--json details.${k}`);
    eq(json.digest, digestOf(r.stdout), "same digest:");
    ok(/estimated statements: backfill \d+, flip \d+/.test(r.stdout), "statement estimates below Details");
    // the not-launched store says it stays closed, as expected (no fix)
    await tenant({ id: "mmapclosed", set: "journal", state: "no_release_not_launched" });
    const c = cli(["--tenant", "mmapclosed", "--dry-run", "--not-launched"]);
    const cp = checkPlain(c.stdout);
    ok(/stays closed to shoppers until your first publish/.test(cp), "closed until the first publish");
    ok(cp.startsWith("Ready to move\n"), cp.split("\n")[0]);
  });

  // ====================================================================================
  console.log("— 10. team access");
  // ====================================================================================
  await t("'Team access that changes' names the staff role for the cart offer, from roleAllows, when the store has a cart offer", async () => {
    ok(roleAllows("staff", "upsells.write") && roleAllows("staff", "storefront.write") && !roleAllows("staff", "storefront.publish"), "the role table as the plan cites it");
    const out = await mapIt((await tenant({ state: "live_v3", entities: ["cart_upsell"] })).db);
    const report = Rep.buildReport(out, null);
    const staff = report.teamAccess.find((x) => x.role === "staff");
    ok(staff, "staff is named");
    eq(staff.text, "Staff can still change the cart offer, but an owner or admin has to publish it before shoppers see it.", "words:");
    ok(!report.teamAccess.some((x) => ["owner", "admin"].includes(x.role)), "owners and admins keep both");
    const text = Rep.renderText(report, "0".repeat(64));
    ok(text.indexOf("Staff can still change the cart offer") > text.indexOf("Team access that changes"), "in its section");
    const none = await mapIt((await tenant({ set: "journal", state: "live_v3", id: "jl" })).db);
    same(Rep.buildReport(none, null).teamAccess, [], "no cart offer, no change:");
  });

  // ====================================================================================
  console.log("— 11. DOC-03: merged kind names only");
  // ====================================================================================
  await t("every section of every mapped body is a registered kind allowed on its type, under its merged name, on every state and trap", async () => {
    // map every trap and entity fixture once more, so all of them are walked
    for (const trap of Object.keys(MAPPING_TRAPS)) if (!MAPPING_TRAPS[trap].requires && trap !== "agency_home_sections_v2") await mapIt((await tenant({ state: "no_release_open", traps: [trap] })).db, { storeOpen: true });
    // fixtures that need a given store (P4-HARNESS: the code-default redirect) are mapped on that store
    const ordinaryEntities = Object.keys(ENTITY_FIXTURES).filter((e) => !ENTITY_FIXTURES[e].requires);
    const beastlifeEntities = Object.keys(ENTITY_FIXTURES).filter((e) => [].concat(ENTITY_FIXTURES[e].requires || []).includes("beastlife"));
    ok(ordinaryEntities.length + beastlifeEntities.length === Object.keys(ENTITY_FIXTURES).length, "every entity fixture is walked");
    await mapIt((await tenant({ state: "live_v1", entities: ordinaryEntities })).db);
    if (beastlifeEntities.length) await mapIt((await tenant({ id: "beastlife", state: "live_v1", entities: beastlifeEntities })).db);
    const preMerge = Object.entries(Reg.LEGACY_KIND_NAMES).filter(([old, v]) => v.kind !== old).map(([old]) => old);
    same(preMerge.sort(), ["image", "rich"], "the pre-merge names:");
    let n = 0;
    for (const out of built) {
      const bodies = [...out.documents.flatMap((d) => [d.draft, d.published?.body]), ...[...out.bodies.values()].map((v) => v.body)].filter(Boolean);
      for (const body of bodies) {
        for (const s of Array.isArray(body.sections) ? body.sections : []) {
          n++;
          ok(Reg.sectionType(s.kind), `${body.type}: "${s.kind}" is registered`);
          ok(!preMerge.includes(s.kind), `${body.type}: "${s.kind}" is a pre-merge name`);
          ok(Reg.allowedKinds(body.type).includes(s.kind), `${body.type}: "${s.kind}" is allowed there`);
          ok(Reg.SECTION_ID_RE.test(s.id), `${body.type}: id ${s.id}`);
          const settings = s.settings || {};
          ok(!["heading", "src"].some((k) => Object.hasOwn(settings, k)), `${body.type} ${s.kind}: an old field name in ${JSON.stringify(settings).slice(0, 100)}`);
        }
      }
    }
    ok(n > 500, `${n} sections walked over ${built.length} mappings`);
  });

  // ====================================================================================
  console.log("— 12. editability");
  // ====================================================================================
  await t("typeHasEditor: a stubbed editable system type has no editor (the system check), an editable plain type has one", async () => {
    Reg.defineDocumentType({ type: "zz_mapper_system", label: "Test system", editable: true, system: true });
    Reg.defineDocumentType({ type: "zz_mapper_plain", label: "Test plain", editable: true });
    eq(Ed.typeHasEditor("zz_mapper_system"), false, "editable + system:");
    eq(Ed.typeHasEditor("zz_mapper_plain"), true, "editable, not system:");
    eq(Ed.typeHasEditor("journal_index"), false, "journal_index:");
  });

  await t("cartEditable() is checked by the mapper itself: when it says no, a store with a cart offer is refused (typeHasEditor('cart') alone would say yes)", async () => {
    eq(Ed.typeHasEditor("cart"), true, "typeHasEditor('cart') is true whatever the ruling");
    const { db } = await tenant({ state: "live_v3", entities: ["cart_upsell"] });
    const no = await mapIt(db, { editability: { typeHasEditor: Ed.typeHasEditor, cartEditable: () => false }, record: false });
    ok(no.report.refusals.some((r) => r.code === "NO_EDITOR" && r.type === "cart"), "refused for the cart");
    ok(no.report.typesWithoutEditor.some((x) => x.type === "cart"), "listed as a type without an editor");
    ok(!no.documents.some((d) => d.type === "cart"), "no cart document is mapped");
    const yes = await mapIt(db, { record: false });
    ok(!yes.report.refusals.some((r) => r.code === "NO_EDITOR"), "with the ruling: not refused");
    ok(yes.documents.some((d) => d.type === "cart"), "mapped");
    const none = await mapIt((await tenant({ set: "journal", state: "live_v3", id: "jl" })).db, { editability: { typeHasEditor: Ed.typeHasEditor, cartEditable: () => false }, record: false });
    ok(!none.report.refusals.some((r) => r.code === "NO_EDITOR"), "no cart offer: nothing to refuse");
  });
} finally {
  await world.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
