// Onboarding checklist (S41 / MC02). Node-only, runs in TENANT context.
//
// Resumable by construction: most steps are DERIVED from real state (a
// re-opened checklist can never drift from reality), and only the three
// human-judgement steps (preview, test order, launch) are stored check-offs
// (config.onboarding.manual). Launch is gated on everything before it.
import { db } from "../db.js";
import { currentTenant } from "../tenant-context.js";
import { listContentPages } from "../cms/store.js";

const isRealDomain = (d) => d && !/localhost|127\.0\.0\.1|\.vercel\.app$/.test(d);

export async function buildChecklist() {
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") {
    return { supported: false, reason: "Onboarding tracks control-plane tenants — this store runs on environment config." };
  }
  const manual = tenant.config?.onboarding?.manual || {};

  const [productCount, pages, sync] = await Promise.all([
    db
      .selectFrom("products")
      .select(({ fn }) => fn.countAll().as("n"))
      .executeTakeFirst()
      .then((r) => Number(r?.n ?? 0))
      .catch(() => 0),
    listContentPages().catch(() => []),
    // GEN-02: the step reads the sync's own record, so it can say "on its way"
    import("../sync.js").then((S) => S.catalogSyncStatus()).catch(() => null),
  ]);
  const syncView = sync?.view;
  const catalogDone = productCount > 0 || syncView?.state === "complete";
  const catalogHint = catalogDone
    ? productCount > 0
      ? `${productCount} products in`
      : "Your Shopify store has no products yet. Add some there and they'll come in."
    : syncView && ["running", "retrying"].includes(syncView.state)
      ? `${syncView.headline}: ${syncView.products.done} products so far`
      : syncView && ["failed", "stalled"].includes(syncView.state)
        ? "It didn't finish. Open Settings to try again."
        : "Starts when your Shopify store is linked. You can also start it from Settings.";
  const enabledPages = pages.filter((p) => p.enabled);
  const hasPolicy = (re) => enabledPages.some((p) => re.test(p.slug));

  const items = [
    {
      id: "connect",
      label: "Connect Shopify",
      kind: "auto",
      done: Boolean(tenant.secrets?.shopify_admin_token),
      href: "/admin/integrations",
      hint: "OAuth connect — the catalog syncs from your store.",
    },
    {
      id: "catalog",
      label: "Bring in your products",
      kind: "auto",
      done: catalogDone,
      href: "/admin/settings#catalog-sync",
      hint: catalogHint,
    },
    {
      id: "brand",
      label: "Pick a theme & brand",
      kind: "auto",
      done: Boolean(tenant.config?.brand || tenant.config?.theme),
      href: "/admin/theme",
      hint: "Apply a kit, set your accent color.",
    },
    {
      id: "policies",
      label: "Publish legal pages",
      kind: "auto",
      done: hasPolicy(/privacy/) && hasPolicy(/terms|refund|return/),
      href: "/admin/storefront",
      hint: "Privacy + terms/refund — templates scaffold them; checkout links them.",
    },
    {
      id: "billing",
      label: "Activate billing",
      kind: "auto",
      done: Boolean(tenant.config?.billing),
      href: "/admin/billing",
      hint: "Pick a plan (Free counts) — explicit, never silent.",
    },
    {
      id: "domain",
      label: "Point your domain",
      kind: "auto",
      done: (tenant.domains || []).some(isRealDomain),
      href: "/admin/settings",
      hint: "A custom host (operator adds + verifies it).",
    },
    {
      id: "preview",
      label: "Review your draft preview",
      kind: "manual",
      done: Boolean(manual.preview),
      href: "/admin/storefront",
      hint: "Walk the storefront in the preview pane, then mark done.",
    },
    {
      id: "test_order",
      label: "Place a test order",
      kind: "manual",
      done: Boolean(manual.test_order),
      href: "/checkout",
      hint: "One COD test order end-to-end (cancel it after).",
    },
  ];

  const prereqsDone = items.every((i) => i.done);
  items.push({
    id: "launch",
    label: "Launch",
    kind: "manual",
    done: Boolean(manual.launch),
    gated: !prereqsDone && !manual.launch,
    href: "/admin/releases",
    hint: prereqsDone || manual.launch ? "Publish your first release and go." : "Unlocks when everything above is done.",
  });

  const doneCount = items.filter((i) => i.done).length;
  return {
    supported: true,
    items,
    doneCount,
    total: items.length,
    launched: Boolean(manual.launch),
    launchedAt: manual.launch || null,
    provisionedAt: tenant.config?.onboarding?.provisioned_at || null,
  };
}

export const MANUAL_STEPS = ["preview", "test_order", "launch"];

export async function markManualStep(step, { done = true } = {}) {
  if (!MANUAL_STEPS.includes(step)) throw new Error(`"${step}" isn't a manual checklist step`);
  const tenant = currentTenant();
  if (!tenant || tenant.id === "_default") throw new Error("control-plane tenant required");
  if (step === "launch" && done) {
    const { items } = await buildChecklist();
    const blocking = items.filter((i) => i.id !== "launch" && !i.done);
    if (blocking.length) throw new Error(`launch is gated — still open: ${blocking.map((i) => i.label).join(", ")}`);
  }
  const { patchTenant } = await import("../platform/control.js");
  const manual = { ...(tenant.config?.onboarding?.manual || {}) };
  if (done) manual[step] = new Date().toISOString();
  else delete manual[step];
  await patchTenant(tenant.id, { config: { onboarding: { ...(tenant.config?.onboarding || {}), manual } } });
  return { step, done };
}
