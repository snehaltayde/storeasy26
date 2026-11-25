// Product-finder quizzes on the new UI (docs/plans/phase-2.md "Line 10"):
// who may do what (decision 6), where a quiz is used, and what each role's
// screen holds.
//   pnpm test:quizzes-ui
//   1. the route, support (the least-trusted) first: every read answers;
//      save, turn on and delete are refused and change nothing
//   2. decision 6: staff save quizzes that are Off; turning one On, or
//      editing or deleting one that is On, is 403 for staff and works for
//      admin, audited as storefront.publish
//   3. where a quiz is used (live and draft pages, exact slug) and the 409
//      QUIZ_IN_USE with the page names; the row stays. 3b: the delete and
//      the staff save are each one guarded statement (a link or a turn-On
//      that lands after the reads stops them); try writes nothing
//   4. the anonymous shopper: an Off quiz is 404 at /api/quiz/<slug> and
//      /quiz/<slug>; another store's slug is 404 everywhere
//   5. the pages as support, staff and signed out (scripts/support/page-harness.js)
//   6. the screens' markup per role (Next's SWC, react-dom/server): support
//      has no Save, Delete or On/Off and every field disabled; staff's On/Off
//      and an On quiz's writes are RoleGate's
//   7. the rules the editor shares with the API (validateQuiz problems, the
//      address from a title) and the catalog page's tray gone
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
process.env.DATABASE_URL = "file:.test-quizui-default.db";
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
const store = await H.makeRoleStore({ name: "quizui" });
const { a, b, call } = store;
const R = await import("../lib/registry/index.js");
const { listAudit } = await import("../lib/platform/audit.js");
const Q = { questions: [{ prompt: "Your goal?", options: [{ label: "Muscle", tags: ["muscle"] }, { label: "Energy", tags: ["energy"] }] }] };
const quiz = (slug, extra = {}) => ({ slug, title: `Quiz ${slug}`, intro: "", ...Q, ...extra });

async function sql(t, s, args = []) {
  const c = t.client();
  try {
    return (await c.execute({ sql: s, args })).rows;
  } finally {
    c.close();
  }
}
const now = new Date().toISOString();
const plantQuiz = (t, slug, enabled) =>
  sql(t, "INSERT OR REPLACE INTO quizzes (slug, title, intro, questions, enabled, updated_at) VALUES (?, ?, '', ?, ?, ?)", [
    slug,
    `Quiz ${slug}`,
    JSON.stringify([{ id: "q1", prompt: "Your goal?", options: [{ id: "q1o1", label: "Muscle", tags: ["muscle"] }, { id: "q1o2", label: "Energy", tags: ["energy"] }] }]),
    enabled ? 1 : 0,
    now,
  ]);
const rowOf = async (t, slug) => (await sql(t, "SELECT slug, title, enabled FROM quizzes WHERE slug = ?", [slug]))[0] ?? null;

// a: "off-one" Off, "on-one" On, "fit" On and linked from the home page (live
// and draft), "fitness" Off and linked nowhere (its name starts like fit's);
// b: "bonly", On, which store a must never show
await plantQuiz(a, "off-one", false);
await plantQuiz(a, "on-one", true);
await plantQuiz(a, "fit", true);
await plantQuiz(a, "fitness", false);
await plantQuiz(b, "bonly", true);
const banner = (href) => ({ ...R.newSection("banner", { id: "sec_qz1" }), settings: { ...R.newSection("banner").settings, title: "Find yours", button: { label: "Take the quiz", link: { type: "url", href } } } });
const homeDraft = JSON.stringify({ ...R.emptyBody("home"), sections: [banner("/quiz/fit?from=home")] });
const promoDraft = JSON.stringify({ ...R.emptyBody("home"), sections: [banner("/quiz/fit")] });
await sql(a, "INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_home', 'home', 'Home page', ?, 'h1', 1, 'ver_qz_live', ?, ?)", [homeDraft, now, now]);
await sql(a, "INSERT INTO documents (id, type, slug, label, draft, draft_hash, schema_version, created_at, updated_at) VALUES ('doc_promo', 'page', 'promo', 'Summer promo', ?, 'h2', 1, ?, ?)", [promoDraft, now, now]);
await sql(a, "INSERT INTO documents (id, type, slug, label, draft, draft_hash, schema_version, archived_at, created_at, updated_at) VALUES ('doc_gone', 'page', 'gone', 'Old page', ?, 'h3', 1, ?, ?, ?)", [promoDraft, now, now, now]);
await sql(a, "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_qz_live', 'quiz', 'fit')");
await sql(b, "INSERT INTO documents (id, type, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_home', 'home', 'B home', '{}', 'h', 1, 'ver_b', ?, ?)", [now, now]);
await sql(b, "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_b', 'quiz', 'off-one')");
// open both stores (a store that never published answers no quiz)
{
  const { emptyList } = await import("../lib/documents/release-list.js");
  const types = R.singletonTypes();
  const list = emptyList(Math.max(1, ...types.map((x) => R.documentType(x).sinceManifest || 1)), types);
  for (const t of [a, b]) {
    await sql(t, "INSERT INTO releases (id, content, content_hash, note, created_at, published_at) VALUES ('rel_open', ?, 'h', 'open', ?, ?)", [JSON.stringify(list), now, now]);
    await sql(t, "INSERT OR REPLACE INTO release_state (id, live_release_id, updated_at) VALUES (1, 'rel_open', ?)", [now]);
  }
}

