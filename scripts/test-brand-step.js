// P6-BRAND suite (GEN-04, US-01): the brand step of "Start your store",
// server side (lib/first-run/brand-step.js behind GET/POST
// /api/admin/brand-step). Extended by P6-START-UI (its rendered tests).
//   pnpm test:brand-step
//
// Run for real: the real route handler (tenantHandler, requireAdmin, real
// sessions and roles), real documents-mode tenant databases made by
// scripts/support/tenant-fixture.js (local files only), the real first-run
// writer (createFirstRunDocuments, the one the generator uses; generate.js is
// not imported), the real control plane, and storage re-read after every
// refusal. No server is started, no port is used, nothing goes to Shopify or
// Typesense.
//
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;

import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

// next/headers answers for one simulated storefront request at a time (as in
// test-design-doc), for resolvedLogo after a publish; outside one it throws,
// as the real module does outside a request.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__readRequest;
  if (!r) throw new Error("next/headers was called outside a request");
  return r;
};
export async function headers() {
  const r = req();
  return { get: (n) => (String(n).toLowerCase() === "host" ? r.host : null) };
}
export async function cookies() {
  const r = req();
  return { get: (n) => (Object.hasOwn(r.cookies, n) ? { name: n, value: r.cookies[n] } : undefined) };
}
`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-bs-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "0";
process.env.PLATFORM_SITE_HOSTS = "";

const { runRequest } = await import("./support/request-cache.js");
const F = await import("./support/tenant-fixture.js");
const { rm } = await import("node:fs/promises");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 4).join("\n   ") || e.message}`);
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (got, want, label = "") => {
  if (!same(got, want)) throw new Error(`${label} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label = "") => {
  if (!cond) throw new Error(`${label} expected truthy`);
};

await F.removeFixtureFiles("bs");
await rm(join(ROOT, ".test-bs-default.db"), { force: true });
const plat = await F.makePlatform({ name: "bs" });
const C = plat.control;
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const Docs = await import("../lib/documents/service.js");
const Pub = await import("../lib/documents/publish.js");
const R = await import("../lib/registry/index.js");
const B = await import("../lib/brand.js");
const M = await import("../lib/media.js");
const Res = await import("../lib/content/resolve.js");
const Pal = await import("../lib/themes/palettes.js");
const { withTenant } = await import("../lib/tenant-context.js");
const BS = await import("../lib/first-run/brand-step.js");
const route = await import("../app/api/admin/brand-step/route.js");

// ---- stores -----------------------------------------------------------------------------
const SITE = { name: "Brand Step Store", tagline: "Old tagline" };
const stores = {};
const fixtures = [];
async function store(key, { mode = "documents", config = {} } = {}) {
  const fx = await F.makeTenant({ name: `bs-${key}`, id: `bs${key}`, mode, config: { site: { ...SITE }, site_url: `https://bs${key}.test`, ...config } });
  fixtures.push(fx);
  stores[key] = fx;
  return fx;
}
const raws = new Map();
const raw = (fx) => {
  if (!raws.has(fx.id)) raws.set(fx.id, fx.client());
  return raws.get(fx.id);
};
const sql = async (fx, q, args = []) => (await raw(fx).execute({ sql: q, args })).rows.map((r) => ({ ...r }));
const inS = async (fx, fn) => withTenant(await C.getTenant(fx.id, { fresh: true }), fn);
// Everything a brand-step write could touch in a store, to prove a refusal
// changed nothing: its content tables and its control-plane config.
const dump = async (fx) => {
  const out = {};
  for (const table of ["documents", "document_versions", "document_refs", "publish_log", "release_state", "releases", "cms_state"]) out[table] = await sql(fx, `SELECT * FROM ${table} ORDER BY rowid`);
  out.config = (await C.getTenant(fx.id, { fresh: true })).config;
  return JSON.stringify(out);
};
const unchanged = async (fx, before, label) => eq(await dump(fx), before, `${label}: storage changed:`);
const configOf = async (fx) => (await C.getTenant(fx.id, { fresh: true })).config;
const designRow = async (fx) => (await sql(fx, "SELECT * FROM documents WHERE id = 'doc_design'"))[0] || null;
const designSettings = async (fx) => {
  const r = await designRow(fx);
  return r ? JSON.parse(r.draft).settings : null;
};

// ---- people -----------------------------------------------------------------------------
const ownerU = await I.createUser({ email: "owner@bs.test", name: "Owner Person", password: "bs-owner-pass-1" });
const staffU = await I.createUser({ email: "staff@bs.test", name: "Staff Person", password: "bs-staff-pass-1" });
const supportU = await I.createUser({ email: "help@bs.test", name: "Support Person", password: "bs-support-pass-1" });
const tok = async (u) => (await Sess.createSession({ userId: u.id, kind: "merchant", ttlMs: 600_000 })).token;
const OWNER = await tok(ownerU);
const STAFF = await tok(staffU);
const SUPPORT = await tok(supportU);
const OWNER_BY = `merchant:${ownerU.id}`;
async function members(fx) {
  await I.addMembership(ownerU.id, fx.id, "owner");
  await I.addMembership(staffU.id, fx.id, "staff");
  await I.addMembership(supportU.id, fx.id, "support");
}

// ---- the route --------------------------------------------------------------------------
const PATH = "/api/admin/brand-step";
const routeReq = (fx, cookie, body) => ({
  cookies: { get: (n) => (n === "_admin" && cookie ? { value: cookie } : undefined) },
  headers: { get: (k) => ({ host: `${fx.id}.test`, origin: `https://${fx.id}.test` })[k.toLowerCase()] ?? null },
  url: `https://${fx.id}.test${PATH}`,
  nextUrl: { pathname: PATH },
  json: async () => body,
});
const call = async (method, fx, body, as = OWNER) => {
  const res = await route[method](routeReq(fx, as, body), {});
  return { status: res.status, body: await res.json() };
};
const get = (fx, as) => call("GET", fx, undefined, as);
const post = (fx, body, as) => call("POST", fx, body, as);

// ---- helpers ----------------------------------------------------------------------------
const FR = Docs.FIRST_RUN_ACTOR;
const designBody = (paletteId, over = {}) => ({ ...R.emptyBody("design"), settings: { ...R.emptyBody("design").settings, ...Pal.designBodyFor(paletteId), ...over } });
const homeBody = () => ({ ...R.emptyBody("home"), sections: [{ id: "sec_bshome1", kind: "text", v: 1, enabled: true, settings: { title: "Welcome", body: ["Words for shoppers."] }, blocks: [] }] });
const seedSlate = (fx, { home = false } = {}) =>
  inS(fx, () =>
    Docs.createFirstRunDocuments({
      docs: [...(home ? [{ type: "home", id: "doc_home", body: homeBody() }] : []), { type: "design", id: "doc_design", body: designBody("slate") }],
      actor: FR,
    }),
  );
const PNG = (n) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n & 255, (n >> 8) & 255, 2, 3, 4, 5, 6, 7]);
let pngN = 1;
const upload = (fx) => inS(fx, () => M.saveMedia({ filename: `logo-${pngN}.png`, mime: "image/png", bytes: PNG(pngN++), alt: "" }));
const forest = Pal.paletteById("forest");
const FOREST_FROZEN = JSON.stringify(forest.brand);
async function publishIn(fx, ids) {
  return inS(fx, async () => {
    const items = [];
    for (const id of ids) {
      const d = await Docs.getDocument(id);
      items.push({ id: d.id, revision: d.revision, draftHash: d.draftHash });
    }
    return Pub.publish({ ids: items, actor: { kind: "merchant", id: ownerU.id } });
  });
}
async function asShopper(fx, fn) {
  globalThis.__readRequest = { host: `${fx.id}.test`, cookies: {} };
  try {
    return await runRequest(() => inS(fx, fn));
  } finally {
    globalThis.__readRequest = null;
  }
}
// Counts the control-plane writes to the tenants table (patchTenant ends in
// upsertTenant's one INSERT … ON CONFLICT).
function countTenantWrites() {
  const db = C.platformDb();
  const execute = db.execute.bind(db);
  const batch = db.batch.bind(db);
  const seen = { writes: 0 };
  const isWrite = (s) => /^\s*(INSERT|UPDATE|DELETE)\b[\s\S]*\btenants\b/i.test(typeof s === "string" ? s : s?.sql || "");
  db.execute = async (s, ...rest) => {
    if (isWrite(s)) seen.writes++;
    return execute(s, ...rest);
  };
  db.batch = async (list, ...rest) => {
    for (const s of list || []) if (isWrite(s)) seen.writes++;
    return batch(list, ...rest);
  };
  seen.stop = () => {
    db.execute = execute;
    db.batch = batch;
  };
  return seen;
}

