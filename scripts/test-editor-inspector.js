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
//   6. P5-EDITOR (COM-01, COM-02): the bundle picker. bundle and bundle_list
//      have controls; each state's status line is the bundle-words sentence
//      by the blocks' own rule; a pick writes { id } only; a grid keeps its
//      order and refuses a duplicate; notes land on the control or its row.
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
    // P5-EDITOR: an old { id, title } pick (UNKNOWN_FIELD), and a grid with
    // a duplicate, an unreadable entry and a bad id (INVALID_VALUE by index)
    case "bundle":
      return { id: "bun-old", title: "Old name" };
    case "bundle_list":
      return [{ id: "bun-a" }, { id: "bun-a" }, "junk", { id: "bad id!" }];
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
  // P5-EDITOR: the bundle picker's rows (GET /api/admin/refs?type=bundle)
  bundles: {
    status: "ready",
    items: [
      { id: "bun-a", slug: "gym-kit", title: "Gym kit", state: "available", reasons: [], enabled: true, bundle_price: 250, saving: 50, currency: "USD", componentCount: 2, overlapsWith: [] },
      { id: "bun-old", slug: "old-kit", title: "Old kit", state: "sold_out", reasons: [{ kind: "sold_out", index: 0 }], enabled: true, bundle_price: 90, saving: 10, currency: "USD", componentCount: 2, overlapsWith: [] },
    ],
  },
};

// ============================== 1. coverage =======================================
console.log("1. every kind has a control, every kind and type a form");

// P4-LIVEROW: the product and collection content shape (OVL-01, ED-12) is
// registered, but its controls are P4-EDITOR's (batch 4): the editor UI
// stays read-only for these until then. These kinds and their two types are
// the only coverage gaps allowed, and exactly these.
// P5-SETTING registered bundle and bundle_list (COM-02) in batch 1; P5-EDITOR
// gave them their controls (fields/BundleControl.js), so they wait no more.
const WAITING_KINDS = ["overlay", "gallery", "pairs", "product_ids"];
const WAITING_TYPES = ["product_content", "collection_content"];
// The coverage gaps allowed, worked out when asked: the waiting kinds, the
// document fields above, and (P5-SETTING) every setting of a waiting kind on
// any registered section kind, read from the registry, so a section kind
// registered with a waiting setting (P5-BLOCKS' bundle_card and bundle_grid)
// is expected here without editing this list.
const waitingProblems = () => [
  ...WAITING_KINDS.map((k) => `setting kind "${k}" has no control`),
  ...Reg.sectionKinds().flatMap((kind) =>
    Reg.sectionType(kind)
      .settings.filter((s) => WAITING_KINDS.includes(s.kind))
      .map((s) => `section kind "${kind}": setting "${s.key}" has no control`),
  ),
  ...["title", "description_html", "gallery", "display_vendor", "display_type", "pairs"].map((k) => `document type "product_content": setting "${k}" has no control`),
  'document type "collection_content": setting "pinned" has no control',
];
const waitingField = (field) => WAITING_KINDS.includes(field?.setting?.kind);
// P5-SETTING: the issues a section form can't place yet, because their field
// is a waiting setting of that section (no control renders it). Nothing else
// is left out.
const waitingKeysOf = (kind) => new Set((Reg.sectionType(kind)?.settings || []).filter((s) => WAITING_KINDS.includes(s.kind)).map((s) => s.key));
const placeableIssues = (issues, s) => {
  const waiting = waitingKeysOf(s.kind);
  if (!waiting.size) return issues;
  return issues.filter((i) => !(i?.sectionId === s.id && typeof i.field === "string" && waiting.has(i.field.split(".")[0])));
};

