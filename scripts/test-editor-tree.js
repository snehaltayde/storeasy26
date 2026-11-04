// P3-TREE suite (ED-02, AU-04, ED-04): the section tree.
//   1. unit: components/admin/editor/tree/treeModel.js. add, move, hide, show,
//      duplicate and delete give bodies that validate in draft mode with no
//      structure issue, on every document type that holds sections; a refused
//      operation says why in plain words and changes nothing; duplicate never
//      reuses an id (sections and nested blocks); ids are stable across moves.
//   2. unit: every registered kind adds to every document type that takes it;
//      the picker lists exactly those kinds with their labels; a product rail
//      given collections picks one with products.
//   3. rendered: SectionTree and AddSection, compiled with Next's own SWC and
//      rendered with react-dom/server: the selected row and the unfinished
//      rows are marked, hidden rows say so, and the picker lists every kind.
// No browser: the batch 3 tree has no host page until P3-EDITOR, whose drill
// covers the clicks.
//   pnpm test:editor-tree
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);
const started = Date.now();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack || e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};

const Reg = await import("../lib/registry/index.js");
const { issueClass, STRUCTURE } = await import("../lib/registry/validate.js");
const T = await import("../components/admin/editor/tree/treeModel.js");
const { emptyBody, validateDocument, documentType, documentTypeNames, allowedKinds, sectionType, SECTION_ID_RE, BLOCK_ID_RE, defineSection, removeSection } = Reg;

const SECTION_TYPES = documentTypeNames().filter((ty) => documentType(ty).sections);

// A whole body of `type` holding `sections`, as the editor would save it.
function bodyOf(type, sections) {
  const body = emptyBody(type);
  if (documentType(type).route) Object.assign(body.meta, { slug: "tree-test", title: "Tree test" });
  body.sections = sections;
  return body;
}
const structureOf = (type, sections) =>
  validateDocument(bodyOf(type, sections), { mode: "draft" })
    .issues.filter((i) => issueClass(i) === STRUCTURE)
    .map((i) => `${i.code} on ${i.field}`);
