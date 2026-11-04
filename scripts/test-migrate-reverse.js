// P4-REVERSE suite (MIG-04, OVL-17): moving a store back from the new editor
// to the old one, and moving it again, for real, on file databases
// (.test-mrev-*.db at the checkout's root, removed at the end). No hosted
// database, no network, no Shopify; Typesense is a spy client with dummy
// localhost values. Replaces P4-SCAFFOLD's placeholder.
//   1. after a reversal shoppers see Shopify's values, the live rows sit only in
//      content_live_reversed, search gets Shopify's names back (spy), the
//      pointer is the release from before the move (and NULL for a store that
//      had none), the old editors save at once
//   2. a publish between the two steps is refused in its own batch; a crash
//      between the steps leaves the new-editor store whole, and after them the
//      old-editor store whole
//   3. the report: by count and by product name, in plain words
//   4. the store's look (theme_pin) set back and read back
//   5. --status, --abort, refusals, the command
//   6. moving again after a reversal: the product edits come back at the
//      switch only, nothing else published in the new editor goes live again
//   7. the P4-CUTOVER review: a failed agency read after the pause and a
//      missing editor record each stop with their own words
//   pnpm test:migrate-reverse
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT, P, installHooks, openWorld, makeLegacyTenant } from "./support/legacy-tenants.js";

const started = Date.now();
let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${String(e?.stack || e).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg || "assertion failed");
};
const eq = (a, b, msg = "") => {
  const differ = a !== null && b !== null && typeof a === "object" && typeof b === "object" ? JSON.stringify(a) !== JSON.stringify(b) : a !== b;
  if (differ) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b, msg = "") => {
  const x = JSON.stringify(canon(a));
  const y = JSON.stringify(canon(b));
  if (x !== y) {
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    throw new Error(`${msg}\n      differ at ${i}: expected …${y.slice(Math.max(0, i - 200), i + 300)}\n      got      …${x.slice(Math.max(0, i - 200), i + 300)}`);
  }
};
const PLAIN_BAD = /\b[a-z]+_[a-z_]+\b|SQLITE|CHECK constraint|cms_|release_state|document_|\bmrun_|\bver_|\brel_|\bdoc_/;
const plainWords = (s, what) => ok(!PLAIN_BAD.test(String(s)), `${what} is not plain words: ${String(s).match(PLAIN_BAD)?.[0]} in ${s}`);
const abovedetails = (text, Rep) => text.split(`\n${Rep.DETAILS_LINE}\n`)[0];

