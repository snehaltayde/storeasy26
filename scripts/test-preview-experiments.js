// PV-08 suite: a running experiment is inert in preview, and says so.
//
// What it proves, each through the real code path:
//   1. rendered: the real storefront home page (app/(storefront)/page.js,
//      compiled with Next's own SWC, rendered with react-dom/server) against a
//      real tenant database with a running hero experiment, a real preview
//      token and the real content resolver. In a preview the founder's own
//      hero shows for every visitor bucket, nothing pings /api/exp, and a note
//      names the test inside the hero. Without a preview, shoppers are bucketed
//      and served exactly as at 8968db3 (a frozen copy of that code is the
//      oracle), and never see the note.
//   2. route: the real POST /api/exp handler refuses to count an exposure from
//      a preview session, and still counts a shopper's, once.
//   3. conversions: a preview session's order converts nothing; the checkout
//      route reads its unit through that one gate.
//   4. rendered console: the Designer's hero settings and tree say a test is
//      running, name it and link to its row on the Experiments screen; the
//      Designer page loads the running tests.
//   5. guard: every place that picks or applies a variant, or records an
//      exposure or conversion, is one this suite knows is gated.
// No browser here. The browser proof is scripts/drills/p1/pv08.mjs.
//   pnpm test:preview-experiments
import { readFile, readdir, rm } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const require = createRequire(import.meta.url);

process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-pv08-default.db";
process.env.PLATFORM_DB_URL = "file:.test-pv08-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";
process.env.RATE_LIMIT_DISABLED = "1";
process.env.RESEND_API_KEY = "";

const dbs = [".test-pv08-default.db", ".test-pv08-platform.db", ".test-pv08-a.db", ".test-pv08-b.db", ".test-pv08-c.db"];
for (const f of dbs) await rm(join(ROOT, f), { force: true });

// One request at a time: next/headers reads this. headers() and cookies()
// outside a "request" throw, as Next's own do.
const HEADERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(`
const req = () => {
  const r = globalThis.__pv08Request;
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
// Plain Node can't resolve the app's "@/…" alias or "next/server" (next has no
// exports map), so the real routes and libraries load through this.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "next/headers") return { url: HEADERS_STUB, shortCircuit: true, format: "module" };
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const X = await import("../lib/experiments.js");
const R = await import("../lib/releases.js");
const { setBlock } = await import("../lib/cms/store.js");
const { setPreviewCandidate, clearPreviewCandidate, PREVIEW_COOKIE } = await import("../lib/cms/candidates.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");
const { NextRequest } = await import("next/server");

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
const ok = (v, m) => {
  if (!v) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m} expected ${B}, got ${A}`);
};

// ---- fixtures: two stores --------------------------------------------------------
// "pv" runs the seeded hero test, with a live hero and a different saved draft.
// "pw" has the same hero setup and no test at all.
// "px" has never published, so its shoppers are served drafts (not a preview),
// and runs the same test.

