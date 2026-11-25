// Analytics, experiments, insights and automations on the new UI
// (docs/plans/phase-2.md "Line 9").
//   pnpm test:growth-ui
//   1. the routes, every caller (support, the least-trusted, first): starting
//      an experiment needs storefront.publish (D6: staff 403, admin 200, and
//      the start is audited as storefront.publish); drafts, pause, complete,
//      adopt and insights stay storefront.write; automations stay settings.*;
//      Generate never reaches an AI provider (no key: "not configured")
//   2. the anonymous shopper: a draft or paused experiment is never served by
//      /api/exp (no exposure is recorded)
//   3. the pages as support, staff and signed out (scripts/support/page-harness.js):
//      analytics props hold aggregates only (no customer name, email or
//      phone); automations as staff or support hold no rules
//   4. the screens' markup as support and as writers (Next's SWC,
//      react-dom/server): support's analytics, experiments and insights hold
//      no write control; staff sees Start disabled with the reason
// File databases only; outside services blanked, the network blocked.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const H = await import("./support/route-harness.js");
H.blankOutsideServices();
process.env.ANTHROPIC_API_KEY = ""; // Generate is "not configured": no provider is ever called
process.env.DATABASE_URL = "file:.test-gui-default.db";
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
const store = await H.makeRoleStore({ name: "gui" });
const { a, call } = store;
const C = await import("../lib/platform/control.js");
const X = await import("../lib/experiments.js");

const draft = (slug, extra = {}) => ({
  slug,
  name: `Test ${slug}`,
  hypothesis: "A shorter hero title sells more",
  target_kind: "hero",
  min_sample: 50,
  variants: [
    { key: "control", weight: 50 },
    { key: "b", weight: 50, payload: { title: "Shorter", highlight: "", subtitle: "" } },
  ],
  ...extra,
});
const statusOf = async (slug) => (await a.run(() => X.listExperiments())).find((e) => e.slug === slug)?.status ?? null;
async function auditRows(resource) {
  return (await C.platformDb().execute({ sql: "SELECT action FROM audit_log WHERE resource = ? ORDER BY at", args: [resource] })).rows.map((r) => r.action);
}

console.log("— 1. the routes");
await t("D6: starting an experiment needs storefront.publish: support and staff 403 (still a draft), admin 200 and audited as storefront.publish", async () => {
  eq((await call("staff", "experiments", "POST", { body: { experiment: draft("gate-one") } })).status, 200, "staff saves the draft:");
  for (const caller of ["support", "operator-support", "staff"]) {
    const r = await call(caller, "experiments", "POST", { body: { start: { slug: "gate-one" } } });
    eq(r.status, 403, `${caller} start:`);
    eq(await statusOf("gate-one"), "draft", `after ${caller}'s start:`);
  }
  eq((await call("signed-out", "experiments", "POST", { body: { start: { slug: "gate-one" } } })).status, 401, "signed out:");
  const r = await call("admin", "experiments", "POST", { body: { start: { slug: "gate-one" } } });
  eq([r.status, r.body?.status], [200, "running"], "admin start:");
  eq(await statusOf("gate-one"), "running");
  ok((await auditRows("experiment:gate-one")).includes("storefront.publish"), "the start is audited as storefront.publish:");
  const again = await call("admin", "experiments", "POST", { body: { start: { slug: "gate-one" } } });
  eq([again.status, again.body?.status, again.body?.changed], [200, "running", false], "starting a running one is a no-op:");
  eq((await auditRows("experiment:gate-one")).filter((x) => x === "storefront.publish").length, 1, "audited once, when the status changed:");
});

