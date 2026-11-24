// Maintenance drill on the REAL edge runtime: a production build under
// `next start`, against two throwaway local sqld servers (file: DBs don't work
// on edge). Sends the requests a shopper or an attacker could send while a
// store is in maintenance, and checks what comes back: full pages, RSC
// navigations that claim to hold the layout, prefetches, and shopper APIs.
// A check only counts if the same marker IS visible to staff, so it can't pass
// just because the page is empty.
//
// Needs `sqld` (PATH, $SQLD_BIN or ~/.turso/sqld). Refuses to run in a checkout
// with .env files: Next would load them, and this must touch nothing hosted.
// Run it from a clean worktree. Local Next behaviour only, NOT Vercel.
//   pnpm drill:maintenance-edge            (builds first, about 3 minutes)
//   pnpm drill:maintenance-edge --no-build (reuses .next)
//   pnpm drill:maintenance-edge --no-build --serve
//     seeds, then serves http://localhost:18430 with maintenance OFF for a look
//     in a browser. Send SIGUSR2 to flip maintenance on and off.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [WEB, PLATFORM, TENANT] = [18430, 18431, 18432];

const envFiles = readdirSync(root).filter((f) => /^\.env/.test(f) && f !== ".env.example");
if (envFiles.length) {
  console.error(`Refusing to run: ${envFiles.join(", ")} would be loaded by Next. Use a clean worktree.`);
  process.exit(2);
}
const sqld = [process.env.SQLD_BIN, join(homedir(), ".turso/sqld")].find((p) => p && existsSync(p)) ||
  (spawnSync("which", ["sqld"]).stdout?.toString().trim() || null);
if (!sqld) {
  console.error("Refusing to run: sqld not found (set SQLD_BIN).");
  process.exit(2);
}

const env = {
  TURSO_DB_URL: "",
  TURSO_DB_AUTH_TOKEN: "",
  RESEND_API_KEY: "",
  TYPESENSE_HOST: "",
  DATABASE_URL: `http://127.0.0.1:${TENANT}`,
  PLATFORM_DB_URL: `http://127.0.0.1:${PLATFORM}`,
  PLATFORM_DB_TOKEN: "",
  PLATFORM_SECRET: "maintenance-drill-secret",
  PLATFORM_CACHE_MS: "0",
  NEXT_TELEMETRY_DISABLED: "1",
};
Object.assign(process.env, env);

const dir = mkdtempSync(join(tmpdir(), "maintenance-drill-"));
const children = [];
function start(cmd, args, log) {
  const out = openSync(join(dir, log), "w");
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", out, out] });
  children.push(child);
  return child;
}
function teardown() {
  for (const c of children) c.kill("SIGTERM");
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(1);
  });
}

const MARK = {
  product: "DRILLMARKER-PRODUCT",
  description: "DRILLMARKER-DESCRIPTION",
  collection: "DRILLMARKER-COLLECTION",
  about: "DRILLMARKER-ABOUT",
  policy: "DRILLMARKER-POLICY",
  hero: "DRILLMARKER-HERO",
  handle: "drillmarker-whey",
  collectionHandle: "drillmarker-range",
};
const LEAK_MARKS = [MARK.product, MARK.description, MARK.collection, MARK.about, MARK.policy, MARK.hero, MARK.handle, MARK.collectionHandle];
// A handle the caller put in the URL comes back in the route params: an echo, not a leak.
const leaks = (body, path = "") => LEAK_MARKS.filter((m) => body.includes(m) && !path.includes(m));
const VARIANT_ID = "gid://shopify/ProductVariant/9001";

const req = (path, { method = "GET", cookie, headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const q = http.request(
      { host: "127.0.0.1", port: WEB, path, method, headers: { host: "edge.test", ...(cookie ? { cookie } : {}), ...headers } },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => (data += c));
        r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: data }));
      },
    );
    q.on("error", reject);
    if (body) q.write(body);
    q.end();
  });
const postJson = (path, json, cookie) =>
  req(path, { method: "POST", cookie, headers: { origin: "http://edge.test", "content-type": "application/json" }, body: JSON.stringify(json) });

