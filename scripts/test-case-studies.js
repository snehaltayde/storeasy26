// Case studies (MK06): the publication gate and the operator route
// (Phase 0 line 4 moved them out of the retired Partners panel).
//   pnpm test:case-studies
// A case study publishes only with documented merchant consent and a
// measurement record. The authoring route, app/api/platform/case-studies, is
// operator only: signed out and a merchant owner get 401; every save, publish
// and delete writes an audit_log row. The marketing site reads published
// studies only (getCaseStudy → null for a draft).
// Outside services are blanked and fetch() is blocked; every database is a
// throwaway file: database.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
const network = H.blockNetwork();
process.env.DATABASE_URL = "file:.test-cases-default.db";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`✗ ${name}\n    ${String(e?.message || e).split("\n").join("\n    ")}`);
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

const store = await H.makeRoleStore({ name: "cases" });
const C = await import("../lib/platform/control.js");
const CS = await import("../lib/platform/case-studies.js");

const MEASURED = {
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
};

// ---------------------------------------------------------------------------
console.log("— the publication gate");

await t("a lift claim without consent + measurement record CANNOT publish", async () => {
  await CS.upsertCaseStudy({ slug: "aa-growth", title: "AA grew 3×", body: "A big claim with nothing behind it." });
  await throws(() => CS.setCaseStudyPublished("aa-growth", true), "can't publish");
  const blocks = (await CS.listCaseStudies()).find((c) => c.slug === "aa-growth").publishBlocks;
  ok(blocks.some((b) => b.includes("consent")), "consent required");
  ok(blocks.some((b) => b.includes("measured result")), "measurement required");
});

await t("documented consent + period + method + results + caveats ⇒ publishes", async () => {
  await CS.upsertCaseStudy({ slug: "aa-growth", ...MEASURED });
  eq((await CS.setCaseStudyPublished("aa-growth", true)).published, true);
  eq((await CS.listCaseStudies({ publishedOnly: true })).length, 1);
  ok(await CS.getCaseStudy("aa-growth"), "published study readable");
  await CS.setCaseStudyPublished("aa-growth", false);
  eq(await CS.getCaseStudy("aa-growth"), null, "unpublished hidden from the site:");
});

await t("anonymous read of an unpublished study is null (the marketing site's default)", async () => {
  await CS.upsertCaseStudy({ slug: "bb-draft", ...MEASURED, title: "BB draft" });
  eq(await CS.getCaseStudy("bb-draft"), null, "draft:");
  eq(await CS.getCaseStudy("no-such-study"), null, "missing:");
  ok(!(await CS.listCaseStudies({ publishedOnly: true })).some((c) => c.slug === "bb-draft"), "not in the published list");
});

// ---------------------------------------------------------------------------
console.log("— the operator route");

