// P6-POLICY-START suite (PUB-12, GEN-06 partly, US-41; owner answer OQ-P6-2):
// the policy starters. Registered by P6-FIXTURE; filled by P6-POLICY-START.
//   1. lib/content/templates.js: returnsSentence, templatesFor, the static
//      PAGE_TEMPLATES with no number, POLICY_STARTERS, no number in the source
//   2. the returns text is the engine's window (lib/returns.js
//      returnsWindowDays()): 10 when the store sets it, the engine's own
//      default when it doesn't
//   3. startPolicyPage: one draft page, written by the policy starter, never
//      live, valid in draft and publish mode, policyStatus 'starter'
//   4. refusals, each with nothing written: a page of that kind already there
//      (any state but missing; an archived one doesn't block), an address
//      held by another kind of document (SLUG_TAKEN words and a link, then
//      Start works once it moves), a stored mode that isn't documents
//      (STORE_MODE_INVALID, thrown), read-only, unknown kind
//   5. markPolicyRead ("I've read it"): body unchanged, last writer the
//      founder, policyStatus 'saved'; refused on a founder-saved page and on
//      a stale revision, nothing changed
//   6. the real route (/api/admin/policy-start) with real sessions
//   7. banned-copy scan of both starter bodies and the founder words; the
//      module's imports
// File databases only (scripts/support/tenant-fixture.js). Nothing here
// reaches Shopify, Typesense or a hosted database.
//   pnpm test:policy-start
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) return next(pathToFileURL(join(ROOT, spec.slice(2) + (/\.\w+$/.test(spec) ? "" : ".js"))).href, ctx);
    if (/^next\/(headers|server|navigation)$/.test(spec)) return next(`${spec}.js`, ctx);
    return next(spec, ctx);
  },
});
// Fixture stores set checkout_mode themselves: never depend on the env.
delete process.env.CHECKOUT_MODE;
process.env.RATE_LIMIT_DISABLED = "1";
process.env.TURSO_DB_URL = "";
process.env.TURSO_DB_AUTH_TOKEN = "";
process.env.DATABASE_URL = "file:.test-ps-default.db";
process.env.PLATFORM_CACHE_MS = "50";
process.env.PLATFORM_SITE_HOSTS = "";

const started = Date.now();
let pass = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(e?.stack || e?.message || e).split("\n").slice(0, 6).join("\n       ")}`);
  }
}
const ok = (c, m) => {
  if (!c) throw new Error(m);
};
const eq = (a, b, m = "") => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n       expected ${y}\n       got      ${x}`);
};

const T = await import("../lib/content/templates.js");
const F = await import("./support/tenant-fixture.js");
await F.removeFixtureFiles("ps");
const plat = await F.makePlatform({ name: "ps" });
const I = await import("../lib/platform/identity.js");
const Sess = await import("../lib/platform/sessions.js");
const Docs = await import("../lib/documents/service.js");
const P = await import("../lib/documents/policy-pages.js");
const R = await import("../lib/registry/index.js");
const { returnsWindowDays } = await import("../lib/returns.js");
const { editorHref } = await import("../lib/admin/editor-entry.js");
const { STORE_MODE_INVALID_MESSAGE } = await import("../lib/cms-mode.js");
// a stored mode other than documents throws StoreModeInvalidError (the route answers 500)
const thrownCode = (p) => p.then(() => "ran", (e) => [e.code, e.message]);
const { scanText } = await import("./support/banned-copy.js");
const PS = await import("../lib/first-run/policy-start.js");
const route = await import("../app/api/admin/policy-start/route.js");

// ---- stores ------------------------------------------------------------------------------
const stores = {};
const mk = async (key, opts) => (stores[key] = await F.makeTenant({ name: `ps-${key}`, id: `ps${key}`, ...opts }));
await mk("main", { mode: "documents" }); // returns_window_days unset
await mk("ten", { mode: "documents", config: { returns_window_days: 10 } });
await mk("block", { mode: "documents" }); // founder pages that block
await mk("camp", { mode: "documents" }); // a campaign at /terms
await mk("race", { mode: "documents" });
await mk("route", { mode: "documents", config: { returns_window_days: 10 } });
await mk("legacy", {}); // legacy, every migration
await mk("mig", { mode: "documents" }); // moved to migrating below
const clients = Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, s.client()]));
const raw = async (key, q, args = []) => (await clients[key].execute({ sql: q, args })).rows.map((r) => ({ ...r }));
await raw("mig", "UPDATE cms_state SET mode = 'migrating' WHERE id = 1");

const owner = await I.createUser({ email: "owner@ps.test", name: "Owner", password: "ps-owner-pass-1" });
const helper = await I.createUser({ email: "support@ps.test", name: "Support", password: "ps-support-pass-1" });
for (const s of Object.values(stores)) await I.addMembership(owner.id, s.id, "owner");
await I.addMembership(helper.id, "psroute", "support");
const OWNER = { kind: "merchant", id: owner.id, role: "owner" };
const STAFF = { kind: "merchant", id: owner.id, role: "staff" };
const SUPPORT = { kind: "merchant", id: helper.id, role: "support" };
const MERCHANT_BY = `merchant:${owner.id}`;

