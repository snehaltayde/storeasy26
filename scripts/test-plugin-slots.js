// Plugin slots: a plugin adds a block to a named storefront slot, rendered
// without running the plugin's own JavaScript (Phase 4 line 2,
// docs/plans/phase-4.md "Line 2").
//   pnpm test:plugin-slots
// 1. The contracts: slots, primitives and their prop checks, manifest blocks,
//    Trust badges' two blocks.
// 2. The placements route as every caller (apps.read reads, apps.manage
//    changes; 401 signed out and for another store's owner), placements made
//    Off on install, slot / state / settings / move, refusals in plain words,
//    the apps.placement audit rows and the "plugins" cache tag.
// 3. The storefront as the anonymous shopper (the least-trusted caller): the
//    real PdpClassic / PdpEditorial, footer and order outlets rendered with
//    Next's own SWC and react-dom/server. Store A's live block shows on A and
//    never on B; Off, install off, uninstalled and the kill switch hide it; a
//    hostile label is escaped; a javascript: link is refused on save and
//    dropped at render; no script, handler, iframe or outside src; the
//    founder's "Turned off" note only in a founder preview; a database one
//    migration behind renders nothing.
// 4. Cost: one placement statement a request (React cache, emulated by
//    support/request-cache.js), and PDP render time before and after the
//    slots on a store with no plugins.
// 5. Edge safety: the transitive import scan from PluginSlot.js, and no
//    "use client" in components/plugins.
import "./support/request-cache.js"; // before any app module that imports react
import { readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = await import("./support/route-harness.js");
const { runRequest, watchStatements } = await import("./support/request-cache.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-pslots-default.db";
process.env.PLATFORM_SECRET = "test-pslots-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "0";
await rm(join(ROOT, ".test-pslots-default.db"), { force: true });
const network = H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack && !e.message ? e.stack : e.message).split("\n").join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  if (got !== want) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

const SL = await import("../lib/plugins/slots.js");
const BL = await import("../lib/plugins/blocks.js");
const M = await import("../lib/plugins/manifest.js");
const CAT = await import("../lib/plugins/catalog.js");
const PL = await import("../lib/plugins/placement.js");
const FLAGS = await import("../lib/platform/flags.js");
const Cache = await import("../lib/cache.js");
const { listAudit } = await import("../lib/platform/audit.js");
const { BADGE_ICONS } = await import("../lib/plugins/first-party/trust-badges/manifest.js");

// --- 1. contracts --------------------------------------------------------------------
await t("slots: the five Phase 4 slots, each with a page, a label and its context fields; slotContext keeps only those", () => {
  eq(SL.SLOT_IDS.join(","), "storefront.pdp.under_price,storefront.pdp.under_atc,storefront.pdp.below_fold,storefront.order.status,storefront.footer.above", "slots:");
  eq(SL.SLOT_MAX_BLOCKS, 3, "max:");
  const product = { id: "gid://p/1", handle: "h", title: "T", price_min: 10, available: true, description_html: "<b>x</b>", variants: [{}] };
  eq(Object.keys(SL.slotContext("storefront.pdp.under_atc", product)).sort().join(","), "available,handle,id,price_min,title", "product context:");
  const order = { id: "ord_1", status: "confirmed", fulfillment_status: null, created_at: "2026-01-01", email: "a@b.c", phone: "999", address: {} };
  eq(Object.keys(SL.slotContext("storefront.order.status", order)).sort().join(","), "created_at,fulfillment_status,id,status", "order context (no contact):");
  eq(Object.keys(SL.slotContext("storefront.footer.above", order)).length, 0, "footer context:");
  eq(Object.keys(SL.slotContext("storefront.nope", product)).length, 0, "unknown slot:");
});

await t("primitives: badge_row and notice; Trust badges' icons are all block icons", () => {
  eq(BL.PRIMITIVE_IDS.join(","), "badge_row,notice", "primitives:");
  ok(BADGE_ICONS.every((i) => BL.BLOCK_ICONS.includes(i)), "icons");
});

await t("validateBlockProps: text cleaned and capped, links storefront-only, icons from the enum, unknown keys dropped, no class or style passthrough", () => {
  const n = BL.validateBlockProps("notice", { title: "Hi\u0000‮ there", text: "Words", link: "/policies/refund-policy", link_label: "Read", className: "x", style: "color:red", onClick: "alert(1)" });
  ok(n.ok, JSON.stringify(n.errors));
  eq(n.props.title, "Hi there", "control characters stripped:");
  eq(Object.keys(n.props).sort().join(","), "link,link_label,text,title", "unknown keys dropped:");
  for (const href of ["javascript:alert(1)", "https://evil.test/", "//evil.test", "/admin", "/products/../admin", " /cart"]) ok(!BL.validateBlockProps("notice", { text: "x", link: href }).ok, `refused ${href}`);
  ok(BL.validateBlockProps("notice", { text: "x".repeat(401) }).errors.text.includes("limit is 400"), "text capped");
  ok(!BL.validateBlockProps("notice", { title: "x" }).ok, "text required");
  const b = BL.validateBlockProps("badge_row", { badges: [{ icon: "truck", label: "<script>alert(1)</script>", extra: 1 }] });
  ok(b.ok, JSON.stringify(b.errors));
  eq(JSON.stringify(b.props.badges), JSON.stringify([{ icon: "truck", label: "<script>alert(1)</script>" }]), "item keys dropped, text kept for React to escape:");
  ok(!BL.validateBlockProps("badge_row", { badges: [{ icon: "rocket", label: "x" }] }).ok, "unknown icon");
  ok(!BL.validateBlockProps("badge_row", { badges: Array.from({ length: 5 }, () => ({ icon: "truck", label: "x" })) }).ok, "five badges");
  ok(!BL.validateBlockProps("badge_row", { badges: [] }).ok, "empty list");
  ok(!BL.validateBlockProps("iframe_widget", {}).ok, "unknown primitive");
  const secret = "neverquoted123";
  ok(!JSON.stringify(BL.validateBlockProps("notice", { text: secret, link: `javascript:${secret}` }).errors).includes(secret), "no refusal quotes a value");
});

await t("manifest blocks: Trust badges declares Badges (badge_row) and Guarantee note (notice) in their slots; bad blocks are refused", () => {
  eq(CAT.checkCatalog().join("\n"), "", "catalog problems:");
  const tb = CAT.pluginById("trust-badges");
  eq(tb.blocks.map((b) => `${b.id}:${b.primitive}:${b.slots.join("|")}`).join(" "), "badges:badge_row:storefront.pdp.under_atc|storefront.pdp.below_fold guarantee:notice:storefront.pdp.below_fold|storefront.footer.above", "blocks:");
  eq(typeof tb.blocks[0].data, "function", "the resolver survives defineManifest:");
  ok(Object.isFrozen(tb.blocks[1].settings), "frozen");
  const base = { id: "x-blocks", name: "X", version: "1.0.0", summary: "s", description: "d", icon: "Puzzle", author: { name: "T" }, scopes: [], settings: [] };
  const bad = (blocks, word) => ok(M.checkManifest({ ...base, blocks }).some((p) => p.includes(word)), `${JSON.stringify(blocks)} → ${word}`);
  bad([{ id: "a", label: "A", primitive: "script_tag", slots: ["storefront.footer.above"] }], "primitive");
  bad([{ id: "a", label: "A", primitive: "notice", slots: ["storefront.header"] }], "slots");
  bad([{ id: "a", label: "A", primitive: "notice", slots: ["storefront.footer.above"], html: "<b>" }], "unknown field");
  bad([{ id: "a", label: "A", primitive: "notice", slots: ["storefront.footer.above"], settings: [{ key: "class_name", kind: "text" }] }], "isn't a prop");
  bad([{ id: "a", label: "A", primitive: "notice", slots: ["storefront.footer.above"], data: "fetch()" }], "function");
  eq(M.checkManifest({ ...base, blocks: [{ id: "a", label: "A", primitive: "notice", slots: ["storefront.footer.above"], settings: [{ key: "text", kind: "text", max: 40 }] }] }).join(","), "", "a good block:");
});

// --- the stores -------------------------------------------------------------------
const store = await H.makeRoleStore({ name: "pslots", a: { products: 2 }, b: { products: 2 } });
const { a, b, call } = store;
const hostB = b.tenant.domains[0];
const MERCHANT = ["owner", "admin", "staff", "support"];
const OPS = ["operator-support", "operator-support-entry"];
const { db } = await import("../lib/db.js");
const firstProduct = (tn) => tn.run(async () => (await import("../lib/repo.js")).getProductByHandle((await db.selectFrom("products").select("handle").orderBy("handle").limit(1).executeTakeFirst()).handle));
const productA = await firstProduct(a);
const productB = await firstProduct(b);
const placementAudit = async () => (await listAudit({ tenantId: a.id, limit: 200 })).filter((r) => r.action === "apps.placement");

// --- the storefront renderer (Next's SWC, as test-commerce-blocks) -----------------------
const require = createRequire(import.meta.url);
const React = require("react");
const { prerenderToNodeStream } = require("react-dom/static");
const { imageConfigDefault } = require("next/dist/shared/lib/image-config.js");
const { ImageConfigContext } = require("next/dist/shared/lib/image-config-context.shared-runtime.js");
const imageConfig = { ...imageConfigDefault, ...((await import(pathToFileURL(join(ROOT, "next.config.mjs")).href)).default.images || {}) };
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (await swc.transform(await readFile(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
// The store a render reads: tfetch (lib/storefront-request.js) resolves it
// from the request host in Next; here the test names it.
let renderStore = a;
const STUBS = {
  "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) },
  "@/lib/storefront-request": { __esModule: true, tfetch: (fn) => renderStore.run(fn) },
  // the founder preview as contentSource answers it (it reads the preview cookie in Next)
  "@/lib/content/resolve": { __esModule: true, contentSource: async () => ({ preview: scope.documentsPreview, v: 4 }) },
};
const seen = new Map();
async function loadJsx(file) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in STUBS || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      let target = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      if (!target.endsWith(".js")) target = existsSync(`${target}.js`) ? `${target}.js` : join(target, "index.js");
      deps.set(id, isJsx(target) ? await loadJsx(target) : await import(pathToFileURL(target).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id in STUBS) return STUBS[id];
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
const SCOPE_KEY = Symbol.for("storeasy.requestScope");
let scope = { storeId: null, documentsPreview: false };
globalThis[SCOPE_KEY] = () => scope;

const { CartProvider } = await loadJsx(join(ROOT, "components/cart/CartContext.js"));
const PluginSlot = (await loadJsx(join(ROOT, "components/plugins/PluginSlot.js"))).default;
const { OFF_NOTE } = await loadJsx(join(ROOT, "components/plugins/PluginSlot.js"));
// the PDP layouts get the real slot through a switch, so the cost test can
// render them once without it (the "before")
let slotImpl = PluginSlot;
STUBS["@/components/plugins/PluginSlot"] = { __esModule: true, default: (props) => React.createElement(slotImpl, props) };
const Pdp = await loadJsx(join(ROOT, "components/pdp/PdpLayouts.js"));

async function html(el, { tn = a, preview = false } = {}) {
  renderStore = tn;
  scope = preview ? { storeId: tn.id, documentsPreview: true } : { storeId: null, documentsPreview: false };
  try {
    return await runRequest(async () => {
      const { prelude } = await prerenderToNodeStream(React.createElement(ImageConfigContext.Provider, { value: imageConfig }, React.createElement(CartProvider, null, el)));
      let out = "";
      for await (const chunk of prelude) out += chunk;
      return out;
    });
  } finally {
    scope = { storeId: null, documentsPreview: false };
  }
}
const pdp = (product, opts = {}, layout = "PdpClassic") => html(React.createElement(Pdp[layout], { product, override: null, extras: [], pairs: null }), opts);
const footer = (opts = {}) => html(React.createElement(PluginSlot, { name: "storefront.footer.above" }), opts);
const blocksIn = (h) => [...h.matchAll(/data-plugin-slot="([^"]+)" data-plugin="([^"]+)" data-block="([^"]+)"/g)].map((m) => `${m[1]}/${m[3]}`);

// --- 4a. the baseline: PDP render time before any slot has something (no plugins) ---
const timeRenders = async (fn, n = 25) => {
  for (let i = 0; i < 3; i++) await fn(); // warm
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    ms.push(performance.now() - t0);
  }
  ms.sort((x, y) => x - y);
  return ms[Math.floor(n / 2)];
};
const NullSlot = () => null;
const realSlot = PluginSlot;
const swapSlot = (impl) => {
  slotImpl = impl;
};

let perf = {};
await t("cost on a store with no plugins: every slot renders nothing, the 3 PDP slots share one placement statement a request, and PDP render time is measured before and after", async () => {
  swapSlot(NullSlot);
  const before = await timeRenders(() => pdp(productA));
  swapSlot(realSlot);
  const after = await timeRenders(() => pdp(productA));
  const h = await pdp(productA);
  eq(blocksIn(h).length, 0, "no blocks:");
  ok(!h.includes("data-plugin-slot-outlet"), "an empty slot renders nothing at all");
  const counted = await a.run(async () => {
    const { currentDatabase } = await import("../lib/db.js");
    const client = currentDatabase().libsql;
    return watchStatements(client, () => runRequest(() => Promise.all(["storefront.pdp.under_price", "storefront.pdp.under_atc", "storefront.pdp.below_fold", "storefront.footer.above"].map((s) => PL.slotBlocks(s, productA)))));
  });
  eq(counted.statements.filter((s) => /plugin_placements/.test(s)).length, 1, `one placement read for four slots (${counted.statements.join(" | ")}):`);
  eq(counted.statements.length, 1, "nothing else:");
  perf = { before: before.toFixed(2), after: after.toFixed(2) };
  console.log(`   PDP render median: ${perf.before} ms without slots, ${perf.after} ms with them (no plugins)`);
  ok(after - before < 10, `the slots add ${(after - before).toFixed(2)} ms`);
});

// --- 2. the placements route --------------------------------------------------------
await t("signed out and another store's owner: 401 on the blocks route", async () => {
  for (const caller of ["signed-out", "owner-b"]) {
    eq((await call(caller, "apps/[id]/blocks", "GET", { params: { id: "pin_0000000000000000" } })).status, 401, `${caller} GET:`);
    eq((await call(caller, "apps/[id]/blocks", "POST", { params: { id: "pin_0000000000000000" }, body: { block: "badges", state: "live" } })).status, 401, `${caller} POST:`);
  }
});

const inst = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
const tbId = inst.body?.install?.id;
const P = (caller, body, opts = {}) => call(caller, "apps/[id]/blocks", body ? "POST" : "GET", { params: { id: tbId }, ...(body ? { body } : {}), ...opts });

await t("install makes one Off placement per block, in its first slot; every role reads them (apps.read)", async () => {
  eq(inst.status, 200, inst.text.slice(0, 200));
  const rows = await a.run(() => db.selectFrom("plugin_placements").selectAll().where("install_id", "=", tbId).orderBy("block_id").execute());
  eq(rows.map((r) => `${r.block_id}:${r.slot}:${r.state}`).join(" "), "badges:storefront.pdp.under_atc:off guarantee:storefront.pdp.below_fold:off", "rows:");
  ok(rows.every((r) => /^ppl_[0-9a-f]{16}$/.test(r.id)), "ppl_ ids");
  eq(JSON.parse(rows[1].settings).title, "Our promise", "default settings:");
  for (const caller of [...MERCHANT, ...OPS]) {
    const r = await P(caller);
    eq(r.status, 200, `${caller}: ${r.text.slice(0, 160)}`);
    eq(Object.keys(r.body).sort().join(","), "blocks,installStatus,ok,previewPaths", `${caller} keys:`);
    eq(r.body.blocks.map((p) => `${p.blockId}:${p.state}`).join(","), "badges:off,guarantee:off", `${caller} blocks:`);
    eq(r.body.previewPaths["storefront.pdp.under_atc"], `/products/${productA.handle}`, `${caller} preview path:`);
    eq(r.body.previewPaths["storefront.order.status"], null, "no order preview:");
  }
  eq((await P("owner", null, { params: { id: "pin_0000000000000000" } })).status, 404, "a missing install:");
});

await t("staff, support and operator support: 403 on every change, and nothing changes", async () => {
  for (const caller of ["staff", "support", ...OPS]) {
    for (const body of [{ block: "badges", state: "live" }, { block: "badges", slot: "storefront.pdp.below_fold" }, { block: "guarantee", settings: { text: "x" } }, { block: "badges", move: "down" }]) {
      eq((await P(caller, body)).status, 403, `${caller} ${JSON.stringify(body)}:`);
    }
  }
  eq((await P("owner")).body.blocks.map((p) => p.state).join(","), "off,off", "still off:");
  eq((await placementAudit()).length, 0, "no audit rows:");
});

await t("refusals in plain words: a slot the block can't use, an unknown block, two changes at once, a repeat", async () => {
  const s = await P("admin", { block: "badges", slot: "storefront.footer.above" });
  eq(s.status, 422, "slot:");
  ok(s.body.error.includes("can't go there"), s.text);
  eq((await P("admin", { block: "nope", state: "live" })).status, 404, "unknown block:");
  eq((await P("admin", { block: "badges", state: "live", slot: "storefront.pdp.below_fold" })).status, 400, "two at once:");
  eq((await P("admin", { block: "badges", state: "off" })).status, 409, "already off:");
  eq((await P("admin", { block: "badges", state: "maybe" })).status, 400, "bad state:");
  eq((await P("admin", {})).status, 400, "no block:");
});

const seenTags = [];
Cache.__setCacheTestHooks({ onInvalidate: (tag) => seenTags.push(tag) });

await t("a javascript: link and an outside link are refused on save, in words that don't quote them; a good link saves", async () => {
  for (const link of ["javascript:alert(1)", "https://evil.test/x"]) {
    const r = await P("owner", { block: "guarantee", settings: { title: "T", text: "Words", link_label: "Read", link } });
    eq(r.status, 422, `${link}:`);
    ok(r.body.errors?.link && !r.text.includes(link), r.text);
  }
  const good = await P("owner", { block: "guarantee", settings: { title: "Our promise", text: "We make it right.", link_label: "Refunds", link: "/policies/refund-policy" } });
  eq(good.status, 200, good.text.slice(0, 200));
  eq(good.body.blocks[1].settings.link, "/policies/refund-policy", "saved:");
  const unknown = await P("owner", { block: "guarantee", settings: { text: "x", style: "color:red" } });
  eq(unknown.status, 422, "an unknown setting:");
});

await t("turn Badges live: shown on store A's PDP (both layouts) to the anonymous shopper, absent on store B's; audited and the cache tag invalidated", async () => {
  seenTags.length = 0;
  const r = await P("owner", { block: "badges", state: "live" });
  eq(r.status, 200, r.text.slice(0, 200));
  ok(seenTags.includes(Cache.tenantTag("plugins", a.id)), `tag: ${seenTags.join(",")}`);
  const rows = await placementAudit();
  eq(rows.length, 2, "rows (settings, live):");
  const d = JSON.parse(rows[0].diff);
  eq(`${d.block}|${d.slot}|${d.state}`, "badges|storefront.pdp.under_atc|live", "diff:");
  eq(rows[0].resource, `app:${tbId}`, "resource:");
  for (const layout of ["PdpClassic", "PdpEditorial"]) {
    const h = await pdp(productA, {}, layout);
    eq(blocksIn(h).join(","), "storefront.pdp.under_atc/badges", `${layout} A:`);
    ok(h.includes("Free shipping") && h.includes("Secure checkout"), `${layout} the badges' words`);
    eq(blocksIn(await pdp(productB, { tn: b }, layout)).length, 0, `${layout} B:`);
  }
  eq(blocksIn(await pdp(productA, { tn: b })).length, 0, "store B never reads A's placement rows, even for A's product:");
});

await t("move to below the details, then order within the slot: Guarantee live too, Move up puts Badges first", async () => {
  eq((await P("owner", { block: "badges", slot: "storefront.pdp.below_fold" })).status, 200, "slot:");
  eq((await P("owner", { block: "guarantee", state: "live" })).status, 200, "guarantee live:");
  let h = await pdp(productA);
  eq(blocksIn(h).join(","), "storefront.pdp.below_fold/guarantee,storefront.pdp.below_fold/badges", "a moved block goes last:");
  const up = await P("owner", { block: "badges", move: "up" });
  eq(up.status, 200, up.text.slice(0, 200));
  ok(up.body.blocks[0].first && up.body.blocks[1].last, "first/last flags");
  h = await pdp(productA);
  eq(blocksIn(h).join(","), "storefront.pdp.below_fold/badges,storefront.pdp.below_fold/guarantee", "moved up:");
  eq((await P("owner", { block: "badges", move: "up" })).status, 409, "already first:");
  ok(h.includes('href="/policies/refund-policy"'), "the store link");
});

await t("the slot markup holds no script, no on* handler, no iframe, no outside src, no style or class from a plugin; a hostile label renders escaped", async () => {
  const hostile = "<script>alert(1)</script><img src=x onerror=alert(1)>";
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { settings: { badges: [{ icon: "truck", label: hostile.slice(0, 40) }] } } })).status, 200, "settings:");
  const h = await pdp(productA);
  const slot = h.slice(h.indexOf("data-plugin-slot-outlet"), h.lastIndexOf("data-block=") + 400);
  ok(slot.length > 100, "a slot");
  ok(!/<script/i.test(slot) && !/<iframe/i.test(slot) && !/\son[a-z]+=/i.test(slot) && !/\ssrc="(?:https?:)?\/\//i.test(slot) && !/style=/i.test(slot), `clean markup: ${slot.slice(0, 600)}`);
  ok(slot.includes("&lt;script&gt;"), "escaped");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { settings: { badges: [{ icon: "truck", label: "Free shipping" }] } } })).status, 200, "restore:");
});

