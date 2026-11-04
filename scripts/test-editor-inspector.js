// P3-INSPECTOR suite (ED-12, AU-02, TOK-03, AU-01, ED-04): the inspector's
// forms, prop-driven, with their logic in
// components/admin/editor/fields/inspectorModel.js.
//   1. unit: every registered setting kind has a control, every section kind,
//      document type and singleton a form; an unknown kind is reported.
//   2. rendered (SSR): every form renders for a worst-case body of every
//      registered document type (and every section of it, from worstCase()),
//      plus a broken body of each; every issue's message appears in the notes
//      element named by aria-describedby on the element whose id is
//      fieldAnchor(issue, { known: the ids the form rendered }).
//   3. unit: the menu model adds, reorders, edits and removes items, and its
//      output validates; the ED-12 checklist lists every control of the
//      legacy screens with a mapped field or a named wait.
//   4. rendered: the RichTextField fallback renders its value and
//      readOnlyReason; its file header documents focusRequest; focus places
//      the caret (ED-04) on a stub document.
//   5. the review notes: labels as written ("FAQ"); a rail's suggested
//      collection uses real available counts, never product_count; the
//      design form keeps the accent button text colour in step.
// Everything renders with Next's own SWC and react-dom/server. No database.
//   pnpm test:editor-inspector
import { readFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    return next(spec, ctx);
  },
});

const Reg = await import("../lib/registry/index.js");
const M = await import("../components/admin/editor/fields/inspectorModel.js");
const { SETTING_KINDS } = await import("../lib/registry/settings.js");

let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e.stack || e.message).split("\n").slice(0, 6).join("\n       ")}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m) => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n       expected ${y}\n       got      ${x}`);
};

// ---- the JSX loader (Next's SWC, as test-sections-render does) -------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const exists = (f) => readFile(f).then(
  () => true,
  () => false,
);
const isJsx = (file) => /^components\//.test(relative(ROOT, file));
const seen = new Map();
async function loadJsx(file) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      if (!target.endsWith(".js")) target = (await exists(`${target}.js`)) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}
const FIELDS = join(ROOT, "components/admin/editor/fields");
const SF = await loadJsx(join(FIELDS, "SettingsForm.js"));
const SettingsForm = SF.default;
const DesignForm = (await loadJsx(join(FIELDS, "DesignForm.js"))).default;
const RichTextField = (await loadJsx(join(FIELDS, "RichTextField.js"))).default;
const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

// ---- markup reading ---------------------------------------------------------------
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function tags(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] == null ? "" : unescape(a[2]);
    out.push({ tag: m[1], attrs, index: m.index, end: m.index + m[0].length });
  }
  return out;
}
// The field ids a form rendered: f-… ids that aren't helper ids (--label,
// --notes, --title, --add, --readonly).
const fieldIds = (list) => list.map((x) => x.attrs.id).filter((id) => id && id.startsWith("f-") && !id.includes("--"));
function notesText(html, list, anchor) {
  const el = list.find((x) => x.attrs.id === M.notesId(anchor));
  if (!el) return null;
  ok(el.attrs["data-for"] === anchor, `the notes of ${anchor} say data-for="${el.attrs["data-for"]}"`);
  return unescape(html.slice(el.end, html.indexOf("</div>", el.end)));
}

// Checks one rendered form against the issues it was given. Returns how many
// issues were checked.
function checkPlacement(html, issues, owner, what) {
  const list = tags(html);
  const ids = fieldIds(list);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok(!dup.length, `${what}: ids rendered twice: ${[...new Set(dup)].join(", ")}`);
  const known = new Set(ids);
  let n = 0;
  for (const issue of M.issuesOf(issues, owner)) {
    const anchor = Reg.fieldAnchor(issue, { known });
    const el = list.find((x) => x.attrs.id === anchor);
    ok(el, `${what}: no element with id ${anchor} for ${issue.code} on ${issue.field}`);
    const by = (el.attrs["aria-describedby"] || "").split(/\s+/);
    ok(by.includes(M.notesId(anchor)), `${what}: ${anchor} doesn't name its notes in aria-describedby (${issue.code})`);
    const text = notesText(html, list, anchor);
    ok(text != null && text.includes(issue.message), `${what}: the message of ${issue.code} isn't next to ${anchor}: ${JSON.stringify(issue.message)}`);
    n++;
  }
  return n;
}

