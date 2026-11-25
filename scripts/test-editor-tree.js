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
// P4-ED05 (D2): the kinds the editor OFFERS: allowed, less the ones no longer
// offered on that type (a banner on a page, campaign or journal post)
const { isOffered } = await import("../lib/registry/sections.js");
const offeredKinds = (type) => allowedKinds(type).filter((k) => isOffered(k, type));

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
    const a = T.add(s, "rich_text", 2, { type: "page" }); // P4-ED05: a banner is no longer offered on a page
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
    for (const kind of offeredKinds(type)) {
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
      offeredKinds(type),
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

// P5-BLOCKS (COM-02, OQ-E): the bundle blocks are home kinds only for now
await t("P5-BLOCKS: bundle_card and bundle_grid are offered on the home page only (not page, campaign or journal), and their add makes a known-incomplete draft", () => {
  for (const kind of ["bundle_card", "bundle_grid"]) {
    ok(offeredKinds("home").includes(kind), `${kind} not offered on home`);
    ok(T.addOptions("home", sample("home"), 1).some((o) => o.kind === kind && o.ok), `${kind}: the home picker can't add it`);
    for (const type of ["page", "campaign", "journal"]) {
      ok(!allowedKinds(type).includes(kind), `${kind} allowed on ${type}`);
      ok(!T.addOptions(type, sample(type), 1).some((o) => o.kind === kind), `${kind} listed on ${type}`);
      ok(!T.add(sample(type), kind, 1, { type }).ok, `${kind} added on ${type}`);
    }
    const r = T.add(sample("home"), kind, 1, { type: "home" });
    ok(r.ok, `${kind}: ${r.message}`);
    const issues = validateDocument(bodyOf("home", r.sections), { mode: "draft" }).issues.filter((i) => i.sectionId === r.id);
    ok(issues.length > 0 && issues.every((i) => i.severity === "incomplete"), `${kind}: a new one waits for its bundle: ${JSON.stringify(issues.map((i) => [i.code, i.severity]))}`);
  }
  eq(JSON.stringify(SECTION_TYPES.filter((type) => allowedKinds(type).includes("bundle_card") || allowedKinds(type).includes("bundle_grid"))), JSON.stringify(["home"]), "types offering a bundle kind:");
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
  eq(imports, ["../../../../lib/registry/index.js", "../../../../lib/registry/sections.js", "../../../../lib/registry/validate.js"], "imports");
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
// Phase 2 line 6: the tree's write buttons are storefront.write (RoleGate);
// these tests are an owner's unless they say otherwise
const TreeRaw = (await loadJsx(join(ROOT, "components/admin/editor/tree/SectionTree.js"))).default;
const SectionTree = (p) => TreeRaw({ role: "owner", ...p });
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
    const html = renderToStaticMarkup(React.createElement(AddSection, { role: "owner",  type, sections: sample(type), index: 1, open: true }));
    for (const kind of offeredKinds(type)) {
      const m = html.match(new RegExp(`<button[^>]*data-kind="${kind}"[^>]*>(.*?)</button>`));
      ok(m && m[1].includes(`>${sectionType(kind).label}</span>`), `${type}: ${kind} with its label`);
    }
    eq((html.match(/data-kind="/g) || []).length, offeredKinds(type).length, `${type}: only its kinds`);
  }
  const home = renderToStaticMarkup(React.createElement(AddSection, { role: "owner",  type: "home", sections: sample("home"), index: 1, open: true, afterLabel: "hero" }));
  ok(/<button[^>]*disabled=""[^>]*data-kind="hero"/.test(home) || /<button[^>]*data-kind="hero"[^>]*disabled=""/.test(home), "a second hero is disabled");
  ok(home.includes("The home page already has a hero. It can have only one."), "with its reason");
  ok(home.includes("Adds below the hero"), "says where it adds");
  const closed = renderToStaticMarkup(React.createElement(AddSection, { role: "owner",  type: "home", sections: [], index: 0 }));
  ok(closed.includes("Add a section") && !closed.includes("data-kind"), "closed, it is one button");
});

// ---- P3-FIX3: the batch 3 review findings --------------------------------------------
console.log("— P3-FIX3");

// Drive the real component: a host calls it as a plain function (its hooks are
// the host's), and the element tree it returns is searched for a button's props.
function drive(Component, props) {
  let tree = null;
  const Host = () => {
    tree = Component(props);
    return null;
  };
  renderToStaticMarkup(React.createElement(Host));
  const all = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.props) {
      all.push(node);
      walk(node.props.children);
    }
  };
  walk(tree);
  const find = (pred) => all.find((n) => pred(n.props, n))?.props || null;
  return { find, all };
}
const record = () => {
  const changes = [];
  const selects = [];
  return { changes, selects, onChange: (next, info) => changes.push({ next, info }), onSelect: (id) => selects.push(id) };
};
// the whole row, its reasons list included (rowOf stops at the first </li>)
const wholeRow = (html, id) => {
  const start = html.indexOf(`data-section-row="${id}"`);
  ok(start >= 0, `no row for ${id}`);
  const next = html.indexOf("data-section-row=", start + 20);
  return html.slice(html.lastIndexOf("<li", start), next < 0 ? html.indexOf("</ol>", start) : html.lastIndexOf("<li", next));
};
const buttonTag = (html, label) => html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] || "";

