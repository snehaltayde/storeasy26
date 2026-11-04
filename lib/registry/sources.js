// P5-SOURCES (TREE-01): the source table. A section's binding names a source;
// this table says what each source is and how its data is read. Pure and
// edge-safe: lib/registry/index.js imports it, and 'use client' editor modules
// import that, so this file reaches the browser. It imports nothing; a
// resolver reads only through the repo and ctx it is handed
// (lib/cms/section-data.js resolveHomeSectionData passes both).
//
//   SOURCES                 name -> { args, resolve, prefetch?, argOf? }
//     args                  the argument names the source reads (documentation
//                           and the shape a binding usually passes)
//     resolve(repo, args, ctx)
//                           the data for one binding (a value or a promise);
//                           undefined means "no data" (nothing set, no log)
//     prefetch(argsList, repo, ctx)
//                           optional: run once per page with the args of every
//                           instance of every source sharing this prefetch,
//                           before any resolve; its result reaches resolve
//                           through ctx.prefetched(prefetch)
//     argOf(settingValue)   optional: turns a registry section's setting value
//                           into the argument the source reads
//   getSource(name)         the entry, or null
//   defineSource(decl)      test seam: add a source ({ name, resolve, ... })
//   removeSource(name)      test seam: take one out again
//
// ctx, as resolveHomeSectionData builds it:
//   curated, curatedError   the one curated collections pre-read (or its fault)
//   pinsByHandle, pinsError the one rail pins pre-read (or its fault)
//   documents               a documents store: never read collection_overrides
//   prefetched(fn)          the promise of that shared prefetch's result
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const NAME_RE = /^[a-z][a-z0-9_]{0,60}$/;

const TABLE = new Map();

// ---- the collection rail ---------------------------------------------------------

// A rail collection's products, in its featured order, and whether that order
// was hand-picked. The home rails show no count (withTotal: false).
//   · a legacy store reads the pins (collection_overrides): the batch pre-read
//     when the repo has one, else one read per rail;
//   · a documents store uses the published pins pre-read (livePinsByHandles),
//     and a repo without it gives every rail no pins.
async function railProducts(repo, ctx, handle, limit) {
  let pins;
  if (ctx.pinsError) throw ctx.pinsError;
  if (ctx.pinsByHandle) pins = ctx.pinsByHandle.get(handle) || [];
  else if (ctx.documents) pins = [];
  else if (typeof repo.collectionPinsByHandle === "function") pins = await repo.collectionPinsByHandle(handle);
  const r = await repo.getProductsInCollection(handle, { limit, sort: "featured", withTotal: false, ...(Array.isArray(pins) ? { pins } : {}) });
  return { list: r?.products || [], handPicked: Array.isArray(pins) && pins.length > 0 };
}

// ---- bundles -----------------------------------------------------------------------

// The id or ids an instance's args hold: the first argument other than the
// limit (a bundle binding has one argument, its setting).
const boundValue = (args) => {
  for (const [k, v] of Object.entries(isObj(args) ? args : {})) if (k !== "limit") return v;
  return undefined;
};
const isId = (v) => typeof v === "string" && v.length > 0;
const idsOf = (v) => (Array.isArray(v) ? v.filter(isId) : isId(v) ? [v] : []);

// One read for every bundle on the page: the ids of every bundle_by_id and
// bundles_by_ids instance, deduped, in one repo.bundlesByIds call. No ids, no
// read. A fault rejects, and every bundle instance then fails (bindingFailed).
async function prefetchBundles(argsList, repo) {
  const ids = [...new Set(argsList.flatMap((a) => idsOf(boundValue(a))))];
  const byId = new Map();
  if (!ids.length) return byId;
  if (typeof repo.bundlesByIds !== "function") throw new Error("bundles can't be read here");
  const rows = await repo.bundlesByIds(ids);
  const list = rows instanceof Map ? [...rows.values()] : Array.isArray(rows) ? rows : [];
  for (const row of list) if (isObj(row) && isId(row.id)) byId.set(row.id, row);
  return byId;
}

// ---- the table -----------------------------------------------------------------------

