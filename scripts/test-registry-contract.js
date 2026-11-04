// P2-REG: the document registry contract (DOC-01..05, DOC-07).
// P3-VALIDATE: draft tolerance (PV-02), plain words and field anchors (AU-02),
// starter sections (AU-04).
//   node scripts/test-registry-contract.js      (pnpm test:registry-contract)
//
// lib/registry/ is pure, so almost everything here runs with no database.
// lib/themes/kits.js (for the kit presets) imports the database layer, so
// the environment points it at a throwaway folder that is removed at the end.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scratch = await mkdtemp(join(tmpdir(), "test-registry-"));
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = `file:${join(scratch, "default.db")}`;
process.env.PLATFORM_DB_URL = `file:${join(scratch, "platform.db")}`;
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";

const R = await import("../lib/registry/index.js");
const { ISSUE_KEYS, errorIssues } = await import("../lib/cms/issues.js");
const { upgradeBlock, normalizePageSections } = await import("../lib/cms/schemas.js");
const { defaultHero } = await import("../lib/cms/defaults.js");
const { emptyList } = await import("../lib/documents/release-list.js");
const { KITS } = await import("../lib/themes/kits.js");
const { checkSetting } = await import("../lib/registry/settings.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label) => {
  if (!cond) throw new Error(label || "expected truthy");
};
const deq = (got, want, label = "") => {
  try {
    deepStrictEqual(got, want);
  } catch {
    throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
};

// Every issue any check in this file produces, for the shape and wording checks
// at the end.
const ALL = [];
const DT = await import("../lib/registry/document-types.js");
const validate = (body, opts) => {
  const r = R.validateDocument(body, opts);
  ALL.push(...r.issues);
  return r;
};
const find = (r, code, extra = {}) => r.issues.filter((i) => i.code === code && Object.entries(extra).every(([k, v]) => i[k] === v));
const one = (r, code, extra = {}) => {
  const hits = find(r, code, extra);
  if (hits.length !== 1) throw new Error(`expected one ${code} ${JSON.stringify(extra)}, got ${JSON.stringify(r.issues.map((i) => [i.code, i.sectionId, i.field, i.severity]))}`);
  return hits[0];
};
const none = (r, label = "") => {
  if (r.issues.length) throw new Error(`${label} expected no issues, got ${JSON.stringify(r.issues.map((i) => [i.code, i.sectionId, i.field, i.severity, i.message]))}`);
};
const home = (sections) => ({ schema: 1, type: "home", meta: {}, sections });
const sec = (kind, id, settings = {}, extra = {}) => {
  const s = R.newSection(kind, { id });
  Object.assign(s.settings, settings);
  return Object.assign(s, extra);
};

// ---- DOC-03: one declaration is enough -------------------------------------------

await t("a fake section type registered here gets validation, typed links, controls, refs, worst cases and document-type selection", async () => {
  R.defineSection({
    kind: "fake_quote",
    label: "Quote",
    documentTypes: ["home", "page"],
    settings: [
      { key: "quote", kind: "text", label: "Quote", max: 140, required: true, default: "Small batches, made well." },
      { key: "source", kind: "link", label: "Source link", default: null },
      { key: "photo", kind: "image", label: "Photo", default: null },
    ],
    placeholder: "A line a customer said",
  });
  try {
    // document-type selection
    ok(R.allowedKinds("home").includes("fake_quote"), "home offers it");
    ok(R.allowedKinds("page").includes("fake_quote"), "page offers it");
    ok(!R.allowedKinds("product_layout").includes("fake_quote"), "the product layout does not");
    // validation: its default is clean, its own limits apply
    none(validate(home([R.newSection("fake_quote", { id: "sec_q1" })]), { mode: "publish" }), "default fake section");
    const long = validate(home([sec("fake_quote", "sec_q1", { quote: "x".repeat(141) })]), { mode: "draft" });
    one(long, "TOO_LONG", { sectionId: "sec_q1", field: "quote" });
    const empty = validate(home([sec("fake_quote", "sec_q1", { quote: "" })]), { mode: "publish" });
    eq(one(empty, "REQUIRED", { field: "quote" }).severity, "error");
    const onLayout = validate({ schema: 1, type: "product_layout", meta: {}, settings: { template: "classic" }, sections: [sec("fake_quote", "sec_q1"), R.newSection("product_main", { id: "sec_main" })] }, { mode: "draft" });
    one(onLayout, "KIND_NOT_ALLOWED", { sectionId: "sec_q1" });
    // typed links
    const evil = validate(home([sec("fake_quote", "sec_q1", { source: { type: "url", href: "https://evil.example" } })]), { mode: "draft" });
    one(evil, "LINK_NOT_STOREFRONT", { sectionId: "sec_q1", field: "source.href" });
    none(validate(home([sec("fake_quote", "sec_q1", { source: { type: "collection", handle: "x" } })]), { mode: "publish" }));
    // editor controls
    deq(
      R.controlsFor("fake_quote").map((c) => [c.key, c.control, c.required, c.max ?? null]),
      [
        ["quote", "text", true, 140],
        ["source", "link", false, null],
        ["photo", "image", false, null],
      ],
    );
    // references and media
    deq(R.refsOf(sec("fake_quote", "sec_q1", { source: { type: "product", handle: "tee", id: "gid://shopify/Product/9" }, photo: { media: "/api/media/a.jpg", alt: "A" } })), [
      { field: "source", ref: "link", type: "product", href: "/products/tee", handle: "tee", id: "gid://shopify/Product/9" },
      { field: "photo.media", ref: "media", src: "/api/media/a.jpg" },
    ]);
    // worst cases
    const wc = R.worstCase("fake_quote");
    deq(
      wc.cases.map((c) => c.name),
      ["long_text", "no_image", "tall_image"],
    );
    eq(wc.cases[0].section.settings.quote.length, 120, "120-character quote");
    for (const c of wc.cases) ok(R.validateDocument(R.fixtureDocument("home", [c.section]), { mode: "publish" }).ok, `worst case ${c.name} publishes`);
    deq(R.checkSectionContract("fake_quote"), []);
  } finally {
    R.removeSection("fake_quote");
  }
  ok(!R.allowedKinds("home").includes("fake_quote"), "removed again");
});

await t("every declared default validates clean in publish mode, and the registry contract holds", async () => {
  deq(R.checkRegistry(), [], "checkRegistry");
  for (const kind of R.sectionKinds()) {
    const d = R.sectionType(kind);
    for (const s of d.settings) {
      if (s.default === undefined) continue;
      const problems = [];
      checkSetting(s, s.default, s.key, (field, code) => problems.push(code));
      deq(problems.filter((c) => c !== "REQUIRED"), [], `${kind}.${s.key} default`);
      if (!d.startsIncomplete) deq(problems, [], `${kind}.${s.key} default`);
    }
    for (const type of d.documentTypes) {
      const body = R.fixtureDocument(type, [R.newSection(kind, { id: "sec_dflt" })]);
      if (!d.startsIncomplete) none(validate(body, { mode: "publish" }), `new ${kind} on ${type}, publish`);
      else {
        const draft = validate(body, { mode: "draft" });
        ok(draft.ok, `new ${kind} on ${type} saves as a draft`);
        ok(
          draft.issues.every((i) => i.severity === "incomplete"),
          `new ${kind} on ${type}: only incomplete issues, got ${JSON.stringify(draft.issues.map((i) => i.code))}`,
        );
      }
    }
  }
  for (const type of R.documentTypeNames()) {
    const r = validate(R.emptyBody(type), { mode: "draft" });
    ok(r.ok, `empty ${type} saves as a draft: ${JSON.stringify(r.issues.map((i) => i.code))}`);
  }
});

await t("a fake type whose default breaks its own rules fails the contract check", async () => {
  R.defineSection({ kind: "fake_long", label: "Long", documentTypes: ["home"], settings: [{ key: "title", kind: "text", max: 80, default: "x".repeat(100) }] });
  R.defineSection({
    kind: "fake_rule",
    label: "Rule",
    documentTypes: ["home"],
    settings: [{ key: "title", kind: "text", max: 80, default: "Sale" }],
    rules: (s) => (s.settings.title === "Sale" ? [{ field: "title", code: "NOT_SALE", message: "The title can't be Sale." }] : []),
  });
  R.defineSection({ kind: "fake_choice", label: "Choice", documentTypes: ["home"], settings: [{ key: "side", kind: "choice", options: ["left", "right"], default: "middle" }] });
  try {
    ok(R.checkSectionContract("fake_long").some((p) => p.includes("TOO_LONG")), "an over-long default is caught");
    ok(R.checkSectionContract("fake_rule").some((p) => p.includes("NOT_SALE")), "a default its own rule refuses is caught");
    ok(R.checkSectionContract("fake_choice").some((p) => p.includes("INVALID_CHOICE")), "a default outside its options is caught");
    ok(R.checkRegistry().length >= 3, "the whole-registry check fails too");
  } finally {
    for (const k of ["fake_long", "fake_rule", "fake_choice"]) R.removeSection(k);
  }
  deq(R.checkRegistry(), []);
});

// P5-BLOCKS (TREE-01, plan deviation 3.9): a source taken out of the table
// after a kind was registered on it fails the registry check, by name.
await t("P5-BLOCKS: checkRegistry names a kind whose source was removed after it registered; the real registry checks clean", async () => {
  deq(R.checkRegistry(), [], "before:");
  R.defineSource({ name: "zz_throwaway_src", args: ["limit"], resolve: () => Promise.resolve([]) });
  let removedSrc = false;
  R.defineSection({ kind: "zz_throwaway_kind", label: "Throwaway", documentTypes: ["home"], settings: [{ key: "limit", kind: "number", label: "N", min: 1, max: 4, default: 2 }], bindings: { things: { sources: ["zz_throwaway_src"], args: ["limit"] } } });
  try {
    deq(R.checkRegistry(), [], "with its source in the table:");
    ok(R.removeSource("zz_throwaway_src"), "removeSource");
    removedSrc = true;
    const problems = R.checkRegistry();
    deq(problems, ['zz_throwaway_kind: binding "things" names the source "zz_throwaway_src", which is not in the source table'], "after removeSource:");
    ok(R.checkSectionContract("zz_throwaway_kind").length === 1, "the kind's own contract check says so too");
  } finally {
    if (!removedSrc) R.removeSource("zz_throwaway_src");
    R.removeSection("zz_throwaway_kind");
  }
  deq(R.checkRegistry(), [], "after:");
  ok(R.sectionKinds().includes("bundle_card") && R.sectionKinds().includes("bundle_grid"), "the bundle kinds are in the real registry checked here");
});

// ---- DOC-03 / DOC-04: never strip, never cut ---------------------------------------

await t("an undeclared field gives UNKNOWN_FIELD naming the section id and field, and the value stays", async () => {
  for (const mode of ["draft", "publish"]) {
    const body = home([sec("hero", "sec_hero1", { colour: "red" }, { flair: true })]);
    const r = validate(body, { mode });
    const setting = one(r, "UNKNOWN_FIELD", { field: "colour" });
    eq(setting.sectionId, "sec_hero1");
    eq(setting.documentId, "doc_home");
    eq(setting.severity, "error");
    eq(one(r, "UNKNOWN_FIELD", { field: "flair" }).sectionId, "sec_hero1");
    eq(r.body.sections[0].settings.colour, "red", "setting kept");
    eq(r.body.sections[0].flair, true, "section field kept");
    eq(body.sections[0].settings.colour, "red", "input untouched");
    ok(!r.ok, `${mode}: not ok`);
  }
  const top = validate({ ...home([]), extra: 1, meta: { slug: "x" } }, { mode: "draft" });
  one(top, "UNKNOWN_FIELD", { field: "extra" });
  one(top, "UNKNOWN_FIELD", { field: "meta.slug" });
  eq(top.body.extra, 1);
});

await t("a 200-character title against max 80 gives TOO_LONG and is not truncated (P3-VALIDATE: incomplete in a draft, an error at publish)", async () => {
  const title = "T".repeat(200);
  for (const mode of ["draft", "publish"]) {
    const r = validate(home([sec("collections", "sec_c1", { title })]), { mode });
    const i = one(r, "TOO_LONG", { sectionId: "sec_c1", field: "title" });
    eq(i.severity, mode === "draft" ? "incomplete" : "error", `${mode}:`);
    eq(r.ok, mode === "draft", `${mode} ok:`);
    ok(i.message.includes("200") && i.message.includes("80"), i.message);
    eq(r.body.sections[0].settings.title, title, "kept whole");
    eq(r.body.sections[0].settings.title.length, 200);
  }
  // softMax is a warning, never a block
  const soft = validate(home([sec("collections", "sec_c1", { title: "S".repeat(60) })]), { mode: "publish" });
  eq(one(soft, "LONG", { field: "title" }).severity, "warning");
  ok(soft.ok, "a soft limit doesn't block");
});

// ---- typed links ------------------------------------------------------------------

await t("a hero link to https://evil.example or /admin gives LINK_NOT_STOREFRONT (incomplete in a draft, an error at publish); /collections/x passes", async () => {
  const withHref = (href, where = "primary") => home([sec("hero", "sec_hero1", { [where]: { label: "Go", link: { type: "url", href } } })]);
  for (const href of ["https://evil.example", "/admin", "//evil.example", "javascript:alert(1)", "/collections/../admin", "/collections/%2e%2e/admin", "/api/admin/releases", "mailto:a@b.c", "/products/"]) {
    for (const mode of ["draft", "publish"]) {
      const r = validate(withHref(href), { mode });
      const i = one(r, "LINK_NOT_STOREFRONT", { sectionId: "sec_hero1", field: "primary.link.href" });
      eq(i.severity, mode === "draft" ? "incomplete" : "error", `${mode} ${href}`);
      eq(r.body.sections[0].settings.primary.link.href, href, "the link value is kept");
    }
  }
  one(validate(withHref("https://evil.example", "secondary"), { mode: "draft" }), "LINK_NOT_STOREFRONT", { field: "secondary.link.href" });
  for (const href of ["/collections/x", "/collections", "/", "#new", "/products/tee?variant=1", "/policies/shipping", "/journal", "/search?q=mugs"]) {
    none(validate(withHref(href), { mode: "publish" }), href);
  }
  // typed links resolve to storefront paths
  eq(R.linkHref({ type: "collection", handle: "x" }), "/collections/x");
  eq(R.linkHref({ type: "page", slug: "about-us", family: "page" }), "/policies/about-us");
  eq(R.linkHref({ type: "page", slug: "sale", family: "campaign" }), "/campaigns/sale");
  one(validate(home([sec("hero", "sec_hero1", { primary: { label: "Go", link: { type: "ftp", href: "/" } } })]), { mode: "draft" }), "LINK_INVALID");
  // names inherited from Object.prototype are not link types or page families
  for (const family of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const link = { type: "page", slug: "x", family };
    eq(R.linkHref(link), null, `linkHref family ${family}`);
    const r = validate(home([sec("hero", "sec_hero1", { primary: { label: "Go", link } })]), { mode: "publish" });
    ok(!r.ok, `family ${family} must not publish`);
    one(r, "LINK_INVALID", { field: "primary.link.family" });
    ok(!R.refsOf(sec("hero", "sec_hero1", { primary: { label: "Go", link } })).some((x) => /native code|function/.test(JSON.stringify(x))), `refsOf family ${family}`);
  }
  for (const type of ["constructor", "__proto__", "toString"]) {
    const r = validate(home([sec("hero", "sec_hero1", { primary: { label: "Go", link: { type, href: "/" } } })]), { mode: "draft" });
    one(r, "LINK_INVALID");
  }
  // the same check reaches menus, announcement bars and banners
  const header =validate({ schema: 1, type: "header", meta: {}, settings: { mode: "custom", items: [{ label: "Admin", link: { type: "url", href: "/admin" } }], template: "standard" } }, { mode: "draft" });
  one(header, "LINK_NOT_STOREFRONT", { field: "items.0.link.href", documentId: "doc_header" });
  const bar = validate({ schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "Hi", link: { type: "url", href: "https://evil.example" } } }, { mode: "draft" });
  one(bar, "LINK_NOT_STOREFRONT", { field: "link.href", documentId: "doc_announcement" });
});

