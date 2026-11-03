// P2-WRITERS (DOC-02, DOC-05, DOC-07): the one door for the programmatic
// content writers (lib/content-writes.js) and its four callers: experiment
// adopt, AI insight apply, agency kit apply and the theme kit's hero preset.
// Run for real: real tenant databases with every migration, the real routes
// with real sessions, storage re-read after every write or refusal.
//   legacy     validated, revision-checked (409 on a concurrent edit),
//              audited, with a history entry; id-less home sections get ids
//   documents  a doc_home / doc_announcement DRAFT only (revision + 1); never
//              cms_blocks, never the live list
//   migrating  refused, nothing written
// Plus heroVariantSettings (lib/experiments.js), the theme kit's refusal in
// documents mode, and the grep guard: no block, page or document-table writer
// outside the allowlist.
//   pnpm test:writers
import { readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-writers-default.db";
process.env.PLATFORM_DB_URL = "file:.test-writers-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-writers-default.db", ".test-writers-platform.db", ".test-writers-legacy.db", ".test-writers-docs.db"];
const cleanup = async () => {
  for (const f of dbs) await rm(join(ROOT, f), { force: true });
};
await cleanup();

const started = Date.now();
const { createClient } = await import("@libsql/client");
const C = await import("../lib/platform/control.js");
const S = await import("../lib/platform/sessions.js");
const I = await import("../lib/platform/identity.js");
const A = await import("../lib/platform/agency.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const W = await import("../lib/content-writes.js");
const X = await import("../lib/experiments.js");
const AI = await import("../lib/ai/insights.js");
const K = await import("../lib/themes/kits.js");
const Store = await import("../lib/cms/store.js");
const H = await import("../lib/cms/history.js");
const Docs = await import("../lib/documents/service.js");
const R = await import("../lib/registry/index.js");
const L = await import("../lib/registry/legacy.js");
const { LEGACY_HERO_FIXTURES } = await import("../lib/registry/fixtures.js");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n   ${e.stack?.split("\n").slice(0, 3).join("\n   ") || e.message}`);
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
const rejects = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal, it went through");
};

// --- fixtures ----------------------------------------------------------------------
await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
const migrations = await loadMigrations("tenant");
const raw = {};
for (const [key, file] of [["legacy", ".test-writers-legacy.db"], ["docs", ".test-writers-docs.db"]]) {
  const c = createClient({ url: `file:${file}` });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  raw[key] = c;
}
await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
await C.upsertTenant({ id: "wl", name: "Legacy store", domains: ["wl.test"], dbUrl: "file:.test-writers-legacy.db", config: { brand: { accent: "#0f766e" } }, secrets: {} });
await C.upsertTenant({ id: "wd", name: "Docs store", domains: ["wd.test"], dbUrl: "file:.test-writers-docs.db", config: { brand: { accent: "#7c3aed" } }, secrets: {} });
const TEN = { legacy: await C.getTenant("wl"), docs: await C.getTenant("wd") };
const inL = (fn) => withTenant(TEN.legacy, fn);
const inD = (fn) => withTenant(TEN.docs, fn);
const sql = async (store, q, args = []) => (await raw[store].execute({ sql: q, args })).rows.map((r) => ({ ...r }));

const owner = await I.createUser({ email: "owner@wl.test", name: "Owner", password: "owner-pass-writers" });
for (const tid of ["wl", "wd"]) await I.addMembership(owner.id, tid, "owner");
const ownerTok = (await S.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const ACTOR = { kind: "merchant", id: owner.id };

const reqFor = (host, body, cookies = {}) => {
  const url = new URL(`http://${host}/api/x`);
  const jar = { _admin: ownerTok, ...cookies };
  return {
    url: url.href,
    nextUrl: url,
    cookies: { get: (n) => (jar[n] != null ? { name: n, value: jar[n] } : undefined) },
    headers: { get: (k) => ({ host })[k.toLowerCase()] ?? null },
    json: async () => body,
  };
};
const route = async (store, path, body, { cookies } = {}) => {
  const mod = await import(`../app/api/${path}/route.js`);
  const host = store === "docs" ? "wd.test" : "wl.test";
  const res = await mod.POST(reqFor(host, body, cookies), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
};

const NOW = "2026-11-01T00:00:00.000Z";
// a completed experiment with a hero variant (as cleanVariantPayload stores it)
const experiment = async (store, slug, payload) =>
  raw[store].execute({
    sql: "INSERT INTO experiments (id, slug, name, hypothesis, target_kind, variants, status, created_at, updated_at) VALUES (?, ?, ?, 'h', 'hero', ?, 'completed', ?, ?)",
    args: [`exp-${slug}`, slug, slug, JSON.stringify([{ key: "control", weight: 50, payload: null }, { key: "b", weight: 50, payload }]), NOW, NOW],
  });
const insight = async (store, id, proposals) =>
  raw[store].execute({ sql: "INSERT INTO ai_insights (id, status, proposals, facts, created_at, updated_at) VALUES (?, 'proposed', ?, '[]', ?, ?)", args: [id, JSON.stringify(proposals), NOW, NOW] });

const FOUNDER_HERO = {
  title: "Shop the founder's picks.",
  highlight: "founder's",
  subtitle: "Hand-picked every week.",
  primary: { label: "Founder primary", href: "/collections/picks" },
  secondary: { label: "Founder secondary", href: "/collections/new" },
  badge: "Founder badge",
};
const VARIANT = { title: "Adopted variant title", highlight: "variant", subtitle: "From the winning test." };

// agency with staff grants on both stores
const agency = await A.createAgency({ name: "Writers Studio" });
const agent = await I.createUser({ email: "agent@studio.test", password: "agent-pass-writers" });
await A.addAgencyMember(agency.id, agent.id, "owner");
const agentTok = (await S.createSession({ userId: agent.id, kind: "agency", ttlMs: 600_000 })).token;
for (const tid of ["wl", "wd"]) {
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@wl.test", role: "staff" });
  ok(await A.acceptGrant(inv.token, { tenantId: tid, actorEmail: "owner@wl.test" }), "grant accepted");
}
const kit = async (id, payload) =>
  C.platformDb().execute({ sql: "INSERT INTO agency_kits (id, agency_id, name, source_note, payload, created_at) VALUES (?, ?, ?, 'x', ?, ?)", args: [id, agency.id, id, JSON.stringify(payload), NOW] });
await kit("akit_ids", {
  hero: LEGACY_HERO_FIXTURES.agency_kit,
  // the shape exportAgencyKit stores: id-less sections (code defaults have none)
  home_sections: [
    { kind: "collections", title: "Shop by collection", limit: 6 },
    { kind: "rich_text", title: "Our story", html: "<p>Made with care.</p>" },
    { kind: "new", title: "New arrivals", limit: 8 },
  ],
  announcement: { enabled: true, text: "Free shipping this week", href: "/collections" },
});

const auditRows = async (tenantId, resource) =>
  (await C.platformDb().execute({ sql: "SELECT actor, actor_kind, resource, diff FROM audit_log WHERE tenant_id = ? AND resource = ? ORDER BY at", args: [tenantId, resource] })).rows.map((r) => ({ ...r }));

// ======================================================================================
console.log("— legacy: validated, revision-checked, audited, history");

await t("legacy adopt keeps the founder's buttons and badge (the variant is merged over the current hero)", async () => {
  await inL(() => Store.setBlock("hero", FOUNDER_HERO));
  await experiment("legacy", "keep-buttons", VARIANT);
  const r = await route("legacy", "admin/experiments", { adopt: { slug: "keep-buttons", variant: "b" } });
  eq(r.status, 200, `adopt: ${JSON.stringify(r.body).slice(0, 200)}`);
  ok(/publish a release/.test(r.body.note), `legacy note: ${r.body.note}`);
  const hero = (await inL(() => Store.getBlockRow("hero"))).value;
  eq([hero.title, hero.highlight, hero.subtitle], [VARIANT.title, VARIANT.highlight, VARIANT.subtitle], "the variant's copy:");
  eq(hero.primary, FOUNDER_HERO.primary, "founder primary button kept:");
  eq(hero.secondary, FOUNDER_HERO.secondary, "founder secondary button kept:");
  eq(hero.badge, FOUNDER_HERO.badge, "founder badge kept:");
});

await t("legacy adopt: a variant that names a button replaces only that button", async () => {
  await inL(() => Store.setBlock("hero", FOUNDER_HERO));
  await experiment("legacy", "one-button", LEGACY_HERO_FIXTURES.experiment_variant);
  await inL(() => X.adoptVariant("one-button", "b", { actor: ACTOR }));
  const hero = (await inL(() => Store.getBlockRow("hero"))).value;
  eq(hero.primary, LEGACY_HERO_FIXTURES.experiment_variant.primary, "variant primary:");
  eq([hero.secondary, hero.badge], [FOUNDER_HERO.secondary, FOUNDER_HERO.badge], "the rest kept:");
});

await t("legacy: a concurrent edit between the read and the write is a 409 with the current value, never a silent overwrite", async () => {
  await inL(() => Store.setBlock("hero", FOUNDER_HERO));
  await experiment("legacy", "race", VARIANT);
  const colleague = { ...FOUNDER_HERO, title: "A colleague's title", highlight: "colleague's" };
  W.__contentWriteTestHooks.beforeWrite = async () => {
    const row = await Store.getBlockRow("hero");
    await Store.setBlock("hero", colleague, { expectedRevision: row.revision });
  };
  let r;
  try {
    r = await route("legacy", "admin/experiments", { adopt: { slug: "race", variant: "b" } });
  } finally {
    W.__contentWriteTestHooks.beforeWrite = null;
  }
  eq(r.status, 409, `status: ${JSON.stringify(r.body).slice(0, 200)}`);
  eq(r.body.code, "CMS_CONFLICT", "code:");
  ok(/Someone else changed this/.test(r.body.error) && !/SQLITE/.test(r.body.error), `plain words: ${r.body.error}`);
  eq(r.body.current?.value?.title, colleague.title, "current value rides along:");
  eq((await inL(() => Store.getBlockRow("hero"))).value.title, colleague.title, "the colleague's save is kept:");
  eq((await sql("legacy", "SELECT adopted_variant FROM experiments WHERE slug = 'race'"))[0].adopted_variant, null, "the experiment isn't marked adopted:");
});

await t("legacy: the write is validated (422 with issues, nothing written), audited, and has a history entry", async () => {
  await inL(() => Store.setBlock("hero", FOUNDER_HERO));
  const before = await inL(() => Store.getBlockRow("hero"));
  // an empty title in a stored variant: today's editor refuses that hero
  await experiment("legacy", "bad", { title: "", highlight: "", subtitle: "x" });
  const bad = await route("legacy", "admin/experiments", { adopt: { slug: "bad", variant: "b" } });
  eq(bad.status, 422, `invalid: ${JSON.stringify(bad.body).slice(0, 200)}`);
  eq(bad.body.code, "VALIDATION_FAILED", "code:");
  ok(bad.body.issues.some((i) => i.field === "title" && i.code === "REQUIRED"), `issues: ${JSON.stringify(bad.body.issues)}`);
  eq(await inL(() => Store.getBlockRow("hero")), before, "nothing written:");

  await experiment("legacy", "good", VARIANT);
  const historyBefore = (await inL(() => H.listHistory("block", "hero"))).length;
  const auditBefore = (await auditRows("wl", "block:hero")).length;
  const ok200 = await route("legacy", "admin/experiments", { adopt: { slug: "good", variant: "b" } });
  eq(ok200.status, 200, "valid adopt:");
  const after = await inL(() => Store.getBlockRow("hero"));
  eq(after.revision, before.revision + 1, "revision + 1:");
  const audits = await auditRows("wl", "block:hero");
  eq(audits.length, auditBefore + 1, "one audit row for the block:");
  eq([audits.at(-1).actor, audits.at(-1).actor_kind, JSON.parse(audits.at(-1).diff).source], [owner.id, "merchant", "experiment:good"], "who and from where:");
  const hist = await inL(() => H.listHistory("block", "hero"));
  eq(hist.length, historyBefore + 1, "one history entry:");
  eq([hist[0].value.title, hist[0].revision, hist[0].actor], [VARIANT.title, after.revision, `merchant:${owner.id}`], "the entry:");
});

await t("legacy insight apply: a hero draft keeps the founder's buttons and badge; an announcement draft is validated and written", async () => {
  await inL(() => Store.setBlock("hero", FOUNDER_HERO));
  await insight("legacy", "ins-l", [
    { component: "hero", draft: LEGACY_HERO_FIXTURES.ai_proposal },
    { component: "announcement", draft: { text: "Back in stock", href: "/collections/all" } },
  ]);
  const h = await route("legacy", "admin/insights", { apply: { id: "ins-l", index: 0 } });
  eq(h.status, 200, `hero apply: ${JSON.stringify(h.body).slice(0, 200)}`);
  const hero = (await inL(() => Store.getBlockRow("hero"))).value;
  eq(hero.title, LEGACY_HERO_FIXTURES.ai_proposal.title, "AI title:");
  eq([hero.primary, hero.secondary, hero.badge], [FOUNDER_HERO.primary, FOUNDER_HERO.secondary, FOUNDER_HERO.badge], "founder's buttons and badge:");
  const a = await route("legacy", "admin/insights", { apply: { id: "ins-l", index: 1 } });
  eq(a.status, 200, "announcement apply:");
  eq((await inL(() => Store.getBlockRow("announcement"))).value, { enabled: true, text: "Back in stock", href: "/collections/all" }, "announcement:");
});

await t("legacy agency kit with id-less home_sections stores every section with a durable sec_ id", async () => {
  const r = await route("legacy", "partners", { kit_apply: { kit: "akit_ids", tenant: "wl" } }, { cookies: { _agency: agentTok } });
  eq(r.status, 200, `kit apply: ${JSON.stringify(r.body).slice(0, 200)}`);
  eq(r.body.written, ["hero", "home_sections", "announcement"], "written:");
  const stored = JSON.parse((await sql("legacy", "SELECT value FROM cms_blocks WHERE key = 'home_sections'"))[0].value);
  eq(stored.map((s) => s.kind), ["collections", "rich_text", "new"], "kinds:");
  ok(stored.every((s) => R.SECTION_ID_RE.test(s.id)), `ids: ${stored.map((s) => s.id)}`);
  eq(new Set(stored.map((s) => s.id)).size, 3, "unique ids:");
  ok(stored.every((s) => !/^sec_l\d+$/.test(s.id)), "minted, not the read-time sec_l<i>:");
  const hero = (await inL(() => Store.getBlockRow("hero"))).value;
  eq(hero.title, LEGACY_HERO_FIXTURES.agency_kit.title, "the kit's hero replaces the copy:");
  eq(hero.badge, LEGACY_HERO_FIXTURES.agency_kit.badge, "with its badge:");
  eq((await auditRows("wl", "block:home_sections")).length, 1, "audited:");
});

// ======================================================================================
console.log("— documents: drafts of doc_home / doc_announcement only");

const IMAGE = { media: "/api/media/med_hero01", alt: "A founder photo" };
const founderSection = () => ({ ...L.legacyHeroToSection(FOUNDER_HERO), settings: { ...L.legacyHeroToSection(FOUNDER_HERO).settings, image: IMAGE } });
await inD(async () => {
  await Docs.createDocument({ type: "home", body: { ...R.emptyBody("home"), sections: [founderSection(), R.newSection("rich_text", { id: "sec_story1", settings: { title: "Story", html: "<p>Hi</p>" } })] }, actor: ACTOR });
  await Docs.createDocument({ type: "announcement", body: { ...R.emptyBody("announcement"), settings: { enabled: false, text: "Old bar", link: null } }, actor: ACTOR });
});
const LIVE_TABLES = ["cms_blocks", "cms_pages", "cms_history", "releases", "release_state", "publish_log"];
const liveDump = async () => {
  const out = {};
  for (const tb of LIVE_TABLES) out[tb] = await sql("docs", `SELECT * FROM ${tb} ORDER BY 1`);
  out.published = await sql("docs", "SELECT id, published_version_id, published_hash FROM documents ORDER BY id");
  out.publishedVersions = await sql("docs", "SELECT id FROM document_versions WHERE kind = 'published' ORDER BY id");
  return JSON.stringify(out);
};
const docRow = async (id) => (await sql("docs", "SELECT id, revision, draft, draft_hash FROM documents WHERE id = ?", [id]))[0];
const otherDocs = async (except) => JSON.stringify(await sql("docs", "SELECT id, revision, draft_hash FROM documents WHERE id <> ? ORDER BY id", [except]));
const heroOf = (row) => JSON.parse(row.draft).sections.find((s) => s.kind === "hero");

await t("documents adopt: only the doc_home draft changes (revision + 1); the founder's buttons, badge and image stay; never cms_blocks or the live list", async () => {
  await experiment("docs", "doc-adopt", VARIANT);
  const live = await liveDump();
  const before = await docRow("doc_home");
  const others = await otherDocs("doc_home");
  const r = await route("docs", "admin/experiments", { adopt: { slug: "doc-adopt", variant: "b" } });
  eq(r.status, 200, `adopt: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(/editor/.test(r.body.note) && !/release/.test(r.body.note), `documents note: ${r.body.note}`);
  const after = await docRow("doc_home");
  eq(after.revision, before.revision + 1, "revision + 1:");
  const s = heroOf(after).settings;
  eq([s.title, s.highlight, s.subtitle], [VARIANT.title, VARIANT.highlight, VARIANT.subtitle], "variant copy:");
  eq(s.primary, { label: FOUNDER_HERO.primary.label, link: { type: "url", href: FOUNDER_HERO.primary.href } }, "founder primary:");
  eq(s.secondary, { label: FOUNDER_HERO.secondary.label, link: { type: "url", href: FOUNDER_HERO.secondary.href } }, "founder secondary:");
  eq([s.badge, s.image], [FOUNDER_HERO.badge, IMAGE], "badge and image:");
  eq(JSON.parse(after.draft).sections.map((x) => x.id), ["sec_hero", "sec_story1"], "other sections untouched:");
  eq(await otherDocs("doc_home"), others, "other documents:");
  eq(await liveDump(), live, "cms_blocks and the live list:");
});

await t("documents insight apply: hero → doc_home draft only, announcement → doc_announcement draft only (revision + 1 each)", async () => {
  await insight("docs", "ins-d", [
    { component: "hero", draft: LEGACY_HERO_FIXTURES.ai_proposal },
    { component: "announcement", draft: { text: "Back in stock", href: "/collections/all" } },
  ]);
  const live = await liveDump();
  let before = await docRow("doc_home");
  let others = await otherDocs("doc_home");
  const h = await route("docs", "admin/insights", { apply: { id: "ins-d", index: 0 } });
  eq(h.status, 200, `hero: ${JSON.stringify(h.body).slice(0, 300)}`);
  let after = await docRow("doc_home");
  eq(after.revision, before.revision + 1, "home revision + 1:");
  eq(heroOf(after).settings.title, LEGACY_HERO_FIXTURES.ai_proposal.title, "title:");
  eq(heroOf(after).settings.badge, FOUNDER_HERO.badge, "badge kept:");
  eq(await otherDocs("doc_home"), others, "other documents:");

  before = await docRow("doc_announcement");
  others = await otherDocs("doc_announcement");
  const a = await route("docs", "admin/insights", { apply: { id: "ins-d", index: 1 } });
  eq(a.status, 200, `announcement: ${JSON.stringify(a.body).slice(0, 300)}`);
  after = await docRow("doc_announcement");
  eq(after.revision, before.revision + 1, "announcement revision + 1:");
  eq(JSON.parse(after.draft).settings, { enabled: true, text: "Back in stock", link: { type: "url", href: "/collections/all" } }, "bar settings:");
  eq(await otherDocs("doc_announcement"), others, "other documents:");
  eq(await liveDump(), live, "cms_blocks and the live list:");
});

await t("documents agency kit apply: one doc_home draft (hero copy + the kit's sections) and one doc_announcement draft; never cms_blocks or the live list", async () => {
  const live = await liveDump();
  const home = await docRow("doc_home");
  const bar = await docRow("doc_announcement");
  const r = await route("docs", "partners", { kit_apply: { kit: "akit_ids", tenant: "wd" } }, { cookies: { _agency: agentTok } });
  eq(r.status, 200, `kit apply: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(/editor/.test(r.body.note), `note: ${r.body.note}`);
  const h = await docRow("doc_home");
  const b = await docRow("doc_announcement");
  eq([h.revision, b.revision], [home.revision + 1, bar.revision + 1], "revisions + 1:");
  const sections = JSON.parse(h.draft).sections;
  eq(sections.map((s) => s.kind), ["hero", "collections", "rich_text", "new"], "hero first, then the kit's sections:");
  ok(sections.every((s) => R.SECTION_ID_RE.test(s.id)), `ids: ${sections.map((s) => s.id)}`);
  eq(heroOf(h).settings.title, LEGACY_HERO_FIXTURES.agency_kit.title, "kit hero copy:");
  eq(heroOf(h).settings.image, IMAGE, "the founder's hero image survives a kit:");
  eq(JSON.parse(b.draft).settings.text, "Free shipping this week", "bar:");
  eq(await sql("docs", "SELECT count(*) AS n FROM cms_blocks"), [{ n: 0 }], "no legacy block:");
  eq(await liveDump(), live, "the live list:");
});

await t("documents: a home that was never saved is created as a draft holding the hero; a home with no hero gets it back at the top", async () => {
  // a fresh documents store has no doc_home yet: use a second, empty one
  const c = createClient({ url: "file:.test-writers-default.db" });
  await c.executeMultiple(schema);
  await runMigrations(c, migrations);
  await c.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  await C.upsertTenant({ id: "we", name: "Empty docs", domains: ["we.test"], dbUrl: "file:.test-writers-default.db", config: {}, secrets: {} });
  const r = await withTenant(await C.getTenant("we"), () => W.writeContentDrafts({ hero: { value: VARIANT, merge: true } }, { actor: ACTOR, source: "test", documents: Docs }));
  eq(r.mode, "documents", "mode:");
  const row = (await c.execute("SELECT revision, draft FROM documents WHERE id = 'doc_home'")).rows[0];
  eq(Number(row.revision), 1, "created:");
  const sections = JSON.parse(row.draft).sections;
  eq([sections.length, sections[0].kind, sections[0].settings.title], [1, "hero", VARIANT.title], "the hero, from the declared defaults plus the variant:");
  eq((await c.execute("SELECT count(*) AS n FROM cms_blocks")).rows[0].n, 0, "no legacy block:");
  // a home whose hero the founder removed: the hero comes back first, the rest stays
  await withTenant(await C.getTenant("we"), async () => {
    const d = await Docs.getDocument("doc_home");
    await Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, sections: [R.newSection("rich_text", { id: "sec_only1", settings: { title: "Only", html: "<p>x</p>" } })] }, actor: ACTOR });
    await W.writeContentDrafts({ hero: { value: VARIANT, merge: true } }, { actor: ACTOR, source: "test", documents: Docs });
  });
  const again = JSON.parse((await c.execute("SELECT draft FROM documents WHERE id = 'doc_home'")).rows[0].draft).sections;
  eq(again.map((x) => [x.kind, x.id]), [["hero", "sec_hero"], ["rich_text", "sec_only1"]], "hero first, the rest kept:");
  c.close();
});

