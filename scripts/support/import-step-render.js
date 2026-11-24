// Phase 1 line 5 WP-B: components/admin/onboarding/ImportStep.js's
// ImportStepBody rendered with renderToStaticMarkup for every state, for
// scripts/test-import-step.js (section 7). The component and the real
// components/ui/progress.js (Radix, so the aria attributes are Radix's own)
// are compiled with Next's swc; icons, Button, Skeleton and the step's Gated
// are small stand-ins.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const req = createRequire(join(ROOT, "package.json"));

async function loader() {
  const React = req("react");
  const swc = req("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const h = React.createElement;
  const Icon = () => null;
  const Button = ({ children, variant, size, asChild, ...props }) => h("button", { "data-variant": variant, ...props }, children);
  const stubs = {
    "lucide-react": new Proxy({}, { get: () => Icon }),
    "@/components/ui/button": { Button },
    "@/components/ui/skeleton": { Skeleton: (p) => h("div", { "data-slot": "skeleton", ...p }) },
    "@/components/admin/SyncProgress": { readSync: async () => null, requestSync: async () => ({ ok: false }) },
    // the real Gated's contract (StepPanels.js): allowed → a button; not → disabled with the reason
    "./StepPanels": {
      Gated: ({ action, children, reasonId, ...props }) =>
        !action ? null : action.allowed ? h(Button, props, children) : h("span", { "data-onboarding": "gated" }, h(Button, { ...props, disabled: true, "aria-describedby": reasonId, onClick: undefined }, children), h("span", { id: reasonId, "data-onboarding": "reason" }, action.reason)),
    },
  };
  const cache = new Map();
  const load = (file) => {
    if (cache.has(file)) return cache.get(file).exports;
    const code = swc.transformSync
      ? swc.transformSync(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } }).code
      : null;
    const mod = { exports: {} };
    cache.set(file, mod);
    const local = createRequire(file);
    const resolve = (id) => {
      if (id in stubs) return stubs[id];
      if (id.startsWith("@/")) {
        const path = join(ROOT, id.slice(2) + (/\.\w+$/.test(id) ? "" : ".js"));
        return /\/components\//.test(path) ? load(path) : local(path);
      }
      return local(id);
    };
    new Function("require", "module", "exports", code)(resolve, mod, mod.exports);
    return mod.exports;
  };
  return { load, React };
}

