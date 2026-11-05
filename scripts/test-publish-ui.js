// P3-PUBLISHUI suite (PUB-02, PUB-03, PUB-04, PUB-05, PUB-09): the publish
// panel, Undo, take offline, Earlier versions and Recently published.
//   pnpm test:publish-ui
// Two kinds of test (phase 3 plan section 1):
//   unit      components/admin/editor/publish/publishModel.js driven in node
//             with a stubbed `call` (the documentsApi client's signature); the
//             stub answers with lib/admin/documents-api-shapes.js examples
//             passed through the real client mapper (documentsApi.mapResponse)
//   rendered  the real components compiled with Next's own SWC and rendered
//             with react-dom/server from the model's state (no effects, no events)
// No database, no server, no port.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const started = Date.now();
const require = createRequire(import.meta.url);

const M = await import("../components/admin/editor/publish/publishModel.js");
const { mapResponse } = await import("../components/admin/editor/documentsApi.js");
const { SHAPES, COMMON, OFFER, PUBLISH_ACTION_TYPES } = await import("../lib/admin/documents-api-shapes.js");

let pass = 0;
let fail = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function t(name, fn) {
  if (only && !only.test(name)) return;
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ") || e.message}`);
  }
}
const eq = (got, want, label = "") => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "expected truthy") => {
  if (!cond) throw new Error(label);
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- rendering the real components --------------------------------------------------

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
// JSX lives in components/; the model and the client are plain ESM, loaded
// once, so the components share this suite's instances.
const isJsx = (file) => /^components\//.test(relative(ROOT, file)) && !/(Model|documentsApi)\.js$/.test(file);
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
const PUB = join(ROOT, "components/admin/editor/publish");
const Panel = await loadJsx(join(PUB, "PublishPanel.js"));
const Undo = await loadJsx(join(PUB, "UndoNotice.js"));
const Offline = await loadJsx(join(PUB, "TakeOfflineConfirm.js"));
const Earlier = await loadJsx(join(PUB, "EarlierVersions.js"));
const Recent = await loadJsx(join(PUB, "RecentlyPublished.js"));
const html = (el) => renderToStaticMarkup(el);
const h = React.createElement;

// What the founder reads: the text, with tags and attributes gone.
const textOf = (markup) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const CODE_RE = /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/;
const ID_RE = /\b(doc|ver|log|rel|set|sec|blk|usr)_[A-Za-z0-9]+|\bh_(draft|live)\w*|merchant:|operator:/;
// plain words: no code anywhere in the markup (attributes included), and no
// id or hash in the text the founder reads
function plain(markup, label) {
  const code = markup.match(CODE_RE);
  if (code) throw new Error(`${label}: a code is in the markup: ${code[0]}\n    ${textOf(markup).slice(0, 300)}`);
  const text = textOf(markup);
  const id = text.match(ID_RE);
  if (id) throw new Error(`${label}: an id or hash is in the text: ${id[0]}\n    ${text.slice(0, 300)}`);
  if (!text.length) throw new Error(`${label}: renders no words`);
  return text;
}

// ---- a stubbed client ---------------------------------------------------------------

// The documentsApi result of one shapes outcome.
const answer = (outcome) => mapResponse(outcome.status, clone(outcome.body));
const P = SHAPES.publish.outcomes;
const DOC = (over = {}) => ({ ...clone(SHAPES.getDocument.outcomes.ok.body.document), ...over });
const HOME_BODY = {
  type: "home",
  sections: [
    { id: "sec_hero", kind: "hero", enabled: true, settings: { title: "", buttons: [{ label: "Shop" }, { label: "Old" }] } },
    { id: "sec_promo", kind: "text", enabled: true, settings: { links: [{ href: "/campaigns/diwali" }, { href: "/x" }] } },
    { id: "sec_rail", kind: "product_rail", enabled: true, settings: { products: ["a", "b", "c"] } },
  ],
};

// call(op, args, extra) answering from `script`: { op: result | (args, extra, n) => result }.
// Every call is recorded.
// P6-OPEN-UI: flow.open always asks openingChecks first. A script without an
// openingChecks entry answers it as an open store does (opening: false, the
// shapes' `open` outcome), and that read is recorded in fn.checks, not in
// calls, so the phase 3 to 5 cases keep their call lists and prove the
// opening: false path goes on exactly as before. A script with an
// openingChecks entry records it in calls like any other op.
const OPEN_STORE = () => mapResponse(SHAPES.openingChecks.outcomes.open.status, clone(SHAPES.openingChecks.outcomes.open.body));
function stub(script = {}) {
  const calls = [];
  const checks = [];
  const counts = {};
  const fn = async (op, args, extra) => {
    if (op === "openingChecks" && script.openingChecks === undefined) {
      checks.push({ op, args: clone(args), before: calls.length });
      return OPEN_STORE();
    }
    calls.push({ op, args: clone(args), extra: extra === undefined ? undefined : clone(extra) });
    counts[op] = (counts[op] || 0) + 1;
    const s = script[op];
    if (s === undefined) throw new Error(`unexpected call ${op}`);
    return typeof s === "function" ? s(args, extra, counts[op]) : clone(s);
  };
  fn.calls = calls;
  fn.checks = checks;
  fn.ops = () => calls.map((c) => c.op);
  return fn;
}
const changes = (rows) => ({ ok: true, data: { ok: true, firstPublish: false, rows } });
const firstPub = (sections) => ({ ok: true, data: { ok: true, firstPublish: true, sections: sections.map((w) => ({ words: w })) } });
const HOME = { id: "doc_home", label: "Home page", type: "home", revision: 3, draftHash: "h_draft" };
const SALE = { id: "doc_7Q2M4K8P1R5T9V3X", label: "Diwali sale", type: "campaign", revision: 2, draftHash: "h_draft2" };
const renderPanel = (flow, extra = {}) => html(h(Panel.PublishPanelView, { state: flow.getState(), canConfirm: flow.canConfirm(), call: async () => ({}), ...extra }));
// a deferred answer
const later = () => {
  let res;
  const p = new Promise((r) => (res = r));
  return { p, res };
};
const tick = () => new Promise((r) => setImmediate(r));

console.log("— issue actions as client steps (unit)");

await t("hideSection, removeSection and removeItem are a saveDraft of the edited body, then the same publish", () => {
  for (const type of ["hideSection", "removeSection", "removeItem"]) {
    const action = { type, documentId: "doc_home", sectionId: "sec_hero", ...(type === "removeItem" ? { field: "buttons", index: 1 } : {}) };
    const steps = M.stepsFor(action, { items: [HOME] });
    eq(
      steps.map((s) => s.kind),
      ["getDocument", "saveDraft", "publish"],
      `${type}:`,
    );
    eq(steps[1].edit, action, `${type} edits with the action:`);
    eq(steps[2].after, "saved", `${type} publishes with the saved revision:`);
    eq(
      steps[2].items.map((i) => i.id),
      ["doc_home"],
      `${type} publishes the same documents:`,
    );
    // the draft the host already holds is used as it is, not read again
    eq(
      M.stepsFor(action, { items: [HOME], bodies: { doc_home: HOME_BODY } }).map((s) => s.kind),
      ["saveDraft", "publish"],
      `${type} with a known body:`,
    );
  }
});

await t("applyAction hides, removes a section, and removes one entry of a section list or a document list", () => {
  const hidden = M.applyAction(HOME_BODY, { type: "hideSection", documentId: "doc_home", sectionId: "sec_hero" });
  eq(hidden.body.sections[0].enabled, false, "hidden:");
  eq(HOME_BODY.sections[0].enabled, true, "the input body is not changed:");
  const removed = M.applyAction(HOME_BODY, { type: "removeSection", documentId: "doc_home", sectionId: "sec_promo" });
  eq(
    removed.body.sections.map((s) => s.id),
    ["sec_hero", "sec_rail"],
    "removed:",
  );
  const item = M.applyAction(HOME_BODY, { type: "removeItem", documentId: "doc_home", sectionId: "sec_rail", field: "products", index: 2 });
  eq(item.body.sections[2].settings.products, ["a", "b"], "a product in a rail:");
  const header = { type: "header", sections: [], settings: { items: [{ label: "A" }, { label: "B" }] }, meta: { redirect_from: ["old", "older"] } };
  eq(M.applyAction(header, { type: "removeItem", documentId: "doc_header", field: "items", index: 0 }).body.settings.items, [{ label: "B" }], "a menu item:");
  eq(M.applyAction(header, { type: "removeItem", documentId: "doc_page", field: "meta.redirect_from", index: 1 }).body.meta.redirect_from, ["old"], "an old address:");
  for (const gone of [
    { type: "hideSection", documentId: "doc_home", sectionId: "sec_nope" },
    { type: "removeItem", documentId: "doc_home", sectionId: "sec_rail", field: "products", index: 9 },
    { type: "removeItem", documentId: "doc_home", sectionId: "sec_rail", field: "nothing", index: 0 },
  ]) {
    const r = M.applyAction(HOME_BODY, gone);
    eq(r.ok, false, `${JSON.stringify(gone)} refused:`);
    plain(`<p>${r.message}</p>`, "the refusal");
  }
});

await t("a fix runs getDocument, saveDraft (edited body, its revision), then publish with the saved revision and hash", async () => {
  const saved = DOC({ revision: 4, draftHash: "h_after_fix" });
  const call = stub({
    listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]),
    publish: (a, x, n) => (n === 1 ? answer(P.validationFailed) : answer(P.ok)),
    getDocument: { ok: true, data: { ok: true, document: DOC({ body: HOME_BODY, revision: 3 }) } },
    saveDraft: { ok: true, data: { ok: true, document: saved, issues: [] } },
  });
  const adopted = [];
  const flow = M.createPublishFlow({ call, onDocument: (d) => adopted.push(d.revision) });
  await flow.open([HOME]);
  await flow.confirm();
  eq(flow.getState().phase, "blocked", "refused first:");
  const issue = flow.getState().outcome.issues[0];
  await flow.act(issue.actions[0], issue); // hideSection
  eq(call.ops(), ["listChanges", "publish", "getDocument", "saveDraft", "publish"], "calls:");
  // P6-OPEN-UI: the one read before them all (fn.checks, see stub())
  eq(call.checks.map((c) => [c.op, c.args, c.before]), [["openingChecks", { ids: ["doc_home"] }, 0]], "openingChecks first, for the set:");
  const save = call.calls[3];
  eq(save.args.id, "doc_home", "saved document:");
  eq(save.args.body.sections[0].enabled, false, "the hero is hidden in the saved body:");
  eq(save.extra, { revision: 3 }, "saved with the read revision:");
  eq(call.calls[4].args, { id: "doc_home", draftHash: "h_after_fix" }, "published with the saved hash:");
  eq(call.calls[4].extra, { revision: 4, checkOpening: true }, "and the saved revision (P6-OPEN-UI: and checkOpening):");
  eq(adopted, [4], "the host adopts the saved document:");
  eq(flow.getState().phase, "done", "then published:");
});

await t("removeItem on a warning after a publish saves without the entry and publishes again", async () => {
  const call = stub({
    listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]),
    publish: answer(P.ok),
    saveDraft: { ok: true, data: { ok: true, document: DOC({ revision: 5, draftHash: "h_x" }), issues: [] } },
  });
  const flow = M.createPublishFlow({ call, documentOf: () => ({ body: HOME_BODY, revision: 4 }) });
  await flow.open([HOME]);
  await flow.confirm();
  const w = flow.getState().outcome.warnings[0];
  eq(w.actions[0].type, "removeItem", "the warning's action:");
  await flow.act(w.actions[0], w);
  eq(call.ops(), ["listChanges", "publish", "saveDraft", "publish"], "no getDocument when the host holds the draft:");
  eq(call.calls[2].args.body.sections[2].settings.products, ["a", "b"], "the third product is gone:");
  eq(call.calls[2].extra, { revision: 4 }, "saved with the host's revision:");
});

await t("publishBoth sends exactly the offer as publishSet, after every offered list loaded", async () => {
  const call = stub({
    listChanges: (a) => (a.id === "doc_home" ? changes([{ kind: "edited", sectionId: "sec_promo", words: "Text: links changed" }]) : firstPub(["Hero", "Text"])),
    publish: answer(P.linksToUnpublished),
    publishSet: answer(P.ok),
  });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  await tick();
  eq(flow.getState().phase, "offer", "offered:");
  ok(flow.canConfirm(), "confirm on once loaded");
  await flow.confirm();
  const sent = call.calls.find((c) => c.op === "publishSet");
  eq(
    sent.args,
    OFFER.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })),
    "exactly the offer's documents, revisions and hashes:",
  );
  ok(
    sent.args.every((i) => !("confirmRepublish" in i)),
    "nothing added",
  );
  eq(sent.extra, { checkOpening: true }, "no top-level revision on a set (P6-OPEN-UI: only checkOpening):");
  eq(M.stepsFor({ type: "publishBoth", documentId: SALE.id }, { offer: OFFER }).map((s) => s.kind), ["review", "publish"], "steps:");
});

await t("openField focuses the field and sends nothing", async () => {
  const focus = [];
  const call = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]) });
  const flow = M.createPublishFlow({ call, onFocus: (f) => focus.push(f) });
  await flow.open([HOME]);
  const issue = { ...clone(P.validationFailed.body.issues[0]), actions: [{ type: "openField", documentId: "doc_home", sectionId: "sec_hero", field: "title" }] };
  await flow.act(issue.actions[0], issue);
  eq(focus, [{ kind: "focus", anchor: "f-sec_hero-title", documentId: "doc_home", sectionId: "sec_hero", field: "title" }], "focused:");
  eq(call.ops(), ["listChanges"], "no call for openField:");
  // a document-level openField with no issue anchor still gets the field's anchor
  eq(M.stepsFor({ type: "openField", documentId: "doc_x", field: "meta.title" })[0].anchor, "f-doc-meta-title", "doc anchor:");
});

