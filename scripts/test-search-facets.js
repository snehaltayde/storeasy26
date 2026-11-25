// P7-FACETS (docs/plans/phase-7.md line 2): a shopper filters search results
// by several facets. Anonymous reads only: real file databases
// (scripts/support/tenant-fixture.js), the real search page run under the page
// harness, the SQL engine on real SQLite, and Typesense as a stubbed fetch that
// evaluates the filter_by it is sent over buildSearchDoc documents (nothing is
// ever sent anywhere).
//   1. parsing and escaping: nothing raw reaches filter_by
//   2. the SQL engine: scope, published values, OR/AND, disjunctive counts, stock
//   3. Typesense: the request body, the same answers as SQL, fallback
//   4. the page: no tags in the HTML, noindex, edge safety
//   5. cost: SQL facets on 5,000 products, timed
//   pnpm test:search-facets
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-sf-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
const TS_ENV = ["TYPESENSE_HOST", "TYPESENSE_ADMIN_API_KEY", "TYPESENSE_COLLECTION", "TYPESENSE_PORT", "TYPESENSE_PROTOCOL"];
const typesenseOn = () => {
  process.env.TYPESENSE_HOST = "127.0.0.1";
  process.env.TYPESENSE_ADMIN_API_KEY = "dummy-local-key";
};
const typesenseOff = () => {
  for (const k of TS_ENV) delete process.env[k];
};
typesenseOff();

// every fetch is refused unless a test installs a Typesense stub
const fetchCalls = [];
let tsStub = null;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url?.url ?? url), body: init?.body ?? null });
  if (tsStub) return tsStub(String(url), init);
  throw new Error("test-search-facets: no network in this suite");
};
const logs = [];
const realLog = console.log;
console.log = (...a) => {
  if (a.length === 1 && typeof a[0] === "string" && a[0].startsWith("{")) {
    try {
      logs.push(JSON.parse(a[0]));
      return;
    } catch {
      /* not a log line */
    }
  }
  realLog(...a);
};

