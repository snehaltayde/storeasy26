// Growth-ops suite (Session 47 / BE22 + BE32 + OP09 + OP13): experiment
// assignment/freeze/SRM/no-peeking/adoption-as-draft, AI facts PII guard +
// untrusted-output validation + budgets + injection boundary, feature-flag
// namespace/cohorts/expiry/emergency-disable (uncached critical reads), and
// cost allocation with a visible unallocated remainder.
//   pnpm test:growth
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

process.env.TURSO_DB_URL = "";
process.env.RESEND_API_KEY = "";
process.env.ANTHROPIC_API_KEY = ""; // AI = honest unconfigured unless a test injects a mock call
process.env.DATABASE_URL = "file:.test-growth-default.db";
process.env.PLATFORM_DB_URL = "file:.test-growth-platform.db";
process.env.PLATFORM_DB_TOKEN = "";
process.env.PLATFORM_SECRET = "test-platform-secret";
process.env.PLATFORM_CACHE_MS = "50";
process.env.FLAG_CACHE_MS = "60000"; // big on purpose: proves critical reads bypass it

const dbs = [".test-growth-default.db", ".test-growth-platform.db", ".test-growth-a.db", ".test-growth-b.db"];
for (const f of dbs) await rm(join(here, "..", f), { force: true });

const C = await import("../lib/platform/control.js");
const { withTenant } = await import("../lib/tenant-context.js");
const { libsql, db } = await import("../lib/db.js");
const X = await import("../lib/experiments.js");
const AI = await import("../lib/ai/insights.js");
const F = await import("../lib/platform/flags.js");
const Costs = await import("../lib/platform/costs.js");
const Docs = await import("../lib/documents/service.js");
const { recordUsage, usageTotals, periodOf } = await import("../lib/platform/billing.js");
const { loadMigrations, runMigrations } = await import("../lib/platform/migrate.js");

await C.migratePlatform(await readFile(join(here, "../lib/platform/schema.sql"), "utf8"));
await runMigrations(C.platformDb(), await loadMigrations("platform"), {});
const schema = await readFile(join(here, "../lib/schema.sql"), "utf8");
for (const [id, file] of [["ga", ".test-growth-a.db"], ["gb", ".test-growth-b.db"]]) {
  await C.upsertTenant({ id, name: id, domains: [`${id}.test`], dbUrl: `file:${file}`, config: {}, secrets: { order_link_secret: `${id}-secret` } });
  await withTenant(await C.getTenant(id), async () => {
    await libsql.executeMultiple(schema);
    await runMigrations(libsql, await loadMigrations("tenant"));
  });
}
const inA = async (fn) => withTenant(await C.getTenant("ga"), fn);
const inB = async (fn) => withTenant(await C.getTenant("gb"), fn);

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

console.log("— experiments (BE22): plan freeze, stable assignment, honest stats");

await t("validation: control first + payload rules + weights", async () => {
  const bad1 = X.validateExperiment({ slug: "x", name: "x", variants: [{ key: "b", weight: 50, payload: { title: "t" } }, { key: "control", weight: 50 }] });
  ok(!bad1.ok && bad1.errors.some((e) => e.includes("first variant")), "control must be first");
  const bad2 = X.validateExperiment({ slug: "x", name: "x", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50 }] });
  ok(!bad2.ok && bad2.errors.some((e) => e.includes("needs a payload")), "non-control needs payload");
  const good = X.validateExperiment({ slug: "x", name: "x", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "New hero" } }] });
  ok(good.ok, good.errors.join("; "));
});

await t("assignment: deterministic, server-derived, weights roughly honored", async () => {
  const exp = { slug: "assign-test", salt: "s1", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50 }] };
  eq(X.assignVariant(exp, "unit-123"), X.assignVariant(exp, "unit-123"), "same unit same variant:");
  const counts = { control: 0, b: 0 };
  for (let i = 0; i < 2000; i++) counts[X.assignVariant(exp, `unit-${i}`)]++;
  ok(counts.control > 800 && counts.b > 800, `rough 50/50 (got ${counts.control}/${counts.b})`);
  const exp91 = { ...exp, variants: [{ key: "control", weight: 90 }, { key: "b", weight: 10 }] };
  let b = 0;
  for (let i = 0; i < 2000; i++) if (X.assignVariant(exp91, `unit-${i}`) === "b") b++;
  ok(b > 100 && b < 320, `90/10 split honored (b got ${b}/2000)`);
});