await t("every action type of the contract has words and steps", () => {
  eq([...M.ACTION_TYPES].sort(), [...PUBLISH_ACTION_TYPES].sort(), "the same action types as documents-api-shapes.js:");
  for (const type of PUBLISH_ACTION_TYPES) {
    const a = { type, documentId: "doc_home", sectionId: "sec_hero", field: "buttons", index: 0 };
    ok(M.actionLabel(a).length > 3, `${type} has words`);
    ok(M.stepsFor(a, { items: [HOME], offer: OFFER }).length > 0, `${type} has steps`);
  }
});

console.log("— offers: review every target before Confirm (unit + rendered)");

async function offerCase(result, { start = [HOME] } = {}) {
  const pending = {};
  const call = stub({
    listChanges: (a) => {
      const d = later();
      pending[a.id] = d.res;
      return d.p;
    },
    publish: result,
    publishSet: answer(P.ok),
  });
  const flow = M.createPublishFlow({ call });
  const opening = flow.open(start);
  await tick();
  pending[start[0].id](changes([{ kind: "edited", sectionId: "sec_promo", words: "Text: links changed" }]));
  await opening;
  const confirming = flow.confirm();
  await tick();
  return { call, flow, pending, confirming };
}

await t("LINKS_TO_UNPUBLISHED: listChanges for each offered document, Confirm disabled until all have loaded", async () => {
  const { call, flow, pending } = await offerCase(answer(P.linksToUnpublished));
  eq(flow.getState().phase, "offer", "offer:");
  eq(
    call.calls.filter((c) => c.op === "listChanges").map((c) => c.args.id),
    ["doc_home", "doc_home", SALE.id],
    "lists requested for every offered document (the review's, then the offer's):",
  );
  ok(!flow.canConfirm(), "Confirm disabled while loading");
  let page = renderPanel(flow);
  ok(/<button[^>]*disabled=""[^>]*>Publish both<\/button>/.test(page), "the rendered Confirm is disabled while loading");
  ok(page.includes(M.WORDS.offerWaiting), "says why");
  await flow.confirm();
  eq(call.ops().filter((o) => o === "publishSet").length, 0, "a confirm before the lists loaded sends nothing:");
  pending.doc_home(changes([{ kind: "edited", sectionId: "sec_promo", words: "Text: links changed" }]));
  await tick();
  ok(!flow.canConfirm(), "still disabled with one list left");
  pending[SALE.id](firstPub(["Hero", "Text"]));
  await tick();
  ok(flow.canConfirm(), "enabled once every list has loaded");
  page = renderPanel(flow);
  const text = plain(page, "offer");
  ok(text.includes("Text: links changed"), "the home page's changes are listed");
  ok(text.includes("Diwali sale") && text.includes(M.WORDS.firstPublish) && text.includes("Hero"), "the target's first-publish sections are listed");
  ok(!/<button[^>]*disabled=""[^>]*>Publish both<\/button>/.test(page), "Confirm is enabled");
  ok(!page.includes("Keep the live version"), "no keep-live inside an offer review");
});

await t("a list that failed to load keeps Confirm disabled", async () => {
  const { flow, pending } = await offerCase(answer(P.linksToUnpublished));
  pending.doc_home(changes([]));
  pending[SALE.id]({ error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy." });
  await tick();
  ok(!flow.canConfirm(), "disabled after a failed list");
  ok(textOf(renderPanel(flow)).includes("We couldn't reach Storeasy."), "the failure is shown");
});

await t("FIRST_PUBLISH_NEEDS_HOME with an offer reviews the home page's first-publish sections before Confirm", async () => {
  const { call, flow, pending } = await offerCase(answer(P.firstPublishNeedsHome), { start: [SALE] });
  eq(flow.getState().phase, "offer", "offer:");
  eq(flow.getState().outcome.reason, "home", "reason:");
  ok(!flow.canConfirm(), "disabled while loading");
  pending.doc_home(firstPub(["Hero", "Product rail"]));
  pending[SALE.id](changes([{ kind: "edited", sectionId: "sec_x", words: "Banner: title changed" }]));
  await tick();
  ok(flow.canConfirm(), "enabled after both");
  const text = plain(renderPanel(flow), "first publish offer");
  ok(text.includes(M.WORDS.offerHome) && text.includes("Product rail") && text.includes("Publish with the home page"), text);
  await flow.confirm();
  eq(call.calls.at(-1).op, "publishSet", "sent as a set:");
});

await t("Publish all changes: each hash is read before its list, every list loads before Confirm, then one publishSet", async () => {
  const order = [];
  const pending = {};
  const call = stub({
    getDocument: (id) => {
      order.push(`get ${id}`);
      return { ok: true, data: { ok: true, document: DOC({ id, label: id === "doc_home" ? "Home page" : "Diwali sale", revision: 7, draftHash: `h_${id}` }) } };
    },
    publishSet: answer(P.ok),
  });
  const flow = M.createPublishFlow({
    call,
    loadChanges: (id) => {
      order.push(`list ${id}`);
      const d = later();
      pending[id] = d.res;
      return d.p;
    },
  });
  const opening = flow.open([{ id: "doc_home" }, { id: SALE.id }]);
  await tick();
  await tick();
  ok(order.indexOf(`get ${SALE.id}`) < order.indexOf(`list ${SALE.id}`) && order.indexOf("get doc_home") < order.indexOf("list doc_home"), `pinned first: ${order}`);
  ok(!flow.canConfirm(), "disabled while loading");
  pending.doc_home(changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]));
  await tick();
  ok(!flow.canConfirm(), "still disabled with one list left, though that list has changes");
  pending[SALE.id](changes([{ kind: "added", sectionId: "sec_new", words: "Banner: added" }]));
  await opening;
  ok(flow.canConfirm(), "enabled");
  const page = renderPanel(flow, { mode: "all" });
  const text = plain(page, "publish all");
  ok(text.includes("Hero: title changed") && text.includes("Banner: added") && text.includes("Publish all changes"), text);
  await flow.confirm();
  eq(call.calls.at(-1).args, [
    { id: "doc_home", revision: 7, draftHash: "h_doc_home" },
    { id: SALE.id, revision: 7, draftHash: `h_${SALE.id}` },
  ], "the pinned hashes:");
});

console.log("— the single-document panel (unit + rendered)");

await t("the review lists the changed sections with Keep the live version, and Confirm waits for the list", async () => {
  const d = later();
  const call = stub({ listChanges: () => d.p, publish: answer(P.ok) });
  const flow = M.createPublishFlow({ call });
  const opening = flow.open([HOME]);
  await tick();
  ok(!flow.canConfirm(), "disabled while loading");
  ok(textOf(renderPanel(flow)).includes(M.WORDS.loadingChanges), "loading words");
  const listed = clone(answer(SHAPES.listChanges.outcomes.ok));
  listed.data.rows.push({ kind: "settings", words: "Page settings: title changed" }); // a document-level row: no sectionId
  d.res(listed);
  await opening;
  ok(flow.canConfirm(), "enabled");
  const page = renderPanel(flow);
  const text = plain(page, "review");
  ok(text.includes("Hero: title changed") && text.includes("Buttons on every page") && text.includes("Page settings: title changed"), text);
  eq((page.match(/>Keep the live version</g) || []).length, 1, "Keep the live version only on the row with a section:");
});

await t("nothing changed: nothing to publish, Confirm stays off", async () => {
  const call = stub({ listChanges: changes([]) });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  ok(!flow.canConfirm(), "nothing to publish");
  ok(textOf(renderPanel(flow)).includes(M.WORDS.nothingChanged), "says so");
});

await t("Keep the live version calls keepLiveSection with the revision, re-pins the hash and reloads the list", async () => {
  let n = 0;
  const call = stub({
    listChanges: () => (++n === 1 ? changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }, { kind: "edited", sectionId: "sec_promo", words: "Text: changed" }]) : changes([{ kind: "edited", sectionId: "sec_promo", words: "Text: changed" }])),
    keepLiveSection: { ok: true, data: { ok: true, document: DOC({ revision: 4, draftHash: "h_kept" }) } },
    publish: answer(P.ok),
  });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.keepLive("doc_home", "sec_hero");
  eq(call.calls[1], { op: "keepLiveSection", args: { id: "doc_home", sectionId: "sec_hero" }, extra: { revision: 3 } }, "call:");
  eq(call.calls[2].op, "listChanges", "reloaded:");
  const text = textOf(renderPanel(flow));
  ok(!text.includes("Hero: title changed") && text.includes("Text: changed") && text.includes(M.WORDS.keepLiveDone), text);
  await flow.confirm();
  eq(call.calls.at(-1).args, { id: "doc_home", draftHash: "h_kept" }, "publishes the kept draft's hash:");
  eq(call.calls.at(-1).extra, { revision: 4, checkOpening: true }, "and revision (P6-OPEN-UI: and checkOpening):");
});

console.log("— every outcome in plain words (rendered, from documents-api-shapes.js)");

const outcomesOf = (op) => {
  const s = SHAPES[op];
  return { ...COMMON.outcomes, ...(s.sameOutcomesAs ? SHAPES[s.sameOutcomesAs].outcomes : s.outcomes) };
};

await t("every publish outcome renders plain words, with no code, hash or id", async () => {
  for (const [name, outcome] of Object.entries(outcomesOf("publish"))) {
    const call = stub({
      listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]),
      publish: answer(outcome),
      publishSet: answer(outcome),
      getDocument: { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy." },
    });
    const flow = M.createPublishFlow({ call, labels: { doc_X: "Product content", doc_journal_index: "Journal index" } });
    await flow.open([HOME]);
    await flow.confirm();
    await tick();
    const text = plain(renderPanel(flow), `publish ${name}`);
    const phase = flow.getState().phase;
    ok(phase !== "review" && phase !== "closed", `${name} left the review (${phase})`);
    if (name === "ok") ok(text.includes("Published") && text.includes("Undo") && text.includes(M.WORDS.seeLive), `${name}: ${text}`);
  }
});

await t("PUBLISH_UNKNOWN shows 'Checking…' and is resolved from the release it names", async () => {
  const unknown = answer(P.unknown);
  eq(unknown.release, { id: "rel_1" }, "the client keeps the release:");
  const run = async ({ live, docs }) => {
    const call = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]), publish: unknown, getDocument: docs });
    const seenStates = [];
    const flow = M.createPublishFlow({ call, checkLive: async (release) => (eq(release, { id: "rel_1" }, "asked about the named release:"), live) });
    flow.subscribe((s) => seenStates.push(s.phase === "checking" ? textOf(renderPanel({ getState: () => s, canConfirm: () => false })) : null));
    await flow.open([HOME]);
    await flow.confirm();
    ok(seenStates.includes(M.WORDS.checking), `showed ${M.WORDS.checking}`);
    return { flow, call, text: plain(renderPanel(flow), "checked") };
  };
  let r = await run({ live: "rel_1", docs: { error: true, message: "x" } });
  ok(r.text.includes(M.WORDS.checkedLive), r.text);
  eq(r.call.ops().includes("getDocument"), false, "no document read when the release is live:");
  r = await run({ live: "rel_other", docs: { ok: true, data: { ok: true, document: DOC({ publishedHash: "h_draft" }) } } });
  ok(r.text.includes(M.WORDS.checkedLive), `went live by its hash: ${r.text}`);
  r = await run({ live: "rel_other", docs: { ok: true, data: { ok: true, document: DOC({ publishedHash: "h_older" }) } } });
  ok(r.text.includes(M.WORDS.checkedNotLive) && r.text.includes(M.WORDS.tryAgain), `not live: ${r.text}`);
  r = await run({ live: undefined, docs: { error: true, code: "NETWORK_ERROR", message: "x" } });
  ok(r.text.includes(M.WORDS.checkedUnknown), `can't tell: ${r.text}`);
});

await t("SLUG_TAKEN and NOT_PUBLISHABLE name the other page and give the next step", async () => {
  const slug = M.outcomeOf(answer(P.slugTaken), { items: [HOME, { id: "doc_7Q2M4K8P1R5T9V3X", label: "About (new)" }] });
  const text = plain(html(h(Panel.PublishPanelView, { state: { phase: "refused", outcome: slug, items: [], order: [], lists: {} }, on: { openDocument: () => {} } })), "slug");
  ok(text.includes("“About (new)” wants the address /about") && text.includes("“About us” already uses it"), text);
  ok(text.includes("Change the address of “About (new)”") && text.includes("Open “About us”"), text);
  eq(slug.otherId, "doc_K3M5P7R9T1V3X5Z7", "the other page, to open:");
  eq(slug.fixAnchor, "f-doc-meta-slug", "the address field:");
  const np = M.outcomeOf(answer(P.notPublishable), { items: [HOME], labels: { doc_journal_index: "Journal index" } });
  const npText = plain(html(h(Panel.PublishPanelView, { state: { phase: "refused", outcome: np, items: [], order: [], lists: {} } })), "not publishable");
  ok(npText.includes("“Journal index” can't be published on its own") && npText.includes("goes live with the pages that use it"), npText);
});