await t("P3-FIX3 rendered: every enabled tree icon button keeps its label as its tooltip; a disabled one's title is its reason", () => {
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "home", sections: sample("home"), selectedId: "sec_text" }));
  const row = rowOf(html, "sec_text");
  for (const label of ["Move Text up", "Move Text down", "Hide Text", "Copy Text", "Delete Text"]) {
    const tag = buttonTag(row, label);
    ok(tag && !tag.includes('disabled=""'), `${label} is enabled`);
    ok(tag.includes(`title="${label}"`), `${label} has its tooltip: ${tag}`);
  }
  const hero = buttonTag(rowOf(html, "sec_hero"), "Move Hero down");
  ok(/disabled=""/.test(hero) && /title="The hero can only go at the top/.test(hero), `disabled with its reason: ${hero}`);
});

await t("P3-FIX3 rendered: a disabled button's reason is text under the selected row (Phase 2 line 6 design: other rows keep it for screen readers), named by aria-describedby; at the top, Move up is disabled", () => {
  const quiet = wholeRow(renderToStaticMarkup(React.createElement(SectionTree, { type: "product_layout", sections: sample("product_layout"), selectedId: null })), "sec_main");
  ok(/<li id="sec_main--why-hide" class="sr-only">/.test(quiet), "an unselected row's reason is still there, for screen readers");
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "product_layout", sections: sample("product_layout"), selectedId: "sec_main" }));
  const row = wholeRow(html, "sec_main");
  for (const verb of ["Hide", "Copy", "Delete"]) {
    const tag = buttonTag(row, `${verb} Product details and buy button`);
    const id = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    ok(id, `${verb} names its reason: ${tag}`);
    const li = row.match(new RegExp(`<li id="${id}"( class="[^"]*")?>([^<]*)</li>`));
    ok(li && li[2].length > 10 && !/sr-only/.test(li[1] || ""), `${verb}: the reason is visible text: ${li?.[0]}`);
    ok(tag.includes(`title="${li[2].replace(/'/g, "&#x27;")}"`), `${verb}: the title is the same reason`);
  }
  ok(row.includes("can&#x27;t be hidden: shoppers need it to buy") || row.includes("can't be hidden: shoppers need it to buy"), "the hide reason is readable");
  // the first row: Move up is disabled, its reason only for screen readers
  const first = wholeRow(html, "sec_rich");
  const up = buttonTag(first, "Move Rich text up");
  ok(/disabled=""/.test(up), `Move up is disabled at the top: ${up}`);
  const upId = /aria-describedby="([^"]+)"/.exec(up)?.[1];
  ok(upId && new RegExp(`<li id="${upId}" class="sr-only">This section is already at the top.</li>`).test(first), "the top's reason is for screen readers");
  // an enabled button names nothing
  ok(!/aria-describedby/.test(buttonTag(wholeRow(renderToStaticMarkup(React.createElement(SectionTree, { type: "home", sections: sample("home"), selectedId: null })), "sec_text"), "Copy Text")), "an enabled button has no aria-describedby");
});

