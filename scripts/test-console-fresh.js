// The console never shows a founder's own save as undone (P1-FIX-C, item 1).
//
// The store's row in the control plane (settings, brand, theme, identity) is
// cached for 30 seconds per server instance (lib/platform/control.js). Hosted
// runs many instances. On the harness, a Settings save followed by a reload
// showed the starter rates again and "You haven't set your own shipping rates
// yet"; after Save brand, Publishing showed nothing to publish, and once
// Publish now answered 409 (docs/cms-reviews/P1-DRILLS.md, finding 1).
//
// Here two real server instances (two node processes, each with its own cache
// at the real 30-second TTL) share one control plane. One saves; the other
// answers at once, through the real /api/admin routes and the real Settings
// and Publishing pages (compiled with Next's SWC, components stubbed). Shopper
// reads keep the cache, and are checked to still do so.
//   pnpm test:console-fresh
import { readFile, rm, readdir } from "node:fs/promises";
import { registerHooks, createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(import.meta.url);
const INSTANCE = process.argv[2] === "--instance";
const HOST = "fresh.test";
const ALIAS = "alias.fresh.test"; // a second domain of the same store

// next/headers and next/navigation stand-ins: a page or route reads the
// request this suite hands it through globalThis.__freshRequest.
const NEXT_HEADERS =
  "data:text/javascript," +
  encodeURIComponent(`
    const req = () => { const q = globalThis.__freshRequest; if (!q) throw new Error("headers() outside a request"); return q; };
    export async function headers() { return new Headers({ host: req().host }); }
    export async function cookies() { const q = req(); return { get: (n) => (q.cookies?.[n] != null ? { name: n, value: q.cookies[n] } : undefined) }; }
    export function draftMode() { return { isEnabled: false }; }
  `);
const NEXT_NAVIGATION =
  "data:text/javascript," +
  encodeURIComponent(`
    export function notFound() { const e = new Error("NEXT_NOT_FOUND"); e.digest = "NEXT_NOT_FOUND"; throw e; }
    export function redirect(to) { const e = new Error("NEXT_REDIRECT " + to); e.digest = "NEXT_REDIRECT"; throw e; }
    export const permanentRedirect = redirect;
  `);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: NEXT_HEADERS, shortCircuit: true };
    if (spec === "next/navigation") return { url: NEXT_NAVIGATION, shortCircuit: true };
    if (spec === "next/server") return next("next/server.js", ctx);
    if (spec.startsWith("@/")) return next(pathToFileURL(join(root, spec.endsWith(".js") ? spec.slice(2) : `${spec.slice(2)}.js`)).href, ctx);
    return next(spec, ctx);
  },
});

const FILES = { platform: ".test-fresh-platform.db", tenant: ".test-fresh-tenant.db", def: ".test-fresh-default.db" };
Object.assign(process.env, {
  TURSO_DB_URL: "",
  TURSO_DB_AUTH_TOKEN: "",
  DATABASE_URL: `file:${FILES.def}`,
  PLATFORM_DB_URL: `file:${FILES.platform}`,
  PLATFORM_DB_TOKEN: "",
  PLATFORM_SECRET: "test-platform-secret-fresh",
  PLATFORM_ADMIN_PASSWORD: "operator-test-pw-fresh",
  ALERT_WEBHOOK_URL: "",
  RATE_LIMIT_DISABLED: "1",
});
// The real TTL. Other suites shorten it; this one is about what it hides.
delete process.env.PLATFORM_CACHE_MS;
delete process.env.PLATFORM_STALE_MS;

if (INSTANCE) await serve();
else await main();