// ---- worst-case and broken bodies --------------------------------------------------
const { longText } = await import("../lib/registry/fixtures.js");
// (no code words in the data, so the words check below reads only the form's own)
const LONG = "worst-case-collection-with-a-really-long-name";
// A worst-case value for a document-level setting (fixtures.js fills only
// section settings).
function worstValue(s) {
  switch (s.kind) {
    case "text":
      return longText(Math.min(120, s.max ?? 120));
    case "boolean":
      return true;
    case "choice":
      return s.options[s.options.length - 1];
    case "link":
      return { type: "collection", handle: LONG };
    case "collection_list":
      return Array.from({ length: s.max ?? 1 }, (_, j) => ({ handle: `${LONG}-${j}` }));
    case "product_list":
      return Array.from({ length: s.max ?? 1 }, (_, j) => ({ handle: `worst-case-product-${j}` }));
    case "nav_items":
      return Array.from({ length: s.max ?? 1 }, (_, j) => ({
        label: longText(40),
        link: { type: "collection", handle: LONG },
        ...(j === 0 ? { children: Array.from({ length: 8 }, () => ({ label: longText(40), link: { type: "page", slug: "shipping", family: "page" } })) } : {}),
      }));
    case "brand":
      return { accent: "#7c3aed", background: "#0b0b0f", foreground: "#fafafa", radius: "xl", type_scale: "large", button_shape: "square", section_spacing: "airy" };
    case "theme":
      return { kit: "glow", version: 1 };
    case "entries":
      return [{ slug: "first-post", title: longText(120) }];
    default:
      return s.default ?? null;
  }
}
// A value that breaks a setting of each kind (or null when the kind can't
// be broken by value alone).
function brokenValue(s) {
  switch (s.kind) {
    case "text":
      return s.max != null ? "x".repeat(s.max + 5) : 42;
    case "number":
      return s.max != null ? s.max + 10 : "many";
    case "boolean":
      return "yes";
    case "choice":
      return "not-a-choice";
    case "rich_text":
      return 7;
    case "paragraphs":
      return ["fine", "y".repeat((s.maxEach ?? 10) + 1), 3];
    case "qa_list":
      return [{ q: "", a: "" }, { q: "What?", a: "<p>Yes</p>", extra: 1 }, "junk"];
    case "link":
      return { type: "url", href: "https://elsewhere.example/x" };
    case "cta":
      return { label: "z".repeat(50), link: { type: "page", slug: "Bad Slug", family: "nowhere" } };
    case "image":
      return { media: "http://insecure.example/a.jpg", alt: "" };
    case "collection":
      return { handle: "Not A Handle" };
    case "product":
      return { handle: "Bad Handle", id: 9 };
    case "collection_list":
    case "product_list":
      return [{ handle: "ok-one" }, { handle: "BAD" }, "junk"];
    case "nav_items":
      return [
        { label: "", link: null },
        { label: "Shop", link: { type: "url", href: "//evil.example" }, children: [{ label: "Deep", link: { type: "product", handle: "x" }, children: [] }, { label: "", link: { type: "page", slug: "ok", family: "page" } }] },
      ];
    case "brand":
      return { accent: "lime", radius: "huge", sparkle: true };
    case "theme":
      return { kit: "nope", version: 9 };
    case "entries":
      return "junk";
    default:
      return null;
  }
}

let idn = 0;
const freshId = () => `sec_w${(idn++).toString(36)}`;
function sectionsFor(type) {
  return Reg.allowedKinds(type).flatMap((kind) => Reg.worstCase(kind).cases.map((c) => ({ ...c.section, id: freshId() })));
}
function worstBody(type) {
  const d = Reg.documentType(type);
  const body = Reg.emptyBody(type);
  if (d.route) Object.assign(body.meta, { slug: "worst-case", title: longText(120), description: longText(300), window_start: "2026-01-01T00:00:00.000Z", window_end: "2026-12-31T00:00:00.000Z", redirect_from: ["old-one", "old-two"] });
  if (d.settings.length) body.settings = Object.fromEntries(d.settings.map((s) => [s.key, worstValue(s)]));
  if (d.sections) body.sections = Reg.fixtureDocument(type, sectionsFor(type)).sections;
  return body;
}
function brokenBody(type) {
  const d = Reg.documentType(type);
  const body = Reg.emptyBody(type);
  if (d.route) Object.assign(body.meta, { slug: "Not OK", title: "", description: "d".repeat(320), window_start: "2026-12-31T00:00:00.000Z", window_end: "2026-01-01T00:00:00.000Z", redirect_from: ["Bad One"], colour: "x" });
  if (d.settings.length) body.settings = { ...Object.fromEntries(d.settings.map((s) => [s.key, brokenValue(s)])), mystery: 1 };
  if (d.sections) {
    body.sections = Reg.allowedKinds(type).map((kind) => {
      const decl = Reg.sectionType(kind);
      const s = Reg.newSection(kind, { id: freshId() });
      for (const st of decl.settings) s.settings[st.key] = brokenValue(st);
      s.settings.unknown_thing = "x";
      return s;
    });
    // a section of a kind the type doesn't take, and one of no kind at all
    body.sections.push({ ...Reg.newSection("product_main", { id: freshId() }) }, { id: freshId(), kind: "mystery", v: 1, settings: {} });
  }
  return body;
}
const issuesFor = (body) => [...Reg.validateDocument(body, { mode: "draft" }).issues, ...Reg.validateDocument(body, { mode: "publish" }).issues];
const CATALOG = {
  collections: [
    { handle: "summer", id: "gid://shopify/Collection/1", title: "Summer", product_count: 12 },
    { handle: "basics", id: "gid://shopify/Collection/2", title: "Basics", available_count: 5, product_count: 9 },
  ],
  products: [{ handle: "tee", id: "gid://shopify/Product/1", title: "Tee" }],
  pages: [{ slug: "shipping", family: "page", title: "Shipping", document: "doc_abc" }],
};

// ============================== 1. coverage =======================================
console.log("1. every kind has a control, every kind and type a form");

await t("unit: every registered setting kind maps to a control, and every control name to a component", () => {
  eq(M.inspectorCoverage(), [], "inspectorCoverage()");
  for (const kind of Object.keys(SETTING_KINDS)) ok(M.controlKindOf(kind), `setting kind ${kind} has no control`);
  eq([...Object.keys(SF.CONTROL_COMPONENTS)].sort(), [...M.CONTROL_NAMES].sort(), "the components are exactly the control names");
  for (const [name, C] of Object.entries(SF.CONTROL_COMPONENTS)) ok(typeof C === "function", `control ${name} is not a component`);
});