console.log("— 1. the route, support first");
await t("support: the list, one quiz (Off included), usage, tags and Try it all answer 200", async () => {
  const list = await call("support", "quiz", "GET");
  eq(list.status, 200);
  eq(list.body.quizzes.map((z) => [z.slug, z.enabled, z.usedOn]).sort(), [["fit", true, 2], ["fitness", false, 0], ["off-one", false, 0], ["on-one", true, 0]], "rows [slug, on, pages]:");
  ok(list.body.quizzes.every((z) => z.questionCount === 1 && typeof z.updated_at === "string"), "question count and updated:");
  const one = await call("support", "quiz", "GET", { query: "slug=off-one" });
  eq([one.status, one.body.quiz.enabled, one.body.quiz.questions.length, one.body.pages], [200, false, 1, []]);
  eq((await call("support", "quiz", "GET", { query: "view=usage&slug=fit" })).body.pages.map((p) => p.document), ["doc_home", "doc_promo"]);
  const tags = await call("support", "quiz", "GET", { query: "view=tags" });
  eq(tags.status, 200);
  ok(Array.isArray(tags.body.tags), "tags:");
  const tr = await call("support", "quiz", "GET", { query: "view=try&tags=muscle,energy" });
  eq([tr.status, tr.body.topTags], [200, ["muscle", "energy"]]);
  ok(Array.isArray(tr.body.products), "products:");
});
await t("support: save, turn on and delete are 403 and change nothing (nor the audit log)", async () => {
  const before = (await listAudit({ tenantId: a.id, limit: 200 })).length;
  for (const body of [{ quiz: quiz("off-one", { title: "Changed" }) }, { quiz: quiz("off-one"), enabled: true }, { quiz: quiz("brand-new"), create: true }, { remove: { slug: "off-one" } }, { remove: { slug: "fit" } }]) {
    eq((await call("support", "quiz", "POST", { body })).status, 403, JSON.stringify(body).slice(0, 60));
  }
  eq(await rowOf(a, "off-one"), { slug: "off-one", title: "Quiz off-one", enabled: 0 });
  eq(await rowOf(a, "brand-new"), null);
  eq((await listAudit({ tenantId: a.id, limit: 200 })).length, before, "audit rows:");
});
await t("signed out: 401 on every read and write", async () => {
  for (const [m, opts] of [["GET", {}], ["GET", { query: "view=tags" }], ["POST", { body: { quiz: quiz("x") } }]]) eq((await call("signed-out", "quiz", m, opts)).status, 401);
});