await t("staff keeps everything else storefront.write: edit a draft, pause, complete and keep a variant; support is 403 on each and nothing changes", async () => {
  eq((await call("staff", "experiments", "POST", { body: { experiment: draft("gate-one") } })).status, 422, "a started plan is frozen (staff edit):");
  for (const [body, label] of [[{ experiment: draft("gate-two") }, "draft"], [{ pause: { slug: "gate-one" } }, "pause"], [{ complete: { slug: "gate-one" } }, "complete"], [{ adopt: { slug: "gate-one", variant: "control" } }, "adopt"]]) {
    eq((await call("support", "experiments", "POST", { body })).status, 403, `support ${label}:`);
  }
  eq(await statusOf("gate-two"), null, "support's draft was not saved:");
  eq((await call("staff", "experiments", "POST", { body: { pause: { slug: "gate-one" } } })).body?.status, "paused", "staff pause:");
  eq((await call("staff", "experiments", "POST", { body: { start: { slug: "gate-one" } } })).status, 403, "staff resume (a start) is refused:");
  eq((await call("staff", "experiments", "POST", { body: { complete: { slug: "gate-one" } } })).body?.status, "completed", "staff complete:");
  const kept = await call("staff", "experiments", "POST", { body: { adopt: { slug: "gate-one", variant: "control" } } });
  eq([kept.status, kept.body?.adopted, kept.body?.draft], [200, "control", false], "staff keeps the control:");
  for (const caller of ["support", "staff", "admin", "owner"]) eq((await call(caller, "experiments", "GET", { query: "analyze=gate-one" })).status, 200, `${caller} reads the analysis:`);
});

await t("insights: every member reads them; Generate with no AI provider is 'not configured' (503) and stores nothing; support's writes are 403", async () => {
  const before = (await call("owner", "insights", "GET")).body;
  eq([before.configured, before.insights.length], [false, 0], "not configured, none yet:");
  for (const caller of ["support", "operator-support", "staff"]) eq((await call(caller, "insights", "GET")).status, 200, `${caller} reads:`);
  const g = await call("staff", "insights", "POST", { body: { generate: true } });
  eq([g.status, g.body?.code], [503, "AI_UNCONFIGURED"], "staff generate:");
  eq((await call("owner", "insights", "GET")).body.insights.length, 0, "nothing stored:");
  {
    const c = a.client();
    try {
      await c.execute({ sql: "INSERT INTO ai_insights (id, status, model, proposals, facts, created_at, updated_at) VALUES ('ins-gui1', 'proposed', 'stub', '[]', '[]', ?, ?)", args: [new Date().toISOString(), new Date().toISOString()] });
    } finally {
      c.close();
    }
  }
  eq((await call("staff", "insights", "POST", { body: { dismiss: { id: "ins-gui1" } } })).body?.status, "dismissed", "staff dismisses:");
  eq((await call("staff", "insights", "POST", { body: { restore: { id: "ins-gui1" } } })).body?.status, "proposed", "staff restores:");
  eq(await auditRows("ai_insight:ins-gui1"), ["storefront.write", "storefront.write"], "dismiss and restore are audited:");
  for (const body of [{ generate: true }, { dismiss: { id: "x" } }, { restore: { id: "x" } }, { apply: { id: "x", index: 0 } }]) eq((await call("support", "insights", "POST", { body })).status, 403, `support ${Object.keys(body)[0]}:`);
});

const RULE = { name: "Big order note cnyrule0", trigger: "order_placed", conditions: { min_total: 100 }, action: { kind: "notify_merchant", subject: "", text: "A big one" }, cap_per_day: 5 };
await t("automations stay admin-only: staff and support 403 on read and write; admin saves, dry-runs and the kill switch works", async () => {
  for (const caller of ["support", "operator-support", "staff"]) {
    eq((await call(caller, "automations", "GET")).status, 403, `${caller} GET:`);
    eq((await call(caller, "automations", "POST", { body: { automation: RULE } })).status, 403, `${caller} POST:`);
  }
  const saved = await call("admin", "automations", "POST", { body: { automation: RULE, enabled: true } });
  eq([saved.status, saved.body?.automation?.enabled], [200, true], "admin saves:");
  const off = await call("admin", "automations", "POST", { body: { disable_all: { disabled: true } } });
  eq(off.body?.disabled, true, "kill switch:");
  eq((await call("admin", "automations", "POST", { body: { disable_all: { disabled: false } } })).body?.disabled, false, "back on:");
  eq(await auditRows("automations:disable_all"), ["settings.write", "settings.write"], "both kill-switch changes are audited as settings.write:");
});