installHooks({ headers: "stub" });
for (const k of ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "TYPESENSE_PORT", "TYPESENSE_PROTOCOL"]) delete process.env[k];
globalThis.fetch = async (url) => {
  throw new Error(`test-migrate-reverse: no network (${String(url?.url ?? url).slice(0, 80)})`);
};
const world = await openWorld({ prefix: ".test-mrev" });
const C = world.control;
const { libsql } = await import("../lib/db.js");
const Cut = await import("../lib/migrate/cutover.js");
const Rev = await import("../lib/migrate/reverse.js");
const Rep = await import("../lib/migrate/report.js");
const Back = await import("../lib/migrate/backfill.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const Store = await import("../lib/cms/store.js");
const M = await import("../lib/cms-mode.js");
const Eff = await import("../lib/catalog/effective.js");
const AC = await import("../lib/documents/after-commit.js");
const TS = await import("../lib/typesense-search.js");
const SR = await import("../lib/catalog/search-reindex.js");
const Kits = await import("../lib/themes/kits.js");
const platform = C.platformDb();
const FIXED = "2026-11-04T10:00:00.000Z";
const LATER = "2026-11-05T09:00:00.000Z";
const fixedClock = () => FIXED;
let tick = 0;
// a clock that moves on (publishes after the move must sort after it)
const movingClock = () => new Date(Date.parse(LATER) + ++tick * 1000).toISOString();

// ---- stores ------------------------------------------------------------------------------

const CLEAN = ["product_override_modules_badge", "product_override_six_modules", "pdp_pairs_custom_title", "cart_upsell", "collection_pins", "surface_templates_products", "redirect_to_page", "cms_templates_two_families"];
const FLAG = { live_v3: undefined, no_release_open: true };
let seq = 0;
async function store(state = "live_v3", { entities = CLEAN, id, config } = {}) {
  const sid = id ?? `mr${++seq}`;
  const { db } = await makeLegacyTenant(world, { id: sid, state, entities, ...(config ? { config } : {}) });
  await db.run(async () => {
    await libsql.execute("DELETE FROM page_redirects WHERE from_slug = 'old-post'");
    await libsql.execute("UPDATE releases SET content = json_set(content, '$.redirects', json((SELECT json_group_array(value) FROM json_each(content, '$.redirects') WHERE json_extract(value, '$.from_slug') IS NOT 'old-post'))) WHERE json_type(content, '$.redirects') = 'array'");
  });
  return { db, id: sid, state, storeOpen: FLAG[state] };
}
const inS = (S, fn) => S.db.run(fn);
const q = async (S, sql, args = []) => inS(S, async () => (await libsql.execute({ sql, args })).rows.map((r) => ({ ...r })));
const modeOf = async (S) => (await q(S, "SELECT mode, cutover_release_id FROM cms_state WHERE id = 1"))[0];
const pointerOf = async (S) => (await q(S, "SELECT live_release_id FROM release_state WHERE id = 1"))[0]?.live_release_id ?? null;
const count = async (S, table, where = "1") => Number((await q(S, `SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0].n);

function syntheticRehearsal(S, sourceHash) {
  return { tool: "migrate-documents", kind: "rehearsal", version: 1, tenant: S.id, sourceHash, passed: true, notLaunched: false, dataCheck: { ran: true, compared: 1, differences: 0 }, render: { same: true, compared: 3, canaries: 3, canariesOk: true } };
}
async function proofs(S) {
  const dry = await inS(S, () => Rep.dryRun({ storeOpen: S.storeOpen, platform }));
  return { digest: dry.digest, rehearsal: syntheticRehearsal(S, dry.mapped.sourceHash), dry };
}
async function move(S, opts = {}) {
  const pr = opts.proofs ?? (await proofs(S));
  return inS(S, () => Cut.runCutover({ storeOpen: S.storeOpen, dryRunDigest: pr.digest, rehearsalReport: pr.rehearsal, platform, now: opts.now ?? fixedClock, ...opts }));
}
async function moved(S, opts) {
  const r = await move(S, opts);
  ok(r.ok, `the move: ${JSON.stringify(r.refused || r.stopped || r.words)}`);
  return r;
}
const reverseDry = (S) => inS(S, () => Rev.reverseDryRun());
async function reverse(S, opts = {}) {
  const d = opts.digest === undefined ? (await reverseDry(S)).digest : opts.digest;
  return inS(S, () => Rev.reverseDocuments({ dryRunDigest: d, platform, now: opts.now ?? movingClock, ...opts }));
}
const resumeReverse = (S, opts = {}) => inS(S, () => Rev.reverseDocuments({ platform, resume: true, now: movingClock, ...opts }));

// ---- the new editor ----------------------------------------------------------------------

const ACTOR = "system:test";
const v = (value) => ({ value });
async function openProduct(S, pid) {
  return inS(S, () => Docs.openEntityContent({ type: "product_content", entityId: pid, actor: ACTOR }));
}
async function saveSettings(S, id, settings) {
  const d = await inS(S, () => Docs.getDocument(id));
  return inS(S, () => Docs.saveDraft({ id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, ...settings } }, actor: ACTOR }));
}
async function publishDocs(S, ids) {
  const items = [];
  for (const id of ids) {
    const d = await inS(S, () => Docs.getDocument(id));
    items.push({ id, revision: d.revision, draftHash: d.draftHash });
  }
  return inS(S, () => Pub.publish({ ids: items, actor: ACTOR }));
}
// a product edit in the new editor, published
async function editProduct(S, pid, settings) {
  const o = await openProduct(S, pid);
  await saveSettings(S, o.document.id, settings);
  const r = await publishDocs(S, [o.document.id]);
  eq(r.published?.length, 1, `published ${pid}:`);
  return o.document.id;
}
const shopifyTitle = async (S, pid) => (await q(S, "SELECT title FROM products WHERE id = ?", [pid]))[0]?.title ?? null;
const handleOf = async (S, pid) => (await q(S, "SELECT handle FROM products WHERE id = ?", [pid]))[0]?.handle ?? null;
// what shoppers see: the effective read (cards and the product page)
const seenTitle = async (S, pid) => (await inS(S, () => Eff.byIds([pid])))[0]?.title ?? null;
const seenPage = async (S, pid) => inS(S, async () => Eff.productPage(await handleOf(S, pid)));

// the products of the fixture store: one with old-editor extras, one without
const productsOf = async (S) => (await q(S, "SELECT id FROM products ORDER BY id")).map((r) => String(r.id));
async function pickProducts(S) {
  const all = await productsOf(S);
  const withExtras = (await q(S, "SELECT product_id FROM product_overrides ORDER BY product_id")).map((r) => String(r.product_id));
  const a = withExtras.find((id) => all.includes(id));
  const b = all.find((id) => !withExtras.includes(id) && !(withExtras || []).includes(id));
  ok(a && b, `fixture products: ${a} ${b}`);
  return { a, b };
}

// a spy Typesense client (dummy localhost values only)
function withSearchSpy(collection) {
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
  const calls = [];
  TS.setSearchAdminClientForTest({
    collections(name) {
      return {
        documents(id) {
          if (id === undefined) return { import: async (docs, opts) => (calls.push({ op: "import", name, docs: JSON.parse(JSON.stringify(docs)), action: opts?.action }), docs.map(() => ({ success: true }))) };
          return { delete: async () => (calls.push({ op: "delete", name, id }), {}) };
        },
      };
    },
  });
  SR.setSearchReindexTestHooks({ enqueue: async () => ({ id: "job_spy", existed: false }) });
  return {
    calls,
    collection,
    off() {
      TS.setSearchAdminClientForTest(null);
      SR.setSearchReindexTestHooks();
      delete process.env.TYPESENSE_HOST;
      delete process.env.TYPESENSE_ADMIN_API_KEY;
    },
  };
}
class Crash extends Error {}
const crash = () => {
  throw new Crash("crash (test)");
};

// =======================================================================================
console.log("— 1. back on the old editor: shoppers see Shopify's values, search too, the old editors save");

let BASIC = null;
await t("after a reversal shoppers see Shopify's values, product and collection live rows sit only in content_live_reversed, search_outbox has a row per product and a spy drain indexes Shopify's names, the pointer is the release from before the move, mode is legacy, and the old editors save at once", async () => {
  const S = await store("live_v3", { config: { site: { name: "Reverse Store" }, typesense_collection: "mrev_products" } });
  await moved(S);
  const cut = await modeOf(S);
  eq([cut.mode, cut.cutover_release_id], ["documents", "rel_fixture_v3"], "moved:");
  const { a, b } = await pickProducts(S);
  await editProduct(S, a, { title: v("Renamed With Extras"), description_html: v("<p>New words</p>") });
  await editProduct(S, b, { title: v("Renamed Plain"), display_vendor: v("New Brand") });
  eq(await seenTitle(S, a), "Renamed With Extras", "renamed before:");
  const liveBefore = { product: await q(S, "SELECT * FROM product_content_live ORDER BY product_id"), collection: await q(S, "SELECT * FROM collection_content_live ORDER BY collection_id") };
  ok(liveBefore.product.length >= 2 && liveBefore.collection.length >= 1, `live rows: ${liveBefore.product.length} ${liveBefore.collection.length}`);
  const spy = withSearchSpy("mrev_products");
  let r;
  try {
    r = await reverse(S);
  } finally {
    spy.off();
  }
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  // the store
  const st = await modeOf(S);
  eq(st.mode, "legacy", "mode:");
  eq(await pointerOf(S), "rel_fixture_v3", "the pointer is cutover_release_id:");
  eq(await count(S, "product_content_live"), 0, "no product live row left:");
  eq(await count(S, "collection_content_live"), 0, "no collection live row left:");
  // the copies, exactly the rows that were live
  const aside = await q(S, "SELECT kind, entity_id, row_json, run_id FROM content_live_reversed ORDER BY kind, entity_id");
  same(
    aside.filter((x) => x.kind === "product").map((x) => JSON.parse(x.row_json)),
    liveBefore.product,
    "product rows copied aside:",
  );
  same(
    aside.filter((x) => x.kind === "collection").map((x) => JSON.parse(x.row_json)),
    liveBefore.collection,
    "collection rows copied aside:",
  );
  ok(aside.every((x) => x.run_id === r.runId), "under this run");
  // shoppers: Shopify's values
  eq(await seenTitle(S, a), await shopifyTitle(S, a), "the card title is Shopify's again:");
  eq(await seenTitle(S, b), await shopifyTitle(S, b), "the other product too:");
  const page = await seenPage(S, b);
  eq(page.title, await shopifyTitle(S, b), "the product page title:");
  ok(page.display_vendor !== "New Brand", `the brand shown is Shopify's: ${page.display_vendor}`);
  // search
  const box = await q(S, "SELECT product_id, reason, done_at FROM search_outbox WHERE reason = 'reverse' ORDER BY product_id");
  same(box.map((x) => x.product_id), liveBefore.product.map((x) => x.product_id), "one outbox row per product that had a live row:");
  ok(box.every((x) => x.done_at != null), "drained");
  for (const pid of [a, b]) {
    const h = await handleOf(S, pid);
    const docs = spy.calls.filter((c) => c.op === "import").flatMap((c) => c.docs).filter((d) => d.id === h);
    ok(docs.length > 0, `${pid} reached search`);
    eq(docs.at(-1).title, await shopifyTitle(S, pid), `${pid} indexed with Shopify's name:`);
  }
  ok(spy.calls.every((c) => c.name === "mrev_products"), "only this store's collection");
  eq(r.report.search.status, "drained", "search reported:");
  // the old editors save at once
  await inS(S, () => Store.setBlock("announcement", { enabled: true, text: "Saved on the old editor again", href: "/" }));
  const ann = await q(S, "SELECT value FROM cms_blocks WHERE key = 'announcement'");
  ok(JSON.parse(ann[0].value).text === "Saved on the old editor again", "the old editor saved");
  eq(await inS(S, () => M.getCmsMode()), "legacy", "the editors' mode check:");
  // the run
  const run = (await q(S, "SELECT kind, step, outcome, finished_at FROM cms_migration_runs WHERE kind = 'reverse'"))[0];
  eq([run.kind, run.step, run.outcome, run.finished_at != null], ["reverse", "pinned", "done", true], "the run:");
  BASIC = { S, r, a, b };
});

await t("a store that had no release when it moved goes back to the old editor's drafts (the pointer is NULL)", async () => {
  const S = await store("no_release_open");
  await moved(S);
  eq((await modeOf(S)).cutover_release_id, null, "moved with no release:");
  ok((await pointerOf(S)) != null, "the move published a release");
  const r = await reverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(await pointerOf(S), null, "the pointer is NULL again:");
  eq((await modeOf(S)).mode, "legacy", "legacy:");
  eq(await count(S, "product_content_live"), 0, "no live row:");
});

// =======================================================================================
console.log("— 2. between the steps");

await t("a publish of a product name that reaches its batch after step 1 is refused in that batch (the documents guard); the reversal then finishes and the name is nowhere", async () => {
  const S = await store("live_v3");
  await moved(S);
  const { a } = await pickProducts(S);
  const o = await openProduct(S, a);
  await saveSettings(S, o.document.id, { title: v("Sneaked In") });
  const digest = (await reverseDry(S)).digest;
  let locked = false;
  Pub.setPublishHooks({
    beforeCommit: async () => {
      if (locked) return;
      locked = true;
      // step 1 of the reversal lands now; it stops right after (a crash)
      Rev.__reverseTestHooks.afterLock = crash;
      const e = await inS(S, () => Rev.reverseDocuments({ dryRunDigest: digest, platform, now: movingClock })).then(() => null, (x) => x);
      Rev.resetReverseTestHooks();
      ok(e instanceof Crash, `step 1 then the crash: ${e}`);
      eq((await modeOf(S)).mode, "migrating", "paused by step 1:");
    },
  });
  let err;
  try {
    err = await publishDocs(S, [o.document.id]).then(() => null, (x) => x);
  } finally {
    Pub.setPublishHooks({});
  }
  ok(err, "the publish was refused");
  eq(err.status, 409, `refused (${err.code}: ${err.message})`);
  ok(/updated|moving/i.test(err.message), err.message);
  eq(await count(S, "product_content_live", "title = 'Sneaked In'"), 0, "never live:");
  eq(await count(S, "search_outbox", "reason = 'publish'"), 0, "no outbox row from it:");
  const r = await resumeReverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq((await modeOf(S)).mode, "legacy", "back on the old editor:");
  eq(await count(S, "content_live_reversed", "row_json LIKE '%Sneaked In%'"), 0, "not in the copies either:");
  eq(await seenTitle(S, a), await shopifyTitle(S, a), "shoppers see Shopify's name:");
});

await t("a crash between step 1 and step 2 leaves the new-editor store whole (paused); --resume finishes; a crash after step 2 leaves the old-editor store complete", async () => {
  const S = await store("live_v3");
  await moved(S);
  const { a } = await pickProducts(S);
  await editProduct(S, a, { title: v("Crash Name") });
  const liveDump = async () => ({ p: await q(S, "SELECT * FROM product_content_live ORDER BY product_id"), c: await q(S, "SELECT * FROM collection_content_live ORDER BY collection_id"), ptr: await pointerOf(S), aside: await count(S, "content_live_reversed") });
  const before = await liveDump();
  Rev.__reverseTestHooks.beforeReverse = crash;
  const e = await reverse(S).then(() => null, (x) => x);
  Rev.resetReverseTestHooks();
  ok(e instanceof Crash, String(e));
  same(await liveDump(), before, "the new-editor store is whole:");
  eq((await modeOf(S)).mode, "migrating", "paused:");
  eq(await seenTitle(S, a), "Crash Name", "shoppers still see the new editor's store:");
  const open = (await q(S, "SELECT step, finished_at FROM cms_migration_runs WHERE kind = 'reverse'"))[0];
  eq([open.step, open.finished_at], ["locked", null], "the run waits after step 1:");
  const r = await resumeReverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq((await modeOf(S)).mode, "legacy", "finished by --resume:");
  eq(await count(S, "product_content_live"), 0, "no live row:");

  // after step 2: the old-editor store is complete
  const S2 = await store("live_v3");
  await moved(S2);
  const p2 = (await pickProducts(S2)).a;
  await editProduct(S2, p2, { title: v("After Crash") });
  Rev.__reverseTestHooks.afterReverse = crash;
  const e2 = await reverse(S2).then(() => null, (x) => x);
  Rev.resetReverseTestHooks();
  ok(e2 instanceof Crash, String(e2));
  eq((await modeOf(S2)).mode, "legacy", "legacy:");
  eq(await pointerOf(S2), "rel_fixture_v3", "pointer:");
  eq(await count(S2, "product_content_live"), 0, "no live row:");
  ok((await count(S2, "content_live_reversed")) > 0, "copied aside:");
  eq(await count(S2, "search_outbox", "reason = 'reverse'"), await count(S2, "content_live_reversed", "kind = 'product'"), "outbox rows written in the same batch:");
  eq(await seenTitle(S2, p2), await shopifyTitle(S2, p2), "shoppers see Shopify's name:");
  // --resume does the last steps (search, look); a new reversal is refused
  const again = await resumeReverse(S2);
  ok(again.ok && again.resumed, JSON.stringify(again));
  eq(again.report.themePin.status, "env" === again.report.themePin.status ? "env" : "reset", "the look step ran:");
  const re = await reverse(S2, { digest: "x" });
  eq(re.refused?.code, "ALREADY_LEGACY", JSON.stringify(re));
});

await t("the release the store goes back to disappearing under the pause stops before step 2 and keeps the store on the new editor", async () => {
  const S = await store("live_v3");
  await moved(S);
  Rev.__reverseTestHooks.beforeReverse = null;
  Rev.__reverseTestHooks.afterLock = async () => {
    await q(S, "UPDATE releases SET id = 'rel_gone' WHERE id = 'rel_fixture_v3'");
  };
  let r;
  try {
    r = await reverse(S);
  } finally {
    Rev.resetReverseTestHooks();
  }
  eq(r.stopped?.code, "CHANGED", JSON.stringify(r));
  ok(r.stopped.unlocked, "unlocked");
  eq((await modeOf(S)).mode, "documents", "still on the new editor:");
  ok((await count(S, "product_content_live")) > 0, "live rows untouched");
  plainWords(r.stopped.words, "stop words");
});

// =======================================================================================
console.log("— 3. the report");

await t("the report counts what was published in the new editor, the product edits and the drafts that don't flow back, and lists each product by name with the edits that no longer show", async () => {
  const S = await store("live_v3");
  await moved(S);
  const { a, b } = await pickProducts(S);
  await editProduct(S, a, { title: v("Protein Bar Max"), description_html: v("<p>Better</p>") });
  await editProduct(S, b, { display_type: v("Snack") });
  // a page published in the new editor, and a draft left unpublished
  const ann = await inS(S, () => Docs.getDocument("doc_announcement"));
  await saveSettings(S, "doc_announcement", { text: "Published in the new editor" });
  const pa = await publishDocs(S, ["doc_announcement"]);
  eq(pa.published?.length, 1, `announcement published (${JSON.stringify(ann?.body?.settings).slice(0, 80)})`);
  await saveSettings(S, "doc_announcement", { text: "A draft only" });
  const dry = await reverseDry(S);
  const nameA = await shopifyTitle(S, a);
  const nameB = await shopifyTitle(S, b);
  eq(dry.plan.counts.publishedDocuments, 3, "three documents published since the move:");
  eq(dry.plan.counts.publishes, 3, "three publishes:");
  eq(dry.plan.counts.overlayProducts, 2, "two products with edits:");
  eq(dry.plan.counts.overlayFields, 3, "name, description, type shown:");
  eq(dry.plan.counts.drafts, 1, "one draft:");
  const pa1 = dry.plan.products.find((p) => p.id === a);
  same(pa1.overlay, ["title", "description_html"], "the first product's edits:");
  const text = Rep.renderReversePlanText({ ...dry.plan, refused: dry.refused }, dry.digest);
  // the first product's draft extras went live with the name, so they are named too
  same(pa1.fields, ["title", "description_html", "extras"], "with its extras:");
  ok(text.includes(`“${nameA}”: new name (“Protein Bar Max”), description, extra sections, badge, products shown together or layout.`), text);
  ok(text.includes(`“${nameB}”: product type shown.`), text);
  ok(text.includes("The announcement bar: what was published in the new editor."), text);
  ok(text.includes("3 parts of your store were published in the new editor since the move (3 publishes)."), text);
  ok(text.includes("3 product edits (names, descriptions, photos, brand or type shown) on 2 products follow Shopify again."), text);
  ok(text.includes("1 unpublished draft stays in the new editor."), text);
  ok(text.includes("The old editors work again at once"), text);
  plainWords(abovedetails(text, Rep), "the reversal dry run");
  const r = await reverse(S, { digest: dry.digest });
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const done = Rep.renderReverseText(r.report);
  ok(done.startsWith("Your store is back on the old editor."), done);
  ok(done.includes(`“${nameA}”: new name (“Protein Bar Max”), description, extra sections`), done);
  const msg = Rep.founderMessage(r.report);
  ok(msg.includes(`“${nameA}”: new name (“Protein Bar Max”), description, extra sections`), msg);
  ok(/old editors work again/.test(msg) && /moves to the new editor again, the product edits above .* come back/.test(msg), msg);
  plainWords(abovedetails(done, Rep), "the reversal report");
  plainWords(msg, "the founder message");
  // the announcement is the old editor's again
  const live = await q(S, "SELECT value FROM cms_blocks WHERE key = 'announcement'");
  ok(!String(live[0]?.value ?? "").includes("Published in the new editor"), "the old editor's announcement");
});

// =======================================================================================
console.log("— 4. the store's look");

const KIT_CONFIG = { site: { name: "Kit Store" }, theme: { kit: "glow", version: 2, applied_at: "2026-10-01T00:00:00.000Z" } };
await t("theme_pin is set back to the old editor's value (the key removed, so the operator screens read config.theme), read back and reported; a failed write is reported and redone by --resume", async () => {
  const S = await store("live_v3", { config: KIT_CONFIG });
  await q(S, "UPDATE releases SET content = json_set(content, '$.theme', json(?)) WHERE id = 'rel_fixture_v3'", [JSON.stringify(KIT_CONFIG.theme)]);
  const m = await moved(S);
  eq(m.report.themePin.status, "written", "the move pinned the look:");
  const pinOf = async () => (await platform.execute({ sql: "SELECT json_type(config, '$.theme_pin') AS t, config FROM tenants WHERE id = ?", args: [S.id] })).rows[0];
  eq((await pinOf()).t, "object", "pinned after the move:");
  Rev.__reverseTestHooks.pinWrite = async () => {
    throw new Error("control plane down (test)");
  };
  let r;
  try {
    r = await reverse(S);
  } finally {
    Rev.resetReverseTestHooks();
  }
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(r.report.themePin.status, "failed", "reported:");
  ok(Rep.renderReverseText(r.report).includes("Couldn't be set back."), "said in plain words");
  eq((await modeOf(S)).mode, "legacy", "the store is back all the same:");
  const status = Rep.renderReverseStatusText(await inS(S, () => Rev.reverseStatus()), { tenant: S.id });
  ok(/didn't all finish/.test(status) && /--resume/.test(status), status);
  const again = await resumeReverse(S);
  ok(again.ok, JSON.stringify(again));
  eq(again.report.themePin.status, "reset", "reset on --resume:");
  const row = await pinOf();
  eq(row.t, null, "no theme_pin key:");
  const config = JSON.parse(String(row.config));
  ok(!Object.hasOwn(config, "theme_pin_at"), "its stamp removed too");
  same(Kits.themePinOf(config), KIT_CONFIG.theme, "the operator screens read the old editor's theme:");
  same(again.report.themePin.look, { kit: "glow", version: 2 }, "reported:");
  ok(Rep.renderReverseText(again.report).includes("Set back to the old editor's look."), "said");
  const status2 = Rep.renderReverseStatusText(await inS(S, () => Rev.reverseStatus()), { tenant: S.id });
  ok(!/didn't all finish/.test(status2), status2);
});

// =======================================================================================
console.log("— 5. --status, --abort, refusals, the command");

await t("--status prints the paused reversal's step in plain words (read only); --abort after step 1 returns the store to the new editor with publishing working; --abort after step 2 refuses; with nothing under way it says so", async () => {
  const S = await store("live_v3");
  await moved(S);
  const { a } = await pickProducts(S);
  Rev.__reverseTestHooks.afterLock = crash;
  await reverse(S, { now: () => "2026-11-05T10:00:00.000Z" }).catch(() => null);
  Rev.resetReverseTestHooks();
  const before = await q(S, "SELECT * FROM cms_migration_runs");
  const s = await inS(S, () => Rev.reverseStatus());
  const text = Rep.renderReverseStatusText(s, { tenant: S.id, now: Date.parse("2026-11-05T10:12:00.000Z") });
  ok(text.startsWith("Your store is being moved back to the old editor."), text);
  ok(text.includes("Started: 2026-11-05 10:00 UTC, 12 minutes ago."), text);
  ok(text.includes("Done so far: the store was paused for going back"), text);
  ok(text.includes("the same command with --resume") && text.includes("the same command with --abort"), text);
  plainWords(text, "status");
  same(await q(S, "SELECT * FROM cms_migration_runs"), before, "read only:");
  // a move's status names the reversal too
  ok(/moved back to the old editor/.test(Rep.renderStatusText(await inS(S, () => Cut.cutoverStatus()), { tenant: S.id })), "the move tool's status");
  const ab = await inS(S, () => Rev.abortReversal({ now: movingClock }));
  ok(ab.ok, JSON.stringify(ab));
  plainWords(ab.words, "abort words");
  eq((await modeOf(S)).mode, "documents", "back on the new editor:");
  eq((await q(S, "SELECT outcome FROM cms_migration_runs WHERE kind = 'reverse'"))[0].outcome, "aborted", "the run:");
  await editProduct(S, a, { title: v("Published After Abort") });
  eq(await seenTitle(S, a), "Published After Abort", "publishing works again:");
  // after step 2
  const r = await reverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const after = await inS(S, () => Rev.abortReversal({ now: movingClock }));
  eq(after.refused?.code, "AFTER_REVERSAL", JSON.stringify(after));
  ok(/already back on the old editor/.test(after.refused.message), after.refused.message);
  plainWords(after.refused.message.replace("migrate:documents", "the move command"), "after words");
  eq((await modeOf(S)).mode, "legacy", "still legacy:");
  const S2 = await store("live_v3");
  await moved(S2);
  const none = await inS(S2, () => Rev.abortReversal({ now: movingClock }));
  eq(none.refused?.code, "NOTHING", JSON.stringify(none));
});

await t("refusals before anything is written: a store on the old editor, one that started on the new editor, a missing or stale dry-run digest, a hosted database without --hosted --confirm --backup-ref, an open reversal without --resume", async () => {
  const S = await store("live_v3");
  const legacy = await reverse(S, { digest: "x" });
  eq(legacy.refused?.code, "ALREADY_LEGACY", JSON.stringify(legacy));
  // a store provisioned on the new editor (never moved)
  const N = await store("live_v3");
  await q(N, "UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  const nd = await reverseDry(N);
  eq(nd.refused?.code, "NEVER_MOVED", JSON.stringify(nd.refused));
  const never = await reverse(N);
  eq(never.refused?.code, "NEVER_MOVED", JSON.stringify(never));
  eq(await count(N, "cms_migration_runs"), 0, "nothing written:");
  await moved(S);
  const runs = await count(S, "cms_migration_runs");
  const none = await reverse(S, { digest: null });
  eq(none.refused?.code, "NO_DIGEST", JSON.stringify(none));
  ok(/--dry-run-digest/.test(none.refused.message), none.refused.message);
  const stale = await reverse(S, { digest: "0".repeat(64) });
  eq(stale.refused?.code, "STALE_DIGEST", JSON.stringify(stale));
  const hosted = await reverse(S, { hosted: { needed: true, hosted: false } });
  eq(hosted.refused?.code, "HOSTED", JSON.stringify(hosted));
  const noRef = await reverse(S, { hosted: { needed: true, hosted: true, confirm: S.id } });
  eq(noRef.refused?.code, "BACKUP_REF", JSON.stringify(noRef));
  const notHosted = await reverse(S, { hosted: { needed: false, hosted: true } });
  eq(notHosted.refused?.code, "NOT_HOSTED", JSON.stringify(notHosted));
  eq(await count(S, "cms_migration_runs"), runs, "no run written by a refusal:");
  eq((await modeOf(S)).mode, "documents", "still on the new editor:");
  for (const x of [legacy, never, none, stale]) plainWords(x.refused.message.replace("--dry-run-digest", "").replace("--dry-run", ""), x.refused.code);
  Rev.__reverseTestHooks.afterLock = crash;
  await reverse(S).catch(() => null);
  Rev.resetReverseTestHooks();
  const open = await reverse(S);
  eq(open.refused?.code, "OPEN_RUN", JSON.stringify(open));
  const cutWhileOpen = await move(S);
  ok(cutWhileOpen.refused, "the move tool refuses while the reversal holds the store");
});

const cli = (args, env) => spawnSync(process.execPath, [join(ROOT, "scripts/reverse-documents.js"), ...args], { cwd: ROOT, env, encoding: "utf8" });
await t("the command: no database address refuses in plain words and creates nothing; --dry-run, the reversal with its digest, --status and --abort through the command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "storeasy-mrev-cli-"));
  try {
    const bare = { PATH: process.env.PATH, HOME: process.env.HOME };
    for (const args of [["--tenant", "somestore", "--status"], ["--tenant", "_default", "--dry-run"], ["--tenant", "somestore", "--dry-run-digest", "x"]]) {
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/reverse-documents.js"), ...args], { cwd: dir, env: bare, encoding: "utf8" });
      eq(r.status, 1, `${args.join(" ")}:`);
      ok(/--env-file/.test(r.stderr), r.stderr);
    }
    eq((await (await import("node:fs/promises")).readdir(dir)).length, 0, "no file created:");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const S = await store("live_v3");
  await moved(S);
  const env = { ...process.env };
  const nd = cli(["--tenant", S.id], env);
  eq(nd.status, 1, "no digest:");
  ok(/--dry-run/.test(nd.stderr), nd.stderr);
  const dry = cli(["--tenant", S.id, "--dry-run"], env);
  eq(dry.status, 0, dry.stderr);
  ok(dry.stdout.startsWith("Ready to move back to the old editor"), dry.stdout.slice(0, 200));
  const digest = /Reversal dry-run digest: ([0-9a-f]{64})/.exec(dry.stdout)?.[1];
  ok(digest, dry.stdout.slice(-200));
  eq(digest, (await reverseDry(S)).digest, "the command's digest is the reversal's:");
  const st = cli(["--tenant", S.id, "--status"], env);
  ok(st.status === 0 && /uses the new editor\. No reversal is under way\./.test(st.stdout), st.stdout + st.stderr);
  const go = cli(["--tenant", S.id, "--dry-run-digest", digest], env);
  eq(go.status, 0, go.stderr + go.stdout.slice(0, 400));
  ok(go.stdout.startsWith("Your store is back on the old editor."), go.stdout.slice(0, 300));
  ok(go.stdout.includes("A message you can pass on"), "the founder message");
  const ab = cli(["--tenant", S.id, "--abort"], env);
  eq(ab.status, 1, "abort after step 2:");
  ok(/already back on the old editor/.test(ab.stderr), ab.stderr);
  eq((await modeOf(S)).mode, "legacy", "reversed by the command:");
});

// =======================================================================================
console.log("— 6. moving to the new editor again");

await t("a move after a reversal restores the product names (and other overlay edits) from the documents' published versions, shows them only after the switch, and puts nothing else published in the new editor live again (counted as kept versions); the dry run lists by name the edits that come back", async () => {
  const S = await store("live_v3");
  await moved(S);
  const { a, b } = await pickProducts(S);
  await editProduct(S, a, { title: v("Back Again Extras"), gallery: v([{ media: "https://cdn.shopify.com/s/files/back-again.jpg", alt: "New photo" }]) });
  await editProduct(S, b, { title: v("Back Again Plain") });
  await saveSettings(S, "doc_announcement", { text: "Published in the new editor before the reversal" });
  eq((await publishDocs(S, ["doc_announcement"])).published?.length, 1, "announcement published");
  const r = await reverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  eq(await seenTitle(S, a), await shopifyTitle(S, a), "Shopify's name on the old editor:");
  const nameA = await shopifyTitle(S, a);
  const nameB = await shopifyTitle(S, b);
  // the dry run of the new move lists what comes back, by name
  const pr = await proofs(S);
  ok(pr.dry.report.verdict.ready, `ready: ${JSON.stringify(pr.dry.report.verdict)}`);
  const text = Rep.renderText(pr.dry.report, pr.dry.digest);
  ok(text.includes(Rep.RECUT_TITLES[0]), text.slice(0, 1500));
  ok(text.includes(`“${nameA}”: new name (“Back Again Extras”), photos.`), text.slice(0, 2500));
  ok(text.includes(`“${nameB}”: new name (“Back Again Plain”).`), text.slice(0, 2500));
  ok(text.includes(Rep.RECUT_TITLES[1]) && text.includes("The announcement bar: what was published in the new editor."), text.slice(0, 2500));
  plainWords(abovedetails(text, Rep), "the dry run");
  // the move, stopped before the switch: shoppers still see Shopify's names
  let seenBeforeFlip = null;
  Cut.__cutoverTestHooks.beforeFlip = async () => {
    seenBeforeFlip = { a: await seenTitle(S, a), b: await seenTitle(S, b), live: await q(S, "SELECT product_id, title, gallery FROM product_content_live WHERE product_id IN (?, ?)", [a, b]) };
  };
  let m;
  try {
    m = await move(S, { proofs: pr });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  ok(m.ok, JSON.stringify(m.refused || m.stopped));
  eq(seenBeforeFlip.a, nameA, "before the switch, Shopify's name (a):");
  eq(seenBeforeFlip.b, nameB, "before the switch, Shopify's name (b):");
  ok(seenBeforeFlip.live.every((x) => x.title == null && x.gallery == null), `the backfill wrote no overlay column: ${JSON.stringify(seenBeforeFlip.live)}`);
  // after the switch, the edits are back
  eq(await seenTitle(S, a), "Back Again Extras", "the name came back (a):");
  eq(await seenTitle(S, b), "Back Again Plain", "the name came back (b):");
  const page = await seenPage(S, a);
  eq(page.featured_image, "https://cdn.shopify.com/s/files/back-again.jpg", "the photos came back:");
  // the editor holds them too, so the next publish keeps them
  const o = await openProduct(S, a);
  eq(o.document.body.settings.title?.value, "Back Again Extras", "the draft carries the name:");
  eq(o.document.publishedVersionId ?? (await q(S, "SELECT published_version_id AS p FROM documents WHERE id = ?", [o.document.id]))[0].p, (await q(S, "SELECT version_id AS p FROM product_content_live WHERE product_id = ?", [a]))[0].p, "the live row is the published version:");
  // nothing else published in the new editor went live again
  const ann = JSON.parse((await q(S, "SELECT v.body FROM documents d JOIN document_versions v ON v.id = d.published_version_id WHERE d.id = 'doc_announcement'"))[0].body);
  ok(ann.settings.text !== "Published in the new editor before the reversal", `the announcement is the old editor's: ${ann.settings.text}`);
  ok((await count(S, "document_versions", "document_id = 'doc_announcement' AND body LIKE '%Published in the new editor before the reversal%'")) > 0, "kept as an older version");
  ok(m.report.keptPublished.some((k) => k.id === "doc_announcement"), "counted in the report");
  eq(m.report.restored.length, 2, "two products restored:");
  const done = Rep.renderCutoverText(m.report);
  ok(done.includes(`“${nameA}”: new name (“Back Again Extras”), photos.`), done.slice(0, 1500));
  plainWords(abovedetails(done, Rep), "the move's report");
  // search gets the restored names from the flip's outbox rows
  ok((await count(S, "search_outbox", `reason = 'cutover' AND product_id IN ('${a}', '${b}')`)) === 2, "outbox rows for the restored products");
});

await t("a move after a reversal with nothing edited in the new editor restores nothing and its report has no 'come back' section; a first move never restores", async () => {
  const S = await store("live_v3");
  await moved(S);
  const r = await reverse(S);
  ok(r.ok, JSON.stringify(r.refused || r.stopped));
  const pr = await proofs(S);
  ok(!pr.dry.report.editsComingBack, "nothing comes back");
  const m = await moved(S, { proofs: pr });
  ok(!m.report.restored?.length, "nothing restored");
  // a first move on a store that holds an old new-editor title in a version never restores it
  const F = await store("live_v3");
  const plan = await inS(F, async () => Back.recutoverPlan({ documents: [] }));
  eq(plan.applies, false, "no reversal, no restore:");
});

// =======================================================================================
console.log("— 7. the P4-CUTOVER review: its own words");

await t("a failed agency read after the pause stops with its own 'couldn't read … try again' words (not 'the store changed'), back on the old editor; a missing editor record refuses with its own words before anything is written", async () => {
  const S = await store("live_v3");
  const pr = await proofs(S);
  let failRead = false;
  const flaky = {
    execute: async (stmt) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (failRead && /agency_grants/.test(sql)) throw new Error("control plane timeout (test)");
      return platform.execute(stmt);
    },
  };
  Cut.__cutoverTestHooks.afterLock = async () => {
    failRead = true;
  };
  let r;
  try {
    r = await move(S, { proofs: pr, platform: flaky });
  } finally {
    Cut.resetCutoverTestHooks();
  }
  eq(r.stopped?.code, "RECHECK_AGENCY_UNREAD", JSON.stringify(r));
  ok(/couldn't read/.test(r.stopped.words) && /Try again/.test(r.stopped.words), r.stopped.words);
  ok(!/changed since the dry run/.test(r.stopped.words), "not the source-moved words");
  plainWords(r.stopped.words, "agency words");
  eq((await modeOf(S)).mode, "legacy", "back on the old editor:");
  // the editor record missing
  const N = await store("live_v3");
  const pn = await proofs(N);
  await q(N, "DELETE FROM cms_state");
  const r2 = await move(N, { proofs: pn });
  eq(r2.refused?.code, "NO_MODE_ROW", JSON.stringify(r2));
  ok(/record of which editor it uses is missing/.test(r2.refused.message), r2.refused.message);
  plainWords(r2.refused.message, "mode row words");
  eq(await count(N, "cms_migration_runs"), 0, "no run:");
  eq(await count(N, "cms_state"), 0, "nothing written:");
});

await t("the runbook has the reversal section: the commands, the dry run and its digest, status/resume/abort, the message for the founder, the look line and the re-move rule; and says the source-hash recheck doesn't cover control-plane brand or theme edits", async () => {
  const text = await readFile(join(ROOT, "docs/cms-reviews/P4-CUTOVER-RUNBOOK.md"), "utf8");
  const at = text.indexOf("## 9. Reversal: going back to the old editor");
  ok(at > 0, "the section");
  const rev = text.slice(at);
  for (const s of ["scripts/reverse-documents.js", "--dry-run", "--dry-run-digest", "--status", "--resume", "--abort", "--hosted --confirm", "--backup-ref", "old editors work again", "brings those edits back", "theme_pin", "migrate:documents"]) ok(rev.includes(s), `runbook reversal section names ${s}`);
  ok(/does not cover brand or theme edits/.test(text), "the source-hash limit");
  const packet = await readFile(join(ROOT, "docs/cms-reviews/P4-CUTOVER.md"), "utf8");
  ok(/does not cover brand or theme edits/.test(packet), "said in P4-CUTOVER.md too");
});

// =======================================================================================
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${pass} passed, ${fail} failed (${secs} s)`);
await world.cleanup();
process.exit(fail ? 1 : 0);