console.log("— 2. decision 6: On needs storefront.publish");
await t("staff: POST {quiz, enabled:true} is 403 QUIZ_NEEDS_PUBLISH and the quiz stays Off", async () => {
  const r = await call("staff", "quiz", "POST", { body: { quiz: quiz("off-one"), enabled: true } });
  eq([r.status, r.body.code], [403, "QUIZ_NEEDS_PUBLISH"]);
  ok(/owner or admin/.test(r.body.error), "the words say who can:");
  eq((await rowOf(a, "off-one")).enabled, 0);
});
await t("staff: editing a quiz that is On is 403 (title unchanged), turning it off too", async () => {
  eq((await call("staff", "quiz", "POST", { body: { quiz: quiz("on-one", { title: "Staff edit" }) } })).status, 403);
  eq((await call("staff", "quiz", "POST", { body: { quiz: quiz("on-one"), enabled: false } })).status, 403);
  eq(await rowOf(a, "on-one"), { slug: "on-one", title: "Quiz on-one", enabled: 1 });
});
await t("staff: saving a quiz that is Off is 200, stays Off, audited as storefront.write; a new one is made Off", async () => {
  const r = await call("staff", "quiz", "POST", { body: { quiz: quiz("off-one", { title: "Staff title" }) } });
  eq([r.status, r.body.quiz.enabled], [200, false]);
  eq(await rowOf(a, "off-one"), { slug: "off-one", title: "Staff title", enabled: 0 });
  const made = await call("staff", "quiz", "POST", { body: { quiz: quiz("staff-made"), create: true } });
  eq([made.status, (await rowOf(a, "staff-made")).enabled], [200, 0]);
  const rows = await listAudit({ tenantId: a.id, limit: 10 });
  eq(rows.find((x) => x.resource === "quiz:off-one")?.action, "storefront.write");
});
await t("staff: deleting a quiz that is On is 403; an Off one that no page uses is deleted", async () => {
  eq((await call("staff", "quiz", "POST", { body: { remove: { slug: "on-one" } } })).status, 403);
  ok(await rowOf(a, "on-one"), "the On quiz stays:");
  eq((await call("staff", "quiz", "POST", { body: { remove: { slug: "staff-made" } } })).status, 200);
  eq(await rowOf(a, "staff-made"), null);
});
await t("admin: turns a quiz On (audited as storefront.publish), edits it while On, and turns it Off", async () => {
  const on = await call("admin", "quiz", "POST", { body: { quiz: quiz("off-one"), enabled: true } });
  eq([on.status, on.body.quiz.enabled, (await rowOf(a, "off-one")).enabled], [200, true, 1]);
  const audit = (await listAudit({ tenantId: a.id, limit: 10 })).find((x) => x.resource === "quiz:off-one");
  eq(audit.action, "storefront.publish");
  eq((await call("admin", "quiz", "POST", { body: { quiz: quiz("off-one", { title: "Admin title" }) } })).status, 200);
  eq(await rowOf(a, "off-one"), { slug: "off-one", title: "Admin title", enabled: 1 }, "enabled left out keeps it On:");
  eq((await call("admin", "quiz", "POST", { body: { quiz: quiz("off-one"), enabled: false } })).status, 200);
  eq((await rowOf(a, "off-one")).enabled, 0);
});
await t("create: a taken address is 409 QUIZ_SLUG_TAKEN and the quiz is untouched; bad input is 422 with problems by field", async () => {
  const r = await call("owner", "quiz", "POST", { body: { quiz: quiz("fitness", { title: "Overwrite" }), create: true } });
  eq([r.status, r.body.code], [409, "QUIZ_SLUG_TAKEN"]);
  eq((await rowOf(a, "fitness")).title, "Quiz fitness");
  const bad = await call("owner", "quiz", "POST", { body: { quiz: { slug: "Bad Slug", title: "", questions: [{ prompt: "", options: [{ label: "x" }] }] }, create: true } });
  eq(bad.status, 422);
  eq(bad.body.problems.map((p) => p.at), ["slug", "title", "q1", "q1"]);
  eq((await call("owner", "quiz", "POST", { body: { remove: { slug: "missing" } } })).status, 404);
});

console.log("— 3. where a quiz is used");
const U = await import("../lib/admin/quiz-usage.js");
await t("quizUsage: fit is on the home page (live and draft) and the promo draft; never an archived page, never fitness; store b's refs stay in b", async () => {
  const m = await a.run(() => U.quizUsage());
  eq(m.get("fit"), [
    { document: "doc_home", name: "Home page", live: true, draft: true },
    { document: "doc_promo", name: "Summer promo", live: false, draft: true },
  ]);
  eq([m.has("fitness"), m.has("off-one")], [false, false]);
  eq([...(await b.run(() => U.quizUsage())).keys()], ["off-one"]);
});
await t("deleting a quiz the home page uses: 409 QUIZ_IN_USE with the page names, the row stays (owner, even with publish)", async () => {
  const r = await call("owner", "quiz", "POST", { body: { remove: { slug: "fit" } } });
  eq([r.status, r.body.code], [409, "QUIZ_IN_USE"]);
  eq(r.body.pages.map((p) => p.name), ["Home page", "Summer promo"]);
  ok(/turn it off instead/i.test(r.body.error), "the words offer turning it off:");
  ok(await rowOf(a, "fit"), "the row stays:");
});

