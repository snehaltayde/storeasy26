// What the founder sees about bringing products in from Shopify (GEN-02).
// Pure: no imports, so the sync engine, the console routes, server pages and
// the client card all read a run the same way. Every word here is founder
// copy: plain, no internal names, no error codes.

// A running sync with no progress and no live runner for this long reads as
// stalled. Longer than the worst queue backoff (about 10 minutes) plus a late
// tick, so a sync that is merely waiting its turn never shows as stuck.
export const STALL_MS = 30 * 60_000;

const ms = (iso) => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : null;
};

// none | running | retrying | stalled | failed | complete
export function runState(run, nowMs = Date.now()) {
  if (!run) return "none";
  if (run.status === "complete") return "complete";
  if (run.status === "failed") return "failed";
  const leaseUntil = ms(run.lease_until);
  const leased = run.lease_owner && leaseUntil != null && leaseUntil > nowMs;
  const last = ms(run.updated_at) ?? ms(run.started_at) ?? 0;
  if (!leased && nowMs - last > STALL_MS) return "stalled";
  return run.error ? "retrying" : "running";
}

export const ACTIVE_STATES = new Set(["running", "retrying", "stalled"]);

// Shopify's HTTP status inside a raw error, when it has one ("Admin GraphQL
// HTTP 503: …", "Shopify HTTP 401: …", "client-credentials grant failed (403):
// …"). The status decides over words in the response body.
export function httpStatusOf(raw) {
  const m = /\bHTTP (\d{3})\b|\((\d{3})\):/.exec(String(raw || ""));
  return m ? Number(m[1] || m[2]) : null;
}

const NO_ANSWER = "Shopify didn't answer. This usually clears up on its own. Try again in a few minutes.";
const SLOW_DOWN = "Shopify asked us to slow down. Try again in a few minutes.";

// Raw error text (from Shopify, the network or the database) → one plain
// sentence or two the founder can act on. Never shows the raw text.
export function plainSyncError(raw) {
  const m = String(raw || "").toLowerCase();
  if (/source changed/.test(m)) return "Your Shopify link changed partway through. Try again to start a fresh copy.";
  if (/no shopify credentials|no shopify_admin_token|client_id\/secret not set|store domain is not configured|no storefront token|no shopify store domain/.test(m))
    return "Storeasy isn't linked to your Shopify store. Contact support to link it, then try again.";
  // a 5xx or 429 is Shopify's own trouble, whatever its body says
  const status = httpStatusOf(raw);
  if (status != null && status >= 500) return NO_ANSWER;
  if (status === 429) return SLOW_DOWN;
  if (/access_denied|access denied|scope/.test(m))
    return "Storeasy is missing a permission in your Shopify store. Contact support to link it again with every permission, then try again.";
  if (/\b(401|403)\b|invalid api key|access token|unauthori[sz]ed|forbidden/.test(m))
    return "Shopify stopped letting Storeasy into your store. Contact support to link it again, then try again.";
  if (/\b(402|423)\b|payment required|locked/.test(m)) return "Shopify says your store is paused or locked. Check your Shopify plan, then try again.";
  if (/\b404\b|not found/.test(m)) return "Shopify couldn't find your store. Contact support to check the store address, then try again.";
  if (/throttl|\b429\b|rate limit/.test(m)) return SLOW_DOWN;
  if (/\b5\d\d\b|fetch failed|network|timed? ?out|aborted|econnreset|socket|non-json|connection/.test(m)) return NO_ANSWER;
  return "Something went wrong while bringing in your products. Try again. If it keeps happening, contact support.";
}

// ---- Phase 1 line 5: stage, time, problem kind, skips --------------------------

// The four stages a running import goes through, in the founder's words.
export const SYNC_STAGES = Object.freeze([
  { id: "products", label: "Bringing in products" },
  { id: "collections", label: "Bringing in collections" },
  { id: "prune", label: "Tidying up" },
  { id: "index", label: "Getting search ready" },
]);
const STAGE_OF_PHASE = { products: "products", collections: "collections", members: "collections", prune: "prune", index: "index" };

export function stageOf(phase) {
  const id = STAGE_OF_PHASE[phase];
  const i = SYNC_STAGES.findIndex((s) => s.id === id);
  return i < 0 ? null : { id, label: SYNC_STAGES[i].label, index: i + 1, of: SYNC_STAGES.length };
}

export const SYNC_WORDS = Object.freeze({
  big: "Big catalogs take a while. You can close this page, it keeps going.",
  kept: "Your store keeps everything already brought in.",
  keptRefresh: "Your store keeps everything it had, plus what came in.",
});