await t("every Undo, take-offline and whole-set Undo outcome renders plain words", async () => {
  const targets = {
    undo: { kind: "one", label: "Home page", undo: { id: "doc_home", revision: 4, logId: "log_1" } },
    unpublish: { kind: "offline", label: "Diwali sale", id: SALE.id, revision: 2 },
    undoSet: { kind: "set", setId: "set_1", members: [{ id: "doc_home", logId: "log_1" }, { id: SALE.id, logId: "log_2" }], labels: ["Home page", "Diwali sale"] },
  };
  for (const op of ["undo", "unpublish", "undoSet"]) {
    const outs = outcomesOf(op);
    for (const [name, outcome] of Object.entries(outs)) {
      if (name === "dryRun") continue;
      const call = stub({ [op]: (a) => (a.dryRun ? answer(outs.dryRun) : answer(outcome)) });
      const flow = M.createUndoFlow({ call });
      await flow.start(targets[op]);
      const confirmText = plain(html(h(Undo.UndoNoticeView, { state: flow.getState(), target: targets[op] })), `${op} confirm`);
      ok(confirmText.includes("Hero: title changed"), `${op}: the dry run's change words are in the confirm: ${confirmText}`);
      await flow.confirm();
      plain(html(h(Undo.UndoNoticeView, { state: flow.getState(), target: targets[op] })), `${op} ${name}`);
      eq(call.calls[0].args.dryRun, true, `${op}: dry run first:`);
      ok(!("dryRun" in call.calls[1].args), `${op}: then the real one`);
    }
  }
});

await t("the Undo confirm shows the dry run's change words and where it goes back to", async () => {
  const call = stub({ undo: (a) => (a.dryRun ? answer(SHAPES.undo.outcomes.dryRun) : answer(SHAPES.undo.outcomes.ok)) });
  const flow = M.createUndoFlow({ call });
  const target = { kind: "one", label: "Home page", undo: clone(SHAPES.publish.outcomes.ok.body.published[0].undo) };
  await flow.start(target);
  eq(call.calls[0], { op: "undo", args: { id: "doc_home", logId: "log_1", dryRun: true }, extra: { revision: 4 } }, "the dry run, with the undo args:");
  const text = plain(html(h(Undo.UndoNoticeView, { state: flow.getState(), target })), "undo confirm");
  ok(text.includes(M.WORDS.undoWillChange) && text.includes("Hero: title changed") && text.includes("It goes back to: Published 2 Nov, 10:00 by Asha."), text);
  await flow.confirm();
  eq(call.calls[1], { op: "undo", args: { id: "doc_home", logId: "log_1" }, extra: { revision: 4 } }, "then the undo:");
  ok(textOf(html(h(Undo.UndoNoticeView, { state: flow.getState(), target }))).includes("Home page is back to the version from 2 Nov, 10:00."), "the result");
});

await t("TakeOfflineConfirm lists the linkers and the dry run's words", async () => {
  const view = M.dryRunView({ kind: "offline", label: "Old sale" }, SHAPES.unpublish.outcomes.dryRun.body);
  const page = html(h(Offline.default, { open: true, view, onConfirm() {}, onCancel() {} }));
  const text = plain(page, "take offline");
  ok(text.includes("Take “Old sale” offline?") && text.includes(M.WORDS.offlineLinkers) && text.includes("Hero: title changed") && text.includes(M.WORDS.offlineConfirm), text);
  ok(page.includes("<li>Diwali sale</li>"), "the linking page is listed");
  const none = plain(html(h(Offline.default, { open: true, view: { ...view, linkers: [] } })), "no linkers");
  ok(none.includes(M.WORDS.offlineNoLinkers), none);
  // an Undo whose dry run takes the page offline confirms with the same dialog
  const call = stub({ undo: (a) => (a.dryRun ? { ok: true, data: { ...clone(SHAPES.undo.outcomes.dryRun.body), willTakeOffline: true, target: null } } : answer(SHAPES.undo.outcomes.ok)) });
  const flow = M.createUndoFlow({ call });
  const target = { kind: "one", label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } };
  await flow.start(target);
  const undoPage = html(h(Undo.UndoNoticeView, { state: flow.getState(), target }));
  ok(undoPage.includes("data-take-offline") && textOf(undoPage).includes("Undo takes “Diwali sale” offline"), textOf(undoPage));
});

await t("whole-set Undo shows the server's words, which say which pages are live and which went offline", () => {
  const target = { kind: "set", setId: "set_1", members: [{ id: "doc_home", logId: "log_1" }, { id: SALE.id, logId: "log_2" }], labels: ["Home page", "Diwali sale"] };
  const message = "“Home page” is live again, as it was before that publish. “Diwali sale” is offline now, as it was before that publish. To bring it back, open it and publish it again.";
  const result = { ok: true, data: { ok: true, message, documents: [DOC({ live: true }), DOC({ id: SALE.id, label: "Diwali sale", live: false })] } };
  const out = M.undoOutcomeOf(target, result);
  const text = plain(html(h(Undo.UndoNoticeView, { state: { phase: "result", outcome: out }, target })), "set undo");
  ok(text.includes(message), text);
  ok(!text.includes("Undone.") && !text.includes("Live now"), `no words of its own on top: ${text}`);
});

await t("staff see Publish disabled with access.reason, and nothing opens", async () => {
  const access = clone(SHAPES.getDocument.outcomes.ok.body.document.access);
  const call = stub({});
  const page = html(h(Panel.default, { documents: [HOME], access, call }));
  ok(/<button[^>]*disabled=""[^>]*>Publish<\/button>/.test(page), "Publish disabled");
  ok(textOf(page).includes(access.reason), "the reason is shown");
  plain(page, "staff");
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME], { access });
  eq(call.calls.length, 0, "no call for staff:");
  const owner = html(h(Panel.default, { documents: [HOME], access: { canPublish: true, reason: null }, call }));
  ok(/<button[^>]*>Publish<\/button>/.test(owner) && !/disabled=""[^>]*>Publish</.test(owner), "an owner's Publish is enabled");
});

await t("RecentlyPublished hides Undo when canUndo is false, shows the offline note, and groups a set with whole-set Undo", () => {
  const row = clone(SHAPES.listRecentlyPublished.outcomes.ok.body.rows[0]);
  const rows = [
    { ...row, note: undefined },
    { ...row, logId: "log_2", documentId: SALE.id, label: "Diwali sale", summary: [{ words: "Banner: added" }], undo: { id: SALE.id, revision: 2, logId: "log_2" }, note: undefined },
    { ...row, logId: "log_3", setId: "set_2", label: "About us", canUndo: false, undo: null, action: "undo", actionWords: "Undid", note: "Publish it again from the editor to bring it back." },
    { ...row, logId: "log_4", setId: "set_3", label: "Header menu", canUndo: false, undo: null, note: undefined },
  ];
  const groups = M.recentGroupsOf(rows, { timeZone: "UTC" });
  eq(
    groups.map((g) => g.rows.length),
    [2, 1, 1],
    "grouped by set:",
  );
  eq(groups[0].undoSet.members, [{ id: "doc_home", logId: "log_1" }, { id: SALE.id, logId: "log_2" }], "whole-set Undo members:");
  eq(groups[1].undoSet, null, "no set Undo for one row:");
  const page = html(h(Recent.RecentlyPublishedView, { groups, state: { phase: "idle" }, onUndo() {}, onConfirm() {}, onCancel() {}, editorHref: (id) => `/admin/editor?doc=${id}` }));
  const text = plain(page, "recently published");
  ok(text.includes("Published Home page") && text.includes("Asha · 2 Nov, 10:00") && text.includes("Hero: title changed"), text);
  ok(text.includes("Undid About us") && text.includes("Publish it again from the editor to bring it back."), "the offline row's note");
  ok(text.includes("Undo all 2"), "whole-set Undo");
  const rowHtml = page.split('data-row=""');
  // rows: [prefix, home, sale, about, header]
  ok(rowHtml[1].includes(">Undo<") && rowHtml[2].includes(">Undo<"), "Undo on rows that can be undone");
  ok(!rowHtml[3].split("</li>")[0].includes(">Undo<") && !rowHtml[4].includes(">Undo<"), "no Undo on rows whose canUndo is false");
  // the real component renders the same, from the raw rows
  const real = html(h(Recent.default, { rows, call: async () => ({}), timeZone: "UTC" }));
  eq((real.match(/>Undo</g) || []).length, 2, "two Undo buttons in the real component:");
  plain(html(h(Recent.default, { rows: [], call: async () => ({}) })), "empty list");
});

await t("EarlierVersions shows 'Saved before Undo' and 'Kept from another tab' versions, each with Restore", async () => {
  const versions = [
    { id: "ver_3", kind: "undo_saved", createdAt: "2026-11-03T09:00:00.000Z", by: "Asha", note: "Saved before Undo", live: false },
    { id: "ver_2", kind: "undo_saved", createdAt: "2026-11-02T12:00:00.000Z", by: "Asha", note: "Kept from another tab", live: false },
    ...clone(SHAPES.listHistory.outcomes.ok.body.versions),
    { id: "ver_0", kind: "checkpoint", createdAt: "2026-11-01T08:00:00.000Z", by: "Someone on your team", note: null, live: false },
  ];
  const page = html(h(Earlier.default, { versions, timeZone: "UTC", onRestore: async () => ({ ok: true }) }));
  const text = plain(page, "earlier versions");
  for (const w of ["Saved before Undo", "Kept from another tab", "Published", "Live now", "Saved while you edited", "3 Nov, 09:00", M.WORDS.restoreNote]) ok(text.includes(w), `${w}: ${text}`);
  eq((page.match(/>Restore to draft</g) || []).length, 4, "a Restore on each:");
  const rows = M.historyRowsOf(versions, { timeZone: "UTC" });
  plain(`<p>${M.restoreOutcomeOf({ ok: true }, rows[0]).words}</p>`, "restored words");
  eq(M.restoreOutcomeOf({ error: true, message: "This page no longer exists." }, rows[0]).words, "This page no longer exists.", "a refusal's words:");
  ok(textOf(html(h(Earlier.default, { versions: [] }))).includes(M.WORDS.historyEmpty), "empty");
});

await t("listChanges outcomes render in the review: rows, first publish, refusals", async () => {
  for (const [name, outcome] of Object.entries(SHAPES.listChanges.outcomes)) {
    const call = stub({ listChanges: answer(outcome) });
    const flow = M.createPublishFlow({ call });
    await flow.open([HOME]);
    plain(renderPanel(flow), `listChanges ${name}`);
  }
});

console.log("— after the batch 2 review: openField, offers on 422, no home page, republish confirm (unit + rendered)");

await t("openField renders 'Go to this field' to the field's anchor, once", () => {
  const issue = { ...clone(P.validationFailed.body.issues[0]), actions: [{ type: "openField", documentId: "doc_home", sectionId: "sec_hero", field: "title" }] };
  const out = M.outcomeOf({ issues: [issue], code: "VALIDATION_FAILED", message: "There's 1 thing to fix in “Home page”, so nothing was published.", documents: [{ id: "doc_home", label: "Home page" }] }, { items: [HOME] });
  const page = html(h(Panel.PublishPanelView, { state: { phase: "blocked", outcome: out, items: [HOME], order: [], lists: {} } }));
  eq((page.match(/>Go to this field</g) || []).length, 1, "one link:");
  ok(page.includes('href="#f-sec_hero-title"'), "to the field anchor");
  const text = plain(page, "openField");
  ok(text.includes("Hero · Title") && text.includes("Add a title.") && text.includes("Must fix"), text);
});

await t("VALIDATION_FAILED with an offer beside other blocks: Publish both reviews the offer, says the other blocks still stop it, and sends exactly the offer", async () => {
  const body = clone(P.validationFailed.body);
  body.issues = [
    { ...body.issues[0], actions: [{ type: "hideSection", documentId: "doc_home", sectionId: "sec_hero" }] },
    { ...body.issues[0], sectionId: "sec_promo", code: "LINKS_TO_UNPUBLISHED", where: "Text · Link", message: "This page links to Diwali sale, which isn't published yet.", anchor: "f-sec_promo-links-0", actions: [{ type: "publishBoth", documentId: SALE.id }, { type: "removeItem", documentId: "doc_home", sectionId: "sec_promo", field: "links", index: 0 }] },
  ];
  const call = stub({
    listChanges: (a) => (a.id === SALE.id ? firstPub(["Banner"]) : changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }])),
    publish: mapResponse(422, body),
    publishSet: answer(P.validationFailed),
  });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  eq(flow.getState().phase, "blocked", "blocked first, with the offer kept:");
  let page = renderPanel(flow);
  ok(textOf(page).includes("Publish both") && textOf(page).includes("Hide this section and publish") && textOf(page).includes("Remove it and publish"), textOf(page));
  plain(page, "422 with offer");
  const link = flow.getState().outcome.issues[1];
  await flow.act(link.actions[0], link);
  await tick();
  eq(flow.getState().phase, "offer", "the offer review:");
  ok(flow.canConfirm(), "loaded");
  page = renderPanel(flow);
  ok(textOf(page).includes(M.WORDS.offerOtherBlocks) && textOf(page).includes("Banner"), textOf(page));
  eq(call.ops().filter((o) => o === "publishSet").length, 0, "nothing sent before Confirm:");
  await flow.confirm();
  eq(
    call.calls.at(-1).args,
    OFFER.publishSet.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })),
    "exactly the offer:",
  );
  eq(flow.getState().phase, "blocked", "the other block still stops it, in words:");
});