await t("unit: every registered setting kind maps to a control, and every control name to a component", () => {
  eq([...M.inspectorCoverage()].sort(), [...waitingProblems()].sort(), "inspectorCoverage() (only P4-EDITOR's kinds wait)");
  for (const kind of Object.keys(SETTING_KINDS)) if (!WAITING_KINDS.includes(kind)) ok(M.controlKindOf(kind), `setting kind ${kind} has no control`);
  eq([...Object.keys(SF.CONTROL_COMPONENTS)].sort(), [...M.CONTROL_NAMES].sort(), "the components are exactly the control names");
  for (const [name, C] of Object.entries(SF.CONTROL_COMPONENTS)) ok(typeof C === "function", `control ${name} is not a component`);
  ok(WAITING_TYPES.every((t) => Reg.documentType(t)), "the waiting types are registered");
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
    // P4-LIVEROW: product and collection content have settings now
    product_content: "settings",
    collection_content: "settings",
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
    if (waitingField(field)) continue; // P4-LIVEROW: P4-EDITOR's controls
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
    checked += checkPlacement(shtml, placeableIssues(issues, s), s.id, `${label} ${s.kind} ${s.id}`);
    const sknown = new Set(fieldIds(tags(shtml)));
    for (const field of M.formOf({ kind: s.kind, sectionId: s.id }).fields) {
      if (waitingField(field)) continue; // P5-SETTING: P5-EDITOR's controls
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

await t("P5-EDITOR rendered: a throwaway home kind with bundle and bundle-list settings renders every field, and each note sits on the control or its row", () => {
  Reg.defineSection({
    kind: "zz_bundleprobe",
    version: 1,
    label: "Bundle probe",
    documentTypes: ["home"],
    settings: [
      { key: "title", kind: "text", label: "Title", max: 80, default: "" },
      { key: "pick", kind: "bundle", label: "Bundle", required: true, default: null },
      { key: "grid", kind: "bundle_list", label: "Bundles to show", required: true, max: 12, default: [] },
    ],
  });
  try {
    const problems = M.inspectorCoverage();
    ok(!problems.some((p) => /bundle/.test(p)), `no bundle problem: ${JSON.stringify(problems)}`);
    eq([...problems].sort(), [...waitingProblems()].sort(), "inspectorCoverage() with the probe registered");
    const s = Reg.newSection("zz_bundleprobe", { id: "sec_bprobe1" });
    renderAll("home", Reg.fixtureDocument("home", [s]), "bundle probe empty");
    // a broken one: the title too long, the bundle an old { id, title }, a
    // duplicate and a bad id in the grid: every note is placed now
    s.settings = { title: "x".repeat(90), pick: { id: "bun-a", title: "Gym kit" }, grid: [{ id: "bun-a" }, { id: "bun-a" }, { id: "bad id!" }] };
    const body = Reg.fixtureDocument("home", [s]);
    const issues = issuesFor(body).filter((i) => i.sectionId === "sec_bprobe1");
    ok(issues.some((i) => i.field === "pick.title" && i.code === "UNKNOWN_FIELD"), "the old title is UNKNOWN_FIELD");
    ok(issues.some((i) => i.field === "grid.1" && i.code === "INVALID_VALUE"), "the duplicate is INVALID_VALUE on its index");
    eq(placeableIssues(issues, s).length, issues.length, "no issue is left out");
    renderAll("home", body, "bundle probe broken");
    for (const c of Reg.worstCase("zz_bundleprobe").cases) renderAll("home", Reg.fixtureDocument("home", [{ ...c.section, id: freshId() }]), `bundle probe ${c.name}`);
  } finally {
    Reg.removeSection("zz_bundleprobe");
  }
  eq([...M.inspectorCoverage()].sort(), [...waitingProblems()].sort(), "after removing the probe");
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

// ============================== 6. the bundle picker (P5-EDITOR) ================================
console.log("6. the bundle picker: controls, words, picks, the grid's order, anchors");

const BC = await loadJsx(join(FIELDS, "BundleControl.js"));
const Words = await import("../lib/commerce/bundle-words.js");
const Card = await loadJsx(join(ROOT, "components/sections/BundleCardSection.js"));

// A refs row as GET /api/admin/refs?type=bundle gives it (lib/admin/refs.js).
const row = (id, state, extra = {}) => ({ id, slug: id, title: `Kit ${id}`, state, reasons: [], enabled: state !== "disabled", bundle_price: 350, saving: 0, currency: "USD", componentCount: 2, overlapsWith: [], ...extra });
const NO_SAVE = { kind: "no_saving", sum: 300, price: 350 };
const WORDS_OF = {
  available: "Showing to shoppers.",
  sold_out: "A product in this bundle is sold out: shoppers see Currently unavailable and can't add it.",
  no_saving: "The price no longer saves anything (the products add up to $300), so shoppers don't see it. Lower the price in Catalog > Bundles.",
  not_ready: "This bundle isn't ready for the cart yet: shoppers can't add it. Open it in Catalog > Bundles and save it again.",
  disabled: "This bundle is turned off, so shoppers don't see it. Turn it on in Catalog > Bundles, or remove it.",
  missing: "This bundle was deleted, so shoppers don't see it. Pick another or remove it.",
};
const stateRows = {
  available: row("bun-av", "available", { saving: 50, bundle_price: 250 }),
  sold_out: row("bun-so", "sold_out", { reasons: [{ kind: "sold_out", index: 0 }] }),
  no_saving: row("bun-ns", "no_saving", { reasons: [NO_SAVE] }),
  not_ready: row("bun-nr", "not_ready", { reasons: [{ kind: "not_synced" }] }),
  disabled: row("bun-of", "disabled"),
  missing: { id: "bun-gone", missing: true, state: "missing", reasons: [], overlapsWith: [] },
};
const ctxOf = (items, status = "ready", more = {}) => ({ ...CATALOG, bundles: { status, items }, ...more });
const cardField = (sid) => M.formOf({ kind: "bundle_card", sectionId: sid }).fields.find((f) => f.key === "bundle");
const gridField = (sid) => M.formOf({ kind: "bundle_grid", sectionId: sid }).fields.find((f) => f.key === "bundles");
const textIn = (html, attr) => {
  const m = new RegExp(`<p[^>]*${attr}=""[^>]*>([\\s\\S]*?)</p>`).exec(html);
  return m ? unescape(m[1].replace(/<[^>]+>/g, "")) : null;
};
const statusLines = (html) => [...html.matchAll(/<p[^>]*data-bundle-status=""[^>]*>([\s\S]*?)<\/p>/g)].map((m) => unescape(m[1].replace(/<[^>]+>/g, "")));

// A small hook driver (as scripts/test-bundle-form.js): state survives between
// renders, effects run, and an element tree can be searched for a handler.
function hookDriver() {
  const slots = new Map();
  let cur = null;
  let cursor = 0;
  let effects = [];
  const hooks = {
    useState(init) {
      const box = cur;
      const k = cursor++;
      if (!(k in box)) box[k] = typeof init === "function" ? init() : init;
      return [box[k], (v) => (box[k] = typeof v === "function" ? v(box[k]) : v)];
    },
    useRef(init) {
      const k = cursor++;
      if (!(k in cur)) cur[k] = { current: init };
      return cur[k];
    },
    useEffect(fn, deps) {
      const box = cur;
      const k = cursor++;
      const prev = box[k];
      if (prev && deps && prev.deps && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
      box[k] = { deps };
      effects.push(fn);
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useContext: () => null,
  };
  const react = { ...React, ...hooks, default: { ...React, ...hooks } };
  const SKIP = new Set(["Dialog", "VariantPicker"]);
  function draw(el) {
    const nodes = [];
    effects = [];
    const visit = (n, path) => {
      if (n == null || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach((c, i) => visit(c, `${path}.${c?.key ?? i}`));
      if (!React.isValidElement(n)) return;
      const ty = n.type;
      if (ty === React.Fragment) return visit(n.props.children, `${path}F`);
      if (typeof ty === "function" && !SKIP.has(ty.name)) {
        const key = `${path}/${ty.name}${n.key != null ? `#${n.key}` : ""}`;
        if (!slots.has(key)) slots.set(key, {});
        cur = slots.get(key);
        cursor = 0;
        return visit(ty(n.props), key);
      }
      nodes.push(n);
      if (typeof ty === "function" && n.props.open === false) return;
      for (const [k, v] of Object.entries(n.props)) if (k === "children" || React.isValidElement(v) || Array.isArray(v)) visit(v, `${path}/${typeof ty === "string" ? ty : ty.name}:${k}`);
    };
    visit(el, "r");
    for (const e of effects) e();
    return nodes;
  }
  return { react, draw };
}
// BundleControl.js and what it imports, compiled with the driver's hooks.
async function loadDriven(file, react) {
  const cache = new Map();
  async function load(f) {
    if (cache.has(f)) return cache.get(f);
    const mod = { exports: {} };
    cache.set(f, mod.exports);
    const code = await compile(f);
    const deps = new Map();
    for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
      if (deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
      if (id.startsWith("@/") || id.startsWith(".")) {
        let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(f), id);
        if (!target.endsWith(".js")) target = (await exists(`${target}.js`)) ? `${target}.js` : join(target, "index.js");
        deps.set(id, isJsx(target) ? await load(target) : await import(pathToFileURL(target).href));
      } else deps.set(id, require(id));
    }
    new Function("require", "module", "exports", code)((id) => (id === "react" ? react : id === "react/jsx-runtime" ? require("react/jsx-runtime") : deps.get(id)), mod, mod.exports);
    return mod.exports;
  }
  return load(file);
}
const textOfEl = (n) => (n == null || typeof n === "boolean" ? "" : Array.isArray(n) ? n.map(textOfEl).join("") : typeof n !== "object" ? String(n) : React.isValidElement(n) ? textOfEl(n.props.children) : "");
async function mountControl(name, props) {
  const d = hookDriver();
  const mod = await loadDriven(join(FIELDS, "BundleControl.js"), d.react);
  let nodes = [];
  const view = {
    props,
    draw: () => (nodes = d.draw(React.createElement(mod[name], view.props))),
    option: (id) => nodes.find((n) => n.type === "button" && n.props["data-bundle-option"] === id),
    button: (label) => nodes.find((n) => n.type === "button" && n.props["aria-label"] === label),
    text: () => nodes.filter((n) => typeof n.type === "string").map((n) => textOfEl(n.props.children)).join(" "),
    refused: () => {
      const n = nodes.find((x) => x.props?.["data-bundle-refused"] === "");
      return n ? textOfEl(n.props.children) : null;
    },
  };
  view.draw();
  return view;
}

await t("P5-EDITOR unit: bundle and bundle_list have controls, are not waiting, and inspectorCoverage() reports no bundle problem (the other waiting kinds stay)", () => {
  ok(!WAITING_KINDS.includes("bundle") && !WAITING_KINDS.includes("bundle_list"), "WAITING_KINDS still holds a bundle kind");
  eq([M.controlKindOf("bundle"), M.controlKindOf("bundle_list")], ["bundle", "bundle_list"], "CONTROL_OF_KIND");
  ok(SF.CONTROL_COMPONENTS.bundle === Controls.CONTROLS.bundle && Controls.CONTROLS.bundle === BC.BundleControl, "controls.js CONTROLS.bundle is BundleControl");
  ok(Controls.CONTROLS.bundle_list === BC.BundleListControl, "controls.js CONTROLS.bundle_list is BundleListControl");
  const problems = M.inspectorCoverage();
  ok(!problems.some((p) => /bundle/.test(p)), `bundle problems: ${JSON.stringify(problems.filter((p) => /bundle/.test(p)))}`);
  for (const k of ["overlay", "gallery", "pairs", "product_ids"]) ok(problems.includes(`setting kind "${k}" has no control`), `${k} still waits`);
  for (const kind of ["bundle_card", "bundle_grid"]) ok(M.formOf({ kind }).fields.every((f) => f.control), `${kind}: every field has a control`);
});

await t("P5-EDITOR rendered: every picked bundle shows the bundle-words sentence for its state, with Catalog > Bundles as a new-tab link", () => {
  for (const [state, r] of Object.entries(stateRows)) {
    const v = M.bundleView(r.id, r);
    eq(v.line, WORDS_OF[state], `${state}: the line`);
    eq(v.line, Words.stateLine(state, r.reasons, { currency: "USD" }), `${state}: it is bundle-words' sentence`);
    // the card
    const html = render(h(BC.BundleControl, { field: cardField("sec_bc1"), value: { id: r.id }, onChange: () => {}, issues: [], owner: "sec_bc1", context: ctxOf(Object.values(stateRows)) }));
    eq(textIn(html, "data-bundle-status"), WORDS_OF[state], `${state}: the card's rendered line`);
    ok(html.includes("data-bundle-chip"), `${state}: a chip`);
    if (/Catalog > Bundles/.test(WORDS_OF[state])) ok(/<a href="\/admin\/catalog#bundles" target="_blank" rel="noopener noreferrer"[^>]*>Catalog &gt; Bundles<\/a>/.test(html), `${state}: the link`);
    ok(!html.includes("₹") && !/\bINR\b/.test(html), `${state}: no rupee sign`);
  }
  // a picked id the ready list doesn't hold reads as deleted
  eq(M.bundleView("bun-nowhere", undefined, { status: "ready" }).line, WORDS_OF.missing, "absent from a ready list");
  eq(M.bundleView("bun-x", undefined, { status: "loading" }).line, "Checking this bundle…", "not read yet");
  // every row of a grid too, in its order
  const list = Object.values(stateRows).map((r) => ({ id: r.id }));
  const html = render(h(BC.BundleListControl, { field: gridField("sec_bg1"), value: list, onChange: () => {}, issues: [], owner: "sec_bg1", context: ctxOf(Object.values(stateRows)) }));
  eq(statusLines(html), Object.keys(stateRows).map((k) => WORDS_OF[k]), "each row's line, in order");
  eq((html.match(/data-bundle-chip=""/g) || []).length, list.length, "each row's chip");
  // the options say title, price in the bundle's currency, and chip
  const opts = M.bundleOptions(Object.values(stateRows), "", ["bun-av"]);
  eq(opts.map((o) => o.label), ["Kit bun-av · $250 · Showing", "Kit bun-so · $350 · Sold out", "Kit bun-ns · $350 · Hidden: no saving", "Kit bun-nr · $350 · Not ready", "Kit bun-of · $350 · Turned off"], "options (a deleted one is not offered)");
  eq(opts.map((o) => o.picked), [true, false, false, false, false], "the picked one is marked");
  eq(M.bundleOptions(Object.values(stateRows), "BUN-NS").map((o) => o.id), ["bun-ns"], "typed words filter the titles");
});

await t("P5-EDITOR rendered: the overlap line, and 'You can't see bundles here.' when the read failed (the id shows, Remove stays, no picking)", () => {
  const ov = row("bun-ov", "available", { saving: 20, bundle_price: 280, overlapsWith: [{ id: "bun-other", title: "Pair" }] });
  const v = M.bundleView(ov.id, ov);
  eq(v.overlap, "Another bundle uses the same products, so the cart may give a different saving than this block shows.", "the overlap line");
  eq(v.overlap, Words.overlapLine(), "bundle-words' overlap line");
  const html = render(h(BC.BundleControl, { field: cardField("sec_ov1"), value: { id: ov.id }, onChange: () => {}, issues: [], owner: "sec_ov1", context: ctxOf([ov]) }));
  eq(textIn(html, "data-bundle-overlap"), v.overlap, "rendered");
  eq(M.bundleView(stateRows.disabled.id, { ...stateRows.disabled, overlapsWith: [{ id: "x", title: "X" }] }).overlap, null, "no overlap line for a hidden bundle");
  // the read failed (a 403 or a fault)
  const failed = M.bundleView("bun-av", undefined, { status: "failed" });
  eq([failed.line, failed.canReplace], ["You can't see bundles here.", false], "the can't-see line");
  const card = render(h(BC.BundleControl, { field: cardField("sec_f1"), value: { id: "bun-av" }, onChange: () => {}, issues: [], owner: "sec_f1", context: ctxOf([], "failed", { canCreateBundles: true }) }));
  eq(textIn(card, "data-bundle-status"), "You can't see bundles here.", "the card says it");
  ok(/>bun-av</.test(card), "the picked id is shown");
  ok(card.includes('aria-label="Remove this bundle"') && !/disabled=""[^>]*aria-label="Remove this bundle"|aria-label="Remove this bundle"[^>]*disabled=""/.test(card), "it can be removed");
  ok(!card.includes('type="search"') && !card.includes("data-bundle-options") && !card.includes("Create a bundle"), "it can't be replaced");
  const grid = render(h(BC.BundleListControl, { field: gridField("sec_f2"), value: [{ id: "bun-a" }, { id: "bun-b" }], onChange: () => {}, issues: [], owner: "sec_f2", context: ctxOf([], "failed") }));
  eq(statusLines(grid), ["You can't see bundles here.", "You can't see bundles here."], "each row says it");
  ok(grid.includes('aria-label="Remove bun-a"') && !grid.includes('type="search"'), "rows can be removed, none added");
});

await t("P5-EDITOR unit: the inspector's words follow the blocks' reasons-aware rule (BundleCardSection isShown, bundleReason): a sold-out or not-ready bundle that saves nothing is hidden with the no-saving words", () => {
  const matrix = [];
  for (const state of ["available", "sold_out", "not_ready", "no_saving", "disabled", "missing"])
    for (const reasons of [[], [{ kind: "sold_out", index: 0 }], [NO_SAVE], [{ kind: "not_synced" }, NO_SAVE], [{ kind: "missing", index: 1 }, NO_SAVE]]) matrix.push(row(`bun-${matrix.length}`, state, { reasons }));
  for (const b of matrix) {
    const what = `${b.state} ${JSON.stringify(b.reasons.map((r) => r.kind))}`;
    eq(M.bundleShows(b), Card.isShown(b), `${what}: shown to shoppers`);
    const v = M.bundleView(b.id, b);
    if (!Card.isShown(b) && !(b.state === "disabled" && b.reasons.length)) eq(v.line, Card.bundleReason(b), `${what}: the same words as the preview note`);
    if (Card.isShown(b)) eq(v.line, Words.stateLine(b.state, b.reasons, { currency: "USD" }), `${what}: a shown bundle's own state line`);
  }
  // the two cases the review named
  const soldNoSave = row("bun-sn", "sold_out", { reasons: [{ kind: "sold_out", index: 0 }, NO_SAVE] });
  const notReadyNoSave = row("bun-rn", "not_ready", { reasons: [{ kind: "not_synced" }, NO_SAVE] });
  for (const b of [soldNoSave, notReadyNoSave]) {
    const v = M.bundleView(b.id, b);
    eq([v.line, v.chip.words, M.bundleShows(b)], [WORDS_OF.no_saving, "Hidden: no saving", false], `${b.state} that saves nothing`);
  }
});

await t("P5-EDITOR unit: a turned-off draft whose check fails is never offered as ready to turn on (the P5-BUNDLEREAD review)", () => {
  const draft = row("bun-dr", "disabled", { reasons: [{ kind: "sold_out", index: 0 }, NO_SAVE] });
  const v = M.bundleView(draft.id, draft);
  eq(v.line, "This bundle is turned off, so shoppers don't see it. It can't be turned on yet: Sold out; Price must be lower than $300. Fix it in Catalog > Bundles, or remove it.", "the line");
  ok(!/Turn it on/.test(v.line), "no 'Turn it on'");
  eq(v.chip.words, "Turned off, not ready", "the chip");
  eq(M.bundleOptions([draft])[0].label, "Kit bun-dr · $350 · Turned off, not ready", "the option");
  // the 1.5 quantity reason carries its own words (lib/bundles.js)
  const frac = row("bun-fr", "disabled", { reasons: [{ kind: "bad_quantity", index: 0, words: "The quantity must be a whole number, 1 or more" }] });
  ok(/It can't be turned on yet: The quantity must be a whole number, 1 or more\./.test(M.bundleView(frac.id, frac).line), "bad_quantity");
  // a passing draft keeps the plain turned-off line
  eq(M.bundleView("bun-of", stateRows.disabled).line, WORDS_OF.disabled, "a passing draft");
});

await t("P5-EDITOR driven: a pick writes exactly { id }; picking again over an old { id, title } writes { id } and the UNKNOWN_FIELD issue is gone", async () => {
  eq(M.pickBundle("bun-a"), { id: "bun-a" }, "pickBundle");
  const sec = { ...Reg.newSection("bundle_card", { id: "sec_pk1" }), settings: { title: "", bundle: { id: "bun-a", title: "Gym kit" } } };
  const before = Reg.validateDocument(Reg.fixtureDocument("home", [sec]), { mode: "draft" }).issues;
  ok(before.some((i) => i.sectionId === "sec_pk1" && i.code === "UNKNOWN_FIELD" && i.field === "bundle.title"), `the old title is UNKNOWN_FIELD: ${JSON.stringify(before.map((i) => `${i.code}@${i.field}`))}`);
  const stored = [];
  const v = await mountControl("BundleControl", { field: cardField("sec_pk1"), value: sec.settings.bundle, onChange: (x) => stored.push(x), issues: before, owner: "sec_pk1", context: CATALOG });
  ok(v.option("bun-a"), "the picked bundle is offered again");
  v.option("bun-a").props.onClick();
  eq(stored, [{ id: "bun-a" }], "picking writes { id } only");
  const after = Reg.validateDocument(Reg.fixtureDocument("home", [{ ...sec, settings: { ...sec.settings, bundle: stored[0] } }]), { mode: "publish" }).issues;
  ok(!after.some((i) => i.sectionId === "sec_pk1" && i.code === "UNKNOWN_FIELD"), `UNKNOWN_FIELD is gone: ${JSON.stringify(after.map((i) => `${i.code}@${i.field}`))}`);
  // another bundle replaces it, also as { id }
  v.option("bun-old").props.onClick();
  eq(stored.at(-1), { id: "bun-old" }, "a new pick");
  v.button("Remove this bundle").props.onClick();
  eq(stored.at(-1), null, "removed");
});

await t("P5-EDITOR driven: BundleListControl keeps the order, refuses a duplicate with 'This bundle is already in the grid.', moves and removes", async () => {
  const items = ["bun-1", "bun-2", "bun-3"].map((id) => row(id, "available", { bundle_price: 250 }));
  const stored = [];
  const v = await mountControl("BundleListControl", { field: gridField("sec_gl1"), value: [{ id: "bun-2" }], onChange: (x) => stored.push(x), issues: [], owner: "sec_gl1", context: ctxOf(items) });
  v.option("bun-3").props.onClick();
  eq(stored.at(-1), [{ id: "bun-2" }, { id: "bun-3" }], "added at the end, the order kept");
  v.props = { ...v.props, value: stored.at(-1) };
  v.draw();
  v.option("bun-1").props.onClick();
  eq(stored.at(-1), [{ id: "bun-2" }, { id: "bun-3" }, { id: "bun-1" }], "and again");
  v.props = { ...v.props, value: stored.at(-1) };
  v.draw();
  const n = stored.length;
  v.option("bun-2").props.onClick();
  v.draw();
  eq(stored.length, n, "a duplicate is not written");
  eq(v.refused(), "This bundle is already in the grid.", "it says why");
  ok(v.text().includes("This bundle is already in the grid."), "on screen");
  v.button("Move Kit bun-1 up").props.onClick();
  eq(stored.at(-1), [{ id: "bun-2" }, { id: "bun-1" }, { id: "bun-3" }], "moved up");
  v.draw();
  eq(v.refused(), null, "the refusal clears on the next edit");
  v.button("Remove Kit bun-2").props.onClick();
  eq(stored.at(-1), [{ id: "bun-3" }, { id: "bun-1" }], "removed");
  // the model itself
  eq(M.bundleList.add([{ id: "a" }], "a"), { list: [{ id: "a" }], error: "This bundle is already in the grid." }, "add refuses");
  eq(M.bundleList.replace([{ id: "a" }, { id: "b", title: "x" }], 1, "a").error, "This bundle is already in the grid.", "replace refuses a duplicate");
  eq(M.bundleList.replace([{ id: "a" }, { id: "b", title: "x" }], 1, "c").list, [{ id: "a" }, { id: "c" }], "replace writes { id }");
  eq(M.bundleList.add(Array.from({ length: 12 }, (_, j) => ({ id: `b${j}` })), "new").error, "A grid shows at most 12 bundles.", "full");
});

await t("P5-EDITOR unit+rendered: anchorsOf maps a bundle's incomplete and UNKNOWN_FIELD notes to the control, and a grid's indexed INVALID_VALUE to its row", () => {
  const card = { ...Reg.newSection("bundle_card", { id: "sec_an1" }), settings: { title: "", bundle: null } };
  const grid = { ...Reg.newSection("bundle_grid", { id: "sec_an2" }), settings: { title: "Bundles", bundles: [{ id: "bun-a" }, { id: "bun-a" }, { id: "bun-b", title: "x" }] } };
  const old = { ...Reg.newSection("bundle_card", { id: "sec_an3" }), settings: { title: "", bundle: { id: "bun-a", title: "Gym kit" } } };
  const issues = issuesFor(Reg.fixtureDocument("home", [card, grid, old]));
  const cardKnown = new Set(M.anchorsOf(cardField("sec_an1"), null, "sec_an1"));
  eq([...cardKnown], ["f-sec_an1-bundle"], "the card's anchors");
  const incomplete = issues.find((i) => i.sectionId === "sec_an1" && i.field === "bundle" && i.severity === "incomplete");
  ok(incomplete, `an incomplete note: ${JSON.stringify(issues.filter((i) => i.sectionId === "sec_an1"))}`);
  eq(Reg.fieldAnchor(incomplete, { known: cardKnown }), "f-sec_an1-bundle", "incomplete lands on the control");
  const unknown = issues.find((i) => i.sectionId === "sec_an3" && i.code === "UNKNOWN_FIELD");
  eq(Reg.fieldAnchor(unknown, { known: new Set(M.anchorsOf(cardField("sec_an3"), old.settings.bundle, "sec_an3")) }), "f-sec_an3-bundle", "UNKNOWN_FIELD lands on the control");
  const gridKnown = new Set(M.anchorsOf(gridField("sec_an2"), grid.settings.bundles, "sec_an2"));
  eq([...gridKnown], ["f-sec_an2-bundles", "f-sec_an2-bundles-0", "f-sec_an2-bundles-1", "f-sec_an2-bundles-2"], "the grid's anchors: the control and each row");
  const dup = issues.find((i) => i.sectionId === "sec_an2" && i.code === "INVALID_VALUE" && i.field === "bundles.1");
  ok(dup, "the duplicate is INVALID_VALUE on index 1");
  eq(Reg.fieldAnchor(dup, { known: gridKnown }), "f-sec_an2-bundles-1", "it lands on row 2");
  const rowKey = issues.find((i) => i.sectionId === "sec_an2" && i.code === "UNKNOWN_FIELD");
  eq(Reg.fieldAnchor(rowKey, { known: gridKnown }), "f-sec_an2-bundles-2", "a row's unknown key lands on that row");
  // and the rendered forms put each message there
  for (const s of [card, grid, old]) {
    const html = render(h(SettingsForm, { kind: s.kind, sectionId: s.id, value: s.settings, issues, onChange: () => {}, context: CATALOG }));
    ok(checkPlacement(html, issues, s.id, s.kind) > 0, `${s.kind}: notes placed`);
  }
});

await t("P5-SETTING review: placeableIssues leaves out only the waiting setting of THAT section (two sections of different kinds share the key 'pick')", () => {
  Reg.defineSection({ kind: "zz_waita", version: 1, label: "Wait A", documentTypes: ["home"], settings: [{ key: "pick", kind: "product_ids", label: "Picks", default: [] }] });
  Reg.defineSection({ kind: "zz_waitb", version: 1, label: "Wait B", documentTypes: ["home"], settings: [{ key: "pick", kind: "text", label: "Pick", max: 5, default: "" }] });
  try {
    const a = { ...Reg.newSection("zz_waita", { id: "sec_wa1" }), settings: { pick: "junk" } };
    const b = { ...Reg.newSection("zz_waitb", { id: "sec_wb1" }), settings: { pick: "far too long" } };
    const issues = issuesFor(Reg.fixtureDocument("home", [a, b]));
    ok(issues.some((i) => i.sectionId === "sec_wa1" && i.field.startsWith("pick")) && issues.some((i) => i.sectionId === "sec_wb1" && i.field === "pick"), `both sections have a pick issue: ${JSON.stringify(issues.map((i) => `${i.sectionId}:${i.field}`))}`);
    const forA = placeableIssues(issues, a);
    ok(!forA.some((i) => i.sectionId === "sec_wa1" && i.field.startsWith("pick")), "A's waiting pick is left out");
    ok(forA.some((i) => i.sectionId === "sec_wb1" && i.field === "pick"), "B's pick (same key, another section) is kept");
    eq(placeableIssues(issues, b).length, issues.length, "B has no waiting setting: every issue is kept");
  } finally {
    Reg.removeSection("zz_waita");
    Reg.removeSection("zz_waitb");
  }
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${failures.length} failed in ${seconds} s`);
if (failures.length) {
  console.log(`Failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