await t("the dry run is a settings.write POST (admins only), not a read: it sends nothing, and with automations on it stores no run and no audit row", async () => {
  const rule = (await call("admin", "automations", "GET")).body.automations.find((r) => r.name === RULE.name);
  const runsBefore = (await call("admin", "automations", "GET")).body.runs.length;
  const auditBefore = Number((await C.platformDb().execute("SELECT COUNT(*) n FROM audit_log")).rows[0].n);
  eq((await call("staff", "automations", "POST", { body: { dry_run: { id: rule.id } } })).status, 403, "staff:");
  const r = await call("admin", "automations", "POST", { body: { dry_run: { id: rule.id } } });
  eq([r.status, r.body?.status], [200, "dry_run"], "admin:");
  eq((await call("admin", "automations", "GET")).body.runs.length, runsBefore, "no run row:");
  eq(Number((await C.platformDb().execute("SELECT COUNT(*) n FROM audit_log")).rows[0].n), auditBefore, "no audit row:");
  eq((await call("admin", "automations", "POST", { body: { disable_all: { disabled: true } } })).body?.disabled, true);
  const killed = await call("admin", "automations", "POST", { body: { dry_run: { id: rule.id } } });
  eq([killed.status, killed.body?.status, killed.body?.wouldBe], [200, "dry_run", "skipped"], "a dry run with the kill switch on:");
  eq((await call("admin", "automations", "POST", { body: { disable_all: { disabled: false } } })).body?.disabled, false);
  eq((await call("admin", "automations", "GET")).body.runs.length, runsBefore, "it stores no run either:");
  const RC = await import("./support/read-controls.js");
  eq(RC.READ_POSTS.filter((x) => x.path === "/api/admin/automations"), [], "so it has no READ_POSTS row:");
});

console.log("— 2. the anonymous shopper");
const { NextRequest } = await import("./support/next-server-stub.js");
const exp = await import(pathToFileURL(join(ROOT, "app/api/exp/route.js")).href);
async function shopperPing(slug, unit) {
  const host = a.tenant.domains[0];
  const req = new NextRequest(`http://${host}/api/exp`, { method: "POST", headers: { host, origin: `http://${host}`, "content-type": "application/json", cookie: `_unit=${unit}` }, body: JSON.stringify({ slug }) });
  return (await exp.POST(req)).json();
}
const exposures = async (slug) => {
  const c = a.client();
  try {
    return Number((await c.execute({ sql: "SELECT COUNT(*) n FROM experiment_exposures e JOIN experiments x ON x.id = e.experiment_id WHERE x.slug = ?", args: [slug] })).rows[0].n);
  } finally {
    c.close();
  }
};
await t("a draft or paused experiment is never served by /api/exp: no exposure recorded; a running one is", async () => {
  // gate-one is completed; one per target can run, so the shopper drafts take turns
  eq((await call("staff", "experiments", "POST", { body: { experiment: draft("shop-draft") } })).status, 200);
  eq((await shopperPing("shop-draft", "unit-aaaa-0001")).recorded, false, "draft:");
  eq(await exposures("shop-draft"), 0, "draft exposures:");
  eq((await call("admin", "experiments", "POST", { body: { start: { slug: "shop-draft" } } })).status, 200);
  eq((await shopperPing("shop-draft", "unit-aaaa-0002")).recorded, true, "running (the control check):");
  eq((await call("admin", "experiments", "POST", { body: { pause: { slug: "shop-draft" } } })).body?.status, "paused");
  eq((await shopperPing("shop-draft", "unit-aaaa-0003")).recorded, false, "paused:");
  eq(await exposures("shop-draft"), 1, "only the running ping counted:");
  eq((await shopperPing("gate-one", "unit-aaaa-0004")).recorded, false, "completed:");
});