await t("FIRST_PUBLISH_NEEDS_HOME with offer null says there's no home page yet and links to making one", async () => {
  const call = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_x", words: "Banner: title changed" }]), publish: answer(P.firstPublishNoHome) });
  const flow = M.createPublishFlow({ call });
  await flow.open([SALE]);
  await flow.confirm();
  eq(flow.getState().phase, "noHome", "phase:");
  ok(!flow.canConfirm(), "nothing to confirm");
  const page = renderPanel(flow);
  const text = plain(page, "no home");
  ok(text.includes("doesn't have one yet") && text.includes(M.WORDS.noHomeAction), text);
  ok(page.includes('href="/admin/editor?path=%2F"'), "links to making the home page");
  const made = [];
  ok(html(h(Panel.PublishPanelView, { state: flow.getState(), on: { createHome: () => made.push(1) } })).includes(`>${M.WORDS.noHomeAction}</button>`), "or a button when the host can make it");
  eq(call.ops(), ["listChanges", "publish"], "no set is sent:");
});

await t("an offered target that was taken offline: one plain question naming the page, never a silent confirmRepublish", async () => {
  let sets = 0;
  const call = stub({
    listChanges: (a) => (a.id === SALE.id ? firstPub(["Banner"]) : changes([{ kind: "edited", sectionId: "sec_promo", words: "Text: links changed" }])),
    publish: answer(P.linksToUnpublished),
    publishSet: () => (++sets === 1 ? answer(P.republishConfirmNeeded) : answer(P.ok)),
  });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  await tick();
  await flow.confirm();
  eq(flow.getState().phase, "republish", "asks:");
  eq(sets, 1, "nothing is resent by itself:");
  ok(call.calls.filter((c) => c.op === "publishSet").every((c) => c.args.every((i) => !i.confirmRepublish)), "the first set carries no confirmRepublish");
  const text = plain(renderPanel(flow), "republish");
  ok(text.includes("You took “Diwali sale” offline. Publish the same content again?") && text.includes(M.WORDS.republishAction), text);
  await flow.confirm();
  const last = call.calls.at(-1);
  eq(last.op, "publishSet", "resent as the set:");
  eq(last.args, [
    { id: "doc_home", revision: 3, draftHash: "h_draft" },
    { id: SALE.id, revision: 2, draftHash: "h_draft2", confirmRepublish: true },
  ], "confirmRepublish only on the page the founder confirmed:");
  eq(flow.getState().phase, "done", "published:");
  // a single document's republish confirm is the same question
  const one = stub({ listChanges: firstPub(["Banner"]), publish: (a) => (a.confirmRepublish ? answer(P.ok) : answer(P.republishConfirmNeeded)) });
  const f1 = M.createPublishFlow({ call: one });
  await f1.open([SALE]);
  await f1.confirm();
  ok(textOf(renderPanel(f1)).includes("You took “Diwali sale” offline."), "named");
  await f1.confirm();
  eq(one.calls.at(-1).args, { id: SALE.id, draftHash: "h_draft2", confirmRepublish: true }, "single:");
  // Cancel sends nothing
  const two = stub({ listChanges: firstPub(["Banner"]), publish: answer(P.republishConfirmNeeded) });
  const f2 = M.createPublishFlow({ call: two });
  await f2.open([SALE]);
  await f2.confirm();
  f2.close();
  eq(two.ops(), ["listChanges", "publish"], "cancel sends nothing:");
});

await t("a singleton's first publish offers no Undo and shows the first-version note; a page's offers Undo", async () => {
  const call = stub({ listChanges: firstPub(["Hero"]), publish: answer(P.ok) });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  const page = renderPanel(flow);
  ok(!page.includes(">Undo<"), "no Undo");
  ok(textOf(page).includes(M.WORDS.firstVersion), "the note");
  const ok2 = clone(P.ok);
  ok2.body.published[0].id = SALE.id;
  const call2 = stub({ listChanges: firstPub(["Banner"]), publish: answer(ok2) });
  const f2 = M.createPublishFlow({ call: call2 });
  await f2.open([SALE]);
  await f2.confirm();
  ok(renderPanel(f2).includes(">Undo<"), "a page's first publish can be undone (take it offline)");
});

// P3-FIX4 (DESIGN reviewer): listChanges for doc_design never says
// firstPublish (its rows compare with the platform default), so a first design
// publish used to offer an Undo that only answers FIRST_VERSION_MESSAGE.
await t("P3-FIX4 unit: a first design publish offers no Undo (neverPublished), shows the first-version note; a later design publish offers Undo", async () => {
  const DESIGN = { id: "doc_design", label: "Brand", type: "design", revision: 4, draftHash: "h_design" };
  const listed = { ok: true, data: clone(SHAPES.listChanges.outcomes.ok.body) };
  eq(listed.data.neverPublished, true, "the shape's example is a never-published design:");
  const published = clone(P.ok);
  published.body.published[0].id = "doc_design";
  published.body.published[0].undo = { id: "doc_design", revision: 4, logId: "log_d1" };
  const call = stub({ listChanges: listed, publish: answer(published) });
  const flow = M.createPublishFlow({ call });
  await flow.open([DESIGN]);
  eq(flow.getState().lists.doc_design.rows.length > 0, true, "the token rows are still listed (not a first-publish list):");
  await flow.confirm();
  const out = flow.getState().outcome;
  eq([out.phase, out.published[0].undo, out.published[0].note, out.undoSet], ["done", null, M.WORDS.firstVersion, null], "the outcome:");
  const page = renderPanel(flow);
  ok(!page.includes(">Undo<"), "no Undo");
  ok(textOf(page).includes(M.WORDS.firstVersion), "the note");
  // the same publish when the design was published before: Undo is offered
  const before = clone(listed);
  delete before.data.neverPublished;
  const f2 = M.createPublishFlow({ call: stub({ listChanges: before, publish: answer(published) }) });
  await f2.open([DESIGN]);
  await f2.confirm();
  eq(f2.getState().outcome.published[0].undo, { id: "doc_design", revision: 4, logId: "log_d1" }, "a later design publish keeps its Undo:");
  ok(renderPanel(f2).includes(">Undo<"), "Undo shown");
  // changeListOf keeps the flag only when it is true
  eq(M.changeListOf(listed, "Brand").neverPublished, true, "kept:");
  ok(!Object.hasOwn(M.changeListOf(before, "Brand"), "neverPublished"), "absent otherwise");
  // Recently published: the server's row for a first design publish has canUndo false (test-design-doc proves it on the real server), and gives no target
  const g = M.recentGroupsOf([{ logId: "log_d1", setId: "set_1", documentId: "doc_design", label: "Brand", action: "publish", actionWords: "Published", byName: "Asha", at: "2026-10-01T10:00:00.000Z", summary: [], canUndo: false, undo: null }], { timeZone: "UTC" });
  eq([g[0].rows[0].canUndo, g[0].rows[0].target, g[0].undoSet ?? null], [false, null, null], "no Undo in Recently published:");
});

await t("a set publish offers Undo of the whole set with the publish's own undo args", async () => {
  const body = clone(P.ok.body);
  body.published.push({ id: SALE.id, versionId: "ver_3", hash: "h_draft2", liveUrl: "/api/preview?exit=1&to=%2Fcampaigns%2Fdiwali", undo: { id: SALE.id, revision: 3, logId: "log_2" } });
  const out = M.outcomeOf({ ok: true, data: body }, { items: [HOME, SALE] });
  eq(out.undoSet, { setId: "set_1", members: [{ id: "doc_home", logId: "log_1" }, { id: SALE.id, logId: "log_2" }], labels: ["Home page", "Diwali sale"], revisions: [4, 3] }, "set target:");
  const text = plain(html(h(Panel.PublishPanelView, { state: { phase: "done", outcome: out, items: [HOME, SALE], order: [], lists: {} }, call: async () => ({}) })), "set done");
  ok(text.includes("Published 2 pages.") && text.includes("Undo all 2"), text);
});

// =========================================================================================
console.log("— P3-FIX3: the batch 3 review findings");

const SET_T = () => ({ kind: "set", setId: "set_1", members: [{ id: "doc_home", logId: "log_1" }, { id: SALE.id, logId: "log_2" }], labels: ["Home page", "Diwali sale"], revisions: [4, 2] });

await t("P3-FIX3 unit: whole-set Undo with nothing undone shows the server's words, not 'Undone.'; in a mixed set a page that stayed is listed as stayed, not 'Live now'", async () => {
  const nothing = { ok: true, data: { ok: true, message: "There's nothing earlier to undo.", documents: [DOC({ live: true }), DOC({ id: SALE.id, label: "Diwali sale", live: true })] } };
  const out = M.undoOutcomeOf(SET_T(), nothing);
  eq([out.words, out.lines], ["There's nothing earlier to undo.", []], "nothing undone:");
  const mixed = { ok: true, data: { ok: true, message: "“Diwali sale” is live again, as it was before that publish. “Home page” stayed as it was: there was nothing earlier.", documents: [DOC({ live: true }), DOC({ id: SALE.id, label: "Diwali sale", live: true })] } };
  const text = plain(html(h(Undo.UndoNoticeView, { state: { phase: "result", outcome: M.undoOutcomeOf(SET_T(), mixed) }, target: SET_T() })), "mixed");
  ok(text.includes("“Home page” stayed as it was") && !text.includes("Live now") && !text.includes("Undone."), text);
  // through the flow: the dry run had something, the Undo itself found nothing (a race)
  const call = stub({ undoSet: (a) => (a.dryRun ? { ok: true, data: { ...clone(SHAPES.undoSet.outcomes.dryRun.body) } } : clone(nothing)) });
  const flow = M.createUndoFlow({ call });
  const tg = SET_T();
  await flow.start(tg);
  eq(flow.getState().phase, "confirm", "the confirm:");
  await flow.confirm();
  ok(plain(html(h(Undo.UndoNoticeView, { state: flow.getState(), target: tg })), "flow").includes("There's nothing earlier to undo."), "the flow shows the server's words");
});

await t("P3-FIX3 unit: a NETWORK_ERROR on publish and publishSet goes through 'Checking…', never 'nothing was saved' (a returned error and a thrown call)", async () => {
  const lost = { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy, so nothing was saved. Check your internet connection, then try again." };
  for (const [op, docs, how] of [
    ["publish", [HOME], "returned"],
    ["publishSet", [HOME, SALE], "returned"],
    ["publish", [HOME], "thrown"],
  ]) {
    const call = stub({
      listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]),
      [op]: () => {
        if (how === "thrown") throw new Error("offline");
        return clone(lost);
      },
      getDocument: (id) => ({ ok: true, data: { ok: true, document: DOC({ id, publishedHash: id === SALE.id ? "h_draft2" : "h_draft" }) } }),
    });
    const flow = M.createPublishFlow({ call, checkLive: async () => undefined });
    const texts = [];
    flow.subscribe((st) => texts.push(textOf(renderPanel({ getState: () => st, canConfirm: () => false }))));
    await flow.open(docs);
    await flow.confirm();
    ok(texts.some((x) => x.includes(M.WORDS.checking)), `${op} ${how}: showed Checking…`);
    ok(texts.every((x) => !/nothing was (saved|published)/.test(x)), `${op} ${how}: never 'nothing was saved': ${texts.find((x) => /nothing was/.test(x))}`);
    eq(flow.getState().phase, "checked", `${op} ${how}: resolved:`);
    ok(textOf(renderPanel(flow)).includes(M.WORDS.checkedLive), `${op} ${how}: it went live (its hashes)`);
  }
  eq(M.outcomeOf(lost, { items: [HOME] }).phase, "checking", "outcomeOf:");
});

await t("P3-FIX3 unit: a NETWORK_ERROR on undo and undoSet goes through 'Checking…' and asks the dry run again", async () => {
  const lost = { error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy, so nothing was saved." };
  const one = { kind: "one", label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } };
  const dry = { ok: true, data: clone(SHAPES.undo.outcomes.dryRun.body) };
  for (const [target, op] of [
    [one, "undo"],
    [SET_T(), "undoSet"],
  ]) {
    for (const [again, want] of [
      [{ conflict: true, code: "PUBLISHED_ELSEWHERE", message: "This was changed after that publish." }, M.WORDS.undoCheckedDone],
      [dry, M.WORDS.undoCheckedNot],
      [{ ok: true, data: { ok: true, willTakeOffline: false, linkers: [], changes: [], target: null } }, M.WORDS.undoCheckedDone],
      [clone(lost), M.WORDS.undoCheckedUnknown],
    ]) {
      const call = stub({ [op]: (a, x, n) => (n === 1 ? clone(dry) : n === 2 ? clone(lost) : clone(again)) });
      const flow = M.createUndoFlow({ call });
      const seen = [];
      flow.subscribe((st) => seen.push(st.phase === "checking" ? textOf(html(h(Undo.UndoNoticeView, { state: st, target }))) : null));
      await flow.start(target);
      await flow.confirm();
      ok(seen.includes(M.WORDS.undoChecking), `${op}: showed Checking…`);
      eq(call.calls.map((c) => Boolean(c.args.dryRun)), [true, false, true], `${op}: the dry run is asked again:`);
      const text = textOf(html(h(Undo.UndoNoticeView, { state: flow.getState(), target })));
      ok(text.includes(want) && !/nothing was saved/.test(text), `${op}: ${text}`);
      if (want === M.WORDS.undoCheckedNot) ok(text.includes(M.WORDS.tryAgain), "Try again is offered");
    }
  }
});