const started = Date.now();
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("sf");
await rm(join(ROOT, ".test-sf-default.db"), { force: true });
await F.makePlatform({ name: "sf" });
const I = await import("../lib/platform/identity.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const FX = await import("../lib/catalog/facets.js");
const FS = await import("../lib/catalog/facet-search.js");
const E = await import("../lib/catalog/effective.js");
const SD = await import("../lib/catalog/search-doc.js");
const TSchema = await import("../lib/typesense.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    realLog(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e?.stack?.split("\n").slice(0, 6).join("\n   ") || e}`);
  } finally {
    tsStub = null;
    typesenseOff();
  }
}
const canon = (v) => JSON.stringify(v, Object.keys(v ?? {}).length ? undefined : undefined);
const eq = (got, want, label = "") => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label} expected ${JSON.stringify(want).slice(0, 900)}, got ${JSON.stringify(got).slice(0, 900)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
void canon;

// ---- the catalog ---------------------------------------------------------------------
const variant = (n, k, price, available, opts) => ({
  id: `gid://shopify/ProductVariant/${9100 + n}${k}`,
  title: opts.map((o) => o[1]).join(" / ") || "Default Title",
  sku: `SF-${n}-${k}`,
  price: { amount: String(price), currencyCode: "INR" },
  availableForSale: available,
  selectedOptions: opts.length ? opts.map(([name, value]) => ({ name, value })) : [{ name: "Title", value: "Default Title" }],
  image: null,
});
const prod = (n, { type, vendor, price, available = true, tags = ["fixture"], variants }) => ({
  id: `gid://shopify/Product/${9100 + n}`,
  handle: `sf-${n}`,
  title: `Facet thing ${n}`,
  productType: type,
  vendor,
  tags,
  price,
  availableForSale: available,
  createdAt: `2026-01-${String(10 + n).padStart(2, "0")}T00:00:00Z`,
  variants: { nodes: variants.map(([avail, opts], k) => variant(n, k + 1, price, avail, opts)) },
});
const SECRET_TAG = "internal-margin-tag";
const A_PRODUCTS = [
  prod(1, { type: "Tee", vendor: "Acme", price: 500, tags: [SECRET_TAG], variants: [[true, [["Size", "M"], ["Colour", "Red"]]], [false, [["Size", "L"], ["Colour", "Red"]]]] }),
  prod(2, { type: "Tee", vendor: "Acme", price: 700, variants: [[true, [["Size", "S"], ["Colour", "Blue"]]], [true, [["Size", "M"], ["Colour", "Blue"]]]] }),
  prod(3, { type: "Hoodie", vendor: "Bolt", price: 1500, variants: [[true, [["size", "M"], ["Colour", "Black"]]]] }),
  prod(4, { type: "Hoodie", vendor: "Acme", price: 1800, available: false, variants: [[false, [["Size", "L"], ["Colour", "Grey"]]]] }),
  prod(5, { type: "Cap", vendor: "Bolt", price: 300, variants: [[true, []]] }),
  prod(6, { type: "Mug", vendor: "Bolt", price: 400, variants: [[true, []]] }),
];
const B_PRODUCTS = [prod(1, { type: "Otherstore Type", vendor: "Otherstore Brand", price: 999, variants: [[true, [["Size", "XXL"]]]] })];
const CONFIG = { site: { name: "SF Store" }, site_url: "https://sf.test", shopify_store_domain: "sf-store.myshopify.com" };
const A = await F.makeTenant({ name: "sf-a", id: "sfa", mode: "documents", products: A_PRODUCTS, config: { ...CONFIG, typesense_collection: "sfa_products" } });
const B = await F.makeTenant({ name: "sf-b", id: "sfb", mode: "documents", products: B_PRODUCTS, config: CONFIG });
// non-ASCII option names (SQLite lower()/trim() are ASCII-only) and a value
// with a trailing tab; a real Unicode value
const U_PRODUCTS = [
  prod(1, { type: "Étoffe", vendor: "Maison", price: 100, variants: [[true, [["ÉPAISSEUR", "Très fin\t"], ["Taille", "日本"]]], [true, [["ÉPAISSEUR", "Épais"], ["Taille", "M"]]]] }),
  prod(2, { type: "Étoffe", vendor: "Maison", price: 200, variants: [[true, [[" Épaisseur ", "Très fin"], ["Taille", "M"]]]] }),
  prod(3, { type: "Étoffe", vendor: "Maison", price: 300, variants: [[true, [["ÉPAISSEUR", "Épais"], ["Taille", "日本"]]]] }),
];
const U = await F.makeTenant({ name: "sf-u", id: "sfu", mode: "documents", products: U_PRODUCTS, config: { ...CONFIG, typesense_collection: "sfu_products" } });
const owner = await I.createUser({ email: "owner@sf.test", name: "Asha", password: "owner-pass-facets" });
for (const fx of [A, B, U]) await I.addMembership(owner.id, fx.id, "owner");
const ACTOR = { kind: "merchant", id: owner.id };

// sf-6: Shopify's type "Mug", the founder PUBLISHED "Drinkware", then saved a
// draft "Draft Type" that is not published
await A.run(async () => {
  const o = await Docs.openEntityContent({ type: "product_content", entityId: "gid://shopify/Product/9106", actor: ACTOR });
  const save = async (value) => {
    const d = await Docs.getDocument(o.document.id);
    return Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, display_type: { value } } }, actor: ACTOR });
  };
  await save("Drinkware");
  const d = await Docs.getDocument(o.document.id);
  await Pub.publish({ ids: [{ id: d.id, revision: d.revision, draftHash: d.draftHash }], actor: ACTOR });
  await save("Draft Type");
});

const P = (sp) => FX.parseFacetParams(sp);
const db = (fx, sp) => fx.run(() => FX.facetSearchDb(P(sp)));
const shaped = async (fx, sp) => {
  const s = P(sp);
  const r = await fx.run(() => FX.facetSearchDb(s));
  return { ...r, ...FX.shapeFacets(s, r.counts) };
};
const handles = (r) => r.hits.map((h) => h.handle).sort();
const countOf = (r, group, value) => r.groups.find((g) => g.key === group)?.values.find((v) => v.value === value)?.count;

// =============================================================================
realLog("— 1. parsing and escaping");
// =============================================================================

await t("parse: values are trimmed, deduped and capped (20 per group, 80 chars, 6 option groups); backticks and control characters are stripped; option names are lowercased", () => {
  const s = P({ q: "  tee ", type: Array.from({ length: 100 }, (_, i) => `T${i}`), vendor: ["A`cme\u0000", "A`cme"], o: ["Size:M", "SIZE:M", "size:L", ...Array.from({ length: 10 }, (_, i) => `g${i}:x`)], min: "100", max: "50", sort: "bogus", page: "x" });
  eq(s.q, "tee");
  eq(s.types.length, 20, "types capped:");
  eq(s.vendors, ["Acme"], "vendors:");
  eq(s.options[0], { name: "size", values: ["M", "L"] }, "size group:");
  ok(s.options.length <= FX.MAX_SELECTED_GROUPS - 2, `type and brand take two of the six selected groups: ${s.options.length}`);
  eq([s.min, s.max], [50, 100], "min > max swapped:");
  eq([s.sort, s.page], ["relevance", 1]);
  eq(P({ type: "x".repeat(5000) }).types[0].length, 80, "5,000 chars capped to 80:");
  eq(P({ o: Array.from({ length: 10 }, (_, i) => `g${i}:x`) }).options.length, FX.MAX_OPTION_GROUPS, "six option groups at most:");
});