console.log("— 3. the pages");
const { makePageHarness } = await import("./support/page-harness.js");
const pages = await makePageHarness({ tenant: () => C.getTenant(a.id, { fresh: true }) });
const P = (f) => `app/(console)/admin/(authed)/${f}/page.js`;
const FORMULA = '=HYPERLINK("http://evil.example","x")';
const CUSTOMER = { name: "Cnyname Shopper", email: "cny.shopper@example.test", phone: "9811122233" };
{
  const c = a.client();
  try {
    const snapshot = JSON.stringify({ items: [{ productId: "gid-1", title: "Whey 1kg", qty: 2, price: 1500, lineTotal: 3000 }] });
    await c.execute({
      sql: "INSERT INTO orders (id, email, phone, name, address_line1, city, total, subtotal, currency, snapshot, payment_method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["GUI-ORDER-1", CUSTOMER.email, CUSTOMER.phone, CUSTOMER.name, "12 Cny Street", "Pune", 3000, 3000, "INR", snapshot, "cod", "cod_pending", new Date(Date.now() - 86400000).toISOString()],
    });
    for (const [i, [term, results]] of [["whey", 0], ["whey", 4], [FORMULA, 2]].entries()) {
      await c.execute({ sql: "INSERT INTO events (event_id, name, payload, created_at) VALUES (?, 'search', ?, ?)", args: [`ev-gui-${i}`, JSON.stringify({ params: { search_term: term, results } }), new Date().toISOString()] });
    }
  } finally {
    c.close();
  }
}
await t("analytics as support: aggregates only, no customer name, email, phone or address in any prop; the range follows ?days=", async () => {
  const run = await pages.run(P("analytics"), { cookies: store.cookies.support, searchParams: { days: "7" } });
  eq([run.error?.message ?? null, run.unresolved], [null, []]);
  const props = JSON.stringify(run.props);
  for (const v of [...Object.values(CUSTOMER), "12 Cny Street", "GUI-ORDER-1"]) ok(!props.includes(v), `no ${v}:`);
  const tables = run.props.find((p) => p.component.endsWith("#AnalyticsTables"))?.props;
  eq([tables?.days, tables?.products.products.map((p) => [p.title, p.qty, p.revenue])], [7, [["Whey 1kg", 2, 3000]]], "the aggregate:");
  eq(tables.terms.terms.find((x) => x.term === "whey"), { term: "whey", searches: 2, zero_results: 1 }, "the whey searches, one with no results:");
  ok(tables.terms.terms.every((x) => Object.keys(x).sort().join() === "searches,term,zero_results"), "a search row carries only term and counts:");
  eq(Object.keys(run.props.find((p) => p.component.endsWith("#SalesNumbers")).props.sales).sort(), ["aov", "currency", "gross", "net", "orders", "refunds"], "the sales keys:");
  eq(run.props.find((p) => p.component.endsWith("#AnalyticsRange"))?.props.days, 7);
  eq((await pages.run(P("analytics"), { cookies: store.cookies.support, searchParams: { days: "12" } })).props.find((p) => p.component.endsWith("#AnalyticsRange"))?.props.days, 30, "an unknown range is 30:");
  eq((await pages.run(P("analytics"), { cookies: {} })).redirect, "/admin/login", "signed out:");
});
await t("experiments and insights as support: the role goes to the screen, which hides every write; an unknown slug is not found", async () => {
  const list = await pages.run(P("experiments"), { cookies: store.cookies.support });
  const screen = list.props.find((p) => p.component.endsWith("#ExperimentsList"));
  eq([screen?.props.role, screen?.props.initial.map((e) => e.slug).sort()], ["support", ["gate-one", "shop-draft"]]);
  const one = await pages.run(P("experiments/[slug]"), { cookies: store.cookies.support, params: { slug: "gate-one" } });
  const d = one.props.find((p) => p.component.endsWith("#ExperimentDetail"))?.props;
  eq([d?.role, d?.experiment.status, d?.analysis.status], ["support", "completed", "completed"]);
  eq((await pages.run(P("experiments/[slug]"), { cookies: store.cookies.support, params: { slug: "exp-missing" } })).notFound, true, "unknown slug:");
  const ins = (await pages.run(P("insights"), { cookies: store.cookies.support })).props.find((p) => p.component.endsWith("#InsightsList"))?.props;
  eq([ins?.role, ins?.initial.configured, Object.keys(ins?.initial || {}).sort()], ["support", false, ["budget", "configured", "insights"]]);
});
await t("automations as staff or support: the no-access note and no rule, run or setting in props; admin gets the rules", async () => {
  for (const role of ["staff", "support"]) {
    const run = await pages.run(P("automations"), { cookies: store.cookies[role] });
    const names = run.props.map((p) => p.component);
    ok(names.some((n) => n.endsWith("#PermissionNote")) && !names.some((n) => n.endsWith("#RulesList")), `${role}: ${names.join(",")}`);
    ok(!JSON.stringify(run.props).includes("cnyrule0"), `${role}: no rule in props`);
  }
  const admin = (await pages.run(P("automations"), { cookies: store.cookies.admin })).props.find((p) => p.component.endsWith("#RulesList"))?.props;
  ok(admin?.initial.automations.some((r) => r.name === RULE.name), "admin sees the rule:");
});

