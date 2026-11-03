// Page editor save path suite (AU-05). The founder's form goes through the
// SAME conversions the editor uses (components/admin/cms/pageSections.js), the
// real handler behind /api/admin/storefront, real requireAdmin and real
// storage, then is read back the way the editor route and the storefront read
// it. Proves that no save reports success while dropping founder content. The
// two components run too, compiled with Next's own SWC (plain node has no JSX):
// ContentPage renders to markup, PageEditor runs on small stand-in hooks.
//   pnpm test:page-editor
import { readFile, rm, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-pageeditor-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pageeditor-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-pageeditor-default.db", ".test-pageeditor-platform.db", ".test-pageeditor-tenant.db", ".test-pageeditor-readonly.db"];
for (const f of dbs) {
  await chmod(join(here, "..", f), 0o644).catch(() => {});
  await rm(join(here, "..", f), { force: true });
}

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const Sess = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { handleStorefrontPut } = await import("../lib/admin/cms-api.js");
const pageStore = await import("../lib/cms/store.js");
const { getContentPage, validatePageSections } = pageStore;
const { sanitizeHtml } = await import("../lib/sanitize.js");
const { normalizePageSections } = await import("../lib/cms/schemas.js");
const { componentFor } = await import("../lib/cms/registry.js");
const R = await import("../lib/releases.js");
const pageSections = await import("../components/admin/cms/pageSections.js");
const { toEdit, formSections, sectionsPayload, editEmpty, blankSection, newSectionId, pageIssueText } = pageSections;
const { ISSUE_KEYS } = await import("../lib/cms/issues.js");
const { PAGE_TEMPLATES } = await import("../lib/content/templates.js");
const { PAGES } = await import("../lib/content/pages.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

// --- fixtures ----------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await C.upsertTenant({ id: "zp", name: "Page editor", domains: ["zp.test"], dbUrl: "file:.test-pageeditor-tenant.db", config: {}, secrets: {} });
const ZP = await C.getTenant("zp");
const tdb = createClient({ url: "file:.test-pageeditor-tenant.db" });
await tdb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
await runMigrations(tdb, await loadMigrations("tenant"));

// DOC-04: a second store whose database has gone read-only, to see what the
// editor shows when the failure is ours and not the founder's.
const rodb = createClient({ url: "file:.test-pageeditor-readonly.db" });
await rodb.executeMultiple(await readFile(join(here, "../lib/schema.sql"), "utf8"));
await runMigrations(rodb, await loadMigrations("tenant"));
rodb.close();
await chmod(join(here, "..", ".test-pageeditor-readonly.db"), 0o444);
await C.upsertTenant({ id: "zpro", name: "Read-only store", domains: ["zpro.test"], dbUrl: "file:.test-pageeditor-readonly.db", config: {}, secrets: {} });
const ZPRO = await C.getTenant("zpro");

const staffU = await I.createUser({ email: "staff@zp.test", password: "staff-pass-au05" });
await I.addMembership(staffU.id, "zp", "staff");
await I.addMembership(staffU.id, "zpro", "staff");
const tok = (await Sess.createSession({ userId: staffU.id, kind: "merchant", ttlMs: 60_000 })).token;

let ACTIVE = ZP; // which store the requests go to
const req = (body) => ({
  cookies: { get: (name) => (name === "_admin" ? { value: tok } : undefined) },
  headers: { get: (k) => ({ host: `${ACTIVE.id}.test` })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const inT = (fn) => withTenant(ACTIVE, fn);
const put = (body) => inT(() => handleStorefrontPut(req(body)));

// The form the editor holds → exactly what its Save sends. DOC-04: like the
// editor, every row carries its durable id (`pid`) from the moment it exists.
const form = (...sections) => sections.map((s, i) => ({ id: `s${i}`, pid: newSectionId(), ...s }));
const save = async (slug, sections, revision = null) => {
  const res = await put({ page: { slug, title: `Page ${slug}`, sections: sectionsPayload(sections) }, revision });
  res.sent = sections; // the form, so the test can word the refusal as the editor does
  return res;
};
const row = (slug) => inT(() => db.selectFrom("cms_pages").selectAll().where("slug", "=", slug).executeTakeFirst());
// Reload = what app/(console)/admin/(authed)/storefront/pages/[slug]/page.js
// hands the editor: the row, normalized, back through the form conversion.
const reload = async (slug) => formSections(normalizePageSections(JSON.parse((await row(slug)).sections)));
const content = (sections) => sections.map(({ id, pid, ...rest }) => rest);

// A founder should be able to act on the message. Internals are not plain.
const assertPlain = (message, label = "") => {
  ok(typeof message === "string" && message.length > 0, `${label} has a message:`);
  ok(!/undefined|null|\[object|\bkind\b|\bsrc\b|\bbody\b|\bhtml\b|array|https?:/i.test(message), `${label} plain words only, got "${message}":`);
};

// DOC-04: a refusal is { error, code, issues }. Each issue is the one shape,
// names its section by id, and carries NO position: "section 3" is the
// editor's to say. `shown` is what the editor's banner says for this response,
// worded by the editor's own pageIssueText against the form that was sent.
const issuesOf = (res) => res.body.issues.filter((i) => i.severity === "error");
const shown = (res, sections = res.sent || []) => issuesOf(res).map((i) => pageIssueText(i, sections));
const POSITION = /\b(section|question|accordion|item)\s+\d/i;
const assertStructured = (res, label = "") => {
  eq(res.body.code, "VALIDATION_FAILED", `${label} code:`);
  ok(Array.isArray(res.body.issues) && issuesOf(res).length > 0, `${label} has issues:`);
  for (const i of res.body.issues) {
    eq(Object.keys(i), ISSUE_KEYS, `${label} issue keys:`);
    ok(typeof i.code === "string" && /^[A-Z_]+$/.test(i.code), `${label} issue code "${i.code}":`);
    ok(!POSITION.test(i.message), `${label} the server sends no position, got "${i.message}":`);
    eq(i.blockId, null, `${label} blockId (nested blocks arrive with TREE-02):`);
  }
};

// --- the reported bug --------------------------------------------------------
console.log("— text section with paragraphs and no heading");

const noHeading = { kind: "text", heading: "", text: "First paragraph.\n\nSecond paragraph." };

await t("paragraphs with no heading survive save and reload (the reported data loss)", async () => {
  const res = await save("no-heading", form(noHeading));
  eq(res.status, 200, "save:");
  const back = await reload("no-heading");
  eq(content(back), [noHeading], "reloaded form:");
});

await t("the storefront reader gets the paragraphs and an empty heading", async () => {
  const page = await inT(() => getContentPage("no-heading"));
  eq(page.sections.length, 1, "sections:");
  eq(page.sections[0].heading, "", "heading:");
  eq(page.sections[0].body, ["First paragraph.", "Second paragraph."], "body:");
});

await t("the paragraphs reach the published release", async () => {
  await inT(() => R.createRelease({ actor: { kind: "merchant", id: "u1" } }));
  const live = await inT(() => R.getLiveRelease());
  const page = live.content.pages.find((p) => p.slug === "no-heading");
  const sections = typeof page.sections === "string" ? JSON.parse(page.sections) : page.sections;
  eq(sections[0].body, ["First paragraph.", "Second paragraph."], "release body:");
});

await t("server rule on its own: paragraphs alone pass, heading alone still passes", async () => {
  const [a, b] = validatePageSections([
    { kind: "text", heading: "   ", body: ["Only words."] },
    { kind: "text", heading: "Only a heading", body: [] },
  ]);
  eq([a.heading, a.body], ["", ["Only words."]], "paragraphs alone:");
  eq([b.heading, b.body], ["Only a heading", []], "heading alone:");
});

await t("the registry declaration no longer calls the text heading required", () => {
  const heading = componentFor("text").settings.find((f) => f.key === "heading");
  ok(!heading.required, "heading.required:");
});

await t("a later edit to the headingless section also survives (revision moves on)", async () => {
  const before = await row("no-heading");
  const edited = { ...(await reload("no-heading"))[0], text: "Rewritten paragraph." };
  const res = await save("no-heading", [edited], before.revision);
  eq(res.status, 200, "second save:");
  eq((await row("no-heading")).revision, before.revision + 1, "revision:");
  eq((await reload("no-heading"))[0].text, "Rewritten paragraph.", "text:");
});

// --- refusals ----------------------------------------------------------------
console.log("— a section with nothing in it is refused, not dropped");

const seed = async (slug) => {
  const res = await save(slug, form({ kind: "text", heading: "Keep me", text: "Existing words." }));
  eq(res.status, 200, "seed:");
  return row(slug);
};
const refused = async (slug, res, label) => {
  eq(res.status, 422, `${label} status:`);
  assertPlain(res.body.error, label);
  assertStructured(res, label);
  for (const i of issuesOf(res)) assertPlain(i.message, `${label} issue`);
};

await t("text section with neither heading nor paragraphs: refused with a plain message, row untouched", async () => {
  const before = await seed("blank-text");
  const sent = form(blankSection("text", "n1"));
  const res = await save("blank-text", sent, before.revision);
  await refused("blank-text", res, "blank text");
  eq(shown(res), ["section 1: add a heading or some text, or remove this section."], "message:");
  eq(issuesOf(res).map(({ sectionId, field, code }) => ({ sectionId, field, code })), [{ sectionId: sent[0].pid, field: "body", code: "SECTION_EMPTY" }], "issue:");
  eq(await row("blank-text"), before, "row unchanged:");
});

await t("whitespace is not content, through the form and straight to the API", async () => {
  const before = await seed("space-text");
  const viaForm = await save("space-text", form({ kind: "text", heading: "   ", text: " \n\n  \n" }), before.revision);
  await refused("space-text", viaForm, "form");
  for (const s of [
    { kind: "text", heading: "", body: [] },
    { kind: "text", heading: "  ", body: ["", "   "] },
    { kind: "text" },
    { heading: "", body: [] },
  ]) {
    const res = await put({ page: { slug: "space-text", title: "x", sections: [s] }, revision: before.revision });
    await refused("space-text", res, `direct ${JSON.stringify(s)}`);
  }
  eq(await row("space-text"), before, "row unchanged:");
});

await t("paragraphs that are not a list are refused, not thrown away", async () => {
  const before = await seed("string-body");
  const res = await put({ page: { slug: "string-body", title: "x", sections: [{ kind: "text", heading: "Kept", body: "A whole paragraph as one string." }] }, revision: before.revision });
  await refused("string-body", res, "string body");
  eq(await row("string-body"), before, "row unchanged:");
});

await t("one empty section refuses the WHOLE save and names its position on the page", async () => {
  const before = await seed("mixed-blank");
  const res = await save(
    "mixed-blank",
    form({ kind: "text", heading: "Good", text: "Words." }, { kind: "faq", heading: "", items: [{ q: "Q", a: "<p>A</p>" }] }, blankSection("text", "n3")),
    before.revision,
  );
  await refused("mixed-blank", res, "third blank");
  ok(shown(res)[0].startsWith("section 3:"), `position in the banner, got "${shown(res)}":`);
  eq(issuesOf(res)[0].sectionId, res.sent[2].pid, "the issue names the third section's id:");
  eq(await row("mixed-blank"), before, "row unchanged:");
});

// --- DOC-04: one structured result ---------------------------------------------
console.log("— DOC-04: structured issues, all of them, located by id");

await t("every problem in the page is reported at once, each naming its own section id and field", async () => {
  const before = await seed("all-issues");
  const sent = form(
    { kind: "text", heading: "Fine", text: "Fine words." },
    blankSection("text", "n1"),
    { kind: "image", src: "http://cdn.example/a.jpg", alt: "", caption: "" },
    { kind: "faq", heading: "", items: [{ q: "Q1", a: "<p>A1</p>" }, { q: "", a: "<p>Orphan</p>" }, { q: "Q3", a: "<p></p>" }] },
    { kind: "rich", heading: "h".repeat(121), html: "Free on orders <500 and >100 rupees." },
  );
  const res = await put({ page: { slug: "all-issues", title: "  ", sections: sectionsPayload(sent) }, revision: before.revision });
  res.sent = sent;
  await refused("all-issues", res, "all issues");
  eq(
    issuesOf(res).map(({ sectionId, field, code }) => [sectionId, field, code]),
    [
      [null, "title", "REQUIRED"],
      [sent[1].pid, "body", "SECTION_EMPTY"],
      [sent[2].pid, "src", "IMAGE_INVALID"],
      [sent[3].pid, "items.1.q", "REQUIRED"],
      [sent[3].pid, "items.2.a", "REQUIRED"],
      [sent[4].pid, "heading", "TOO_LONG"],
      [sent[4].pid, "html", "WORDS_LOST"],
    ],
    "issues in order:",
  );
  eq(
    shown(res),
    [
      "title required",
      "section 2: add a heading or some text, or remove this section.",
      "section 3: this image link isn't secure. Use a link that starts with https, or choose an image from your library.",
      "section 4, question 2: question text required",
      "section 4, question 3: answer required",
      "section 5: the heading is too long (121 characters, the limit is 120)",
      'section 5: saving would lose these words: "<500 and >". This usually comes from < or > signs. Reword them or remove them, then save again.',
    ],
    "what the banner says:",
  );
  eq(res.body.error, "There are 7 things to fix", "summary:");
  eq(await row("all-issues"), before, "row unchanged:");
});

await t("every issue names the id the section is stored under, also for a section the form never saved", async () => {
  const sent = form(blankSection("rich", "n1"));
  const res = await save("ids-new", sent);
  eq(issuesOf(res)[0].sectionId, sent[0].pid, "a brand-new section's id:");
  ok(/^sec_[a-z0-9]+$/.test(sent[0].pid), `minted in the form: ${sent[0].pid}`);
  const fixed = await save("ids-new", [{ ...sent[0], html: "<p>Now words</p>" }]);
  eq(fixed.status, 200, "save once fixed:");
  eq(JSON.parse((await row("ids-new")).sections)[0].id, sent[0].pid, "the server keeps the id the form minted:");
});

await t("the number comes from the id against the form as it is now, never from the server", async () => {
  const sent = form({ kind: "text", heading: "One", text: "x" }, { kind: "text", heading: "Two", text: "y" }, blankSection("image", "n2"));
  const res = await save("renumber", sent);
  eq(shown(res), ["section 3: choose an image, or remove this section."], "as sent:");
  eq(shown(res, [sent[2], sent[0], sent[1]]), ["section 1: choose an image, or remove this section."], "after moving it to the top:");
  eq(shown(res, [sent[0], sent[1]]), ["A section: choose an image, or remove this section."], "after removing it:");
});

await t("a question number counts the rows on screen, including the blank ones the save leaves out", async () => {
  const sent = form({ kind: "faq", heading: "", items: [{ q: "Q1", a: "<p>A1</p>" }, { q: "", a: "" }, { q: "Q3", a: "" }] });
  const res = await save("faq-rows", sent);
  eq(issuesOf(res).map((i) => i.field), ["items.1.a"], "the server's index is into what was sent:");
  eq(shown(res), ["section 1, question 3: answer required"], "the banner's number is the row on screen:");
});

await t("two sections sent with the same id: each issue names the id its own section would be saved under", () => {
  const { checkPageSections } = pageStore;
  const { issues, value } = checkPageSections([
    { id: "sec_same1", kind: "image", src: "", alt: "" },
    { id: "sec_same1", kind: "image", src: "", alt: "" },
  ]);
  eq(issues.map((i) => i.sectionId), value.map((s) => s.id), "issue ids are the saved ids:");
  eq(issues[0].sectionId, "sec_same1", "the first keeps its id:");
  ok(issues[1].sectionId !== "sec_same1", `the second gets its own: ${issues[1].sectionId}`);
});

await t("no refusal anywhere in this suite's server messages carries a position", () => {
  // assertStructured runs inside refused(); this pins the old forms by name
  for (const old of ["section 1: x", "Section 2 (banner): x", "section 1, question 2: x"]) ok(POSITION.test(old), `the check sees ${old}:`);
});

// --- every kind, every filled/blank combination ------------------------------
console.log("— no kind is treated as empty, dropped and marked clean");

const H = "A heading";
const combos = (fields) => {
  const names = Object.keys(fields);
  return Array.from({ length: 2 ** names.length }, (_, n) => Object.fromEntries(names.map((name, i) => [name, n & (1 << i) ? fields[name] : ""])));
};
const MATRIX = [
  ...combos({ heading: H, text: "Para one.\n\nPara two." }).map((f) => ({
    section: { kind: "text", ...f },
    saves: Boolean(f.heading || f.text),
  })),
  ...combos({ heading: H, html: "<p>Rich words</p>" }).map((f) => ({
    section: { kind: "rich", ...f },
    saves: Boolean(f.html),
  })),
  ...combos({ src: "/api/media/med_a", alt: "Alt words", caption: "Caption words" }).map((f) => ({
    section: { kind: "image", ...f },
    saves: Boolean(f.src && f.alt),
  })),
  ...combos({ heading: H, q: "A question", a: "<p>An answer</p>" }).map(({ heading, q, a }) => ({
    section: { kind: "faq", heading, items: [{ q, a }] },
    saves: Boolean(q && a),
  })),
];

await t(`matrix (${MATRIX.length} cases): saved with every word intact, or refused plainly with the row untouched`, async () => {
  let n = 0;
  for (const { section, saves } of MATRIX) {
    const slug = `m-${n++}`;
    const label = JSON.stringify(section);
    const before = await seed(slug);
    const res = await save(slug, form(section), before.revision);
    if (saves) {
      eq(res.status, 200, `${label} save:`);
      // what the editor marks clean is exactly what a reload shows
      eq(content(await reload(slug)), [section], `${label} reload:`);
    } else {
      await refused(slug, res, label);
      eq(await row(slug), before, `${label} row unchanged:`);
    }
  }
});

await t("heading typed on a rich section with no content is refused, not lost", async () => {
  const before = await seed("rich-heading");
  const res = await save("rich-heading", form({ kind: "rich", heading: H, html: "" }), before.revision);
  await refused("rich-heading", res, "rich heading only");
  eq(await row("rich-heading"), before, "row unchanged:");
});

await t("alt text typed on an image with no picture is refused, not lost", async () => {
  const before = await seed("img-alt");
  const res = await save("img-alt", form({ kind: "image", src: "", alt: "Alt words", caption: "" }), before.revision);
  await refused("img-alt", res, "image alt only");
  eq(shown(res), ["section 1: choose an image, or remove this section."], "says what to do, and only that:");
  eq(await row("img-alt"), before, "row unchanged:");
});

await t("an FAQ answer with no question is refused, not lost, among good rows", async () => {
  const before = await seed("faq-answer");
  const res = await save(
    "faq-answer",
    form({ kind: "faq", heading: "", items: [{ q: "Q1", a: "<p>A1</p>" }, { q: "", a: "<p>An orphan answer</p>" }] }),
    before.revision,
  );
  await refused("faq-answer", res, "orphan answer");
  eq(await row("faq-answer"), before, "row unchanged:");
});

await t("an untouched blank FAQ row holds no founder words: it alone is left out", async () => {
  const res = await save("faq-blank-row", form({ kind: "faq", heading: H, items: [{ q: "Q1", a: "<p>A1</p>" }, { q: "  ", a: "" }] }));
  eq(res.status, 200, "save:");
  eq((await reload("faq-blank-row"))[0].items, [{ q: "Q1", a: "<p>A1</p>" }], "items:");
});

await t("the payload always has one entry per section, so positions and new ids line up", async () => {
  const sections = form(noHeading, blankSection("text", "n1"), blankSection("rich", "n2"), blankSection("image", "n3"), blankSection("faq", "n4"));
  eq(sectionsPayload(sections).length, sections.length, "payload length:");
  const res = await save("positions", form({ ...noHeading }, { kind: "rich", heading: "", html: "<p>R</p>" }));
  eq(res.status, 200, "save:");
  const stored = JSON.parse((await row("positions")).sections);
  eq(stored.map((s) => s.kind), ["text", "rich"], "stored order:");
  ok(stored.every((s) => /^sec_/.test(s.id)), "each stored section has an id for the editor to adopt by position");
});

// --- words the sanitizer would remove ----------------------------------------
console.log("— ordinary words typed into the two HTML fields");

// Both HTML fields, same checks: rich content and an FAQ answer.
const htmlField = (html) => [
  ["rich", { kind: "rich", heading: "", html }],
  ["faq", { kind: "faq", heading: "", items: [{ q: "A question", a: html }] }],
];

// [what the founder typed, the words the refusal must quote]
const LOSES_WORDS = [
  ["Free on orders <500 and >100 rupees.", "<500 and >"],
  ["Write to Priya <priya@store.com> any day.", "<priya@store.com>"],
  ["<p>Keep it at a<b and c>d always.</p>", "<b and c>"],
  ["<p>Hello</p><noscript>Important founder words</noscript>", "Important founder words"],
  ["Ask for the <founder> today.", "<founder>"],
  ["Sizes: a < b and c > d.", "< b and c >"],
  ["Visit <www.store.example/sale> now.", "<www.store.example/sale>"],
  ['<p>Before</p><embed src="/x"><p>After the embed</p>', "After the embed"],
  ["<p>Before</p><svg><text>Drawn words</text></svg>", "Drawn words"],
  ['<p>Before</p><iframe src="/x"><p>Never closed</p>', "Never closed"],
  // a colon or a hyphen doesn't make it a tag, and it still parses as one
  ["Call <tel:9876543210> now.", "<tel:9876543210>"],
  ["<Price:500> only.", "<Price:500>"],
  ["Use <code:SAVE10> at checkout.", "<code:SAVE10>"],
  ["Mix <m:500> grams.", "<m:500>"],
  ["<sku:123>Blue</sku:123> shoes.", "<sku:123>Blue</sku:123>"],
  ["<m:500>Flour</m:500> mix.", "<m:500>Flour</m:500>"],
  ["Save <b free-shipping> today.", "<b free-shipping>"],
  // a real tag's name, on its own, with nothing closing it
  ["Click the <link> below.", "<link>"],
  ["Send your <address> and <time>.", "<address> and <time>"],
  ["Pick a <title> first.", "<title>"],
  ["</time> comes before <time> here.", "<time>"],
  ["Ends with <script>", "<script>"],
  // looks like a comment or a doctype, and isn't one
  ["Price <?500> today", "<?500>"],
  ["Why <?> Because", "<?>"],
  ["<?Free shipping over 500?> today", "<?Free shipping over 500?>"],
  ["Offer <![sale]> today", "<![sale]>"],
  ["Note <!doctype sale> today", "<!doctype sale>"],
  ["Note <!doctype> today", "<!doctype>"],
  // a closed-off name is still only a name
  ["Click the <link/> below.", "<link/>"],
  ["Send <address /> today", "<address />"],
  ["Send <w:500/> today", "<w:500/>"],
  // a real tag and an ordinary word, not an attribute of that tag
  ["Keep <b required> here", "<b required>"],
  ["The shop is <span open> today", "<span open>"],
  ["Get a <p download> today", "<p download>"],
  ["Keep <b =x> here", "<b =x>"],
  // a comment nobody closed hides the rest, so it is refused
  ["<p>Before</p><!-- not closed, these words go", "<!-- not closed, these words go"],
];

await t(`stray brackets (${LOSES_WORDS.length} cases, both fields): refused, quoting the words, row untouched`, async () => {
  let n = 0;
  for (const [typed, words] of LOSES_WORDS) {
    for (const [field, section] of htmlField(typed)) {
      const slug = `stray-${n++}`;
      const before = await seed(slug);
      const res = await save(slug, form(section), before.revision);
      const label = `${field} ${JSON.stringify(typed)}`;
      await refused(slug, res, label);
      const [said] = shown(res);
      ok(said.includes(`"${words}"`), `${label} quotes ${words}, got "${said}":`);
      ok(said.startsWith(field === "rich" ? "section 1:" : "section 1, question 1:"), `${label} position, got "${said}":`);
      eq(issuesOf(res)[0].field, field === "rich" ? "html" : "items.0.a", `${label} field:`);
      eq(await row(slug), before, `${label} row unchanged:`);
    }
  }
});

await t("a very long stretch of lost words is quoted short, and the message stays usable", async () => {
  const res = await save("stray-long", form({ kind: "rich", heading: "", html: `<${"w".repeat(500)}> and more` }));
  eq(res.status, 422, "status:");
  ok(shown(res)[0].length < 300, `length ${shown(res)[0].length}:`);
});

// HTML that needs no change, and words that aren't at risk: stored as typed.
const KEPT_AS_TYPED = [
  "Plain words with no tags at all.",
  "5 > 3 is fine without its partner.",
  "Tom &amp; Jerry &lt;3 this.",
  '<p>Bold <b>word</b> and a <a href="/x" title="A title">link</a></p>',
  "<ul><li>One</li><li>Two</li></ul><h3>Usage</h3>",
  '<img src="/api/media/a" alt="Alt words" />',
  'Line one<br />line two<hr /><a href="/x" target="_blank" rel="noopener noreferrer">x</a>',
];

await t(`clean words and HTML (${KEPT_AS_TYPED.length} cases, both fields): the reload shows exactly what was typed`, async () => {
  let n = 0;
  for (const typed of KEPT_AS_TYPED) {
    for (const [field, section] of htmlField(typed)) {
      const slug = `kept-${n++}`;
      const res = await save(slug, form(section));
      eq(res.status, 200, `${field} ${typed} status:`);
      eq(content(await reload(slug)), [section], `${field} ${typed} reload:`);
    }
  }
});

// [typed, stored]: nothing a reader sees is gone. Telling the founder about the
// removed parts is AU-06, and the form shows the typed version until a reload.
const UNSAFE_NO_WORDS = [
  ["<p>Hi</p><script>alert(1)</script>", "<p>Hi</p>"],
  ["<style>.x{color:red}</style><p>Hi</p>", "<p>Hi</p>"],
  ["<p>Hi</p><iframe allowfullscreen></iframe>", "<p>Hi</p>"],
  ['<p onclick="x()" class="y" data-z>Hi</p>', "<p>Hi</p>"],
  ['<a href="javascript:alert(1)">Hi</a>', "<a>Hi</a>"],
  ["<!-- a note --><p>Hi</p>", "<p>Hi</p>"],
  ["<p>Hi</p><!-- private note > do not show -->", "<p>Hi</p>"],
  ["<!--[if gte mso 9]><xml><o:p>Word notes</o:p></xml><![endif]--><p>Hi</p>", "<p>Hi</p>"],
  ["<![if !mso]><p>Hi</p><![endif]>", "<p>Hi</p>"],
  ['<?xml version="1.0"?><p>Hi</p>', "<p>Hi</p>"],
  ['<?xml:namespace prefix = o ns = "urn:schemas-microsoft-com:office:office" /><p>Hi</p>', "<p>Hi</p>"],
  ["<!DOCTYPE html><p>Hi</p>", "<p>Hi</p>"],
  ["<![CDATA[]]><p>Hi</p>", "<p>Hi</p>"],
  ["<template>x</template><p>Hi</p>", "<p>Hi</p>"],
  ["<iframe/>words</iframe>", "words"],
  ['<input required disabled><p hidden>Hi</p><ol reversed><li>x</li></ol>', "<p>Hi</p><ol><li>x</li></ol>"],
  ["<p class=MsoNormal>Hi<o:p></o:p></p>", "<p>Hi</p>"],
  ['<noscript><img src="/x"></noscript><p>Hi</p>', "<p>Hi</p>"],
  ['<svg viewBox="0 0 1 1"><path d="M0 0"/></svg><p>Hi</p>', "<p>Hi</p>"],
  ["<center>Hi</center>", "Hi"],
  [`<meta charset='utf-8'><p dir="ltr" style="line-height:1.38;" id="docs-guid"><span style="font-size:11pt;">Hi</span></p>`, "<p><span>Hi</span></p>"],
  ['<a href="/x"title="y">Hi</a>', '<a href="/x" title="y">Hi</a>'],
  ["<P ALIGN=center>Hi<BR/></P >", "<p>Hi<br /></p>"],
  ["Under 5 < 10", "Under 5 &lt; 10"],
  // real HTML still saves: a tag that closes, Word's own tags, data-* and aria-*
  ["<address>Hi</address>", "Hi"],
  ["<time>Hi</time>", "Hi"],
  ['<st1:country-region w:st="on">Hi</st1:country-region>', "Hi"],
  ['<w:sdt>Hi</w:sdt><o:p/><v:shape id="x"/>', "Hi"],
  ["<m:oMath>Hi</m:oMath><x:Row>there</x:Row>", "Hithere"],
  ["<p data-sale aria-hidden>Hi</p>", "<p>Hi</p>"],
  ["Hi<wbr>there", "Hithere"],
  ["<table><colgroup><col><col></colgroup><tr><td>Hi</td></tr></table>", "<table><tr><td>Hi</td></tr></table>"],
  // an address that only runs code, or no address at all, costs no link
  ['<a href="vbscript:x">Hi</a>', "<a>Hi</a>"],
  ['<a href="java&#x73;cript:alert(1)">Hi</a>', "<a>Hi</a>"],
  ['<a href="">Hi</a>', "<a>Hi</a>"],
  ['<a href=" ">Hi</a>', "<a>Hi</a>"],
  ['<iframe src="javascript:alert(1)"></iframe><p>Hi</p>', "<p>Hi</p>"],
  ['<video src="vbscript:x" controls></video><p>Hi</p>', "<p>Hi</p>"],
  ['<audio controls src="java&#x73;cript:x"></audio><p>Hi</p>', "<p>Hi</p>"],
  ['<embed src=" "></embed><p>Hi</p>', "<p>Hi</p>"],
  ['<video controls></video src="/a"><p>Hi</p>', "<p>Hi</p>"],
  ['<img srcset="javascript:x" alt="A" /><p>Hi</p>', '<img alt="A" /><p>Hi</p>'],
  ['<picture><source srcset="/a.webp"><img src="/a.jpg" alt="A"></picture>', '<img src="/a.jpg" alt="A" />'],
  ['<img src="/a.jpg" srcset="/a.jpg 2x" data-src="/b.jpg" alt="A" />', '<img src="/a.jpg" alt="A" />'],
];

await t(`unsafe parts with no words in them (${UNSAFE_NO_WORDS.length} cases, both fields) still save, every word kept`, async () => {
  let n = 0;
  for (const [typed, stored] of UNSAFE_NO_WORDS) {
    for (const [field, section] of htmlField(typed)) {
      const slug = `unsafe-${n++}`;
      const res = await save(slug, form(section));
      eq(res.status, 200, `${field} ${typed} status: "${res.body.error}"`);
      const [back] = await reload(slug);
      eq(field === "rich" ? back.html : back.items[0].a, stored, `${field} ${typed} stored:`);
    }
  }
});

await t("what these saves stored is not refused or changed by saving it again", async () => {
  for (const [, stored] of UNSAFE_NO_WORDS) {
    for (const [field, section] of htmlField(stored)) {
      const [clean] = validatePageSections([section]);
      eq(field === "rich" ? clean.html : clean.items[0].a, stored, `${field} ${stored}:`);
    }
  }
});

await t("a row the old code cut mid-tag saves again, unless encoding its < takes it past the limit", async () => {
  const oldCut = (limit, tail) => sanitizeHtml("x".repeat(limit - 10) + '<a href="https://a.example/">y</a>').slice(0, tail);
  const insert = (slug, html) => inT(() => db.insertInto("cms_pages").values({ slug, title: "T", description: "", sections: JSON.stringify([{ id: `sec_${slug}`, kind: "rich", heading: "", html }]), enabled: 1, revision: 1, updated_at: "2026-01-01T00:00:00.000Z", family: "page", schema_version: 2 }).execute());

  await insert("old-cut-short", oldCut(10000, 10003));
  const short = await save("old-cut-short", await reload("old-cut-short"), 1);
  eq(short.status, 200, `under the limit: "${short.body.error}"`);

  const cut = oldCut(20000, 20000);
  ok(cut.endsWith('xxxx<a href="h') && cut.length === 20000, "fixture:");
  await insert("old-cut", cut);
  const before = await row("old-cut");
  const res = await save("old-cut", await reload("old-cut"), 1);
  await refused("old-cut", res, "cut at the limit");
  eq(shown(res), ["section 1: the content is too long (20003 characters, the limit is 20000)"], "message:");
  eq(await row("old-cut"), before, "row unchanged:");
});

await t("a link near the limit stays accepted however many times it is saved, with no edit", async () => {
  const link = '<a href="/x" target="_blank" rel="noopener noreferrer">x</a>';
  const answer = `<p>${"a".repeat(8000 - link.length - "<p></p>".length)}${link}</p>`;
  eq(answer.length, 8000, "fixture:");
  let revision = null;
  for (let i = 0; i < 4; i++) {
    const res = await save("rel-grow", form({ kind: "faq", heading: "", items: [{ q: "Q", a: answer }] }), revision);
    eq(res.status, 200, `save ${i + 1}: "${res.body.error}"`);
    revision = (await row("rel-grow")).revision;
    eq((await reload("rel-grow"))[0].items[0].a, answer, `reload ${i + 1}:`);
  }
});

await t("a typed nofollow or sponsored stays on a link with a target, through save and reload", async () => {
  const typed = '<a href="https://x.example" target="_blank" rel="nofollow sponsored">x</a>';
  const stored = '<a href="https://x.example" target="_blank" rel="nofollow sponsored noopener noreferrer">x</a>';
  const res = await save("rel-seo", form({ kind: "rich", heading: "", html: typed }));
  eq(res.status, 200, "save:");
  const [back] = await reload("rel-seo");
  eq(back.html, stored, "stored:");
  eq(validatePageSections([{ kind: "rich", html: stored }])[0].html, stored, "saved again:");
});

await t("a row already holding repeated rel attributes shrinks back on its next save", () => {
  const doubled = '<a href="/x" target="_blank" rel="noopener noreferrer" rel="noopener noreferrer">x</a>';
  eq(validatePageSections([{ kind: "rich", html: doubled }])[0].html, '<a href="/x" target="_blank" rel="noopener noreferrer">x</a>', "html:");
});

// --- link and image addresses the founder typed -------------------------------
console.log("— a link or image address that saving would remove");

// [typed, the address the refusal must quote]
const LOSES_ADDRESS = [
  ['<a href="tel:+919876543210">Call us</a>', "tel:+919876543210"],
  ['<a href="sms:+919876543210">Text us</a>', "sms:+919876543210"],
  ['<a href="whatsapp://send?phone=919876543210">WhatsApp</a>', "whatsapp://send?phone=919876543210"],
  ['<a href="www.store.com/sale">Sale</a>', "www.store.com/sale"],
  ["<a href=contact>Contact</a>", "contact"],
  ['<a href="//cdn.example/x">Sale</a>', "//cdn.example/x"],
  ['<img src="photo.jpg" alt="Photo">', "photo.jpg"],
  ['<img src="data:image/png;base64,AAAA" alt="Pasted">', "data:image/png;base64,AAAA"],
];

await t(`addresses (${LOSES_ADDRESS.length} cases, both fields): refused, quoting the address, row untouched`, async () => {
  let n = 0;
  for (const [typed, address] of LOSES_ADDRESS) {
    for (const [field, section] of htmlField(typed)) {
      const slug = `addr-${n++}`;
      const before = await seed(slug);
      const res = await save(slug, form(section), before.revision);
      const label = `${field} ${typed}`;
      await refused(slug, res, label);
      const [said] = shown(res);
      ok(said.includes(`"${address}"`), `${label} quotes the address, got "${said}":`);
      ok(said.startsWith(field === "rich" ? "section 1:" : "section 1, question 1:"), `${label} position, got "${said}":`);
      eq(issuesOf(res)[0].code, "ADDRESS_LOST", `${label} code:`);
      eq(await row(slug), before, `${label} row unchanged:`);
    }
  }
});

// [typed, the address the refusal must quote]. The addresses are often https,
// which the plain-words check doesn't look at because the founder typed them.
const LOSES_MEDIA = [
  ['<p>Watch</p><iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe>', "https://www.youtube.com/embed/abc"],
  ['<iframe src="https://www.youtube.com/embed/abc"></iframe>', "https://www.youtube.com/embed/abc"],
  ['<IFRAME SRC="https://player.example/1"></IFRAME>', "https://player.example/1"],
  ["<iframe src=https://player.example/1></iframe><p>Watch</p>", "https://player.example/1"],
  ['<iframe src="video.mp4"></iframe><p>Hi</p>', "video.mp4"],
  ['<p>Watch</p><video src="https://cdn.example/a.mp4" controls></video>', "https://cdn.example/a.mp4"],
  ['<video src="https://cdn.example/a.mp4"></video>', "https://cdn.example/a.mp4"],
  ['<video controls><source src="https://cdn.example/a.mp4"></video><p>Watch</p>', "https://cdn.example/a.mp4"],
  ['<audio src="https://cdn.example/a.mp3"></audio><p>Hear</p>', "https://cdn.example/a.mp3"],
  ['<audio controls><source src="/a.mp3" type="audio/mpeg"></audio>', "/a.mp3"],
  ['<source src="/a.mp4">', "/a.mp4"],
  ['<embed src="https://cdn.example/a.swf">', "https://cdn.example/a.swf"],
  ['<embed src="https://cdn.example/a.swf" /><p>Watch</p>', "https://cdn.example/a.swf"],
  ['<object data="https://cdn.example/a.pdf"></object><p>Read</p>', "https://cdn.example/a.pdf"],
  ['<object src="/a.swf"></object>', "/a.swf"],
];
const MEDIA_MESSAGE = (address) => `this page can't show embedded videos or sound yet, so saving would lose "${address}". Remove it or link to it instead.`;
const LOSES_PICTURE = [
  ['<img srcset="https://cdn.example/a.jpg 2x" alt="A"><p>x</p>', "https://cdn.example/a.jpg 2x"],
  ['<img data-src="https://cdn.example/a.jpg" alt="A"><p>x</p>', "https://cdn.example/a.jpg"],
  ['<img data-src="/a.jpg">', "/a.jpg"],
  ['<IMG SRCSET="/a.jpg 1x, /b.jpg 2x">', "/a.jpg 1x, /b.jpg 2x"],
  ['<img src="" data-src="/a.jpg" alt="A">', "/a.jpg"],
  ['<img src="javascript:x" srcset="/a.jpg 2x" alt="A">', "/a.jpg 2x"],
];
const PICTURE_MESSAGE = (address) => `this page can't show this type of picture yet, so saving would lose "${address}". Add it as an image section, or remove it.`;

const refusedQuoting = async (cases, message, prefix) => {
  let n = 0;
  for (const [typed, address] of cases) {
    for (const [field, section] of htmlField(typed)) {
      const slug = `${prefix}-${n++}`;
      const before = await seed(slug);
      const res = await save(slug, form(section), before.revision);
      const label = `${field} ${typed}`;
      eq(res.status, 422, `${label} status:`);
      eq(shown(res), [`${field === "rich" ? "section 1" : "section 1, question 1"}: ${message(address)}`], `${label} message:`);
      eq(issuesOf(res)[0].message, message(address), `${label} the server's message has no position:`);
      assertPlain(issuesOf(res)[0].message.replace(address, ""), label);
      eq(await row(slug), before, `${label} row unchanged:`);
    }
  }
};

await t(`embedded videos and sound (${LOSES_MEDIA.length} cases, both fields): refused, quoting the address, row untouched`, () => refusedQuoting(LOSES_MEDIA, MEDIA_MESSAGE, "media"));

await t(`pictures held only in srcset or data-src (${LOSES_PICTURE.length} cases, both fields): refused, quoting the address, row untouched`, () => refusedQuoting(LOSES_PICTURE, PICTURE_MESSAGE, "picture"));

await t("the same refusal reaches Save as template, with the right section number", async () => {
  const sent = form(noHeading, { kind: "rich", heading: "", html: '<iframe src="/v"></iframe>' });
  const res = await put({ saveTemplate: { name: "Video", family: "page", sections: sectionsPayload(sent) } });
  eq(res.status, 422, "status:");
  assertStructured(res, "template");
  eq(shown(res, sent), [`section 2: ${MEDIA_MESSAGE("/v")}`], "message:");
  eq(issuesOf(res)[0].sectionId, sent[1].pid, "names the second section:");
});

await t("addresses that work are stored as typed", async () => {
  const typed = '<a href="https://x.example/a">a</a><a href="http://x.example/b">b</a><a href="/c">c</a><a href="#d">d</a><a href="mailto:hi@store.example">e</a><img src="/api/media/a" alt="f" />';
  const res = await save("addr-ok", form({ kind: "rich", heading: "", html: typed }));
  eq(res.status, 200, `save: "${res.body.error}"`);
  eq((await reload("addr-ok"))[0].html, typed, "stored:");
});

await t("sanitizeHtml itself still returns the same text for an address it removes", () => {
  eq(sanitizeHtml('<a href="tel:+919876543210">Call us</a>'), "<a>Call us</a>", "html:");
  eq(sanitizeHtml('<noscript><img src="photo.jpg"></noscript><p>Hi</p>'), "<p>Hi</p>", "dropped element:");
  eq(validatePageSections([{ kind: "rich", html: '<noscript><img src="photo.jpg"></noscript><p>Hi</p>' }])[0].html, "<p>Hi</p>", "an address inside a dropped element holds no link:");
});

// --- invisible and unusable input --------------------------------------------
console.log("— characters that show nothing, and image links");

const INVISIBLE = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u00AD", "\u00A0", " \u200B \u200D ", "\u200E", "\u200F", "\uFE0F", "\u2800", "\u3164", "\u034F", "\u2062", "\u202A", "\u180E", "\u115F", "\u1160", "\uFFA0", "\u0001"];

await t(`a section holding only invisible characters (${INVISIBLE.length} kinds) counts as empty`, async () => {
  const before = await seed("invisible");
  for (const blank of INVISIBLE) {
    const label = JSON.stringify(blank);
    for (const section of [
      { kind: "text", heading: blank, text: "" },
      { kind: "text", heading: "", text: blank },
      { kind: "rich", heading: "", html: blank },
      { kind: "image", src: "/api/media/a", alt: blank, caption: "" },
      { kind: "faq", heading: "", items: [{ q: blank, a: "<p>A</p>" }] },
      { kind: "faq", heading: "", items: [{ q: "Q", a: blank }] },
    ]) {
      await refused("invisible", await save("invisible", form(section), before.revision), `${label} ${section.kind}`);
    }
  }
  eq(await row("invisible"), before, "row unchanged:");
});

await t("an invisible heading beside real text is no heading, and an invisible paragraph is no paragraph", () => {
  const [a, b] = validatePageSections([
    { kind: "text", heading: "\u200B", body: ["Real words."] },
    { kind: "text", heading: "Real heading", body: ["\u200B", "Real words."] },
  ]);
  eq([a.heading, a.body], ["", ["Real words."]], "invisible heading:");
  eq([b.heading, b.body], ["Real heading", ["Real words."]], "invisible paragraph:");
});

// Sanitized HTML that a shopper would see as nothing, in both HTML fields.
const EMPTY_MARKUP = ["<p></p>", "<p> </p>", "<br>", "<p>&nbsp;</p>", "&nbsp;", "&#160;", "<div></div>", "<p>\u200B</p>", "<p>&#8203;</p>", '<a href="/x"></a>', "<script>x</script>", "<!-- a note -->", "<!-- a > note -->", "<p>&ensp;</p>", "<p>&emsp;</p>", "<p>&thinsp;</p>", "<p>&zwj;</p>", "<p>&zwnj;</p>", "<p>&nbsp</p>", "<p>&#160</p>", "<p>&#xa0;</p>", "<p>&#XA0;</p>", "<p>&#x200b;</p>"];

await t(`only empty markup (${EMPTY_MARKUP.length} kinds, both fields) counts as empty, row untouched`, async () => {
  const before = await seed("empty-markup");
  for (const typed of EMPTY_MARKUP) {
    for (const [field, section] of htmlField(typed)) {
      const res = await save("empty-markup", form(section), before.revision);
      await refused("empty-markup", res, `${field} ${typed}`);
      eq(shown(res), [field === "rich" ? "section 1: this section is empty. Add some content, or remove this section." : "section 1, question 1: answer required"], `${field} ${typed} message:`);
    }
  }
  eq(await row("empty-markup"), before, "row unchanged:");
});

await t("a picture or a dividing line alone is content; so is one real word in empty tags", async () => {
  for (const typed of ['<img src="/api/media/a" alt="Photo" />', "<hr />", "<p>&nbsp;</p><p>Hi</p>", "<p>5 &lt; 6</p>", "<p>&nbspHi</p>"]) {
    for (const [field, section] of htmlField(typed)) {
      const [clean] = validatePageSections([section]);
      eq(field === "rich" ? clean.html : clean.items[0].a, typed, `${field} ${typed}:`);
    }
  }
});

await t("the same characters inside real words are stored untouched (scripts and emoji need them)", async () => {
  const heading = "\u0915\u094D\u200D\u0937 family \u{1F468}\u200D\u{1F469}";
  const text = "\u0936\u094D\u200C\u0930 words";
  const res = await save("zwj-kept", form({ kind: "text", heading, text }));
  eq(res.status, 200, "save:");
  eq(content(await reload("zwj-kept")), [{ kind: "text", heading, text }], "reload:");
});

await t("an image link that isn't https or from the library is refused in plain words", async () => {
  const before = await seed("img-link");
  for (const src of ["http://cdn.example/a.jpg", "//cdn.example/a.jpg", "javascript:alert(1)", "a.jpg"]) {
    const res = await save("img-link", form({ kind: "image", src, alt: "Alt", caption: "" }), before.revision);
    await refused("img-link", res, src);
    eq(shown(res), ["section 1: this image link isn't secure. Use a link that starts with https, or choose an image from your library."], `${src} message:`);
  }
  eq(await row("img-link"), before, "row unchanged:");
});

// --- over-limit text ---------------------------------------------------------
console.log("— over-limit text is refused, never cut");

const LONG = [
  ["text heading", { kind: "text", heading: "h".repeat(121), body: ["x"] }],
  ["paragraph", { kind: "text", heading: "", body: ["ok", "p".repeat(4001)] }],
  ["rich heading", { kind: "rich", heading: "h".repeat(121), html: "<p>x</p>" }],
  ["rich content", { kind: "rich", heading: "", html: `<p>${"r".repeat(20001)}</p>` }],
  ["image link", { kind: "image", src: `/${"s".repeat(500)}`, alt: "a" }],
  ["alt text", { kind: "image", src: "/api/media/a", alt: "a".repeat(301) }],
  ["caption", { kind: "image", src: "/api/media/a", alt: "a", caption: "c".repeat(301) }],
  ["FAQ heading", { kind: "faq", heading: "h".repeat(121), items: [{ q: "q", a: "<p>a</p>" }] }],
  ["question", { kind: "faq", items: [{ q: "q".repeat(301), a: "<p>a</p>" }] }],
  ["answer", { kind: "faq", items: [{ q: "q", a: `<p>${"a".repeat(8001)}</p>` }] }],
];

await t(`each of the ${LONG.length} limited fields refuses over-limit text, row untouched`, async () => {
  const before = await seed("too-long");
  for (const [label, section] of LONG) {
    const res = await put({ page: { slug: "too-long", title: "x", sections: [section] }, revision: before.revision });
    eq(res.status, 422, `${label} status:`);
    assertStructured(res, label);
    const [only] = issuesOf(res);
    eq(issuesOf(res).length, 1, `${label} one issue:`);
    ok(/too long \(\d+ characters, the limit is \d+\)/.test(only.message), `${label} says the length and the limit, got "${only.message}":`);
    eq(only.code, "TOO_LONG", `${label} code:`);
    ok(only.sectionId && /^sec_/.test(only.sectionId) && only.field, `${label} names a section and field: ${JSON.stringify(only)}`);
    assertPlain(only.message, label);
  }
  eq(await row("too-long"), before, "row unchanged:");
});

await t("text exactly at the limit is stored whole", async () => {
  const words = "p".repeat(4000);
  const res = await put({ page: { slug: "at-limit", title: "x", sections: [{ kind: "text", heading: "h".repeat(120), body: [words] }] }, revision: null });
  eq(res.status, 200, "save:");
  const [s] = JSON.parse((await row("at-limit")).sections);
  eq([s.heading.length, s.body[0].length], [120, 4000], "lengths:");
});

// --- saving as a template takes the same path --------------------------------
console.log("— save as template");

await t("a headingless text section survives save as template", async () => {
  const res = await put({ saveTemplate: { name: "No heading", family: "page", sections: sectionsPayload(form(noHeading)) } });
  eq(res.status, 200, "save:");
  const used = await put({ useTemplate: res.body.template.id });
  eq(content(used.body.template.sections.map((s, i) => toEdit(s, `t${i}`))), [noHeading], "instantiated:");
});

await t("a blank section is refused in a template too, plainly", async () => {
  const sent = form(noHeading, blankSection("text", "n1"));
  const res = await put({ saveTemplate: { name: "Blank", family: "page", sections: sectionsPayload(sent) } });
  await refused("template", res, "template");
  eq(shown(res, sent), ["section 2: add a heading or some text, or remove this section."], "position:");
});

const oldTemplate = (id, sections) => inT(() => db.insertInto("cms_templates").values({ id, name: "Old", family: "page", sections: JSON.stringify(sections), version: 1, revision: 1, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" }).execute());

await t("a template saved under older rules still opens, keeping what today's rules refuse, and the page's Save says what to fix", async () => {
  const stale = { kind: "rich", heading: "Keep", html: "<p></p>" };
  const staleFaq = { kind: "faq", heading: "Asked", items: [{ q: "Keep this question", a: "<p>&nbsp;</p>" }] };
  const good = [{ kind: "text", heading: "Real", body: ["Real words"] }, { kind: "rich", heading: "", html: "<p>Good</p>" }];
  await oldTemplate("tpl_old", [stale, good[0], staleFaq, good[1]]);
  const used = await put({ useTemplate: "tpl_old" });
  eq(used.status, 200, `open: "${used.body.error}"`);
  const sections = used.body.template.sections;
  eq(sections.map(({ id, ...rest }) => rest), [stale, good[0], staleFaq, good[1]], "nothing lost or changed:");
  ok(sections.every((s) => /^sec_/.test(s.id)) && new Set(sections.map((s) => s.id)).size === 4, "fresh ids:");
  const again = await put({ useTemplate: "tpl_old" });
  ok(again.body.template.sections.every((s, i) => s.id !== sections[i].id), "ids differ per use:");

  const edit = formSections(sections);
  const refusedSave = await save("from-old-template", edit);
  await refused("from-old-template", refusedSave, "stale section on Save");
  // DOC-04: both stale sections are named at once, not only the first
  eq(shown(refusedSave), ["section 1: this section is empty. Add some content, or remove this section.", "section 3, question 1: answer required"], "message on Save:");
  eq(await row("from-old-template"), undefined, "nothing written:");
  const fixed = await save("from-old-template", [{ ...edit[0], html: "<p>Now it has words</p>" }, edit[1], { ...edit[2], items: [{ q: "Keep this question", a: "<p>Now answered</p>" }] }, edit[3]]);
  eq(fixed.status, 200, `saved once fixed: "${fixed.body.error}"`);
});

await t("a template name over the limit is refused, not cut", async () => {
  const sections = sectionsPayload(form(noHeading));
  const long = await put({ saveTemplate: { name: "n".repeat(81), family: "page", sections } });
  eq(long.status, 422, "status:");
  eq(shown(long, []), ["the template name is too long (81 characters, the limit is 80)"], "message:");
  eq(issuesOf(long)[0].field, "name", "field:");
  const atLimit = await put({ saveTemplate: { name: "n".repeat(80), family: "page", sections } });
  eq(atLimit.status, 200, "at the limit:");
  eq(atLimit.body.template.name.length, 80, "stored whole:");
});

await t("the Save as template button sees real content: only all-blank sections count as empty", () => {
  ok(!editEmpty({ kind: "text", heading: "", text: "Words" }), "paragraphs:");
  ok(!editEmpty({ kind: "text", heading: H, text: "" }), "heading:");
  ok(!editEmpty({ kind: "rich", heading: H, html: "" }), "rich heading:");
  ok(!editEmpty({ kind: "image", src: "", alt: "Alt", caption: "" }), "image alt:");
  ok(!editEmpty({ kind: "image", src: "", alt: "", caption: "Caption" }), "image caption:");
  ok(!editEmpty({ kind: "faq", heading: H, items: [{ q: "", a: "" }] }), "faq heading:");
  ok(!editEmpty({ kind: "faq", heading: "", items: [{ q: "", a: "<p>A</p>" }] }), "faq answer:");
  for (const kind of ["text", "rich", "image", "faq"]) ok(editEmpty(blankSection(kind, "x")), `blank ${kind}:`);
});

// --- nothing that saved before is newly refused ------------------------------
console.log("— existing content still saves");

await t("every built-in template and default page saves through the form, whole", () => {
  const sources = [...PAGE_TEMPLATES.map((x) => [`template ${x.id}`, x.page.sections || []]), ...Object.entries(PAGES).map(([slug, p]) => [`default ${slug}`, p.sections])];
  ok(sources.length > 8, "fixtures present:");
  for (const [label, sections] of sources) {
    const edit = sections.map((s, i) => toEdit(s, `s${i}`));
    const clean = validatePageSections(sectionsPayload(edit));
    eq(content(clean.map((s, i) => toEdit(s, `s${i}`))), content(edit), `${label}:`);
  }
});

// --- the two components, compiled with Next's SWC ------------------------------
const source = (rel) => readFile(join(here, "..", rel), "utf8");
const require = createRequire(import.meta.url);
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (rel, resolve) => {
  const { code } = await swc.transform(await source(rel), {
    filename: rel,
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(resolve, mod, mod.exports);
  return mod.exports;
};

console.log("— ContentPage, rendered to markup from what the reader returns");

const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const contentStubs = {
  "next/link": { __esModule: true, default: ({ href, children }) => createElement("a", { href }, children) },
  "./FaqSection": { __esModule: true, default: () => null },
};
const ContentPage = (await compile("components/ContentPage.js", (id) => contentStubs[id] ?? require(id))).default;
const rendered = async (slug, sections) => {
  eq((await save(slug, form(...sections))).status, 200, `${slug} save:`);
  const page = await inT(() => getContentPage(slug));
  const html = renderToStaticMarkup(createElement(ContentPage, { page }));
  return html.slice(html.indexOf('<div class="mt-8'));
};

await t("paragraphs with no heading render, with no heading tag at all", async () => {
  const html = await rendered("render-no-heading", [noHeading]);
  ok(!html.includes("<h2"), `no h2: ${html}`);
  ok(html.includes(">First paragraph.</p>") && html.includes(">Second paragraph.</p>"), `both paragraphs: ${html}`);
});

await t("with a heading, one h2 holds it and the paragraphs follow", async () => {
  const html = await rendered("render-heading", [{ kind: "text", heading: H, text: "Words below." }]);
  eq(html.match(/<h2\b[^>]*>[^<]*<\/h2>/g)?.map((h) => h.replace(/<[^>]*>/g, "")), [H], "h2s:");
  ok(html.indexOf("<h2") < html.indexOf(">Words below.</p>"), `order: ${html}`);
});

await t("a heading alone renders, and a rich section with no heading has no heading tag", async () => {
  ok((await rendered("render-heading-only", [{ kind: "text", heading: H, text: "" }])).includes(`>${H}</h2>`), "heading alone:");
  const rich = await rendered("render-rich", [{ kind: "rich", heading: "", html: "<p>Rich words</p>" }]);
  ok(!rich.includes("<h2") && rich.includes("<p>Rich words</p>"), `rich: ${rich}`);
});

// PageEditor runs for real on stand-ins: useState and useRef are small slots,
// JSX builds plain objects, child components aren't expanded, and ./api is the
// real client talking to the real handler through a stubbed fetch. This covers
// its load and save logic. A browser (drills D1 and D2) still has to confirm it.
console.log("— PageEditor, load and save logic on stand-in hooks");

let hooks = null;
const stubComponents = new Map();
const stubModule = () =>
  new Proxy({ __esModule: true }, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (!stubComponents.has(k)) stubComponents.set(k, Object.assign(() => null, { displayName: String(k) }));
      return stubComponents.get(k);
    },
  });
const element = (type, props) => ({ type, props });
const toasts = [];
const editorModules = {
  react: { useState: (init) => hooks.useState(init), useRef: (init) => hooks.useRef(init), useMemo: (fn) => fn() },
  "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
  "next/navigation": { useRouter: () => ({ push() {}, replace() {} }) },
  "@/components/console/Toast": { useToast: () => ({ success: (m) => toasts.push(m), info() {}, error() {} }) },
  "@/lib/admin/schedule": await import("../lib/admin/schedule.js"),
  "@/lib/content/templates": { PAGE_TEMPLATES },
  "./api": await import("../components/admin/cms/api.js"),
  "./labels": await import("../components/admin/cms/labels.js"),
  "./pageSections": pageSections,
  "./PagesList": { pageStatus: () => ({ tone: "neutral", label: "Draft" }) },
  "./useDirtyGuard": { useDirtyGuard() {} },
};
const { PageEditor } = await compile("components/admin/cms/PageEditor.js", (id) => editorModules[id] ?? stubModule());

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url !== "/api/admin/storefront") return realFetch(url, options);
  const res = await put(JSON.parse(options.body));
  return { ok: res.status < 400, status: res.status, json: async () => res.body };
};

const walk = (node, visit) => {
  if (Array.isArray(node)) node.forEach((n) => walk(n, visit));
  else if (node?.props) {
    visit(node);
    Object.values(node.props).forEach((v) => walk(v, visit));
  }
};
const textOf = (node) => (Array.isArray(node) ? node.map(textOf).join("") : node?.props ? textOf(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "");
const mountEditor = (page, revision) => {
  const slots = [];
  let cursor = 0;
  const instance = {
    useState(init) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof init === "function" ? init() : init;
      return [slots[at], (next) => (slots[at] = typeof next === "function" ? next(slots[at]) : next)];
    },
    useRef(init) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: init };
      return slots[at];
    },
  };
  const tree = () => {
    hooks = instance;
    cursor = 0;
    return PageEditor({ mode: "edit", page, revision });
  };
  const all = (name, match = () => true) => {
    const found = [];
    walk(tree(), (n) => n.type?.displayName === name && match(n) && found.push(n));
    return found;
  };
  return {
    field: (label) => all("Textarea", (n) => n.props["aria-label"] === label)[0] ?? all("Input", (n) => n.props["aria-label"] === label)[0],
    type: (label, value) => view.field(label).props.onChange({ target: { value } }),
    save: () => all("Button", (n) => n.props.variant === "primary" && textOf(n) === "Save")[0].props.onClick(),
    unsaved: () => all("Badge", (n) => textOf(n) === "Unsaved").length > 0,
    problems: () => all("Banner", (n) => n.props.title === "Couldn't save").map(textOf),
    // DOC-04: each line of the banner, and what clicking it does
    lines: () => {
      const found = [];
      walk(all("Banner", (n) => n.props.title === "Couldn't save"), (n) => n.type === "li" && found.push(n));
      return found;
    },
    clickLine: (i) => {
      let button = null;
      walk(view.lines()[i], (n) => n.type === "button" && (button = n));
      return button;
    },
    sectionCards: () => all("Card", (n) => typeof n.props.id === "string" && n.props.id.startsWith("pe-sec-")).map((n) => n.props.id),
    press: (label, i) => all("IconButton", (n) => n.props.label === label)[i].props.onClick(),
  };
};
let view = null;

await t("a stored section with no heading loads into the form, and the form starts clean", () => {
  view = mountEditor({ slug: "x", title: "X", sections: [{ kind: "text", heading: "", body: ["First.", "Second."] }] }, 1);
  eq(view.field("Section paragraphs").props.value, "First.\n\nSecond.", "paragraphs:");
  eq(view.field("Section heading").props.value, "", "heading:");
  ok(!view.unsaved(), "clean:");
});

await t("a refused save shows the message, stays Unsaved and keeps the typing; fixing it saves and goes clean", async () => {
  const before = await seed("ed-refuse");
  view = mountEditor({ slug: "ed-refuse", title: "Page ed-refuse", sections: JSON.parse(before.sections) }, before.revision);
  view.type("Section heading", "");
  view.type("Section paragraphs", "");
  ok(view.unsaved(), "typed:");
  toasts.length = 0;
  await view.save();
  eq(view.problems(), ["section 1: add a heading or some text, or remove this section."], "banner:");
  ok(view.unsaved(), "still unsaved after a refusal:");
  eq(toasts, [], "no success toast:");
  eq(await row("ed-refuse"), before, "row unchanged:");

  view.type("Section paragraphs", "Better words.");
  await view.save();
  eq(view.problems(), [], "banner gone:");
  ok(!view.unsaved(), "clean after a real save:");
  eq(toasts.length, 1, "one success toast:");
  eq(content(await reload("ed-refuse")), [{ kind: "text", heading: "", text: "Better words." }], "stored:");
});

await t("words the sanitizer would remove are refused in the editor too, and stay in the form", async () => {
  const typed = "Free on orders <500 and >100 rupees.";
  const seeded = await save("ed-stray", form({ kind: "rich", heading: "", html: "<p>Before</p>" }));
  eq(seeded.status, 200, "seed:");
  const before = await row("ed-stray");
  view = mountEditor({ slug: "ed-stray", title: "Page ed-stray", sections: JSON.parse(before.sections) }, before.revision);
  view.type("Section HTML", typed);
  await view.save();
  ok(view.problems()[0]?.includes('"<500 and >"'), `banner quotes the words, got ${JSON.stringify(view.problems())}:`);
  ok(view.unsaved(), "still unsaved:");
  eq(view.field("Section HTML").props.value, typed, "form keeps the typing:");
  eq(await row("ed-stray"), before, "row unchanged:");
});

// DOC-04, in the editor: the banner is worded from each issue's section id
// against the form as it is NOW, and each line takes the founder to its card.
await t("DOC-04: the banner lists every issue, numbers it from the id, renumbers when the section moves, and each line scrolls to its card", async () => {
  view = mountEditor(
    {
      slug: "ed-renumber",
      title: "Page ed-renumber",
      sections: [
        { id: "sec_keep1", kind: "text", heading: "Fine", body: ["Words."] },
        { id: "sec_blank2", kind: "text", heading: "", body: [] },
        { id: "sec_img3", kind: "image", src: "", alt: "", caption: "" },
      ],
    },
    null,
  );
  await view.save();
  eq(view.lines().map(textOf), ["section 2: add a heading or some text, or remove this section.", "section 3: choose an image, or remove this section."], "both, numbered from their ids:");
  const scrolled = [];
  const realDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => ({ scrollIntoView: () => scrolled.push(id) }) };
  try {
    view.clickLine(1).props.onClick();
  } finally {
    globalThis.document = realDocument;
  }
  eq(scrolled, ["pe-sec-sec_img3"], "clicking the image line scrolls to the image's card:");
  ok(view.sectionCards().includes("pe-sec-sec_img3"), `that card carries the anchor: ${view.sectionCards()}`);
  view.press("Move section up", 2); // the image moves above the blank text section
  eq(view.lines().map(textOf), ["section 3: add a heading or some text, or remove this section.", "section 2: choose an image, or remove this section."], "renumbered by the editor, with no new request:");
});

await t("DOC-04: a database failure shows one plain line, not a list of section problems, and the form stays Unsaved", async () => {
  ACTIVE = ZPRO;
  try {
    view = mountEditor({ slug: "ed-dbdown", title: "Page ed-dbdown", sections: [{ id: "sec_dbdown", kind: "text", heading: "H", body: ["x"] }] }, null);
    view.type("Section paragraphs", "Typed while the database is read-only.");
    toasts.length = 0;
    await view.save();
    eq(view.lines().map(textOf), ["We couldn't reach your store's data just now, so nothing was saved. Your changes are still here. Try again in a minute."], "banner:");
    ok(view.unsaved(), "still unsaved:");
    eq(toasts, [], "no success toast:");
    eq(view.field("Section paragraphs").props.value, "Typed while the database is read-only.", "the typing stays:");
  } finally {
    ACTIVE = ZP;
  }
});

// --- guard on what the stand-ins can't see ------------------------------------
console.log("— source guard");

await t("PageEditor saves through sectionsPayload and keeps no filter of its own", async () => {
  const src = await source("components/admin/cms/PageEditor.js");
  ok(/sections: sectionsPayload\(form\.sections\)/.test(src), "buildPayload:");
  ok(/const sections = sectionsPayload\(form\.sections\);/.test(src), "save as template:");
  ok(!/sections\.filter\(\(s\) => !editEmpty/.test(src), "no local drop:");
});

await t("PageEditor copy matches the rule, and each badge shows the number refusals use", async () => {
  const src = await source("components/admin/cms/PageEditor.js");
  ok(!/sections are dropped|dropped on save/i.test(src), "copy no longer says empty sections are dropped:");
  ok(src.includes("A section can't be saved empty"), "copy says a section can't be saved empty:");
  ok(src.includes('placeholder="Heading (optional)"') && !src.includes("Section heading (required)"), "heading placeholder:");
  ok(/<Badge tone="neutral">\s*\{i \+ 1\}\. \{SECTION_LABELS\[s\.kind\]/.test(src), "badge number:");
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) {
  await chmod(join(here, "..", f), 0o644).catch(() => {});
  await rm(join(here, "..", f), { force: true });
}
process.exit(fail ? 1 : 0);