// ---- DOC-05: drafts are tolerant, publish is strict -----------------------------------

await t("a new banner with no text is incomplete in draft mode and an error in publish mode", async () => {
  const body = home([R.newSection("banner", { id: "sec_b1" })]);
  const draft = validate(body, { mode: "draft" });
  const d = one(draft, "SECTION_EMPTY", { sectionId: "sec_b1", field: "title" });
  eq(d.severity, "incomplete");
  ok(draft.ok, "the draft saves");
  eq(errorIssues(draft.issues).length, 0, "errorIssues finds nothing to block a draft");
  deq(Object.keys(d), ISSUE_KEYS, "issue shape");
  const pub = validate(body, { mode: "publish" });
  eq(one(pub, "SECTION_EMPTY", { sectionId: "sec_b1" }).severity, "error");
  ok(!pub.ok, "publish is refused");
  // a required field the same way
  const rail = home([R.newSection("product_rail", { id: "sec_r1" })]);
  eq(one(validate(rail, { mode: "draft" }), "REQUIRED", { field: "collection" }).severity, "incomplete");
  eq(one(validate(rail, { mode: "publish" }), "REQUIRED", { field: "collection" }).severity, "error");
  // a structure error is an error even in a draft
  eq(one(validate(home([{ ...R.newSection("banner", { id: "sec_b1" }), kind: "carousel" }]), { mode: "draft" }), "UNKNOWN_KIND").severity, "error");
});

await t("a <script> in rich_text is removed in both modes, and lostBySanitizing reports dropped words", async () => {
  for (const mode of ["draft", "publish"]) {
    const r = validate(home([sec("rich_text", "sec_r1", { html: "<p>Hello</p><script>alert(1)</script>" })]), { mode });
    eq(r.body.sections[0].settings.html, "<p>Hello</p>", mode);
    ok(!/script/i.test(JSON.stringify(r.body)), "no script left anywhere");
    none(r, mode);
  }
  // the same in FAQ answers
  const faq = validate(home([sec("faq", "sec_f1", { items: [{ q: "Why?", a: "<p>Because</p><script>x()</script>" }] })]), { mode: "draft" });
  eq(faq.body.sections[0].settings.items[0].a, "<p>Because</p>");
  // words the sanitizer would drop: reported, and the founder's text is kept
  const raw = "<p>Buy 2 < 3 and save > 10%</p>";
  const lost = R.lostBySanitizing(raw, R.sanitize(raw));
  eq(lost.code, "WORDS_LOST");
  ok(lost.message.includes("3 and save"), lost.message);
  for (const mode of ["draft", "publish"]) {
    const r = validate(home([sec("rich_text", "sec_r1", { html: raw })]), { mode });
    eq(one(r, "WORDS_LOST", { sectionId: "sec_r1", field: "html" }).severity, "error");
    eq(r.body.sections[0].settings.html, raw, "kept as typed");
  }
  eq(R.lostBySanitizing("<p>ok</p>", R.sanitize("<p>ok</p>")), null);
  ok(R.isBlank("\u200b \u00a0"), "zero-width and nbsp are blank");
  ok(R.isBlankHtml("<p>&nbsp;</p>"), "empty tags are blank");
});

// ---- DOC-03 composition guards ----------------------------------------------------

await t("a second hero, a hero out of place, a kind not allowed, and too many sections above the buy box each give a plain structured error", async () => {
  const two = validate(home([sec("hero", "sec_h1"), sec("hero", "sec_h2")]), { mode: "draft" });
  const extra = one(two, "TOO_MANY_OF_KIND", { sectionId: "sec_h2", field: "kind" });
  eq(extra.message, "The home page can have only one hero. Remove this extra one.");
  eq(find(two, "TOO_MANY_OF_KIND", { sectionId: "sec_h1" }).length, 0, "the first hero is fine");

  const moved = validate(home([sec("collections", "sec_c1"), sec("hero", "sec_h1")]), { mode: "draft" });
  eq(one(moved, "POSITION_NOT_ALLOWED", { sectionId: "sec_h1" }).message, "The hero can only go at the top of the home page. Move it there.");

  const page = validate({ schema: 1, type: "page", meta: { slug: "about", title: "About" }, sections: [sec("hero", "sec_h1")] }, { mode: "draft" });
  eq(one(page, "KIND_NOT_ALLOWED", { sectionId: "sec_h1" }).message, "A hero section can't go on this page. Remove it.");

  const layout = (sections) => ({ schema: 1, type: "product_layout", meta: {}, settings: { template: "classic" }, sections });
  const crowded = validate(layout([sec("banner", "sec_b1", { title: "Hi" }), sec("faq", "sec_f1", { items: [{ q: "Q", a: "<p>A</p>" }] }), R.newSection("product_main", { id: "sec_main" })]), { mode: "draft" });
  const before = one(crowded, "TOO_MANY_BEFORE_PROTECTED", { sectionId: "sec_f1" });
  eq(before.message, "Only one section can sit above the product details and buy button. Move this section below it.");
  eq(find(crowded, "TOO_MANY_BEFORE_PROTECTED", { sectionId: "sec_b1" }).length, 0, "the first one above is allowed");
  ok(validate(layout([sec("banner", "sec_b1", { title: "Hi" }), R.newSection("product_main", { id: "sec_main" }), sec("faq", "sec_f1", { items: [{ q: "Q", a: "<p>A</p>" }] })]), { mode: "publish" }).ok, "one above is fine");
  one(validate(layout([sec("banner", "sec_b1", { title: "Hi" })]), { mode: "draft" }), "PROTECTED_MISSING");
  one(validate(layout([{ ...R.newSection("product_main", { id: "sec_main" }), enabled: false }]), { mode: "draft" }), "PROTECTED_HIDDEN");
  // P3-FIX3 (TREE-05): hidden on both screens is an error at publish and incomplete in a draft
  for (const kind of R.sectionKinds().filter((k) => R.sectionType(k).protected)) {
    const host = R.documentTypeNames().find((ty) => R.allowedKinds(ty).includes(kind));
    ok(host, `a document type takes ${kind}`);
    const both = { ...R.newSection(kind, { id: "sec_main" }), show: { mobile: false, desktop: false } };
    const bodyOf = (s) => (host === "product_layout" ? layout([s]) : { ...R.emptyBody(host), sections: [s] });
    const pub = one(validate(bodyOf(both), { mode: "publish" }), "PROTECTED_HIDDEN", { sectionId: "sec_main", field: "show" });
    eq(pub.severity, "error", `${kind} hidden on both screens at publish:`);
    ok(!/_/.test(pub.message) && /both phones and computers/.test(pub.message), `plain words: ${pub.message}`);
    const draft = validate(bodyOf(both), { mode: "draft" });
    deq([draft.ok, one(draft, "PROTECTED_HIDDEN", { sectionId: "sec_main" }).severity], [true, "incomplete"], `${kind} in a draft:`);
    for (const show of [{ mobile: false }, { desktop: false }, { mobile: false, desktop: true }, { mobile: true, desktop: true }])
      eq(find(validate(bodyOf({ ...both, show }), { mode: "publish" }), "PROTECTED_HIDDEN").length, 0, `${kind} shown on one screen (${JSON.stringify(show)}) is fine:`);
  }

  for (const r of [two, moved, page, crowded]) {
    for (const i of r.issues) {
      eq(i.severity, "error", i.code);
      ok(!/_/.test(i.message), `plain words, no code names: ${i.message}`);
    }
  }
});

// ---- DOC-07: the home page ----------------------------------------------------------

await t("publishing home with zero enabled sections gives exactly the 'Your home page is empty…' message", async () => {
  const want = "Your home page is empty. Add a section or restore the last published version.";
  for (const sections of [[], [{ ...sec("collections", "sec_c1"), enabled: false }]]) {
    const pub = validate(home(sections), { mode: "publish" });
    const i = one(pub, "HOME_EMPTY");
    eq(i.message, want);
    eq(i.severity, "error");
    eq(i.documentId, "doc_home");
    ok(!pub.ok);
    const draft = validate(home(sections), { mode: "draft" });
    ok(draft.ok, "an empty home saves as a draft");
    eq(find(draft, "HOME_EMPTY").length, 0);
  }
  ok(validate(home([sec("collections", "sec_c1")]), { mode: "publish" }).ok, "one enabled section publishes");
});

// ---- DOC-02: legacy adapters ---------------------------------------------------------

await t("legacyHeroToSettings turns experiment, AI and agency payloads and every kit preset into valid hero sections", async () => {
  const sources = { ...R.LEGACY_HERO_FIXTURES };
  for (const [id, kit] of Object.entries(KITS)) if (kit.presets?.hero) sources[`kit_${id}`] = kit.presets.hero;
  ok(Object.keys(sources).length >= 5, "experiment, AI, agency and at least two kits");
  for (const [name, hero] of Object.entries(sources)) {
    const section = R.legacyHeroToSection(hero);
    eq(section.kind, "hero");
    eq(section.id, "sec_hero");
    const r = validate(home([section, sec("collections", "sec_c1")]), { mode: "publish" });
    none(r, name);
    eq(section.settings.title, hero.title, `${name} title`);
    if (hero.primary) deq(section.settings.primary, { label: hero.primary.label, link: { type: "url", href: hero.primary.href } }, `${name} primary`);
  }
});