await t("a link that turns bad in the database is dropped at render: the block is skipped and plugin_block_invalid is logged; the page renders", async () => {
  await a.run(() => db.updateTable("plugin_placements").set({ settings: JSON.stringify({ text: "x", link_label: "Go", link: "javascript:alert(1)" }) }).where("install_id", "=", tbId).where("block_id", "=", "guarantee").execute());
  const lines = [];
  const log = console.log;
  console.log = (...x) => lines.push(x.join(" "));
  let h;
  try {
    h = await pdp(productA);
  } finally {
    console.log = log;
  }
  eq(blocksIn(h).join(","), "storefront.pdp.below_fold/badges", "only badges:");
  ok(!h.includes("javascript:"), "no javascript: link");
  ok(lines.some((l) => l.includes("plugin_block_invalid") && l.includes("guarantee")), `logged: ${lines.join(" | ").slice(0, 300)}`);
  await a.run(() => db.updateTable("plugin_placements").set({ settings: JSON.stringify({ title: "Our promise", text: "We make it right." }) }).where("install_id", "=", tbId).where("block_id", "=", "guarantee").execute());
});

await t("a resolver that throws or runs past 300 ms skips its block (the page renders)", async () => {
  const tb = CAT.pluginById("trust-badges");
  const undo = CAT.registerPlugin({
    id: "slow-blocks",
    name: "Slow",
    version: "1.0.0",
    summary: "s",
    description: "d",
    icon: "Puzzle",
    author: { name: "T" },
    scopes: [],
    settings: [],
    blocks: [
      { id: "slow", label: "Slow", primitive: "notice", slots: ["storefront.footer.above"], data: () => new Promise((r) => setTimeout(() => r({ text: "late" }), 600)) },
      { id: "boom", label: "Boom", primitive: "notice", slots: ["storefront.footer.above"], data: () => { throw new Error("boom"); } },
    ],
  });
  try {
    const r = await call("owner", "apps", "POST", { body: { install: { pluginId: "slow-blocks", scopes: [] } } });
    eq(r.status, 200, r.text.slice(0, 200));
    await a.run(() => db.updateTable("plugin_placements").set({ state: "live" }).where("install_id", "=", r.body.install.id).execute());
    const t0 = Date.now();
    const h = await footer();
    ok(Date.now() - t0 < 600, `within the budget (${Date.now() - t0} ms)`);
    ok(!h.includes("late") && !blocksIn(h).length, "both skipped");
    eq((await call("owner", "apps/[id]", "POST", { params: { id: r.body.install.id }, body: { uninstall: true } })).status, 200, "uninstall:");
  } finally {
    undo();
  }
  ok(tb, "trust badges still there");
});