await t("unit: an unknown setting kind is a coverage failure, and has no control", () => {
  const problems = M.inspectorCoverage({ kinds: { ...SETTING_KINDS, sparkle: { control: "sparkle" } } });
  ok(problems.some((p) => p.includes('"sparkle"') && p.includes("no control")), `an unmapped kind wasn't reported: ${JSON.stringify(problems)}`);
  const { entries: _gone, ...fewer } = M.CONTROL_OF_KIND;
  ok(M.inspectorCoverage({ controls: fewer }).some((p) => p.includes('"entries"')), "a kind dropped from the map wasn't reported");
  ok(M.inspectorCoverage({ controls: { ...M.CONTROL_OF_KIND, ghost: "text" } }).some((p) => p.includes('"ghost"')), "a stale entry wasn't reported");
  eq(M.controlKindOf("sparkle"), null, "controlKindOf of an unknown kind");
  eq(M.controlKindOf("constructor"), null, "controlKindOf ignores prototype names");
  eq(M.formOf({ kind: "sparkle" }), null, "formOf an unknown section kind");
  eq(M.formOf({ type: "sparkle" }), null, "formOf an unknown document type");
});

await t("unit: every section kind and every document type (every singleton) has a form", () => {
  const expected = {
    announcement: "settings",
    header: "menu",
    footer: "menu",
    design: "design",
    home: "sections",
    collections_index: "settings",
    product_layout: "settings",
    collection_layout: "settings",
    cart: "settings",
    page: "page",
    campaign: "page",
    journal: "page",
    journal_index: "system",
    product_content: "sections",
  };
  for (const type of Reg.documentTypeNames()) {
    const f = M.formOf({ type });
    ok(f, `no form for ${type}`);
    ok(Object.hasOwn(expected, type), `document type ${type} is new: add it to this test with its form`);
    eq(f.form, expected[type], `the form of ${type}`);
    eq(f.fields.map((x) => x.key), Reg.documentType(type).settings.map((s) => s.key), `${type}: one field per setting`);
    if (Reg.documentType(type).route) eq(f.meta.map((x) => x.path), ["meta.title", "meta.slug", "meta.description", "meta.enabled", "meta.effective_at", "meta.window_start", "meta.window_end", "meta.redirect_from"], `${type}: details`);
  }
  for (const type of Reg.singletonTypes()) ok(M.formOf({ type }), `singleton ${type} has no form`);
  for (const kind of Reg.sectionKinds()) {
    const f = M.formOf({ kind, sectionId: "sec_x1" });
    ok(f, `no form for section ${kind}`);
    eq(f.form, Reg.sectionType(kind).protected ? "protected" : "settings", `the form of ${kind}`);
    eq(f.label, Reg.sectionType(kind).label, `${kind}: the label as written`);
    for (const field of f.fields) eq(field.anchor, Reg.anchorFor("sec_x1", field.key), `${kind}.${field.key}: the field id is the anchor`);
  }
  eq(M.formOf({ type: "cart" }).waits != null && M.formOf({ type: "product_content" }).waits != null, true, "cart and product content say what they wait for");
});

// ============================== 2. rendered forms ==================================
console.log("2. every form renders for a worst case of every type; each message sits at its field");

const codesSeen = new Set();
const controlsRendered = new Set();
let checked = 0;
function renderAll(type, body, label) {
  const issues = issuesFor(body);
  for (const i of issues) codesSeen.add(i.code);
  // the document's own form
  const html = render(h(SettingsForm, { type, value: body, issues, onChange: () => {}, context: CATALOG }));
  ok(html.includes(`id="f-doc"`), `${label}: the document form has no root id`);
  checked += checkPlacement(html, issues, null, `${label} document`);
  const f = M.formOf({ type });
  const known = new Set(fieldIds(tags(html)));
  for (const field of [...f.meta, ...f.fields]) {
    const v = field.path.startsWith("meta.") ? M.getAt(body, field.path) : body.settings?.[field.key];
    for (const a of M.anchorsOf(field, v ?? null, null)) ok(known.has(a), `${label}: ${field.path} should render ${a}`);
    controlsRendered.add(field.control);
  }
  // each section's form
  for (const s of Array.isArray(body.sections) ? body.sections : []) {
    if (!s || typeof s.id !== "string") continue;
    const shtml = render(h(SettingsForm, { kind: s.kind, sectionId: s.id, value: s.settings, issues, onChange: () => {}, context: CATALOG }));
    const decl = Reg.sectionType(s.kind);
    if (!decl) {
      ok(unescape(shtml).includes("can't be edited here"), `${label}: an unknown section kind should say it can't be edited`);
      continue;
    }
    ok(shtml.includes(`id="${Reg.fieldAnchor({ sectionId: s.id, field: null })}"`), `${label}: section ${s.kind} has no root id`);
    checked += checkPlacement(shtml, issues, s.id, `${label} ${s.kind} ${s.id}`);
    const sknown = new Set(fieldIds(tags(shtml)));
    for (const field of M.formOf({ kind: s.kind, sectionId: s.id }).fields) {
      for (const a of M.anchorsOf(field, s.settings?.[field.key] ?? null, s.id)) ok(sknown.has(a), `${label} ${s.kind}: ${field.path} should render ${a}`);
      controlsRendered.add(field.control);
    }
  }
}

