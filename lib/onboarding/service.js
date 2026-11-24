// Phase 1 line 3: the onboarding steps' reads and the one write. Node only,
// runs in TENANT context (withTenant; the store is the request's host).
//
//   readOnboardingFacts()   the facts lib/onboarding/steps.js derives from.
//                           Each read is caught on its own: a failed read is
//                           null there (that step is never done on a guess).
//   onboardingFor(actor)    deriveSteps(facts, actor.role)
//   onboardingProgress()    { supported, open, openKnown, doneCount, total } from
//                           the cheap reads only (no openingReport): the nav
//                           badge and the dashboard nudge, on every console page.
//                           The Open step counts as not done unless a live
//                           release exists.
//   liveOpen()              a live release exists (throws when unreadable)
//   markTestOrder(done)     sets or clears config.onboarding.manual.test_order
//                           (the only stored check-off left; "preview" and
//                           "launch" check-offs are no longer read)
//                           → { step, done, tenant } (the stored row after the write)
import { libsql } from "../db.js";
import { currentTenant } from "../tenant-context.js";
import { deriveSteps } from "./steps.js";

const quiet = (p) => p.then((v) => v, () => null);
const brandStepRecorded = (onboarding) => {
  const s = onboarding && typeof onboarding === "object" ? onboarding.brand_step : null;
  return Boolean(s && typeof s === "object" && !Array.isArray(s) && s.at);
};

async function syncFacts() {
  const [runs, products] = await Promise.all([
    libsql.execute("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) AS complete FROM sync_runs"),
    libsql.execute("SELECT COUNT(*) AS n FROM products"),
  ]);
  const { catalogSyncStatus } = await import("../sync.js");
  const status = await catalogSyncStatus();
  return {
    hasComplete: Number(runs.rows[0]?.complete ?? 0) > 0,
    anyRun: Number(runs.rows[0]?.n ?? 0) > 0,
    products: Number(products.rows[0]?.n ?? 0),
    view: status.view,
    linked: status.linked,
  };
}

export async function liveOpen() {
  const r = await libsql.execute("SELECT live_release_id FROM release_state WHERE id = 1");
  return r.rows[0]?.live_release_id != null;
}

async function homeExists() {
  const r = await libsql.execute("SELECT 1 AS x FROM documents WHERE id = 'doc_home'");
  return r.rows.length > 0;
}

export async function readOnboardingFacts({ opening: withOpening = true } = {}) {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") {
    return { supported: false, open: await quiet(liveOpen()) };
  }
  const onboarding = tenant.config?.onboarding;
  const [sync, cmsMode, design, hasHome, open] = await Promise.all([
    quiet(syncFacts()),
    quiet(import("../cms-mode.js").then((m) => m.getCmsMode())),
    quiet(import("../admin/brand-readability.js").then((m) => m.storeDesign())),
    quiet(homeExists()),
    quiet(liveOpen()),
  ]);
  // "Before you open your store" only applies (and is only read) while closed
  const opening = withOpening && open === false ? await quiet(import("../documents/opening.js").then((m) => m.openingReport())) : null;
  const { linked = null, ...syncRest } = sync || {};
  return {
    supported: true,
    shopDomain: tenant.config?.shopify_store_domain || null,
    linked: sync ? linked : null,
    sync: sync ? syncRest : null,
    cmsMode,
    brandRecorded: brandStepRecorded(onboarding),
    designBranded: design ? Boolean(design.brand || design.theme) : null,
    hasHome,
    open,
    opening,
    testOrderMarked: Boolean(onboarding?.manual?.test_order),
  };
}

export async function onboardingFor(actor) {
  return deriveSteps(await readOnboardingFacts(), actor?.role);
}

export async function onboardingProgress() {
  const { supported, open, openKnown, doneCount, total } = deriveSteps(await readOnboardingFacts({ opening: false }), "support");
  return { supported, open, openKnown, doneCount, total };
}

export async function markTestOrder(done) {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("This store is set up from its environment config, so there is nothing to mark here.");
  const { patchTenant, getTenant } = await import("../platform/control.js");
  // the stored row, not the request's copy: another write (the brand step) may have landed since
  const onboarding = (await getTenant(tenant.id, { fresh: true }))?.config?.onboarding || {};
  const manual = { ...(onboarding.manual || {}) };
  if (done) manual.test_order = new Date().toISOString();
  else delete manual.test_order;
  await patchTenant(tenant.id, { config: { onboarding: { ...onboarding, manual } } });
  return { step: "test_order", done: Boolean(done), tenant: await getTenant(tenant.id, { fresh: true }) };
}