await C.migratePlatform(await readFile(join(ROOT, "lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(ROOT, "lib/schema.sql"), "utf8");
for (const [id, file] of [["pv", ".test-pv08-a.db"], ["pw", ".test-pv08-b.db"], ["px", ".test-pv08-c.db"]]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-link-secret` } });
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inPv = async (fn) => withTenant(await C.getTenant("pv"), fn);
const inPw = async (fn) => withTenant(await C.getTenant("pw"), fn);
const inPx = async (fn) => withTenant(await C.getTenant("px"), fn);

const LIVE_HERO = { title: "Live hero, published.", highlight: "", subtitle: "What shoppers see today.", primary: { label: "Shop now", href: "/collections" } };
const DRAFT_HERO = { title: "Winter repair, started.", highlight: "Winter repair", subtitle: "The night-cream routine your skin asked for.", primary: { label: "Shop night routine", href: "/collections" } };
const TYPED_HERO = { title: "Typed while the test runs", highlight: "", subtitle: "Not saved yet, and still mine.", primary: { label: "Shop typed", href: "/collections" } };
const VARIANT_B = { title: "Visibly brighter in 14 days", highlight: "14 days", subtitle: "Or your money back." };
const TEST_NAME = "Hero promise test";

for (const inT of [inPv, inPw]) {
  await inT(async () => {
    await db.insertInto("products").values({ id: "gid://t/P1", handle: "glow", title: "Glow Serum", price_min: 1299, price_max: 1299, currency: "INR", available: 1, tags: "[]" }).execute();
    await setBlock("hero", LIVE_HERO);
    await R.createRelease({ note: "pv08 fixture" });
    await setBlock("hero", DRAFT_HERO); // saved, unpublished: what the founder is editing
  });
}
await inPx(async () => {
  await db.insertInto("products").values({ id: "gid://t/P1", handle: "glow", title: "Glow Serum", price_min: 1299, price_max: 1299, currency: "INR", available: 1, tags: "[]" }).execute();
  await setBlock("hero", DRAFT_HERO); // never published: shoppers see this draft
});
for (const inT of [inPv, inPx]) {
  await inT(async () => {
    await X.upsertExperiment({
      slug: "hero-promise",
      name: TEST_NAME,
      hypothesis: "a benefit-led headline beats the brand-led control",
      min_sample: 200,
      variants: [
        { key: "control", weight: 50 },
        { key: "b", weight: 50, payload: VARIANT_B },
      ],
    });
    await X.startExperiment("hero-promise");
  });
}
const EXP = await inPv(() => X.runningExperimentFor("hero"));
const EXP_X = await inPx(() => X.runningExperimentFor("hero"));

// ---- the 8968db3 serving code, frozen: the oracle for "shoppers unchanged" -------
function baseHashUnit(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}
function baseAssignVariant(experiment, unitId) {
  const variants = experiment.variants;
  const bucket = baseHashUnit(`${experiment.salt || ""}|${experiment.slug}|${unitId}`);
  const totalWeight = variants.reduce((s, v) => s + Number(v.weight), 0);
  let acc = 0;
  for (const v of variants) {
    acc += (Number(v.weight) / totalWeight) * 10000;
    if (bucket < acc) return v.key;
  }
  return variants[variants.length - 1]?.key || "control";
}
function baseHeroVariantFor(experiment, hero, unitId) {
  if (!experiment || !unitId) return { hero, assignment: null };
  const key = baseAssignVariant(experiment, unitId);
  const variant = experiment.variants.find((v) => v.key === key);
  if (!variant || key === "control" || !variant.payload) return { hero, assignment: { slug: experiment.slug, variant: key } };
  return { hero: { ...hero, ...variant.payload }, assignment: { slug: experiment.slug, variant: key } };
}

// Units the frozen code puts in each bucket (route-valid: [a-z0-9-]{8,64}).
const unitsIn = (key, n, from = 0) => {
  const out = [];
  for (let i = from; out.length < n; i++) if (baseAssignVariant(EXP, `unit-pv08-${i}`) === key) out.push(`unit-pv08-${i}`);
  return out;
};
const B_UNITS = unitsIn("b", 40);
const C_UNITS = unitsIn("control", 40);

const token = (inT = inPv) => inT(() => R.previewToken());
const exposuresFor = (unit) => inPv(() => db.selectFrom("experiment_exposures").selectAll().where("unit_id", "=", unit).execute());
const allExposures = async () => Number((await inPv(() => db.selectFrom("experiment_exposures").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst())).n);

// ---- a small JSX loader -----------------------------------------------------------
// Each component file is compiled with Next's SWC to CommonJS. "@/lib/…" and
// relative library imports are the REAL modules (loaded natively through the
// hooks above), components load the same way as this file, packages come from
// node_modules, and `stubs` swaps the few edges a render can't have.
const compile = async (file) =>
  (
    await swc.transform(await readFile(file, "utf8"), {
      filename: file,
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" },
      module: { type: "commonjs" },
    })
  ).code;
const toFile = (from, id) => {
  const p = id.startsWith("@/") ? join(ROOT, id.slice(2)) : resolve(dirname(from), id);
  return p.endsWith(".js") ? p : `${p}.js`;
};
const isJsx = (file) => /^(app|components)\//.test(relative(ROOT, file));
async function loadJsx(file, stubs = {}, seen = new Map()) {
  if (seen.has(file)) return seen.get(file);
  const mod = { exports: {} };
  seen.set(file, mod.exports);
  const code = await compile(file);
  const deps = new Map();
  for (const [, id] of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (id in stubs || deps.has(id)) continue;
    if (id === "react" || id === "react/jsx-runtime") continue;
    if (id.startsWith("@/") || id.startsWith(".")) {
      const target = toFile(file, id);
      deps.set(id, isJsx(target) ? await loadJsx(target, stubs, seen) : await import(pathToFileURL(target).href));
    } else if (id === "next/headers") deps.set(id, await import("next/headers"));
    else deps.set(id, require(id));
  }
  const req = (id) => {
    if (id in stubs) return stubs[id];
    if (id === "react") return stubs.react || React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime");
    if (deps.has(id)) return deps.get(id);
    throw new Error(`unresolved import "${id}" in ${relative(ROOT, file)}`);
  };
  new Function("require", "module", "exports", code)(req, mod, mod.exports);
  seen.set(file, mod.exports);
  return mod.exports;
}
const nothing = { __esModule: true, default: () => null };
const link = { __esModule: true, default: ({ href, children, prefetch, ...rest }) => React.createElement("a", { href, ...rest }, children) };

// ---- 1. the storefront home page, rendered ----------------------------------------

// The ping stand-in renders a marker, so a render shows whether the page would
// have sent POST /api/exp (the real component renders nothing and pings in an
// effect, which a server render never runs).
const PING = { __esModule: true, default: ({ slug, unit }) => React.createElement("i", { "data-exp-ping": slug, "data-unit": unit }) };
const HomePage = (
  await loadJsx(join(ROOT, "app/(storefront)/page.js"), {
    "next/link": link,
    "@/components/ExperimentPing": PING,
    "@/components/EmptyCatalog": nothing,
    "@/components/site/MarketingHome": nothing,
    "@/components/sections/HomeSections": nothing,
  })
).default;

async function renderHome({ host = "pv.test", cookies = {} } = {}) {
  globalThis.__pv08Request = { host, cookies };
  try {
    return renderToStaticMarkup(await HomePage());
  } finally {
    globalThis.__pv08Request = null;
  }
}
const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const heroHtml = (html) => html.match(/<section[^>]*data-sec="hero"[\s\S]*?<\/section>/)?.[0] || "";
// the title is one line of text with the highlight in a span: join it without spaces
const h1 = (html) => text((heroHtml(html).match(/<h1[\s\S]*?<\/h1>/)?.[0] || "").replace(/<\/?span[^>]*>/g, ""));
const pinged = (html) => /data-exp-ping=/.test(html);
const NOTE_RE = /A test is running on this section/;

console.log("— the storefront home page, rendered, with the hero test running");

await t("fixture: the store really runs the hero test, and its live and draft heroes differ", async () => {
  eq(EXP?.slug, "hero-promise", "running test:");
  eq(EXP.status, "running", "status:");
  ok(B_UNITS.length === 40 && C_UNITS.length === 40, "units in both buckets");
  const shopper = await renderHome({ cookies: { _unit: C_UNITS[0] } });
  eq(h1(shopper), LIVE_HERO.title, "a control shopper's hero:");
  const preview = await renderHome({ cookies: { _unit: C_UNITS[0], [PREVIEW_COOKIE]: await token() } });
  eq(h1(preview), DRAFT_HERO.title, "the founder's preview of a control unit:");
});

await t("THE BUG: in a preview, a visitor bucketed into variant b still sees the founder's own saved hero", async () => {
  const tok = await token();
  for (const unit of B_UNITS.slice(0, 5)) {
    const html = await renderHome({ cookies: { _unit: unit, [PREVIEW_COOKIE]: tok } });
    eq(h1(html), DRAFT_HERO.title, `unit ${unit} title:`);
    ok(text(heroHtml(html)).includes(DRAFT_HERO.subtitle), `unit ${unit}: the founder's subtitle is missing: ${text(heroHtml(html)).slice(0, 200)}`);
    ok(!html.includes(VARIANT_B.title) && !html.includes(VARIANT_B.subtitle), `unit ${unit}: variant b's words are in the preview`);
  }
});

await t("THE BUG, typing: an unsaved title in the preview shows while the hero test runs", async () => {
  const tok = await token();
  await inPv(() => setPreviewCandidate(tok, { hero: TYPED_HERO }));
  try {
    for (const unit of [B_UNITS[0], C_UNITS[0], undefined]) {
      const html = await renderHome({ cookies: { ...(unit ? { _unit: unit } : {}), [PREVIEW_COOKIE]: tok } });
      eq(h1(html), TYPED_HERO.title, `unit ${unit ?? "(none)"}:`);
      ok(text(heroHtml(html)).includes(TYPED_HERO.subtitle), `unit ${unit ?? "(none)"}: the typed subtitle is missing`);
    }
  } finally {
    await inPv(() => clearPreviewCandidate(tok));
  }
});

await t("THE BUG, exposure: a preview render never mounts the exposure ping, for any bucket or no unit at all", async () => {
  const tok = await token();
  for (const unit of [...B_UNITS.slice(0, 10), ...C_UNITS.slice(0, 10), undefined]) {
    const html = await renderHome({ cookies: { ...(unit ? { _unit: unit } : {}), [PREVIEW_COOKIE]: tok } });
    ok(!pinged(html), `unit ${unit ?? "(none)"}: the preview would ping /api/exp`);
    eq(h1(html), DRAFT_HERO.title, `unit ${unit ?? "(none)"} title:`);
  }
});

await t("a preview of every bucket: 80 units, each shows the founder's hero, none pings", async () => {
  const tok = await token();
  const seen = new Set();
  for (const unit of [...B_UNITS, ...C_UNITS]) {
    const html = await renderHome({ cookies: { _unit: unit, [PREVIEW_COOKIE]: tok } });
    seen.add(`${h1(html)}|${pinged(html)}`);
  }
  eq([...seen], [`${DRAFT_HERO.title}|false`], "distinct (title|pinged) across 80 units:");
});

await t("the note: in a preview the hero says a test is running, names it, and links to it", async () => {
  const html = await renderHome({ cookies: { _unit: B_UNITS[0], [PREVIEW_COOKIE]: await token() } });
  const hero = heroHtml(html);
  ok(NOTE_RE.test(text(hero)), `no note inside the hero section: ${text(hero).slice(0, 240)}`);
  ok(text(hero).includes(`“${TEST_NAME}”`), `the note doesn't name the test: ${text(hero).slice(0, 240)}`);
  ok(text(hero).includes("Some visitors see a different version; the preview shows yours."), "the note doesn't say what the founder sees");
  ok(hero.includes('href="/admin/experiments#exp-hero-promise"'), `no link to the test's row: ${hero.slice(0, 600)}`);
  ok(!/\b(variant|exposure|bucket)\b/i.test(text(hero.match(/<[a-z]+[^>]*data-preview-note[\s\S]*?<\/(p|div)>/)?.[0] || "")), "the note uses jargon");
});

await t("NEGATIVE: shoppers never see the note, in either bucket, and a preview with no test running has none", async () => {
  for (const unit of [B_UNITS[0], C_UNITS[0]]) {
    const html = await renderHome({ cookies: { _unit: unit } });
    ok(!NOTE_RE.test(text(html)) && !html.includes("data-preview-note"), `shopper ${unit} sees the note`);
  }
  const fresh = await renderHome({ cookies: {} });
  ok(!NOTE_RE.test(text(fresh)), "a first-time shopper sees the note");
  const noTest = await renderHome({ host: "pw.test", cookies: { _unit: B_UNITS[0], [PREVIEW_COOKIE]: await token(inPw) } });
  eq(h1(noTest), DRAFT_HERO.title, "a store with no test, previewed:");
  ok(!NOTE_RE.test(text(noTest)) && !pinged(noTest), "a store with no test shows a note or pings");
});

await t("REGRESSION: signed-out shoppers are bucketed and served exactly as at 8968db3 (80 units, frozen oracle)", async () => {
  const live = { ...(await inPv(async () => (await import("../lib/cms/defaults.js")).defaultHero("pv"))), ...LIVE_HERO };
  let b = 0;
  for (const unit of [...B_UNITS, ...C_UNITS]) {
    const html = await renderHome({ cookies: { _unit: unit } });
    const want = baseHeroVariantFor(EXP, live, unit);
    eq(h1(html), want.hero.title, `unit ${unit} title:`);
    ok(text(heroHtml(html)).includes(want.hero.subtitle), `unit ${unit}: subtitle "${want.hero.subtitle}" missing`);
    eq(html.match(/data-exp-ping="([^"]+)"/)?.[1] ?? null, want.assignment?.slug ?? null, `unit ${unit} ping:`);
    eq(html.match(/data-unit="([^"]+)"/)?.[1] ?? null, unit, `unit ${unit} ping carries the unit:`);
    if (want.assignment.variant === "b") b++;
  }
  eq(b, 40, "variant b served to:");
});

await t("REGRESSION: on a store that has never published, shoppers get drafts and are still bucketed (drafts are not a preview)", async () => {
  const draft = { ...(await inPx(async () => (await import("../lib/cms/defaults.js")).defaultHero("px"))), ...DRAFT_HERO };
  const served = new Set();
  for (let i = 0; i < 40; i++) {
    const unit = `unit-px-${i}`;
    const html = await renderHome({ host: "px.test", cookies: { _unit: unit } });
    const want = baseHeroVariantFor(EXP_X, draft, unit);
    eq(h1(html), want.hero.title, `unit ${unit} title:`);
    eq(html.match(/data-exp-ping="([^"]+)"/)?.[1] ?? null, "hero-promise", `unit ${unit} ping:`);
    ok(!NOTE_RE.test(text(html)), `unit ${unit} sees the preview note`);
    served.add(want.assignment.variant);
  }
  eq([...served].sort(), ["b", "control"], "buckets served:");
  const preview = await renderHome({ host: "px.test", cookies: { _unit: "unit-px-0", [PREVIEW_COOKIE]: await token(inPx) } });
  eq(h1(preview), DRAFT_HERO.title, "the founder's preview there:");
  ok(!pinged(preview) && NOTE_RE.test(text(preview)), "the founder's preview there pings or has no note");
});

await t("REGRESSION: a first-time shopper (no unit cookie) is still bucketed and still pings", async () => {
  const titles = new Set();
  for (let i = 0; i < 30; i++) {
    const html = await renderHome({ cookies: {} });
    ok(pinged(html), "a first-time shopper's page doesn't ping");
    ok(/data-unit="[0-9a-f-]{36}"/.test(html), "the ping has no fresh unit id");
    titles.add(h1(html));
  }
  eq([...titles].sort(), [LIVE_HERO.title, VARIANT_B.title].sort(), "titles first-time shoppers got (30 visits):");
});

await t("a forged or expired preview cookie is not a preview: the live page serves as for any shopper", async () => {
  for (const bad of ["p.1.00000000000000000000", "nonsense", await token(inPw)]) {
    const html = await renderHome({ cookies: { _unit: B_UNITS[1], [PREVIEW_COOKIE]: bad } });
    eq(h1(html), VARIANT_B.title, `cookie ${bad.slice(0, 12)}…:`);
    ok(!NOTE_RE.test(text(html)), "a bad cookie shows the preview note");
  }
});

await t("unit: heroVariantFor in a preview applies nothing and returns the note; outside it matches 8968db3 for 2,000 units", () => {
  const live = { ...LIVE_HERO, badge: "" };
  const p = X.heroVariantFor(EXP, live, B_UNITS[0], { preview: true });
  ok(p.hero === live, "preview: the hero is not the founder's own object");
  eq(p.assignment, null, "preview assignment:");
  eq(p.notice, { slug: "hero-promise", name: TEST_NAME, section: "hero" }, "preview notice:");
  eq(X.heroVariantFor(null, live, B_UNITS[0], { preview: true }), { hero: live, assignment: null }, "no test, preview:");
  for (let i = 0; i < 2000; i++) {
    const unit = `u-${i}-${(i * 7919).toString(36)}`;
    eq(X.heroVariantFor(EXP, live, unit), baseHeroVariantFor(EXP, live, unit), `unit ${unit}, no options:`);
    eq(X.heroVariantFor(EXP, live, unit, { preview: false }), baseHeroVariantFor(EXP, live, unit), `unit ${unit}, preview false:`);
  }
  eq(X.heroVariantFor(EXP, live, ""), { hero: live, assignment: null }, "no unit:");
  // Random units almost never land on a split's edge, so find ones that do:
  // bucket 4999 is control's last and 5000 is b's first, at 50/50.
  for (const want of [4999, 5000]) {
    let unit = null;
    for (let i = 0; !unit && i < 200_000; i++) if (baseHashUnit(`${EXP.salt}|${EXP.slug}|edge-${i}`) === want) unit = `edge-${i}`;
    ok(unit, `no unit found in bucket ${want}`);
    eq(X.heroVariantFor(EXP, live, unit), baseHeroVariantFor(EXP, live, unit), `the unit in bucket ${want}:`);
  }
});

// ---- 2. POST /api/exp, the real route ------------------------------------------

console.log("— POST /api/exp, the real route");
const expRoute = await import("../app/api/exp/route.js");
const ping = (cookies, { host = "pv.test", slug = "hero-promise" } = {}) =>
  expRoute.POST(
    new NextRequest(`https://${host}/api/exp`, {
      method: "POST",
      headers: { host, "content-type": "application/json", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
      body: JSON.stringify({ slug }),
    }),
  );

await t("THE BUG: an exposure ping from a preview session is refused by the server, and no row is written", async () => {
  const unit = B_UNITS[10];
  const before = await allExposures();
  const res = await ping({ _unit: unit, [PREVIEW_COOKIE]: await token() });
  eq(res.status, 200, "status:");
  eq(await res.json(), { ok: true, recorded: false }, "body:");
  eq((await exposuresFor(unit)).length, 0, "rows for the unit:");
  eq(await allExposures(), before, "exposures in all:");
});

await t("NEGATIVE: any preview cookie is refused, even an expired, forged or other store's one", async () => {
  const before = await allExposures();
  for (const [i, bad] of ["p.1.00000000000000000000", "nonsense", await token(inPw)].entries()) {
    const unit = C_UNITS[10 + i];
    const res = await ping({ _unit: unit, [PREVIEW_COOKIE]: bad });
    eq(await res.json(), { ok: true, recorded: false }, `cookie ${i}:`);
    eq((await exposuresFor(unit)).length, 0, `rows for ${unit}:`);
  }
  eq(await allExposures(), before, "exposures in all:");
});

await t("REGRESSION: a shopper's ping is counted, with the variant re-derived on the server, once", async () => {
  for (const unit of [B_UNITS[20], C_UNITS[20]]) {
    const res = await ping({ _unit: unit });
    eq(await res.json(), { ok: true, recorded: true }, `${unit} body:`);
    const again = await ping({ _unit: unit });
    eq(await again.json(), { ok: true, recorded: true }, `${unit} replay body:`);
    const rows = await exposuresFor(unit);
    eq(rows.length, 1, `${unit} rows:`);
    eq(rows[0].variant, baseAssignVariant(EXP, unit), `${unit} variant:`);
  }
});

await t("REGRESSION: no unit, a bad unit or a bad slug still answer recorded:false, and another store's ping counts there only", async () => {
  eq(await (await ping({})).json(), { ok: true, recorded: false }, "no unit:");
  eq(await (await ping({ _unit: "BAD UNIT" })).json(), { ok: true, recorded: false }, "bad unit:");
  eq(await (await ping({ _unit: B_UNITS[21] }, { slug: "../x" })).json(), { ok: true, recorded: false }, "bad slug:");
  eq(await (await ping({ _unit: B_UNITS[21] }, { host: "pw.test" })).json(), { ok: true, recorded: false }, "a store with no such test:");
  eq((await exposuresFor(B_UNITS[21])).length, 0, "rows:");
});

// ---- 3. conversions -------------------------------------------------------------

console.log("— conversions");
const req = (cookies) => new NextRequest("https://pv.test/api/checkout", { method: "POST", headers: { host: "pv.test", cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });

await t("a preview session's order converts nothing; a shopper's still converts", async () => {
  ok(typeof X.conversionUnit === "function", "lib/experiments.js has no conversionUnit gate");
  const exposed = B_UNITS[20]; // exposed above, as a shopper
  eq(X.conversionUnit(req({ _unit: exposed, [PREVIEW_COOKIE]: await token() })), null, "preview:");
  eq(X.conversionUnit(req({ _unit: exposed, [PREVIEW_COOKIE]: "nonsense" })), null, "any preview cookie:");
  eq(X.conversionUnit(req({ _unit: exposed })), exposed, "shopper:");
  eq(X.conversionUnit(req({})), null, "no unit:");
  // the same units through the real conversion writer
  eq(await inPv(() => X.recordConversions(X.conversionUnit(req({ _unit: exposed, [PREVIEW_COOKIE]: "x" })), "PV08-O1", 999)), 0, "preview order converts:");
  eq(await inPv(() => X.recordConversions(X.conversionUnit(req({ _unit: exposed })), "PV08-O2", 999)), 1, "shopper order converts:");
});

// Written to hold after claude/gallant-keller-7d3213 merges too: that branch
// moves recordConversions into lib/payment-settle.js and hands it an `expUnit`
// read in the checkout route, in two new places.
await t("guard: the checkout route takes every conversion unit through conversionUnit, never the raw cookie", async () => {
  const src = await readFile(join(ROOT, "app/api/checkout/route.js"), "utf8");
  const reads = src.match(/\bexpUnit\s*=\s*[^;]+;/g) || [];
  ok(reads.length >= 2, `expected the COD and the online-payment conversion units, found ${reads.length}`);
  for (const r of reads) ok(/^expUnit\s*=\s*conversionUnit\(request\);$/.test(r), `a conversion unit read past the preview gate: ${r}`);
  ok(!/\.get\(\s*("_unit"|'_unit'|UNIT_COOKIE)\s*\)/.test(src), "the checkout route still reads the _unit cookie directly");
});

// ---- 4. the console ---------------------------------------------------------------

console.log("— the console: Designer, Designer page, Experiments");

await t("runningTestsBySection names the running hero test, and nothing on a store with none", async () => {
  ok(typeof X.runningTestsBySection === "function", "lib/experiments.js has no runningTestsBySection");
  eq(await inPv(() => X.runningTestsBySection()), { hero: { slug: "hero-promise", name: TEST_NAME } }, "pv:");
  eq(await inPw(() => X.runningTestsBySection()), {}, "pw:");
});

// The Designer with stand-in hooks (the shallow driver from test-editor-layout):
// its tree's Hero row is clicked, then the inspector it returns is rendered.
let H = null;
const hookReact = new Proxy(React, { get: (target, key) => (H && (key === "useState" || key === "useRef" || key === "useEffect") ? H[key] : target[key]) });
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
function shallow(Component, props) {
  const states = [];
  const refs = [];
  let si = 0;
  let ri = 0;
  const h = {
    useState(init) {
      const k = si++;
      if (!(k in states)) states[k] = typeof init === "function" ? init() : init;
      return [states[k], (v) => (states[k] = typeof v === "function" ? v(states[k]) : v)];
    },
    useRef(init) {
      const k = ri++;
      if (!(k in refs)) refs[k] = { current: init ?? null };
      return refs[k];
    },
    useEffect() {},
  };
  const s = {
    tree: null,
    render() {
      si = ri = 0;
      H = h;
      try {
        s.tree = Component(props);
      } finally {
        H = null;
      }
      return s;
    },
    shell() {
      for (const el of walk(s.tree)) if (el.props && "inspector" in el.props && "tree" in el.props) return el;
      throw new Error("no editor shell in the Designer's tree");
    },
  };
  return s.render();
}
const consoleStubs = {
  react: hookReact,
  "next/link": link,
  "next/navigation": { usePathname: () => "/admin/storefront/designer", useRouter: () => ({ push() {}, refresh() {}, replace() {} }) },
  "@/components/admin/StoreSwitcher": nothing,
  "@/components/console/Toast": { useToast: () => ({ success() {}, info() {}, error() {} }) },
  "./api": new Proxy({}, { get: () => async () => ({ ok: false }) }),
  "./useDirtyGuard": { useDirtyGuard() {} },
  "./MediaPicker": { MediaPicker: () => null },
  "./RefPicker": { CollectionPicker: () => null, ProductPicker: () => null, refLabel: (x) => x?.title || "" },
};
const Designer = (await loadJsx(join(ROOT, "components/admin/cms/Designer.js"), consoleStubs)).default;
const designerInitial = {
  customized: { hero: true, announcement: false, home_sections: true },
  revisions: { hero: 1, announcement: null, home_sections: 2 },
  blocks: {
    hero: DRAFT_HERO,
    announcement: { enabled: true, text: "Sale", href: "" },
    home_sections: [{ id: "sec_1", kind: "collections", title: "Shop by collection", enabled: true }],
  },
};
const TESTS = { hero: { slug: "hero-promise", name: TEST_NAME } };
function designer(tests, pick = 0) {
  const s = shallow(Designer, { initial: designerInitial, tests });
  const rows = [...walk(s.shell().props.tree)].filter((el) => el.props?.["data-tree-pick"]);
  ok(rows.length >= 2, "the tree has no Hero and Announcement rows");
  rows[pick].props.onClick();
  s.render();
  const shell = s.shell();
  return { inspector: renderToStaticMarkup(shell.props.inspector), tree: renderToStaticMarkup(shell.props.tree) };
}

await t("Designer: the hero's settings say a test is running, name it, and link to its row", () => {
  const { inspector } = designer(TESTS, 0);
  ok(inspector.includes('id="ins-hero-title"'), "the hero's settings aren't the ones shown");
  ok(NOTE_RE.test(text(inspector)), `no note beside the hero settings: ${text(inspector).slice(0, 300)}`);
  ok(text(inspector).includes(`“${TEST_NAME}”`), "the note doesn't name the test");
  ok(text(inspector).includes("Some visitors see a different version; the preview shows yours."), "the note doesn't say what the preview shows");
  ok(inspector.includes('href="/admin/experiments#exp-hero-promise"'), "no link to the test's row");
  ok(inspector.indexOf("A test is running") < inspector.indexOf('id="ins-hero-title"'), "the note should come before the fields");
});

await t("Designer: the tree marks the hero while a test runs on it", () => {
  const { tree } = designer(TESTS, 0);
  const heroRow = tree.match(/<li[\s\S]*?<\/li>/)?.[0] || "";
  ok(text(heroRow).includes("Hero") && text(heroRow).includes("Test running"), `hero row: ${text(heroRow)}`);
  // The mark describes the row; it isn't part of its name, so "Hero" stays the
  // button's name (drills and screen readers find it by that).
  ok(/<button[^>]*aria-describedby="tree-hero-test"/.test(heroRow), `the Hero button isn't described by the mark: ${heroRow.slice(0, 300)}`);
  ok(/<span id="tree-hero-test" aria-hidden="true">/.test(heroRow), "the mark is part of the button's name");
});

await t("NEGATIVE: with no test running the Designer shows no note, and the announcement's settings never do", () => {
  for (const tests of [undefined, {}]) {
    const { inspector, tree } = designer(tests, 0);
    ok(inspector.includes('id="ins-hero-title"') && !NOTE_RE.test(text(inspector)), "a note with no test");
    ok(!text(tree).includes("Test running"), "a tree mark with no test");
  }
  const { inspector } = designer(TESTS, 1);
  ok(inspector.includes('id="ins-ann-text"') && !NOTE_RE.test(text(inspector)), "the announcement's settings carry the hero's note");
});

await t("the Designer page loads the running tests and hands them to the Designer", async () => {
  let got = null;
  const page = await loadJsx(join(ROOT, "app/(console)/admin/(authed)/storefront/designer/page.js"), {
    "next/navigation": { redirect: (to) => { throw new Error(`redirected to ${to}`); } },
    "@/lib/admin-auth": { adminActor: async () => ({ id: "owner", role: "owner" }), ADMIN_COOKIE: "_admin", PLATFORM_COOKIE: "_platform" },
    "@/components/admin/cms/Designer": { __esModule: true, default: (props) => ((got = props), null) },
  });
  for (const [host, want] of [["pv.test", TESTS], ["pw.test", {}]]) {
    got = null;
    globalThis.__pv08Request = { host, cookies: { _admin: "x" } };
    try {
      renderToStaticMarkup(await page.default());
    } finally {
      globalThis.__pv08Request = null;
    }
    ok(got?.initial?.blocks?.hero, `${host}: the Designer got no initial view`);
    eq(got.tests, want, `${host} tests:`);
  }
});

await t("Experiments: each test's row carries the anchor the notes link to", async () => {
  const { default: ExperimentsAdmin } = await loadJsx(join(ROOT, "components/admin/ExperimentsAdmin.js"), { ...consoleStubs, react: React });
  const list = await inPv(() => X.listExperiments());
  const html = renderToStaticMarkup(React.createElement(ExperimentsAdmin, { initial: list }));
  ok(html.includes('id="exp-hero-promise"'), `no row anchor: ${html.slice(0, 300)}`);
});

// ---- 5. guard: every place a variant is picked or applied is gated ------------------

console.log("— guard");

async function sources(dir) {
  const out = [];
  for (const e of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
const APP_FILES = [...(await sources("app")), ...(await sources("lib")), ...(await sources("components"))];
const SRC = new Map(await Promise.all(APP_FILES.map(async (f) => [f, await readFile(join(ROOT, f), "utf8")])));
const using = (re) => [...SRC].filter(([f, s]) => f !== "lib/experiments.js" && re.test(s)).map(([f]) => f).sort();

await t("guard: only the known, gated places pick, apply or count a variant (a new one must be gated, then listed here)", () => {
  eq(using(/\bassignVariant\(/), [], "assignVariant outside lib/experiments.js:");
  eq(using(/\bheroVariantFor\(/), ["app/(storefront)/page.js"], "heroVariantFor:");
  eq(using(/\brunningExperimentFor\(/), ["app/(storefront)/page.js"], "runningExperimentFor:");
  eq(using(/<ExperimentPing\b/), ["app/(storefront)/page.js"], "the exposure ping:");
  eq(using(/["'`]\/api\/exp["'`]/), ["components/ExperimentPing.js"], "callers of /api/exp:");
  eq(using(/\brecordExposure\(/), ["app/api/exp/route.js"], "recordExposure:");
  // lib/payment-settle.js is where claude/gallant-keller-7d3213 moves the call
  const conv = using(/\brecordConversions\(/);
  ok(conv.length && conv.every((f) => ["app/api/checkout/route.js", "lib/payment-settle.js"].includes(f)), `recordConversions callers: ${JSON.stringify(conv)}`);
  // the visitor's unit is read raw only where it is gated: the home page (with
  // the preview state) and the exposure route (after its preview check)
  eq(using(/\.get\(\s*(?:"_unit"|'_unit'|UNIT_COOKIE)\s*\)/), ["app/(storefront)/page.js", "app/api/exp/route.js"], "raw reads of the _unit cookie:");
  eq(X.TARGET_KINDS, ["hero"], "experiment targets (a new one needs its own preview gate and note):");
});

await t("guard: the home page passes the preview state to the hero test, and pings only with an assignment", () => {
  const src = SRC.get("app/(storefront)/page.js");
  ok(/heroVariantFor\([^)]*\{\s*preview:\s*src\.preview\s*\}\s*\)/.test(src), "heroVariantFor is called without { preview: src.preview }");
  ok(/\{assignment && <ExperimentPing\b/.test(src), "the ping no longer depends on an assignment");
  ok(/recordExposure\(/.test(SRC.get("app/api/exp/route.js")) && SRC.get("app/api/exp/route.js").indexOf("isPreviewRequest(request)") < SRC.get("app/api/exp/route.js").indexOf("recordExposure("), "the route records before it checks for a preview");
});

await t("edge: the storefront files this item touches import nothing from node:", () => {
  for (const f of ["app/(storefront)/page.js", "components/preview/ExperimentNote.js", "lib/experiments.js", "lib/cms/candidates.js"]) {
    const s = SRC.get(f);
    ok(s != null, `${f} is missing`);
    ok(!/from\s+["']node:|require\(\s*["']node:/.test(s), `${f} imports a node: module`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(ROOT, f), { force: true });
process.exit(fail ? 1 : 0);