// Everything a write could leave: every document, version, release and publish row.
async function snapshot(key) {
  return {
    documents: await raw(key, "SELECT id, type, slug, revision, draft_hash, published_version_id, archived_at, updated_by, updated_at FROM documents ORDER BY id"),
    versions: await raw(key, "SELECT id, document_id, kind FROM document_versions ORDER BY id"),
    releases: await raw(key, "SELECT id FROM releases ORDER BY id"),
    publishLog: await raw(key, "SELECT * FROM publish_log"),
    refs: await raw(key, "SELECT * FROM document_refs"),
  };
}
const statusOf = async (key) => stores[key].run(async () => P.policyStatus(await P.readPolicyRows()));
const textOf = (body) => JSON.stringify(body.sections);
const rowOf = async (key, id) => (await raw(key, "SELECT * FROM documents WHERE id = ?", [id]))[0];

// =========================================================================================
console.log("— 1. templates.js: the returns sentence, bound, with no number written down");

await t("returnsSentence: 1..365 says that many days of your order ('1 day' for 1); 0 or below says no returns; a fraction is rounded down (hours under a day); anything else is the sentence with no number", async () => {
  eq(T.returnsSentence(10), "Unopened products can be returned within 10 days of your order.", "10:");
  eq(T.returnsSentence(1), "Unopened products can be returned within 1 day of your order.", "1:");
  eq(T.returnsSentence(365), "Unopened products can be returned within 365 days of your order.", "365:");
  // P6-FIX1: what the engine does with the number
  for (const v of [0, -3, -0.5, -Number.MAX_VALUE, 0.01]) eq(T.returnsSentence(v), T.NO_RETURNS, `${String(v)}:`);
  eq(T.NO_RETURNS, "We don't accept returns on orders.", "the no-returns words:");
  eq(T.returnsSentence(10.5), T.returnsSentence(10), "10.5 rounds down:");
  eq(T.returnsSentence(1.99), T.returnsSentence(1), "1.99 rounds down:");
  eq(T.returnsSentence(0.5), "Unopened products can be returned within 12 hours of your order.", "half a day:");
  eq(T.returnsSentence(1 / 24), "Unopened products can be returned within 1 hour of your order.", "one hour:");
  const none = "Unopened products can be returned within our return window, counted from the day you order.";
  for (const v of [366, 400, 365.5 + 1, NaN, Infinity, -Infinity, "10", "x", null, undefined, {}, [14]]) eq(T.returnsSentence(v), none, `${String(v)}:`);
});

await t("P6-FIX1: for a negative, zero, fractional or odd returns_window_days, the returns starter says what lib/returns.js does (returnsWindowDays, then returnEligibility): never a return the engine refuses", async () => {
  const { returnEligibility } = await import("../lib/returns.js");
  const DAY = 86_400_000;
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const order = (ageMs) => ({ status: "paid", created_at: new Date(now - ageMs).toISOString(), total: 100, refunded_total: 0 });
  const st = stores.main;
  const base = st.tenant.config;
  try {
    for (const [setting, said] of [
      [-3, T.NO_RETURNS],
      [-0.5, T.NO_RETURNS],
      [0, T.returnsSentence(14)], // the engine reads 0 as unset: its default
      ["abc", T.returnsSentence(14)],
      [10.5, T.returnsSentence(10)],
      [0.5, "Unopened products can be returned within 12 hours of your order."],
      [10, T.returnsSentence(10)],
    ]) {
      st.tenant.config = { ...base, returns_window_days: setting };
      const days = await st.run(() => returnsWindowDays());
      const body = await st.run(() => PS.starterBody("returns"));
      const text = body.sections.find((x) => x.settings.title === "Refunds & returns").settings.body[0];
      ok(text.startsWith(said + " "), `${setting}: ${text}`);
      // the engine's answer just inside what the page promises
      const m = /within (\d+) (day|days|hour|hours) of your order/.exec(said);
      if (!m) {
        eq(returnEligibility(order(1000), { now, windowDays: days }).ok, false, `${setting}: the page says no returns, the engine:`);
      } else {
        const span = Number(m[1]) * (m[2].startsWith("day") ? DAY : DAY / 24);
        eq(returnEligibility(order(span - 1000), { now, windowDays: days }).ok, true, `${setting}: the engine refuses a return the page promises:`);
      }
    }
  } finally {
    st.tenant.config = base;
  }
  // the FAQ's "Start a return" line is left out when no returns are taken
  const faqAnswer = (list) => list.find((x) => x.id === "faq").page.sections.flatMap((x) => x.items).find((i) => i.q === "What's the return policy?").a;
  eq(faqAnswer(T.templatesFor({ returnsWindowDays: -3 })), `<p>${T.NO_RETURNS}</p>`, "the FAQ with no returns:");
  ok(faqAnswer(T.templatesFor({ returnsWindowDays: 10 })).includes("Start a return"), "the FAQ with returns keeps it");
});

const termsOf = (list) => list.find((x) => x.id === "terms").page.sections.find((s) => s.heading === "Refunds & returns").body.join(" ");
const faqOf = (list) => list.find((x) => x.id === "faq").page.sections.flatMap((s) => s.items).find((i) => i.q === "What's the return policy?").a;

