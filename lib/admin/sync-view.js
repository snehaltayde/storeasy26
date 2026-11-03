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

const n = (x) => Number(x || 0).toLocaleString("en-IN");
const plural = (x, one, many) => `${n(x)} ${Number(x) === 1 ? one : many}`;

function ago(iso, nowMs) {
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
    products: {
      done: Number(run?.products_fetched || 0),
      total: run?.products_total == null ? null : Number(run.products_total),
    },
    collections: { done: Number(run?.collections_fetched || 0) },
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
      collections: { done: Number(run.collections || 0) },
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