// A catalog this big gets the "you can close this page" line.
export const BIG_CATALOG = 1000;

// Time words. `durationWords(6 * 60_000)` → "6 minutes"; under a minute →
// "less than a minute".
export function durationWords(msLen) {
  if (!Number.isFinite(msLen) || msLen < 0) return null;
  const mins = Math.round(msLen / 60_000);
  if (mins < 1) return "less than a minute";
  if (mins < 60) return mins === 1 ? "1 minute" : `${mins} minutes`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "about an hour" : `about ${hours} hours`;
}

// "About N minutes left", rounded so it never reads more exact than it is.
export function etaWords(msLeft) {
  if (!Number.isFinite(msLeft) || msLeft < 0) return null;
  const mins = msLeft / 60_000;
  if (mins < 2.5) return "About a minute or two left";
  if (mins < 10) return `About ${Math.round(mins)} minutes left`;
  if (mins < 55) return `About ${Math.round(mins / 5) * 5} minutes left`;
  if (mins < 90) return "About an hour left";
  return `About ${Math.round(mins / 60)} hours left`;
}

// When the time left is shown: only while products come in, with Shopify's
// exact total, at least a minute and two pages in, and never while retrying
// (the rate then includes the wait).
export const ETA_MIN_MS = 60_000;
export const ETA_MIN_PAGES = 2;
function etaOf(run, state, nowMs) {
  if (state !== "running" || run.phase !== "products") return null;
  const total = run.products_total == null ? null : Number(run.products_total);
  const done = Number(run.products_fetched || 0);
  const started = ms(run.started_at);
  if (!total || total <= 0 || started == null || done <= 0 || done >= total) return null;
  const elapsed = nowMs - started;
  if (elapsed < ETA_MIN_MS || Number(run.pages_done || 0) < ETA_MIN_PAGES) return null;
  const left = ((total - done) * elapsed) / done;
  return { ms: Math.round(left), words: etaWords(left) };
}

// What kind of trouble a raw error is: reconnect | busy | shop | unknown.
// The HTTP status decides over words in the body, as in plainSyncError.
export function problemKind(raw) {
  const m = String(raw || "").toLowerCase();
  if (/source changed/.test(m)) return "unknown";
  if (/no shopify credentials|no shopify_admin_token|client_id\/secret not set|store domain is not configured|no storefront token|no shopify store domain/.test(m)) return "reconnect";
  const status = httpStatusOf(raw);
  if (status != null) {
    if (status === 429 || status >= 500) return "busy";
    if ([401, 403, 404].includes(status)) return "reconnect";
    if ([402, 423].includes(status)) return "shop";
  }
  if (/access_denied|access denied|scope|\b(401|403)\b|invalid api key|access token|unauthori[sz]ed|forbidden|\b404\b|not found/.test(m)) return "reconnect";
  if (/\b(402|423)\b|payment required|locked/.test(m)) return "shop";
  if (/throttl|\b429\b|rate limit|\b5\d\d\b|fetch failed|network|timed? ?out|aborted|econnreset|socket|non-json|connection/.test(m)) return "busy";
  return "unknown";
}

const RECONNECT_WORDS = (m) => {
  if (/no shopify credentials|no shopify_admin_token|client_id\/secret not set|store domain is not configured|no storefront token|no shopify store domain/.test(m))
    return "Storeasy isn't linked to your Shopify store. Reconnect Shopify, then try again.";
  if (/access_denied|access denied|scope/.test(m)) return "Storeasy is missing a permission in your Shopify store. Reconnect Shopify to give it every permission, then try again.";
  if (/\b404\b|not found/.test(m) && !/\b(401|403)\b/.test(m)) return "Shopify couldn't find your store. Reconnect Shopify to check the store address, then try again.";
  return "Shopify stopped letting Storeasy into your store. Reconnect Shopify, then try again.";
};

const RETRY = { id: "retry", label: "Try again" };