await t("founder preview: an Off block shows with the \"Turned off\" note; the anonymous shopper's HTML never has the note or the Off block", async () => {
  eq((await P("owner", { block: "guarantee", state: "off" })).status, 200, "off:");
  const shopper = await pdp(productA);
  eq(blocksIn(shopper).join(","), "storefront.pdp.below_fold/badges", "shopper:");
  ok(!shopper.includes(OFF_NOTE) && !shopper.includes("data-founder-note") && !shopper.includes("data-plugin-off"), "no note for the shopper");
  const founder = await pdp(productA, { preview: true });
  eq(blocksIn(founder).sort().join(","), "storefront.pdp.below_fold/badges,storefront.pdp.below_fold/guarantee", "founder:");
  ok(founder.includes(OFF_NOTE.replace("'", "&#x27;")) || founder.includes(OFF_NOTE), "the note");
});

await t("the footer slot: Guarantee note moved above the footer shows on every page; Off hides it", async () => {
  eq((await P("owner", { block: "guarantee", slot: "storefront.footer.above" })).status, 200, "slot:");
  eq(blocksIn(await footer()).length, 0, "still off:");
  eq((await P("owner", { block: "guarantee", state: "live" })).status, 200, "live:");
  eq(blocksIn(await footer()).join(","), "storefront.footer.above/guarantee", "shown:");
  eq(blocksIn(await footer({ tn: b })).length, 0, "not on B:");
});

