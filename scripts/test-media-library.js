// The media screen (docs/plans/phase-2.md "Line 5"): the paged library read,
// who may use it, and what support's page holds.
//   pnpm test:media-library
//   1. lib/admin/media-library.js listLibrary on a file database: 50 a page
//      by cursor with no gap or repeat under every sort, the Active /
//      Archived tabs and their counts, search by name or alt (literal),
//      the type filter, thumbs by mediaUrl and never a blob, refused input,
//      a store before migration 0025
//   2. the route, every caller (support, the least-trusted, first): the
//      library and the usage PUT are reads; upload, alt, archive and delete
//      are refused to support (and change nothing); signed out is 401;
//      another store's med_ id is 404 or changes nothing there
//   3. the page as support, staff and signed out (scripts/support/page-harness.js):
//      what the screen is handed
//   4. the screen's markup as support and as staff (Next's SWC, react-dom/server):
//      no upload input, no alt field, no archive or delete for support
//   5. the upload goes only through uploadImage; no delete can be forced
// File databases only; outside services blanked, the network blocked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.DATABASE_URL = "file:.test-mlib-default.db";
process.env.PLATFORM_CACHE_MS = "50";
H.blockNetwork();

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n   ")}`);
  }
}
const eq = (got, want, label = "") => {
  const [g, w] = [JSON.stringify(got), JSON.stringify(want)];
  if (g !== w) throw new Error(`${label} expected ${w}, got ${g}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};
const started = Date.now();

// --- the fixture ----------------------------------------------------------------
const store = await H.makeRoleStore({ name: "mlib" });
const { a, b, call } = store;
const L = await import("../lib/admin/media-library.js");
const MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const B_CANARY = "cnybmedia0";

async function plant(t, rows) {
  const c = t.client();
  try {
    for (const r of rows) {
      await c.execute({
        sql: "INSERT INTO media (id, filename, mime, size, width, height, alt, variant, parent_id, sha256, data, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [r.id, r.filename, r.mime, r.size, r.width ?? null, r.height ?? null, r.alt ?? "", r.variant ?? null, r.parent_id ?? null, `sha-${r.id}`, new Uint8Array([1, 2, 3]), r.created_at, r.archived_at ?? null],
      });
    }
  } finally {
    c.close();
  }
}
const pad = (i) => String(i).padStart(3, "0");
// 57 active originals (one second apart, two share a time), 3 archived, thumbs for the even ones
const originals = [];
for (let i = 1; i <= 60; i++) {
  originals.push({
    id: `med_a${pad(i)}`,
    filename: i === 7 ? "100%_real.png" : i === 8 ? "Summer-Banner.JPG" : `photo-${pad(i)}.${["png", "jpg", "webp", "gif", "svg"][i % 5]}`,
    mime: MIMES[i % 5],
    size: 1000 + ((i * 7919) % 50_000),
    width: 800,
    height: 600,
    alt: i === 9 ? "A summer banner on the beach" : "",
    created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, i === 12 ? 11 : i)).toISOString(),
    archived_at: i > 57 ? "2026-11-20T00:00:00.000Z" : null,
  });
}
const thumbs = originals.filter((_, i) => i % 2 === 1).map((o) => ({ id: `${o.id}_t`, filename: `thumb-${o.filename}`, mime: "image/webp", size: 100, variant: "thumb", parent_id: o.id, created_at: o.created_at }));
await plant(a, [...originals, ...thumbs]);
await plant(b, [{ id: "med_bonly", filename: `${B_CANARY}.png`, mime: "image/png", size: 10, alt: "", created_at: "2026-11-02T00:00:00.000Z" }]);
const active = originals.filter((o) => !o.archived_at);

const all = async (opts) => {
  const out = [];
  let cursor = null;
  let pages = 0;
  do {
    const r = await a.run(() => L.listLibrary({ ...opts, cursor }));
    out.push(...r.items);
    cursor = r.nextCursor;
    pages++;
    if (pages > 10) throw new Error("no end to the pages");
  } while (cursor);
  return { items: out, pages };
};
const sorted = (rows, key, dir) => [...rows].sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0) * (dir === "desc" ? -1 : 1));

console.log("— 1. listLibrary");
await t("the first page: 50 originals, newest first, a next cursor, and the tab counts", async () => {
  const r = await a.run(() => L.listLibrary({}));
  eq(r.items.length, 50, "page size:");
  eq(r.items.map((m) => m.id), sorted(active, "created_at", "desc").slice(0, 50).map((m) => m.id), "order:");
  ok(typeof r.nextCursor === "string" && r.nextCursor.length > 0, "a next cursor:");
  eq(r.counts, { active: 57, archived: 3 });
});
await t("every sort pages through all 57 active files with no gap or repeat (ties broken by id)", async () => {
  const want = { newest: sorted(active, "created_at", "desc"), oldest: sorted(active, "created_at", "asc"), name: sorted(active, "filename", "asc"), size: sorted(active, "size", "desc") };
  for (const sort of L.LIBRARY_SORTS) {
    const { items, pages } = await all({ sort });
    eq(pages, 2, `${sort} pages:`);
    eq(items.map((m) => m.id), want[sort].map((m) => m.id), `${sort}:`);
  }
});
await t("Archived lists only archived files; a variant is never an item; each item has its thumb's address and never a blob", async () => {
  const r = await a.run(() => L.listLibrary({ archived: "archived" }));
  eq(r.items.map((m) => m.id).sort(), ["med_a058", "med_a059", "med_a060"]);
  ok(r.items.every((m) => m.archived_at), "archived_at:");
  const { items } = await all({});
  ok(items.every((m) => !m.id.endsWith("_t")), "no variants:");
  const keys = ["id", "filename", "mime", "size", "width", "height", "alt", "created_at", "archived_at", "url", "thumbUrl"];
  ok(items.every((m) => JSON.stringify(Object.keys(m)) === JSON.stringify(keys)), "only the listed keys (no data, sha256 or storage_url):");
  const two = items.find((m) => m.id === "med_a002");
  const one = items.find((m) => m.id === "med_a001");
  eq([two.url, two.thumbUrl, one.thumbUrl], ["/api/media/med_a002", "/api/media/med_a002_t", "/api/media/med_a001"]);
});
await t("search matches the file name or the alt text, any case, and % or _ are plain characters", async () => {
  eq((await a.run(() => L.listLibrary({ q: "summer" }))).items.map((m) => m.id).sort(), ["med_a008", "med_a009"]);
  eq((await a.run(() => L.listLibrary({ q: "100%" }))).items.map((m) => m.id), ["med_a007"]);
  eq((await a.run(() => L.listLibrary({ q: "%" }))).items.map((m) => m.id), ["med_a007"]);
  eq((await a.run(() => L.listLibrary({ q: "o_0" }))).items.length, 0, "_ is not a wildcard:");
  const r = await a.run(() => L.listLibrary({ q: "photo-05" }));
  eq(r.counts, { active: 8, archived: 2 }, "the counts follow the search (photo-050 to photo-059):");
});
await t("the type filter: one mime per type, and the counts follow it", async () => {
  for (const [type, mime] of Object.entries(L.LIBRARY_TYPES)) {
    const r = await a.run(() => L.listLibrary({ type }));
    ok(r.items.length > 0 && r.items.every((m) => m.mime === mime), `${type}:`);
    eq(r.counts.active + r.counts.archived, originals.filter((o) => o.mime === mime).length, `${type} counts:`);
  }
});
await t("refused input: an unknown sort, type or tab, a search over 200 characters, a forged cursor, a cursor from another sort", async () => {
  const first = await a.run(() => L.listLibrary({ sort: "name" }));
  for (const bad of [{ sort: "random" }, { type: "bmp" }, { archived: "all" }, { q: "x".repeat(201) }, { cursor: "bm90LWpzb24" }, { cursor: first.nextCursor }]) {
    const e = await a.run(() => L.listLibrary(bad)).then(() => null, (x) => x);
    ok(e?.name === "LibraryQueryError" && e.status === 400 && !/cursor|sql|json/i.test(e.message), `${JSON.stringify(bad).slice(0, 60)}:`);
  }
});
await t("a store before migration 0025 (no archived_at) lists every file as active and has nothing archived", async () => {
  const F = await import("./support/tenant-fixture.js");
  const old = await F.makeTenant({ name: "mlib-0024", stage: "0024" });
  try {
    const c = old.client();
    await c.execute({ sql: "INSERT INTO media (id, filename, mime, size, alt, sha256, data, created_at) VALUES ('med_old', 'old.png', 'image/png', 5, '', 's', x'00', '2026-01-01T00:00:00Z')", args: [] });
    c.close();
    const r = await old.run(() => L.listLibrary({}));
    eq([r.items.map((m) => [m.id, m.archived_at]), r.counts], [[["med_old", null]], { active: 1, archived: 0 }]);
    eq((await old.run(() => L.listLibrary({ archived: "archived" }))).items.length, 0);
  } finally {
    await old.cleanup();
  }
});

console.log("— 2. the route, every caller");
const LIB = "view=library";
await t("support (and every other member, and an operator under a support grant) reads the library, both tabs, and the usage", async () => {
  for (const caller of ["support", "operator-support", "staff", "admin", "owner"]) {
    const r = await call(caller, "media", "GET", { query: LIB });
    eq([r.status, Object.keys(r.body || {})], [200, ["ok", "items", "nextCursor", "counts"]], `${caller}:`);
    const arc = await call(caller, "media", "GET", { query: `${LIB}&archived=only` });
    eq([arc.status, arc.body.items.map((m) => m.id).sort()], [200, ["med_a058", "med_a059", "med_a060"]], `${caller} archived=only:`);
    const u = await call(caller, "media", "PUT", { body: { id: "med_a001" } });
    eq([u.status, Object.keys(u.body || {})], [200, ["ok", "usage"]], `${caller} usage:`);
  }
});
await t("support's writes are refused (403) and change nothing: upload, alt, archive, delete", async () => {
  const form = { file: new File([new Uint8Array([137, 80, 78, 71])], "x.png", { type: "image/png" }) };
  eq((await call("support", "media", "POST", { form })).status, 403, "upload:");
  eq((await call("support", "media", "PATCH", { body: { id: "med_a001", alt: "changed" } })).status, 403, "alt:");
  eq((await call("support", "media", "PATCH", { body: { id: "med_a001", archived: true } })).status, 403, "archive:");
  eq((await call("support", "media", "DELETE", { body: { id: "med_a001" } })).status, 403, "delete:");
  const r = await call("support", "media", "GET", { query: `${LIB}&q=photo-001` });
  eq(r.body.items.map((m) => [m.id, m.alt, m.archived_at]), [["med_a001", "", null]]);
});
await t("signed out: 401 on the library, the usage and every write", async () => {
  for (const [method, opts] of [["GET", { query: LIB }], ["PUT", { body: { id: "med_a001" } }], ["PATCH", { body: { id: "med_a001", archived: true } }], ["DELETE", { body: { id: "med_a001" } }]]) {
    eq((await call("signed-out", "media", method, opts)).status, 401, `${method}:`);
  }
});
await t("another store's med_ id: archive is 404, alt and delete change nothing there, the usage says nothing, and store A's library never lists it", async () => {
  eq((await call("owner", "media", "PATCH", { body: { id: "med_bonly", archived: true } })).status, 404, "archive:");
  eq((await call("owner", "media", "PATCH", { body: { id: "med_bonly", alt: "x" } })).status, 404, "alt:");
  eq((await call("owner", "media", "PUT", { body: { id: "med_bonly" } })).body.usage, [], "usage:");
  const c = b.client();
  const row = (await c.execute("SELECT alt, archived_at FROM media WHERE id = 'med_bonly'")).rows[0];
  c.close();
  eq([row?.alt, row?.archived_at ?? null], ["", null], "store B's file is untouched:");
  for (const caller of ["owner", "support"]) {
    const r = await call(caller, "media", "GET", { query: `${LIB}&q=${B_CANARY}` });
    eq([r.body.items.length, r.text.includes(B_CANARY)], [0, false], `${caller}:`);
  }
  eq((await call("owner-b", "media", "GET", { query: LIB, host: b.tenant.domains[0] })).body.items.map((m) => m.id), ["med_bonly"], "store B's owner on store B:");
});
await t("DELETE of an id this store doesn't have (gone, or store B's): 404 MEDIA_NOT_FOUND in plain words, no slog line, no audit row", async () => {
  const { listAudit } = await import("../lib/platform/audit.js");
  for (const id of ["med_nothere", "med_bonly"]) {
    const before = (await listAudit({ tenantId: a.id, limit: 200 })).length;
    const logged = [];
    const orig = console.log;
    console.log = (...x) => logged.push(x.map(String).join(" "));
    let r;
    try {
      r = await call("owner", "media", "DELETE", { body: { id } });
    } finally {
      console.log = orig;
    }
    eq([r.status, r.body?.code], [404, "MEDIA_NOT_FOUND"], `${id}:`);
    ok(!/MEDIA|SQL/.test(r.body.error), `${id} plain words:`);
    eq(logged.filter((l) => l.includes("media_deleted")), [], `${id} slog:`);
    eq((await listAudit({ tenantId: a.id, limit: 200 })).length, before, `${id} audit rows:`);
  }
  const c = b.client();
  eq(Number((await c.execute("SELECT count(*) AS n FROM media WHERE id = 'med_bonly'")).rows[0].n), 1, "store B's file stays:");
  c.close();
});
await t("READ_POSTS: its one /admin/media row is the usage PUT, gated on storefront.read, and it writes nothing (store, control plane, audit)", async () => {
  const { READ_POSTS } = await import("./support/read-controls.js");
  const { ADMIN_ROUTES } = await import("./support/admin-routes.js");
  const rows = READ_POSTS.filter((r) => r.page === "/admin/media");
  eq(rows.map(({ page, method, path }) => ({ page, method, path })), [{ page: "/admin/media", method: "PUT", path: "/api/admin/media" }]);
  ok(rows.every((r) => typeof r.reason === "string" && r.reason.length >= 10), "a reason:");
  eq(ADMIN_ROUTES.filter((r) => r.path === "media" && r.method === "PUT").map((r) => r.action), ["storefront.read"], "admin-routes row:");
  const src = read("app/api/admin/media/route.js");
  const put = src.slice(src.indexOf("export const PUT"));
  ok(/requireAdmin\(request, "storefront\.read"\)/.test(put) && /mediaUsage\(/.test(put) && !/audit\(|slog\("media_|saveMedia|setMediaAlt|archiveMedia|deleteMedia|\.execute\(/.test(put), "the PUT handler only reads the usage:");
  const { createHash } = await import("node:crypto");
  const dump = async (t) => {
    const c = t.client();
    try {
      const h = createHash("sha256");
      const tables = (await c.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => String(r.name));
      for (const name of tables) h.update(name + JSON.stringify((await c.execute(`SELECT * FROM "${name}"`)).rows.map((r) => Object.values(r).map(String)).sort()));
      return h.digest("hex");
    } finally {
      c.close();
    }
  };
  const { listAudit } = await import("../lib/platform/audit.js");
  const before = [await dump(a), (await listAudit({ tenantId: a.id, limit: 200 })).length];
  for (const caller of ["support", "operator-support", "owner"]) for (const id of ["med_a001", "med_a058", "med_nothere"]) eq((await call(caller, "media", "PUT", { body: { id } })).status, 200, `${caller} ${id}:`);
  eq([await dump(a), (await listAudit({ tenantId: a.id, limit: 200 })).length], before, "the store's database and the audit log are unchanged:");
});
await t("a bad query is 400 INVALID_QUERY in plain words; the old GET shape is unchanged", async () => {
  const r = await call("support", "media", "GET", { query: `${LIB}&sort=random` });
  eq([r.status, r.body.code], [400, "INVALID_QUERY"]);
  ok(!/sort|INVALID/.test(r.body.error), "plain words:");
  const old = await call("support", "media", "GET", {});
  eq([old.status, Object.keys(old.body)], [200, ["ok", "media", "limits"]]);
});
await t("staff: alt, archive and bring back through the route show in the library and its counts", async () => {
  eq((await call("staff", "media", "PATCH", { body: { id: "med_a002", alt: "Two" } })).status, 200);
  eq((await call("staff", "media", "PATCH", { body: { id: "med_a002", archived: true } })).status, 200);
  let r = await call("staff", "media", "GET", { query: `${LIB}&archived=only&q=Two` });
  eq([r.body.items.map((m) => m.id), r.body.counts], [["med_a002"], { active: 0, archived: 1 }]);
  eq((await call("staff", "media", "PATCH", { body: { id: "med_a002", archived: false } })).status, 200);
  r = await call("staff", "media", "GET", { query: LIB });
  eq(r.body.counts, { active: 57, archived: 3 });
});

console.log("— 3. the page");
const C = await import("../lib/platform/control.js");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const PAGE = "app/(console)/admin/(authed)/media/page.js";
await t("as support the page hands the screen the first page, the role and the limits, and nothing a write needs", async () => {
  const run = await pages.run(PAGE, { cookies: store.cookies.support });
  eq([run.error?.message ?? null, run.unresolved], [null, []]);
  const screen = run.props.find((p) => p.component.endsWith("#MediaLibrary"));
  ok(screen, "the MediaLibrary screen:");
  eq(Object.keys(screen.props).sort(), ["initial", "limits", "role"]);
  eq([screen.props.role, screen.props.initial.items.length, screen.props.initial.counts], ["support", 50, { active: 57, archived: 3 }]);
  ok(Object.values(screen.props).every((v) => typeof v !== "function"), "no handlers:");
  eq(screen.props.limits["image/svg+xml"], 300_000);
});
await t("as staff the role is staff; signed out goes to the sign-in page", async () => {
  const run = await pages.run(PAGE, { cookies: store.cookies.staff });
  eq(run.props.find((p) => p.component.endsWith("#MediaLibrary"))?.props.role, "staff");
  eq((await pages.run(PAGE, { cookies: {} })).redirect, "/admin/login");
});

console.log("— 4. the screen's markup");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const toastStub = { useToast: () => ({ success() {}, error() {}, info() {} }) };
const cache = new Map();
const resolveLocal = (id) => [`${id.slice(2)}.js`, id.slice(2)].find((c) => {
  try {
    readFileSync(join(ROOT, c));
    return true;
  } catch {
    return false;
  }
});
async function load(rel) {
  const file = join(ROOT, rel);
  if (cache.has(file)) return cache.get(file);
  const out = (await swc.transform(readFileSync(file, "utf8"), { filename: file, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" } })).code;
  const deps = new Map();
  for (const [, , id] of out.matchAll(/require\((["'])([^"']+)\1\)/g)) {
    if (deps.has(id)) continue;
    if (id === "@/components/console/Toast") deps.set(id, toastStub);
    else if (/^@\/(components\/(ui|kit|admin\/media)|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("./") && rel.startsWith("lib/")) deps.set(id, await load(join(dirname(rel), id)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { MediaLibrary } = await load("components/admin/media/MediaLibrary.js");
const { MediaDetails } = await load("components/admin/media/MediaSheet.js");
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
const first = await a.run(() => L.listLibrary({}));
const limits = { "image/png": 1_500_000, "image/svg+xml": 300_000 };
const archivedItem = (await a.run(() => L.listLibrary({ archived: "archived" }))).items[0];
const lib = (role, initial = first) => html(React.createElement(MediaLibrary, { initial, role, limits }));
const details = (role, item = first.items[0]) => html(React.createElement(MediaDetails, { item, role }));
const buttons = (s) => [...s.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

await t("support's screen: no upload zone or file input, no upload button; every button is a marked read; the read-only line", async () => {
  const s = lib("support");
  for (const bad of ['type="file"', 'data-media="upload-zone"', "Upload images", "Choose images", "Drop images here"]) ok(!s.includes(bad), `no ${bad}:`);
  const unmarked = buttons(s).filter((b) => !b.includes("data-read-control"));
  eq(unmarked, [], "unmarked buttons:");
  ok(s.includes("read-only access"), "the read-only line:");
  ok(s.includes('data-media="grid"') && (s.match(/data-media-id="/g) || []).length === 50, "50 cards:");
});
await t("support's details: no alt field, no Save, Archive, Bring back or Delete; the alt text as text, Copy URL, Open full size and Where it's used as reads", async () => {
  for (const item of [first.items[0], archivedItem]) {
    const s = details("support", item);
    for (const bad of ["<textarea", "Save alt text", ">Archive<", "Bring back", "Delete", 'data-media="writes"', "data-role-gate"]) ok(!s.includes(bad), `no ${bad}:`);
    ok(s.includes('data-media="alt-read"') && s.includes("Where it&#x27;s used") && s.includes("Copy URL") && s.includes("Open full size"), "the reads:");
    eq(buttons(s).filter((b) => !b.includes("data-read-control")), [], "unmarked buttons:");
    ok(!/<a [^>]*href=/.test(s.replace(/<a [^>]*data-read-control[^>]*>/g, "")), "every link a marked read:");
  }
  ok(details("support").includes("No alt text yet"), "the empty-alt note:");
});
await t("staff's screen and details: the upload zone (several files, images only) and the limits; the alt field, Save, Archive and Delete", async () => {
  const s = lib("staff");
  ok(s.includes('type="file"') && s.includes("multiple") && s.includes('accept="image/*"') && s.includes("Upload images") && s.includes("Choose images"), "upload:");
  ok(s.includes("PNG up to 1.5 MB; SVG up to 300 KB."), "the limits in words:");
  const d = details("staff");
  ok(d.includes("<textarea") && d.includes("Save alt text") && d.includes(">Archive") && d.includes("Delete"), "writes:");
  ok(details("staff", archivedItem).includes("Bring back") && details("staff", archivedItem).includes("hidden from the image picker"), "an archived file:");
});
await t("the states: an empty library ('Upload your first image' for writers), an empty search, and a failed first read with Try again", async () => {
  const none = { items: [], nextCursor: null, counts: { active: 0, archived: 0 } };
  ok(lib("staff", none).includes("Upload your first image"), "writer empty:");
  const sup = lib("support", none);
  ok(sup.includes("No images yet") && !sup.includes("Choose images"), "support empty:");
  const err = lib("support", null);
  ok(err.includes('role="alert"') && err.includes("Try again") && err.includes("couldn&#x27;t load"), "error:");
});

await t("rendering the screen and the details logs no React warning (empty, populated, error; support and staff)", async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" ").slice(0, 300));
  try {
    const none = { items: [], nextCursor: null, counts: { active: 0, archived: 0 } };
    for (const role of ["support", "staff"]) for (const init of [none, first, null]) lib(role, init);
    for (const role of ["support", "staff"]) details(role);
  } finally {
    console.error = orig;
  }
  eq(errs, []);
});

console.log("— 5. upload and delete rules");
await t("UploadZone uploads only through uploadImage (no fetch, XHR or form of its own); no other media part POSTs", async () => {
  const src = read("components/admin/media/UploadZone.js");
  ok(/import \{ uploadImage \} from "@\/lib\/media-upload";/.test(src) && /await uploadImage\(file, \{ onProgress/.test(src), "uploadImage:");
  for (const bad of ["fetch(", "XMLHttpRequest", "FormData", "/api/admin/media"]) ok(!src.includes(bad), `no ${bad}:`);
  for (const f of ["MediaLibrary", "MediaToolbar", "MediaGrid", "MediaSheet", "DeleteMediaDialog"]) ok(!/method: "POST"|FormData|XMLHttpRequest/.test(read(`components/admin/media/${f}.js`)), `${f}:`);
});
await t("no delete can be forced: no force flag, no 'Delete anyway'; a used file gets the fixed words, its places by name and Archive it instead", async () => {
  for (const f of ["DeleteMediaDialog", "MediaSheet", "media-words"]) ok(!/force|anyway/i.test(read(`components/admin/media/${f}.js`).replace(/^\s*\/\/.*$/gm, "")), `${f}:`);
  const W = await load("components/admin/media/media-words.js");
  eq(W.refusalWords("MEDIA_IN_USE", "server words"), W.MEDIA_WORDS.inUse);
  eq(W.refusalWords("SOMETHING", "SQLITE_BUSY"), W.MEDIA_WORDS.failed);
  eq(W.usageLines([{ where: "draft:doc_home", label: "draft", document: "doc_home", name: "Home page" }, { where: "live release:rel_1", release: "rel_1" }, { where: "brand settings", config: "brand" }, null]), ["Home page (draft)", "What your store shows now", "Your brand settings", "Another part of your store"]);
  ok(read("components/admin/media/DeleteMediaDialog.js").includes("Archive it instead"), "Archive it instead:");
});
await t("upload words: uploaded, reused, back in your library, uploadImage's refusal; the library address for a view", async () => {
  const W = await load("components/admin/media/media-words.js");
  const f = { name: "a.png" };
  eq(W.uploadResultWords(f, { ok: true, media: { deduped: false } }).text, "a.png uploaded.");
  ok(W.uploadResultWords(f, { ok: true, media: { deduped: true } }).text.includes("reused"));
  ok(W.uploadResultWords(f, { ok: true, media: { deduped: true, unarchived: true } }).text.includes("back in your library"));
  eq(W.uploadResultWords(f, { ok: false, message: "too big" }), { tone: "danger", text: "too big" });
  eq(W.libraryUrl({ tab: "archived", q: " cat ", type: "svg", sort: "size", cursor: "c1" }), "/api/admin/media?view=library&archived=only&q=cat&type=svg&sort=size&cursor=c1");
  eq(W.libraryUrl({}), "/api/admin/media?view=library");
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