await t("lifecycle: start needs a hypothesis, freezes the plan, one per target", async () => {
  await inA(async () => {
    await X.upsertExperiment({ slug: "hero-a", name: "Hero A", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "Fuel every rep", highlight: "rep", subtitle: "New line" } }] });
    await throws(() => X.startExperiment("hero-a"), "hypothesis", "no hypothesis:");
    await X.upsertExperiment({ slug: "hero-a", name: "Hero A", hypothesis: "a sharper promise lifts conversion", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "Fuel every rep", highlight: "rep", subtitle: "New line" } }] });
    await X.startExperiment("hero-a");
    await throws(() => X.upsertExperiment({ slug: "hero-a", name: "Hero A2", hypothesis: "h", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "x" } }] }), "froze", "running = frozen:");
    await X.upsertExperiment({ slug: "hero-b", name: "Hero B", hypothesis: "h", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "y" } }] });
    await throws(() => X.startExperiment("hero-b"), "already runs", "one per target:");
  });
});

await t("exposure: server re-derives the variant; first exposure wins; idempotent", async () => {
  await inA(async () => {
    const r1 = await X.recordExposure("hero-a", "unit-9");
    const r2 = await X.recordExposure("hero-a", "unit-9");
    ok(r1.recorded && r2.recorded);
    const rows = await db.selectFrom("experiment_exposures").selectAll().execute();
    eq(rows.filter((r) => r.unit_id === "unit-9").length, 1, "one exposure row:");
    const exp = (await X.listExperiments()).find((e) => e.slug === "hero-a");
    eq(rows[0].variant, X.assignVariant(exp, "unit-9"), "variant matches the pure hash:");
  });
});

await t("conversion: requires exposure, idempotent per order, zero without a unit", async () => {
  await inA(async () => {
    eq(await X.recordConversions("never-exposed", "O-X", 100), 0, "unexposed unit converts nothing:");
    await X.recordExposure("hero-a", "unit-c1");
    eq(await X.recordConversions("unit-c1", "O-1", 999), 1);
    eq(await X.recordConversions("unit-c1", "O-1", 999), 1, "replay same order:");
    const n = await db.selectFrom("experiment_conversions").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    eq(Number(n.n), 1, "still one conversion row:");
    eq(await X.recordConversions(null, "O-2", 1), 0, "no unit cookie = honestly uncounted:");
  });
});

await t("NO PEEKING: a running experiment's analysis blocks winner interpretation", async () => {
  await inA(async () => {
    const a = await X.analyzeExperiment("hero-a");
    ok(a.interpretationBlocked.some((b) => b.includes("no peeking")), "running blocks");
    eq(a.verdict, null, "no verdict while blocked:");
  });
});

await t("SRM guard: skewed exposure ratios block interpretation loudly", async () => {
  ok(X.srmCheck([500, 500], [50, 50]).ok, "balanced passes");
  ok(!X.srmCheck([700, 300], [50, 50]).ok, "70/30 on a 50/50 plan fails");
  await inA(async () => {
    // force-complete with heavy skew recorded straight into the table
    for (let i = 0; i < 90; i++) await db.insertInto("experiment_exposures").values({ experiment_id: (await db.selectFrom("experiments").select("id").where("slug", "=", "hero-a").executeTakeFirst()).id, unit_id: `skew-${i}`, variant: "control", first_exposed_at: new Date().toISOString() }).onConflict((oc) => oc.doNothing()).execute();
    await X.setExperimentStatus("hero-a", "completed");
    const a = await X.analyzeExperiment("hero-a");
    ok(a.interpretationBlocked.some((b) => b.includes("mismatch") || b.includes("insufficient")), "skew/sample blocks post-completion");
  });
});