// =============================================================================
// One server instance: answers JSON lines on stdin, one at a time.
// =============================================================================
async function serve() {
  const C = await import("../lib/platform/control.js");
  const { withTenant } = await import("../lib/tenant-context.js");
  const TR = await import("../lib/tenant-request.js");
  const { previewToken } = await import("../lib/releases.js");
  const { claimDomain } = await import("../lib/platform/domains.js");

  // Every read of the store's row, counted; and a switch that makes them fail
  // (the control plane not answering), for the negative cases.
  const client = C.platformDb();
  const send = client.execute.bind(client);
  const stats = { rowReads: 0, failRows: false };
  client.execute = (stmt, ...rest) => {
    const sql = typeof stmt === "string" ? stmt : stmt?.sql || "";
    if (/^\s*SELECT \* FROM tenants WHERE id = \?/.test(sql)) {
      stats.rowReads++;
      if (stats.failRows) return Promise.reject(Object.assign(new TypeError("fetch failed"), { name: "TypeError" }));
    }
    return send(stmt, ...rest);
  };

  const ROUTES = {
    "/api/admin/settings": "app/api/admin/settings/route.js",
    "/api/admin/brand": "app/api/admin/brand/route.js",
    "/api/admin/theme": "app/api/admin/theme/route.js",
    "/api/admin/releases": "app/api/admin/releases/route.js",
    "/api/platform/costs": "app/api/platform/costs/route.js",
    "/api/platform/tenants/fresh": "app/api/platform/tenants/[id]/route.js",
  };
  const mods = {};
  for (const [p, f] of Object.entries(ROUTES)) mods[p] = await import(pathToFileURL(join(root, f)).href);

  const request = (path, { method = "GET", body, cookies = {}, host = HOST } = {}) => {
    const u = new URL(`http://${host}${path}`);
    const h = { host, origin: u.origin };
    return {
      method,
      url: u.href,
      nextUrl: u,
      headers: { get: (k) => h[String(k).toLowerCase()] ?? null },
      cookies: { get: (n) => (cookies[n] != null ? { name: n, value: cookies[n] } : undefined) },
      json: async () => body ?? {},
    };
  };

  // The console's pages, compiled the way Next compiles them, with the
  // client components they hand data to replaced by stubs that keep the props.
  const swc = require("next/dist/build/swc/index.js");
  await swc.loadBindings();
  const React = require("react");
  const nextHeaders = await import(NEXT_HEADERS);
  const nextNavigation = await import(NEXT_NAVIGATION);
  const SettingsAdmin = () => null;
  const ReleasesAdmin = () => null;
  const stubs = {
    "next/headers": nextHeaders,
    "next/navigation": nextNavigation,
    "@/components/admin/SettingsAdmin": { __esModule: true, default: SettingsAdmin },
    "@/components/admin/OpsPanels": { __esModule: true, default: () => null },
    "@/components/admin/ReleasesAdmin": { __esModule: true, default: ReleasesAdmin },
    "@/components/console/PageHeader": { PageHeader: () => null },
  };
  async function loadPage(rel) {
    const file = join(root, rel);
    const { code } = await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    });
    const mod = { exports: {} };
    const req = (id) => {
      if (id in stubs) return stubs[id];
      if (id.startsWith("@/")) return require(join(root, id.endsWith(".js") ? id.slice(2) : `${id.slice(2)}.js`));
      if (id.startsWith(".")) return require(resolve(dirname(file), id));
      return require(id);
    };
    new Function("require", "module", "exports", code)(req, mod, mod.exports);
    return mod.exports.default;
  }
  const pages = {
    settings: { fn: await loadPage("app/(console)/admin/(authed)/settings/page.js"), stub: SettingsAdmin },
    releases: { fn: await loadPage("app/(console)/admin/(authed)/releases/page.js"), stub: ReleasesAdmin },
  };
  function* walk(node) {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) yield* walk(n);
      return;
    }
    if (!node.props) return;
    yield node;
    yield* walk(node.props.children);
  }
  const inRequest = async (cookies, fn) => {
    globalThis.__freshRequest = { host: HOST, cookies };
    try {
      return await fn();
    } finally {
      globalThis.__freshRequest = null;
    }
  };

  const ops = {
    async api({ path, method = "GET", body, cookies, params, host }) {
      const res = await mods[path][method](request(path, { method, body, cookies, host }), { params: Promise.resolve(params || {}) });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async page({ name, cookies }) {
      const { fn, stub } = pages[name];
      return inRequest(cookies, async () => {
        try {
          const tree = await fn();
          const el = [...walk(tree)].find((e) => e.type === stub);
          return { props: el ? el.props : null };
        } catch (e) {
          return { threw: e.digest || e.name, message: String(e.message).slice(0, 200) };
        }
      });
    },
    // A shopper's page: the storefront's tfetch (lib/tenant-request.js), with
    // or without this store's preview cookie.
    async storefront({ preview = false }) {
      const cookies = {};
      if (preview === "forged") cookies._preview = `p.${Math.floor(Date.now() / 1000) + 600}.0123456789abcdef0123`;
      else if (preview) {
        const t = await C.getTenant("fresh");
        cookies._preview = await withTenant(t, () => previewToken());
      }
      return inRequest(cookies, async () => {
        try {
          return { value: await TR.tfetch(async () => { const { currentTenant } = await import("../lib/tenant-context.js"); const c = currentTenant()?.config || {}; return { brand: c.brand || null, shipping: c.shipping_config || null, name: c.site?.name || null }; }) };
        } catch (e) {
          return { threw: e.digest || e.name || e.code };
        }
      });
    },
    async claimDomain({ host }) {
      await claimDomain({ host, tenantId: "fresh", preVerified: true });
      return { ok: true };
    },
    async stats({ reset = false, failRows } = {}) {
      const out = { ...stats };
      if (reset) stats.rowReads = 0;
      if (failRows !== undefined) stats.failRows = failRows;
      return out;
    },
  };

  const PREFIX = "@@fresh ";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { id, op, ...args } = JSON.parse(line);
    let out;
    try {
      out = await ops[op](args);
    } catch (e) {
      out = { error: String(e?.stack || e).slice(0, 600) };
    }
    process.stdout.write(`${PREFIX}${JSON.stringify({ id, out })}\n`);
  }
}