await t("templatesFor binds both returns sentences (terms 'Refunds & returns', FAQ 'What's the return policy?'); 'x', 400 and NaN give the no-number sentence", async () => {
  const ten = T.templatesFor({ returnsWindowDays: 10 });
  ok(termsOf(ten).startsWith("Unopened products can be returned within 10 days of your order. "), `terms: ${termsOf(ten)}`);
  ok(faqOf(ten).startsWith("<p>Unopened products can be returned within 10 days of your order. "), `faq: ${faqOf(ten)}`);
  for (const v of ["x", 400, NaN]) {
    const l = T.templatesFor({ returnsWindowDays: v });
    ok(termsOf(l).includes(T.returnsSentence(null)) && faqOf(l).includes(T.returnsSentence(null)), `${v}: ${termsOf(l)} / ${faqOf(l)}`);
    ok(!/\d+ days? of/.test(JSON.stringify(l)), `${v}: a number of days is left`);
  }
  // kept as they were (GEN-06 known limits): refund timing, delivery, payment methods
  ok(termsOf(ten).endsWith("Refunds go back to the original payment method within 5–7 working days."), "the refund-timing sentence:");
  ok(JSON.stringify(ten).includes("Standard delivery arrives in 3–5 working days."), "the delivery sentence:");
  ok(JSON.stringify(ten).includes("UPI, cards, netbanking and cash on delivery."), "the payment-methods sentence:");
  // plain (the starters): the refund-timing day count, which no setting backs, is left out
  const plain = T.templatesFor({ returnsWindowDays: 10, plain: true });
  eq(termsOf(plain), "Unopened products can be returned within 10 days of your order. Refunds go back to the original payment method.", "plain terms:");
  eq(T.templatesFor({ returnsWindowDays: 10, plain: false }), ten, "plain: false is the default:");
});

await t("templatesFor gives fresh objects on each call; the other templates are unchanged", async () => {
  const a = T.templatesFor({ returnsWindowDays: 10 });
  const b = T.templatesFor({ returnsWindowDays: 10 });
  ok(a !== b && a[0] !== b[0] && a[1].page.sections !== b[1].page.sections, "shared objects");
  a.find((x) => x.id === "privacy").page.sections[0].heading = "changed";
  eq(b.find((x) => x.id === "privacy").page.sections[0].heading, "What we collect", "a change to one list reaches the other:");
  eq(T.templatesFor().find((x) => x.id === "privacy").page.sections[0].heading, "What we collect", "a change reaches the next call:");
  eq(a.map((x) => x.id), ["blank", "faq", "campaign", "brand-story", "privacy", "terms", "how-to-use"], "the ids, in order:");
});

await t("PAGE_TEMPLATES (the legacy PageEditor's list) is templatesFor(): no 'N days of' return window and no '7 days'", async () => {
  const s = JSON.stringify(T.PAGE_TEMPLATES);
  ok(!/\d+ days? of/.test(s), "a number of days of … is left");
  ok(!s.includes("7 days"), "'7 days' is left");
  eq(T.PAGE_TEMPLATES, T.templatesFor(), "PAGE_TEMPLATES vs templatesFor():");
  ok(termsOf(T.PAGE_TEMPLATES).includes(T.returnsSentence()) && faqOf(T.PAGE_TEMPLATES).includes(T.returnsSentence()), "the no-number sentence:");
});

await t("POLICY_STARTERS: privacy -> 'privacy' (slug privacy-policy), returns -> 'terms' (slug terms, 'Terms of service'), each its kind by the shared slug rule", async () => {
  eq(T.POLICY_STARTERS, { privacy: "privacy", returns: "terms" }, "ids:");
  ok(Object.isFrozen(T.POLICY_STARTERS), "not frozen");
  const by = Object.fromEntries(T.PAGE_TEMPLATES.map((x) => [x.id, x.page]));
  eq([by.privacy.slug, by.terms.slug, by.terms.title], ["privacy-policy", "terms", "Terms of service"], "slugs and title:");
  eq([P.kindOfSlug(by.privacy.slug), P.kindOfSlug(by.terms.slug)], ["privacy", "returns"], "kinds:");
});

await t("templates.js writes no number of return days anywhere (the window is never hard-coded)", async () => {
  const src = await readFile(join(ROOT, "lib/content/templates.js"), "utf8");
  ok(!/\b\d+ days? of\b/.test(src), "a number of days of … in the source");
  ok(!/\b7 days\b|\b14 days\b|\b14\b/.test(src.replace(/^\s*\/\/.*$/gm, "")), "a 7 or 14 in the code");
  ok(/\d–\d working days/.test(src), "test-copy's ALLOWED entry no longer matches");
});

// =========================================================================================
console.log("— 2. the returns starter says the engine's window");

await t("with returns_window_days 10, the returns starter's body says 'within 10 days of your order', and neither '7 days' nor '14 days'", async () => {
  const body = await stores.ten.run(() => PS.starterBody("returns"));
  const s = textOf(body);
  ok(s.includes("within 10 days of your order"), s);
  ok(!s.includes("7 days") && !s.includes("14 days"), s);
  ok(!/working days/.test(s), `an unset refund-timing promise: ${s}`);
  const r =await stores.ten.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER }));
  eq(r.status, 200, JSON.stringify(r.body));
  const doc = await stores.ten.run(() => Docs.getDocument(r.body.document.id));
  ok(textOf(doc.body).includes("within 10 days of your order") && !textOf(doc.body).includes("14 days"), textOf(doc.body));
});