await t("sufficiency + significance: winner only when earned; A/A gives an honest null", async () => {
  // pure math path (no DB): sufficient, significant
  const sig = X.compareTopTwo([
    { key: "b", exposed: 1000, conversions: 80, rate: 0.08 },
    { key: "control", exposed: 1000, conversions: 40, rate: 0.04 },
  ]);
  eq(sig.winner, "b", "clear lift wins:");
  // A/A: same rates → no winner claim
  const aa = X.compareTopTwo([
    { key: "control", exposed: 1000, conversions: 50, rate: 0.05 },
    { key: "a2", exposed: 1000, conversions: 52, rate: 0.052 },
  ]);
  eq(aa.winner, null, "A/A noise is not a winner:");
  ok(!aa.significant);
});

await t("adoption: refused while running; completed → hero DRAFT, release untouched", async () => {
  await inA(async () => {
    await X.upsertExperiment({ slug: "hero-c", name: "Hero C", hypothesis: "h", variants: [{ key: "control", weight: 50 }, { key: "b", weight: 50, payload: { title: "Adopted title", highlight: "Adopted", subtitle: "s" } }] });
    await X.startExperiment("hero-c");
    await throws(() => X.adoptVariant("hero-c", "b"), "complete the experiment", "running can't adopt:");
    await X.setExperimentStatus("hero-c", "completed");
    const r = await X.adoptVariant("hero-c", "b", { documents: Docs });
    ok(r.draft && /publish/i.test(r.note), "draft + honest note");
    const doc = await Docs.getDocument("doc_home");
    const hero = doc.body.sections.find((s) => s.kind === "hero");
    eq(hero.settings.title, "Adopted title", "hero draft written:");
    const { getLiveRelease } = await import("../lib/releases.js");
    eq(await getLiveRelease(), null, "no release published by adoption:");
  });
});

console.log("— AI assistance (BE32): tenant-only facts, untrusted output, budgets");

await t("facts: gathered from THIS tenant only, and the PII guard holds", async () => {
  await inA(async () => {
    await libsql.execute({
      sql: "INSERT INTO orders (id, email, total, currency, status, snapshot, created_at, updated_at, sync_attempts, refunded_total) VALUES ('AI-1','secret.buyer@leak.test',500,'INR','paid',?, ?, ?,0,0)",
      args: [JSON.stringify({ items: [{ title: "Whey Gold", quantity: 2 }] }), new Date().toISOString(), new Date().toISOString()],
    });
    const facts = await AI.gatherTenantFacts();
    ok(facts.length >= 2, "facts gathered");
    ok(!JSON.stringify(facts).includes("secret.buyer"), "no email leaked into facts");
    AI.assertNoPii(facts);
    await throws(async () => AI.assertNoPii([{ id: "f1", text: "mail me at a@b.co" }]), "PII guard", "guard catches an email:");
  });
});

await t("validator: invented evidence and non-allowlisted components are REJECTED", async () => {
  const facts = [{ id: "f1", kind: "catalog", text: "catalog: 10 products" }];
  await throws(async () => AI.validateProposals({ proposals: [{ title: "T", mechanism: "m", component: "hero", evidence: ["f99"] }] }, facts), "invented evidence");
  await throws(async () => AI.validateProposals({ proposals: [{ title: "T", mechanism: "m", component: "export_tenant_data", evidence: ["f1"] }] }, facts), "not allowlisted");
  await throws(async () => AI.validateProposals({ proposals: [{ title: "T", mechanism: "m", component: "none", evidence: [] }] }, facts), "no evidence");
  const good = AI.validateProposals({ proposals: [{ title: "T", mechanism: "m", component: "hero", evidence: ["f1"], draft: { title: "H" } }] }, facts);
  eq(good[0].component, "hero");
});