// =============================================================================
// The suite: set up one control plane and one store, then two instances.
// =============================================================================
async function main() {
  const dbs = Object.values(FILES);
  const cleanup = async () => {
    for (const f of dbs) await rm(join(root, f), { force: true });
  };
  await cleanup();

  const { createClient } = await import("@libsql/client");
  const C = await import("../lib/platform/control.js");
  const Id = await import("../lib/platform/identity.js");
  const Sess = await import("../lib/platform/sessions.js");
  const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
  const { platformSessionToken } = await import("../lib/platform/admin-auth.js");
  const { CONSOLE_API_PREFIX } = await import("../lib/tenant-request.js").catch(() => ({}));

  await C.migratePlatform(await readFile(join(root, "lib/platform/schema.sql"), "utf8"));
  await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
  const tc = createClient({ url: `file:${FILES.tenant}` });
  await tc.executeMultiple(await readFile(join(root, "lib/schema.sql"), "utf8"));
  await runMigrations(tc, await loadMigrations("tenant"));
  tc.close();
  await C.upsertTenant({ id: "fresh", name: "Fresh Co", domains: [HOST, ALIAS], dbUrl: `file:${FILES.tenant}`, config: { site: { name: "Fresh Co" } }, secrets: {} });
  const owner = await Id.createUser({ email: "owner@fresh.test", password: "owner-pass-fresh" });
  await Id.addMembership(owner.id, "fresh", "owner");
  const OWNER = { _admin: (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 3_600_000 })).token };
  const OPERATOR = { _platform: await platformSessionToken() };
  const row = async () => {
    const r = (await C.platformDb().execute({ sql: "SELECT config, domains FROM tenants WHERE id = 'fresh'", args: [] })).rows[0];
    return { config: JSON.parse(r.config || "{}"), domains: JSON.parse(r.domains || "[]") };
  };

  let pass = 0;
  let fail = 0;
  async function t(name, fn) {
    try {
      await fn();
      pass++;
      console.log(`✓ ${name}`);
    } catch (e) {
      fail++;
      console.error(`✗ ${name}\n   ${e.message}`);
    }
  }
  const eq = (got, want, label = "") => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
  };
  const ok = (cond, label = "") => {
    if (!cond) throw new Error(`${label} expected truthy`);
  };

  // --- the two instances ---------------------------------------------------------
  const children = [];
  function instance(name) {
    const env = { ...process.env };
    delete env.PLATFORM_CACHE_MS;
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--instance"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(p);
    const waiting = new Map();
    let seq = 0;
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    createInterface({ input: p.stdout }).on("line", (line) => {
      if (!line.startsWith("@@fresh ")) return; // the app's own log lines
      const { id, out } = JSON.parse(line.slice(8));
      waiting.get(id)?.(out);
      waiting.delete(id);
    });
    p.on("exit", (code) => {
      for (const done of waiting.values()) done({ error: `instance ${name} exited (${code}): ${stderr.slice(-600)}` });
      waiting.clear();
    });
    const call = (op, args = {}) =>
      new Promise((done) => {
        const id = ++seq;
        waiting.set(id, done);
        p.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      }).then((out) => {
        if (out?.error) throw new Error(`instance ${name}: ${out.error}`);
        return out;
      });
    return {
      name,
      call,
      api: (method, path, body, cookies = OWNER, params, host) => call("api", { method, path, body, cookies, params, host }),
      page: (pageName, cookies = OWNER) => call("page", { name: pageName, cookies }),
      storefront: (preview = false) => call("storefront", { preview }),
      stats: (o) => call("stats", o),
    };
  }
  const A = instance("A");
  const B = instance("B");
  const stopAll = () => {
    for (const p of children) if (p.exitCode == null) p.kill("SIGTERM");
  };

  const RATES = { currency: "INR", basis: "net", flatRate: 79, freeThreshold: 1999, codFee: 49, codFeeWaivedAt: null, zones: [] };
  const BRAND = { accent: "#2563eb", background: "#ffffff", foreground: "#0a0a0b", radius: "lg", type_scale: "regular", button_shape: "rounded", section_spacing: "regular" };
  const shippingOf = (s) => ({ flatRate: s.flatRate, freeThreshold: s.freeThreshold, codFee: s.codFee });

  try {
    console.log("— Settings: saved on one instance, read on another at once");

    await t("before any save, both instances show the starter rates and the notice (and have cached the store's row)", async () => {
      for (const X of [A, B]) {
        const r = await X.api("GET", "/api/admin/settings");
        eq(r.status, 200, `${X.name} status:`);
        eq(shippingOf(r.body.settings.shipping), { flatRate: 79, freeThreshold: 999, codFee: 49 }, `${X.name} starter rates:`);
        eq(r.body.settings.shipping_is_default, true, `${X.name} notice:`);
        const p = await X.page("settings");
        eq(p.props?.initial?.shipping_is_default, true, `${X.name} Settings page notice: ${JSON.stringify(p)}`);
        await X.storefront(); // a shopper's page caches the row too
      }
    });

    await t("THE BUG: rates saved through instance B; a reload served by instance A shows them at once, with no starter notice", async () => {
      const put = await B.api("PUT", "/api/admin/settings", { shipping: RATES });
      eq(put.status, 200, `save: ${JSON.stringify(put.body).slice(0, 200)}`);
      eq(shippingOf(put.body.settings.shipping), { flatRate: 79, freeThreshold: 1999, codFee: 49 }, "the save's own answer:");
      const api = await A.api("GET", "/api/admin/settings");
      eq(shippingOf(api.body.settings.shipping), { flatRate: 79, freeThreshold: 1999, codFee: 49 }, "GET /api/admin/settings on A:");
      eq(api.body.settings.shipping_is_default, false, "A's API still says the rates are the starter ones:");
      const page = await A.page("settings");
      eq(shippingOf(page.props.initial.shipping), { flatRate: 79, freeThreshold: 1999, codFee: 49 }, "the Settings page on A:");
      eq(page.props.initial.shipping_is_default, false, "the Settings page on A still shows \"You haven't set your own shipping rates yet\":");
    });

    await t("the store's name (identity) saved on B shows on A's Settings page and API at once", async () => {
      const put = await B.api("PUT", "/api/admin/settings", { identity: { name: "Fresh Co Renamed", support_email: "", support_phone: "" } });
      eq(put.status, 200, "save:");
      eq((await A.api("GET", "/api/admin/settings")).body.settings.identity.name, "Fresh Co Renamed", "A's API:");
      eq((await A.page("settings")).props.initial.identity.name, "Fresh Co Renamed", "A's page:");
    });

    await t("the same instance: a save then a reload on A shows the save (the page and the API agree)", async () => {
      const put = await A.api("PUT", "/api/admin/settings", { shipping: { ...RATES, codFee: 39 } });
      eq(put.status, 200, "save:");
      eq((await A.page("settings")).props.initial.shipping.codFee, 39, "page:");
      eq((await A.api("GET", "/api/admin/settings")).body.settings.shipping.codFee, 39, "API:");
      eq((await B.api("GET", "/api/admin/settings")).body.settings.shipping.codFee, 39, "and B:");
    });

    console.log("— Brand and theme: Publishing sees the change at once");

    await t("set-up: publish once, so Publishing has a live version to compare with", async () => {
      const r = await A.api("POST", "/api/admin/releases", { action: "publish", note: "baseline" });
      eq(r.status, 200, `publish: ${JSON.stringify(r.body).slice(0, 300)}`);
      for (const X of [A, B]) {
        const v = await X.api("GET", "/api/admin/releases");
        eq([v.body.dirty, v.body.diff?.items?.length ?? null], [false, 0], `${X.name} after the baseline:`);
        eq((await X.page("releases")).props?.initial?.dirty, false, `${X.name}'s Publishing page:`);
      }
    });

    await t("THE BUG: brand saved on B; Publishing on A (page and API) lists the brand change at once", async () => {
      const put = await B.api("PUT", "/api/admin/brand", { brand: BRAND });
      eq(put.status, 200, `save brand: ${JSON.stringify(put.body).slice(0, 200)}`);
      const v = await A.api("GET", "/api/admin/releases");
      eq(v.body.dirty, true, "A's Publishing API still says nothing to publish:");
      ok(v.body.diff.items.some((i) => i.type === "brand"), `A's change list: ${JSON.stringify(v.body.diff.items)}`);
      const p = await A.page("releases");
      eq(p.props.initial.dirty, true, "A's Publishing page still says nothing to publish:");
      ok(p.props.initial.diff.items.some((i) => i.type === "brand"), `A's page change list: ${JSON.stringify(p.props.initial.diff.items)}`);
      eq(p.props.initial.draftHash, v.body.draftHash, "the page and the API agree on what would ship:");
    });

    await t("THE BUG: Publishing opened on B, Publish now answered by A: 200, not 409, and the live brand is the saved one", async () => {
      const opened = await B.page("releases");
      const r = await A.api("POST", "/api/admin/releases", { action: "publish", note: "brand", expectedDraftHash: opened.props.initial.draftHash });
      eq(r.status, 200, `Publish now: ${r.body?.code} ${r.body?.error}`);
      eq(await liveBrand(), BRAND.accent, "the live brand:");
      eq((await B.api("GET", "/api/admin/releases")).body.dirty, false, "after publishing, B has nothing left to publish:");
    });
    async function liveBrand() {
      const c = createClient({ url: `file:${FILES.tenant}` });
      try {
        const s = (await c.execute("SELECT r.content FROM release_state s JOIN releases r ON r.id = s.live_release_id WHERE s.id = 1")).rows[0];
        return JSON.parse(s.content).brand?.accent ?? null;
      } finally {
        c.close();
      }
    }

    await t("a theme kit applied on B shows on A's Theme API and in A's Publishing at once", async () => {
      const r = await B.api("POST", "/api/admin/theme", { action: "apply", kit: "glow", withPresets: false, withBrand: false });
      eq(r.status, 200, `apply: ${JSON.stringify(r.body).slice(0, 200)}`);
      eq((await A.api("GET", "/api/admin/theme")).body.theme?.kit, "glow", "A's Theme API:");
      const v = await A.api("GET", "/api/admin/releases");
      ok(v.body.diff.items.some((i) => i.type === "theme"), `A's change list: ${JSON.stringify(v.body.diff.items)}`);
    });

    console.log("— what still uses the cache, and what a fresh read costs");

    await t("every console request reads the store's row once; a shopper's page reads it not at all (cached)", async () => {
      await A.storefront(); // warm
      await A.stats({ reset: true });
      await A.api("GET", "/api/admin/settings");
      eq((await A.stats({ reset: true })).rowReads, 1, "GET /api/admin/settings:");
      await A.page("settings");
      ok((await A.stats({ reset: true })).rowReads >= 1, "the Settings page reads it");
      await A.storefront();
      await A.storefront();
      eq((await A.stats({ reset: true })).rowReads, 0, "two shopper pages:");
    });

    await t("a shopper's page on A keeps the cached row until it expires (rates saved on B aren't fetched per request)", async () => {
      await A.storefront(); // A's cached copy
      const put = await B.api("PUT", "/api/admin/settings", { shipping: { ...RATES, flatRate: 59 } });
      eq(put.status, 200, "save:");
      eq((await A.storefront()).value.shipping.flatRate, 79, "shopper page on A, inside the 30 seconds:");
      eq((await A.api("GET", "/api/admin/settings")).body.settings.shipping.flatRate, 59, "while A's console reads the save:");
    });

    await t("a founder's preview session on A reads the row fresh (drafts come from it); a forged preview cookie does not", async () => {
      await A.storefront(); // re-warm A's cache with what it holds now
      const put = await B.api("PUT", "/api/admin/brand", { brand: { ...BRAND, accent: "#dc2626" } });
      eq(put.status, 200, "save brand:");
      eq((await A.storefront(false)).value.brand?.accent, BRAND.accent, "a shopper on A, inside the 30 seconds (cached):");
      await A.stats({ reset: true });
      eq((await A.storefront("forged")).value.brand?.accent, BRAND.accent, "a forged preview cookie on A (cached):");
      eq((await A.stats({ reset: true })).rowReads, 0, "a forged preview cookie read the row:");
      eq((await A.storefront(true)).value.brand?.accent, "#dc2626", "the founder's preview on A:");
      ok((await A.stats({ reset: true })).rowReads >= 1, "the preview didn't read the row");
    });

    await t("NEGATIVE: when the control plane can't be read, the console says so (503); it never falls back to the cached row", async () => {
      await A.api("GET", "/api/admin/settings"); // A has a recent copy
      await A.stats({ failRows: true });
      try {
        const r = await A.api("GET", "/api/admin/settings");
        eq(r.status, 503, `console API: ${JSON.stringify(r.body)}`);
        const p = await A.page("settings");
        ok(p.threw && !p.props, `the Settings page shows its error screen, not settings: ${JSON.stringify(p).slice(0, 200)}`);
        // shoppers keep the last good copy during an outage, as before
        ok((await A.storefront()).value, "a shopper's page still answers from the last good copy");
      } finally {
        await A.stats({ failRows: false });
      }
    });

    console.log("— the operator console: no write puts back an old copy");

    await t("an operator's cost budget set on A doesn't undo the brand the founder just saved on B", async () => {
      await A.api("GET", "/api/admin/settings");
      await A.api("POST", "/api/platform/costs", { budget: { tenant: "fresh", amount: 1000 } }, OPERATOR); // A caches the row
      const put = await B.api("PUT", "/api/admin/brand", { brand: { ...BRAND, accent: "#16a34a" } });
      eq(put.status, 200, "save brand:");
      const r = await A.api("POST", "/api/platform/costs", { budget: { tenant: "fresh", amount: 5000 } }, OPERATOR);
      eq(r.status, 200, `budget: ${JSON.stringify(r.body)}`);
      const { config } = await row();
      eq([config.brand?.accent, config.cost_budget], ["#16a34a", 5000], "stored brand and budget:");
    });

    await t("an operator's edit of the store's details on A doesn't undo the tagline the founder just saved on B", async () => {
      await A.api("GET", "/api/platform/tenants/fresh", undefined, OPERATOR, { id: "fresh" }); // A caches the row
      const put = await B.api("PUT", "/api/admin/settings", { identity: { name: "Fresh Co", support_email: "", support_phone: "", tagline: "Fresh every day" } });
      eq(put.status, 200, "save identity:");
      const r = await A.api("PATCH", "/api/platform/tenants/fresh", { update: { name: "Fresh Co", support_email: "help@fresh.test" } }, OPERATOR, { id: "fresh" });
      eq(r.status, 200, `operator update: ${JSON.stringify(r.body)}`);
      const { config } = await row();
      eq([config.site?.tagline, config.site?.support_email], ["Fresh every day", "help@fresh.test"], "stored tagline and email:");
      const detail = await A.api("GET", "/api/platform/tenants/fresh", undefined, OPERATOR, { id: "fresh" });
      eq(detail.status, 200, "detail:");
    });

    await t("a domain claimed on A doesn't drop one B added a moment ago", async () => {
      await A.call("claimDomain", { host: "first.fresh.test" }); // A caches the row
      await B.call("claimDomain", { host: "second.fresh.test" });
      await A.call("claimDomain", { host: "third.fresh.test" });
      const { domains } = await row();
      for (const d of [HOST, "first.fresh.test", "second.fresh.test", "third.fresh.test"]) ok(domains.includes(d), `${d} missing: ${JSON.stringify(domains)}`);
    });

    console.log("— the store's status and domains, as the console sees them");

    await t("a store suspended through instance B is closed to its console on A at once; reopened, it opens at once", async () => {
      eq((await A.api("GET", "/api/admin/settings")).status, 200, "before:");
      const off = await B.api("PATCH", "/api/platform/tenants/fresh", { status: "suspended" }, OPERATOR, { id: "fresh" });
      eq(off.status, 200, `suspend: ${JSON.stringify(off.body)}`);
      const closed = await A.api("GET", "/api/admin/settings");
      eq([closed.status, closed.body?.code], [503, "TENANT_SUSPENDED"], "A's console while suspended:");
      // C starts while the store is closed, so its own host index says "suspended"
      const C3 = instance("C");
      eq((await C3.api("GET", "/api/admin/settings")).body?.code, "TENANT_SUSPENDED", "C's console while suspended:");
      const on = await B.api("PATCH", "/api/platform/tenants/fresh", { status: "active" }, OPERATOR, { id: "fresh" });
      eq(on.status, 200, `reactivate: ${JSON.stringify(on.body)}`);
      eq((await A.api("GET", "/api/admin/settings")).status, 200, "A's console once reopened:");
      eq((await C3.api("GET", "/api/admin/settings")).status, 200, "C's console once reopened (its index still says suspended):");
    });

    await t("a domain removed through B no longer opens the console on A", async () => {
      eq((await A.api("GET", "/api/admin/settings", undefined, OWNER, undefined, ALIAS)).status, 200, "the second domain, before:");
      const { domains } = await row();
      const r = await B.api("PATCH", "/api/platform/tenants/fresh", { update: { domains: domains.filter((d) => d !== ALIAS) } }, OPERATOR, { id: "fresh" });
      eq(r.status, 200, `remove the domain: ${JSON.stringify(r.body)}`);
      eq((await A.api("GET", "/api/admin/settings", undefined, OWNER, undefined, ALIAS)).status, 404, "the removed domain on A:");
      eq((await A.api("GET", "/api/admin/settings")).status, 200, "the store's own domain on A:");
    });

    console.log("— every console path is covered");

    await t("every console page takes tfetch from lib/console-request.js, never the cached one", async () => {
      const walk = async (dir) => {
        const out = [];
        for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
          const rel = join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(rel)));
          else if (e.name.endsWith(".js")) out.push(rel);
        }
        return out;
      };
      const files = await walk("app/(console)");
      let users = 0;
      for (const f of files) {
        const src = await readFile(join(root, f), "utf8");
        ok(!src.includes("@/lib/tenant-request"), `${f} reads the store through the cached path`);
        if (/\btfetch\(/.test(src)) {
          users++;
          ok(src.includes('import { tfetch } from "@/lib/console-request";'), `${f} uses tfetch without the console's import`);
        }
      }
      ok(users >= 30, `found ${users} console files using tfetch`);
      const cr = await readFile(join(root, "lib/console-request.js"), "utf8");
      ok(/fresh: true/.test(cr), "lib/console-request.js doesn't ask for fresh reads");
    });

    await t("every /api/admin route resolves the store through tenantHandler (which reads fresh there), or reads no store", async () => {
      eq(CONSOLE_API_PREFIX, "/api/admin/", "the console API prefix:");
      const walk = async (dir) => {
        const out = [];
        for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
          const rel = join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(rel)));
          else if (e.name === "route.js") out.push(rel);
        }
        return out;
      };
      const routes = await walk("app/api/admin");
      ok(routes.length >= 30, `found ${routes.length} routes`);
      for (const f of routes) {
        const src = await readFile(join(root, f), "utf8");
        if (src.includes("tenantHandler(")) continue;
        ok(!/currentTenant|tenantOwnCfg|tenantCfg|tenantId\(|@\/lib\/db/.test(src), `${f} reads the store without tenantHandler`);
      }
    });
  } finally {
    stopAll();
    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