console.log("— 3b. the races: one guarded statement each");
const QZ = await import("../lib/quiz.js");
await t("guardedDeleteQuiz: a draft or live link that lands after the usage read stops the delete; the state the caller read must still hold; /quiz/race-two never blocks race", async () => {
  await plantQuiz(a, "race", false);
  await plantQuiz(a, "race-two", false);
  await plantQuiz(a, "race-live", false);
  await plantQuiz(a, "race-on", true);
  // as if a founder saved these links between the route's usage read and its DELETE
  await sql(a, "INSERT INTO documents (id, type, slug, label, draft, draft_hash, schema_version, created_at, updated_at) VALUES ('doc_race', 'page', 'race', 'Race page', ?, 'h4', 1, ?, ?)", [JSON.stringify({ ...R.emptyBody("home"), sections: [banner("/quiz/race-two")] }), now, now]);
  await sql(a, "INSERT INTO documents (id, type, slug, label, draft, draft_hash, schema_version, published_version_id, created_at, updated_at) VALUES ('doc_race_live', 'page', 'race-live', 'Live race page', '{}', 'h5', 1, 'ver_race', ?, ?)", [now, now]);
  await sql(a, "INSERT INTO document_refs (version_id, ref_type, ref_id) VALUES ('ver_race', 'quiz', 'race-live')");
  eq(await a.run(() => U.guardedDeleteQuiz("race-two", false)), 0, "a draft link:");
  eq(await a.run(() => U.guardedDeleteQuiz("race-live", false)), 0, "a live link:");
  eq(await a.run(() => U.guardedDeleteQuiz("race-on", false)), 0, "turned On since it was read:");
  ok((await rowOf(a, "race-two")) && (await rowOf(a, "race-live")) && (await rowOf(a, "race-on")), "the rows stay:");
  eq(await a.run(() => U.guardedDeleteQuiz("race", false)), 1, "race (only race-two is linked):");
  eq(await rowOf(a, "race"), null);
  const r = await call("owner", "quiz", "POST", { body: { remove: { slug: "race-two" } } });
  eq([r.status, r.body.code, r.body.pages.map((p) => p.name)], [409, "QUIZ_IN_USE", ["Race page"]]);
});
await t("gate race: staff opens a quiz that is Off, admin turns it On, staff's save is refused and the quiz stays On (in the route, and in the write itself)", async () => {
  await plantQuiz(a, "gate", false);
  const seen = (await call("staff", "quiz", "GET", { query: "slug=gate" })).body.quiz;
  eq(seen.enabled, false, "staff loaded it Off:");
  eq((await call("admin", "quiz", "POST", { body: { quiz: quiz("gate"), enabled: true } })).status, 200);
  const r = await call("staff", "quiz", "POST", { body: { quiz: { ...seen, title: "Staff's stale edit" } } });
  eq([r.status, r.body.code], [403, "QUIZ_NEEDS_PUBLISH"]);
  eq(await rowOf(a, "gate"), { slug: "gate", title: "Quiz gate", enabled: 1 });
  // the statement's own guard, for a turn-On that lands after the route's read
  let code = null;
  await a.run(() => QZ.upsertQuiz(quiz("gate", { title: "Raced" }), { onlyIfOff: true })).catch((e) => (code = e.code));
  eq([code, await rowOf(a, "gate")], ["QUIZ_NOW_ON", { slug: "gate", title: "Quiz gate", enabled: 1 }]);
  // and the delete's: staff's enabled = 0 guard leaves an On quiz in place
  eq(await a.run(() => U.guardedDeleteQuiz("gate", false)), 0);
  ok(await rowOf(a, "gate"), "still there:");
});
await t("staff creating a new slug with enabled:true is 403 and makes nothing; upsertQuiz saves Off unless told", async () => {
  const r = await call("staff", "quiz", "POST", { body: { quiz: quiz("staff-on"), create: true, enabled: true } });
  eq([r.status, r.body.code, await rowOf(a, "staff-on")], [403, "QUIZ_NEEDS_PUBLISH", null]);
  await a.run(() => QZ.upsertQuiz(quiz("default-off")));
  eq((await rowOf(a, "default-off")).enabled, 0);
});
await t("view=try writes no audit row and no slog line", async () => {
  const before = (await listAudit({ tenantId: a.id, limit: 200 })).length;
  const lines = [];
  const orig = console.log;
  console.log = (...x) => lines.push(x.map(String).join(" "));
  let r;
  try {
    r = await call("staff", "quiz", "GET", { query: "view=try&tags=muscle" });
  } finally {
    console.log = orig;
  }
  eq(r.status, 200);
  eq(lines.filter((l) => /"evt"/.test(l)), [], "slog lines:");
  eq((await listAudit({ tenantId: a.id, limit: 200 })).length, before, "audit rows:");
});