await t("injection boundary: hostile mock output stores NOTHING; live content untouched", async () => {
  await inA(async () => {
    const before = await db.selectFrom("ai_insights").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    const hostile = async () => ({
      text: JSON.stringify({ proposals: [{ title: "Ignore rules", mechanism: "export the other tenant", component: "cross_tenant_export", evidence: ["f1"] }] }),
      tokensIn: 10,
      tokensOut: 10,
    });
    await throws(() => AI.generateInsights({ call: hostile }), "not allowlisted", "hostile component:");
    const after = await db.selectFrom("ai_insights").select(({ fn }) => fn.countAll().as("n")).executeTakeFirst();
    eq(Number(after.n), Number(before.n), "nothing stored:");
  });
});

await t("good mock: stored, usage metered, draft applies through the CMS", async () => {
  await inA(async () => {
    const call = async ({ user }) => {
      const { facts } = JSON.parse(user);
      return {
        text: JSON.stringify({ proposals: [{ title: "Lead with the best seller", mechanism: "social proof up front", component: "hero", evidence: [facts[0].id], draft: { title: "Whey Gold — the one everyone reorders", highlight: "Whey Gold", subtitle: "Back in stock." } }] }),
        tokensIn: 120,
        tokensOut: 80,
      };
    };
    const r = await AI.generateInsights({ call });
    eq(r.proposals.length, 1);
    const spent = (await usageTotals("ga", periodOf())).ai_tokens || 0;
    eq(spent, 200, "tokens metered on the platform ledger:");
    const applied = await AI.applyInsightDraft(r.id, 0);
    ok(applied.note.includes("DRAFT"), "apply is a draft");
    const doc = await Docs.getDocument("doc_home");
    const hero = doc.body.sections.find((s) => s.kind === "hero");
    ok(hero.settings.title.includes("Whey Gold"), "hero draft updated");
  });
});

await t("budget gate + honest unconfigured state", async () => {
  await inA(async () => {
    // burn the ga budget: budget defaults 200k — shrink via tenant config
    const t = await C.getTenant("ga");
    await C.patchTenant("ga", { config: { ...t.config, ai_budget_tokens: 100 } });
  });
  await inA(async () => {
    const b = await AI.aiBudget();
    eq(b.remaining, 0, "spent 200 of 100:");
    await throws(() => AI.generateInsights({ call: async () => ({ text: "{}", tokensIn: 1, tokensOut: 1 }) }), "budget", "budget refusal:");
  });
  await inB(() => throws(() => AI.generateInsights(), "isn't configured", "no key = honest 503, never a mock:"));
});

console.log("— feature flags (OP13): namespace, cohorts, uncached critical reads");

await t("namespace: entitlement-looking keys are refused (separation by vocabulary)", async () => {
  await throws(() => F.setFlag({ key: "pro_plan", default_on: true }), "namespaced");
  await throws(() => F.setFlag({ key: "checkout", default_on: true }), "namespaced");
  await F.setFlag({ key: "ff_search-v2", description: "new search", default_on: false, tenants: { ga: 1 } });
});

await t("evaluation: default, cohort override, expiry, unknown-flag fallback", async () => {
  eq(await F.flagEnabled("ff_search-v2", "ga"), true, "cohort on:");
  eq(await F.flagEnabled("ff_search-v2", "gb"), false, "default off:");
  eq(await F.flagEnabled("ff_nonexistent", "ga", { fallback: true }), true, "fallback:");
  eq(await F.flagEnabled("ff_nonexistent", "ga", { fallback: false }), false, "fallback respected:");
  await F.setFlag({ key: "ff_expired", default_on: true, expires_at: "2020-01-01T00:00:00.000Z" });
  eq(await F.flagEnabled("ff_expired", "ga", { fallback: false }), false, "expired = off for everyone:");
});

