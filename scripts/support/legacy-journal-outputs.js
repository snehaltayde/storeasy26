// What the sitemap and the /journal listing show on a legacy store (P2-READ).
//
//   node scripts/support/legacy-journal-outputs.js            prints the JSON
//   node scripts/support/legacy-journal-outputs.js <out.json> writes it
//
// Builds one throwaway legacy tenant (file databases in the checkout's root)
// with pages, campaigns and journal posts (shown, scheduled, ended, switched
// off), and records, before any publish (drafts) and with a v3 release live:
//   · app/sitemap.js's output,
//   · app/(storefront)/journal/page.js rendered to HTML (Next's SWC).
// It imports the app through relative paths, so running this same file inside
// an older checkout records that checkout's answers.
// scripts/fixtures/legacy-journal-outputs.a6d028e.json was recorded this way
// from a6d028e, and test:release-readers compares today's answers with it.
import { registerHooks, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);

// next/headers answers for one simulated request at a time.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__journalRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() { const r = req(); return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) }; }
export async function cookies() { req(); return { get: () => undefined }; }
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-journal-legacy-default.db";
process.env.PLATFORM_DB_URL = "file:.test-journal-legacy-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const DBS = [".test-journal-legacy-default.db", ".test-journal-legacy-platform.db", ".test-journal-legacy-t.db"];
for (const f of DBS) await rm(join(ROOT, f), { force: true });

const C = await import("../../lib/platform/control.js");
const { withTenant } = await import("../../lib/tenant-context.js");
const { libsql } = await import("../../lib/db.js");
const R = await import("../../lib/releases.js");
const { loadMigrations, runMigrations } = await import("../../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
await C.upsertTenant({
  id: "jl",
  name: "Journal Legacy",
  domains: ["jl.test"],
  dbUrl: "file:.test-journal-legacy-t.db",
  config: { site: { name: "Journal Legacy" }, site_url: "https://jl.test" },
  secrets: { order_link_secret: "jl-link-secret" },
});
const T = await C.getTenant("jl");
const inT = (fn) => withTenant(T, fn);
const NOW = "2026-01-01T00:00:00.000Z";

// Pages of every family. Windows are far in the past or future, so the output
// does not depend on the day it is recorded.
const PAGES = [
  { slug: "about", title: "About", family: "page", enabled: 1 },
  { slug: "shipping", title: "Shipping", family: "page", enabled: 1 },
  { slug: "hidden-policy", title: "Hidden", family: "page", enabled: 0 },
  { slug: "spring", title: "Spring sale", family: "campaign", enabled: 1, window_start: "2020-03-01T00:00:00.000Z", window_end: "2099-03-31T00:00:00.000Z" },
  { slug: "first-post", title: "First post", description: "Hello", family: "journal", enabled: 1, window_start: "2025-05-01T00:00:00.000Z" },
  { slug: "second-post", title: "Second post", description: "", family: "journal", enabled: 1, window_start: "2025-07-01T00:00:00.000Z" },
  { slug: "undated-post", title: "Undated", description: "No date", family: "journal", enabled: 1 },
  { slug: "future-post", title: "Not yet", description: "", family: "journal", enabled: 1, window_start: "2099-01-01T00:00:00.000Z" },
  { slug: "ended-post", title: "Gone", description: "", family: "journal", enabled: 1, window_start: "2020-01-01T00:00:00.000Z", window_end: "2021-01-01T00:00:00.000Z" },
  { slug: "off-post", title: "Switched off", description: "", family: "journal", enabled: 0 },
];

await inT(async () => {
  await libsql.executeMultiple(await readFile(join(ROOT, "lib/schema.sql"), "utf8"));
  await runMigrations(libsql, await loadMigrations("tenant"));
  const run = (sql, args = []) => libsql.execute({ sql, args });
  await run("INSERT INTO collections (id, handle, title, synced_at, updated_at) VALUES ('gid://shopify/Collection/1', 'serums', 'Serums', ?, ?)", [NOW, NOW]);
  await run("INSERT INTO products (id, handle, title, price_min, price_max, currency, available, synced_at, updated_at) VALUES ('gid://shopify/Product/1', 'glow-serum', 'Glow Serum', 100, 100, 'INR', 1, ?, ?)", [NOW, NOW]);
  for (const p of PAGES) {
    await run(
      "INSERT INTO cms_pages (slug, title, description, sections, enabled, effective_at, family, window_start, window_end, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
      [p.slug, p.title, p.description ?? "", JSON.stringify([{ kind: "text", heading: p.title, body: ["x"] }]), p.enabled, p.family, p.window_start ?? null, p.window_end ?? null, NOW],
    );
  }
});

// A v3 release whose pages differ from the drafts: one post renamed, one added.
const releasePages = PAGES.map((p) => ({
  slug: p.slug,
  title: p.slug === "first-post" ? "First post (live)" : p.title,
  description: p.description ?? "",
  sections: [],
  enabled: !!p.enabled,
  family: p.family,
  window_start: p.window_start ?? null,
  window_end: p.window_end ?? null,
})).concat([{ slug: "live-only-post", title: "Live only", description: "From the release", sections: [], enabled: true, family: "journal", window_start: "2025-09-01T00:00:00.000Z", window_end: null }]);

async function putLive(id, content) {
  await inT(async () => {
    await libsql.execute({
      sql: "INSERT INTO releases (id, content, content_hash, note, created_by, created_at, scheduled_for, published_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)",
      args: [id, R.stableStringify(content), `hash_${id}`, `note ${id}`, NOW, NOW],
    });
    await libsql.execute({ sql: "UPDATE release_state SET live_release_id = ?, updated_at = ? WHERE id = 1", args: [id, NOW] });
  });
}

// ---- the journal listing, rendered with Next's SWC (as test-releases does) -------
const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const STUBS = { "next/link": { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) } };
async function loadPage(file) {
  const mod = { exports: {} };
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in STUBS || deps.has(id) || id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(file), id);
      deps.set(id, await import(pathToFileURL(p.endsWith(".js") ? p : `${p}.js`).href));
    } else deps.set(id, require(id));
  }
  const req = (id) => (id in STUBS ? STUBS[id] : id === "react" ? React : id === "react/jsx-runtime" ? require("react/jsx-runtime") : deps.get(id));
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  return mod.exports;
}
const Journal = (await loadPage(join(ROOT, "app/(storefront)/journal/page.js"))).default;
const sitemap = (await import(pathToFileURL(join(ROOT, "app/sitemap.js")).href)).default;
void relative;

async function asRequest(fn) {
  globalThis.__journalRequest = { host: "jl.test" };
  try {
    return await fn();
  } finally {
    globalThis.__journalRequest = null;
  }
}

async function record() {
  const map = await asRequest(() => sitemap());
  const html = await asRequest(async () => renderToStaticMarkup(await Journal()));
  return JSON.parse(JSON.stringify({ sitemap: map, journal: html }));
}

const out = { recordedFrom: "scripts/support/legacy-journal-outputs.js", states: {} };
out.states.drafts = await record();
await putLive("rel_journal_v3", { v: 3, blocks: {}, pages: releasePages, brand: null, theme: null, product_overrides: [], collection_pins: [], placements: [], redirects: [] });
out.states.v3 = await record();

for (const f of DBS) await rm(join(ROOT, f), { force: true });
const json = JSON.stringify(out, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json);
else process.stdout.write(json);
process.exit(0);