await t("documents: a concurrent save between the read and the write is a 409 with the current document; nothing of ours lands", async () => {
  await experiment("docs", "doc-race", VARIANT);
  let theirId = null;
  W.__contentWriteTestHooks.beforeWrite = async () => {
    const d = await Docs.getDocument("doc_home");
    const other = d.body.sections.find((x) => x.kind !== "hero");
    theirId = other.id;
    const sections = d.body.sections.map((x) => (x.id === other.id ? { ...x, settings: { ...x.settings, title: "Their title" } } : x));
    await Docs.saveDraft({ id: d.id, revision: d.revision, body: { ...d.body, sections }, actor: ACTOR });
  };
  let r;
  try {
    r = await route("docs", "admin/experiments", { adopt: { slug: "doc-race", variant: "b" } });
  } finally {
    W.__contentWriteTestHooks.beforeWrite = null;
  }
  eq(r.status, 409, `status: ${JSON.stringify(r.body).slice(0, 200)}`);
  ok(r.body.current && r.body.current.id === "doc_home", "current document rides along:");
  const d = await docRow("doc_home");
  eq(JSON.parse(d.draft).sections.find((x) => x.id === theirId).settings.title, "Their title", "their save kept:");
  ok(heroOf(d).settings.title !== VARIANT.title, "our variant didn't land:");
  eq((await sql("docs", "SELECT adopted_variant FROM experiments WHERE slug = 'doc-race'"))[0].adopted_variant, null, "not marked adopted:");
});