await t("with the setting unset, the sentence is returnsSentence(returnsWindowDays()), the engine's own window", async () => {
  const days = await stores.main.run(() => returnsWindowDays());
  eq(days, 14, "the engine's default (read from lib/returns.js, not written here):");
  const body = await stores.main.run(() => PS.starterBody("returns"));
  const section = body.sections.find((s) => s.settings.title === "Refunds & returns");
  ok(section.settings.body[0].startsWith(T.returnsSentence(days) + " "), section.settings.body[0]);
  ok(!textOf(body).includes("7 days") && !textOf(body).includes("of delivery"), textOf(body));
});

// =========================================================================================
console.log("— 3. startPolicyPage writes one draft page, never live");

const made = {};
await t("privacy on a closed documents store: one type 'page' document, slug privacy-policy, updated_by system:policy-starter, revision 1, not live, no release", async () => {
  const before = await snapshot("main");
  eq(before.documents.length, 0, "an empty store to start:");
  const r = await stores.main.run(() => PS.startPolicyPage({ kind: "privacy", actor: OWNER }));
  eq(r.status, 200, JSON.stringify(r.body));
  const after = await snapshot("main");
  eq(after.documents.length, 1, "documents:");
  const row = after.documents[0];
  eq([row.type, row.slug, row.updated_by, row.revision, row.published_version_id, row.archived_at], ["page", "privacy-policy", "system:policy-starter", 1, null, null], "the row:");
  eq(after.versions.map((v) => [v.document_id, v.kind]), [[row.id, "checkpoint"]], "versions:");
  eq([after.releases.length, after.publishLog.length], [0, 0], "releases and publish log:");
  eq(await raw("main", "SELECT * FROM release_state"), await raw("main", "SELECT * FROM release_state"), "release_state readable:");
  eq((await raw("main", "SELECT COUNT(*) AS n FROM release_state WHERE live_release_id IS NOT NULL"))[0].n, 0, "nothing live:");
  eq(r.body, { ok: true, document: { id: row.id, revision: 1, slug: "privacy-policy", title: "Privacy policy", kind: "privacy" }, href: editorHref(row.id), message: "We started your privacy page from a template. It's a starting point, not legal advice: read it, change what you need and save it." }, "the answer:");
  made.privacy = r.body.document;
});

await t("the starter body validates in draft and in publish mode with 0 errors; meta has only emptyBody('page').meta keys", async () => {
  const d = await stores.main.run(() => Docs.getDocument(made.privacy.id));
  for (const mode of ["draft", "publish"]) {
    const v = R.validateDocument(d.body, { mode });
    eq([v.ok, v.issues.filter((i) => i.severity !== "warning")], [true, []], `${mode}:`);
  }
  eq(Object.keys(d.body.meta).sort(), Object.keys(R.emptyBody("page").meta).sort(), "meta keys:");
  eq([d.body.meta.slug, d.body.meta.title, d.body.meta.description], ["privacy-policy", "Privacy policy", "What we collect, why, and your choices."], "meta:");
  eq(d.body.sections.map((s) => [s.kind, s.settings.title]), [["text", "What we collect"], ["text", "What we never do"], ["text", "Your rights"]], "sections:");
  eq(new Set(d.body.sections.map((s) => s.id)).size, 3, "fresh section ids:");
});

await t("policyStatus reports 'starter' for privacy (it does not count yet); the returns starter has slug 'terms' and 'starter' for returns", async () => {
  let s = await statusOf("main");
  eq([s.privacy.state, s.privacy.doc.id, s.returns.state], ["starter", made.privacy.id, "missing"], "after privacy:");
  eq(P.policyCounts(s.privacy.state), false, "a starter counts:");
  const r = await stores.main.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER }));
  eq([r.status, r.body.document?.slug, r.body.document?.title, r.body.document?.kind], [200, "terms", "Terms of service", "returns"], JSON.stringify(r.body));
  ok(r.body.message.startsWith("We started your returns page from a template. It's a starting point, not legal advice"), r.body.message);
  made.returns = r.body.document;
  s = await statusOf("main");
  eq([s.privacy.state, s.returns.state, s.returns.doc.id], ["starter", "starter", made.returns.id], "after returns:");
  const row = await rowOf("main", made.returns.id);
  eq([row.type, row.updated_by, row.revision, row.published_version_id], ["page", "system:policy-starter", 1, null], "the returns row:");
  const d = await stores.main.run(() => Docs.getDocument(made.returns.id));
  for (const mode of ["draft", "publish"]) eq(R.validateDocument(d.body, { mode }).ok, true, `returns ${mode}:`);
  eq((await raw("main", "SELECT COUNT(*) AS n FROM releases"))[0].n, 0, "releases:");
});

await t("a staff member (storefront.write, no publish) may start a page", async () => {
  const r = await stores.race.run(() => PS.startPolicyPage({ kind: "privacy", actor: STAFF }));
  eq(r.status, 200, JSON.stringify(r.body));
  await raw("race", "DELETE FROM document_versions");
  await raw("race", "DELETE FROM documents");
});