await t("rendered: a setting kind no registered section uses yet (product) renders through the registry", () => {
  Reg.defineSection({ kind: "zz_probe", version: 1, label: "Probe", documentTypes: ["page"], settings: [{ key: "pick", kind: "product", label: "Product" }] });
  try {
    const s = Reg.newSection("zz_probe", { id: "sec_probe1" });
    renderAll("page", Reg.fixtureDocument("page", [s]), "probe empty");
    s.settings.pick = { handle: "Bad Handle", id: 7 };
    renderAll("page", Reg.fixtureDocument("page", [s]), "probe broken");
    s.settings.pick = { handle: "tee", id: "gid://shopify/Product/1" };
    renderAll("page", Reg.fixtureDocument("page", [s]), "probe picked");
  } finally {
    Reg.removeSection("zz_probe");
  }
});

for (const type of Reg.documentTypeNames()) {
  await t(`rendered: ${type}, worst case (every section kind's worstCase() cases) and broken`, () => {
    renderAll(type, worstBody(type), `${type} worst`);
    renderAll(type, brokenBody(type), `${type} broken`);
    // a menu left on automatic with items in it (the registry warns)
    if (type === "header" || type === "footer") renderAll(type, { ...worstBody(type), settings: { ...worstBody(type).settings, mode: "auto" } }, `${type} automatic`);
  });
}

await t("rendered: the checks covered every control and a wide spread of issue codes", () => {
  for (const name of M.CONTROL_NAMES) ok(controlsRendered.has(name), `no form rendered the ${name} control`);
  for (const code of ["TOO_LONG", "REQUIRED", "LINK_NOT_STOREFRONT", "LINK_INVALID", "IMAGE_INVALID", "UNKNOWN_FIELD", "INVALID_CHOICE", "OUT_OF_RANGE", "TOO_DEEP", "BRAND_INVALID", "THEME_INVALID", "SLUG_INVALID", "WINDOW_INVALID", "KIND_NOT_ALLOWED", "UNKNOWN_KIND", "ITEMS_NOT_SHOWN"])
    ok(codesSeen.has(code), `no body produced ${code}`);
  ok(checked > 300, `only ${checked} issues were checked`);
  console.log(`       ${checked} issues checked at their fields, ${codesSeen.size} codes`);
});

await t("rendered: the hero's highlight note sits on its title field (AU-02)", () => {
  const s = Reg.newSection("hero", { id: "sec_hero1" });
  s.settings.highlight = "nowhere";
  const body = Reg.fixtureDocument("home", [s]);
  const issues = issuesFor(body).filter((i) => i.code === "HIGHLIGHT_NOT_IN_TITLE");
  ok(issues.length, "no highlight note");
  const html = render(h(SettingsForm, { kind: "hero", sectionId: "sec_hero1", value: s.settings, issues, onChange: () => {} }));
  eq(Reg.fieldAnchor(issues[0], { known: new Set(fieldIds(tags(html))) }), "f-sec_hero1-title", "the anchor");
  checkPlacement(html, issues, "sec_hero1", "hero");
});

