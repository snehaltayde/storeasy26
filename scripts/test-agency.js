// Agency-platform suite (Session 48 / BE28 + AG01–06 + OP14 + MK06):
// commercial-status-vs-access separation, email-bound grant acceptance w/
// wrong-recipient and expiry refusals, immediate revocation, kit scrubbing
// (no customer data / secrets / domains / media / catalog ids), hash-bound
// expiring approvals, idempotent commission ledger w/ refund reversal, cross-
// client report isolation, and the case-study publication gate.
//   pnpm test:agency
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = "";
process.env.DATABASE_URL = "file:.test-agency-default.db";
process.env.PLATFORM_DB_URL = "file:.test-agency-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

const dbs = [".test-agency-default.db", ".test-agency-platform.db", ".test-agency-a.db", ".test-agency-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql } = await import("../lib/db.js");
const A = await import("../lib/platform/agency.js");
const CS = await import("../lib/platform/case-studies.js");
const { createUser } = await import("../lib/platform/identity.js");
const { createSession, verifySession } = await import("../lib/platform/sessions.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const [id, file, domain] of [["aa", ".test-agency-a.db", "aa.test"], ["ab", ".test-agency-b.db", "ab.test"]]) {
  await C.upsertTenant({ id, name: id.toUpperCase(), domains: [domain], dbUrl: `file:${file}`, config: { currency: "INR", merchant_timezone: "Asia/Kolkata" }, secrets: { order_link_secret: `${id}-secret` } });
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inA = async (fn) => withTenant(await C.getTenant("aa"), fn);
const inB = async (fn) => withTenant(await C.getTenant("ab"), fn);

// distinct sales per tenant (report isolation) + source-marker CMS on aa
await inA(async () => {
  await libsql.execute({
    sql: "INSERT INTO orders (id, email, total, currency, status, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES ('AA-1','buyer-a@x.test',11111,'INR','paid',?, ?, ?,0,0)",
    args: [JSON.stringify({ items: [{ title: "Alpha Serum", quantity: 1, price: 11111 }] }), new Date().toISOString(), new Date().toISOString()],
  });
  const { writeContentDrafts } = await import("../lib/content-writes.js");
  const Docs = await import("../lib/documents/service.js");
  await writeContentDrafts(
    {
      hero: {
        value: {
          title: "Glow like AA",
          highlight: "AA",
          subtitle: "See https://cdn.example/aa-banner.png for the look",
          primary: { label: "Shop", href: "/collections" },
          secondary: { label: "Bestseller", href: "/collections/aa-exclusive-serum" },
        },
      },
      announcement: { enabled: true, text: "Free shipping over ₹999", href: "" },
      home_sections: [
        { kind: "collections", title: "Shop by ritual", limit: 6, enabled: true },
        { kind: "new", title: "Fresh in", limit: 8, enabled: true },
      ],
    },
    { source: "test:agency", documents: Docs },
  );
});
await inB(async () => {
  await libsql.execute({
    sql: "INSERT INTO orders (id, email, total, currency, status, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES ('AB-1','buyer-b@x.test',22222,'INR','paid',?, ?, ?,0,0)",
    args: [JSON.stringify({ items: [{ title: "Beta Whey", quantity: 1, price: 22222 }] }), new Date().toISOString(), new Date().toISOString()],
  });
});

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
const eq = (a, b, m = "") => {
  if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, m = "") => {
  if (!v) throw new Error(`${m} expected truthy`);
};
const throws = async (fn, part, m = "") => {
  try {
    await fn();
  } catch (e) {
    if (!String(e.message).toLowerCase().includes(part.toLowerCase())) throw new Error(`${m} wrong error: ${e.message}`);
    return;
  }
  throw new Error(`${m} expected it to throw "${part}"`);
};

console.log("— access model (BE28 + OP14): commercial status ≠ client access");

const agency = await A.createAgency({ name: "Studio North" });
const rival = await A.createAgency({ name: "Rival Co" });
const member = await createUser({ email: "lead@studionorth.test", password: "agency-pass-123" });
await A.addAgencyMember(agency.id, member.id, "owner");

await t("a VERIFIED agency with no grants sees zero client stores", async () => {
  await A.setAgencyStatus(agency.id, { status: "verified", referral_eligible: true });
  eq((await A.agencyPortfolio(agency.id)).length, 0, "verified ≠ access:");
});

await t("agency sessions are their own kind — never merchant, never operator", async () => {
  const { token } = await createSession({ userId: member.id, kind: "agency", ttlMs: 60000 });
  ok(await A.agencyFromToken(token), "agency session works");
  eq(await verifySession(token, "merchant"), null, "not a merchant:");
  eq(await verifySession(token, "operator"), null, "not an operator:");
});

console.log("— grants (AG01 + AG02): email-bound acceptance, immediate revocation");

await t("invites: owner role refused; invalid email refused", async () => {
  await throws(() => A.createGrantInvite({ agencyId: agency.id, clientEmail: "o@c.test", role: "owner" }), "never grantable");
  await throws(() => A.createGrantInvite({ agencyId: agency.id, clientEmail: "not-an-email", role: "staff" }), "valid client email");
});

await t("wrong recipient and expired tokens create NOTHING", async () => {
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@aa.test", role: "staff" });
  eq(await A.acceptGrant(inv.token, { tenantId: "aa", actorEmail: "intruder@evil.test" }), null, "wrong recipient:");
  eq((await A.grantsForAgency(agency.id)).find((g) => g.id === inv.id).status, "pending", "still pending after wrong-recipient probe:");
  const stale = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@aa.test", role: "staff", ttlMs: -1000 });
  eq(await A.acceptGrant(stale.token, { tenantId: "aa", actorEmail: "owner@aa.test" }), null, "expired:");
  eq((await A.grantsForAgency(agency.id)).find((g) => g.id === stale.id).status, "expired", "listed as expired:");
  // the right person accepts the live one
  const g = await A.acceptGrant(inv.token, { tenantId: "aa", actorEmail: "Owner@AA.test" });
  eq(g.status, "accepted", "case-insensitive email match accepts:");
  eq(g.tenant_id, "aa");
});

await t("portfolio lists ONLY granted stores, with currency/timezone retained", async () => {
  const p = await A.agencyPortfolio(agency.id);
  eq(p.length, 1);
  eq(p[0].tenant, "aa");
  eq(p[0].currency, "INR");
  eq(p[0].timezone, "Asia/Kolkata");
  ok(p[0].health.orders30 >= 1, "health measured");
  eq((await A.agencyPortfolio(rival.id)).length, 0, "the other agency sees nothing:");
});

await t("revocation is immediate: portfolio, reports and kits all refuse", async () => {
  const g = (await A.grantsForAgency(agency.id)).find((x) => x.status === "accepted");
  await A.revokeGrant(g.id, "test");
  eq(await A.activeGrant(agency.id, "aa"), null, "grant gone:");
  eq((await A.agencyPortfolio(agency.id)).length, 0, "portfolio empty:");
  await throws(() => A.agencyClientReport(agency.id, "aa"), "no accepted grant", "report:");
  await throws(() => A.exportAgencyKit({ agencyId: agency.id, tenantId: "aa" }), "no accepted grant", "kit export:");
});

// re-grant aa (staff) + grant ab (support) for the rest of the suite
for (const [tenant, email, role] of [["aa", "owner@aa.test", "staff"], ["ab", "owner@ab.test", "support"]]) {
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: email, role });
  await A.acceptGrant(inv.token, { tenantId: tenant, actorEmail: email });
}