await t("P3-FIX3 unit+rendered: the whole-set Undo confirm names the page that goes offline; an offered singleton's first publish offers no set Undo", async () => {
  const tg = SET_T();
  const call = stub({
    undoSet: { ok: true, data: { ok: true, willTakeOffline: true, linkers: [], changes: [{ words: "Taken offline" }], target: null } },
    undo: (a) => (a.id === SALE.id ? { ok: true, data: { ok: true, willTakeOffline: true, linkers: [], changes: [{ words: "Taken offline" }], target: null } } : { ok: true, data: { ok: true, willTakeOffline: false, linkers: [], changes: [], target: null } }),
  });
  const flow = M.createUndoFlow({ call });
  await flow.start(tg);
  const v = flow.getState().view;
  eq([v.title, v.changes, v.offline], ["Undo all 2 pages of this publish? “Diwali sale” goes offline.", ["Diwali sale: Taken offline"], ["Diwali sale"]], "named:");
  eq(call.calls.filter((c) => c.op === "undo").map((c) => [c.args.id, c.args.logId, c.args.dryRun, c.extra?.revision]), [["doc_home", "log_1", true, 4], [SALE.id, "log_2", true, 2]], "each member's dry run, with its revision:");
  const text = plain(html(h(Offline.default, { open: true, view: v, onConfirm() {}, onCancel() {} })), "set offline confirm");
  ok(text.includes("“Diwali sale” goes offline"), text);
  // no one goes offline: no member dry runs
  const quiet = stub({ undoSet: { ok: true, data: clone(SHAPES.undoSet.outcomes.dryRun.body) } });
  await M.createUndoFlow({ call: quiet }).start(SET_T());
  eq(quiet.ops(), ["undoSet"], "no extra calls:");
  // the home page came in through an offer (no type recorded): its first publish has no Undo, so no set Undo
  const body = clone(P.ok.body);
  body.published.push({ id: SALE.id, versionId: "ver_3", hash: "h_draft2", liveUrl: null, undo: { id: SALE.id, revision: 3, logId: "log_2" } });
  const out = M.outcomeOf({ ok: true, data: body }, { items: [SALE], offerItems: [HOME, SALE], firstPublish: { doc_home: true, [SALE.id]: true }, types: {} });
  eq([out.published.find((p) => p.id === "doc_home").undo, out.undoSet], [null, null], "no set Undo:");
  eq([M.typeOfId("doc_home", {}), M.typeOfId("doc_header", null), M.typeOfId(SALE.id, {}), M.typeOfId("doc_x", { doc_x: "page" })], ["home", "header", null, "page"], "typeOfId:");
});

await t("P3-FIX3 round 1: the whole-set Undo confirm names the page that goes offline through the real client and the server's parser, which refuse an undo without a revision (428 REVISION_REQUIRED), dry run or not", async () => {
  // the server side: the real parser (lib/admin/documents-api.js) and the
  // rule documents-api applies after it (PUBLISH_NEEDS_REVISION: undo and
  // unpublish need a revision, a dry run too; pinned against the real
  // handler in scripts/test-publish-service.js "428 without a revision")
  const Api = await import("../lib/admin/documents-api.js");
  const { createDocumentsApi } = await import("../components/admin/editor/documentsApi.js");
  const offline = { ok: true, willTakeOffline: true, linkers: [], changes: [{ words: "Taken offline" }], target: null };
  const stays = { ok: true, willTakeOffline: false, linkers: [], changes: [{ words: "Hero: title changed" }], target: { versionId: "ver_prev", name: "Published 2 Nov, 10:00 by Asha" } };
  const sent = [];
  const fetch = async (_url, init) => {
    const parsed = Api.parseDocumentsOperation(JSON.parse(init.body));
    const op = parsed.op;
    sent.push(op ? { kind: op.kind, id: op.id, dryRun: op.dryRun, hasRevision: op.hasRevision, revision: op.revision } : parsed);
    const reply = (status, body) => ({ status, json: async () => clone(body) });
    if (parsed.error) return reply(400, { error: parsed.error, code: parsed.code });
    if ((op.kind === "undo" || op.kind === "unpublish") && !op.hasRevision) return reply(428, SHAPES.undo.outcomes.revisionRequired.body);
    if (op.kind === "undoSet") return reply(200, { ...offline, changes: [{ words: "Diwali sale: Taken offline" }, { words: "Home page: Hero: title changed" }] });
    if (op.kind === "undo") return reply(200, op.id === SALE.id ? offline : stays);
    throw new Error(`unexpected ${op.kind}`);
  };
  const { call } = createDocumentsApi({ fetch });
  // the two ways a set target is made: the publish answer and Recently published
  const body = clone(P.ok.body);
  body.published.push({ id: SALE.id, versionId: "ver_3", hash: "h_draft2", liveUrl: null, undo: { id: SALE.id, revision: 3, logId: "log_2" } });
  const fromPublish = M.outcomeOf({ ok: true, data: body }, { items: [HOME, SALE] }).undoSet;
  const row = clone(SHAPES.listRecentlyPublished.outcomes.ok.body.rows[0]);
  const fromRecent = M.recentGroupsOf([row, { ...row, logId: "log_2", documentId: SALE.id, label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } }], { timeZone: "UTC" })[0].undoSet;
  for (const [name, set, revs] of [
    ["the publish answer", { kind: "set", ...fromPublish }, [4, 3]],
    ["Recently published", fromRecent, [row.undo.revision, 2]],
  ]) {
    sent.length = 0;
    const flow = M.createUndoFlow({ call });
    await flow.start(set);
    const v = flow.getState().view;
    eq(v?.title, "Undo all 2 pages of this publish? “Diwali sale” goes offline.", `${name}: the confirm names the page:`);
    eq(v.offline, ["Diwali sale"], `${name}: offline:`);
    eq(sent.filter((x) => x.kind === "undo").map((x) => [x.id, x.dryRun, x.hasRevision, x.revision]), [["doc_home", true, true, revs[0]], [SALE.id, true, true, revs[1]]], `${name}: each member's dry run carries its revision:`);
    const text = plain(html(h(Offline.default, { open: true, view: v, onConfirm() {}, onCancel() {} })), `${name} confirm`);
    ok(text.includes("“Diwali sale” goes offline"), text);
  }
  // the PublishPanel's done state builds its target with the revisions too
  const flow = M.createUndoFlow({ call });
  const tree = Panel.PublishPanelView({ state: { phase: "done", outcome: M.outcomeOf({ ok: true, data: body }, { items: [HOME, SALE] }), items: [HOME, SALE], order: [], lists: {} }, call });
  const find = (el) => {
    if (!el || typeof el !== "object") return null;
    if (Array.isArray(el)) return el.map(find).find(Boolean) || null;
    if (el.props && el.props.target && el.props.target.kind === "set") return el.props.target;
    return find(el.props?.children);
  };
  const panelTarget = find(tree);
  eq(panelTarget?.revisions, [4, 3], "the panel's set target carries the revisions:");
  sent.length = 0;
  await flow.start(panelTarget);
  eq(flow.getState().view.offline, ["Diwali sale"], "the panel's Undo all names the page:");
  // a set target with no revisions (an older host) sends no member dry run that would only be refused
  sent.length = 0;
  const { revisions: _r, ...noRevs } = SET_T();
  const f3 = M.createUndoFlow({ call });
  await f3.start(noRevs);
  eq(sent.map((x) => x.kind), ["undoSet"], "no doomed member requests:");
  eq(f3.getState().view.title, M.WORDS.undoSetTitle(2), "the generic title then:");
});

await t("P3-FIX3 rendered: without undo rights, Undo is disabled with the reason as text (RecentlyPublished, UndoNotice, the publish answer); start() sends nothing", async () => {
  const access = clone(SHAPES.getDocument.outcomes.ok.body.document.access);
  ok(access.canPublish === false && access.reason, "the shapes' staff access");
  const row = clone(SHAPES.listRecentlyPublished.outcomes.ok.body.rows[0]);
  const rows = [row, { ...row, logId: "log_2", documentId: SALE.id, label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } }];
  const page = html(h(Recent.default, { rows, call: async () => ({}), access, timeZone: "UTC" }));
  const buttons = page.match(/<button[^>]*>(Undo|Undo all 2)<\/button>/g) || [];
  eq(buttons.length, 3, "two rows and the set:");
  ok(buttons.every((b) => /disabled=""/.test(b)), `all disabled: ${buttons}`);
  for (const b of buttons) {
    const id = /aria-describedby="([^"]+)"/.exec(b)?.[1];
    ok(id && page.includes(`id="${id}"`), `the reason is named: ${b}`);
  }
  eq((textOf(page).match(new RegExp(access.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 3, "the reason is shown as text, each time:");
  const owner = html(h(Recent.default, { rows, call: async () => ({}), access: { canPublish: true, reason: null }, timeZone: "UTC" }));
  ok(!/disabled=""[^>]*>Undo/.test(owner) && !owner.includes("data-undo-reason"), "an owner's Undo is enabled");
  const notice = html(h(Undo.default, { target: { kind: "one", label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } }, call: async () => ({}), access }));
  ok(/<button[^>]*disabled=""[^>]*>Undo<\/button>/.test(notice) && textOf(notice).includes(access.reason), "UndoNotice");
  ok(textOf(html(h(Undo.UndoNoticeView, { state: { phase: "idle" }, target: SET_T(), access: { canUndo: false } }))).includes(M.WORDS.staffUndoReason), "the default reason");
  // the publish answer's Undo, for a host that passes staff access
  const ok2 = clone(P.ok);
  ok2.body.published[0].id = SALE.id;
  const out = M.outcomeOf(answer(ok2), { items: [SALE] });
  const done = html(h(Panel.PublishPanelView, { state: { phase: "done", outcome: out, items: [SALE], order: [], lists: {} }, access, call: async () => ({}) }));
  ok(/<button[^>]*disabled=""[^>]*>Undo<\/button>/.test(done), "the publish answer's Undo");
  const call = stub({});
  eq(await M.createUndoFlow({ call, access }).start({ kind: "one", label: "x", undo: { id: SALE.id, revision: 2, logId: "log_2" } }), null, "start refused:");
  eq(call.calls.length, 0, "no call:");
});

await t("P3-FIX3 pins: whole-set Undo needs two undoable rows; stale answers are ignored (lists, open, Undo start); a double confirm sends once; pinned() needs a revision", async () => {
  // (1) the threshold
  const row = clone(SHAPES.listRecentlyPublished.outcomes.ok.body.rows[0]);
  const g = M.recentGroupsOf([row, { ...row, logId: "log_2", canUndo: false, undo: null }]);
  eq([g.length, g[0].rows.length, g[0].undoSet], [1, 2, null], "one undoable row of two: no set Undo:");
  // (2a) loadLists: an answer for an older open is dropped
  const slow = later();
  const call = stub({ listChanges: (a) => (a.id === HOME.id ? slow.p : changes([{ kind: "edited", sectionId: "sec_x", words: "Banner: title changed" }])) });
  const flow = M.createPublishFlow({ call });
  const first = flow.open([HOME]);
  await tick();
  flow.close();
  await flow.open([SALE]);
  slow.res(changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]));
  await first;
  eq([Object.keys(flow.getState().lists), Object.keys(flow.getState().firstPublish).includes(HOME.id)], [[SALE.id], false], "the older answer is dropped:");
  // (2b) open(): a pin that answers after a newer open is dropped
  const pin = later();
  const c2 = stub({ getDocument: () => pin.p, listChanges: changes([{ kind: "edited", sectionId: "sec_x", words: "Banner: title changed" }]) });
  const f2 = M.createPublishFlow({ call: c2 });
  const o1 = f2.open([{ id: HOME.id, label: "Home page" }]);
  await tick();
  await f2.open([SALE]);
  pin.res({ ok: true, data: { ok: true, document: DOC({ revision: 9, draftHash: "h_9" }) } });
  await o1;
  eq(f2.getState().items.map((i) => i.id), [SALE.id], "the newer open wins:");
  eq(c2.calls.filter((c) => c.op === "listChanges").map((c) => c.args.id), [SALE.id], "no list for the older open:");
  // (2c) Undo start: an older dry run answering late changes nothing
  const d1 = later();
  const t1 = { kind: "one", label: "Home page", undo: { id: HOME.id, revision: 3, logId: "log_1" } };
  const t2 = { kind: "one", label: "Diwali sale", undo: { id: SALE.id, revision: 2, logId: "log_2" } };
  const dryB = { ok: true, data: { ok: true, willTakeOffline: false, linkers: [], changes: [{ words: "Banner: back to before" }], target: null } };
  const u = M.createUndoFlow({ call: stub({ undo: (a) => (a.id === HOME.id ? d1.p : clone(dryB)) }) });
  const s1 = u.start(t1);
  await u.start(t2);
  d1.res({ ok: true, data: { ok: true, willTakeOffline: true, linkers: [], changes: [{ words: "Taken offline" }], target: null } });
  await s1;
  eq([u.getState().target === t2, u.getState().phase, u.getState().view.changes], [true, "confirm", ["Banner: back to before"]], "the newer Undo stays:");
  // (3) a double confirm sends one publish
  const pub = later();
  const c3 = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]), publish: () => pub.p });
  const f3 = M.createPublishFlow({ call: c3 });
  await f3.open([HOME]);
  const a = f3.confirm();
  eq(f3.canConfirm(), false, "busy: Confirm is off:");
  const b = await f3.confirm();
  pub.res(answer(P.ok));
  await a;
  eq([b, c3.ops().filter((x) => x === "publish").length], [null, 1], "one publish:");
  // ...and a double Undo confirm sends one undo
  const un = later();
  const c4 = stub({ undo: (x) => (x.dryRun ? clone(dryB) : un.p) });
  const f4 = M.createUndoFlow({ call: c4 });
  await f4.start(t2);
  const ua = f4.confirm();
  eq(await f4.confirm(), null, "the second Undo confirm:");
  un.res({ ok: true, data: { ok: true, message: "“Diwali sale” is back.", document: DOC({ id: SALE.id }) } });
  await ua;
  eq(c4.calls.filter((c) => !c.args.dryRun).length, 1, "one undo:");
  // (4) pinned(): a hash without a revision is read again
  const c5 = stub({ getDocument: { ok: true, data: { ok: true, document: DOC({ revision: 7, draftHash: "h_7" }) } }, listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]) });
  const f5 = M.createPublishFlow({ call: c5 });
  await f5.open([{ id: HOME.id, label: "Home page", draftHash: "h_draft" }]);
  eq([c5.ops()[0], f5.getState().items[0].revision, f5.getState().items[0].draftHash], ["getDocument", 7, "h_7"], "read again:");
});