await t("rendered: labels are shown as written (FAQ, not faq), with no code words", () => {
  const s = Reg.newSection("faq", { id: "sec_faq1" });
  const html = render(h(SettingsForm, { kind: "faq", sectionId: "sec_faq1", value: s.settings, issues: [], onChange: () => {} }));
  ok(/>FAQ</.test(html), "the FAQ heading isn't as written");
  ok(!/\bfaq\b/.test(html.replace(/(id|for|aria-[a-z]+|data-[a-z]+)="[^"]*"/g, "")), "a lower-cased label appears");
  for (const type of Reg.documentTypeNames()) {
    const text = render(h(SettingsForm, { type, value: worstBody(type), issues: [], onChange: () => {}, context: CATALOG })).replace(/<[^>]+>/g, " ");
    for (const w of ["CTA", "href", "handle", "slug"]) ok(!new RegExp(`\\b${w}\\b`).test(text), `${type}: the form shows the word ${w}`);
  }
});

await t("rendered: a read-only form says why and disables its controls", () => {
  const body = worstBody("announcement");
  const html = render(h(SettingsForm, { type: "announcement", value: body, issues: [], onChange: () => {}, readOnlyReason: "Only the owner can change the announcement bar." }));
  ok(html.includes("Only the owner can change the announcement bar."), "the reason isn't shown");
  ok(/id="f-doc-text"[^>]*disabled=""|disabled=""[^>]*id="f-doc-text"/.test(html), "the text box isn't disabled");
});

await t("unit: the value helpers: setAt gives a new value with one path changed", () => {
  const settings = { title: "Old", limit: 4 };
  eq(M.setAt(settings, "title", "New"), { title: "New", limit: 4 }, "setAt on a section");
  eq(settings.title, "Old", "the old value is untouched");
  eq(M.setAt({ settings: { items: [{ label: "a" }] } }, "settings.items.0.label", "b"), { settings: { items: [{ label: "b" }] } }, "setAt into a list");
  eq(M.setAt({ meta: { title: "x" } }, "meta.title", "y"), { meta: { title: "y" } }, "setAt on meta");
  eq(M.getAt({ a: [{ b: 3 }] }, "a.0.b"), 3, "getAt");
  eq(M.numberFrom(""), null, "an empty number is null");
  eq(M.numberFrom("7"), 7, "a number");
  eq(M.numberFrom("seven"), "seven", "text stays as typed");
});

// ============================== 3. the menu and the checklist =========================
console.log("3. the menu model, and the ED-12 checklist");

const headerBody = (settings) => ({ ...Reg.emptyBody("header"), settings: { mode: "custom", template: "standard", ...settings } });
await t("unit: the menu model adds, reorders, edits and removes items, and its output validates", () => {
  let items = [];
  items = M.menu.add(items);
  items = M.menu.add(items);
  eq(items, [{ label: "", link: null }, { label: "", link: null }], "two blank items");
  // a blank item is unfinished, not broken: it saves as a draft
  const draft = Reg.validateDocument(headerBody({ items }), { mode: "draft" });
  ok(draft.ok, `blank items should save as a draft: ${JSON.stringify(draft.issues.map((i) => i.code))}`);
  ok(draft.issues.every((i) => i.severity === "incomplete"), "blank items should be incomplete");
  items = M.menu.edit(items, [0], { label: "Shop", link: { type: "collection", handle: "summer" } });
  items = M.menu.edit(items, [1], { label: "Help", link: { type: "page", slug: "shipping", family: "page" } });
  items = M.menu.addChild(items, 0);
  items = M.menu.addChild(items, 0);
  items = M.menu.edit(items, [0, 0], { label: "Tees", link: { type: "product", handle: "tee" } });
  items = M.menu.edit(items, [0, 1], { label: "Sale", link: { type: "url", href: "/collections/sale" } });
  items = M.menu.move(items, [0, 1], -1);
  eq(items[0].children.map((c) => c.label), ["Sale", "Tees"], "sub-items reorder");
  items = M.menu.move(items, [1], -1);
  eq(items.map((i) => i.label), ["Help", "Shop"], "items reorder");
  eq(M.menu.move(items, [0], -1), items, "moving the first item up changes nothing");
  const live = Reg.validateDocument(headerBody({ items }), { mode: "publish" });
  ok(live.ok && live.issues.length === 0, `the menu should publish clean: ${JSON.stringify(live.issues.map((i) => `${i.code}@${i.field}`))}`);
  items = M.menu.remove(items, [1, 0]);
  eq(items[1].children.map((c) => c.label), ["Tees"], "a sub-item is removed");
  items = M.menu.remove(items, [1, 0]);
  ok(!("children" in items[1]), "an item with no sub-items left has no children list");
  items = M.menu.addChild(items, 1);
  items = M.menu.remove(items, [1]);
  eq(items.map((i) => i.label), ["Help"], "an item goes with its sub-items");
  ok(Reg.validateDocument(headerBody({ items }), { mode: "publish" }).ok, "still publishes");
  // the footer too
  ok(Reg.validateDocument({ ...Reg.emptyBody("footer"), settings: { mode: "custom", template: "minimal", items } }, { mode: "publish" }).ok, "a footer menu publishes");
});

await t("unit: the menu limits are the legacy screen's (12 items, 8 sub-items) and the notes are plain", () => {
  let items = [];
  for (let i = 0; i < 15; i++) items = M.menu.add(items);
  eq(items.length, 12, "at most 12 items");
  for (let i = 0; i < 10; i++) items = M.menu.addChild(items, 3);
  eq(items[3].children.length, 8, "at most 8 sub-items");
  const auto = M.menu.view({ mode: "auto", items }, "header");
  ok(auto.auto && auto.keptNote && !auto.canAdd, "automatic with items keeps them and says so");
  const empty = M.menu.view({ mode: "custom", items: [] }, "footer");
  ok(empty.emptyNote && empty.autoText.includes("top 5"), "an empty custom footer says shoppers see no menu");
  const warn = Reg.validateDocument(headerBody({ mode: "auto", items: [{ label: "A", link: { type: "collection", handle: "a" } }] }), { mode: "draft" }).issues;
  ok(warn.some((i) => i.code === "ITEMS_NOT_SHOWN"), "the registry warns too");
});

await t("rendered: the menu control renders every item, sub-item and link with its anchor", () => {
  const items = [
    { label: "Shop", link: { type: "collection", handle: "summer" }, children: [{ label: "Tees", link: { type: "product", handle: "tee" } }] },
    { label: "Help", link: { type: "page", slug: "shipping", family: "page" } },
    { label: "Sale", link: { type: "url", href: "/collections/sale" } },
  ];
  const html = render(h(SettingsForm, { type: "header", value: headerBody({ items }), issues: [], onChange: () => {}, context: CATALOG }));
  const ids = new Set(fieldIds(tags(html)));
  for (const a of ["f-doc-mode", "f-doc-items", "f-doc-items-0", "f-doc-items-0-label", "f-doc-items-0-link", "f-doc-items-0-link-handle", "f-doc-items-0-children", "f-doc-items-0-children-0-link-handle", "f-doc-items-1-link-slug", "f-doc-items-1-link-family", "f-doc-items-2-link-href", "f-doc-template"])
    ok(ids.has(a), `missing ${a}`);
  ok(html.includes("Add a sub-item (1/8)") && html.includes("Add an item (3/12)"), "the counts are shown");
  ok(html.includes("Standard: logo on the left"), "the layout choice words");
});

// The ED-12 checklist (docs/cms-reviews/P3-ED12-CHECKLIST.md): every control
// element of today's screens, found by scanning their source, is cited by a
// row; every row cites a real control line; a "field" row names a field the
// new forms really have; a "waits" row names what it waits for.
const LEGACY = {
  "components/admin/cms/NavigationEditor.js": [[1, 999]],
  "components/admin/cms/HomeEditor.js": [
    [119, 150],
    [278, 300],
    [390, 405],
    [597, 712],
    [724, 752],
  ],
  "components/admin/cms/PdpExtrasEditor.js": [[1, 999]],
  "components/admin/cms/SurfaceTemplatesCard.js": [[1, 999]],
  "components/admin/cms/Designer.js": [[888, 919]],
  "components/admin/BrandAdmin.js": [[1, 999]],
  "components/admin/ThemeAdmin.js": [[1, 999]],
};
const CONTROL_LINE = /<(Input|Textarea|Select|Switch|Button|IconButton|ManualAdd|CollectionPicker|ProductPicker|ConfirmDialog|ConflictBanner|input|select|textarea|button)\b/;
const STATUSES = new Set(["field", "tree", "shell", "elsewhere", "waits"]);
await t("unit: the ED-12 checklist lists every legacy control with a mapped field or a named wait", async () => {
  const doc = await readFile(join(ROOT, "docs/cms-reviews/P3-ED12-CHECKLIST.md"), "utf8");
  const rows = [];
  for (const line of doc.split("\n")) {
    const m = /^\|\s*`([^`:]+):(\d+)`\s*\|([^|]*)\|\s*(\w+)\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (m) rows.push({ file: m[1], line: Number(m[2]), control: m[3].trim(), status: m[4], target: m[5].trim(), note: m[6].trim() });
  }
  ok(rows.length > 50, `only ${rows.length} checklist rows were read`);
  const inventory = new Set();
  for (const [file, ranges] of Object.entries(LEGACY)) {
    const lines = (await readFile(join(ROOT, file), "utf8")).split("\n");
    lines.forEach((text, i) => {
      const n = i + 1;
      if (ranges.some(([a, b]) => n >= a && n <= b) && CONTROL_LINE.test(text)) inventory.add(`${file}:${n}`);
    });
  }
  const cited = new Set(rows.map((r) => `${r.file}:${r.line}`));
  const missing = [...inventory].filter((k) => !cited.has(k));
  ok(!missing.length, `legacy controls with no checklist row: ${missing.join(", ")}`);
  const stray = rows.filter((r) => !inventory.has(`${r.file}:${r.line}`));
  ok(!stray.length, `rows that cite no control line: ${stray.map((r) => `${r.file}:${r.line}`).join(", ")}`);
  for (const r of rows) {
    const at = `${r.file}:${r.line}`;
    ok(STATUSES.has(r.status), `${at}: unknown status ${r.status}`);
    ok(r.control, `${at}: no control words`);
    if (r.status === "field") {
      // "<type or section kind>: <path>[, <path>…]"
      const m = /^`?([a-z_]+)`?:\s*(.+)$/.exec(r.target);
      ok(m, `${at}: a field row must name "<type or kind>: <path>", got ${r.target}`);
      const form = Reg.documentType(m[1]) ? M.formOf({ type: m[1] }) : M.formOf({ kind: m[1] });
      ok(form, `${at}: ${m[1]} has no form`);
      for (const p of m[2].split(",").map((x) => x.replace(/`/g, "").trim())) {
        const head = p.startsWith("meta.") ? p.split(".").slice(0, 2).join(".") : p.split(/[.[]/)[0];
        ok([...(form.meta || []), ...form.fields].some((f) => f.path === head), `${at}: ${m[1]} has no field ${head} (from ${p})`);
      }
    } else if (r.status === "waits") ok(/OVL-02|capability|no .*type|collection content/i.test(`${r.target} ${r.note}`), `${at}: a wait must name what it waits for`);
    else if (r.status === "tree") ok(/P3-TREE/.test(r.target), `${at}: a tree row names P3-TREE`);
    else if (r.status === "shell") ok(/P3-(STORE|EDITOR|PUBLISHUI)/.test(r.target), `${at}: a shell row names the item that owns it`);
    else ok(/P3-[A-Z]+/.test(r.target), `${at}: an elsewhere row names the item that owns it`);
  }
  for (const type of ["collections_index", "header", "footer", "announcement", "product_layout", "collection_layout", "design"]) ok(rows.some((r) => r.status === "field" && r.target.startsWith(`${type}:`) || r.target.startsWith(`\`${type}\`:`)), `no field row maps to ${type}`);
  for (const w of ["cart", "product content", "collection content"]) ok(new RegExp(w, "i").test(doc), `the checklist doesn't record the ${w} wait`);
  console.log(`       ${rows.length} rows, ${inventory.size} legacy controls`);
});