async function waitFor(fn, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const STORE = "Edge Drill";
const CLOSED_TITLE = `${STORE} will be right back`;
// A dark brand: the closed page must follow it and stay readable on it.
const BRAND = { background: "#111827", foreground: "#f9fafb", accent: "#84cc16" };
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const unescapeHtml = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const titlesOf = (html) => [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => unescapeHtml(m[1]));

// Inline colours of the element marked data-curtain="<part>", as declared in
// the served HTML (the curtain sets every colour inline).
function curtainColours(html, part) {
  const tag = new RegExp(`<[a-z0-9]+[^>]*data-curtain="${part}"[^>]*>`).exec(html)?.[0] || "";
  const style = /style="([^"]*)"/.exec(tag)?.[1] || "";
  const prop = (name) => new RegExp(`(?:^|;)\\s*${name}:\\s*(#[0-9a-fA-F]{6})`).exec(style)?.[1]?.toLowerCase() || null;
  return { color: prop("color"), background: prop("background-color") };
}
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Router state a client would send if it already held the storefront layout.
const treeOf = (segment) => {
  const leaf = ["__PAGE__", {}];
  const inner = segment ? [segment, { children: leaf }] : leaf;
  return encodeURIComponent(JSON.stringify(["", { children: ["(storefront)", { children: inner }] }]));
};
const rscHeaders = (claim, extra = {}) => ({ RSC: "1", "Next-Router-State-Tree": treeOf(claim), ...extra });

const PAGES = [
  { name: "home", path: "/", claim: "contact", mark: MARK.hero },
  { name: "product", path: `/products/${MARK.handle}`, claim: null, mark: MARK.product },
  { name: "collection", path: `/collections/${MARK.collectionHandle}`, claim: null, mark: MARK.collection },
  { name: "content", path: "/about", claim: null, mark: MARK.about },
  { name: "policy", path: "/policies/drill-policy", claim: null, mark: MARK.policy },
  { name: "search", path: "/search?q=drillmark", claim: null, mark: MARK.product },
];
// Every page whose title the closed store must replace (contact has no marker).
const TITLE_PAGES = [...PAGES.map(({ name, path }) => ({ name, path })), { name: "contact", path: "/contact" }];

let problems = 0;
let checks = 0;
function record(ok, line) {
  checks++;
  if (!ok) problems++;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
}