console.log("— kits (AG03): scrubbed structure, drafts on apply");

let kit = null;
await t("export scrubs source identifiers: media URLs, catalog handles, domains", async () => {
  kit = await A.exportAgencyKit({ agencyId: agency.id, tenantId: "aa", name: "Glow kit" });
  const leaks = A.kitScan(kit.payload, ["aa.test", "aa-exclusive-serum", "cdn.example", "aa-banner", "/api/media/", "buyer-a@x.test", "gid://shopify"]);
  eq(leaks.length, 0, `leaked: ${leaks.join(", ")}`);
  eq(kit.payload.hero.subtitle, "", "media-URL subtitle dropped, not copied:");
  eq(kit.payload.hero.primary.href, "/collections", "generic destination survives:");
  eq(kit.payload.hero.secondary, undefined, "catalog-handle link dropped:");
  eq(kit.payload.home_sections.length, 2, "section structure kept:");
  eq(kit.payload.announcement.enabled, false, "announcement arrives disabled:");
});

await t("apply: support role refused; staff writes DRAFTS only on the destination", async () => {
  await throws(() => A.applyAgencyKit({ agencyId: agency.id, kitId: kit.id, tenantId: "ab" }), "need staff or admin", "support can't write:");
  // upgrade ab to staff (client re-grants)
  const g = (await A.grantsForAgency(agency.id)).find((x) => x.tenant_id === "ab" && x.status === "accepted");
  await A.revokeGrant(g.id, "test");
  const inv = await A.createGrantInvite({ agencyId: agency.id, clientEmail: "owner@ab.test", role: "staff" });
  await A.acceptGrant(inv.token, { tenantId: "ab", actorEmail: "owner@ab.test" });
  const r = await A.applyAgencyKit({ agencyId: agency.id, kitId: kit.id, tenantId: "ab" });
  ok(r.written.includes("hero") && r.written.includes("home_sections"), "blocks written");
  ok(r.note.includes("DRAFTS"), "honest draft note");
  await inB(async () => {
    const Docs = await import("../lib/documents/service.js");
    const doc = await Docs.getDocument("doc_home");
    const hero = doc.body.sections.find((s) => s.kind === "hero");
    eq(hero.settings.title, "Glow like AA", "dest hero draft:");
    const { getLiveRelease } = await import("../lib/releases.js");
    eq(await getLiveRelease(), null, "live pointer untouched:");
  });
});