await t("P3-FIX3 unit+rendered: a copy (or an add) that would make the draft too big to save is refused with DRAFT_TOO_LARGE", async () => {
  const big = "x".repeat(19_000);
  const s = [sec("rich_text", "sec_big0", { html: `<p>${big}</p>` })];
  let sections = s;
  let copies = 0;
  for (; copies < 40; copies++) {
    const r = T.duplicate(sections, "sec_big0", { type: "page", body: bodyOf("page", sections) });
    if (!r.ok) {
      eq([r.code, /too big to save/.test(r.message)], ["DRAFT_TOO_LARGE", true], "refused:");
      break;
    }
    sections = r.sections;
    ok(validateDocument(bodyOf("page", sections), { mode: "draft" }).ok, `copy ${copies + 1} saves`);
  }
  ok(copies > 0 && copies < 40, `refused at copy ${copies + 1}`);
  // the refused copy really would not save
  const forced = [...sections, { ...sections[0], id: "sec_forced1" }];
  eq(validateDocument(bodyOf("page", forced), { mode: "draft" }).issues.filter((i) => i.code === "DRAFT_TOO_LARGE").length, 1, "the draft cap agrees:");
  // the tree shows Copy disabled with that reason
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "page", sections, body: bodyOf("page", sections), selectedId: null }));
  const tag = buttonTag(wholeRow(html, "sec_big0"), "Copy Rich text");
  ok(/disabled=""/.test(tag) && /too big to save/.test(tag), `Copy is disabled: ${tag}`);
  // without the body, the sections alone are measured
  eq(T.duplicate(sections, "sec_big0", { type: "page" }).code, "DRAFT_TOO_LARGE", "sections alone:");
  // an add too
  const { DRAFT_MAX_BYTES } = await import("../lib/registry/validate.js");
  const bytes = (b) => new TextEncoder().encode(JSON.stringify(b)).length;
  const near = bodyOf("page", s);
  near.meta.description = "";
  near.meta.description = "d".repeat(DRAFT_MAX_BYTES - bytes(near) - 20); // 20 bytes under the cap
  ok(bytes(near) <= DRAFT_MAX_BYTES, "the padded draft is under the cap");
  eq(T.add(s, "text", 1, { type: "page", body: near }).code, "DRAFT_TOO_LARGE", "an add over the cap:");
  ok(T.add(s, "text", 1, { type: "page", body: bodyOf("page", s) }).ok, "an add under the cap");
  // the tree passes its body: the copy is disabled and a call does nothing,
  // though the sections alone are small
  const padded = bodyOf("page", s);
  padded.meta.description = "d".repeat(DRAFT_MAX_BYTES - bytes(padded) - 100);
  const shown = renderToStaticMarkup(React.createElement(SectionTree, { type: "page", sections: s, body: padded, selectedId: null }));
  ok(/disabled=""/.test(buttonTag(wholeRow(shown, "sec_big0"), "Copy Rich text")), "Copy is disabled by the body's size");
  const rec = record();
  drive(SectionTree, { type: "page", sections: s, body: padded, selectedId: null, ...rec }).find((p) => p["aria-label"] === "Copy Rich text").onClick();
  eq(rec.changes.length, 0, "a copy call is refused:");
  ok(T.duplicate(s, "sec_big0", { type: "page", body: bodyOf("page", s) }).ok, "a small draft copies");
});