const draftClean = (type, sections, label) => {
  const r = validateDocument(bodyOf(type, sections), { mode: "draft" });
  const st = r.issues.filter((i) => issueClass(i) === STRUCTURE);
  ok(r.ok, `${label}: the draft is not ok (${r.issues.filter((i) => i.severity === "error").map((i) => i.code)})`);
  eq(
    st.map((i) => i.code),
    [],
    `${label}: structure issues`,
  );
};
const deepFreeze = (v) => {
  if (v && typeof v === "object") {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
};
const sec = (kind, id, settings = {}, extra = {}) => ({ ...Reg.newSection(kind, { id }), ...extra, settings: { ...Reg.newSection(kind).settings, ...settings } });

// Representative drafts, one per document type that holds sections, each
// clean in draft mode with filled-in sections and an unfinished one.
function sample(type) {
  if (type === "home")
    return [
      sec("hero", "sec_hero", { title: "Summer is here" }),
      sec("collections", "sec_coll"),
      sec("banner", "sec_bann"),
      sec("text", "sec_text", { title: "Our story", body: ["Two friends.", "One kitchen."] }),
      sec("faq", "sec_faq", { title: "Questions", items: [{ q: "Do you ship?", a: "Yes." }] }),
    ];
  if (type === "product_layout") return [sec("rich_text", "sec_rich", { html: "<p>Size guide</p>" }), sec("product_main", "sec_main"), sec("faq", "sec_faq", { items: [{ q: "Returns?", a: "30 days." }] })];
  const kinds = allowedKinds(type).filter((k) => !sectionType(k).protected && k !== "hero");
  return kinds.slice(0, 4).map((k, n) => sec(k, `sec_${type.replace(/_/g, "").slice(0, 8)}${n}`, k === "text" ? { title: "Hello" } : {}));
}

// ---- 1. operations ---------------------------------------------------------------
console.log("— operations give bodies that save");

await t("the sample drafts are clean in draft mode (the starting point of every check)", () => {
  for (const type of SECTION_TYPES) draftClean(type, sample(type), type);
});

await t("every allowed add, move, hide, show, duplicate and delete on each type's draft validates in draft mode with no structure issue", () => {
  let checked = 0;
  for (const type of SECTION_TYPES) {
    const s = deepFreeze(sample(type));
    const results = [];
    for (const kind of allowedKinds(type)) for (let at = 0; at <= s.length; at++) results.push([`add ${kind} at ${at}`, T.add(s, kind, at, { type })]);
    for (const { id } of s) {
      for (let to = 0; to < s.length; to++) results.push([`move ${id} to ${to}`, T.move(s, id, to, { type })]);
      results.push([`up ${id}`, T.moveUp(s, id, { type })], [`down ${id}`, T.moveDown(s, id, { type })]);
      results.push([`hide ${id}`, T.hide(s, id, { type })], [`duplicate ${id}`, T.duplicate(s, id, { type })], [`delete ${id}`, T.delete(s, id, { type })]);
      const hidden = T.hide(s, id, { type });
      if (hidden.ok) results.push([`show ${id}`, T.show(hidden.sections, id, { type })]);
    }
    for (const [label, r] of results) {
      if (!r.ok) {
        ok(typeof r.message === "string" && r.message.length > 10 && !/undefined|null|\[object/.test(r.message), `${type} ${label}: refusal words "${r.message}"`);
        continue;
      }
      draftClean(type, r.sections, `${type} ${label}`);
      checked++;
    }
  }
  ok(checked > 200, `only ${checked} results checked`);
});

await t("a random walk of 400 operations per type never leaves a structure issue, and a refusal never changes the list", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (const type of SECTION_TYPES) {
    let s = deepFreeze(sample(type));
    const kinds = allowedKinds(type);
    let oks = 0;
    for (let step = 0; step < 400; step++) {
      const id = s.length ? s[rnd(s.length)].id : null;
      const op = rnd(7);
      const before = JSON.stringify(s);
      const r =
        op === 0 || !id
          ? T.add(s, kinds[rnd(kinds.length)], rnd(s.length + 1), { type, collections: [{ handle: "tees", available_count: 4 }] })
          : op === 1
            ? T.move(s, id, rnd(s.length), { type })
            : op === 2
              ? T.hide(s, id, { type })
              : op === 3
                ? T.show(s, id, { type })
                : op === 4
                  ? T.duplicate(s, id, { type })
                  : op === 5 && s.length > 3
                    ? T.delete(s, id, { type })
                    : T.moveUp(s, id, { type });
      eq(JSON.stringify(s), before, `${type} step ${step}: the input list changed`);
      if (!r.ok) continue;
      eq(structureOf(type, r.sections), [], `${type} step ${step}`);
      ok(r.selectedId === null || r.sections.some((x) => x.id === r.selectedId), `${type} step ${step}: selectedId ${r.selectedId} is not in the list`);
      s = deepFreeze(r.sections.length > 14 ? r.sections.slice(0, 1).concat(r.sections.slice(-10)) : r.sections);
      if (structureOf(type, s).length) s = deepFreeze(sample(type)); // trimming may drop a protected module
      oks++;
    }
    ok(oks > 100, `${type}: only ${oks} operations went through`);
  }
});

await t("composition refusals: a second hero, a section above the hero, the product details hidden, copied or deleted, two sections above them", () => {
  const home = deepFreeze(sample("home"));
  const second = T.add(home, "hero", 2, { type: "home" });
  ok(!second.ok && second.code === "TOO_MANY_OF_KIND", `second hero: ${JSON.stringify(second)}`);
  eq(second.message, "The home page already has a hero. It can have only one.");
  const above = T.move(home, "sec_coll", 0, { type: "home" });
  ok(!above.ok && above.code === "POSITION_NOT_ALLOWED" && /top|first/i.test(above.message), `above the hero: ${JSON.stringify(above)}`);
  ok(!T.moveUp(home, "sec_coll", { type: "home" }).ok, "move up into the hero's place is refused");
  ok(!T.moveDown(home, "sec_hero", { type: "home" }).ok, "the hero can't move down");
  const pl = deepFreeze(sample("product_layout"));
  for (const [op, code] of [
    ["hide", "PROTECTED_HIDDEN"],
    ["duplicate", "PROTECTED_COPY"],
    ["delete", "PROTECTED_MISSING"],
  ]) {
    const r = T[op](pl, "sec_main", { type: "product_layout" });
    ok(!r.ok && r.code === code && /shoppers need it|only one/.test(r.message), `${op} product details: ${JSON.stringify(r)}`);
  }
  const twoAbove = T.move(pl, "sec_faq", 0, { type: "product_layout" });
  ok(!twoAbove.ok && twoAbove.code === "TOO_MANY_BEFORE_PROTECTED" && twoAbove.message === "Only one section can sit above the product details and buy button.", JSON.stringify(twoAbove));
  const banner = T.add(pl, "banner", 0, { type: "product_layout" });
  ok(banner.ok && banner.index === 3, `a banner asked for at the top goes where it fits (the end): ${JSON.stringify(banner.index)}`);
  const notHere = T.add(sample("page"), "hero", 0, { type: "page" });
  ok(!notHere.ok && notHere.code === "KIND_NOT_ALLOWED" && notHere.message === "A hero section can't go on this page.", JSON.stringify(notHere));
});

await t("the hero added anywhere goes to the top; a delete selects the neighbour; hide then show gives back the same section", () => {
  const home = deepFreeze(sample("home").slice(1));
  const r = T.add(home, "hero", 3, { type: "home" });
  ok(r.ok && r.index === 0 && r.sections[0].kind === "hero" && r.selectedId === r.id && r.sections[0].id === r.id, JSON.stringify({ ok: r.ok, index: r.index }));
  const d = T.delete(sample("home"), "sec_bann", { type: "home" });
  ok(d.ok && d.selectedId === "sec_text", `after delete: ${d.selectedId}`);
  const last = T.delete(sample("home"), "sec_faq", { type: "home" });
  ok(last.ok && last.selectedId === "sec_text", `after deleting the last: ${last.selectedId}`);
  const s = sample("home");
  const back = T.show(T.hide(s, "sec_text", { type: "home" }).sections, "sec_text", { type: "home" });
  eq(back.sections, s, "hide then show");
  const both = [...s.slice(0, 3), { ...s[3], show: { mobile: false, desktop: false } }];
  ok(T.isHidden(both[3]), "hidden on both screens reads as hidden (TREE-05)");
  eq(T.show(both, "sec_text", { type: "home" }).sections[3].show, { mobile: true, desktop: true }, "show clears hidden on both screens");
});

await t("duplicate never reuses an id: a fresh section id and fresh block ids, none already in the document", () => {
  // a throwaway kind that holds blocks (no registered kind does yet, TREE-02)
  defineSection({ kind: "tree_blocks", documentTypes: ["page"], label: "Blocks probe", blocks: { allowed: ["x"], max: 5 } });
  try {
    const s = deepFreeze([
      { id: "sec_aaaa", kind: "tree_blocks", v: 1, enabled: true, settings: {}, blocks: [{ id: "blk_b1" }, { id: "blk_b2" }] },
      sec("text", "sec_bbbb", { title: "Hi" }),
    ]);
    const used = new Set(["sec_aaaa", "sec_bbbb", "blk_b1", "blk_b2"]);
    let cur = s;
    for (let n = 0; n < 30; n++) {
      const pick = cur[n % cur.length];
      const r = T.duplicate(cur, pick.id, { type: "page" });
      ok(r.ok, `duplicate ${n}: ${r.message}`);
      const copy = r.sections.find((x) => x.id === r.id);
      ok(SECTION_ID_RE.test(copy.id) && !used.has(copy.id), `copy ${n} reused or broke a section id: ${copy.id}`);
      used.add(copy.id);
      for (const b of copy.blocks) {
        ok(BLOCK_ID_RE.test(b.id) && !used.has(b.id), `copy ${n} reused or broke a block id: ${b.id}`);
        used.add(b.id);
      }
      ok(r.sections.indexOf(copy) === r.sections.findIndex((x) => x.id === pick.id) + 1, "the copy sits right below the original");
      eq({ ...copy, id: pick.id, blocks: pick.blocks.map((b) => ({ ...b })) }, { ...pick, blocks: pick.blocks.map((b) => ({ ...b })) }, `copy ${n} content`);
      ok(copy.settings !== pick.settings, "the copy's settings are its own object");
      const ids = r.sections.flatMap((x) => [x.id, ...(x.blocks || []).map((b) => b.id)]);
      eq(ids.length, new Set(ids).size, `ids unique after copy ${n}`);
      cur = r.sections;
    }
  } finally {
    removeSection("tree_blocks");
  }
  for (const type of SECTION_TYPES) {
    for (const x of sample(type)) {
      const r = T.duplicate(sample(type), x.id, { type });
      if (!r.ok) continue;
      ok(!sample(type).some((y) => y.id === r.id), `${type}: the copy of ${x.id} reused an id`);
    }
  }
});

await t("a minted id that is already in the document is never used: add and duplicate mint again", () => {
  const real = crypto.getRandomValues.bind(crypto);
  // the first draws give sec_aaaaaaaa and blk_aaaaaaaa, both taken
  let forced = 0;
  const fake = (arr) => {
    if (forced < 4) {
      forced++;
      return arr.fill(0xaa);
    }
    return real(arr);
  };
  Object.defineProperty(crypto, "getRandomValues", { value: fake, configurable: true, writable: true });
  try {
    const s = deepFreeze([sec("text", "sec_aaaaaaaa", { title: "Taken" }), sec("faq", "sec_faq1", { items: [{ q: "Q?", a: "A." }] })]);
    const a = T.add(s, "banner", 2, { type: "page" });
    ok(a.ok && a.id !== "sec_aaaaaaaa" && SECTION_ID_RE.test(a.id), `add took ${a.id}`);
    forced = 0;
    const d = T.duplicate(s, "sec_faq1", { type: "page" });
    ok(d.ok && d.id !== "sec_aaaaaaaa", `duplicate took ${d.id}`);
    ok(forced >= 2, "the fake draws were used");
  } finally {
    delete crypto.getRandomValues;
    if (crypto.getRandomValues !== Object.getPrototypeOf(crypto).getRandomValues) Object.defineProperty(crypto, "getRandomValues", { value: real, configurable: true, writable: true });
  }
  ok(/^sec_[0-9a-f]{8}$/.test(Reg.mintSectionId()), "real minting is back");
});

await t("ids are stable across moves: the same ids, the same section objects, reordered", () => {
  const s = deepFreeze(sample("home"));
  let cur = s;
  for (const [id, to] of [
    ["sec_faq", 1],
    ["sec_coll", 4],
    ["sec_text", 2],
    ["sec_bann", 3],
  ]) {
    const r = T.move(cur, id, to, { type: "home" });
    ok(r.ok, `move ${id} to ${to}: ${r.message}`);
    eq(r.sections[to].id, id, "landed at");
    ok(r.selectedId === id, "the moved section stays selected");
    cur = r.sections;
  }
  eq([...cur.map((x) => x.id)].sort(), [...s.map((x) => x.id)].sort(), "the same ids");
  for (const x of cur) ok(s.includes(x), `${x.id} is not the same object after moving`);
  const up = T.moveUp(cur, "sec_bann", { type: "home" });
  ok(up.ok && up.sections.some((x) => x === s[2]), "moveUp keeps the object");
});

// ---- 2. add -----------------------------------------------------------------
console.log("— add, every kind, every type");

await t("add of every registered kind for each type that holds sections works: a client-minted id, selected, and a clean draft", () => {
  let n = 0;
  for (const type of SECTION_TYPES) {
    for (const kind of allowedKinds(type)) {
      const d = sectionType(kind);
      // the empty body, less a protected module when that is the kind added
      const base = deepFreeze(emptyBody(type).sections.filter((x) => !(d.protected && x.kind === kind)));
      for (const start of [base, deepFreeze([...base, ...sample(type).filter((x) => x.kind !== kind && !sectionType(x.kind).protected)].slice(0, 3))]) {
        if (structureOf(type, start).length && !d.protected) continue;
        const r = T.add(start, kind, start.length, { type });
        ok(r.ok, `${kind} on ${type}: ${r.message}`);
        const added = r.sections.find((x) => x.id === r.id);
        ok(added && added.kind === kind && SECTION_ID_RE.test(r.id) && r.selectedId === r.id, `${kind} on ${type}: the new section`);
        ok(!start.some((x) => x.id === r.id), `${kind} on ${type}: reused an id`);
        draftClean(type, r.sections, `${kind} on ${type}`);
        if (d.startsIncomplete) {
          const issues = validateDocument(bodyOf(type, r.sections), { mode: "draft" }).issues.filter((i) => i.sectionId === r.id);
          ok(issues.every((i) => i.severity === "incomplete" || i.severity === "warning"), `${kind} on ${type}: ${issues.map((i) => i.code)}`);
        }
        n++;
      }
    }
  }
  ok(n >= 50, `only ${n} adds`);
});

await t("the picker lists every registered kind for the document type, with its label, and says why one can't be added", () => {
  for (const type of SECTION_TYPES) {
    const opts = T.addOptions(type, sample(type), 1);
    eq(
      opts.map((o) => o.kind),
      allowedKinds(type),
      `${type} kinds`,
    );
    for (const o of opts) {
      eq(o.label, sectionType(o.kind).label, `${type} ${o.kind} label`);
      ok(o.ok ? o.reason === null : typeof o.reason === "string" && o.reason.length > 10, `${type} ${o.kind}: ok ${o.ok}, reason ${o.reason}`);
    }
  }
  const home = T.addOptions("home", sample("home"), 1);
  const hero = home.find((o) => o.kind === "hero");
  ok(!hero.ok && hero.reason === "The home page already has a hero. It can have only one.", JSON.stringify(hero));
  ok(home.filter((o) => o.kind !== "hero").every((o) => o.ok), "every other home kind can be added");
  ok(T.addOptions("header", [], 0).length === 0 && !T.add([], "text", 0, { type: "header" }).ok, "a type without sections lists nothing and refuses");
});

await t("product_rail add picks a collection with products when given collections, and asks for one without", () => {
  const collections = [
    { handle: "empty", id: "gid://shopify/Collection/1", available_count: 0, product_count: 0 },
    { handle: "sold-out", available_count: 0, product_count: 6 },
    { handle: "tees", id: "gid://shopify/Collection/3", available_count: 7, product_count: 9 },
  ];
  for (const type of SECTION_TYPES.filter((ty) => allowedKinds(ty).includes("product_rail"))) {
    const r = T.add(sample(type), "product_rail", 1, { type, collections });
    ok(r.ok, `${type}: ${r.message}`);
    const rail = r.sections.find((x) => x.id === r.id);
    eq(rail.settings.collection, { handle: "tees", id: "gid://shopify/Collection/3" }, `${type} rail collection`);
    const pub = validateDocument(bodyOf(type, r.sections), { mode: "publish" }).issues.filter((i) => i.sectionId === r.id && i.severity === "error");
    eq(
      pub.map((i) => i.code),
      [],
      `${type}: the new rail publishes clean`,
    );
    const bare = T.add(sample(type), "product_rail", 1, { type });
    ok(bare.ok && bare.sections.find((x) => x.id === bare.id).settings.collection === null, `${type}: without collections the rail asks for one`);
    const issues = validateDocument(bodyOf(type, bare.sections), { mode: "draft" }).issues.filter((i) => i.sectionId === bare.id);
    ok(
      issues.some((i) => i.severity === "incomplete" && i.field === "collection"),
      `${type}: the bare rail is unfinished`,
    );
  }
});

await t("rowState and groupIssues: 'unfinished' only for a section with an incomplete issue", () => {
  const s = sample("home");
  const { issues } = validateDocument(bodyOf("home", s), { mode: "draft" });
  const by = T.groupIssues(issues);
  const states = Object.fromEntries(s.map((x) => [x.id, T.rowState(x, by[x.id])]));
  ok(states.sec_bann.unfinished, "the empty banner is unfinished");
  for (const id of ["sec_hero", "sec_coll", "sec_text", "sec_faq"]) ok(!states[id].unfinished, `${id} is not unfinished`);
  eq(states.sec_hero.title, "Summer is here", "row title");
  eq(T.rowState(s[0], [{ sectionId: "sec_hero", severity: "warning" }]).unfinished, false, "a warning is not unfinished");
  eq(T.rowState(s[0], [{ sectionId: "sec_hero", severity: "error" }]).problem, true, "an error is a problem");
  eq(T.rowState({ id: "sec_zz", kind: "gone" }).label, "A section we don't know", "unknown kind");
});

await t("rowActions for a 30-section home stays fast enough to run on every render", () => {
  const big = sample("home");
  for (let n = 0; n < 25; n++) big.push(sec("text", `sec_t${n}`, { title: `Part ${n}` }));
  const t0 = performance.now();
  for (const x of big) T.rowActions(big, x.id, "home");
  const ms = performance.now() - t0;
  console.log(`   rowActions over 30 rows: ${ms.toFixed(1)} ms`);
  ok(ms < 1500, `${ms} ms`);
});

await t("edge-safe: treeModel imports only the registry and no node: API", async () => {
  const src = await readFile(join(ROOT, "components/admin/editor/tree/treeModel.js"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  eq(imports, ["../../../../lib/registry/index.js", "../../../../lib/registry/validate.js"], "imports");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  ok(!/["']node:|require\(|process\.|Buffer/.test(code), "no node: API");
  // and the registry it imports is edge-safe all the way down
  const walk = async (file, seenFiles = new Set()) => {
    if (seenFiles.has(file)) return seenFiles;
    seenFiles.add(file);
    const text = await readFile(file, "utf8");
    ok(!/from\s+["']node:|import\(\s*["']node:/.test(text), `${relative(ROOT, file)} imports a node: module`);
    for (const [, spec] of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) await walk(resolve(dirname(file), spec.endsWith(".js") ? spec : `${spec}.js`), seenFiles);
    return seenFiles;
  };
  const files = await walk(join(ROOT, "components/admin/editor/tree/treeModel.js"));
  ok(files.size > 5, `walked ${files.size} files`);
});

// ---- 3. rendered ----------------------------------------------------------------
console.log("— rendered");

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
const toFile = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
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
      const target = toFile(file, id);
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
  seen.set(file, mod.exports);
  return mod.exports;
}
const SectionTree = (await loadJsx(join(ROOT, "components/admin/editor/tree/SectionTree.js"))).default;
const AddSection = (await loadJsx(join(ROOT, "components/admin/editor/tree/AddSection.js"))).default;

// the <li> of one row
const rowOf = (html, id) => {
  const start = html.indexOf(`data-section-row="${id}"`);
  ok(start >= 0, `no row for ${id}`);
  const open = html.lastIndexOf("<li", start);
  return html.slice(open, html.indexOf("</li>", start) + 5);
};

await t("the tree marks the unfinished sections and the selected one (and only those)", () => {
  const s = sample("home");
  s.push({ ...sec("text", "sec_hidd", { title: "Old note" }), enabled: false });
  s.push(sec("rich_text", "sec_rich"));
  const { issues } = validateDocument(bodyOf("home", s), { mode: "draft" });
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "home", sections: s, selectedId: "sec_text", issuesBySection: T.groupIssues(issues) }));
  const sel = rowOf(html, "sec_text");
  ok(sel.includes("data-selected") && sel.includes('aria-current="true"'), "the selected row is marked");
  eq((html.match(/aria-current="true"/g) || []).length, 1, "exactly one selected row");
  eq((html.match(/data-selected=""/g) || []).length, 1, "exactly one data-selected");
  for (const id of ["sec_bann", "sec_rich"]) {
    const row = rowOf(html, id);
    ok(row.includes("data-unfinished") && row.includes(">Unfinished</span>"), `${id} shows Unfinished`);
  }
  for (const id of ["sec_hero", "sec_coll", "sec_text", "sec_faq", "sec_hidd"]) ok(!rowOf(html, id).includes("Unfinished"), `${id} is not marked unfinished`);
  const hid = rowOf(html, "sec_hidd");
  ok(hid.includes(">Hidden</span>") && hid.includes('aria-label="Show Text"'), "the hidden row says Hidden and offers Show");
  ok(rowOf(html, "sec_hero").includes(">Summer is here</span>"), "a row shows its section's title");
  const heroRow = rowOf(html, "sec_hero");
  ok(/aria-label="Move Hero down"[^>]*disabled=""/.test(heroRow) || /disabled=""[^>]*aria-label="Move Hero down"/.test(heroRow), "the hero can't move down (disabled)");
  ok(/title="The hero can only go at the top/.test(heroRow), `the disabled button says why: ${heroRow.match(/title="[^"]*"/g)}`);
  ok(html.includes("Add a section"), "the add button is there");
});

await t("nothing selected: no row is marked; an empty document says so", () => {
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "page", sections: sample("page"), selectedId: null }));
  ok(!html.includes("aria-current") && !html.includes("data-selected"), "no selected row");
  const empty = renderToStaticMarkup(React.createElement(SectionTree, { type: "page", sections: [], selectedId: null }));
  ok(empty.includes("No sections yet"), "the empty note");
});

await t("the protected product details row offers no hide, copy or delete", () => {
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "product_layout", sections: sample("product_layout"), selectedId: null }));
  const row = rowOf(html, "sec_main");
  for (const verb of ["Hide", "Copy", "Delete"]) {
    const m = row.match(new RegExp(`<button[^>]*aria-label="${verb} Product details and buy button"[^>]*>`));
    ok(m && m[0].includes('disabled=""'), `${verb} is disabled on the product details`);
  }
});

await t("the open picker lists every registered kind for the type with its label; a refused one is disabled with its reason", () => {
  for (const type of SECTION_TYPES) {
    const html = renderToStaticMarkup(React.createElement(AddSection, { type, sections: sample(type), index: 1, open: true }));
    for (const kind of allowedKinds(type)) {
      const m = html.match(new RegExp(`<button[^>]*data-kind="${kind}"[^>]*>(.*?)</button>`));
      ok(m && m[1].includes(`>${sectionType(kind).label}</span>`), `${type}: ${kind} with its label`);
    }
    eq((html.match(/data-kind="/g) || []).length, allowedKinds(type).length, `${type}: only its kinds`);
  }
  const home = renderToStaticMarkup(React.createElement(AddSection, { type: "home", sections: sample("home"), index: 1, open: true, afterLabel: "hero" }));
  ok(/<button[^>]*disabled=""[^>]*data-kind="hero"/.test(home) || /<button[^>]*data-kind="hero"[^>]*disabled=""/.test(home), "a second hero is disabled");
  ok(home.includes("The home page already has a hero. It can have only one."), "with its reason");
  ok(home.includes("Adds below the hero"), "says where it adds");
  const closed = renderToStaticMarkup(React.createElement(AddSection, { type: "home", sections: [], index: 0 }));
  ok(closed.includes("Add a section") && !closed.includes("data-kind"), "closed, it is one button");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