await t("the order slot renders only the slot's context (an order's id and states), and nothing when no block is placed there", async () => {
  const h = await html(React.createElement(PluginSlot, { name: "storefront.order.status", ctx: { id: "ord_1", status: "confirmed", email: "shopper@x.test" } }));
  eq(h, "", "empty:");
  const src = await readFile(join(ROOT, "app/(storefront)/orders/[orderId]/page.js"), "utf8");
  ok(src.indexOf("verifyOrderStatusToken") < src.indexOf("<PluginSlot"), "after the signed-link check");
  ok(/<PluginSlot name="storefront\.order\.status"/.test(await readFile(join(ROOT, "app/(storefront)/account/orders/[orderId]/page.js"), "utf8")), "account order page outlet");
  ok(/<PluginSlot name="storefront\.footer\.above"/.test(await readFile(join(ROOT, "app/(storefront)/layout.js"), "utf8")), "layout outlet");
});

await t("order slot: a fixture block's resolver gets only id/status/fulfillment_status/created_at on the guest and account order pages; no contact canary in the HTML; a bad token or another order gives 404 and the resolver never runs", async () => {
  // contact canaries an order holds, which no plugin may ever see
  const C = { email: "pslotsbuyer@example.test", phone: "9876500011", name: "Pslotsname Buyer", address_line1: "12 Pslotsaddr Road", city: "Pslotscity", pincode: "560811" };
  const ORDER = "BL-PSLOTS0001";
  await a.run(async () => {
    const now = new Date().toISOString();
    await db.insertInto("orders").values({ id: ORDER, ...C, state: "KA", country: "IN", subtotal: 500, discount_total: 0, shipping_total: 0, total: 500, currency: "INR", payment_method: "cod", payment_status: "cod", status: "cod_pending", snapshot: JSON.stringify({ contact: { email: C.email, phone: C.phone }, items: [{ title: "Item", quantity: 1, price: 500, lineTotal: 500 }] }), created_at: now, updated_at: now }).execute();
    await db.insertInto("order_items").values({ order_id: ORDER, variant_id: "v1", product_id: "p1", title: "Item", variant_title: "M", unit_price: 500, quantity: 1, line_total: 500, line_discount: 0, position: 0 }).execute();
  });
  const recorded = [];
  const undo = CAT.registerPlugin({
    id: "order-spy",
    name: "Order spy",
    version: "1.0.0",
    summary: "s",
    description: "d",
    icon: "Puzzle",
    author: { name: "T" },
    scopes: [],
    settings: [],
    blocks: [{ id: "spy", label: "Spy", primitive: "notice", slots: ["storefront.order.status"], data: (ctx) => (recorded.push(ctx), { text: "Order spy note" }) }],
  });
  // the pages' Next-only imports, as Next answers them in a request
  const nav = require("next/navigation");
  let jar = {};
  Object.assign(STUBS, {
    "next/navigation": { __esModule: true, notFound: nav.notFound, redirect: nav.redirect, useRouter: () => ({ refresh() {}, push() {} }) },
    "next/server": { __esModule: true, after: () => {} },
    "next/headers": { __esModule: true, cookies: async () => ({ get: (k) => (k in jar ? { value: jar[k] } : undefined) }) },
  });
  let installId;
  try {
    const r = await call("owner", "apps", "POST", { body: { install: { pluginId: "order-spy", scopes: [] } } });
    eq(r.status, 200, r.text.slice(0, 200));
    installId = r.body.install.id;
    await a.run(() => db.updateTable("plugin_placements").set({ state: "live" }).where("install_id", "=", installId).execute());
    const Guest = (await loadJsx(join(ROOT, "app/(storefront)/orders/[orderId]/page.js"))).default;
    const Account = (await loadJsx(join(ROOT, "app/(storefront)/account/orders/[orderId]/page.js"))).default;
    const { orderStatusToken } = await import("../lib/orders.js");
    const K = await import("../lib/customers.js");
    const { runDueJobs } = await import("../lib/platform/worker.js");
    const token = await a.run(() => orderStatusToken(ORDER));
    // a signed-in customer through the real OTP flow (it claims the order by email)
    await a.run(() => K.requestOtp(C.email));
    await runDueJobs({ limit: 10 }).catch(() => {});
    const subject = (await a.run(() => db.selectFrom("notifications").select("subject").where("type", "=", "customer_otp").orderBy("created_at", "desc").executeTakeFirst())).subject;
    const session = await a.run(() => K.verifyOtp(C.email, /(\d{6})/.exec(subject)[1]));
    const props = (orderId, t) => ({ params: Promise.resolve({ orderId }), searchParams: Promise.resolve({ t }) });
    const pages = {
      guest: () => html(React.createElement(Guest, props(ORDER, token))),
      account: () => {
        jar = { [K.CUSTOMER_COOKIE]: session.token };
        return html(React.createElement(Account, props(ORDER)));
      },
    };
    for (const [name, render] of Object.entries(pages)) {
      recorded.length = 0;
      const h = await render();
      ok(h.includes("Order spy note") && blocksIn(h).includes("storefront.order.status/spy"), `${name}: the block renders`);
      ok(recorded.length > 0, `${name}: the resolver ran`);
      for (const ctx of recorded) eq(Object.keys(ctx).sort().join(","), "created_at,fulfillment_status,id,status", `${name} ctx keys:`);
      eq(recorded[0].id, ORDER, `${name} ctx id:`);
      for (const v of Object.values(C)) ok(!h.toLowerCase().includes(v.toLowerCase()), `${name}: no ${v} in the HTML`);
      ok(!JSON.stringify(recorded).includes(C.email), `${name}: no email in ctx`);
    }
    // refused: a bad signed link, and a signed-in customer asking for an order that isn't theirs
    recorded.length = 0;
    const is404 = (e) => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(String(e?.digest || ""));
    let guest404 = null;
    try {
      await Guest(props(ORDER, `${token.slice(0, -4)}AAAA`));
    } catch (e) {
      guest404 = e;
    }
    ok(is404(guest404), `guest bad token: 404 (${guest404?.digest})`);
    let acct404 = null;
    try {
      jar = { [K.CUSTOMER_COOKIE]: session.token };
      await Account(props("BL-NOTMINE01"));
    } catch (e) {
      acct404 = e;
    }
    ok(is404(acct404), `account, not their order: 404 (${acct404?.digest})`);
    eq(recorded.length, 0, "the resolver never ran:");
  } finally {
    for (const k of ["next/navigation", "next/server", "next/headers"]) delete STUBS[k];
    if (installId) eq((await call("owner", "apps/[id]", "POST", { params: { id: installId }, body: { uninstall: true } })).status, 200, "uninstall:");
    undo();
  }
});