async function plantRun(id, status) {
  const rule = (await call("admin", "automations", "GET")).body.automations.find((r) => r.name === RULE.name);
  const c = a.client();
  try {
    await c.execute({ sql: "INSERT INTO automation_runs (id, automation_id, event_key, status, reason, created_at) VALUES (?, ?, ?, ?, 'simulated outage', ?)", args: [id, rule.id, `order_placed:${id === "run-gui-done" ? "GUI-OTHER" : "GUI-ORDER-1"}`, status, new Date().toISOString()] });
  } finally {
    c.close();
  }
  return rule;
}
const sends = async (ruleId) => {
  const c = a.client();
  try {
    return Number((await c.execute({ sql: "SELECT COUNT(*) n FROM notifications WHERE idempotency_key LIKE ?", args: [`aut_${ruleId}_%`] })).rows[0].n);
  } finally {
    c.close();
  }
};
await t("Retry a failed run: staff 403; a run that hasn't failed is refused; a double retry sends once; each retry is audited as settings.write", async () => {
  const rule = await plantRun("run-gui-failed", "failed");
  await plantRun("run-gui-done", "done");
  eq((await call("staff", "automations", "POST", { body: { retry: { run: "run-gui-failed" } } })).status, 403, "staff:");
  eq((await call("support", "automations", "POST", { body: { retry: { run: "run-gui-failed" } } })).status, 403, "support:");
  const notFailed = await call("admin", "automations", "POST", { body: { retry: { run: "run-gui-done" } } });
  eq(notFailed.status, 422, "a done run:");
  ok(/only failed runs retry/.test(notFailed.body?.error || ""), `the words: ${notFailed.body?.error}`);
  eq(await auditRows("automation_run:run-gui-done"), [], "a refused retry is not audited:");
  const before = await sends(rule.id);
  const both = await Promise.all([1, 2].map(() => call("admin", "automations", "POST", { body: { retry: { run: "run-gui-failed" } } })));
  const sentNow = both.filter((r) => r.status === 200 && r.body?.status === "done");
  eq(sentNow.length, 1, `one retry sends: ${JSON.stringify(both.map((r) => [r.status, r.body?.status, r.body?.error]))}`);
  eq(await sends(rule.id), before + 1, "one email intent:");
  eq((await call("admin", "automations", "POST", { body: { retry: { run: "run-gui-failed" } } })).status, 422, "a third retry: the run is gone:");
  ok((await auditRows("automation_run:run-gui-failed")).every((x) => x === "settings.write") && (await auditRows("automation_run:run-gui-failed")).length >= 1, "audited as settings.write:");
});