await t("P3-FIX3 driven: move, copy and delete call onChange and onSelect; Delete asks first; Move up is refused at the top", () => {
  const s = sample("home");
  // move: the moved row is selected (even an unselected one)
  let r = record();
  let d = drive(SectionTree, { type: "home", sections: s, selectedId: "sec_text", ...r });
  d.find((p) => p["aria-label"] === "Move Banner down").onClick();
  eq([r.changes[0].info.op, r.changes[0].next.map((x) => x.id), r.selects], ["moveDown", ["sec_hero", "sec_coll", "sec_text", "sec_bann", "sec_faq"], ["sec_bann"]], "move:");
  // copy: the copy is selected
  r = record();
  d = drive(SectionTree, { type: "home", sections: s, selectedId: "sec_text", ...r });
  d.find((p) => p["aria-label"] === "Copy Text").onClick();
  const copyId = r.changes[0].info.id;
  ok(copyId !== "sec_text" && r.changes[0].next[4].id === copyId, "the copy is below the original");
  eq(r.selects, [copyId], "the copy is selected:");
  // delete asks first: the trash icon calls nothing
  r = record();
  d = drive(SectionTree, { type: "home", sections: s, selectedId: "sec_text", ...r });
  d.find((p) => p["aria-label"] === "Delete Text").onClick();
  eq([r.changes.length, r.selects.length], [0, 0], "the trash icon only asks:");
  // the confirm: Delete removes, the neighbour is selected; Keep it removes nothing
  r = record();
  d = drive(SectionTree, { type: "home", sections: s, selectedId: "sec_text", confirmingId: "sec_text", ...r });
  ok(d.find((p) => p["aria-label"] === "Delete Text: Our story?"), "the confirm shows in the row");
  ok(!d.find((p) => p["aria-label"] === "Delete Text"), "the row's buttons give way to it");
  d.find((p, n) => n.type !== "p" && p.variant === "ghost" && p.children === "Keep it").onClick();
  eq(r.changes.length, 0, "Keep it changes nothing:");
  d.find((p) => p.variant === "destructive" && p.children === "Delete").onClick();
  eq([r.changes[0].info.op, r.changes[0].next.map((x) => x.id), r.selects], ["remove", ["sec_hero", "sec_coll", "sec_bann", "sec_faq"], ["sec_faq"]], "delete:");
  // at the top: Move up is disabled, and does nothing if called
  r = record();
  d = drive(SectionTree, { type: "home", sections: s, selectedId: null, ...r });
  const up = d.find((p) => p["aria-label"] === "Move Hero up");
  ok(up.disabled === true, "Move up is disabled at the top");
  up.onClick();
  eq(r.changes.length, 0, "and refused:");
});

await t("P3-FIX3 pin: a copy's block ids are minted against the document's ids (a drawn block id already in use is drawn again)", () => {
  defineSection({ kind: "tree_blocks2", documentTypes: ["page"], label: "Blocks probe two", blocks: { allowed: ["x"], max: 5 } });
  const real = crypto.getRandomValues.bind(crypto);
  let forced = 0;
  Object.defineProperty(crypto, "getRandomValues", { value: (arr) => (forced++ < 6 ? arr.fill(0xaa) : real(arr)), configurable: true, writable: true });
  try {
    const s = deepFreeze([{ id: "sec_bbbbbbbb", kind: "tree_blocks2", v: 1, enabled: true, settings: {}, blocks: [{ id: "blk_aaaaaaaa" }] }]);
    const r = T.duplicate(s, "sec_bbbbbbbb", { type: "page" });
    ok(r.ok, r.message);
    const ids = r.sections.flatMap((x) => [x.id, ...(x.blocks || []).map((b) => b.id)]);
    eq(ids.length, new Set(ids).size, `ids unique: ${ids}`);
    ok(forced >= 2, "the forced draws were used");
  } finally {
    delete crypto.getRandomValues;
    if (crypto.getRandomValues !== Object.getPrototypeOf(crypto).getRandomValues) Object.defineProperty(crypto, "getRandomValues", { value: real, configurable: true, writable: true });
    removeSection("tree_blocks2");
  }
});