await t("parse: negative, non-numeric and absurd prices are ignored; instock only as 1; a page is 1 to 100", () => {
  for (const bad of ["-5", "abc", "1e5", "", " ", "0x10", "NaN", "Infinity"]) eq(P({ min: bad }).min, null, `min=${bad}:`);
  eq(P({ min: "0", max: "12.5" }).max, 12.5);
  eq(P({ instock: "true" }).instock, false);
  eq(P({ instock: "1" }).instock, true);
  eq(P({ page: "9999" }).page, 1, "four digits:");
  eq(P({ page: "250" }).page, 100);
  eq(P({ sort: ["price-asc", "new"] }).sort, "price-asc");
});

await t("filter_by: every value is in backticks; injection attempts (`, &&, ||, ), 5,000 chars, 100 repeated keys) never reach it raw", () => {
  eq(P({ type: "b\\c`\\" }).types, ["bc"], "backslashes stripped:");
  const s = P({ type: ["a`,b", "x && vendor:=[y]", "z || available:=false", "w)", "q".repeat(5000)], vendor: Array.from({ length: 100 }, () => "Same"), o: ["size:M`] || options:=[`x"], min: "10", max: "20", instock: "1" });
  const f = FX.typesenseFilter(s);
  const m = f.match(/^product_type:=\[(.*?)\] && vendor:=\[`Same`\] && options_available:=\[(.*?)\] && price:>=10 && price:<=20 && available:=true$/);
  ok(m, `the shape: ${f}`);
  const vals = [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1]);
  eq(vals, ["a,b", "x && vendor:=[y]", "z || available:=false", "w)", "q".repeat(80)], "type values, each whole inside backticks:");
  eq(m[1], vals.map((v) => `\`${v}\``).join(", "), "nothing outside the backticks but the separators:");
  eq(m[2], "`size:M] || options:=[x`", "the option value, backticks stripped, inside backticks:");
  eq(FX.typesenseFilter(s, { exclude: "type" }).includes("product_type"), false, "exclude leaves its group out:");
  eq(FX.typesenseFilter(P({})), "", "nothing on:");
});

await t("links: facetHref keeps a fixed order, resets the page, and toggled adds and removes a value", () => {
  const s = P({ q: "tee", type: ["Tee"], o: ["size:M"], page: "3", sort: "new" });
  eq(FX.facetHref(s), "/search?q=tee&type=Tee&o=size%3AM&sort=new");
  eq(FX.facetHref(s, { page: 2 }), "/search?q=tee&type=Tee&o=size%3AM&sort=new&page=2");
  eq(FX.facetHref(FX.toggled(s, "type", "Hoodie")), "/search?q=tee&type=Tee&type=Hoodie&o=size%3AM&sort=new");
  eq(FX.facetHref(FX.toggled(s, "o:size", "M")), "/search?q=tee&type=Tee&sort=new");
  eq(FX.facetHref(FX.clearedFilters(s)), "/search?q=tee&sort=new");
  eq(FX.activeCount(P({ type: ["a", "b"], o: ["size:M"], min: "1", instock: "1" })), 5);
});

// =============================================================================
realLog("— 2. the SQL engine");
// =============================================================================

await t("scope: store B's products never appear in A's values, counts or results (and A's never in B's)", async () => {
  const a = await shaped(A, {});
  const text = JSON.stringify(a);
  for (const w of ["Otherstore", "XXL"]) ok(!text.includes(w), `A shows ${w}`);
  eq(a.found, 6, "A's total:");
  const b = await shaped(B, {});
  eq(b.found, 1);
  for (const w of ["Acme", "Bolt", "Tee"]) ok(!JSON.stringify(b).includes(w), `B shows ${w}`);
});

await t("published values: the published type 'Drinkware' is a value and matches; Shopify's 'Mug' and the draft 'Draft Type' are not", async () => {
  const a = await shaped(A, {});
  const types = a.groups.find((g) => g.key === "type").values.map((v) => v.value).sort();
  eq(types, ["Cap", "Drinkware", "Hoodie", "Tee"]);
  eq(handles(await db(A, { type: "Drinkware" })), ["sf-6"]);
  eq((await db(A, { type: "Mug" })).found, 0, "Shopify's raw type matches nothing:");
  eq((await db(A, { type: "Draft Type" })).found, 0, "the draft matches nothing:");
  ok(!JSON.stringify(a).includes("Draft Type"), "the draft is nowhere");
});