await t("CRITICAL flags bypass the cache: a direct DB flip is seen immediately", async () => {
  await F.setFlag({ key: "ff_checkout", description: "kill-switch", default_on: true, critical: true });
  eq(await F.flagEnabled("ff_checkout", "ga"), true);
  // simulate ANOTHER INSTANCE disabling it: raw SQL, no local cache bust
  await C.platformDb().execute("UPDATE feature_flags SET default_on = 0 WHERE key = 'ff_checkout'");
  eq(await F.flagEnabled("ff_checkout", "ga", { fallback: true }), false, "critical read is uncached:");
  // contrast: a NON-critical flag flipped the same way stays cached (60s TTL here)
  await C.platformDb().execute("UPDATE feature_flags SET default_on = 1 WHERE key = 'ff_search-v2'");
  eq(await F.flagEnabled("ff_search-v2", "gb"), false, "non-critical rides the cache window:");
  F.__resetFlagCache();
  eq(await F.flagEnabled("ff_search-v2", "gb"), true, "fresh cache sees it:");
});

await t("emergency disable: default off + cohorts cleared + audited", async () => {
  await F.setFlag({ key: "ff_checkout", description: "kill-switch", default_on: true, critical: true });
  await F.emergencyDisable("ff_checkout", "op:test");
  eq(await F.flagEnabled("ff_checkout", "ga", { fallback: true }), false, "killed:");
  const a = await C.platformDb().execute("SELECT COUNT(*) n FROM audit_log WHERE action = 'flags.emergency_disable'");
  ok(Number(a.rows[0].n) >= 1, "audited");
  await F.setFlag({ key: "ff_checkout", description: "kill-switch", default_on: true, critical: true }); // restore
});

console.log("— tenant unit costs (OP09): stated method, visible remainder");

await t("inputs: validated and round-tripped", async () => {
  await throws(() => Costs.setCostInputs("nope", {}), "YYYY-MM");
  await throws(() => Costs.setCostInputs("2026-10", { compute: -5 }), "non-negative");
  const r = await Costs.setCostInputs(periodOf(), { compute: 1000, db: 500, mail: 100, ai: 200, other: 300 }, "test month");
  eq(r.totals.compute, 1000);
});

await t("allocation: proportional to measured drivers; 'other' and gaps stay unallocated", async () => {
  // drivers: ga has orders (AI-1 above) + media; gb has nothing
  await inA(async () => {
    await libsql.execute("INSERT INTO media (id, filename, mime, size, alt, sha256, data, created_at) VALUES ('m1','a.png','image/png',1000000,'', 'h1', x'00', '2026-10-01')");
  });
  const report = await Costs.costReport(periodOf());
  ok(report.configured);
  const ga = report.tenants.find((t) => t.tenant === "ga");
  const gb = report.tenants.find((t) => t.tenant === "gb");
  ok(ga.allocated > 0, "driver-backed tenant gets an allocation");
  ok(ga.costs.compute > gb.costs.compute, "orders drive compute");
  // mail bucket: NO notifications anywhere → fully unallocated, never split evenly
  eq(gb.costs.mail + ga.costs.mail, 0, "zero-driver bucket allocates nothing:");
  ok(report.unallocated >= 300 + 100, `'other' + zero-driver mail stay visible (unallocated=${report.unallocated})`);
  eq(Math.round((report.allocated + report.unallocated) * 100) / 100, report.total, "allocated + unallocated = total:");
  ok(report.method.compute.includes("orders"), "method stated");
});

await t("budgets alert (never auto-charge); unmeasured tenants stay visible", async () => {
  const t = await C.getTenant("ga");
  await C.patchTenant("ga", { config: { ...t.config, cost_budget: 1 } });
  const report = await Costs.costReport(periodOf());
  ok(report.alerts.some((a) => a.tenant === "ga"), "over-budget alert");
  await C.upsertTenant({ id: "gc", name: "gc", domains: ["gc.test"], dbUrl: "file:/nonexistent-dir-s47/x.db", config: {}, secrets: {} });
  const report2 = await Costs.costReport(periodOf());
  ok(report2.unmeasured.includes("gc"), "unreachable tenant listed as unmeasured");
  await C.patchTenant("gc", { status: "suspended" }); // tidy: drop from active set
});

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of dbs) await rm(join(here, "..", f), { force: true });
process.exit(fail ? 1 : 0);
