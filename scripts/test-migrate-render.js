// P4-EQUIV suite (MIG-02): the rendered before/after comparison.
//   1. normalizing: two captures that differ only in nonce, build id, asset
//      hashes (and generated ids, date-times, streaming order, late metadata)
//      compare the same
//   2. real differences are found and named by page and place: a changed
//      product title, a missing module, a reordered pair, a different
//      template, a changed cart offer, a status or redirect change
//   3. ALLOWED_DIFFERENCES: every entry has a reason and a fixture that
//      differs without it and is the same with it; neither hides a real change
//   4. capturing: no cookie header on any request (the server sets a cart
//      cookie and an experiment unit; neither comes back), redirects recorded,
//      a folder holding someone else's files refused
//   5. the command: refuses a base not on this machine before any request;
//      --compare exits 1 on a difference and 0 when the same
//   6. the route list from a store: the canaries plus every product and
//      collection with old content (file databases only)
// No network beyond a server on 127.0.0.1 this suite starts on a free port;
// no sqld, no Typesense, no Shopify.
//   pnpm test:migrate-render
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COL, P, ROOT, installHooks, makeLegacyTenant, openWorld } from "./support/legacy-tenants.js";
import { compare, normalize, normalizeTree, streamInstructions } from "../lib/migrate/render-compare.js";
import { ALLOWED_DIFFERENCES } from "../lib/migrate/allowed-differences.js";
import { assertLocalBase, captureRoutes, compareDirs, loadCapture, main, readRoutes } from "./migrate-render.mjs";

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
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const show = (r) => JSON.stringify(r.differences, null, 1).slice(0, 1500);

// ---------- a synthetic product page, shaped like what the storefront renders ----------
//
// Knobs: the things that differ between two visits (nonce, build id, asset
// hash, generated id, request time, whether the product part streamed late)
// and the things a shopper sees (title, modules, pairs and their order,
// template, badge).
const BASE = {
  nonce: "bm9uY2UtMQ==",
  build: "bld_7f3a9c",
  hash: "0x7k2_a",
  useId: "_R_1b2_",
  time: "2026-11-04T10:15:00.123Z",
  streamed: false,
  lateMeta: false,
  title: "Micronised Creatine",
  badge: "Bestseller",
  template: "editorial",
  modules: [
    ["How to use", "<p>One scoop a day.</p>"],
    ["Ingredients", "<p>Creatine monohydrate.</p>"],
    ["Why it works", "<p>Strength over time.</p>"],
  ],
  pairsTitle: "Goes well with your routine",
  pairs: [
    ["whey-protein", "Whey Protein"],
    ["shaker", "Shaker Bottle"],
    ["electrolytes", "Electrolytes"],
  ],
};