console.log("— approvals (AG04): hash-bound, expiring, identity-recorded");

await t("approve records identity against THE hash; a changed draft reads stale", async () => {
  const ap = await A.createClientApproval({ agencyId: agency.id, tenantId: "ab", note: "homepage refresh" });
  await throws(() => A.decideApproval(ap.token, { decision: "approved", approver: "" }), "name is required");
  const d = await A.decideApproval(ap.token, { decision: "approved", approver: "Priya (AB Owner)" });
  eq(d.status, "approved");
  eq(d.content_hash, ap.content_hash, "decision bound to the created hash:");
  let list = await A.approvalsForAgency(agency.id);
  eq(list.find((x) => x.id === ap.id).current, true, "approval is current:");
  // the draft changes — the old approval must go stale, not authorize it
  await inB(async () => {
    const { writeContentDrafts } = await import("../lib/content-writes.js");
    const Docs = await import("../lib/documents/service.js");
    await writeContentDrafts({ announcement: { enabled: true, text: "Changed after approval", href: "" } }, { source: "test:agency", documents: Docs });
  });
  list = await A.approvalsForAgency(agency.id);
  eq(list.find((x) => x.id === ap.id).current, false, "changed draft ⇒ stale approval:");
  await throws(() => A.decideApproval(ap.token, { decision: "rejected", approver: "Someone Else" }), "expired or already decided", "single decision:");
});

await t("expired links can't decide", async () => {
  const ap = await A.createClientApproval({ agencyId: agency.id, tenantId: "ab", ttlMs: -1000 });
  eq((await A.approvalByToken(ap.token)).status, "expired");
  await throws(() => A.decideApproval(ap.token, { decision: "approved", approver: "Late Larry" }), "expired");
});

console.log("— referrals & commissions (AG05): collected revenue, reversed once");

await t("commissions: earned on charges, reversed on refunds, NEVER double-counted", async () => {
  await A.attributeReferral("aa", agency.id, "brought by Studio North");
  const ins = (sql, args) => C.platformDb().execute({ sql, args });
  const now = new Date().toISOString();
  await ins("INSERT INTO billing_events (id, provider_event_id, tenant_id, type, amount, occurred_at, applied_at) VALUES ('bev_t1','pe1','aa','charged',10000,?,?)", [now, now]);
  await ins("INSERT INTO billing_events (id, provider_event_id, tenant_id, type, amount, occurred_at, applied_at) VALUES ('bev_t2','pe2','aa','refunded',-4000,?,?)", [now, now]);
  await ins("INSERT INTO billing_events (id, provider_event_id, tenant_id, type, amount, occurred_at, applied_at) VALUES ('bev_t3','pe3','ab','charged',5000,?,?)", [now, now]);
  const r1 = await A.recomputeCommissions();
  eq(r1.inserted, 2, "one earned + one reversed:");
  const r2 = await A.recomputeCommissions();
  eq(r2.inserted, 0, "idempotent re-run:");
  const st = await A.commissionStatement(agency.id);
  const m = st.months[0];
  eq(Number(m.earned), 1500, "15% of 10000:");
  eq(Number(m.reversed), -600, "15% of the refund, negative:");
  eq(Number(m.net), 900);
  ok(!st.entries.some((e) => e.tenant_id === "ab"), "non-referred store earns nothing:");
  ok(st.payoutsNote.includes("not payments"), "payouts honestly separate");
});