await t("tags are never a facet or a value; the secret tag is in no group", async () => {
  const a = await shaped(A, {});
  ok(!JSON.stringify(a).includes(SECRET_TAG), "tag shown");
  ok(!a.groups.some((g) => /tag/i.test(g.key)), "a tags group");
});

await t("OR within a group, AND across groups; option names group case-blind (Size and size); Default Title is no option", async () => {
  eq(handles(await db(A, { type: ["Tee", "Hoodie"] })), ["sf-1", "sf-2", "sf-3", "sf-4"], "Tee OR Hoodie:");
  eq(handles(await db(A, { type: ["Tee", "Hoodie"], vendor: "Acme" })), ["sf-1", "sf-2", "sf-4"], "AND Acme:");
  eq(handles(await db(A, { o: "size:M" })), ["sf-1", "sf-2", "sf-3"], "size M across Size and size:");
  eq(handles(await db(A, { o: ["size:M", "colour:Red"] })), ["sf-1"], "size M AND colour Red:");
  eq(handles(await db(A, { o: ["size:S", "size:L"] })), ["sf-1", "sf-2", "sf-4"], "S OR L:");
  const a = await shaped(A, {});
  ok(!a.groups.some((g) => g.key === "o:title"), "no Title group");
  eq(a.groups.find((g) => g.key === "o:size")?.title, "Size", "the first label is shown:");
  eq(handles(await db(A, { type: "Unknown" })), [], "an unknown value matches nothing:");
});

await t("disjunctive counts: a group's counts ignore its own filter; a selected value's count equals the result total", async () => {
  const r = await shaped(A, { type: "Tee", vendor: "Acme" });
  eq(r.found, 2);
  eq(countOf(r, "type", "Tee"), r.found, "Tee's count is the total:");
  eq(countOf(r, "type", "Hoodie"), 1, "Hoodie with Acme on (sf-4):");
  eq(countOf(r, "vendor", "Acme"), r.found, "Acme's count is the total:");
  eq(countOf(r, "vendor", "Bolt"), undefined, "no Bolt Tee: Bolt has no count, so it is not listed:");
  const o = await shaped(A, { o: "size:M" });
  eq(countOf(o, "o:size", "M"), o.found, "size M's count is the total:");
  eq(countOf(o, "o:size", "L"), 2, "L ignores the size filter:");
  eq(countOf(o, "o:colour", "Black"), 1, "colour counts follow size M:");
  eq(countOf(o, "type", "Cap"), undefined, "no Cap in size M:");
});

await t("in stock: only available products; option values and counts honour in-stock variants only (options_available)", async () => {
  const r = await shaped(A, { instock: "1" });
  eq(r.found, 5, "sf-4 is sold out:");
  eq(countOf(r, "o:size", "L"), undefined, "L is only on sold-out variants:");
  eq(handles(await db(A, { o: "size:L" })), ["sf-1", "sf-4"], "without in stock L matches:");
  eq(handles(await db(A, { o: "size:L", instock: "1" })), [], "with in stock L matches nothing (sf-1's L is sold out):");
});

await t("price, sort and pages: min and max bound price_min; sorts order; 24 a page", async () => {
  eq(handles(await db(A, { min: "400", max: "1500" })), ["sf-1", "sf-2", "sf-3", "sf-6"]);
  eq((await db(A, { sort: "price-asc" })).hits.map((h) => h.price), [300, 400, 500, 700, 1500, 1800]);
  eq((await db(A, { sort: "price-desc" })).hits[0].handle, "sf-4");
  eq((await db(A, { sort: "new" })).hits[0].handle, "sf-6");
  const r = await shaped(A, { type: "Tee" });
  eq(r.price, { min: 500, max: 700 }, "price placeholders from the results:");
  eq((await db(A, { q: "thing 3" })).hits.map((h) => h.handle), ["sf-3"], "the words still search:");
});

// =============================================================================
realLog("— 3. Typesense");
// =============================================================================