function productPage(over = {}) {
  const o = { ...BASE, ...over };
  const modules = o.modules
    .map(([title, html]) => `<details class="group py-3"><summary class="flex cursor-pointer">${title}<span class="text-sf-text-faint">+</span></summary><div class="rte mt-2 text-sm">${html}</div></details>`)
    .join("");
  const pairs = o.pairs.map(([handle, name]) => `<a class="block" href="/products/${handle}"><img src="/api/media/${handle}" alt="${name}"/><span>${name}</span></a>`).join("");
  const product = `<div data-pdp-template="${o.template}"><div class="grid gap-8"><h1 class="font-display text-3xl">${o.title}</h1>${o.badge ? `<span class="badge">${o.badge}</span>` : ""}<label for="${o.useId}">Quantity</label><input id="${o.useId}" aria-describedby="${o.useId}-hint" type="number" value="1"/><div data-sec="pdp-modules" class="mt-6 divide-y">${modules}</div></div></div><section data-sec="pdp-pairs" class="mt-16"><h2>${o.pairsTitle}</h2><div class="grid grid-cols-4">${pairs}</div></section>`;
  const meta = `<title>${o.title} · Design Demo Co</title><meta name="description" content="${o.title}, tested."/><link rel="canonical" href="http://localhost:6140/products/micronised-creatine-12"/>`;
  // streamed: the product part arrives later in a hidden div, as React sends it
  const main = o.streamed
    ? `<main><!--$?--><template id="B:0"></template><div class="animate-pulse">Loading…</div><!--/$--></main>`
    : `<main><!--$-->${product}<!--/$--></main>`;
  const tail = o.streamed ? `<div hidden id="S:0">${product}</div><script nonce="${o.nonce}">$RC("B:0","S:0")</script>` : "";
  return [
    "<!DOCTYPE html>",
    `<html lang="en"><head><meta charSet="utf-8"/>`,
    `<link rel="stylesheet" href="/_next/static/chunks/app_storefront_${o.hash}._.css?dpl=${o.build}" data-precedence="next_static/chunks/app_storefront_${o.hash}._.css"/>`,
    `<script src="/_next/static/chunks/main-${o.hash}.js" async="" nonce="${o.nonce}"></script>`,
    o.lateMeta ? "" : meta,
    `<style nonce="${o.nonce}">@font-face{font-family:x;src:url(/_next/static/media/font.${o.hash}.woff2)}</style>`,
    `</head><body class="flex min-h-full"><div hidden=""></div>`,
    `<header><a href="/">Design Demo Co</a><img src="/_next/static/media/logo.${o.hash}.svg" alt="Design Demo Co"/><img src="/_next/image?url=%2Fbadge.png&amp;w=64&amp;q=75&amp;dpl=${o.build}" alt=""/></header>`,
    main,
    `<footer><p>Prices updated <time datetime="${o.time}">today</time></p></footer>`,
    `<script nonce="${o.nonce}">self.__next_f.push([1,"0:{\\"b\\":\\"${o.build}\\",\\"t\\":\\"${o.time}\\"}"])</script>`,
    tail,
    o.lateMeta ? meta : "",
    `<next-route-announcer style="position:absolute"></next-route-announcer>`,
    "</body></html>",
  ].join("");
}
const cap = (body, route = "/products/micronised-creatine-12", extra = {}) => ({ route, status: 200, contentType: "text/html; charset=utf-8", body, origin: "http://localhost:6140", ...extra });

// ---------- a local store this suite starts (port 0: a free one) ----------

const seen = [];
let variant = "before";
const server = createServer((req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } });
  // every answer tries to set a cart cookie and an experiment unit
  res.setHeader("set-cookie", ["cart=cart_abc123; Path=/; HttpOnly", "_unit=11111111-2222-4333-8444-555555555555; Path=/"]);
  if (req.url === "/old-address") {
    res.writeHead(308, { location: "/journal/new-address" });
    return res.end();
  }
  if (req.url.startsWith("/api/upsell")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ title: variant === "before" ? "You might also like" : "Add to your order", products: [{ id: P(1), title: "Shaker Bottle" }] }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(productPage(variant === "before" ? { nonce: `n-${seen.length}` } : { nonce: `n-${seen.length}`, title: "Micronised Creatine Plus" }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "migrate-render-"));