await t("P3-FIX3 pins (rendered): the offer review hides the per-issue Publish both; the home link says 'Make your home page'", async () => {
  const call = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_x", words: "Banner: title changed" }]), publish: answer(P.linksToUnpublished) });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  await tick();
  eq(flow.getState().phase, "offer", "the offer:");
  ok((flow.getState().outcome.issues || []).some((i) => (i.actions || []).some((x) => x.type === "publishBoth")), "an issue carries publishBoth");
  const page = renderPanel(flow);
  eq((page.match(/>Publish both</g) || []).length, 1, "only the review's own Confirm says Publish both:");
  const noHome = html(h(Panel.PublishPanelView, { state: { phase: "noHome", outcome: { phase: "noHome", title: M.WORDS.noHomeTitle, message: "Make it." }, items: [], order: [], lists: {} } }));
  ok(/<a href="\/admin\/editor\?path=%2F"[^>]*>Make your home page<\/a>/.test(noHome), `the link and its words: ${noHome}`);
});

await t("P3-FIX3: closing the panel while a fix runs says it keeps running; the fix finishes without opening the panel again, and onPublished hears it", async () => {
  const save = later();
  const call = stub({
    listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]),
    publish: (a, x, n) => (n === 1 ? answer(P.validationFailed) : answer(P.ok)),
    getDocument: { ok: true, data: { ok: true, document: DOC({ body: HOME_BODY, revision: 3 }) } },
    saveDraft: () => save.p,
  });
  const heard = [];
  const adopted = [];
  const flow = M.createPublishFlow({ call, onPublished: (o) => heard.push(o.phase), onDocument: (d) => adopted.push(d.revision) });
  await flow.open([HOME]);
  await flow.confirm();
  const issue = flow.getState().outcome.issues[0];
  const running = flow.act(issue.actions[0], issue);
  await tick();
  eq([flow.getState().phase, flow.getState().busy, flow.running()], ["blocked", true, true], "running:");
  ok(textOf(renderPanel(flow)).includes(M.WORDS.keepsRunning), "says it keeps running");
  flow.close();
  save.res({ ok: true, data: { ok: true, document: DOC({ revision: 4, draftHash: "h_after_fix" }), issues: [] } });
  await running;
  eq(call.ops(), ["listChanges", "publish", "getDocument", "saveDraft", "publish"], "the fix ran to the end:");
  eq([flow.getState().phase, heard, adopted], ["closed", ["done"], [4]], "the panel stays closed; the host hears it:");
  ok(!textOf(html(h(Panel.PublishPanelView, { state: { phase: "blocked", busy: false, outcome: { issues: [], message: "x" }, items: [], order: [], lists: {} } }))).includes(M.WORDS.keepsRunning), "not said when nothing runs");
});