// A stand-in Typesense: evaluates the filter_by grammar this code writes over
// the real documents (buildSearchDoc over indexRows) and answers multi_search.
// (also used by the Unicode test below)
const docsOf = async (fx) => (await fx.run(() => E.indexRows({ limit: 1000 }))).rows.map(SD.buildSearchDoc);
function evalFilter(doc, filter) {
  if (!filter) return true;
  return filter.split(" && ").every((c) => {
    let m = c.match(/^(\w+):=\[(.*)\]$/);
    if (m) {
      const vals = [...m[2].matchAll(/`([^`]*)`/g)].map((x) => x[1]);
      const have = doc[m[1]];
      return Array.isArray(have) ? have.some((h) => vals.includes(h)) : vals.includes(have);
    }
    if ((m = c.match(/^price:(>=|<=)(\d+(?:\.\d+)?)$/))) return m[1] === ">=" ? doc.price >= Number(m[2]) : doc.price <= Number(m[2]);
    if (c === "available:=true") return doc.available === true;
    throw new Error(`stub: unknown clause ${c}`);
  });
}
function fakeTypesense(docs, { missing = null } = {}) {
  const bodies = [];
  const fn = async (url, init) => {
    ok(url.endsWith("/multi_search") && init.method === "POST", `stub: ${url}`);
    const body = JSON.parse(init.body);
    bodies.push(body);
    const results = body.searches.map((q) => {
      if (missing && (String(q.facet_by).includes(missing) || String(q.filter_by || "").includes(missing))) return { code: 404, error: `Could not find a facet field named \`${missing}\` in the schema.` };
      let hits = docs.filter((d) => evalFilter(d, q.filter_by));
      if (q.sort_by === "price:asc") hits.sort((a, b) => a.price - b.price);
      const facet_counts = String(q.facet_by || "")
        .split(",")
        .filter(Boolean)
        .map((field) => {
          const n = new Map();
          for (const d of hits) for (const v of Array.isArray(d[field]) ? d[field] : [d[field]]) if (v !== "" && v != null) n.set(String(v), (n.get(String(v)) || 0) + 1);
          const prices = hits.map((d) => d.price);
          return { field_name: field, counts: [...n].map(([value, count]) => ({ value, count })), ...(field === "price" && prices.length ? { stats: { min: Math.min(...prices), max: Math.max(...prices) } } : {}) };
        });
      const per = q.per_page ?? 10;
      return { found: hits.length, hits: hits.slice(((q.page || 1) - 1) * per, (q.page || 1) * per).map((document) => ({ document })), facet_counts };
    });
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  fn.bodies = bodies;
  return fn;
}
const viaTypesense = async (fx, sp, stub) => {
  typesenseOn();
  tsStub = stub;
  const s = P(sp);
  return fx.run(() => FS.runFacetSearch(s));
};
const viaSql = async (fx, sp) => {
  typesenseOff();
  return fx.run(() => FS.runFacetSearch(P(sp)));
};
const sameAnswer = (x, y, label) => {
  eq(x.found, y.found, `${label} found:`);
  eq(x.hits.map((h) => h.handle).sort(), y.hits.map((h) => h.handle).sort(), `${label} hits:`);
  const flat = (r) => r.groups.map((g) => [g.key, g.values.map((v) => [v.value, v.count, v.selected])]);
  eq(flat(x), flat(y), `${label} groups:`);
};

await t("the schema and the document: options and options_available string-array facets, price a facet, created_at; documents carry the keys", async () => {
  const f = Object.fromEntries(TSchema.productsCollectionSchema().fields.map((x) => [x.name, x]));
  eq([f.options?.type, f.options?.facet, f.options_available?.type, f.options_available?.facet, f.price?.facet, f.created_at?.type], ["string[]", true, "string[]", true, true, "int64"]);
  const d = (await docsOf(A)).find((x) => x.handle === "sf-1");
  eq(d.options.sort(), ["colour:Red", "size:L", "size:M"]);
  eq(d.options_available.sort(), ["colour:Red", "size:M"]);
  eq(d.tags, [SECRET_TAG], "tags stay in the document for offers, never a facet:");
  ok(d.created_at > 0);
});