// ============================== 4. rich text and focus ===================================
console.log("4. the RichTextField fallback, and focus");

await t("rendered: the RichTextField fallback renders its value, and readOnlyReason read-only", () => {
  const html = render(h(RichTextField, { id: "f-sec_r1-html", label: "Content", value: "<p>Hello &amp; welcome</p><h2>Sizes</h2>", onChange: () => {}, issues: [] }));
  ok(html.includes('id="f-sec_r1-html"'), "the id is the anchor");
  ok(unescape(html).includes("<p>Hello &amp; welcome</p><h2>Sizes</h2>"), "the stored value is shown exactly");
  ok(!/readonly=""/i.test(html), "an editable field is not read-only");
  const ro = render(h(RichTextField, { id: "f-sec_r1-html", label: "Content", value: "<table><tr><td>1</td></tr></table>", onChange: () => {}, issues: [{ message: "Check this table.", severity: "warning" }], readOnlyReason: "This has a table, which this editor can't change yet." }));
  ok(/readOnly=""|readonly=""/.test(ro), "the field is read-only");
  ok(ro.includes("This has a table, which this editor can&#x27;t change yet."), "the reason is shown");
  const list = tags(ro);
  const box = list.find((x) => x.attrs.id === "f-sec_r1-html");
  ok(box.attrs["aria-describedby"].includes("f-sec_r1-html--notes") && box.attrs["aria-describedby"].includes("f-sec_r1-html--readonly"), "the notes and the reason are named by aria-describedby");
  ok(notesText(ro, list, "f-sec_r1-html").includes("Check this table."), "the issue is shown at the field");
});