// What went wrong and what the founder can do, for a run that needs them:
// failed, stalled or retrying. → { kind, words, next: [{ id, label }] } or
// null. `next[0]` is the main action; "reconnect" selects step 1.
export function syncProblem(run, state) {
  if (!run || !["failed", "stalled", "retrying"].includes(state)) return null;
  if (state === "stalled") return { kind: "stopped", words: "It stopped before finishing. Try again picks up where it left off.", next: [RETRY] };
  const kind = problemKind(run.error);
  const m = String(run.error || "").toLowerCase();
  if (state === "retrying") {
    const words = kind === "busy" ? "Shopify is busy. We'll try again by itself." : "We hit a snag. We'll try again by itself.";
    return { kind, words, next: [{ id: "retry", label: "Try now" }] };
  }
  if (kind === "reconnect") return { kind, words: RECONNECT_WORDS(m), next: [{ id: "reconnect", label: "Reconnect Shopify" }, RETRY] };
  if (kind === "busy") return { kind, words: "Shopify is busy right now. Try again in a few minutes.", next: [RETRY] };
  if (kind === "shop") return { kind, words: "Shopify says your store is paused or locked. Check your Shopify plan, then try again.", next: [RETRY] };
  return { kind, words: "Something went wrong while bringing in your products. Try again. If it keeps happening, contact support.", next: [RETRY] };
}

// The products and collections a run skipped: at most 20 listed, the rest
// counted. Each says what it is, why, and what to do; never its id.
export const SKIPPED_SHOWN = 20;
export const SKIP_REASONS = Object.freeze({
  no_title: { why: "It has no title in Shopify.", todo: "Give it a title in Shopify, then refresh from Shopify." },
  no_handle: { why: "It has no web address (handle) in Shopify.", todo: "Give it a web address in Shopify, then refresh from Shopify." },
  duplicate_handle: { why: "It shares a web address with another product.", todo: "Give one of them a different web address in Shopify, then refresh from Shopify." },
  unreadable: { why: "Shopify sent something Storeasy couldn't read.", todo: "Refresh from Shopify. If it keeps happening, contact support." },
  wont_save: { why: "Storeasy couldn't save it.", todo: "Refresh from Shopify. If it keeps happening, contact support." },
});
const SKIP_WORDS = SKIP_REASONS;
export const KEPT_WORDS = "Your store keeps its last good copy.";
function skippedOf(run) {
  const count = Number(run?.skipped_count || 0);
  if (!count) return { count: 0, products: 0, items: [], more: 0 };
  let list = [];
  try {
    const parsed = JSON.parse(run.skipped || "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  const items = list.slice(0, SKIPPED_SHOWN).map((s) => {
    const w = SKIP_WORDS[s?.reason] || SKIP_WORDS.unreadable;
    const type = s?.type === "collection" ? "collection" : "product";
    const name = (typeof s?.title === "string" && s.title.trim()) || (typeof s?.handle === "string" && s.handle.trim()) || (type === "collection" ? "A collection without a name" : "A product without a name");
    return { type, name: name.slice(0, 120), reason: SKIP_WORDS[s?.reason] ? s.reason : "unreadable", why: w.why, todo: w.todo, kept: s?.kept === true };
  });
  return { count, products: list.filter((s) => s?.type !== "collection").length, items, more: Math.max(0, count - items.length) };
}