await t("settingsToLegacyHero round-trips full heroes; an invalid legacy link is kept and reported, not dropped", async () => {
  const full = [R.LEGACY_HERO_FIXTURES.agency_kit, defaultHero("Acme"), ...Object.values(KITS).map((k) => k.presets.hero), { title: "T", highlight: "", subtitle: "", primary: null, secondary: null }];
  for (const hero of full) deq(R.settingsToLegacyHero(R.legacyHeroToSettings(hero)), hero, hero.title);

  const bad = { title: "Hello", primary: { label: "Go", href: "javascript:alert(1)" }, secondary: { label: "More", href: "https://evil.example" }, tagline: "kept" };
  const settings = R.legacyHeroToSettings(bad);
  eq(settings.primary.link.href, "javascript:alert(1)", "kept");
  eq(settings.tagline, "kept", "an unknown legacy field is carried");
  const r = validate(home([R.legacyHeroToSection(bad)]), { mode: "draft" });
  one(r, "LINK_NOT_STOREFRONT", { field: "primary.link.href" });
  one(r, "LINK_NOT_STOREFRONT", { field: "secondary.link.href" });
  one(r, "UNKNOWN_FIELD", { field: "tagline" });
  eq(r.body.sections[0].settings.primary.link.href, "javascript:alert(1)");
  deq(R.settingsToLegacyHero(settings), bad, "and back again");
  // the image has no legacy home, so it is the one thing settingsToLegacyHero leaves out
  deq(R.settingsToLegacyHero({ title: "T", image: { media: "/api/media/a.jpg", alt: "A" } }), { title: "T" });
});

await t("the announcement and home section adapters carry every legacy field", async () => {
  deq(R.legacyAnnouncementToSettings({ enabled: true, text: "Free shipping", href: "/collections" }), { enabled: true, text: "Free shipping", link: { type: "url", href: "/collections" } });
  deq(R.legacyAnnouncementToSettings({ enabled: false, text: "", href: "" }), { enabled: false, text: "", link: null });
  const legacy = [
    { id: "sec_aa11", kind: "banner", title: "Sale", text: "", label: "Shop", href: "https://evil.example", enabled: true },
    { kind: "product_rail", title: "Hot", collection: "mugs", collection_id: "gid://shopify/Collection/7", limit: 8 },
    { kind: "image_with_text", image: "/api/media/a.jpg", image_alt: "A tub", image_side: "right", title: "", text: "Hi", label: "", href: "" },
    { kind: "collections", title: "Shop", limit: 6, colour: "red", enabled: false },
    { kind: "carousel", slides: 3 },
  ];
  const out = R.legacyHomeSectionsToSections(legacy);
  deq(out[0].settings, { title: "Sale", text: "", button: { label: "Shop", link: { type: "url", href: "https://evil.example" } } });
  deq(out[1].settings, { title: "Hot", collection: { handle: "mugs", id: "gid://shopify/Collection/7" }, limit: 8 });
  deq(out[2].settings, { image: { media: "/api/media/a.jpg", alt: "A tub" }, image_side: "right", title: "", text: "Hi", button: null });
  eq(out[3].enabled, false);
  eq(out[3].settings.colour, "red");
  const r = validate(home(out), { mode: "draft" });
  one(r, "LINK_NOT_STOREFRONT", { sectionId: "sec_aa11" });
  one(r, "UNKNOWN_FIELD", { sectionId: "sec_l3", field: "colour" });
  one(r, "UNKNOWN_KIND", { sectionId: "sec_l4" });
  eq(r.body.sections[4].settings.slides, 3, "an unknown kind keeps its fields");
});

await t("names inherited from Object.prototype are refused as issues, never thrown or mapped", async () => {
  // a bindings key such as toString is an unknown field, not a crash
  for (const k of ["toString", "constructor", "hasOwnProperty"]) {
    const s = sec("collections", "sec_c1");
    s.bindings = { [k]: { source: "featured_collections" } };
    one(validate(home([s]), { mode: "draft" }), "UNKNOWN_FIELD", { field: `bindings.${k}` });
  }
  const proto = sec("collections", "sec_c1");
  proto.bindings = JSON.parse('{"__proto__":{"source":"featured_collections"}}');
  one(validate(home([proto]), { mode: "draft" }), "UNKNOWN_FIELD", { field: "bindings.__proto__" });
  // legacy sections of such kinds keep their kind and their fields
  for (const kind of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const [h] = R.legacyHomeSectionsToSections([{ kind, title: "T", limit: 3 }]);
    eq(h.kind, kind, `home kind ${kind}`);
    deq(h.settings, { title: "T", limit: 3 }, `home settings ${kind}`);
    const [p] = R.legacyPageSectionsToSections([{ kind, heading: "H" }]);
    eq(p.kind, kind, `page kind ${kind}`);
    deq(p.settings, { heading: "H" }, `page settings ${kind}`);
  }
  // a legacy field named like a prototype member is carried, not renamed
  const [t1] = R.legacyPageSectionsToSections([{ kind: "text", heading: "H", constructor: "c", toString: "s" }]);
  eq(t1.kind, "text");
  eq(t1.settings.constructor, "c");
  eq(t1.settings.toString, "s");
});

// ---- DOC-01: ids and hashing ---------------------------------------------------------

await t("bodies differing only in sec_ or blk_ ids hash the same; ensureIds mints and keeps ids", async () => {
  const a = home([
    { ...sec("collections", "sec_aaaa1111"), blocks: [{ id: "blk_aaaa", kind: "x" }] },
    sec("new", "sec_bbbb2222"),
  ]);
  const b = home([
    { ...sec("collections", "sec_cccc3333"), blocks: [{ id: "blk_zzzz", kind: "x" }] },
    sec("new", "sec_dddd4444"),
  ]);
  eq(await R.documentHash(a), await R.documentHash(b), "ids don't count");
  ok(/^[0-9a-f]{64}$/.test(await R.documentHash(a)), "sha-256 hex");
  const c = home([sec("collections", "sec_aaaa1111", { title: "Other" }), sec("new", "sec_bbbb2222")]);
  ok((await R.documentHash(a)) !== (await R.documentHash(c)), "content counts");
  const swapped = home([sec("new", "sec_bbbb2222"), sec("collections", "sec_aaaa1111")]);
  ok((await R.documentHash(swapped)) !== (await R.documentHash(home([sec("collections", "sec_x1"), sec("new", "sec_x2")]))), "order counts");
  eq(await R.documentHash({ ...a, sections: a.sections.map((s) => ({ ...s, settings: { ...s.settings }, extra: undefined })) }), await R.documentHash(a), "undefined keys are left out");

  const stamped = R.ensureIds(home([{ kind: "collections" }, { id: "sec_keep1", kind: "new", blocks: [{ kind: "x" }, { id: "blk_keep", kind: "y" }] }, { id: "sec_keep1", kind: "new" }, { id: "BAD", kind: "new" }]));
  const ids = stamped.sections.map((s) => s.id);
  eq(ids[1], "sec_keep1", "a valid id is kept");
  ok(ids.every((id) => R.SECTION_ID_RE.test(id)), "all valid");
  eq(new Set(ids).size, 4, "duplicates replaced");
  ok(R.BLOCK_ID_RE.test(stamped.sections[1].blocks[0].id), "a block gets a blk_ id");
  eq(stamped.sections[1].blocks[1].id, "blk_keep");
  const r = validate(home([sec("collections", "sec_dup1"), sec("new", "sec_dup1"), { ...sec("new", "sec_x"), id: "nope" }]), { mode: "draft" });
  one(r, "SECTION_ID_DUPLICATE");
  one(r, "SECTION_ID_INVALID");
});

await t("legacyHomeSectionsToSections stamps sec_l<i> exactly as lib/cms/schemas.js does", async () => {
  const legacy = [{ kind: "collections", title: "A", limit: 6 }, { id: "sec_real1", kind: "new", title: "B", limit: 8 }, { id: "Not valid", kind: "banner", title: "C" }, { id: "sec_real1", kind: "new", title: "D", limit: 4 }, { kind: "rich_text", html: "<p>x</p>" }];
  const ours = R.legacyHomeSectionsToSections(legacy).map((s) => s.id);
  const theirs = upgradeBlock("home_sections", legacy, 1).map((s) => s.id);
  deq(ours, theirs);
  deq(ours, ["sec_l0", "sec_real1", "sec_l2", "sec_real1", "sec_l4"]);
  // and twice gives the same
  deq(R.legacyHomeSectionsToSections(legacy), R.legacyHomeSectionsToSections(legacy));
  // page sections through the merged names, ids as normalizePageSections stamps them
  const page = [{ heading: "Hi", body: ["One"] }, null, { kind: "rich", heading: "R", html: "<p>r</p>" }, { kind: "image", src: "/api/media/a.jpg", alt: "A", caption: "C" }, { kind: "faq", heading: "F", items: [{ q: "Q", a: "<p>A</p>" }] }];
  const mapped = R.legacyPageSectionsToSections(page);
  deq(
    mapped.map((s) => s.id),
    normalizePageSections(page).map((s) => s.id),
  );
  deq(
    mapped.map((s) => [s.kind, s.settings]),
    [
      ["text", { title: "Hi", body: ["One"] }],
      ["rich_text", { title: "R", html: "<p>r</p>" }],
      ["image_with_text", { image: { media: "/api/media/a.jpg", alt: "A" }, caption: "C" }],
      ["faq", { title: "F", items: [{ q: "Q", a: "<p>A</p>" }] }],
    ],
  );
  none(validate({ schema: 1, type: "page", meta: { slug: "about", title: "About" }, sections: mapped }, { mode: "publish" }), "migrated page");
});

await t("upgradeBody runs pure per-section migrate steps", async () => {
  R.defineSection({
    kind: "fake_v3",
    version: 3,
    label: "Versioned",
    documentTypes: ["home"],
    settings: [{ key: "title", kind: "text", max: 80, default: "Hi" }],
    migrate: { 1: (s) => ({ ...s, settings: { title: s.settings.heading } }), 2: (s) => ({ ...s, settings: { title: s.settings.title.toUpperCase() } }) },
  });
  try {
    const old = home([{ id: "sec_v1", kind: "fake_v3", v: 1, enabled: true, settings: { heading: "hello" }, blocks: [] }]);
    const up = R.upgradeBody(old);
    deq(up.sections[0], { id: "sec_v1", kind: "fake_v3", v: 3, enabled: true, settings: { title: "HELLO" }, blocks: [] });
    eq(old.sections[0].v, 1, "pure: the input is untouched");
    const r = validate(old, { mode: "publish" });
    none(r);
    eq(r.body.sections[0].v, 3, "validation stores the upgraded section");
    eq(R.upgradeBody(up), up, "a current body comes back as it is");
    one(validate(home([{ id: "sec_v9", kind: "fake_v3", v: 9, settings: {}, blocks: [] }]), { mode: "draft" }), "SECTION_VERSION");
  } finally {
    R.removeSection("fake_v3");
  }
});

// ---- document types -------------------------------------------------------------------