await t("install off, then on; the kill switch; then uninstall: each hides every block at once", async () => {
  const live = async () => blocksIn(await pdp(productA)).length + blocksIn(await footer()).length;
  eq(await live(), 2, "two live:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { disable: true } })).status, 200, "off:");
  eq(await live(), 0, "install off:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { enable: true } })).status, 200, "on:");
  eq(await live(), 2, "back:");
  await FLAGS.setFlag({ key: CAT.killFlag("trust-badges"), description: "Trust badges", default_on: true, create: true, actor: "operator" });
  await FLAGS.setFlagOverride({ key: CAT.killFlag("trust-badges"), tenant: a.id, on: false, actor: "operator" });
  FLAGS.__resetFlagCache();
  eq(await live(), 0, "killed:");
  eq(blocksIn(await pdp(productA, { preview: true })).length, 0, "killed, even in the founder preview:");
  await FLAGS.setFlagOverride({ key: CAT.killFlag("trust-badges"), tenant: a.id, on: true, actor: "operator" });
  FLAGS.__resetFlagCache();
  eq(await live(), 2, "allowed again:");
  eq((await call("owner", "apps/[id]", "POST", { params: { id: tbId }, body: { uninstall: true } })).status, 200, "uninstall:");
  eq(await live(), 0, "uninstalled:");
  eq((await P("owner")).status, 404, "its blocks are gone with it:");
  const kept = await a.run(() => db.selectFrom("plugin_placements").selectAll().where("install_id", "=", tbId).execute());
  eq(kept.length, 2, "the rows are kept, nothing deleted:");
});

await t("store B's owner, on B's host, asks for store A's install id: 404 on read and on change", async () => {
  eq((await call("owner-b", "apps/[id]/blocks", "GET", { host: hostB, params: { id: tbId } })).status, 404, "GET:");
  eq((await call("owner-b", "apps/[id]/blocks", "POST", { host: hostB, params: { id: tbId }, body: { block: "badges", state: "live" } })).status, 404, "POST:");
});

let tb2;
const P2 = (caller, body) => call(caller, "apps/[id]/blocks", body ? "POST" : "GET", { params: { id: tb2 }, ...(body ? { body } : {}) });
await t("uninstall then install again: the old install's rows hold no place; a moved block goes after the live ones only, Move up is correct, and a no-op move writes no audit row", async () => {
  const r = await call("owner", "apps", "POST", { body: { install: { pluginId: "trust-badges", scopes: [] } } });
  eq(r.status, 200, r.text.slice(0, 200));
  tb2 = r.body.install.id;
  const fresh = await P2("owner");
  ok(fresh.body.blocks.every((p) => p.first && p.last), `alone in their slots (the uninstalled rows don't count): ${JSON.stringify(fresh.body.blocks.map((p) => [p.first, p.last]))}`);
  eq((await P2("owner", { block: "badges", slot: "storefront.pdp.below_fold" })).status, 200, "move to below the details:");
  let list = (await P2("owner")).body.blocks;
  ok(!list[0].first && list[0].last && list[1].first && !list[1].last, "badges second, guarantee first");
  const before = (await placementAudit()).length;
  eq((await P2("owner", { block: "badges", move: "down" })).status, 409, "already last:");
  eq((await placementAudit()).length, before, "no audit row for a no-op:");
  eq((await P2("owner", { block: "badges", move: "up" })).status, 200, "move up:");
  list = (await P2("owner")).body.blocks;
  ok(list[0].first && list[1].last, "badges first now");
  const pos = await a.run(() => db.selectFrom("plugin_placements").select(["block_id", "position"]).where("install_id", "=", tb2).orderBy("block_id").execute());
  eq(pos.map((x) => `${x.block_id}:${x.position}`).join(","), "badges:0,guarantee:1", "positions renumbered among installed apps only:");
  eq((await P2("owner", { block: "badges", move: "up" })).status, 409, "already first:");
  eq((await placementAudit()).length, before + 1, "one audit row for the one real move:");
  for (const block of ["badges", "guarantee"]) eq((await P2("owner", { block, state: "live" })).status, 200, `${block} live:`);
  eq(blocksIn(await pdp(productA)).join(","), "storefront.pdp.below_fold/badges,storefront.pdp.below_fold/guarantee", "rendered in that order:");
});

await t("a fourth Live block in one slot is refused in plain words; three show", async () => {
  const undo = CAT.registerPlugin({
    id: "more-notes",
    name: "More notes",
    version: "1.0.0",
    summary: "s",
    description: "d",
    icon: "Puzzle",
    author: { name: "T" },
    scopes: [],
    settings: [],
    blocks: ["n1", "n2"].map((id) => ({ id, label: `Note ${id}`, primitive: "notice", slots: ["storefront.pdp.below_fold", "storefront.footer.above"], settings: [{ key: "text", kind: "text", max: 40, default: `Words ${id}` }] })),
  });
  try {
    const r = await call("owner", "apps", "POST", { body: { install: { pluginId: "more-notes", scopes: [] } } });
    eq(r.status, 200, r.text.slice(0, 200));
    const id = r.body.install.id;
    const N = (body) => call("owner", "apps/[id]/blocks", "POST", { params: { id }, body });
    eq((await N({ block: "n1", state: "live" })).status, 200, "third live:");
    const full = await N({ block: "n2", state: "live" });
    eq(full.status, 409, `fourth: ${full.text.slice(0, 200)}`);
    eq(full.body.code, "SLOT_FULL", "code:");
    ok(full.body.error.includes("already shows 3 blocks") && full.body.error.includes("Turn one of them off"), full.body.error);
    eq((await N({ block: "n2", slot: "storefront.footer.above" })).status, 200, "an Off block may move there:");
    eq((await N({ block: "n2", state: "live" })).status, 200, "live in the footer instead:");
    const moveIn = await N({ block: "n2", slot: "storefront.pdp.below_fold" });
    eq(moveIn.status, 409, "a live block can't move into a full slot:");
    eq(blocksIn(await pdp(productA)).length, 3, "three show:");
    eq((await call("owner", "apps/[id]", "POST", { params: { id }, body: { uninstall: true } })).status, 200, "uninstall:");
  } finally {
    undo();
  }
});

await t("the kill switch fails closed for rendering: when the flags can't be read, no plugin block renders (logged); the page still renders", async () => {
  eq(blocksIn(await pdp(productA)).length, 2, "two live first:");
  PL.__setKillReader(async () => {
    throw new Error("control plane down");
  });
  const lines = [];
  const log = console.log;
  console.log = (...x) => lines.push(x.join(" "));
  let h;
  try {
    h = await pdp(productA);
  } finally {
    console.log = log;
    PL.__setKillReader(null);
  }
  ok(h.includes("data-pdp-template"), "the page renders");
  eq(blocksIn(h).length, 0, "no plugin block:");
  ok(lines.some((l) => l.includes("plugin_kill_switch_unreadable")), "logged");
  eq(blocksIn(await pdp(productA)).length, 2, "back once readable:");
});

await t("a database one migration behind (no plugin_placements): every slot renders nothing, the install still works", async () => {
  await b.run(async () => {
    await db.schema.dropTable("plugin_placements").execute();
  });
  eq(blocksIn(await pdp(productB, { tn: b })).length, 0, "nothing:");
  const r = await call("owner-b", "apps", "POST", { host: hostB, body: { install: { pluginId: "trust-badges", scopes: [] } } });
  eq(r.status, 200, `install on B: ${r.text.slice(0, 200)}`);
  const list = await call("owner-b", "apps/[id]/blocks", "GET", { host: hostB, params: { id: r.body.install.id } });
  eq(list.status, 200, list.text.slice(0, 200));
  eq(list.body.blocks.map((p) => p.state).join(","), "off,off", "listed with defaults:");
});

Cache.__setCacheTestHooks({ onInvalidate: null });

// --- 5. edge safety -------------------------------------------------------------------
await t("the transitive import scan from PluginSlot.js finds no node: import (tenant-context's async_hooks, which the edge runtime has, is the only Node module reached) and never reaches installs.js", async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks|worker_threads|stream|buffer|util|events)["']/g;
  const local = (f, spec) => {
    let r = spec.startsWith("@/") ? spec.slice(2) : join(dirname(f), spec);
    if (!r.endsWith(".js")) r = existsSync(join(ROOT, `${r}.js`)) ? `${r}.js` : join(r, "index.js");
    return existsSync(join(ROOT, r)) ? r : null;
  };
  const reached = new Set();
  const queue = ["components/plugins/PluginSlot.js"];
  const hits = [];
  while (queue.length) {
    const f = queue.shift();
    if (reached.has(f)) continue;
    reached.add(f);
    const src = strip(await readFile(join(ROOT, f), "utf8"));
    for (const m of src.matchAll(nodeImport)) hits.push(`${f}: ${m[1]}`);
    for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*|^import\s+)["']((?:\.|@\/)[^"']+)["']/gm)) {
      const r = local(f, m[1]);
      if (r) queue.push(r);
    }
  }
  for (const f of ["lib/plugins/placement.js", "lib/plugins/blocks.js", "lib/plugins/slots.js", "lib/plugins/catalog.js", "lib/platform/flags.js", "components/plugins/blocks/BadgeRow.js", "lib/storefront-request.js"]) ok(reached.has(f), `${f} reached`);
  ok(!reached.has("lib/plugins/installs.js"), "installs.js is console-only");
  eq(hits.join(","), "lib/tenant-context.js: node:async_hooks", "node imports reached:");
});

await t('no file in components/plugins has "use client", an event handler, dangerouslySetInnerHTML, <script> or <iframe>', async () => {
  const walk = async (d) => (await readdir(join(ROOT, d), { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [`${d}/${e.name}`])).concat(...(await Promise.all((await readdir(join(ROOT, d), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => walk(`${d}/${e.name}`)))));
  const files = await walk("components/plugins");
  ok(files.length >= 4, files.join(","));
  for (const f of files) {
    const src = await readFile(join(ROOT, f), "utf8");
    ok(!/["']use client["']/.test(src), `${f}: use client`);
    ok(!/\bon[A-Z]\w*=/.test(src) && !/dangerouslySetInnerHTML|<script|<iframe/.test(src), `${f}: handler or raw HTML`);
  }
});

await t("no network: nothing reached fetch()", () => eq(network.length, 0, network.join(", ")));

await store.cleanup();
await rm(join(ROOT, ".test-pslots-default.db"), { force: true });
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)${perf.before ? ` · PDP ${perf.before} → ${perf.after} ms` : ""}`);
process.exit(fail ? 1 : 0);
