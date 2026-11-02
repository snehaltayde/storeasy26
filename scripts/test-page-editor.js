// Page editor save path suite (AU-05). The founder's form goes through the
// SAME conversions the editor uses (components/admin/cms/pageSections.js), the
// real handler behind /api/admin/storefront, real requireAdmin and real
// storage, then is read back the way the editor route and the storefront read
// it. Proves that no save reports success while dropping founder content.
//   pnpm test:page-editor
import { readFile, rm } from "node:fs/promises";
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

const dbs = [".test-pageeditor-default.db", ".test-pageeditor-platform.db", ".test-pageeditor-tenant.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const Sess = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { db } = await import("../lib/db.js");
const { handleStorefrontPut } = await import("../lib/admin/cms-api.js");
const { getContentPage, validatePageSections } = await import("../lib/cms/store.js");
const { normalizePageSections } = await import("../lib/cms/schemas.js");
const { componentFor } = await import("../lib/cms/registry.js");
const R = await import("../lib/releases.js");
const { toEdit, sectionsPayload, editEmpty, blankSection } = await import("../components/admin/cms/pageSections.js");
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

const staffU = await I.createUser({ email: "staff@zp.test", password: "staff-pass-au05" });
await I.addMembership(staffU.id, "zp", "staff");
const tok = (await Sess.createSession({ userId: staffU.id, kind: "merchant", ttlMs: 60_000 })).token;

const req = (body) => ({
  cookies: { get: (name) => (name === "_admin" ? { value: tok } : undefined) },
  headers: { get: (k) => ({ host: "zp.test" })[k.toLowerCase()] ?? null },
  json: async () => body,
});
const inT = (fn) => withTenant(ZP, fn);
const put = (body) => inT(() => handleStorefrontPut(req(body)));

// The form the editor holds → exactly what its Save sends.
const form = (...sections) => sections.map((s, i) => ({ id: `s${i}`, ...s }));
const save = (slug, sections, revision = null) => put({ page: { slug, title: `Page ${slug}`, sections: sectionsPayload(sections) }, revision });
const row = (slug) => inT(() => db.selectFrom("cms_pages").selectAll().where("slug", "=", slug).executeTakeFirst());
// Reload = what app/(console)/admin/(authed)/storefront/pages/[slug]/page.js
// hands the editor: the row, normalized, back through the form conversion.
const reload = async (slug) => normalizePageSections(JSON.parse((await row(slug)).sections)).map((s, i) => toEdit(s, `s${i}`));
const content = (sections) => sections.map(({ id, pid, ...rest }) => rest);

// A founder should be able to act on the message. Internals are not plain.
const assertPlain = (message, label = "") => {
  ok(typeof message === "string" && message.length > 0, `${label} has a message:`);
  ok(!/undefined|null|\[object|\bkind\b|\bsrc\b|\bbody\b|\bhtml\b|array|https?:/i.test(message), `${label} plain words only, got "${message}":`);
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
};

await t("text section with neither heading nor paragraphs: refused with a plain message, row untouched", async () => {
  const before = await seed("blank-text");
  const res = await save("blank-text", form(blankSection("text", "n1")), before.revision);
  await refused("blank-text", res, "blank text");
  eq(res.body.error, "section 1: add a heading or some text, or remove this section.", "message:");
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
  ok(res.body.error.startsWith("section 3:"), `position in the message, got "${res.body.error}":`);
  eq(await row("mixed-blank"), before, "row unchanged:");
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
  ok(/choose an image/.test(res.body.error), `says what to do, got "${res.body.error}":`);
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
    ok(/too long/.test(res.body.error), `${label} message, got "${res.body.error}":`);
    assertPlain(res.body.error, label);
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
  const res = await put({ saveTemplate: { name: "Blank", family: "page", sections: sectionsPayload(form(noHeading, blankSection("text", "n1"))) } });
  await refused("template", res, "template");
  ok(res.body.error.startsWith("section 2:"), `position, got "${res.body.error}":`);
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

// --- guards on the two files plain node cannot import -------------------------
console.log("— source guards (not a render: see the manual drill in the packet)");

const source = (rel) => readFile(join(here, "..", rel), "utf8");

await t("PageEditor saves through sectionsPayload and keeps no filter of its own", async () => {
  const src = await source("components/admin/cms/PageEditor.js");
  ok(/sections: sectionsPayload\(form\.sections\)/.test(src), "buildPayload:");
  ok(/const sections = sectionsPayload\(form\.sections\);/.test(src), "save as template:");
  ok(!/sections\.filter\(\(s\) => !editEmpty/.test(src), "no local drop:");
});

await t("ContentPage renders a text heading only when there is one", async () => {
  const src = await source("components/ContentPage.js");
  const h2s = src.match(/.*<h2\b.*/g) || [];
  eq(h2s.length, 2, "h2 count (rich + text):");
  ok(h2s.every((l) => /\{s\.heading \? <h2 [^>]*>\{s\.heading\}<\/h2> : null\}/.test(l)), `every h2 is conditional: ${h2s.join(" | ")}`);
});

// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