await t("document types: singletons feed emptyList, design checks brand readability, product_content publishes (P4-LIVEROW), unknown types are refused", async () => {
  const singles = R.singletonTypes();
  deq(singles, ["announcement", "header", "footer", "design", "home", "collections_index", "product_layout", "collection_layout", "cart"]);
  const list = emptyList(1, singles);
  for (const type of singles) eq(list.documents[`doc_${type}`], null, type);
  ok(!singles.includes("journal_index") && !singles.includes("page"), "routes and the journal index aren't singletons");
  eq(R.documentType("journal_index").editable, false);
  // P4-LIVEROW (OVL-02): product and collection content publish as live rows
  eq(R.documentType("product_content").publishable, true);
  eq(R.documentType("collection_content").publishable, true);
  deq(R.allowedKinds("journal_index"), []);
  ok(R.allowedKinds("campaign").includes("product_rail") && R.allowedKinds("campaign").includes("collections"), "DOC-06: a campaign takes a rail and a collections grid");

  const design = (brand, theme = { kit: "pulse", version: 1 }) => ({ schema: 1, type: "design", meta: {}, settings: { brand, theme } });
  none(validate(design(null), { mode: "publish" }), "platform default brand");
  const unreadable = validate(design({ accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" }), { mode: "publish" });
  ok(find(unreadable, "BRAND_UNREADABLE").length >= 1, "unreadable colours are refused at publish");
  ok(validate(design({ accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" }), { mode: "draft" }).ok, "but save as a draft");
  const same = validate(design({ accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" }), { mode: "publish", live: design({ accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" }) });
  eq(find(same, "BRAND_UNREADABLE").length, 0, "a pair the live store already shows doesn't block");
  one(validate(design({ accent: "lime" }), { mode: "draft" }), "BRAND_INVALID");
  one(validate(design(null, { kit: "nope", version: 1 }), { mode: "draft" }), "THEME_INVALID");

  const pc = { schema: 1, type: "product_content", meta: {}, sections: [sec("text", "sec_t1", { title: "Care" })] };
  ok(validate(pc, { mode: "draft" }).ok, "product content saves");
  ok(validate(pc, { mode: "publish" }).ok, "product content publishes");
  // the new shape: overlays, Shopify-owned fields, the gallery allowlist at publish
  const pcBody = (settings) => ({ ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, ...settings } });
  ok(validate(pcBody({ title: { value: "Name", base_hash: "h", base_value: "Old" }, badge: "New" }), { mode: "publish" }).ok, "an overlay name and a badge publish");
  one(validate({ ...pcBody({}), settings: { ...pcBody({}).settings, price: 5 } }, { mode: "draft" }), "SHOPIFY_OWNED", { field: "price" });
  one(validate(pcBody({ title: { value: " ", base_hash: null, base_value: null } }), { mode: "draft" }), "TITLE_EMPTY");
  const offHost = pcBody({ gallery: { value: [{ media: "https://images.example.com/a.png", alt: "A" }], base_hash: null, base_value: null } });
  eq(find(validate(offHost, { mode: "draft" }), "IMAGE_HOST_NOT_ALLOWED")[0]?.severity, "warning", "a draft holds an off-host image");
  eq(find(validate(offHost, { mode: "publish" }), "IMAGE_HOST_NOT_ALLOWED")[0]?.severity, "error", "publish refuses it");
  // a type declared publishable: false is still refused at publish
  const unpub = R.defineDocumentType({ type: "test_unpublishable", label: "Test", publishable: false });
  try {
    one(validate({ schema: 1, type: unpub.type, meta: {} }, { mode: "publish" }), "PUBLISH_NOT_AVAILABLE");
  } finally {
    R.__forgetDocumentTypeForTest?.(unpub.type);
  }

  one(validate({ schema: 1, type: "blog_roll", sections: [] }, { mode: "draft" }), "UNKNOWN_TYPE");
  one(validate({ schema: 2, type: "home", meta: {}, sections: [] }, { mode: "draft" }), "SCHEMA_UNSUPPORTED");
  one(validate({ schema: 1, type: "announcement", meta: {}, settings: { enabled: false, text: "", link: null }, sections: [sec("text", "sec_t1")] }, { mode: "draft" }), "SECTIONS_NOT_ALLOWED");
  one(validate({ schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "", link: null } }, { mode: "publish" }), "REQUIRED", { field: "text" });
  const pageMeta = validate({ schema: 1, type: "campaign", meta: { slug: "Big Sale!", title: "Sale", window_start: "2026-12-01T00:00:00Z", window_end: "2026-11-01T00:00:00Z" }, sections: [] }, { mode: "draft" });
  one(pageMeta, "SLUG_INVALID");
  one(pageMeta, "WINDOW_INVALID");
  one(validate({ schema: 1, type: "collections_index", meta: {}, settings: { featured: [{ handle: "mugs" }], order: [], hide: [{ handle: "mugs" }] } }, { mode: "draft" }), "SHOWN_AND_HIDDEN");
  let threw = false;
  try {
    R.validateDocument(home([]), { mode: "preview" });
  } catch {
    threw = true;
  }
  ok(threw, "an unknown mode is a bug, not a result");
});

await t("worstCase gives every registered kind its fixtures, each valid as a draft", async () => {
  for (const kind of R.sectionKinds()) {
    const { cases } = R.worstCase(kind);
    ok(cases.length >= 1, kind);
    const d = R.sectionType(kind);
    const titled = d.settings.find((s) => s.key === "title" && s.kind === "text");
    if (titled) eq(cases[0].section.settings.title.length, Math.min(120, titled.max), `${kind} title at its limit`);
    for (const c of cases) {
      const r = validate(R.fixtureDocument(d.documentTypes[0], [c.section]), { mode: c.name === "no_image" ? "draft" : "publish" });
      ok(r.ok, `${kind} ${c.name}: ${JSON.stringify(errorIssues(r.issues).map((i) => i.code))}`);
    }
  }
  const hero = R.worstCase("hero").cases.map((c) => c.name);
  deq(hero, ["long_text", "no_image", "tall_image"]);
  eq(R.worstCase("hero").cases[0].section.settings.title.length, 120, "a 120-character hero title");
  const rail = R.worstCase("product_rail");
  deq(
    rail.cases.map((c) => c.name),
    ["long_text", "one_item", "max_items", "sold_out"],
  );
  ok(rail.cases.find((c) => c.name === "sold_out").data.products.every((p) => p.soldOut), "all sold out");
  eq(rail.cases.find((c) => c.name === "max_items").data.products.length, 12);
  eq(rail.cases.find((c) => c.name === "one_item").data.products.length, 1);
  ok(rail.cases[0].data.products.some((p) => p.title.length >= 150), "long product names");
  eq(R.worstCase("faq").cases.find((c) => c.name === "max_items").section.settings.items.length, 30);
  ok(R.worstCase("collections").cases[0].data.collections.some((c) => c.image === null), "a collection with no image");
});

// ---- edge safety and wording ----------------------------------------------------------

await t("no lib/registry file imports react, next/* or node:*, directly or through what it imports", async () => {
  const BUILTINS = /^(?:node:|fs$|path$|os$|crypto$|child_process$|url$|util$|stream$|buffer$|http$|https$|net$|zlib$|events$)/;
  const FORBIDDEN = /^(?:react(?:-dom)?(?:\/|$)|next(?:\/|$))/;
  const seen = new Set();
  const queue = (await readdir(join(root, "lib/registry"))).filter((f) => f.endsWith(".js")).map((f) => join(root, "lib/registry", f));
  ok(queue.length >= 9, "all the registry files");
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await readFile(file, "utf8");
    const specs = [
      ...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g),
      ...src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
      ...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      ok(!FORBIDDEN.test(spec) && !BUILTINS.test(spec), `${file.slice(root.length + 1)} imports ${spec}`);
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else throw new Error(`${file.slice(root.length + 1)} imports a package (${spec}); the registry must stay dependency-free`);
    }
    ok(!/\brequire\(|\bprocess\.|\bBuffer\b|__dirname/.test(src.replace(/\/\/.*$/gm, "")), `${file.slice(root.length + 1)} uses a Node-only global`);
  }
  ok([...seen].some((f) => f.endsWith("lib/cms/issues.js")), "the walk follows imports out of lib/registry");
});

await t("P2-FIX4: each issue carries its class (issueClass), without changing the DOC-04 shape or the JSON sent to the editor", async () => {
  const V = await import("../lib/registry/validate.js");
  const r = validate(
    home([
      sec("hero", "sec_h1", { title: "Hi" }),
      sec("rich_text", "sec_r1", { title: 42, html: { not: "a string" } }),
      sec("banner", "sec_r2", { title: "", text: "" }),
    ]),
    { mode: "draft" },
  );
  const cls = (code, sectionId) => V.issueClass(r.issues.find((i) => i.code === code && i.sectionId === sectionId));
  eq(cls("INVALID_VALUE", "sec_r1"), "structure", "a title that is not text:");
  eq(r.issues.filter((i) => i.sectionId === "sec_r1" && i.code === "INVALID_VALUE").length, 2, "title and html both reported:");
  ok(r.issues.filter((i) => i.sectionId === "sec_r1").every((i) => V.issueClass(i) === "structure"), "both are structure");
  const empty = r.issues.find((i) => i.sectionId === "sec_r2" && i.severity === "incomplete");
  ok(empty, "an incomplete banner is reported");
  eq(V.issueClass(empty), "incomplete", "an empty banner:");
  // a sanitizer refusal is structure too
  const s = validate(home([sec("hero", "sec_h1", { title: "Hi" }), sec("rich_text", "sec_r3", { title: "T", html: "<p>a</p><iframe src=x>words inside</iframe>" })]), { mode: "publish" });
  for (const i of s.issues.filter((x) => x.sectionId === "sec_r3" && x.severity === "error")) eq(V.issueClass(i), "structure", `${i.code}:`);
  // every issue the validator makes has a class, and it never shows in the shape
  for (const i of [...r.issues, ...s.issues]) {
    ok(["structure", "invalid", "incomplete", "warning"].includes(V.issueClass(i)), `${i.code} has a class (${V.issueClass(i)})`);
    deq(Object.keys(i), ISSUE_KEYS, `${i.code} keys:`);
    ok(!("cls" in JSON.parse(JSON.stringify(i))), "not in the JSON");
  }
  eq(V.issueClass({ code: "X" }), null, "an issue made elsewhere:");
});

// ---- P3-VALIDATE (PV-02, AU-02, AU-04) ----------------------------------------------------

const V = await import("../lib/registry/validate.js");
const header = (items) => ({ schema: 1, type: "header", meta: {}, settings: { mode: "custom", items, template: "standard" } });
const page = (meta, sections = []) => ({ schema: 1, type: "page", meta: { slug: "about", title: "About", ...meta }, sections });
const codes = (r) => r.issues.map((i) => [i.code, i.field, i.severity]);

await t("PV-02: in a draft, a broken limit or rule inside a section is 'incomplete' (stored), and the same issue is an error at publish; its class is unchanged", async () => {
  const body = home([
    sec("hero", "sec_hero1", { title: "Edited title" }),
    sec("banner", "sec_bn1", { title: "Sale", button: { label: "Go", link: { type: "url", href: "https://evil.example" } } }),
    sec("product_rail", "sec_r1", { collection: { handle: "Not A Handle" } }),
    sec("image_with_text", "sec_i1", { image: { media: "http://insecure.example/a.jpg", alt: "A" } }),
    sec("new", "sec_n1", { limit: 99 }),
    sec("faq", "sec_f1", { items: [{ q: "Q".repeat(301), a: "<p>A</p>" }] }),
  ]);
  const draft = validate(body, { mode: "draft" });
  ok(draft.ok, `the draft saves: ${JSON.stringify(codes(draft))}`);
  const want = [
    ["sec_bn1", "button.link.href", "LINK_NOT_STOREFRONT"],
    ["sec_r1", "collection.handle", "INVALID_VALUE"],
    ["sec_i1", "image.media", "IMAGE_INVALID"],
    ["sec_n1", "limit", "OUT_OF_RANGE"],
    ["sec_f1", "items.0.q", "TOO_LONG"],
  ];
  for (const [sectionId, field, code] of want) {
    const i = one(draft, code, { sectionId, field });
    eq(i.severity, "incomplete", `${sectionId} ${code} in a draft:`);
    eq(V.issueClass(i), "invalid", `${sectionId} ${code} keeps its class:`);
  }
  const pub = validate(body, { mode: "publish" });
  ok(!pub.ok, "publish refuses");
  for (const [sectionId, field, code] of want) eq(one(pub, code, { sectionId, field }).severity, "error", `${sectionId} ${code} at publish:`);
  // the stored body keeps every value exactly as typed
  eq(draft.body.sections[1].settings.button.link.href, "https://evil.example");
  eq(draft.body.sections[0].settings.title, "Edited title");
});

await t("PV-02: in a draft, a page title or description over its limit and a menu item's bad link are 'incomplete'; SLUG_INVALID and structure stay errors", async () => {
  const long = validate(page({ title: "T".repeat(121), description: "D".repeat(301) }), { mode: "draft" });
  ok(long.ok, `saves: ${JSON.stringify(codes(long))}`);
  eq(one(long, "TOO_LONG", { field: "meta.title" }).severity, "incomplete", "title:");
  eq(one(long, "TOO_LONG", { field: "meta.description" }).severity, "incomplete", "description:");
  for (const f of ["meta.title", "meta.description"]) eq(one(validate(page({ title: "T".repeat(121), description: "D".repeat(301) }), { mode: "publish" }), "TOO_LONG", { field: f }).severity, "error", `${f} at publish:`);

  const nav = header([
    { label: "Admin", link: { type: "url", href: "/admin" } },
    { label: "Shop", link: { type: "collection", handle: "Bad Handle" }, children: [{ label: "Evil", link: { type: "url", href: "https://evil.example" } }] },
  ]);
  const navDraft = validate(nav, { mode: "draft" });
  ok(navDraft.ok, `a menu with bad links saves: ${JSON.stringify(codes(navDraft))}`);
  for (const [code, field] of [["LINK_NOT_STOREFRONT", "items.0.link.href"], ["LINK_INVALID", "items.1.link.handle"], ["LINK_NOT_STOREFRONT", "items.1.children.0.link.href"]]) {
    eq(one(navDraft, code, { field, documentId: "doc_header" }).severity, "incomplete", `${field}:`);
    eq(one(validate(nav, { mode: "publish" }), code, { field }).severity, "error", `${field} at publish:`);
  }
  // still errors in a draft
  const stays = [
    [page({ slug: "Big Sale!" }), "SLUG_INVALID", "meta.slug"],
    [page({ redirect_from: ["Not A Slug"] }), "SLUG_INVALID", "meta.redirect_from.0"],
    [page({ title: 42 }), "INVALID_VALUE", "meta.title"],
    [header([{ label: "Odd", link: { type: "ftp" } }]), "LINK_INVALID", "items.0.link"],
    [header([{ label: "x".repeat(41), link: { type: "url", href: "/" } }]), "TOO_LONG", "items.0.label"],
    [home([sec("hero", "sec_h1"), sec("hero", "sec_h2")]), "TOO_MANY_OF_KIND", "kind"],
    [home([sec("banner", "sec_b1", { title: "Hi", colour: "red" })]), "UNKNOWN_FIELD", "colour"],
    [{ schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "Hi", link: { type: "url", href: "https://evil.example" } } }, "LINK_NOT_STOREFRONT", "link.href"],
    [{ schema: 1, type: "collections_index", meta: {}, settings: { featured: [{ handle: "mugs" }], order: [], hide: [{ handle: "mugs" }] } }, "SHOWN_AND_HIDDEN", "hide"],
  ];
  for (const [body, code, field] of stays) {
    const r = validate(body, { mode: "draft" });
    eq(one(r, code, { field }).severity, "error", `${code} on ${field} in a draft:`);
    ok(!r.ok, `${code} on ${field}: the draft is refused`);
  }
});

await t("AU-02: HIGHLIGHT_NOT_IN_TITLE stays a warning, on the hero's title field, in plain words", async () => {
  for (const mode of ["draft", "publish"]) {
    const r = validate(home([sec("hero", "sec_h1", { title: "Made for every day", highlight: "old words" })]), { mode });
    const i = one(r, "HIGHLIGHT_NOT_IN_TITLE", { sectionId: "sec_h1" });
    eq(i.severity, "warning", `${mode}:`);
    eq(i.field, "title", `${mode} field:`);
    eq(i.message, "The highlighted words aren't in the title any more, so nothing will be highlighted. Pick words from the title to highlight.");
    ok(r.ok, "a warning never blocks");
    eq(R.where(i, home([sec("hero", "sec_h1")])), "Hero · Title");
    eq(R.fieldAnchor(i), "f-sec_h1-title");
  }
  none(validate(home([sec("hero", "sec_h1", { title: "Made for every day", highlight: "every" })]), { mode: "publish" }), "a matching highlight");
});

await t("AU-02: fieldAnchor is f-<section|doc>-<path>, stable and unique per (section, field), and falls back to the top-level setting key", async () => {
  eq(R.fieldAnchor({ sectionId: "sec_hero", field: "title" }), "f-sec_hero-title");
  eq(R.fieldAnchor({ sectionId: "sec_t1", field: "body.2" }), "f-sec_t1-body-2");
  eq(R.fieldAnchor({ sectionId: "sec_f1", field: "items.1.q" }), "f-sec_f1-items-1-q");
  eq(R.fieldAnchor({ sectionId: null, documentId: "doc_x", field: "meta.title" }), "f-doc-meta-title");
  eq(R.fieldAnchor({ sectionId: null, documentId: "doc_header", field: "items.0.children.2.link.href" }), "f-doc-items-0-children-2-link-href");
  eq(R.fieldAnchor({ sectionId: "sec_b1", field: null }), "f-sec_b1");
  // the fallback: the closest field the form renders, down to the setting key
  eq(R.fieldAnchor({ sectionId: "sec_hero", field: "primary.link.href" }, { known: new Set() }), "f-sec_hero-primary");
  eq(R.fieldAnchor({ sectionId: "sec_hero", field: "primary.link.href" }, { known: new Set(["f-sec_hero-primary-link"]) }), "f-sec_hero-primary-link");
  eq(R.fieldAnchor({ sectionId: "sec_t1", field: "body.2" }, { known: (a) => a === "f-sec_t1-body-2" }), "f-sec_t1-body-2");
  eq(R.fieldAnchor({ sectionId: null, field: "meta.title" }, { known: new Set() }), "f-doc-meta-title");
  // unique and stable over every (section, field) of every kind, two sections each
  const seen = new Map();
  for (const kind of R.sectionKinds()) {
    for (const id of ["sec_one1", "sec_two2"]) {
      for (const s of R.sectionType(kind).settings) {
        for (const field of [s.key, `${s.key}.0`, `${s.key}.label`, `${s.key}.link.href`]) {
          const a = R.fieldAnchor({ sectionId: id, field });
          eq(R.fieldAnchor({ sectionId: id, field }), a, "stable:");
          const key = `${id}|${field}`;
          if (seen.has(a)) eq(seen.get(a), key, `anchor ${a} is shared by`);
          seen.set(a, key);
          ok(/^f-sec_[a-z0-9]+-[a-z0-9_-]+$/.test(a), `an id-safe anchor: ${a}`);
        }
      }
    }
  }
  ok(seen.size > 100, `anchors checked: ${seen.size}`);
});

await t("AU-02: where() names the section and the field by their labels for every registered kind and document type; a text section's paragraphs are body.N", async () => {
  for (const kind of R.sectionKinds()) {
    const d = R.sectionType(kind);
    const s = R.newSection(kind, { id: "sec_w1" });
    const body = R.fixtureDocument(d.documentTypes[0], [s]);
    eq(R.where({ sectionId: "sec_w1", field: null }, body), d.label, `${kind} with no field:`);
    for (const setting of d.settings) eq(R.where({ sectionId: "sec_w1", field: setting.key }, body), `${d.label} · ${setting.label}`, `${kind}.${setting.key}:`);
  }
  eq(R.where({ sectionId: "sec_bn", field: "button.link.href" }, home([sec("banner", "sec_bn")])), "Banner · Button", "the spec's example:");
  const text = home([sec("text", "sec_t1", { title: "", body: ["One", "Two", "x".repeat(4001)] })]);
  const para = one(validate(text, { mode: "draft" }), "TOO_LONG", { sectionId: "sec_t1" });
  eq(para.field, "body.2", "the third paragraph's path:");
  eq(R.where(para, text), "Text · Paragraphs · paragraph 3");
  eq(R.fieldAnchor(para), "f-sec_t1-body-2");
  eq(R.where({ sectionId: "sec_f1", field: "items.1.a" }, home([sec("faq", "sec_f1")])), "FAQ · Questions · question 2 · answer");
  eq(R.where({ sectionId: null, documentId: "doc_header", field: "items.0.children.1.link.href" }), "Header menu · Menu items · item 1 · sub-item 2");
  eq(R.where({ sectionId: null, documentId: "doc_x", field: "meta.title" }, page({})), "Page · Title");
  eq(R.where({ sectionId: null, documentId: "doc_x", field: "meta.slug" }, page({})), "Page · Web address");
  for (const type of R.documentTypeNames()) {
    const t = R.documentType(type);
    for (const setting of t.settings) eq(R.where({ sectionId: null, field: setting.key }, R.emptyBody(type)), `${t.label} · ${setting.label}`, `${type}.${setting.key}:`);
  }
  eq(R.where({ sectionId: "sec_gone", field: "title" }, home([])), "Section", "a section the body doesn't hold:");
});

// AU-04
const COLLECTIONS = [
  { handle: "empty-shelf", id: "gid://shopify/Collection/3", product_count: 0, available_count: 0 },
  { handle: "nearly", id: "gid://shopify/Collection/4", product_count: 5, available_count: 2 },
  { handle: "serums", id: "gid://shopify/Collection/1", product_count: 3, available_count: 3 },
];
await t("AU-04: starterSection binds a new product rail to the first collection with enough available products, else the first non-empty one; with none it is newSection", async () => {
  const rail = R.starterSection("product_rail", { collections: COLLECTIONS, id: "sec_r1" });
  deq(rail.settings.collection, { handle: "serums", id: "gid://shopify/Collection/1" });
  none(validate(home([rail]), { mode: "publish" }), "a rail with a real collection publishes clean");
  deq(R.starterSection("product_rail", { collections: COLLECTIONS.slice(0, 2), id: "sec_r1" }).settings.collection, { handle: "nearly", id: "gid://shopify/Collection/4" }, "none has enough: the first non-empty");
  for (const collections of [undefined, null, [], [COLLECTIONS[0]], [{ handle: "Bad Handle", product_count: 9 }]]) {
    deq(R.starterSection("product_rail", { collections, id: "sec_r1" }), R.newSection("product_rail", { id: "sec_r1" }), `collections ${JSON.stringify(collections)}:`);
  }
  // every other kind is its newSection: text kinds stay incomplete with their placeholder
  for (const kind of R.sectionKinds()) {
    if (kind === "product_rail") continue;
    const s = R.starterSection(kind, { collections: COLLECTIONS, id: "sec_k1" });
    deq(s, R.newSection(kind, { id: "sec_k1" }), `${kind}:`);
    const d = R.sectionType(kind);
    if (d.startsIncomplete) {
      ok(d.placeholder, `${kind} has a placeholder`);
      const r = validate(R.fixtureDocument(d.documentTypes[0], [s]), { mode: "publish" });
      ok(!r.ok || kind === "product_rail", `${kind}: a starter that starts incomplete must not publish as it is`);
    }
  }
  let threw = false;
  try {
    R.starterSection("carousel");
  } catch {
    threw = true;
  }
  ok(threw, "an unknown kind is a bug");
});

// ---- P3-FIX1: the P3-VALIDATE review findings ----------------------------------------------

await t("P3-FIX1: pickRailCollection never counts product_count as available; a known available count is preferred", async () => {
  const { pickRailCollection } = await import("../lib/registry/starter.js");
  const min = R.sectionType("product_rail").minItems;
  const big = { handle: "big", product_count: 20 }; // no available count: unknown
  const known = { handle: "known", available_count: min, product_count: min };
  const small = { handle: "small", available_count: 1, product_count: 9 };
  const soldOut = { handle: "sold-out", available_count: 0, product_count: 5 };
  eq(pickRailCollection([big, known], min)?.handle, "known", "a known count of enough beats a big unknown one:");
  eq(pickRailCollection([big, small], min)?.handle, "small", "a known count above 0 beats an unknown one:");
  eq(pickRailCollection([soldOut, big], min)?.handle, "big", "an unknown count with products beats a known 0:");
  eq(pickRailCollection([big], min)?.handle, "big", "alone, an unknown one with products is still taken:");
  eq(pickRailCollection([soldOut], min)?.handle, "sold-out", "alone, a sold-out one that holds products (today's fallback):");
  eq(pickRailCollection([big, { handle: "ap", availableProducts: min }], min)?.handle, "ap", "availableProducts counts as known:");
  eq(pickRailCollection([{ handle: "none", product_count: 0 }], min), null, "an empty one is never taken:");
  deq(R.starterSection("product_rail", { collections: [big, known], id: "sec_r1" }).settings.collection, { handle: "known" }, "starterSection follows it:");
});

await t("P3-FIX1: a draft has a hard cap: over 512 KB, a text over 20,000 characters, or a list over 4x its publish maximum is an error (not incomplete)", async () => {
  // a text over 20,000 characters: one error for the field, no incomplete note beside it
  const longTitle = home([sec("text", "sec_t1", { title: "x".repeat(20_001) })]);
  const r1 = validate(longTitle, { mode: "draft" });
  eq(r1.ok, false, "refused:");
  const e1 = one(r1, "TOO_LONG_TO_SAVE", { sectionId: "sec_t1" });
  eq(e1.severity, "error", "severity:");
  eq(e1.field, "title", "field:");
  eq(find(r1, "TOO_LONG", { sectionId: "sec_t1", field: "title" }).length, 0, "the incomplete note is replaced:");
  // just under: still a tolerated incomplete draft
  const r1b = validate(home([sec("text", "sec_t1", { title: "x".repeat(20_000) })]), { mode: "draft" });
  eq(r1b.ok, true, "20,000 characters is a draft:");
  eq(one(r1b, "TOO_LONG", { sectionId: "sec_t1" }).severity, "incomplete", "and stays incomplete:");
  // the largest publish limit (the custom section's 20,000) still publishes
  const custom = R.sectionType("custom_html") ? "custom_html" : R.sectionKinds().find((k) => R.sectionType(k).settings.some((s) => s.kind === "rich_text" && s.max === 20_000));
  ok(custom, "a section with a 20,000 limit");
  const key = R.sectionType(custom).settings.find((s) => s.max === 20_000).key;
  const fullHtml = `<p>${"y".repeat(20_000 - 7)}</p>`;
  eq(fullHtml.length, 20_000, "fixture length:");
  const typeFor = R.sectionType(custom).documentTypes[0];
  const atLimit = R.fixtureDocument(typeFor, [sec(custom, "sec_c1", { [key]: fullHtml })]);
  eq(find(validate(atLimit, { mode: "draft" }), "TOO_LONG_TO_SAVE").length, 0, "a publishable rich text is never capped:");
  eq(find(validate(atLimit, { mode: "publish" }), "TOO_LONG").length, 0, "and publishes:");
  // FAQ answers and menu labels deep in lists
  const faq = home([sec("faq", "sec_f1", { items: [{ q: "Q", a: `<p>${"z".repeat(20_001)}</p>` }] })]);
  eq(one(validate(faq, { mode: "draft" }), "TOO_LONG_TO_SAVE", { sectionId: "sec_f1" }).field, "items.0.a", "an answer's path:");
  // a list over 4x its publish maximum
  const paras = (n) => home([sec("text", "sec_t2", { body: Array.from({ length: n }, (_, i) => `p${i}`) })]);
  const max = R.sectionType("text").settings.find((s) => s.key === "body").max;
  const r2 = validate(paras(max * 4 + 1), { mode: "draft" });
  eq(r2.ok, false, "over 4x refused:");
  eq(one(r2, "TOO_MANY_TO_SAVE", { sectionId: "sec_t2" }).field, "body", "field:");
  eq(find(r2, "TOO_MANY", { sectionId: "sec_t2" }).length, 0, "the incomplete note is replaced:");
  const r2b = validate(paras(max * 4), { mode: "draft" });
  eq(r2b.ok, true, "exactly 4x is a draft:");
  eq(one(r2b, "TOO_MANY", { sectionId: "sec_t2" }).severity, "incomplete", "and stays incomplete:");
  const qa = home([sec("faq", "sec_f2", { items: Array.from({ length: 5000 }, () => ({ q: "Q", a: "<p>A</p>" })) })]);
  eq(validate(qa, { mode: "draft" }).ok, false, "the review's 5,000-question FAQ:");
  // a menu item's sub-items (publish limit 8)
  const header = (n) => ({ ...R.emptyBody("header"), settings: { ...R.emptyBody("header").settings, mode: "custom", items: [{ label: "Shop", link: { type: "url", href: "/collections" }, children: Array.from({ length: n }, (_, i) => ({ label: `c${i}`, link: { type: "url", href: "/collections" } })) }] } });
  eq(one(validate(header(33), { mode: "draft" }), "TOO_MANY_TO_SAVE").field, "items.0.children", "33 sub-items:");
  eq(find(validate(header(32), { mode: "draft" }), "TOO_MANY_TO_SAVE").length, 0, "32 sub-items:");
  // a body over 512 KB, every field within its own cap
  const bulky = (sections) => home(Array.from({ length: sections }, (_, i) => sec("text", `sec_b${i}`, { body: Array.from({ length: 100 }, () => "w".repeat(3000)) })));
  const r3 = validate(bulky(2), { mode: "draft" });
  eq(r3.ok, false, "over 512 KB refused:");
  eq(one(r3, "DRAFT_TOO_LARGE").severity, "error", "one body-level error:");
  eq(validate(bulky(1), { mode: "draft" }).ok, true, "300 KB is a draft:");
  // publish mode is unchanged: the usual limits, no cap codes (publish has no
  // body size limit of its own: see the packet's known limits)
  for (const [b, refused] of [[longTitle, true], [paras(max * 4 + 1), true], [bulky(2), false]]) {
    const p = validate(b, { mode: "publish" });
    eq(p.ok, !refused, "publish as before:");
    ok(!p.issues.some((i) => ["TOO_LONG_TO_SAVE", "TOO_MANY_TO_SAVE", "DRAFT_TOO_LARGE"].includes(i.code)), "no cap code in publish");
  }
});

await t("P3-FIX1: an oversized draft is refused on save (saveDraft answers 422 and stores nothing)", async () => {
  const { libsql } = await import("../lib/db.js");
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
  await libsql.executeMultiple(await readFile(join(root, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"), {});
  await libsql.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  const Svc = await import("../lib/documents/service.js");
  const actor = { kind: "merchant", id: "u_reg" };
  const { document: d } = await Svc.createDocument({ type: "home", body: home([sec("text", "sec_s1", { title: "Small" })]), actor });
  for (const big of [home([sec("text", "sec_s1", { title: "x".repeat(20_001) })]), home([sec("faq", "sec_s2", { items: Array.from({ length: 5000 }, () => ({ q: "Q", a: "<p>A</p>" })) })])]) {
    let err = null;
    try {
      await Svc.saveDraft({ id: d.id, revision: d.revision, body: big, actor });
    } catch (e) {
      err = e;
    }
    ok(err, "saveDraft refused it");
    eq(err.status, 422, "status:");
    ok(JSON.stringify(err.extra ?? err.issues ?? err.message).match(/TOO_LONG_TO_SAVE|TOO_MANY_TO_SAVE/) || /too long to save|too many to save/.test(JSON.stringify(err)), `the cap's code: ${String(err.message).slice(0, 200)}`);
    const now = await Svc.getDocument(d.id);
    eq(now.revision, d.revision, "nothing stored:");
    eq(now.body.sections[0].settings.title, "Small", "the draft is as it was:");
  }
  // a draft over a publish limit (but under the cap) still saves, as PV-02 says
  const saved = await Svc.saveDraft({ id: d.id, revision: d.revision, body: home([sec("text", "sec_s1", { title: "x".repeat(121) })]), actor });
  ok(saved.document.revision > d.revision, "an over-limit title under the cap saves");
});

// ---- AU-02: every message is a plain sentence --------------------------------------------

// Bad values for each setting kind, so every check of lib/registry/settings.js
// speaks at least once.
const ok1 = { type: "url", href: "/" };
function badValues(s) {
  const long = (n) => "x".repeat(n);
  switch (s.kind) {
    case "text":
      return [42, ...(s.max != null ? [long(s.max + 5)] : []), ...(s.softMax != null ? [long(s.softMax + 1)] : [])];
    case "number":
      return ["5", 1.5, (s.min ?? 0) - 1, (s.max ?? 10) + 1];
    case "boolean":
      return ["yes"];
    case "choice":
      return ["nope"];
    case "rich_text":
      return [5, "<p>Buy 2 < 3 and save > 10%</p>", '<p><a href="ftp://x.example/a">l</a></p>', '<p>Hi</p><video src="https://x.example/v.mp4"></video>', '<p>Hi</p><img srcset="https://x.example/a.avif 1x" alt="a">', ...(s.max != null ? [`<p>${long(s.max)}</p>`] : [])];
    case "paragraphs":
      return ["x", [5], [long((s.maxEach ?? 10) + 1)], Array.from({ length: (s.max ?? 1) + 1 }, () => "p")];
    case "qa_list":
      return ["x", [5], [{ q: "", a: "", z: 1 }], [{ q: long(301), a: "<p>a</p>" }], [{ q: "Q", a: 5 }], [{ q: "Q", a: "<p>2 < 3 and > 1</p>" }], Array.from({ length: (s.max ?? 1) + 1 }, () => ({ q: "Q", a: "<p>A</p>" }))];
    case "link":
      return [5, { type: "ftp" }, { type: 5 }, { type: "url" }, { type: "url", href: "https://evil.example" }, { type: "collection", handle: "Bad Handle" }, { type: "product", handle: "x", id: 5 }, { type: "page", slug: "Bad!", family: "nope", document: 5 }, { type: "url", href: "/", extra: 1 }];
    case "cta":
      return [5, { label: long(41), link: null }, { label: "Go" }, { link: ok1 }, { label: "Go", link: { type: "url", href: "https://evil.example" } }, { label: "Go", link: ok1, z: 1 }];
    case "image":
      return [5, { media: 5, alt: "a" }, { media: "http://x.example/a.jpg", alt: "a" }, { media: `/${long(600)}`, alt: "a" }, { media: "/a.jpg" }, { media: "/a.jpg", alt: long(301) }, { media: "/a.jpg", alt: "a", z: 1 }];
    case "collection":
    case "product":
      return [5, { handle: "Bad" }, { handle: "x", id: 5 }, { handle: "x", z: 1 }];
    case "collection_list":
    case "product_list":
      return [5, [5], [{ handle: "Bad" }], Array.from({ length: (s.max ?? 1) + 1 }, (_, j) => ({ handle: `h${j}` }))];
    case "nav_items":
      return [
        5,
        [5],
        [{ label: "", link: null }],
        [{ label: long(41), link: { type: "url", href: "/admin" } }],
        [{ label: "a", link: ok1, children: 5 }],
        [{ label: "a", link: ok1, children: Array.from({ length: 9 }, () => ({ label: "b", link: ok1 })) }],
        [{ label: "a", link: ok1, children: [{ label: "b", link: ok1, children: [] }] }],
        [{ label: "a", link: ok1, z: 1 }],
        Array.from({ length: (s.max ?? 1) + 1 }, () => ({ label: "a", link: ok1 })),
      ];
    case "brand":
      return [5, { accent: "lime" }, { background: "nope", foreground: "nope" }, { radius: "huge" }, { type_scale: "x" }, { button_shape: "x" }, { section_spacing: "x" }, { z: 1 }];
    case "theme":
      return [5, { kit: "nope", version: 1 }, { kit: "pulse", version: 1, z: 1 }];
    case "entries":
      return [5];
    // P4-LIVEROW
    case "overlay":
      return [5, { value: null, z: 1 }, { value: "x", base_hash: 5 }, ...(s.nonEmpty ? [{ value: "  " }] : []), ...badValues({ ...s, kind: s.of }).map((x) => ({ value: x, base_hash: null, base_value: null }))];
    case "gallery":
      return [5, [], [5], [{ media: 5 }], [{ media: "http://x.example/a.jpg" }], [{ media: `/${long(1001)}` }], [{ media: "/a.jpg", alt: long(513) }], [{ media: "/a.jpg", z: 1 }], Array.from({ length: (s.max ?? 1) + 1 }, () => ({ media: "/a.jpg", alt: "a" }))];
    case "pairs":
      return [5, { title: long(81), products: [] }, { products: [5] }, { products: ["gid://shopify/Product/1", "gid://shopify/Product/1"] }, { products: [], z: 1 }, { products: Array.from({ length: (s.max ?? 1) + 1 }, (_, j) => `gid://shopify/Product/${j}`) }];
    case "product_ids":
      return [5, [5], ["a", "a"], Array.from({ length: (s.max ?? 1) + 1 }, (_, j) => `gid://shopify/Product/${j}`)];
    // P5-SETTING
    case "bundle":
      return [5, "bun-1", {}, { id: 5 }, { id: "" }, { id: "has space" }, { id: "x".repeat(65) }, { id: "bun-1", price: 100 }, { id: "bun-1", title: "Duo" }];
    case "bundle_list":
      return [5, [5], [{ id: 5 }], [{ id: "bun-1" }, { id: "bun-1" }], [{ id: "bun-1", slug: "duo" }], Array.from({ length: (s.max ?? 12) + 1 }, (_, j) => ({ id: `bun-${j}` }))];
    default:
      throw new Error(`no bad values for the setting kind "${s.kind}": add them here`);
  }
}

await t("crafted bad values for every setting kind of every section and document type, and every rules() function, are each reported", async () => {
  const kinds = new Set();
  for (const kind of R.sectionKinds()) {
    const d = R.sectionType(kind);
    for (const s of d.settings) {
      kinds.add(s.kind);
      for (const bad of badValues(s)) {
        const section = sec(kind, "sec_bad1", { [s.key]: bad });
        for (const mode of ["draft", "publish"]) validate(R.fixtureDocument(d.documentTypes[0], [section]), { mode });
      }
      // empty: a required setting says so
      for (const mode of ["draft", "publish"]) validate(R.fixtureDocument(d.documentTypes[0], [sec(kind, "sec_bad1", { [s.key]: null })]), { mode });
    }
  }
  for (const type of R.documentTypeNames()) {
    const t = R.documentType(type);
    for (const s of t.settings) {
      kinds.add(s.kind);
      if (s.of) kinds.add(s.of); // P4-LIVEROW: an overlay's own kind (gallery)
      for (const bad of badValues(s)) for (const mode of ["draft", "publish"]) validate({ ...R.emptyBody(type), settings: { ...R.emptyBody(type).settings, [s.key]: bad } }, { mode });
    }
  }
  // P5-BLOCKS: bundle and bundle_list are declared by bundle_card and
  // bundle_grid (their bad values ran in the loop above), so no kind waits
  for (const k of Object.keys(R.SETTING_KINDS)) ok(kinds.has(k) || k === "number" || k === "product", `setting kind ${k} is declared somewhere`);
  ok(kinds.has("bundle") && kinds.has("bundle_list"), "the bundle setting kinds are declared by a registered kind");
  // each section rules() and document rules() function, made to speak
  validate(home([sec("hero", "sec_h1", { title: "T", highlight: "X" })]), { mode: "draft" });
  validate(home([sec("banner", "sec_b1", { title: "", text: "" })]), { mode: "publish" });
  validate(home([sec("text", "sec_t1", { title: "", body: [] })]), { mode: "publish" });
  validate(home([sec("product_rail", "sec_r1", { collection: { handle: "x" }, limit: 2 })]), { mode: "publish" });
  validate({ schema: 1, type: "announcement", meta: {}, settings: { enabled: true, text: "", link: null } }, { mode: "publish" });
  validate({ schema: 1, type: "footer", meta: {}, settings: { mode: "auto", items: [{ label: "a", link: ok1 }], template: "columns" } }, { mode: "publish" });
  validate({ schema: 1, type: "design", meta: {}, settings: { brand: { accent: "#ffff00", background: "#ffffff", foreground: "#fefefe" }, theme: { kit: "pulse", version: 1 } } }, { mode: "publish" });
  validate({ schema: 1, type: "design", meta: {}, settings: { brand: { accent: "#9ca3af", background: "#ffffff", foreground: "#0a0a0b" }, theme: { kit: "pulse", version: 1 } } }, { mode: "publish" });
  validate(home([]), { mode: "publish" });
  validate({ schema: 1, type: "collections_index", meta: {}, settings: { featured: [{ handle: "mugs" }], order: [], hide: [{ handle: "mugs" }] } }, { mode: "draft" });
  // and the structure checks of validate.js that need a whole body
  validate({ schema: 1, type: "page", meta: "x", sections: [] }, { mode: "draft" });
  validate({ schema: 1, type: "header", meta: { x: 1 }, settings: "x" }, { mode: "draft" });
  validate({ schema: 1, type: "page", meta: { slug: "", title: "", enabled: "yes", effective_at: "never", window_start: "2026-12-01", window_end: "2026-11-01", redirect_from: "x" }, sections: [] }, { mode: "publish" });
  validate({ schema: 1, type: "page", meta: { slug: "a", title: "A", redirect_from: ["Bad Old"] }, sections: [{ ...sec("text", "sec_t1"), v: 0 }, { ...sec("text", "sec_t2"), v: 2 }, { ...sec("text", "sec_t3"), enabled: "x", show: "x", bindings: "x", blocks: "x", mobile: "x" }] }, { mode: "draft" });
  validate({ schema: 1, type: "product_content", meta: {}, sections: [sec("text", "sec_t1", { title: "Care" })] }, { mode: "publish" });
  // P4-LIVEROW: product content's rules and notes, and Shopify-owned fields
  validate({ ...R.emptyBody("product_content"), settings: { ...R.emptyBody("product_content").settings, gallery: { value: [{ media: "https://images.example.com/a.png", alt: "A" }] } } }, { mode: "publish" });
  validate({ ...R.emptyBody("product_content"), handle: "x", meta: { tags: [] } }, { mode: "draft" });
  const notes = DT.productModuleNotes({
    ...R.emptyBody("product_content"),
    sections: [sec("image_with_text", "sec_iw", { image: { media: "/a.jpg", alt: "a" } }), ...Array.from({ length: 6 }, (_, j) => sec("rich_text", `sec_n${j}`, { title: "x".repeat(81), html: "<p>a</p>" }))],
  });
  const { issue: mkIssue } = await import("../lib/cms/issues.js");
  // as lib/documents/service.js and publish.js add them to a save's or a publish's issues
  ALL.push(...notes.map((n) => mkIssue({ documentId: "doc_prod_x", sectionId: n.sectionId ?? null, field: n.field ?? null, code: n.code, severity: "warning", message: n.message })));
  // P4-ED05 (D2): a banner on a page, campaign or journal post, as service.js and checks.js add it
  const { notShownNotes } = await import("../lib/registry/sections.js");
  ALL.push(...notShownNotes({ ...R.emptyBody("page"), sections: [sec("banner", "sec_bn", { title: "Old" })] }).map((n) => mkIssue({ documentId: "doc_p_x", sectionId: n.sectionId, field: null, code: n.code, severity: "warning", message: n.message })));
  validate(home([sec("collections", "sec_c1", {}, { bindings: { collections: { source: "every_product" } }, blocks: [{ id: "blk_a1", kind: "x" }] })]), { mode: "draft" });
});

// P4-SEARCH (the P4-LIVEROW review): what product modules need to reach shoppers.
await t("P4-SEARCH: a rich text or text product module with no title is incomplete in a draft and an error at publish, naming the module; an image-with-text module's image from another website warns in a draft and is an error at publish; titled modules and allowed images are clean", async () => {
  const pc = (sections) => ({ ...R.emptyBody("product_content"), sections });
  for (const [kind, settings, what] of [["rich_text", { title: "", html: "<p>Care</p>" }, "rich text"], ["text", { title: " ", body: ["Care"] }, "text"]]) {
    const d = one(validate(pc([sec(kind, "sec_m1", settings)]), { mode: "draft" }), "MODULE_TITLE_MISSING", { sectionId: "sec_m1" });
    eq(d.severity, "incomplete", `${kind} draft:`);
    eq(d.field, "title", `${kind} field:`);
    eq(d.message, `This ${what} module has no title, so shoppers won't see it: on the product page a module shows as a title they tap to open. Add a title.`, `${kind} words:`);
    eq(one(validate(pc([sec(kind, "sec_m1", settings)]), { mode: "publish" }), "MODULE_TITLE_MISSING").severity, "error", `${kind} publish:`);
  }
  none(validate(pc([sec("rich_text", "sec_m1", { title: "Care", html: "<p>Care</p>" }), sec("text", "sec_m2", { title: "Fit", body: ["Snug"] })]), { mode: "publish" }), "titled modules");
  // an FAQ's questions are its titles; a page's rich text is not a product module
  none(validate(pc([sec("faq", "sec_f1", { items: [{ q: "Q?", a: "<p>A</p>" }] })]), { mode: "publish" }), "faq");
  none(validate({ schema: 1, type: "page", meta: { slug: "a", title: "A" }, sections: [sec("rich_text", "sec_r1", { html: "<p>Hi</p>" })] }, { mode: "publish" }), "a page's untitled rich text");
  const img = (media) => pc([sec("image_with_text", "sec_i1", { image: { media, alt: "A" }, title: "Look" })]);
  eq(one(validate(img("https://evil.example.com/a.png"), { mode: "draft" }), "IMAGE_HOST_NOT_ALLOWED").severity, "warning", "draft:");
  const e = one(validate(img("https://evil.example.com/a.png"), { mode: "publish" }), "IMAGE_HOST_NOT_ALLOWED", { sectionId: "sec_i1" });
  deq([e.severity, e.field], ["error", "image"], "publish:");
  for (const media of ["https://cdn.shopify.com/s/a.png", "/api/media/med_1"]) eq(find(validate(img(media), { mode: "publish" }), "IMAGE_HOST_NOT_ALLOWED").length, 0, `${media}:`);
  // a page's image-with-text is not held to the product allowlist
  eq(find(validate({ schema: 1, type: "page", meta: { slug: "a", title: "A" }, sections: [sec("image_with_text", "sec_i1", { image: { media: "https://images.example.com/a.png", alt: "A" }, title: "Look" })] }, { mode: "publish" }), "IMAGE_HOST_NOT_ALLOWED").length, 0, "a page:");
});

// ---- P5-SETTING (COM-01, COM-02, TREE-01): bundles chosen by id ---------------------

const VAL = await import("../lib/registry/validate.js");
// A throwaway home kind with the two bundle kinds (P5-BLOCKS declares the real
// bundle_card and bundle_grid).
const withBundleProbe = async (fn) => {
  R.defineSection({
    kind: "zz_bundles",
    label: "Bundle probe",
    documentTypes: ["home"],
    settings: [
      { key: "bundle", kind: "bundle", label: "Bundle", required: true, default: null },
      { key: "bundles", kind: "bundle_list", label: "Bundles to show", default: [] },
      { key: "few", kind: "bundle_list", label: "A few bundles", max: 3, default: [] },
    ],
  });
  try {
    await fn();
  } finally {
    R.removeSection("zz_bundles");
  }
};
const bundleDoc = (settings) => home([sec("zz_bundles", "sec_bp1", { bundle: { id: "bun-0a1b2c" }, ...settings })]);

await t("P5-SETTING: a bundle setting takes { id } (bun-<hex> and older raw ids like bnd_p1c); price, title or stock keys are UNKNOWN_FIELD of class structure; null on a required bundle is incomplete", async () => {
  await withBundleProbe(async () => {
    for (const id of ["bun-0a1b2c3d4e5f6a7b8c", "bnd_p1c"]) for (const mode of ["draft", "publish"]) none(validate(bundleDoc({ bundle: { id } }), { mode }), `${id} ${mode}:`);
    for (const key of ["price", "title", "available", "slug", "bundle_price", "items"]) {
      for (const mode of ["draft", "publish"]) {
        const i = one(validate(bundleDoc({ bundle: { id: "bun-0a1b2c", [key]: key === "available" ? true : "x" } }), { mode }), "UNKNOWN_FIELD", { sectionId: "sec_bp1", field: `bundle.${key}` });
        eq(VAL.issueClass(i), "structure", `${key} ${mode} class:`);
        eq(i.severity, "error", `${key} ${mode} severity:`);
      }
    }
    const draft = one(validate(bundleDoc({ bundle: null }), { mode: "draft" }), "REQUIRED", { sectionId: "sec_bp1", field: "bundle" });
    eq(draft.severity, "incomplete", "null in a draft:");
    eq(VAL.issueClass(draft), "incomplete", "null class:");
    eq(one(validate(bundleDoc({ bundle: null }), { mode: "publish" }), "REQUIRED", { field: "bundle" }).severity, "error", "null at publish:");
    for (const bad of [{ id: "" }, { id: "has space" }, { id: 7 }, "bun-1", { id: "x".repeat(65) }]) eq(VAL.issueClass(find(validate(bundleDoc({ bundle: bad }), { mode: "draft" }), "INVALID_VALUE")[0]), "structure", `${JSON.stringify(bad).slice(0, 30)}:`);
    // the editor's control and the refs
    deq(
      R.controlsFor("zz_bundles").map((c) => [c.key, c.control, c.kind]),
      [
        ["bundle", "bundle", "bundle"],
        ["bundles", "bundle_list", "bundle_list"],
        ["few", "bundle_list", "bundle_list"],
      ],
    );
    deq(R.refsOf(sec("zz_bundles", "sec_bp1", { bundle: { id: "bun-a" }, bundles: [{ id: "bun-b" }, { id: "bnd_c" }] })), [
      { field: "bundle", ref: "bundle", id: "bun-a" },
      { field: "bundles.0", ref: "bundle", id: "bun-b" },
      { field: "bundles.1", ref: "bundle", id: "bnd_c" },
    ]);
  });
});

await t("P5-SETTING: a bundle list refuses the same bundle twice and more than its max (12 when none is declared), each with its plain message; an issue on its third bundle says 'bundle 3'", async () => {
  await withBundleProbe(async () => {
    const ids = (n) => Array.from({ length: n }, (_, j) => ({ id: `bun-${j}` }));
    none(validate(bundleDoc({ bundles: ids(12), few: ids(3) }), { mode: "publish" }), "12 and 3:");
    const dup = validate(bundleDoc({ bundles: [{ id: "bun-a" }, { id: "bun-b" }, { id: "bun-a" }] }), { mode: "publish" });
    const d = one(dup, "INVALID_VALUE", { sectionId: "sec_bp1", field: "bundles.2" });
    eq(d.message, "This bundle is already in the grid.", "duplicate words:");
    eq(VAL.issueClass(d), "invalid", "duplicate class (a draft keeps it, publish refuses it):");
    eq(d.severity, "error", "duplicate at publish:");
    eq(R.where(d, bundleDoc({})), "Bundle probe · Bundles to show · bundle 3", "where:");
    const over = one(validate(bundleDoc({ bundles: ids(13) }), { mode: "publish" }), "INVALID_VALUE", { field: "bundles" });
    eq(over.message, "A grid shows at most 12 bundles.", "over the default max:");
    eq(VAL.issueClass(over), "invalid", "over-max class:");
    eq(one(validate(bundleDoc({ few: ids(4) }), { mode: "publish" }), "INVALID_VALUE", { field: "few" }).message, "A grid shows at most 3 bundles.", "over a declared max:");
    for (const key of ["title", "price", "available"]) {
      const i = one(validate(bundleDoc({ bundles: [{ id: "bun-a", [key]: 1 }] }), { mode: "publish" }), "UNKNOWN_FIELD", { field: `bundles.0.${key}` });
      eq(VAL.issueClass(i), "structure", `${key}:`);
    }
    eq(VAL.issueClass(one(validate(bundleDoc({ bundles: "bun-a" }), { mode: "draft" }), "INVALID_VALUE", { field: "bundles" })), "structure", "not a list:");
    // worst cases: one bundle, and the grid at its max
    const wc = R.worstCase("zz_bundles");
    const max = wc.cases.find((c) => c.name === "max_items").section.settings;
    deq([max.bundle, max.bundles.length, max.few.length, new Set(max.bundles.map((b) => b.id)).size], [{ id: "bun-worst" }, 12, 3, 12], "max_items:");
    for (const c of wc.cases) none(validate(R.fixtureDocument("home", [c.section]), { mode: "publish" }), `worst case ${c.name}:`);
  });
});

// TREE-01: a version body never holds a price or stock value. Every setting
// kind whose value is (or holds) an object refuses those keys as a structure
// error, so nothing can be published that carries them. A new kind must be
// placed in one of the two tables below, or this test fails.
const PRICE_KEYS = ["price", "bundle_price", "compare_at_price", "inventory", "available", "sold_out", "soldOut"];
const OK_LINK = { type: "collection", handle: "mugs" };
// kind -> [a valid value, the path inside it where a key goes ("" is the value itself), extra declaration]
const OBJECT_KINDS = {
  link: [OK_LINK, ""],
  cta: [{ label: "Go", link: OK_LINK }, ""],
  image: [{ media: "/api/media/med_a", alt: "A jar" }, ""],
  collection: [{ handle: "mugs", id: "gid://shopify/Collection/1" }, ""],
  product: [{ handle: "tee", id: "gid://shopify/Product/1" }, ""],
  bundle: [{ id: "bun-0a1b" }, ""],
  brand: [{ accent: "#7c3aed", background: "#ffffff", foreground: "#0a0a0b" }, ""],
  theme: [{ kit: "pulse", version: 1 }, ""],
  pairs: [{ title: "Goes with", products: ["gid://shopify/Product/1"] }, ""],
  overlay: [{ value: "Mug", base_hash: null, base_value: null }, "", { of: "text" }],
  collection_list: [[{ handle: "mugs" }], "0"],
  product_list: [[{ handle: "tee" }], "0"],
  bundle_list: [[{ id: "bun-0a1b" }], "0"],
  qa_list: [[{ q: "Is it warm?", a: "<p>Yes.</p>" }], "0"],
  nav_items: [[{ label: "Shop", link: OK_LINK, children: [{ label: "Mugs", link: OK_LINK }] }], "0"],
  gallery: [[{ media: "https://cdn.shopify.com/a.jpg", alt: "A" }], "0"],
};
// values with no object to put a key in
const PLAIN_KINDS = ["text", "number", "boolean", "choice", "rich_text", "paragraphs", "product_ids"];
// P5-BLOCKS (after the P5-SETTING review): kinds that DO hold objects but are
// left out of the key check, each with its reason
const EXEMPT_KINDS = {
  // a list of objects, but only the system document journal_index holds it:
  // lib/documents/release-list.js generates it from the posts, and
  // service.js, publish.js and undo.js refuse to write it, so no editor or
  // founder path can put a price or stock key into it
  entries: "system type journal_index: generated, never written by an editor",
};

await t("TREE-01: for every object-valued setting kind (and every list kind's items), a price or stock key is UNKNOWN_FIELD of class structure in publish mode", async () => {
  deq(Object.keys(R.SETTING_KINDS).filter((k) => !Object.hasOwn(OBJECT_KINDS, k) && !PLAIN_KINDS.includes(k) && !Object.hasOwn(EXEMPT_KINDS, k)), [], "setting kinds placed in no table:");
  deq(Object.keys(EXEMPT_KINDS).filter((k) => Object.hasOwn(OBJECT_KINDS, k) || PLAIN_KINDS.includes(k)), [], "an exempt kind placed in another table too:");
  // the exemption is real and narrow: entries is only declared by the system journal index
  const holders = R.documentTypeNames().filter((t) => R.documentType(t).settings.some((x) => x.kind === "entries"));
  deq(holders, ["journal_index"], "document types holding entries:");
  ok(R.documentType("journal_index").system, "journal_index is a system type");
  for (const k of R.sectionKinds()) ok(!R.sectionType(k).settings.some((x) => x.kind === "entries"), `section kind ${k} holds entries`);
  const settings = Object.entries(OBJECT_KINDS).map(([kind, [, , extra]]) => ({ key: `v_${kind}`, kind, label: `Probe ${kind.replace(/_/g, " ")}`, default: null, ...(extra || {}) }));
  R.defineSection({ kind: "zz_tree", label: "Tree probe", documentTypes: ["home"], settings });
  try {
    const body = (over = {}) => home([sec("zz_tree", "sec_tree1", { ...Object.fromEntries(Object.entries(OBJECT_KINDS).map(([kind, [v]]) => [`v_${kind}`, v])), ...over })]);
    const base = validate(body(), { mode: "publish" });
    deq(base.issues.filter((i) => i.sectionId === "sec_tree1").map((i) => [i.code, i.field]), [], "the valid values:");
    let n = 0;
    for (const [kind, [value, at]] of Object.entries(OBJECT_KINDS)) {
      for (const key of PRICE_KEYS) {
        const v = structuredClone(value);
        const target = at === "" ? v : v[Number(at)];
        target[key] = key === "price" || key === "inventory" || key === "bundle_price" || key === "compare_at_price" ? 1999 : true;
        const field = `v_${kind}${at === "" ? "" : `.${at}`}.${key}`;
        const r = validate(body({ [`v_${kind}`]: v }), { mode: "publish" });
        const i = one(r, "UNKNOWN_FIELD", { sectionId: "sec_tree1", field });
        eq(VAL.issueClass(i), "structure", `${kind}.${key} class:`);
        eq(i.severity, "error", `${kind}.${key} severity:`);
        n++;
      }
    }
    eq(n, Object.keys(OBJECT_KINDS).length * PRICE_KEYS.length, "cases:");
  } finally {
    R.removeSection("zz_tree");
  }
});

// The codes lib/registry reports: every upper-case string literal in its files
// (labels taken out). A code here that no check in this suite produced is a
// message nobody has read.
async function registryCodes() {
  const out = new Map();
  for (const f of (await readdir(join(root, "lib/registry"))).filter((x) => x.endsWith(".js"))) {
    const src = (await readFile(join(root, "lib/registry", f), "utf8")).replace(/\blabel:\s*"[^"]*"/g, "").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/"([A-Z][A-Z0-9_]{2,})"/g)) out.set(m[1], f);
  }
  return out;
}
export function missingCodes(codesFound, corpus) {
  const seen = new Set(corpus.map((i) => i.code));
  return [...codesFound.keys()].filter((c) => !seen.has(c));
}

await t("coverage: every code lib/registry/*.js can report is in this suite's corpus of issues (and the scan bites)", async () => {
  const found = await registryCodes();
  ok(found.size >= 40, `codes found: ${found.size}`);
  for (const c of ["LINK_NOT_STOREFRONT", "HIGHLIGHT_NOT_IN_TITLE", "WORDS_LOST", "BRAND_HARD_TO_READ", "SLUG_INVALID", "TOO_MANY_BEFORE_PROTECTED"]) ok(found.has(c), `the scan sees ${c}`);
  ok(!found.has("FAQ"), "labels are not codes");
  deq(missingCodes(found, ALL), [], "codes no check here produced:");
  // a code added to the registry with no case here is caught
  deq(missingCodes(new Map([...found, ["NEW_CHECK_NOBODY_READ", "x.js"]]), ALL), ["NEW_CHECK_NOBODY_READ"], "the scan bites:");
});

// What a message may not say (AU-02): CTA, href, handle or slug, outside the
// founder's own words (quoted values are taken out first).
export const FORBIDDEN_WORDS = /\b(CTA|href|handle|slug)\b/i;
export const withoutQuoted = (m) => m.replace(/"[^"]*"/g, '""').replace(/“[^”]*”/g, "“”");
export const isSentence = (m) => /^["“A-Z0-9]/.test(m) && /[.!?]$/.test(m.trim()) && !/\s{2,}/.test(m);
export const POSITIONAL = /\b(?:section|position|row|block)\s+\d+\b|Section \d+ \(/i;

await t("AU-02: every message seen (worstCase, the crafted bad values, every rules() function) is a plain sentence: non-empty, no position, no CTA/href/handle/slug", async () => {
  for (const kind of R.sectionKinds()) for (const c of R.worstCase(kind).cases) for (const mode of ["draft", "publish"]) validate(R.fixtureDocument(R.sectionType(kind).documentTypes[0], [c.section]), { mode });
  const messages = new Map();
  for (const i of ALL) messages.set(i.message, i.code);
  ok(messages.size > 150, `distinct messages: ${messages.size}`);
  const bad = [];
  for (const [m, code] of messages) {
    if (typeof m !== "string" || !m.trim()) bad.push(`${code}: empty`);
    else if (!isSentence(m)) bad.push(`${code}: not a sentence: ${m}`);
    else if (POSITIONAL.test(withoutQuoted(m))) bad.push(`${code}: names a position: ${m}`);
    else if (FORBIDDEN_WORDS.test(withoutQuoted(m))) bad.push(`${code}: uses a code word: ${m}`);
    else if (/\bundefined\b|\bnull\b|\[object Object\]|NaN/.test(m)) bad.push(`${code}: leaks a value: ${m}`);
  }
  deq(bad, [], "messages that aren't plain:");
  // the checks bite
  ok(!isSentence("accent must be a 6-digit hex color (e.g. #84cc16)"), "no full stop");
  ok(FORBIDDEN_WORDS.test(withoutQuoted("The CTA has no href.")), "code words");
  ok(!FORBIDDEN_WORDS.test(withoutQuoted('The link goes to "/collections?handle=x", which is fine.')), "a founder's quoted value is theirs");
});

await t("every issue has the DOC-04 shape and no message matches /Section \\d+ \\(/", async () => {
  // a few more broken bodies, so every check's wording is seen
  validate(null, { mode: "draft" });
  validate(home("nope"), { mode: "draft" });
  validate(home([null, { id: "sec_x1", kind: "hero", v: 1, settings: "x", mobile: { title: "x" }, show: { tv: true }, bindings: { a: 1 }, blocks: [{}] }]), { mode: "publish" });
  validate(home([sec("faq", "sec_f1", { items: [{ q: "", a: "", z: 1 }] }), sec("image_with_text", "sec_i1", { image: { media: "http://x" } }), sec("new", "sec_n1", { limit: 99 })]), { mode: "publish" });
  validate({ schema: 1, type: "footer", meta: {}, settings: { mode: "auto", items: [{ label: "", children: [{ label: "x", link: { type: "url", href: "/" }, children: [] }] }], template: "x" } }, { mode: "publish" });
  ok(ALL.length > 100, `enough issues seen (${ALL.length})`);
  console.log(`    (${ALL.length} issues checked)`);
  for (const i of ALL) {
    deq(Object.keys(i), ISSUE_KEYS, i.code);
    ok(["error", "warning", "incomplete"].includes(i.severity), i.severity);
    ok(typeof i.message === "string" && i.message.length > 0, i.code);
    ok(!/Section \d+ \(/.test(i.message), `positional message: ${i.message}`);
    ok(!/\bundefined\b|\bnull\b|\[object Object\]/.test(i.message), `a message leaks a value: ${i.message}`);
  }
  for (const i of ALL.filter((i) => i.sectionId)) ok(/^sec_[a-z0-9]{2,16}$/.test(i.sectionId), i.sectionId);
});

await rm(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