await t("Typesense: one multi_search with the main query plus one per selected group (≤ 7), filter_by from validated values only; the same answers as SQL for OR/AND, stock and price", async () => {
  const docs = await docsOf(A);
  for (const sp of [{}, { type: ["Tee", "Hoodie"] }, { type: ["Tee", "Hoodie"], vendor: "Acme" }, { o: ["size:M", "colour:Red"] }, { o: "size:M", instock: "1" }, { min: "400", max: "1500", type: "Tee" }, { instock: "1" }]) {
    const stub = fakeTypesense(docs);
    const ts = await viaTypesense(A, sp, stub);
    eq(ts.source, "typesense", `${JSON.stringify(sp)} source:`);
    const sq = await viaSql(A, sp);
    eq(sq.source, "database");
    sameAnswer(ts, sq, JSON.stringify(sp));
    const body = stub.bodies[0];
    const s = P(sp);
    eq(body.searches.length, 1 + FX.selectedGroups(s).length, `${JSON.stringify(sp)} queries:`);
    ok(body.searches.length <= 7);
    eq(body.searches[0].filter_by ?? "", FX.typesenseFilter(s), "main filter:");
    eq(body.searches[0].collection, "sfa_products", "only this store's collection:");
    ok(body.searches.every((q) => !JSON.stringify(q).includes("tags")) || body.searches.every((q) => !String(q.facet_by).includes("tags")), "never a tags facet");
    ok(body.searches.every((q) => !String(q.facet_by).includes("tags")), "no tags facet");
  }
  const big = fakeTypesense(docs);
  await viaTypesense(A, { type: "T", vendor: "V", o: ["a:1", "b:1", "c:1", "d:1", "e:1", "f:1"] }, big);
  ok(big.bodies[0].searches.length <= 7, `at most 7 queries: ${big.bodies[0].searches.length}`);
});

await t("Typesense: an old index without the options field falls back to SQL for that request and logs search_facets_fallback; search_facets logs source, groups and ms", async () => {
  const n = logs.length;
  const r = await viaTypesense(A, { o: "size:M" }, fakeTypesense(await docsOf(A), { missing: "options" }));
  eq(r.source, "database");
  eq(r.found, 3);
  const fb = logs.slice(n).filter((l) => l.evt === "search_facets_fallback");
  eq(fb.length, 1, "one fallback line:");
  ok(/options/.test(fb[0].reason), fb[0].reason);
  const sf = logs.slice(n).filter((l) => l.evt === "search_facets");
  ok(sf.length === 1 && sf[0].source === "database" && typeof sf[0].ms === "number" && sf[0].groups > 0, JSON.stringify(sf));
});

await t("a tenant without a Typesense namespace uses SQL and sends nothing", async () => {
  typesenseOn();
  const before = fetchCalls.length;
  const r = await B.run(() => FS.runFacetSearch(P({})));
  eq(r.source, "database");
  eq(fetchCalls.length, before, "no fetch:");
});

await t("Unicode: a non-ASCII option name (ÉPAISSEUR, ' Épaisseur ') is one group on both engines and matches; a trailing tab is trimmed; a Unicode value (日本) filters", async () => {
  const all = await shaped(U, {});
  const keys = all.groups.map((g) => g.key);
  eq(keys.filter((k) => k.startsWith("o:")).sort(), ["o:taille", "o:Épaisseur"], "one group per name:");
  const ep = all.groups.find((g) => g.key === "o:Épaisseur");
  eq(ep.values.map((v) => [v.value, v.count]).sort(), [["Très fin", 2], ["Épais", 2]].sort(), "the tab is trimmed, counts per product:");
  // the URL the rail links to, parsed back, matches
  const href = FX.facetHref(FX.toggled(FX.parseFacetParams({}), "o:Épaisseur", "Très fin"));
  const back = Object.fromEntries([...new URL(href, "https://x.test").searchParams].map(([k, v]) => [k, v]));
  eq(handles(await db(U, back)), ["sf-1", "sf-2"], `${href}:`);
  eq(handles(await db(U, { o: "taille:日本" })), ["sf-1", "sf-3"], "日本:");
  eq(handles(await db(U, { o: ["ÉPAISSEUR:Très fin", "taille:日本"] })), ["sf-1"], "the name as typed in capitals normalises the same:");
  const d = (await docsOf(U)).find((x) => x.handle === "sf-1");
  eq(d.options.sort(), ["taille:M", "taille:日本", "Épaisseur:Très fin", "Épaisseur:Épais"].sort(), "Typesense keys agree:");
  for (const sp of [{}, { o: "Épaisseur:Très fin" }, { o: ["Épaisseur:Épais", "taille:日本"] }]) sameAnswer(await viaTypesense(U, sp, fakeTypesense(await docsOf(U))), await viaSql(U, sp), `U ${JSON.stringify(sp)}`);
});