export async function run({ t, ok, eq, V, live, at, scanText }) {
  const { load, React } = await loader();
  const M = load(join(ROOT, "components/admin/onboarding/ImportStep.js"));
  const { renderToStaticMarkup } = req("react-dom/server");
  const html = (props) => renderToStaticMarkup(React.createElement(M.ImportStepBody, props));
  const text = (s) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const START = { id: "start_sync", allowed: true };
  const RETRY = { id: "retry_sync", allowed: true };
  const READ_ONLY = { allowed: false, reason: "Your role can look at this but not change it." };

  await t("UI loading: Skeletons shaped like the content, no lone spinner", async () => {
    const out = html({ view: null });
    ok(out.includes('data-import="loading"') && (out.match(/data-slot="skeleton"/g) || []).length === 3, out);
  });

  await t("UI never run: the headline, the words, 'Bring in products'; support sees it disabled with the reason", async () => {
    const view = V.syncView(null);
    const owner = html({ view, gate: START });
    ok(text(owner).includes("Your products aren't in yet") && /<button[^>]*>Bring in products<\/button>/.test(owner) && !/disabled/.test(owner), owner);
    const sup = html({ view, gate: { ...START, ...READ_ONLY } });
    ok(/<button[^>]*disabled=""[^>]*aria-describedby="import-reason"[^>]*>Bring in products/.test(sup) && text(sup).includes(READ_ONLY.reason), sup);
  });

  await t("UI running with an exact total: the four stages with Products current, a Radix progressbar with aria-valuenow, done of total and the percent, started, time left; aria-live on the headline only", async () => {
    const out = html({ view: V.syncView(live()), gate: null });
    eq((out.match(/aria-live=/g) || []).length, 1, "one aria-live:");
    ok(/aria-live="polite"[^>]*data-import="headline"/.test(out), "on the headline");
    ok(/data-stage="products" data-stage-state="current" aria-current="step"/.test(out) && /data-stage="index" data-stage-state="todo"/.test(out), "stages");
    ok(/role="progressbar"/.test(out) && /aria-valuenow="25"/.test(out), `progressbar: ${out.match(/<div[^>]*role="progressbar"[^>]*>/)?.[0]}`);
    const s = text(out);
    for (const w of ["Bringing in products", "Bringing in collections", "Tidying up", "Getting search ready", "120 of 480 products (25%)", "Started 5 minutes ago.", "About 15 minutes left for products."]) ok(s.includes(w), `${w} in: ${s}`);
    ok(!/<button/.test(out), "no button while running fine");
  });

  await t("UI progress counts skipped products as read: 117 in + 3 skipped of 480 reads 120 of 480 (25%); all read is 100%", async () => {
    const out = html({ view: V.syncView(live({ products_fetched: 117, skipped_count: 3 })) });
    ok(text(out).includes("120 of 480 products (25%)") && /aria-valuenow="25"/.test(out), text(out));
    ok(/aria-valuenow="100"/.test(html({ view: V.syncView(live({ products_fetched: 470, skipped_count: 10, pages_done: 20 })) })), "100%");
  });

  await t("UI running without a total: 'so far', an indeterminate bar with no aria-valuenow, no time left", async () => {
    const out = html({ view: V.syncView(live({ products_total: null })) });
    ok(text(out).includes("120 products so far") && !/aria-valuenow/.test(out) && /data-state="indeterminate"/.test(out) && !text(out).includes("left."), out);
  });

  await t("UI collections stage: products done, collections done of total; members reads the same", async () => {
    for (const phase of ["collections", "members"]) {
      const out = html({ view: V.syncView(live({ phase, collections_fetched: 3, collections_total: 12 })) });
      const s = text(out);
      ok(/data-stage="products" data-stage-state="done"/.test(out) && /data-stage="collections" data-stage-state="current"/.test(out), `${phase} stages`);
      ok(s.includes("120 products, all in") && s.includes("3 of 12 collections (25%)") && /aria-valuenow="25"/.test(out), `${phase}: ${s}`);
    }
  });

  await t("UI big catalog: 'Big catalogs take a while. You can close this page, it keeps going.'", async () => {
    ok(text(html({ view: V.syncView(live({ products_total: 4000, products_fetched: 300 })) })).includes(V.SYNC_WORDS.big), "big words");
    ok(!text(html({ view: V.syncView(live()) })).includes(V.SYNC_WORDS.big), "not for 480");
  });

  await t("UI retrying (Shopify busy): the words, 'Next try at about …', 'Try now'; support's is disabled with the reason", async () => {
    const view = V.syncView(live({ error: "Admin GraphQL HTTP 429: x", lease_owner: null }), { retryAt: new Date(Date.now() + 120_000).toISOString() });
    const out = html({ view, gate: RETRY });
    const s = text(out);
    ok(s.includes("Shopify is busy. We'll try again by itself.") && /Next try at about \d/.test(s) && /<button[^>]*>Try now<\/button>/.test(out), s);
    ok(/disabled=""[^>]*>Try now/.test(html({ view, gate: { ...RETRY, ...READ_ONLY } })), "support disabled");
  });

  await t("UI failed 401: 'Reconnect Shopify' first, then 'Try again'; the store keeps what came in; the header's own problem words are not repeated", async () => {
    const view = V.syncView({ ...live(), status: "failed", finished_at: at(0), error: "Admin GraphQL HTTP 401: x" });
    const out = html({ view, gate: RETRY });
    const order = [...out.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    eq(order, ["Reconnect Shopify", "Try again"], "buttons:");
    ok(/data-import="reconnect"/.test(out) && text(out).includes(V.SYNC_WORDS.kept) && text(out).includes("Reconnect Shopify, then try again."), text(out));
    ok(!text(html({ view, gate: RETRY, showProblem: false })).includes("stopped letting Storeasy"), "showProblem false");
    const sup = html({ view, gate: { ...RETRY, ...READ_ONLY } });
    ok(/<button[^>]*data-import="reconnect"[^>]*>Reconnect Shopify/.test(sup) && !/disabled=""[^>]*data-import="reconnect"/.test(sup) && /disabled=""[^>]*>Try again/.test(sup), "support: Reconnect shown (step 1 gates its own action), Try again disabled");
  });

  await t("UI stalled, shop and unknown: their words and one Try again", async () => {
    const old = at(120);
    for (const [run, words] of [
      [{ ...live(), lease_owner: null, updated_at: old, started_at: old }, "Try again picks up where it left off"],
      [{ ...live(), status: "failed", error: "Admin GraphQL HTTP 402: x" }, "Check your Shopify plan"],
      [{ ...live(), status: "failed", error: "odd" }, "contact support"],
    ]) {
      const out = html({ view: V.syncView(run), gate: RETRY });
      ok(text(out).includes(words) && [...out.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]).join() === "Try again", text(out));
    }
  });

  await t("UI complete: 'N products and M collections, brought in …. Took 6 minutes.', 'Refresh from Shopify', and the skipped list (20 shown, 'and N more', kept copies said)", async () => {
    const list = [{ type: "product", id: "a", handle: "no-title", title: null, reason: "no_title", kept: true }, ...Array.from({ length: 24 }, (_, i) => ({ type: "product", id: `p${i}`, handle: `h${i}`, title: `Shirt ${i}`, reason: "duplicate_handle" }))];
    const view = V.syncView({ status: "complete", products: 30, collections: 2, started_at: at(11), finished_at: at(5), skipped_count: 25, skipped: JSON.stringify(list) }, { hasComplete: true });
    const out = html({ view, gate: START });
    const s = text(out);
    ok(s.includes("30 products and 2 collections, brought in 5 minutes ago. Took 6 minutes."), s);
    ok(s.includes("25 products couldn't come in") && s.includes("and 5 more") && (out.match(/data-skip-reason=/g) || []).length === 20, s);
    ok(s.includes(`no-title It has no title in Shopify. Give it a title in Shopify, then refresh from Shopify. ${V.KEPT_WORDS}`), s);
    ok(/<button[^>]*>Refresh from Shopify<\/button>/.test(out), "refresh");
    ok((out.match(/<li hidden=""/g) || []).length === 15 && /aria-expanded="false" aria-controls="import-skipped-list"[^>]*>Show all 20<\/button>/.test(out), "the first 5 show, the other 15 one 'Show all 20' away");
    ok(!/data-import="skipped"/.test(html({ view: V.syncView({ status: "complete", products: 3, collections: 0, finished_at: at(1) }), gate: START })), "no skips, no list");
  });

  await t("UI lost touch: 'Lost touch, still trying.' only while live", async () => {
    ok(text(html({ view: V.syncView(live()), lost: true })).includes(M.IMPORT_WORDS.lost), "live");
    ok(!text(html({ view: V.syncView({ status: "complete", products: 1, collections: 0, finished_at: at(1) }), lost: true })).includes(M.IMPORT_WORDS.lost), "complete");
  });

  await t("UI words: plain founder copy; polling constants as the plan says", async () => {
    const w = M.IMPORT_WORDS;
    const all = [w.lost, w.start, w.refresh, w.more(3), w.allIn(1), w.allIn(480), w.products(1, null), w.products(3, 9), w.collections(2, null), w.started(240_000), w.started(10_000), w.took(360_000), w.nextTry("3:40 pm"), w.left("About 7 minutes left"), w.showAll(20), w.fewer].join(" ");
    eq(scanText(all), [], "banned copy:");
    eq([M.POLL_MS, M.SLOW_POLL_MS, M.LOST_AFTER], [3000, 15000, 3], "polling:");
  });
}