const ROUTE = join(ROOT, "app/api/platform/case-studies/route.js");
const R = existsSync(ROUTE) ? await import(pathToFileURL(ROUTE).href) : null;
const { NextRequest } = await import("./support/next-server-stub.js");
const req = ({ method = "GET", cookies = {}, body, origin } = {}) => {
  const headers = { host: "ops.test" };
  if (method !== "GET") headers.origin = origin ?? "http://ops.test";
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest("http://ops.test/api/platform/case-studies", { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
};
const call = async (opts) => {
  if (!R) throw new Error("no app/api/platform/case-studies/route.js");
  const res = await R[opts?.method || "GET"](req(opts));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const operator = store.cookies["operator-support"];
const auditRows = async (action) =>
  (await C.platformDb().execute({ sql: "SELECT * FROM audit_log WHERE action = ? ORDER BY at", args: [action] })).rows;

await t("signed out: GET and POST are 401 and change nothing", async () => {
  eq((await call({})).status, 401, "GET:");
  eq((await call({ method: "POST", body: { case_study: { slug: "nope", title: "Nope" } } })).status, 401, "POST:");
  eq(await CS.getCaseStudy("nope", { publishedOnly: false }), null, "nothing saved:");
});

await t("a merchant owner's session is 401 on GET and POST", async () => {
  eq((await call({ cookies: { _platform: store.cookies.owner._admin } })).status, 401, "owner token as operator cookie, GET:");
  eq((await call({ cookies: store.cookies.owner })).status, 401, "owner _admin cookie, GET:");
  eq((await call({ method: "POST", cookies: store.cookies.owner, body: { delete_case: { slug: "aa-growth" } } })).status, 401, "POST:");
  ok(await CS.getCaseStudy("aa-growth", { publishedOnly: false }), "the study survives");
});

await t("support, staff and admin member sessions are 401 on GET and POST", async () => {
  for (const role of ["support", "staff", "admin"]) {
    eq((await call({ cookies: store.cookies[role] })).status, 401, `${role} _admin cookie, GET:`);
    eq((await call({ cookies: { _platform: store.cookies[role]._admin } })).status, 401, `${role} token as operator cookie, GET:`);
    eq((await call({ method: "POST", cookies: store.cookies[role], body: { delete_case: { slug: "aa-growth" } } })).status, 401, `${role} POST:`);
  }
  ok(await CS.getCaseStudy("aa-growth", { publishedOnly: false }), "the study survives");
});

await t("the operator lists every study with its publish blocks (200)", async () => {
  const r = await call({ cookies: operator });
  eq(r.status, 200, "GET:");
  const slugs = r.body.caseStudies.map((c) => c.slug);
  ok(slugs.includes("aa-growth") && slugs.includes("bb-draft"), `listed: ${slugs}`);
  ok(Array.isArray(r.body.caseStudies[0].publishBlocks), "publishBlocks present");
});

await t("save writes the draft and an audit_log row", async () => {
  const r = await call({ method: "POST", cookies: operator, body: { case_study: { slug: "cc-route", ...MEASURED, title: "CC via route" } } });
  eq(r.status, 200, "POST case_study:");
  eq(r.body.caseStudy.published, 0, "saved as a draft:");
  const rows = await auditRows("case_study.save");
  eq(rows.length, 1, "one save row:");
  eq(rows[0].resource, "case:cc-route");
  eq(rows[0].actor_kind, "operator");
});

await t("publish is gated and audited; a blocked publish is 422 with its blocks", async () => {
  await CS.upsertCaseStudy({ slug: "dd-claim", title: "DD claim" });
  const blocked = await call({ method: "POST", cookies: operator, body: { publish_case: { slug: "dd-claim", published: true } } });
  eq(blocked.status, 422, "blocked publish:");
  ok(Array.isArray(blocked.body.blocks) && blocked.body.blocks.length, "blocks returned");
  const r = await call({ method: "POST", cookies: operator, body: { publish_case: { slug: "cc-route", published: true } } });
  eq(r.status, 200, "publish:");
  eq(r.body.published, true);
  ok(await CS.getCaseStudy("cc-route"), "live on the site");
  const rows = await auditRows("case_study.publish");
  eq(rows.length, 1, "one publish row (the blocked one wrote none):");
  eq(rows[0].resource, "case:cc-route");
});

await t("delete removes the study and writes an audit_log row", async () => {
  const r = await call({ method: "POST", cookies: operator, body: { delete_case: { slug: "cc-route" } } });
  eq(r.status, 200, "delete:");
  eq(await CS.getCaseStudy("cc-route", { publishedOnly: false }), null, "gone:");
  const rows = await auditRows("case_study.delete");
  eq(rows.length, 1, "one delete row:");
  eq(rows[0].resource, "case:cc-route");
});

await t("a foreign Origin is 403 even for the operator, and changes nothing", async () => {
  await CS.upsertCaseStudy({ slug: "ee-origin", ...MEASURED, title: "EE before" });
  const before = JSON.stringify((await C.platformDb().execute("SELECT * FROM case_studies ORDER BY slug")).rows);
  const auditBefore = Number((await C.platformDb().execute("SELECT COUNT(*) n FROM audit_log")).rows[0].n);
  for (const body of [{ case_study: { slug: "ee-origin", ...MEASURED, title: "EE hijacked" } }, { publish_case: { slug: "ee-origin", published: true } }, { delete_case: { slug: "ee-origin" } }]) {
    eq((await call({ method: "POST", cookies: operator, origin: "https://evil.example", body })).status, 403, `${Object.keys(body)[0]}:`);
  }
  eq(JSON.stringify((await C.platformDb().execute("SELECT * FROM case_studies ORDER BY slug")).rows), before, "case_studies unchanged:");
  eq(Number((await C.platformDb().execute("SELECT COUNT(*) n FROM audit_log")).rows[0].n), auditBefore, "audit_log unchanged:");
});

await t("editing a published study takes it back to draft: off /customers, and republishing runs the gate again", async () => {
  await CS.upsertCaseStudy({ slug: "ff-live", ...MEASURED, title: "FF live" });
  await CS.setCaseStudyPublished("ff-live", true);
  ok(await CS.getCaseStudy("ff-live"), "setup: live");
  const r = await call({ method: "POST", cookies: operator, body: { case_study: { slug: "ff-live", ...MEASURED, title: "FF edited", consent_ref: "" } } });
  eq(r.status, 200, "save:");
  const row = (await C.platformDb().execute({ sql: "SELECT * FROM case_studies WHERE slug = 'ff-live'" })).rows[0];
  eq(Number(row.published), 0, "the row is a draft:");
  eq(Number(r.body.caseStudy.published), 0, "the answer says draft:");
  eq(r.body.caseStudy.created_at, row.created_at, "the answer matches the row (created_at):");
  eq(r.body.caseStudy.title, "FF edited");
  eq(await CS.getCaseStudy("ff-live"), null, "not on /customers:");
  const again = await call({ method: "POST", cookies: operator, body: { publish_case: { slug: "ff-live", published: true } } });
  eq(again.status, 422, "republish blocked:");
  ok(again.body.blocks.some((b) => b.includes("consent")), `blocked on consent: ${again.body.blocks}`);
  eq(await CS.getCaseStudy("ff-live"), null, "still not on /customers:");
});

await t("an empty POST is 400", async () => {
  eq((await call({ method: "POST", cookies: operator, body: {} })).status, 400);
});

await t("no network: nothing reached fetch()", () => {
  eq(network.length, 0, `fetch calls: ${network.join(", ")}`);
});

await store.cleanup();
const { rm } = await import("node:fs/promises");
for (const f of [".test-cases-default.db", ".test-cases-default.db-wal", ".test-cases-default.db-shm"]) await rm(join(ROOT, f), { force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
