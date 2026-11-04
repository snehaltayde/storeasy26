// P3-DIFF suite (PUB-09, PUB-04, PUB-03, TOK-03): lib/documents/diff.js, the
// plain words for what changed between two bodies of one document.
//   pnpm test:doc-diff
//
// Pure: no database, no server, no ports. Every test imports lib/documents/diff.js,
// which does not exist before cms/p3-diff, so each one fails without it.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const startedAt = Date.now();

const R = await import("../lib/registry/index.js");
const D = await import("../lib/documents/diff.js");
const { diffBodies, firstPublishRows, DIFF_KINDS } = D;

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
const ok = (v, msg) => {
  if (!v) throw new Error(msg || "expected true");
};
const eq = (a, b, msg = "") => {
  try {
    deepStrictEqual(a, b);
  } catch {
    throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const words = (rows) => rows.map((r) => r.words);

const sec = (kind, id, settings = {}, extra = {}) => ({ ...R.newSection(kind, { id }), ...extra, settings: { ...R.newSection(kind).settings, ...settings } });
const home = (sections) => ({ ...R.emptyBody("home"), sections });
const page = (sections, meta = {}) => {
  const b = R.emptyBody("page");
  Object.assign(b.meta, { slug: "about-us", title: "About us" }, meta);
  b.sections = sections;
  return b;
};

// ---- acceptance 1: the hero title plus a new banner ------------------------------------

await t("a home draft with an edited hero title and a new banner gives exactly 'Hero: title changed' and 'Banner: added'", async () => {
  const live = home([sec("hero", "sec_hero", { title: "Welcome to our store" }), sec("collections", "sec_coll")]);
  const draft = clone(live);
  draft.sections[0].settings.title = "Fresh stock every week";
  draft.sections.splice(1, 0, R.newSection("banner", { id: "sec_newban" }));
  const rows = diffBodies("home", live, draft);
  eq(words(rows), ["Hero: title changed", "Banner: added"], "rows:");
  eq(rows, [
    { kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" },
    { kind: "added", sectionId: "sec_newban", words: "Banner: added" },
  ]);
});

// ---- acceptance 2: ids alone and equal hashes give nothing ----------------------------

await t("bodies that differ only by section ids give [], including ids stamped on sections that had none", async () => {
  const live = home([sec("hero", "sec_aaaa"), sec("banner", "sec_bbbb", { title: "Sale" }), sec("text", "sec_cccc", { body: ["One", "Two"] })]);
  const restamped = clone(live);
  restamped.sections.forEach((s, i) => (s.id = `sec_new${i}`));
  ok((await R.documentHash(live)) === (await R.documentHash(restamped)), "the hashes are equal");
  eq(diffBodies("home", live, restamped), [], "new ids:");
  // a migrated body whose sections never had an id, against the lazily stamped draft
  const unstamped = clone(live);
  for (const s of unstamped.sections) delete s.id;
  eq(diffBodies("home", unstamped, R.ensureIds(unstamped)), [], "lazily stamped:");
  eq(diffBodies("home", unstamped, live), [], "stamped the other way:");
  // two banners with swapped ids but the same content in the same places
  const twins = home([sec("banner", "sec_b1", { title: "A" }), sec("banner", "sec_b2", { title: "B" })]);
  const swapped = clone(twins);
  [swapped.sections[0].id, swapped.sections[1].id] = ["sec_b9", "sec_b8"];
  eq(diffBodies("home", twins, swapped), [], "renamed twins:");
});

await t("equal documentHash gives [] for every registered type, and a change elsewhere does not bring id-only sections in", async () => {
  for (const type of R.documentTypeNames()) {
    const body = R.emptyBody(type);
    eq(diffBodies(type, body, clone(body)), [], `${type}:`);
  }
  const live = page([sec("text", "sec_t1", { title: "Hello" })]);
  const draft = clone(live);
  draft.sections[0].id = "sec_t2";
  draft.meta.title = "About the team";
  eq(diffBodies("page", live, draft), [{ kind: "meta", words: "Page title changed" }]);
});

await t("an id-less migrated section that was also edited reads as an edit, not removed plus added", async () => {
  const live = home([sec("hero", "sec_hero"), sec("text", undefined, { title: "Story" })]);
  delete live.sections[1].id;
  const draft = R.ensureIds(clone(live));
  draft.sections[1].settings.title = "Our story";
  const rows = diffBodies("home", live, draft);
  eq(words(rows), ["Text: title changed"]);
  eq(rows[0].sectionId, draft.sections[1].id);
});

// ---- acceptance 3: one plain row for each kind of change ------------------------------

const base = () =>
  page(
    [sec("banner", "sec_ban1", { title: "Sale", button: { label: "Shop", link: { type: "url", href: "/collections" } } }), sec("text", "sec_txt1", { title: "Story", body: ["One", "Two", "Three"] }), sec("faq", "sec_faq1", { items: [{ q: "Ship?", a: "<p>Yes</p>" }] })],
    { redirect_from: ["old-about"] },
  );

const one = (label, change, expected) =>
  t(`${label} gives one plain row: ${JSON.stringify(expected.words)}`, async () => {
    const from = base();
    const to = clone(from);
    change(to);
    eq(diffBodies("page", from, to), [expected]);
  });

await one("a moved section", (b) => b.sections.push(b.sections.shift()), { kind: "moved", sectionId: "sec_ban1", words: "Banner: moved down" });
await one("two sections swapped", (b) => ([b.sections[0], b.sections[1]] = [b.sections[1], b.sections[0]]), { kind: "moved", sectionId: "sec_ban1", words: "Banner: moved down" });
await one("a hidden section", (b) => (b.sections[1].enabled = false), { kind: "hidden", sectionId: "sec_txt1", words: "Text: hidden" });
await one("a removed section", (b) => b.sections.splice(2, 1), { kind: "removed", sectionId: "sec_faq1", words: "FAQ: removed" });
await one("a new web address", (b) => (b.meta.slug = "our-team"), { kind: "meta", words: "Web address changed" });
await one("a new page title", (b) => (b.meta.title = "Our team"), { kind: "meta", words: "Page title changed" });
await one("a showing window", (b) => (b.meta.window_start = "2026-12-01T00:00:00.000Z"), { kind: "meta", words: "Showing dates: start date added" });
await one("both ends of a window", (b) => Object.assign(b.meta, { window_start: "2026-12-01T00:00:00.000Z", window_end: "2026-12-31T00:00:00.000Z" }), { kind: "meta", words: "Showing dates: start date and end date added" });
await one("a new redirect", (b) => b.meta.redirect_from.push("team"), { kind: "meta", words: "Old addresses that lead here: an old address added" });
await one("a removed redirect", (b) => (b.meta.redirect_from = []), { kind: "meta", words: "Old addresses that lead here: an old address removed" });
await one("a page switched off", (b) => (b.meta.enabled = false), { kind: "meta", words: "Page switched off, so shoppers won't see it" });
await one("a new search description", (b) => (b.meta.description = "Who we are"), { kind: "meta", words: "Search description added" });
await one("a banner button's text", (b) => (b.sections[0].settings.button.label = "Shop now"), { kind: "edited", sectionId: "sec_ban1", words: "Banner: button text changed" });
await one("a banner button's link", (b) => (b.sections[0].settings.button.link = { type: "collection", handle: "summer" }), { kind: "edited", sectionId: "sec_ban1", words: "Banner: button link changed" });
await one("a text paragraph", (b) => (b.sections[1].settings.body[1] = "Changed"), { kind: "edited", sectionId: "sec_txt1", words: "Text: a paragraph changed" });
await one("two new paragraphs", (b) => b.sections[1].settings.body.push("Four", "Five"), { kind: "edited", sectionId: "sec_txt1", words: "Text: 2 paragraphs added" });
await one("reordered paragraphs", (b) => b.sections[1].settings.body.reverse(), { kind: "edited", sectionId: "sec_txt1", words: "Text: paragraphs reordered" });
await one("an FAQ question", (b) => (b.sections[2].settings.items[0].q = "Do you ship?"), { kind: "edited", sectionId: "sec_faq1", words: "FAQ: a question changed" });
await one("an FAQ answer", (b) => (b.sections[2].settings.items[0].a = "<p>Yes, all over India</p>"), { kind: "edited", sectionId: "sec_faq1", words: "FAQ: an answer changed" });
await one("a new FAQ question", (b) => b.sections[2].settings.items.push({ q: "Returns?", a: "<p>30 days</p>" }), { kind: "edited", sectionId: "sec_faq1", words: "FAQ: a question added" });
await one("two fields of one section", (b) => Object.assign(b.sections[0].settings, { title: "Big sale", text: "Ends Sunday" }), { kind: "edited", sectionId: "sec_ban1", words: "Banner: title changed, text added" });
await one("a section hidden on phones", (b) => (b.sections[1].show = { mobile: false }), { kind: "edited", sectionId: "sec_txt1", words: "Text: now hidden on phones" });

await t("a shown section gives one plain row", async () => {
  const from = base();
  from.sections[1].enabled = false;
  const to = clone(from);
  to.sections[1].enabled = true;
  eq(diffBodies("page", from, to), [{ kind: "shown", sectionId: "sec_txt1", words: "Text: shown" }]);
});

await t("a document setting change gives one plain row named by the type's setting labels", async () => {
  const a = R.emptyBody("announcement");
  const b = clone(a);
  b.settings.text = "Free shipping over ₹999";
  eq(diffBodies("announcement", a, b), [{ kind: "settings", words: "Announcement bar: text added" }]);
  const c = clone(b);
  c.settings.enabled = true;
  eq(diffBodies("announcement", b, c), [{ kind: "settings", words: "Announcement bar: switched on" }]);
  const h = R.emptyBody("header");
  const h2 = clone(h);
  Object.assign(h2.settings, { mode: "custom", items: [{ label: "Shop", link: { type: "url", href: "/collections" } }] });
  eq(diffBodies("header", h, h2), [
    { kind: "settings", words: "Header menu: menu changed" },
    { kind: "settings", words: "Header menu: a menu item added" },
  ]);
  const ci = R.emptyBody("collections_index");
  const ci2 = clone(ci);
  ci2.settings.featured = [{ handle: "summer" }, { handle: "winter" }];
  eq(diffBodies("collections_index", ci, ci2), [{ kind: "settings", words: "Collections page: 2 collections added to featured collections" }]);
  const pl = R.emptyBody("product_layout");
  const pl2 = clone(pl);
  pl2.settings.template = "editorial";
  eq(diffBodies("product_layout", pl, pl2), [{ kind: "settings", words: "Product page layout: layout changed" }]);
});

await t("two sections of one kind are told apart by their place", async () => {
  const from = home([sec("banner", "sec_b1", { title: "A" }), sec("banner", "sec_b2", { title: "B" })]);
  const to = clone(from);
  to.sections[1].settings.title = "C";
  eq(words(diffBodies("home", from, to)), ["Banner 2: title changed"]);
});

// ---- acceptance 4: the worst-case corpus never says slug, handle, CTA, href, an id or a hash ----

const BANNED = /\b(slug|handle|CTA|href)\b/i;
const ID_LIKE = /\b(?:sec|blk|doc|ver|med|rel|log|set)_[a-z0-9]+|gid:\/\/|\/api\/media\//i;
const HASH = /[0-9a-f]{40,}/i;
// values chosen to tempt a leak: an address and handles made of the banned words
const TEMPT = "slug-handle-cta-href";
const SETTING_VALUES = {
  text: ["", `Text with ${TEMPT}`],
  number: [1, 2],
  boolean: [false, true],
  rich_text: ["", `<p>${TEMPT}</p>`],
  link: [null, { type: "collection", handle: TEMPT }],
  cta: [null, { label: "CTA", link: { type: "url", href: "/collections" } }],
  image: [null, { media: "/api/media/med_abc", alt: TEMPT }],
  collection: [null, { handle: TEMPT, id: "gid://shopify/Collection/1" }],
  product: [null, { handle: TEMPT, id: "gid://shopify/Product/1" }],
  collection_list: [[], [{ handle: TEMPT }]],
  product_list: [[], [{ handle: TEMPT }]],
  nav_items: [[], [{ label: "CTA", link: { type: "url", href: "/cart" } }]],
  paragraphs: [[], [TEMPT]],
  qa_list: [[], [{ q: TEMPT, a: "<p>CTA</p>" }]],
  brand: [null, { accent: "#123456", background: "#fefefe", foreground: "#111111", radius: "lg", type_scale: "large", button_shape: "square", section_spacing: "airy" }],
  theme: [null, { kit: "glow", version: 1, applied_at: "2026-11-01T00:00:00.000Z" }],
  entries: [[], [{ id: "doc_0123456789abcdef", slug: TEMPT }]],
};

function corpus() {
  const out = [];
  for (const type of R.documentTypeNames()) {
    const td = R.documentType(type);
    const blank = R.emptyBody(type);
    // document settings, each from empty to set and back
    for (const s of td.settings) {
      const [a, b] = SETTING_VALUES[s.kind] ?? [null, "x"];
      const from = clone(blank);
      const to = clone(blank);
      if (s.kind === "choice") [from.settings[s.key], to.settings[s.key]] = [s.options[0], s.options[s.options.length - 1]];
      else [from.settings[s.key], to.settings[s.key]] = [clone(a), clone(b)];
      out.push([`${type}.${s.key}`, type, from, to], [`${type}.${s.key} back`, type, to, from]);
    }
    // meta, with tempting values
    if (td.route) {
      const from = R.fixtureDocument(type, []);
      const to = clone(from);
      Object.assign(to.meta, { slug: TEMPT, title: `Title ${TEMPT}`, description: TEMPT, enabled: false, effective_at: "2026-12-01", window_start: "2026-12-01T00:00:00.000Z", window_end: "2026-12-31T00:00:00.000Z", redirect_from: [TEMPT] });
      out.push([`${type} meta`, type, from, to], [`${type} meta back`, type, to, from]);
    }
    if (!td.sections) continue;
    for (const kind of R.allowedKinds(type)) {
      const cases = R.worstCase(kind).cases;
      for (const c of cases) {
        const fresh = R.newSection(kind, { id: c.section.id });
        const withIt = R.fixtureDocument(type, [clone(c.section)]);
        const plain = R.fixtureDocument(type, [fresh]);
        out.push([`${type}/${kind}/${c.name} edited`, type, plain, withIt], [`${type}/${kind}/${c.name} reverted`, type, withIt, plain]);
        if (!R.sectionType(kind).protected) {
          out.push([`${type}/${kind}/${c.name} added`, type, R.fixtureDocument(type, []), withIt], [`${type}/${kind}/${c.name} removed`, type, withIt, R.fixtureDocument(type, [])]);
          const hidden = clone(withIt);
          hidden.sections.find((s) => s.id === c.section.id).enabled = false;
          out.push([`${type}/${kind}/${c.name} hidden`, type, withIt, hidden], [`${type}/${kind}/${c.name} shown`, type, hidden, withIt]);
        }
      }
      // every pair of cases of one kind, to reach every nested field
      for (const x of cases) for (const y of cases) if (x !== y) out.push([`${type}/${kind} ${x.name} to ${y.name}`, type, R.fixtureDocument(type, [clone(x.section)]), R.fixtureDocument(type, [{ ...clone(y.section), id: x.section.id }])]);
    }
    // all kinds at once, then reordered
    const all = R.allowedKinds(type).map((k) => clone(R.worstCase(k).cases[0].section));
    const full = R.fixtureDocument(type, all);
    const turned = clone(full);
    turned.sections.reverse();
    out.push([`${type} every kind added`, type, R.fixtureDocument(type, []), full], [`${type} reversed`, type, full, turned]);
  }
  return out;
}

await t("for a corpus of every registered type and section kind (worstCase fixtures), no row says slug, handle, CTA or href, an id or a hash", async () => {
  const list = corpus();
  ok(list.length > 300, `a real corpus (${list.length})`);
  let rows = 0;
  const seenKinds = new Set();
  let equal = 0;
  for (const [name, type, from, to] of list) {
    const out = diffBodies(type, from, to);
    // two worst cases of a kind with no image or list are the same section
    if ((await R.documentHash(from)) === (await R.documentHash(to))) {
      equal++;
      eq(out, [], `${name}: equal bodies:`);
      continue;
    }
    ok(out.length > 0, `${name}: bodies that differ gave no row`);
    for (const r of out) {
      rows++;
      seenKinds.add(r.kind);
      ok(DIFF_KINDS.includes(r.kind), `${name}: kind ${r.kind}`);
      ok(typeof r.words === "string" && r.words.trim() && !r.words.includes("undefined") && !r.words.includes("null"), `${name}: words ${JSON.stringify(r.words)}`);
      ok(!BANNED.test(r.words), `${name}: ${JSON.stringify(r.words)} says a banned word`);
      ok(!ID_LIKE.test(r.words), `${name}: ${JSON.stringify(r.words)} holds an id`);
      ok(!HASH.test(r.words), `${name}: ${JSON.stringify(r.words)} holds a hash`);
      ok(!r.words.includes(TEMPT), `${name}: ${JSON.stringify(r.words)} quotes founder text`);
      ok(r.sectionId === undefined || R.SECTION_ID_RE.test(r.sectionId), `${name}: sectionId ${r.sectionId}`);
      eq(Object.keys(r).filter((k) => !["kind", "sectionId", "words"].includes(k)), [], `${name}: extra keys`);
    }
    for (const r of firstPublishRows(type, to)) {
      ok(typeof r.words === "string" && r.words.trim(), `${name}: first publish words`);
      ok(!ID_LIKE.test(r.words) && !HASH.test(r.words), `${name}: first publish ${JSON.stringify(r.words)}`);
      // the only founder text a row quotes is the page title
      if (!r.words.includes(" title: ")) ok(!BANNED.test(r.words), `${name}: first publish ${JSON.stringify(r.words)}`);
    }
  }
  eq([...seenKinds].sort(), [...DIFF_KINDS].sort(), "every kind of row appears:");
  ok(equal < list.length / 10, `few equal pairs (${equal})`);
  console.log(`    ${list.length} body pairs (${equal} equal), ${rows} rows`);
});

// ---- acceptance 5: design tokens and first publish -----------------------------------

await t("a doc_design token change gives one 'Colours' or 'Fonts' row", async () => {
  const live = R.emptyBody("design");
  live.settings.brand = { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "regular", button_shape: "pill", section_spacing: "regular" };
  const accent = clone(live);
  accent.settings.brand.accent = "#e11d48";
  eq(diffBodies("design", live, accent), [{ kind: "settings", words: "Colours: accent changed" }]);
  const font = clone(live);
  font.settings.brand.type_scale = "large";
  eq(diffBodies("design", live, font), [{ kind: "settings", words: "Fonts: text size changed" }]);
  const two = clone(accent);
  two.settings.brand.background = "#fafafa";
  eq(diffBodies("design", live, two), [{ kind: "settings", words: "Colours: accent and background changed" }], "two colours, one row:");
  // an unset brand renders as the platform default, so setting the default is not a colour change
  const unset = R.emptyBody("design");
  eq(diffBodies("design", unset, accent), [{ kind: "settings", words: "Colours: accent changed" }], "from no brand:");
  // accent_label is worked out from the accent; storing it is not a colour change
  const derived = clone(live);
  derived.settings.brand.accent_label = "#0a0a0b";
  ok(!words(diffBodies("design", live, derived)).some((w) => w.startsWith("Colours")), "a stored accent_label alone:");
  const label = clone(derived);
  label.settings.brand.accent_label = "#ffffff";
  eq(diffBodies("design", derived, label), [{ kind: "settings", words: "Colours: text on accent changed" }]);
  const look = clone(live);
  look.settings.theme = { kit: "glow", version: 1 };
  eq(diffBodies("design", live, look), [{ kind: "settings", words: "Look: chosen" }]);
});

await t("firstPublishRows lists the title and the visible sections only", async () => {
  const body = home([sec("hero", "sec_hero"), sec("banner", "sec_ban", { title: "Sale" }, { enabled: false }), sec("text", "sec_txt", { title: "Hi" }), sec("text", "sec_tx2", { title: "Bye" })]);
  eq(firstPublishRows("home", body), [{ words: "Hero" }, { words: "Text 1" }, { words: "Text 2" }]);
  const p = page([sec("faq", "sec_faq", { items: [{ q: "Q", a: "<p>A</p>" }] }), sec("text", "sec_t", { title: "x" }, { enabled: false })], { title: "Shipping and returns" });
  eq(firstPublishRows("page", p), [{ words: 'Page title: "Shipping and returns"' }, { words: "FAQ" }]);
  eq(firstPublishRows("announcement", R.emptyBody("announcement")), [{ words: "Announcement bar" }]);
  const long = page([], { title: "x".repeat(120) });
  ok(firstPublishRows("page", long)[0].words.length < 90, "a long title is cut");
});

// ---- P3-FIX1: the batch 1 review findings ---------------------------------------------

await t("P3-FIX1: a removed id-less section is named as removed, not the one that was edited (pass 3 skips a kind whose unmatched counts differ)", async () => {
  // live [Text A, Text B], no ids; the draft removes A and edits B, which gains an id
  const live = home([sec("text", undefined, { title: "A" }), sec("text", undefined, { title: "B" })]);
  for (const s of live.sections) delete s.id;
  const draft = home([{ ...clone(live.sections[1]), id: "sec_bbbb", settings: { ...live.sections[1].settings, title: "B two" } }]);
  const rows = diffBodies("home", live, draft);
  eq(rows, [
    { kind: "added", sectionId: "sec_bbbb", words: "Text: added" },
    { kind: "removed", words: "Text 1: removed" },
    { kind: "removed", words: "Text 2: removed" },
  ]);
  ok(!rows.some((r) => r.kind === "edited"), "A is never compared against B as an edit");
  // equal counts still pair: one id-less section against one stamped and edited
  const one = home([sec("text", undefined, { title: "A" })]);
  delete one.sections[0].id;
  eq(diffBodies("home", one, home([{ ...clone(one.sections[0]), id: "sec_aaaa", settings: { ...one.sections[0].settings, title: "A two" } }])), [{ kind: "edited", sectionId: "sec_aaaa", words: "Text: title changed" }]);
});

// sec_a and sec_b (the review's names) are one character short of SECTION_ID_RE,
// so they count as no id; sec_aa and sec_bb are the smallest valid ids.
await t("P3-FIX1: [Banner sec_aa 'one'] to [Banner sec_bb 'two'] gives 'Banner: added' plus 'Banner: removed' (pass 3 needs an id-less side)", async () => {
  const rows = diffBodies("home", home([sec("banner", "sec_aa", { title: "one" })]), home([sec("banner", "sec_bb", { title: "two" })]));
  eq(rows, [
    { kind: "added", sectionId: "sec_bb", words: "Banner: added" },
    { kind: "removed", sectionId: "sec_aa", words: "Banner: removed" },
  ]);
  // pass 1 pairs by id only when the kind is the same
  eq(diffBodies("home", home([sec("banner", "sec_same", { title: "one" })]), home([sec("text", "sec_same", { title: "one" })])), [
    { kind: "added", sectionId: "sec_same", words: "Text: added" },
    { kind: "removed", sectionId: "sec_same", words: "Banner: removed" },
  ]);
});

await t("P3-FIX1: a changed body never gives [] (the 'some details changed' row, pinned)", async () => {
  const live = home([sec("hero", "sec_hero")]);
  const draft = { ...clone(live), later_field: { a: 1 } };
  eq(diffBodies("home", live, draft), [{ kind: "settings", words: "Home page: some details changed" }]);
  eq(diffBodies("home", draft, live), [{ kind: "settings", words: "Home page: some details changed" }]);
});

await t("P3-FIX1: the other review survivors are pinned: an image description, the bound products, extra section settings, 'Look: applied again'", async () => {
  const withImage = home([sec("hero", "sec_hero", { image: { media: "/api/media/med_one", alt: "A runner" } })]);
  const alt = clone(withImage);
  alt.sections[0].settings.image.alt = "A runner at dawn";
  eq(diffBodies("home", withImage, alt), [{ kind: "edited", sectionId: "sec_hero", words: "Hero: image description changed" }]);
  const bound = home([sec("collections", "sec_coll", {}, { bindings: { collection: "summer" } })]);
  const rebound = clone(bound);
  rebound.sections[0].bindings = { collection: "winter" };
  eq(diffBodies("home", bound, rebound), [{ kind: "edited", sectionId: "sec_coll", words: "Collections grid: the products or collections it shows changed" }]);
  const extra = clone(bound);
  extra.sections[0].settings.later_setting = 1;
  eq(diffBodies("home", bound, extra), [{ kind: "edited", sectionId: "sec_coll", words: "Collections grid: other settings changed" }]);
  const look = R.emptyBody("design");
  look.settings.theme = { kit: "glow", version: 1, applied_at: "2026-11-01T00:00:00.000Z" };
  const again = clone(look);
  again.settings.theme.applied_at = "2026-11-02T00:00:00.000Z";
  eq(diffBodies("design", look, again), [{ kind: "settings", words: "Look: applied again" }]);
  const other = clone(look);
  other.settings.theme.kit = "pulse";
  eq(diffBodies("design", look, other), [{ kind: "settings", words: "Look: a different look chosen" }]);
});

await t("P3-FIX1: a null or empty side gives no false meta or 'reordered' rows", async () => {
  const empty = R.emptyBody("page");
  for (const [from, to] of [[null, empty], [empty, null], [undefined, empty], [empty, {}]]) {
    const rows = diffBodies("page", from, to);
    ok(!rows.some((r) => r.kind === "meta" || /reordered/.test(r.words)), `${JSON.stringify(from)} to ${JSON.stringify(to)}: ${JSON.stringify(rows)}`);
  }
  eq(diffBodies("page", null, empty), [], "null against an empty page:");
  eq(diffBodies("page", empty, null), [], "an empty page against null:");
  // a first publish (null to a real page) and taking it offline (a real page to null)
  const real = page([sec("text", "sec_t1", { title: "Hello" })], { title: "About us" });
  eq(diffBodies("page", null, real), [
    { kind: "meta", words: "Web address added" },
    { kind: "meta", words: "Page title added" },
    { kind: "added", sectionId: "sec_t1", words: "Text: added" },
  ]);
  eq(diffBodies("page", real, null), [
    { kind: "meta", words: "Web address removed" },
    { kind: "meta", words: "Page title removed" },
    { kind: "removed", sectionId: "sec_t1", words: "Text: removed" },
  ]);
  // a sparse meta (missing keys) against blank ones: no meta row
  const sparse = clone(real);
  sparse.meta = { slug: "about-us", title: "About us" };
  ok(!diffBodies("page", sparse, real).some((r) => r.kind === "meta"), "sparse meta");
  // redirects: missing is empty, a doubled address collapsing is a removal, reordered only for the same items
  const r = (list) => ({ ...clone(real), meta: { ...real.meta, redirect_from: list } });
  const noRedirects = clone(real);
  delete noRedirects.meta.redirect_from;
  ok(!diffBodies("page", noRedirects, r([])).some((x) => x.kind === "meta"), "missing against []");
  eq(diffBodies("page", r(["old", "old"]), r(["old"])), [{ kind: "meta", words: "Old addresses that lead here: an old address removed" }]);
  eq(diffBodies("page", r(["a", "b"]), r(["b", "a"])), [{ kind: "meta", words: "Old addresses that lead here: reordered" }]);
});

await t("P3-FIX1: a section hidden on both phones and computers reads as hidden, in firstPublishRows and as one diffBodies row", async () => {
  const live = home([sec("hero", "sec_hero"), sec("text", "sec_txt", { title: "Hi" })]);
  const both = clone(live);
  both.sections[1].show = { mobile: false, desktop: false };
  eq(firstPublishRows("home", both), [{ words: "Hero" }]);
  eq(diffBodies("home", live, both), [{ kind: "hidden", sectionId: "sec_txt", words: "Text: hidden" }]);
  // shown again on computers only: one shown row, and the phones it still hides from
  const computers = clone(both);
  computers.sections[1].show = { mobile: false, desktop: true };
  eq(diffBodies("home", both, computers), [
    { kind: "shown", sectionId: "sec_txt", words: "Text: shown" },
    { kind: "edited", sectionId: "sec_txt", words: "Text: still hidden on phones" },
  ]);
  // one screen only is not hidden
  eq(diffBodies("home", live, computers), [{ kind: "edited", sectionId: "sec_txt", words: "Text: now hidden on phones" }]);
});

await t("P3-FIX1: reversing three sections names only the two that moved; the middle one stayed", async () => {
  const live = home([sec("text", "sec_aaaa", { title: "A" }), sec("text", "sec_bbbb", { title: "B" }), sec("text", "sec_cccc", { title: "C" })]);
  const turned = clone(live);
  turned.sections.reverse();
  eq(diffBodies("home", live, turned), [
    { kind: "moved", sectionId: "sec_cccc", words: "Text 1: moved up" },
    { kind: "moved", sectionId: "sec_aaaa", words: "Text 3: moved down" },
  ]);
  ok(diffBodies("home", live, turned).every((r) => !/: moved$/.test(r.words)), "never a 'moved' row with no direction");
});

await t("P3-FIX1: a stored accent_label the founder did not set (equal to the one worked out from the accent) gives no row", async () => {
  const live = R.emptyBody("design");
  live.settings.brand = { accent: "#84cc16", background: "#ffffff", foreground: "#0a0a0b", radius: "md", type_scale: "regular", button_shape: "pill", section_spacing: "regular" };
  const { validateBrand } = await import("../lib/brand.js");
  const stamped = clone(live);
  stamped.settings.brand.accent_label = validateBrand(live.settings.brand).value.accent_label;
  eq(diffBodies("design", live, stamped), []);
  eq(diffBodies("design", stamped, live), []);
  // a stored label that differs from the worked-out one does render differently
  const other = clone(live);
  other.settings.brand.accent_label = stamped.settings.brand.accent_label === "#ffffff" ? "#0a0a0b" : "#ffffff";
  eq(diffBodies("design", live, other), [{ kind: "settings", words: "Colours: text on accent changed" }]);
  // an accent change that moves the worked-out label is the accent row alone
  const dark = clone(live);
  dark.settings.brand.accent = "#1e3a8a";
  ok(validateBrand(dark.settings.brand).value.accent_label !== validateBrand(live.settings.brand).value.accent_label, "the worked-out label moves");
  eq(diffBodies("design", live, dark), [{ kind: "settings", words: "Colours: accent changed" }]);
});

// ---- acceptance 6: edge-safe ---------------------------------------------------------

await t("lib/documents/diff.js imports no node: API, directly or through what it imports (edge guard list)", async () => {
  const BUILTINS = /^(?:node:|fs$|path$|os$|crypto$|child_process$|url$|util$|stream$|buffer$|http$|https$|net$|zlib$|events$)/;
  const FORBIDDEN = /^(?:react(?:-dom)?(?:\/|$)|next(?:\/|$))/;
  const start = join(root, "lib/documents/diff.js");
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = await readFile(file, "utf8");
    // comments out, then every import form wherever it sits on a line
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const specs = [
      ...code.matchAll(/(?:^|;)\s*(?:import|export)\s[^;()=]*?\bfrom\s*["']([^"']+)["']/gm),
      ...code.matchAll(/(?:^|;)\s*import\s*["']([^"']+)["']/gm),
      ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specs) {
      ok(!FORBIDDEN.test(spec) && !BUILTINS.test(spec), `${file.slice(root.length + 1)} imports ${spec}`);
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else throw new Error(`${file.slice(root.length + 1)} imports a package (${spec})`);
    }
    ok(!/\brequire\(|\bprocess\.|\bBuffer\b|__dirname/.test(src.replace(/\/\/.*$/gm, "")), `${file.slice(root.length + 1)} uses a Node-only global`);
  }
  ok(seen.size > 3 && [...seen].some((f) => f.endsWith("lib/registry/index.js")), "the walk follows the imports");
  const own = await readFile(start, "utf8");
  ok(!/\bawait\b|\bdb\b|libsql|kysely/i.test(own.replace(/\/\/.*$/gm, "")), "no database and nothing async");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