// Skips per type, for progress. While products come in every skip is a
// product (exact); later the stored list (at most 50) is split by type.
function skippedByType(run) {
  const count = Number(run?.skipped_count || 0);
  if (!count) return { products: 0, collections: 0 };
  if (run.phase === "products") return { products: count, collections: 0 };
  let list = [];
  try {
    const parsed = JSON.parse(run.skipped || "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    list = [];
  }
  const collections = list.filter((x) => x?.type === "collection").length;
  return { products: Math.max(0, count - collections), collections };
}

export const SKIPPED_WORDS = (sk) => {
  const prod = sk.products === sk.count;
  const what = prod ? (sk.count === 1 ? "product" : "products") : sk.count === 1 ? "item" : "items";
  return `${Number(sk.count).toLocaleString("en-IN")} ${what} couldn't come in`;
};

const n = (x) => Number(x || 0).toLocaleString("en-IN");
const plural = (x, one, many) => `${n(x)} ${Number(x) === 1 ? one : many}`;

function spanMs(run) {
  const a = ms(run?.started_at);
  const b = ms(run?.finished_at);
  return a != null && b != null && b >= a ? b - a : null;
}

export function ago(iso, nowMs = Date.now()) {
  const t = ms(iso);
  if (t == null) return null;
  const mins = Math.round((nowMs - t) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

function soFar(run) {
  const done = Number(run.products_fetched || 0);
  const total = run.products_total == null ? null : Number(run.products_total);
  if (total != null && total > 0) return `${n(Math.min(done, total))} of ${n(total)} products so far.`;
  return `${plural(done, "product", "products")} so far.`;
}

// The view the console renders. `hasComplete`: some earlier run finished, so
// this is not the store's first sync (a refresh: calmer words, and the card
// warns instead of alarming). `retryAt`: when the queue will try a retrying
// sync again, if the caller knows it. `linked`: false when the store has no
// Shopify link, so nothing offers a start that can only fail.
export function syncView(run, { hasComplete = false, nowMs = Date.now(), retryAt = null, linked = true } = {}) {
  const state = runState(run, nowMs);
  const refresh = hasComplete;
  const base = {
    state,
    firstSync: !hasComplete,
    linked: linked !== false,
    runId: run?.id ?? null,
    phase: run?.phase ?? null,
    // `skipped`: read but not brought in, so done + skipped reaches the total
    products: {
      done: Number(run?.products_fetched || 0),
      total: run?.products_total == null ? null : Number(run.products_total),
      skipped: skippedByType(run).products,
    },
    collections: {
      done: Number(run?.collections_fetched || 0),
      total: run?.collections_total == null ? null : Number(run.collections_total),
      skipped: skippedByType(run).collections,
    },
    stage: state === "none" || state === "complete" ? null : stageOf(run?.phase),
    elapsedMs: ACTIVE_STATES.has(state) && ms(run?.started_at) != null ? Math.max(0, nowMs - ms(run.started_at)) : null,
    durationMs: state === "complete" || state === "failed" ? spanMs(run) : null,
    eta: run && state !== "none" && state !== "complete" ? etaOf(run, state, nowMs) : null,
    problem: syncProblem(run, state),
    skipped: skippedOf(run),
    big: (state === "running" || state === "retrying") && (run?.phase === "products" || !run?.phase) && Math.max(Number(run?.products_total || 0), Number(run?.products_fetched || 0)) > BIG_CATALOG,
    startedAt: run?.started_at ?? null,
    finishedAt: run?.finished_at ?? null,
    retryAt: state === "retrying" ? retryAt : null,
    message: null,
    canRetry: state === "failed" || state === "stalled" || state === "retrying",
    canStart: (state === "none" || state === "complete") && linked !== false,
  };

  if (state === "none") {
    return {
      ...base,
      headline: "Your products aren't in yet",
      detail:
        linked === false
          ? "Storeasy isn't linked to your Shopify store yet. Contact support to link it."
          : "Bring in your products and collections from Shopify. It takes a few minutes for most stores.",
    };
  }
  if (state === "complete") {
    const when = ago(run.finished_at, nowMs);
    return {
      ...base,
      products: { done: Number(run.products || 0), total: null },
      collections: { done: Number(run.collections || 0), total: null },
      headline: "Your products are in",
      detail: `${plural(run.products, "product", "products")} and ${plural(run.collections, "collection", "collections")}${when ? `, brought in ${when}` : ""}.`,
    };
  }

  let progress;
  const collecting = run.phase === "collections" || run.phase === "members";
  if (collecting) {
    progress = `All ${plural(run.products_fetched, "product is", "products are")} in. ${plural(run.collections_fetched, "collection", "collections")} so far.`;
  } else if (run.phase === "prune" || run.phase === "index") {
    progress = `${plural(run.products_fetched, "product", "products")} and ${plural(run.collections_fetched, "collection", "collections")} are in. Tidying up and getting search ready.`;
  } else {
    progress = soFar(run);
  }

  if (state === "running") {
    const headline = collecting
        ? "Bringing in your collections"
        : run.phase === "prune" || run.phase === "index"
          ? "Finishing up"
          : refresh
            ? "Refreshing your products from Shopify"
            : "Bringing in your products from Shopify";
    return {
      ...base,
      headline,
      detail: `${progress} Big stores can take a while. You can keep using the console.`,
    };
  }
  // True since review fix round 1: a run adds what it reads and removes
  // nothing (products, or a collection's members) until it has read it all.
  const kept = refresh ? "Your store keeps everything it had, plus what came in." : "Your store keeps everything already brought in.";
  if (state === "retrying") {
    return {
      ...base,
      headline: "We hit a snag and will try again",
      message: plainSyncError(run.error),
      detail: `${progress} ${kept} We'll try again by itself, or you can try now.`,
    };
  }
  if (state === "stalled") {
    return {
      ...base,
      headline: refresh ? "Refreshing your products stopped partway" : "Bringing in your products stopped partway",
      message: "It stopped before finishing. Try again to pick up where it left off.",
      detail: `${progress} ${kept}`,
    };
  }
  // failed
  return {
    ...base,
    headline: refresh ? "The latest refresh from Shopify didn't finish" : "Your products didn't finish coming in",
    message: plainSyncError(run.error),
    detail: `${run.phase ? progress : ""} ${kept}`.trim(),
  };
}