await t("documents: a draft that breaks structure is 422 with every issue and nothing stored (DOC-05: incomplete is not refused)", async () => {
  const before = await docRow("doc_home");
  // an unknown section kind in a kit is structure: refused
  await kit("akit_bad", { home_sections: [{ kind: "carousel", title: "Spin" }] });
  const r = await route("docs", "partners", { kit_apply: { kit: "akit_bad", tenant: "wd" } }, { cookies: { _agency: agentTok } });
  eq(r.status, 422, `status: ${JSON.stringify(r.body).slice(0, 300)}`);
  ok(Array.isArray(r.body.issues) && r.body.issues.length >= 1, "issues:");
  eq(await docRow("doc_home"), before, "nothing stored:");
  // an empty hero title is only incomplete in a draft: it saves (publish refuses it)
  await experiment("docs", "doc-incomplete", { title: "", highlight: "", subtitle: "Only a subtitle" });
  const inc = await route("docs", "admin/experiments", { adopt: { slug: "doc-incomplete", variant: "b" } });
  eq(inc.status, 200, `incomplete draft saves: ${JSON.stringify(inc.body).slice(0, 300)}`);
  eq(heroOf(await docRow("doc_home")).settings.title, "", "stored as typed:");
});

await t("'migrating': adopt, insight apply and agency kit apply refuse with 409 STORE_USES_DOCUMENTS and write nothing", async () => {
  await raw.docs.execute("UPDATE cms_state SET mode = 'migrating' WHERE id = 1");
  try {
    await experiment("docs", "mid-move", VARIANT);
    await insight("docs", "ins-m", [{ component: "hero", draft: LEGACY_HERO_FIXTURES.ai_proposal }]);
    const before = JSON.stringify([await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id"), await liveDump()]);
    const answers = [
      await route("docs", "admin/experiments", { adopt: { slug: "mid-move", variant: "b" } }),
      await route("docs", "admin/insights", { apply: { id: "ins-m", index: 0 } }),
      await route("docs", "partners", { kit_apply: { kit: "akit_ids", tenant: "wd" } }, { cookies: { _agency: agentTok } }),
    ];
    eq(answers.map((a) => [a.status, a.body.code]), [[409, "STORE_USES_DOCUMENTS"], [409, "STORE_USES_DOCUMENTS"], [409, "STORE_USES_DOCUMENTS"]], "answers:");
    ok(answers.every((a) => /moving to the new editor/.test(a.body.error)), "plain words:");
    eq(JSON.stringify([await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id"), await liveDump()]), before, "nothing written:");
    eq((await sql("docs", "SELECT adopted_variant FROM experiments WHERE slug = 'mid-move'"))[0].adopted_variant, null, "not marked adopted:");
  } finally {
    await raw.docs.execute("UPDATE cms_state SET mode = 'documents' WHERE id = 1");
  }
});

await t("a cms_state that can't be read is a 5xx, never a go-ahead", async () => {
  await raw.legacy.executeMultiple("ALTER TABLE cms_state RENAME TO cms_state_data; CREATE VIEW cms_state AS SELECT * FROM cms_state_gone;");
  try {
    await experiment("legacy", "bad-mode", VARIANT);
    const before = await inL(() => Store.getBlockRow("hero"));
    const r = await route("legacy", "admin/experiments", { adopt: { slug: "bad-mode", variant: "b" } });
    ok(r.status >= 500, `status ${r.status}`);
    ok(!/cms_state|SQLITE/i.test(r.body.error), `plain words: ${r.body.error}`);
    eq(await inL(() => Store.getBlockRow("hero")), before, "nothing written:");
  } finally {
    await raw.legacy.executeMultiple("DROP VIEW cms_state; ALTER TABLE cms_state_data RENAME TO cms_state;");
  }
});

await t("documents: a caller that doesn't hand in the documents service refuses (409) and writes nothing, never a legacy block", async () => {
  await experiment("docs", "no-service", VARIANT);
  const before = JSON.stringify([await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id"), await liveDump()]);
  const e = await rejects(() => inD(() => X.adoptVariant("no-service", "b", { actor: ACTOR })));
  eq([e.status, e.code], [409, "STORE_USES_DOCUMENTS"], `refusal: ${e.message}`);
  eq(JSON.stringify([await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id"), await liveDump()]), before, "nothing written:");
});

await t("edge: no node:* import in lib/content-writes.js, lib/experiments.js or lib/themes/kits.js, nor in anything they import (static or import())", async () => {
  // the rule test-release-readers applies to the readers; node:async_hooks is
  // the one node: module Next's edge runtime provides
  const nodeImport = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](node:(?!async_hooks["'])[^"']+|fs|path|crypto|child_process|os|module|url|async_hooks)["']/;
  const seen = new Set();
  const walk = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, "utf8");
    const hit = src.match(nodeImport);
    if (hit) throw new Error(`${f.slice(ROOT.length + 1)} imports ${hit[1]}`);
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) await walk(join(dirname(f), spec.endsWith(".js") ? spec : `${spec}.js`));
  };
  for (const f of ["lib/content-writes.js", "lib/experiments.js", "lib/themes/kits.js"]) await walk(join(ROOT, f));
  ok(seen.has(join(ROOT, "lib/content-writes.js")) && seen.has(join(ROOT, "lib/cms/store.js")), `walked ${seen.size} files`);
  ok(![...seen].some((f) => f.includes("/lib/documents/service.js")), "the documents service is not in the graph:");
});

// ======================================================================================
console.log("— heroVariantSettings");

await t("heroVariantSettings merges a flat variant payload into hero settings, equal to the settingsToLegacyHero round-trip of heroVariantFor's legacy output", async () => {
  const heroes = [FOUNDER_HERO, LEGACY_HERO_FIXTURES.agency_kit, { title: "Bare", highlight: "", subtitle: "" }];
  const payloads = [VARIANT, LEGACY_HERO_FIXTURES.experiment_variant, LEGACY_HERO_FIXTURES.ai_proposal, { title: "Two buttons", primary: { label: "P", href: "/p" }, secondary: { label: "S", href: "/s" } }];
  let n = 0;
  for (const hero of heroes) {
    for (const payload of payloads) {
      const exp = { slug: "eq", name: "eq", salt: "s", variants: [{ key: "control", weight: 1, payload: null }, { key: "b", weight: 1, payload }] };
      let unit = 0;
      while (X.assignVariant(exp, `u${unit}`) !== "b") unit++;
      const served = X.heroVariantFor(exp, hero, `u${unit}`).hero;
      const merged = X.heroVariantSettings(L.legacyHeroToSettings(hero), payload);
      eq(L.settingsToLegacyHero(merged), served, `hero ${hero.title} + ${payload.title}:`);
      n++;
    }
  }
  // at the settings level: the image and everything unnamed stay, buttons become typed links
  const s = X.heroVariantSettings({ ...R.defaultSettings(R.sectionType("hero")), badge: "Kept", image: IMAGE }, LEGACY_HERO_FIXTURES.experiment_variant);
  eq([s.badge, s.image, s.primary], ["Kept", IMAGE, { label: "Shop the sale", link: { type: "url", href: "/collections/sale" } }], "settings level:");
  ok(R.validateDocument({ ...R.emptyBody("home"), sections: [{ id: "sec_hero", kind: "hero", v: R.sectionType("hero").version, enabled: true, settings: s, blocks: [] }] }, { mode: "publish" }).ok, "a valid hero section:");
  eq(X.heroVariantSettings(null, { title: "T" }), { title: "T" }, "no settings:");
  // heroVariantFor keeps its legacy behaviour
  const exp = { slug: "eq", name: "eq", salt: "s", variants: [{ key: "control", weight: 1, payload: null }, { key: "b", weight: 1, payload: VARIANT }] };
  eq(X.heroVariantFor(exp, FOUNDER_HERO, null).hero, FOUNDER_HERO, "no unit: the hero untouched:");
  ok(n === 12, `pairs: ${n}`);
});

// ======================================================================================
console.log("— theme kits");

await t("kit apply in documents mode is 409 (brand and theme are TOK-03): no pin, no brand, no draft", async () => {
  const cfg = (await C.platformDb().execute("SELECT config FROM tenants WHERE id = 'wd'")).rows[0].config;
  const docs = await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id");
  const e = await rejects(() => inD(() => K.applyKit("glow", { actor: ACTOR })));
  eq([e.status, e.code], [409, "STORE_USES_DOCUMENTS"], `refusal: ${e.message}`);
  eq((await C.platformDb().execute("SELECT config FROM tenants WHERE id = 'wd'")).rows[0].config, cfg, "config unchanged:");
  eq(await sql("docs", "SELECT id, revision, draft_hash FROM documents ORDER BY id"), docs, "documents unchanged:");
  eq(await sql("docs", "SELECT count(*) AS n FROM cms_blocks"), [{ n: 0 }], "no block:");
  // and the route keeps its own refusal
  const r = await route("docs", "admin/theme", { action: "apply", kit: "glow" });
  eq([r.status, r.body.code], [409, "STORE_USES_DOCUMENTS"], "route:");
});

await t("kit apply in legacy works as today: pin, brand defaults and the hero preset as a draft (audited, with history)", async () => {
  const hist = (await inL(() => H.listHistory("block", "hero"))).length;
  const r = await withTenant(await C.getTenant("wl"), () => K.applyKit("glow", { actor: ACTOR }));
  eq([r.theme.kit, r.presets], ["glow", ["hero"]], "applied:");
  const t2 = await C.getTenant("wl");
  eq([t2.config.theme.kit, t2.config.brand.accent], ["glow", K.KITS.glow.brand.accent], "pin and brand:");
  const hero = (await inL(() => Store.getBlockRow("hero"))).value;
  eq(hero.title, K.KITS.glow.presets.hero.title, "hero preset:");
  eq((await inL(() => H.listHistory("block", "hero"))).length, hist + 1, "history entry:");
  const noPreset = await withTenant(await C.getTenant("wl"), () => K.applyKit("pulse", { actor: ACTOR, withPresets: false }));
  eq(noPreset.presets, [], "withPresets false writes no hero:");
  eq((await inL(() => Store.getBlockRow("hero"))).value.title, K.KITS.glow.presets.hero.title, "hero unchanged:");
});

// ======================================================================================
console.log("— the grep guard");

const BLOCK_WRITE_RE = /\b(setBlock|deleteBlock|upsertContentPage|deleteContentPage)\s*\(/;
const BLOCK_IMPORT_RE = /\b(setBlock|deleteBlock|upsertContentPage|deleteContentPage)\b[^;]*from\s+["'][^"']*cms\/store(\.js)?["']/;
const DOC_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+["'`]?(documents|document_versions|publish_log)\b|\b(?:insertInto|updateTable|deleteFrom|replaceInto)\(\s*["'`](documents|document_versions|publish_log)["'`]/i;
// The owners of the legacy block and page writers, the door, and the seed and
// perf scripts (they build fixtures, never a founder's content).
export const BLOCK_WRITER_ALLOW = new Set(["lib/cms/store.js", "lib/admin/cms-api.js", "lib/content-writes.js", "scripts/seed-design-preview.js", "scripts/perf-fixture.js", "scripts/perf-report.js"]);
// Test suites set up their own fixtures; they are not product code.
const isTest = (p) => /^scripts\/test-[\w.-]+\.js$/.test(p) || p.startsWith("scripts/support/") || p.startsWith("scripts/drills/");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
export function directWriters(files) {
  const out = [];
  for (const { path, text } of files) {
    if (isTest(path)) continue;
    const code = stripComments(text);
    if (!BLOCK_WRITER_ALLOW.has(path) && (BLOCK_WRITE_RE.test(code) || BLOCK_IMPORT_RE.test(code))) out.push(`${path}: block/page writer`);
    if (!path.startsWith("lib/documents/") && DOC_WRITE_RE.test(code)) out.push(`${path}: document-table writer`);
  }
  return out;
}

await t("the grep guard finds no direct block, page or document-table writer outside the allowlist", async () => {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!["node_modules", ".next"].includes(e.name)) await walk(p);
      } else if (/\.(m?js|jsx|ts|tsx|sql)$/.test(e.name)) files.push({ path: p, text: await readFile(join(ROOT, p), "utf8") });
    }
  };
  for (const d of ["lib", "app", "components", "scripts", "migrations"]) await walk(d);
  for (const f of ["middleware.js", "instrumentation.js"]) {
    try {
      files.push({ path: f, text: await readFile(join(ROOT, f), "utf8") });
    } catch {
      /* not there */
    }
  }
  ok(files.length > 100, `files scanned: ${files.length}`);
  for (const must of ["lib/experiments.js", "lib/ai/insights.js", "lib/platform/agency.js", "lib/themes/kits.js", "lib/content-writes.js", "app/api/partners/route.js"]) ok(files.some((f) => f.path === must), `${must} scanned:`);
  eq(directWriters(files), [], "direct writers:");
  // the guard bites: each of these is caught outside the allowlist
  const caught = [
    ['import { setBlock } from "../cms/store.js";\nawait setBlock("hero", v);', "block/page writer"],
    ['const { setBlock } = await import("../cms/store.js"); await setBlock("hero", v)', "block/page writer"],
    ["await deleteBlock('hero')", "block/page writer"],
    ["await upsertContentPage(page)", "block/page writer"],
    ["await deleteContentPage('about')", "block/page writer"],
    ['await libsql.execute("UPDATE documents SET draft = 1")', "document-table writer"],
    ["INSERT INTO document_versions (id) VALUES (1)", "document-table writer"],
    ["await db.deleteFrom('publish_log')", "document-table writer"],
  ];
  for (const [text, what] of caught) eq(directWriters([{ path: "lib/cms/x.js", text }]), [`lib/cms/x.js: ${what}`], `caught: ${text}`);
  // the old shapes of the four callers are caught
  eq(directWriters([{ path: "lib/experiments.js", text: 'import { setBlock } from "./cms/store.js";\nawait setBlock("hero", variant.payload);' }]), ["lib/experiments.js: block/page writer"], "old adoptVariant:");
  // reads, comments and the allowlist are fine
  eq(directWriters([{ path: "lib/cms/x.js", text: "// setBlock(\"hero\") used to be here\nawait getBlock('hero'); db.selectFrom('documents')" }]), [], "reads and comments:");
  eq(directWriters([{ path: "lib/content-writes.js", text: "await setBlock(key, v)" }]), [], "the door itself:");
  eq(directWriters([{ path: "scripts/test-cms.js", text: "await setBlock(key, v)" }]), [], "test suites:");
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
for (const c of Object.values(raw)) c.close();
await cleanup();
process.exit(fail ? 1 : 0);