// =========================================================================================
console.log("— 4. refusals write nothing");

await t("a second start of the same kind: 409 POLICY_PAGE_EXISTS naming the first page, with an editor link; nothing written", async () => {
  const before = await snapshot("main");
  for (const kind of ["privacy", "returns"]) {
    const r = await stores.main.run(() => PS.startPolicyPage({ kind, actor: OWNER }));
    const first = made[kind];
    const title = kind === "privacy" ? "Privacy policy" : "Terms of service";
    eq(r, { status: 409, body: { error: `You already have a ${kind} page: ${title}. Open it to read it.`, code: "POLICY_PAGE_EXISTS", document: { id: first.id, title, state: "starter" }, href: editorHref(first.id) } }, `${kind}:`);
  }
  eq(await snapshot("main"), before, "storage:");
});

await t("two starts at once (a double click): one page, and the other answer is POLICY_PAGE_EXISTS naming it", async () => {
  const rs = await stores.race.run(() => Promise.all([PS.startPolicyPage({ kind: "returns", actor: OWNER }), PS.startPolicyPage({ kind: "returns", actor: OWNER })]));
  eq(rs.map((r) => r.status).sort(), [200, 409], JSON.stringify(rs.map((r) => r.body)));
  const won = rs.find((r) => r.status === 200).body.document;
  const lost = rs.find((r) => r.status === 409).body;
  eq([lost.code, lost.document.id, lost.href], ["POLICY_PAGE_EXISTS", won.id, editorHref(won.id)], "the second answer:");
  eq((await raw("race", "SELECT COUNT(*) AS n FROM documents"))[0].n, 1, "documents:");
});

await t("a founder-saved 'refund-policy' page blocks the returns start (state 'saved'); nothing written", async () => {
  const body = { ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug: "refund-policy", title: "Our refunds" } };
  const own = (await stores.block.run(() => Docs.createDocument({ type: "page", body, actor: OWNER }))).document;
  const before = await snapshot("block");
  const r = await stores.block.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER }));
  eq(r, { status: 409, body: { error: "You already have a returns page: Our refunds. Open it to read it.", code: "POLICY_PAGE_EXISTS", document: { id: own.id, title: "Our refunds", state: "saved" }, href: editorHref(own.id) } }, "answer:");
  eq(await snapshot("block"), before, "storage:");
});

await t("an archived privacy page does not block: the privacy start makes a new page at privacy-policy", async () => {
  const body = { ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug: "privacy-policy", title: "Old privacy" } };
  const old = (await stores.block.run(() => Docs.createDocument({ type: "page", body, actor: OWNER }))).document;
  await stores.block.run(() => Docs.archive({ id: old.id, revision: old.revision, actor: OWNER }));
  eq((await statusOf("block")).privacy.state, "missing", "the archived page doesn't count:");
  const r = await stores.block.run(() => PS.startPolicyPage({ kind: "privacy", actor: OWNER }));
  eq([r.status, r.body.document?.slug], [200, "privacy-policy"], JSON.stringify(r.body));
  ok(r.body.document.id !== old.id, "the archived page was reused");
  eq((await rowOf("block", old.id)).archived_at != null, true, "the archived page stays archived:");
});

await t("a campaign at /terms: the returns start answers 409 with SLUG_TAKEN's own words and an editor link to the campaign, nothing written; once it moves, Start works", async () => {
  const cbody = { ...R.emptyBody("campaign"), meta: { ...R.emptyBody("campaign").meta, slug: "terms", title: "Terms sale" } };
  const camp = (await stores.camp.run(() => Docs.createDocument({ type: "campaign", body: cbody, actor: OWNER }))).document;
  eq((await statusOf("camp")).returns.state, "missing", "policyStatus doesn't count a campaign:");
  const before = await snapshot("camp");
  const r = await stores.camp.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER }));
  eq(r.status, 409, JSON.stringify(r.body));
  eq([r.body.code, r.body.error, r.body.href, r.body.document?.id], ["SLUG_TAKEN", "Another page already uses /terms: Terms sale", editorHref(camp.id), camp.id], "answer:");
  ok(!/already have a returns page/.test(r.body.error), "it says the founder has a returns page");
  eq(await snapshot("camp"), before, "storage:");
  // the founder moves the campaign's address, then presses Start again
  const cur = await stores.camp.run(() => Docs.getDocument(camp.id));
  await stores.camp.run(() => Docs.saveDraft({ id: camp.id, revision: cur.revision, body: { ...cur.body, meta: { ...cur.body.meta, slug: "terms-sale" } }, actor: OWNER }));
  const again = await stores.camp.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER }));
  eq([again.status, again.body.document?.slug], [200, "terms"], JSON.stringify(again.body));
});