try {
  // ---------- servers + seed ----------
  start(sqld, ["--http-listen-addr", `127.0.0.1:${PLATFORM}`, "--db-path", join(dir, "platform")], "platform.log");
  start(sqld, ["--http-listen-addr", `127.0.0.1:${TENANT}`, "--db-path", join(dir, "tenant")], "tenant.log");
  for (const port of [PLATFORM, TENANT]) {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok), `sqld :${port}`);
  }

  const C = await import("../lib/platform/control.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const { libsql } = await import("../lib/db.js");
  const I = await import("../lib/platform/identity.js");
  const Reg = await import("../lib/registry/index.js");
  const { singletonId } = await import("../lib/documents/ids.js");
  const { publishDocumentsFixture } = await import("./perf-docs-fixture.js");
  const { createSession } = await import("../lib/platform/sessions.js");
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

  await C.migratePlatform(readFileSync(join(root, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
  const dbUrl = env.DATABASE_URL;
  const closed = { enabled: true, message: "DRILL-CURTAIN" };
  await C.upsertTenant({ id: "edge", name: STORE, domains: ["edge.test", "localhost"], dbUrl, config: { brand: BRAND }, secrets: { order_link_secret: "drill-edge", admin_password: "drill-edge-admin" } });
  await C.upsertTenant({ id: "other", name: "Other", domains: ["other.test"], dbUrl, config: {}, secrets: { order_link_secret: "drill-other", admin_password: "drill-other-admin" } });
  const setMaintenance = (on) => C.patchTenant("edge", { config: { maintenance: on ? closed : null } });

  await withTenant(await C.getTenant("edge"), async () => {
    await libsql.executeMultiple(readFileSync(join(root, "lib/schema.sql"), "utf8"));
    await runMigrations(libsql, await loadMigrations("tenant"));
    const now = new Date().toISOString();
    const productId = "gid://shopify/Product/9001";
    const collectionId = "gid://shopify/Collection/9001";
    await libsql.execute({
      sql: `INSERT INTO products (id, handle, title, description, description_html, tags, price_min, price_max, currency, available, total_inventory, options, created_at, updated_at, synced_at)
            VALUES (?, ?, ?, ?, ?, '[]', 999, 999, 'INR', 1, 5, '[]', ?, ?, ?)`,
      args: [productId, MARK.handle, MARK.product, MARK.description, `<p>${MARK.description}</p>`, now, now, now],
    });
    await libsql.execute({
      sql: `INSERT INTO variants (id, product_id, title, price, currency, available, selected_options, position) VALUES (?, ?, 'Default', 999, 'INR', 1, '[]', 0)`,
      args: [VARIANT_ID, productId],
    });
    await libsql.execute({
      sql: "INSERT INTO collections (id, handle, title, description, updated_at, synced_at) VALUES (?, ?, ?, '', ?, ?)",
      args: [collectionId, MARK.collectionHandle, MARK.collection, now, now],
    });
    await libsql.execute({ sql: "INSERT INTO collection_products (collection_id, product_id, position) VALUES (?, ?, 0)", args: [collectionId, productId] });
    // The marked content as published documents: the about page, a policy
    // page and the home hero, written and published through lib/documents.
    const page = (slug, title) => {
      const b = Reg.emptyBody("page");
      b.meta = { ...b.meta, slug, title };
      b.sections = Reg.legacyPageSectionsToSections([{ kind: "text", heading: title, body: [title] }]);
      return { id: null, type: "page", body: b };
    };
    const home = Reg.emptyBody("home");
    home.sections = [Reg.legacyHeroToSection({ title: MARK.hero, subtitle: MARK.hero })];
    const documents = [{ id: singletonId("home"), type: "home", body: home }, page("about", MARK.about), page("drill-policy", MARK.policy)];
    for (const d of documents) {
      const r = Reg.validateDocument(d.body, { mode: "publish", documentId: d.id ?? d.body.meta.slug });
      const errors = r.issues.filter((i) => i.severity === "error");
      if (errors.length) throw new Error(`the drill's ${d.type} document would not publish: ${JSON.stringify(errors).slice(0, 400)}`);
      d.body = r.body;
    }
    await publishDocumentsFixture({ documents });
  });

  const member = await I.createUser({ email: "member@edge.test", password: "drill-member-pass" });
  await I.addMembership(member.id, "edge", "owner");
  const stranger = await I.createUser({ email: "stranger@other.test", password: "drill-stranger-pass" });
  await I.addMembership(stranger.id, "other", "owner");
  const operator = await I.createOperator({ email: "op@edge.test", password: "drill-operator-pass" });
  const session = async (userId, kind) => (await createSession({ userId, kind, ttlMs: 864e5 })).token;
  const STAFF = `_admin=${await session(member.id, "merchant")}`;
  const OPERATOR = `_platform=${await session(operator.id, "operator")}`;
  const STRANGER = `_admin=${await session(stranger.id, "merchant")}`;
  const FORGED = "_admin=x; _platform=x; _mx=1";

  // ---------- build + serve ----------
  if (!process.argv.includes("--no-build")) {
    console.log("building…");
    const build = spawnSync("pnpm", ["exec", "next", "build"], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1e8 });
    if (build.status !== 0) throw new Error(`next build failed:\n${(build.stdout + build.stderr).slice(-2000)}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, ".next/server/middleware-manifest.json"), "utf8"));
  for (const route of ["/(storefront)/page", "/(storefront)/products/[handle]/page", "/(storefront)/search/page"]) {
    record(Boolean(manifest.functions?.[route]), `build lists ${route} as an edge function`);
  }
  // The next binary directly: a pnpm wrapper would not pass on the kill.
  start(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(WEB)], "next.log");
  await waitFor(() => req("/robots.txt").then((r) => r.status === 200), "next start");

  if (process.argv.includes("--serve")) {
    await setMaintenance(false);
    let on = false;
    process.on("SIGUSR2", async () => {
      on = !on;
      await setMaintenance(on);
      console.log(`maintenance ${on ? "ON" : "OFF"}`);
    });
    console.log(`serving http://localhost:${WEB} with maintenance OFF (pid ${process.pid}; SIGUSR2 flips it)`);
    await new Promise(() => {});
  }

  // ---------- maintenance OFF: the markers are really there ----------
  console.log("\n— maintenance OFF (anonymous): real content is visible");
  await setMaintenance(false);
  for (const p of PAGES) {
    const full = await req(p.path);
    record(full.body.includes(p.mark), `${p.name}: full page ${full.status}, shows ${p.mark}`);
    const rsc = await req(p.path, { headers: rscHeaders(p.claim) });
    record(rsc.body.includes(p.mark), `${p.name}: RSC ${rsc.status}, shows ${p.mark}`);
  }
  const offSearch = await req("/api/search?q=drillmark");
  record(offSearch.status === 200 && offSearch.body.includes(MARK.product), `/api/search ${offSearch.status}, returns the product`);
  // The real titles, to hold staff to during maintenance.
  const OPEN_TITLES = {};
  for (const p of TITLE_PAGES) {
    const titles = titlesOf((await req(p.path, { headers: { "user-agent": BROWSER_UA } })).body);
    OPEN_TITLES[p.path] = titles[0];
    record(titles.length === 1 && !/will be right back|Page not found/.test(titles[0]), `${p.name}: title "${titles.join(" | ")}"`);
  }

  // ---------- maintenance ON ----------
  await setMaintenance(true);
  console.log("\n— maintenance ON: runtime");
  for (const p of PAGES) {
    const r = await req(p.path);
    record(r.headers["x-edge-runtime"] === "1", `${p.name}: x-edge-runtime=${r.headers["x-edge-runtime"] ?? "absent"}`);
  }

  console.log("\n— maintenance ON: no real content without a verified credential");
  const VISITORS = [
    ["anonymous", undefined],
    ["forged cookies", FORGED],
    ["member of another tenant", STRANGER],
  ];
  const REQUESTS = (p) => [
    ["full page", p.path, {}],
    ["RSC, claiming the layout", p.path, rscHeaders(p.claim)],
    ["RSC, no state tree", p.path, { RSC: "1" }],
    ["RSC prefetch", p.path, rscHeaders(p.claim, { "Next-Router-Prefetch": "1" })],
    ["RSC segment prefetch", p.path, rscHeaders(p.claim, { "Next-Router-Prefetch": "1", "Next-Router-Segment-Prefetch": "/_tree" })],
    [".rsc path", p.path.replace(/(\?|$)/, ".rsc$1"), rscHeaders(p.claim)],
  ];
  for (const p of PAGES) {
    for (const [who, cookie] of VISITORS) {
      for (const [kind, path, headers] of REQUESTS(p)) {
        const r = await req(path, { cookie, headers });
        const found = leaks(r.body, path);
        record(!found.length, `${p.name}: ${who}, ${kind}: ${r.status}${found.length ? ` LEAKS ${found.join(", ")}` : ""}`);
      }
    }
  }
  for (const [who, cookie] of VISITORS) {
    const r = await req("/", { cookie });
    record(r.body.includes("DRILL-CURTAIN"), `home: ${who}, full page shows the maintenance page`);
  }
  for (const p of PAGES.slice(1)) {
    const r = await req(p.path);
    record(r.body.includes("DRILL-CURTAIN"), `${p.name}: anonymous, full page shows the maintenance page (status ${r.status})`);
  }

  console.log("\n— maintenance ON: what a crawler receives (metadata blocks the response for bots)");
  for (const p of PAGES) {
    const r = await req(p.path, { headers: { "user-agent": GOOGLEBOT_UA } });
    const found = leaks(r.body, p.path);
    record(!found.length && r.body.includes("DRILL-CURTAIN"), `${p.name}: Googlebot, full page: ${r.status}${found.length ? ` LEAKS ${found.join(", ")}` : ""}`);
  }

  console.log("\n— maintenance ON: every page is titled as closed, not as missing");
  for (const p of TITLE_PAGES) {
    for (const [ua, agent] of [["browser", BROWSER_UA], ["Googlebot", GOOGLEBOT_UA]]) {
      const titles = titlesOf((await req(p.path, { headers: { "user-agent": agent } })).body);
      record(titles.length === 1 && titles[0] === CLOSED_TITLE, `${p.name}: ${ua}, title "${titles.join(" | ")}"`);
    }
  }
  for (const p of PAGES) {
    const r = await req(p.path, { headers: rscHeaders(p.claim, { "user-agent": BROWSER_UA }) });
    record(r.body.includes(CLOSED_TITLE) && !r.body.includes("Page not found"), `${p.name}: client navigation (RSC), title is "${CLOSED_TITLE}"`);
  }

  // A tab opened before the store closed: its click gets only a 404 digest
  // (checked above, no leak) and renders the 404 it got at load, which then
  // reloads once (components/ReloadOnSoftNotFound.js). That part runs in a
  // browser, so this drill can't see it.

  console.log("\n— maintenance ON: the closed page follows the brand and stays readable");
  const curtainPage = (await req(`/products/${MARK.handle}`)).body;
  const page = curtainColours(curtainPage, "page");
  record(page.background === BRAND.background && page.color === BRAND.foreground, `page colours ${page.background} / ${page.color} (brand ${BRAND.background} / ${BRAND.foreground})`);
  for (const part of ["eyebrow", "title", "message", "signin"]) {
    const { color } = curtainColours(curtainPage, part);
    const ratio = color && page.background ? contrast(color, page.background) : 0;
    record(ratio >= 4.5, `${part}: ${color ?? "no inline colour"} on ${page.background}, ${ratio.toFixed(2)}:1`);
  }
  const visible = (/<body[\s\S]*<\/body>/.exec(curtainPage)?.[0] || "").replace(/<script[\s\S]*?<\/script>/g, "");
  record(visible.includes("DRILL-CURTAIN") && !/opacity-\d|text-zinc-\d|text-hero-muted/.test(visible), "the closed page uses no fixed grey or opacity class");

  console.log("\n— maintenance ON: verified staff still get the real site");
  const passRes = await req("/api/admin/maintenance-pass", { cookie: STAFF });
  const PASS = /_mx=([^;]+)/.exec(String(passRes.headers["set-cookie"] || ""))?.[0];
  record(Boolean(PASS), "staff session obtains a signed pass");
  for (const [who, cookie] of [["_admin session", STAFF], ["_platform session", OPERATOR], ["_mx pass", PASS]]) {
    for (const p of PAGES) {
      const full = await req(p.path, { cookie });
      record(full.body.includes(p.mark), `${p.name}: ${who}, full page ${full.status}`);
      const rsc = await req(p.path, { cookie, headers: rscHeaders(p.claim) });
      record(rsc.body.includes(p.mark), `${p.name}: ${who}, RSC ${rsc.status}`);
    }
  }
  for (const [who, cookie] of [["_admin session", STAFF], ["_mx pass", PASS]]) {
    for (const p of TITLE_PAGES) {
      const titles = titlesOf((await req(p.path, { cookie, headers: { "user-agent": BROWSER_UA } })).body);
      record(titles.length === 1 && titles[0] === OPEN_TITLES[p.path], `${p.name}: ${who}, title unchanged "${titles.join(" | ")}"`);
    }
  }

  console.log("\n— maintenance ON: shopper APIs that must close");
  const CLOSED_APIS = [
    ["GET /api/search", (cookie) => req("/api/search?q=drillmark", { cookie }), MARK.product],
    ["POST /api/wishlist", (cookie) => postJson("/api/wishlist", { items: [{ handle: MARK.handle }] }, cookie), MARK.product],
    ["GET /api/upsell", (cookie) => req("/api/upsell", { cookie }), null],
    ["POST /api/quiz/x", (cookie) => postJson("/api/quiz/x", { answers: {} }, cookie), null],
    ["GET /api/cart", (cookie) => req("/api/cart", { cookie }), null],
    ["POST /api/cart (add)", (cookie) => postJson("/api/cart", { action: "add", variantId: VARIANT_ID, quantity: 1 }, cookie), MARK.product],
  ];
  for (const [name, send, mark] of CLOSED_APIS) {
    for (const [who, cookie] of [["anonymous", undefined], ["forged cookies", FORGED], ["other tenant", STRANGER]]) {
      const r = await send(cookie);
      const found = leaks(r.body);
      record(r.status === 503 && !found.length, `${name}: ${who}: ${r.status}${found.length ? ` LEAKS ${found.join(", ")}` : ""}`);
    }
    const r = await send(STAFF);
    record(r.status !== 503 && (!mark || r.body.includes(mark)), `${name}: staff: ${r.status}${mark ? `, returns ${mark}` : ""}`);
  }
  const sitemap = await req("/sitemap.xml");
  record(!leaks(sitemap.body).length, `GET /sitemap.xml: anonymous: ${sitemap.status}, lists no catalog`);

  console.log("\n— maintenance ON: left open on purpose (reported, none may carry catalog data to an anonymous caller)");
  const notGated = (r) => !r.body.includes("STORE_MAINTENANCE");
  const OPEN = [
    ["POST /api/checkout (closes itself)", () => postJson("/api/checkout", { paymentMethod: "cod", items: [{ variantId: VARIANT_ID, quantity: 1 }] }), (r) => r.status === 503],
    ["GET /api/account", () => req("/api/account"), (r) => r.status === 200],
    ["POST /api/contact", () => postJson("/api/contact", {}), (r) => r.status < 500],
    ["POST /api/leads", () => postJson("/api/leads", {}), () => true],
    ["POST /api/track", () => postJson("/api/track", {}), () => true],
    ["POST /api/errors", () => postJson("/api/errors", {}), () => true],
    ["POST /api/exp", () => postJson("/api/exp", {}), () => true],
    ["GET /api/health", () => req("/api/health"), () => true],
    ["GET /api/media/med_000000000000000000", () => req("/api/media/med_000000000000000000"), (r) => r.status === 404],
    ["GET /api/preview (no token)", () => req("/api/preview"), () => true],
    ["GET /manifest.webmanifest", () => req("/manifest.webmanifest"), (r) => r.status === 200],
    ["GET /offline", () => req("/offline"), (r) => r.status === 200],
    ["GET /robots.txt", () => req("/robots.txt"), (r) => r.status === 200],
    ["POST /api/razorpay/webhook (must not be closed)", () => postJson("/api/razorpay/webhook", {}), notGated],
    ["POST /api/shopify/webhooks (must not be closed)", () => postJson("/api/shopify/webhooks", {}), notGated],
    ["GET /admin/login", () => req("/admin/login"), (r) => r.status === 200],
  ];
  for (const [name, send, expected] of OPEN) {
    const r = await send();
    const found = leaks(r.body);
    record(expected(r) && !found.length, `${name}: ${r.status}${found.length ? ` LEAKS ${found.join(", ")}` : ""}`);
  }
  const checkoutStaff = await postJson("/api/checkout", { paymentMethod: "cod", items: [{ variantId: VARIANT_ID, quantity: 1 }] }, STAFF);
  record(checkoutStaff.status === 503, `POST /api/checkout: staff: ${checkoutStaff.status} (closed for everyone)`);
  const consoleAuthed = await req("/admin/dashboard", { cookie: STAFF });
  record(consoleAuthed.status === 200 && !consoleAuthed.body.includes("/admin/login?"), `GET /admin/dashboard: staff: ${consoleAuthed.status}`);

  console.log("\n— maintenance switched back OFF");
  await setMaintenance(false);
  for (const p of PAGES) {
    const r = await req(p.path, { cookie: FORGED, headers: rscHeaders(p.claim) });
    record(r.body.includes(p.mark), `${p.name}: forged cookies, RSC ${r.status}, real content again`);
  }
  for (const p of TITLE_PAGES) {
    const titles = titlesOf((await req(p.path, { headers: { "user-agent": BROWSER_UA } })).body);
    record(titles[0] === OPEN_TITLES[p.path], `${p.name}: anonymous, real title again "${titles.join(" | ")}"`);
  }
  const backOn = await req("/api/search?q=drillmark");
  record(backOn.status === 200, `/api/search ${backOn.status}`);
} catch (e) {
  problems++;
  console.error(`\nDRILL ABORTED: ${e.message}`);
} finally {
  teardown();
}

console.log(`\n${checks - Math.min(problems, checks)} passed, ${problems} failed (${checks} checks)`);
if (problems) console.log(`server logs kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
process.exit(problems ? 1 : 0);