console.log("— 4. the screens' markup");
const swc = require("next/dist/build/swc/index.js");
await swc.loadBindings();
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const stubs = { "@/components/kit/toast": { useToast: () => ({ success() {}, error() {}, info() {} }) }, "next/navigation": { useRouter: () => ({ refresh() {}, push() {} }) } };
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
    else if (/^@\/(components\/(ui|kit|admin\/(analytics|insights|experiments|automations|offers|media))|lib)\//.test(id)) deps.set(id, await load(resolveLocal(id)));
    else if (id.startsWith("./") && rel.startsWith("components/admin/")) deps.set(id, await load(join(dirname(rel), `${id}.js`)));
    else if (id.startsWith("./") && rel.startsWith("lib/")) deps.set(id, await load(join(dirname(rel), id)));
    else if (id.startsWith("@/") || id.startsWith(".")) throw new Error(`${rel} imports ${id}`);
    else deps.set(id, require(id));
  }
  const mod = { exports: {} };
  new Function("require", "module", "exports", out)((id) => deps.get(id), mod, mod.exports);
  cache.set(file, mod.exports);
  return mod.exports;
}
const AT = await load("components/admin/analytics/AnalyticsTables.js");
const { FunnelCard } = await load("components/admin/analytics/FunnelCard.js");
const { InsightsList } = await load("components/admin/insights/InsightsList.js");
const { ExperimentsList } = await load("components/admin/experiments/ExperimentsList.js");
const { ExperimentDetail } = await load("components/admin/experiments/AnalysisPanel.js");
const { RulesList } = await load("components/admin/automations/RulesList.js");
const { TooltipProvider } = await load("components/ui/tooltip.js");
const html = (el) => renderToStaticMarkup(React.createElement(TooltipProvider, null, el));
const h = React.createElement;
const controls = (s) => [...s.matchAll(/<(button|a|summary)\b[^>]*>/g)].map((m) => m[0]);
const unmarked = (s) => controls(s).filter((c) => !c.includes("data-read-control") && !c.includes('data-role-gate="disabled"'));
const texts = (s) => s.replace(/<[^>]+>/g, " ");

const aProps = (await pages.run(P("analytics"), { cookies: store.cookies.support })).props;
const prop = (name) => aProps.find((p) => p.component.endsWith(`#${name}`)).props;
const INSIGHTS = { configured: false, budget: { budget: 200000, spent: null, remaining: null, metered: false }, insights: [{ id: "ins_1", status: "proposed", created_at: "2026-11-20T00:00:00.000Z", facts: [{ id: "f1", text: "12 searches for whey found nothing" }], proposals: [{ title: "Name the whey", mechanism: "Shoppers look for it", evidence: ["f1"], component: "hero", draft: { title: "Whey" } }] }] };
const exps = (await a.run(() => X.listExperiments()));
const draftExp = { ...exps.find((e) => e.slug === "shop-draft"), status: "draft" };
const done = exps.find((e) => e.slug === "gate-one");
const doneAnalysis = await a.run(() => X.analyzeExperiment("gate-one"));

