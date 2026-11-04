// Per-instance section data resolution (S54 / audit slice 2). The homepage
// used to fetch data once per KIND into a shared slot (data.collections /
// data.products) — duplicate sections overwrote each other and the last
// instance's `limit` won for all of them. Data now resolves PER INSTANCE ID,
// driven by the registry's declared bindings, with identical queries batched
// (two "newest products" sections with the same limit share one query; one
// curated-collections read serves every collections section, sliced per
// instance).
//
// Node-safe and injectable (`repo` override) so the suite proves instance
// independence and batching without a browser.
//
// P2-SECTIONS: sections come in two shapes. The old flat home section
// ({ id, kind, title, limit, collection }) still works as before. A registry
// section ({ id, kind, settings }), what the home page renders from now, is
// read through the new registry's declaration (lib/registry): its bindings,
// and its settings' defaults. Keys: legacyKey (an old id-less section's
// "i-<n>"), else the id, else "i-<index>".
//
// Product rails and the founder's pinned order (collection_overrides):
//   · a legacy store reads the pins as it always has (one read per rail
//     collection), and the rail says whether its order is hand-picked;
//   · a documents store (documents: true, a v4 release or its preview) never
//     reads collection_overrides. P4-OVL07 (ED-12): its rails use the pins
//     the founder published for that collection (collection_content_live,
//     one read for every rail, lib/catalog/effective.js livePinsByHandles),
//     and a collection with none keeps its own order. A preview's unpublished
//     pins show on the collection's own page only, never on the home rails.
//
// P3-VALIDATE (PV-02): one failing catalog read never rejects the whole page.
// Each binding settles on its own: a read that throws (the curated
// collections, a rail's pins, a source query) leaves that binding out of the
// section's data and lists it in data.bindingFailed, with a log line
// (section_binding_failed). The renderer map (components/sections/index.js)
// then leaves that section out for shoppers and shows a note in the
// founder's preview; every other section gets its data as before. A failed
// curated read or pins read is never replaced by a guess (the uncurated
// collections, the unpinned order): the sections that needed it fail instead.
//
// P5-SOURCES (TREE-01): what each source reads lives in one table,
// lib/registry/sources.js (SOURCES). run() looks the binding's source up
// there; a source the table does not hold (one removed after a kind was
// registered) fails that binding with cause "source_unknown", the other
// failures with cause "fault". The failing field's cause is also in
// data.bindingFailedCause ({ [field]: cause }, not enumerable, so the data's
// JSON is what it was). A source with a prefetch (the bundles) runs it once,
// with the args of every instance that uses it, before any section resolves.
import { componentFor } from "./registry.js";
import { slog } from "../log.js";
import { sectionType } from "../registry/index.js";
import { getSource } from "../registry/sources.js";
import { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandle, collectionPinsByHandles } from "../repo.js";
import { livePinsByHandles } from "../catalog/effective.js";

// Whether this request is the founder's preview (P3-VALIDATE): the request's
// content source (lib/content/resolve.js contentSource, cached per request),
// read inside the request's store (tfetch). The renderer map asks only when a
// section has failed, so these modules load only then: a plain import here
// would pull next/headers into everything that imports the map. Any doubt
// answers false, the shoppers' rule (leave the section out).
export async function isPreviewRequest() {
  try {
    const [{ contentSource }, { tfetch }] = await Promise.all([import("../content/resolve.js"), import("../tenant-request.js")]);
    return Boolean((await tfetch(() => contentSource()))?.preview);
  } catch {
    return false;
  }
}

const DEFAULT_REPO = { getFeaturedCollections, getCollectionsByHandles, getNewestProducts, getProductsInCollection, collectionPinsByHandle, collectionPinsByHandles, livePinsByHandles };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isRegistry = (s) => isObj(s) && isObj(s.settings);

// What a section binds to: { field: { source, args } } and the defaults to
// fill a missing argument with.
function declarationOf(s) {
  if (isRegistry(s)) {
    const d = sectionType(s.kind);
    if (!d) return null;
    const bindings = {};
    for (const [field, b] of Object.entries(d.bindings || {})) bindings[field] = { source: Array.isArray(b.sources) ? b.sources[0] : b.source, args: b.args || [] };
    const defaults = Object.fromEntries(d.settings.filter((x) => x.default !== undefined).map((x) => [x.key, x.default]));
    return { bindings, defaults };
  }
  return componentFor(s?.kind);
}

// A section's own value for a binding argument. A registry section's setting
// goes through its source's argOf (a collection { handle, id } gives the rail
// its handle; a bundle { id } its id).
function argOf(s, key, source) {
  if (!isRegistry(s)) return s[key];
  const v = s.settings[key];
  const of = getSource(source)?.argOf;
  return of && key !== "limit" ? of(v) : v;
}