const BUILT_IN = [
  {
    name: "featured_collections",
    args: ["limit"],
    // the curated list sliced per instance, else the store's featured ones; a
    // failed curated read is never replaced by the uncurated list
    resolve: (repo, args, ctx) => {
      if (ctx.curatedError) return Promise.reject(ctx.curatedError);
      return ctx.curated?.length ? Promise.resolve(ctx.curated.slice(0, args.limit)) : repo.getFeaturedCollections(args.limit);
    },
  },
  {
    name: "newest_products",
    args: ["limit"],
    resolve: (repo, args) => repo.getNewestProducts(args.limit),
  },
  {
    name: "collection_products",
    args: ["collection", "limit"],
    // S55: a product rail bound to ONE collection (featured/pinned order)
    resolve: (repo, args, ctx) => (args.collection ? railProducts(repo, ctx, args.collection, args.limit) : Promise.resolve({ list: [], handPicked: false })),
    // a registry collection setting is { handle, id }: the rail takes its handle
    argOf: (v) => (isObj(v) ? (typeof v.handle === "string" ? v.handle : undefined) : v),
  },
  {
    name: "route_product",
    args: [],
    // the product page's own product: known, but the home page has no data for it
    resolve: () => Promise.resolve(undefined),
  },
  {
    name: "bundle_by_id",
    args: ["bundle"],
    prefetch: prefetchBundles,
    // the entry, or undefined when the read has no such bundle (the component
    // treats that as missing)
    resolve: async (repo, args, ctx) => {
      const byId = await ctx.prefetched(prefetchBundles);
      const id = boundValue(args);
      return isId(id) ? byId.get(id) : undefined;
    },
    argOf: (v) => (isObj(v) ? (isId(v.id) ? v.id : undefined) : v),
  },
  {
    name: "bundles_by_ids",
    args: ["bundles"],
    prefetch: prefetchBundles,
    // every picked bundle, in the picked order; one the read has not got is
    // { id, state: "missing" }
    resolve: async (repo, args, ctx) => {
      const byId = await ctx.prefetched(prefetchBundles);
      return idsOf(boundValue(args)).map((id) => byId.get(id) ?? { id, state: "missing" });
    },
    argOf: (v) => (Array.isArray(v) ? v.map((x) => (isObj(x) && isId(x.id) ? x.id : null)).filter(isId) : v),
  },
];

function freezeSource(decl) {
  if (!isObj(decl) || !NAME_RE.test(String(decl.name || ""))) throw new Error("defineSource: a source needs a name of lower-case letters, digits and _");
  const where = `source "${decl.name}"`;
  if (typeof decl.resolve !== "function") throw new Error(`${where}: resolve must be a function`);
  for (const fn of ["prefetch", "argOf"]) if (decl[fn] != null && typeof decl[fn] !== "function") throw new Error(`${where}: ${fn} must be a function`);
  const args = decl.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string" && a)) throw new Error(`${where}: args must be a list of names`);
  return Object.freeze({
    name: decl.name,
    args: Object.freeze([...args]),
    resolve: decl.resolve,
    ...(decl.prefetch ? { prefetch: decl.prefetch } : {}),
    ...(decl.argOf ? { argOf: decl.argOf } : {}),
  });
}

for (const decl of BUILT_IN) TABLE.set(decl.name, freezeSource(decl));

// The table: SOURCES.<name>, and `name in SOURCES`. Only defineSource and
// removeSource change it.
export const SOURCES = Object.create(null);
for (const [name, d] of TABLE) SOURCES[name] = d;

export const getSource = (name) => (typeof name === "string" && TABLE.get(name)) || null;
export const isSource = (name) => typeof name === "string" && TABLE.has(name);
export const sourceNames = () => [...TABLE.keys()];

// Test seams.
export function defineSource(decl) {
  const d = freezeSource(decl);
  if (TABLE.has(d.name)) throw new Error(`source "${d.name}" is already in the table`);
  TABLE.set(d.name, d);
  SOURCES[d.name] = d;
  return d;
}
export function removeSource(name) {
  delete SOURCES[name];
  return TABLE.delete(name);
}