await t("a store whose stored mode is 'legacy' or 'migrating' throws STORE_MODE_INVALID, read-only actors are refused, and an unknown kind is 400; nothing written", async () => {
  const legacyBefore = await snapshot("legacy");
  const l = await thrownCode(stores.legacy.run(() => PS.startPolicyPage({ kind: "privacy", actor: OWNER })));
  eq(l, ["STORE_MODE_INVALID", STORE_MODE_INVALID_MESSAGE], "legacy:");
  eq(await snapshot("legacy"), legacyBefore, "legacy storage:");

  const migBefore = await snapshot("mig");
  const m = await thrownCode(stores.mig.run(() => PS.startPolicyPage({ kind: "returns", actor: OWNER })));
  eq(m, ["STORE_MODE_INVALID", STORE_MODE_INVALID_MESSAGE], "migrating:");
  eq(await snapshot("mig"), migBefore, "migrating storage:");

  const ro = await stores.race.run(async () => {
    const before = await snapshot("race");
    const out = [];
    for (const actor of [SUPPORT, null, { kind: "merchant", id: "x" }, "merchant:x"]) out.push(await PS.startPolicyPage({ kind: "privacy", actor }));
    return { before, out };
  });
  for (const r of ro.out) eq(r, { status: 403, body: { error: "You can look at this, but your role can't change it. Ask the store owner or an admin.", code: "READ_ONLY" } }, "read-only:");
  eq(await snapshot("race"), ro.before, "read-only storage:");

  for (const kind of ["about", "Privacy", "", undefined, null, 1, ["privacy"]]) {
    const r = await stores.race.run(() => PS.startPolicyPage({ kind, actor: OWNER }));
    eq([r.status, r.body.code], [400, "UNKNOWN_POLICY_KIND"], `${JSON.stringify(kind)}:`);
    ok(/privacy page or a returns page/.test(r.body.error), r.body.error);
  }
  eq(await snapshot("race"), ro.before, "unknown-kind storage:");
});

// =========================================================================================
console.log("— 5. markPolicyRead ('I've read it')");

await t("on a starter draft: the body is unchanged, the last writer is the merchant, policyStatus 'saved'", async () => {
  const before = await stores.main.run(() => Docs.getDocument(made.privacy.id));
  const r = await stores.main.run(() => PS.markPolicyRead({ id: made.privacy.id, revision: 1, actor: OWNER }));
  eq(r.status, 200, JSON.stringify(r.body));
  eq([r.body.ok, r.body.document.id, r.body.document.revision, r.body.href], [true, made.privacy.id, 2, editorHref(made.privacy.id)], "answer:");
  const after = await stores.main.run(() => Docs.getDocument(made.privacy.id));
  eq(after.body, before.body, "body:");
  eq(after.draftHash, before.draftHash, "draft hash:");
  const row = await rowOf("main", made.privacy.id);
  eq([row.updated_by, row.revision, row.published_version_id], [MERCHANT_BY, 2, null], "row:");
  const s = await statusOf("main");
  eq([s.privacy.state, P.policyCounts(s.privacy.state), s.returns.state], ["saved", true, "starter"], "status:");
});

await t("on a founder-saved page: 409 'This page was already saved by you.', nothing changes", async () => {
  const before = await snapshot("main");
  const r = await stores.main.run(() => PS.markPolicyRead({ id: made.privacy.id, revision: 2, actor: OWNER }));
  eq(r, { status: 409, body: { error: "This page was already saved by you.", code: "ALREADY_SAVED" } }, "answer:");
  const own = (await snapshot("block")).documents.find((d) => d.slug === "refund-policy");
  const r2 = await stores.block.run(() => PS.markPolicyRead({ id: own.id, revision: own.revision, actor: OWNER }));
  eq([r2.status, r2.body.code], [409, "ALREADY_SAVED"], "the founder's refund-policy page:");
  eq(await snapshot("main"), before, "storage:");
});

await t("P6-FIX1: ALREADY_SAVED says 'by you' only when this actor wrote the page last; a page another merchant or the cutover wrote last gets words that name no one; nothing changes", async () => {
  const other = { kind: "merchant", id: "u_ps_other", role: "owner" };
  const body = { ...R.emptyBody("page"), meta: { ...R.emptyBody("page").meta, slug: "privacy-notes", title: "Privacy notes" } };
  const page = (await stores.block.run(() => Docs.createDocument({ type: "page", body, actor: other }))).document;
  const before = await snapshot("block");
  const r = await stores.block.run(() => PS.markPolicyRead({ id: page.id, revision: page.revision, actor: OWNER }));
  eq(r, { status: 409, body: { error: PS.POLICY_START_WORDS.alreadySavedOther, code: "ALREADY_SAVED" } }, "another merchant:");
  ok(!/by you/.test(r.body.error), r.body.error);
  await raw("block", "UPDATE documents SET updated_by = 'system:cutover' WHERE id = ?", [page.id]);
  const mid = await snapshot("block");
  const c = await stores.block.run(() => PS.markPolicyRead({ id: page.id, revision: page.revision, actor: OWNER }));
  eq([c.status, c.body.code, c.body.error], [409, "ALREADY_SAVED", PS.POLICY_START_WORDS.alreadySavedOther], "the cutover:");
  eq(await snapshot("block"), mid, "storage:");
  // the same actor: "by you" (a staff session of the same person is the same writer)
  await raw("block", "UPDATE documents SET updated_by = ? WHERE id = ?", [MERCHANT_BY, page.id]);
  for (const actor of [OWNER, STAFF]) eq((await stores.block.run(() => PS.markPolicyRead({ id: page.id, revision: page.revision, actor }))).body.error, "This page was already saved by you.", `${actor.role}:`);
  eq((await snapshot("block")).documents.length, before.documents.length, "documents:");
  for (const w of [PS.POLICY_START_WORDS.alreadySavedOther]) eq(scanText(w, { claims: false }), [], w);
});