await t("eligibility gates computation; voiding a referral stops future events", async () => {
  await A.setAgencyStatus(agency.id, { referral_eligible: false });
  const now = new Date().toISOString();
  await C.platformDb().execute({ sql: "INSERT INTO billing_events (id, provider_event_id, tenant_id, type, amount, occurred_at, applied_at) VALUES ('bev_t4','pe4','aa','charged',8000,?,?)", args: [now, now] });
  eq((await A.recomputeCommissions()).inserted, 0, "ineligible = nothing:");
  await A.setAgencyStatus(agency.id, { referral_eligible: true });
  await A.voidReferral("aa", "dispute");
  eq((await A.recomputeCommissions()).inserted, 0, "voided = nothing:");
  await A.attributeReferral("aa", agency.id); // restore → the pending event now lands exactly once
  eq((await A.recomputeCommissions()).inserted, 1, "re-attributed picks up the one new event once:");
});

await t("an attributed store can't be silently re-pointed at another agency", async () => {
  await throws(() => A.attributeReferral("aa", rival.id), "already attributed");
});

console.log("— reports (AG06): per-client isolation");

await t("two concurrent client reports never mix metrics", async () => {
  const [ra, rb] = await Promise.all([A.agencyClientReport(agency.id, "aa"), A.agencyClientReport(agency.id, "ab")]);
  eq(ra.sales.gross, 11111, "aa totals:");
  eq(rb.sales.gross, 22222, "ab totals:");
  ok(!JSON.stringify(ra).includes("Beta Whey"), "aa report has no ab product:");
  ok(!JSON.stringify(rb).includes("Alpha Serum"), "ab report has no aa product:");
  eq(ra.timezone, "Asia/Kolkata");
});

console.log("— case studies (MK06): the publication gate");

await t("a lift claim without consent + measurement record CANNOT publish", async () => {
  await CS.upsertCaseStudy({ slug: "aa-growth", title: "AA grew 3×", body: "A big claim with nothing behind it." });
  await throws(() => CS.setCaseStudyPublished("aa-growth", true), "can't publish");
  const blocks = (await CS.listCaseStudies()).find((c) => c.slug === "aa-growth").publishBlocks;
  ok(blocks.some((b) => b.includes("consent")), "consent required");
  ok(blocks.some((b) => b.includes("measured result")), "measurement required");
});

await t("documented consent + period + method + results + caveats ⇒ publishes", async () => {
  await CS.upsertCaseStudy({
    slug: "aa-growth",
    title: "AA grew 3×",
    tenant_id: "aa",
    consent_ref: "written approval, owner@aa.test, 2026-10-20, email thread #482",
    period: "2026-07-01 → 2026-09-30",
    baseline: "Q2 2026 on the previous storefront",
    method: "orders + net sales from the reconciled rollup, same definitions both periods",
    limitations: "single store, festive quarter",
    confounders: "a Diwali campaign ran in the same window",
    results: [{ metric: "orders / month", before: "41", after: "128" }],
    quote: "The new storefront paid for itself in a month.",
    quote_by: "Owner, AA (used with permission)",
    body: "What we changed and measured.",
  });
  eq((await CS.setCaseStudyPublished("aa-growth", true)).published, true);
  eq((await CS.listCaseStudies({ publishedOnly: true })).length, 1);
  ok(await CS.getCaseStudy("aa-growth"), "published study readable");
  await CS.setCaseStudyPublished("aa-growth", false);
  eq(await CS.getCaseStudy("aa-growth"), null, "unpublished hidden from the site:");
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