await t("six selected groups: groups with nothing selected are left out (a value there would be dropped), full is set; at five they show", async () => {
  const full = await shaped(A, { type: "Tee", vendor: "Acme", o: ["size:M", "colour:Red", "fit:x", "cut:y"] });
  ok(full.full, "full");
  ok(full.groups.every((g) => g.selectedCount > 0), `only selected groups: ${full.groups.map((g) => g.key)}`);
  const five = await shaped(A, { type: "Tee", o: ["size:M", "fit:x", "cut:y", "hem:z"] });
  eq(five.full, false, "at five:");
  const counts = { type: [{ value: "A", count: 1 }, { value: "B", count: 1 }] };
  ok(FX.shapeFacets(P({ o: ["a:1", "b:1", "c:1", "d:1", "e:1"] }), counts).groups.some((g) => g.key === "type"), "at five an unselected group shows");
  ok(!FX.shapeFacets(P({ vendor: "V", o: ["a:1", "b:1", "c:1", "d:1", "e:1"] }), counts).groups.some((g) => g.key === "type"), "at six it is left out");
});

// =============================================================================
realLog("— 4. the page");
// =============================================================================

const { makePageHarness } = await import("./support/page-harness.js");
const PH = await makePageHarness({ tenant: async () => A.tenant });
const PAGE = "app/(storefront)/search/page.js";

await t("the page (anonymous, no cookies): its props carry the results and groups, never a raw tag, B's data or a draft; chips and the empty state", async () => {
  const r = await PH.run(PAGE, { cookies: {}, searchParams: Promise.resolve({ q: "thing", type: ["Tee", "Hoodie"], o: "size:M" }) });
  ok(!r.error, String(r.error?.stack || r.error).slice(0, 400));
  eq(r.unresolved, [], "every import resolved:");
  const all = JSON.stringify(r.props) + r.text;
  for (const w of [SECRET_TAG, "Otherstore", "Draft Type"]) ok(!all.includes(w), `the page shows ${w}`);
  const rail = r.props.find((p) => /FacetRail/.test(p.component));
  ok(rail && rail.props.groups.some((g) => g.key === "o:size"), `FacetRail gets the groups: ${r.props.map((p) => p.component).join(", ")}`);
  const sheet = r.props.find((p) => /FacetSheet/.test(p.component));
  eq([sheet?.props.active, sheet?.props.total], [3, 3], "Filters (3), Show 3 products:");
  ok(r.text.includes("3 products"), "the count");
  const empty = await PH.run(PAGE, { cookies: {}, searchParams: Promise.resolve({ q: "thing", type: "Nothing-like-this" }) });
  ok(empty.text.includes("No products match these filters.") && empty.text.includes("Clear all filters"), `empty: ${empty.text.slice(0, 300)}`);
});

await t("paging past the end redirects to the last page; an empty result does not redirect", async () => {
  const r = await PH.run(PAGE, { cookies: {}, searchParams: Promise.resolve({ q: "thing", page: "50" }) });
  eq(r.redirect, "/search?q=thing", "6 results, page 50 -> page 1:");
  const n = await PH.run(PAGE, { cookies: {}, searchParams: Promise.resolve({ q: "thing", type: "Nope", page: "3" }) });
  ok(!n.redirect && n.text.includes("No products match these filters."), "no results: the empty state");
});

await t("a signed-in shopper and support see exactly what anonymous sees (props and text)", async () => {
  const S = await import("../lib/platform/sessions.js");
  const K = await import("../lib/customers.js");
  const { runDueJobs } = await import("../lib/platform/worker.js");
  const { db: tdb } = await import("../lib/db.js");
  const sup = await I.createUser({ email: "support@sf.test", name: "Sam", password: "support-pass-facets" });
  await I.addMembership(sup.id, A.id, "support");
  const supportCookie = (await S.createSession({ userId: sup.id, kind: "merchant", ttlMs: 600_000 })).token;
  const shopperToken = await A.run(async () => {
    await K.requestOtp("shopper@sf.test");
    await runDueJobs({ limit: 10 }).catch(() => {});
    const row = await tdb.selectFrom("notifications").select(["subject"]).where("type", "=", "customer_otp").orderBy("created_at", "desc").executeTakeFirst();
    return (await K.verifyOtp("shopper@sf.test", /(\d{6})/.exec(row.subject)[1])).token;
  });
  ok(await A.run(() => K.customerFromToken(shopperToken)), "the shopper session is real");
  const sp = { q: "thing", type: ["Tee", "Hoodie"], o: "size:M", sort: "price-asc" };
  const as = async (cookies) => {
    const r = await PH.run(PAGE, { cookies, searchParams: Promise.resolve(sp) });
    ok(!r.error, String(r.error?.stack || r.error).slice(0, 300));
    return JSON.stringify(r.props) + "\n" + r.text;
  };
  const anon = await as({});
  eq(await as({ _customer: shopperToken }), anon, "shopper:");
  eq(await as({ _admin: supportCookie }), anon, "support:");
});