const routesFile = join(TMP, "routes.json");
writeFileSync(
  routesFile,
  JSON.stringify({
    routes: [
      { name: "home", path: "/", kind: "canary" },
      { name: "product", path: "/products/micronised-creatine-12", kind: "canary" },
      { name: "old", path: "/old-address", kind: "canary" },
      { name: "upsell", path: "/api/upsell", kind: "canary" },
    ],
  }),
);
// the command as its own process; async, so this suite's server keeps answering
const cli = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "scripts", "migrate-render.mjs"), ...args], { cwd: ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

let world = null;
try {
  // ====================================================================================
  console.log("— 1. normalizing: what differs between two visits to the same store");
  // ====================================================================================
  await t("two captures differing only in nonce, build id and asset hash compare the same", async () => {
    const a = productPage();
    const b = productPage({ nonce: "ZGlmZmVyZW50LW5vbmNl", build: "bld_000111", hash: "9zz_q1" });
    ok(a !== b, "the raw pages differ");
    for (const s of ["bm9uY2UtMQ==", "bld_7f3a9c", "0x7k2_a"]) ok(a.includes(s) && !b.includes(s), `the raw pages differ in ${s}`);
    const r = compare(cap(a), cap(b));
    ok(r.same, `expected the same, got ${show(r)}`);
    eq(r.differences.length, 0, "differences:");
    eq(normalize(a), normalize(b), "normalized pages:");
  });

  await t("normalized pages carry no nonce, build id, asset hash, script, generated id or date-time", async () => {
    const n = normalize(productPage(), { origin: "http://localhost:6140" });
    for (const s of ["bm9uY2UtMQ==", "bld_7f3a9c", "0x7k2_a", "_R_1b2_", "2026-11-04T10:15:00", "<script", "next-route-announcer", "http://localhost:6140", "nonce"]) ok(!n.includes(s), `normalized page still holds ${s}`);
    ok(n.includes("/_next/static/<asset>"), "asset addresses kept, without their hash");
    ok(n.includes('for="<id>"') && n.includes('aria-describedby="<id>-hint"'), "generated ids in other attributes become <id>");
    ok(n.includes("<origin>/products/micronised-creatine-12"), "the capture's origin becomes <origin>");
    ok(n.includes("Micronised Creatine") && n.includes("Goes well with your routine"), "what shoppers read is kept");
    ok(normalize("<p>Ready? Shop  now, from 2026-11-04.</p>").includes("Ready? Shop now, from 2026-11-04."), "a question mark and a plain date in words stay");
  });

  await t("also the same: other generated ids and request times, a part that streamed late, metadata sent after the body", async () => {
    const a = productPage();
    const b = productPage({ useId: "_R_9xq_", time: "2026-11-05T23:59:59Z", streamed: true, lateMeta: true });
    eq(streamInstructions(b).length, 1, "the late page has one streaming instruction");
    const r = compare(cap(a), cap(b));
    ok(r.same, `expected the same, got ${show(r)}`);
  });

  await t("without the streaming step a late part would differ (the fallback would be compared)", async () => {
    const b = productPage({ streamed: true });
    const noScripts = b.replace(/\$RC\("B:0","S:0"\)/, "");
    const r = compare(cap(productPage()), cap(noScripts));
    ok(!r.same, "a page whose late part was never placed must differ");
    ok(normalize(noScripts).includes("Loading…"), "the fallback is what is left");
  });

  // ====================================================================================
  console.log("— 2. real differences, named by page and place");
  // ====================================================================================
  const route = "/products/micronised-creatine-12";
  const one = (r, pred, msg) => {
    const d = r.differences.find(pred);
    ok(d, `${msg}: not found in ${show(r)}`);
    eq(d.route, route, `${msg} route:`);
    return d;
  };

  await t("a changed product title: a difference at the h1 (and the page title), with its route", async () => {
    const r = compare(cap(productPage()), cap(productPage({ title: "Micronised Creatine Plus" })));
    ok(!r.same, "must differ");
    const d = one(r, (x) => /h1 > text\(\)$/.test(x.selector), "the h1");
    ok(d.selector.includes('div[data-pdp-template="editorial"]'), `selector names the template block: ${d.selector}`);
    eq(d.before, "Micronised Creatine", "before:");
    eq(d.after, "Micronised Creatine Plus", "after:");
    one(r, (x) => x.selector === "html > head > title > text()", "the page title");
  });

  await t("a missing module: a difference inside the modules block, before shown, after empty", async () => {
    const r = compare(cap(productPage()), cap(productPage({ modules: BASE.modules.filter((_, i) => i !== 1) })));
    ok(!r.same, "must differ");
    const d = one(r, (x) => x.selector.includes('div[data-sec="pdp-modules"] > details'), "the module");
    ok(String(d.before).includes("Ingredients"), `before shows the module: ${d.before}`);
    eq(d.after, null, "after:");
    eq(r.differences.length, 1, "exactly one difference:");
  });

  await t("a reordered pair: one difference at the pairs grid, both orders shown", async () => {
    const r = compare(cap(productPage()), cap(productPage({ pairs: [BASE.pairs[1], BASE.pairs[0], BASE.pairs[2]] })));
    ok(!r.same, "must differ");
    eq(r.differences.length, 1, "exactly one difference:");
    const d = one(r, (x) => x.selector.endsWith('section[data-sec="pdp-pairs"] > div'), "the pairs grid");
    ok(/^in this order: Whey Protein .*\| Shaker Bottle/.test(d.before), `before order: ${d.before}`);
    ok(/^in this order: Shaker Bottle .*\| Whey Protein/.test(d.after), `after order: ${d.after}`);
  });

  await t("a different template: one difference for the whole product block, named by its template", async () => {
    const r = compare(cap(productPage()), cap(productPage({ template: "classic" })));
    ok(!r.same, "must differ");
    eq(r.differences.length, 1, "exactly one difference:");
    const d = one(r, (x) => x.selector.endsWith('div[data-pdp-template="editorial"]'), "the template block");
    ok(String(d.before).startsWith('<div data-pdp-template="editorial">'), `before: ${String(d.before).slice(0, 80)}`);
    ok(String(d.after).startsWith('<div data-pdp-template="classic">'), `after: ${String(d.after).slice(0, 80)}`);
  });

  await t("a removed badge, a changed pairs title, a changed status, a changed redirect, a page missing on one side", async () => {
    const badge = compare(cap(productPage()), cap(productPage({ badge: null })));
    ok(badge.differences.some((d) => d.before === '<span class="badge"> Bestseller </span>' && d.after === null), `badge: ${show(badge)}`);
    const pt = compare(cap(productPage()), cap(productPage({ pairsTitle: "You might also like" })));
    ok(pt.differences.some((d) => d.selector.endsWith('section[data-sec="pdp-pairs"] > h2 > text()')), `pairs title: ${show(pt)}`);
    const st = compare(cap(productPage()), cap(productPage(), route, { status: 404 }));
    ok(st.differences.some((d) => d.selector === "(status)" && d.before === "200" && d.after === "404"), `status: ${show(st)}`);
    const rd = compare(cap("", "/old", { status: 308, location: "/journal/a" }), cap("", "/old", { status: 308, location: "/journal/b" }));
    ok(rd.differences.some((d) => d.route === "/old" && d.selector === "(redirect)"), `redirect: ${show(rd)}`);
    const gone = compare([cap(productPage()), cap(productPage(), "/x")], [cap(productPage())]);
    ok(gone.differences.some((d) => d.route === "/x" && d.selector === "(page)"), `missing page: ${show(gone)}`);
  });

  await t("the cart offer (JSON): a changed title is a difference at its path", async () => {
    const j = (title, ids) => ({ route: "/api/upsell", status: 200, contentType: "application/json", body: JSON.stringify({ title, products: ids.map((id) => ({ id })) }) });
    eq(compare(j("A", [1, 2]), j("A", [1, 2])).same, true, "same offer:");
    const r = compare(j("You might also like", [1, 2]), j("Add to your order", [1, 2]));
    ok(r.differences.some((d) => d.route === "/api/upsell" && d.selector === "$.title" && d.before === '"You might also like"'), show(r));
    const o = compare(j("A", [1, 2]), j("A", [2, 1]));
    ok(o.differences.some((d) => d.selector === "$.products" && d.before.startsWith("in this order:")), `reordered offer: ${show(o)}`);
  });

  // ====================================================================================
  console.log("— 3. ALLOWED_DIFFERENCES (also asserted by test-migrate-documents, P4-CUTOVER)");
  // ====================================================================================
  await t("the list: unique ids, and every entry has a plain reason, an apply and a fixture", async () => {
    ok(Array.isArray(ALLOWED_DIFFERENCES) && ALLOWED_DIFFERENCES.length >= 1, "a list");
    ok(Object.isFrozen(ALLOWED_DIFFERENCES), "frozen");
    eq(new Set(ALLOWED_DIFFERENCES.map((a) => a.id)).size, ALLOWED_DIFFERENCES.length, "unique ids:");
    for (const a of ALLOWED_DIFFERENCES) {
      ok(typeof a.id === "string" && /^[a-z0-9-]+$/.test(a.id), `id ${a.id}`);
      ok(typeof a.reason === "string" && a.reason.trim().length >= 60, `${a.id}: a reason in words`);
      ok(typeof a.apply === "function", `${a.id}: apply`);
      ok(a.fixture && typeof a.fixture.before === "string" && typeof a.fixture.after === "string" && typeof a.fixture.route === "string", `${a.id}: a fixture`);
    }
  });

  for (const a of ALLOWED_DIFFERENCES) {
    await t(`${a.id}: its fixture differs without it, is the same with it (and with the whole list)`, async () => {
      const before = cap(a.fixture.before, a.fixture.route);
      const after = cap(a.fixture.after, a.fixture.route);
      const strict = compare(before, after, { allowed: [] });
      ok(!strict.same, `${a.id}: the fixture must differ without the entry (it proves the entry is needed)`);
      const others = compare(before, after, { allowed: ALLOWED_DIFFERENCES.filter((x) => x !== a) });
      ok(!others.same, `${a.id}: no other entry covers it`);
      const withIt = compare(before, after, { allowed: [a] });
      ok(withIt.same, `${a.id}: with the entry, the same; got ${show(withIt)}`);
      ok(withIt.allowedApplied.some((x) => x.id === a.id && x.route === a.fixture.route), `${a.id}: reported as used`);
      ok(compare(before, after, { allowed: ALLOWED_DIFFERENCES }).same, `${a.id}: the same with the whole list`);
    });
  }

  await t("section-ids does not hide a changed section kind, content or order", async () => {
    const sec = (id, kind, text) => `<section data-sec="${id}" data-section-id="${id}" data-section-kind="${kind}"><p>${text}</p></section>`;
    const page = (body) => `<html><body><main>${body}</main></body></html>`;
    const A = ALLOWED_DIFFERENCES;
    ok(!compare(cap(page(sec("i-1", "rich_text", "x")), "/"), cap(page(sec("sec_l1", "banner", "x")), "/"), { allowed: A }).same, "kind");
    ok(!compare(cap(page(sec("i-1", "rich_text", "x")), "/"), cap(page(sec("sec_l1", "rich_text", "y")), "/"), { allowed: A }).same, "content");
    ok(!compare(cap(page(sec("i-1", "text", "a") + sec("i-2", "text", "b")), "/"), cap(page(sec("sec_l1", "text", "b") + sec("sec_l2", "text", "a")), "/"), { allowed: A }).same, "order");
    // fixed names are not ids: a different named block is still a difference
    ok(!compare(cap(page(`<div data-sec="pdp-modules"></div>`), "/"), cap(page(`<div data-sec="pdp-pairs"></div>`), "/"), { allowed: A }).same, "named blocks");
  });

  await t("hero-test-variant only applies when both captures show the same running test", async () => {
    const entry = ALLOWED_DIFFERENCES.find((a) => a.id === "hero-test-variant");
    const { before, after } = entry.fixture;
    eq(normalizeTree(before).experiments.join(), "hero-promise", "the test is seen in the page's data:");
    const noTest = after.replace(/<script>self\.__next_f[\s\S]*?<\/script>/, "");
    eq(normalizeTree(noTest).experiments.length, 0, "no test without the data:");
    ok(!compare(cap(before, "/"), cap(noTest, "/"), { allowed: ALLOWED_DIFFERENCES }).same, "a test that stopped (or started) is a difference");
    const otherTest = after.replace("hero-promise", "hero-other");
    ok(!compare(cap(before, "/"), cap(otherTest, "/"), { allowed: ALLOWED_DIFFERENCES }).same, "a different test is a difference");
    const heroOnly = compare(cap(before.replace("Shop now", "Buy"), "/"), cap(after, "/"), { allowed: ALLOWED_DIFFERENCES });
    ok(heroOnly.same, "inside the hero only, while the same test runs, it is set aside");
    const outside = compare(cap(before.replace("</main>", "<p>Free shipping</p></main>"), "/"), cap(after, "/"), { allowed: ALLOWED_DIFFERENCES });
    ok(!outside.same, "outside the hero it still counts");
  });

  // ====================================================================================
  console.log("— 4. capturing: no cookie, redirects recorded, folders kept safe");
  // ====================================================================================
  const capBefore = join(TMP, "before");
  const capAfter = join(TMP, "after");
  await t("capture requests carry no cookie header (the store's cart cookie and experiment unit never come back)", async () => {
    seen.length = 0;
    variant = "before";
    const routes = readRoutes(routesFile);
    await captureRoutes(BASE_URL, routes, capBefore);
    // a second capture after the store set its cookies twice over
    await captureRoutes(BASE_URL, routes, capBefore);
    eq(seen.length, routes.length * 2, "requests:");
    for (const s of seen) {
      eq(s.headers.cookie, undefined, `${s.url}: a cookie header was sent:`);
      ok(!JSON.stringify(s.headers).includes("cart_abc123") && !JSON.stringify(s.headers).includes("11111111-2222"), `${s.url}: the cart cookie or the experiment unit came back`);
    }
    // and the command, as a separate process
    seen.length = 0;
    const r = await cli(["--base", BASE_URL, "--routes", routesFile, "--out", join(TMP, "cli-capture")]);
    eq(r.status, 0, `the command: ${r.stderr}`);
    eq(seen.length, routes.length, "command requests:");
    for (const s of seen) eq(s.headers.cookie, undefined, `command ${s.url}: a cookie header was sent:`);
  });

  await t("the capture: status, type, the redirect recorded (not followed), and the body as served", async () => {
    const list = loadCapture(capBefore);
    const old = list.find((c) => c.route === "/old-address");
    eq(old.status, 308, "redirect status:");
    eq(old.location, "/journal/new-address", "redirect target:");
    ok(!seen.some((s) => s.url === "/journal/new-address"), "the redirect was not followed");
    const up = list.find((c) => c.route === "/api/upsell");
    ok(/json/.test(up.contentType), "the cart offer is JSON");
    const index = JSON.parse(readFileSync(join(capBefore, "index.json"), "utf8"));
    eq(index.tool, "migrate-render", "index tool:");
    ok(index.routes.every((r) => /^[0-9a-f]{64}$/.test(r.sha256)), "each page has its hash");
  });

  await t("a folder holding someone else's files is refused, and nothing in it changes", async () => {
    const dir = join(TMP, "precious");
    mkdirSync(dir);
    writeFileSync(join(dir, "founder-notes.txt"), "keep me");
    seen.length = 0;
    let refused = null;
    try {
      await captureRoutes(BASE_URL, readRoutes(routesFile), dir);
    } catch (e) {
      refused = e.message;
    }
    ok(refused && refused.includes("did not write"), `refused: ${refused}`);
    eq(readdirSync(dir).join(), "founder-notes.txt", "folder:");
    eq(readFileSync(join(dir, "founder-notes.txt"), "utf8"), "keep me", "file:");
    eq(seen.length, 0, "no request was made:");
  });

  // ====================================================================================
  console.log("— 5. the command: only this machine; --compare's exit code");
  // ====================================================================================
  await t("a base not on this machine is refused before any request (library and command)", async () => {
    const remote = ["https://shop.example.com", "http://storeasy.in", "http://10.0.0.5:6140", "http://localhost.example.com:6140", "http://localhost:3017", "ftp://localhost:6140", "file:/tmp/x", "not a url"];
    for (const base of remote) {
      let threw = false;
      try {
        assertLocalBase(base);
      } catch {
        threw = true;
      }
      ok(threw, `assertLocalBase let ${base} through`);
    }
    for (const base of ["http://localhost:6140", "http://127.0.0.1:7145", "http://[::1]:6140", "http://design.localhost:6140"]) assertLocalBase(base);
    let fetched = 0;
    let threw = null;
    try {
      await captureRoutes("https://shop.example.com", [{ name: "home", path: "/" }], join(TMP, "never"), {
        fetchImpl: async () => {
          fetched++;
          throw new Error("must not fetch");
        },
      });
    } catch (e) {
      threw = e.message;
    }
    ok(threw && /this machine/.test(threw), `refused in words: ${threw}`);
    eq(fetched, 0, "fetches:");
    ok(!existsSync(join(TMP, "never")), "no folder was made");
    const out = join(TMP, "cli-remote");
    const r = await cli(["--base", "https://shop.example.com", "--routes", routesFile, "--out", out]);
    eq(r.status, 2, `exit code (stderr: ${r.stderr})`);
    ok(/this machine/.test(r.stderr), `plain refusal: ${r.stderr}`);
    ok(!existsSync(out), "the command made no folder");
    const h = await cli(["--base", BASE_URL, "--routes", routesFile, "--out", join(TMP, "cli-hosted"), "--hosted"]);
    eq(h.status, 2, "--hosted is refused:");
  });

  await t("a route that leaves the store is refused", async () => {
    const f = join(TMP, "bad-routes.json");
    writeFileSync(f, JSON.stringify(["//evil.example.com/x"]));
    const r = await cli(["--base", BASE_URL, "--routes", f, "--out", join(TMP, "cli-bad")]);
    eq(r.status, 2, `exit code: ${r.stderr}`);
  });

  await t("--compare exits 1 on a difference and names it; 0 when the same", async () => {
    variant = "after";
    await captureRoutes(BASE_URL, readRoutes(routesFile), capAfter);
    variant = "before";
    const same = await cli(["--compare", capBefore, join(TMP, "cli-capture")]);
    eq(same.status, 0, `the same captures: ${same.stdout}${same.stderr}`);
    ok(/Result: the same/.test(same.stdout), same.stdout);
    const jsonOut = join(TMP, "result.json");
    const diff = await cli(["--compare", capBefore, capAfter, "--json", jsonOut]);
    eq(diff.status, 1, `exit code on a difference: ${diff.stdout}${diff.stderr}`);
    ok(diff.stdout.includes("Different: /products/micronised-creatine-12") && diff.stdout.includes("Different: /api/upsell"), diff.stdout);
    ok(/where: +.*h1 > text\(\)/.test(diff.stdout) && diff.stdout.includes("after:  Micronised Creatine Plus"), diff.stdout);
    ok(/NOT the same/.test(diff.stdout), "the verdict");
    const result = JSON.parse(readFileSync(jsonOut, "utf8"));
    eq(result.same, false, "json same:");
    ok(result.differences.every((d) => typeof d.route === "string" && typeof d.selector === "string"), "every difference has a route and a selector");
    eq(compareDirs(capBefore, capAfter).same, false, "compareDirs:");
    const bad = await cli(["--compare", capBefore, join(TMP, "nothing-here")]);
    eq(bad.status, 2, "a folder that is not a capture:");
    eq(await main(["--compare"], { log() {}, error() {} }), 2, "usage:");
  });

  // ====================================================================================
  console.log("— 6. the route list from a store");
  // ====================================================================================
  await t("the canaries plus every product and collection with old content", async () => {
    installHooks({ headers: "real" });
    world = await openWorld({ prefix: ".test-mrender" });
    const { db } = await makeLegacyTenant(world, {
      id: "mrender",
      file: "t1",
      state: "live_v3",
      entities: ["product_override_modules_badge", "product_override_six_modules", "pdp_pairs_custom_title", "pdp_pairs_two_on_one_source", "collection_pins", "surface_templates_products", "surface_templates_collections", "redirect_to_journal_post"],
    });
    const M = await import("../lib/migrate/map.js");
    const C = await import("../lib/migrate/check.js");
    const { renderRoutesFor } = await import("../lib/migrate/render-compare.js");
    const { libsql } = await import("../lib/db.js");
    const out = await db.run(() => M.mapTenant({ platform: world.control.platformDb() }));
    const { routes } = await db.run(() => renderRoutesFor(out));
    const paths = routes.map((r) => r.path);
    eq(new Set(paths).size, paths.length, "no route twice:");
    eq(new Set(routes.map((r) => r.name)).size, routes.length, "unique names:");
    const canary = (why) => routes.find((r) => r.kind === "canary" && r.why.startsWith(why));
    eq(canary("home").path, "/", "home:");
    ok(canary("a page")?.path.startsWith("/policies/"), `a page: ${JSON.stringify(canary("a page"))}`);
    ok(canary("a journal post")?.path.startsWith("/journal/"), "a journal post");
    eq(canary("an old address")?.path, "/journal/old-post-address", "the old address that moved:");
    eq(canary("the cart (empty")?.path, "/checkout", "the cart:");
    eq(canary("the cart offer")?.path, "/api/upsell", "the cart offer:");
    ok(canary("search")?.path.startsWith("/search?q="), "search");
    // the collection with pins, the product with the most kinds of content
    const handles = async (table, ids) => new Map((await db.run(() => libsql.execute({ sql: `SELECT id, handle FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, args: ids }))).rows.map((r) => [String(r.id), String(r.handle)]));
    eq(canary("a collection with pinned")?.path, "/collections/pinned-col", "pinned collection:");
    const ids = C.entityIdsOf(out);
    ok(ids.products.length >= 5 && ids.collections.length >= 2, `entity ids: ${JSON.stringify(ids)}`);
    const ph = await handles("products", ids.products);
    const ch = await handles("collections", ids.collections);
    for (const id of ids.products) if (ph.has(id)) ok(paths.includes(`/products/${ph.get(id)}`), `product ${id} listed`);
    for (const id of ids.collections) if (ch.has(id)) ok(paths.includes(`/collections/${ch.get(id)}`), `collection ${id} listed`);
    ok(ph.has(P(201)) && paths.includes(`/products/${ph.get(P(201))}`), "the product with modules and a badge");
    ok(ch.has(COL(241)) && paths.includes(`/collections/${ch.get(COL(241))}`), "the collection with a template");
    const bp = canary("a product with")?.path;
    ok(bp && bp.startsWith("/products/"), `product canary: ${bp}`);
  });
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
  if (world) await world.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