try {
  // ======================================================================================
  console.log("— GEN-04: Save on a generated store");

  const A = await store("a");
  await members(A);
  const seeded = await seedSlate(A);
  const logo = await upload(A);
  const LOGO = { media: M.mediaUrl(logo.id), alt: "" };

  await t("the seeded store is the first-run writer's: a slate doc_design by system:first-run, closed, no release", async () => {
    eq(seeded.created, ["doc_design"], "created:");
    const row = await designRow(A);
    eq(row.updated_by, Docs.FIRST_RUN_BY, "updated_by:");
    eq(Pal.paletteIdOfBrand(JSON.parse(row.draft).settings.brand), "slate", "palette:");
    eq((await sql(A, "SELECT live_release_id FROM release_state WHERE id = 1"))[0].live_release_id, null, "closed:");
  });

  await t("GET on the generated slate store preselects slate, lists six palettes with labels, shows the tagline, no logo, closed", async () => {
    const r = await get(A);
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq(r.body.current.paletteId, "slate", "preselected:");
    eq(r.body.palettes.map((p) => [p.id, p.label]), Pal.PALETTES.map((p) => [p.id, p.label]), "palettes:");
    for (const p of r.body.palettes) eq(p.brand, { ...Pal.paletteById(p.id).brand }, `${p.id} brand:`);
    eq(r.body.current.logo, null, "logo:");
    eq(r.body.current.description, "Old tagline", "description:");
    eq(r.body.storeOpen, false, "storeOpen:");
    eq(r.body.canEditDescription, true, "the owner may change the description:");
    eq(r.body.design, { id: "doc_design", revision: 1 }, "design:");
    eq(r.body.brandStep, null, "no record yet:");
    eq(r.body.descriptionMax, 160, "max:");
  });

  let afterSave;
  await t("ACCEPTANCE: saving forest with a library logo gives a founder doc_design draft: brand = the forest palette, logo set, theme unchanged, updated_by the merchant, still closed, no release", async () => {
    const releasesBefore = (await sql(A, "SELECT COUNT(*) AS n FROM releases"))[0].n;
    const r = await post(A, { paletteId: "forest", logo: LOGO });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 400)}:`);
    const s = await designSettings(A);
    eq(s.brand, { ...forest.brand }, "brand:");
    eq(s.logo, LOGO, "logo:");
    eq(s.theme, { kit: "pulse", version: 1 }, "theme unchanged:");
    const row = await designRow(A);
    eq(row.updated_by, OWNER_BY, "updated_by:");
    eq(row.revision, 2, "revision:");
    eq(row.published_version_id, null, "not published:");
    eq((await sql(A, "SELECT live_release_id FROM release_state WHERE id = 1"))[0].live_release_id, null, "still closed:");
    eq((await sql(A, "SELECT COUNT(*) AS n FROM releases"))[0].n, releasesBefore, "no release written:");
    eq((await sql(A, "SELECT COUNT(*) AS n FROM publish_log"))[0].n, 0, "no publish:");
    eq(r.body.design, { id: "doc_design", revision: 2 }, "answer design:");
    eq(r.body.afterPublish, ["colours", "logo"], "after publish:");
    eq(r.body.liveNow, [], "nothing live now:");
    eq(r.body.storeOpen, false, "storeOpen:");
    eq(r.body.skipped, false, "skipped:");
    const step = (await configOf(A)).onboarding.brand_step;
    eq([step.skipped, step.paletteId, typeof step.at], [false, "forest", "string"], "brand_step:");
    eq(JSON.stringify(forest.brand), FOREST_FROZEN, "the frozen palette brand is not changed:");
    ok(Object.isFrozen(forest.brand), "still frozen:");
    // the library knows the draft uses the logo file (MED-03), so it can't be deleted unasked
    const uses = await inS(A, () => M.mediaUsage(logo.id));
    ok(uses.length > 0, `logo usage: ${JSON.stringify(uses)}`);
    afterSave = s;
  });

  await t("ACCEPTANCE: a following createFirstRunDocuments call with a slate design skips doc_design with reason 'founder', and forest stays", async () => {
    const r = await seedSlate(A);
    eq(r.skipped, [{ id: "doc_design", reason: "founder" }], "skipped:");
    eq(r.written, false, "nothing written:");
    eq(await designSettings(A), afterSave, "forest stays:");
  });

  await t("GET after the save preselects forest and shows the logo", async () => {
    const r = await get(A);
    eq([r.body.current.paletteId, r.body.current.logo, r.body.design.revision], ["forest", LOGO, 2], "current:");
    eq(r.body.brandStep.paletteId, "forest", "record:");
  });

  await t("saving the same palette and logo again writes no new revision (an open editor is not disturbed)", async () => {
    const r = await post(A, { paletteId: "forest", logo: LOGO });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq((await designRow(A)).revision, 2, "revision:");
    eq(r.body.afterPublish, [], "nothing new to publish:");
  });

  await t("ACCEPTANCE: logo:null removes an existing logo (Remove logo); a save that leaves logo out keeps it", async () => {
    const r = await post(A, { paletteId: "forest", logo: null });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq((await designSettings(A)).logo, null, "logo removed:");
    eq(r.body.afterPublish, ["logo"], "only the logo changed:");
    eq((await get(A)).body.current.logo, null, "GET shows no logo:");
    eq((await post(A, { paletteId: "forest", logo: LOGO })).status, 200, "put back:");
    const k = await post(A, { paletteId: "navy" });
    eq(k.status, 200);
    eq((await designSettings(A)).logo, LOGO, "left out = kept:");
    eq(k.body.afterPublish, ["colours"], "only colours changed:");
  });

  await t("Save with no change on a generated slate store (one click) still makes the design the founder's, so a later generation skips it", async () => {
    const K = await store("keep");
    await members(K);
    await seedSlate(K);
    const before = JSON.parse((await designRow(K)).draft).settings;
    const r = await post(K, { paletteId: "slate" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    const row = await designRow(K);
    eq([row.updated_by, row.revision], [OWNER_BY, 2], "taken over:");
    eq(JSON.parse(row.draft).settings, before, "content unchanged:");
    eq(r.body.afterPublish, [], "nothing new to publish:");
    eq((await seedSlate(K)).skipped, [{ id: "doc_design", reason: "founder" }], "the generator skips it:");
  });

  // ======================================================================================
  console.log("— the description (one merged control-plane write)");

  await t("ACCEPTANCE: the description writes config.site.tagline and brand_step in ONE config write, and an onboarding.manual check-off written just before survives", async () => {
    // the request's own tenant snapshot predates the check-off (written just
    // before the save): the save must merge into the LATEST config
    const stale = await C.getTenant(A.id, { fresh: true });
    await C.patchTenant(A.id, { config: { onboarding: { ...(stale.config.onboarding || {}), manual: { catalog: "2026-11-05T10:00:00.000Z" } } } });
    const spy = countTenantWrites();
    let r;
    try {
      r = await withTenant(stale, () => BS.saveBrandStep({ paletteId: "forest", description: "  Handmade candles from Pune  " }, { kind: "merchant", id: ownerU.id, role: "owner" }));
    } finally {
      spy.stop();
    }
    eq(spy.writes, 1, "control-plane writes:");
    const cfg = await configOf(A);
    eq(cfg.site.tagline, "Handmade candles from Pune", "tagline (trimmed by the Settings rule):");
    eq(cfg.site.name, SITE.name, "the rest of config.site kept:");
    eq(cfg.onboarding.manual, { catalog: "2026-11-05T10:00:00.000Z" }, "the check-off survives:");
    eq([cfg.onboarding.brand_step.paletteId, cfg.onboarding.brand_step.skipped], ["forest", false], "brand_step:");
    eq(r.liveNow, ["description"], "live now:");
    eq(cfg.site_url, `https://${A.id}.test`, "other config keys kept:");
  });

  await t("through the route: the answer names what is live now and what waits for Publish; an unchanged description is not rewritten", async () => {
    const r = await post(A, { paletteId: "clay", description: "A new line" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.liveNow, r.body.afterPublish], [["description"], ["colours"]], "lists:");
    eq((await configOf(A)).site.tagline, "A new line", "tagline:");
    const again = await post(A, { paletteId: "clay", description: "A new line" });
    eq(again.body.liveNow, [], "unchanged description is not live-now:");
  });

  await t("the description is one line of at most 160 characters: 161 is refused with nothing written; an existing longer tagline sent back unchanged is kept", async () => {
    const before = await dump(A);
    const r = await post(A, { paletteId: "clay", description: "x".repeat(161) });
    eq([r.status, r.body.code], [400, "DESCRIPTION_TOO_LONG"], `answer ${JSON.stringify(r.body)}:`);
    ok(/160 characters/.test(r.body.error) && /Nothing was saved/.test(r.body.error), r.body.error);
    await unchanged(A, before, "too long");
    eq((await post(A, { paletteId: "clay", description: "y".repeat(160) })).status, 200, "160 is fine:");
    const long = "z".repeat(250);
    const cur = await configOf(A);
    await C.patchTenant(A.id, { config: { site: { ...cur.site, tagline: long } } });
    eq((await get(A)).body.current.description, long, "shown unchanged:");
    const k = await post(A, { paletteId: "clay", description: long });
    eq(k.status, 200, `kept: ${JSON.stringify(k.body).slice(0, 200)}`);
    eq((await configOf(A)).site.tagline, long, "kept as it is:");
    const nl = await post(A, { paletteId: "clay", description: "Line one\nline two" });
    eq(nl.status, 200);
    eq((await configOf(A)).site.tagline, "Line one line two", "a line break becomes a space:");
  });

  // ======================================================================================
  console.log("— Skip");

  const Sk = await store("skip");
  await members(Sk);
  await seedSlate(Sk, { home: true });

  await t("ACCEPTANCE: skip records skipped:true (no paletteId with no earlier save, so startingPaletteId is slate) and leaves the seeded slate design intact; resolvedLogo is null after publishing it", async () => {
    const rowBefore = await designRow(Sk);
    const r = await post(Sk, { skip: true });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.skipped, r.body.liveNow, r.body.afterPublish], [true, [], []], "answer:");
    eq(await designRow(Sk), rowBefore, "the design is untouched:");
    const step = (await configOf(Sk)).onboarding.brand_step;
    eq(Object.keys(step).sort(), ["at", "skipped"], "record keys:");
    eq(step.skipped, true, "skipped:");
    eq(Pal.startingPaletteId((await configOf(Sk)).onboarding), "slate", "starting palette:");
    const p = await publishIn(Sk, ["doc_home", "doc_design"]);
    ok(p.release, `published: ${JSON.stringify(p).slice(0, 300)}`);
    eq(await asShopper(Sk, () => Res.resolvedLogo()), null, "resolvedLogo:");
    eq(Pal.paletteIdOfBrand(await asShopper(Sk, () => Res.resolvedBrand())), "slate", "the shopper sees slate:");
  });

  await t("on the open store the answer says storeOpen, so the console can say the description shows now", async () => {
    const r = await post(Sk, { paletteId: "slate", description: "Open now" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.storeOpen, r.body.liveNow], [true, ["description"]], "answer:");
    eq((await get(Sk)).body.storeOpen, true, "GET:");
  });

  const Fs = await store("fs");
  await members(Fs);
  await seedSlate(Fs);

  await t("ACCEPTANCE: saving forest then skipping leaves brand_step { skipped:true, paletteId:'forest' } and startingPaletteId === 'forest'", async () => {
    eq((await post(Fs, { paletteId: "forest" })).status, 200, "save:");
    const designAfterSave = await designRow(Fs);
    const r = await post(Fs, { skip: true, paletteId: "ink" });
    eq(r.status, 200);
    const onb = (await configOf(Fs)).onboarding;
    eq([onb.brand_step.skipped, onb.brand_step.paletteId], [true, "forest"], "record:");
    eq(Pal.startingPaletteId(onb), "forest", "starting palette:");
    eq(await designRow(Fs), designAfterSave, "skip writes no document (the paletteId it was sent is ignored):");
  });

  // ======================================================================================
  console.log("— GET preselection");

  const N = await store("none");
  await members(N);
  await t("ACCEPTANCE: GET with no design preselects DEFAULT_PALETTE_ID; a founder's own colours preselect nothing; a partial brand that draws like a palette is preselected", async () => {
    const r = await get(N);
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    eq([r.body.current.paletteId, r.body.design], [Pal.DEFAULT_PALETTE_ID, null], "no design:");
    await inS(N, () => Docs.createDocument({ type: "design", body: designBody("slate", { brand: { accent: "#7c3aed", background: "#ffffff", foreground: "#111111" } }), actor: { kind: "merchant", id: ownerU.id } }));
    eq((await get(N)).body.current.paletteId, null, "own colours:");
    const d = await inS(N, () => Docs.getDocument("doc_design"));
    const partial = { accent: "#1e3a8a", background: "#ffffff", foreground: "#0f172a" };
    await inS(N, () => Docs.saveDraft({ id: "doc_design", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, brand: partial } }, actor: { kind: "merchant", id: ownerU.id } }));
    eq((await get(N)).body.current.paletteId, "navy", "partial navy:");
  });

  await t("with no design at all, Save creates doc_design under the founder, on the palette's kit", async () => {
    const E = await store("empty");
    await members(E);
    const r = await post(E, { paletteId: "stone" });
    eq(r.status, 200, `status ${JSON.stringify(r.body).slice(0, 300)}:`);
    const row = await designRow(E);
    eq([row.updated_by, row.revision], [OWNER_BY, 1], "created:");
    const s = JSON.parse(row.draft).settings;
    eq([s.brand, s.theme, s.logo], [{ ...Pal.paletteById("stone").brand }, { kit: "pulse", version: 1 }, null], "settings:");
    eq(r.body.afterPublish, ["colours"], "after publish:");
  });

  await t("a design on another look keeps it; a design with no look gets the palette's kit", async () => {
    const G = await store("glow");
    await members(G);
    await inS(G, () => Docs.createFirstRunDocuments({ docs: [{ type: "design", id: "doc_design", body: designBody("slate", { theme: { kit: "glow", version: 1 } }) }], actor: FR }));
    eq((await post(G, { paletteId: "clay" })).status, 200);
    eq((await designSettings(G)).theme, { kit: "glow", version: 1 }, "glow kept:");
    const H = await store("notheme");
    await members(H);
    await inS(H, () => Docs.createFirstRunDocuments({ docs: [{ type: "design", id: "doc_design", body: designBody("slate", { theme: null }) }], actor: FR }));
    eq((await post(H, { paletteId: "clay" })).status, 200);
    eq((await designSettings(H)).theme, { kit: "pulse", version: 1 }, "the palette's kit:");
  });

  // ======================================================================================
  console.log("— refusals write nothing");

  const Rf = await store("refuse");
  await members(Rf);
  await seedSlate(Rf);
  const rfLogo = await upload(Rf);

  await t("ACCEPTANCE: an https logo address is refused (the logo kind) with nothing written", async () => {
    for (const media of ["https://elsewhere.example/logo.png", "/other/path.png", "//cdn.example/x.png", `/api/media/${rfLogo.id}?x=1`]) {
      const before = await dump(Rf);
      const r = await post(Rf, { paletteId: "forest", logo: { media, alt: "" } });
      eq(r.status, 422, `${media}: ${JSON.stringify(r.body).slice(0, 300)}`);
      ok(r.body.issues.some((i) => i.code === "LOGO_INVALID"), `${media} code: ${JSON.stringify(r.body.issues)}`);
      ok(/picture from your own library/.test(r.body.errors.join(" ")), r.body.errors.join(" "));
      await unchanged(Rf, before, media);
    }
  });

  await t("a library address whose file is not in the library is refused with nothing written", async () => {
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "forest", logo: { media: "/api/media/med_nothere1", alt: "" } });
    eq(r.status, 422, JSON.stringify(r.body).slice(0, 300));
    ok(r.body.issues.some((i) => i.code === "LOGO_NOT_IN_LIBRARY"), JSON.stringify(r.body.issues));
    await unchanged(Rf, before, "not in library");
  });

  await t("ACCEPTANCE: an unknown paletteId is a 400 with nothing written (also a missing one, and junk)", async () => {
    for (const body of [{ paletteId: "lime" }, { paletteId: "toString" }, {}, { paletteId: "forest", logo: "x" }, { paletteId: "forest", description: 5 }, "nope", null]) {
      const before = await dump(Rf);
      const r = await post(Rf, body);
      eq(r.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      ok(/Nothing was saved|nothing was saved/.test(r.body.error), r.body.error);
      await unchanged(Rf, before, JSON.stringify(body));
    }
    eq((await post(Rf, { paletteId: "lime" })).body.code, "PALETTE_UNKNOWN", "code:");
  });

  await t("ACCEPTANCE: a legacy tenant is refused with 409 STORE_USES_LEGACY and nothing written; GET too", async () => {
    const L = await store("legacy", { mode: "legacy" });
    await members(L);
    const before = await dump(L);
    for (const body of [{ paletteId: "forest" }, { skip: true }, { paletteId: "forest", description: "New" }]) {
      const r = await post(L, body);
      eq([r.status, r.body.code], [409, "STORE_USES_LEGACY"], `${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
      ok(/current Storefront editor/.test(r.body.error) && /nothing was saved/.test(r.body.error), r.body.error);
    }
    await unchanged(L, before, "legacy");
    eq((await get(L)).body.code, "STORE_USES_LEGACY", "GET:");
  });

  await t("a store moving to the new editor is refused with 409 STORE_MIGRATING and nothing written", async () => {
    const Mv = await store("moving");
    await members(Mv);
    await raw(Mv).execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
    const before = await dump(Mv);
    const r = await post(Mv, { paletteId: "forest" });
    eq([r.status, r.body.code], [409, "STORE_MIGRATING"], JSON.stringify(r.body));
    await unchanged(Mv, before, "moving");
  });

  await t("ACCEPTANCE: a stale revision returns 409 with the current document and does not overwrite a concurrent editor save", async () => {
    const g = await get(Rf);
    const rev = g.body.design.revision;
    // the editor saves first (another tab or a teammate)
    const d = await inS(Rf, () => Docs.getDocument("doc_design"));
    const editorBrand = { ...d.body.settings.brand, accent: "#7c2d12" };
    await inS(Rf, () => Docs.saveDraft({ id: "doc_design", revision: d.revision, body: { ...d.body, settings: { ...d.body.settings, brand: editorBrand } }, actor: { kind: "merchant", id: staffU.id } }));
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "forest", revision: rev, description: "Should not land" });
    eq([r.status, r.body.code], [409, "DOCUMENT_CHANGED"], JSON.stringify(r.body).slice(0, 300));
    eq(r.body.current?.revision, rev + 1, "the current document rides along:");
    ok(/changed somewhere else/.test(r.body.error), r.body.error);
    await unchanged(Rf, before, "stale");
    eq((await designSettings(Rf)).brand, editorBrand, "the editor's save stands:");
    // with the current revision it goes through
    eq((await post(Rf, { paletteId: "forest", revision: rev + 1 })).status, 200, "current revision:");
  });

  await t("ACCEPTANCE: a staff actor without the settings permission sending a changed description gets 403 in plain words and NOTHING is written", async () => {
    const before = await dump(Rf);
    const r = await post(Rf, { paletteId: "ink", description: "Staff words" }, STAFF);
    eq([r.status, r.body.code], [403, "DESCRIPTION_NOT_ALLOWED"], JSON.stringify(r.body));
    ok(/Only the store owner or an admin/.test(r.body.error) && /nothing was saved/.test(r.body.error), r.body.error);
    await unchanged(Rf, before, "staff description");
    // the same staff member may save colours with the description unchanged (or left out)
    const cur = (await configOf(Rf)).site.tagline;
    const ok1 = await post(Rf, { paletteId: "ink", description: cur }, STAFF);
    eq(ok1.status, 200, `unchanged description: ${JSON.stringify(ok1.body).slice(0, 200)}`);
    eq((await designRow(Rf)).updated_by, `merchant:${staffU.id}`, "staff's save:");
    eq((await get(Rf, STAFF)).body.canEditDescription, false, "GET tells the console:");
  });

  await t("a read-only (support) actor can read the step but not save or skip", async () => {
    eq((await get(Rf, SUPPORT)).status, 200, "GET:");
    const before = await dump(Rf);
    for (const body of [{ paletteId: "forest" }, { skip: true }]) eq((await post(Rf, body, SUPPORT)).status, 403, `${JSON.stringify(body)}:`);
    await unchanged(Rf, before, "support");
    eq((await post(Rf, { paletteId: "forest" }, null)).status, 401, "signed out:");
  });

  // ======================================================================================
  console.log("— every palette passes the design type's publish rules");

  const Pp = await store("palettes");
  await members(Pp);
  await seedSlate(Pp);
  await t("ACCEPTANCE: every palette saved through the step passes the design type's publish rules (validateDocument publish mode, checkBrand 0 errors)", async () => {
    for (const p of Pal.PALETTES) {
      const r = await post(Pp, { paletteId: p.id });
      eq(r.status, 200, `${p.id}: ${JSON.stringify(r.body).slice(0, 200)}`);
      const row = await designRow(Pp);
      const body = JSON.parse(row.draft);
      eq(body.settings.brand, { ...p.brand }, `${p.id} brand:`);
      const v = R.validateDocument(body, { mode: "publish", documentId: "doc_design" });
      ok(v.ok, `${p.id} publish validation: ${JSON.stringify(v.issues)}`);
      eq(v.issues.filter((i) => i.severity === "error"), [], `${p.id} errors:`);
      const kit = `${body.settings.theme.kit}-${body.settings.theme.version}`;
      eq(B.checkBrand(body.settings.brand, { kit }).errors.length, 0, `${p.id} checkBrand errors:`);
      eq((await get(Pp)).body.current.paletteId, p.id, `${p.id} preselected after saving:`);
    }
    for (const p of Pal.PALETTES) ok(Object.isFrozen(p.brand), `${p.id} brand still frozen`);
    eq(JSON.stringify(forest.brand), FOREST_FROZEN, "forest unchanged:");
  });

  // ======================================================================================
  console.log("— the module and route conventions");

  await t("brand-step.js never publishes and never imports the generator; the route is nodejs and resolves the store through tenantHandler", async () => {
    const { readFile } = await import("node:fs/promises");
    const lib = (await readFile(join(ROOT, "lib/first-run/brand-step.js"), "utf8")).replace(/^\s*\/\/.*$/gm, "");
    ok(!/generate\.js|documents\/publish|\bpublish\(/.test(lib), "brand-step.js must not publish or import generate.js");
    const src = await readFile(join(ROOT, "app/api/admin/brand-step/route.js"), "utf8");
    ok(/export const runtime = "nodejs";/.test(src), "runtime nodejs");
    ok((src.match(/tenantHandler\(/g) || []).length >= 2, "GET and POST through tenantHandler");
    ok(!/\/admin\/(catalog|home|upsells|storefront)/.test(src + lib), "no legacy console links");
  });
} finally {
  for (const c of raws.values()) c.close();
  for (const fx of fixtures) await fx.cleanup().catch(() => {});
  await plat.cleanup().catch(() => {});
  await F.removeFixtureFiles("bs").catch(() => {});
  await rm(join(ROOT, ".test-bs-default.db"), { force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