await t("support's analytics markup: every control is a marked read (range links, CSV, truncated cells); the funnel has a table for screen readers", async () => {
  const s = html(h("div", null, h(AT.AnalyticsRange, { days: 30 }), h(AT.SalesNumbers, prop("SalesNumbers")), h(FunnelCard, prop("FunnelCard")), h(AT.AnalyticsTables, prop("AnalyticsTables"))));
  eq(unmarked(s), [], "unmarked controls:");
  ok(s.includes("Download top products as CSV") && s.includes("Whey 1kg"), "the CSV button and the product:");
  const fun = html(h(FunnelCard, { funnel: { steps: [{ name: "view_item", count: 10 }, { name: "purchase", count: 2 }], conversion_pct: 20 } }));
  ok(fun.includes('<table class="sr-only"><caption>Funnel steps</caption>') && fun.includes("Opened a product"), "the funnel's table for screen readers:");
  ok(html(h(AT.AnalyticsError, { days: 7 })).includes('href="/admin/analytics?days=7"'), "Try again re-reads the same range:");
  ok(html(h(AT.CoverageNote, { coverage: { sales: 4, event_coverage_pct: 25 } })).includes("Tracking is thin"), "the coverage note:");
  eq(html(h(AT.CoverageNote, { coverage: { sales: 4, event_coverage_pct: 80 } })), "", "no note when tracking is good:");
});
await t("CSV: a shopper's search term that starts with = (or + - @, a tab, a return) is prefixed with ' so it is never a formula", async () => {
  const { toCsv } = await load("components/admin/analytics/CsvButton.js");
  const csv = toCsv(prop("AnalyticsTables").terms.terms, [{ key: "term", header: "Search" }, { key: "searches", header: "Searches" }]);
  const line = csv.split("\n").find((l) => l.includes("hyperlink"));
  ok(line && line.startsWith(`"'=hyperlink(`), `the formula row: ${line}`);
  eq(["+1", "-2", "@x", "\tx", "\rx", "ok"].map((v) => toCsv([{ v }], [{ key: "v", header: "v" }]).split("\n").slice(1).join("\n")), ["'+1", "'-2", "'@x", "'\tx", '"\'\rx"', "ok"], "every risky first character:");
});
await t("support's insights markup: no Generate, Apply, Dismiss or Restore; staff gets them, with Generate disabled while not configured", async () => {
  const sup = html(h(InsightsList, { initial: INSIGHTS, role: "support" }));
  for (const w of ["Generate ideas", "Apply as draft", "Dismiss", "Restore"]) ok(!texts(sup).includes(w), `support: no ${w}`);
  eq(unmarked(sup), [], "support's controls are marked reads:");
  ok(sup.includes("aren&rsquo;t set up") || sup.includes("aren’t set up"), "the not-set-up state:");
  const staff = html(h(InsightsList, { initial: INSIGHTS, role: "staff" }));
  for (const w of ["Generate ideas", "Apply as draft", "Dismiss"]) ok(texts(staff).includes(w), `staff: ${w}`);
  ok(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Generate ideas/s.test(staff), "Generate is disabled:");
  ok(html(h(InsightsList, { initial: null, role: "support" })).includes("Try again"), "a failed read: Try again:");
});
await t("experiments markup: support has no New experiment, Start, Edit, Pause, Complete or Keep; staff sees Start disabled (RoleGate) with no other way to start; admin's Start is live", async () => {
  const supList = html(h(ExperimentsList, { initial: exps, role: "support" }));
  ok(!texts(supList).includes("New experiment"), "support list: no New experiment");
  eq(unmarked(supList), [], "support list: every control a marked read:");
  for (const [e, an] of [[draftExp, null], [done, doneAnalysis]]) {
    const s = html(h(ExperimentDetail, { experiment: e, analysis: an, role: "support" }));
    for (const w of ["Start", "Edit the plan", "Pause", "Complete", "Keep it as a draft", "Resume"]) ok(!controls(s).some((c) => c.includes("data-experiment-action")) && !texts(s).includes(` ${w} `), `support ${e.status}: no ${w}`);
    eq(unmarked(s), [], `support ${e.status}: every control a marked read:`);
  }
  const staff = html(h(ExperimentDetail, { experiment: draftExp, analysis: null, role: "staff" }));
  const start = controls(staff).filter((c) => c.includes('data-experiment-action="start"'));
  eq(start.length, 1, "staff sees Start:");
  ok(start[0].includes('aria-disabled="true"') && start[0].includes('data-role-gate="disabled"'), `staff's Start is RoleGate-disabled: ${start[0]}`);
  ok(texts(staff).includes("Edit the plan"), "staff can edit the draft:");
  const admin = html(h(ExperimentDetail, { experiment: draftExp, analysis: null, role: "admin" }));
  ok(!controls(admin).find((c) => c.includes('data-experiment-action="start"')).includes("aria-disabled"), "admin's Start is live:");
  const staffDone = html(h(ExperimentDetail, { experiment: done, analysis: doneAnalysis, role: "staff" }));
  ok(texts(staffDone).includes("Keep it as a draft"), "staff keeps a variant of a completed one:");
  ok(texts(staffDone).includes("Too few visitors so far"), "the sample block in words:");
  const running = html(h(ExperimentDetail, { experiment: { ...done, status: "running" }, analysis: { ...doneAnalysis, status: "running", verdict: null }, role: "staff" }));
  ok(texts(running).includes("No peeking") && texts(running).includes("Hidden"), "running: no peeking, the rate hidden:");
});
await t("automations markup (admin): rules, kill switch, New rule, Dry run, Edit, Remove and the runs table", async () => {
  const initial = (await pages.run(P("automations"), { cookies: store.cookies.admin })).props.find((p) => p.component.endsWith("#RulesList")).props.initial;
  const s = texts(html(h(RulesList, { initial, role: "admin" })));
  for (const w of ["Turn all off", "New rule", "Dry run", "Edit", "Remove", "Recent runs", RULE.name]) ok(s.includes(w), `admin: ${w}`);
});

await store.cleanup();
console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
