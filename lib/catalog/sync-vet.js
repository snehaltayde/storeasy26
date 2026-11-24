// Phase 1 line 5: which products and collections of one Shopify page a sync
// can bring in. Pure (its one import is the pure view module). A node that can't come in is SKIPPED (the
// run carries on and finishes); it never fails the page or the run.
//   vetProducts(nodes)     → { keep, skipped }
//   vetCollections(nodes)  → { keep, skipped }
// skipped: [{ type: "product" | "collection", id, handle, title, reason }]
//
// `wont_save` is not decided here: lib/sync.js gives it to a node whose rows
// the database refused (the constraint fallback).

// The founder's words for each reason (why, and what to do) live with the
// view, which the client reads too.
export { SKIP_REASONS } from "../admin/sync-view.js";

const text = (x) => (typeof x === "string" ? x.trim() : "");
const brief = (x) => (typeof x === "string" ? x.slice(0, 120) : null);

export const skipOf = (type, node, reason) => ({
  type,
  id: typeof node?.id === "string" ? node.id.slice(0, 120) : null,
  handle: brief(node?.handle) || null,
  title: brief(node?.title) || null,
  reason,
});

function vet(type, prefix, nodes) {
  const keep = [];
  const skipped = [];
  const handles = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = typeof node?.id === "string" ? node.id : "";
    let reason = null;
    if (!node || typeof node !== "object" || node.__unreadable || !id.startsWith(prefix) || id.length === prefix.length) reason = "unreadable";
    else if (!text(node.title)) reason = "no_title";
    else if (!text(node.handle)) reason = "no_handle";
    else if (handles.has(node.handle)) reason = "duplicate_handle";
    if (reason) {
      skipped.push(skipOf(type, node, reason));
      continue;
    }
    handles.add(node.handle);
    keep.push(node);
  }
  return { keep, skipped };
}

export const vetProducts = (nodes) => vet("product", "gid://shopify/Product/", nodes);
export const vetCollections = (nodes) => vet("collection", "gid://shopify/Collection/", nodes);

// The run's stored list: deduplicated by id (a later skip of the same node
// wins), at most `max` kept. → { list, count } where count is every distinct
// skip, kept or not.
export const SKIPPED_MAX = 50;
export function mergeSkipped(stored, more, max = SKIPPED_MAX) {
  let list = [];
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (Array.isArray(parsed)) list = parsed.filter((s) => s && typeof s === "object");
  } catch {
    list = [];
  }
  const key = (s) => `${s.type}:${s.id ?? `${s.handle}|${s.title}`}`;
  const seen = new Map(list.map((s) => [key(s), s]));
  let added = 0;
  for (const s of more) {
    if (!seen.has(key(s))) added++;
    seen.set(key(s), s);
  }
  return { list: [...seen.values()].slice(0, max), added };
}