// sections: the RENDER list (enabled, known kinds, ids present or absent —
// legacy live snapshots may be id-less; we key those by index).
// index: resolvedCollectionsIndex() (curated featured handles) or null.
// documents: true on a documents store (v4): no collection_overrides read;
//   the published pins instead (repo.livePinsByHandles; a repo without it,
//   such as a test's fake, gives every rail no pins).
// → Map<instanceKey, data object per the component's bindings>
//   (a product rail's data also says handPicked: its order was pinned)
export async function resolveHomeSectionData(sections, { index = null, repo = DEFAULT_REPO, documents = false } = {}) {
  const keyOf = (s, i) => s.legacyKey || s.id || `i-${i}`;
  const out = new Map();

  // One curated read serves every collections instance (sliced per limit).
  let curated = null;
  let curatedError = null;
  const needsCurated = sections.some((s) => declarationOf(s)?.bindings?.collections) && index?.featured?.length;
  if (needsCurated) {
    try {
      curated = await repo.getCollectionsByHandles(index.featured);
    } catch (e) {
      curatedError = e;
    }
  }

  // P2-PERF: every rail's pins in one read on a legacy store (one per rail
  // before). A repo without the batch read (tests' fakes) leaves pins to each
  // rail's own read. A documents store reads its published pins in one read
  // (P4-OVL07), and an unfinished section (preview only) needs no data.
  const railHandleOf = (s) => {
    if (isObj(s?.unfinished)) return null;
    const def = declarationOf(s);
    const b = Object.values(def?.bindings || {}).find((x) => x.source === "collection_products");
    return b ? argOf(s, "collection", "collection_products") ?? def.defaults?.collection : null;
  };
  const railHandles = sections.map(railHandleOf).filter((h) => typeof h === "string" && h);
  let pinsByHandle = null;
  let pinsError = null;
  const batchRead = documents ? repo.livePinsByHandles : repo.collectionPinsByHandles;
  if (railHandles.length && typeof batchRead === "function") {
    try {
      pinsByHandle = await batchRead(railHandles);
    } catch (e) {
      pinsError = e;
    }
  }

  // Every binding of every section, with its args, before anything resolves.
  const jobs = [];
  for (const [i, s] of sections.entries()) {
    // P2-PREVIEW: an unfinished section (preview only) renders as the
    // founder's note and needs no data; its settings may not even be valid.
    if (isObj(s?.unfinished)) continue;
    const def = declarationOf(s);
    if (!def) continue;
    const bindings = [];
    for (const [field, binding] of Object.entries(def.bindings || {})) {
      const args = {};
      for (const argKey of binding.args || []) args[argKey] = argOf(s, argKey, binding.source) ?? def.defaults?.[argKey];
      args.limit = Number(args.limit) || def.defaults?.limit || 8;
      bindings.push({ field, source: binding.source, args });
    }
    jobs.push({ key: keyOf(s, i), s, bindings });
  }

  // P5-SOURCES: each shared prefetch runs once, with every instance's args
  // (the bundles: one read for the page). Its result, or its fault, reaches
  // the resolvers through ctx.prefetched.
  const argsByPrefetch = new Map();
  for (const j of jobs) {
    for (const b of j.bindings) {
      const fn = getSource(b.source)?.prefetch;
      if (!fn) continue;
      if (!argsByPrefetch.has(fn)) argsByPrefetch.set(fn, []);
      argsByPrefetch.get(fn).push(b.args);
    }
  }
  const ctx = { curated, curatedError, pinsByHandle, pinsError, documents };
  const prefetched = new Map();
  for (const [fn, argsList] of argsByPrefetch) {
    let p;
    try {
      p = Promise.resolve(fn(argsList, repo, ctx));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch(() => {});
    prefetched.set(fn, p);
  }
  ctx.prefetched = (fn) => prefetched.get(fn) ?? Promise.reject(new Error("this source's prefetch did not run"));

  // Batch identical (source, args) queries.
  const queryCache = new Map();
  const run = (source, args) => {
    const cacheKey = `${source}:${JSON.stringify(args)}`;
    if (!queryCache.has(cacheKey)) {
      const src = getSource(source);
      let p;
      if (!src) {
        const e = new Error(`"${source}" is not in the source table`);
        e.code = "source_unknown";
        p = Promise.reject(e);
      } else {
        try {
          p = Promise.resolve(src.resolve(repo, args, ctx));
        } catch (e) {
          p = Promise.reject(e);
        }
      }
      // a rejection is read by every section that shares the query (below);
      // this keeps it from counting as unhandled in between
      p.catch(() => {});
      queryCache.set(cacheKey, p);
    }
    return queryCache.get(cacheKey);
  };

  for (const { key, s, bindings } of jobs) {
    const data = {};
    for (const { field, source, args } of bindings) {
      let value;
      try {
        value = await run(source, args);
      } catch (e) {
        const cause = e?.code === "source_unknown" ? "source_unknown" : "fault";
        (data.bindingFailed ||= []).push(field);
        if (!Object.hasOwn(data, "bindingFailedCause")) Object.defineProperty(data, "bindingFailedCause", { value: {}, enumerable: false, writable: true, configurable: true });
        data.bindingFailedCause[field] = cause;
        slog("section_binding_failed", { sectionId: s?.id ?? null, kind: s?.kind ?? null, field, source, cause, error: String(e?.message ?? e ?? "").slice(0, 200) });
        continue;
      }
      if (source === "collection_products") {
        data[field] = value.list;
        data.handPicked = value.handPicked;
      } else if (value !== undefined) data[field] = value;
    }
    out.set(key, data);
  }
  return out;
}
