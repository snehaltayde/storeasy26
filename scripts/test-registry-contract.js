// P2-REG: the document registry contract (DOC-01..05, DOC-07).
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

await t("a 200-character title against max 80 gives TOO_LONG and is not truncated", async () => {
  const title = "T".repeat(200);
  for (const mode of ["draft", "publish"]) {
    const r = validate(home([sec("collections", "sec_c1", { title })]), { mode });
    const i = one(r, "TOO_LONG", { sectionId: "sec_c1", field: "title" });
    eq(i.severity, "error");
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

await t("a hero link to https://evil.example or /admin gives LINK_NOT_STOREFRONT; /collections/x passes", async () => {
  const withHref = (href, where = "primary") => home([sec("hero", "sec_hero1", { [where]: { label: "Go", link: { type: "url", href } } })]);
  for (const href of ["https://evil.example", "/admin", "//evil.example", "javascript:alert(1)", "/collections/../admin", "/collections/%2e%2e/admin", "/api/admin/releases", "mailto:a@b.c", "/products/"]) {
    for (const mode of ["draft", "publish"]) {
      const r = validate(withHref(href), { mode });
      const i = one(r, "LINK_NOT_STOREFRONT", { sectionId: "sec_hero1", field: "primary.link.href" });
      eq(i.severity, "error", href);
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
  // the same check reaches menus, announcement bars and banners
  const header = validate({ schema: 1, type: "header", meta: {}, settings: { mode: "custom", items: [{ label: "Admin", link: { type: "url", href: "/admin" } }], template: "standard" } }, { mode: "draft" });
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

await t("document types: singletons feed emptyList, design checks brand readability, product_content can't publish, unknown types are refused", async () => {
  const singles = R.singletonTypes();
  deq(singles, ["announcement", "header", "footer", "design", "home", "collections_index", "product_layout", "collection_layout", "cart"]);
  const list = emptyList(1, singles);
  for (const type of singles) eq(list.documents[`doc_${type}`], null, type);
  ok(!singles.includes("journal_index") && !singles.includes("page"), "routes and the journal index aren't singletons");
  eq(R.documentType("journal_index").editable, false);
  eq(R.documentType("product_content").publishable, false);
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
  one(validate(pc, { mode: "publish" }), "PUBLISH_NOT_AVAILABLE");

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