await t("unit: focusRequest is part of the RichTextField props contract (file header)", async () => {
  const src = await readFile(join(FIELDS, "RichTextField.js"), "utf8");
  const header = src.slice(0, src.indexOf("import "));
  for (const prop of ["value", "onChange(html)", "issues", "focusRequest", "readOnlyReason", "id", "label"]) ok(header.includes(prop), `the header doesn't document ${prop}`);
  ok(/focusRequest\s+\{ path, offset\? \}/.test(header) && /offset 2 puts the caret at the start\s*\/\/\s*of the third/.test(header.replace(/\n\/\/\s+/g, "\n// ")), "the header doesn't say what offset means");
  ok(/THE INTERFACE IS FINAL/.test(header), "the header doesn't say the interface is final");
  ok(!/sanitize/.test(src.slice(src.indexOf("import "))), "the field must not sanitize on the client");
});

await t("unit: focus goes to the closest rendered field and the caret to the block (ED-04)", () => {
  const known = new Set(["f-sec_t1", "f-sec_t1-title", "f-sec_t1-body", "f-sec_t1-body-0", "f-sec_t1-body-1"]);
  eq(M.focusAnchor({ path: "body.1" }, { sectionId: "sec_t1", known }), "f-sec_t1-body-1", "a paragraph");
  eq(M.focusAnchor({ path: "body.7" }, { sectionId: "sec_t1", known }), "f-sec_t1-body", "a paragraph not rendered falls back to its list");
  eq(M.focusAnchor({ path: "meta.title" }, {}), "f-doc-meta-title", "a page title");
  eq(M.focusAnchor(null), null, "no request");
  const html = "<p>One</p><h2>Two <em>a</em></h2><ul><li>x</li></ul><p>Four<br>line</p>";
  eq(M.blockStart(html, 0), 0, "block 0");
  eq(M.blockStart(html, 2), html.indexOf("<ul>"), "offset 2 is the third block child");
  eq(M.blockStart(html, 3), html.indexOf("<p>Four"), "a <br> inside a block doesn't count");
  eq(M.blockStart(html, 9), html.length, "past the end");
  eq(M.blockStart(html, undefined), null, "no offset");
  const calls = [];
  const el = { value: "Hello", focus: () => calls.push("focus"), scrollIntoView: () => calls.push("scroll"), setSelectionRange: (a, b) => calls.push(`caret ${a}-${b}`) };
  const doc = { getElementById: (id) => (id === "f-sec_t1-title" ? el : null) };
  ok(M.applyFocus(doc, "f-sec_t1-title", 99), "focused");
  eq(calls, ["scroll", "focus", "caret 5-5"], "scrolled, focused, caret clamped");
  ok(!M.applyFocus(doc, "f-nowhere", 0), "a missing element is not focused");
});

// ============================== 5. review notes and the design form ===========================
console.log("5. the review notes, and the design form");

await t("unit: a rail's suggestion uses real available counts, never product_count (P3-VALIDATE review)", () => {
  // summer has 12 products and no available count; basics 5 available
  eq(M.railSuggestion(CATALOG.collections, 3)?.handle, "basics", "the one with a known count of 3 or more");
  eq(M.availableOf({ product_count: 12 }), null, "product_count is not an available count");
  eq(M.availableOf({ available_count: 0 }), 0, "zero is a real count");
  // all sold out (available 0) against unknown: the unknown one that holds products
  eq(M.railSuggestion([{ handle: "gone", available_count: 0, product_count: 9 }, { handle: "maybe", product_count: 2 }], 3)?.handle, "maybe", "unknown beats sold out");
  const html = render(h(SettingsForm, { kind: "product_rail", sectionId: "sec_rail1", value: { title: "Rail", collection: null, limit: 8 }, issues: [], onChange: () => {}, context: CATALOG }));
  ok(html.includes("Use Basics"), "the empty rail suggests Basics");
  ok(html.includes("Basics (5 available)") && html.includes(">Summer<"), "the picker shows counts only where they are known");
});

await t("unit: the design form keeps the accent button text in step and can go back to the default", () => {
  const b1 = M.design.setToken(null, "accent", "#1d4ed8");
  eq(b1.accent, "#1d4ed8", "the accent is set on a copy of the default");
  eq(b1.background, "#ffffff", "the rest is the platform default");
  const Brand = (v) => Reg.validateDocument({ ...Reg.emptyBody("design"), settings: { brand: v, theme: null } }, { mode: "draft" });
  ok(Brand(b1).ok, "the new brand saves");
  const dark = M.design.setToken({ ...b1, accent_label: "#ffffff" }, "accent", "#fde047");
  eq(dark.accent_label, "#0a0a0b", "a light accent gets dark button text (the stale white is replaced)");
  const half = M.design.setToken(dark, "accent", "#fde");
  ok(!("accent_label" in half), "a half-typed colour drops the worked-out label");
  eq(M.design.reset(), null, "back to the default brand");
  eq(M.design.setLook({ kit: "pulse", version: 1, applied_at: "x" }, "glow-1"), { kit: "glow", version: 1 }, "a look");
  eq(M.design.setLook({ kit: "pulse", version: 1 }, "nope-3"), { kit: "pulse", version: 1 }, "an unknown look changes nothing");
});