// P4-EDITOR (P4-LIVEROW review): a publish of only products and collections
// writes no release, so its lost answer is PUBLISH_UNKNOWN with release: null.
// It is settled by reading the document again FROM THE SERVER: the editor's
// store call answers getDocument with the store's own copy, which still holds
// what was live before, so DocumentEditor passes readDocument.
await t("P4-EDITOR: a lost products-only publish answer (release: null) settles from the server's document, not the store's copy", async () => {
  const { createDocumentStore } = await import("../components/admin/editor/store.js");
  const EM = await import("../components/admin/editor/editorModel.js");
  const PROD = { id: "doc_prod_0123456789abcdef", type: "product_content", label: "Moon serum", slug: null, body: { type: "product_content", settings: { title: { value: "Moon serum", base_hash: "b", base_value: "Night serum" } }, sections: [] }, revision: 4, draftHash: "h_prod_draft", publishedVersionId: "ver_old", publishedHash: "h_prod_old", access: { canPublish: true, reason: null } };
  const lost = { ...answer(P.unknown), release: null };
  const run = async ({ serverPublishedHash, viaServer }) => {
    const calls = [];
    const api = {
      async call(op, args, extra) {
        calls.push(op);
        if (op === "listChanges") return changes([{ kind: "edited", sectionId: null, words: "Name: your own instead of Shopify's" }]);
        if (op === "publish") return clone(lost);
        if (op === "getDocument") return { ok: true, data: { ok: true, document: { ...clone(PROD), publishedVersionId: "ver_new", publishedHash: serverPublishedHash } } };
        throw new Error(`unexpected ${op}`);
      },
      sendKeepalive: () => true,
    };
    const store = createDocumentStore({ api, document: clone(PROD), tenant: "t", timers: { setTimeout: () => 0, clearTimeout: () => {} }, storage: null });
    const call = EM.createStoreCall({ api, getStore: () => store });
    const flow = M.createPublishFlow({ call, ...(viaServer ? { readDocument: (id) => api.call("getDocument", id) } : {}) });
    await flow.open([{ id: PROD.id, label: PROD.label, type: PROD.type, revision: PROD.revision, draftHash: PROD.draftHash }]);
    await flow.confirm();
    return { state: flow.getState(), calls };
  };
  // as the editor builds it: readDocument straight to the server
  let r = await run({ serverPublishedHash: "h_prod_draft", viaServer: true });
  eq([r.state.phase, r.state.outcome.live], ["checked", true], "went live (the server's published hash is the draft sent):");
  ok(r.state.outcome.words === M.WORDS.checkedLive, r.state.outcome.words);
  r = await run({ serverPublishedHash: "h_prod_old", viaServer: true });
  eq([r.state.phase, r.state.outcome.live], ["checked", false], "did not go live:");
  // without readDocument the store's stale copy answers: the old false "didn't go live"
  r = await run({ serverPublishedHash: "h_prod_draft", viaServer: false });
  eq(r.state.outcome.live, false, "the store's copy can't tell (why the editor passes readDocument):");
  const src = await readFile(join(ROOT, "components/admin/editor/DocumentEditor.js"), "utf8");
  ok(/createPublishFlow\(\{[^}]*readDocument: \(id\) => api\.call\("getDocument", id\)/.test(src), "DocumentEditor passes readDocument to the publish flow");
});

// =====================================================================================
console.log("— P6-OPEN-UI: Before you open your store (PUB-12, US-41; unit + rendered)");

const OC = SHAPES.openingChecks.outcomes;
const DESIGN = { id: "doc_design", revision: 2, draftHash: "h_design", label: "Design" };
const PRIV = { id: "doc_P1V4C9Y0P4G3E2Q8", revision: 1, draftHash: "h_priv", label: "Privacy policy" };
const TERMS = { id: "doc_T3R7M5S2X9W4K1Z6", revision: 1, draftHash: "h_terms", label: "Terms of service" };
// report items in P6-OPEN's words and shapes (lib/documents/opening.js)
const I = {
  paymentOk: { id: "payment", level: "ok", title: "Shoppers can pay", message: "Shoppers can pay by card, UPI or cash on delivery.", href: null, who: null },
  paymentCod: { id: "payment", level: "info", title: "Cash on delivery only", message: "Shoppers can only pay cash on delivery for now.", href: "/admin/settings#payments", who: null, linkLabel: "Add your Razorpay keys" },
  paymentOff: clone(OC.ok.body.items[0]),
  maintenance: { id: "maintenance", level: "warn", title: "Your store is in maintenance", message: "Your store is in maintenance mode. Ask Storeasy support to turn it off.", href: null, who: "support" },
  privacyOk: { id: "privacy", level: "ok", title: "Privacy page", message: "Your privacy page is ready.", href: null, who: null },
  returnsOk: { id: "returns", level: "ok", title: "Returns page", message: "Your returns page is ready.", href: null, who: null },
  privacyMissing: clone(OC.ok.body.items[1]),
  returnsMissing: { id: "returns", level: "block", title: "Returns page", message: "Your store needs a returns page (your terms, returns and refunds) before it opens. Start one from a template, then read it and save it.", href: null, who: null, actions: [{ type: "startPolicy", kind: "returns", label: "Start a returns page" }] },
  privacyStarter: { id: "privacy", level: "block", title: "Privacy page", message: "We started a privacy page for you from a template. It's a starting point, not legal advice: read it, change what you need and save it before you open.", href: `/admin/editor?doc=${PRIV.id}`, who: null, linkLabel: "Read it", actions: [{ type: "markPolicyRead", id: PRIV.id, revision: 1, label: "I've read it" }] },
  privacySaved: { id: "privacy", level: "info", title: "Privacy page", message: "Your privacy page goes live too.", href: `/admin/editor?doc=${PRIV.id}`, who: null, linkLabel: "Open “Privacy policy”" },
  returnsStarter: clone(OC.ok.body.items[2]),
  returnsSaved: { id: "returns", level: "info", title: "Returns page", message: "Your returns page (your terms, returns and refunds) goes live too.", href: `/admin/editor?doc=${TERMS.id}`, who: null, linkLabel: "Open “Terms of service”" },
  testOrderWarn: clone(OC.ok.body.items[3]),
  testOrderOk: { id: "test_order", level: "ok", title: "Test order placed", message: "You placed a test order.", href: null, who: null },
  catalogOk: { id: "catalog", level: "ok", title: "Products", message: "Your products are in.", href: null, who: null },
  contactWarn: { id: "contact", level: "warn", title: "No contact details", message: "Shoppers can't see how to reach you. Add a support email or phone.", href: "/admin/settings#store-profile", who: null },
  designInfo: clone(OC.ok.body.items[4]),
  designOk: { id: "design", level: "ok", title: "Colours and logo", message: "Your colours and logo are set.", href: null, who: null },
};
const reportOf = (items, offer = null) => ({ ok: true, data: { ok: true, opening: true, items: clone(items), offer: offer ? { publishSet: clone(offer) } : null } });
const openStore = () => OPEN_STORE();
// a 409 opening refusal through the real client mapper
const refusalOf = (code, error, { items, offer, withOffer = true }) => mapResponse(409, { error, code, report: { opening: true, items: clone(items), offer: offer ? { publishSet: clone(offer) } : null }, ...(withOffer ? { offer: offer ? { publishSet: clone(offer) } : null } : {}) });
const firstPubAll = () => firstPub(["Hero", "Product rail"]);
// a fetch spy for the console POSTs: answers[url] is (json, n) => [status, body]
function fetchSpy(answers = {}) {
  const sent = [];
  const counts = {};
  const f = async (url, init) => {
    const json = JSON.parse(init.body);
    sent.push({ url, method: init.method, json });
    counts[url] = (counts[url] || 0) + 1;
    const a = answers[url];
    if (!a) throw new Error(`unexpected fetch ${url}`);
    const [status, body] = a(json, counts[url]);
    return { ok: status >= 200 && status < 300, status, json: async () => clone(body) };
  };
  f.sent = sent;
  return f;
}
const buttons = (markup) => [...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ text: textOf(m[2]), disabled: /\sdisabled=""/.test(m[1]) }));
const buttonOf = (markup, words) => buttons(markup).find((b) => b.text === words) || null;
const linksOf = (markup) => [...markup.matchAll(/<a([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ text: textOf(m[2]), href: (m[1].match(/href="([^"]*)"/) || [])[1]?.replace(/&amp;/g, "&") ?? null }));

await t("P6-OPEN-UI unit: flow.open asks openingChecks before anything goes out; opening:true enters 'opening' with the report's items and the offered design already in the set", async () => {
  const items = [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderWarn, I.catalogOk, I.designInfo];
  const call = stub({ openingChecks: reportOf(items, [HOME, DESIGN]), listChanges: firstPubAll(), publishSet: answer(P.ok) });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  const s = flow.getState();
  eq(call.calls[0], { op: "openingChecks", args: { ids: ["doc_home"] }, extra: undefined }, "the first call, for the set:");
  eq(s.phase, "opening", "phase:");
  eq(s.outcome.report.items.map((i) => i.id), items.map((i) => i.id), "the report's items, in order:");
  eq(s.items.map(({ id, revision, draftHash }) => ({ id, revision, draftHash })), [{ id: "doc_home", revision: 3, draftHash: "h_draft" }, { id: "doc_design", revision: 2, draftHash: "h_design" }], "the design is in the set, with the offer's revision and hash:");
  eq(call.calls.filter((c) => c.op === "listChanges").map((c) => c.args.id), ["doc_home", "doc_design"], "what goes live is listed, design included:");
  ok(!call.ops().some((o) => o === "publish" || o === "publishSet"), "nothing published by opening the panel");
  ok(flow.canConfirm(), "Open is on: only a warning is left");
  await flow.confirm();
  const sent = call.calls.at(-1);
  eq([sent.op, sent.args.map((x) => x.id), sent.extra], ["publishSet", ["doc_home", "doc_design"], { checkOpening: true, confirmOpen: true }], "one Open sends the set with confirmOpen:");
  eq(flow.getState().phase, "done", "then done:");
});

await t("P6-OPEN-UI unit: opening:false, a refused read, a failed read and a thrown read all go on to the review exactly as before", async () => {
  const cases = {
    "opening false": () => openStore(),
    "refused (legacy store)": () => mapResponse(409, { error: "This store still uses the current Storefront editor.", code: "STORE_USES_LEGACY" }),
    "failed (network)": () => ({ error: true, code: "NETWORK_ERROR", message: "We couldn't reach Storeasy." }),
    thrown: () => {
      throw new Error("boom");
    },
  };
  for (const [name, read] of Object.entries(cases)) {
    const call = stub({ openingChecks: read, listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]), publish: answer(P.ok) });
    const flow = M.createPublishFlow({ call });
    await flow.open([HOME]);
    eq(flow.getState().phase, "review", `${name}: the review:`);
    eq(flow.getState().items.map((i) => i.id), ["doc_home"], `${name}: the same set:`);
    ok(flow.canConfirm(), `${name}: Publish on as before`);
    await flow.confirm();
    eq(call.ops().slice(-1), ["publish"], `${name}: published:`);
    eq(call.calls.at(-1).extra, { revision: 3, checkOpening: true }, `${name}: with checkOpening and no confirmOpen:`);
    ok(textOf(renderPanel(flow)).includes("Published"), `${name}: done`);
    ok(!textOf(renderPanel(flow)).includes(M.WORDS.openingTitle), `${name}: no opening panel`);
  }
});

await t("P6-OPEN-UI unit: the publish's 409s map to the one panel: CONFIRM_NEEDED and NEEDS_DESIGN to 'opening' (design folded, no second dialog), CANNOT_TAKE_PAYMENT to 'cannotOpen' (Open off), NEEDS_POLICIES folds saved drafts or keeps Open off when its offer is null; a starter is never added", async () => {
  // the outcome mapping on its own
  eq(M.outcomeOf(answer(P.openingConfirmNeeded)).phase, "opening", "OPENING_CONFIRM_NEEDED:");
  eq(M.outcomeOf(answer(P.storeCannotTakePayment)).phase, "cannotOpen", "STORE_CANNOT_TAKE_PAYMENT:");
  eq(M.outcomeOf(answer(P.openingNeedsDesign)).phase, "opening", "OPENING_NEEDS_DESIGN:");
  eq([M.outcomeOf(answer(P.openingNeedsPolicies)).phase, M.outcomeOf(answer(P.openingNeedsPolicies)).stuck], ["opening", true], "OPENING_NEEDS_POLICIES with offer null:");

  const run = async (first) => {
    const call = stub({ listChanges: firstPubAll(), publish: (a, x, n) => (n === 1 ? first : answer(P.ok)), publishSet: answer(P.ok) });
    const flow = M.createPublishFlow({ call });
    await flow.open([HOME]); // the stub answers openingChecks as an open store would
    await flow.confirm();
    await tick();
    return { call, flow };
  };
  // CONFIRM_NEEDED: 'opening' with the report, and Open resends with confirmOpen
  let r = await run(refusalOf("OPENING_CONFIRM_NEEDED", "Look over what's left before your store opens, then open it. Nothing was published yet.", { items: [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderWarn, I.designOk], withOffer: false }));
  eq(r.flow.getState().phase, "opening", "confirm needed:");
  ok(r.flow.canConfirm(), "Open on");
  await r.flow.confirm();
  eq([r.call.calls.at(-1).op, r.call.calls.at(-1).extra], ["publish", { revision: 3, checkOpening: true, confirmOpen: true }], "resent with confirmOpen:");

  // NEEDS_DESIGN: folded into the same panel, never the offer dialog
  r = await run(refusalOf("OPENING_NEEDS_DESIGN", "Publish your colours and logo with this, so your store opens with them. Nothing was published.", { items: [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderOk, I.designInfo], offer: [HOME, DESIGN] }));
  eq(r.flow.getState().phase, "opening", "needs design:");
  eq(r.flow.getState().items.map((i) => i.id), ["doc_home", "doc_design"], "design added to the set:");
  ok(!textOf(renderPanel(r.flow)).includes(M.WORDS.offerTitle), "no 'Publish these together' dialog");
  ok(r.flow.canConfirm(), "Open on once the lists loaded");
  await r.flow.confirm();
  eq([r.call.calls.at(-1).op, r.call.calls.at(-1).args.map((x) => x.id), r.call.calls.at(-1).extra], ["publishSet", ["doc_home", "doc_design"], { checkOpening: true, confirmOpen: true }], "the set with the design:");

  // CANNOT_TAKE_PAYMENT: no way to open
  r = await run(answer(P.storeCannotTakePayment));
  eq(r.flow.getState().phase, "cannotOpen", "cannot open:");
  ok(!r.flow.canConfirm(), "Open off");
  eq(await r.flow.confirm(), null, "a confirm sends nothing:");
  eq(r.call.ops().filter((o) => o === "publish").length, 1, "only the first publish went out:");

  // NEEDS_POLICIES with an offer of founder-saved drafts: folded in
  r = await run(refusalOf("OPENING_NEEDS_POLICIES", "Publish your privacy page and returns page with this. Nothing was published.", { items: [I.paymentOk, I.privacySaved, I.returnsSaved, I.testOrderOk, I.designOk], offer: [HOME, PRIV, TERMS] }));
  eq(r.flow.getState().phase, "opening", "needs policies:");
  eq(r.flow.getState().items.map((i) => i.id), ["doc_home", PRIV.id, TERMS.id], "the saved policy drafts are in the set:");
  ok(r.flow.canConfirm(), "Open on");

  // NEEDS_POLICIES with offer null: Open off
  r = await run(answer(P.openingNeedsPolicies));
  eq(r.flow.getState().phase, "opening", "needs policies, nothing to offer:");
  ok(!r.flow.canConfirm(), "Open off");
  // even if its report had no block left, offer null keeps Open off until a check
  r = await run(refusalOf("OPENING_NEEDS_POLICIES", "Your store needs a privacy page and a returns page before it opens, so nothing was published.", { items: [I.paymentOk, I.privacyOk, I.returnsOk], offer: null }));
  ok(!r.flow.canConfirm(), "offer null: Open off");

  // a starter draft is never added, even when an offer names it
  r = await run(refusalOf("OPENING_NEEDS_POLICIES", "Your store needs a privacy page and a returns page before it opens, so nothing was published.", { items: [I.paymentOk, I.privacyStarter, I.returnsSaved], offer: [HOME, PRIV, TERMS] }));
  eq(r.flow.getState().items.map((i) => i.id), ["doc_home", TERMS.id], "the starter is left out, the saved returns page is in:");
  ok(!r.flow.canConfirm(), "the starter still blocks");
  eq(M.foldOffer([HOME], { publishSet: [HOME, PRIV] }, { items: [I.privacyStarter] }).items.map((i) => i.id), ["doc_home"], "foldOffer never adds a starter:");
});

await t("P6-OPEN-UI rendered: each item's message, a link only with an href (its linkLabel, else 'Fix this'; none for support), 'Open my store anyway' resends with confirmOpen through the store (spy)", async () => {
  const items = [I.paymentCod, I.maintenance, I.privacyOk, I.returnsOk, I.testOrderWarn, I.catalogOk, I.contactWarn, I.designInfo];
  // the editor's path: the real store, createStoreCall, and a spy for the documents api
  const EM = await import("../components/admin/editor/editorModel.js");
  const { createDocumentStore } = await import("../components/admin/editor/store.js");
  const apiCalls = [];
  const api = {
    async call(op, args, extra) {
      apiCalls.push({ op, args: clone(args ?? null), extra: extra === undefined ? undefined : clone(extra) });
      if (op === "openingChecks") return reportOf(items, [HOME, DESIGN]);
      if (op === "listChanges") return firstPubAll();
      if (op === "publishSet") return answer(P.ok);
      return { error: true, code: "UNKNOWN", message: "no script" };
    },
    sendKeepalive: () => true,
  };
  const store = createDocumentStore({ api, document: DOC(), tenant: "t1", timers: { setTimeout: () => 0, clearTimeout: () => {} }, storage: null });
  const call = EM.createStoreCall({ api, getStore: () => store });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  eq(flow.getState().phase, "opening", "opening:");
  const page = renderPanel(flow);
  const text = plain(page, "opening panel");
  ok(text.includes(M.WORDS.openingTitle), "titled 'Before you open your store'");
  for (const it of items) ok(text.includes(it.message), `${it.id} shows its message`);
  const links = linksOf(page);
  eq(
    links.map((l) => [l.text, l.href]),
    [
      ["Add your Razorpay keys", "/admin/settings#payments"],
      ["Open your preview", "/admin/editor"],
      [M.WORDS.fixThis, "/admin/settings#store-profile"],
      ["See your colours", "/admin/editor?doc=doc_design"],
    ],
    "a link only where there is an href, with its linkLabel (else 'Fix this'); none for support:",
  );
  ok(!/Must fix/.test(text), "nothing blocks");
  const itemMarkup = (id) => (page.match(new RegExp(`<li[^>]*data-opening-item="${id}"[\\s\\S]*?</li>`)) || [""])[0];
  for (const id of ["payment", "design"]) ok(itemMarkup(id) && !/bg-warning|bg-danger|text-warning|text-danger/.test(itemMarkup(id)), `the info line ${id} has no warning style`);
  ok(/bg-warning/.test(itemMarkup("maintenance")) && /bg-warning/.test(itemMarkup("contact")), "warnings are marked");
  ok(/bg-success/.test(itemMarkup("privacy")) && textOf(itemMarkup("privacy")).includes(M.WORDS.levelDone), "an ok item shows as done");
  ok(!linksOf(itemMarkup("maintenance")).length, "the support item has no link");
  eq(buttons(page).filter((b) => /Open my store/.test(b.text)).map((b) => [b.text, b.disabled]), [["Open my store anyway", false]], "one 'Open my store anyway':");
  ok(buttonOf(page, M.WORDS.placedOne) && buttonOf(page, M.WORDS.checkAgain), "'I placed one' and 'Check again'");
  await flow.confirm(); // what on.confirm does
  const sent = apiCalls.filter((c) => c.op === "publishSet");
  eq(sent.length, 1, "one publishSet:");
  eq(sent[0].extra, { checkOpening: true, confirmOpen: true }, "through createStoreCall and the store, with confirmOpen:");
  eq(sent[0].args.map((x) => x.id), ["doc_home", "doc_design"], "the set with the design:");
});

await t("P6-OPEN-UI rendered: with every item ok the panel still shows, all done, with one 'Open my store' button; in 'cannotOpen' there is no open button and the payment message shows", async () => {
  const allOk = [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderOk, I.catalogOk, I.designOk];
  let call = stub({ openingChecks: reportOf(allOk, [HOME]), listChanges: firstPubAll() });
  let flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  let page = renderPanel(flow);
  let text = plain(page, "all ok");
  ok(text.includes(M.WORDS.openingTitle) && text.includes(M.WORDS.openingAllDone), text);
  eq(buttons(page).filter((b) => /Open my store/.test(b.text)).map((b) => [b.text, b.disabled]), [["Open my store", false]], "one 'Open my store':");
  eq((text.match(/Done/g) || []).length, allOk.length, "every item shows as done:");

  call = stub({ listChanges: firstPubAll(), publish: answer(P.storeCannotTakePayment) });
  flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  page = renderPanel(flow);
  text = plain(page, "cannot open");
  eq(flow.getState().phase, "cannotOpen", "phase:");
  ok(text.includes(I.paymentOff.message), "the payment message shows");
  ok(!/data-open-store/.test(page) && !buttons(page).some((b) => /Open my store/.test(b.text)), "no open button");
  ok(buttonOf(page, M.WORDS.checkAgain), "Check again is there");
});

await t("P6-OPEN-UI rendered (OQ-P6-1/2): missing policies block Open with 'Start a …' buttons; Start POSTs policy-start { kind } and checks again; a starter shows 'Read it' and \"I've read it\" (POST { markRead }); Open turns on only once both are ok or info", async () => {
  const reports = [
    [I.paymentOk, I.privacyMissing, I.returnsMissing, I.testOrderOk, I.designOk],
    [I.paymentOk, I.privacyStarter, I.returnsMissing, I.testOrderOk, I.designOk],
    [I.paymentOk, I.privacySaved, I.returnsMissing, I.testOrderOk, I.designOk],
    [I.paymentOk, I.privacySaved, I.returnsOk, I.testOrderOk, I.designOk],
  ];
  const offers = [[HOME], [HOME, PRIV], [HOME, PRIV], [HOME, PRIV]];
  let n = 0;
  const call = stub({ openingChecks: () => reportOf(reports[Math.min(n, 3)], offers[Math.min(n++, 3)]), listChanges: firstPubAll(), publishSet: answer(P.ok) });
  const fetch = fetchSpy({
    [M.POLICY_START_URL]: (json) =>
      json.kind
        ? [200, { ok: true, document: { id: json.kind === "privacy" ? PRIV.id : TERMS.id, revision: 1, slug: "privacy-policy", title: "Privacy policy", kind: json.kind }, href: `/admin/editor?doc=${PRIV.id}`, message: "We started your privacy page from a template. It's a starting point, not legal advice: read it, change what you need and save it." }]
        : [200, { ok: true, document: { id: PRIV.id, revision: 2, slug: "privacy-policy", title: "Privacy policy", draftHash: "h_priv2" }, href: `/admin/editor?doc=${PRIV.id}`, message: "Marked as read. This page now counts as yours." }],
  });
  const flow = M.createPublishFlow({ call, fetch });
  await flow.open([HOME]);
  let page = renderPanel(flow);
  let text = plain(page, "policies missing");
  ok(buttonOf(page, M.WORDS.startPrivacy) && buttonOf(page, M.WORDS.startReturns), "both Start buttons");
  eq((text.match(/not legal advice/g) || []).length, 1, "the 'not legal advice' line, once:");
  ok(text.includes(M.WORDS.notLegalAdvice), "its words");
  eq(buttonOf(page, "Open my store")?.disabled, true, "Open is off:");
  ok(text.includes(M.WORDS.openingBlocks), "says what to do");
  ok(!flow.canConfirm(), "canConfirm off");

  // Start a privacy page
  const action = flow.getState().outcome.report.items.find((i) => i.id === "privacy").actions[0];
  await flow.act(action);
  eq(fetch.sent.at(-1), { url: "/api/admin/policy-start", method: "POST", json: { kind: "privacy" } }, "POSTs { kind }:");
  eq(call.ops().filter((o) => o === "openingChecks").length, 2, "checked again:");
  page = renderPanel(flow);
  text = plain(page, "a starter");
  ok(text.includes("We started your privacy page from a template."), "the answer's message shows");
  ok(linksOf(page).some((l) => l.text === "Read it" && l.href === `/admin/editor?doc=${PRIV.id}`), "'Read it' opens the starter in the editor");
  ok(buttonOf(page, M.WORDS.markRead), "\"I've read it\"");
  ok(!flow.getState().items.some((i) => i.id === PRIV.id), "a starter is not in the set, even when an offer names it");
  eq(buttonOf(page, "Open my store")?.disabled, true, "still off:");

  // I've read it
  const read = flow.getState().outcome.report.items.find((i) => i.id === "privacy").actions[0];
  await flow.act(read);
  eq(fetch.sent.at(-1).json, { markRead: { id: PRIV.id, revision: 1 } }, "POSTs { markRead: { id, revision } }:");
  eq(call.ops().filter((o) => o === "openingChecks").length, 3, "checked again:");
  ok(flow.getState().items.some((i) => i.id === PRIV.id), "the read page now goes live with the store (saved, offered)");
  ok(!flow.canConfirm(), "returns still blocks");

  // the returns page appears elsewhere: Check again
  await flow.act({ type: "checkAgain" });
  eq(call.ops().filter((o) => o === "openingChecks").length, 4, "checked again:");
  ok(flow.canConfirm(), "Open on once privacy is info and returns ok");
  page = renderPanel(flow);
  eq(buttonOf(page, "Open my store")?.disabled, false, "the rendered Open is on:");
  await flow.confirm();
  const sent = call.calls.at(-1);
  eq([sent.op, sent.args.map((x) => x.id), sent.extra], ["publishSet", ["doc_home", PRIV.id], { checkOpening: true, confirmOpen: true }], "the privacy page goes with the store:");
});

await t("P6-OPEN-UI rendered: 'Check again' re-reads the report; 'I placed one' POSTs the test order check-off (Setup's route) and re-reads", async () => {
  let n = 0;
  const call = stub({ openingChecks: () => reportOf(n++ < 2 ? [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderWarn] : [I.paymentOk, I.privacyOk, I.returnsOk, I.testOrderOk], [HOME]), listChanges: firstPubAll() });
  const fetch = fetchSpy({ [M.SETUP_URL]: () => [200, { ok: true, items: [] }] });
  const flow = M.createPublishFlow({ call, fetch });
  await flow.open([HOME]);
  await flow.act({ type: "checkAgain" });
  eq(call.ops().filter((o) => o === "openingChecks").length, 2, "Check again read it again:");
  ok(textOf(renderPanel(flow)).includes(M.WORDS.placedOne), "'I placed one' on the test order");
  await flow.act({ type: "placedTestOrder" });
  eq(fetch.sent, [{ url: "/api/admin/setup", method: "POST", json: { step: "test_order" } }], "the manual check-off:");
  eq(call.ops().filter((o) => o === "openingChecks").length, 3, "then read again:");
  const text = plain(renderPanel(flow), "after test order");
  ok(text.includes(M.WORDS.testOrderMarked) && !text.includes(M.WORDS.placedOne), text);
  eq(buttonOf(renderPanel(flow), "Open my store")?.disabled, false, "nothing left to check: 'Open my store':");
  // a failed check-off leaves the panel as it was
  const call2 = stub({ openingChecks: reportOf([I.paymentOk, I.testOrderWarn], [HOME]), listChanges: firstPubAll() });
  const flow2 = M.createPublishFlow({ call: call2, fetch: fetchSpy({ [M.SETUP_URL]: () => [422, { error: 'launch is gated — still open: x' }] }) });
  await flow2.open([HOME]);
  await flow2.act({ type: "placedTestOrder" });
  const t2 = plain(renderPanel(flow2), "check-off failed");
  ok(t2.includes(M.WORDS.testOrderFailed) && !t2.includes("gated"), t2);
  eq(call2.ops().filter((o) => o === "openingChecks").length, 1, "not re-read:");
  // the panel actions are not issue actions
  eq([...M.ACTION_TYPES], ["hideSection", "removeSection", "removeItem", "publishBoth", "openField"], "ACTION_TYPES unchanged:");
  ok(M.OPENING_PANEL_ACTIONS.every((a) => !M.ACTION_TYPES.includes(a)), "none of the panel's actions is an issue action");
});

await t("P6-OPEN-UI rendered: POLICY_PAGE_EXISTS names the page that counts (even an unrelated 'returning-customers' page) with 'Open it'; another failure shows its words and leaves the panel as it was", async () => {
  let n = 0;
  const call = stub({ openingChecks: () => reportOf(n++ === 0 ? [I.paymentOk, I.privacyOk, I.returnsMissing] : [I.paymentOk, I.privacyOk, { ...I.returnsSaved, linkLabel: "Open “Returning customers”" }], [HOME]), listChanges: firstPubAll() });
  const fetch = fetchSpy({
    [M.POLICY_START_URL]: () => [409, { error: "You already have a returns page: Returning customers. Open it to read it.", code: "POLICY_PAGE_EXISTS", document: { id: "doc_R3T8N1C5U2S7Q4W9", title: "Returning customers", state: "saved" }, href: "/admin/editor?doc=doc_R3T8N1C5U2S7Q4W9" }],
  });
  const flow = M.createPublishFlow({ call, fetch });
  await flow.open([HOME]);
  await flow.act({ type: "startPolicy", kind: "returns" });
  let page = renderPanel(flow);
  let text = plain(page, "exists");
  ok(text.includes("“Returning customers” already counts as your returns page") && text.includes("Open it to check it's the page you want"), text);
  ok(linksOf(page).some((l) => l.text === "Open it" && l.href === "/admin/editor?doc=doc_R3T8N1C5U2S7Q4W9"), "'Open it' to that page");
  eq(call.ops().filter((o) => o === "openingChecks").length, 2, "checked again:");
  // a failure: its plain words, nothing re-read, the panel as it was
  const call2 = stub({ openingChecks: reportOf([I.paymentOk, I.privacyMissing], [HOME]), listChanges: firstPubAll() });
  const f2 = fetchSpy({ [M.POLICY_START_URL]: (j, k) => (k === 1 ? [409, { error: "This store still uses the current Storefront editor, so no page was started here.", code: "STORE_USES_LEGACY" }] : [403, { error: "Your role (staff) can't do that" }]) });
  const flow2 = M.createPublishFlow({ call: call2, fetch: f2 });
  await flow2.open([HOME]);
  const before = clone(flow2.getState().outcome.report);
  await flow2.act({ type: "startPolicy", kind: "privacy" });
  text = plain(renderPanel(flow2), "refused");
  ok(text.includes("This store still uses the current Storefront editor"), text);
  eq(flow2.getState().outcome.report, before, "the panel as it was:");
  await flow2.act({ type: "startPolicy", kind: "privacy" });
  text = plain(renderPanel(flow2), "not allowed");
  ok(text.includes(M.WORDS.notAllowed) && !text.includes("role"), text);
  eq(call2.ops().filter((o) => o === "openingChecks").length, 1, "never re-read on a failure:");
  // a lost answer (fetch rejects)
  const flow3 = M.createPublishFlow({ call: stub({ openingChecks: reportOf([I.privacyMissing], [HOME]), listChanges: firstPubAll() }), fetch: async () => { throw new Error("offline"); } });
  await flow3.open([HOME]);
  await flow3.act({ type: "startPolicy", kind: "privacy" });
  ok(textOf(renderPanel(flow3)).includes(M.WORDS.actionFailed), "a lost answer: plain words");
});

await t("P6-OPEN-UI rendered: a done answer with a store-level POLICY_PAGE_MISSING warning shows plain words under 'Your store', never the code", async () => {
  const body = clone(P.okPolicyPageMissing.body);
  body.published.push({ id: "doc_home", versionId: "ver_9", hash: "h_draft", liveUrl: "/api/preview?exit=1&to=%2F", undo: { id: "doc_home", revision: 4, logId: "log_9" } });
  const missing = body.issues[0];
  // the store-level one: no document
  body.issues.push({ ...clone(missing), documentId: null, anchor: null, where: null, actions: [], message: "After this publish your store has no live privacy page, and checkout links to it. Publish one soon." });
  const call = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_hero", words: "Hero: title changed" }]), publish: mapResponse(200, body) });
  const flow = M.createPublishFlow({ call });
  await flow.open([HOME]);
  await flow.confirm();
  eq(flow.getState().phase, "done", "done:");
  const page = renderPanel(flow);
  const text = plain(page, "done with POLICY_PAGE_MISSING");
  ok(text.includes(missing.message) && text.includes("no live privacy page"), text);
  ok(text.includes(M.WORDS.storeWide), "the store-level warning is under 'Your store', not 'This page'");
  ok(!/POLICY_PAGE_MISSING/.test(page), "never the code");
});

await t("P6-OPEN-UI unit: checkOpening reaches the documents API body as a top-level key on publish and publishSet, through createStoreCall and the store (fetch spy); FIRST_PUBLISH_NEEDS_HOME, noHome and republish still work", async () => {
  const EM = await import("../components/admin/editor/editorModel.js");
  const { createDocumentStore } = await import("../components/admin/editor/store.js");
  const { createDocumentsApi } = await import("../components/admin/editor/documentsApi.js");
  const bodies = [];
  const answers = { publish: [P.firstPublishNeedsHome, P.ok], publishSet: [P.ok] };
  const fetch = async (url, init) => {
    const json = JSON.parse(init.body);
    bodies.push(json);
    const op = Object.keys(json).find((k) => k !== "revision" && k !== "checkOpening" && k !== "confirmOpen");
    let out;
    if (op === "openingChecks") out = OC.open;
    else if (op === "listChanges") out = { status: 200, body: { ok: true, firstPublish: true, sections: [{ words: "Hero" }] } };
    else out = (answers[op] || []).shift() || { status: 500, body: { error: "no script", code: "X" } };
    return { status: out.status, ok: out.status < 300, json: async () => clone(out.body) };
  };
  const api = createDocumentsApi({ fetch });
  const store = createDocumentStore({ api, document: DOC({ id: SALE.id, type: "campaign", label: "Diwali sale", revision: 2, draftHash: "h_draft2" }), tenant: "t1", timers: { setTimeout: () => 0, clearTimeout: () => {} }, storage: null });
  const call = EM.createStoreCall({ api, getStore: () => store });
  const flow = M.createPublishFlow({ call });
  await flow.open([SALE]);
  eq(bodies[0], { openingChecks: { ids: [SALE.id] } }, "openingChecks first, through the store call to the api:");
  await flow.confirm();
  const pub = bodies.find((b) => "publish" in b);
  eq([pub.checkOpening, pub.revision, "confirmOpen" in pub, "checkOpening" in pub.publish], [true, 2, false, false], "publish: top-level checkOpening, beside the revision:");
  eq(flow.getState().phase, "offer", "FIRST_PUBLISH_NEEDS_HOME still offers the home page:");
  await tick();
  await flow.confirm();
  const set = bodies.find((b) => "publishSet" in b);
  eq([set.checkOpening, Array.isArray(set.publishSet), set.publishSet.every((x) => !("checkOpening" in x))], [true, true, true], "publishSet: top-level checkOpening:");
  eq(flow.getState().phase, "done", "published:");
  // the store on its own: the keys only when asked
  const seen = [];
  const s2 = createDocumentStore({ api: { call: async (op, args, extra) => (seen.push([op, extra]), answer(P.ok)), sendKeepalive: () => true }, document: DOC(), tenant: "t1", timers: { setTimeout: () => 0, clearTimeout: () => {} }, storage: null });
  await s2.publish({ checkOpening: true, confirmOpen: true });
  await s2.publishSet([{ id: "doc_design", revision: 1, draftHash: "h" }], { checkOpening: true });
  await s2.publish();
  await s2.publishSet([]);
  eq(seen, [["publish", { revision: 3, checkOpening: true, confirmOpen: true }], ["publishSet", { checkOpening: true }], ["publish", { revision: 3 }], ["publishSet", undefined]], "the store sends the keys only when set:");
  // noHome and republish, through the stub
  const nh = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_x", words: "x" }]), publish: answer({ status: 409, body: { ...P.firstPublishNeedsHome.body, offer: null } }) });
  const f3 = M.createPublishFlow({ call: nh });
  await f3.open([SALE]);
  await f3.confirm();
  eq(f3.getState().phase, "noHome", "noHome:");
  const rp = stub({ listChanges: changes([{ kind: "edited", sectionId: "sec_x", words: "x" }]), publish: (a, x, n) => (n === 1 ? answer(P.republishConfirmNeeded) : answer(P.ok)) });
  const f4 = M.createPublishFlow({ call: rp });
  await f4.open([SALE]);
  await f4.confirm();
  eq(f4.getState().phase, "republish", "republish:");
  await f4.confirm();
  eq([rp.calls.at(-1).args.confirmRepublish, rp.calls.at(-1).extra], [true, { revision: 2, checkOpening: true }], "republish resends with confirmRepublish and checkOpening:");
  eq(f4.getState().phase, "done", "done:");
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed (${secs} s)`);
process.exit(fail ? 1 : 0);