console.log("— 4. the anonymous shopper and the other store");
const { NextRequest } = await import("./support/next-server-stub.js");
const sfQuiz = await import("../app/api/quiz/[slug]/route.js");
const shopper = async (slug, host = a.tenant.domains[0]) => {
  const res = await sfQuiz.POST(new NextRequest(`http://${host}/api/quiz/${slug}`, { method: "POST", headers: { host, "content-type": "application/json", origin: `http://${host}` }, body: JSON.stringify({ answers: { q1: "q1o1" } }) }), { params: Promise.resolve({ slug }) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const C = await import("../lib/platform/control.js");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const SF = "app/(storefront)/quiz/[slug]/page.js";
await t("an Off quiz is 404 at /api/quiz/<slug> and /quiz/<slug>; an On one answers", async () => {
  eq((await shopper("fitness")).status, 404);
  ok((await pages.run(SF, { params: { slug: "fitness" } })).notFound, "the page is a not-found:");
  const on = await shopper("fit");
  eq([on.status, on.body.ok], [200, true]);
  const page = await pages.run(SF, { params: { slug: "fit" } });
  eq([page.notFound ?? false, page.error?.message ?? null], [false, null]);
});
await t("another store's slug is 404: the shopper API and page on a's host, and a's console", async () => {
  eq((await shopper("bonly")).status, 404);
  ok((await pages.run(SF, { params: { slug: "bonly" } })).notFound, "page:");
  eq((await call("owner", "quiz", "GET", { query: "slug=bonly" })).status, 404);
  eq((await call("owner", "quiz", "POST", { body: { remove: { slug: "bonly" } } })).status, 404);
  ok(!(await call("support", "quiz", "GET")).text.includes("bonly"), "a's list never names it:");
  eq((await shopper("bonly", b.tenant.domains[0])).status, 200, "b's own host still answers:");
});

console.log("— 5. the pages");
const LIST = "app/(console)/admin/(authed)/quizzes/page.js";
const ONE = "app/(console)/admin/(authed)/quizzes/[slug]/page.js";
const propsOf = (run, name) => run.props.filter((p) => p.component.endsWith(`#${name}`)).map((p) => p.props);
await t("support: the list gets the quizzes with usedOn and canWrite false; the editor gets the quiz, its pages, the tags, canWrite and canPublish false", async () => {
  const list = await pages.run(LIST, { cookies: store.cookies.support });
  eq([list.error?.message ?? null, list.unresolved], [null, []]);
  const l = propsOf(list, "QuizList")[0];
  eq([Object.keys(l).sort(), l.role, l.canWrite], [["canWrite", "quizzes", "role"], "support", false]);
  eq(l.quizzes.find((z) => z.slug === "fit").usedOn, 2);
  ok(!list.text.includes("bonly"), "nothing of store b:");
  const one = await pages.run(ONE, { cookies: store.cookies.support, params: { slug: "fit" } });
  const e = propsOf(one, "QuizEditor")[0];
  eq([Object.keys(e).sort(), e.canWrite, e.canPublish, e.initial.slug, e.pages.length], [["canPublish", "canWrite", "initial", "pages", "role", "tags"], false, false, "fit", 2]);
  ok(Object.values(e).every((v) => typeof v !== "function"), "no handlers:");
});
await t("support: /admin/quizzes/new goes back to the list; an unknown slug and store b's are not-found; signed out goes to sign-in", async () => {
  eq((await pages.run(ONE, { cookies: store.cookies.support, params: { slug: "new" } })).redirect, "/admin/quizzes");
  ok((await pages.run(ONE, { cookies: store.cookies.support, params: { slug: "missing" } })).notFound, "missing:");
  ok((await pages.run(ONE, { cookies: store.cookies.owner, params: { slug: "bonly" } })).notFound, "store b's:");
  eq((await pages.run(LIST, { cookies: {} })).redirect, "/admin/login");
});
await t("staff: canWrite without canPublish; admin: both; new opens the create form", async () => {
  const s = propsOf(await pages.run(ONE, { cookies: store.cookies.staff, params: { slug: "new" } }), "QuizEditor")[0];
  eq([s.initial, s.canWrite, s.canPublish], [null, true, false]);
  const ad = propsOf(await pages.run(ONE, { cookies: store.cookies.admin, params: { slug: "fit" } }), "QuizEditor")[0];
  eq([ad.canWrite, ad.canPublish], [true, true]);
});

console.log("— 6. the screens' markup");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const stubs = {
  "@/components/kit/toast": { useToast: () => ({ success() {}, error() {}, info() {} }) },
  "next/navigation": { useRouter: () => ({ refresh() {}, replace() {}, push() {} }), usePathname: () => "/admin/quizzes" },
};
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
    if (stubs[id]) deps.set(id, stubs[id]);
    else if (/^@\/(components\/(ui|kit|admin\/quizzes|admin\/offers)|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("./")) deps.set(id, await load(resolveLocal(`@/${join(dirname(rel), id)}`)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const { QuizList } = await load("components/admin/quizzes/QuizList.js");
const { QuizEditor, slugFrom } = await load("components/admin/quizzes/QuizEditor.js");
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
const listData = (await call("owner", "quiz", "GET")).body.quizzes;
const fitRow = (await call("owner", "quiz", "GET", { query: "slug=fit" })).body;
const offRow = (await call("owner", "quiz", "GET", { query: "slug=fitness" })).body;
const TAGS = [{ tag: "muscle", products: 3, inStock: 2 }];
const editor = (role, row, can = {}) => html(React.createElement(QuizEditor, { initial: row?.quiz ?? null, pages: row?.pages ?? [], tags: TAGS, role, canWrite: can.write ?? false, canPublish: can.publish ?? false }));
const tags = (s, re) => [...s.matchAll(re)].map((m) => m[0]);
const buttons = (s) => tags(s, /<button[^>]*>/g);
// Radix's radio items render a hidden native radio on the server (aria-hidden,
// tabindex -1, dropped in the browser outside a form): not a field
const fields = (s) => tags(s, /<(input|textarea)[^>]*>/g).filter((x) => !/aria-hidden="true"[^>]*tabindex="-1"/.test(x));

await t("support's list: the rows (address, On/Off, questions, pages), New quiz RoleGate-disabled, every button and link a marked read", () => {
  const s = html(React.createElement(QuizList, { quizzes: listData, role: "support", canWrite: false }));
  ok(s.includes("/quiz/fit") && s.includes('data-quiz-state="on"') && s.includes("Used on 2 pages") && s.includes("Not used on a page"), "the columns:");
  ok(/<a[^>]*data-role-gate="disabled"[^>]*>.*?New quiz/.test(s) && !s.includes('href="/admin/quizzes/new"'), "New quiz gated, no href:");
  eq(buttons(s).filter((x) => !x.includes("data-read-control")), [], "unmarked buttons:");
  eq(tags(s, /<a [^>]*href=[^>]*>/g).filter((x) => !x.includes("data-read-control")), [], "unmarked links:");
  ok(html(React.createElement(QuizList, { quizzes: [], role: "staff", canWrite: true })).includes("Make your first quiz"), "the empty state:");
});
await t("support's editor: no Save, Delete or On/Off; every field disabled; no tag picker; Try it and Back to quizzes are marked reads", () => {
  for (const row of [fitRow, offRow]) {
    const s = editor("support", row);
    for (const bad of ["data-quiz-save", "data-quiz-toggle", "data-quiz-delete-open", "data-role-gate", "Add a question", "Add a tag", "Unsaved changes"]) ok(!s.includes(bad), `no ${bad}:`);
    eq(fields(s).filter((x) => !/\sdisabled=""/.test(x)), [], "enabled fields:");
    eq(buttons(s).filter((x) => !x.includes("data-read-control")), [], "unmarked buttons:");
    ok(s.includes("data-quiz-try") && s.includes("Back to quizzes"), "the reads:");
  }
  ok(editor("support", fitRow).includes("Open on the store") && !editor("support", offRow).includes("Open on the store"), "Open on the store only when On:");
  ok(editor("support", fitRow).includes("Home page (live and draft)"), "where it's used, by name:");
});
await t("staff: an Off quiz has Save and Delete live and Turn on RoleGate's; an On quiz is read-only with Save, Delete and Turn off RoleGate's and the reason", () => {
  const off = editor("staff", offRow, { write: true });
  ok(/<button[^>]*data-quiz-save[^>]*>/.test(off) && !/<button[^>]*data-role-gate[^>]*data-quiz-save|data-quiz-save[^>]*data-role-gate/.test(off), "Save live:");
  ok(/data-role-gate="disabled"[^>]*data-quiz-toggle="on"|data-quiz-toggle="on"[^>]*data-role-gate="disabled"/.test(off), "Turn on gated:");
  ok(!/data-role-gate="disabled"[^>]*data-quiz-delete-open|data-quiz-delete-open[^>]*data-role-gate="disabled"/.test(off), "Delete live:");
  const on = editor("staff", fitRow, { write: true });
  for (const k of ["data-quiz-save", 'data-quiz-toggle="off"', "data-quiz-delete-open"]) ok(new RegExp(`<button[^>]*(data-role-gate="disabled"[^>]*${k}|${k}[^>]*data-role-gate="disabled")`).test(on), `${k} gated:`);
  ok(on.includes("data-quiz-locked") && on.includes("Only an owner or admin"), "the reason:");
  eq(fields(on).filter((x) => !/\sdisabled=""/.test(x)), [], "fields disabled on an On quiz:");
  ok(editor("staff", null, { write: true }).includes("An owner or admin can turn it on"), "a new quiz says it saves Off:");
});
await t("owner: everything live, the address locked on an edit, Turn on after saving on a new quiz", () => {
  const s = editor("owner", fitRow, { write: true, publish: true });
  ok(!s.includes("data-role-gate"), "nothing gated:");
  ok(s.includes("data-quiz-address") && !/id="quiz-slug"[^>]*<input|<input[^>]*id="quiz-slug"/.test(s), "the address is text, not a field:");
  const n = editor("owner", null, { write: true, publish: true });
  ok(/<input[^>]*id="quiz-slug"/.test(n) && n.includes("Turn on after saving"), "new:");
});
await t("rendering the list and the editor logs no React warning", () => {
  const errs = [];
  const orig = console.error;
  console.error = (...x) => errs.push(x.map(String).join(" ").slice(0, 300));
  try {
    html(React.createElement(QuizList, { quizzes: listData, role: "owner", canWrite: true }));
    for (const [role, can] of [["support", {}], ["staff", { write: true }], ["owner", { write: true, publish: true }]]) for (const row of [fitRow, offRow, null]) editor(role, row, can);
  } finally {
    console.error = orig;
  }
  eq(errs, []);
});

console.log("— 7. shared rules and the catalog page");
await t("validateQuiz problems name the field by position, in plain words; the address from a title", async () => {
  const { validateQuiz } = await import("../lib/quiz-rules.js");
  const v = validateQuiz({ slug: "ok", title: "T", questions: [{ prompt: "p", options: [{ label: "a" }, { label: "" }] }, { prompt: "", options: [] }] });
  eq(v.problems.map((p) => p.at), ["q2", "q2", "q1o2"]);
  ok(v.problems.every((p) => /^[A-Z].*\.$/.test(p.words)), "sentences:");
  eq([slugFrom("Find your fit!"), slugFrom("  Été & Co  "), slugFrom("")], ["find-your-fit", "ete-co", ""]);
});
await t("the catalog page has no quiz tray; the nav lists Quizzes under Catalog; every page is new UI since Phase 2 line 11 (test:no-legacy-ui)", async () => {
  ok(!/QuizPanel|QuizTray|listQuizzes/.test(read("app/(console)/admin/(authed)/catalog/page.js")), "catalog:");
  const { NAV } = await import("../lib/admin/nav.js");
  eq(NAV.find((g) => g.label === "Catalog").items.map((i) => i.id), ["catalog", "quizzes"]);
});

console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