await t("with a stale revision: 409 in the words documents-api uses (the service's DOCUMENT_CHANGED), nothing changes; a missing revision is 428", async () => {
  const before = await snapshot("main");
  const r = await stores.main.run(() => PS.markPolicyRead({ id: made.returns.id, revision: 7, actor: OWNER }));
  eq([r.status, r.body.code], [409, "DOCUMENT_CHANGED"], JSON.stringify(r.body));
  // what PUT /api/admin/documents sends for the same stale save: { error: e.message, code, ...extra }
  let e = null;
  try {
    await stores.main.run(async () => Docs.saveDraft({ id: made.returns.id, revision: 7, body: (await Docs.getDocument(made.returns.id)).body, actor: OWNER }));
  } catch (x) {
    e = x;
  }
  eq([r.body.error, r.body.current?.id, r.body.current?.revision], [e.message, made.returns.id, 1], "the same words and the current page:");
  ok(r.body.error.includes("was changed somewhere else since you opened it, so nothing was saved"), r.body.error);
  const missing = await stores.main.run(() => PS.markPolicyRead({ id: made.returns.id, revision: undefined, actor: OWNER }));
  eq([missing.status, missing.body.code], [428, "REVISION_REQUIRED"], "no revision:");
  eq(await snapshot("main"), before, "storage:");
  eq((await statusOf("main")).returns.state, "starter", "still a starter:");
});

await t("markPolicyRead refusals: unknown id 404, archived 409, a campaign 409, read-only 403, a stored 'legacy' or 'migrating' mode STORE_MODE_INVALID; nothing written", async () => {
  const before = await snapshot("main");
  eq((await stores.main.run(() => PS.markPolicyRead({ id: "doc_nothere", revision: 1, actor: OWNER }))).status, 404, "unknown id:");
  eq((await stores.main.run(() => PS.markPolicyRead({ id: "", revision: 1, actor: OWNER }))).status, 400, "no id:");
  eq((await stores.main.run(() => PS.markPolicyRead({ id: made.returns.id, revision: 1, actor: SUPPORT }))).status, 403, "read-only:");
  eq(await snapshot("main"), before, "storage:");
  const archived = (await snapshot("block")).documents.find((d) => d.archived_at);
  eq((await stores.block.run(() => PS.markPolicyRead({ id: archived.id, revision: archived.revision, actor: OWNER }))).body.code, "DOCUMENT_ARCHIVED", "archived:");
  const camp = (await snapshot("camp")).documents.find((d) => d.type === "campaign");
  eq((await stores.camp.run(() => PS.markPolicyRead({ id: camp.id, revision: camp.revision, actor: OWNER }))).body.code, "NOT_A_STARTER", "a campaign:");
  eq((await thrownCode(stores.legacy.run(() => PS.markPolicyRead({ id: "doc_x", revision: 1, actor: OWNER }))))[0], "STORE_MODE_INVALID", "legacy:");
  eq((await thrownCode(stores.mig.run(() => PS.markPolicyRead({ id: "doc_x", revision: 1, actor: OWNER }))))[0], "STORE_MODE_INVALID", "migrating:");
});

// =========================================================================================
console.log("— 6. the route, with real sessions");