await t("element ids in the rail come from the group's position, never an option name", async () => {
  const src = await readFile(join(ROOT, "components/search/FacetRail.js"), "utf8");
  ok(!/id=\{`[^`]*\$\{g\.key\}/.test(src) && /facet-\$\{i\}/.test(src), "ids by index");
});

await t("metadata: a filtered search is noindex; a plain query page is not", async () => {
  const mod = await PH.load(PAGE);
  eq((await mod.generateMetadata({ searchParams: Promise.resolve({ q: "tee", type: "Tee" }) })).robots, { index: false, follow: true });
  eq((await mod.generateMetadata({ searchParams: Promise.resolve({ q: "tee" }) })).robots, undefined);
});

await t("edge safety: everything the search page imports (walked from it) uses no node:* module (tenant-context's async_hooks, which the edge runtime has, is the only one reached)", async () => {
  const seen = new Set();
  const hits = new Set();
  const walk = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = await readFile(file, "utf8");
    for (const [, m] of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](node:[^"']+)["']/g)) hits.add(`${relative(ROOT, file)}: ${m}`);
    for (const [, spec] of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
      if (spec.startsWith("@/")) await walk(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js")));
      else if (spec.startsWith(".")) await walk(resolve(dirname(file), spec + (/\.\w+$/.test(spec) ? "" : ".js")));
    }
  };
  await walk(join(ROOT, PAGE));
  eq([...hits], ["lib/tenant-context.js: node:async_hooks"], "node imports reached:");
  for (const f of ["lib/catalog/facets.js", "lib/catalog/facet-search.js", "lib/typesense-search.js", "components/search/FacetSheet.js"]) ok(seen.has(join(ROOT, f)), `walked ${f}`);
});

// =============================================================================
realLog("— 5. cost");
// =============================================================================

await t("SQL facets on 5,000 products (two option names, stock, a live overlay table): timed and reported", async () => {
  const C = await F.makeTenant({ name: "sf-big", id: "sfbig", mode: "documents", products: [], config: CONFIG });
  const c = C.client();
  const stmts = [];
  const TYPES = ["Tee", "Hoodie", "Cap", "Jogger", "Sock", "Bag", "Belt", "Scarf"];
  const VENDORS = ["Acme", "Bolt", "Cove", "Dune", "Edge"];
  const SIZES = ["XS", "S", "M", "L", "XL"];
  const COLOURS = ["Red", "Blue", "Black", "Grey"];
  for (let i = 0; i < 5000; i++) {
    const id = `gid://shopify/Product/${100000 + i}`;
    stmts.push({ sql: "INSERT INTO products (id, handle, title, product_type, vendor, tags, price_min, price_max, currency, available, options, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, 'INR', ?, '[]', ?)", args: [id, `big-${i}`, `Big thing ${i}`, TYPES[i % 8], VENDORS[i % 5], 100 + (i % 50) * 20, 100 + (i % 50) * 20, i % 7 ? 1 : 0, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`] });
    for (let k = 0; k < 4; k++) stmts.push({ sql: "INSERT INTO variants (id, product_id, title, price, currency, available, selected_options, position) VALUES (?, ?, 'v', 100, 'INR', ?, ?, ?)", args: [`${id}-v${k}`, id, (i + k) % 3 ? 1 : 0, JSON.stringify([{ name: "Size", value: SIZES[(i + k) % 5] }, { name: "Colour", value: COLOURS[(i + k) % 4] }]), k] });
  }
  await c.batch(stmts, "write");
  c.close();
  const cases = [{}, { q: "thing" }, { type: ["Tee", "Cap"], vendor: "Acme", o: ["size:M", "colour:Red"], instock: "1", min: "200", max: "800" }];
  const times = [];
  for (const sp of cases) {
    await C.run(() => FX.facetSearchDb(P(sp))); // warm the probe
    const runs = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      const r = await C.run(() => FX.facetSearchDb(P(sp)));
      runs.push(performance.now() - t0);
      ok(r.found > 0, `found: ${JSON.stringify(sp)}`);
    }
    times.push(Math.round(Math.min(...runs)));
  }
  realLog(`   SQL facets at 5,000 products (best of 3): no filter ${times[0]} ms, a query ${times[1]} ms, seven filters ${times[2]} ms`);
  await C.cleanup();
});

realLog(`\n${pass} passed, ${fail} failed in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
await F.removeFixtureFiles("sf");
await rm(join(ROOT, ".test-sf-default.db"), { force: true });
process.exit(fail ? 1 : 0);
