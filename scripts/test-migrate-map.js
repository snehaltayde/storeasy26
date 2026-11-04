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
//  13. P4-FIX1: the MAPPER review's findings (six safety lines, the ids.js
//      hashes, "not checked", unique section ids, the cart handle)
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

  await t("P4-FIX1: the command refuses a control plane (PLATFORM_DB_URL) that isn't local, before reading it, unless --hosted --confirm; the URL is never printed", async () => {
    // a .invalid host never resolves, so even a broken check couldn't reach anything;
    // no case passes --hosted (builders never do)
    const hostedPlatform = { PLATFORM_DB_URL: "libsql://mmap-platform.invalid", PLATFORM_DB_TOKEN: "dummy-not-a-token" };
    for (const tenantArg of ["mmapcli", "_default"]) {
      const r = cli(["--tenant", tenantArg, "--dry-run"], hostedPlatform);
      eq(r.status, 1, `${tenantArg}: exit:`);
      ok(/refusing: the control plane \(PLATFORM_DB_URL\) is not a local database/.test(r.stderr) && new RegExp(`--hosted --confirm ${tenantArg}`).test(r.stderr), r.stderr);
      ok(!/mmap-platform|dummy/.test(r.stderr + r.stdout), "the URL and token are not printed");
      eq(r.stdout, "", "nothing printed, nothing read");
      const c = cli(["--tenant", tenantArg, "--dry-run", "--confirm", tenantArg], hostedPlatform);
      eq(c.status, 1, `${tenantArg}: --confirm alone is not enough:`);
      ok(/refusing: the control plane/.test(c.stderr), c.stderr);
    }
    // a control plane on this machine (the harness's sqld) is accepted like a file one
    const onMachine = cli(["--tenant", "_default", "--dry-run", "--json"], { PLATFORM_DB_URL: "http://127.0.0.1:7169" });
    ok(!/control plane/.test(onMachine.stderr), `a local sqld address is not refused: ${onMachine.stderr.slice(0, 200)}`);
  });

  await t("P4-FIX1: the dry run says, below Details, which routes the in-process data check covered", async () => {
    const r = cli(["--tenant", "mmapcli", "--dry-run"]);
    eq(r.status, 0, `exit (stderr ${r.stderr.slice(0, 300)}):`);
    const m = /\n {2}routes given to the data check \((\d+)\):\n/.exec(r.stdout);
    ok(m && r.stdout.indexOf(m[0]) > r.stdout.indexOf("\nDetails\n"), "the routes line is below Details");
    const j = JSON.parse(cli(["--tenant", "mmapcli", "--dry-run", "--json"]).stdout);
    ok(Array.isArray(j.details.routesChecked) && j.details.routesChecked.length === Number(m[1]), "the JSON lists the same routes");
    ok(j.details.routesChecked.some((x) => x.fn === "resolvedAnnouncement"), "a no-argument getter");
    ok(j.details.routesChecked.some((x) => x.fn === "resolvedContentPage" && x.args[0] === "about"), "a page of the store");
    ok(/\n {4}resolvedContentPage: .*"about"/.test(r.stdout), "printed by getter, with its arguments");
    eq(j.details.dataCheck.compared + j.details.dataCheck.skipped, j.details.routesChecked.length, "every route given was compared or skipped:");
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

  // ====================================================================================
  console.log("— 13. P4-FIX1: the MAPPER review's findings");
  // ====================================================================================
  const E = await import("../lib/migrate/map-entities.js");
  // The entity part as it is while unbuilt, handed in, so this case keeps
  // pinning map.js's refusal after P4-OVL07 builds the real one.
  const unbuiltEntities = async (source) => ({ built: false, documents: [], bodies: new Map(), liveRows: { product: [], collection: [] }, refs: [], holds: E.entityHoldings(source) });
  const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

  await t("(1a) a ready store plus one product_overrides row is refused with ENTITY_CONTENT_NOT_MOVABLE while the entity part isn't built", async () => {
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "mmapent" });
    const mapEnt = () => db.run(() => M.mapTenant({ platform: world.control.platformDb(), entities: unbuiltEntities }));
    const ready = await mapEnt();
    same(ready.report.refusals, [], "the store starts ready:");
    eq(Rep.buildReport(ready, await checkOf(db, ready)).verdict.ready, true, "ready:");
    await exec(db, "INSERT INTO product_overrides (product_id, modules, badge, updated_at) VALUES (?, ?, 'One badge', 'x')", [P(1), JSON.stringify([{ title: "A module", html: "<p>a</p>" }])]);
    const out = await mapEnt();
    const r = out.report.refusals.find((x) => x.code === "ENTITY_CONTENT_NOT_MOVABLE");
    ok(r, `refused: ${JSON.stringify(out.report.refusals)}`);
    eq(r.holds.products, 1, "one product's content:");
    const report = Rep.buildReport(out, await checkOf(db, out));
    eq(report.verdict.ready, false, "not ready:");
    ok(report.verdict.fixes.some((f) => f.code === "ENTITY_CONTENT_NOT_MOVABLE" && /product and collection extras/.test(f.what)), "said in founder words");
    // once the entity part is built, the same holds are no longer refused
    const builtPart = async (source) => ({ ...(await unbuiltEntities(source)), built: true });
    const later = await db.run(() => M.mapTenant({ platform: world.control.platformDb(), entities: builtPart }));
    ok(!later.report.refusals.some((x) => x.code === "ENTITY_CONTENT_NOT_MOVABLE"), "a built entity part is not refused");
  });

  await t("(1b) a data-check difference alone makes the verdict 'Not ready' (a store whose only problem is a change shoppers would see)", async () => {
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "mmapdiff" });
    const out = await mapIt(db, { record: false });
    const real = await checkOf(db, out);
    eq(real.differences.length, 0, "the real check:");
    eq(Rep.buildReport(out, real).verdict.ready, true, "ready with the real check:");
    // the same store, with a candidate that would show shoppers another bar
    const ann = { schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "Not what shoppers see", link: null } };
    const v = await Ids.migratedVersion("doc_announcement", ann);
    const bodies = new Map(out.bodies);
    bodies.set(v.id, { document_id: "doc_announcement", body: ann });
    const list = { ...out.list, documents: { ...out.list.documents, doc_announcement: { version: v.id, hash: v.bodyHash } } };
    const check = await db.run(() => C.dataCheck({ ...out, list, bodies, releaseId: null }, { routes: C.routesFor(out.source, routes) }));
    ok(check.ran && check.differences.length > 0, "the check found the change");
    const report = Rep.buildReport(out, check);
    same(out.report.refusals, [], "no refusal");
    same(out.report.unresolvedRedirects, [], "no unmatched address");
    eq(report.verdict.ready, false, "the difference alone: not ready:");
    same(report.verdict.fixes.map((f) => f.kind), ["shoppers"], "the only fix:");
    const text = Rep.renderText(report, "0".repeat(64));
    ok(text.startsWith("Not ready: 1 thing to fix\n"), text.split("\n")[0]);
    ok(/\n {2}- The announcement bar would look different after the move\.\n/.test(text), "named under What shoppers will see change");
  });

  await t("(1c) an accepted agency grant is refused with AGENCY_ACCESS (and an unreadable agency check with AGENCY_UNCHECKED)", async () => {
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "mmapagency", entities: ["agency_grant"] });
    const out = await mapIt(db, { record: false });
    const r = out.report.refusals.find((x) => x.code === "AGENCY_ACCESS");
    ok(r, `refused: ${JSON.stringify(out.report.refusals)}`);
    eq(r.grants.length, 1, "one grant:");
    eq(r.grants[0].agency, "agc_fixture02", "the agency:");
    same(out.report.refusals.map((x) => x.code), ["AGENCY_ACCESS"], "the only refusal:");
    const report = Rep.buildReport(out, await checkOf(db, out));
    eq(report.verdict.ready, false, "not ready:");
    ok(report.verdict.fixes.some((f) => /An agency has access to your store/.test(f.what) && /Settings > Team/.test(f.where)), "in founder words");
    const blind = await db.run(() => M.mapTenant({ platform: null }));
    ok(blind.report.refusals.some((x) => x.code === "AGENCY_UNCHECKED"), "no control plane: refused as unchecked");
  });

  await t("(1d) a brand or theme edit between rehearsal and cutover changes the source hash (the design is in it)", async () => {
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "mmapbrand" });
    const a = await mapIt(db, { record: false });
    const as = (config) => withTenant({ ...db.tenant, config: { ...db.tenant.config, ...config } }, () => M.mapTenant({ platform: world.control.platformDb() }));
    const branded = await as({ brand: { accent: "#0d9488" } });
    eq(doc(branded, "doc_design")?.draft.settings.brand.accent, "#0d9488", "the edit is read:");
    ok(branded.sourceHash !== a.sourceHash, "a brand edit changes the source hash");
    const themed = await as({ brand: { accent: "#0d9488" }, theme: { kit: "glow", version: 1 } });
    ok(themed.sourceHash !== branded.sourceHash, "a theme edit changes the source hash");
    // the design alone moves the hash (nothing else in the source changed)
    ok((await M.sourceHashOf({ ...a.source, design: { brand: { accent: "#111111" }, theme: null } })) !== a.sourceHash, "sourceHashOf reads the design");
  });

  await t("(1e) two enabled cart offers merge their products in position order, the first offer's empty title becomes the default words, and shoppers see no change", async () => {
    const { db } = await tenant({ set: "journal", state: "no_release_open", id: "mmapcart2", entities: ["cart_upsell"] });
    // pl_fx_cart is at position 2 (P220, P221); this one at position 0 comes first
    await exec(db, "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position, updated_at) VALUES ('pl_fix_cart0', 'cart_upsell', NULL, ?, '', 1, 0, 'x')", [JSON.stringify([P(221), P(1)])]);
    await exec(db, "INSERT INTO placements (id, kind, source_product_id, target_product_ids, title, enabled, position, updated_at) VALUES ('pl_fix_cartoff', 'cart_upsell', NULL, ?, 'Off', 0, 1, 'x')", [JSON.stringify([P(1)])]);
    const out = await mapIt(db, { storeOpen: true });
    const cart = doc(out, "doc_cart").published.body.settings;
    same(cart.products.map((p) => p.id), [P(221), P(1), P(220)], "merged in position order, each product once:");
    eq(cart.title, M.CART_DEFAULT_TITLE, "the first offer's '' title:");
    ok(out.report.leftOut.some((l) => l.reason === "later_offer_title_not_shown" && l.id === "pl_fx_cart"), "the later offer's title is listed");
    const check = await checkOf(db, out);
    ok(check.ran, "ran");
    ok(!check.differences.some((d) => d.fn === "resolvedCartUpsell"), `the cart offer answers as today: ${JSON.stringify(check.differences).slice(0, 400)}`);
  });

  await t("(1f) an absent announcement maps to no document (the code default, null), never a default body", async () => {
    for (const [state, storeOpen] of [["live_v3", undefined], ["no_release_open", true]]) {
      const { db } = await tenant({ set: "journal", state, id: "mmapann" });
      const rows = (await exec(db, "SELECT key FROM cms_blocks WHERE key = 'announcement'")).rows;
      eq(rows.length, 0, `${state}: no announcement row:`);
      const out = await mapIt(db, { storeOpen });
      ok(!doc(out, "doc_announcement"), `${state}: no announcement document`);
      eq(out.list.documents.doc_announcement, null, `${state}: the list holds the code default:`);
      const check = await checkOf(db, out);
      ok(!check.differences.some((d) => d.fn === "resolvedAnnouncement"), `${state}: the bar answers as today`);
    }
  });

  await t("(2) draft and published hashes strip section ids, and the version id hashes the document id with the body (checked with sha256 here, not migratedVersion)", async () => {
    // live (v3 release) home sections with no ids, drafts with the same content and ids of their own
    const { db } = await tenant({ set: "journal", state: "live_v3", id: "mmaphash", traps: ["home_sections_no_ids"] });
    const SECS = [
      { id: "sec_new01", kind: "new", title: "New in", limit: 4 },
      { id: "sec_bann01", kind: "banner", title: "Free shipping", text: "This week only.", label: "Shop", href: "/collections" },
      { id: "sec_coll01", kind: "collections", title: "Shop by collection", limit: 3 },
    ];
    await exec(db, "INSERT OR REPLACE INTO cms_blocks (key, value, updated_at, schema_version) VALUES ('home_sections', ?, 'x', 2)", [JSON.stringify(SECS)]);
    const out = await mapIt(db);
    const home = doc(out, "doc_home");
    same(home.published.body.sections.map((s) => s.id), ["sec_hero", "sec_l0", "sec_l1", "sec_l2"], "the live sections had no ids:");
    same(home.draft.sections.map((s) => s.id), ["sec_hero", "sec_new01", "sec_bann01", "sec_coll01"], "the drafts carry their own:");
    const strip = (b) => ({ ...b, sections: b.sections.map(({ id: _id, ...s }) => s) });
    same(strip(home.draft), strip(home.published.body), "the same content");
    ok(sha(Reg.stableStringify(home.draft)) !== sha(Reg.stableStringify(home.published.body)), "the bodies differ only by ids");
    eq(home.draftHash, home.publishedHash, "the draft and published hashes ignore ids:");
    eq(home.dirty, false, "so the home is not an unpublished change:");
    // the hashes themselves, on a body whose ids are changed or removed
    const renamed = { ...home.draft, sections: home.draft.sections.map((s, i) => ({ ...s, id: `sec_zz${i}` })) };
    eq(await Ids.draftHash(renamed), await Ids.draftHash(home.draft), "draftHash with other ids:");
    eq(await Ids.publishedHash(renamed), await Ids.publishedHash(home.draft), "publishedHash with other ids:");
    ok((await Ids.draftHash(home.draft)) !== sha(Reg.stableStringify(home.draft)), "not the ids-kept body hash");
    const changed = { ...home.draft, sections: home.draft.sections.map((s, i) => (i === 1 ? { ...s, settings: { ...s.settings, title: "Other" } } : s)) };
    ok((await Ids.draftHash(changed)) !== (await Ids.draftHash(home.draft)), "a content change still changes the hash");
    // every listed version id: ver_ + 16 hex of sha256(documentId + sha256(canonical body))
    let n = 0;
    for (const [versionId, v] of out.bodies) {
      const bodyHash = sha(Reg.stableStringify(v.body));
      eq(versionId, `ver_${sha(v.document_id + bodyHash).slice(0, 16)}`, `${v.document_id}: the version id:`);
      ok(versionId !== `ver_${sha(bodyHash).slice(0, 16)}`, `${v.document_id}: the document id is part of the hash`);
      n++;
    }
    ok(n >= 5, `${n} versions checked`);
    for (const d of out.documents.filter((x) => x.published)) eq(d.published.bodyHash, sha(Reg.stableStringify(d.published.body)), `${d.id}: the list entry's hash keeps ids:`);
    // the same body under two documents: two ids
    const page = out.documents.find((d) => d.type === "page" && d.published);
    const other = "doc_p_zzfix1other";
    eq((await Ids.migratedVersion(other, page.published.body)).id, `ver_${sha(other + sha(Reg.stableStringify(page.published.body))).slice(0, 16)}`, "another document's id:");
    ok((await Ids.migratedVersion(other, page.published.body)).id !== page.published.versionId, "another document, another version id");
  });

  await t("(3) when the data check did not run, 'What shoppers will see change' says it was not checked, never 'Nothing.'", async () => {
    const sectionOf = (text) => {
      const at = text.indexOf(`\n${Rep.SECTION_TITLES[0]}\n`);
      return text.slice(at + Rep.SECTION_TITLES[0].length + 2).split("\n\n")[0];
    };
    const cases = [];
    cases.push(["no flag", await mapIt((await tenant({ set: "journal", state: "no_release_open", id: "mmapnc1" })).db, { record: false })]);
    const sched = await tenant({ set: "journal", state: "pending_schedule", id: "mmapnc2" });
    cases.push(["pending schedule", await mapIt(sched.db, { record: false }), sched.db]);
    cases.push(["live read error", await mapIt((await tenant({ set: "journal", state: "live_read_error", id: "mmapnc3" })).db, { storeOpen: true, record: false })]);
    const live = await tenant({ set: "journal", state: "live_v3", id: "mmapnc4" });
    const base = await mapIt(live.db, { record: false });
    for (const mode of ["migrating", "documents"]) {
      const mapped = await M.mapLegacy({ ...base.source, state: { ...base.source.state, mode } });
      cases.push([mode, { source: base.source, ...mapped }]);
    }
    const codes = { "no flag": "NEEDS_FLAG", "pending schedule": "PENDING_SCHEDULE", "live read error": "LIVE_READ_ERROR", migrating: "MIGRATING", documents: "ALREADY_DOCUMENTS" };
    for (const [name, out, db] of cases) {
      ok(out.report.refusals.some((r) => r.code === codes[name]), `${name}: refused with ${codes[name]}: ${JSON.stringify(out.report.refusals.map((r) => r.code))}`);
      const check = await (db ?? live.db).run(() => C.dataCheck(out, { routes: C.routesFor(out.source, routes) }));
      eq(check.ran, false, `${name}: the check did not run:`);
      for (const c of [check, null]) {
        const report = Rep.buildReport(out, c);
        eq(report.shopperChangesChecked, false, `${name}: not checked:`);
        const text = Rep.renderText(report, "0".repeat(64));
        eq(sectionOf(text), `  ${Rep.NOT_CHECKED}`, `${name}${c ? "" : " (no check)"}:`);
        ok(!/\n {2}Nothing\.\n/.test(text.slice(0, text.indexOf("\nDetails\n")).split(`${Rep.SECTION_TITLES[1]}\n`)[0]), `${name}: no 'Nothing.' for shoppers`);
        eq(report.verdict.ready, false, `${name}: not ready:`);
      }
    }
    // through the command too, for the scheduled store
    const cliText = cli(["--tenant", "mmapnc2", "--dry-run"]);
    eq(cliText.status, 0, "exit:");
    eq(sectionOf(cliText.stdout), "  Not checked: fix the things above first.", "the command's words:");
    // a check that ran with nothing to report still says Nothing.; no check at all on a store with no refusal is a fix
    const ran = Rep.buildReport(base, await checkOf(live.db, base));
    eq(sectionOf(Rep.renderText(ran, "0".repeat(64))), "  Nothing.", "a check that ran:");
    const unchecked = Rep.buildReport(base, null);
    eq(unchecked.verdict.ready, false, "no comparison, no 'Ready to move':");
    ok(unchecked.verdict.fixes.some((f) => f.kind === "check"), "the missing comparison is a fix");
  });

  await t("(4) generated section ids skip ids already taken: stored [sec_l1, no id, no id] never gives two sec_l1 (home, page and product page sections)", async () => {
    same(M.uniqueSectionIds([{ id: "sec_l1", stored: true }, { id: "sec_l1", stored: false }, { id: "sec_l2", stored: false }]), ["sec_l1", "sec_l1x2", "sec_l2"], "the rule:");
    same(M.uniqueSectionIds([{ id: "sec_l0", stored: false }, { id: "sec_l0", stored: true }]), ["sec_l0x2", "sec_l0"], "a stored id wins over a generated one before it:");
    same(M.uniqueSectionIds([{ id: "sec_hero", stored: true }], ["sec_hero"]), ["sec_herox2"], "a reserved id is never reused:");
    same(M.uniqueSectionIds([{ id: "sec_abcdefghijklmnop", stored: true }, { id: "sec_abcdefghijklmnop", stored: true }]), ["sec_abcdefghijklmnop", "sec_dup2"], "a repeat of a long stored id:");
    const HOME = [
      { id: "sec_l1", kind: "new", title: "Stored id", limit: 4 },
      { kind: "new", title: "No id one", limit: 4 },
      { kind: "collections", title: "No id two", limit: 3 },
    ];
    for (const schemaVersion of [1, 2]) {
      const { db } = await tenant({ set: "journal", state: "no_release_open", id: "mmapids" });
      // schema 1 rows are stamped at read (sec_l<stored place>); schema 2 rows are read as stored
      await exec(db, "INSERT OR REPLACE INTO cms_blocks (key, value, updated_at, schema_version) VALUES ('home_sections', ?, 'x', ?)", [JSON.stringify(HOME), schemaVersion]);
      await exec(db, "INSERT OR REPLACE INTO cms_blocks (key, value, updated_at, schema_version) VALUES ('pdp_extras', ?, 'x', 1)", [
        JSON.stringify([
          { id: "sec_l1", title: "Stored", html: "<p>a</p>" },
          { title: "No id", html: "<p>b</p>" },
          { title: "No id", html: "<p>c</p>" },
          { id: "sec_productmain", title: "Clash", html: "<p>d</p>" },
        ]),
      ]);
      await exec(db, "INSERT INTO cms_pages (slug, title, description, sections, enabled, family) VALUES ('id-clash', 'Id clash', '', ?, 1, 'page')", [
        JSON.stringify([{ id: "sec_l1", kind: "text", heading: "Stored", body: ["a"] }, { kind: "text", heading: "No id", body: ["b"] }, { kind: "text", heading: "No id", body: ["c"] }]),
      ]);
      const out = await mapIt(db, { storeOpen: true });
      const unique = (ids, what) => eq(new Set(ids).size, ids.length, `schema ${schemaVersion} ${what} ids ${JSON.stringify(ids)}:`);
      const home = doc(out, "doc_home").published.body.sections.map((s) => s.id);
      unique(home, "home");
      eq(home[1], "sec_l1", "the stored id is kept:");
      eq(home.filter((id) => id === "sec_l1").length, 1, "one sec_l1:");
      const pdp = doc(out, "doc_product_layout").published.body.sections.map((s) => s.id);
      unique(pdp, "product page");
      same(pdp.slice(0, 2), ["sec_productmain", "sec_l1"], "the product module and the stored id:");
      const page = out.documents.find((d) => d.slug === "id-clash").published.body.sections.map((s) => s.id);
      unique(page, "page");
      eq(page[0], "sec_l1", "the page's stored id is kept:");
      for (const id of ["doc_home", "doc_product_layout", out.documents.find((d) => d.slug === "id-clash").id]) {
        const issues = Reg.validateDocument(doc(out, id).draft, { mode: "draft", documentId: id }).issues.filter((i) => i.code === "SECTION_ID_DUPLICATE");
        same(issues, [], `${id}: no duplicate id stops a draft save:`);
      }
      const check = await checkOf(db, out);
      ok(!check.differences.some((d) => ["resolvedHomePage", "resolvedHomeSections", "resolvedContentPage"].includes(d.fn)), `shoppers see the same: ${JSON.stringify(check.differences).slice(0, 400)}`);
      // product page extras stored WITH an id: the old getter returns the id,
      // the new reader doesn't (known limit, MAPPER's comparison rules: a
      // false "Not ready", the safe way round). Apart from ids, the same.
      const pdpDiff = check.differences.find((d) => d.fn === "resolvedPdpExtras");
      if (pdpDiff) same(pdpDiff.legacy.ok.map(({ id: _id, ...x }) => x), pdpDiff.candidate.ok, "product page extras apart from ids:");
    }
  });

  await t("(5) the cart document keeps each product's catalog handle (the reader needs it); a Shopify handle change leaves the source hash alone and moves the cart and release ids (for P4-CUTOVER)", async () => {
    const { db } = await tenant({ set: "journal", state: "no_release_open", id: "mmapcarth", entities: ["cart_upsell"] });
    const a = await mapIt(db, { storeOpen: true, record: false });
    const picks = doc(a, "doc_cart").published.body.settings.products;
    ok(picks.every((p) => typeof p.handle === "string" && p.handle && p.id), `handle and id: ${JSON.stringify(picks)}`);
    await exec(db, "UPDATE products SET handle = 'renamed-in-shopify' WHERE id = ?", [P(220)]);
    const b = await mapIt(db, { storeOpen: true, record: false });
    eq(b.sourceHash, a.sourceHash, "the catalog is outside the source hash:");
    ok(b.releaseId !== a.releaseId, "the release id moves");
    ok(doc(b, "doc_cart").published.versionId !== doc(a, "doc_cart").published.versionId, "the cart version id moves");
    const check = await checkOf(db, b);
    ok(!check.differences.some((d) => d.fn === "resolvedCartUpsell"), "shoppers see the same offer");
  });
} finally {
  await world.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