const tokOwner = (await Sess.createSession({ userId: owner.id, kind: "merchant", ttlMs: 600_000 })).token;
const tokSupport = (await Sess.createSession({ userId: helper.id, kind: "merchant", ttlMs: 600_000 })).token;
const req = (body, tok, { badJson = false } = {}) => ({
  method: "POST",
  cookies: { get: (n) => (n === "_admin" && tok ? { name: n, value: tok } : undefined) },
  headers: { get: (k) => ({ host: "psroute.test" })[k.toLowerCase()] ?? null },
  url: "https://psroute.test/api/admin/policy-start",
  nextUrl: new URL("https://psroute.test/api/admin/policy-start"),
  json: async () => {
    if (badJson) throw new SyntaxError("Unexpected token");
    return body;
  },
});
const post = async (body, tok = tokOwner, o) => {
  const res = await route.POST(req(body, tok, o), { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
};

await t("POST { kind } starts a page, POST { markRead } marks it read; the returns page says the store's 10 days", async () => {
  const p = await post({ kind: "privacy" });
  eq([p.status, p.body.ok, p.body.document?.slug], [200, true, "privacy-policy"], JSON.stringify(p.body));
  const r = await post({ kind: "returns" });
  eq([r.status, r.body.document?.slug], [200, "terms"], JSON.stringify(r.body));
  const doc = await stores.route.run(() => Docs.getDocument(r.body.document.id));
  ok(textOf(doc.body).includes("within 10 days of your order"), textOf(doc.body));
  const m = await post({ markRead: { id: p.body.document.id, revision: 1 } });
  eq([m.status, m.body.document?.revision], [200, 2], JSON.stringify(m.body));
  eq((await rowOf("route", p.body.document.id)).updated_by, MERCHANT_BY, "last writer:");
  const again = await post({ kind: "privacy" });
  eq([again.status, again.body.code, again.body.document?.state], [409, "POLICY_PAGE_EXISTS", "saved"], "again:");
});

await t("anything else is 400 in plain words; a support session is 403 and no session 401; nothing written", async () => {
  const before = await snapshot("route");
  for (const body of [{}, null, [], { kind: "privacy", extra: 1 }, { kind: 1 }, { markRead: { id: "doc_x" } }, { markRead: { id: "doc_x", revision: "1" } }, { markRead: { id: "doc_x", revision: 1, body: {} } }, { kind: "privacy", markRead: { id: "doc_x", revision: 1 } }, { publish: true }]) {
    const r = await post(body);
    eq([r.status, r.body.code], [400, "BAD_REQUEST"], `${JSON.stringify(body)}:`);
    ok(/Start a privacy page/.test(r.body.error), r.body.error);
  }
  eq((await post(undefined, tokOwner, { badJson: true })).status, 400, "bad JSON:");
  const u = await post({ kind: "about" });
  eq([u.status, u.body.code], [400, "UNKNOWN_POLICY_KIND"], "unknown kind:");
  eq((await post({ kind: "privacy" }, tokSupport)).status, 403, "support:");
  eq((await post({ kind: "privacy" }, null)).status, 401, "no session:");
  eq(await snapshot("route"), before, "storage:");
});

await t("P6-FIX1: a database fault inside the work answers a retryable 503 through infraResponse (never 500 INTERNAL, never a 4xx), for both actions; nothing written", async () => {
  const { currentDatabase } = await import("../lib/db.js");
  const client = await stores.route.run(() => currentDatabase().libsql);
  const before = await snapshot("route");
  const real = client.execute;
  let hits = 0;
  client.execute = function (stmt, ...rest) {
    const sql = typeof stmt === "string" ? stmt : String(stmt?.sql ?? "");
    if (/\bFROM documents\b/i.test(sql)) {
      hits++;
      throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { name: "LibsqlError", code: "SQLITE_BUSY" });
    }
    return real.call(this, stmt, ...rest);
  };
  let start;
  let mark;
  try {
    start = await post({ kind: "privacy" });
    mark = await post({ markRead: { id: "doc_anything", revision: 1 } });
  } finally {
    client.execute = real;
  }
  ok(hits >= 2, `the fault was reached (${hits})`);
  for (const [label, r] of [["start", start], ["markRead", mark]]) {
    eq([r.status, r.body.code, r.body.retryable], [503, "DATABASE_UNAVAILABLE", true], `${label}: ${JSON.stringify(r.body)}`);
    ok(!/SQLITE|locked/i.test(r.body.error), `${label}: the database's own words: ${r.body.error}`);
  }
  eq(await snapshot("route"), before, "storage:");
});

// =========================================================================================
console.log("— 7. copy and imports");

await t("banned-copy scanText over both starter bodies finds no BANNED or CLAIMS hit (and none in the shopper rules)", async () => {
  for (const key of ["main", "ten"]) {
    for (const kind of ["privacy", "returns"]) {
      const body = await stores[key].run(() => PS.starterBody(kind));
      const words = JSON.stringify(body.sections) + " " + body.meta.title + " " + body.meta.description;
      eq(scanText(words, { shopper: true }), [], `${key} ${kind}:`);
    }
  }
});

await t("the founder words (answers and refusals) find no BANNED hit", async () => {
  const all = [...Object.values(PS.POLICY_START_WORDS), PS.startedMessage("privacy"), PS.startedMessage("returns"), PS.existsMessage("returns", "Terms"), PS.READ_MESSAGE];
  for (const w of all) eq(scanText(w, { claims: false }), [], w);
});

await t("policy-start.js never publishes and never imports opening.js, brand-step.js, generate.js, Shopify or AI; the route is nodejs, uses tenantHandler and has no old-screen links", async () => {
  const src = await readFile(join(ROOT, "lib/first-run/policy-start.js"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const bad of [/opening/, /brand-step/, /generate/, /shopify/i, /\/ai\b|lib\/ai/, /publish/, /node:/]) ok(!imports.some((i) => bad.test(i)), `imports ${bad}: ${imports.join(", ")}`);
  ok(!/\bpublish\(|publishSet|undoSet/.test(src.replace(/^\s*\/\/.*$/gm, "")), "calls a publish");
  const rsrc = await readFile(join(ROOT, "app/api/admin/policy-start/route.js"), "utf8");
  ok(rsrc.includes('export const runtime = "nodejs";') && rsrc.includes("tenantHandler("), "route conventions");
  ok(!/\/admin\/(catalog|home|upsells|storefront)\b/.test(rsrc + src), "an old-screen link");
});

// ---- done ---------------------------------------------------------------------------------
for (const c of Object.values(clients)) c.close();
for (const s of Object.values(stores)) await s.cleanup();
await plat.cleanup();
await F.removeFixtureFiles("ps");
const { rm } = await import("node:fs/promises");
await rm(join(ROOT, ".test-ps-default.db"), { force: true });
console.log(`\n${pass} passed, ${failures.length} failed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
