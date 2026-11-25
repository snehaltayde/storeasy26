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
});

if (process.env.GROWTH_UI_GATE_ONLY) {
  await store.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