await t("P3-FIX3 driven: AddSection adds below the selected row with the tree's collections, and selects the new section at once (ED-04)", () => {
  const s = sample("home").filter((x) => x.kind !== "collections");
  const collections = [
    { handle: "empty", id: "gid://shopify/Collection/1", available_count: 0, product_count: 0 },
    { handle: "protein", id: "gid://shopify/Collection/2", available_count: 3, product_count: 3 },
  ];
  const r = record();
  const d = drive(SectionTree, { type: "home", sections: s, selectedId: "sec_bann", collections, ...r });
  const addProps = d.find((p, n) => n.type === AddSection);
  eq([addProps.index, addProps.collections === collections, addProps.onSelect === r.onSelect, addProps.afterLabel], [s.findIndex((x) => x.id === "sec_bann") + 1, true, true, "banner"], "the picker's props:");
  const picker = drive(AddSection, { ...addProps, open: true });
  picker.find((p) => p["data-kind"] === "product_rail").onClick();
  const { next, info } = r.changes[0];
  const at = next.findIndex((x) => x.id === info.id);
  eq([info.op, at, next[at].kind, r.selects], ["add", s.findIndex((x) => x.id === "sec_bann") + 1, "product_rail", [info.id]], "added below and selected:");
  ok(JSON.stringify(next[at]).includes("protein") && !JSON.stringify(next[at]).includes('"empty"'), `the rail got the collection with products: ${JSON.stringify(next[at].settings)}`);
  // nothing selected: at the end
  const r2 = record();
  const d2 = drive(SectionTree, { type: "home", sections: s, selectedId: null, ...r2 });
  eq(d2.find((p, n) => n.type === AddSection).index, s.length, "nothing selected: at the end:");
});

await t("P3-FIX3 rendered: 'Needs a fix' marks a section with an error, and only that one", () => {
  const s = sample("home");
  const issues = { sec_text: [{ severity: "error", code: "TOO_LONG", sectionId: "sec_text", message: "Too long." }], sec_faq: [{ severity: "warning", code: "X", sectionId: "sec_faq", message: "Check." }] };
  const html = renderToStaticMarkup(React.createElement(SectionTree, { type: "home", sections: s, selectedId: null, issuesBySection: issues }));
  ok(rowOf(html, "sec_text").includes(">Needs a fix</span>"), "the error row");
  for (const id of ["sec_hero", "sec_coll", "sec_bann", "sec_faq"]) ok(!rowOf(html, id).includes("Needs a fix"), `${id} is not marked`);
});

await t("no reason or hint in the tree ends in a doubled full stop (the hero's place: '…of the home page.', never 'page..')", () => {
  const hero = { id: "sec_h", kind: "hero", v: 1, enabled: true, settings: {}, blocks: [] };
  const text = { id: "sec_t", kind: "text", v: 1, enabled: true, settings: { title: "x", body: ["y"] }, blocks: [] };
  const seen = [];
  for (const type of ["home", "page", "product_layout", "collection_layout"])
    for (const secs of [[], [hero], [hero, text], [text]]) {
      for (const i of [0, secs.length]) for (const o of T.addOptions(type, secs, i)) seen.push(o.reason);
      for (const sec of secs) for (const v of Object.values(T.rowActions(secs, sec.id, type))) seen.push(v?.reason);
    }
  const words = seen.filter((w) => typeof w === "string");
  ok(words.some((w) => w === "The hero can only go at the top of the home page."), "the hero's place reads as one sentence");
  eq(words.filter((w) => /\.\.(\s|$)/.test(w)), [], "doubled full stops:");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