await t("rendered: the design form shows every token, the look, the default note and readability notes at the brand", () => {
  const body = { ...Reg.emptyBody("design"), settings: { brand: null, theme: null } };
  const html = render(h(DesignForm, { value: body, issues: [], onChange: () => {} }));
  for (const k of ["accent", "background", "foreground", "radius", "type_scale", "button_shape", "section_spacing"]) ok(html.includes(`id="f-doc-brand-${k}"`), `no ${k}`);
  ok(html.includes('id="f-doc-theme"') && html.includes("platform&#x27;s default brand"), "the look and the default note");
  // an unreadable pair on publish lands on the brand group
  const bad = { ...Reg.emptyBody("design"), settings: { brand: { ...M.design.setToken(null, "foreground", "#fefefe") }, theme: { kit: "pulse", version: 1 } } };
  const issues = Reg.validateDocument(bad, { mode: "publish" }).issues;
  ok(issues.some((i) => i.code === "BRAND_UNREADABLE"), `expected a readability issue: ${issues.map((i) => i.code)}`);
  const shown = render(h(SettingsForm, { type: "design", value: bad, issues, onChange: () => {} }));
  checkPlacement(shown, issues, null, "design");
  ok(shown.includes("Go back to the platform"), "a custom brand can go back to the default");
});

// ============================== fix round 1 =======================================
console.log("fix round 1: a page link never keeps another page's document id");

// Drive the real LinkControl: a host renders it as a plain call, so its hooks are
// the host's, and the element tree it returns can be searched for a control's
// onChange. Each "event" re-renders with the stored value, as the editor does.
const Controls = await loadJsx(join(FIELDS, "controls.js"));
function driveLink(props) {
  let tree = null;
  const Host = () => {
    tree = Controls.LinkControl(props);
    return null;
  };
  render(h(Host));
  const find = (node, id) => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const f = find(n, id);
        if (f) return f;
      }
      return null;
    }
    if (node.props?.id === id && typeof node.props.onChange === "function") return node.props;
    return find(node.props?.children, id);
  };
  return (id) => find(tree, id);
}

await t("unit+driven: changing the kind of page drops or looks up the document id again", () => {
  const pages = [
    { slug: "shipping", family: "page", document: "doc_ship" },
    { slug: "shipping", family: "journal", document: "doc_jship" },
  ];
  // the pure lookup
  eq(M.pageLinkTarget(pages, "shipping", "page"), { slug: "shipping", family: "page", document: "doc_ship" }, "a known page");
  eq(M.pageLinkTarget(pages, "shipping", "campaign"), { slug: "shipping", family: "campaign" }, "no such campaign: no document");
  eq(M.pageLinkTarget(pages, "shipping", "journal"), { slug: "shipping", family: "journal", document: "doc_jship" }, "the journal post's own id");
  eq(M.pageLinkTarget(undefined, " shipping ", "page"), { slug: "shipping", family: "page" }, "no pages given");
  // the real control
  const stored = [];
  const at = (value) => driveLink({ owner: null, path: "items.0.link", label: "Link", value, onChange: (v) => stored.push(v), issues: [], context: { pages } });
  at({ type: "page", slug: "", family: "page" })("f-doc-items-0-link-slug").onChange("shipping");
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "page", document: "doc_ship" }, "typing the slug attaches the page's id");
  at(stored.at(-1))("f-doc-items-0-link-family").onChange({ target: { value: "campaign" } });
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "campaign" }, "a campaign called shipping doesn't exist: the stale id is dropped");
  at(stored.at(-1))("f-doc-items-0-link-family").onChange({ target: { value: "journal" } });
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "journal", document: "doc_jship" }, "the journal post's id is looked up");
  at(stored.at(-1))("f-doc-items-0-link-family").onChange({ target: { value: "page" } });
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "page", document: "doc_ship" }, "back to the page's own id");
});

await t("P3-FIX3 unit+driven: typing a web name while the link is a Campaign or a Journal post keeps that kind and that page's own id", () => {
  const pages = [
    { slug: "shipping", family: "page", document: "doc_ship" },
    { slug: "shipping", family: "journal", document: "doc_jship" },
    { slug: "spring", family: "campaign", document: "doc_spring" },
  ];
  const stored = [];
  const at = (value) => driveLink({ owner: null, path: "items.0.link", label: "Link", value, onChange: (v) => stored.push(v), issues: [], context: { pages } });
  at({ type: "page", slug: "", family: "campaign" })("f-doc-items-0-link-slug").onChange("spring");
  eq(stored.at(-1), { type: "page", slug: "spring", family: "campaign", document: "doc_spring" }, "a campaign: its kind and its id");
  at({ type: "page", slug: "", family: "journal" })("f-doc-items-0-link-slug").onChange("shipping");
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "journal", document: "doc_jship" }, "a journal post: its kind and its own id, not the page's");
  at({ type: "page", slug: "spring", family: "campaign", document: "doc_spring" })("f-doc-items-0-link-slug").onChange("shipping");
  eq(stored.at(-1), { type: "page", slug: "shipping", family: "campaign" }, "no campaign at that name: the kind stays, the old id is dropped");
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${failures.length} failed in ${seconds} s`);
if (failures.length) {
  console.log(`Failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
